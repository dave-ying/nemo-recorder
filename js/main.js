import { state } from './state.js';
import { el } from './dom.js';
import { showToast, updateSegmentCountDisplay, setTransportDisabled, updateEmptyState } from './ui.js';
import { connectMicrophone } from './audio.js';
import { loadUploadedFile, appendUploadedFile } from './upload.js';
import { drawPlaybackWaveform, removePlayheadCaretDraggingClass, hideSegmentTrash } from './waveform.js';
import { splitAtPlayhead, deleteSegmentByIndex, deleteSegmentAtPlayhead, undo, redo, jumpToSegmentStart, jumpToSegmentEnd, applySplitHandleDrag, finishSplitHandleDrag, seekFromClientX } from './editing.js';
import { startPlayback, pausePlayback } from './playback.js';
import { arrowKeyDown, arrowKeyUp } from './scrub.js';
import { openExportModal, closeExportModal, renderExportQualityOptions, updateExportInfo, executeExport } from './export.js';
import { openRecordModal, closeRecordModal, handleModalStop, handleModalRecord, togglePreview, initRecordModal } from './record-modal.js';

const RESIZE_DEBOUNCE_MS = 120;

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
el.playButton.addEventListener('click', () => { state.isPlaying ? pausePlayback() : startPlayback(); });

el.downloadButton.addEventListener('click', openExportModal);
el.splitButton.addEventListener('click', splitAtPlayhead);
el.deleteButton.addEventListener('click', deleteSegmentAtPlayhead);
el.undoButton.addEventListener('click', undo);
el.redoButton.addEventListener('click', redo);
el.transportUploadButton.addEventListener('click', () => el.appendFileInput.click());
el.transportRecordButton.addEventListener('click', () => openRecordModal('append'));

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

el.playheadScissors.addEventListener('click', (e) => {
  e.stopPropagation();
  splitAtPlayhead();
});
el.playheadScissors.addEventListener('mousedown', (e) => { e.stopPropagation(); });

el.qualityModalClose.addEventListener('click', () => {
  el.qualityModal.classList.remove('visible');
});

el.qualityModal.addEventListener('click', (e) => {
  if (e.target === el.qualityModal) el.qualityModal.classList.remove('visible');
});

el.timelineRulerCanvas.addEventListener('pointerdown', (e) => {
  if (!state.recordedBuffer) return;
  e.preventDefault();
  e.stopPropagation();
  hideSegmentTrash();
  seekFromClientX(e.clientX);
});

el.segmentTrash.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.selectedSegmentIndex >= 0) deleteSegmentByIndex(state.selectedSegmentIndex);
});

document.addEventListener('pointerdown', (e) => {
  if (!el.playbackView.hidden && state.selectedSegmentIndex >= 0) {
    const target = /** @type {Node} */ (e.target);
    if (el.waveformContainer.contains(target) || target === el.segmentTrash || el.segmentTrash.contains(target)) return;
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
  if (state.draggingHandleIndex >= 0) {
    finishSplitHandleDrag();
    return;
  }
  if (state.draggingPlayhead) {
    state.draggingPlayhead = false;
    removePlayheadCaretDraggingClass();
    return;
  }
});

window.addEventListener('touchend', () => {
  if (state.draggingPlayhead) {
    state.draggingPlayhead = false;
    removePlayheadCaretDraggingClass();
  }
});

window.addEventListener('mousemove', (e) => {
  if (state.draggingHandleIndex >= 0) {
    applySplitHandleDrag(e.clientX);
    return;
  }
  if (state.draggingPlayhead) {
    seekFromClientX(e.clientX);
  }
});

window.addEventListener('touchmove', (e) => {
  if (state.draggingPlayhead) {
    seekFromClientX(e.touches[0].clientX);
  }
}, { passive: true });

document.addEventListener('keydown', (e) => {
  const keyTarget = /** @type {HTMLElement} */ (e.target);
  if (keyTarget.tagName === 'INPUT' || keyTarget.tagName === 'TEXTAREA') return;
  const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;

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

  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !el.playbackView.hidden) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey) && !el.playbackView.hidden) {
    e.preventDefault();
    redo();
  } else if (e.code === 'Space' && noMod) {
    if (!el.playbackView.hidden && state.recordedBuffer) {
      e.preventDefault();
      state.isPlaying ? pausePlayback() : startPlayback();
    }
  } else if (e.code === 'KeyS' && noMod && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    splitAtPlayhead();
  } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && noMod && !el.playbackView.hidden && state.recordedBuffer) {
    e.preventDefault();
    arrowKeyDown(e.code);
  } else if (e.code === 'ArrowUp' && noMod && !el.playbackView.hidden && state.recordedBuffer && !el.restartButton.disabled) {
    e.preventDefault();
    el.restartButton.click();
  } else if (e.code === 'ArrowDown' && noMod && !el.playbackView.hidden && state.recordedBuffer && !el.skipForwardButton.disabled) {
    e.preventDefault();
    el.skipForwardButton.click();
  } else if (e.code === 'Delete' && !el.playbackView.hidden && state.recordedBuffer) {
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
    } else if (el.qualityModal.classList.contains('visible')) {
      el.qualityModal.classList.remove('visible');
    }
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
