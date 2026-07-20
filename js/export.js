import { state } from './state.js';
import { el } from './dom.js';
import { formatSize } from './utils.js';
import { showToast } from './ui.js';
import { wavWorkerCode, mp3WorkerCode } from './worker-code.js';

const URL_REVOKE_DELAY_MS = 2000;
const EXPORT_BUTTON_HTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Export & Download`;

/** @type {Worker|null} */
let wavWorker = null;
/** @type {Worker|null} */
let mp3Worker = null;

function resetExportUI() {
  state.isDownloading = false;
  el.exportConfirm.disabled = false;
  el.exportConfirm.innerHTML = EXPORT_BUTTON_HTML;
}

function failExport(message) {
  resetExportUI();
  closeExportModal();
  showToast(message, true);
}

// Workers are created lazily on first export so page load stays cheap, and only
// the worker for the format actually being exported is ever spawned.
function getExportWorker(format) {
  if (format === 'wav') {
    if (!wavWorker) {
      wavWorker = new Worker(URL.createObjectURL(new Blob([wavWorkerCode], { type: 'application/javascript' })));
      wavWorker.onmessage = (e) => handleExportResult(e, 'wav');
      wavWorker.onerror = () => failExport('Export failed — try again');
    }
    return wavWorker;
  }
  if (!mp3Worker) {
    mp3Worker = new Worker(URL.createObjectURL(new Blob([mp3WorkerCode], { type: 'application/javascript' })));
    mp3Worker.onmessage = (e) => handleExportResult(e, 'mp3');
    mp3Worker.onerror = () => failExport('Export failed — try again');
  }
  return mp3Worker;
}

function handleExportResult(e, format) {
  if (e.data.error) {
    failExport(`Export failed: ${e.data.error}`);
    return;
  }
  const blob = e.data.blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = format;
  const label = format === 'wav'
    ? `${state.recordedBuffer.sampleRate}hz_${state.exportSettings.quality}bit`
    : `${state.exportSettings.quality}kbps`;
  const chLabel = state.recordedBuffer.numberOfChannels === 1 ? 'mono' : 'stereo';
  a.href = url;
  a.download = `audio_${ts}_${label}_${chLabel}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), URL_REVOKE_DELAY_MS);
  resetExportUI();
  closeExportModal();
  showToast(`Downloaded ${formatSize(blob.size)}`);
}

export function openExportModal() {
  if (!state.recordedBuffer) return;
  renderExportQualityOptions();
  updateExportInfo();
  el.exportModal.classList.add('visible');
}

export function closeExportModal() {
  el.exportModal.classList.remove('visible');
}

export function renderExportQualityOptions() {
  const grid = el.exportQualityGrid;
  grid.innerHTML = '';
  let options = [];

  if (state.exportSettings.format === 'wav') {
    options = [16, 24, 32];
  } else if (state.exportSettings.format === 'mp3') {
    options = [64, 96, 128, 192, 256, 320];
  }

  state.exportSettings.quality = options[options.length - 1];

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'export-quality-btn' + (opt === state.exportSettings.quality ? ' active' : '');
    btn.textContent = state.exportSettings.format === 'wav' ? `${opt}-bit` : `${opt} kbps`;
    btn.dataset.value = opt;
    btn.addEventListener('click', () => {
      state.exportSettings.quality = opt;
      grid.querySelectorAll('.export-quality-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateExportInfo();
    });
    grid.appendChild(btn);
  });
}

export function calculateExportSize(format, quality) {
  if (!state.recordedBuffer) return 0;
  const duration = state.recordedBuffer.duration;
  const channels = state.recordedBuffer.numberOfChannels;
  if (format === 'wav') {
    return duration * state.recordedBuffer.sampleRate * channels * (quality / 8);
  } else if (format === 'mp3') {
    return duration * (quality * 1000) / 8;
  }
  return 0;
}

export function updateExportInfo() {
  const size = calculateExportSize(state.exportSettings.format, state.exportSettings.quality);
  el.exportSize.textContent = formatSize(size);
  if (state.exportSettings.format === 'wav') {
    el.exportDetail.textContent = `${state.exportSettings.quality}-bit PCM`;
  } else if (state.exportSettings.format === 'mp3') {
    el.exportDetail.textContent = `MP3 ${state.exportSettings.quality} kbps`;
  }
}

export function executeExport() {
  if (!state.recordedBuffer || state.isDownloading) return;
  state.isDownloading = true;

  el.exportConfirm.disabled = true;
  el.exportConfirm.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Encoding...`;

  const channels = [];
  for (let c = 0; c < state.recordedBuffer.numberOfChannels; c++) {
    channels.push(state.recordedBuffer.getChannelData(c).slice());
  }

  const worker = getExportWorker(state.exportSettings.format);
  if (state.exportSettings.format === 'wav') {
    worker.postMessage({
      channels: channels,
      sampleRate: state.recordedBuffer.sampleRate,
      bitDepth: state.exportSettings.quality
    }, channels.map(c => c.buffer));
  } else if (state.exportSettings.format === 'mp3') {
    worker.postMessage({
      channels: channels,
      sampleRate: state.recordedBuffer.sampleRate,
      bitrate: state.exportSettings.quality
    }, channels.map(c => c.buffer));
  }
}
