import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, MIN_SEGMENT_SAMPLES, SEGMENT_GAP_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SELECTION_PULSE_PERIOD_SEC, DELETE_PULSE_PERIOD_SEC, SEGMENT_DELETE_ANIM_MS } from './state.js';
import { el, waveCtx, rulerCtx } from './dom.js';
import { pausePlayback } from './playback.js';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel } from './waveform-math.js';
import { pushHistory } from './history.js';

// ===== Segment helpers (moved here to avoid circular deps with editing.js) =====

export function findSegmentAtSample(editedSample) {
  let acc = 0;
  for (let i = 0; i < state.segments.length; i++) {
    const seg = state.segments[i];
    const segLen = seg.end - seg.start;
    if (editedSample < acc + segLen || i === state.segments.length - 1) {
      return { index: i, offsetInSeg: editedSample - acc, seg };
    }
    acc += segLen;
  }
  return null;
}

// ===== Waveform path helpers =====

export function buildWaveformPath(path, peaks, startIdx, endIdx, midY, scale) {
  if (startIdx >= endIdx) return;
  path.moveTo(startIdx, midY - peaks[startIdx * 2 + 1] * midY * scale);
  for (let x = startIdx + 1; x < endIdx; x++) {
    path.lineTo(x, midY - peaks[x * 2 + 1] * midY * scale);
  }
  for (let x = endIdx - 1; x >= startIdx; x--) {
    path.lineTo(x, midY - peaks[x * 2] * midY * scale);
  }
  path.closePath();
}

export function fillWaveformPathLive(ctx, peaks, startIdx, endIdx, midY, scale) {
  const path = new Path2D();
  buildWaveformPath(path, peaks, startIdx, endIdx, midY, scale);
  ctx.fill(path);
}

// ===== Peak computation =====

export function computePeaks(width) {
  if (!state.recordedBuffer) return null;
  const data = state.recordedBuffer.getChannelData(0);
  return computePeaksForRange(data, 0, data.length, width);
}

// Same min/max-per-pixel peak computation as computePeaks, but scoped to an
// arbitrary sample range — used to render a single segment's own waveform
// shape independent of the full recordedBuffer (e.g. mid-delete-animation,
// where a segment's on-screen width no longer matches its final width).
function computePeaksForRange(data, startSample, endSample, pixelWidth) {
  const w = Math.max(1, pixelWidth);
  const peaks = new Float32Array(w * 2);
  const totalSamples = endSample - startSample;
  if (totalSamples <= 0) return peaks;

  const samplesPerPixel = totalSamples / w;
  const step = Math.max(1, (samplesPerPixel / PEAK_STEP_DIVISOR) | 0);

  for (let x = 0; x < w; x++) {
    const start = startSample + ((x * samplesPerPixel) | 0);
    const end = Math.min(endSample, startSample + (((x + 1) * samplesPerPixel) | 0));
    let min = 0, max = 0;
    if (start < end) {
      min = 1; max = -1;
      for (let i = start; i < end; i += step) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const v = data[end - 1];
      if (v < min) min = v;
      if (v > max) max = v;
      if (min > max) { min = 0; max = 0; }
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

// ===== Trash & scissors positioning =====

export function updatePlayheadScissorsPosition(ratio) {
  if (state.isPlaying || !state.recordedBuffer || ratio < 0 || ratio > 1 || el.playbackView.hidden) {
    el.playheadScissors.classList.remove('visible');
    return;
  }

  // Only hide at the exact first/last frame; a tiny epsilon absorbs float error.
  const EDGE_THRESHOLD = 1 / (2 * state.recordedBuffer.length);
  if (ratio <= EDGE_THRESHOLD || ratio >= 1 - EDGE_THRESHOLD) {
    el.playheadScissors.classList.remove('visible');
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  const halfBtn = (el.playheadScissors.offsetHeight || SCISSORS_FALLBACK_HEIGHT) / 2;

  const gapPx = SEGMENT_GAP_CSS_PX;
  const segBounds = computeSegmentBounds(canvasRect.width, state.recordedBuffer.length, gapPx);
  const visualRatio = audioRatioToVisualRatio(ratio, canvasRect.width, segBounds);

  let leftPx = (canvasRect.left - viewRect.left) + visualRatio * canvasRect.width;
  // Match positionPlayheadCarets: the visible playhead line ends at
  // canvasRect.bottom - insetY, so sit the button flush against that point.
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX;
  const playheadBottomY = (canvasRect.bottom - viewRect.top) - insetY;
  const topPx = playheadBottomY + halfBtn;

  leftPx = Math.max(halfBtn, Math.min(viewRect.width - halfBtn, leftPx));

  el.playheadScissors.style.left = leftPx + 'px';
  el.playheadScissors.style.top = topPx + 'px';
  el.playheadScissors.classList.add('visible');
}

// ===== Playhead caret positioning =====

export function positionPlayheadCarets(ratio) {
  if (!state.recordedBuffer || el.playbackView.hidden || ratio < 0 || ratio > 1) {
    el.playheadCaretTop.style.display = 'none';
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.floor(canvasRect.width * dpr);
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const segBounds = computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  const visualRatio = audioRatioToVisualRatio(ratio, W, segBounds);
  const lineXCssPx = Math.floor(visualRatio * W) / dpr;
  const leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;

  el.playheadCaretTop.style.display = '';

  // Align the line's top with the segment cards' top inset; the grip sits above
  // it. offsetTop (grip height + the CSS tuck margin) is a layout value, so it's
  // immune to the hover/drag scale transform and tracks the mobile grip size.
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX;
  const lineOffsetTop = el.playheadLine.offsetTop;
  const topPx = (canvasRect.top - viewRect.top) + insetY - lineOffsetTop;

  el.playheadLine.style.height = Math.max(0, canvasRect.height - 2 * insetY) + 'px';
  el.playheadCaretTop.style.left = leftPx + 'px';
  el.playheadCaretTop.style.top = topPx + 'px';
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
  clearTimeout(state.trashHideTimer);
  el.segmentTrash.classList.remove('visible');
  state.hoveredSegmentIndex = -1;
  state.isHoveringTrash = false;
  stopSelectionAnim();
  if (!state.isPlaying && state.recordedBuffer) {
    drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
  }
}

export function clearSegmentHover() {
  state.hoverSegmentIndex = -1;
  el.waveformContainer.style.cursor = 'default';
}

export function showSegmentTrash(index) {
  if (index < 0 || index >= state.segments.length) return;
  if (state.segments.length < 2) return;
  clearTimeout(state.trashHideTimer);
  state.hoveredSegmentIndex = index;
  el.segmentTrash.classList.add('visible');
  positionSegmentTrash();
  startSelectionAnim();
}

el.segmentTrash.addEventListener('mouseenter', () => { state.isHoveringTrash = true; });
el.segmentTrash.addEventListener('mouseleave', () => { state.isHoveringTrash = false; });

let selectionAnimRaf = null;

function startSelectionAnim() {
  if (selectionAnimRaf) return;
  const tick = () => {
    if (state.hoveredSegmentIndex < 0) { selectionAnimRaf = null; return; }
    if (!state.isPlaying && state.recordedBuffer) {
      drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
    }
    selectionAnimRaf = requestAnimationFrame(tick);
  };
  selectionAnimRaf = requestAnimationFrame(tick);
}

function stopSelectionAnim() {
  if (selectionAnimRaf) { cancelAnimationFrame(selectionAnimRaf); selectionAnimRaf = null; }
}

function positionSegmentTrash() {
  if (state.hoveredSegmentIndex < 0 || !state.recordedBuffer) return;
  if (state.hoveredSegmentIndex >= state.segments.length) { hideSegmentTrash(); return; }
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  const gapPx = SEGMENT_GAP_CSS_PX;
  const segBounds = computeSegmentBounds(canvasRect.width, state.recordedBuffer.length, gapPx);
  const sb = segBounds[state.hoveredSegmentIndex];
  if (!sb) { hideSegmentTrash(); return; }

  const centerX = (sb.drawStart + sb.drawEnd) / 2;
  const halfW = 15;
  let leftPx = (canvasRect.left - viewRect.left) + centerX;
  leftPx = Math.max(halfW, Math.min(viewRect.width - halfW, leftPx));
  const topPx = (canvasRect.top - viewRect.top) - 30 - 4;

  el.segmentTrash.style.left = leftPx + 'px';
  el.segmentTrash.style.top = topPx + 'px';
}

const PEAK_STEP_DIVISOR = 100;
const SCISSORS_FALLBACK_HEIGHT = 30;

const DIVISION_HANDLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 9c.852 0 1.297 .986 .783 1.623l-.076 .084l-6 6a1 1 0 0 1 -1.32 .083l-.094 -.083l-6 -6l-.083 -.094l-.054 -.077l-.054 -.096l-.017 -.036l-.027 -.067l-.032 -.108l-.01 -.053l-.01 -.06l-.004 -.057v-.118l.005 -.058l.009 -.06l.01 -.052l.032 -.108l.027 -.067l.07 -.132l.065 -.09l.073 -.081l.094 -.083l.077 -.054l.096 -.054l.036 -.017l.067 -.027l.108 -.032l.053 -.01l.06 -.01l.057 -.004l12.059 -.002z"/></svg>`;

let bottomHandles = [];

function createHandleElement() {
  const h = document.createElement('button');
  h.className = 'division-handle';
  h.innerHTML = DIVISION_HANDLE_SVG;
  h.tabIndex = -1;
  h.setAttribute('aria-label', 'Drag to reposition split');

  const svg = h.querySelector('svg');
  svg.style.transform = 'rotate(180deg)';

  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const index = parseInt(h.dataset.index);
    if (state.isPlaying) pausePlayback();
    const totalSamples = state.recordedBuffer.length;
    let accBeforeSegI = 0;
    for (let j = 0; j < index; j++) {
      accBeforeSegI += state.segments[j].end - state.segments[j].start;
    }
    const segILen = state.segments[index].end - state.segments[index].start;
    const segIP1Len = state.segments[index + 1].end - state.segments[index + 1].start;
    pushHistory();
    state.draggingHandleIndex = index;
    state._dragSnapshot = {
      handleIndex: index,
      totalSamples,
      startClientX: e.clientX,
      accBeforeSegI,
      segIStart: state.segments[index].start,
      segIP1End: state.segments[index + 1].end,
      minAcc: accBeforeSegI + MIN_SEGMENT_SAMPLES,
      maxAcc: accBeforeSegI + segILen + segIP1Len - MIN_SEGMENT_SAMPLES
    };
    addDraggingClass(index);
    hideSegmentTrash();
    el.playheadScissors.classList.remove('visible');
  });

  h.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  return h;
}

export function ensureDivisionHandles() {
  const needed = Math.max(0, state.segments.length - 1);

  while (bottomHandles.length > needed) {
    bottomHandles.pop().remove();
  }

  while (bottomHandles.length < needed) {
    const bottomH = createHandleElement();
    bottomH.dataset.index = String(bottomHandles.length);
    el.playbackView.appendChild(bottomH);
    bottomHandles.push(bottomH);
  }

  for (let i = 0; i < bottomHandles.length; i++) {
    bottomHandles[i].dataset.index = String(i);
  }
}

const HANDLE_HALF_W = 12;
const HANDLE_OVERLAP = 4;

export function positionDivisionHandles() {
  if (!state.recordedBuffer || state.segments.length <= 1) {
    for (const h of bottomHandles) h.style.display = 'none';
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.floor(canvasRect.width * dpr);
  const bottomPx = (canvasRect.bottom - viewRect.top) - HANDLE_OVERLAP;
  const totalSamples = state.recordedBuffer.length;
  let acc = 0;

  for (let i = 0; i < bottomHandles.length; i++) {
    acc += state.segments[i].end - state.segments[i].start;
    const ratio = acc / totalSamples;
    const lineXCssPx = Math.floor(ratio * W) / dpr;
    let leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;
    leftPx = Math.max(HANDLE_HALF_W, Math.min(viewRect.width - HANDLE_HALF_W, leftPx));

    bottomHandles[i].style.display = '';
    bottomHandles[i].style.left = leftPx + 'px';
    bottomHandles[i].style.top = bottomPx + 'px';
  }
}

export function addDraggingClass(index) {
  if (index >= 0 && index < bottomHandles.length) {
    bottomHandles[index].classList.add('dragging');
  }
}

export function removeDraggingClass(index) {
  if (index >= 0 && index < bottomHandles.length) {
    bottomHandles[index].classList.remove('dragging');
  }
}

// ===== Playback waveform rendering =====

function roundedRectPath(path, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) {
    path.rect(x, y, w, h);
    return;
  }
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.arcTo(x + w, y, x + w, y + r, r);
  path.lineTo(x + w, y + h - r);
  path.arcTo(x + w, y + h, x + w - r, y + h, r);
  path.lineTo(x + r, y + h);
  path.arcTo(x, y + h, x, y + h - r, r);
  path.lineTo(x, y + r);
  path.arcTo(x, y, x + r, y, r);
  path.closePath();
}

function buildOneCardPath(x, w, H, dpr) {
  if (w <= 0) return null;
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX * dpr;
  const cardH = H - 2 * insetY;
  const baseR = SEGMENT_CORNER_RADIUS_CSS_PX * dpr;
  const r = Math.min(baseR, w / 2, cardH / 2);
  const cardPath = new Path2D();
  roundedRectPath(cardPath, x, insetY, w, cardH, r);
  return cardPath;
}

function buildSegmentCardPaths(segBounds, H, dpr) {
  const cardPaths = [];
  for (const sb of segBounds) {
    cardPaths.push(buildOneCardPath(sb.drawStart, sb.drawEnd - sb.drawStart, H, dpr));
  }
  return cardPaths;
}

// ===== Render caches =====
//
// The card backgrounds (shadow-blur fills are among the most expensive canvas
// ops) and the timeline ruler only change when the segment layout, canvas
// size, or hover/selection state changes — never per frame. They're cached so
// the per-frame callers (playback and the selection-pulse loop) just blit the
// base layer and draw the cheap dynamic parts, instead of re-rendering
// shadows and ruler text at 60fps.

/** @type {HTMLCanvasElement | null} */
let baseLayerCanvas = null;
let baseLayerKey = '';
/** @type {Array<Path2D | null>} */
let cachedCardPaths = [];
let cardPathsKey = '';
let rulerCacheKey = '';

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
  const selectedIdx = state.hoveredSegmentIndex;
  const hoverIdx = state.hoverSegmentIndex;

  // Card backgrounds with drop shadows (drawn first so shadows don't darken neighbors' content)
  for (let i = 0; i < cardPaths.length; i++) {
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    ctx.save();
    ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
    ctx.shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
    ctx.shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
    ctx.fillStyle = (i === selectedIdx || i === hoverIdx) ? WAVEFORM_STYLE.hoverCardBg : WAVEFORM_STYLE.segmentCardBg;
    ctx.fill(cardPath);
    ctx.restore();
  }

  // Midlines (clipped to each card so they break at gaps)
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

function drawSegmentCards(ctx, path, segBounds, cardPaths, playheadX, H, dpr) {
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;

  const selectedIdx = state.hoveredSegmentIndex;
  const hoverIdx = state.hoverSegmentIndex;
  const hasSelection = selectedIdx >= 0 && selectedIdx < segBounds.length;
  const isMarkedForDelete = hasSelection && state.isHoveringTrash;
  const pulsePeriod = isMarkedForDelete ? DELETE_PULSE_PERIOD_SEC : SELECTION_PULSE_PERIOD_SEC;
  const pulse = hasSelection
    ? (Math.sin((performance.now() / 1000) * (Math.PI * 2 / pulsePeriod)) + 1) / 2
    : 0;

  // Static layer: card backgrounds, shadows, midlines (cached in renderBaseLayer)
  if (baseLayerCanvas) ctx.drawImage(baseLayerCanvas, 0, 0);

  // Dynamic pass: clipped waveform content + edge stroke per card
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    const x = sb.drawStart;
    const w = sb.drawEnd - sb.drawStart;
    const isSelected = i === selectedIdx;

    ctx.save();
    ctx.clip(cardPath);

    // Played / unplayed fills (clipped to card, then to each side of the playhead)
    const midX = Math.min(sb.drawEnd, Math.max(sb.drawStart, playheadX));
    if (isSelected) {
      const unplayedColor = isMarkedForDelete
        ? lerpColorAlpha(WAVEFORM_STYLE.deleteUnplayedColorDim, WAVEFORM_STYLE.deleteUnplayedColorBright, pulse)
        : lerpColorAlpha(WAVEFORM_STYLE.selectedUnplayedColorDim, WAVEFORM_STYLE.selectedUnplayedColorBright, pulse);
      const playedColor = isMarkedForDelete ? WAVEFORM_STYLE.deletePlayedColor : WAVEFORM_STYLE.selectedPlayedColor;
      if (midX > x) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, midX - x, H);
        ctx.clip();
        ctx.fillStyle = playedColor;
        ctx.fill(path);
        ctx.restore();
      }
      if (midX < x + w) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(midX, 0, x + w - midX, H);
        ctx.clip();
        ctx.fillStyle = unplayedColor;
        ctx.fill(path);
        ctx.restore();
      }
    } else {
      if (midX > x) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, midX - x, H);
        ctx.clip();
        ctx.fillStyle = WAVEFORM_STYLE.playedColor;
        ctx.fill(path);
        ctx.restore();
      }
      if (midX < x + w) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(midX, 0, x + w - midX, H);
        ctx.clip();
        ctx.fillStyle = WAVEFORM_STYLE.unplayedColor;
        ctx.fill(path);
        ctx.restore();
      }
    }

    ctx.restore();

    // Edge stroke (on top, not clipped)
    if (isSelected) {
      const glowBlur = (6 + pulse * 8) * dpr;
      ctx.save();
      ctx.strokeStyle = isMarkedForDelete ? WAVEFORM_STYLE.deleteEdgeColor : WAVEFORM_STYLE.selectedEdgeColor;
      ctx.lineWidth = isMarkedForDelete ? edgeWidth * 1.5 : edgeWidth;
      ctx.shadowColor = isMarkedForDelete ? WAVEFORM_STYLE.deleteGlowColor : WAVEFORM_STYLE.selectedGlowColor;
      ctx.shadowBlur = glowBlur;
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
}

function lerpColorAlpha(dimRgba, brightRgba, t) {
  const d = parseRgba(dimRgba);
  const b = parseRgba(brightRgba);
  const r = Math.round(d.r + (b.r - d.r) * t);
  const g = Math.round(d.g + (b.g - d.g) * t);
  const bl = Math.round(d.b + (b.b - d.b) * t);
  const a = d.a + (b.a - d.a) * t;
  return `rgba(${r}, ${g}, ${bl}, ${a})`;
}

function parseRgba(str) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(str);
  return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
}

function computeSegmentBounds(W, totalSamples, gapPx) {
  return computeSegmentBoundsPure(W, state.segments, totalSamples, gapPx);
}

// State-aware inverse mapping for drag handling: takes the gap in px and
// derives segBounds from current state, so callers don't need to.
export function visualRatioToAudioRatioWithState(visualRatio, W, gapPx) {
  if (!state.recordedBuffer) return visualRatio;
  const segBounds = computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
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
  // The ruler doesn't depend on playhead or selection, so skip the redraw
  // (tick loops + per-label text layout) unless layout or duration changed.
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

export function drawPlaybackWaveform(playheadRatio = 0) {
  cancelSegmentDeleteAnimation();
  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));

  if (el.waveformCanvas.width !== W) el.waveformCanvas.width = W;
  if (el.waveformCanvas.height !== H) el.waveformCanvas.height = H;

  waveCtx.clearRect(0, 0, W, H);

  if (!state.recordedBuffer) {
    el.playheadScissors.classList.remove('visible');
    el.playheadCaretTop.style.display = 'none';
    rulerCtx.clearRect(0, 0, el.timelineRulerCanvas.width, el.timelineRulerCanvas.height);
    rulerCacheKey = '';
    return;
  }

  const totalSamples = state.recordedBuffer.length;
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const segBounds = computeSegmentBounds(W, totalSamples, gapPx);
  const visualRatio = audioRatioToVisualRatio(playheadRatio, W, segBounds);

  updatePlayheadScissorsPosition(playheadRatio);
  positionPlayheadCarets(playheadRatio);

  if (!state.cachedPeaks || state.cachedPeaksWidth !== W) {
    state.cachedPeaks = computePeaks(W);
    state.cachedPeaksWidth = W;
    state.cachedPath = new Path2D();
    buildWaveformPath(state.cachedPath, state.cachedPeaks, 0, W, H / 2, WAVEFORM_SCALE);
  }
  const path = state.cachedPath;

  const playheadX = Math.floor(visualRatio * W);

  const geomKey = segmentGeometryKey(W, H, dpr);
  if (geomKey !== cardPathsKey) {
    cachedCardPaths = buildSegmentCardPaths(segBounds, H, dpr);
    cardPathsKey = geomKey;
  }
  const baseKey = geomKey + '#' + state.hoveredSegmentIndex + '#' + state.hoverSegmentIndex;
  if (baseKey !== baseLayerKey) {
    renderBaseLayer(segBounds, cachedCardPaths, W, H, dpr);
    baseLayerKey = baseKey;
  }

  drawSegmentCards(waveCtx, path, segBounds, cachedCardPaths, playheadX, H, dpr);

  if (state.draggingHandleIndex < 0) {
    ensureDivisionHandles();
  }
  positionDivisionHandles();

  if (state.hoveredSegmentIndex >= 0 && state.segments.length >= 2) {
    positionSegmentTrash();
  }

  drawTimelineRuler(state.recordedBuffer.duration, segBounds, W, dpr, geomKey);
}

// ===== Segment delete animation =====
//
// The deleted card shatters into small waveform-derived fragments that burst
// outward and fade, tinted the same red used for the trash-hover highlight.
// The surviving cards slide/reflow from their old positions into their final
// ones — each keeps rendering its own (unchanged) audio via a local waveform
// path, stretched to its animated width, so the shapes stay correct mid-slide
// instead of morphing through unrelated content. DOM chrome (playhead caret,
// scissors, split handles) rides a matching temporary CSS transition so the
// whole editor glides in lockstep rather than just the canvas.

const SHATTER_SPACING_CSS_PX = 9;
const SHATTER_MAX_PARTICLES = 26;
const SHATTER_MAX_DRIFT_CSS_PX = 44;
const SHATTER_STAGGER_MS = 90;

let deleteAnim = null;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function cancelSegmentDeleteAnimation() {
  if (!deleteAnim) return;
  cancelAnimationFrame(deleteAnim.raf);
  clearDomSlideTransitions();
  deleteAnim = null;
}

function clearDomSlideTransitions() {
  el.playheadCaretTop.style.transition = '';
  el.playheadScissors.style.transition = '';
  for (const h of bottomHandles) h.style.transition = '';
}

function buildShatterParticles(delSb, delSeg, channelData, H, dpr) {
  if (!delSb || !delSeg) return [];
  const width = delSb.drawEnd - delSb.drawStart;
  if (width <= 0) return [];

  const spacing = SHATTER_SPACING_CSS_PX * dpr;
  const count = Math.max(1, Math.min(SHATTER_MAX_PARTICLES, Math.round(width / spacing)));
  const peaks = computePeaksForRange(channelData, delSeg.start, delSeg.end, count);
  const midY = H / 2;
  const segCenterX = (delSb.drawStart + delSb.drawEnd) / 2;
  const colStep = width / count;
  const barW = Math.max(2 * dpr, colStep * 0.62);

  const particles = [];
  for (let i = 0; i < count; i++) {
    const min = peaks[i * 2], max = peaks[i * 2 + 1];
    const topY = midY - max * midY * WAVEFORM_SCALE;
    const botY = midY - min * midY * WAVEFORM_SCALE;
    const cx = delSb.drawStart + (i + 0.5) * colStep;
    const cy = (topY + botY) / 2;
    const barH = Math.max(3 * dpr, botY - topY);

    const dirX = cx === segCenterX ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(cx - segCenterX);
    const dirY = cy === midY ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(cy - midY);

    particles.push({
      cx, cy, w: barW, h: barH,
      vx: dirX * (0.5 + Math.random() * 0.5),
      vy: dirY * (0.5 + Math.random() * 0.5) - 0.25,
      rot0: (Math.random() - 0.5) * 0.3,
      rotSpeed: (Math.random() - 0.5) * 2.4,
      delay: Math.random() * SHATTER_STAGGER_MS,
      warm: Math.random() > 0.5
    });
  }
  return particles;
}

function drawShatterParticles(ctx, particles, elapsedMs, dpr, colorA, colorB) {
  const maxDrift = SHATTER_MAX_DRIFT_CSS_PX * dpr;
  for (const p of particles) {
    const localDuration = Math.max(60, SEGMENT_DELETE_ANIM_MS - p.delay);
    const pt = Math.max(0, Math.min(1, (elapsedMs - p.delay) / localDuration));
    const eased = 1 - Math.pow(1 - pt, 2);
    const alpha = 1 - Math.pow(pt, 1.6);
    if (alpha <= 0.01) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.cx + p.vx * maxDrift * eased, p.cy + p.vy * maxDrift * eased);
    ctx.rotate(p.rot0 + p.rotSpeed * eased);
    const scale = 1 - 0.4 * eased;
    ctx.scale(scale, scale);
    ctx.fillStyle = p.warm ? colorA : colorB;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}

function buildSlide(oldSb, newSb, seg, channelData, H) {
  const finalWidth = Math.max(1, Math.round(newSb.drawEnd - newSb.drawStart));
  const peaks = computePeaksForRange(channelData, seg.start, seg.end, finalWidth);
  const localPath = new Path2D();
  buildWaveformPath(localPath, peaks, 0, finalWidth, H / 2, WAVEFORM_SCALE);
  return { oldSb, newSb, finalWidth, localPath };
}

function drawDeleteAnimFrame(anim, now) {
  const { slides, particles, W, H, dpr } = anim;
  const elapsedMs = now - anim.startTime;
  const t = Math.max(0, Math.min(1, elapsedMs / SEGMENT_DELETE_ANIM_MS));
  const eased = easeOutCubic(t);

  waveCtx.clearRect(0, 0, W, H);

  const curPlayheadX = anim.oldPlayheadX + (anim.newPlayheadX - anim.oldPlayheadX) * eased;
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;

  for (const s of slides) {
    const curStart = s.oldSb.drawStart + (s.newSb.drawStart - s.oldSb.drawStart) * eased;
    const curEnd = s.oldSb.drawEnd + (s.newSb.drawEnd - s.oldSb.drawEnd) * eased;
    const curWidth = curEnd - curStart;
    const cardPath = buildOneCardPath(curStart, curWidth, H, dpr);
    if (!cardPath) continue;

    waveCtx.save();
    waveCtx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
    waveCtx.shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
    waveCtx.shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
    waveCtx.fillStyle = WAVEFORM_STYLE.segmentCardBg;
    waveCtx.fill(cardPath);
    waveCtx.restore();

    waveCtx.save();
    waveCtx.clip(cardPath);

    waveCtx.strokeStyle = WAVEFORM_STYLE.midlineColor;
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(curStart, H / 2);
    waveCtx.lineTo(curEnd, H / 2);
    waveCtx.stroke();

    const scaleX = curWidth / s.finalWidth;
    const midX = Math.min(curEnd, Math.max(curStart, curPlayheadX));
    if (midX > curStart) {
      waveCtx.save();
      waveCtx.beginPath();
      waveCtx.rect(curStart, 0, midX - curStart, H);
      waveCtx.clip();
      waveCtx.translate(curStart, 0);
      waveCtx.scale(scaleX, 1);
      waveCtx.fillStyle = WAVEFORM_STYLE.playedColor;
      waveCtx.fill(s.localPath);
      waveCtx.restore();
    }
    if (midX < curEnd) {
      waveCtx.save();
      waveCtx.beginPath();
      waveCtx.rect(midX, 0, curEnd - midX, H);
      waveCtx.clip();
      waveCtx.translate(curStart, 0);
      waveCtx.scale(scaleX, 1);
      waveCtx.fillStyle = WAVEFORM_STYLE.unplayedColor;
      waveCtx.fill(s.localPath);
      waveCtx.restore();
    }

    waveCtx.restore();

    waveCtx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
    waveCtx.lineWidth = edgeWidth;
    waveCtx.stroke(cardPath);
  }

  // Restore plays the exact same particle trajectory backwards in time, so
  // fragments converge into solid form instead of bursting apart from it —
  // tinted teal (the "selected/restored" color) rather than delete's red,
  // since a restore isn't a destructive action.
  const particleElapsedMs = anim.reverseParticles ? SEGMENT_DELETE_ANIM_MS - elapsedMs : elapsedMs;
  const [colorA, colorB] = anim.reverseParticles
    ? [WAVEFORM_STYLE.selectedPlayedColor, WAVEFORM_STYLE.selectedEdgeColor]
    : [WAVEFORM_STYLE.deletePlayedColor, WAVEFORM_STYLE.deleteEdgeColor];
  drawShatterParticles(waveCtx, particles, particleElapsedMs, dpr, colorA, colorB);
}

// Shared setup for both directions: hands the DOM chrome (caret, scissors,
// split handles) a temporary CSS transition to their final spot so they glide
// in lockstep with the canvas, then drives the canvas animation via rAF.
function beginSegmentAnim(slides, particles, oldPlayheadX, newPlayheadX, newPlayheadRatio, reverseParticles, dpr, W, H) {
  cancelSegmentDeleteAnimation();

  const domTransition = `left ${SEGMENT_DELETE_ANIM_MS}ms ease-out, top ${SEGMENT_DELETE_ANIM_MS}ms ease-out`;
  el.playheadCaretTop.style.transition = domTransition;
  el.playheadScissors.style.transition = `${domTransition}, opacity 0.18s ease`;
  positionPlayheadCarets(newPlayheadRatio);
  updatePlayheadScissorsPosition(newPlayheadRatio);
  if (state.draggingHandleIndex < 0) ensureDivisionHandles();
  for (const h of bottomHandles) h.style.transition = `${domTransition}, opacity 0.15s, transform 0.15s, color 0.15s`;
  positionDivisionHandles();

  deleteAnim = { startTime: performance.now(), slides, particles, W, H, dpr, oldPlayheadX, newPlayheadX, reverseParticles, raf: null };

  const tick = (now) => {
    drawDeleteAnimFrame(deleteAnim, now);
    if (now - deleteAnim.startTime < SEGMENT_DELETE_ANIM_MS) {
      deleteAnim.raf = requestAnimationFrame(tick);
    } else {
      clearDomSlideTransitions();
      deleteAnim = null;
      drawPlaybackWaveform(newPlayheadRatio);
    }
  };
  deleteAnim.raf = requestAnimationFrame(tick);
}

function prepareCanvasForAnim() {
  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));
  if (el.waveformCanvas.width !== W) el.waveformCanvas.width = W;
  if (el.waveformCanvas.height !== H) el.waveformCanvas.height = H;
  return { dpr, W, H };
}

/**
 * Animates a segment deletion: the removed card's waveform shatters into
 * fragments that burst outward and fade, while the surviving cards slide
 * from their old layout into their final one. Call this in place of
 * drawPlaybackWaveform right after splicing state.segments and rebuilding
 * state.recordedBuffer for a delete (including a redo that replays one).
 *
 * @param {Array<{start: number, end: number}>} oldSegments - segments snapshot from before the splice
 * @param {number} oldTotalSamples - state.recordedBuffer.length from before the splice
 * @param {number} deletedIndex - index removed from oldSegments
 * @param {number} oldPlayheadRatio - playback ratio before the delete
 * @param {number} newPlayheadRatio - playback ratio after the delete (current state)
 */
export function animateSegmentDelete(oldSegments, oldTotalSamples, deletedIndex, oldPlayheadRatio, newPlayheadRatio) {
  if (!state.originalBuffer || !state.recordedBuffer) {
    cancelSegmentDeleteAnimation();
    drawPlaybackWaveform(newPlayheadRatio);
    return;
  }

  const { dpr, W, H } = prepareCanvasForAnim();
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const oldSegBounds = computeSegmentBoundsPure(W, oldSegments, oldTotalSamples, gapPx);
  const newSegBounds = computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  const channelData = state.originalBuffer.getChannelData(0);

  const slides = [];
  for (let i = 0; i < oldSegments.length; i++) {
    if (i === deletedIndex) continue;
    const newIndex = i < deletedIndex ? i : i - 1;
    const oldSb = oldSegBounds[i];
    const newSb = newSegBounds[newIndex];
    if (!oldSb || !newSb) continue;
    slides.push(buildSlide(oldSb, newSb, oldSegments[i], channelData, H));
  }

  const particles = buildShatterParticles(oldSegBounds[deletedIndex], oldSegments[deletedIndex], channelData, H, dpr);
  const oldPlayheadX = audioRatioToVisualRatio(oldPlayheadRatio, W, oldSegBounds) * W;
  const newPlayheadX = audioRatioToVisualRatio(newPlayheadRatio, W, newSegBounds) * W;

  beginSegmentAnim(slides, particles, oldPlayheadX, newPlayheadX, newPlayheadRatio, false, dpr, W, H);
}

/**
 * The reverse of animateSegmentDelete, for undoing a delete: the restored
 * card's fragments converge inward and solidify (the same particle motion as
 * a delete's shatter, played backwards in time) while the other cards slide
 * apart from their current layout to make room. Call this in place of
 * drawPlaybackWaveform right after restoring state.segments/recordedBuffer
 * to the pre-delete snapshot.
 *
 * @param {Array<{start: number, end: number}>} beforeSegments - segments snapshot from before the restore (the post-delete state)
 * @param {number} beforeTotalSamples - state.recordedBuffer.length from before the restore
 * @param {number} restoredIndex - index the restored segment occupies in the current (post-restore) state.segments
 * @param {number} oldPlayheadRatio - playback ratio before the restore
 * @param {number} newPlayheadRatio - playback ratio after the restore (current state)
 */
export function animateSegmentRestore(beforeSegments, beforeTotalSamples, restoredIndex, oldPlayheadRatio, newPlayheadRatio) {
  if (!state.originalBuffer || !state.recordedBuffer) {
    cancelSegmentDeleteAnimation();
    drawPlaybackWaveform(newPlayheadRatio);
    return;
  }

  const { dpr, W, H } = prepareCanvasForAnim();
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const oldSegBounds = computeSegmentBoundsPure(W, beforeSegments, beforeTotalSamples, gapPx);
  const newSegBounds = computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  const channelData = state.originalBuffer.getChannelData(0);

  const slides = [];
  for (let k = 0; k < state.segments.length; k++) {
    if (k === restoredIndex) continue;
    const oldIndex = k < restoredIndex ? k : k - 1;
    const oldSb = oldSegBounds[oldIndex];
    const newSb = newSegBounds[k];
    if (!oldSb || !newSb) continue;
    slides.push(buildSlide(oldSb, newSb, state.segments[k], channelData, H));
  }

  const particles = buildShatterParticles(newSegBounds[restoredIndex], state.segments[restoredIndex], channelData, H, dpr);
  const oldPlayheadX = audioRatioToVisualRatio(oldPlayheadRatio, W, oldSegBounds) * W;
  const newPlayheadX = audioRatioToVisualRatio(newPlayheadRatio, W, newSegBounds) * W;

  beginSegmentAnim(slides, particles, oldPlayheadX, newPlayheadX, newPlayheadRatio, true, dpr, W, H);
}

// ===== Segment click-to-select =====

function findSegmentAtX(x, width) {
  if (state.segments.length < 2 || !state.recordedBuffer) return -1;
  const gapPx = SEGMENT_GAP_CSS_PX;
  const segBounds = computeSegmentBounds(width, state.recordedBuffer.length, gapPx);
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    if (x >= sb.drawStart && x < sb.drawEnd) return i;
  }
  return -1;
}

el.waveformContainer.addEventListener('pointerdown', (e) => {
  if (state.segments.length < 2 || !state.recordedBuffer) return;
  const rect = el.waveformContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cardTop = SEGMENT_VERTICAL_INSET_CSS_PX;
  const cardBottom = rect.height - SEGMENT_VERTICAL_INSET_CSS_PX;
  if (y < cardTop || y > cardBottom) { hideSegmentTrash(); return; }
  const i = findSegmentAtX(x, rect.width);
  if (i >= 0) {
    if (i === state.hoveredSegmentIndex) hideSegmentTrash(); // toggle: click selected segment to deselect
    else showSegmentTrash(i);
  } else {
    hideSegmentTrash();
  }
});

// ===== Segment hover =====

let hoverRedrawRaf = null;

function scheduleHoverRedraw() {
  if (state.hoveredSegmentIndex >= 0) return; // selection anim handles redraws
  if (hoverRedrawRaf) return;
  hoverRedrawRaf = requestAnimationFrame(() => {
    hoverRedrawRaf = null;
    if (!state.isPlaying && state.recordedBuffer) {
      drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
    }
  });
}

el.waveformContainer.addEventListener('mousemove', (e) => {
  if (state.segments.length < 2 || !state.recordedBuffer) return;
  const rect = el.waveformContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cardTop = SEGMENT_VERTICAL_INSET_CSS_PX;
  const cardBottom = rect.height - SEGMENT_VERTICAL_INSET_CSS_PX;
  const i = (y >= cardTop && y <= cardBottom) ? findSegmentAtX(x, rect.width) : -1;
  if (i !== state.hoverSegmentIndex) {
    state.hoverSegmentIndex = i;
    el.waveformContainer.style.cursor = i >= 0 ? 'pointer' : 'default';
    scheduleHoverRedraw();
  }
});

el.waveformContainer.addEventListener('mouseleave', () => {
  if (state.hoverSegmentIndex !== -1) {
    state.hoverSegmentIndex = -1;
    el.waveformContainer.style.cursor = 'default';
    scheduleHoverRedraw();
  }
});
