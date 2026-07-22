// Pure noise gate — no DOM, no app state, length-preserving. A per-track
// "source cleanup" effect: it silences audio that sits below a threshold
// (room tone between phrases) while passing louder content through untouched.
// The persistent-effect orchestration (toggle, caching, chaining) lives in
// effects.js.
//
// A single detection envelope is derived from the loudest channel each sample
// so the gate opens/closes coherently across channels (no stereo-image
// wandering), and one shared gain is applied to every channel. Attack/hold/
// release are one-pole time constants; hold prevents the gate from chattering
// during short dips inside speech.

const dbToGain = db => Math.pow(10, db / 20);

/** @typedef {{thresholdDb:number, attackMs:number, holdMs:number, releaseMs:number}} GateParams */

/** One-pole smoothing coefficient for a given time constant (ms). */
function timeCoef(ms, sampleRate) {
  const t = Math.max(0.01, ms) / 1000;
  return Math.exp(-1 / (sampleRate * t));
}

/**
 * Apply the gate to every channel. Output length always equals the input.
 *
 * @param {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}} buffer
 * @param {GateParams} params
 * @param {((channels:number,length:number,sampleRate:number)=>{getChannelData:(c:number)=>Float32Array})|null} [createBuffer]
 * @returns {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}}
 */
export function applyNoiseGate(buffer, params, createBuffer = null) {
  const sr = buffer.sampleRate;
  const nch = buffer.numberOfChannels;
  const len = buffer.length;
  const threshold = dbToGain(params.thresholdDb);
  const attackCoef = timeCoef(params.attackMs, sr);
  const releaseCoef = timeCoef(params.releaseMs, sr);
  // Envelope follower: instant attack, eased release, so brief peaks open the
  // gate immediately but it doesn't slam shut between syllables.
  const envRelease = timeCoef(Math.max(params.releaseMs, 40), sr);
  const holdSamples = Math.max(0, Math.round((params.holdMs / 1000) * sr));

  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(buffer.getChannelData(c));

  const gains = new Float32Array(len);
  let env = 0;
  let gain = 0;
  let hold = 0;
  for (let i = 0; i < len; i++) {
    let inst = 0;
    for (let c = 0; c < nch; c++) {
      const a = Math.abs(channels[c][i]);
      if (a > inst) inst = a;
    }
    env = inst > env ? inst : inst + (env - inst) * envRelease;

    let target;
    if (env >= threshold) { target = 1; hold = holdSamples; }
    else if (hold > 0) { hold--; target = 1; }
    else target = 0;

    const coef = target > gain ? attackCoef : releaseCoef;
    gain = target + (gain - target) * coef;
    gains[i] = gain;
  }

  const out = createBuffer
    ? createBuffer(nch, len, sr)
    : new AudioBuffer({ numberOfChannels: nch, length: len, sampleRate: sr });
  for (let c = 0; c < nch; c++) {
    const src = channels[c];
    const dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) dst[i] = src[i] * gains[i];
  }
  return /** @type {*} */ (out);
}
