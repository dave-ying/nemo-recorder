import { state } from './state.js';
import { el } from './dom.js';

const MAX_HISTORY = 50;

/** @typedef {{segments: Array<{start: number, end: number, origin: string}>, playbackOffset: number, bufferEpoch: number}} HistorySnapshot */

/** @type {HistorySnapshot[]} */
let undoStack = [];
/** @type {HistorySnapshot[]} */
let redoStack = [];

const cloneSegments = (segments) => segments.map(s => ({ start: s.start, end: s.end, origin: s.origin }));

const snapshotCurrent = () => ({ segments: cloneSegments(state.segments), playbackOffset: state.playbackOffset, bufferEpoch: state.bufferEpoch });

const canUndo = () => undoStack.length > 0;
const canRedo = () => redoStack.length > 0;

function updateHistoryButtons() {
  el.undoButton.disabled = !canUndo();
  el.redoButton.disabled = !canRedo();
}

// Call before mutating state.segments (split, delete, drag-resize start) to
// snapshot the pre-mutation state for undo.
export function pushHistory() {
  undoStack.push(snapshotCurrent());
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
function reclaimOriginalBufferTail() {
  const orig = state.originalBuffer;
  if (!orig || !state.audioContext) return;
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
  updateHistoryButtons();
  return snapshot;
}

// Returns the snapshot to restore, or null if there's nothing to redo.
export function popRedo() {
  if (!canRedo()) return null;
  undoStack.push(snapshotCurrent());
  const snapshot = redoStack.pop();
  updateHistoryButtons();
  return snapshot;
}
