// ===== Shared multi-lane timeline (NLE-style arrangement view) =====
//
// This replaces the old "single waveform + tracks rail below" layout with a
// vertical stack of track lanes that all share ONE horizontal time axis
// (seconds) and ONE playhead. Each lane has a fixed-width control header on the
// left (track number, name, record/upload, mute/solo, effects, volume, delete)
// and, on the right, a canvas that draws that track's audio positioned at the
// track's timeline offset. A single playhead line spans every lane, the main
// transport plays the summed mix (state.mixBuffer) and animates that playhead,
// and clicking/dragging anywhere on the lanes seeks.
//
// The per-track editing toolbar (split / delete / trim / undo / copy / paste)
// still operates on the *focused* track — clicking a lane focuses it — so all
// the existing single-track editing machinery keeps working; the timeline just
// re-renders after each edit.

import { state, WAVEFORM_STYLE } from './state.js';
import { el } from './dom.js';
import { formatTime } from './utils.js';
import { computePeaksForRange, pickRulerIntervalSec, formatRulerLabel, trackTimelineEndSamples, clipAtTimelineSample } from './waveform-math.js';
import { trackSourceBuffer } from './effects.js';
import { rebuildMix, commitClipMove, moveClipToTrack } from './editing.js';
import {
  setActiveTrack, toggleMute, toggleSolo, setGainDb,
  removeTrack, toggleTrackFxPopover, enabledFxCount, registerTimeline,
  TRACK_GAIN_MIN_DB, TRACK_GAIN_MAX_DB,
  SVG_MIC, SVG_UPLOAD, SVG_TRASH, SVG_FX, SVG_SPINNER
} from './tracks.js';
import { openRecordModal } from './record-modal.js';

// Must match the values in styles.css (.tl-lane-head width, ruler/lane heights).
const HEADER_W = 220;
const RULER_H = 26;
const LANE_H = 96;
const LANE_GAP = 8;
const MIN_PX_PER_SEC = 6;
const DPR_CAP = 2;

const ZOOM_MIN = 1;      // 1 = fit whole project to width
const ZOOM_MAX = 40;
const ZOOM_STEP = 1.3;

// ----- module playback / view state -----
let playheadSec = 0;
let pxPerSec = MIN_PX_PER_SEC;
let projectDurationSec = 0;
let laneAreaWidthCss = 0;
let zoom = 1;
let scrollLeftSec = 0;

let mixSource = null;
let mixStartCtxTime = 0;
let mixStartSec = 0;
let rafId = 0;
let playing = false;

/**
 * Peak cache: source AudioBuffer → Map of `${start}:${end}:${width}` → peaks.
 * Keying by buffer identity auto-invalidates (edits produce a new buffer, so the
 * stale entry is never hit again and the WeakMap lets it be GC'd); the inner map
 * caches each clip's peaks across frames so playback/drag don't recompute them.
 * @type {WeakMap<AudioBuffer, Map<string, Float32Array>>}
 */
const _peaksCache = new WeakMap();

// ===== Scale / geometry =====

/** Sample rate of a track's source (fallback 48k when it has no audio yet). */
function trackSr(track) {
  const src = trackSourceBuffer(track);
  return src ? src.sampleRate : 48000;
}

/** Seconds a track occupies on the timeline (furthest-right clip end). */
function trackEndSec(track) {
  const src = trackSourceBuffer(track);
  if (!src || track.segments.length === 0) return 0;
  return trackTimelineEndSamples(track.segments) / src.sampleRate;
}

/** Longest timeline extent across all tracks, in seconds (>=0). */
function computeProjectDurationSec() {
  let max = 0;
  for (const t of state.tracks) max = Math.max(max, trackEndSec(t));
  return max;
}

/**
 * Recompute the horizontal scale. `zoom` (1 = fit whole project to width) scales
 * pxPerSec up from the fit baseline; when zoomed in the lanes overflow and the
 * timeline scrolls horizontally.
 */
function computeScale() {
  projectDurationSec = computeProjectDurationSec();
  const usable = Math.max(1, laneAreaWidthCss);
  const fit = projectDurationSec > 0 ? usable / projectDurationSec : MIN_PX_PER_SEC;
  pxPerSec = Math.max(MIN_PX_PER_SEC, fit * zoom);
}

/** Absolute project seconds → x within the lane column (accounts for scroll). */
function secToX(sec) { return (sec - scrollLeftSec) * pxPerSec; }
/** x within the lane column → absolute project seconds. */
function xToSec(x) { return (pxPerSec > 0 ? x / pxPerSec : 0) + scrollLeftSec; }

function visibleDurSec() { return pxPerSec > 0 ? laneAreaWidthCss / pxPerSec : 0; }
function maxScrollSec() { return Math.max(0, projectDurationSec - visibleDurSec()); }
function clampScroll() { scrollLeftSec = Math.max(0, Math.min(scrollLeftSec, maxScrollSec())); }

/** Redraw everything that depends on scale/scroll (no lane-DOM rebuild). */
function repaint() {
  drawRuler();
  drawAllLanes();
  positionPlayhead();
  updateScrollbar();
}

/** Zoom by a factor, keeping the project time under `pivotX` (lane px) fixed. */
function zoomBy(factor, pivotX) {
  const px = Math.max(0, pivotX);
  const secAt = xToSec(px);
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
  computeScale();
  scrollLeftSec = zoom <= ZOOM_MIN ? 0 : secAt - px / pxPerSec;
  clampScroll();
  repaint();
}

export function zoomIn() { zoomBy(ZOOM_STEP, laneAreaWidthCss / 2); }
export function zoomOut() { zoomBy(1 / ZOOM_STEP, laneAreaWidthCss / 2); }
export function zoomFit() { zoom = ZOOM_MIN; scrollLeftSec = 0; computeScale(); repaint(); }

function onWheel(e) {
  if (!anyTrackHasAudio() || !el.timelineGrid) return;
  const rect = el.timelineGrid.getBoundingClientRect();
  const px = e.clientX - rect.left - HEADER_W;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, px);
    return;
  }
  // Horizontal pan: trackpad X, or Shift+wheel, when zoomed in.
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
  if (dx !== 0 && maxScrollSec() > 0) {
    e.preventDefault();
    scrollLeftSec += dx / pxPerSec;
    clampScroll();
    repaint();
  }
}

/** Position + size the horizontal scrollbar thumb (hidden when fully fit). */
function updateScrollbar() {
  const bar = el.timelineScrollbar, thumb = el.timelineScrollThumb;
  if (!bar || !thumb) return;
  const maxS = maxScrollSec();
  if (maxS <= 0 || projectDurationSec <= 0) { bar.hidden = true; return; }
  bar.hidden = false;
  const trackW = bar.clientWidth || laneAreaWidthCss;
  const frac = Math.min(1, visibleDurSec() / projectDurationSec);
  const w = Math.max(28, trackW * frac);
  const left = (scrollLeftSec / projectDurationSec) * trackW;
  thumb.style.width = w + 'px';
  thumb.style.left = Math.min(trackW - w, left) + 'px';
}

function onScrollbarPointerDown(e) {
  const bar = el.timelineScrollbar, thumb = el.timelineScrollThumb;
  if (!bar || !thumb) return;
  e.preventDefault();
  const barRect = bar.getBoundingClientRect();
  const thumbW = thumb.offsetWidth;
  const onThumb = e.target === thumb;
  const grab = onThumb ? (e.clientX - thumb.getBoundingClientRect().left) : thumbW / 2;
  const toScroll = (cx) => {
    const left = Math.max(0, Math.min(barRect.width - thumbW, cx - barRect.left - grab));
    scrollLeftSec = (left / Math.max(1, barRect.width)) * projectDurationSec;
    clampScroll();
    repaint();
  };
  toScroll(e.clientX);
  const move = (ev) => toScroll(ev.clientX);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ===== Public API =====

/** True when at least one track holds audio (drives timeline vs empty-state). */
export function anyTrackHasAudio() {
  return state.tracks.some(t => t.originalBuffer && t.segments.length > 0);
}

/**
 * Render the whole timeline. Rebuilds the lane DOM (headers + canvases), redraws
 * each lane's waveform on the shared axis, and repositions the shared playhead.
 * Cheap enough to call after any edit — a handful of tracks, canvases blitted
 * from cached peaks.
 */
export function renderTimeline() {
  if (!el.timeline) return;
  const show = anyTrackHasAudio();
  el.timeline.hidden = !show;
  if (el.transportBar) el.transportBar.hidden = !show;
  if (el.waveformHome) el.waveformHome.hidden = show;
  if (el.editorTopBar) el.editorTopBar.hidden = !show;
  if (!show) { updateTransportUI(); return; }

  measureLaneWidth();
  computeScale();
  clampScroll();
  clampPlayhead();
  buildLanes();
  drawRuler();
  drawAllLanes();
  positionPlayhead();
  updateScrollbar();
  syncActivePlaybackOffset();
  updateTransportUI();
}

/**
 * Publish the shared playhead as `state.timelineSec` (the authority for
 * clip-level split/delete-at-playhead) and keep a rough `state.playbackOffset`
 * bridge for the legacy keyboard nav (measured from the active track's earliest
 * clip).
 */
function syncActivePlaybackOffset() {
  state.timelineSec = playheadSec;
  if (!state.recordedBuffer) { state.playbackOffset = 0; return; }
  const t = state.tracks[state.activeTrackIndex];
  const sr = trackSr(t);
  let firstT = Infinity;
  for (const s of t.segments) firstT = Math.min(firstT, s.tStart != null ? s.tStart : 0);
  if (!isFinite(firstT)) firstT = 0;
  state.playbackOffset = Math.max(0, Math.min(state.recordedBuffer.duration, playheadSec - firstT / sr));
}

/** Measure the lane canvas column width from the mounted grid (falls back to stage). */
function measureLaneWidth() {
  const probe = el.timelineGrid && el.timelineGrid.clientWidth
    ? el.timelineGrid.clientWidth
    : (el.timeline ? el.timeline.clientWidth : 0);
  laneAreaWidthCss = Math.max(1, probe - HEADER_W);
}

// ===== Lane DOM =====

function buildLanes() {
  const grid = el.timelineGrid;
  if (!grid) return;
  grid.innerHTML = '';
  const anySolo = state.tracks.some(t => t.solo);

  state.tracks.forEach((track, i) => {
    const lane = document.createElement('div');
    lane.className = 'tl-lane' + (i === state.activeTrackIndex ? ' is-active' : '');
    lane.dataset.index = String(i);

    lane.append(buildLaneHeader(track, i, anySolo), buildLaneBody(track, i));
    grid.append(lane);
  });
}

function buildLaneHeader(track, i, anySolo) {
  const head = document.createElement('div');
  head.className = 'tl-lane-head';
  head.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */(e.target).closest('.track-ctl, input')) return;
    setActiveTrack(i);
  });

  // Row 1: number badge + name
  const top = document.createElement('div');
  top.className = 'tl-head-top';
  const num = document.createElement('span');
  num.className = 'tl-track-num';
  num.textContent = String(i + 1);
  const name = document.createElement('span');
  name.className = 'tl-track-name';
  name.textContent = track.name;
  top.append(num, name);

  // Row 2: primary controls
  const ctls = document.createElement('div');
  ctls.className = 'tl-head-controls';
  // Record / upload into a lane: fresh when the lane is empty, append when it
  // already holds audio (so a lane can hold multiple takes, like the old "+").
  const hasAudio = !!track.originalBuffer && track.segments.length > 0;
  ctls.append(
    iconButton('track-ctl track-rec', hasAudio ? 'Record more into this track' : 'Record into this track', SVG_MIC,
      () => { setActiveTrack(i); openRecordModal(hasAudio ? 'append' : 'fresh'); }),
    iconButton('track-ctl track-upload', hasAudio ? 'Append audio to this track' : 'Upload into this track', SVG_UPLOAD,
      () => { setActiveTrack(i); (hasAudio ? el.appendFileInput : el.fileInput).click(); }),
    toggleButton('track-ctl track-mute' + (track.muted ? ' is-on' : ''), 'Mute', 'M', () => toggleMute(i)),
    toggleButton('track-ctl track-solo' + (track.solo ? ' is-on' : '') + (anySolo && !track.solo ? ' is-dimmed' : ''), 'Solo', 'S', () => toggleSolo(i))
  );
  const fxCount = enabledFxCount(track);
  const fxBusy = track.denoise.processing && i === state.activeTrackIndex;
  ctls.append(iconButton(
    'track-ctl track-fx' + (fxCount > 0 ? ' is-on' : '') + (fxBusy ? ' is-busy' : ''),
    fxCount > 0 ? `Effects (${fxCount} on)` : 'Effects',
    fxBusy ? SVG_SPINNER : SVG_FX,
    () => toggleTrackFxPopover(i)
  ));
  ctls.append(iconButton('track-ctl track-del', 'Delete track', SVG_TRASH, () => removeTrack(i)));

  // Row 3: volume slider
  const volRow = document.createElement('div');
  volRow.className = 'tl-head-vol';
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.className = 'track-vol';
  vol.min = String(TRACK_GAIN_MIN_DB);
  vol.max = String(TRACK_GAIN_MAX_DB);
  vol.step = '1';
  vol.value = String(track.gainDb);
  vol.title = `Volume ${track.gainDb} dB`;
  vol.addEventListener('input', () => { setGainDb(i, Number(vol.value), { rebuild: false }); vol.title = `Volume ${track.gainDb} dB`; });
  vol.addEventListener('change', () => setGainDb(i, Number(vol.value)));
  volRow.append(vol);

  head.append(top, ctls, volRow);
  return head;
}

function buildLaneBody(track, i) {
  const body = document.createElement('div');
  body.className = 'tl-lane-body';
  const canvas = document.createElement('canvas');
  canvas.className = 'tl-lane-canvas';
  body.append(canvas);
  if (!track.originalBuffer || track.segments.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'tl-lane-empty';
    hint.textContent = 'Empty — record or upload into this track';
    body.append(hint);
  }
  return body;
}

// ===== Canvas drawing =====

function laneCanvases() {
  return el.timelineGrid ? el.timelineGrid.querySelectorAll('.tl-lane-canvas') : [];
}

function drawAllLanes() {
  const canvases = laneCanvases();
  state.tracks.forEach((track, i) => {
    const canvas = /** @type {HTMLCanvasElement} */ (canvases[i]);
    if (canvas) drawLane(canvas, track, i === state.activeTrackIndex);
  });
}

function drawLane(canvas, track, isActive) {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const cssW = laneAreaWidthCss;
  const cssH = LANE_H;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const midY = H / 2;
  // Faint midline
  ctx.fillStyle = WAVEFORM_STYLE.midlineColor;
  ctx.fillRect(0, Math.round(midY), W, 1);

  const src = trackSourceBuffer(track);
  if (!src || track.segments.length === 0) return;
  const sr = src.sampleRate;
  const data = src.getChannelData(0);
  const playX = secToX(playheadSec) * dpr;
  const scale = (H / 2) * 0.86;

  let accSamples = 0;
  track.segments.forEach((seg, segIndex) => {
    const len = seg.end - seg.start;
    const tStart = seg.tStart != null ? seg.tStart : accSamples;
    accSamples = Math.max(accSamples, tStart + len);
    const startSec = tStart / sr;
    const endSec = (tStart + len) / sr;

    const x0 = Math.round(secToX(startSec) * dpr);
    const x1 = Math.round(secToX(endSec) * dpr);
    const wpx = Math.max(1, x1 - x0);
    const selected = isActive && segIndex === state.selectedSegmentIndex;

    // Clip card background + border (selected clips get an accent outline)
    ctx.fillStyle = selected ? WAVEFORM_STYLE.hoverCardBg
      : (isActive ? WAVEFORM_STYLE.hoverCardBg : WAVEFORM_STYLE.segmentCardBg);
    ctx.fillRect(x0, 2, wpx, H - 4);
    ctx.strokeStyle = selected ? WAVEFORM_STYLE.selectedEdgeColor
      : (isActive ? WAVEFORM_STYLE.selectedEdgeColor : WAVEFORM_STYLE.segmentEdgeColor);
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x0 + 0.5, 2.5, wpx - 1, H - 5);

    // Waveform peaks (cached per source + segment range + column width)
    const peaks = cachedPeaks(src, data, seg.start, seg.end, wpx);
    const onColor = selected ? WAVEFORM_STYLE.selectedPlayedColor
      : (isActive ? WAVEFORM_STYLE.playedColor : WAVEFORM_STYLE.unplayedColor);
    const offColor = selected ? WAVEFORM_STYLE.selectedUnplayedColorBright
      : (isActive ? WAVEFORM_STYLE.unplayedColor : 'rgba(77, 216, 200, 0.16)');
    for (let x = 0; x < wpx; x++) {
      const colX = x0 + x;
      const top = midY + peaks[x * 2] * scale;
      const h = Math.max(1, (midY + peaks[x * 2 + 1] * scale) - top);
      ctx.fillStyle = colX <= playX ? onColor : offColor;
      ctx.fillRect(colX, top, 1, h);
    }
  });
}

/** Peaks cached per source buffer, keyed by segment range + column width. */
function cachedPeaks(src, data, start, end, wpx) {
  let byRange = _peaksCache.get(src);
  if (!byRange) { byRange = new Map(); _peaksCache.set(src, byRange); }
  const key = `${start}:${end}:${wpx}`;
  let peaks = byRange.get(key);
  if (!peaks) { peaks = computePeaksForRange(data, start, end, wpx); byRange.set(key, peaks); }
  return peaks;
}

function drawRuler() {
  const canvas = el.timelineRuler;
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const cssW = laneAreaWidthCss;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.floor(RULER_H * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = RULER_H + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (projectDurationSec <= 0) return;

  // Tick density follows the VISIBLE window, so zooming in reveals finer ticks.
  const visibleDurSec = cssW / pxPerSec;
  const intervalSec = pickRulerIntervalSec(visibleDurSec, cssW);
  ctx.fillStyle = WAVEFORM_STYLE.tickColor;
  ctx.strokeStyle = WAVEFORM_STYLE.tickColor;
  ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
  ctx.textBaseline = 'bottom';
  const first = Math.max(0, Math.floor(scrollLeftSec / intervalSec) * intervalSec);
  const last = Math.min(projectDurationSec, scrollLeftSec + visibleDurSec);
  for (let t = first; t <= last + 1e-6; t += intervalSec) {
    const x = Math.round(secToX(t) * dpr);
    ctx.fillRect(x, canvas.height - 8 * dpr, 1, 8 * dpr);
    ctx.fillText(formatRulerLabel(t, intervalSec), x + 3 * dpr, canvas.height - 9 * dpr);
  }
}

// ===== Shared playhead =====

function totalLanesHeightCss() {
  return state.tracks.length * (LANE_H + LANE_GAP);
}

function clampPlayhead() {
  if (playheadSec < 0) playheadSec = 0;
  if (playheadSec > projectDurationSec) playheadSec = projectDurationSec;
}

function positionPlayhead() {
  const ph = el.timelinePlayhead;
  if (!ph) return;
  const x = secToX(playheadSec);
  // Hide when scrolled out of the visible lane window.
  if (!anyTrackHasAudio() || x < 0 || x > laneAreaWidthCss + 0.5) { ph.style.display = 'none'; return; }
  ph.style.display = '';
  ph.style.left = (HEADER_W + x) + 'px';
  ph.style.top = '0px';
  ph.style.height = (RULER_H + totalLanesHeightCss()) + 'px';
}

// ===== Pointer interaction: seek / select clip / drag clip =====
//
// - Press on empty lane area or the ruler → scrub the playhead (drag to move it).
// - Press on a clip and release without dragging → seek there, select that clip,
//   and focus its track (so split/delete/trim act on it).
// - Press on a clip and drag → move that INDIVIDUAL clip in time (its tStart);
//   drag it onto another lane to move it to that track (cross-track move).

const CLIP_DRAG_THRESHOLD_PX = 4;
const SNAP_PX = 7; // snap distance to 0 / playhead / other clip edges

/** Map a client X (relative to the lane column) to a project time (seconds). */
function clientXToSec(clientX) {
  if (!el.timelineGrid) return 0;
  const rect = el.timelineGrid.getBoundingClientRect();
  return Math.max(0, Math.min(projectDurationSec, xToSec(clientX - rect.left - HEADER_W)));
}

/**
 * Which track/segment (if any) sits under a project time on a given lane.
 * @returns {{trackIndex:number, segIndex:number}|null}
 */
function clipHitTest(laneIndex, sec) {
  const track = state.tracks[laneIndex];
  if (!track) return null;
  const src = trackSourceBuffer(track);
  if (!src || track.segments.length === 0) return null;
  const tSample = Math.round(sec * src.sampleRate);
  const hit = clipAtTimelineSample(track.segments, tSample);
  return hit ? { trackIndex: laneIndex, segIndex: hit.index } : null;
}

/** Lane index under a client Y (for cross-track drops); -1 if none. */
function laneIndexAtClientY(clientY) {
  if (!el.timelineGrid) return -1;
  const lanes = el.timelineGrid.querySelectorAll('.tl-lane');
  for (let i = 0; i < lanes.length; i++) {
    const r = lanes[i].getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) return i;
  }
  return -1;
}

/** Candidate snap positions (in seconds) for a dragged clip's left edge. */
function snapTargets(exceptTrack, exceptSeg) {
  const targets = [0, playheadSec];
  state.tracks.forEach((t, ti) => {
    const sr = trackSr(t);
    t.segments.forEach((s, si) => {
      if (ti === exceptTrack && si === exceptSeg) return;
      const a = (s.tStart != null ? s.tStart : 0) / sr;
      targets.push(a, a + (s.end - s.start) / sr);
    });
  });
  return targets;
}

/** Snap a proposed left-edge second to a nearby target if within SNAP_PX. */
function applySnap(sec, exceptTrack, exceptSeg) {
  const tol = SNAP_PX / pxPerSec;
  let best = sec, bestD = tol;
  for (const t of snapTargets(exceptTrack, exceptSeg)) {
    const d = Math.abs(sec - t);
    if (d < bestD) { bestD = d; best = t; }
  }
  return Math.max(0, best);
}

/** @type {null | {mode:'seek'|'clip', trackIndex:number, segIndex:number, startClientX:number, startClientY:number, grabOffsetSec:number, startTStart:number, sr:number, moved:boolean, destLane:number}} */
let drag = null;

function onLanePointerDown(e) {
  if (!anyTrackHasAudio()) return;
  const rect = el.timelineGrid.getBoundingClientRect();
  if (e.clientX - rect.left < HEADER_W) return; // header zone
  const targetEl = /** @type {HTMLElement} */(e.target);
  if (targetEl.closest('.track-ctl, input, .tl-lane-head')) return;

  const laneEl = /** @type {HTMLElement|null} */(targetEl.closest('.tl-lane'));
  const laneIndex = laneEl && laneEl.dataset.index != null ? Number(laneEl.dataset.index) : -1;
  const sec = clientXToSec(e.clientX);
  const hit = laneIndex >= 0 ? clipHitTest(laneIndex, sec) : null;

  if (hit) {
    // Editing a clip always happens on its (now active) track so per-track undo
    // captures it correctly.
    if (hit.trackIndex !== state.activeTrackIndex) setActiveTrack(hit.trackIndex);
    const track = state.tracks[hit.trackIndex];
    const seg = track.segments[hit.segIndex];
    const sr = trackSr(track);
    drag = {
      mode: 'clip', trackIndex: hit.trackIndex, segIndex: hit.segIndex,
      startClientX: e.clientX, startClientY: e.clientY,
      grabOffsetSec: sec - (seg.tStart != null ? seg.tStart : 0) / sr,
      startTStart: seg.tStart != null ? seg.tStart : 0, sr, moved: false, destLane: hit.trackIndex
    };
  } else {
    drag = { mode: 'seek', trackIndex: -1, segIndex: -1, startClientX: e.clientX, startClientY: e.clientY, grabOffsetSec: 0, startTStart: 0, sr: 0, moved: false, destLane: -1 };
    seekTo(sec);
  }
  window.addEventListener('pointermove', onLanePointerMove);
  window.addEventListener('pointerup', onLanePointerUp);
}

function onLanePointerMove(e) {
  if (!drag) return;
  if (drag.mode === 'seek') { seekTo(clientXToSec(e.clientX)); return; }
  const dx = e.clientX - drag.startClientX;
  const dy = e.clientY - drag.startClientY;
  if (!drag.moved && Math.abs(dx) < CLIP_DRAG_THRESHOLD_PX && Math.abs(dy) < CLIP_DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  if (el.timeline) el.timeline.classList.add('is-dragging-clip');

  // Horizontal: move the clip's left edge to the pointer (minus grab offset),
  // snapping to 0 / playhead / other clip edges.
  const leftSec = applySnap(clientXToSec(e.clientX) - drag.grabOffsetSec, drag.trackIndex, drag.segIndex);
  const seg = state.tracks[drag.trackIndex].segments[drag.segIndex];
  seg.tStart = Math.max(0, Math.round(leftSec * drag.sr));

  // Vertical: highlight a different lane as a cross-track drop target.
  const destLane = laneIndexAtClientY(e.clientY);
  drag.destLane = destLane;
  highlightDropLane(destLane === drag.trackIndex ? -1 : destLane);

  drawAllLanes();
  positionPlayhead();
}

function onLanePointerUp(e) {
  window.removeEventListener('pointermove', onLanePointerMove);
  window.removeEventListener('pointerup', onLanePointerUp);
  if (el.timeline) el.timeline.classList.remove('is-dragging-clip');
  highlightDropLane(-1);
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode !== 'clip') return;

  if (!d.moved) {
    // A click on a clip: select it + seek there (its track is already active).
    state.selectedSegmentIndex = d.segIndex;
    seekTo(clientXToSec(d.startClientX));
    renderTimeline();
    return;
  }

  const seg = state.tracks[d.trackIndex].segments[d.segIndex];
  const droppedTStart = seg.tStart;                 // the live-dragged position
  const droppedSec = droppedTStart / d.sr;
  if (d.destLane >= 0 && d.destLane !== d.trackIndex) {
    // Cross-track move: reset the source clip to its original spot, then hand
    // off to editing.moveClipToTrack (clone → dest, remove from source).
    seg.tStart = d.startTStart;
    moveClipToTrack(d.trackIndex, d.segIndex, d.destLane, droppedSec);
  } else {
    // Within-track move: commit with history (commitClipMove restores the
    // pre-drag tStart, snapshots, re-applies, and rebuilds).
    commitClipMove(d.trackIndex, d.segIndex, d.startTStart, droppedTStart);
  }
}

/** Toggle the drop-target highlight on a lane (or clear with -1). */
function highlightDropLane(laneIndex) {
  if (!el.timelineGrid) return;
  el.timelineGrid.querySelectorAll('.tl-lane.is-drop-target').forEach(l => l.classList.remove('is-drop-target'));
  if (laneIndex >= 0) {
    const lane = el.timelineGrid.querySelector(`.tl-lane[data-index="${laneIndex}"]`);
    if (lane) lane.classList.add('is-drop-target');
  }
}

/** Scrub from a press on the ruler (maps the ruler's own x → seconds). */
function onRulerPointerDown(e) {
  if (!anyTrackHasAudio() || !el.timelineRuler) return;
  const rect = el.timelineRuler.getBoundingClientRect();
  const toSec = (cx) => Math.max(0, Math.min(projectDurationSec, xToSec(cx - rect.left)));
  seekTo(toSec(e.clientX));
  const move = (ev) => seekTo(toSec(ev.clientX));
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Move the playhead to a time; if playing, restart the mix from there. */
export function seekTo(sec) {
  playheadSec = Math.max(0, Math.min(projectDurationSec, sec));
  const wasPlaying = playing;
  if (playing) stopMix(false);
  syncActivePlaybackOffset();
  drawAllLanes();
  positionPlayhead();
  updateTransportUI();
  if (wasPlaying) startMix();
}

// ===== Transport (plays the summed mix, drives the shared playhead) =====

export function togglePlay() {
  if (playing) stopMix(false);
  else startMix();
}

function startMix() {
  if (!state.audioContext || !state.mixBuffer) return;
  if (state.audioContext.state === 'suspended') state.audioContext.resume();
  if (playheadSec >= projectDurationSec - 0.01) playheadSec = 0;

  const src = state.audioContext.createBufferSource();
  mixSource = src;
  src.buffer = state.mixBuffer;
  src.connect(state.audioContext.destination);
  src.onended = () => { if (src === mixSource) stopMix(true); };
  mixStartCtxTime = state.audioContext.currentTime;
  mixStartSec = playheadSec;
  src.start(0, playheadSec);
  playing = true;
  animate();
  updateTransportUI();
}

/** @param {boolean} [ended] true when playback ran to the end (reset to 0). */
function stopMix(ended) {
  if (mixSource) {
    try { mixSource.stop(); } catch (e) { /* already stopped */ }
    try { mixSource.disconnect(); } catch (e) { /* already disconnected */ }
  }
  if (playing && !ended && state.audioContext) {
    playheadSec = Math.min(projectDurationSec, state.audioContext.currentTime - mixStartCtxTime + mixStartSec);
  }
  if (ended) playheadSec = 0;
  mixSource = null;
  playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  syncActivePlaybackOffset();
  drawAllLanes();
  positionPlayhead();
  updateTransportUI();
}

/** Stop playback from outside (e.g. before recording / switching tracks). */
export function stopTimelinePlayback() {
  if (playing) stopMix(false);
}

export function isTimelinePlaying() { return playing; }

function animate() {
  if (!playing || !state.audioContext) return;
  const elapsed = state.audioContext.currentTime - mixStartCtxTime + mixStartSec;
  if (elapsed >= projectDurationSec) { stopMix(true); return; }
  playheadSec = elapsed;
  syncActivePlaybackOffset();
  positionPlayhead();
  drawAllLanes();
  updateTransportUI();
  rafId = requestAnimationFrame(animate);
}

function updateTransportUI() {
  if (el.playButton) {
    el.playButton.classList.toggle('playing', playing);
    el.playButton.disabled = !state.mixBuffer;
  }
  if (el.restartButton) el.restartButton.disabled = !state.mixBuffer;
  if (el.skipForwardButton) el.skipForwardButton.disabled = !state.mixBuffer;
  if (el.timeCurrent) el.timeCurrent.textContent = formatTime(playheadSec);
  if (el.timeTotal) el.timeTotal.textContent = formatTime(projectDurationSec);
}

export function seekToStart() { seekTo(0); }
export function seekToEnd() { seekTo(projectDurationSec); }

// ===== Init (wire seek + resize) =====

export function initTimeline() {
  if (el.timelineGrid) el.timelineGrid.addEventListener('pointerdown', onLanePointerDown);
  if (el.timelineRuler) el.timelineRuler.addEventListener('pointerdown', onRulerPointerDown);
  if (el.timeline) el.timeline.addEventListener('wheel', onWheel, { passive: false });
  if (el.timelineScrollbar) el.timelineScrollbar.addEventListener('pointerdown', onScrollbarPointerDown);
  // Let tracks.js drive timeline re-renders / playback stops without a static
  // import cycle (timeline statically imports tracks for the control mutations).
  registerTimeline({ renderTimeline, stopTimelinePlayback });
}

// Helpers reused from tracks.js styling of small buttons.
function iconButton(cls, title, svg, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  b.addEventListener('click', onClick);
  return b;
}

function toggleButton(cls, title, label, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.title = title;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
