// Pure de-esser — no DOM, no app state, length-preserving. A per-track
// "source cleanup" effect that tames harsh sibilance ("s"/"sh"/"t" sounds)
// without dulling the rest of the voice. It splits off the sibilant high band
// with a high-pass, tracks that band's short-term level, and ducks ONLY the
// high band when it exceeds the threshold — then recombines with the untouched
// low band. The persistent-effect orchestration lives in effects.js.

import { biquadCoefficients, runBiquad } from './biquad.js';

const dbToGain = db => Math.pow(10, db / 20);

export const DEESSER_FREQ = 6000;       // split point for the sibilant band
export const DEESSER_DETECT_MS = 3;     // envelope attack/release on the band
export const DEESSER_RELEASE_MS = 40;

/** @typedef {{freq?:number, thresholdDb:number, amount:number}} DeEsserParams */

function timeCoef(ms, sampleRate) {
  const t = Math.max(0.01, ms) / 1000;
  return Math.exp(-1 / (sampleRate * t));
}

/**
 * Apply the de-esser to every channel. A single gain-reduction envelope is
 * derived from the loudest channel's sibilant band so channels duck together.
 * Output length always equals the input.
 *
 * @param {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}} buffer
 * @param {DeEsserParams} params
 * @param {((channels:number,length:number,sampleRate:number)=>{getChannelData:(c:number)=>Float32Array})|null} [createBuffer]
 * @returns {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}}
 */
export function applyDeEsser(buffer, params, createBuffer = null) {
  const sr = buffer.sampleRate;
  const nch = buffer.numberOfChannels;
  const len = buffer.length;
  const freq = params.freq || DEESSER_FREQ;
  const threshold = dbToGain(params.thresholdDb);
  const amount = Math.max(0, Math.min(1, params.amount));
  const hp = biquadCoefficients('highpass', sr, freq, 0.707);
  const lp = biquadCoefficients('lowpass', sr, freq, 0.707);
  const attackCoef = timeCoef(DEESSER_DETECT_MS, sr);
  const releaseCoef = timeCoef(DEESSER_RELEASE_MS, sr);

  // Split each channel into complementary high (sibilant) and low bands with a
  // matched HP/LP pair. Deriving the low band with an actual low-pass — rather
  // than `src - high` — keeps the two bands phase-coherent, so attenuating the
  // high band actually removes that energy from the recombined output (a naive
  // subtraction leaves phase-rotated high content behind) while an unreduced
  // pair still sums back to ~unity.
  const highs = [];
  const lows = [];
  for (let c = 0; c < nch; c++) {
    const src = buffer.getChannelData(c);
    highs.push(runBiquad(src, hp));
    lows.push(runBiquad(src, lp));
  }

  // Per-sample gain reduction on the high band, driven by its envelope.
  const gr = new Float32Array(len);
  let env = 0;
  let g = 1;
  for (let i = 0; i < len; i++) {
    let inst = 0;
    for (let c = 0; c < nch; c++) {
      const a = Math.abs(highs[c][i]);
      if (a > inst) inst = a;
    }
    const coef = inst > env ? attackCoef : releaseCoef;
    env = inst + (env - inst) * coef;
    // Target reduction: pull the band back toward threshold, scaled by amount.
    const target = env > threshold ? Math.pow(threshold / env, amount) : 1;
    // Smooth the reduction with the same release so it doesn't zipper.
    g = target < g ? target : target + (g - target) * releaseCoef;
    gr[i] = g;
  }

  const out = createBuffer
    ? createBuffer(nch, len, sr)
    : new AudioBuffer({ numberOfChannels: nch, length: len, sampleRate: sr });
  for (let c = 0; c < nch; c++) {
    const low = lows[c];
    const high = highs[c];
    const dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) dst[i] = low[i] + high[i] * gr[i];
  }
  return /** @type {*} */ (out);
}
