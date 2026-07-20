import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, MIN_SEGMENT_SAMPLES, SEGMENT_GAP_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SELECTION_PULSE_PERIOD_SEC, DELETE_PULSE_PERIOD_SEC, SEGMENT_DELETE_ANIM_MS, TRASH_HALF_WIDTH_CSS_PX, TRASH_ABOVE_CARD_CSS_PX, APPEND_BUTTON_SIZE_CSS_PX, SEGMENT_DRAG_LIFT_CSS_PX, SEGMENT_DRAG_SETTLE_MS, SEGMENT_DRAG_SHADOW_BLUR_CSS_PX, SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_DRAG_APPROACH_RATE } from './state.js';
import { el, waveCtx, rulerCtx } from './dom.js';
import { pausePlayback } from './playback.js';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel, computePeaksForRange, buildWaveformPath, buildOneCardPath, findSegmentAtSamplePure, computeReorderArrangement, computeArrangementBounds } from './waveform-math.js';
import { pushHistory } from './history.js';
import { updateEmptyState } from './ui.js';
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

// ===== Trash & scissors positioning =====

const SCISSORS_FALLBACK_HEIGHT = 30;

function updatePlayheadScissorsPosition(ratio) {
  if (state.isPlaying || !state.recordedBuffer || ratio < 0 || ratio > 1 || el.playbackView.hidden) {
    el.playheadScissors.classList.remove('visible');
    return;
  }

  const EDGE_THRESHOLD = 1 / (2 * state.recordedBuffer.length);
  if (ratio <= EDGE_THRESHOLD || ratio >= 1 - EDGE_THRESHOLD) {
    el.playheadScissors.classList.remove('visible');
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.editorSection.getBoundingClientRect();
  const halfBtn = (el.playheadScissors.offsetHeight || SCISSORS_FALLBACK_HEIGHT) / 2;

  const gapPx = SEGMENT_GAP_CSS_PX;
  const segBounds = _computeSegmentBounds(canvasRect.width, state.recordedBuffer.length, gapPx);
  const visualRatio = audioRatioToVisualRatio(ratio, canvasRect.width, segBounds);

  let leftPx = (canvasRect.left - viewRect.left) + visualRatio * canvasRect.width;
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX;
  const playheadBottomY = (canvasRect.bottom - viewRect.top) - insetY;
  const topPx = playheadBottomY + halfBtn;

  leftPx = Math.max(halfBtn, Math.min(viewRect.width - halfBtn, leftPx));

  el.playheadScissors.style.left = leftPx + 'px';
  el.playheadScissors.style.top = topPx + 'px';
  el.playheadScissors.classList.add('visible');
}

// ===== Playhead caret positioning =====

function positionPlayheadCarets(ratio) {
  if (!state.recordedBuffer || el.playbackView.hidden || ratio < 0 || ratio > 1) {
    el.playheadCaretTop.style.display = 'none';
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.editorSection.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.floor(canvasRect.width * dpr);
  const gapPx = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const segBounds = _computeSegmentBounds(W, state.recordedBuffer.length, gapPx);
  const visualRatio = audioRatioToVisualRatio(ratio, W, segBounds);
  const lineXCssPx = Math.floor(visualRatio * W) / dpr;
  const leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;

  el.playheadCaretTop.style.display = '';

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
  state.selectedSegmentIndex = -1;
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
  state.selectedSegmentIndex = index;
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
    if (state.selectedSegmentIndex < 0) { selectionAnimRaf = null; return; }
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
  if (state.selectedSegmentIndex < 0 || !state.recordedBuffer) return;
  if (state.selectedSegmentIndex >= state.segments.length) { hideSegmentTrash(); return; }
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.editorSection.getBoundingClientRect();
  const gapPx = SEGMENT_GAP_CSS_PX;
  const segBounds = _computeSegmentBounds(canvasRect.width, state.recordedBuffer.length, gapPx);
  const sb = segBounds[state.selectedSegmentIndex];
  if (!sb) { hideSegmentTrash(); return; }

  const centerX = (sb.drawStart + sb.drawEnd) / 2;
  let leftPx = (canvasRect.left - viewRect.left) + centerX;
  leftPx = Math.max(TRASH_HALF_WIDTH_CSS_PX, Math.min(viewRect.width - TRASH_HALF_WIDTH_CSS_PX, leftPx));
  const topPx = (canvasRect.top - viewRect.top) - TRASH_ABOVE_CARD_CSS_PX;

  el.segmentTrash.style.left = leftPx + 'px';
  el.segmentTrash.style.top = topPx + 'px';
}

const DIVISION_HANDLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -0.5 21 21" fill="currentColor"><path d="M3.25 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.75 3h-2a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let bottomHandles = [];

function createHandleElement() {
  const h = document.createElement('button');
  h.className = 'division-handle';
  h.innerHTML = DIVISION_HANDLE_SVG;
  h.tabIndex = -1;
  h.setAttribute('aria-label', 'Drag to reposition split');

  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const segIndex = parseInt(h.dataset.segIndex);
    if (state.isPlaying) pausePlayback();
    const totalSamples = state.recordedBuffer.length;
    let accBeforeSegI = 0;
    for (let j = 0; j < segIndex; j++) {
      accBeforeSegI += state.segments[j].end - state.segments[j].start;
    }
    const segILen = state.segments[segIndex].end - state.segments[segIndex].start;
    const segIP1Len = state.segments[segIndex + 1].end - state.segments[segIndex + 1].start;
    pushHistory();
    state.draggingHandleIndex = segIndex;
    state._dragSnapshot = {
      handleIndex: segIndex,
      totalSamples,
      startClientX: e.clientX,
      accBeforeSegI,
      segIStart: state.segments[segIndex].start,
      segIP1End: state.segments[segIndex + 1].end,
      minAcc: accBeforeSegI + MIN_SEGMENT_SAMPLES,
      maxAcc: accBeforeSegI + segILen + segIP1Len - MIN_SEGMENT_SAMPLES
    };
    addDraggingClass(segIndex);
    hideSegmentTrash();
    el.playheadScissors.classList.remove('visible');
  });

  h.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  return h;
}

function ensureDivisionHandles() {
  const segs = state.segments;
  const desiredSegIndices = [];
  for (let i = 0; i < segs.length - 1; i++) {
    desiredSegIndices.push(i);
  }

  while (bottomHandles.length > desiredSegIndices.length) {
    bottomHandles.pop().remove();
  }

  while (bottomHandles.length < desiredSegIndices.length) {
    const bottomH = createHandleElement();
    el.editorSection.appendChild(bottomH);
    bottomHandles.push(bottomH);
  }

  for (let i = 0; i < bottomHandles.length; i++) {
    bottomHandles[i].dataset.segIndex = String(desiredSegIndices[i]);
  }
}

const HANDLE_HALF_W = 12;

function positionDivisionHandles() {
  if (!state.recordedBuffer || state.segments.length <= 1) {
    for (const h of bottomHandles) h.style.display = 'none';
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.editorSection.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.floor(canvasRect.width * dpr);
  const bottomPx = (canvasRect.bottom - viewRect.top) + 1;
  const totalSamples = state.recordedBuffer.length;

  for (const h of bottomHandles) {
    const segIndex = parseInt(h.dataset.segIndex);
    let acc = 0;
    for (let j = 0; j <= segIndex; j++) {
      acc += state.segments[j].end - state.segments[j].start;
    }
    const ratio = acc / totalSamples;
    const lineXCssPx = Math.floor(ratio * W) / dpr;
    let leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;
    leftPx = Math.max(HANDLE_HALF_W, Math.min(viewRect.width - HANDLE_HALF_W, leftPx));

    h.style.display = '';
    h.style.left = leftPx + 'px';
    h.style.top = bottomPx + 'px';
  }
}

function positionAppendButton() {
  if (!state.recordedBuffer || state.isRecording || el.playbackView.hidden) {
    el.appendButton.classList.remove('visible');
    el.appendMenu.hidden = true;
    return;
  }
  const viewRect = el.editorSection.getBoundingClientRect();
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const stageRect = el.stage.getBoundingClientRect();
  // Center the button in the visible empty space between the waveform's right
  // edge and the master container's (stage's) right edge. That space spans the
  // waveform container's right margin plus the stage's right padding, so it is
  // wider than just the margin — measuring against the stage is what makes the
  // button sit visually centered rather than shifted toward the waveform.
  const gapLeftPx = canvasRect.right - viewRect.left;
  const gapRightPx = stageRect.right - viewRect.left;
  const gapWidthPx = gapRightPx - gapLeftPx;
  let leftPx = gapLeftPx + Math.max(0, (gapWidthPx - APPEND_BUTTON_SIZE_CSS_PX) / 2);
  const midY = (canvasRect.top - viewRect.top) + canvasRect.height / 2;
  el.appendButton.style.left = leftPx + 'px';
  el.appendButton.style.top = (midY - APPEND_BUTTON_SIZE_CSS_PX / 2) + 'px';
  el.appendButton.classList.add('visible');
}

function addDraggingClass(segIndex) {
  const h = bottomHandles.find(el => parseInt(el.dataset.segIndex) === segIndex);
  if (h) h.classList.add('dragging');
}

export function removeDraggingClass(segIndex) {
  const h = bottomHandles.find(el => parseInt(el.dataset.segIndex) === segIndex);
  if (h) h.classList.remove('dragging');
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
  const selectedIdx = state.selectedSegmentIndex;
  const hoverIdx = state.hoverSegmentIndex;

  for (let i = 0; i < cardPaths.length; i++) {
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    ctx.save();
    ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
    ctx.shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
    ctx.shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
    if (i === state.draggingSegmentIndex) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.018)';
    } else if (i === selectedIdx || i === hoverIdx) {
      ctx.fillStyle = WAVEFORM_STYLE.hoverCardBg;
    } else {
      ctx.fillStyle = WAVEFORM_STYLE.segmentCardBg;
    }
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

  if (baseLayerCanvas) ctx.drawImage(baseLayerCanvas, 0, 0);

  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    const x = sb.drawStart;
    const w = sb.drawEnd - sb.drawStart;
    const isSelected = i === selectedIdx;
    const isDragged = i === state.draggingSegmentIndex;

    ctx.save();
    ctx.clip(cardPath);

    if (isDragged) ctx.globalAlpha = 0.35;

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

    if (isDragged) {
      ctx.save();
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
      ctx.lineWidth = edgeWidth;
      ctx.stroke(cardPath);
      ctx.restore();
    } else if (isSelected) {
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
  el.playheadScissors.style.transition = '';
  for (const h of bottomHandles) h.style.transition = '';
}

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
  const segBounds = _computeSegmentBounds(W, totalSamples, gapPx);
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
  const baseKey = geomKey + '#' + state.selectedSegmentIndex + '#' + state.hoverSegmentIndex + '#' + state.draggingSegmentIndex;
  if (baseKey !== baseLayerKey) {
    renderBaseLayer(segBounds, cachedCardPaths, W, H, dpr);
    baseLayerKey = baseKey;
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

  if (state.draggingHandleIndex < 0) {
    ensureDivisionHandles();
  }
  positionDivisionHandles();
  positionAppendButton();

  if (state.selectedSegmentIndex >= 0) {
    positionSegmentTrash();
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
 * Compute the playhead's animated device-px X for the current drag frame.
 *
 * The playhead follows its audio content: it stays on the same segment (by
 * {start, end} identity) at the same offset within that segment, regardless of
 * where that segment has been dragged to in the live arrangement. If the
 * playhead's segment is the dragged one during live drag, the playhead sits on
 * the floating card (which follows the pointer) rather than the slot.
 */
function computeDragPlayheadX(snap, floatStart) {
  const originalIdx = snap.playheadSegOriginalIndex;
  if (originalIdx < 0) return -1;
  const segLen = snap.playheadSegEnd - snap.playheadSegStart;
  const frac = segLen > 0 ? Math.max(0, Math.min(1, snap.playheadOffsetInSeg / segLen)) : 0;

  if (floatStart != null) {
    // Playhead is on the floating card.
    const pathWidth = snap.segPathWidths[originalIdx];
    return floatStart + frac * pathWidth;
  }
  const ab = snap.animBounds[originalIdx];
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
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.editorSection.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const lineXCssPx = deviceX / dpr;
  const leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;
  el.playheadCaretTop.style.display = '';
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX;
  const lineOffsetTop = el.playheadLine.offsetTop;
  const topPx = (canvasRect.top - viewRect.top) + insetY - lineOffsetTop;
  el.playheadLine.style.height = Math.max(0, canvasRect.height - 2 * insetY) + 'px';
  el.playheadCaretTop.style.left = leftPx + 'px';
  el.playheadCaretTop.style.top = topPx + 'px';
}

/**
 * Render a single segment card at the given animated bounds, using a pre-built
 * local waveform path (built once at drag-begin) scaled to fit the current
 * width. Optional `lift`, `shadowBlur`, `shadowOffsetY`, `dashed`, and
 * `strokeColor` let the caller style the floating dragged card differently
 * from the in-place cards.
 */
function drawDragCard(ctx, segPath, pathWidth, drawStart, drawEnd, playheadX, H, dpr, options) {
  const curWidth = drawEnd - drawStart;
  if (curWidth <= 0 || !segPath) return;
  const cardPath = _buildOneCardPath(drawStart, curWidth, H, dpr);
  if (!cardPath) return;

  const lift = options.lift || 0;
  const edgeWidth = options.edgeWidth;

  ctx.save();
  if (lift > 0) ctx.translate(0, -lift);

  // Card background + drop shadow (deeper for the lifted floating card).
  // The shadow offset is increased by `lift` so the shadow stays near the
  // "ground" (the card's un-lifted Y) rather than rising with the card —
  // that's what conveys the lift visually.
  ctx.save();
  ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
  ctx.shadowBlur = options.shadowBlur != null ? options.shadowBlur : SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
  ctx.shadowOffsetY = (options.shadowOffsetY != null ? options.shadowOffsetY : SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr) + lift;
  ctx.fillStyle = WAVEFORM_STYLE.segmentCardBg;
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

  // Edge stroke: dashed outline for the floating card while actively dragged,
  // solid accent edge while settling, normal edge for in-place cards.
  if (options.dashed) {
    ctx.save();
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = options.strokeColor || WAVEFORM_STYLE.selectedEdgeColor;
    ctx.lineWidth = edgeWidth;
    ctx.stroke(cardPath);
    ctx.restore();
  } else if (options.strokeColor) {
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
 * Draw a faint dashed outline of the dragged segment's slot — the "drop zone"
 * the card will land in. Replaces the old vertical-line drop indicator with a
 * shape that matches the card's rounded rectangle.
 */
function drawDropZoneOutline(ctx, drawStart, drawEnd, H, dpr) {
  const w = drawEnd - drawStart;
  if (w <= 0) return;
  const cardPath = _buildOneCardPath(drawStart, w, H, dpr);
  if (!cardPath) return;
  ctx.save();
  ctx.setLineDash([6 * dpr, 5 * dpr]);
  ctx.strokeStyle = WAVEFORM_STYLE.selectedEdgeColor;
  ctx.lineWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;
  ctx.shadowColor = WAVEFORM_STYLE.selectedGlowColor;
  ctx.shadowBlur = 6 * dpr;
  ctx.stroke(cardPath);
  ctx.fillStyle = 'rgba(77, 216, 200, 0.05)';
  ctx.fill(cardPath);
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
 * either fully played (before the playhead's segment in the arrangement), fully
 * unplayed (after it), or split at the playhead offset (if it IS the playhead's
 * segment).
 */
function drawDragFrame() {
  const snap = state._segmentDragSnapshot;
  if (!snap || !state.recordedBuffer || !state.originalBuffer) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));
  if (el.waveformCanvas.width !== W) el.waveformCanvas.width = W;
  if (el.waveformCanvas.height !== H) el.waveformCanvas.height = H;

  waveCtx.clearRect(0, 0, W, H);

  const isSettling = !!snap.settle;
  const srcIdx = snap.srcIndex;
  const arrangement = snap.arrangement;
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;
  const playheadOrigIdx = snap.playheadSegOriginalIndex;
  const playheadSegLen = snap.playheadSegEnd - snap.playheadSegStart;
  const playheadFrac = playheadSegLen > 0
    ? Math.max(0, Math.min(1, snap.playheadOffsetInSeg / playheadSegLen))
    : 0;

  // Find the playhead segment's position in the live arrangement so each card
  // can be classified as before / after / containing the playhead.
  let kPlayhead = -1;
  for (let k = 0; k < arrangement.length; k++) {
    if (arrangement[k] === playheadOrigIdx) { kPlayhead = k; break; }
  }
  const srcK = arrangement.indexOf(srcIdx);

  // Compute the floating card's current position (used for the floating render
  // and for the playhead caret when the playhead is on the dragged segment).
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
  // floating card is drawn separately; during settle it's rendered below.
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

    // Floating dragged card: follows the pointer, lifted, deep shadow, dashed.
    if (floatStart >= 0) {
      const floatEnd = floatStart + pathWidth;
      const splitX = splitForCard(srcK, floatStart, floatEnd, pathWidth);
      drawDragCard(waveCtx, snap.segPaths[srcIdx], pathWidth,
        floatStart, floatEnd, splitX, H, dpr, {
          edgeWidth,
          lift: snap.liftPx,
          shadowBlur: SEGMENT_DRAG_SHADOW_BLUR_CSS_PX * dpr,
          shadowOffsetY: SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX * dpr,
          dashed: true,
        });
    }
  } else {
    // Settle: render the dragged segment at its eased position, with lift +
    // deep shadow fading to normal as it lands.
    const ab = snap.animBounds[srcIdx];
    if (ab && ab.drawEnd > ab.drawStart) {
      const maxLift = SEGMENT_DRAG_LIFT_CSS_PX * dpr;
      const liftFrac = maxLift > 0 ? Math.max(0, snap.liftPx / maxLift) : 0;
      const cardW = ab.drawEnd - ab.drawStart;
      const splitX = splitForCard(srcK, ab.drawStart, ab.drawEnd, cardW);
      drawDragCard(waveCtx, snap.segPaths[srcIdx], snap.segPathWidths[srcIdx],
        ab.drawStart, ab.drawEnd, splitX, H, dpr, {
          edgeWidth,
          lift: snap.liftPx,
          shadowBlur: SEGMENT_SHADOW_BLUR_CSS_PX * dpr + (SEGMENT_DRAG_SHADOW_BLUR_CSS_PX - SEGMENT_SHADOW_BLUR_CSS_PX) * dpr * liftFrac,
          shadowOffsetY: SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr + (SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX - SEGMENT_SHADOW_OFFSET_Y_CSS_PX) * dpr * liftFrac,
          strokeColor: liftFrac > 0.05 ? WAVEFORM_STYLE.selectedEdgeColor : null,
        });
    }
  }

  // Playhead carets follow the audio content. If the playhead is on the
  // dragged segment during live drag, the carets sit on the floating card.
  const playheadOnDragged = playheadOrigIdx === srcIdx;
  const caretX = playheadOnDragged && !isSettling && floatStart >= 0
    ? computeDragPlayheadX(snap, floatStart)
    : computeDragPlayheadX(snap);
  positionPlayheadCaretsAtDeviceX(caretX);
  el.playheadScissors.classList.remove('visible');

  // Division handles would be at stale positions during the live rearrange;
  // hide them for the duration of the drag. drawPlaybackWaveform will
  // reposition them when normal rendering resumes after settle.
  for (const h of bottomHandles) h.style.display = 'none';

  // The append button doesn't depend on segment positions, keep it placed.
  positionAppendButton();
}

export function captureSegmentBitmap(index) {
  if (!state.recordedBuffer || el.playbackView.hidden) return null;

  const prevHovered = state.selectedSegmentIndex;
  const prevTrash = state.isHoveringTrash;
  state.selectedSegmentIndex = index;
  state.isHoveringTrash = true;
  const ratio = state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0;
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
    const channelData = state.originalBuffer.getChannelData(0);
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
      drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
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
});

el.waveformContainer.addEventListener('mouseleave', () => {
  if (state.hoverSegmentIndex !== -1) {
    state.hoverSegmentIndex = -1;
    el.waveformContainer.style.cursor = 'default';
    scheduleHoverRedraw();
  }
});
