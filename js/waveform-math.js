/**
 * Pure (DOM-free) helpers for mapping between audio time ratios and visual
 * pixel ratios on the waveform, accounting for the inter-segment gaps.
 *
 * The waveform is rendered as a row of "cards" (one per kept segment) with
 * `gapPx` of empty space between consecutive cards. The audio itself is
 * contiguous (the edited buffer is the segments concatenated), so every audio
 * ratio in [0,1] belongs to exactly one segment, but its naive linear pixel
 * position `ratio * W` can land inside a visual gap — which represents no audio.
 *
 * These functions provide the gap-aware mapping used by the playhead, carets,
 * time ticks, and drag handling.
 */

export const PEAK_STEP_DIVISOR = 100;

/**
 * Compute min/max peak pairs per pixel column for a range of samples.
 * Returns a Float32Array of length (pixelWidth * 2) with [min, max, min, max, ...].
 *
 * @param {Float32Array} data - channel data
 * @param {number} startSample - first sample index (inclusive)
 * @param {number} endSample - last sample index (exclusive)
 * @param {number} pixelWidth - number of pixel columns
 * @returns {Float32Array}
 */
export function computePeaksForRange(data, startSample, endSample, pixelWidth) {
  const w = Math.max(1, pixelWidth);
  const peaks = new Float32Array(w * 2);
  const totalSamples = endSample - startSample;
  if (totalSamples <= 0) return peaks;

  const samplesPerPixel = totalSamples / w;
  const step = Math.max(1, (samplesPerPixel / PEAK_STEP_DIVISOR) | 0);

  for (let x = 0; x < w; x++) {
    const start = startSample + ((x * samplesPerPixel) | 0);
    const end = Math.min(endSample, startSample + (((x + 1) * samplesPerPixel) | 0));
    let min = 0, max = 0;
    if (start < end) {
      min = 1; max = -1;
      for (let i = start; i < end; i += step) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const v = data[end - 1];
      if (v < min) min = v;
      if (v > max) max = v;
      if (min > max) { min = 0; max = 0; }
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

// ===== Timeline geometry (free-positioned multi-track) =====
//
// The multi-track editor lays clips on a linear time axis (unlike the legacy
// single-track "cards with gaps" ratio model). A clip carries `tStart` — its
// start position on the timeline, in samples of the project sample rate. The
// x-position of any timeline sample is a plain linear map through the current
// zoom (`pxPerSecond`) and horizontal scroll (`scrollLeftSec`). These are the
// pure primitives the canvas renderer, playhead, and hit-testing build on.

/** Samples in a clip (its source range length). */
export function clipLengthSamples(clip) {
  return clip.end - clip.start;
}

/** Timeline end sample of a clip (tStart + length). */
export function clipTimelineEnd(clip) {
  return (clip.tStart || 0) + (clip.end - clip.start);
}

/**
 * Lay a track's clips end-to-end from 0, assigning each `tStart` in samples.
 * This is the contiguous layout (single track, and the default before a clip
 * is freely repositioned). Mutates and returns the clips array.
 * @param {Array<{start:number,end:number,tStart?:number}>} clips
 */
export function layoutContiguous(clips) {
  let acc = 0;
  for (const c of clips) {
    c.tStart = acc;
    acc += (c.end - c.start);
  }
  return clips;
}

/** Timeline sample position → x pixel (same px unit as pxPerSecond). */
export function timeToX(sample, sampleRate, pxPerSecond, scrollLeftSec) {
  return ((sample / sampleRate) - scrollLeftSec) * pxPerSecond;
}

/** Inverse of timeToX: x pixel → nearest timeline sample. */
export function xToTime(x, sampleRate, pxPerSecond, scrollLeftSec) {
  return Math.round((x / pxPerSecond + scrollLeftSec) * sampleRate);
}

/** Longest timeline extent (samples) across every clip of every track. */
export function projectDurationSamples(tracks) {
  let max = 0;
  for (const t of tracks) {
    for (const c of t.segments) {
      const end = clipTimelineEnd(c);
      if (end > max) max = end;
    }
  }
  return max;
}

/** Decibels → linear amplitude gain. */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * The tracks that should be audible in the mixdown given mute/solo state:
 * if any track is soloed, only soloed (and non-muted) tracks sound; otherwise
 * every non-muted track sounds.
 * @template {{muted?: boolean, solo?: boolean}} T
 * @param {T[]} tracks
 * @returns {T[]}
 */
export function audibleTracks(tracks) {
  const anySolo = tracks.some(t => t.solo);
  return tracks.filter(t => (anySolo ? (t.solo && !t.muted) : !t.muted));
}

/**
 * Sum one clip's source samples into the mixdown channels at its timeline
 * offset, scaled by `gain`. Channel-count mismatch falls back to reusing the
 * source's last channel (mono spreads to every mix channel). Out-of-range
 * destination samples are skipped, so a partially off-grid clip is safe.
 *
 * @param {Float32Array[]} mixChannels - destination, one Float32Array per channel
 * @param {Float32Array[]} srcChannels - source track channels
 * @param {number} srcStart - clip source range start (samples)
 * @param {number} srcEnd - clip source range end (samples, exclusive)
 * @param {number} tStartSample - timeline position to write the clip start at
 * @param {number} gain - linear amplitude multiplier
 */
export function addClipToMix(mixChannels, srcChannels, srcStart, srcEnd, tStartSample, gain) {
  const numMixCh = mixChannels.length;
  const numSrcCh = srcChannels.length;
  const len = srcEnd - srcStart;
  for (let ch = 0; ch < numMixCh; ch++) {
    const src = srcChannels[Math.min(ch, numSrcCh - 1)];
    const dst = mixChannels[ch];
    const dstLen = dst.length;
    for (let i = 0; i < len; i++) {
      const d = tStartSample + i;
      if (d < 0) continue;
      if (d >= dstLen) break;
      dst[d] += src[srcStart + i] * gain;
    }
  }
}

// ===== Shared waveform path building =====

function roundedRectPath(path, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) {
    path.rect(x, y, w, h);
    return;
  }
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.arcTo(x + w, y, x + w, y + r, r);
  path.lineTo(x + w, y + h - r);
  path.arcTo(x + w, y + h, x + w - r, y + h, r);
  path.lineTo(x + r, y + h);
  path.arcTo(x, y + h, x, y + h - r, r);
  path.lineTo(x, y + r);
  path.arcTo(x, y, x + r, y, r);
  path.closePath();
}

export function buildOneCardPath(x, w, H, dpr, cornerRadius, insetY) {
  if (w <= 0) return null;
  const cardH = H - 2 * insetY;
  const baseR = cornerRadius * dpr;
  const r = Math.min(baseR, w / 2, cardH / 2);
  const cardPath = new Path2D();
  roundedRectPath(cardPath, x, insetY, w, cardH, r);
  return cardPath;
}

export function buildWaveformPath(path, peaks, startIdx, endIdx, midY, scale) {
  if (startIdx >= endIdx) return;
  path.moveTo(startIdx, midY - peaks[startIdx * 2 + 1] * midY * scale);
  for (let x = startIdx + 1; x < endIdx; x++) {
    path.lineTo(x, midY - peaks[x * 2 + 1] * midY * scale);
  }
  for (let x = endIdx - 1; x >= startIdx; x--) {
    path.lineTo(x, midY - peaks[x * 2] * midY * scale);
  }
  path.closePath();
}

/**
 * Given a sample position in the edited (concatenated) buffer, find which
 * segment it falls in.
 *
 * Returns the last segment for samples past the end (used by callers to
 * handle the playhead at the very end of the recording).
 *
 * @param {Array<{start: number, end: number}>} segments
 * @param {number} editedSample - sample index into the edited (concatenated) buffer
 * @returns {{ index: number, offsetInSeg: number, seg: {start: number, end: number} } | null}
 */
export function findSegmentAtSamplePure(segments, editedSample) {
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLen = seg.end - seg.start;
    if (editedSample < acc + segLen || i === segments.length - 1) {
      return { index: i, offsetInSeg: editedSample - acc, seg };
    }
    acc += segLen;
  }
  return null;
}

/**
 * Compute the pixel bounds for each segment card.
 *
 * @param {number} W - canvas/container width in any consistent unit (CSS px or device px)
 * @param {Array<{start: number, end: number}>} segments - segment ranges in samples of the original buffer
 * @param {number} totalSamples - total samples in the edited buffer (sum of segment lengths)
 * @param {number} gapPx - gap width between cards, in the same unit as W
 * @returns {Array<{start: number, end: number, drawStart: number, drawEnd: number}>}
 *   `start`/`end` are the linear pixel range for the segment's audio;
 *   `drawStart`/`drawEnd` are the visible card edges with the gap carved out.
 */
export function computeSegmentBoundsPure(W, segments, totalSamples, gapPx) {
  const segBounds = [];
  let accSamples = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLen = seg.end - seg.start;
    const startX = Math.floor((accSamples / totalSamples) * W);
    accSamples += segLen;
    const endX = Math.floor((accSamples / totalSamples) * W);

    const gapHalf = gapPx / 2;
    const drawStart = i === 0 ? startX : Math.min(startX + gapHalf, endX);
    const drawEnd = i === segments.length - 1 ? endX : Math.max(startX, endX - gapHalf);

    segBounds.push({ start: startX, end: endX, drawStart, drawEnd });
  }
  return segBounds;
}

/**
 * Detects whether `shorterSegments` is exactly `longerSegments` with one
 * element removed (used by undo/redo to recognize a delete transition
 * between two history snapshots, so it can replay the delete/restore
 * animation instead of an instant redraw).
 *
 * @param {Array<{start: number, end: number}>} longerSegments
 * @param {Array<{start: number, end: number}>} shorterSegments - must have exactly one fewer element than longerSegments
 * @returns {number} the removed index in longerSegments, or -1 if the arrays
 *   aren't a clean single-element removal of each other (e.g. a split/merge,
 *   or boundaries also moved)
 */
export function findSingleSegmentRemoval(longerSegments, shorterSegments) {
  if (longerSegments.length !== shorterSegments.length + 1) return -1;

  let i = 0;
  while (i < shorterSegments.length && segRangesEqual(longerSegments[i], shorterSegments[i])) i++;

  for (let j = i; j < shorterSegments.length; j++) {
    if (!segRangesEqual(longerSegments[j + 1], shorterSegments[j])) return -1;
  }
  return i;
}

function segRangesEqual(a, b) {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

/**
 * Compute where a dragged segment should insert based on the pointer's X
 * position over the segment cards. Returns an insert index in
 * [0, segments.length]: "insert before segment k" for k in [0, length-1],
 * or "append at end" for length.
 *
 * The pointer is compared against each card's midpoint: the first segment
 * whose midpoint is past the pointer dictates the insert position. Pointer
 * in the left half of card k → insert before k; right half → insert before k+1.
 *
 * The result is a *raw* index in terms of the pre-reorder array (the dragged
 * segment is still counted). Use `computeReorderTarget` to convert it to the
 * actual splice target after removal, or to detect a no-op drop.
 *
 * @param {Array<{drawStart: number, drawEnd: number}>} segBounds
 * @param {number} pointerX - pointer position in the same unit as segBounds
 * @returns {number}
 */
export function computeDropInsertIndexPure(segBounds, pointerX) {
  for (let k = 0; k < segBounds.length; k++) {
    const sb = segBounds[k];
    const mid = (sb.drawStart + sb.drawEnd) / 2;
    if (pointerX < mid) return k;
  }
  return segBounds.length;
}

/**
 * Given the source segment's index and a raw drop insert index (both in terms
 * of the pre-reorder array), return the adjusted splice target for the moved
 * segment, or -1 if the drop is a no-op (dropping back where it came from).
 *
 * After `splice(srcIndex, 1)`, indices greater than srcIndex shift down by one,
 * so a raw insert index above srcIndex must be decremented.
 *
 * @param {number} srcIndex
 * @param {number} rawInsertIndex
 * @returns {number} splice target in [0, length-1], or -1 for no-op
 */
export function computeReorderTarget(srcIndex, rawInsertIndex) {
  if (rawInsertIndex === srcIndex || rawInsertIndex === srcIndex + 1) return -1;
  return rawInsertIndex > srcIndex ? rawInsertIndex - 1 : rawInsertIndex;
}

/**
 * Given the source segment's index and a raw drop insert index (both in terms
 * of the pre-reorder array), return the new order as an array of original
 * indices. E.g. for src=0 (moving A) and rawInsert=2 (insert before C), the
 * arrangement is [1, 0, 2] → [B, A, C].
 *
 * Returns the identity arrangement [0, 1, ..., n-1] when the drop is a no-op
 * (rawInsertIndex === srcIndex or rawInsertIndex === srcIndex + 1), so callers
 * can render the live arrangement unconditionally and get a no-motion result
 * when the user hasn't actually moved the segment past a swap threshold.
 *
 * @param {number} segmentsCount
 * @param {number} srcIndex
 * @param {number} rawInsertIndex
 * @returns {number[]} array of original indices in their new order
 */
export function computeReorderArrangement(segmentsCount, srcIndex, rawInsertIndex) {
  const arr = [];
  for (let i = 0; i < segmentsCount; i++) arr.push(i);
  if (rawInsertIndex === srcIndex || rawInsertIndex === srcIndex + 1) return arr;
  const target = rawInsertIndex > srcIndex ? rawInsertIndex - 1 : rawInsertIndex;
  const [moved] = arr.splice(srcIndex, 1);
  arr.splice(target, 0, moved);
  return arr;
}

/**
 * Compute the per-original-index target draw bounds for a live reorder drag.
 * Returns an array (indexed by ORIGINAL segment index) of
 * { drawStart, drawEnd } in the same unit as W (device px or CSS px).
 *
 * `arrangement` is the new order (from computeReorderArrangement) — an array
 * of original indices. We compute the segment bounds in the new order, then
 * invert back to per-original-index so callers can look up "where does
 * original segment i want to be right now?".
 *
 * @param {number} W
 * @param {Array<{start: number, end: number}>} segments - original segments (unchanged during drag)
 * @param {number} totalSamples
 * @param {number} gapPx
 * @param {number[]} arrangement - new order, as original indices
 * @returns {Array<{drawStart: number, drawEnd: number}>}
 */
export function computeArrangementBounds(W, segments, totalSamples, gapPx, arrangement) {
  const ordered = arrangement.map(i => segments[i]);
  const orderedBounds = computeSegmentBoundsPure(W, ordered, totalSamples, gapPx);
  const result = new Array(segments.length);
  for (let k = 0; k < arrangement.length; k++) {
    result[arrangement[k]] = { drawStart: orderedBounds[k].drawStart, drawEnd: orderedBounds[k].drawEnd };
  }
  return result;
}

/**
 * Map an audio-time ratio (fraction of edited duration) to a visual ratio
 * (fraction of canvas width), so the result always lands inside a segment card.
 *
 * @param {number} audioRatio - in [0, 1], fraction of edited audio duration
 * @param {number} W - canvas width in the same unit used to compute segBounds
 * @param {Array<{start: number, end: number, drawStart: number, drawEnd: number}>} segBounds
 * @returns {number} visual ratio in [0, 1]
 */
export function audioRatioToVisualRatio(audioRatio, W, segBounds) {
  if (segBounds.length === 0) return audioRatio;
  const targetPx = audioRatio * W;
  // Float rounding can put a ratio that is meant to be exactly on a segment
  // boundary (e.g. the playhead sitting on a split point) an epsilon BELOW
  // it, which would attribute it to the previous segment and render it at
  // that card's right edge — inside the visual gap. Treat the top EPSILON of
  // each non-last card's linear range as belonging to the NEXT segment so
  // such positions land on the next card's left edge instead.
  const EPSILON = 1e-6;
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const isLast = i === segBounds.length - 1;
    const aboveStart = i === 0 ? targetPx >= sb.start : targetPx >= sb.start - EPSILON;
    const belowEnd = isLast ? targetPx <= sb.end : targetPx < sb.end - EPSILON;
    if (aboveStart && belowEnd) {
      const span = sb.end - sb.start;
      if (span <= 0) return sb.drawStart / W;
      const frac = Math.max(0, (targetPx - sb.start) / span);
      return (sb.drawStart + frac * (sb.drawEnd - sb.drawStart)) / W;
    }
  }
  return audioRatio;
}

/**
 * Inverse of audioRatioToVisualRatio. Maps a visual ratio (e.g. a mouse
 * position over the waveform) back to an audio-time ratio.
 *
 * If the visual position lands inside a gap (which represents no audio), it
 * snaps to the nearest segment boundary — both edges of a gap correspond to
 * the same audio time, so snapping is unambiguous.
 *
 * @param {number} visualRatio - in [0, 1], fraction of canvas width
 * @param {number} W - canvas width in the same unit used to compute segBounds
 * @param {Array<{start: number, end: number, drawStart: number, drawEnd: number}>} segBounds
 * @returns {number} audio ratio in [0, 1]
 */
/**
 * Nice tick intervals (in seconds) the timeline ruler can choose between,
 * from sub-second recordings up to hour-plus ones.
 */
export const RULER_NICE_INTERVALS_SEC = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const RULER_MIN_PX_PER_MAJOR_TICK = 60;

/**
 * Pick the tick interval (seconds) that keeps major ticks readably spaced
 * for a given duration and available ruler width.
 *
 * @param {number} duration - total duration in seconds
 * @param {number} cssWidth - ruler width in CSS px
 * @returns {number} interval in seconds
 */
export function pickRulerIntervalSec(duration, cssWidth) {
  const maxMajorTicks = Math.max(1, Math.floor(cssWidth / RULER_MIN_PX_PER_MAJOR_TICK));
  for (const iv of RULER_NICE_INTERVALS_SEC) {
    if (duration / iv <= maxMajorTicks) return iv;
  }
  return RULER_NICE_INTERVALS_SEC[RULER_NICE_INTERVALS_SEC.length - 1];
}

/**
 * Format a ruler tick label for a given time, at a given chosen interval.
 * Sub-second intervals get a one-decimal seconds field; second-or-coarser
 * intervals show whole mm:ss so labels don't get cluttered.
 *
 * @param {number} t - time in seconds
 * @param {number} intervalSec - the chosen tick interval, from pickRulerIntervalSec
 * @returns {string}
 */
export function formatRulerLabel(t, intervalSec) {
  if (intervalSec < 1) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  }
  const rt = Math.round(t);
  const m = Math.floor(rt / 60);
  const s = rt % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function visualRatioToAudioRatio(visualRatio, W, segBounds) {
  if (segBounds.length === 0) return visualRatio;
  const targetPx = visualRatio * W;

  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    if (targetPx >= sb.drawStart && targetPx < sb.drawEnd) {
      const cardSpan = sb.drawEnd - sb.drawStart;
      if (cardSpan <= 0) return sb.start / W;
      const frac = (targetPx - sb.drawStart) / cardSpan;
      const linearPx = sb.start + frac * (sb.end - sb.start);
      return linearPx / W;
    }
  }

  let bestDist = Infinity;
  let bestRatio = 0;
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const dStart = Math.abs(targetPx - sb.drawStart);
    if (dStart < bestDist) { bestDist = dStart; bestRatio = sb.start / W; }
    const dEnd = Math.abs(targetPx - sb.drawEnd);
    if (dEnd < bestDist) { bestDist = dEnd; bestRatio = sb.end / W; }
  }
  return bestRatio;
}
