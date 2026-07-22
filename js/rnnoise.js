// RNNoise worker primitives. The WASM runs in a lazily-spawned module-type
// Worker (see rnnoise-worker.js); this file owns request/response correlation
// and per-channel resampling (RNNoise needs mono 48 kHz). It is intentionally
// free of app-state/DOM imports so js/effects.js (and Node) can import it
// without cycles — the noise-removal effect's orchestration lives there.

const RNNOISE_RATE = 48000;

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
    // samples.slice(0) — NOT samples.buffer.slice(0): a subarray's buffer is
    // the whole backing store, so the latter would ignore the region offset
    // (effects.js passes region slices for appended audio).
    const transferable = samples.slice(0).buffer;
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

/**
 * Denoise one channel of PCM: resample to 48 kHz, run RNNoise, resample back.
 * The round-trip can drift by a sample, so the result may be one sample
 * longer or shorter than the input — callers fit it to the exact length.
 *
 * @param {Float32Array} samples - mono PCM at `sampleRate`
 * @param {number} sampleRate
 * @returns {Promise<Float32Array>} denoised samples at `sampleRate`
 */
export async function denoiseChannel(samples, sampleRate) {
  const at48 = await resampleChannel(samples, sampleRate, RNNOISE_RATE);
  const denoised48 = await denoiseAt48k(at48);
  return resampleChannel(denoised48, RNNOISE_RATE, sampleRate);
}
