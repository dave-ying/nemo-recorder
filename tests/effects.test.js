import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, segmentEffectOn } from '../js/state.js';
import {
  createChannelCache,
  concatChannelCaches,
  fitToLength,
  effectsFingerprintsEqual,
  mergeSyncHints,
  isEffectsActive,
  getSourceBuffer,
  resetEffectsCaches,
  buildDenoiseComposite,
  perSegmentNoiseSignature
} from '../js/effects.js';

// effects.js's pure cache/fingerprint/hint helpers plus the state-reading
// selectors. The pipeline's async drain and DOM integration are covered by
// the browser app, not here.

function mockAudioBuffer(channels, sampleRate = 48000) {
  return { numberOfChannels: channels.length, sampleRate, length: channels[0].length, getChannelData: c => channels[c] };
}

// Preserve/restore the shared state object around each state-touching test.
function withState(fields, fn) {
  const saved = {};
  for (const key of Object.keys(fields)) saved[key] = state[key];
  Object.assign(state, fields);
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) state[key] = saved[key];
  }
}

test('createChannelCache is shaped like an AudioBuffer', () => {
  const ch = [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])];
  const cache = createChannelCache(ch, 3, 44100);
  assert.equal(cache.numberOfChannels, 2);
  assert.equal(cache.length, 3);
  assert.equal(cache.sampleRate, 44100);
  assert.equal(cache.getChannelData(0), ch[0]);
  assert.equal(cache.getChannelData(1), ch[1]);
});

test('concatChannelCaches appends processed regions', () => {
  const cache = createChannelCache([new Float32Array([1, 2]), new Float32Array([7, 8])], 2, 48000);
  const appended = [new Float32Array([3, 4, 5]), new Float32Array([9, 10, 11])];
  const merged = concatChannelCaches(cache, appended);
  assert.equal(merged.length, 5);
  assert.deepEqual([...merged.getChannelData(0)], [1, 2, 3, 4, 5]);
  assert.deepEqual([...merged.getChannelData(1)], [7, 8, 9, 10, 11]);
  // Original cache untouched (pipeline keeps the old one until commit).
  assert.equal(cache.length, 2);
});

test('concatChannelCaches tolerates fewer appended channels (mono into stereo slot)', () => {
  const cache = createChannelCache([new Float32Array([1]), new Float32Array([2])], 1, 48000);
  const merged = concatChannelCaches(cache, [new Float32Array([9])]);
  assert.deepEqual([...merged.getChannelData(0)], [1, 9]);
  assert.deepEqual([...merged.getChannelData(1)], [2, 9]);
});

test('fitToLength handles same, shorter, and longer inputs', () => {
  const exact = new Float32Array([1, 2, 3]);
  assert.equal(fitToLength(exact, 3), exact);
  assert.deepEqual([...fitToLength(new Float32Array([1, 2, 3, 4]), 3)], [1, 2, 3]);
  // Longer: holds the last sample rather than zero-padding.
  assert.deepEqual([...fitToLength(new Float32Array([1, 2, 3]), 5)], [1, 2, 3, 3, 3]);
});

test('effectsFingerprintsEqual compares every effect input', () => {
  const buffer = {};
  const base = {
    buffer, length: 100, sampleRate: 48000,
    denoiseEnabled: true, loudnessEnabled: true, targetLufs: -16, truePeakDbtp: -1
  };
  assert.ok(effectsFingerprintsEqual(base, { ...base }));
  assert.ok(!effectsFingerprintsEqual(base, null));
  assert.ok(!effectsFingerprintsEqual(null, { ...base }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, buffer: {} }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, length: 101 }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, sampleRate: 44100 }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, denoiseEnabled: false }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, loudnessEnabled: false }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, targetLufs: -14 }));
  assert.ok(!effectsFingerprintsEqual(base, { ...base, truePeakDbtp: -2 }));
  // Scope + per-segment signature are part of the fingerprint so a chip toggle
  // or a scope switch forces a recomposite.
  const scoped = { ...base, effectScope: 'segment', segNoiseSig: '0-3;' };
  assert.ok(effectsFingerprintsEqual(scoped, { ...scoped }));
  assert.ok(!effectsFingerprintsEqual(scoped, { ...scoped, effectScope: 'all' }));
  assert.ok(!effectsFingerprintsEqual(scoped, { ...scoped, segNoiseSig: '' }));
});

test('segmentEffectOn: whole-recording scope applies to every segment', () => {
  withState({ effectScope: 'all' }, () => {
    assert.equal(segmentEffectOn({ fxOff: ['noise'] }, 'noise'), true);
  });
  withState({ effectScope: 'segment' }, () => {
    assert.equal(segmentEffectOn({ fxOff: [] }, 'noise'), true);
    assert.equal(segmentEffectOn({ fxOff: ['noise'] }, 'noise'), false);
    assert.equal(segmentEffectOn({}, 'noise'), true);
  });
});

test('perSegmentNoiseSignature: empty unless in segment scope with opt-outs', () => {
  withState({ effectScope: 'all', segments: [{ start: 0, end: 3, origin: 'x', fxOff: ['noise'] }] }, () => {
    assert.equal(perSegmentNoiseSignature(), '');
  });
  withState({ effectScope: 'segment', segments: [{ start: 0, end: 3, origin: 'x', fxOff: [] }] }, () => {
    assert.equal(perSegmentNoiseSignature(), '');
  });
  withState({ effectScope: 'segment', segments: [
    { start: 0, end: 3, origin: 'x', fxOff: [] },
    { start: 3, end: 6, origin: 'x', fxOff: ['noise'] }
  ] }, () => {
    assert.equal(perSegmentNoiseSignature(), '3-6;');
  });
});

test('buildDenoiseComposite returns the denoise cache when nothing opts out', () => {
  const raw = mockAudioBuffer([new Float32Array([1, 1, 1, 1])]);
  const cache = createChannelCache([new Float32Array([9, 9, 9, 9])], 4, 48000);
  // Whole-recording scope: opt-outs are ignored, so the full cache is used.
  withState({ effectScope: 'all', segments: [{ start: 0, end: 4, origin: 'x', fxOff: ['noise'] }] }, () => {
    assert.equal(buildDenoiseComposite(raw, cache), cache);
  });
  // Segment scope but no segment opted out → still the full cache (no copy).
  withState({ effectScope: 'segment', segments: [{ start: 0, end: 4, origin: 'x', fxOff: [] }] }, () => {
    assert.equal(buildDenoiseComposite(raw, cache), cache);
  });
});

test('buildDenoiseComposite splices raw into segments that opted out of noise', () => {
  const raw = mockAudioBuffer([new Float32Array([1, 2, 3, 4, 5, 6])]);
  const cache = createChannelCache([new Float32Array([9, 9, 9, 9, 9, 9])], 6, 48000);
  withState({ effectScope: 'segment', segments: [
    { start: 0, end: 3, origin: 'x', fxOff: [] },        // noise on → denoised
    { start: 3, end: 6, origin: 'x', fxOff: ['noise'] }  // noise off → raw
  ] }, () => {
    const out = buildDenoiseComposite(raw, cache);
    assert.notEqual(out, cache);
    assert.deepEqual([...out.getChannelData(0)], [9, 9, 9, 4, 5, 6]);
    // The denoise cache itself is never mutated.
    assert.deepEqual([...cache.getChannelData(0)], [9, 9, 9, 9, 9, 9]);
  });
});

test('mergeSyncHints keeps the stronger hint', () => {
  const full = { type: 'full' };
  const light = { type: 'light' };
  const appendA = { type: 'append', oldLen: 100 };
  const appendB = { type: 'append', oldLen: 250 };

  assert.equal(mergeSyncHints(null, light), light);
  assert.equal(mergeSyncHints(light, null), light);
  assert.deepEqual(mergeSyncHints(light, full), { type: 'full' });
  assert.deepEqual(mergeSyncHints(full, appendA), { type: 'full' });
  // Two appends merge to the EARLIER oldLen — processing from there covers both regions.
  assert.deepEqual(mergeSyncHints(appendA, appendB), { type: 'append', oldLen: 100 });
  assert.deepEqual(mergeSyncHints(appendB, appendA), { type: 'append', oldLen: 100 });
  // Append outranks light (a light pass alone would miss the new region's denoise).
  assert.deepEqual(mergeSyncHints(light, appendA), appendA);
  assert.deepEqual(mergeSyncHints(appendA, light), appendA);
  assert.deepEqual(mergeSyncHints(light, light), light);
});

test('isEffectsActive reflects the two effect toggles', () => {
  withState({ loudness: { enabled: false }, denoise: { enabled: false } }, () => {
    assert.equal(isEffectsActive(), false);
    state.loudness.enabled = true;
    assert.equal(isEffectsActive(), true);
    state.loudness.enabled = false;
    state.denoise.enabled = true;
    assert.equal(isEffectsActive(), true);
  });
});

test('getSourceBuffer prefers the processed buffer only at length parity', () => {
  const raw = mockAudioBuffer([new Float32Array(100)]);
  const processed = mockAudioBuffer([new Float32Array(100)]);
  const staleProcessed = mockAudioBuffer([new Float32Array(80)]);
  withState({ originalBuffer: raw, effectsBuffer: null }, () => {
    assert.equal(getSourceBuffer(), raw);
    state.effectsBuffer = processed;
    assert.equal(getSourceBuffer(), processed);
    // A raw mutation that hasn't been synced yet breaks parity → raw fallback.
    state.effectsBuffer = staleProcessed;
    assert.equal(getSourceBuffer(), raw);
    // No raw buffer at all → null (not a stale processed buffer).
    state.originalBuffer = null;
    assert.equal(getSourceBuffer(), null);
  });
});

test('resetEffectsCaches clears the processed buffer', () => {
  const raw = mockAudioBuffer([new Float32Array(10)]);
  const processed = mockAudioBuffer([new Float32Array(10)]);
  withState({ originalBuffer: raw, effectsBuffer: processed }, () => {
    resetEffectsCaches();
    assert.equal(state.effectsBuffer, null);
    assert.equal(getSourceBuffer(), raw);
  });
});
