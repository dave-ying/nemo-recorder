import { state } from './state.js';
import { el } from './dom.js';
import { showToast } from './ui.js';
import { loadBufferAsRecording, appendBufferToRecording } from './editing.js';

async function decodeUploadedAudio(file) {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new AudioContext();
  }
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  const arrayBuffer = await file.arrayBuffer();
  return state.audioContext.decodeAudioData(arrayBuffer);
}

export async function loadUploadedFile(file) {
  el.emptyStateUploadButton.disabled = true;

  try {
    const buffer = await decodeUploadedAudio(file);
    loadBufferAsRecording(buffer, `Loaded "${file.name}" — lossless PCM ready`);
  } catch (err) {
    showToast('Could not read that file — unsupported or corrupt audio', true);
    console.warn('[nemo-recorder]', err.message);
  } finally {
    el.emptyStateUploadButton.disabled = false;
    el.fileInput.value = '';
  }
}

export async function appendUploadedFile(file) {
  try {
    const buffer = await decodeUploadedAudio(file);
    await appendBufferToRecording(buffer, `Appended "${file.name}"`);
  } catch (err) {
    showToast('Could not read that file — unsupported or corrupt audio', true);
    console.warn('[nemo-recorder]', err.message);
  }
}
