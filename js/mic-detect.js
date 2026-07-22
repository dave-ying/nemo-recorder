// Pure, DOM-free microphone-capability decisions. Given a track's reported
// settings/capabilities (from getSettings()/getCapabilities()) plus the result
// of an active stereo probe, decide which quality options to offer and which to
// preselect. Kept free of DOM/state imports so it's unit-testable in Node — the
// browser-only probing (getUserMedia) lives in audio.js and feeds into here.

const CANDIDATE_RATES = [44100, 48000, 96000, 192000];

/**
 * Resolve the microphone's genuine sample rate.
 *
 * getSettings().sampleRate is the rate the track is actually delivering, so
 * it's the truthful native rate. getCapabilities().sampleRate only describes
 * the range the audio backend could resample to (often a huge 3kHz–384kHz span
 * for every device), not the mic's real rate — offering that whole range would
 * default recordings to the highest one (e.g. 192k) even on ordinary hardware,
 * inflating file size with interpolated data rather than real fidelity. So the
 * capability range is only a last-resort fallback when getSettings() is silent.
 *
 * @param {{sampleRate?: number}} settings
 * @param {{sampleRate?: {min?: number, max?: number}}} capabilities
 * @returns {number}
 */
function resolveSampleRate(settings, capabilities) {
  if (settings.sampleRate) return settings.sampleRate;
  const capRate = capabilities.sampleRate;
  if (capRate && typeof capRate === 'object') {
    const min = capRate.min ?? 0;
    const max = capRate.max ?? Infinity;
    return CANDIDATE_RATES.find(r => r >= min && r <= max) || capRate.min || 48000;
  }
  return 48000;
}

/**
 * Decide whether the device genuinely supports stereo capture.
 *
 * The physical channel count is notoriously unreliable to read from the Web
 * Audio API: getCapabilities().channelCount.max commonly reports 2 even for
 * mono-only mics (it describes the pipeline's upmix ceiling, not the hardware).
 * So the source of truth here is, in order:
 *   1. An explicit stereo probe (audio.js asks the device for exactly 2
 *      channels; a mono-only device rejects it). true/false is authoritative.
 *   2. If no probe result, whether the track is already delivering ≥2 channels
 *      unconstrained (getSettings().channelCount) — that means it's genuinely
 *      multi-channel.
 * We deliberately do NOT fall back to getCapabilities().channelCount.max,
 * because that's the exact signal that mislabels mono mics as stereo.
 *
 * @param {{channelCount?: number}} settings
 * @param {boolean|null} stereoSupported - probe result, or null if not probed
 * @returns {boolean}
 */
function resolveStereo(settings, stereoSupported) {
  if (stereoSupported === true || stereoSupported === false) return stereoSupported;
  const native = settings.channelCount;
  return typeof native === 'number' && native >= 2;
}

/**
 * Derive the offered capability lists and the preselected defaults for a
 * connected microphone.
 *
 * @param {Object} opts
 * @param {{sampleRate?: number, channelCount?: number}} [opts.settings] - track.getSettings()
 * @param {{sampleRate?: {min?: number, max?: number}, channelCount?: {max?: number}}} [opts.capabilities] - track.getCapabilities()
 * @param {boolean|null} [opts.stereoSupported] - active stereo-probe result; null if inconclusive/unprobed
 * @returns {{
 *   capabilities: {supportedRates: number[], supportedChannels: number[], supportedBitDepths: number[]},
 *   defaults: {sampleRate: number, channels: number, bitDepth: number}
 * }}
 */
export function deriveMicCapabilities({ settings = {}, capabilities = {}, stereoSupported = null } = {}) {
  const sampleRate = resolveSampleRate(settings, capabilities);
  const supportedRates = [sampleRate];

  const stereo = resolveStereo(settings, stereoSupported);
  const supportedChannels = stereo ? [1, 2] : [1];

  // Web Audio captures 32-bit float internally, so 32-bit float is the truthful
  // native depth; 16/24 are offered as lower-footprint export choices.
  const supportedBitDepths = [16, 24, 32];

  return {
    capabilities: { supportedRates, supportedChannels, supportedBitDepths },
    defaults: {
      // Preselect the genuine native rate and the highest channel count the
      // device actually supports (best fidelity), and 32-bit float (lossless).
      sampleRate,
      channels: supportedChannels[supportedChannels.length - 1],
      bitDepth: 32,
    },
  };
}
