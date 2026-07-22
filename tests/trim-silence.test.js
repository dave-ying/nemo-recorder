import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rmsAmplitude,
  amplitudeToDb,
  detectSilenceRegions,
  remapSegments,
  buildCompactedChannels,
  TRIM_SILENCE_WINDOW_MS,
  TRIM_SILENCE_HOP_MS
} from '../js/trim-silence.js';

// ===== Helpers =====

// Build a buffer-like object with `sampleRate`, `length`, `numberOfChannels`,
// and `getChannelData(c)`. `channels` is an array of Float32Array, one per
// channel. Mirrors the AudioBuffer DOM API surface the DSP functions use.
function makeMockBuffer(channels, sampleRate = 1000) {
  const length = channels[0].length;
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData: (c) => channels[c]
  };
}

// Build a mono buffer with a repeating pattern of (silent | loud) regions.
// `regions` is an array of {silent: boolean, samples: number} entries. Silent
// regions are zeroed; loud regions are filled with a high-amplitude sine so
// RMS is well above any reasonable dB threshold.
function buildPatternBuffer(regions, sampleRate = 1000) {
  let total = 0;
  for (const r of regions) total += r.samples;
  const data = new Float32Array(total);
  let cursor = 0;
  for (const r of regions) {
    if (!r.silent) {
      for (let i = 0; i < r.samples; i++) {
        data[cursor + i] = 0.9 * Math.sin((i / 20) * Math.PI);
      }
    }
    cursor += r.samples;
  }
  return makeMockBuffer([data], sampleRate);
}

// Stereo helper — takes two separate Float32Arrays, one per channel.
function buildStereo(left, right) {
  return makeMockBuffer([left, right]);
}

// ===== rmsAmplitude / amplitudeToDb =====

test('rmsAmplitude: zero-length range returns 0', () => {
  const data = new Float32Array([1, 2, 3]);
  assert.equal(rmsAmplitude(data, 1, 1), 0);
  assert.equal(rmsAmplitude(data, 2, 1), 0);
});

test('rmsAmplitude: constant signal matches the constant', () => {
  const data = new Float32Array(100).fill(0.5);
  assert.ok(Math.abs(rmsAmplitude(data, 0, 100) - 0.5) < 1e-6);
});

test('rmsAmplitude: alternating +1/-1 has RMS of 1', () => {
  const data = new Float32Array(100);
  for (let i = 0; i < 100; i++) data[i] = i % 2 === 0 ? 1 : -1;
  assert.ok(Math.abs(rmsAmplitude(data, 0, 100) - 1) < 1e-6);
});

test('amplitudeToDb: zero amplitude is -Infinity', () => {
  assert.equal(amplitudeToDb(0), -Infinity);
  assert.equal(amplitudeToDb(-1), -Infinity);
});

test('amplitudeToDb: 1.0 is 0 dB, 0.5 is approximately -6 dB', () => {
  assert.equal(amplitudeToDb(1), 0);
  assert.ok(Math.abs(amplitudeToDb(0.5) - (-6.0206)) < 0.001);
});

// ===== detectSilenceRegions =====

test('detectSilenceRegions: empty pattern finds no silence', () => {
  const buf = buildPatternBuffer([{ silent: false, samples: 5000 }]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.deepEqual(regions, []);
});

test('detectSilenceRegions: all-silent pattern returns one region covering the buffer', () => {
  const buf = buildPatternBuffer([{ silent: true, samples: 5000 }]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].start, 0);
  assert.equal(regions[0].end, 5000);
});

test('detectSilenceRegions: synthetic silence + non-silence finds the silent region', () => {
  // 1s of loud, 1s of silence, 1s of loud at 1kHz sample rate.
  // 50ms window, 25ms hop → ~1000 samples per window, 500 hop.
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true, samples: 1000 },
    { silent: false, samples: 1000 }
  ]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 1, `expected 1 region, got ${regions.length}: ${JSON.stringify(regions)}`);
  const r = regions[0];
  // The middle silence starts roughly at sample 1000 and ends at 2000. Allow
  // some slack for the windowing offset (window may extend into the loud
  // neighbouring regions by up to one window length).
  assert.ok(r.start >= 1000, `region start ${r.start} should be ≥ 1000`);
  assert.ok(r.end <= 2000, `region end ${r.end} should be ≤ 2000`);
  assert.ok(r.end - r.start >= 500, `region ${r.start}-${r.end} should be at least 500 samples wide`);
});

test('detectSilenceRegions: two separate silent regions are returned separately', () => {
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true, samples: 1000 },
    { silent: false, samples: 1000 },
    { silent: true, samples: 1000 },
    { silent: false, samples: 1000 }
  ]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 2);
  // First region is roughly in the first third, second in the last third.
  assert.ok(regions[0].end <= 2100, `first region end ${regions[0].end} too far into second half`);
  assert.ok(regions[1].start >= 2900, `second region start ${regions[1].start} too early`);
});

test('detectSilenceRegions: silence shorter than minSilenceMs is NOT detected', () => {
  // 200ms silence between two 1s loud regions. minSilenceMs = 500 → 200ms
  // silence must be filtered out, leaving no regions.
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true, samples: 200 },
    { silent: false, samples: 1000 }
  ]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.deepEqual(regions, []);
});

test('detectSilenceRegions: silence right at minSilenceMs IS detected', () => {
  // 500ms silence is exactly at the threshold — should still be detected.
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true, samples: 500 },
    { silent: false, samples: 1000 }
  ]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 1);
});

test('detectSilenceRegions: silence at start of buffer is detected', () => {
  const buf = buildPatternBuffer([
    { silent: true, samples: 1000 },
    { silent: false, samples: 1000 }
  ]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].start, 0);
  assert.ok(regions[0].end <= 1100);
});

test('detectSilenceRegions: silence at end of buffer is detected', () => {
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true, samples: 1000 }
  ]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 1);
  assert.ok(regions[0].start >= 900);
  assert.equal(regions[0].end, 2000);
});

test('detectSilenceRegions: loud signal above threshold is not detected (RMS > threshold)', () => {
  // 0.9-amplitude sine → RMS ≈ 0.636 → ≈ -3.9 dBFS. Threshold -40 → nothing.
  const data = new Float32Array(5000);
  for (let i = 0; i < data.length; i++) data[i] = 0.9 * Math.sin(i / 20);
  const buf = makeMockBuffer([data]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.deepEqual(regions, []);
});

test('detectSilenceRegions: threshold edge — at threshold is considered silent', () => {
  // Use a constant 0.5 signal: RMS = 0.5 → -6.02 dBFS. With threshold -6,
  // amplitudeToDb(rms) < threshold → silent. With threshold -6.02 (slightly
  // stricter), it's NOT silent. Verify both branches.
  const data = new Float32Array(2000).fill(0.5);
  const buf = makeMockBuffer([data]);
  const silent = detectSilenceRegions(buf, { thresholdDb: -6, minSilenceMs: 200 });
  const loud = detectSilenceRegions(buf, { thresholdDb: -6.05, minSilenceMs: 200 });
  assert.equal(silent.length, 1, 'should detect silence when dB == threshold');
  assert.equal(loud.length, 0, 'should not detect silence when dB > threshold');
});

test('detectSilenceRegions: respects windowMs / hopMs options', () => {
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true, samples: 1000 },
    { silent: false, samples: 1000 }
  ]);
  const fine = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500, windowMs: 25, hopMs: 10 });
  const coarse = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500, windowMs: 200, hopMs: 100 });
  assert.equal(fine.length, 1);
  assert.equal(coarse.length, 1);
  // Both detectors should land inside (or covering) the actual silence range.
  // The exact span depends on window alignment — verify both straddle the
  // middle third of the buffer rather than asserting a specific span.
  for (const r of [fine[0], coarse[0]]) {
    assert.ok(r.start >= 900 && r.start <= 1100, `region start ${r.start} should be near 1000`);
    assert.ok(r.end >= 1900 && r.end <= 2100, `region end ${r.end} should be near 2000`);
  }
});

test('detectSilenceRegions: buffer shorter than window returns empty', () => {
  const buf = buildPatternBuffer([{ silent: true, samples: 10 }]);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 50 });
  assert.deepEqual(regions, []);
});

test('detectSilenceRegions: stereo — content on ANY channel prevents a silence call', () => {
  // Left channel is fully silent; right channel has a loud burst in the
  // middle. A channel-0-only analysis would call the whole buffer silent and
  // trim real audio out of the right channel.
  const sr = 1000;
  const left = new Float32Array(3000); // all silence
  const right = new Float32Array(3000);
  for (let i = 1000; i < 2000; i++) right[i] = 0.9 * Math.sin((i / 20) * Math.PI);
  const buf = buildStereo(left, right);
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  // Both outer thirds are genuinely silent (both channels), the middle is not.
  assert.equal(regions.length, 2);
  assert.equal(regions[0].start, 0);
  assert.ok(regions[0].end <= 1100, `first region end ${regions[0].end} should not reach the burst`);
  assert.ok(regions[1].start >= 1900, `second region start ${regions[1].start} should not overlap the burst`);
  assert.equal(regions[1].end, 3000);
});

test('detectSilenceRegions: stereo — fully silent on both channels is detected', () => {
  const buf = buildStereo(new Float32Array(3000), new Float32Array(3000));
  const regions = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0], { start: 0, end: 3000 });
});

// ===== remapSegments =====

test('remapSegments: no silence preserves all segments and contents', () => {
  const segs = [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1000, end: 2000, origin: 'capture' }
  ];
  const { entries, newSegments, segmentLengths } = remapSegments(segs, []);
  assert.equal(segmentLengths.length, 2);
  assert.deepEqual(segmentLengths, [1000, 1000]);
  assert.deepEqual(newSegments, [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1000, end: 2000, origin: 'capture' }
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { origIdx: 0, srcStart: 0, srcEnd: 1000 });
  assert.deepEqual(entries[1], { origIdx: 1, srcStart: 1000, srcEnd: 2000 });
});

test('remapSegments: full-segment silence drops the segment', () => {
  const segs = [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1000, end: 2000, origin: 'capture' },
    { start: 2000, end: 3000, origin: 'capture' }
  ];
  const silences = [{ start: 1000, end: 2000 }];
  const { entries, newSegments, segmentLengths } = remapSegments(segs, silences);
  assert.deepEqual(segmentLengths, [1000, 0, 1000]);
  // Middle segment dropped; first and third pack together in the new buffer.
  assert.deepEqual(newSegments, [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1000, end: 2000, origin: 'capture' }
  ]);
  // Two entries, one per kept segment.
  assert.equal(entries.length, 2);
});

test('remapSegments: carries per-segment effect opt-outs (fxOff) across compaction', () => {
  const segs = [
    { start: 0, end: 1000, origin: 'capture', fxOff: ['noise'] },
    { start: 1000, end: 2000, origin: 'capture' }
  ];
  // Silence trims the tail of the first segment; its fxOff must survive.
  const silences = [{ start: 900, end: 1000 }];
  const { newSegments } = remapSegments(segs, silences);
  assert.deepEqual(newSegments, [
    { start: 0, end: 900, origin: 'capture', fxOff: ['noise'] },
    { start: 900, end: 1900, origin: 'capture' }
  ]);
});

test('remapSegments: silence inside a segment splits it into one non-silent entry', () => {
  const segs = [{ start: 0, end: 3000, origin: 'capture' }];
  const silences = [{ start: 1000, end: 2000 }];
  const { entries, newSegments, segmentLengths } = remapSegments(segs, silences);
  assert.deepEqual(segmentLengths, [2000]);
  assert.equal(newSegments.length, 1);
  assert.equal(newSegments[0].start, 0);
  assert.equal(newSegments[0].end, 2000);
  // Two entries: before the silence and after it (still part of segment 0).
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { origIdx: 0, srcStart: 0, srcEnd: 1000 });
  assert.deepEqual(entries[1], { origIdx: 0, srcStart: 2000, srcEnd: 3000 });
});

test('remapSegments: multiple silences inside a segment are all collapsed', () => {
  const segs = [{ start: 0, end: 5000, origin: 'capture' }];
  const silences = [
    { start: 500, end: 1000 },
    { start: 2000, end: 2500 },
    { start: 4000, end: 4500 }
  ];
  const { entries, newSegments, segmentLengths } = remapSegments(segs, silences);
  assert.equal(segmentLengths[0], 5000 - 500 - 500 - 500);
  assert.equal(newSegments.length, 1);
  assert.equal(newSegments[0].end - newSegments[0].start, segmentLengths[0]);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { origIdx: 0, srcStart: 0, srcEnd: 500 });
  assert.deepEqual(entries[1], { origIdx: 0, srcStart: 1000, srcEnd: 2000 });
  assert.deepEqual(entries[2], { origIdx: 0, srcStart: 2500, srcEnd: 4000 });
  assert.deepEqual(entries[3], { origIdx: 0, srcStart: 4500, srcEnd: 5000 });
});

test('remapSegments: silence overlapping two segments is subtracted from each independently', () => {
  // 3 segments of 1000 each. A silence region [1500, 2500] overlaps segment 1
  // (1000-2000) entirely and segment 2 (2000-3000) for the first half.
  const segs = [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1000, end: 2000, origin: 'capture' },
    { start: 2000, end: 3000, origin: 'capture' }
  ];
  const silences = [{ start: 1500, end: 2500 }];
  const { entries, newSegments, segmentLengths } = remapSegments(segs, silences);
  // Segment 0 is fully kept (1000 samples), segment 1 contributes 500 (1000-1500),
  // segment 2 contributes 500 (2500-3000). Total: 2000.
  assert.deepEqual(segmentLengths, [1000, 500, 500]);
  assert.equal(newSegments.length, 3);
  // Packed contiguously.
  assert.equal(newSegments[0].start, 0); assert.equal(newSegments[0].end, 1000);
  assert.equal(newSegments[1].start, 1000); assert.equal(newSegments[1].end, 1500);
  assert.equal(newSegments[2].start, 1500); assert.equal(newSegments[2].end, 2000);
  // Entries: seg 0 (whole), seg 1 (first 500), seg 2 (last 500).
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { origIdx: 0, srcStart: 0, srcEnd: 1000 });
  assert.deepEqual(entries[1], { origIdx: 1, srcStart: 1000, srcEnd: 1500 });
  assert.deepEqual(entries[2], { origIdx: 2, srcStart: 2500, srcEnd: 3000 });
});

test('remapSegments: preserves segment origins', () => {
  const segs = [
    { start: 0, end: 100, origin: 'capture' },
    { start: 100, end: 200, origin: 'paste' },
    { start: 200, end: 300, origin: 'split' }
  ];
  const { newSegments } = remapSegments(segs, []);
  assert.equal(newSegments[0].origin, 'capture');
  assert.equal(newSegments[1].origin, 'paste');
  assert.equal(newSegments[2].origin, 'split');
});

test('remapSegments: empty input returns empty results', () => {
  const { entries, newSegments, segmentLengths } = remapSegments([], []);
  assert.deepEqual(entries, []);
  assert.deepEqual(newSegments, []);
  assert.deepEqual(segmentLengths, []);
});

test('remapSegments: silence entirely outside segments is ignored', () => {
  const segs = [{ start: 1000, end: 2000, origin: 'capture' }];
  const silences = [
    { start: 0, end: 500 },      // before
    { start: 2500, end: 3000 }   // after
  ];
  const { newSegments, segmentLengths } = remapSegments(segs, silences);
  assert.deepEqual(segmentLengths, [1000]);
  assert.equal(newSegments[0].end - newSegments[0].start, 1000);
});

// ===== buildCompactedChannels =====

test('buildCompactedChannels: copies samples into one Float32Array per channel', () => {
  const data = new Float32Array(100);
  for (let i = 0; i < 100; i++) data[i] = i;
  const buf = makeMockBuffer([data]);
  const entries = [{ srcStart: 10, srcEnd: 20 }, { srcStart: 30, srcEnd: 40 }];
  const { channels, totalLen } = buildCompactedChannels(buf, entries);
  assert.equal(channels.length, 1);
  assert.equal(totalLen, 20);
  const expected = Array.from(data.subarray(10, 20));
  for (const v of data.subarray(30, 40)) expected.push(v);
  assert.deepEqual(Array.from(channels[0]), expected);
});

test('buildCompactedChannels: handles stereo by copying each channel independently', () => {
  const left = new Float32Array(100);
  const right = new Float32Array(100);
  for (let i = 0; i < 100; i++) { left[i] = i; right[i] = i * 2; }
  const buf = buildStereo(left, right);
  const entries = [{ srcStart: 0, srcEnd: 50 }, { srcStart: 75, srcEnd: 100 }];
  const { channels, totalLen } = buildCompactedChannels(buf, entries);
  assert.equal(channels.length, 2);
  assert.equal(totalLen, 75);
  // Spot-check a few samples on each channel.
  assert.equal(channels[0][0], 0);
  assert.equal(channels[0][49], 49);
  assert.equal(channels[0][50], 75);
  assert.equal(channels[1][0], 0);
  assert.equal(channels[1][49], 98);
  assert.equal(channels[1][50], 150);
});

test('buildCompactedChannels: empty entries produces empty arrays', () => {
  const data = new Float32Array(100);
  const buf = makeMockBuffer([data]);
  const { channels, totalLen } = buildCompactedChannels(buf, []);
  assert.equal(channels.length, 1);
  assert.equal(totalLen, 0);
  assert.equal(channels[0].length, 0);
});

// ===== Integration: full pipeline (no AudioBuffer) =====

test('integration: detect + remap + compact on a 3-segment buffer with inter-segment silence', () => {
  // 3 segments of 1s each at 1kHz sample rate, with 600ms of silence
  // between segments 0-1 and between segments 1-2.
  const sr = 1000;
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 }, // segment 0
    { silent: true,  samples: 600 },  // silence
    { silent: false, samples: 1000 }, // segment 1
    { silent: true,  samples: 600 },  // silence
    { silent: false, samples: 1000 }  // segment 2
  ], sr);

  const silences = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  assert.equal(silences.length, 2);

  const segments = [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1600, end: 2600, origin: 'capture' },
    { start: 3200, end: 4200, origin: 'capture' }
  ];
  const { entries, newSegments, segmentLengths } = remapSegments(segments, silences);
  // All segments are intact (no silence falls INSIDE any segment).
  assert.deepEqual(segmentLengths, [1000, 1000, 1000]);
  assert.equal(newSegments.length, 3);
  // They pack together.
  assert.deepEqual(newSegments, [
    { start: 0, end: 1000, origin: 'capture' },
    { start: 1000, end: 2000, origin: 'capture' },
    { start: 2000, end: 3000, origin: 'capture' }
  ]);
  // Compacted PCM is 3000 samples long with all the original loud data.
  const { channels, totalLen } = buildCompactedChannels(buf, entries);
  assert.equal(totalLen, 3000);
  // Every sample should be loud (RMS way above -40) since silence was removed.
  const rms = rmsAmplitude(channels[0], 0, totalLen);
  assert.ok(rms > 0.5, `compacted RMS ${rms} should be > 0.5`);
});

test('integration: all-silent buffer → zero-length output, segments dropped', () => {
  const sr = 1000;
  const buf = buildPatternBuffer([{ silent: true, samples: 3000 }], sr);
  const silences = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  const segments = [{ start: 0, end: 3000, origin: 'capture' }];
  const { entries, newSegments, segmentLengths } = remapSegments(segments, silences);
  assert.deepEqual(segmentLengths, [0]);
  assert.deepEqual(newSegments, []);
  const { totalLen } = buildCompactedChannels(buf, entries);
  assert.equal(totalLen, 0);
});

test('integration: silence at start of buffer is trimmed, first segment keeps only its tail', () => {
  const sr = 1000;
  const buf = buildPatternBuffer([
    { silent: true,  samples: 700 },
    { silent: false, samples: 1000 }
  ], sr);
  const segments = [{ start: 700, end: 1700, origin: 'capture' }];
  const silences = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  const { newSegments, segmentLengths } = remapSegments(segments, silences);
  assert.deepEqual(segmentLengths, [1000]);
  assert.equal(newSegments.length, 1);
  assert.equal(newSegments[0].start, 0);
  assert.equal(newSegments[0].end, 1000);
});

test('integration: silence at end of buffer is trimmed, last segment keeps only its head', () => {
  const sr = 1000;
  const buf = buildPatternBuffer([
    { silent: false, samples: 1000 },
    { silent: true,  samples: 700 }
  ], sr);
  const segments = [{ start: 0, end: 1000, origin: 'capture' }];
  const silences = detectSilenceRegions(buf, { thresholdDb: -40, minSilenceMs: 500 });
  const { newSegments, segmentLengths } = remapSegments(segments, silences);
  assert.deepEqual(segmentLengths, [1000]);
  assert.equal(newSegments.length, 1);
  assert.equal(newSegments[0].start, 0);
  assert.equal(newSegments[0].end, 1000);
});

// ===== Constants =====

test('TRIM_SILENCE_WINDOW_MS / TRIM_SILENCE_HOP_MS match the spec defaults', () => {
  assert.equal(TRIM_SILENCE_WINDOW_MS, 50);
  assert.equal(TRIM_SILENCE_HOP_MS, 25);
});
