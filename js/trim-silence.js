import { state, currentPlaybackRatio } from './state.js';

export const TRIM_SILENCE_WINDOW_MS = 50;
export const TRIM_SILENCE_HOP_MS = 25;

// ===== Pure DSP =====

/**
 * Compute the RMS (root mean square) amplitude of `samples[start..end)` as a
 * linear value. Used as the basis for dBFS conversion.
 *
 * @param {Float32Array} samples
 * @param {number} start - inclusive start index
 * @param {number} end - exclusive end index
 * @returns {number} RMS in the range [0, 1] (or higher for unclipped buffers)
 */
export function rmsAmplitude(samples, start, end) {
  if (end <= start) return 0;
  let sumSq = 0;
  for (let i = start; i < end; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / (end - start));
}

/**
 * Convert a linear amplitude to dBFS. Zero amplitude → -Infinity (so any
 * threshold comparison is well-defined).
 *
 * @param {number} amplitude - linear amplitude (e.g. RMS)
 * @returns {number} amplitude in dBFS, or -Infinity for amplitude <= 0
 */
export function amplitudeToDb(amplitude) {
  if (amplitude <= 0) return -Infinity;
  return 20 * Math.log10(amplitude);
}

/**
 * Slide a fixed-size RMS window across `buffer` (an AudioBuffer-like object
 * with `sampleRate`, `length`, `numberOfChannels`, `getChannelData()`) and
 * return the sample ranges of silent regions.
 *
 * "Silent" = the window RMS of EVERY channel is below `thresholdDb` (i.e. the
 * per-channel max window RMS is below threshold) — so content present only on
 * one channel of a stereo recording is never mistaken for silence.
 * Consecutive silent windows are merged into one region; regions shorter than
 * `minSilenceMs` are discarded.
 *
 * @param {{sampleRate: number, length: number, numberOfChannels: number, getChannelData: (channel: number) => Float32Array}} buffer
 * @param {{thresholdDb: number, minSilenceMs: number, windowMs?: number, hopMs?: number}} opts
 * @returns {Array<{start: number, end: number}>} sample ranges (start inclusive, end exclusive) sorted ascending
 */
export function detectSilenceRegions(buffer, opts) {
  const thresholdDb = opts.thresholdDb;
  const minSilenceMs = opts.minSilenceMs;
  const windowMs = opts.windowMs != null ? opts.windowMs : TRIM_SILENCE_WINDOW_MS;
  const hopMs = opts.hopMs != null ? opts.hopMs : TRIM_SILENCE_HOP_MS;

  const sr = buffer.sampleRate;
  const totalSamples = buffer.length;
  const winSamples = Math.max(1, Math.round(windowMs * sr / 1000));
  const hopSamples = Math.max(1, Math.round(hopMs * sr / 1000));

  if (totalSamples < winSamples) return [];

  const channelData = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channelData.push(buffer.getChannelData(c));

  // Loudest per-channel window RMS decides silence, so a quiet channel can't
  // hide real audio on another channel.
  const maxWindowRms = (start, end) => {
    let max = 0;
    for (const data of channelData) {
      const rms = rmsAmplitude(data, start, end);
      if (rms > max) max = rms;
    }
    return max;
  };

  const regions = [];
  let regionStart = -1;
  let regionEnd = -1;

  let cursor = 0;
  while (cursor + winSamples <= totalSamples) {
    const winEnd = cursor + winSamples;
    const db = amplitudeToDb(maxWindowRms(cursor, winEnd));
    const silent = db < thresholdDb;
    if (silent) {
      if (regionStart < 0) { regionStart = cursor; regionEnd = winEnd; }
      else { regionEnd = winEnd; }
    } else if (regionStart >= 0) {
      regions.push({ start: regionStart, end: regionEnd });
      regionStart = -1;
      regionEnd = -1;
    }
    cursor += hopSamples;
  }
  // Tail window covering the last < winSamples samples (only if it doesn't
  // already overlap with the last full window).
  if (cursor < totalSamples) {
    const db = amplitudeToDb(maxWindowRms(cursor, totalSamples));
    const silent = db < thresholdDb;
    if (silent) {
      if (regionStart < 0) { regionStart = cursor; regionEnd = totalSamples; }
      else { regionEnd = totalSamples; }
    } else if (regionStart >= 0) {
      regions.push({ start: regionStart, end: regionEnd });
      regionStart = -1;
      regionEnd = -1;
    }
  }
  if (regionStart >= 0) regions.push({ start: regionStart, end: regionEnd });

  const minSamples = Math.round(minSilenceMs * sr / 1000);
  return regions.filter(r => (r.end - r.start) >= minSamples);
}

/**
 * Compute, for each segment, the list of non-silent ranges within the segment
 * (in originalBuffer sample coordinates), and from those produce:
 *   - `entries`: a flat, ascending list of source ranges to copy from originalBuffer
 *   - `newSegments`: the remapped segments pointing into the new compacted buffer
 *   - `segmentLengths`: total non-silent sample count per ORIGINAL segment index
 *
 * Segments that become entirely silent are dropped from `newSegments`.
 *
 * @param {Array<{start: number, end: number, origin?: string, fxOff?: string[]}>} segments
 * @param {Array<{start: number, end: number}>} silenceRegions - sorted ascending, non-overlapping
 * @returns {{
 *   entries: Array<{origIdx: number, srcStart: number, srcEnd: number}>,
 *   newSegments: Array<{start: number, end: number, origin: string, fxOff?: string[], tStart?: number}>,
 *   segmentLengths: number[]
 * }}
 */
export function remapSegments(segments, silenceRegions) {
  const entries = [];
  const newSegments = [];
  const segmentLengths = [];
  let runningOffset = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segStart = seg.start;
    const segEnd = seg.end;
    let cursor = segStart;
    let segLen = 0;

    for (let j = 0; j < silenceRegions.length; j++) {
      const sil = silenceRegions[j];
      if (sil.end <= cursor) continue;
      if (sil.start >= segEnd) break;
      if (sil.start > cursor) {
        const rEnd = Math.min(sil.start, segEnd);
        const len = rEnd - cursor;
        entries.push({ origIdx: i, srcStart: cursor, srcEnd: rEnd });
        segLen += len;
        cursor = rEnd;
      }
      cursor = Math.max(cursor, sil.end);
      if (cursor >= segEnd) break;
    }
    if (cursor < segEnd) {
      const len = segEnd - cursor;
      entries.push({ origIdx: i, srcStart: cursor, srcEnd: segEnd });
      segLen += len;
    }

    segmentLengths.push(segLen);
    if (segLen > 0) {
      const remapped = {
        start: runningOffset,
        end: runningOffset + segLen,
        origin: seg.origin || 'capture'
      };
      // Carry each segment's per-segment effect opt-outs across compaction
      // (only when it has any, so ordinary segments keep their minimal shape).
      if (seg.fxOff && seg.fxOff.length) remapped.fxOff = seg.fxOff.slice();
      newSegments.push(remapped);
      runningOffset += segLen;
    }
  }

  return { entries, newSegments, segmentLengths };
}

/**
 * Build the compacted PCM data, one Float32Array per channel. The result is a
 * copy (not a view) of the relevant samples concatenated in `entries` order.
 *
 * @param {{numberOfChannels: number, getChannelData: (channel: number) => Float32Array}} buffer
 * @param {Array<{srcStart: number, srcEnd: number}>} entries
 * @returns {{channels: Float32Array[], totalLen: number}}
 */
export function buildCompactedChannels(buffer, entries) {
  const nch = buffer.numberOfChannels;
  let totalLen = 0;
  for (const e of entries) totalLen += (e.srcEnd - e.srcStart);

  const channels = [];
  for (let c = 0; c < nch; c++) {
    const src = buffer.getChannelData(c);
    const dst = new Float32Array(totalLen);
    let off = 0;
    for (const e of entries) {
      const len = e.srcEnd - e.srcStart;
      dst.set(src.subarray(e.srcStart, e.srcEnd), off);
      off += len;
    }
    channels.push(dst);
  }
  return { channels, totalLen };
}

// ===== Integration (DOM-dependent — loaded lazily so the module stays Node-testable) =====

let _depsPromise = null;
function loadDeps() {
  if (_depsPromise) return _depsPromise;
  _depsPromise = Promise.all([
    import('./dom.js'),
    import('./utils.js'),
    import('./ui.js'),
    import('./waveform.js'),
    import('./playback.js'),
    import('./history.js'),
    import('./editing.js'),
    import('./effects.js')
  ]).then(([
    domMod,
    utilsMod,
    uiMod,
    waveMod,
    playMod,
    histMod,
    editMod,
    effectsMod
  ]) => ({
    el: domMod.el,
    formatTime: utilsMod.formatTime,
    showToast: uiMod.showToast,
    updateSegmentCountDisplay: uiMod.updateSegmentCountDisplay,
    setTransportDisabled: uiMod.setTransportDisabled,
    updateEmptyState: uiMod.updateEmptyState,
    drawPlaybackWaveform: waveMod.drawPlaybackWaveform,
    hideSegmentTrash: waveMod.hideSegmentTrash,
    clearSegmentHover: waveMod.clearSegmentHover,
    pausePlayback: playMod.pausePlayback,
    pushHistory: histMod.pushHistory,
    rebuildPlaybackBuffer: editMod.rebuildPlaybackBuffer,
    applyEffectsRemap: effectsMod.applyEffectsRemap
  }));
  return _depsPromise;
}

/**
 * Detect silence in the current originalBuffer, compact it out, and remap
 * segments so playback / export reflect the trimmed audio. Undoable.
 *
 * Returns a promise that resolves when the trim is complete (or when the
 * operation is skipped because there's nothing to trim).
 */
export async function applyTrimSilence() {
  const deps = await loadDeps();
  const {
    el, formatTime, showToast, updateSegmentCountDisplay, setTransportDisabled,
    updateEmptyState, drawPlaybackWaveform, hideSegmentTrash, clearSegmentHover,
    pausePlayback, pushHistory, rebuildPlaybackBuffer, applyEffectsRemap
  } = deps;

  if (!state.originalBuffer || !state.audioContext) return;
  if (!state.recordedBuffer) return;
  if (state.isPlaying) pausePlayback();

  const origTotal = state.segments.reduce((acc, s) => acc + (s.end - s.start), 0);

  const silenceRegions = detectSilenceRegions(state.originalBuffer, {
    thresholdDb: state.trimSilence.thresholdDb,
    minSilenceMs: state.trimSilence.minSilenceMs
  });

  const { entries, newSegments, segmentLengths } = remapSegments(state.segments, silenceRegions);
  const newTotal = segmentLengths.reduce((a, b) => a + b, 0);

  if (newTotal === origTotal) {
    showToast('No silence to trim');
    return;
  }
  if (newTotal === 0) {
    showToast('Cannot trim — all audio would be removed', true);
    return;
  }

  const { channels, totalLen } = buildCompactedChannels(state.originalBuffer, entries);

  // Pin the pre-trim buffer: compaction replaces originalBuffer with shorter,
  // repositioned PCM, so undo needs the exact old buffer back.
  pushHistory(true);
  state.bufferEpoch++;

  const nch = state.originalBuffer.numberOfChannels;
  const newOriginal = state.audioContext.createBuffer(nch, totalLen, state.originalBuffer.sampleRate);
  for (let c = 0; c < nch; c++) {
    const ch = /** @type {Float32Array<ArrayBuffer>} */ (/** @type {*} */ (channels[c]));
    newOriginal.copyToChannel(ch, c);
  }
  state.originalBuffer = newOriginal;
  state.segments = newSegments;
  state.cachedPeaks = null;
  state.cachedPath = null;

  // Keep the effects pipeline's processed parallel buffer in sync with the
  // compaction (compacts the denoise cache with the same entries instead of
  // re-denoising, then re-runs the loudness stage). No-op when effects off.
  applyEffectsRemap(entries);

  rebuildPlaybackBuffer();

  hideSegmentTrash();
  clearSegmentHover();
  state.selectedSegmentIndex = -1;
  state.hoverSegmentIndex = -1;
  updateSegmentCountDisplay();

  if (!state.recordedBuffer) {
    state.playbackOffset = 0;
    el.playButton.classList.remove('playing');
    el.timeCurrent.textContent = '00:00.000';
    el.timeTotal.textContent = '00:00.000';
    setTransportDisabled(true);
    updateEmptyState();
    drawPlaybackWaveform(0);
    showToast('Trimmed silence — no audio remaining', true);
    return;
  }

  state.playbackOffset = Math.max(0, Math.min(state.playbackOffset, state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  el.timeTotal.textContent = formatTime(state.recordedBuffer.duration);

  updateEmptyState();
  const ratio = currentPlaybackRatio();
  drawPlaybackWaveform(ratio);

  const removedSamples = origTotal - newTotal;
  const removedSec = removedSamples / state.originalBuffer.sampleRate;
  showToast(`Trimmed silence · removed ${formatTime(removedSec)}`);
}
