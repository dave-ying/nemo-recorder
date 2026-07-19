import { state, SEGMENT_GAP_CSS_PX } from './state.js';
import { el } from './dom.js';
import { formatTime } from './utils.js';
import { updateSegmentCountDisplay, setTransportDisabled, showToast } from './ui.js';
import { hideSegmentTrash, clearSegmentHover, drawPlaybackWaveform, findSegmentAtSample } from './waveform.js';
import { pausePlayback } from './playback.js';
import { pushHistory, popUndo, popRedo } from './history.js';

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
  if (state.segments.length <= 1) {
    showToast('Cannot delete the only remaining segment', true);
    return;
  }
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

  pushHistory();
  state.segments.splice(index, 1);
  rebuildPlaybackBuffer();

  if (!state.recordedBuffer) {
    showToast('All audio deleted', true);
    hideSegmentTrash();
    clearSegmentHover();
    el.playheadScissors.classList.remove('visible');
    state.hoverRatio = -1;

    el.playButton.classList.remove('playing');
    el.timeCurrent.textContent = '00:00.000';
    el.timeTotal.textContent = '00:00.000';
    setTransportDisabled(true);
    return;
  }

  state.playbackOffset = Math.max(0, Math.min(newPlayheadSample / sr, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);

  hideSegmentTrash();
  clearSegmentHover();
  state.hoverRatio = -1;
  drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
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

function applyHistorySnapshot(snapshot) {
  state.segments = snapshot.segments.map(s => ({ start: s.start, end: s.end }));
  rebuildPlaybackBuffer();

  hideSegmentTrash();
  clearSegmentHover();
  el.playheadScissors.classList.remove('visible');
  state.hoverRatio = -1;

  if (!state.recordedBuffer) {
    el.playButton.classList.remove('playing');
    state.playbackOffset = 0;
    el.timeCurrent.textContent = '00:00.000';
    el.timeTotal.textContent = '00:00.000';
    setTransportDisabled(true);
    updateSegmentCountDisplay();
    return;
  }

  setTransportDisabled(false);
  state.playbackOffset = Math.max(0, Math.min(snapshot.playbackOffset, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);
  updateSegmentCountDisplay();
  drawPlaybackWaveform(state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
}

export function undo() {
  if (state.isPlaying) pausePlayback();
  const snapshot = popUndo();
  if (!snapshot) return;
  applyHistorySnapshot(snapshot);
  showToast('Undo');
}

export function redo() {
  if (state.isPlaying) pausePlayback();
  const snapshot = popRedo();
  if (!snapshot) return;
  applyHistorySnapshot(snapshot);
  showToast('Redo');
}
