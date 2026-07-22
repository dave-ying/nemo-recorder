import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNoiseGate } from '../js/noise-gate.js';

const SR = 48000;

function makeBuf(nch, len, sr) {
  const ch = [];
  for (let i = 0; i < nch; i++) ch.push(new Float32Array(len));
  return { numberOfChannels: nch, length: len, sampleRate: sr, getChannelData: c => ch[c] };
}
function fromChannels(chs, sr = SR) {
  return { numberOfChannels: chs.length, length: chs[0].length, sampleRate: sr, getChannelData: c => chs[c] };
}
function sine(len, freq, amp, sr = SR) {
  const a = new Float32Array(len);
  for (let i = 0; i < len; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
  return a;
}
function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); }

const PARAMS = { thresholdDb: -45, attackMs: 5, holdMs: 50, releaseMs: 100 };

test('noise gate is length- and channel-preserving', () => {
  const input = fromChannels([sine(4096, 1000, 0.3), sine(4096, 1000, 0.3)]);
  const out = applyNoiseGate(input, PARAMS, makeBuf);
  assert.equal(out.length, 4096);
  assert.equal(out.numberOfChannels, 2);
});

test('noise gate passes signal above the threshold roughly unchanged', () => {
  const src = sine(48000, 1000, 0.4); // ~-8 dBFS, well above -45
  const input = fromChannels([src]);
  const out = applyNoiseGate(input, PARAMS, makeBuf);
  // After the brief attack ramp the gate is fully open, so energy is retained.
  assert.ok(rms(out.getChannelData(0)) > 0.9 * rms(src));
});

test('noise gate silences steady signal below the threshold', () => {
  const src = sine(48000, 1000, 0.001); // ~-60 dBFS, below -45
  const input = fromChannels([src]);
  const out = applyNoiseGate(input, PARAMS, makeBuf);
  // The gate closes and heavily attenuates the sub-threshold tone.
  assert.ok(rms(out.getChannelData(0)) < 0.2 * rms(src));
});
