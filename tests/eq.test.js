import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEq } from '../js/eq.js';

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

test('EQ is length-preserving', () => {
  const input = fromChannels([sine(2048, 1000, 0.3)]);
  const out = applyEq(input, { lowGainDb: 3, midGainDb: 0, highGainDb: -2 }, makeBuf);
  assert.equal(out.length, 2048);
});

test('flat EQ (all bands 0 dB) is a passthrough copy', () => {
  const src = sine(1024, 1000, 0.3);
  const input = fromChannels([src]);
  const out = applyEq(input, { lowGainDb: 0, midGainDb: 0, highGainDb: 0 }, makeBuf);
  const o = out.getChannelData(0);
  for (let i = 0; i < src.length; i++) assert.equal(o[i], src[i]);
});

test('high-shelf boost raises high-frequency energy', () => {
  const src = sine(48000, 12000, 0.3);
  const input = fromChannels([src]);
  const out = applyEq(input, { lowGainDb: 0, midGainDb: 0, highGainDb: 12 }, makeBuf);
  assert.ok(rms(out.getChannelData(0)) > 1.3 * rms(src));
});

test('low-shelf cut reduces low-frequency energy', () => {
  const src = sine(48000, 60, 0.3);
  const input = fromChannels([src]);
  const out = applyEq(input, { lowGainDb: -12, midGainDb: 0, highGainDb: 0 }, makeBuf);
  assert.ok(rms(out.getChannelData(0)) < 0.6 * rms(src));
});
