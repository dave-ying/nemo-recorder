import { state } from './state.js';
import { el } from './dom.js';
import { pushHistory } from './history.js';
import { rebuildPlaybackBuffer } from './editing.js';
import { drawPlaybackWaveform } from './waveform.js';
import { showToast } from './ui.js';
import { pausePlayback } from './playback.js';

// RNNoise background-noise removal. The WASM runs in a lazily-spawned
// module-type Worker (see rnnoise-worker.js); this file owns request/response
// correlation, per-channel resampling (RNNoise needs mono 48 kHz), and the
// editor-state integration (history, rebuild, busy UI).

const RNNOISE_RATE = 48000;
const SPINNER_SVG = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

let worker = null;
let requestId = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./rnnoise-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(new Float32Array(data.samples));
    };
    worker.onerror = (event) => {
      for (const request of pending.values()) request.reject(new Error(event.message || 'RNNoise worker failed'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

// samples must be mono 48 kHz. Resolves to the denoised array (same length).
function denoiseAt48k(samples) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const transferable = samples.buffer.slice(0);
    getWorker().postMessage({ type: 'denoise', id, samples: transferable, sampleRate: RNNOISE_RATE }, [transferable]);
  });
}

// High-quality resample via OfflineAudioContext (same approach as
// editing.js's adaptBuffer) — avoids the audible aliasing of the naive
// linear interpolator.
async function resampleChannel(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) return samples;
  const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const ctx = new OfflineAudioContext(1, length, targetRate);
  const buf = ctx.createBuffer(1, samples.length, sourceRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function setBusy(busy) {
  state.denoise.processing = busy;
  const button = el.removeNoiseButton;
  button.disabled = busy || !state.originalBuffer;
  if (busy) {
    if (!button.dataset.icon) button.dataset.icon = button.innerHTML;
    button.innerHTML = SPINNER_SVG;
    button.title = 'Removing noise...';
  } else {
    if (button.dataset.icon) button.innerHTML = button.dataset.icon;
    button.title = 'Remove background noise';
  }
}

export async function removeNoise() {
  if (!state.originalBuffer || !state.audioContext) return;
  if (state.denoise.processing) return;
  if (state.isPlaying) pausePlayback();

  const buffer = state.originalBuffer;
  const rate = buffer.sampleRate;
  const numCh = buffer.numberOfChannels;
  setBusy(true);
  try {
    // Process each channel independently so stereo content stays stereo.
    const processedChannels = [];
    for (let c = 0; c < numCh; c++) {
      const at48 = await resampleChannel(buffer.getChannelData(c), rate, RNNOISE_RATE);
      const denoised48 = await denoiseAt48k(at48);
      processedChannels.push(await resampleChannel(denoised48, RNNOISE_RATE, rate));
    }

    // The wait above can take seconds. If the user replaced/extended the PCM
    // meanwhile (paste, append, new upload), applying our result would
    // clobber that edit — bail out instead. Segment-only edits (split/delete)
    // keep the same buffer object and same length, so they stay valid.
    if (state.originalBuffer !== buffer) {
      showToast('Audio changed while removing noise — nothing applied', true);
      return;
    }

    // Pin the pre-denoise buffer so undo restores the exact noisy PCM.
    pushHistory(true);
    const replacement = state.audioContext.createBuffer(numCh, buffer.length, rate);
    for (let c = 0; c < numCh; c++) {
      // Resample round-trips can drift by a sample; fit exactly to the
      // original length, holding the last sample rather than zero-padding.
      const fitted = new Float32Array(buffer.length);
      const src = processedChannels[c];
      const copyLen = Math.min(src.length, buffer.length);
      fitted.set(src.subarray(0, copyLen));
      if (copyLen < buffer.length && copyLen > 0) fitted.fill(src[copyLen - 1], copyLen);
      replacement.copyToChannel(fitted, c);
    }
    state.originalBuffer = replacement;
    state.bufferEpoch++;
    rebuildPlaybackBuffer();
    drawPlaybackWaveform(state.recordedBuffer ? state.playbackOffset / state.recordedBuffer.duration : 0);
    showToast('Noise removed');
  } catch (error) {
    showToast(`Noise removal failed: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}
