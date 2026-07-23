import { state, SEGMENT_GAP_CSS_PX, SEGMENT_DRAG_SETTLE_MS, WAVEFORM_SCALE, cloneSeg, currentPlaybackRatio, getActiveTrack } from './state.js';
import { el } from './dom.js';
import { formatTime } from './utils.js';
import { updateSegmentCountDisplay, setTransportDisabled, showToast, updateEmptyState } from './ui.js';
import { hideSegmentTrash, clearSegmentHover, drawPlaybackWaveform, findSegmentAtSample, animateSegmentDelete, animateSegmentRestore, captureSegmentBitmap, visualRatioToAudioRatioWithState, showSegmentTrash, ensureDragAnimRunning } from './waveform.js';
import { findSingleSegmentRemoval, computeDropInsertIndexPure, computeReorderTarget, computeSegmentBoundsPure, computeReorderArrangement, computeArrangementBounds, computePeaksForRange, buildWaveformPath, dbToGain, audibleTracks, addClipToMix, clipAtTimelineSample, ensureClipTStarts, trackTimelineEndSamples } from './waveform-math.js';
import { pausePlayback, seekToRatio } from './playback.js';
import { pushHistory, popUndo, popRedo, resetHistory } from './history.js';
import { isEffectsActive, getSourceBuffer, trackSourceBuffer, requestEffectsSync, resetEffectsCaches } from './effects.js';
import { createNormalizedBuffer } from './loudness-normalize.js';

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
  drawPlaybackWaveform(currentPlaybackRatio());
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
  drawPlaybackWaveform(currentPlaybackRatio());
}

// Ctrl/Cmd+Arrow segment selection. With no segment selected, finds the
// segment closest to the playhead in the given direction (the segment under
// the playhead counts as "to the right" only if the playhead sits exactly at
// its start — otherwise it's already behind the playhead). With a segment
// already selected, it just steps to the adjacent one.
export function selectAdjacentSegment(direction) {
  if (!state.recordedBuffer || state.segments.length === 0) return;

  if (state.selectedSegmentIndex >= 0) {
    const next = state.selectedSegmentIndex + direction;
    if (next < 0 || next >= state.segments.length) return;
    showSegmentTrash(next);
    return;
  }

  const sr = state.originalBuffer.sampleRate;
  const editedSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(editedSample);
  if (!target) return;

  if (direction > 0) {
    const idx = target.offsetInSeg === 0 ? target.index : target.index + 1;
    if (idx >= state.segments.length) return;
    showSegmentTrash(idx);
  } else {
    const idx = target.index - 1;
    if (idx < 0) return;
    showSegmentTrash(idx);
  }
}

// Shared tail for both mic capture (stopRecording) and file upload
// (loadUploadedFile): both produce a full-length AudioBuffer that becomes the
// new original/edited recording, and land in the same playback-ready state.
// Enabled effects (effects.js) automatically apply to the new audio.
export async function loadBufferAsRecording(buffer, toastMessage) {
  if (state.isPlaying) pausePlayback();
  state.clipboardSegment = null;
  resetEffectsCaches();
  state.originalBuffer = buffer;
  state.recordedBuffer = buffer;
  state.segments = [{ start: 0, end: buffer.length, origin: 'capture', tStart: 0 }];
  rebuildMix(); // refresh the master mix (this track + any other tracks)
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
  refreshTracksPanel();
  // The effects pipeline rebuilds recordedBuffer from the processed source
  // and redraws when it commits; the rAF draw above covers the raw interim.
  if (isEffectsActive()) await requestEffectsSync({ type: 'full' });
  showToast(toastMessage);
}

/**
 * Refresh the multi-track rail after audio structurally changes (load/append).
 * Lazy-imported to avoid a static import cycle (tracks.js imports editing.js).
 */
function refreshTracksPanel() {
  import('./tracks.js').then(m => m.updateTracksPanel()).catch(() => {});
}

/**
 * Rebuild state.recordedBuffer — the ACTIVE track's editor buffer — by
 * concatenating its kept segments. This is what the waveform editor draws and
 * what split/seek/playhead math operate on, so it must stay the active track's
 * own audio (NOT the multi-track mix). Also refreshes the master mix so
 * playback/export reflect the edit.
 */
export function rebuildPlaybackBuffer() {
  if (!state.originalBuffer || !state.audioContext) {
    state.recordedBuffer = null;
    state.cachedPeaks = null;
    state.cachedPath = null;
    rebuildMix();
    return;
  }

  // Read from the effects-processed parallel buffer while effects are on
  // (same length as originalBuffer, so segment ranges index into both).
  const source = getSourceBuffer();
  const numCh = source.numberOfChannels;
  let totalLen = 0;
  for (const s of state.segments) totalLen += (s.end - s.start);

  if (totalLen === 0) {
    state.recordedBuffer = null;
    state.cachedPeaks = null;
    state.cachedPath = null;
    rebuildMix();
    return;
  }

  const buf = state.audioContext.createBuffer(numCh, totalLen, source.sampleRate);
  for (let c = 0; c < numCh; c++) {
    const src = source.getChannelData(c);
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
  rebuildMix();
}

/**
 * Rebuild state.mixBuffer — the master mixdown that master playback and export
 * consume — by summing every audible track's clips at their timeline offset and
 * per-track gain. Each track's clips are laid contiguously starting at the
 * track's `offsetSamples` (free time positioning, Model B). Per-track audio is
 * read through the effects pipeline via trackSourceBuffer() so enabled effects
 * are baked in. Segments are left pristine (tStart is computed locally) so the
 * active-track editor is unaffected.
 */
export function rebuildMix() {
  if (!state.audioContext) return;

  const parts = [];
  let numCh = 1;
  let sampleRate = 0;
  let totalLen = 0;
  for (const track of audibleTracks(state.tracks)) {
    const source = trackSourceBuffer(track);
    if (!source || track.segments.length === 0) continue;
    // Each clip sits at its own timeline position (tStart); clips without one
    // fall back to contiguous packing so pre-tStart data still mixes correctly.
    let acc = 0;
    const laid = [];
    for (const s of track.segments) {
      const t = s.tStart != null ? s.tStart : acc;
      laid.push({ start: s.start, end: s.end, tStart: t });
      acc = Math.max(acc, t + (s.end - s.start));
    }
    parts.push({ track, source, laid });
    numCh = Math.max(numCh, source.numberOfChannels);
    if (!sampleRate) sampleRate = source.sampleRate;
    if (acc > totalLen) totalLen = acc;
  }

  if (totalLen === 0 || !sampleRate) {
    state.mixBuffer = null;
    return;
  }

  const buf = state.audioContext.createBuffer(numCh, totalLen, sampleRate);
  const mixChannels = [];
  for (let c = 0; c < numCh; c++) mixChannels.push(buf.getChannelData(c));

  for (const { track, source, laid } of parts) {
    const srcChannels = [];
    for (let c = 0; c < source.numberOfChannels; c++) srcChannels.push(source.getChannelData(c));
    const gain = dbToGain(track.gainDb);
    for (const s of laid) {
      addClipToMix(mixChannels, srcChannels, s.start, s.end, s.tStart, gain);
    }
  }

  // Master "finishing" stage: loudness-normalize the summed mix (not the
  // individual tracks — normalizing per-track then summing gives an
  // unpredictable final loudness). Length-preserving.
  const ml = state.master.loudness;
  if (ml.enabled) {
    const result = createNormalizedBuffer(buf, ml.targetLufs, ml.truePeakDbtp,
      (channels, length, sampleRate) => state.audioContext.createBuffer(channels, length, sampleRate));
    state.mixBuffer = result.buffer;
  } else {
    state.mixBuffer = buf;
  }
}

/**
 * Re-run the mixdown after a master finishing-effect change (loudness toggle or
 * settings). Master playback / export read state.mixBuffer, so a rebuild is all
 * that's needed. Master effects live outside undo history.
 */
export function refreshMasterLoudness() {
  rebuildMix();
}

/**
 * Commit a per-clip time move (dragged on the timeline). `prevTStart` is the
 * clip's position before the drag; restore it, snapshot for undo, then apply the
 * new position and rebuild the mix. The clip's track must be the active track
 * (the timeline focuses it before dragging) so per-track history captures it.
 * @param {number} trackIndex @param {number} clipIndex @param {number} prevTStart @param {number} newTStart
 */
export function commitClipMove(trackIndex, clipIndex, prevTStart, newTStart) {
  const track = state.tracks[trackIndex];
  if (!track) return;
  const seg = track.segments[clipIndex];
  if (!seg) return;
  newTStart = Math.max(0, Math.round(newTStart));
  if (prevTStart === newTStart) { seg.tStart = newTStart; rebuildMix(); refreshTracksPanel(); return; }
  seg.tStart = prevTStart;
  pushHistory();
  seg.tStart = newTStart;
  state.bufferEpoch++; // arrangement changed → undo must rebuild the mix
  rebuildMix();
  refreshTracksPanel();
}

/**
 * Move a clip from one track to another (drag it onto a different lane). The
 * clip's RAW PCM is cloned from the source track and appended onto the
 * destination (so the destination's effects apply), positioned at `tStartSec`;
 * the clip is removed from the source. Reuses the effects-aware append path.
 *
 * Cross-track moves span two tracks, which the per-active-track undo history
 * can't represent cleanly, so history is reset afterward (the move is not
 * undoable) — kept safe rather than leaving undo in an inconsistent state.
 * @param {number} srcTrackIndex @param {number} clipIndex @param {number} destTrackIndex @param {number} tStartSec
 */
export async function moveClipToTrack(srcTrackIndex, clipIndex, destTrackIndex, tStartSec) {
  const srcTrack = state.tracks[srcTrackIndex];
  const destTrack = state.tracks[destTrackIndex];
  if (!srcTrack || !destTrack || srcTrackIndex === destTrackIndex || !state.audioContext) return;
  const srcSeg = srcTrack.segments[clipIndex];
  const srcBuf = srcTrack.originalBuffer;
  if (!srcSeg || !srcBuf) return;
  if (state.isPlaying) pausePlayback();

  // 1. Extract the clip's raw PCM from the source track.
  const clipLen = srcSeg.end - srcSeg.start;
  const nch = srcBuf.numberOfChannels;
  const clipBuf = state.audioContext.createBuffer(nch, clipLen, srcBuf.sampleRate);
  for (let c = 0; c < nch; c++) {
    clipBuf.copyToChannel(srcBuf.getChannelData(c).slice(srcSeg.start, srcSeg.end), c);
  }

  // 2. Remove it from the source track.
  srcTrack.segments.splice(clipIndex, 1);

  // 3. Make the destination active and drop the clip in via the effects-aware
  //    load/append path.
  const tracks = await import('./tracks.js');
  tracks.setActiveTrack(destTrackIndex);
  const destRate = destTrack.originalBuffer ? destTrack.originalBuffer.sampleRate : state.audioContext.sampleRate;
  const destCh = destTrack.originalBuffer ? destTrack.originalBuffer.numberOfChannels : nch;
  const adapted = await adaptBuffer(clipBuf, destRate, destCh);
  const tStartSamples = Math.max(0, Math.round(tStartSec * destRate));

  if (!destTrack.originalBuffer) {
    await loadBufferAsRecording(adapted);
    if (state.segments[0]) state.segments[0].tStart = tStartSamples;
  } else {
    const destOldLen = destTrack.originalBuffer.length;
    const newLen = adapted.length;
    const newSegments = destTrack.segments.map(cloneSeg);
    newSegments.push({ start: destOldLen, end: destOldLen + newLen, origin: 'move', tStart: tStartSamples });
    await commitAppendedAudio(newLen, (c) => adapted.getChannelData(c), newSegments, destOldLen);
  }

  resetHistory(); // cross-track move isn't undoable (see note above)
  state.bufferEpoch++;
  rebuildPlaybackBuffer(); // active (dest) editor buffer + mix
  refreshTracksPanel();
  showToast(`Moved clip to ${destTrack.name}`);
}

// Split the clip under the shared timeline playhead (state.timelineSec) on the
// active track into two independently-positioned clips. PCM-neutral: the two
// halves reference the same source ranges, so no rebuild is needed — only the
// arrangement changes (undo shares the buffer epoch and skips the rebuild).
export function splitAtPlayhead() {
  if (!state.recordedBuffer || !state.originalBuffer) return;
  if (state.isPlaying) pausePlayback();

  const src = trackSourceBuffer(getActiveTrack()) || state.originalBuffer;
  const sr = src.sampleRate;
  const tSample = Math.round((state.timelineSec || 0) * sr);
  const hit = clipAtTimelineSample(state.segments, tSample);
  if (!hit) { showToast('Move the playhead over a clip to split'); return; }

  const seg = state.segments[hit.index];
  const local = hit.offsetInClip; // samples into the clip's source range
  if (local <= 0 || local >= (seg.end - seg.start)) {
    showToast('Move the playhead within a clip to split');
    return;
  }

  const splitPoint = seg.start + local;
  const clipTStart = seg.tStart != null ? seg.tStart : 0;
  pushHistory();
  state.segments.splice(hit.index, 1,
    { start: seg.start, end: splitPoint, origin: 'split', tStart: clipTStart },
    { start: splitPoint, end: seg.end, origin: 'split', tStart: clipTStart + local }
  );

  hideSegmentTrash();
  clearSegmentHover();
  drawPlaybackWaveform(currentPlaybackRatio());
  updateSegmentCountDisplay();
  refreshTracksPanel();
  showToast(`Split clip ${hit.index + 1} → ${hit.index + 1} and ${hit.index + 2}`);
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

  const oldSegments = state.segments.map(cloneSeg);
  const oldTotalSamples = state.recordedBuffer.length;
  const oldPlayheadRatio = currentPlaybackRatio();
  // Lift the doomed card's rendered pixels (in delete-red) off the canvas
  // while it's still part of the layout — this image is what disintegrates.
  const deletedSnap = captureSegmentBitmap(index);

  pushHistory();
  state.segments.splice(index, 1);
  rebuildPlaybackBuffer();
  state.bufferEpoch++;

  if (!state.recordedBuffer) {
    hideSegmentTrash();
    clearSegmentHover();
    el.playButton.classList.remove('playing');
    state.playbackOffset = 0;
    el.timeCurrent.textContent = '00:00.000';
    el.timeTotal.textContent = '00:00.000';
    setTransportDisabled(true);
    updateSegmentCountDisplay();
    animateSegmentDelete(oldSegments, oldTotalSamples, index, oldPlayheadRatio, 0, deletedSnap);
    refreshTracksPanel();
    showToast('All audio deleted', true);
    return;
  }

  state.playbackOffset = Math.max(0, Math.min(newPlayheadSample / sr, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);

  hideSegmentTrash();
  clearSegmentHover();
  const newPlayheadRatio = currentPlaybackRatio();
  animateSegmentDelete(oldSegments, oldTotalSamples, index, oldPlayheadRatio, newPlayheadRatio, deletedSnap);
  updateSegmentCountDisplay();
  refreshTracksPanel();
  showToast(`Deleted segment ${index + 1} · ${state.segments.length} remaining`);
}

export function deleteSegmentAtPlayhead() {
  if (!state.recordedBuffer || !state.originalBuffer) return;
  if (state.isPlaying) pausePlayback();
  const src = trackSourceBuffer(getActiveTrack()) || state.originalBuffer;
  const sr = src.sampleRate;
  const tSample = Math.round((state.timelineSec || 0) * sr);
  const hit = clipAtTimelineSample(state.segments, tSample);
  if (hit) deleteSegmentByIndex(hit.index);
}


// ===== Segment copy/paste (context menu) =====

export function copySegmentByIndex(index) {
  if (!state.originalBuffer || index < 0 || index >= state.segments.length) return;
  const seg = state.segments[index];
  const numCh = state.originalBuffer.numberOfChannels;
  const channels = [];
  for (let c = 0; c < numCh; c++) {
    channels.push(state.originalBuffer.getChannelData(c).slice(seg.start, seg.end));
  }
  state.clipboardSegment = { channels, length: seg.end - seg.start, sampleRate: state.originalBuffer.sampleRate };
  showToast(`Copied segment ${index + 1}`);
}

// Builds a new originalBuffer (old samples + new samples appended) AND a new
// recordedBuffer (from the pre-computed final segment layout) in a single pass,
// so each source sample is read once instead of twice.
// `newSegments` is the final segment array (after splice/insert) — ranges with
// start < oldLen read from originalBuffer; the range at oldLen reads from
// `fillChannel`. The caller must compute `newSegments` before calling this.
function concatAndRebuild(newLen, fillChannel, newSegments, oldLen) {
  const orig = state.originalBuffer;
  const nch = orig.numberOfChannels;

  let totalRec = 0;
  for (const s of newSegments) totalRec += (s.end - s.start);
  const combined = state.audioContext.createBuffer(nch, oldLen + newLen, orig.sampleRate);
  const recorded = state.audioContext.createBuffer(nch, totalRec, orig.sampleRate);

  for (let c = 0; c < nch; c++) {
    const origCh = orig.getChannelData(c);
    const combDst = combined.getChannelData(c);
    const recDst = recorded.getChannelData(c);

    combDst.set(origCh, 0);
    const newCh = fillChannel(c);
    combDst.set(newCh, oldLen);

    let off = 0;
    for (const s of newSegments) {
      const len = s.end - s.start;
      if (s.start >= oldLen) {
        recDst.set(newCh.subarray(s.start - oldLen, s.end - oldLen), off);
      } else {
        recDst.set(origCh.subarray(s.start, s.end), off);
      }
      off += len;
    }
  }

  return { combined, recorded };
}

// Raw-only counterpart of concatAndRebuild: builds just the new
// originalBuffer (old samples + appended samples). Used when effects are on —
// the playback buffer comes from the effects pipeline instead, so building
// `recorded` here would be wasted work.
function concatRawOnly(newLen, fillChannel, oldLen) {
  const orig = state.originalBuffer;
  const nch = orig.numberOfChannels;
  const combined = state.audioContext.createBuffer(nch, oldLen + newLen, orig.sampleRate);
  for (let c = 0; c < nch; c++) {
    const dst = combined.getChannelData(c);
    dst.set(orig.getChannelData(c), 0);
    dst.set(fillChannel(c), oldLen);
  }
  return combined;
}

// Shared mutation for every "append raw audio onto originalBuffer" op
// (paste-after, duplicate, paste-at-playhead, append): installs the grown raw
// buffer + final segment layout, then lands in playback-ready state. With
// effects off this is the single-pass fast path; with effects on the pipeline
// processes the appended region (denoise is incremental; loudness re-runs)
// and rebuilds/redraws on commit — so this awaits the sync before callers
// update their UI.
async function commitAppendedAudio(newLen, fillChannel, newSegments, oldLen) {
  // Any freshly-inserted clip without an explicit timeline position is packed
  // at the track's current end (existing clips keep their free positions).
  ensureClipTStarts(newSegments);
  if (isEffectsActive()) {
    const combined = concatRawOnly(newLen, fillChannel, oldLen);
    pushHistory();
    state.bufferEpoch++;
    state.originalBuffer = combined;
    state.segments = newSegments;
    state.cachedPeaks = null;
    state.cachedPath = null;
    await requestEffectsSync({ type: 'append', oldLen });
    return;
  }
  const { combined, recorded } = concatAndRebuild(newLen, fillChannel, newSegments, oldLen);
  pushHistory();
  state.bufferEpoch++;
  state.originalBuffer = combined;
  state.recordedBuffer = recorded;
  state.segments = newSegments;
  state.cachedPeaks = null;
  state.cachedPath = null;
}

// Shared tail for paste-after/duplicate: appends `newLen` samples (produced
// per channel by `fillChannel`) onto originalBuffer and splices a new segment
// in right after `afterIndex`.
async function insertClonedAudioAfter(afterIndex, newLen, fillChannel, originLabel, toastMessage) {
  if (!state.originalBuffer || !state.audioContext) return;
  if (state.isPlaying) pausePlayback();

  const oldLen = state.originalBuffer.length;
  const insertAt = Math.max(0, Math.min(afterIndex + 1, state.segments.length));
  const newSegments = state.segments.map(cloneSeg);
  newSegments.splice(insertAt, 0, { start: oldLen, end: oldLen + newLen, origin: originLabel, tStart: undefined });

  await commitAppendedAudio(newLen, fillChannel, newSegments, oldLen);
  if (!state.recordedBuffer) return;

  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);
  updateSegmentCountDisplay();
  updateEmptyState();
  clearSegmentHover();
  // The effects await above lets the user edit meanwhile — only select the
  // new segment if our segment layout is still the current one.
  if (state.segments === newSegments) showSegmentTrash(insertAt);
  const ratio = currentPlaybackRatio();
  drawPlaybackWaveform(ratio);
  showToast(toastMessage);
}

export async function pasteSegmentAfterIndex(index) {
  const clip = state.clipboardSegment;
  if (!clip) { showToast('Nothing to paste — copy a segment first'); return; }
  const target = state.originalBuffer;
  const adapted = await adaptClipboardForPaste(clip);
  if (!adapted) return;
  // The recording may have been replaced while the clip was being resampled
  if (state.originalBuffer !== target) { showToast('Cannot paste — recording was replaced', true); return; }
  await insertClonedAudioAfter(
    index, adapted.length,
    (c) => adapted.channels[Math.min(c, adapted.channels.length - 1)],
    'paste', `Pasted after segment ${index + 1}`
  );
}

export async function duplicateSegmentByIndex(index) {
  if (!state.originalBuffer || index < 0 || index >= state.segments.length) return;
  const seg = state.segments[index];
  await insertClonedAudioAfter(
    index, seg.end - seg.start,
    (c) => state.originalBuffer.getChannelData(c).subarray(seg.start, seg.end),
    'duplicate', `Duplicated segment ${index + 1}`
  );
}

// Shared classification of where the playhead currently sits, used both to
// decide whether pasteInsertAtPlayhead needs to split a segment and to decide
// whether the context menu should offer that action at all (only when the
// playhead is strictly mid-segment — not at a boundary, and not off the ends
// of the timeline).
function classifyPlayheadPosition() {
  if (!state.recordedBuffer || !state.originalBuffer || state.segments.length === 0) return null;
  const sr = state.originalBuffer.sampleRate;
  const editedSample = Math.round(state.playbackOffset * sr);
  const target = findSegmentAtSample(editedSample);
  if (!target) return null;

  const { index, offsetInSeg, seg } = target;
  const segLen = seg.end - seg.start;
  const atSegStart = offsetInSeg <= 0;
  const atRecordingEnd = index === state.segments.length - 1 && offsetInSeg >= segLen;
  return { target, atSegStart, atRecordingEnd, midSegment: !atSegStart && !atRecordingEnd };
}

export function isPlayheadMidSegment() {
  const info = classifyPlayheadPosition();
  return !!info && info.midSegment;
}

// Secondary paste mode: instead of landing after a chosen segment, drop the
// clipboard audio exactly at the playhead. If the playhead sits mid-segment,
// that segment is split there first (same split point splitAtPlayhead would
// use) and the paste is inserted between the two halves — content after the
// playhead shifts right to make room. If the playhead sits exactly on a
// segment boundary (or at the very end of the recording), no split is
// needed; the paste just slots in there directly.
export async function pasteInsertAtPlayhead() {
  const clip = state.clipboardSegment;
  if (!clip) { showToast('Nothing to paste — copy a segment first'); return; }
  if (!state.recordedBuffer || !state.originalBuffer || !state.audioContext) return;
  if (state.isPlaying) pausePlayback();

  const targetBuffer = state.originalBuffer;
  const adapted = await adaptClipboardForPaste(clip);
  if (!adapted) return;
  if (state.originalBuffer !== targetBuffer) { showToast('Cannot paste — recording was replaced', true); return; }

  const info = classifyPlayheadPosition();
  if (!info) return;
  const { target, atSegStart, atRecordingEnd } = info;
  const { index, offsetInSeg, seg } = target;

  const newLen = adapted.length;
  const fillChannel = (c) => adapted.channels[Math.min(c, adapted.channels.length - 1)];
  const oldLen = state.originalBuffer.length;

  let newSegments;
  let pastedIndex;
  let didSplit = false;

  if (atSegStart) {
    pastedIndex = index;
    newSegments = state.segments.map(cloneSeg);
    newSegments.splice(pastedIndex, 0, { start: oldLen, end: oldLen + newLen, origin: 'paste', tStart: undefined });
  } else if (atRecordingEnd) {
    pastedIndex = index + 1;
    newSegments = state.segments.map(cloneSeg);
    newSegments.splice(pastedIndex, 0, { start: oldLen, end: oldLen + newLen, origin: 'paste', tStart: undefined });
  } else {
    const splitPoint = seg.start + offsetInSeg;
    pastedIndex = index + 1;
    didSplit = true;
    newSegments = [];
    for (let i = 0; i < state.segments.length; i++) {
      if (i === index) {
        newSegments.push({ start: seg.start, end: splitPoint, origin: 'split', tStart: undefined });
        newSegments.push({ start: oldLen, end: oldLen + newLen, origin: 'paste', tStart: undefined });
        newSegments.push({ start: splitPoint, end: seg.end, origin: 'split', tStart: undefined });
      } else {
        newSegments.push(cloneSeg(state.segments[i]));
      }
    }
  }

  await commitAppendedAudio(newLen, fillChannel, newSegments, oldLen);
  if (!state.recordedBuffer) return;

  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);

  updateSegmentCountDisplay();
  updateEmptyState();
  clearSegmentHover();
  // Guard like insertClonedAudioAfter: the effects await may have let the
  // user edit meanwhile, changing the segment layout out from under us.
  if (state.segments === newSegments) showSegmentTrash(pastedIndex);
  const ratio = currentPlaybackRatio();
  drawPlaybackWaveform(ratio);
  showToast(didSplit ? 'Pasted at playhead (split)' : 'Pasted at playhead');
}

function applyHistorySnapshot(snapshot, render) {
  // A pinned snapshot restores the exact pre-op originalBuffer (trim-silence
  // replaces PCM wholesale). Swap it back BEFORE the epoch check — the buffer
  // reference changes, so a rebuild is mandatory.
  if (snapshot.pinnedBuffer) state.originalBuffer = snapshot.pinnedBuffer;
  // The effects pipeline's caches describe the swapped-out buffer; resync
  // against the restored one. The interim rebuild below falls back to raw
  // (length parity fails until the sync commits).
  if (snapshot.pinnedBuffer && isEffectsActive()) requestEffectsSync({ type: 'full' });

  // Decide BEFORE assigning the snapshot's epoch: if the snapshot was taken at
  // the same buffer epoch as the current state, its concatenated PCM is
  // identical (e.g. undoing/redoing a split, which only rearranges segment
  // ranges without changing the underlying buffer) — skip the rebuild AND the
  // peak invalidation entirely.
  const pcmMatches = !snapshot.pinnedBuffer && !!state.recordedBuffer && snapshot.bufferEpoch === state.bufferEpoch;
  state.segments = snapshot.segments.map(cloneSeg);
  state.bufferEpoch = snapshot.bufferEpoch;

  if (!pcmMatches) {
    rebuildPlaybackBuffer();
  }

  // Undo/redo may have changed which segments opt out of a per-segment effect
  // (a chip toggle is PCM-neutral, so pcmMatches short-circuits the rebuild
  // above). Resync the effects pipeline so the processed buffer recomposites
  // for the restored per-segment state; it no-ops when the fingerprint is
  // unchanged (e.g. undoing a plain split).
  if (!snapshot.pinnedBuffer && isEffectsActive()) requestEffectsSync({ type: 'light' });

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
    if (render === drawPlaybackWaveform) updateEmptyState();
    refreshTracksPanel();
    return;
  }

  setTransportDisabled(false);
  state.playbackOffset = Math.max(0, Math.min(snapshot.playbackOffset, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);
  updateSegmentCountDisplay();
  updateEmptyState();
  render(currentPlaybackRatio());
  refreshTracksPanel();
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
    segments: state.segments.map(cloneSeg),
    totalSamples: state.recordedBuffer ? state.recordedBuffer.length : 0,
    ratio: currentPlaybackRatio()
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

// If the clipboard sample rate differs from the current originalBuffer, wrap
// the clip's raw channels in a temporary AudioBuffer and resample/remix via
// adaptBuffer so pasted audio plays back at the correct speed/pitch.
async function adaptClipboardForPaste(clip) {
  if (!state.audioContext || !state.originalBuffer) return null;
  if (clip.sampleRate === state.originalBuffer.sampleRate && clip.channels.length === state.originalBuffer.numberOfChannels) return clip;
  const nch = clip.channels.length;
  const temp = state.audioContext.createBuffer(nch, clip.length, clip.sampleRate);
  for (let c = 0; c < nch; c++) temp.copyToChannel(clip.channels[c], c);
  const adapted = await adaptBuffer(temp, state.originalBuffer.sampleRate, state.originalBuffer.numberOfChannels);
  const outChannels = [];
  for (let c = 0; c < adapted.numberOfChannels; c++) outChannels.push(adapted.getChannelData(c));
  return { channels: outChannels, length: adapted.length, sampleRate: adapted.sampleRate };
}

export async function appendBufferToRecording(buffer, toastMessage) {
  if (state.isPlaying) pausePlayback();
  const target = state.originalBuffer;
  if (!target) return;
  const adapted = await adaptBuffer(buffer, target.sampleRate, target.numberOfChannels);
  // Bail if originalBuffer was replaced or disconnected during the async wait
  if (state.originalBuffer !== target || !state.audioContext) {
    showToast('Cannot append — recording was replaced', true);
    return;
  }
  const oldLen = state.originalBuffer.length;
  const newLen = adapted.length;
  const newSegments = state.segments.map(cloneSeg);
  newSegments.push({ start: oldLen, end: oldLen + newLen, origin: 'append', tStart: undefined });
  await commitAppendedAudio(newLen, (c) => adapted.getChannelData(c), newSegments, oldLen);
  if (!state.recordedBuffer) return;

  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);
  updateSegmentCountDisplay();
  updateEmptyState();
  const ratio = currentPlaybackRatio();
  drawPlaybackWaveform(ratio);
  refreshTracksPanel();
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
  // Source from the effects-processed buffer when effects are on so the
  // dragged card shows the audio that's actually heard.
  const channelData = getSourceBuffer().getChannelData(0);
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
  el.waveformContainer.style.cursor = 'grabbing';
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
    startSettle(snap, snap.targetBounds[src].drawStart, snap.targetBounds[src].drawEnd, currentPlaybackRatio());
    return;
  }

  pushHistory();
  const [moved] = state.segments.splice(src, 1);
  state.segments.splice(target, 0, moved);
  rebuildPlaybackBuffer();
  state.bufferEpoch++;

  // The playhead is a fixed timeline position: state.playbackOffset is
  // deliberately left untouched, so the caret stays at the same time and the
  // reordered content reflows around it (it does not follow the moved audio).

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
  const finalRatio = currentPlaybackRatio();

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
