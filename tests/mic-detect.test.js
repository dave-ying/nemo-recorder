import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMicCapabilities } from '../js/mic-detect.js';

// Pure microphone-capability decision logic. The browser-only stereo probe
// (getUserMedia in audio.js) is exercised by the app; here we assert that the
// derived option lists + preselected defaults are correct for the signals that
// probe (and getSettings/getCapabilities) can produce.

test('mono mic: settings report 1 channel, no stereo probe → mono only', () => {
  const { capabilities, defaults } = deriveMicCapabilities({
    settings: { channelCount: 1, sampleRate: 48000 },
    capabilities: {},
    stereoSupported: null,
  });
  assert.deepEqual(capabilities.supportedChannels, [1]);
  assert.equal(defaults.channels, 1);
});

test('mono mic is not mislabeled stereo when getCapabilities().channelCount.max says 2', () => {
  // This is the exact real-world failure: getSettings().channelCount is absent,
  // getCapabilities().channelCount.max wrongly reports 2 for a mono-only mic,
  // and the probe confirms mono. Must NOT offer or preselect stereo.
  const { capabilities, defaults } = deriveMicCapabilities({
    settings: { sampleRate: 48000 }, // channelCount unavailable
    capabilities: { channelCount: { max: 2 } },
    stereoSupported: false,
  });
  assert.deepEqual(capabilities.supportedChannels, [1]);
  assert.equal(defaults.channels, 1);
});

test('mono mic: caps says 2 but no probe result → still mono (caps.max is not trusted)', () => {
  const { capabilities, defaults } = deriveMicCapabilities({
    settings: { sampleRate: 48000 },
    capabilities: { channelCount: { max: 2 } },
    stereoSupported: null,
  });
  assert.deepEqual(capabilities.supportedChannels, [1]);
  assert.equal(defaults.channels, 1);
});

test('stereo mic confirmed by probe → offers both, preselects stereo', () => {
  const { capabilities, defaults } = deriveMicCapabilities({
    settings: { channelCount: 1, sampleRate: 48000 },
    capabilities: {},
    stereoSupported: true,
  });
  assert.deepEqual(capabilities.supportedChannels, [1, 2]);
  assert.equal(defaults.channels, 2);
});

test('mic already delivering 2 channels → stereo without needing a probe', () => {
  const { capabilities, defaults } = deriveMicCapabilities({
    settings: { channelCount: 2, sampleRate: 48000 },
    capabilities: {},
    stereoSupported: null,
  });
  assert.deepEqual(capabilities.supportedChannels, [1, 2]);
  assert.equal(defaults.channels, 2);
});

test('probe result wins over the native channel count', () => {
  // Even if the track was delivering 2 channels, an authoritative false probe
  // downgrades to mono (defensive; native>=2 short-circuits in audio.js, but
  // the pure function must honor an explicit false).
  const { capabilities } = deriveMicCapabilities({
    settings: { channelCount: 2, sampleRate: 48000 },
    stereoSupported: false,
  });
  assert.deepEqual(capabilities.supportedChannels, [1]);
});

test('sample rate: getSettings().sampleRate is the native rate and is preselected', () => {
  const { capabilities, defaults } = deriveMicCapabilities({
    settings: { channelCount: 1, sampleRate: 44100 },
  });
  assert.deepEqual(capabilities.supportedRates, [44100]);
  assert.equal(defaults.sampleRate, 44100);
});

test('sample rate falls back to a candidate within the capability range when settings are silent', () => {
  const { defaults } = deriveMicCapabilities({
    settings: {},
    capabilities: { sampleRate: { min: 8000, max: 96000 } },
  });
  // First candidate rate that fits the range.
  assert.equal(defaults.sampleRate, 44100);
});

test('sample rate defaults to 48000 when nothing is reported', () => {
  const { capabilities, defaults } = deriveMicCapabilities({ settings: {}, capabilities: {} });
  assert.deepEqual(capabilities.supportedRates, [48000]);
  assert.equal(defaults.sampleRate, 48000);
});

test('bit depths are always offered and default to 32-bit float', () => {
  const { capabilities, defaults } = deriveMicCapabilities({ settings: { channelCount: 1 } });
  assert.deepEqual(capabilities.supportedBitDepths, [16, 24, 32]);
  assert.equal(defaults.bitDepth, 32);
});

test('handles being called with no arguments', () => {
  const { capabilities, defaults } = deriveMicCapabilities();
  assert.deepEqual(capabilities.supportedChannels, [1]);
  assert.equal(defaults.sampleRate, 48000);
  assert.equal(defaults.channels, 1);
});
