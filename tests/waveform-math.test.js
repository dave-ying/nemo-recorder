import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, visualRatioToAudioRatio } from '../js/waveform-math.js';

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
