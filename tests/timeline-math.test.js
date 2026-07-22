import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipLengthSamples,
  clipTimelineEnd,
  layoutContiguous,
  timeToX,
  xToTime,
  projectDurationSamples,
  dbToGain,
  audibleTracks,
  addClipToMix
} from '../js/waveform-math.js';

test('clipLengthSamples / clipTimelineEnd', () => {
  assert.equal(clipLengthSamples({ start: 100, end: 250 }), 150);
  assert.equal(clipTimelineEnd({ start: 100, end: 250, tStart: 1000 }), 1150);
  // missing tStart is treated as 0
  assert.equal(clipTimelineEnd({ start: 0, end: 480 }), 480);
});

test('layoutContiguous lays clips end to end from 0', () => {
  const clips = [
    { start: 0, end: 100 },
    { start: 500, end: 800 }, // length 300
    { start: 10, end: 60 }    // length 50
  ];
  layoutContiguous(clips);
  assert.equal(clips[0].tStart, 0);
  assert.equal(clips[1].tStart, 100);
  assert.equal(clips[2].tStart, 400);
});

test('timeToX / xToTime are inverses at sample granularity', () => {
  const sr = 48000, pps = 120, scroll = 2; // 2s scrolled off the left
  // sample 3s in => (3-2)*120 = 120px
  assert.equal(timeToX(3 * sr, sr, pps, scroll), 120);
  // round-trips back to the sample
  assert.equal(xToTime(120, sr, pps, scroll), 3 * sr);
  // scroll offset: sample at scrollLeft maps to x=0
  assert.equal(timeToX(2 * sr, sr, pps, scroll), 0);
  assert.equal(xToTime(0, sr, pps, scroll), 2 * sr);
});

test('projectDurationSamples spans the furthest clip across tracks', () => {
  const tracks = [
    { segments: [{ start: 0, end: 100, tStart: 0 }, { start: 0, end: 100, tStart: 100 }] }, // ends at 200
    { segments: [{ start: 0, end: 50, tStart: 900 }] }, // ends at 950
    { segments: [] }
  ];
  assert.equal(projectDurationSamples(tracks), 950);
  assert.equal(projectDurationSamples([{ segments: [] }]), 0);
});

test('dbToGain', () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-6) - 0.501187) < 1e-4);
  assert.ok(Math.abs(dbToGain(6) - 1.995262) < 1e-4);
});

test('audibleTracks honors mute and solo precedence', () => {
  const a = { id: 1 }, b = { id: 2, muted: true }, c = { id: 3 };
  // no solo: all non-muted
  assert.deepEqual(audibleTracks([a, b, c]).map(t => t.id), [1, 3]);
  // solo present: only soloed non-muted
  const s1 = { id: 1, solo: true }, s2 = { id: 2 }, s3 = { id: 3, solo: true, muted: true };
  assert.deepEqual(audibleTracks([s1, s2, s3]).map(t => t.id), [1]);
});

test('addClipToMix sums samples at the timeline offset with gain', () => {
  const mix = [new Float32Array(10)];
  const src = [Float32Array.from([1, 1, 1, 1])];
  addClipToMix(mix, src, 0, 4, 3, 0.5); // write 4 samples of 0.5 starting at index 3
  assert.deepEqual(Array.from(mix[0]), [0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0]);
  // a second clip overlaps and SUMS
  addClipToMix(mix, src, 0, 4, 4, 0.25);
  assert.deepEqual(Array.from(mix[0]), [0, 0, 0, 0.5, 0.75, 0.75, 0.75, 0.25, 0, 0]);
});

test('addClipToMix clamps out-of-range destination samples', () => {
  const mix = [new Float32Array(4)];
  const src = [Float32Array.from([2, 2, 2, 2, 2, 2])];
  // tStart -2 => first two samples are before 0 (skipped), rest lands 0..3
  addClipToMix(mix, src, 0, 6, -2, 1);
  assert.deepEqual(Array.from(mix[0]), [2, 2, 2, 2]);
});

test('addClipToMix spreads mono source across stereo mix', () => {
  const mix = [new Float32Array(3), new Float32Array(3)];
  const src = [Float32Array.from([1, 1, 1])]; // mono
  addClipToMix(mix, src, 0, 3, 0, 1);
  assert.deepEqual(Array.from(mix[0]), [1, 1, 1]);
  assert.deepEqual(Array.from(mix[1]), [1, 1, 1]);
});
