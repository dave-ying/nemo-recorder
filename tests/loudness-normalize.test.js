import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKWeighting, measureIntegratedLufs, createNormalizedBuffer, findTruePeak } from '../js/loudness-normalize.js';

function mockBuffer(channels, sampleRate) {
  return { numberOfChannels: channels.length, sampleRate, length: channels[0].length, getChannelData: c => channels[c] };
}
function sine(frequency, amplitude, seconds, sampleRate = 48000) {
  const data = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < data.length; i++) data[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  return data;
}
test('K-weighting frequency response', () => {
  const sr = 48000;
  const inputPower = (() => {
    const sig = sine(1000, 1, 2, sr);
    let sum = 0;
    for (let i = sr; i < sig.length; i++) sum += sig[i] ** 2;
    return 10 * Math.log10(sum / (sig.length - sr));
  })();
  const outputPower = freq => {
    const out = applyKWeighting(sine(freq, 1, 2, sr), sr);
    let sum = 0;
    for (let i = sr; i < out.length; i++) sum += out[i] ** 2;
    return 10 * Math.log10(sum / (out.length - sr));
  };
  const gains = [100, 1000, 5000].map(f => outputPower(f) - inputPower);
  assert.ok(gains[0] < -1, `100 Hz gain ${gains[0].toFixed(2)} dB (expected < -1)`);
  assert.ok(Math.abs(gains[1]) < 1.5, `1 kHz gain ${gains[1].toFixed(2)} dB (expected ~0)`);
  assert.ok(gains[2] > 2, `5 kHz gain ${gains[2].toFixed(2)} dB (expected > 2)`);
});
test('1 kHz sine at -20 dBFS measures approximately -23 LUFS', () => {
  const measured = measureIntegratedLufs(mockBuffer([sine(1000, 0.1, 2)], 48000));
  assert.ok(Math.abs(measured + 23) < 0.8, `${measured} LUFS`);
});
test('normalization reaches target when not limited', () => {
  const input = mockBuffer([sine(1000, 0.01, 2)], 48000);
  const result = createNormalizedBuffer(input, -16, -1, (ch, len, sr) => mockBuffer(Array.from({ length: ch }, () => new Float32Array(len)), sr));
  assert.ok(Math.abs(measureIntegratedLufs(result.buffer) + 16) < 0.5);
});
test('true-peak limiter keeps output below ceiling', () => {
  const input = mockBuffer([new Float32Array(48000).fill(0.8)], 48000);
  const result = createNormalizedBuffer(input, -10, -6, (ch, len, sr) => mockBuffer(Array.from({ length: ch }, () => new Float32Array(len)), sr));
  assert.ok(findTruePeak(result.buffer) <= Math.pow(10, -6 / 20) + 1e-6);
});
test('true peak detects inter-sample peaks above the sample peak', () => {
  // A narrow Gaussian bump centered exactly between two samples: the sampled
  // values undershoot the true amplitude of 1.0. Linear interpolation would
  // report the sample peak; proper oversampling must recover ~1.0.
  const sr = 48000;
  const data = new Float32Array(4800);
  const center = 100.5;
  for (let i = 0; i < data.length; i++) data[i] = Math.exp(-(((i - center) / 4) ** 2));
  let samplePeak = 0;
  for (const v of data) samplePeak = Math.max(samplePeak, Math.abs(v));
  const tp = findTruePeak(mockBuffer([data], sr));
  assert.ok(samplePeak < 0.99, `test premise broken: sample peak ${samplePeak} should undershoot`);
  assert.ok(tp > samplePeak + 0.005, `true peak ${tp} should exceed sample peak ${samplePeak}`);
  assert.ok(tp <= 1.06, `true peak ${tp} should not wildly overshoot the true amplitude 1.0`);
});
test('true peak of a constant signal equals the constant', () => {
  const tp = findTruePeak(mockBuffer([new Float32Array(4800).fill(0.3)], 48000));
  assert.ok(Math.abs(tp - 0.3) < 1e-3, `true peak ${tp} of DC 0.3`);
});
