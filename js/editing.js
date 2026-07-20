import { state, SEGMENT_GAP_CSS_PX } from './state.js';
import { el } from './dom.js';
import { formatTime } from './utils.js';
import { updateSegmentCountDisplay, setTransportDisabled, showToast, updateEmptyState } from './ui.js';
import { hideSegmentTrash, clearSegmentHover, drawPlaybackWaveform, findSegmentAtSample, animateSegmentDelete, animateSegmentRestore, captureSegmentBitmap, removeDraggingClass, visualRatioToAudioRatioWithState } from './waveform.js';
import { findSingleSegmentRemoval } from './waveform-math.js';
import { pausePlayback, seekToRatio } from './playback.js';
import { pushHistory, popUndo, popRedo, resetHistory } from './history.js';

export function jumpToSegmentStart() {
  if (!state.recordedBuffer) return;
  const sr = state.originalBuffer.sampleRate;
  const editedSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(editedSample);
  if (!target) return;
  let acc = 0;
  for (let i = 0; i < target.index; i++) acc += state.segments[i].end - state.segments[i].start;
  if (target.offsetInSeg === 0 && target.index > 0) {
    acc = 0;
    for (let i = 0; i < target.index - 1; i++) acc += state.segments[i].end - state.segments[i].start;
  }
  state.playbackOffset = acc / sr;
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
}

export function jumpToSegmentEnd() {
  if (!state.recordedBuffer) return;
  const sr = state.originalBuffer.sampleRate;
  const editedSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(editedSample);
  if (!target) return;
  if (target.index === state.segments.length - 1) {
    state.playbackOffset = state.recordedBuffer.duration;
    el.timeCurrent.textContent = formatTime(state.playbackOffset);
    drawPlaybackWaveform(1);
    return;
  }
  let acc = 0;
  for (let i = 0; i <= target.index; i++) acc += state.segments[i].end - state.segments[i].start;
  state.playbackOffset = acc / sr;
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
}

// Shared tail for both mic capture (stopRecording) and file upload
// (loadUploadedFile): both produce a full-length AudioBuffer that becomes the
// new original/edited recording, and land in the same playback-ready state.
export function loadBufferAsRecording(buffer, toastMessage) {
  state.originalBuffer = buffer;
  state.recordedBuffer = buffer;
  state.segments = [{ start: 0, end: buffer.length }];
  resetHistory();

  el.timeCurrent.textContent = '00:00.000';
  el.timeTotal.textContent = formatTime(buffer.duration);

  state.cachedPeaks = null;
  state.cachedPath = null;
  state.playbackOffset = 0;
  state.selectedSegmentIndex = -1;
  state.hoverSegmentIndex = -1;
  hideSegmentTrash();
  updateSegmentCountDisplay();
  setTransportDisabled(false);
  requestAnimationFrame(() => drawPlaybackWaveform(0));

  updateEmptyState();
  showToast(toastMessage);
}

export function rebuildPlaybackBuffer() {
  if (!state.originalBuffer || !state.audioContext) return;

  const numCh = state.originalBuffer.numberOfChannels;
  let totalLen = 0;
  for (const s of state.segments) totalLen += (s.end - s.start);

  if (totalLen === 0) {
    state.recordedBuffer = null;
    state.cachedPeaks = null;
    state.cachedPath = null;
    return;
  }

  const buf = state.audioContext.createBuffer(numCh, totalLen, state.originalBuffer.sampleRate);
  for (let c = 0; c < numCh; c++) {
    const src = state.originalBuffer.getChannelData(c);
    const dst = buf.getChannelData(c);
    let off = 0;
    for (const s of state.segments) {
      dst.set(src.subarray(s.start, s.end), off);
      off += (s.end - s.start);
    }
  }

  state.recordedBuffer = buf;
  state.cachedPeaks = null;
  state.cachedPath = null;
}

export function splitAtPlayhead() {
  if (!state.recordedBuffer || !state.originalBuffer) return;
  if (state.isPlaying) pausePlayback();

  const sr = state.originalBuffer.sampleRate;
  const editedSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(editedSample);
  if (!target) return;

  const { index, offsetInSeg, seg } = target;
  if (offsetInSeg <= 0 || offsetInSeg >= (seg.end - seg.start)) {
    showToast('Move the line within a segment to split');
    return;
  }

  const splitPoint = seg.start + offsetInSeg;
  pushHistory();
  state.segments.splice(index, 1,
    { start: seg.start, end: splitPoint },
    { start: splitPoint, end: seg.end }
  );

  // Shift playhead to the start of the right card so the split gap stays visible
  const canvasRect = el.waveformCanvas.getBoundingClientRect();
  if (canvasRect.width > 0 && state.recordedBuffer.duration > 0) {
    const shiftSec = ((SEGMENT_GAP_CSS_PX / 2 + 1) / canvasRect.width) * state.recordedBuffer.duration;
    state.playbackOffset = Math.min(state.recordedBuffer.duration, state.playbackOffset + shiftSec);
    el.timeCurrent.textContent = formatTime(state.playbackOffset);
  }

  hideSegmentTrash();
  clearSegmentHover();
  drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
  updateSegmentCountDisplay();
  showToast(`Split: segment ${index + 1} → ${index + 1} and ${index + 2}`);
}

export function deleteSegmentByIndex(index) {
  if (!state.recordedBuffer || !state.originalBuffer) return;
  if (state.isPlaying) pausePlayback();
  if (index < 0 || index >= state.segments.length) return;

  const sr = state.originalBuffer.sampleRate;
  const playheadSampleInEdited = Math.round(state.playbackOffset * sr);

  let accSamples = 0, deletedSegStart = 0, deletedSegLen = 0;
  for (let i = 0; i < state.segments.length; i++) {
    const segLen = state.segments[i].end - state.segments[i].start;
    if (i === index) { deletedSegStart = accSamples; deletedSegLen = segLen; break; }
    accSamples += segLen;
  }

  let newPlayheadSample;
  if (playheadSampleInEdited < deletedSegStart) {
    newPlayheadSample = playheadSampleInEdited;
  } else if (playheadSampleInEdited >= deletedSegStart + deletedSegLen) {
    newPlayheadSample = playheadSampleInEdited - deletedSegLen;
  } else {
    newPlayheadSample = deletedSegStart;
  }

  const oldSegments = state.segments.map(s => ({ start: s.start, end: s.end }));
  const oldTotalSamples = state.recordedBuffer.length;
  const oldPlayheadRatio = state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0;
  // Lift the doomed card's rendered pixels (in delete-red) off the canvas
  // while it's still part of the layout — this image is what disintegrates.
  const deletedSnap = captureSegmentBitmap(index);

  pushHistory();
  state.segments.splice(index, 1);
  rebuildPlaybackBuffer();

  if (!state.recordedBuffer) {
    hideSegmentTrash();
    clearSegmentHover();
    el.playheadScissors.classList.remove('visible');
    el.playButton.classList.remove('playing');
    el.timeCurrent.textContent = '00:00.000';
    el.timeTotal.textContent = '00:00.000';
    setTransportDisabled(true);
    updateSegmentCountDisplay();
    animateSegmentDelete(oldSegments, oldTotalSamples, index, oldPlayheadRatio, 0, deletedSnap);
    showToast('All audio deleted', true);
    return;
  }

  state.playbackOffset = Math.max(0, Math.min(newPlayheadSample / sr, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);

  hideSegmentTrash();
  clearSegmentHover();
  const newPlayheadRatio = state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0;
  animateSegmentDelete(oldSegments, oldTotalSamples, index, oldPlayheadRatio, newPlayheadRatio, deletedSnap);
  updateSegmentCountDisplay();
  showToast(`Deleted segment ${index + 1} · ${state.segments.length} remaining`);
}

export function deleteSegmentAtPlayhead() {
  if (!state.recordedBuffer || !state.originalBuffer) return;
  if (state.isPlaying) pausePlayback();
  const sr = state.originalBuffer.sampleRate;
  const editedSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(editedSample);
  if (target) deleteSegmentByIndex(target.index);
}

function applyHistorySnapshot(snapshot, render) {
  state.segments = snapshot.segments.map(s => ({ start: s.start, end: s.end }));
  rebuildPlaybackBuffer();

  hideSegmentTrash();
  clearSegmentHover();
  el.playheadScissors.classList.remove('visible');

  if (!state.recordedBuffer) {
    el.playButton.classList.remove('playing');
    state.playbackOffset = 0;
    el.timeCurrent.textContent = '00:00.000';
    el.timeTotal.textContent = '00:00.000';
    setTransportDisabled(true);
    updateSegmentCountDisplay();
    render(0);
    // The delete animation reveals the empty state in its onComplete; for
    // a plain redraw (non-animated transition), do it now.
    if (render === drawPlaybackWaveform) updateEmptyState();
    return;
  }

  setTransportDisabled(false);
  state.playbackOffset = Math.max(0, Math.min(snapshot.playbackOffset, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);
  updateSegmentCountDisplay();
  updateEmptyState();
  render(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
}

// If the transition being undone/redone is a clean single-segment delete,
// replay the matching delete/restore animation instead of an instant redraw.
function pickHistoryRenderer(beforeSegments, beforeTotalSamples, beforeRatio, targetSegments, isRedo) {
  if (isRedo && targetSegments.length === beforeSegments.length - 1) {
    const deletedIndex = findSingleSegmentRemoval(beforeSegments, targetSegments);
    if (deletedIndex >= 0) {
      // Capture now, while the doomed segment is still rendered on screen —
      // by the time the renderer runs, the state has already been spliced.
      const deletedSnap = captureSegmentBitmap(deletedIndex);
      return (newRatio) => animateSegmentDelete(beforeSegments, beforeTotalSamples, deletedIndex, beforeRatio, newRatio, deletedSnap);
    }
  } else if (!isRedo && targetSegments.length === beforeSegments.length + 1) {
    const restoredIndex = findSingleSegmentRemoval(targetSegments, beforeSegments);
    if (restoredIndex >= 0) {
      return (newRatio) => animateSegmentRestore(beforeSegments, beforeTotalSamples, restoredIndex, beforeRatio, newRatio);
    }
  }
  return null;
}

function captureBeforeState() {
  return {
    segments: state.segments.map(s => ({ start: s.start, end: s.end })),
    totalSamples: state.recordedBuffer ? state.recordedBuffer.length : 0,
    ratio: state.recordedBuffer && state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0
  };
}

export function undo() {
  if (state.isPlaying) pausePlayback();
  const before = captureBeforeState();

  const snapshot = popUndo();
  if (!snapshot) return;

  const render = pickHistoryRenderer(before.segments, before.totalSamples, before.ratio, snapshot.segments, false) || drawPlaybackWaveform;
  applyHistorySnapshot(snapshot, render);
  showToast('Undo');
}

export function redo() {
  if (state.isPlaying) pausePlayback();
  const before = captureBeforeState();

  const snapshot = popRedo();
  if (!snapshot) return;

  const render = pickHistoryRenderer(before.segments, before.totalSamples, before.ratio, snapshot.segments, true) || drawPlaybackWaveform;
  applyHistorySnapshot(snapshot, render);
  showToast('Redo');
}

async function adaptBuffer(buffer, targetSampleRate, targetChannels) {
  if (buffer.sampleRate === targetSampleRate && buffer.numberOfChannels === targetChannels) {
    return buffer;
  }
  const duration = buffer.duration;
  const totalLen = Math.max(1, Math.ceil(duration * targetSampleRate));
  const ctx = new OfflineAudioContext(targetChannels, totalLen, targetSampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

export async function appendBufferToRecording(buffer, toastMessage) {
  if (state.isPlaying) pausePlayback();
  if (!state.originalBuffer) return;
  const adapted = await adaptBuffer(buffer, state.originalBuffer.sampleRate, state.originalBuffer.numberOfChannels);
  const oldLen = state.originalBuffer.length;
  const newLen = adapted.length;
  const orig = state.originalBuffer;
  const nch = orig.numberOfChannels;
  const combined = state.audioContext.createBuffer(nch, oldLen + newLen, orig.sampleRate);
  for (let c = 0; c < nch; c++) {
    const dst = combined.getChannelData(c);
    dst.set(orig.getChannelData(c), 0);
    dst.set(adapted.getChannelData(c), oldLen);
  }
  pushHistory();
  state.originalBuffer = combined;
  state.segments.push({ start: oldLen, end: oldLen + newLen });
  rebuildPlaybackBuffer();
  if (state.recordedBuffer) {
    el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);
  }
  updateSegmentCountDisplay();
  updateEmptyState();
  const ratio = state.recordedBuffer && state.recordedBuffer.duration > 0
    ? state.playbackOffset / state.recordedBuffer.duration
    : 0;
  drawPlaybackWaveform(ratio);
  showToast(toastMessage);
}

export function applySplitHandleDrag(clientX) {
  const snap = state._dragSnapshot;
  if (!snap) return;
  const rect = el.waveformContainer.getBoundingClientRect();
  const ratio = (clientX - rect.left) / rect.width;
  let newAcc = ratio * snap.totalSamples;
  newAcc = Math.max(snap.minAcc, Math.min(snap.maxAcc, newAcc));
  const newSegIEnd = snap.segIStart + (newAcc - snap.accBeforeSegI);
  state.segments[snap.handleIndex].end = newSegIEnd;
  state.segments[snap.handleIndex + 1].start = newSegIEnd;
  const playheadRatio = state.recordedBuffer.duration > 0
    ? state.playbackOffset / state.recordedBuffer.duration
    : 0;
  drawPlaybackWaveform(playheadRatio);
}

export function finishSplitHandleDrag() {
  const idx = state.draggingHandleIndex;
  removeDraggingClass(idx);
  state.draggingHandleIndex = -1;
  state._dragSnapshot = null;
  rebuildPlaybackBuffer();
  updateSegmentCountDisplay();
  const ratio = state.recordedBuffer.duration > 0
    ? state.playbackOffset / state.recordedBuffer.duration
    : 0;
  drawPlaybackWaveform(ratio);
  showToast('Split line repositioned');
}

export function seekFromClientX(clientX) {
  if (!state.recordedBuffer) return;
  const rect = el.waveformContainer.getBoundingClientRect();
  const visualRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ratio = visualRatioToAudioRatioWithState(visualRatio, rect.width, SEGMENT_GAP_CSS_PX);
  seekToRatio(ratio);
}
