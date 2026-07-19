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
 * scissors, time ticks, and drag handling.
 */

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
  for (let i = 0; i < segBounds.length; i++) {
    const sb = segBounds[i];
    const isLast = i === segBounds.length - 1;
    if (targetPx >= sb.start && (targetPx < sb.end || (isLast && targetPx <= sb.end))) {
      const span = sb.end - sb.start;
      if (span <= 0) return sb.drawStart / W;
      const frac = (targetPx - sb.start) / span;
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
