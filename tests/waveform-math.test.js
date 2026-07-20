import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio, pickRulerIntervalSec, formatRulerLabel, findSingleSegmentRemoval, computePeaksForRange, findSegmentAtSamplePure, computeDropInsertIndexPure, computeReorderTarget, computeReorderArrangement, computeArrangementBounds } from '../js/waveform-math.js';

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

// ===== computeDropInsertIndexPure =====

// Three equal segments on a 1000px canvas with 20px gaps.
// segBounds (from computeSegmentBoundsPure): [0,300,290] [310,600,590] [610,1000,1000]
// Card midpoints: 145, 450, 805.
const DROP_BOUNDS = computeSegmentBoundsPure(1000, [{ start: 0, end: 300 }, { start: 300, end: 600 }, { start: 600, end: 1000 }], 1000, 20);

test('computeDropInsertIndexPure: pointer before the first midpoint → insert at 0', () => {
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 0), 0);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 100), 0);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 144), 0);
});

test('computeDropInsertIndexPure: pointer in the right half of card 0 → insert before 1', () => {
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 146), 1);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 300), 1);
});

test('computeDropInsertIndexPure: pointer in the left half of card 1 → still insert before 1', () => {
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 400), 1);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 449), 1);
});

test('computeDropInsertIndexPure: pointer in the right half of card 1 → insert before 2', () => {
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 451), 2);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 600), 2);
});

test('computeDropInsertIndexPure: pointer past the last midpoint → append at end', () => {
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 806), 3);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 1000), 3);
  assert.equal(computeDropInsertIndexPure(DROP_BOUNDS, 9999), 3);
});

test('computeDropInsertIndexPure: empty segBounds → 0', () => {
  assert.equal(computeDropInsertIndexPure([], 500), 0);
});

// ===== computeReorderTarget =====

test('computeReorderTarget: raw === src or raw === src + 1 is a no-op (-1)', () => {
  assert.equal(computeReorderTarget(0, 0), -1);
  assert.equal(computeReorderTarget(0, 1), -1);
  assert.equal(computeReorderTarget(1, 1), -1);
  assert.equal(computeReorderTarget(1, 2), -1);
  assert.equal(computeReorderTarget(2, 2), -1);
  assert.equal(computeReorderTarget(2, 3), -1);
});

test('computeReorderTarget: moving forward (raw > src+1) decrements after removal', () => {
  // 3 segments [A,B,C]; move A (src=0) to the end (raw=3) → after removing A, insert at 2.
  assert.equal(computeReorderTarget(0, 3), 2);
  // move A to before C (raw=2) → insert at 1.
  assert.equal(computeReorderTarget(0, 2), 1);
  // move B (src=1) to the end (raw=3) → insert at 2.
  assert.equal(computeReorderTarget(1, 3), 2);
});

test('computeReorderTarget: moving backward (raw < src) inserts at raw directly', () => {
  // 3 segments [A,B,C]; move C (src=2) to the front (raw=0) → insert at 0.
  assert.equal(computeReorderTarget(2, 0), 0);
  // move C before B (raw=1) → insert at 1.
  assert.equal(computeReorderTarget(2, 1), 1);
  // move B (src=1) to the front (raw=0) → insert at 0.
  assert.equal(computeReorderTarget(1, 0), 0);
});

test('computeReorderTarget: full round-trip of a forward-then-back move restores order', () => {
  // [A,B,C] → move A to end (src=0, raw=3, target=2) → [B,C,A]
  // → move A (now src=2) back to front (raw=0, target=0) → [A,B,C]
  const segs = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }];
  const t1 = computeReorderTarget(0, 3);
  assert.equal(t1, 2);
  const after = segs.slice();
  const [moved] = after.splice(0, 1);
  after.splice(t1, 0, moved);
  assert.deepEqual(after.map(s => s.start), [10, 20, 0]);
  // A is now at index 2; move it back to the front.
  const t2 = computeReorderTarget(2, 0);
  assert.equal(t2, 0);
  const [moved2] = after.splice(2, 1);
  after.splice(t2, 0, moved2);
  assert.deepEqual(after.map(s => s.start), [0, 10, 20]);
});

// ===== computeReorderArrangement =====

test('computeReorderArrangement: no-op drops return identity', () => {
  assert.deepEqual(computeReorderArrangement(3, 0, 0), [0, 1, 2]);
  assert.deepEqual(computeReorderArrangement(3, 0, 1), [0, 1, 2]);
  assert.deepEqual(computeReorderArrangement(3, 1, 1), [0, 1, 2]);
  assert.deepEqual(computeReorderArrangement(3, 1, 2), [0, 1, 2]);
  assert.deepEqual(computeReorderArrangement(3, 2, 2), [0, 1, 2]);
  assert.deepEqual(computeReorderArrangement(3, 2, 3), [0, 1, 2]);
});

test('computeReorderArrangement: moving forward puts the source at rawInsert-1', () => {
  // [A,B,C]; move A (src=0) to before C (raw=2) → [B,A,C]
  assert.deepEqual(computeReorderArrangement(3, 0, 2), [1, 0, 2]);
  // [A,B,C]; move A (src=0) to the end (raw=3) → [B,C,A]
  assert.deepEqual(computeReorderArrangement(3, 0, 3), [1, 2, 0]);
  // [A,B,C]; move B (src=1) to the end (raw=3) → [A,C,B]
  assert.deepEqual(computeReorderArrangement(3, 1, 3), [0, 2, 1]);
});

test('computeReorderArrangement: moving backward puts the source at rawInsert', () => {
  // [A,B,C]; move C (src=2) to the front (raw=0) → [C,A,B]
  assert.deepEqual(computeReorderArrangement(3, 2, 0), [2, 0, 1]);
  // [A,B,C]; move C (src=2) before B (raw=1) → [A,C,B]
  assert.deepEqual(computeReorderArrangement(3, 2, 1), [0, 2, 1]);
  // [A,B,C]; move B (src=1) to the front (raw=0) → [B,A,C]
  assert.deepEqual(computeReorderArrangement(3, 1, 0), [1, 0, 2]);
});

test('computeReorderArrangement: round-trip forward then back restores order', () => {
  const segs = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }];
  // [A,B,C] → move A (src=0) to the end (raw=3) → arrangement [1,2,0] = [B,C,A]
  const a1 = computeReorderArrangement(3, 0, 3);
  assert.deepEqual(a1, [1, 2, 0]);
  // Apply the arrangement to segs. A is now at position 2 in `after`.
  const after = a1.map(i => segs[i]);
  assert.deepEqual(after.map(s => s.start), [10, 20, 0]);
  // Move A back to the front: src=2 (A's current position), raw=0 (before pos 0).
  const a2 = computeReorderArrangement(3, 2, 0);
  assert.deepEqual(a2, [2, 0, 1]);
  // Apply a2 to `after`: after[2], after[0], after[1] = A, B, C
  const restored = a2.map(i => after[i]);
  assert.deepEqual(restored.map(s => s.start), [0, 10, 20]);
});

test('computeReorderArrangement: single-segment array is always identity', () => {
  assert.deepEqual(computeReorderArrangement(1, 0, 0), [0]);
  assert.deepEqual(computeReorderArrangement(1, 0, 1), [0]);
});

// ===== computeArrangementBounds =====

// Two segments of 500 samples each, 1000 total, on a 1000px canvas with 20px gap.
// Identity arrangement: seg 0 → [0, 490], seg 1 → [510, 1000].
// Swapped arrangement [1, 0]: seg 1 first → [0, 490], seg 0 second → [510, 1000].
const ASEG = [{ start: 0, end: 500 }, { start: 500, end: 1000 }];
const ATOT = 1000;
const AW = 1000;
const AGAP = 20;

test('computeArrangementBounds: identity arrangement matches computeSegmentBoundsPure', () => {
  const id = computeArrangementBounds(AW, ASEG, ATOT, AGAP, [0, 1]);
  const direct = computeSegmentBoundsPure(AW, ASEG, ATOT, AGAP);
  assert.deepEqual(id, [
    { drawStart: direct[0].drawStart, drawEnd: direct[0].drawEnd },
    { drawStart: direct[1].drawStart, drawEnd: direct[1].drawEnd }
  ]);
});

test('computeArrangementBounds: swapped arrangement exchanges the two segments\' positions', () => {
  // [1, 0] → seg 1 is first, seg 0 is second.
  // Seg 1 has length 500, seg 0 has length 500 — both equal, so positions are symmetric.
  const swapped = computeArrangementBounds(AW, ASEG, ATOT, AGAP, [1, 0]);
  // First slot (drawStart=0, drawEnd=490) now belongs to original seg 1.
  assert.equal(swapped[1].drawStart, 0);
  assert.equal(swapped[1].drawEnd, 490);
  // Second slot (drawStart=510, drawEnd=1000) now belongs to original seg 0.
  assert.equal(swapped[0].drawStart, 510);
  assert.equal(swapped[0].drawEnd, 1000);
});

test('computeArrangementBounds: unequal segments get widths proportional to their audio length', () => {
  // Seg 0 = 200 samples, seg 1 = 800 samples. Total 1000. On 1000px canvas with 20px gap.
  // Identity: seg 0 → [0, 190], seg 1 → [210, 1000].
  // Swapped [1, 0]: seg 1 first → [0, 790], seg 0 second → [810, 1000].
  const segs = [{ start: 0, end: 200 }, { start: 200, end: 1000 }];
  const swapped = computeArrangementBounds(1000, segs, 1000, 20, [1, 0]);
  assert.equal(swapped[1].drawStart, 0);
  assert.equal(swapped[1].drawEnd, 790);
  assert.equal(swapped[0].drawStart, 810);
  assert.equal(swapped[0].drawEnd, 1000);
});

test('computeArrangementBounds: result is indexed by ORIGINAL segment index, not arrangement position', () => {
  // Critical property: result[i] is where original segment i should be drawn.
  // For arrangement [2, 0, 1] of three equal segments, original seg 2 is at slot 0,
  // original seg 0 is at slot 1, original seg 1 is at slot 2.
  const segs = [{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 300 }];
  const r = computeArrangementBounds(900, segs, 300, 20, [2, 0, 1]);
  const ordered = computeSegmentBoundsPure(900, [segs[2], segs[0], segs[1]], 300, 20);
  assert.equal(r[2].drawStart, ordered[0].drawStart);
  assert.equal(r[2].drawEnd, ordered[0].drawEnd);
  assert.equal(r[0].drawStart, ordered[1].drawStart);
  assert.equal(r[0].drawEnd, ordered[1].drawEnd);
  assert.equal(r[1].drawStart, ordered[2].drawStart);
  assert.equal(r[1].drawEnd, ordered[2].drawEnd);
});
