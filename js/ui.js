import { el } from './dom.js';
import { state } from './state.js';

const TOAST_DURATION_MS = 3500;
let toastTimer = null;

export const showToast = (message, isError = false) => {
  el.toastMessage.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), TOAST_DURATION_MS);
};

export function confirmDialog({
  title = 'Confirm',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = title;
    el.confirmMessage.textContent = message;
    el.confirmOk.textContent = confirmLabel;
    el.confirmCancel.textContent = cancelLabel;
    el.confirmOk.classList.toggle('btn-danger', danger);
    el.confirmOk.classList.toggle('btn-primary', !danger);
    el.confirmModal.classList.add('visible');

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      el.confirmModal.classList.remove('visible');
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      el.confirmModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target === el.confirmModal) onCancel(); };
    const onKey = (e) => {
      if (e.code === 'Escape') { e.preventDefault(); onCancel(); }
    };

    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
    el.confirmModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

export const resetReadouts = () => {
  el.bitrateReadout.textContent = '— kbps';
};

export const updateBitrate = () => {
  const { sampleRate, bitDepth, channels } = state.settings;
  el.bitrateReadout.textContent = `${Math.round(sampleRate * bitDepth * channels / 1000).toLocaleString()} kbps`;
};

export const updateSegmentCountDisplay = () => {
  if (!state.recordedBuffer) {
    el.segmentCountEl.classList.add('hidden');
  } else {
    el.segmentCountEl.classList.remove('hidden');
    el.segmentCountEl.textContent = `${state.segments.length} segments`;
  }
};

export const setTransportDisabled = (disabled) => {
  el.restartButton.disabled = disabled;
  el.skipForwardButton.disabled = disabled;
  el.playButton.disabled = disabled;
  el.splitButton.disabled = disabled;
  el.trimSilenceButton.disabled = disabled;
};

/**
 * Wire a toolbar button to toggle a popover anchored beneath it, dismissing
 * on outside pointerdown, Escape, window blur, or resize — matching the
 * segment context menu's dismissal behavior.
 *
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} popover
 * @returns {() => void} close - programmatically hide the popover
 */
export const attachToolbarPopover = (button, popover) => {
  const anchor = button.parentElement;
  const close = () => { popover.hidden = true; };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.hidden = !popover.hidden;
  });
  document.addEventListener('pointerdown', (e) => {
    if (popover.hidden) return;
    if (anchor && !anchor.contains(/** @type {Node} */ (e.target))) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!popover.hidden && e.code === 'Escape') {
      // stopImmediatePropagation: main.js's keydown handler lives on the same
      // node (document), so plain stopPropagation wouldn't reach it.
      e.stopImmediatePropagation();
      close();
    }
  });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  return close;
};

export const updateEmptyState = () => {
  const empty = !state.recordedBuffer && !state.isRecording;
  el.emptyState.hidden = !empty;
  el.downloadButton.hidden = !state.recordedBuffer;
  el.playheadCaretTop.hidden = empty;
  el.editorTopBar.hidden = empty;
  el.transportBar.hidden = empty;
};

export const renderQualityOptions = () => {
  if (!state.micCapabilities) return;

  const createOptions = (container, values, currentValue, labels, settingKey) => {
    container.innerHTML = '';
    values.forEach(val => {
      const btn = document.createElement('button');
      btn.className = 'quality-option' + (val === currentValue ? ' active' : '');
      btn.textContent = labels[val] || val;
      btn.dataset.value = val;
      btn.addEventListener('click', () => {
        state.settings[settingKey] = val;
        container.querySelectorAll('.quality-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateBitrate();
      });
      container.appendChild(btn);
    });
  };

  createOptions(el.rateOptions, state.micCapabilities.supportedRates, state.settings.sampleRate,
    { 44100: '44.1k', 48000: '48k', 96000: '96k', 192000: '192k' }, 'sampleRate');
  createOptions(el.bitOptions, state.micCapabilities.supportedBitDepths, state.settings.bitDepth,
    { 16: '16-bit', 24: '24-bit', 32: '32-bit f' }, 'bitDepth');
  createOptions(el.chOptions, state.micCapabilities.supportedChannels, state.settings.channels,
    { 1: 'Mono', 2: 'Stereo' }, 'channels');
};

// The picker is the dropdown in the mic status chip. It swaps in for the
// plain mic-name text only when there's an actual choice to make AND we're in
// a state where the device can be changed — connected with 2+ mics, not mid-
// recording, not reviewing a take. Every other state (disconnected, single
// mic, recording, review) falls back to the static name so the chip always
// reads as a single coherent line.
export const renderMicDeviceOptions = () => {
  const showPicker = !!(state.micCapabilities
    && state.micDevices
    && state.micDevices.length >= 2
    && !state.isRecording
    && !state.pendingTakeBuffer);
  el.micDeviceSelect.hidden = !showPicker;
  el.micName.hidden = showPicker;

  if (!state.micDevices || state.micDevices.length < 2) return;
  el.micDeviceSelect.innerHTML = '';
  state.micDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    if (d.deviceId === state.micDeviceId) opt.selected = true;
    el.micDeviceSelect.appendChild(opt);
  });
  el.micDeviceSelect.title = state.micLabel || '';
};
