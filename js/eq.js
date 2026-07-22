// Pure 3-band EQ (low-shelf + peaking mid + high-shelf) — no DOM, no app
// state, length-preserving. A per-track "source cleanup" effect; the
// persistent-effect orchestration (toggle, caching, chaining) lives in
// effects.js. Kept minimal on purpose (three gain sliders, fixed frequencies)
// so it's easy for a general audience — the frequencies below are sensible
// voice/general-audio defaults.

import { biquadCoefficients, runBiquad } from './biquad.js';

export const EQ_LOW_FREQ = 120;    // low-shelf corner (rumble / warmth)
export const EQ_MID_FREQ = 1000;   // presence bell
export const EQ_MID_Q = 0.9;
export const EQ_HIGH_FREQ = 8000;  // high-shelf corner (air / brightness)
export const SHELF_Q = 0.707;

/** @typedef {{lowGainDb:number, midGainDb:number, highGainDb:number}} EqParams */

/**
 * Apply the 3-band EQ to every channel. Bands sitting at 0 dB are skipped, so
 * an all-flat EQ is a straight copy. Output length always equals the input.
 *
 * @param {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}} buffer
 * @param {EqParams} params
 * @param {((channels:number,length:number,sampleRate:number)=>{getChannelData:(c:number)=>Float32Array})|null} [createBuffer] - inject for Node/pipeline; falls back to AudioBuffer
 * @returns {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}}
 */
export function applyEq(buffer, params, createBuffer = null) {
  const sr = buffer.sampleRate;
  const stages = [];
  if (params.lowGainDb) stages.push(biquadCoefficients('lowshelf', sr, EQ_LOW_FREQ, SHELF_Q, params.lowGainDb));
  if (params.midGainDb) stages.push(biquadCoefficients('peaking', sr, EQ_MID_FREQ, EQ_MID_Q, params.midGainDb));
  if (params.highGainDb) stages.push(biquadCoefficients('highshelf', sr, EQ_HIGH_FREQ, SHELF_Q, params.highGainDb));

  const out = createBuffer
    ? createBuffer(buffer.numberOfChannels, buffer.length, sr)
    : new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: sr });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    let cur = buffer.getChannelData(c);
    for (const st of stages) cur = runBiquad(cur, st);
    out.getChannelData(c).set(cur);
  }
  return /** @type {*} */ (out);
}
