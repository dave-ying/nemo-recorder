import { state } from './state.js';
import { el } from './dom.js';
import { showToast } from './ui.js';
import { loadBufferAsRecording, appendBufferToRecording } from './editing.js';
import { unsupportedFormatError, formatSize } from './utils.js';

// decodeAudioData inflates files to raw Float32 PCM in RAM — a highly compressed
// multi-hour file can balloon past the tab's memory limit and crash it.
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
let isImporting = false;

// Detect by engine, not brand: Apple forces WebKit on every iOS browser (Safari,
// Chrome/CriOS, Firefox/FxiOS, Edge/EdgiOS), and those all lack OGG/Opus/WebM
// decoders; Chromium/Firefox elsewhere lack AIFF/CAF. Desktop and Android
// Chromium browsers all carry a "chrom" UA token, so this splits correctly.
const isWebKit = /applewebkit/i.test(navigator.userAgent) && !/chrom|opr/i.test(navigator.userAgent);

const showOversizedToast = (file) => {
  showToast(`"${file.name}" (${formatSize(file.size)}) is too large to decode in a browser tab — try a file under ${formatSize(MAX_IMPORT_BYTES)}`, true);
};

async function decodeUploadedAudio(file) {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new AudioContext();
  }
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  const arrayBuffer = await file.arrayBuffer();
  return state.audioContext.decodeAudioData(arrayBuffer);
}

export async function loadUploadedFile(file) {
  if (isImporting) return;
  if (file.size > MAX_IMPORT_BYTES) {
    showOversizedToast(file);
    el.fileInput.value = '';
    return;
  }
  isImporting = true;
  el.emptyStateUploadButton.disabled = true;

  try {
    const buffer = await decodeUploadedAudio(file);
    await loadBufferAsRecording(buffer, `Loaded "${file.name}" — lossless PCM ready`);
  } catch (err) {
    showToast(unsupportedFormatError(file.name, isWebKit), true);
    console.warn('[nemo-audio]', err.message);
  } finally {
    isImporting = false;
    el.emptyStateUploadButton.disabled = false;
    el.fileInput.value = '';
  }
}

export async function appendUploadedFile(file) {
  if (isImporting) return;
  if (file.size > MAX_IMPORT_BYTES) {
    showOversizedToast(file);
    return;
  }
  isImporting = true;
  try {
    const buffer = await decodeUploadedAudio(file);
    await appendBufferToRecording(buffer, `Appended "${file.name}"`);
  } catch (err) {
    showToast(unsupportedFormatError(file.name, isWebKit), true);
    console.warn('[nemo-audio]', err.message);
  } finally {
    isImporting = false;
  }
}
