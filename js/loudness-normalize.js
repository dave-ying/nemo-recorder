import { state } from './state.js';

let _domDeps = null;
async function loadDomDeps() {
  if (_domDeps) return _domDeps;
  const [history, editing, waveform, ui, playback] = await Promise.all([
    import('./history.js'),
    import('./editing.js'),
    import('./waveform.js'),
    import('./ui.js'),
    import('./playback.js')
  ]);
  _domDeps = {
    pushHistory: history.pushHistory,
    rebuildPlaybackBuffer: editing.rebuildPlaybackBuffer,
    drawPlaybackWaveform: waveform.drawPlaybackWaveform,
    showToast: ui.showToast,
    pausePlayback: playback.pausePlayback
  };
  return _domDeps;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const WINDOW_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
const SHELF_FREQUENCY = 1681;
const SHELF_GAIN_DB = 4;
const SHELF_Q = 0.707;
const RLB_FREQUENCY = 38;
const RLB_Q = 0.5;

const dbToGain = db => Math.pow(10, db / 20);

function biquadCoefficients(sampleRate, type, frequency, q, gainDb = 0) {
  const w0 = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highshelf') {
    const beta = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cos + beta);
    b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    b2 = A * ((A + 1) + (A - 1) * cos - beta);
    a0 = (A + 1) - (A - 1) * cos + beta;
    a1 = 2 * ((A - 1) - (A + 1) * cos);
    a2 = (A + 1) - (A - 1) * cos - beta;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filterChannel(input, sampleRate) {
  const stages = [
    biquadCoefficients(sampleRate, 'highshelf', SHELF_FREQUENCY, SHELF_Q, SHELF_GAIN_DB),
    biquadCoefficients(sampleRate, 'highpass', RLB_FREQUENCY, RLB_Q)
  ];
  let output = new Float32Array(input);
  for (const c of stages) {
    const next = new Float32Array(output.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < output.length; i++) {
      const x = output[i];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      next[i] = y;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    output = next;
  }
  return output;
}

function loudnessFromEnergy(energy) {
  return -0.691 + 10 * Math.log10(Math.max(energy, 1e-20));
}

/**
 * Apply the BS.1770 K-weighting filter chain (high-shelf ~1681 Hz, +4 dB,
 * followed by the RLB high-pass ~38 Hz) to a channel's samples.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Float32Array} filtered copy
 */
export function applyKWeighting(samples, sampleRate) {
  return filterChannel(samples, sampleRate);
}

/**
 * Measure BS.1770-4 integrated loudness: 400 ms windows with 75% overlap,
 * -70 LUFS absolute gate, then -10 LU relative gate.
 *
 * @param {{numberOfChannels: number, length: number, sampleRate: number, getChannelData: (channel: number) => Float32Array}} buffer
 * @returns {number} integrated loudness in LUFS, or -Infinity if every window is gated out
 */
export function measureIntegratedLufs(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    filterChannel(buffer.getChannelData(c), buffer.sampleRate));
  const window = Math.max(1, Math.round(WINDOW_SECONDS * buffer.sampleRate));
  const hop = Math.max(1, Math.round(HOP_SECONDS * buffer.sampleRate));
  const blocks = [];
  for (let start = 0; start + window <= buffer.length; start += hop) {
    let energy = 0;
    for (const channel of channels) {
      let sum = 0;
      for (let i = start; i < start + window; i++) sum += channel[i] * channel[i];
      energy += sum / window;
    }
    const lufs = loudnessFromEnergy(energy);
    if (lufs > ABSOLUTE_GATE_LUFS) blocks.push({ energy, lufs });
  }
  if (blocks.length === 0) return -Infinity;
  const absoluteEnergy = blocks.reduce((sum, block) => sum + block.energy, 0) / blocks.length;
  const relativeGate = loudnessFromEnergy(absoluteEnergy) + RELATIVE_GATE_LU;
  const gated = blocks.filter(block => block.lufs >= relativeGate);
  if (gated.length === 0) return -Infinity;
  return loudnessFromEnergy(gated.reduce((sum, block) => sum + block.energy, 0) / gated.length);
}

// ===== True peak (4x oversampling via windowed-sinc polyphase FIR) =====

const TRUE_PEAK_PHASES = 4;
const TRUE_PEAK_TAPS = 8;

const sinc = x => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
// Blackman window over [-1, 1] (0 at both ends).
const blackman = x => (Math.abs(x) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x));

/**
 * Build one FIR kernel per fractional phase (1/4, 2/4, 3/4) for 4x
 * interpolation between samples n and n+1. Each kernel is DC-normalized; its
 * L1 norm bounds the interpolation overshoot, which lets findTruePeak skip
 * regions that provably can't exceed the current peak.
 */
function buildTruePeakKernels() {
  const half = TRUE_PEAK_TAPS / 2;
  const kernels = [];
  for (let p = 1; p < TRUE_PEAK_PHASES; p++) {
    const t = p / TRUE_PEAK_PHASES;
    const taps = new Float64Array(TRUE_PEAK_TAPS);
    for (let i = 0; i < TRUE_PEAK_TAPS; i++) {
      const d = t - (i - half + 1);
      taps[i] = sinc(d) * blackman(d / half);
    }
    let sum = 0;
    for (const v of taps) sum += v;
    let l1 = 0;
    for (let i = 0; i < TRUE_PEAK_TAPS; i++) { taps[i] /= sum; l1 += Math.abs(taps[i]); }
    kernels.push({ taps, l1 });
  }
  return kernels;
}

const _truePeakKernels = buildTruePeakKernels();
const _truePeakMaxL1 = Math.max(..._truePeakKernels.map(k => k.l1));

function truePeakChannel(samples) {
  const n = samples.length;
  if (n === 0) return 0;
  const half = TRUE_PEAK_TAPS / 2;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  // Interpolate only where the local sample amplitude could plausibly
  // overshoot past the running peak (bounded by the kernel's L1 norm).
  for (let i = 0; i < n - 1; i++) {
    const localMax = Math.max(Math.abs(samples[i]), Math.abs(samples[i + 1]));
    if (localMax * _truePeakMaxL1 <= peak) continue;
    for (const { taps } of _truePeakKernels) {
      let y = 0;
      for (let j = 0; j < TRUE_PEAK_TAPS; j++) {
        let idx = i - half + 1 + j;
        if (idx < 0) idx = 0;
        else if (idx >= n) idx = n - 1;
        y += samples[idx] * taps[j];
      }
      const ay = Math.abs(y);
      if (ay > peak) peak = ay;
    }
  }
  return peak;
}

/**
 * Estimate the true (inter-sample) peak of a buffer via 4x windowed-sinc
 * oversampling — a close approximation of the BS.1770 Annex 2 true-peak
 * measurement, unlike linear interpolation which underestimates overshoots.
 *
 * @param {{numberOfChannels: number, getChannelData: (channel: number) => Float32Array}} buffer
 * @returns {number} true peak as a linear amplitude
 */
export function findTruePeak(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channelPeak = truePeakChannel(buffer.getChannelData(c));
    if (channelPeak > peak) peak = channelPeak;
  }
  return peak;
}

/**
 * Measure loudness and produce a gained buffer at `targetLufs`, limited so
 * the true peak never exceeds `truePeakDbtp`.
 *
 * @param {{numberOfChannels: number, length: number, sampleRate: number, getChannelData: (channel: number) => Float32Array}} buffer
 * @param {number} targetLufs
 * @param {number} truePeakDbtp
 * @param {((channels: number, length: number, sampleRate: number) => {getChannelData: (channel: number) => Float32Array})|null} createBuffer - inject for Node tests; falls back to the AudioBuffer constructor in browsers
 * @returns {{buffer: *, measuredLufs: number, gain: number, limited: boolean}}
 */
export function createNormalizedBuffer(buffer, targetLufs, truePeakDbtp, createBuffer = null) {
  const measured = measureIntegratedLufs(buffer);
  const loudnessGain = Number.isFinite(measured) ? dbToGain(targetLufs - measured) : 1;
  const ceiling = dbToGain(truePeakDbtp);
  const initialPeak = findTruePeak(buffer);
  const limiterGain = initialPeak * loudnessGain > ceiling ? ceiling / (initialPeak * loudnessGain) : 1;
  const gain = loudnessGain * limiterGain;
  const output = createBuffer
    ? createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
    : new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const source = buffer.getChannelData(c);
    const destination = output.getChannelData(c);
    for (let i = 0; i < source.length; i++) destination[i] = source[i] * gain;
  }
  return { buffer: output, measuredLufs: measured, gain, limited: limiterGain < 1 };
}

export async function normalizeLoudness() {
  if (!state.originalBuffer || !state.audioContext) return;
  const { pushHistory, rebuildPlaybackBuffer, drawPlaybackWaveform, showToast, pausePlayback } = await loadDomDeps();
  if (state.isPlaying) pausePlayback();

  const target = state.loudness.targetLufs;
  const ceilingDb = state.loudness.truePeakDbtp;
  const result = createNormalizedBuffer(state.originalBuffer, target, ceilingDb,
    (channels, length, sampleRate) => state.audioContext.createBuffer(channels, length, sampleRate));

  if (!Number.isFinite(result.measuredLufs) && !result.limited) {
    showToast('Audio is too quiet to measure loudness — nothing to normalize');
    return;
  }

  // Pin the pre-normalize buffer: gain is applied to a brand-new buffer, so
  // undo restores the exact pre-op PCM.
  pushHistory(true);
  state.originalBuffer = result.buffer;
  state.bufferEpoch++;
  rebuildPlaybackBuffer();
  drawPlaybackWaveform(state.recordedBuffer?.duration ? state.playbackOffset / state.recordedBuffer.duration : 0);

  if (!Number.isFinite(result.measuredLufs)) {
    showToast(`Loudness unmeasurable — limited to ${ceilingDb.toFixed(1)} dBTP`);
  } else if (result.limited) {
    showToast(`Normalized to ${target.toFixed(1)} LUFS · limited at ${ceilingDb.toFixed(1)} dBTP`);
  } else {
    showToast(`Normalized to ${target.toFixed(1)} LUFS (was ${result.measuredLufs.toFixed(1)})`);
  }
}
