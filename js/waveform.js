import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, MIN_SEGMENT_SAMPLES, SEGMENT_GAP_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SELECTION_PULSE_PERIOD_SEC, DELETE_PULSE_PERIOD_SEC } from './state.js';
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
  const totalSamples = data.length;
  if (totalSamples === 0) return new Float32Array(width * 2);

  const samplesPerPixel = totalSamples / width;
  const peaks = new Float32Array(width * 2);
  const step = Math.max(1, (samplesPerPixel / PEAK_STEP_DIVISOR) | 0);

  for (let x = 0; x < width; x++) {
    const start = (x * samplesPerPixel) | 0;
    const end = Math.min(totalSamples, ((x + 1) * samplesPerPixel) | 0);
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

function buildSegmentCardPaths(segBounds, H, dpr) {
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX * dpr;
  const cardH = H - 2 * insetY;
  const baseR = SEGMENT_CORNER_RADIUS_CSS_PX * dpr;
  const cardPaths = [];
  for (const sb of segBounds) {
    const x = sb.drawStart;
    const w = sb.drawEnd - sb.drawStart;
    if (w <= 0) {
      cardPaths.push(null);
      continue;
    }
    const r = Math.min(baseR, w / 2, cardH / 2);
    const cardPath = new Path2D();
    roundedRectPath(cardPath, x, insetY, w, cardH, r);
    cardPaths.push(cardPath);
  }
  return cardPaths;
}

function drawSegmentCards(ctx, path, segBounds, cardPaths, playheadX, H, dpr) {
  const insetY = SEGMENT_VERTICAL_INSET_CSS_PX * dpr;
  const shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
  const shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;
  const midY = H / 2;

  const selectedIdx = state.hoveredSegmentIndex;
  const hoverIdx = state.hoverSegmentIndex;
  const hasSelection = selectedIdx >= 0 && selectedIdx < segBounds.length;
  const isMarkedForDelete = hasSelection && state.isHoveringTrash;
  const pulsePeriod = isMarkedForDelete ? DELETE_PULSE_PERIOD_SEC : SELECTION_PULSE_PERIOD_SEC;
  const pulse = hasSelection
    ? (Math.sin((performance.now() / 1000) * (Math.PI * 2 / pulsePeriod)) + 1) / 2
    : 0;

  // Pass 1: card backgrounds with drop shadows (drawn first so shadows don't darken neighbors' content)
  for (let i = 0; i < cardPaths.length; i++) {
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    ctx.save();
    ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowOffsetY;
    ctx.fillStyle = (i === selectedIdx) ? WAVEFORM_STYLE.hoverCardBg
      : (i === hoverIdx) ? WAVEFORM_STYLE.hoverCardBg
      : WAVEFORM_STYLE.segmentCardBg;
    ctx.fill(cardPath);
    ctx.restore();
  }

  // Pass 2: clipped waveform content + edge stroke per card
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const cardPath = cardPaths[i];
    if (!cardPath) continue;
    const x = sb.drawStart;
    const w = sb.drawEnd - sb.drawStart;
    const isSelected = i === selectedIdx;

    ctx.save();
    ctx.clip(cardPath);

    // Midline (clipped to card so it breaks at gaps)
    ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, midY);
    ctx.lineTo(x + w, midY);
    ctx.stroke();

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

function drawTimelineRuler(duration, segBounds, W, dpr) {
  const rect = el.timelineRulerCanvas.getBoundingClientRect();
  const H = Math.max(1, Math.floor(rect.height * dpr));
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
  const cardPaths = buildSegmentCardPaths(segBounds, H, dpr);

  drawSegmentCards(waveCtx, path, segBounds, cardPaths, playheadX, H, dpr);

  if (state.draggingHandleIndex < 0) {
    ensureDivisionHandles();
  }
  positionDivisionHandles();

  if (state.hoveredSegmentIndex >= 0 && state.segments.length >= 2) {
    positionSegmentTrash();
  }

  drawTimelineRuler(state.recordedBuffer.duration, segBounds, W, dpr);
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
