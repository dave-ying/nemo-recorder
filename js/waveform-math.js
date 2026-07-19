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
