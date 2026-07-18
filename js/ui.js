import { el, $ } from './dom.js';
import { READOUT_IDS, state } from './state.js';
import { formatSize } from './utils.js';

const TOAST_DURATION_MS = 3500;
let toastTimer = null;

export const showToast = (message, isError = false) => {
  el.toastMessage.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), TOAST_DURATION_MS);
};

export const showView = (name) => {
  el.connectView.hidden = name !== 'connect';
  el.readyView.hidden = name !== 'ready';
  el.recordingView.hidden = name !== 'recording';
  el.playbackView.hidden = name !== 'playback';
  if (name !== 'playback') {
    el.playheadScissors.classList.remove('visible');
    el.segmentTrash.classList.remove('visible');
  }
};

export const setReadoutActive = (active) => {
  for (const id of READOUT_IDS) $(id).classList.toggle('active', active);
};

export const resetReadouts = () => {
  el.readoutDuration.innerHTML = '—<span class="unit">s</span>';
  el.readoutRate.innerHTML = '—<span class="unit">Hz</span>';
  el.readoutBit.innerHTML = '—<span class="unit">bit</span>';
  el.readoutCh.innerHTML = '—';
  el.readoutSize.innerHTML = '—<span class="unit">MB</span>';
  setReadoutActive(false);
  el.bitrateReadout.textContent = '— kbps';
};

export const updateBitrate = () => {
  const { sampleRate, bitDepth, channels } = state.settings;
  el.bitrateReadout.textContent = `${Math.round(sampleRate * bitDepth * channels / 1000).toLocaleString()} kbps`;
};

export const updateReadouts = (buffer) => {
  const duration = buffer.length / buffer.sampleRate;
  const bytesPerSample = state.settings.bitDepth / 8;
  const fileSize = buffer.length * buffer.numberOfChannels * bytesPerSample;
  const [sizeVal, sizeUnit] = formatSize(fileSize).split(' ');
  el.readoutDuration.innerHTML = `${duration.toFixed(3)}<span class="unit">s</span>`;
  el.readoutRate.innerHTML = `${buffer.sampleRate}<span class="unit">Hz</span>`;
  el.readoutBit.innerHTML = `${state.settings.bitDepth === 32 ? '32 f' : state.settings.bitDepth}<span class="unit">bit</span>`;
  el.readoutCh.innerHTML = buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo';
  el.readoutSize.innerHTML = `${sizeVal}<span class="unit">${sizeUnit || ''}</span>`;
  setReadoutActive(true);
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
  el.playButton.disabled = disabled;
  el.splitButton.disabled = disabled;
  el.deleteButton.disabled = disabled;
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
