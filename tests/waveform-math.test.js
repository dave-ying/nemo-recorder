import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel, findSingleSegmentRemoval, computePeaksForRange, findSegmentAtSamplePure } from '../js/waveform-math.js';

// Two equal segments, each 500 samples of a 1000-sample edited buffer.
// On a 1000px canvas with a 20px gap, each segment's linear range is 500px,
// and the gap carves 10px off each adjacent edge:
//   seg 0: linear [0, 500], card [0, 490]
//   seg 1: linear [500, 1000], card [510, 1000]
// Gap (no audio) spans pixels [490, 510] — the audio boundary at ratio 0.5
// maps linearly to pixel 500, which sits in the middle of this gap.
const W = 1000;
const GAP = 20;
const SEGS = [{ start: 0, end: 500 }, { start: 500, end: 1000 }];
const TOTAL = 1000;
const BOUNDS = computeSegmentBoundsPure(W, SEGS, TOTAL, GAP);

test('computeSegmentBoundsPure carves gaps out of middle segments only', () => {
  assert.deepEqual(BOUNDS, [
    { start: 0, end: 500, drawStart: 0, drawEnd: 490 },
    { start: 500, end: 1000, drawStart: 510, drawEnd: 1000 },
  ]);
});

test('single segment has no gaps — bounds are the full linear range', () => {
  const b = computeSegmentBoundsPure(1000, [{ start: 0, end: 1000 }], 1000, 20);
  assert.deepEqual(b, [{ start: 0, end: 1000, drawStart: 0, drawEnd: 1000 }]);
});

// ===== audioRatioToVisualRatio =====

test('audio ratio 0 and 1 map to the visual edges', () => {
  assert.equal(audioRatioToVisualRatio(0, W, BOUNDS), 0);
  assert.equal(audioRatioToVisualRatio(1, W, BOUNDS), 1);
});

test('audio ratio at the exact boundary snaps to the start of the next card', () => {
  // ratio 0.5 = boundary between seg 0 and seg 1. Should land at drawStart of seg 1 = 510/1000.
  const v = audioRatioToVisualRatio(0.5, W, BOUNDS);
  assert.equal(v, 510 / 1000);
});

test('audio ratio inside a segment maps linearly within that card', () => {
  // ratio 0.25 = halfway through seg 0's audio. Card is [0, 490]. Midpoint = 245/1000.
  assert.equal(audioRatioToVisualRatio(0.25, W, BOUNDS), 245 / 1000);
  // ratio 0.75 = halfway through seg 1's audio. Card is [510, 1000]. Midpoint = 755/1000.
  assert.equal(audioRatioToVisualRatio(0.75, W, BOUNDS), 755 / 1000);
});

test('audio ratio just before the boundary lands near the end of the first card, never in the gap', () => {
  // ratio 0.499 — still inside seg 0. Visual should be inside card [0, 490], not in the gap.
  const v = audioRatioToVisualRatio(0.499, W, BOUNDS);
  assert.ok(v <= 490 / 1000, `expected <= 0.49, got ${v}`);
  assert.ok(v > 0, `expected > 0, got ${v}`);
});

test('audio ratio just after the boundary lands near the start of the second card, never in the gap', () => {
  const v = audioRatioToVisualRatio(0.501, W, BOUNDS);
  assert.ok(v >= 510 / 1000, `expected >= 0.51, got ${v}`);
  assert.ok(v < 1, `expected < 1, got ${v}`);
});

test('single segment: audio ratio maps linearly (no gaps to skip)', () => {
  const b = computeSegmentBoundsPure(1000, [{ start: 0, end: 1000 }], 1000, 20);
  assert.equal(audioRatioToVisualRatio(0.3, 1000, b), 0.3);
  assert.equal(audioRatioToVisualRatio(0.5, 1000, b), 0.5);
});

// ===== visualRatioToAudioRatio =====

test('visual ratio inside a card maps back to the correct audio ratio', () => {
  // Visual midpoint of seg 0's card is 245/1000 → audio 0.25.
  assert.equal(visualRatioToAudioRatio(245 / 1000, W, BOUNDS), 0.25);
  // Visual midpoint of seg 1's card is 755/1000 → audio 0.75.
  assert.equal(visualRatioToAudioRatio(755 / 1000, W, BOUNDS), 0.75);
});

test('visual ratio in a gap snaps to the nearest segment boundary (both gap edges give the same audio time)', () => {
  // Center of the gap at pixel 500 → snap to boundary at audio ratio 0.5.
  assert.equal(visualRatioToAudioRatio(0.5, W, BOUNDS), 0.5);
  // Left edge of gap at pixel 490 → nearest boundary is still 0.5.
  assert.equal(visualRatioToAudioRatio(490 / 1000, W, BOUNDS), 0.5);
  // Right edge of gap at pixel 510 → nearest boundary is still 0.5.
  assert.equal(visualRatioToAudioRatio(510 / 1000, W, BOUNDS), 0.5);
});

test('visual ratio at 0 and 1 maps to audio 0 and 1', () => {
  assert.equal(visualRatioToAudioRatio(0, W, BOUNDS), 0);
  assert.equal(visualRatioToAudioRatio(1, W, BOUNDS), 1);
});

test('roundtrip: audio → visual → audio preserves the audio ratio (inside a card)', () => {
  for (const r of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
    const v = audioRatioToVisualRatio(r, W, BOUNDS);
    const back = visualRatioToAudioRatio(v, W, BOUNDS);
    assert.ok(Math.abs(back - r) < 1e-9, `roundtrip ${r} -> ${v} -> ${back}`);
  }
});

test('three segments: boundary audio ratios never map into a gap', () => {
  const segs = [{ start: 0, end: 300 }, { start: 300, end: 600 }, { start: 600, end: 1000 }];
  const b = computeSegmentBoundsPure(1000, segs, 1000, 20);
  // Boundaries at audio ratio 0.3 and 0.6. Cards are [0,290],[310,590],[610,1000].
  // Gaps are (290,310) and (590,610) — open intervals; card edges belong to cards.
  for (const boundary of [0.3, 0.6]) {
    const v = audioRatioToVisualRatio(boundary, 1000, b);
    assert.ok(v <= 290 / 1000 || v >= 310 / 1000, `boundary ${boundary} visual ${v} landed in gap 1`);
    assert.ok(v <= 590 / 1000 || v >= 610 / 1000, `boundary ${boundary} visual ${v} landed in gap 2`);
  }
});

// ===== pickRulerIntervalSec =====

test('pickRulerIntervalSec picks a coarser interval as duration grows for a fixed width', () => {
  assert.equal(pickRulerIntervalSec(8, 400), 2);
  assert.equal(pickRulerIntervalSec(45, 400), 10);
  assert.equal(pickRulerIntervalSec(75, 400), 15);
  assert.equal(pickRulerIntervalSec(600, 400), 120);
  assert.equal(pickRulerIntervalSec(3700, 400), 900);
});

test('pickRulerIntervalSec picks a sub-second interval for very short durations', () => {
  assert.equal(pickRulerIntervalSec(0.5, 400), 0.1);
});

test('pickRulerIntervalSec never produces more major ticks than the width allows, unless even the coarsest interval overflows', () => {
  for (const duration of [3, 20, 90, 600, 4000]) {
    for (const width of [80, 200, 500]) {
      const interval = pickRulerIntervalSec(duration, width);
      const majorTicks = duration / interval;
      const maxMajorTicks = Math.max(1, Math.floor(width / 60));
      const isCoarsestFallback = interval === 3600;
      assert.ok(isCoarsestFallback || majorTicks <= maxMajorTicks + 1e-9, `duration=${duration} width=${width} interval=${interval} ticks=${majorTicks}`);
    }
  }
});

test('pickRulerIntervalSec falls back to the coarsest interval for very long durations', () => {
  assert.equal(pickRulerIntervalSec(100000, 80), 3600);
});

// ===== formatRulerLabel =====

test('formatRulerLabel shows whole mm:ss for second-or-coarser intervals', () => {
  assert.equal(formatRulerLabel(0, 15), '00:00');
  assert.equal(formatRulerLabel(75, 15), '01:15');
  assert.equal(formatRulerLabel(3600, 900), '60:00');
});

test('formatRulerLabel shows a one-decimal seconds field for sub-second intervals', () => {
  assert.equal(formatRulerLabel(0, 0.1), '00:00.0');
  assert.equal(formatRulerLabel(0.4, 0.1), '00:00.4');
});

// ===== findSingleSegmentRemoval =====

test('finds a removal in the middle of the array', () => {
  const longer = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }];
  const shorter = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
  assert.equal(findSingleSegmentRemoval(longer, shorter), 1);
});

test('finds a removal at the start of the array', () => {
  const longer = [{ start: 0, end: 10 }, { start: 10, end: 20 }];
  const shorter = [{ start: 10, end: 20 }];
  assert.equal(findSingleSegmentRemoval(longer, shorter), 0);
});

test('finds a removal at the end of the array', () => {
  const longer = [{ start: 0, end: 10 }, { start: 10, end: 20 }];
  const shorter = [{ start: 0, end: 10 }];
  assert.equal(findSingleSegmentRemoval(longer, shorter), 1);
});

test('returns -1 when lengths do not differ by exactly one', () => {
  const a = [{ start: 0, end: 10 }, { start: 10, end: 20 }];
  assert.equal(findSingleSegmentRemoval(a, a), -1);
  assert.equal(findSingleSegmentRemoval(a, []), -1);
});

test('returns -1 when a kept segment also changed boundaries (not a clean removal)', () => {
  const longer = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }];
  const shorter = [{ start: 0, end: 10 }, { start: 20, end: 35 }]; // second kept segment's end moved
  assert.equal(findSingleSegmentRemoval(longer, shorter), -1);
});

test('a single-segment array reduced to empty reports the removal at index 0', () => {
  assert.equal(findSingleSegmentRemoval([{ start: 0, end: 10 }], []), 0);
});

// ===== computePeaksForRange =====

test('computePeaksForRange returns correct min/max for a constant signal', () => {
  const data = new Float32Array(1000).fill(0.5);
  const peaks = computePeaksForRange(data, 0, data.length, 10);
  for (let x = 0; x < 10; x++) {
    assert.equal(peaks[x * 2], 0.5, `min at pixel ${x}`);
    assert.equal(peaks[x * 2 + 1], 0.5, `max at pixel ${x}`);
  }
});

test('computePeaksForRange returns correct min/max for alternating extreme signal', () => {
  const data = new Float32Array(1000);
  for (let i = 0; i < data.length; i++) {
    data[i] = i % 2 === 0 ? -1.0 : 1.0;
  }
  const peaks = computePeaksForRange(data, 0, data.length, 10);
  for (let x = 0; x < 10; x++) {
    assert.equal(peaks[x * 2], -1, `min at pixel ${x}`);
    assert.equal(peaks[x * 2 + 1], 1, `max at pixel ${x}`);
  }
});

test('computePeaksForRange with pixelWidth larger than sample count', () => {
  const data = new Float32Array([-0.7, 0.3, 0.9, -0.2]);
  const peaks = computePeaksForRange(data, 0, data.length, 8);
  for (let x = 0; x < 8; x++) {
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    assert.ok(min <= max, `pixel ${x}: min=${min}, max=${max}`);
  }
  // The 4 samples get distributed across 8 pixels; values must appear somewhere in the peaks
  const allPeaks = Array.from(peaks);
  const hasNeg07 = allPeaks.some(v => Math.abs(v - (-0.7)) < 0.001);
  const has03   = allPeaks.some(v => Math.abs(v - 0.3) < 0.001);
  const has09   = allPeaks.some(v => Math.abs(v - 0.9) < 0.001);
  const hasNeg02 = allPeaks.some(v => Math.abs(v - (-0.2)) < 0.001);
  assert.ok(hasNeg07 && has03 && has09 && hasNeg02, 'all data values appear in peaks');
});

test('computePeaksForRange with empty range returns zero-filled peaks', () => {
  const data = new Float32Array([0.5, 0.5]);
  const peaks = computePeaksForRange(data, 0, 0, 5);
  for (let x = 0; x < 5; x++) {
    assert.equal(peaks[x * 2], 0);
    assert.equal(peaks[x * 2 + 1], 0);
  }
});

test('computePeaksForRange with slice in the middle of data', () => {
  const data = new Float32Array(1000);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin(i * 0.1);
  }
  const peaks = computePeaksForRange(data, 200, 800, 20);
  for (let x = 0; x < 20; x++) {
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    assert.ok(min <= max);
    assert.ok(min >= -1 && min <= 1);
    assert.ok(max >= -1 && max <= 1);
  }
  // Verify min/max span covers the slice range
  const globalMin = Math.min(...Array.from({ length: 20 }, (_, x) => peaks[x * 2]));
  const globalMax = Math.max(...Array.from({ length: 20 }, (_, x) => peaks[x * 2 + 1]));
  assert.ok(globalMax > globalMin);
});

// ===== findSegmentAtSamplePure =====

test('finds the first segment at sample 0', () => {
  const segs = [{ start: 0, end: 500 }, { start: 500, end: 1000 }];
  const r = findSegmentAtSamplePure(segs, 0);
  assert.deepEqual(r, { index: 0, offsetInSeg: 0, seg: segs[0] });
});

test('finds the last segment for an exact last-segment sample', () => {
  const segs = [{ start: 0, end: 300 }, { start: 300, end: 600 }];
  const r = findSegmentAtSamplePure(segs, 599);
  assert.deepEqual(r, { index: 1, offsetInSeg: 299, seg: segs[1] });
});

test('finds the correct segment near the middle', () => {
  const segs = [{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 300 }];
  const r = findSegmentAtSamplePure(segs, 150);
  assert.deepEqual(r, { index: 1, offsetInSeg: 50, seg: segs[1] });
});

test('lookup on an exact segment boundary returns the start of the next segment', () => {
  const segs = [{ start: 0, end: 100 }, { start: 100, end: 200 }];
  const r = findSegmentAtSamplePure(segs, 100);
  assert.deepEqual(r, { index: 1, offsetInSeg: 0, seg: segs[1] });
});

test('past-the-end sample returns the last segment by design', () => {
  const segs = [{ start: 0, end: 100 }, { start: 100, end: 200 }];
  const r = findSegmentAtSamplePure(segs, 999);
  assert.deepEqual(r, { index: 1, offsetInSeg: 899, seg: segs[1] });
});

test('single segment: any valid sample returns that segment', () => {
  const segs = [{ start: 10, end: 500 }];
  const r = findSegmentAtSamplePure(segs, 200);
  assert.deepEqual(r, { index: 0, offsetInSeg: 200, seg: segs[0] });
});

test('empty segments array returns null', () => {
  assert.equal(findSegmentAtSamplePure([], 0), null);
});
