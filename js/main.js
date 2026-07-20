import { state, SEGMENT_GAP_CSS_PX } from './state.js';
import { el } from './dom.js';
import { showToast, updateSegmentCountDisplay, setTransportDisabled, updateHeaderState, updateEmptyState } from './ui.js';
import { connectMicrophone, disconnectMicrophone, startRecording, stopRecording } from './audio.js';
import { loadUploadedFile, appendUploadedFile } from './upload.js';
import { drawPlaybackWaveform, removeDraggingClass, removePlayheadCaretDraggingClass, visualRatioToAudioRatioWithState, hideSegmentTrash, findSegmentAtSample } from './waveform.js';
import { splitAtPlayhead, deleteSegmentByIndex, deleteSegmentAtPlayhead, rebuildPlaybackBuffer, undo, redo } from './editing.js';
import { startPlayback, pausePlayback, seekToRatio } from './playback.js';
import { arrowKeyDown, arrowKeyUp } from './scrub.js';
import { formatTime } from './utils.js';
import { openExportModal, closeExportModal, renderExportQualityOptions, updateExportInfo, executeExport } from './export.js';

const RESIZE_DEBOUNCE_MS = 120;

// ===== Event handlers =====

el.connectButton.addEventListener('click', connectMicrophone);
el.disconnectButton.addEventListener('click', disconnectMicrophone);
el.emptyStateRecordButton.addEventListener('click', async () => {
  if (state.isRecording) return;
  if (!state.micCapabilities) await connectMicrophone();
  if (state.micCapabilities) startRecording();
});
el.emptyStateUploadButton.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => {
  const file = /** @type {HTMLInputElement} */ (e.target).files[0];
  if (file) loadUploadedFile(file);
});
el.recordButton.addEventListener('click', () => { if (!state.isRecording) startRecording(); });
el.stopButton.addEventListener('click', () => { if (state.isRecording) stopRecording(); });
el.restartButton.addEventListener('click', () => {
  if (state.isPlaying) pausePlayback();
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
});
el.skipForwardButton.addEventListener('click', () => {
  if (state.isPlaying) pausePlayback();
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
});
el.playButton.addEventListener('click', () => { state.isPlaying ? pausePlayback() : startPlayback(); });

el.downloadButton.addEventListener('click', openExportModal);
el.splitButton.addEventListener('click', splitAtPlayhead);
el.deleteButton.addEventListener('click', deleteSegmentAtPlayhead);
el.undoButton.addEventListener('click', undo);
el.redoButton.addEventListener('click', redo);

const closeAppendMenu = () => { el.appendMenu.hidden = true; };

el.appendButton.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!el.appendMenu.hidden) {
    closeAppendMenu();
    return;
  }
  el.appendMenu.hidden = false;
  const btnRect = el.appendButton.getBoundingClientRect();
  const viewRect = el.playbackView.getBoundingClientRect();
  el.appendMenu.style.right = (viewRect.right - btnRect.right) + 'px';
  el.appendMenu.style.top = (btnRect.bottom - viewRect.top + 4) + 'px';
});

el.appendMenuUpload.addEventListener('click', () => {
  closeAppendMenu();
  el.appendFileInput.click();
});

el.appendMenuRecord.addEventListener('click', () => {
  closeAppendMenu();
  state.appendOnStop = true;
  startRecording();
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

el.settingsButton.addEventListener('click', () => {
  el.qualityModal.classList.add('visible');
});

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
  const rect = el.waveformContainer.getBoundingClientRect();
  const visualRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const ratio = visualRatioToAudioRatioWithState(visualRatio, rect.width, SEGMENT_GAP_CSS_PX);
  seekToRatio(ratio);
});

el.segmentTrash.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.hoveredSegmentIndex >= 0) deleteSegmentByIndex(state.hoveredSegmentIndex);
});

document.addEventListener('pointerdown', (e) => {
  if (!el.playbackView.hidden && state.hoveredSegmentIndex >= 0) {
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
    const snap = state._dragSnapshot;
    if (!snap) return;
    const rect = el.waveformContainer.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    let newAcc = ratio * snap.totalSamples;
    newAcc = Math.max(snap.minAcc, Math.min(snap.maxAcc, newAcc));
    const newSegIEnd = snap.segIStart + (newAcc - snap.accBeforeSegI);
    state.segments[snap.handleIndex].end = newSegIEnd;
    state.segments[snap.handleIndex + 1].start = newSegIEnd;
    const playheadRatio = state.recordedBuffer.duration > 0
      ? state.playbackOffset / state.recordedBuffer.duration
      : 0;
    drawPlaybackWaveform(playheadRatio);
    return;
  }
  if (state.draggingPlayhead && state.recordedBuffer) {
    const rect = el.waveformContainer.getBoundingClientRect();
    const visualRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ratio = visualRatioToAudioRatioWithState(visualRatio, rect.width, SEGMENT_GAP_CSS_PX);
    seekToRatio(ratio);
  }
});

window.addEventListener('touchmove', (e) => {
  if (state.draggingPlayhead && state.recordedBuffer) {
    const rect = el.waveformContainer.getBoundingClientRect();
    const visualRatio = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
    const ratio = visualRatioToAudioRatioWithState(visualRatio, rect.width, SEGMENT_GAP_CSS_PX);
    seekToRatio(ratio);
  }
}, { passive: true });

document.addEventListener('keydown', (e) => {
  const keyTarget = /** @type {HTMLElement} */ (e.target);
  if (keyTarget.tagName === 'INPUT' || keyTarget.tagName === 'TEXTAREA') return;
  const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;

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
    if (state.hoveredSegmentIndex >= 0) deleteSegmentByIndex(state.hoveredSegmentIndex);
    else deleteSegmentAtPlayhead();
  } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) {
    if (state.micCapabilities && !state.isRecording) { e.preventDefault(); startRecording(); }
    else if (state.isRecording) { e.preventDefault(); stopRecording(); }
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
updateHeaderState();
updateEmptyState();
updateSegmentCountDisplay();
setTransportDisabled(true);

if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
  showToast('Browser lacks required audio capture support', true);
  el.connectButton.disabled = true;
  el.connectButton.style.opacity = '0.4';
}

if (navigator.permissions?.query) {
  navigator.permissions.query({ name: 'microphone' }).then(result => {
    if (result.state === 'granted') {
      connectMicrophone();
    }
  }).catch(() => {});
}
