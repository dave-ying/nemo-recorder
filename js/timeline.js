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
import { computePeaksForRange, pickRulerIntervalSec, formatRulerLabel } from './waveform-math.js';
import { trackSourceBuffer } from './effects.js';
import { rebuildMix } from './editing.js';
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

// ----- module playback / view state -----
let playheadSec = 0;
let pxPerSec = MIN_PX_PER_SEC;
let projectDurationSec = 0;
let laneAreaWidthCss = 0;

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

/** Seconds a track occupies on the timeline: its offset + total kept audio. */
function trackEndSec(track) {
  const src = trackSourceBuffer(track);
  if (!src || track.segments.length === 0) return 0;
  const sr = src.sampleRate;
  let len = 0;
  for (const s of track.segments) len += (s.end - s.start);
  return (track.offsetSamples || 0) / sr + len / sr;
}

function trackOffsetSec(track) {
  const src = trackSourceBuffer(track);
  const sr = src ? src.sampleRate : 48000;
  return (track.offsetSamples || 0) / sr;
}

/** Longest timeline extent across all tracks, in seconds (>=0). */
function computeProjectDurationSec() {
  let max = 0;
  for (const t of state.tracks) max = Math.max(max, trackEndSec(t));
  return max;
}

/** Fit the whole project into the available lane width (no zoom/scroll yet). */
function computeScale() {
  projectDurationSec = computeProjectDurationSec();
  const usable = Math.max(1, laneAreaWidthCss);
  pxPerSec = projectDurationSec > 0 ? Math.max(MIN_PX_PER_SEC, usable / projectDurationSec) : MIN_PX_PER_SEC;
}

function secToX(sec) { return sec * pxPerSec; }
function xToSec(x) { return pxPerSec > 0 ? x / pxPerSec : 0; }

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
  clampPlayhead();
  buildLanes();
  drawRuler();
  drawAllLanes();
  positionPlayhead();
  syncActivePlaybackOffset();
  updateTransportUI();
}

/**
 * Bridge the shared timeline playhead (project seconds) into the active track's
 * local editor playhead (state.playbackOffset), so the existing editing tools
 * (split / delete at playhead) cut at the right spot relative to the shared
 * playhead.
 */
function syncActivePlaybackOffset() {
  if (!state.recordedBuffer) { state.playbackOffset = 0; return; }
  const t = state.tracks[state.activeTrackIndex];
  const offSec = trackOffsetSec(t);
  state.playbackOffset = Math.max(0, Math.min(state.recordedBuffer.duration, playheadSec - offSec));
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

  let accSamples = track.offsetSamples || 0;
  track.segments.forEach((seg, segIndex) => {
    const len = seg.end - seg.start;
    const startSec = accSamples / sr;
    const endSec = (accSamples + len) / sr;
    accSamples += len;

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

  const intervalSec = pickRulerIntervalSec(projectDurationSec, cssW);
  ctx.fillStyle = WAVEFORM_STYLE.tickColor;
  ctx.strokeStyle = WAVEFORM_STYLE.tickColor;
  ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
  ctx.textBaseline = 'bottom';
  for (let t = 0; t <= projectDurationSec + 1e-6; t += intervalSec) {
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
  if (!anyTrackHasAudio()) { ph.style.display = 'none'; return; }
  ph.style.display = '';
  const leftPx = HEADER_W + secToX(playheadSec);
  ph.style.left = leftPx + 'px';
  ph.style.top = '0px';
  ph.style.height = (RULER_H + totalLanesHeightCss()) + 'px';
}

// ===== Pointer interaction: seek / select clip / drag clip in time =====
//
// - Press on empty lane area or the ruler → scrub the playhead (drag to move it).
// - Press on a track's clip and release without dragging → seek there, select
//   that clip, and focus its track (so split/delete/trim act on it).
// - Press on a clip and drag horizontally → reposition that whole track on the
//   timeline (updates the track's offset; all its clips move together, since a
//   track is one contiguous block of audio).

const CLIP_DRAG_THRESHOLD_PX = 4;

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
  const sr = src.sampleRate;
  let acc = (track.offsetSamples || 0) / sr;
  for (let i = 0; i < track.segments.length; i++) {
    const s = track.segments[i];
    const dur = (s.end - s.start) / sr;
    if (sec >= acc && sec <= acc + dur) return { trackIndex: laneIndex, segIndex: i };
    acc += dur;
  }
  return null;
}

/** @type {null | {mode:'seek'|'clip', trackIndex:number, segIndex:number, startClientX:number, startOffsetSamples:number, sr:number, moved:boolean}} */
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
    const track = state.tracks[hit.trackIndex];
    const src = trackSourceBuffer(track);
    drag = {
      mode: 'clip', trackIndex: hit.trackIndex, segIndex: hit.segIndex,
      startClientX: e.clientX, startOffsetSamples: track.offsetSamples || 0,
      sr: src ? src.sampleRate : 48000, moved: false
    };
  } else {
    drag = { mode: 'seek', trackIndex: -1, segIndex: -1, startClientX: e.clientX, startOffsetSamples: 0, sr: 0, moved: false };
    seekTo(sec);
  }
  window.addEventListener('pointermove', onLanePointerMove);
  window.addEventListener('pointerup', onLanePointerUp);
}

function onLanePointerMove(e) {
  if (!drag) return;
  if (drag.mode === 'seek') { seekTo(clientXToSec(e.clientX)); return; }
  // clip drag: reposition the track in time (keep pxPerSec fixed for linear feel)
  const dx = e.clientX - drag.startClientX;
  if (!drag.moved && Math.abs(dx) < CLIP_DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  if (el.timeline) el.timeline.classList.add('is-dragging-clip');
  const dSamples = Math.round((dx / pxPerSec) * drag.sr);
  const track = state.tracks[drag.trackIndex];
  track.offsetSamples = Math.max(0, drag.startOffsetSamples + dSamples);
  drawAllLanes();
  positionPlayhead();
}

function onLanePointerUp() {
  window.removeEventListener('pointermove', onLanePointerMove);
  window.removeEventListener('pointerup', onLanePointerUp);
  if (el.timeline) el.timeline.classList.remove('is-dragging-clip');
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === 'clip') {
    if (d.moved) {
      // Committed a time move: refit the scale, rebuild the mix, redraw.
      rebuildMix();
      renderTimeline();
    } else {
      // A click on a clip: focus its track + select the clip + seek there.
      if (d.trackIndex !== state.activeTrackIndex) setActiveTrack(d.trackIndex);
      state.selectedSegmentIndex = d.segIndex;
      seekTo(clientXToSec(d.startClientX));
      renderTimeline();
    }
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
