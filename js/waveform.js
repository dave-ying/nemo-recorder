import { state, WAVEFORM_STYLE, WAVEFORM_SCALE, MIN_SEGMENT_SAMPLES } from './state.js';
import { el, waveCtx } from './dom.js';
import { formatTime } from './utils.js';
import { pausePlayback } from './playback.js';

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

function findSegmentIndexAtRatio(ratio) {
  if (!state.recordedBuffer) return -1;
  const targetSample = Math.round(ratio * state.recordedBuffer.length);
  const result = findSegmentAtSample(targetSample);
  return result ? result.index : -1;
}

function getSegmentCenterRatio(segIndex) {
  if (!state.recordedBuffer || segIndex < 0 || segIndex >= state.segments.length) return 0;
  const totalSamples = state.recordedBuffer.length;
  let acc = 0;
  for (let i = 0; i < state.segments.length; i++) {
    const segLen = state.segments[i].end - state.segments[i].start;
    if (i === segIndex) return (acc + segLen / 2) / totalSamples;
    acc += segLen;
  }
  return 0;
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

export function updateSegmentTrashPosition() {
  if (state.hoverRatio < 0 || !state.recordedBuffer || state.segments.length <= 1) {
    el.segmentTrash.classList.remove('visible');
    state.hoveredSegmentIndex = -1;
    return;
  }

  const segIndex = findSegmentIndexAtRatio(state.hoverRatio);
  if (segIndex < 0) {
    el.segmentTrash.classList.remove('visible');
    state.hoveredSegmentIndex = -1;
    return;
  }

  const centerRatio = getSegmentCenterRatio(segIndex);
  const containerRect = el.waveformContainer.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();

  let leftPx = (containerRect.left - viewRect.left) + centerRatio * containerRect.width;
  const topPx = (containerRect.bottom - viewRect.top) + TRASH_TOP_OFFSET;

  const halfBtn = TRASH_BUTTON_HALF;
  leftPx = Math.max(halfBtn, Math.min(viewRect.width - halfBtn, leftPx));

  el.segmentTrash.style.left = leftPx + 'px';
  el.segmentTrash.style.top = topPx + 'px';
  el.segmentTrash.title = `Delete segment ${segIndex + 1} of ${state.segments.length}`;
  el.segmentTrash.classList.add('visible');
  state.hoveredSegmentIndex = segIndex;
}

export function updatePlayheadScissorsPosition(ratio) {
  if (state.isPlaying || !state.recordedBuffer || ratio < 0 || ratio > 1 || el.playbackView.hidden || el.segmentTrash.classList.contains('visible')) {
    el.playheadScissors.classList.remove('visible');
    return;
  }

  const EDGE_THRESHOLD = 0.01;
  if (ratio <= EDGE_THRESHOLD || ratio >= 1 - EDGE_THRESHOLD) {
    el.playheadScissors.classList.remove('visible');
    return;
  }

  const containerRect = el.waveformContainer.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  const halfBtn = (el.playheadScissors.offsetHeight || SCISSORS_FALLBACK_HEIGHT) / 2;

  let leftPx = (containerRect.left - viewRect.left) + ratio * containerRect.width;
  const topPx = (containerRect.bottom - viewRect.top) + TRASH_TOP_OFFSET;

  leftPx = Math.max(halfBtn, Math.min(viewRect.width - halfBtn, leftPx));

  el.playheadScissors.style.left = leftPx + 'px';
  el.playheadScissors.style.top = topPx + 'px';
  el.playheadScissors.classList.add('visible');
}

// ===== Trash hide helpers =====

export function hideSegmentTrash() {
  clearTimeout(state.trashHideTimer);
  el.segmentTrash.classList.remove('visible');
  state.hoveredSegmentIndex = -1;
  state.isHoveringTrash = false;
}

export function scheduleHideSegmentTrash(delay = TRASH_HIDE_DELAY_MS) {
  clearTimeout(state.trashHideTimer);
  state.trashHideTimer = setTimeout(() => {
    hideSegmentTrash();
    if (state.hoverRatio !== -1) {
      state.hoverRatio = -1;
      if (state.recordedBuffer) {
        drawPlaybackWaveform(state.playbackOffset / state.recordedBuffer.duration);
      }
    }
  }, delay);
}

const PEAK_STEP_DIVISOR = 100;
const TRASH_TOP_OFFSET = 6;
const TRASH_BUTTON_HALF = 15;
const SCISSORS_FALLBACK_HEIGHT = 30;
const TRASH_HIDE_DELAY_MS = 200;

const DIVISION_HANDLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 9c.852 0 1.297 .986 .783 1.623l-.076 .084l-6 6a1 1 0 0 1 -1.32 .083l-.094 -.083l-6 -6l-.083 -.094l-.054 -.077l-.054 -.096l-.017 -.036l-.027 -.067l-.032 -.108l-.01 -.053l-.01 -.06l-.004 -.057v-.118l.005 -.058l.009 -.06l.01 -.052l.032 -.108l.027 -.067l.07 -.132l.065 -.09l.073 -.081l.094 -.083l.077 -.054l.096 -.054l.036 -.017l.067 -.027l.108 -.032l.053 -.01l.06 -.01l.057 -.004l12.059 -.002z"/></svg>`;

let topHandles = [];
let bottomHandles = [];

function createHandleElement(isBottom) {
  const h = document.createElement('button');
  h.className = 'division-handle';
  h.innerHTML = DIVISION_HANDLE_SVG;
  h.tabIndex = -1;
  h.setAttribute('aria-label', 'Drag to reposition split');

  if (isBottom) {
    const svg = h.querySelector('svg');
    svg.style.transform = 'rotate(180deg)';
  }

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

  while (topHandles.length > needed) {
    topHandles.pop().remove();
    bottomHandles.pop().remove();
  }

  while (topHandles.length < needed) {
    const topH = createHandleElement(false);
    const bottomH = createHandleElement(true);
    topH.dataset.index = String(topHandles.length);
    bottomH.dataset.index = String(topHandles.length);
    el.playbackView.appendChild(topH);
    el.playbackView.appendChild(bottomH);
    topHandles.push(topH);
    bottomHandles.push(bottomH);
  }

  for (let i = 0; i < topHandles.length; i++) {
    topHandles[i].dataset.index = String(i);
    bottomHandles[i].dataset.index = String(i);
  }
}

const HANDLE_HALF_W = 12;
const HANDLE_HEIGHT = 20;
const HANDLE_OVERLAP = 4;

export function positionDivisionHandles() {
  if (!state.recordedBuffer || state.segments.length <= 1) {
    for (const h of topHandles) h.style.display = 'none';
    for (const h of bottomHandles) h.style.display = 'none';
    return;
  }

  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.floor(canvasRect.width * dpr);
  const topPx = (canvasRect.top - viewRect.top) - HANDLE_HEIGHT + HANDLE_OVERLAP;
  const bottomPx = (canvasRect.bottom - viewRect.top) - HANDLE_OVERLAP;
  const totalSamples = state.recordedBuffer.length;
  let acc = 0;

  for (let i = 0; i < topHandles.length; i++) {
    acc += state.segments[i].end - state.segments[i].start;
    const ratio = acc / totalSamples;
    const lineXCssPx = Math.floor(ratio * W) / dpr;
    let leftPx = (canvasRect.left - viewRect.left) + lineXCssPx;
    leftPx = Math.max(HANDLE_HALF_W, Math.min(viewRect.width - HANDLE_HALF_W, leftPx));

    topHandles[i].style.display = '';
    topHandles[i].style.left = leftPx + 'px';
    topHandles[i].style.top = topPx + 'px';

    bottomHandles[i].style.display = '';
    bottomHandles[i].style.left = leftPx + 'px';
    bottomHandles[i].style.top = bottomPx + 'px';
  }
}

export function addDraggingClass(index) {
  if (index >= 0 && index < topHandles.length) {
    topHandles[index].classList.add('dragging');
    bottomHandles[index].classList.add('dragging');
  }
}

export function removeDraggingClass(index) {
  if (index >= 0 && index < topHandles.length) {
    topHandles[index].classList.remove('dragging');
    bottomHandles[index].classList.remove('dragging');
  }
}

// ===== Playback waveform rendering =====

function drawMidline(ctx, W, midY) {
  ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(W, midY);
  ctx.stroke();
}

function drawPlayedFill(ctx, path, playheadX, H) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, playheadX, H);
  ctx.clip();
  ctx.fillStyle = WAVEFORM_STYLE.playedColor;
  ctx.fill(path);
  ctx.restore();
}

function drawUnplayedFill(ctx, path, playheadX, W, H) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(playheadX, 0, W - playheadX, H);
  ctx.clip();
  ctx.fillStyle = WAVEFORM_STYLE.unplayedColor;
  ctx.fill(path);
  ctx.restore();
}

function computeSegmentBounds(W, totalSamples) {
  const segBounds = [];
  let accSamples = 0;
  for (const seg of state.segments) {
    const segLen = seg.end - seg.start;
    const startX = Math.floor((accSamples / totalSamples) * W);
    accSamples += segLen;
    const endX = Math.floor((accSamples / totalSamples) * W);
    segBounds.push({ start: startX, end: endX });
  }
  return segBounds;
}

function drawDivisionMarkers(ctx, segBounds, H, dpr, highlightIndex = -1) {
  if (segBounds.length <= 1) return;

  ctx.strokeStyle = WAVEFORM_STYLE.divisionColor;
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  for (let i = 0; i < segBounds.length - 1; i++) {
    if (i === highlightIndex) continue;
    const x = segBounds[i].end;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  if (highlightIndex >= 0 && highlightIndex < segBounds.length - 1) {
    const x = segBounds[highlightIndex].end;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = WAVEFORM_STYLE.divisionColor;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawTrashOverlay(ctx, segBounds, H, dpr) {
  if (!state.isHoveringTrash || state.hoveredSegmentIndex === -1 || state.hoveredSegmentIndex >= segBounds.length) return;
  const sb = segBounds[state.hoveredSegmentIndex];
  ctx.fillStyle = WAVEFORM_STYLE.trashOverlayColor;
  ctx.fillRect(sb.start, 0, sb.end - sb.start, H);

  ctx.strokeStyle = WAVEFORM_STYLE.trashBorderColor;
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(sb.start + 1 * dpr, 1 * dpr, sb.end - sb.start - 2 * dpr, H - 2 * dpr);
}

function drawHoverLine(ctx, hoverX, H, dpr) {
  ctx.strokeStyle = WAVEFORM_STYLE.hoverLineColor;
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(hoverX, 0);
  ctx.lineTo(hoverX, H);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawTimeTicks(ctx, W, H, duration, dpr) {
  ctx.fillStyle = WAVEFORM_STYLE.tickColor;
  ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
  for (let i = 1; i < 5; i++) {
    const t = (i / 5) * duration;
    const x = (i / 5) * W;
    const label = formatTime(t);
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, x - tw / 2, H - 8 * dpr);
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
    return;
  }

  updatePlayheadScissorsPosition(playheadRatio);

  if (!state.cachedPeaks || state.cachedPeaksWidth !== W) {
    state.cachedPeaks = computePeaks(W);
    state.cachedPeaksWidth = W;
    state.cachedPath = new Path2D();
    buildWaveformPath(state.cachedPath, state.cachedPeaks, 0, W, H / 2, WAVEFORM_SCALE);
  }
  const path = state.cachedPath;

  const midY = H / 2;
  const playheadX = Math.floor(playheadRatio * W);
  const totalSamples = state.recordedBuffer.length;
  const segBounds = computeSegmentBounds(W, totalSamples);

  drawMidline(waveCtx, W, midY);
  drawUnplayedFill(waveCtx, path, playheadX, W, H);
  drawPlayedFill(waveCtx, path, playheadX, H);
  drawDivisionMarkers(waveCtx, segBounds, H, dpr, state.draggingHandleIndex);
  drawTrashOverlay(waveCtx, segBounds, H, dpr);

  if (state.draggingHandleIndex < 0 && !state.isHoveringTrash && state.hoverRatio >= 0 && state.hoverRatio <= 1) {
    drawHoverLine(waveCtx, Math.floor(state.hoverRatio * W), H, dpr);
  }

  waveCtx.strokeStyle = WAVEFORM_STYLE.playheadColor;
  waveCtx.lineWidth = 2 * dpr;
  waveCtx.shadowColor = WAVEFORM_STYLE.playheadGlow;
  waveCtx.shadowBlur = 8;
  waveCtx.beginPath();
  waveCtx.moveTo(playheadX, 0);
  waveCtx.lineTo(playheadX, H);
  waveCtx.stroke();
  waveCtx.shadowBlur = 0;

  if (state.draggingHandleIndex < 0) {
    ensureDivisionHandles();
  }
  positionDivisionHandles();

  drawTimeTicks(waveCtx, W, H, state.recordedBuffer.duration, dpr);
}
