import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createRNNWasmModule from '../vendor/rnnoise/rnnoise.js';
import { processSamples } from '../js/rnnoise-worker.js';

// Real end-to-end tests of the vendored RNNoise WASM in Node: instantiate the
// module with the wasm binary injected (bypassing fetch) and run the same
// frame loop the worker uses.

const wasmBinary = await readFile(new URL('../vendor/rnnoise/rnnoise.wasm', import.meta.url));
const module = await createRNNWasmModule({ wasmBinary });

const rms = (samples, start = 0, end = samples.length) => {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - start));
};

// Deterministic white noise (LCG) so the test never flakes.
function makeNoise(length, amplitude, seed = 12345) {
  const out = new Float32Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amplitude * ((s / 0xffffffff) * 2 - 1);
  }
  return out;
}

test('stationary noise is strongly suppressed once the model converges', () => {
  // 5 s of white noise at a typical ambience level. RNNoise needs a few
  // seconds of stationary noise to build its estimate, so check the last
  // second only — suppression there should be dramatic (> 20 dB).
  const input = makeNoise(48000 * 5, 0.05);
  const output = processSamples(input, module);
  assert.equal(output.length, input.length);
  const lastSecond = input.length - 48000;
  const inRms = rms(input, lastSecond);
  const outRms = rms(output, lastSecond);
  assert.ok(
    outRms < inRms * 0.1,
    `expected > 20 dB suppression in the final second: in RMS ${inRms.toFixed(4)}, out RMS ${outRms.toFixed(4)}`
  );
});

test('processing is deterministic and state does not leak between calls', () => {
  const input = makeNoise(48000, 0.05, 4242);
  const first = processSamples(input, module);
  const second = processSamples(input, module);
  assert.deepEqual(Array.from(second), Array.from(first));
});

test('input length is preserved when not a multiple of the 480-sample frame', () => {
  const input = makeNoise(1000, 0.05, 999);
  const output = processSamples(input, module);
  assert.equal(output.length, 1000);
});
