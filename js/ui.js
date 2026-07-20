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

export const updateHeaderState = () => {
  const connected = !!state.micCapabilities;
  el.connectButton.hidden = connected;
  el.headerMicInfo.hidden = !connected;
  el.recordButton.hidden = !connected;
};

export const resetReadouts = () => {
  el.bitrateReadout.textContent = '— kbps';
};

export const updateBitrate = () => {
  const { sampleRate, bitDepth, channels } = state.settings;
  el.bitrateReadout.textContent = `${Math.round(sampleRate * bitDepth * channels / 1000).toLocaleString()} kbps`;
};

export const updateSegmentCountDisplay = () => {
  if (!state.recordedBuffer || state.segments.length <= 1) {
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
  el.deleteButton.disabled = disabled;
};

export const setRecordingUI = (active) => {
  el.liveMeterBar.hidden = !active;
  el.liveCanvas.hidden = !active;
  el.stopButton.hidden = !active;
  el.playButton.hidden = active;
  el.timelineRulerCanvas.hidden = active;
  el.playheadCaretTop.style.display = active ? 'none' : '';
  el.playheadScissors.classList.remove('visible');
  el.segmentTrash.classList.remove('visible');
  if (active) {
    el.emptyState.hidden = true;
    setTransportDisabled(true);
    el.undoButton.disabled = true;
    el.redoButton.disabled = true;
  }
};

export const updateEmptyState = () => {
  const empty = !state.recordedBuffer && !state.isRecording;
  el.emptyState.hidden = !empty;
  el.downloadButton.hidden = !state.recordedBuffer;
  el.playheadCaretTop.style.display = empty ? 'none' : '';
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
