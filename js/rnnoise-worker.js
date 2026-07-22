import createRNNWasmModule from '../vendor/rnnoise/rnnoise.js';

const FRAME_SIZE = 480;
// The RNNoise model was trained on 16-bit PCM magnitudes (the reference
// denoise.c feeds raw `short` values as floats). Feeding [-1, 1] floats makes
// everything look ~90 dB quieter and the suppressor does nothing, so scale
// on the way in and unscale on the way out.
const PCM_SCALE = 32768;
let modulePromise = null;
let module = null;

async function getModule() {
  if (!modulePromise) {
    modulePromise = createRNNWasmModule({ locateFile: () => new URL('../vendor/rnnoise/rnnoise.wasm', import.meta.url).href });
  }
  module = await modulePromise;
  return module;
}

/**
 * Run RNNoise over a mono 48 kHz sample array, frame by frame (480-sample
 * frames, zero-padding the tail). `wasm` is injectable so tests can pass a
 * module instance directly (the worker's lazy singleton is used otherwise).
 *
 * @param {Float32Array} samples
 * @param {*} [wasm]
 * @returns {Float32Array}
 */
export function processSamples(samples, wasm = module) {
  if (!wasm) throw new Error('RNNoise module not initialized');
  const output = new Float32Array(samples.length);
  const state = wasm._rnnoise_create();
  const inputPtr = wasm._malloc(FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT);
  const frame = new Float32Array(wasm.HEAPF32.buffer, inputPtr, FRAME_SIZE);
  try {
    for (let offset = 0; offset < samples.length; offset += FRAME_SIZE) {
      frame.fill(0);
      const size = Math.min(FRAME_SIZE, samples.length - offset);
      frame.set(samples.subarray(offset, offset + size));
      for (let i = 0; i < size; i++) frame[i] *= PCM_SCALE;
      wasm._rnnoise_process_frame(state, inputPtr, inputPtr);
      for (let i = 0; i < size; i++) output[offset + i] = frame[i] / PCM_SCALE;
    }
  } finally {
    wasm._rnnoise_destroy(state);
    wasm._free(inputPtr);
  }
  return output;
}

// Worker wiring — guarded so the module stays importable in Node for tests.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async ({ data }) => {
    if (data.type !== 'denoise') return;
    try {
      if (data.sampleRate !== 48000) throw new Error('RNNoise requires 48 kHz input');
      const samples = new Float32Array(data.samples);
      await getModule();
      const output = processSamples(samples);
      const response = { type: 'denoised', id: data.id, samples: output.buffer };
      // @ts-ignore - TS overload resolution picks WindowPostMessageOptions instead of Transferable[]
      self.postMessage(response, [output.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', id: data.id, error: error.message });
    }
  };
}
