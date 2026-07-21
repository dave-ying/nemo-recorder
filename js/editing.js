import { state, SEGMENT_GAP_CSS_PX, SEGMENT_DRAG_SETTLE_MS, WAVEFORM_SCALE } from './state.js';
import { el } from './dom.js';
import { formatTime } from './utils.js';
import { updateSegmentCountDisplay, setTransportDisabled, showToast, updateEmptyState } from './ui.js';
import { hideSegmentTrash, clearSegmentHover, drawPlaybackWaveform, findSegmentAtSample, animateSegmentDelete, animateSegmentRestore, captureSegmentBitmap, visualRatioToAudioRatioWithState, showSegmentTrash, ensureDragAnimRunning } from './waveform.js';
import { findSingleSegmentRemoval, computeDropInsertIndexPure, computeReorderTarget, computeSegmentBoundsPure, computeReorderArrangement, computeArrangementBounds, computePeaksForRange, buildWaveformPath } from './waveform-math.js';
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
  state.segments = [{ start: 0, end: buffer.length, origin: 'capture' }];
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
    { start: seg.start, end: splitPoint, origin: 'split' },
    { start: splitPoint, end: seg.end, origin: 'split' }
  );

  // Snap the playhead to the exact split point — the start of the right
  // segment. audioRatioToVisualRatio maps boundary positions to the right
  // card's left edge, so the playhead lands exactly on the next segment.
  state.playbackOffset = editedSample / sr;
  el.timeCurrent.textContent = formatTime(state.playbackOffset);

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

  const oldSegments = state.segments.map(s => ({ start: s.start, end: s.end, origin: s.origin }));
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
  state.segments = snapshot.segments.map(s => ({ start: s.start, end: s.end, origin: s.origin }));
  rebuildPlaybackBuffer();

  hideSegmentTrash();
  clearSegmentHover();

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
    segments: state.segments.map(s => ({ start: s.start, end: s.end, origin: s.origin })),
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
  state.segments.push({ start: oldLen, end: oldLen + newLen, origin: 'append' });
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

// ===== Segment reorder (drag-and-drop) =====
//
// Reorder uses a deferred-click pattern: pointerdown on a segment sets
// `state.pendingSegmentDrag` (see waveform.js). pointermove past
// SEGMENT_DRAG_THRESHOLD_CSS_PX promotes it to an active drag via
// beginSegmentReorderDrag; pointerup before that threshold calls
// cancelSegmentReorderDrag, which falls back to the existing click-to-trash
// behavior. Active drags call applySegmentReorderDrag on each move and
// finishSegmentReorderDrag on pointerup.
//
// While active, a rAF loop in waveform.js (ensureDragAnimRunning) renders the
// live arrangement: non-dragged segments ease toward their would-be positions,
// the dragged segment floats with the pointer (lifted, deep shadow, dashed
// outline), and a faint drop-zone outline marks the slot. On release the loop
// enters a settle phase that eases the floating card into its final slot
// before handing rendering back to drawPlaybackWaveform.

export function beginSegmentReorderDrag(clientX, clientY) {
  const pending = state.pendingSegmentDrag;
  if (!pending || !state.recordedBuffer || !state.originalBuffer) return;
  if (state._segmentDragSnapshot) return; // re-entrant guard (e.g. during settle)
  if (state.isPlaying) pausePlayback();

  const sr = state.originalBuffer.sampleRate;
  const playheadSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(playheadSample);

  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformContainer.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));
  const gapPxDev = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const totalSamples = state.recordedBuffer.length;

  // Initial card bounds in device px — animBounds and targetBounds both start
  // here so the first frame after pointerdown is a no-op (no motion yet).
  const initialBounds = computeSegmentBoundsPure(W, state.segments, totalSamples, gapPxDev);
  const animBounds = initialBounds.map(sb => ({ drawStart: sb.drawStart, drawEnd: sb.drawEnd }));
  const targetBounds = initialBounds.map(sb => ({ drawStart: sb.drawStart, drawEnd: sb.drawEnd }));

  // Per-original-segment local waveform paths, built once at the segment's
  // initial card width. Reused every frame via scaleX = animWidth / pathWidth.
  const channelData = state.originalBuffer.getChannelData(0);
  const segPaths = new Array(state.segments.length);
  const segPathWidths = new Array(state.segments.length);
  for (let i = 0; i < state.segments.length; i++) {
    const sb = initialBounds[i];
    const finalWidth = Math.max(1, Math.round(sb.drawEnd - sb.drawStart));
    const seg = state.segments[i];
    const peaks = computePeaksForRange(channelData, seg.start, seg.end, finalWidth);
    const localPath = new Path2D();
    buildWaveformPath(localPath, peaks, 0, finalWidth, H / 2, WAVEFORM_SCALE);
    segPaths[i] = localPath;
    segPathWidths[i] = finalWidth;
  }

  // Capture the pointer's offset within the dragged card so the floating card
  // stays pinned to the same grab point as the user drags.
  const pointerCssX = clientX - rect.left;
  const pointerX = pointerCssX * dpr;
  const srcCardDrawStart = initialBounds[pending.index].drawStart;
  const pointerOffsetInCard = Math.max(0, Math.min(segPathWidths[pending.index], pointerX - srcCardDrawStart));

  // Snapshot the original segments' {start, end} so the live arrangement
  // (which is in terms of original indices) can be resolved even after
  // state.segments is reordered at settle start.
  const originalSegments = state.segments.map(s => ({ start: s.start, end: s.end }));

  // Identity arrangement at drag-begin; updated each pointermove.
  const arrangement = [];
  for (let i = 0; i < state.segments.length; i++) arrangement.push(i);

  state.draggingSegmentIndex = pending.index;
  state.pendingSegmentDrag = null;
  state._segmentDragSnapshot = {
    srcIndex: pending.index,
    currentClientX: clientX,
    dropInsertIndex: pending.index,
    playheadSegStart: target ? target.seg.start : -1,
    playheadSegEnd: target ? target.seg.end : -1,
    playheadOffsetInSeg: target ? target.offsetInSeg : 0,
    playheadSegOriginalIndex: target ? target.index : -1,
    pointerX,
    pointerOffsetInCard,
    animBounds,
    targetBounds,
    segPaths,
    segPathWidths,
    originalSegments,
    arrangement,
    liftPx: 0,
    settle: null
  };

  hideSegmentTrash();
  ensureDragAnimRunning();
}

export function applySegmentReorderDrag(clientX) {
  const snap = state._segmentDragSnapshot;
  if (!snap || !state.recordedBuffer) return;
  snap.currentClientX = clientX;
  const rect = el.waveformContainer.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const xCss = clientX - rect.left;
  // computeDropInsertIndexPure compares against card midpoints in the same
  // unit as the segBounds it receives; use CSS-px bounds here so the math
  // matches the pointer's CSS-px position.
  const segBoundsCss = computeSegmentBoundsPure(rect.width, snap.originalSegments, state.recordedBuffer.length, SEGMENT_GAP_CSS_PX);
  snap.dropInsertIndex = computeDropInsertIndexPure(segBoundsCss, xCss);

  // Recompute the live arrangement + per-original-index target bounds (in
  // device px). The rAF loop eases animBounds toward these each frame.
  snap.arrangement = computeReorderArrangement(snap.originalSegments.length, snap.srcIndex, snap.dropInsertIndex);
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const gapPxDev = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  snap.targetBounds = computeArrangementBounds(W, snap.originalSegments, state.recordedBuffer.length, gapPxDev, snap.arrangement);
  snap.pointerX = xCss * dpr;

  ensureDragAnimRunning();
}

export function finishSegmentReorderDrag() {
  const snap = state._segmentDragSnapshot;
  if (!snap) return;
  if (snap.settle) return; // already settling — ignore re-entrant pointerup

  const src = snap.srcIndex;
  const target = computeReorderTarget(src, snap.dropInsertIndex);

  if (target < 0 || !state.recordedBuffer) {
    // No-op drop: animate the floating card back to its original slot.
    // state.segments is unchanged, so the slot is just snap.targetBounds[src]
    // (which equals the original position under the identity arrangement).
    startSettle(snap, snap.targetBounds[src].drawStart, snap.targetBounds[src].drawEnd, state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0);
    return;
  }

  pushHistory();
  const [moved] = state.segments.splice(src, 1);
  state.segments.splice(target, 0, moved);
  rebuildPlaybackBuffer();

  // Preserve the playhead on the same audio content: find the (now-relocated)
  // segment by its {start, end} identity and reposition the playhead to the
  // same offset within it.
  if (state.recordedBuffer && snap.playheadSegStart >= 0) {
    const sr = state.originalBuffer.sampleRate;
    let acc = 0;
    for (let i = 0; i < state.segments.length; i++) {
      const s = state.segments[i];
      if (s.start === snap.playheadSegStart && s.end === snap.playheadSegEnd) {
        state.playbackOffset = Math.max(0, Math.min((acc + snap.playheadOffsetInSeg) / sr, state.recordedBuffer.duration));
        break;
      }
      acc += s.end - s.start;
    }
  }

  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);

  // Compute the dragged segment's final slot in the new state.segments order.
  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformContainer.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const gapPxDev = Math.round(SEGMENT_GAP_CSS_PX * dpr);
  const newBounds = computeSegmentBoundsPure(W, state.segments, state.recordedBuffer.length, gapPxDev);
  // The dragged segment's new index in state.segments is `target` (it was
  // spliced in there). Its final slot is newBounds[target].
  const finalSlot = newBounds[target];
  const finalRatio = state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0;

  startSettle(snap, finalSlot.drawStart, finalSlot.drawEnd, finalRatio);
  updateSegmentCountDisplay();
  showToast(`Moved segment ${src + 1} to position ${target + 1}`);
}

/**
 * Begin the post-release settle animation: ease the floating dragged card from
 * its current on-screen position into its final slot, decaying the lift to
 * zero. The rAF loop handles the actual easing and final redraw; this just
 * records the settle parameters on the snapshot.
 */
function startSettle(snap, toX, toDrawEnd, finalRatio) {
  const dpr = window.devicePixelRatio || 1;
  // Capture the floating card's current position (where it is on screen now,
  // following the pointer) so the ease starts from there rather than jumping.
  const pathWidth = snap.segPathWidths[snap.srcIndex];
  const rect = el.waveformContainer.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  let fromX = snap.pointerX - snap.pointerOffsetInCard;
  fromX = Math.max(0, Math.min(W - pathWidth, fromX));
  const fromDrawEnd = fromX + pathWidth;

  // The user has released the mouse — drop the grabbing cursor immediately,
  // even though the visual settle is still easing.
  el.waveformContainer.style.cursor = 'default';

  snap.settle = {
    startTime: performance.now(),
    duration: SEGMENT_DRAG_SETTLE_MS,
    fromX,
    fromDrawEnd,
    fromLift: snap.liftPx,
    toX,
    toDrawEnd,
    toLift: 0,
    finalRatio
  };
  // The dragged segment's animBounds currently track its slot (not the
  // floating position); redirect them to the floating position so the settle
  // ease starts visually correct.
  snap.animBounds[snap.srcIndex].drawStart = fromX;
  snap.animBounds[snap.srcIndex].drawEnd = fromDrawEnd;
  // Make sure the rAF loop is running (it might have been paused if pointer
  // events stopped firing before pointerup).
  ensureDragAnimRunning();
}

export function cancelSegmentReorderDrag() {
  const pending = state.pendingSegmentDrag;
  state.pendingSegmentDrag = null;
  if (!pending) return;
  // If a drag or settle is already in progress, a stray click (pointerdown +
  // pointerup without crossing the drag threshold) shouldn't cancel it — just
  // discard the pending click and let the active drag/settle continue.
  if (state._segmentDragSnapshot) return;
  if (pending.index === state.selectedSegmentIndex) hideSegmentTrash();
  else showSegmentTrash(pending.index);
}

export function seekFromClientX(clientX) {
  if (!state.recordedBuffer) return;
  const rect = el.waveformContainer.getBoundingClientRect();
  const visualRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ratio = visualRatioToAudioRatioWithState(visualRatio, rect.width, SEGMENT_GAP_CSS_PX);
  seekToRatio(ratio);
}
