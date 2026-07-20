import { state } from './state.js';
import { el } from './dom.js';

const MAX_HISTORY = 50;

/** @typedef {{segments: Array<{start: number, end: number, origin: string}>, playbackOffset: number}} HistorySnapshot */

/** @type {HistorySnapshot[]} */
let undoStack = [];
/** @type {HistorySnapshot[]} */
let redoStack = [];

const cloneSegments = (segments) => segments.map(s => ({ start: s.start, end: s.end, origin: s.origin }));

const snapshotCurrent = () => ({ segments: cloneSegments(state.segments), playbackOffset: state.playbackOffset });

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
  updateHistoryButtons();
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
