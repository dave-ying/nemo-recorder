import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeEsser } from '../js/deesser.js';
import { biquadCoefficients, runBiquad } from '../js/biquad.js';

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
  for (let i = 0; i < len; i++) a[i] += amp * Math.sin(2 * Math.PI * freq * i / sr);
  return a;
}
function add(a, b) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + b[i]; return o; }
function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); }
function highBand(a) { return runBiquad(a, biquadCoefficients('highpass', SR, 6000, 0.707)); }

const PARAMS = { freq: 6000, thresholdDb: -30, amount: 0.8 };

test('de-esser is length- and channel-preserving', () => {
  const s = add(sine(4096, 300, 0.2), sine(4096, 8000, 0.5));
  const out = applyDeEsser(fromChannels([s, s]), PARAMS, makeBuf);
  assert.equal(out.length, 4096);
  assert.equal(out.numberOfChannels, 2);
});

test('de-esser reduces sibilant (high-band) energy above threshold', () => {
  const low = sine(48000, 300, 0.2);
  const sib = sine(48000, 8000, 0.6); // strong sibilance, well above -30 dB
  const src = add(low, sib);
  const out = applyDeEsser(fromChannels([src]), PARAMS, makeBuf).getChannelData(0);
  assert.ok(rms(highBand(out)) < 0.8 * rms(highBand(src)));
});

test('de-esser leaves the low band substantially intact', () => {
  const low = sine(48000, 300, 0.3);
  const sib = sine(48000, 8000, 0.6);
  const src = add(low, sib);
  const out = applyDeEsser(fromChannels([src]), PARAMS, makeBuf).getChannelData(0);
  // Low-band energy (everything below the split) should barely move.
  const lowOf = (a) => runBiquad(a, biquadCoefficients('lowpass', SR, 2000, 0.707));
  const before = rms(lowOf(src));
  const after = rms(lowOf(out));
  assert.ok(after > 0.9 * before && after < 1.1 * before);
});
