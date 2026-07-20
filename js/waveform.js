import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, MIN_SEGMENT_SAMPLES, SEGMENT_GAP_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SELECTION_PULSE_PERIOD_SEC, DELETE_PULSE_PERIOD_SEC, SEGMENT_DELETE_ANIM_MS, TRASH_HALF_WIDTH_CSS_PX, TRASH_ABOVE_CARD_CSS_PX, APPEND_BUTTON_SIZE_CSS_PX, APPEND_BUTTON_PAD_CSS_PX } from './state.js';
import { el, waveCtx, rulerCtx } from './dom.js';
import { pausePlayback } from './playback.js';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel, computePeaksForRange, buildWaveformPath, buildOneCardPath, findSegmentAtSamplePure } from './waveform-math.js';
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
  const viewRect = el.playbackView.getBoundingClientRect();
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
  const viewRect = el.playbackView.getBoundingClientRect();
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

function showSegmentTrash(index) {
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
  const viewRect = el.playbackView.getBoundingClientRect();
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

function ensureDivisionHandles() {
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

function positionDivisionHandles() {
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

function positionAppendButton() {
  if (!state.recordedBuffer || state.isRecording || el.playbackView.hidden) {
    el.appendButton.classList.remove('visible');
    el.appendMenu.hidden = true;
    return;
  }
  const viewRect = el.playbackView.getBoundingClientRect();
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  let leftPx = viewRect.width - APPEND_BUTTON_SIZE_CSS_PX - APPEND_BUTTON_PAD_CSS_PX;
  const midY = (canvasRect.top - viewRect.top) + canvasRect.height / 2;
  el.appendButton.style.left = leftPx + 'px';
  el.appendButton.style.top = (midY - APPEND_BUTTON_SIZE_CSS_PX / 2) + 'px';
  el.appendButton.classList.add('visible');
}

function addDraggingClass(index) {
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
    ctx.fillStyle = (i === selectedIdx || i === hoverIdx) ? WAVEFORM_STYLE.hoverCardBg : WAVEFORM_STYLE.segmentCardBg;
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

    ctx.save();
    ctx.clip(cardPath);

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
  const baseKey = geomKey + '#' + state.selectedSegmentIndex + '#' + state.hoverSegmentIndex;
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

  if (state.selectedSegmentIndex >= 0) {
    positionSegmentTrash();
  }

  drawTimelineRuler(state.recordedBuffer.duration, segBounds, W, dpr, geomKey);
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
