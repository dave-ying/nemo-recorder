import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, SEGMENT_GAP_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SELECTION_PULSE_PERIOD_SEC, DELETE_PULSE_PERIOD_SEC, SEGMENT_DELETE_ANIM_MS, APPEND_BUTTON_SIZE_CSS_PX, SEGMENT_DRAG_LIFT_CSS_PX, SEGMENT_DRAG_HEADROOM_CSS_PX, SEGMENT_DRAG_SETTLE_MS, SEGMENT_DRAG_SHADOW_BLUR_CSS_PX, SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_DRAG_APPROACH_RATE, SEGMENT_DRAG_SCALE_MAX, SEGMENT_CHIP_SIZE_CSS_PX, SEGMENT_CHIP_GAP_CSS_PX, SEGMENT_CHIP_MARGIN_CSS_PX, perSegmentUiActive, enabledPerSegmentEffects, segmentEffectOn, currentPlaybackRatio } from './state.js';
import { el, waveCtx, rulerCtx, dragOverlayCtx } from './dom.js';
import { pausePlayback } from './playback.js';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel, computePeaksForRange, buildWaveformPath, buildOneCardPath, findSegmentAtSamplePure, computeReorderArrangement, computeArrangementBounds } from './waveform-math.js';
import { updateEmptyState } from './ui.js';
import { getSourceBuffer } from './effects.js';
import { drawDeleteAnimFrame, prepareCanvasForAnim, buildShatterTiles, buildSlide, drawSlideCard, renderCardSnapshot, captureCanvasRegionForIndex } from './segment-anim.js';

function _buildOneCardPath(x, w, H, dpr) {
  return buildOneCardPath(x, w, H, dpr, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX);
}

// ===== Segment helpers (moved here to avoid circular deps with editing.js) =====

export function findSegmentAtSample(editedSample) {
  return findSegmentAtSamplePure(state.segments, editedSample);
}

// ===== Waveform path helpers =====

export function fillWaveformPathLive(ctx, peaks, startIdx, endIdx, midY, scale) {
  const path = new Path2D();
  buildWaveformPath(path, peaks, startIdx, endIdx, midY, scale);
  ctx.fill(path);
}

// ===== Peak computation =====

function computePeaks(width) {
  if (!state.recordedBuffer) return null;
  const data = state.recordedBuffer.getChannelData(0);
  return computePeaksForRange(data, 0, data.length, width);
}

// ===== Trash positioning =====

// ===== Playhead caret positioning =====

// Callers that already computed segBounds/device width for this frame (e.g.
// drawPlaybackWaveform) pass them in to avoid a duplicate O(N) computation.
function positionPlayheadCarets(ratio, segBounds, deviceW) {
  if (!state.recordedBuffer || el.playbackView.hidden || ratio < 0 || ratio > 1) {
    el.playheadCaretTop.style.display = 'none';
    return;
  }

  if (!_cachedCanvasRect || !_cachedViewRect) return;
  const canvasRect = _cachedCanvasRect;
  const viewRect = _cachedViewRect;
  const dpr = window.devicePixelRatio || 1;
  const W = deviceW != null ? deviceW : Math.floor(canvasRect.width * dpr);
  if (!segBounds) {
    const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
    segBounds = _computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  }
  const visualRatio = audioRatioToVisualRatio(ratio, W, segBounds);
  const lineXCssPx = Math.floor(visualRatio * W) / dpr;
  const leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;

  el.playheadCaretTop.style.display = '';

  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX;
  // top and height are layout-constant — only write when they change (set via style object check)
  const heightPx = Math.max(0, canvasRect.height - 2 * insetY);
  if (el.playheadLine.style.height !== heightPx + 'px') {
    el.playheadLine.style.height = heightPx + 'px';
  }
  // top depends on canvasRect.top which only changes on scroll/resize — cache it in rect cache
  const topPx = (canvasRect.top - viewRect.top) + insetY - (_cachedLineOffsetTop || 0);
  if (el.playheadCaretTop.style.top !== topPx + 'px') {
    el.playheadCaretTop.style.top = topPx + 'px';
  }
  el.playheadCaretTop.style.left = leftPx + 'px';
}

function playheadCaretMouseDown(e) {
  e.preventDefault();
  e.stopPropagation();
  if (state.isPlaying) pausePlayback();
  state.draggingPlayhead = true;
  el.playheadCaretTop.classList.add('dragging');
  hideSegmentTrash();
}

function playheadCaretTouchStart(e) {
  e.preventDefault();
  if (state.isPlaying) pausePlayback();
  state.draggingPlayhead = true;
  el.playheadCaretTop.classList.add('dragging');
  hideSegmentTrash();
}

el.playheadCaretTop.addEventListener('mousedown', playheadCaretMouseDown);
el.playheadCaretTop.addEventListener('touchstart', playheadCaretTouchStart, { passive: false });
el.playheadCaretTop.addEventListener('click', (e) => e.stopPropagation());

export function removePlayheadCaretDraggingClass() {
  el.playheadCaretTop.classList.remove('dragging');
}

// ===== Trash show/hide helpers =====

export function hideSegmentTrash() {
  state.selectedSegmentIndex = -1;
  el.deleteSegmentButton.classList.add('btn-inactive');
  state.isHoveringTrash = false;
  stopSelectionAnim();
  if (!state.isPlaying && state.recordedBuffer) {
    drawPlaybackWaveform(currentPlaybackRatio());
  }
}

export function clearSegmentHover() {
  state.hoverSegmentIndex = -1;
  el.waveformContainer.style.cursor = 'default';
}

export function showSegmentTrash(index) {
  if (index < 0 || index >= state.segments.length) return;
  state.selectedSegmentIndex = index;
  el.deleteSegmentButton.classList.remove('btn-inactive');
  startSelectionAnim();
}

el.deleteSegmentButton.addEventListener('mouseenter', () => { state.isHoveringTrash = true; });
el.deleteSegmentButton.addEventListener('mouseleave', () => { state.isHoveringTrash = false; });

let selectionAnimRaf = null;
let _lastPulseTime = 0;

function startSelectionAnim() {
  if (selectionAnimRaf) return;
  _lastPulseTime = 0;
  const tick = (now) => {
    if (state.selectedSegmentIndex < 0) { selectionAnimRaf = null; return; }
    // Throttle to ~24 fps — the pulse is a slow sine wave, no need for 60 fps
    if (now - _lastPulseTime < 41) {
      selectionAnimRaf = requestAnimationFrame(tick);
      return;
    }
    _lastPulseTime = now;
    if (!state.isPlaying && state.recordedBuffer) {
      drawPlaybackWaveform(currentPlaybackRatio());
    }
    selectionAnimRaf = requestAnimationFrame(tick);
  };
  selectionAnimRaf = requestAnimationFrame(tick);
}

function stopSelectionAnim() {
  if (selectionAnimRaf) { cancelAnimationFrame(selectionAnimRaf); selectionAnimRaf = null; }
}

function positionAppendButton() {
  if (!state.recordedBuffer || state.isRecording || el.playbackView.hidden) {
    el.appendButton.classList.remove('visible');
    el.appendMenu.hidden = true;
    return;
  }
  if (!_cachedCanvasRect || !_cachedViewRect) return;
  if (!_cachedStageRect) _cachedStageRect = el.stage.getBoundingClientRect();
  const canvasRect = _cachedCanvasRect;
  const viewRect = _cachedViewRect;
  const stageRect = _cachedStageRect;
  const gapLeftPx = canvasRect.right - viewRect.left;
  const gapRightPx = stageRect.right - viewRect.left;
  const gapWidthPx = gapRightPx - gapLeftPx;
  let leftPx = gapLeftPx + Math.max(0, (gapWidthPx - APPEND_BUTTON_SIZE_CSS_PX) / 2);
  const midY = (canvasRect.top - viewRect.top) + canvasRect.height / 2;
  const topPx = midY - APPEND_BUTTON_SIZE_CSS_PX / 2;
  if (el.appendButton.style.left !== leftPx + 'px') el.appendButton.style.left = leftPx + 'px';
  if (el.appendButton.style.top !== topPx + 'px') el.appendButton.style.top = topPx + 'px';
  el.appendButton.classList.add('visible');
}

// ===== Playback waveform rendering =====

function buildSegmentCardPaths(segBounds, H, dpr) {
  const cardPaths = [];
  for (const sb of segBounds) {
    cardPaths.push(_buildOneCardPath(sb.drawStart, sb.drawEnd - sb.drawStart, H, dpr));
  }
  return cardPaths;
}

// ===== Render caches =====

/** @type {HTMLCanvasElement | null} */
let baseLayerCanvas = null;
let baseLayerKey = '';
/** @type {HTMLCanvasElement | null} */
let playedLayerCanvas = null;
/** @type {HTMLCanvasElement | null} */
let unplayedLayerCanvas = null;
let waveformLayerKey = '';
/** @type {Array<Path2D | null>} */
let cachedCardPaths = [];
let cardPathsKey = '';
let rulerCacheKey = '';

// Layout rect cache — invalidated on resize to avoid forced reflows
let _cachedCanvasRect = null;
let _cachedViewRect = null;
let _cachedStageRect = null;
let _cachedLineOffsetTop = null;
let _cachedPathHeight = 0;

export function invalidateRectCache() {
  _cachedCanvasRect = null;
  _cachedViewRect = null;
  _cachedStageRect = null;
  _cachedLineOffsetTop = null;
}

function segmentGeometryKey(W, H, dpr) {
  let k = W + 'x' + H + '@' + dpr;
  for (const s of state.segments) k += '|' + s.start + ':' + s.end;
  return k;
}

function renderBaseLayer(segBounds, cardPaths, W, H, dpr) {
  if (!baseLayerCanvas) baseLayerCanvas = document.createElement('canvas');
  if (baseLayerCanvas.width !== W) baseLayerCanvas.width = W;
  if (baseLayerCanvas.height !== H) baseLayerCanvas.height = H;
  const ctx = baseLayerCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  const midY = H / 2;

  for (let i = 0; i < cardPaths.length; i++) {
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    ctx.save();
    ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
    ctx.shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
    ctx.shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
    ctx.fillStyle = i === state.draggingSegmentIndex ? 'rgba(255, 255, 255, 0.018)' : WAVEFORM_STYLE.segmentCardBg;
    ctx.fill(cardPath);
    ctx.restore();
  }

  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    ctx.save();
    ctx.clip(cardPath);
    ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sb.drawStart, midY);
    ctx.lineTo(sb.drawEnd, midY);
    ctx.stroke();
    ctx.restore();
  }
}

function renderWaveformLayers(path, segBounds, cardPaths, W, H, dpr) {
  if (!playedLayerCanvas) playedLayerCanvas = document.createElement('canvas');
  if (!unplayedLayerCanvas) unplayedLayerCanvas = document.createElement('canvas');
  if (playedLayerCanvas.width !== W) playedLayerCanvas.width = W;
  if (playedLayerCanvas.height !== H) playedLayerCanvas.height = H;
  if (unplayedLayerCanvas.width !== W) unplayedLayerCanvas.width = W;
  if (unplayedLayerCanvas.height !== H) unplayedLayerCanvas.height = H;

  const playedCtx = playedLayerCanvas.getContext('2d');
  const unplayedCtx = unplayedLayerCanvas.getContext('2d');

  playedCtx.clearRect(0, 0, W, H);
  unplayedCtx.clearRect(0, 0, W, H);

  for (let i = 0; i < cardPaths.length; i++) {
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    playedCtx.save();
    playedCtx.clip(cardPath);
    playedCtx.fillStyle = WAVEFORM_STYLE.playedColor;
    playedCtx.fill(path);
    playedCtx.restore();

    unplayedCtx.save();
    unplayedCtx.clip(cardPath);
    unplayedCtx.fillStyle = WAVEFORM_STYLE.unplayedColor;
    unplayedCtx.fill(path);
    unplayedCtx.restore();
  }
}

function drawSegmentCards(ctx, path, segBounds, cardPaths, playheadX, H, dpr) {
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;

  const selectedIdx = state.selectedSegmentIndex;
  const hoverIdx = state.hoverSegmentIndex;
  const hasSelection = selectedIdx >= 0 && selectedIdx < segBounds.length;
  const isMarkedForDelete = hasSelection && state.isHoveringTrash;
  const pulsePeriod = isMarkedForDelete ? DELETE_PULSE_PERIOD_SEC : SELECTION_PULSE_PERIOD_SEC;
  const pulse = hasSelection
    ? (Math.sin((performance.now() / 1000) * (Math.PI * 2 / pulsePeriod)) + 1) / 2
    : 0;

  // Draw card backgrounds (base layer) — no hover/selected tint
  if (baseLayerCanvas) ctx.drawImage(baseLayerCanvas, 0, 0);

  // Hover card-background tint goes UNDER the waveform (matching the legacy
  // look where it lived in the base layer): brighten the card, not the wave.
  if (hoverIdx >= 0 && hoverIdx < segBounds.length && hoverIdx !== selectedIdx && hoverIdx !== state.draggingSegmentIndex) {
    const hoverPath = cardPaths[hoverIdx];
    if (hoverPath) {
      ctx.fillStyle = WAVEFORM_STYLE.hoverCardBg;
      ctx.fill(hoverPath);
    }
  }

  // Draw pre-rendered waveform layers
  if (unplayedLayerCanvas) ctx.drawImage(unplayedLayerCanvas, 0, 0);
  if (playedLayerCanvas && playheadX > 0) {
    ctx.drawImage(playedLayerCanvas, 0, 0, playheadX, H, 0, 0, playheadX, H);
  }

  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    const w = sb.drawEnd - sb.drawStart;
    const isSelected = i === selectedIdx;
    const isDragged = i === state.draggingSegmentIndex;

    if (isSelected) {
      // The standard waveform layers were already blitted across this card;
      // erase them (clip + clear) and re-stamp the card exactly as the legacy
      // renderer did: brighter card bg, midline, then the selected-color fills.
      ctx.save();
      ctx.clip(cardPath);
      ctx.clearRect(sb.drawStart - 1, 0, w + 2, H);
      ctx.fillStyle = WAVEFORM_STYLE.hoverCardBg;
      ctx.fill(cardPath);
      ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sb.drawStart, H / 2);
      ctx.lineTo(sb.drawEnd, H / 2);
      ctx.stroke();

      const midX = Math.min(sb.drawEnd, Math.max(sb.drawStart, playheadX));
      const unplayedColor = isMarkedForDelete
        ? lerpColorAlpha(WAVEFORM_STYLE.deleteUnplayedColorDim, WAVEFORM_STYLE.deleteUnplayedColorBright, pulse)
        : lerpColorAlpha(WAVEFORM_STYLE.selectedUnplayedColorDim, WAVEFORM_STYLE.selectedUnplayedColorBright, pulse);
      const playedColor = isMarkedForDelete ? WAVEFORM_STYLE.deletePlayedColor : WAVEFORM_STYLE.selectedPlayedColor;
      if (midX > sb.drawStart) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(sb.drawStart, 0, midX - sb.drawStart, H);
        ctx.clip();
        ctx.fillStyle = playedColor;
        ctx.fill(path);
        ctx.restore();
      }
      if (midX < sb.drawStart + w) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(midX, 0, sb.drawStart + w - midX, H);
        ctx.clip();
        ctx.fillStyle = unplayedColor;
        ctx.fill(path);
        ctx.restore();
      }
      ctx.restore();

      const glowBlur = (6 + pulse * 8) * dpr;
      ctx.save();
      ctx.strokeStyle = isMarkedForDelete ? WAVEFORM_STYLE.deleteEdgeColor : WAVEFORM_STYLE.selectedEdgeColor;
      ctx.lineWidth = isMarkedForDelete ? edgeWidth * 1.5 : edgeWidth;
      ctx.shadowColor = isMarkedForDelete ? WAVEFORM_STYLE.deleteGlowColor : WAVEFORM_STYLE.selectedGlowColor;
      ctx.shadowBlur = glowBlur;
      ctx.stroke(cardPath);
      ctx.restore();
    } else if (isDragged) {
      ctx.save();
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
      ctx.lineWidth = edgeWidth;
      ctx.stroke(cardPath);
      ctx.restore();
    } else if (i === hoverIdx) {
      ctx.strokeStyle = WAVEFORM_STYLE.hoverEdgeColor;
      ctx.lineWidth = edgeWidth;
      ctx.stroke(cardPath);
    } else {
      ctx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
      ctx.lineWidth = edgeWidth;
      ctx.stroke(cardPath);
    }
  }

  if (perSegmentUiActive()) drawSegmentChips(ctx, segBounds, H, dpr);
}

// ===== Per-segment effect chips =====
//
// In per-segment scope, each card shows a small chip per enabled per-segment
// effect in its top-right corner: filled in the effect's identity color when
// the effect is on for that segment, hollow (faint fill + dim outline) when
// off. Chips stack leftward from the right edge; the first effect sits nearest
// the corner. Geometry is pure (unit-agnostic) so drawing (device px) and
// hit-testing (CSS px) share the same layout math.

/**
 * @param {number} cardStart @param {number} cardEnd @param {number} topInset
 * @param {number} size @param {number} gap @param {number} margin @param {number} count
 * @returns {Array<{x:number,y:number,w:number,h:number}>} up to `count` rects
 */
function chipLayout(cardStart, cardEnd, topInset, size, gap, margin, count) {
  const rects = [];
  const y = topInset + margin;
  let right = cardEnd - margin;
  for (let i = 0; i < count; i++) {
    const x = right - size;
    if (x < cardStart + margin) break; // out of room on a narrow card
    rects.push({ x, y, w: size, h: size });
    right = x - gap;
  }
  return rects;
}

function drawSegmentChips(ctx, segBounds, H, dpr) {
  const effects = enabledPerSegmentEffects();
  if (effects.length === 0) return;
  const topInset = SEGMENT_VERTICAL_INSET_CSS_PX * dpr;
  const size = SEGMENT_CHIP_SIZE_CSS_PX * dpr;
  const gap = SEGMENT_CHIP_GAP_CSS_PX * dpr;
  const margin = SEGMENT_CHIP_MARGIN_CSS_PX * dpr;
  const radius = 4 * dpr;
  // First pass: dim any card that receives NONE of the enabled per-segment
  // effects, so "off" segments visibly recede at a glance (the chips then say
  // precisely which effects are off). A neutral dark wash, distinct from the
  // teal played/unplayed shading.
  for (let i = 0; i < segBounds.length; i++) {
    if (i === state.draggingSegmentIndex) continue;
    const seg = state.segments[i];
    if (effects.every(e => !segmentEffectOn(seg, e.key))) {
      const sb = segBounds[i];
      const cardPath = _buildOneCardPath(sb.drawStart, sb.drawEnd - sb.drawStart, H, dpr);
      if (!cardPath) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(8, 8, 11, 0.5)';
      ctx.fill(cardPath);
      ctx.restore();
    }
  }
  for (let i = 0; i < segBounds.length; i++) {
    if (i === state.draggingSegmentIndex) continue;
    const sb = segBounds[i];
    const rects = chipLayout(sb.drawStart, sb.drawEnd, topInset, size, gap, margin, effects.length);
    const seg = state.segments[i];
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j];
      const eff = effects[j];
      const on = segmentEffectOn(seg, eff.key);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, radius);
      if (on) {
        ctx.fillStyle = eff.color;
        ctx.shadowColor = eff.color;
        ctx.shadowBlur = 6 * dpr;
        ctx.fill();
        ctx.shadowBlur = 0;
        // A small check mark reads unambiguously as "on" even for viewers who
        // don't register the color/fill difference.
        ctx.strokeStyle = 'rgba(10, 10, 12, 0.9)';
        ctx.lineWidth = 1.6 * dpr;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(r.x + r.w * 0.28, r.y + r.h * 0.52);
        ctx.lineTo(r.x + r.w * 0.44, r.y + r.h * 0.68);
        ctx.lineTo(r.x + r.w * 0.74, r.y + r.h * 0.34);
        ctx.stroke();
      } else {
        ctx.fillStyle = eff.colorSoft;
        ctx.fill();
        ctx.strokeStyle = eff.color;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.4 * dpr;
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

/**
 * Which per-segment effect chip (if any) is under a client point. Returns the
 * segment index + effect key so a click can toggle it. Only hit-tests when the
 * per-segment UI is active (segment scope + an enabled per-segment effect).
 */
export function getSegmentChipAtClientPoint(clientX, clientY) {
  if (!state.recordedBuffer || !perSegmentUiActive()) return null;
  const effects = enabledPerSegmentEffects();
  if (effects.length === 0) return null;
  const rect = el.waveformContainer.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const segBounds = _computeSegmentBounds(rect.width, state.recordedBuffer.length, SEGMENT_GAP_CSS_PX);
  for (let i = 0; i < segBounds.length; i++) {
    const rects = chipLayout(segBounds[i].drawStart, segBounds[i].drawEnd,
      SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_CHIP_SIZE_CSS_PX, SEGMENT_CHIP_GAP_CSS_PX, SEGMENT_CHIP_MARGIN_CSS_PX, effects.length);
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { index: i, key: effects[j].key };
    }
  }
  return null;
}

function lerpColorAlpha(dimRgba, brightRgba, t) {
  const d = parseRgbaCached(dimRgba);
  const b = parseRgbaCached(brightRgba);
  const r = Math.round(d.r + (b.r - d.r) * t);
  const g = Math.round(d.g + (b.g - d.g) * t);
  const bl = Math.round(d.b + (b.b - d.b) * t);
  const a = d.a + (b.a - d.a) * t;
  return `rgba(${r}, ${g}, ${bl}, ${a})`;
}

// The style colors are module constants, so parsing them once per string
// avoids running the regex every animation frame.
const _rgbaCache = new Map();
function parseRgbaCached(str) {
  let c = _rgbaCache.get(str);
  if (!c) {
    c = parseRgba(str);
    _rgbaCache.set(str, c);
  }
  return c;
}

function parseRgba(str) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(str);
  return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
}

function _computeSegmentBounds(W, totalSamples, gapPx) {
  return computeSegmentBoundsPure(W, state.segments, totalSamples, gapPx);
}

export function visualRatioToAudioRatioWithState(visualRatio, W, gapPx) {
  if (!state.recordedBuffer) return visualRatio;
  const segBounds = _computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  return visualRatioToAudioRatio(visualRatio, W, segBounds);
}

// ===== Timeline ruler =====

const RULER_MAJOR_TICK_CSS_PX = 9;
const RULER_MINOR_TICK_CSS_PX = 5;
const RULER_MINOR_TICKS_PER_MAJOR = 5;
const RULER_LABEL_GAP_CSS_PX = 4;

function drawTimelineRuler(duration, segBounds, W, dpr, geomKey) {
  const rect = el.timelineRulerCanvas.getBoundingClientRect();
  const H = Math.max(1, Math.floor(rect.height * dpr));
  const key = geomKey + '#' + H + '#' + duration + '#' + rect.width;
  if (key === rulerCacheKey) return;
  rulerCacheKey = key;
  if (el.timelineRulerCanvas.width !== W) el.timelineRulerCanvas.width = W;
  if (el.timelineRulerCanvas.height !== H) el.timelineRulerCanvas.height = H;
  rulerCtx.clearRect(0, 0, W, H);
  if (duration <= 0 || rect.width <= 0) return;

  const majorTickH = RULER_MAJOR_TICK_CSS_PX * dpr;
  const minorTickH = RULER_MINOR_TICK_CSS_PX * dpr;
  const lineW = Math.max(1, Math.round(dpr));
  const intervalSec = pickRulerIntervalSec(duration, rect.width);
  const minorIntervalSec = intervalSec / RULER_MINOR_TICKS_PER_MAJOR;
  const EPS = intervalSec * 1e-6;

  rulerCtx.fillStyle = WAVEFORM_STYLE.tickColor;

  rulerCtx.globalAlpha = 0.55;
  for (let t = 0; t <= duration + EPS; t += minorIntervalSec) {
    const x = Math.floor(audioRatioToVisualRatio(t / duration, W, segBounds) * W);
    rulerCtx.fillRect(x - lineW / 2, H - minorTickH, lineW, minorTickH);
  }

  rulerCtx.globalAlpha = 1;
  rulerCtx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
  for (let t = 0; t <= duration + EPS; t += intervalSec) {
    const x = Math.floor(audioRatioToVisualRatio(t / duration, W, segBounds) * W);
    rulerCtx.fillRect(x - lineW / 2, H - majorTickH, lineW, majorTickH);
    const label = formatRulerLabel(t, intervalSec);
    const tw = rulerCtx.measureText(label).width;
    const labelX = Math.max(2 * dpr, Math.min(W - tw - 2 * dpr, x - tw / 2));
    rulerCtx.fillText(label, labelX, H - majorTickH - RULER_LABEL_GAP_CSS_PX * dpr);
  }
}

// ===== Segment delete animation (orchestration) =====

let deleteAnim = null;

function cancelSegmentDeleteAnimation() {
  if (!deleteAnim) return;
  cancelAnimationFrame(deleteAnim.raf);
  clearDomSlideTransitions();
  deleteAnim = null;
}

function clearDomSlideTransitions() {
  el.playheadCaretTop.style.transition = '';
}

function beginSegmentAnim(slides, snap, tiles, oldPlayheadX, newPlayheadX, newPlayheadRatio, reverseTiles, dpr, W, H, onComplete) {
  cancelSegmentDeleteAnimation();

  const domTransition = `left ${SEGMENT_DELETE_ANIM_MS}ms cubic-bezier(0.33, 1, 0.68, 1), top ${SEGMENT_DELETE_ANIM_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`;
  el.playheadCaretTop.style.transition = domTransition;
  positionPlayheadCarets(newPlayheadRatio);

  deleteAnim = { startTime: performance.now(), slides, snap, tiles, W, H, dpr, oldPlayheadX, newPlayheadX, reverseTiles, raf: null };

  const tick = (now) => {
    drawDeleteAnimFrame(deleteAnim, now);
    if (now - deleteAnim.startTime < SEGMENT_DELETE_ANIM_MS) {
      deleteAnim.raf = requestAnimationFrame(tick);
    } else {
      clearDomSlideTransitions();
      deleteAnim = null;
      if (onComplete) onComplete();
      else drawPlaybackWaveform(newPlayheadRatio);
    }
  };
  deleteAnim.raf = requestAnimationFrame(tick);
}

function drawDropIndicator(ctx, x, H, dpr) {
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX * dpr;
  const top = insetY;
  const bottom = H - insetY;
  const cs = 5 * dpr;
  ctx.save();
  ctx.strokeStyle = WAVEFORM_STYLE.selectedEdgeColor;
  ctx.lineWidth = 2 * dpr;
  ctx.shadowColor = WAVEFORM_STYLE.selectedGlowColor;
  ctx.shadowBlur = 10 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = WAVEFORM_STYLE.selectedEdgeColor;
  ctx.beginPath();
  ctx.moveTo(x - cs, top - cs);
  ctx.lineTo(x + cs, top - cs);
  ctx.lineTo(x, top);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - cs, bottom + cs);
  ctx.lineTo(x + cs, bottom + cs);
  ctx.lineTo(x, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawPlaybackWaveform(playheadRatio = 0) {
  // While a segment drag animation is running, it owns the waveform canvas.
  // External callers (resize, hover, etc.) would clobber the drag frame; bail
  // and let the drag rAF loop continue rendering.
  if (dragAnimRaf !== null) return;
  if (deleteAnim) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));

  if (el.waveformCanvas.width !== W) el.waveformCanvas.width = W;
  if (el.waveformCanvas.height !== H) el.waveformCanvas.height = H;

  // Update the rect cache when the canvas geometry changes. All dependent
  // rects must refresh together — a layout shift moves the canvas AND the
  // view/stage in lockstep, so refreshing only one desyncs caret positioning.
  if (!_cachedCanvasRect || _cachedCanvasRect.width !== rect.width || _cachedCanvasRect.height !== rect.height || _cachedCanvasRect.top !== rect.top || _cachedCanvasRect.left !== rect.left) {
    _cachedCanvasRect = rect;
    _cachedViewRect = el.editorSection.getBoundingClientRect();
    _cachedStageRect = el.stage.getBoundingClientRect();
    _cachedLineOffsetTop = el.playheadLine.offsetTop;
  }

  waveCtx.clearRect(0, 0, W, H);

  if (!state.recordedBuffer) {
    el.playheadCaretTop.style.display = 'none';
    rulerCtx.clearRect(0, 0, el.timelineRulerCanvas.width, el.timelineRulerCanvas.height);
    rulerCacheKey = '';
    return;
  }

  const totalSamples = state.recordedBuffer.length;
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const segBounds = _computeSegmentBounds(W, totalSamples, gapPx);
  const visualRatio = audioRatioToVisualRatio(playheadRatio, W, segBounds);

  positionPlayheadCarets(playheadRatio, segBounds, W);

  if (!state.cachedPeaks || state.cachedPeaksWidth !== W) {
    state.cachedPeaks = computePeaks(W);
    state.cachedPeaksWidth = W;
    state.cachedPath = null;
    // Fresh PCM with unchanged geometry (loudness normalize, denoise,
    // undo/redo of PCM-replacing ops) leaves geomKey identical — force the
    // pre-rendered waveform layers to re-render from the new peaks too,
    // otherwise the stale amplitude shape keeps being blitted.
    waveformLayerKey = '';
  }
  // Peaks are height-independent, but the path bakes in H/2 — rebuild it when
  // the canvas height changes even if the width (and peaks) are unchanged.
  if (!state.cachedPath || _cachedPathHeight !== H) {
    state.cachedPath = new Path2D();
    buildWaveformPath(state.cachedPath, state.cachedPeaks, 0, W, H / 2, WAVEFORM_SCALE);
    _cachedPathHeight = H;
  }
  const path = state.cachedPath;

  const playheadX = Math.floor(visualRatio * W);

  const geomKey = segmentGeometryKey(W, H, dpr);
  if (geomKey !== cardPathsKey) {
    cachedCardPaths = buildSegmentCardPaths(segBounds, H, dpr);
    cardPathsKey = geomKey;
  }
  const baseKey = geomKey + '#' + state.draggingSegmentIndex;
  if (baseKey !== baseLayerKey) {
    renderBaseLayer(segBounds, cachedCardPaths, W, H, dpr);
    baseLayerKey = baseKey;
  }
  // Waveform layers keyed on geometry only (colors are constant)
  if (geomKey !== waveformLayerKey) {
    renderWaveformLayers(path, segBounds, cachedCardPaths, W, H, dpr);
    waveformLayerKey = geomKey;
  }

  drawSegmentCards(waveCtx, path, segBounds, cachedCardPaths, playheadX, H, dpr);

  if (state.draggingSegmentIndex >= 0 && state._segmentDragSnapshot) {
    const snap = state._segmentDragSnapshot;
    const isNoOp = snap.dropInsertIndex === snap.srcIndex || snap.dropInsertIndex === snap.srcIndex + 1;
    if (!isNoOp) {
      let indicatorX;
      if (snap.dropInsertIndex === 0) indicatorX = segBounds[0].drawStart;
      else if (snap.dropInsertIndex === segBounds.length) indicatorX = segBounds[segBounds.length - 1].drawEnd;
      else indicatorX = (segBounds[snap.dropInsertIndex - 1].drawEnd + segBounds[snap.dropInsertIndex].drawStart) / 2;
      drawDropIndicator(waveCtx, indicatorX, H, dpr);
    }
  }

  positionAppendButton();

  if (state.selectedSegmentIndex >= 0 && state.selectedSegmentIndex >= segBounds.length) {
    hideSegmentTrash();
  }

  drawTimelineRuler(state.recordedBuffer.duration, segBounds, W, dpr, geomKey);
}

// ===== Segment reorder drag animation =====
//
// While the user drags a segment, a requestAnimationFrame loop owns the
// waveform canvas and renders:
//   - non-dragged segments easing toward their would-be positions in the live
//     arrangement (so the row visually reshuffles as the pointer moves)
//   - a faint dashed "drop zone" outline where the dragged segment would land
//   - the dragged segment itself as a floating card that follows the pointer,
//     lifted up with a deeper shadow
// On pointerup the loop enters a settle phase: the floating card eases into
// its final slot, the lift decays to zero, and normal rendering resumes.
//
// `drawPlaybackWaveform` bails out while this loop is running (see top of that
// function), so the drag frame is never clobbered by an external redraw.

let dragAnimRaf = null;
let dragAnimLastTime = 0;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

/**
 * Start the drag animation rAF loop if it isn't already running. Safe to call
 * every pointermove — the loop reads the current `state._segmentDragSnapshot`
 * each frame, so updates to dropInsertIndex / pointerX are picked up naturally.
 */
export function ensureDragAnimRunning() {
  if (dragAnimRaf !== null) return;
  dragAnimLastTime = performance.now();
  const tick = (now) => {
    if (!state._segmentDragSnapshot) {
      releaseDragOverlay();
      dragAnimRaf = null;
      return;
    }
    const dt = Math.max(0, (now - dragAnimLastTime) / 1000);
    dragAnimLastTime = now;
    stepDragAnim(dt, now);
    drawDragFrame();
    const snap = state._segmentDragSnapshot;
    if (snap && snap.settle && (now - snap.settle.startTime) >= snap.settle.duration) {
      const finalRatio = snap.settle.finalRatio;
      state._segmentDragSnapshot = null;
      state.draggingSegmentIndex = -1;
      state.hoverSegmentIndex = -1;
      el.waveformContainer.style.cursor = 'default';
      releaseDragOverlay();
      dragAnimRaf = null;
      // Restore normal rendering. cachedPeaks/cachedPath were nulled by
      // rebuildPlaybackBuffer at settle start, so this rebuilds them too.
      drawPlaybackWaveform(finalRatio);
      return;
    }
    dragAnimRaf = requestAnimationFrame(tick);
  };
  dragAnimRaf = requestAnimationFrame(tick);
}

/**
 * Hide + clear the drag overlay canvas when no drag is active. Called from
 * every rAF loop exit branch so a stale frame from a previous drag can't
 * linger (and so we don't waste cycles clearing it next drag start).
 */
function releaseDragOverlay() {
  if (!el.dragOverlayCanvas.hidden) el.dragOverlayCanvas.hidden = true;
  const overlay = el.dragOverlayCanvas;
  dragOverlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

/**
 * Advance the drag animation one tick: ease animated bounds toward target
 * bounds (live drag) or along the settle trajectory (post-release).
 */
function stepDragAnim(dt, now) {
  const snap = state._segmentDragSnapshot;
  if (!snap) return;
  const dpr = window.devicePixelRatio || 1;
  const maxLift = SEGMENT_DRAG_LIFT_CSS_PX * dpr;

  if (snap.settle) {
    const t = Math.max(0, Math.min(1, (now - snap.settle.startTime) / snap.settle.duration));
    const eased = easeOutCubic(t);
    const ab = snap.animBounds[snap.srcIndex];
    ab.drawStart = snap.settle.fromX + (snap.settle.toX - snap.settle.fromX) * eased;
    ab.drawEnd = snap.settle.fromDrawEnd + (snap.settle.toDrawEnd - snap.settle.fromDrawEnd) * eased;
    snap.liftPx = snap.settle.fromLift + (snap.settle.toLift - snap.settle.fromLift) * eased;
    return;
  }

  // Live drag: exponential approach toward target bounds + max lift.
  const alpha = 1 - Math.exp(-SEGMENT_DRAG_APPROACH_RATE * Math.max(dt, 1 / 1000));
  for (let i = 0; i < snap.animBounds.length; i++) {
    const ab = snap.animBounds[i];
    const tb = snap.targetBounds[i];
    ab.drawStart += (tb.drawStart - ab.drawStart) * alpha;
    ab.drawEnd += (tb.drawEnd - ab.drawEnd) * alpha;
  }
  snap.liftPx += (maxLift - snap.liftPx) * alpha;
}

/**
 * Locate the playhead within the live arrangement. The playhead is a fixed
 * timeline position during a reorder — it does NOT follow the dragged segment
 * or any audio content. Resolves the arrangement to its would-be segment
 * order and reuses findSegmentAtSamplePure's boundary semantics (a sample
 * exactly on a boundary belongs to the right segment; past-the-end clamps to
 * the last segment).
 *
 * @returns {{ k: number, frac: number }} `k` = position in the arrangement of
 *   the segment containing the playhead (-1 if there are no segments);
 *   `frac` = the playhead's fraction within that segment (0..1).
 */
function locatePlayheadInArrangement(snap) {
  const total = state.recordedBuffer.length;
  const sr = state.originalBuffer.sampleRate;
  const ph = Math.max(0, Math.min(total, Math.round(state.playbackOffset * sr)));
  const ordered = snap.arrangement.map(i => snap.originalSegments[i]);
  const hit = findSegmentAtSamplePure(ordered, ph);
  if (!hit) return { k: -1, frac: 0 };
  const segLen = hit.seg.end - hit.seg.start;
  return { k: hit.index, frac: segLen > 0 ? Math.max(0, Math.min(1, hit.offsetInSeg / segLen)) : 0 };
}

/**
 * Compute the playhead caret's device-px X for the current drag frame. The
 * caret sits wherever the fixed playhead time falls in the live arrangement,
 * using the containing card's animated bounds — so it glides with the cards
 * as they ease toward their would-be positions, but never follows the dragged
 * card or the pointer.
 */
function computeDragPlayheadX(snap) {
  const { k, frac } = locatePlayheadInArrangement(snap);
  if (k < 0) return -1;
  const ab = snap.animBounds[snap.arrangement[k]];
  if (!ab) return -1;
  return ab.drawStart + frac * (ab.drawEnd - ab.drawStart);
}

/**
 * Position the playhead carets at a specific device-px X on the waveform
 * canvas, bypassing the normal audio-ratio-based positioning (which would use
 * state.segments in its current order and conflict with the live arrangement).
 */
function positionPlayheadCaretsAtDeviceX(deviceX) {
  if (deviceX < 0 || !state.recordedBuffer || el.playbackView.hidden) {
    el.playheadCaretTop.style.display = 'none';
    return;
  }
  if (!_cachedCanvasRect || !_cachedViewRect) return;
  const canvasRect = _cachedCanvasRect;
  const viewRect = _cachedViewRect;
  const dpr = window.devicePixelRatio || 1;
  const lineXCssPx = deviceX / dpr;
  const leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;
  el.playheadCaretTop.style.display = '';
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX;
  const heightPx = Math.max(0, canvasRect.height - 2 * insetY);
  if (el.playheadLine.style.height !== heightPx + 'px') {
    el.playheadLine.style.height = heightPx + 'px';
  }
  const topPx = (canvasRect.top - viewRect.top) + insetY - (_cachedLineOffsetTop || 0);
  if (el.playheadCaretTop.style.top !== topPx + 'px') {
    el.playheadCaretTop.style.top = topPx + 'px';
  }
  el.playheadCaretTop.style.left = leftPx + 'px';
}

/**
 * Render a single segment card at the given animated bounds, using a pre-built
 * local waveform path (built once at drag-begin) scaled to fit the current
 * width. Optional `lift`, `scale`, `bg`, `shadowBlur`, `shadowOffsetY`, and
 * `strokeColor` let the caller style the floating dragged card differently
 * from the in-place cards.
 */
function drawDragCard(ctx, segPath, pathWidth, drawStart, drawEnd, playheadX, H, dpr, options) {
  const curWidth = drawEnd - drawStart;
  if (curWidth <= 0 || !segPath) return;
  const cardPath = _buildOneCardPath(drawStart, curWidth, H, dpr);
  if (!cardPath) return;

  const lift = options.lift || 0;
  const scale = options.scale || 1;
  const edgeWidth = options.edgeWidth;
  const bg = options.bg || WAVEFORM_STYLE.segmentCardBg;

  ctx.save();
  if (lift > 0) ctx.translate(0, -lift);
  if (scale !== 1) {
    // Scale around the card's own center so the lift reads as "picked up
    // and slightly enlarged" rather than growing from a corner.
    const cx = drawStart + curWidth / 2;
    const cy = H / 2;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }

  // Card background + drop shadow (deeper for the lifted floating card).
  // The shadow offset is increased by `lift` so the shadow stays near the
  // "ground" (the card's un-lifted Y) rather than rising with the card —
  // that's what conveys the lift visually.
  ctx.save();
  ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
  ctx.shadowBlur = options.shadowBlur != null ? options.shadowBlur : SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
  ctx.shadowOffsetY = (options.shadowOffsetY != null ? options.shadowOffsetY : SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr) + lift;
  ctx.fillStyle = bg;
  ctx.fill(cardPath);
  ctx.restore();

  // Midline + played/unplayed waveform fill, clipped to the card.
  ctx.save();
  ctx.clip(cardPath);

  ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(drawStart, H / 2);
  ctx.lineTo(drawEnd, H / 2);
  ctx.stroke();

  const scaleX = curWidth / pathWidth;
  const midX = Math.min(drawEnd, Math.max(drawStart, playheadX));
  if (midX > drawStart) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(drawStart, 0, midX - drawStart, H);
    ctx.clip();
    ctx.translate(drawStart, 0);
    ctx.scale(scaleX, 1);
    ctx.fillStyle = WAVEFORM_STYLE.playedColor;
    ctx.fill(segPath);
    ctx.restore();
  }
  if (midX < drawEnd) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(midX, 0, drawEnd - midX, H);
    ctx.clip();
    ctx.translate(drawStart, 0);
    ctx.scale(scaleX, 1);
    ctx.fillStyle = WAVEFORM_STYLE.unplayedColor;
    ctx.fill(segPath);
    ctx.restore();
  }

  ctx.restore();

  // Edge stroke: solid accent edge (with glow) while the card is lifted
  // (dragging or settling), normal edge for in-place cards.
  if (options.strokeColor) {
    ctx.save();
    ctx.strokeStyle = options.strokeColor;
    ctx.lineWidth = edgeWidth;
    ctx.shadowColor = WAVEFORM_STYLE.selectedGlowColor;
    ctx.shadowBlur = 8 * dpr;
    ctx.stroke(cardPath);
    ctx.restore();
  } else {
    ctx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
    ctx.lineWidth = edgeWidth;
    ctx.stroke(cardPath);
  }

  ctx.restore();
}

/**
 * Draw a recessed, neutral placeholder at the dragged segment's slot — the
 * "hole" it was lifted out of. Deliberately styled to recede (dark fill, no
 * glow, no accent color) rather than compete with the floating card, which
 * uses the accent color to read as the one "live" element during the drag.
 */
function drawDropZoneOutline(ctx, drawStart, drawEnd, H, dpr) {
  const w = drawEnd - drawStart;
  if (w <= 0) return;
  const cardPath = _buildOneCardPath(drawStart, w, H, dpr);
  if (!cardPath) return;
  ctx.save();
  ctx.setLineDash([6 * dpr, 5 * dpr]);
  ctx.fillStyle = WAVEFORM_STYLE.dropZoneBg;
  ctx.fill(cardPath);
  ctx.strokeStyle = WAVEFORM_STYLE.dropZoneEdgeColor;
  ctx.lineWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;
  ctx.stroke(cardPath);
  ctx.restore();
}

/**
 * Per-frame render of the full drag state (live drag or settle). Replaces
 * drawPlaybackWaveform for the duration of the drag.
 *
 * The played/unplayed split for each card is computed from the LIVE ARRANGEMENT
 * order (not a global canvas X), because the floating dragged card can be
 * anywhere on the canvas — far from its slot — and a global X would misclassify
 * cards that are before/after the playhead in the arrangement. Each card is
 * either fully played (before the playhead time in the arrangement), fully
 * unplayed (after it), or split at the playhead time (the card containing it).
 * The playhead holds a fixed timeline position throughout the drag — it does
 * not follow the dragged segment.
 */
function drawDragFrame() {
  const snap = state._segmentDragSnapshot;
  if (!snap || !state.recordedBuffer || !state.originalBuffer) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = _cachedCanvasRect || el.waveformCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));
  if (el.waveformCanvas.width !== W) el.waveformCanvas.width = W;
  if (el.waveformCanvas.height !== H) el.waveformCanvas.height = H;

  // The drag overlay canvas extends SEGMENT_DRAG_HEADROOM_CSS_PX on all four
  // sides of the main canvas (see .drag-overlay-canvas CSS). The floating
  // lifted card draws here so its lift / scale-up / drop shadow / accent
  // glow aren't clipped at the waveform canvas's edges — that's what was
  // making the card top appear to slide under the ruler, and the shadow +
  // glow sides appear truncated when the card was dragged all the way to
  // the left or right edge. Coordinate space: overlay (x, y) = main
  // (x + headroomDev, y + headroomDev), achieved per draw via translate()
  // so drawDragCard stays canvas-agnostic.
  const headroomDev = SEGMENT_DRAG_HEADROOM_CSS_PX * dpr;
  const overlayW = W + 2 * headroomDev;
  const overlayH = H + 2 * headroomDev;
  if (el.dragOverlayCanvas.width !== overlayW) el.dragOverlayCanvas.width = overlayW;
  if (el.dragOverlayCanvas.height !== overlayH) el.dragOverlayCanvas.height = overlayH;
  if (el.dragOverlayCanvas.hidden) el.dragOverlayCanvas.hidden = false;
  dragOverlayCtx.clearRect(0, 0, overlayW, overlayH);

  waveCtx.clearRect(0, 0, W, H);

  const isSettling = !!snap.settle;
  const srcIdx = snap.srcIndex;
  const arrangement = snap.arrangement;
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;

  // The playhead holds a fixed timeline position during the drag; find where
  // that time falls in the live arrangement so each card can be classified as
  // before / after / containing the playhead.
  const { k: kPlayhead, frac: playheadFrac } = locatePlayheadInArrangement(snap);
  const srcK = arrangement.indexOf(srcIdx);

  // Compute the floating card's current position (used for the floating render).
  const pathWidth = snap.segPathWidths[srcIdx];
  let floatStart = -1;
  if (pathWidth > 0) {
    floatStart = snap.pointerX - snap.pointerOffsetInCard;
    floatStart = Math.max(0, Math.min(W - pathWidth, floatStart));
  }

  // For each card, compute the played/unplayed split X from the arrangement.
  // Cards before the playhead → fully played (drawEnd); after → fully unplayed
  // (drawStart); the playhead's own card → split at frac.
  function splitForCard(kInArrangement, drawStart, drawEnd, cardPathWidth) {
    if (kPlayhead < 0) return drawStart;
    if (kInArrangement < kPlayhead) return drawEnd;
    if (kInArrangement > kPlayhead) return drawStart;
    return drawStart + playheadFrac * cardPathWidth;
  }

  // Render non-dragged segments in live-arrangement order. The dragged segment
  // is skipped here — during live drag its slot is a drop zone outline and the
  // floating card is drawn separately on the overlay; during settle the
  // dragged segment is also rendered on the overlay so its lift isn't clipped.
  for (let k = 0; k < arrangement.length; k++) {
    const originalIdx = arrangement[k];
    if (originalIdx === srcIdx) continue;
    const ab = snap.animBounds[originalIdx];
    if (!ab) continue;
    const cardW = ab.drawEnd - ab.drawStart;
    const splitX = splitForCard(k, ab.drawStart, ab.drawEnd, cardW);
    drawDragCard(waveCtx, snap.segPaths[originalIdx], snap.segPathWidths[originalIdx],
      ab.drawStart, ab.drawEnd, splitX, H, dpr, { edgeWidth });
  }

  if (!isSettling) {
    // Drop zone outline at the dragged segment's slot (its animated bounds).
    const slot = snap.animBounds[srcIdx];
    if (slot && slot.drawEnd > slot.drawStart) {
      drawDropZoneOutline(waveCtx, slot.drawStart, slot.drawEnd, H, dpr);
    }

    // Floating dragged card: follows the pointer 1:1, lifted, deep shadow.
    // bg/scale ease in with liftPx so pickup reads as a smooth "rising off
    // the row" rather than an instant translucent-to-opaque pop.
    if (floatStart >= 0) {
      const maxLift = SEGMENT_DRAG_LIFT_CSS_PX * dpr;
      const liftFrac = maxLift > 0 ? Math.max(0, Math.min(1, snap.liftPx / maxLift)) : 0;
      const floatEnd = floatStart + pathWidth;
      const splitX = splitForCard(srcK, floatStart, floatEnd, pathWidth);
      dragOverlayCtx.save();
      dragOverlayCtx.translate(headroomDev, headroomDev);
      drawDragCard(dragOverlayCtx, snap.segPaths[srcIdx], pathWidth,
        floatStart, floatEnd, splitX, H, dpr, {
          edgeWidth,
          lift: snap.liftPx,
          scale: 1 + SEGMENT_DRAG_SCALE_MAX * liftFrac,
          bg: lerpColorAlpha(WAVEFORM_STYLE.segmentCardBg, WAVEFORM_STYLE.dragCardBg, liftFrac),
          shadowBlur: SEGMENT_DRAG_SHADOW_BLUR_CSS_PX * dpr,
          shadowOffsetY: SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX * dpr,
          strokeColor: WAVEFORM_STYLE.selectedEdgeColor,
        });
      dragOverlayCtx.restore();
    }
  } else {
    // Settle: render the dragged segment at its eased position, with lift +
    // deep shadow + opaque bg + scale all fading back to normal as it lands.
    // Drawn on the overlay (same translate trick as the live floating card)
    // because liftPx > 0 for most of the settle window and we don't want the
    // decay to be clipped at the main canvas top.
    const ab = snap.animBounds[srcIdx];
    if (ab && ab.drawEnd > ab.drawStart) {
      const maxLift = SEGMENT_DRAG_LIFT_CSS_PX * dpr;
      const liftFrac = maxLift > 0 ? Math.max(0, snap.liftPx / maxLift) : 0;
      const cardW = ab.drawEnd - ab.drawStart;
      const splitX = splitForCard(srcK, ab.drawStart, ab.drawEnd, cardW);
      dragOverlayCtx.save();
      dragOverlayCtx.translate(headroomDev, headroomDev);
      drawDragCard(dragOverlayCtx, snap.segPaths[srcIdx], snap.segPathWidths[srcIdx],
        ab.drawStart, ab.drawEnd, splitX, H, dpr, {
          edgeWidth,
          lift: snap.liftPx,
          scale: 1 + SEGMENT_DRAG_SCALE_MAX * liftFrac,
          bg: lerpColorAlpha(WAVEFORM_STYLE.segmentCardBg, WAVEFORM_STYLE.dragCardBg, liftFrac),
          shadowBlur: SEGMENT_SHADOW_BLUR_CSS_PX * dpr + (SEGMENT_DRAG_SHADOW_BLUR_CSS_PX - SEGMENT_SHADOW_BLUR_CSS_PX) * dpr * liftFrac,
          shadowOffsetY: SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr + (SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX - SEGMENT_SHADOW_OFFSET_Y_CSS_PX) * dpr * liftFrac,
          strokeColor: liftFrac > 0.05 ? WAVEFORM_STYLE.selectedEdgeColor : null,
        });
      dragOverlayCtx.restore();
    }
  }

  // The playhead keeps its timeline position: the caret sits wherever that
  // time falls in the live arrangement, never on the floating dragged card.
  positionPlayheadCaretsAtDeviceX(computeDragPlayheadX(snap));

  // The append button doesn't depend on segment positions, keep it placed.
  positionAppendButton();
}

export function captureSegmentBitmap(index) {
  if (!state.recordedBuffer || el.playbackView.hidden) return null;

  const prevHovered = state.selectedSegmentIndex;
  const prevTrash = state.isHoveringTrash;
  state.selectedSegmentIndex = index;
  state.isHoveringTrash = true;
  const ratio = currentPlaybackRatio();
  drawPlaybackWaveform(ratio);
  state.selectedSegmentIndex = prevHovered;
  state.isHoveringTrash = prevTrash;

  const dpr = window.devicePixelRatio || 1;
  const W = el.waveformCanvas.width, H = el.waveformCanvas.height;
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const segBounds = _computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  if (!segBounds[index]) return null;
  const minX = index > 0 ? Math.ceil(segBounds[index - 1].drawEnd) + 1 : 0;
  const maxX = index < segBounds.length - 1 ? Math.floor(segBounds[index + 1].drawStart) - 1 : W;
  return captureCanvasRegionForIndex(segBounds[index], W, H, dpr, minX, maxX);
}

export function animateSegmentDelete(oldSegments, oldTotalSamples, deletedIndex, oldPlayheadRatio, newPlayheadRatio, snap) {
  if (!state.originalBuffer) {
    cancelSegmentDeleteAnimation();
    drawPlaybackWaveform(newPlayheadRatio);
    return;
  }

  const { dpr, W, H } = prepareCanvasForAnim();
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const oldSegBounds = computeSegmentBoundsPure(W, oldSegments, oldTotalSamples, gapPx);

  let slides, newPlayheadX, onComplete;
  if (!state.recordedBuffer) {
    slides = [];
    newPlayheadX = 0;
    onComplete = () => { drawPlaybackWaveform(0); updateEmptyState(); };
  } else {
    const channelData = getSourceBuffer().getChannelData(0);
    const newSegBounds = _computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
    slides = [];
    for (let i = 0; i < oldSegments.length; i++) {
      if (i === deletedIndex) continue;
      const newIndex = i < deletedIndex ? i : i - 1;
      const oldSb = oldSegBounds[i];
      const newSb = newSegBounds[newIndex];
      if (!oldSb || !newSb) continue;
      slides.push(buildSlide(oldSb, newSb, oldSegments[i], channelData, H));
    }
    newPlayheadX = audioRatioToVisualRatio(newPlayheadRatio, W, newSegBounds) * W;
  }

  const validSnap = snap && snap.W === W && snap.H === H ? snap : null;
  const tiles = buildShatterTiles(validSnap, dpr);
  const oldPlayheadX = audioRatioToVisualRatio(oldPlayheadRatio, W, oldSegBounds) * W;

  beginSegmentAnim(slides, validSnap, tiles, oldPlayheadX, newPlayheadX, newPlayheadRatio, false, dpr, W, H, onComplete);
}

export function animateSegmentRestore(beforeSegments, beforeTotalSamples, restoredIndex, oldPlayheadRatio, newPlayheadRatio) {
  if (!state.originalBuffer || !state.recordedBuffer) {
    cancelSegmentDeleteAnimation();
    drawPlaybackWaveform(newPlayheadRatio);
    return;
  }

  const { dpr, W, H } = prepareCanvasForAnim();
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const oldSegBounds = computeSegmentBoundsPure(W, beforeSegments, beforeTotalSamples, gapPx);
  const newSegBounds = _computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  const channelData = getSourceBuffer().getChannelData(0);

  const slides = [];
  for (let k = 0; k < state.segments.length; k++) {
    if (k === restoredIndex) continue;
    const oldIndex = k < restoredIndex ? k : k - 1;
    const oldSb = oldSegBounds[oldIndex];
    const newSb = newSegBounds[k];
    if (!oldSb || !newSb) continue;
    slides.push(buildSlide(oldSb, newSb, state.segments[k], channelData, H));
  }

  const oldPlayheadX = audioRatioToVisualRatio(oldPlayheadRatio, W, oldSegBounds) * W;
  const newPlayheadX = audioRatioToVisualRatio(newPlayheadRatio, W, newSegBounds) * W;
  const snap = newSegBounds[restoredIndex]
    ? renderCardSnapshot(newSegBounds[restoredIndex], state.segments[restoredIndex], channelData, W, H, dpr, newPlayheadX)
    : null;
  const tiles = buildShatterTiles(snap, dpr);

  beginSegmentAnim(slides, snap, tiles, oldPlayheadX, newPlayheadX, newPlayheadRatio, true, dpr, W, H);
}

// ===== Segment click-to-select =====

function findSegmentAtX(x, width) {
  if (!state.recordedBuffer) return -1;
  const gapPx = SEGMENT_GAP_CSS_PX;
  const segBounds = _computeSegmentBounds(width, state.recordedBuffer.length, gapPx);
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    if (x >= sb.drawStart && x < sb.drawEnd) return i;
  }
  return -1;
}

export function getSegmentIndexAtClientPoint(clientX, clientY) {
  if (!state.recordedBuffer) return -1;
  const rect = el.waveformContainer.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const cardTop = SEGMENT_VERTICAL_INSET_CSS_PX;
  const cardBottom = rect.height - SEGMENT_VERTICAL_INSET_CSS_PX;
  if (y < cardTop || y > cardBottom) return -1;
  return findSegmentAtX(x, rect.width);
}

el.waveformContainer.addEventListener('pointerdown', (e) => {
  if (!state.recordedBuffer) return;
  // In per-segment scope, a click on an effect chip toggles that effect for
  // that segment — it must not start a reorder drag or a seek/selection.
  const chip = getSegmentChipAtClientPoint(e.clientX, e.clientY);
  if (chip) {
    e.preventDefault();
    import('./editing.js').then(m => m.toggleSegmentEffect(chip.index, chip.key));
    return;
  }
  const rect = el.waveformContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cardTop = SEGMENT_VERTICAL_INSET_CSS_PX;
  const cardBottom = rect.height - SEGMENT_VERTICAL_INSET_CSS_PX;
  if (y < cardTop || y > cardBottom) { hideSegmentTrash(); return; }
  const i = findSegmentAtX(x, rect.width);
  if (i >= 0) {
    // With 2+ segments, defer the click decision: record a pending drag so
    // pointermove past the threshold promotes to a reorder drag, and pointerup
    // before that falls back to the existing click-to-(de)select-trash behavior.
    if (state.segments.length >= 2) {
      state.pendingSegmentDrag = { index: i, startClientX: e.clientX, startClientY: e.clientY };
      return;
    }
    if (i === state.selectedSegmentIndex) hideSegmentTrash();
    else showSegmentTrash(i);
  } else {
    hideSegmentTrash();
  }
});

// ===== Segment hover =====

let hoverRedrawRaf = null;

function scheduleHoverRedraw() {
  if (state.selectedSegmentIndex >= 0) return;
  if (hoverRedrawRaf) return;
  hoverRedrawRaf = requestAnimationFrame(() => {
    hoverRedrawRaf = null;
    if (!state.isPlaying && state.recordedBuffer) {
      drawPlaybackWaveform(currentPlaybackRatio());
    }
  });
}

el.waveformContainer.addEventListener('mousemove', (e) => {
  if (!state.recordedBuffer) return;
  if (state.draggingSegmentIndex >= 0 || state.pendingSegmentDrag) return;
  const rect = el.waveformContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cardTop = SEGMENT_VERTICAL_INSET_CSS_PX;
  const cardBottom = rect.height - SEGMENT_VERTICAL_INSET_CSS_PX;
  const i = (y >= cardTop && y <= cardBottom) ? findSegmentAtX(x, rect.width) : -1;
  if (i !== state.hoverSegmentIndex) {
    state.hoverSegmentIndex = i;
    el.waveformContainer.style.cursor = 'default';
    scheduleHoverRedraw();
  }
  // Chips are clickable — show a pointer cursor over them.
  if (getSegmentChipAtClientPoint(e.clientX, e.clientY)) {
    el.waveformContainer.style.cursor = 'pointer';
  }
});

el.waveformContainer.addEventListener('mouseleave', () => {
  if (state.hoverSegmentIndex !== -1) {
    state.hoverSegmentIndex = -1;
    el.waveformContainer.style.cursor = 'default';
    scheduleHoverRedraw();
  }
});
