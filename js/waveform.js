import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, MIN_SEGMENT_SAMPLES, SEGMENT_GAP_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SELECTION_PULSE_PERIOD_SEC, DELETE_PULSE_PERIOD_SEC, SEGMENT_DELETE_ANIM_MS } from './state.js';
import { el, waveCtx, rulerCtx } from './dom.js';
import { pausePlayback } from './playback.js';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel } from './waveform-math.js';
import { pushHistory } from './history.js';
import { updateEmptyState } from './ui.js';

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

export function positionAppendButton() {
  if (!state.recordedBuffer || state.isRecording || el.playbackView.hidden) {
    el.appendButton.classList.remove('visible');
    el.appendMenu.hidden = true;
    return;
  }
  const viewRect = el.playbackView.getBoundingClientRect();
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const btnW = 30;
  const padPx = 16;
  let leftPx = viewRect.width - btnW - padPx;
  const midY = (canvasRect.top - viewRect.top) + canvasRect.height / 2;
  el.appendButton.style.left = leftPx + 'px';
  el.appendButton.style.top = (midY - btnW / 2) + 'px';
  el.appendButton.classList.add('visible');
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
  positionAppendButton();

  if (state.hoveredSegmentIndex >= 0) {
    positionSegmentTrash();
  }

  drawTimelineRuler(state.recordedBuffer.duration, segBounds, W, dpr, geomKey);
}

// ===== Segment delete animation =====
//
// The deleted card disintegrates as the exact image the user was looking at:
// right before the segments are spliced, the card is rendered once in its
// delete-red state through the normal renderer and its pixels are copied off
// the live canvas into an offscreen snapshot. That snapshot is then cut into
// a grid of tiles which tile seamlessly at frame zero (the first frame IS
// the red card, pixel-for-pixel) before drifting apart, rotating, and fading.
// The surviving cards slide/reflow from their old positions into their final
// ones — each keeps rendering its own (unchanged) audio via a local waveform
// path, stretched to its animated width, so the shapes stay correct
// mid-slide instead of morphing through unrelated content. DOM chrome
// (playhead caret, scissors, split handles) rides a matching temporary CSS
// transition so the whole editor glides in lockstep rather than just the
// canvas.

const SHATTER_TILE_CSS_PX = 12;
const SHATTER_MAX_TILES = 500;
const SHATTER_MAX_DRIFT_CSS_PX = 44;
const SHATTER_STAGGER_MS = 110;
// Extra margin captured around the card so its glow/shadow travels with the tiles.
const SNAPSHOT_PAD_CSS_PX = 16;

/**
 * @typedef {Object} SegmentSnapshot
 * @property {HTMLCanvasElement} canvas - offscreen copy of the card's pixels
 * @property {number} sx - x of the captured region on the waveform canvas (device px)
 * @property {number} sy - y of the captured region on the waveform canvas (device px)
 * @property {number} W - waveform canvas width at capture time (device px)
 * @property {number} H - waveform canvas height at capture time (device px)
 */

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

// The canvas rectangle a snapshot of card sb covers: the card itself plus
// padding for its glow/shadow, clamped to [minX, maxX] (so a live capture
// never lifts pixels belonging to a neighboring card) and to the canvas.
function snapshotRegion(sb, W, H, dpr, minX, maxX) {
  const pad = Math.round(SNAPSHOT_PAD_CSS_PX * dpr);
  const insetY = Math.round(SEGMENT_VERTICAL_INSET_CSS_PX * dpr);
  const sx = Math.max(0, minX, Math.floor(sb.drawStart - pad));
  const ex = Math.min(W, maxX, Math.ceil(sb.drawEnd + pad));
  const sy = Math.max(0, insetY - pad);
  const ey = Math.min(H, H - insetY + pad);
  if (ex <= sx || ey <= sy) return null;
  return { sx, sy, w: ex - sx, h: ey - sy };
}

/** @returns {{ off: HTMLCanvasElement, ctx: CanvasRenderingContext2D, sx: number, sy: number } | null} */
function makeSnapshotCanvas(sb, W, H, dpr, minX, maxX) {
  const region = sb ? snapshotRegion(sb, W, H, dpr, minX, maxX) : null;
  if (!region) return null;
  const off = document.createElement('canvas');
  off.width = region.w;
  off.height = region.h;
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  return { off, ctx, sx: region.sx, sy: region.sy };
}

// Copies the card region around segBound sb (plus glow/shadow padding, but
// never past the neighboring cards' edges) from the live waveform canvas
// into an offscreen canvas. Must be called while the canvas still shows the
// frame the region should be lifted from.
/** @returns {SegmentSnapshot | null} */
function captureCanvasRegion(sb, W, H, dpr, minX, maxX) {
  const snap = makeSnapshotCanvas(sb, W, H, dpr, minX, maxX);
  if (!snap) return null;
  snap.ctx.drawImage(el.waveformCanvas, snap.sx, snap.sy, snap.off.width, snap.off.height, 0, 0, snap.off.width, snap.off.height);
  return { canvas: snap.off, sx: snap.sx, sy: snap.sy, W, H };
}

// Renders card sb into an offscreen snapshot without touching the live
// canvas or DOM chrome — used by the restore animation, where the restored
// card isn't on screen yet. Draws exactly what the final frame will show for
// that card (normal, unselected style) via the same path the slides use.
/** @returns {SegmentSnapshot | null} */
function renderCardSnapshot(sb, seg, channelData, W, H, dpr, playheadX) {
  const snap = makeSnapshotCanvas(sb, W, H, dpr, 0, W);
  if (!snap) return null;
  snap.ctx.translate(-snap.sx, -snap.sy);
  const slide = buildSlide(sb, sb, seg, channelData, H);
  drawSlideCard(snap.ctx, slide, sb.drawStart, sb.drawEnd, playheadX, H, dpr, SEGMENT_EDGE_WIDTH_CSS_PX * dpr);
  return { canvas: snap.off, sx: snap.sx, sy: snap.sy, W, H };
}

/**
 * Captures the to-be-deleted segment card as an image, exactly as the
 * renderer draws it in its delete-red (trash-hover) state. Call this BEFORE
 * splicing state.segments — it re-renders the current frame with the segment
 * forced into the red marked-for-delete style via the normal drawing path,
 * then lifts that card's pixels off the canvas. The returned snapshot is what
 * animateSegmentDelete disintegrates.
 *
 * @param {number} index - segment index about to be deleted
 * @returns {SegmentSnapshot | null}
 */
export function captureSegmentBitmap(index) {
  if (!state.recordedBuffer || el.playbackView.hidden) return null;

  const prevHovered = state.hoveredSegmentIndex;
  const prevTrash = state.isHoveringTrash;
  state.hoveredSegmentIndex = index;
  state.isHoveringTrash = true;
  const ratio = state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0;
  drawPlaybackWaveform(ratio);
  state.hoveredSegmentIndex = prevHovered;
  state.isHoveringTrash = prevTrash;

  const dpr = window.devicePixelRatio || 1;
  const W = el.waveformCanvas.width, H = el.waveformCanvas.height;
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const segBounds = computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  if (!segBounds[index]) return null;
  const minX = index > 0 ? Math.ceil(segBounds[index - 1].drawEnd) + 1 : 0;
  const maxX = index < segBounds.length - 1 ? Math.floor(segBounds[index + 1].drawStart) - 1 : W;
  return captureCanvasRegion(segBounds[index], W, H, dpr, minX, maxX);
}

// Cuts the snapshot into a grid of roughly SHATTER_TILE_CSS_PX-square tiles
// (grown as needed to stay under SHATTER_MAX_TILES). The tiles cover the
// snapshot edge-to-edge, so at elapsed=0 (zero drift, zero rotation, full
// alpha) drawing them reproduces the captured card pixel-for-pixel — it's
// the rendered image itself that then crumbles apart.
function buildShatterTiles(snap, dpr) {
  if (!snap) return [];
  const sw = snap.canvas.width, sh = snap.canvas.height;
  let tile = SHATTER_TILE_CSS_PX * dpr;
  if ((sw / tile) * (sh / tile) > SHATTER_MAX_TILES) {
    tile = Math.sqrt((sw * sh) / SHATTER_MAX_TILES);
  }
  const cols = Math.max(1, Math.round(sw / tile));
  const rows = Math.max(1, Math.round(sh / tile));
  const tw = sw / cols, th = sh / rows;
  const centerX = snap.sx + sw / 2;
  const midY = snap.H / 2;

  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = snap.sx + (c + 0.5) * tw;
      const cy = snap.sy + (r + 0.5) * th;
      const dirX = cx === centerX ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(cx - centerX);
      const dirY = cy === midY ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(cy - midY);
      tiles.push({
        sx: c * tw, sy: r * th, w: tw, h: th, cx, cy,
        vx: dirX * (0.25 + Math.random() * 0.6),
        vy: dirY * (0.3 + Math.random() * 0.7) - 0.25,
        rotSpeed: (Math.random() - 0.5) * 1.6,
        delay: Math.random() * SHATTER_STAGGER_MS
      });
    }
  }
  return tiles;
}

function drawShatterTiles(ctx, snap, tiles, elapsedMs, dpr) {
  const maxDrift = SHATTER_MAX_DRIFT_CSS_PX * dpr;
  for (const t of tiles) {
    const localDuration = Math.max(60, SEGMENT_DELETE_ANIM_MS - t.delay);
    const pt = Math.max(0, Math.min(1, (elapsedMs - t.delay) / localDuration));
    const eased = 1 - Math.pow(1 - pt, 2);
    const alpha = 1 - Math.pow(pt, 1.6);
    if (alpha <= 0.01) continue;

    ctx.globalAlpha = alpha;
    const scale = 1 - 0.4 * eased;
    const rot = t.rotSpeed * eased;
    const cos = Math.cos(rot) * scale, sin = Math.sin(rot) * scale;
    ctx.setTransform(cos, sin, -sin, cos, t.cx + t.vx * maxDrift * eased, t.cy + t.vy * maxDrift * eased);
    ctx.drawImage(snap.canvas, t.sx, t.sy, t.w, t.h, -t.w / 2, -t.h / 2, t.w, t.h);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

function buildSlide(oldSb, newSb, seg, channelData, H) {
  const finalWidth = Math.max(1, Math.round(newSb.drawEnd - newSb.drawStart));
  const peaks = computePeaksForRange(channelData, seg.start, seg.end, finalWidth);
  const localPath = new Path2D();
  buildWaveformPath(localPath, peaks, 0, finalWidth, H / 2, WAVEFORM_SCALE);
  return { oldSb, newSb, finalWidth, localPath };
}

// Draws one sliding card (background, midline, playhead-split waveform,
// edge stroke) at its current interpolated position. Also reused to render
// a card into an offscreen snapshot (renderCardSnapshot).
function drawSlideCard(ctx, s, curStart, curEnd, playheadX, H, dpr, edgeWidth) {
  const curWidth = curEnd - curStart;
  const cardPath = buildOneCardPath(curStart, curWidth, H, dpr);
  if (!cardPath) return;

  ctx.save();
  ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
  ctx.shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
  ctx.shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
  ctx.fillStyle = WAVEFORM_STYLE.segmentCardBg;
  ctx.fill(cardPath);
  ctx.restore();

  ctx.save();
  ctx.clip(cardPath);

  ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(curStart, H / 2);
  ctx.lineTo(curEnd, H / 2);
  ctx.stroke();

  const scaleX = curWidth / s.finalWidth;
  const midX = Math.min(curEnd, Math.max(curStart, playheadX));
  if (midX > curStart) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(curStart, 0, midX - curStart, H);
    ctx.clip();
    ctx.translate(curStart, 0);
    ctx.scale(scaleX, 1);
    ctx.fillStyle = WAVEFORM_STYLE.playedColor;
    ctx.fill(s.localPath);
    ctx.restore();
  }
  if (midX < curEnd) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(midX, 0, curEnd - midX, H);
    ctx.clip();
    ctx.translate(curStart, 0);
    ctx.scale(scaleX, 1);
    ctx.fillStyle = WAVEFORM_STYLE.unplayedColor;
    ctx.fill(s.localPath);
    ctx.restore();
  }

  ctx.restore();

  ctx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
  ctx.lineWidth = edgeWidth;
  ctx.stroke(cardPath);
}

function drawDeleteAnimFrame(anim, now) {
  const { slides, snap, tiles, W, H, dpr } = anim;
  const elapsedMs = now - anim.startTime;
  const t = Math.max(0, Math.min(1, elapsedMs / SEGMENT_DELETE_ANIM_MS));
  const eased = easeOutCubic(t);

  waveCtx.clearRect(0, 0, W, H);

  const curPlayheadX = anim.oldPlayheadX + (anim.newPlayheadX - anim.oldPlayheadX) * eased;
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;

  for (const s of slides) {
    const curStart = s.oldSb.drawStart + (s.newSb.drawStart - s.oldSb.drawStart) * eased;
    const curEnd = s.oldSb.drawEnd + (s.newSb.drawEnd - s.oldSb.drawEnd) * eased;
    drawSlideCard(waveCtx, s, curStart, curEnd, curPlayheadX, H, dpr, edgeWidth);
  }

  // Restore plays the exact same tile trajectories backwards in time, so the
  // card image reassembles from fragments instead of crumbling into them.
  if (snap && tiles.length > 0) {
    const tileElapsedMs = anim.reverseTiles ? SEGMENT_DELETE_ANIM_MS - elapsedMs : elapsedMs;
    drawShatterTiles(waveCtx, snap, tiles, tileElapsedMs, dpr);
  }
}

// Shared setup for both directions: hands the DOM chrome (caret, scissors,
// split handles) a temporary CSS transition to their final spot so they glide
// in lockstep with the canvas, then drives the canvas animation via rAF.
function beginSegmentAnim(slides, snap, tiles, oldPlayheadX, newPlayheadX, newPlayheadRatio, reverseTiles, dpr, W, H, onComplete) {
  cancelSegmentDeleteAnimation();

  const domTransition = `left ${SEGMENT_DELETE_ANIM_MS}ms ease-out, top ${SEGMENT_DELETE_ANIM_MS}ms ease-out`;
  el.playheadCaretTop.style.transition = domTransition;
  el.playheadScissors.style.transition = `${domTransition}, opacity 0.18s ease`;
  positionPlayheadCarets(newPlayheadRatio);
  updatePlayheadScissorsPosition(newPlayheadRatio);
  if (state.draggingHandleIndex < 0) ensureDivisionHandles();
  for (const h of bottomHandles) h.style.transition = `${domTransition}, opacity 0.15s, transform 0.15s, color 0.15s`;
  positionDivisionHandles();

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
 * Animates a segment deletion: the removed card's red waveform disintegrates
 * in place — its captured image (see captureSegmentBitmap) cut into tiles
 * that drift apart, rotate, and fade — as the surviving cards slide from
 * their old layout into their final one. Call this in place of
 * drawPlaybackWaveform right after splicing state.segments and rebuilding
 * state.recordedBuffer for a delete (including a redo that replays one).
 *
 * @param {Array<{start: number, end: number}>} oldSegments - segments snapshot from before the splice
 * @param {number} oldTotalSamples - state.recordedBuffer.length from before the splice
 * @param {number} deletedIndex - index removed from oldSegments
 * @param {number} oldPlayheadRatio - playback ratio before the delete
 * @param {number} newPlayheadRatio - playback ratio after the delete (current state)
 * @param {SegmentSnapshot | null} snap - the deleted card's image, captured via captureSegmentBitmap before the splice
 */
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
    // Last segment deleted — no surviving cards to slide, just disintegrate
    // the captured card, then reveal the empty-state placeholder.
    slides = [];
    newPlayheadX = 0;
    onComplete = () => { drawPlaybackWaveform(0); updateEmptyState(); };
  } else {
    const channelData = state.originalBuffer.getChannelData(0);
    const newSegBounds = computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
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

  // A snapshot captured at a different canvas size can't line up — drop it
  // and let the surviving cards' slide carry the animation alone.
  const validSnap = snap && snap.W === W && snap.H === H ? snap : null;
  const tiles = buildShatterTiles(validSnap, dpr);
  const oldPlayheadX = audioRatioToVisualRatio(oldPlayheadRatio, W, oldSegBounds) * W;

  beginSegmentAnim(slides, validSnap, tiles, oldPlayheadX, newPlayheadX, newPlayheadRatio, false, dpr, W, H, onComplete);
}

/**
 * The reverse of animateSegmentDelete, for undoing a delete: the restored
 * card's image reassembles from converging tiles (the same trajectories as
 * a delete's disintegration, played backwards in time) while
 * the other cards slide apart from their current layout to make room. Call this in place of
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

  const oldPlayheadX = audioRatioToVisualRatio(oldPlayheadRatio, W, oldSegBounds) * W;
  const newPlayheadX = audioRatioToVisualRatio(newPlayheadRatio, W, newSegBounds) * W;
  // The restored card isn't on screen to capture, so render its final look
  // into the snapshot instead.
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
  const segBounds = computeSegmentBounds(width, state.recordedBuffer.length, gapPx);
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    if (x >= sb.drawStart && x < sb.drawEnd) return i;
  }
  return -1;
}

el.waveformContainer.addEventListener('pointerdown', (e) => {
  if (!state.recordedBuffer) return;
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
  if (!state.recordedBuffer) return;
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
