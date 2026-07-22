import { state, SEGMENT_DRAG_THRESHOLD_CSS_PX } from './state.js';
import { el } from './dom.js';
import { showToast, updateSegmentCountDisplay, setTransportDisabled, updateEmptyState, attachToolbarPopover } from './ui.js';
import { applyTrimSilence } from './trim-silence.js';
import { normalizeLoudness } from './loudness-normalize.js';
import { removeNoise } from './rnnoise.js';
import { connectMicrophone } from './audio.js';
import { loadUploadedFile, appendUploadedFile } from './upload.js';
import { drawPlaybackWaveform, removePlayheadCaretDraggingClass, hideSegmentTrash, showSegmentTrash, getSegmentIndexAtClientPoint, invalidateRectCache } from './waveform.js';
import { splitAtPlayhead, deleteSegmentByIndex, deleteSegmentAtPlayhead, undo, redo, jumpToSegmentStart, jumpToSegmentEnd, seekFromClientX, beginSegmentReorderDrag, applySegmentReorderDrag, finishSegmentReorderDrag, cancelSegmentReorderDrag, selectAdjacentSegment, copySegmentByIndex, pasteSegmentAfterIndex, pasteInsertAtPlayhead } from './editing.js';
import { startPlayback, pausePlayback, isPlaybackActive } from './playback.js';
import { arrowKeyDown, arrowKeyUp, stepBySeconds } from './scrub.js';
import { openExportModal, closeExportModal, renderExportQualityOptions, updateExportInfo, executeExport } from './export.js';
import { openRecordModal, closeRecordModal, handleModalStop, handleModalRecord, togglePreview, initRecordModal } from './record-modal.js';
import { closeHelpModal, initHelpModal } from './help-modal.js';
import { openSegmentContextMenu, initSegmentContextMenu, closeSegmentContextMenu } from './context-menu.js';

const RESIZE_DEBOUNCE_MS = 120;
let _pendingSeekClientX = null;
let _seekRafId = null;

function flushSeek() {
  if (_seekRafId) cancelAnimationFrame(_seekRafId);
  _seekRafId = null;
  if (_pendingSeekClientX !== null) {
    seekFromClientX(_pendingSeekClientX);
    _pendingSeekClientX = null;
  }
}

function scheduleSeek(clientX) {
  _pendingSeekClientX = clientX;
  if (!_seekRafId) {
    _seekRafId = requestAnimationFrame(() => {
      _seekRafId = null;
      if (_pendingSeekClientX !== null) {
        seekFromClientX(_pendingSeekClientX);
        _pendingSeekClientX = null;
      }
    });
  }
}

// ===== Event handlers =====

el.emptyStateRecordButton.addEventListener('click', () => openRecordModal('fresh'));
el.emptyStateUploadButton.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => {
  const file = /** @type {HTMLInputElement} */ (e.target).files[0];
  if (file) loadUploadedFile(file);
});
el.restartButton.addEventListener('click', () => {
  if (state.isPlaying) pausePlayback();
  jumpToSegmentStart();
});
el.skipForwardButton.addEventListener('click', () => {
  if (state.isPlaying) pausePlayback();
  jumpToSegmentEnd();
});
el.playButton.addEventListener('click', () => { isPlaybackActive() ? pausePlayback() : startPlayback(); });

el.downloadButton.addEventListener('click', openExportModal);
el.splitButton.addEventListener('click', splitAtPlayhead);
el.deleteSegmentButton.addEventListener('click', () => {
  if (state.selectedSegmentIndex >= 0) deleteSegmentByIndex(state.selectedSegmentIndex);
  else showToast('Select a segment to delete');
});
el.undoButton.addEventListener('click', undo);
el.redoButton.addEventListener('click', redo);

// ===== Audio tools (trim silence / loudness normalize / noise removal) =====

const closeTrimPopover = attachToolbarPopover(el.trimSilenceButton, el.trimSilencePopover);
const closeNormalizePopover = attachToolbarPopover(el.normalizeLoudnessButton, el.normalizeLoudnessPopover);

// Seed the popover inputs from state (single source of truth for defaults).
el.trimSilenceThreshold.value = String(state.trimSilence.thresholdDb);
el.trimSilenceMinMs.value = String(state.trimSilence.minSilenceMs);
el.normalizeTargetLufs.value = String(state.loudness.targetLufs);
el.normalizeTruePeak.value = String(state.loudness.truePeakDbtp);

el.trimSilenceThreshold.addEventListener('change', () => {
  const v = Math.round(Number(el.trimSilenceThreshold.value));
  if (Number.isFinite(v)) state.trimSilence.thresholdDb = Math.max(-80, Math.min(0, v));
  el.trimSilenceThreshold.value = String(state.trimSilence.thresholdDb);
});
el.trimSilenceMinMs.addEventListener('change', () => {
  const v = Math.round(Number(el.trimSilenceMinMs.value));
  if (Number.isFinite(v)) state.trimSilence.minSilenceMs = Math.max(50, v);
  el.trimSilenceMinMs.value = String(state.trimSilence.minSilenceMs);
});
el.trimSilenceApply.addEventListener('click', () => {
  closeTrimPopover();
  applyTrimSilence();
});

el.normalizeTargetLufs.addEventListener('change', () => {
  const v = Number(el.normalizeTargetLufs.value);
  if (Number.isFinite(v)) state.loudness.targetLufs = Math.max(-70, Math.min(0, v));
  el.normalizeTargetLufs.value = String(state.loudness.targetLufs);
});
el.normalizeTruePeak.addEventListener('change', () => {
  const v = Number(el.normalizeTruePeak.value);
  if (Number.isFinite(v)) state.loudness.truePeakDbtp = Math.min(0, v);
  el.normalizeTruePeak.value = String(state.loudness.truePeakDbtp);
});
el.normalizeLoudnessApply.addEventListener('click', () => {
  closeNormalizePopover();
  normalizeLoudness();
});

el.removeNoiseButton.addEventListener('click', removeNoise);

const closeAppendMenu = () => { el.appendMenu.hidden = true; };

el.appendButton.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!el.appendMenu.hidden) {
    closeAppendMenu();
    return;
  }
  el.appendMenu.hidden = false;
  const btnRect = el.appendButton.getBoundingClientRect();
  const viewRect = el.editorSection.getBoundingClientRect();
  el.appendMenu.style.right = (viewRect.right - btnRect.right) + 'px';
  el.appendMenu.style.top = (btnRect.bottom - viewRect.top + 4) + 'px';
});

el.appendMenuUpload.addEventListener('click', () => {
  closeAppendMenu();
  el.appendFileInput.click();
});

el.appendMenuRecord.addEventListener('click', () => {
  closeAppendMenu();
  openRecordModal('append');
});

el.appendFileInput.addEventListener('change', (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files[0];
  if (file) appendUploadedFile(file);
  input.value = '';
});

el.exportClose.addEventListener('click', closeExportModal);
el.exportConfirm.addEventListener('click', executeExport);
el.exportModal.addEventListener('click', (e) => {
  if (e.target === el.exportModal) closeExportModal();
});
document.querySelectorAll('.export-format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.export-format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.exportSettings.format = /** @type {HTMLElement} */ (btn).dataset.format;
    renderExportQualityOptions();
    updateExportInfo();
  });
});

el.timelineRulerCanvas.addEventListener('pointerdown', (e) => {
  if (!state.recordedBuffer) return;
  e.preventDefault();
  e.stopPropagation();
  hideSegmentTrash();
  seekFromClientX(e.clientX);
});

el.waveformContainer.addEventListener('contextmenu', (e) => {
  if (!state.recordedBuffer) return;
  const i = getSegmentIndexAtClientPoint(e.clientX, e.clientY);
  if (i < 0) return;
  e.preventDefault();
  showSegmentTrash(i);
  openSegmentContextMenu(i, e.clientX, e.clientY);
});

document.addEventListener('pointerdown', (e) => {
  if (!el.playbackView.hidden && state.selectedSegmentIndex >= 0) {
    const target = /** @type {Node} */ (e.target);
    if (el.waveformContainer.contains(target) || el.deleteSegmentButton.contains(target)) return;
    hideSegmentTrash();
  }
  if (!el.appendMenu.hidden) {
    const target = /** @type {Node} */ (e.target);
    if (target !== el.appendButton && !el.appendMenu.contains(target) && target !== el.appendFileInput) {
      closeAppendMenu();
    }
  }
});

window.addEventListener('mouseup', () => {
  if (state.pendingSegmentDrag) {
    cancelSegmentReorderDrag();
    return;
  }
  if (state.draggingSegmentIndex >= 0) {
    finishSegmentReorderDrag();
    return;
  }
  if (state.draggingPlayhead) {
    state.draggingPlayhead = false;
    removePlayheadCaretDraggingClass();
    flushSeek();
    return;
  }
});

window.addEventListener('touchend', () => {
  if (state.pendingSegmentDrag) {
    cancelSegmentReorderDrag();
    return;
  }
  if (state.draggingSegmentIndex >= 0) {
    finishSegmentReorderDrag();
    return;
  }
  if (state.draggingPlayhead) {
    state.draggingPlayhead = false;
    removePlayheadCaretDraggingClass();
    flushSeek();
  }
});

window.addEventListener('mousemove', (e) => {
  if (state.pendingSegmentDrag) {
    const dx = e.clientX - state.pendingSegmentDrag.startClientX;
    const dy = e.clientY - state.pendingSegmentDrag.startClientY;
    if (dx * dx + dy * dy >= SEGMENT_DRAG_THRESHOLD_CSS_PX * SEGMENT_DRAG_THRESHOLD_CSS_PX) {
      beginSegmentReorderDrag(e.clientX, e.clientY);
    }
    return;
  }
  if (state.draggingSegmentIndex >= 0) {
    applySegmentReorderDrag(e.clientX);
    return;
  }
  if (state.draggingPlayhead) {
    scheduleSeek(e.clientX);
  }
});

window.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) return;
  if (state.pendingSegmentDrag) {
    const dx = t.clientX - state.pendingSegmentDrag.startClientX;
    const dy = t.clientY - state.pendingSegmentDrag.startClientY;
    if (dx * dx + dy * dy >= SEGMENT_DRAG_THRESHOLD_CSS_PX * SEGMENT_DRAG_THRESHOLD_CSS_PX) {
      beginSegmentReorderDrag(t.clientX, t.clientY);
    }
    return;
  }
  if (state.draggingSegmentIndex >= 0) {
    applySegmentReorderDrag(t.clientX);
    return;
  }
  if (state.draggingPlayhead) {
    scheduleSeek(t.clientX);
  }
}, { passive: true });

document.addEventListener('keydown', (e) => {
  const keyTarget = /** @type {HTMLElement} */ (e.target);
  if (keyTarget.tagName === 'INPUT' || keyTarget.tagName === 'TEXTAREA') return;
  const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;
  // Delete/split have keyboard aliases beyond the base key: the base key
  // stays unrestricted (unchanged from before) so existing behavior doesn't
  // shift, while the new aliases each require an exact modifier combo.
  const isDeleteShortcut = e.code === 'Delete'
    || (e.code === 'Backspace' && noMod);
  const isSplitShortcut = (e.code === 'KeyS' && noMod)
    || (e.code === 'KeyB' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey);

  if (el.helpModal.classList.contains('visible')) {
    if (e.code === 'Escape') closeHelpModal();
    return;
  }

  // While the record modal is open it owns the keyboard: editor shortcuts
  // (Space, S, arrows, Delete, undo) must not fire behind the overlay.
  if (el.recordModal.classList.contains('visible')) {
    // While the confirm dialog is open over the record modal, it owns the
    // keyboard (Escape/Enter handled by confirmDialog's own listener).
    if (el.confirmModal.classList.contains('visible')) return;
    if (e.code === 'Space' && noMod) {
      e.preventDefault();
      if (state.isRecording) handleModalStop();
      else if (state.pendingTakeBuffer) togglePreview();
    } else if (e.code === 'KeyR' && noMod) {
      e.preventDefault();
      if (state.isRecording) handleModalStop();
      else if (!state.pendingTakeBuffer && state.micCapabilities) handleModalRecord();
    } else if (e.code === 'Escape') {
      closeRecordModal();
    }
    return;
  }

  // While the export modal is open, block editor shortcuts so the user can't
  // mutate/delete the recording while encoding is in flight.
  if (el.exportModal.classList.contains('visible')) {
    if (e.code === 'Escape') closeExportModal();
    return;
  }

  // Close the segment context menu before any editing shortcut so the menu's
  // stale index doesn't mismatch after operations like delete or paste.
  if (!el.segmentContextMenu.hidden) closeSegmentContextMenu();

  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !el.playbackView.hidden) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey) && !el.playbackView.hidden) {
    e.preventDefault();
    redo();
  } else if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    if (state.selectedSegmentIndex >= 0) copySegmentByIndex(state.selectedSegmentIndex);
    else showToast('Select a segment to copy');
  } else if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    pasteInsertAtPlayhead();
  } else if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    if (state.selectedSegmentIndex >= 0) pasteSegmentAfterIndex(state.selectedSegmentIndex);
    else showToast('Select a segment to paste after');
  } else if (e.code === 'Space' && noMod) {
    if (!el.playbackView.hidden && state.recordedBuffer) {
      e.preventDefault();
      isPlaybackActive() ? pausePlayback() : startPlayback();
    }
  } else if (isSplitShortcut && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    splitAtPlayhead();
  } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !el.playbackView.hidden && state.recordedBuffer) {
    // Discrete 1-second jump — ignore OS key-repeat so held Shift+Arrow
    // doesn't rapid-fire jumps (and doesn't stack with a plain-arrow scrub
    // already in flight if Shift gets pressed mid-hold).
    if (e.repeat) return;
    e.preventDefault();
    stepBySeconds(e.code === 'ArrowRight' ? 1 : -1);
  } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !el.playbackView.hidden && state.recordedBuffer) {
    // Repeat is allowed here (unlike the Shift+Arrow jump) so holding the
    // key steps through segments one at a time, like list navigation.
    e.preventDefault();
    selectAdjacentSegment(e.code === 'ArrowRight' ? 1 : -1);
  } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && noMod && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    arrowKeyDown(e.code);
  } else if (e.code === 'ArrowUp' && noMod && !el.playbackView.hidden && state.recordedBuffer && !el.restartButton.disabled) {
    e.preventDefault();
    el.restartButton.click();
  } else if (e.code === 'ArrowDown' && noMod && !el.playbackView.hidden && state.recordedBuffer && !el.skipForwardButton.disabled) {
    e.preventDefault();
    el.skipForwardButton.click();
  } else if (isDeleteShortcut && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    if (state.selectedSegmentIndex >= 0) deleteSegmentByIndex(state.selectedSegmentIndex);
    else deleteSegmentAtPlayhead();
  } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openRecordModal('fresh');
  } else if (e.code === 'Escape') {
    if (!el.appendMenu.hidden) {
      closeAppendMenu();
    } else if (el.exportModal.classList.contains('visible')) {
      closeExportModal();
    }
  }
});

window.addEventListener('blur', () => {
  if (state.draggingSegmentIndex >= 0) finishSegmentReorderDrag();
  if (state.pendingSegmentDrag) cancelSegmentReorderDrag();
  if (state.draggingPlayhead) {
    state.draggingPlayhead = false;
    removePlayheadCaretDraggingClass();
    flushSeek();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    arrowKeyUp(e.code);
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  invalidateRectCache();
  resizeTimer = setTimeout(() => {
    if (!el.playbackView.hidden && state.recordedBuffer) {
      state.cachedPeaks = null;
      state.cachedPath = null;
      const elapsed = state.isPlaying
        ? state.audioContext.currentTime - state.playbackStartTime + state.playbackOffset
        : state.playbackOffset;
      drawPlaybackWaveform(elapsed / state.recordedBuffer.duration);
    }
  }, RESIZE_DEBOUNCE_MS);
});

// ===== Init =====
initRecordModal();
initHelpModal();
initSegmentContextMenu();
updateEmptyState();
updateSegmentCountDisplay();
setTransportDisabled(true);

if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
  showToast('Browser lacks required audio capture support', true);
}

if (navigator.permissions?.query) {
  navigator.permissions.query({ name: 'microphone' }).then(result => {
    if (result.state === 'granted') {
      connectMicrophone();
    }
  }).catch(() => {});
}
