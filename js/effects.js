import { state, segmentEffectOn, PER_SEGMENT_EFFECTS } from './state.js';
import { createNormalizedBuffer } from './loudness-normalize.js';
import { denoiseChannel } from './rnnoise.js';
import { buildCompactedChannels } from './trim-silence.js';

// ===== Persistent audio effects (denoise → loudness) =====
//
// Loudness normalization and noise removal are EFFECTS, not one-time
// operations: while enabled they apply to ALL audio, including audio added
// later (record append, upload append, fresh record, fresh upload). The raw
// capture in state.originalBuffer is never mutated by effects. Instead this
// module maintains state.effectsBuffer — a processed full-length parallel of
// originalBuffer (every effect is length-preserving, so segment {start, end}
// ranges index into both interchangeably) — and editing.js renders/plays/
// exports from getSourceBuffer().
//
// Pipeline order is denoise first, then loudness (cleanup before the
// loudness measurement so steady noise doesn't skew the gain). Denoise is
// expensive and async (RNNoise WASM in a worker), so its result is cached
// per raw buffer and appended regions are processed incrementally; loudness
// is a fast synchronous single pass and simply re-runs whenever its inputs
// (source buffer or settings) change.
//
// Effects are non-destructive and live OUTSIDE undo history: toggling one
// off restores the raw audio exactly, so no history snapshot is needed.
//
// Concurrency: all sync requests funnel through a single drain queue
// (requestEffectsSync). A run snapshots the raw buffer reference and aborts
// if the buffer changed underneath it mid-await — every raw mutation
// enqueues its own hint, so the queue always converges to the latest state.
//
// This module statically imports only DOM-free modules so it stays
// Node-testable; DOM-touching deps (dom/editing/waveform/ui/playback) are
// loaded lazily, the same pattern trim-silence.js uses.

const SPINNER_SVG = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

let _depsPromise = null;
function loadDeps() {
  if (_depsPromise) return _depsPromise;
  _depsPromise = Promise.all([
    import('./dom.js'),
    import('./editing.js'),
    import('./waveform.js'),
    import('./ui.js'),
    import('./playback.js')
  ]).then(([domMod, editMod, waveMod, uiMod, playMod]) => ({
    el: domMod.el,
    rebuildPlaybackBuffer: editMod.rebuildPlaybackBuffer,
    drawPlaybackWaveform: waveMod.drawPlaybackWaveform,
    showToast: uiMod.showToast,
    setTransportDisabled: uiMod.setTransportDisabled,
    pausePlayback: playMod.pausePlayback
  }));
  return _depsPromise;
}

// ===== Pure helpers (exported for Node tests) =====

/**
 * A channel-data cache shaped like an AudioBuffer (numberOfChannels /
 * length / sampleRate / getChannelData) so it can feed straight into
 * createNormalizedBuffer and buildCompactedChannels.
 *
 * @param {Float32Array[]} channels
 * @param {number} length
 * @param {number} sampleRate
 */
export function createChannelCache(channels, length, sampleRate) {
  return {
    channels,
    numberOfChannels: channels.length,
    length,
    sampleRate,
    getChannelData: (c) => channels[c]
  };
}

/**
 * Append already-processed region channels onto a cache, producing a new
 * cache. Used when new raw audio was appended and only the new region
 * needed (re)processing.
 *
 * @param {ReturnType<typeof createChannelCache>} cache
 * @param {Float32Array[]} appendedChannels
 */
export function concatChannelCaches(cache, appendedChannels) {
  const appendedLen = appendedChannels[0].length;
  const channels = cache.channels.map((ch, c) => {
    const appended = appendedChannels[Math.min(c, appendedChannels.length - 1)];
    const merged = new Float32Array(cache.length + appendedLen);
    merged.set(ch, 0);
    merged.set(appended, cache.length);
    return merged;
  });
  return createChannelCache(channels, cache.length + appendedLen, cache.sampleRate);
}

/**
 * Fit `src` to exactly `length` samples. Resample round-trips can drift by
 * a sample; hold the last sample rather than zero-padding.
 *
 * @param {Float32Array} src
 * @param {number} length
 * @returns {Float32Array}
 */
export function fitToLength(src, length) {
  if (src.length === length) return src;
  const fitted = new Float32Array(length);
  const copyLen = Math.min(src.length, length);
  fitted.set(src.subarray(0, copyLen));
  if (copyLen < length && copyLen > 0) fitted.fill(src[copyLen - 1], copyLen);
  return fitted;
}

/**
 * A signature of the per-segment noise-removal opt-outs, so a chip toggle (or
 * a range shift while a segment has noise off) invalidates the fingerprint and
 * forces a recomposite. Empty in whole-recording scope (composite == denoise
 * cache) — reordering segments then never triggers a needless recomposite.
 */
export function perSegmentNoiseSignature() {
  if (state.effectScope !== 'segment') return '';
  let sig = '';
  for (const s of state.segments) {
    if (s.fxOff && s.fxOff.includes('noise')) sig += s.start + '-' + s.end + ';';
  }
  return sig;
}

/** Snapshot of every input the effects output depends on. */
function computeEffectsFingerprint() {
  const buf = state.originalBuffer;
  return {
    buffer: buf,
    length: buf ? buf.length : 0,
    sampleRate: buf ? buf.sampleRate : 0,
    denoiseEnabled: state.denoise.enabled,
    loudnessEnabled: state.loudness.enabled,
    targetLufs: state.loudness.targetLufs,
    truePeakDbtp: state.loudness.truePeakDbtp,
    effectScope: state.effectScope,
    segNoiseSig: perSegmentNoiseSignature()
  };
}

export function effectsFingerprintsEqual(a, b) {
  return !!a && !!b
    && a.buffer === b.buffer
    && a.length === b.length
    && a.sampleRate === b.sampleRate
    && a.denoiseEnabled === b.denoiseEnabled
    && a.loudnessEnabled === b.loudnessEnabled
    && a.targetLufs === b.targetLufs
    && a.truePeakDbtp === b.truePeakDbtp
    && a.effectScope === b.effectScope
    && a.segNoiseSig === b.segNoiseSig;
}

/**
 * Build the noise stage's output as a full-length parallel buffer. In
 * whole-recording scope this is just the denoise cache (every sample denoised).
 * In per-segment scope, segments that opted out of noise removal (fxOff
 * includes 'noise') read their raw samples instead — so the processed buffer
 * is a composite: denoised where the effect is on, raw where it's off. Kept
 * full-length so getSourceBuffer()'s length-parity invariant holds and segment
 * ranges still index into it. Pure over (raw, cache, state.segments) — exported
 * for Node tests.
 *
 * @param {AudioBuffer} raw
 * @param {ReturnType<typeof createChannelCache>} cache - full-length denoised channels
 */
export function buildDenoiseComposite(raw, cache) {
  const anyOff = state.effectScope === 'segment'
    && state.segments.some(s => s.fxOff && s.fxOff.includes('noise'));
  if (!anyOff) return cache;

  const nch = cache.numberOfChannels;
  const len = cache.length;
  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(cache.getChannelData(c).slice());
  for (const s of state.segments) {
    if (segmentEffectOn(s, 'noise')) continue; // stays denoised
    const start = Math.max(0, Math.min(len, s.start));
    const end = Math.max(0, Math.min(len, s.end));
    if (end <= start) continue;
    for (let c = 0; c < nch; c++) {
      const rawCh = raw.getChannelData(Math.min(c, raw.numberOfChannels - 1));
      channels[c].set(rawCh.subarray(start, end), start);
    }
  }
  return createChannelCache(channels, len, cache.sampleRate);
}

/**
 * @typedef {Object} EffectsSyncHint
 * @property {'full'|'append'|'light'} type - full: re-denoise everything;
 *   append: re-denoise only the region [oldLen, end) (raw buffer grew);
 *   light: keep the denoise cache, re-run only the loudness stage
 * @property {number} [oldLen] - pre-append raw length (append hints only)
 */

/**
 * Merge two queued hints, keeping the stronger one. Two appends merge to
 * the earlier oldLen (processing from the earlier point covers both
 * regions). Anything combined with a full sync becomes a full sync.
 */
export function mergeSyncHints(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type === 'full' || b.type === 'full') return { type: 'full' };
  if (a.type === 'append' && b.type === 'append') {
    return { type: 'append', oldLen: Math.min(a.oldLen, b.oldLen) };
  }
  return a.type === 'append' ? a : b;
}

// ===== Pipeline state =====

/** @type {ReturnType<typeof createChannelCache>|null} */
let denoiseCache = null;
/** @type {ReturnType<typeof computeEffectsFingerprint>|null} */
let lastCommitted = null;
/** @type {{measuredLufs: number, limited: boolean}|null} — loudness-stage details from the last commit, for toggle toasts */
let lastSyncResult = null;
/** @type {EffectsSyncHint|null} */
let queuedHint = null;
/** @type {Promise<void>|null} */
let drainPromise = null;

export function isEffectsActive() {
  return state.loudness.enabled || state.denoise.enabled;
}

/**
 * The buffer playback/waveform/export/copy must read from: the processed
 * parallel buffer when effects are on, else the raw capture. Length parity
 * is the validity invariant — a raw mutation that hasn't been synced yet
 * changes the length, and raw is the safe fallback until the pipeline
 * commits.
 */
export function getSourceBuffer() {
  return trackSourceBuffer(state.tracks[state.activeTrackIndex]);
}

/**
 * Same read-point rule as getSourceBuffer, but for an arbitrary track (used by
 * the multi-track mixdown, which must pull every track's processed audio, not
 * just the active one). Returns the processed parallel buffer when it is
 * length-valid, else the raw capture.
 * @param {{effectsBuffer: AudioBuffer|null, originalBuffer: AudioBuffer|null}} track
 */
export function trackSourceBuffer(track) {
  const fx = track.effectsBuffer;
  const raw = track.originalBuffer;
  if (fx && raw && fx.length === raw.length) return fx;
  return raw;
}

/**
 * Drop every cache. Called when the recording is replaced
 * (loadBufferAsRecording) or torn down (disconnectMicrophone), and by the
 * drain when there's nothing to process. Effect toggles are session settings
 * and survive — and so does queuedHint: hints queued against the old buffer
 * degrade gracefully (cache validation fails → full resync), so wiping the
 * queue here would only risk dropping a needed sync.
 */
export function resetEffectsCaches() {
  denoiseCache = null;
  lastCommitted = null;
  lastSyncResult = null;
  state.effectsBuffer = null;
}

/**
 * Keep the effect caches valid across a trim-silence compaction. Must be
 * called AFTER state.originalBuffer was swapped for the compacted buffer and
 * BEFORE rebuildPlaybackBuffer. `entries` are the same {srcStart, srcEnd}
 * keep-ranges trim-silence applied to the raw buffer, so the denoise cache
 * can be compacted identically instead of re-denoised from scratch.
 *
 * @param {Array<{srcStart: number, srcEnd: number}>} entries
 */
export function applyEffectsRemap(entries) {
  if (!state.originalBuffer || !state.audioContext) return;
  if (!isEffectsActive()) { state.effectsBuffer = null; return; }
  if (drainPromise || (state.denoise.enabled && !denoiseCache)) {
    // A sync is mid-flight for the pre-remap buffer (or the denoise cache is
    // missing) — invalidate and let the queue rebuild from the remapped raw.
    denoiseCache = null;
    lastCommitted = null;
    requestEffectsSync({ type: 'light' });
    return;
  }
  if (denoiseCache) {
    const compacted = buildCompactedChannels(denoiseCache, entries);
    denoiseCache = createChannelCache(compacted.channels, compacted.totalLen, denoiseCache.sampleRate);
  }
  rebuildEffectsBufferFromCaches();
}

// ===== Drain queue =====

/**
 * Enqueue a sync and return the shared drain promise. All callers awaiting
 * it resolve once the queue has drained past their hint. Safe to call
 * fire-and-forget (the pipeline redraws on commit).
 *
 * @param {EffectsSyncHint} hint
 * @returns {Promise<void>}
 */
export function requestEffectsSync(hint) {
  queuedHint = mergeSyncHints(queuedHint, hint);
  if (!drainPromise) {
    // The drain body never rejects: per-run errors are handled inside, and
    // anything unexpected (e.g. a deps-load failure) is logged — awaiters
    // must never see an unhandled rejection for background effect work.
    drainPromise = (async () => {
      try {
        const deps = await loadDeps();
        while (queuedHint) {
          const hintToRun = queuedHint;
          queuedHint = null;
          try {
            await runOneSync(hintToRun, deps);
          } catch (err) {
            console.warn('[nemo-recorder]', err);
            // A permanent failure (e.g. WASM failed to load) would otherwise
            // error-toast on every future append — turn the effect off and
            // rebuild without it.
            if (state.denoise.enabled) {
              state.denoise.enabled = false;
              updateEffectsUI(deps);
              deps.showToast(`Noise removal failed and was turned off: ${err.message}`, true);
              queuedHint = mergeSyncHints(queuedHint, { type: 'light' });
            } else {
              deps.showToast(`Effect processing failed: ${err.message}`, true);
            }
          }
        }
      } catch (err) {
        console.warn('[nemo-recorder]', err);
      }
    })();
    drainPromise.finally(() => { drainPromise = null; });
  }
  return drainPromise;
}

async function runOneSync(hint, deps) {
  const buf = state.originalBuffer;
  if (!buf || !state.audioContext) {
    resetEffectsCaches();
    return;
  }
  if (!isEffectsActive()) {
    const hadEffects = !!state.effectsBuffer;
    resetEffectsCaches();
    if (hadEffects) {
      deps.rebuildPlaybackBuffer();
      deps.drawPlaybackWaveform(currentRatio());
    }
    return;
  }

  const fingerprint = computeEffectsFingerprint();
  if (lastCommitted && state.effectsBuffer && effectsFingerprintsEqual(lastCommitted, fingerprint)) return;

  // --- Denoise stage (async, per channel) ---
  if (state.denoise.enabled) {
    const cacheValid = denoiseCache
      && denoiseCache.length === buf.length
      && denoiseCache.sampleRate === buf.sampleRate;
    let regionStart = 0;
    if (hint.type === 'light' && cacheValid) {
      // Loudness-only pass (toggle/settings change) — the denoise cache
      // already covers the whole buffer, so skip the expensive stage.
      regionStart = buf.length;
    } else if (hint.type === 'append' && denoiseCache
        && denoiseCache.length === hint.oldLen
        && denoiseCache.sampleRate === buf.sampleRate) {
      regionStart = hint.oldLen;
    }
    if (regionStart < buf.length) {
      setBusy(true, deps);
      try {
        const regionChannels = [];
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const slice = buf.getChannelData(c).subarray(regionStart);
          const denoised = await denoiseChannel(slice, buf.sampleRate);
          // The wait can take seconds; if the raw buffer was swapped
          // meanwhile (paste, new upload), queued hints cover the new state.
          if (state.originalBuffer !== buf) return;
          regionChannels.push(fitToLength(denoised, buf.length - regionStart));
        }
        denoiseCache = regionStart === 0
          ? createChannelCache(regionChannels, buf.length, buf.sampleRate)
          : concatChannelCaches(denoiseCache, regionChannels);
      } finally {
        setBusy(false, deps);
      }
    }
  } else {
    denoiseCache = null;
  }

  rebuildEffectsBufferFromCaches(fingerprint);
  deps.rebuildPlaybackBuffer();
  deps.drawPlaybackWaveform(currentRatio());
}

// Loudness stage (sync DSP over the full program source) + commit. Split
// out so applyEffectsRemap can run it synchronously.
function rebuildEffectsBufferFromCaches(fingerprint = null) {
  const buf = state.originalBuffer;
  // Noise stage: whole-recording → the denoise cache; per-segment → a
  // composite (denoised where on, raw where a segment opted out).
  const base = state.denoise.enabled
    ? (denoiseCache && buf ? buildDenoiseComposite(buf, denoiseCache) : denoiseCache)
    : buf;
  if (!base) { state.effectsBuffer = null; lastCommitted = null; lastSyncResult = null; return; }
  if (state.loudness.enabled) {
    const result = createNormalizedBuffer(base, state.loudness.targetLufs, state.loudness.truePeakDbtp,
      (channels, length, sampleRate) => state.audioContext.createBuffer(channels, length, sampleRate));
    state.effectsBuffer = result.buffer;
    lastSyncResult = { measuredLufs: result.measuredLufs, limited: result.limited };
  } else {
    state.effectsBuffer = toAudioBuffer(base);
    lastSyncResult = null;
  }
  lastCommitted = fingerprint || computeEffectsFingerprint();
}

function toAudioBuffer(bufferLike) {
  const buf = state.audioContext.createBuffer(bufferLike.numberOfChannels, bufferLike.length, bufferLike.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    buf.copyToChannel(bufferLike.getChannelData(c), c);
  }
  return buf;
}

function currentRatio() {
  return state.recordedBuffer && state.recordedBuffer.duration > 0
    ? state.playbackOffset / state.recordedBuffer.duration
    : 0;
}

// ===== UI =====

function setBusy(busy, deps) {
  const { el } = deps;
  state.denoise.processing = busy;
  if (busy) {
    if (!el.removeNoiseButton.dataset.icon) el.removeNoiseButton.dataset.icon = el.removeNoiseButton.innerHTML;
    el.removeNoiseButton.innerHTML = SPINNER_SVG;
  } else if (el.removeNoiseButton.dataset.icon) {
    el.removeNoiseButton.innerHTML = el.removeNoiseButton.dataset.icon;
  }
  updateEffectsUI(deps);
  // Transport and the other tools stay disabled while a denoise run owns
  // the pipeline; ui.js also honors state.denoise.processing for the button.
  deps.setTransportDisabled(busy || !state.recordedBuffer);
}

function updateEffectsUI(deps) {
  const { el } = deps;
  el.removeNoiseButton.classList.toggle('effect-active', state.denoise.enabled);
  el.removeNoiseButton.setAttribute('aria-pressed', String(state.denoise.enabled));
  el.removeNoiseButton.title = state.denoise.processing
    ? 'Removing noise...'
    : state.denoise.enabled
      ? 'Noise removal on — applies to all audio, click to turn off'
      : 'Remove background noise';
  el.normalizeLoudnessButton.classList.toggle('effect-active', state.loudness.enabled);
  el.normalizeLoudnessButton.setAttribute('aria-pressed', String(state.loudness.enabled));
  el.normalizeLoudnessEnabled.checked = state.loudness.enabled;
  updateScopeUI(deps);
}

// The scope segmented control is only meaningful when a per-segmentable effect
// is on (loudness alone can't be scoped). When none is on it's shown disabled;
// the "All on / All off" shortcuts appear only in per-segment scope.
function updateScopeUI(deps) {
  const { el } = deps;
  const active = PER_SEGMENT_EFFECTS.some(e => e.isEnabled());
  el.effectScopeControl.setAttribute('data-disabled', String(!active));
  el.effectScopeAll.classList.toggle('is-selected', state.effectScope === 'all');
  el.effectScopeSegment.classList.toggle('is-selected', state.effectScope === 'segment');
  el.effectScopeAll.setAttribute('aria-pressed', String(state.effectScope === 'all'));
  el.effectScopeSegment.setAttribute('aria-pressed', String(state.effectScope === 'segment'));
  el.segFxQuick.hidden = !(active && state.effectScope === 'segment');
}

/**
 * Switch the per-segmentable effects between whole-recording and per-segment
 * scope. Redraws immediately so the per-segment chips appear/disappear at once,
 * then recomposites the processed buffer for the new scope.
 * @param {'all'|'segment'} scope
 */
export async function setEffectScope(scope) {
  if (scope !== 'all' && scope !== 'segment') return;
  if (state.effectScope === scope) return;
  const deps = await loadDeps();
  state.effectScope = scope;
  updateScopeUI(deps);
  deps.drawPlaybackWaveform(currentRatio());
  if (state.originalBuffer && isEffectsActive()) await requestEffectsSync({ type: 'light' });
}

// ===== Toggle handlers (wired in main.js) =====

export async function toggleLoudness(enabled) {
  const deps = await loadDeps();
  if (state.isPlaying) deps.pausePlayback();
  state.loudness.enabled = !!enabled;
  updateEffectsUI(deps);
  if (!state.originalBuffer) return;
  await requestEffectsSync({ type: 'light' });
  if (!state.loudness.enabled) {
    deps.showToast('Loudness normalization off');
    return;
  }
  const target = state.loudness.targetLufs;
  const ceiling = state.loudness.truePeakDbtp;
  const result = lastSyncResult;
  if (result && !Number.isFinite(result.measuredLufs) && !result.limited) {
    deps.showToast('Loudness normalization on — audio too quiet to measure');
  } else if (result && !Number.isFinite(result.measuredLufs)) {
    deps.showToast(`Loudness normalization on · limited to ${ceiling.toFixed(1)} dBTP`);
  } else if (result && result.limited) {
    deps.showToast(`Loudness normalization on · ${target.toFixed(1)} LUFS · limited at ${ceiling.toFixed(1)} dBTP`);
  } else if (result) {
    deps.showToast(`Loudness normalization on · ${target.toFixed(1)} LUFS (was ${result.measuredLufs.toFixed(1)})`);
  } else {
    deps.showToast('Loudness normalization on');
  }
}

export async function toggleDenoise(enabled) {
  if (state.denoise.processing) return;
  const deps = await loadDeps();
  if (state.isPlaying) deps.pausePlayback();
  state.denoise.enabled = !!enabled;
  updateEffectsUI(deps);
  if (!state.originalBuffer) {
    deps.showToast(enabled ? 'Noise removal on' : 'Noise removal off');
    return;
  }
  await requestEffectsSync({ type: enabled ? 'full' : 'light' });
  // The drain may have flipped the effect back off on failure (it toasts
  // itself) — don't contradict that with a success toast.
  if (state.denoise.enabled === !!enabled) {
    deps.showToast(enabled ? 'Noise removal on' : 'Noise removal off');
  }
}

// Live re-apply when the popover's target/ceiling inputs change while the
// effect is on. Silent — the waveform redraw is the feedback.
export async function refreshLoudness() {
  if (!state.loudness.enabled || !state.originalBuffer) return;
  await requestEffectsSync({ type: 'light' });
}
