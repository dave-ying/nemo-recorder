import { state } from './state.js';
import { el } from './dom.js';
import { deleteSegmentByIndex, copySegmentByIndex, pasteSegmentAfterIndex, duplicateSegmentByIndex, pasteInsertAtPlayhead, isPlayheadMidSegment } from './editing.js';

let openIndex = -1;

export function closeSegmentContextMenu() {
  el.segmentContextMenu.hidden = true;
  openIndex = -1;
}

export function openSegmentContextMenu(index, clientX, clientY) {
  openIndex = index;
  const noClipboard = !state.clipboardSegment;
  el.segmentContextPaste.classList.toggle('disabled', noClipboard);
  // Only offer the split-insert paste when it would actually split something —
  // i.e. the playhead sits strictly inside a segment. At a segment boundary,
  // at the very start/end of the timeline, or between segments, this action
  // would be identical to (or a no-op next to) the plain "Paste", so hide it
  // entirely rather than showing a redundant/confusing option.
  el.segmentContextPasteAtPlayhead.hidden = !isPlayheadMidSegment();
  el.segmentContextPasteAtPlayhead.classList.toggle('disabled', noClipboard);
  el.segmentContextMenu.hidden = false;

  const menuRect = el.segmentContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 4;
  const maxY = window.innerHeight - menuRect.height - 4;
  el.segmentContextMenu.style.left = Math.max(4, Math.min(clientX, maxX)) + 'px';
  el.segmentContextMenu.style.top = Math.max(4, Math.min(clientY, maxY)) + 'px';
}

export function initSegmentContextMenu() {
  el.segmentContextCopy.addEventListener('click', () => {
    if (openIndex >= 0) copySegmentByIndex(openIndex);
    closeSegmentContextMenu();
  });
  el.segmentContextPaste.addEventListener('click', () => {
    if (openIndex >= 0 && state.clipboardSegment) pasteSegmentAfterIndex(openIndex);
    closeSegmentContextMenu();
  });
  el.segmentContextPasteAtPlayhead.addEventListener('click', () => {
    // Unlike the other items, this ignores which segment was right-clicked —
    // it always targets the playhead, matching the Ctrl+Shift+V shortcut.
    if (state.clipboardSegment) pasteInsertAtPlayhead();
    closeSegmentContextMenu();
  });
  el.segmentContextDuplicate.addEventListener('click', () => {
    if (openIndex >= 0) duplicateSegmentByIndex(openIndex);
    closeSegmentContextMenu();
  });
  el.segmentContextDelete.addEventListener('click', () => {
    if (openIndex >= 0) deleteSegmentByIndex(openIndex);
    closeSegmentContextMenu();
  });

  document.addEventListener('pointerdown', (e) => {
    if (el.segmentContextMenu.hidden) return;
    if (!el.segmentContextMenu.contains(/** @type {Node} */ (e.target))) closeSegmentContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !el.segmentContextMenu.hidden) closeSegmentContextMenu();
  });
  window.addEventListener('resize', closeSegmentContextMenu);
  window.addEventListener('blur', closeSegmentContextMenu);
}
