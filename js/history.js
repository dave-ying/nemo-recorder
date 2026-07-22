import { state, cloneSeg } from './state.js';
import { el } from './dom.js';
import { isEffectsActive } from './effects.js';

const MAX_HISTORY = 50;

/**
 * @typedef {Object} HistorySnapshot
 * @property {Array<{start: number, end: number, origin: string, fxOff?: string[]}>} segments
 * @property {number} playbackOffset
 * @property {number} bufferEpoch
 * @property {AudioBuffer|null} pinnedBuffer - set only for PCM-replacing ops (trim-silence): the pre-op originalBuffer, kept alive by reference so undo can restore the exact pre-op PCM. Null for segment-only/append ops, whose ranges stay valid in the shared (append-only) buffer lineage. Effects (loudness/denoise) never pin: they don't mutate originalBuffer at all (see effects.js).
 */

/** @type {HistorySnapshot[]} */
let undoStack = [];
/** @type {HistorySnapshot[]} */
let redoStack = [];

const cloneSegments = (segments) => segments.map(cloneSeg);

const snapshotCurrent = () => ({ segments: cloneSegments(state.segments), playbackOffset: state.playbackOffset, bufferEpoch: state.bufferEpoch, pinnedBuffer: null });

const canUndo = () => undoStack.length > 0;
const canRedo = () => redoStack.length > 0;

function updateHistoryButtons() {
  el.undoButton.disabled = !canUndo();
  el.redoButton.disabled = !canRedo();
}

// Call before mutating state.segments (split, delete, drag-resize start) to
// snapshot the pre-mutation state for undo.
//
// Pass pinBuffer=true for PCM-REPLACING operations (trim-silence) that swap
// state.originalBuffer for unrelated new PCM. The snapshot then keeps the
// pre-op buffer alive by reference so undo can restore it exactly.
// Segment-only and append ops must NOT pin: appends keep old ranges valid in
// the grown buffer, and pinning every append would pin one full buffer per
// paste. (Loudness/denoise used to pin; as non-destructive effects they no
// longer touch originalBuffer or history at all.)
export function pushHistory(pinBuffer = false) {
  const snapshot = snapshotCurrent();
  if (pinBuffer) snapshot.pinnedBuffer = state.originalBuffer;
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  reclaimOriginalBufferTail();
  updateHistoryButtons();
}

// Paste/duplicate/append only ever grow originalBuffer, and undoing them does
// not shrink it — the pasted PCM tail stays allocated for the life of the
// recording. The moment pushHistory clears the redo stack, any tail samples
// referenced only by discarded redo snapshots become unreachable forever, so
// reclaim them with one slice copy (only when there's actually a tail to cut).
//
// Pinned snapshots (trim-silence) reference their OWN buffers, not the
// current one — counting their segment ranges here is conservative (may skip
// a reclaim, never over-truncates). The reclaim builds a NEW buffer rather
// than mutating in place, so pinned references are never corrupted.
function reclaimOriginalBufferTail() {
  const orig = state.originalBuffer;
  if (!orig || !state.audioContext) return;
  // The effects pipeline keeps processed caches parallel to the FULL raw
  // buffer; truncation would desync them. While effects are on, skip the
  // reclaim — correctness over the memory saving.
  if (isEffectsActive()) return;
  let maxEnd = 0;
  for (const s of state.segments) if (s.end > maxEnd) maxEnd = s.end;
  for (const snap of undoStack) {
    for (const s of snap.segments) if (s.end > maxEnd) maxEnd = s.end;
  }
  // maxEnd <= 0 means every segment reference is gone (e.g. all deleted) —
  // the undo stack still pins the full capture, so there's nothing to reclaim.
  if (maxEnd <= 0 || maxEnd >= orig.length) return;
  const nch = orig.numberOfChannels;
  const trimmed = state.audioContext.createBuffer(nch, maxEnd, orig.sampleRate);
  for (let c = 0; c < nch; c++) {
    const src = /** @type {Float32Array<ArrayBuffer>} */ (/** @type {*} */ (orig.getChannelData(c).subarray(0, maxEnd)));
    trimmed.copyToChannel(src, c);
  }
  state.originalBuffer = trimmed;
}

export function resetHistory() {
  undoStack = [];
  redoStack = [];
  updateHistoryButtons();
}

// Returns the snapshot to restore, or null if there's nothing to undo.
export function popUndo() {
  if (!canUndo()) return null;
  redoStack.push(snapshotCurrent());
  const snapshot = undoStack.pop();
  pinOppositeSnapshotIfNeeded(snapshot, redoStack);
  updateHistoryButtons();
  return snapshot;
}

// Returns the snapshot to restore, or null if there's nothing to redo.
export function popRedo() {
  if (!canRedo()) return null;
  undoStack.push(snapshotCurrent());
  const snapshot = redoStack.pop();
  pinOppositeSnapshotIfNeeded(snapshot, undoStack);
  updateHistoryButtons();
  return snapshot;
}

// If the snapshot being restored carries a pinnedBuffer, applyHistorySnapshot
// will swap state.originalBuffer back to it — making the CURRENT buffer
// unreachable. Pin that current buffer into the just-pushed opposite-stack
// snapshot so redo/undo across the boundary restores the exact PCM both ways.
// Runs before the swap (state.originalBuffer is still the pre-restore buffer).
function pinOppositeSnapshotIfNeeded(restoredSnapshot, oppositeStack) {
  if (!restoredSnapshot || !restoredSnapshot.pinnedBuffer) return;
  const opposite = oppositeStack[oppositeStack.length - 1];
  if (opposite && !opposite.pinnedBuffer) opposite.pinnedBuffer = state.originalBuffer;
}
