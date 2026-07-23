import { state, currentPlaybackRatio } from './state.js';
import { denoiseChannel } from './rnnoise.js';
import { applyNoiseGate } from './noise-gate.js';
import { applyEq } from './eq.js';
import { applyDeEsser } from './deesser.js';
import { buildCompactedChannels } from './trim-silence.js';

// ===== Per-track "source cleanup" effects (denoise → gate → EQ → de-esser) =====
//
// These are per-track EFFECTS, not one-time operations: while enabled they
// apply to ALL of that track's audio, including audio added later (append/
// paste/duplicate/upload). The raw capture in state.originalBuffer is never
// mutated. Instead this module maintains state.effectsBuffer — a processed
// full-length parallel of originalBuffer (every effect is length-preserving,
// so segment {start, end} ranges index into both interchangeably) — and
// editing.js renders/plays/exports from getSourceBuffer() / trackSourceBuffer().
//
// The chain is denoise → gate → EQ → de-esser. Denoise is expensive and async
// (RNNoise WASM in a worker), so its result is cached per raw buffer and
// appended regions are processed incrementally; the gate/EQ/de-esser stages
// are fast synchronous passes that re-run whenever their settings change.
//
// Loudness normalization is NOT here anymore — it's a MASTER finishing effect
// applied to the summed mix in editing.js's rebuildMix() (state.master.loudness).
//
// This module is active-track-centric: it reads state.denoise/gate/eq/deesser
// (proxies onto the active track) and processes state.originalBuffer. A track's
// FX are edited by first making that track active (tracks.js does this), so the
// pipeline always targets the active track; other tracks keep their previously
// computed effectsBuffer (raw unchanged → still valid), which the mix reads.
//
// Effects are non-destructive and live OUTSIDE undo history.
//
// Statically imports only DOM-free modules so it stays Node-testable; DOM-
// touching deps (dom/editing/waveform/ui/playback/tracks) are lazy-loaded.

let _depsPromise = null;
function loadDeps() {
  if (_depsPromise) return _depsPromise;
  _depsPromise = Promise.all([
    import('./editing.js'),
    import('./waveform.js'),
    import('./ui.js'),
    import('./playback.js'),
    import('./tracks.js')
  ]).then(([editMod, waveMod, uiMod, playMod, tracksMod]) => ({
    rebuildPlaybackBuffer: editMod.rebuildPlaybackBuffer,
    drawPlaybackWaveform: waveMod.drawPlaybackWaveform,
    showToast: uiMod.showToast,
    setTransportDisabled: uiMod.setTransportDisabled,
    pausePlayback: playMod.pausePlayback,
    refreshTrackFxUI: tracksMod.refreshTrackFxUI
  }));
  return _depsPromise;
}

// ===== Pure helpers (exported for Node tests) =====

/**
 * A channel-data cache shaped like an AudioBuffer (numberOfChannels /
 * length / sampleRate / getChannelData) so it can feed straight into the
 * DSP modules and buildCompactedChannels.
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

/** Allocate a fresh channel-cache (used as the DSP modules' createBuffer). */
function makeCache(nch, len, sr) {
  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(new Float32Array(len));
  return createChannelCache(channels, len, sr);
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

/** Stable signature of one effect's enabled flag + tracked settings. */
function fxSignature(fx, keys) {
  let s = fx.enabled ? '1' : '0';
  for (const k of keys) s += ':' + fx[k];
  return s;
}

/** Snapshot of every input the effects output depends on. */
function computeEffectsFingerprint() {
  const buf = state.originalBuffer;
  return {
    buffer: buf,
    length: buf ? buf.length : 0,
    sampleRate: buf ? buf.sampleRate : 0,
    denoiseEnabled: state.denoise.enabled,
    gateSig: fxSignature(state.gate, ['thresholdDb', 'attackMs', 'holdMs', 'releaseMs']),
    eqSig: fxSignature(state.eq, ['lowGainDb', 'midGainDb', 'highGainDb']),
    deesserSig: fxSignature(state.deesser, ['thresholdDb', 'amount'])
  };
}

export function effectsFingerprintsEqual(a, b) {
  return !!a && !!b
    && a.buffer === b.buffer
    && a.length === b.length
    && a.sampleRate === b.sampleRate
    && a.denoiseEnabled === b.denoiseEnabled
    && a.gateSig === b.gateSig
    && a.eqSig === b.eqSig
    && a.deesserSig === b.deesserSig;
}

/**
 * @typedef {Object} EffectsSyncHint
 * @property {'full'|'append'|'light'} type - full: re-denoise everything;
 *   append: re-denoise only the region [oldLen, end) (raw buffer grew);
 *   light: keep the denoise cache, re-run only the fast sync stages
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
/** @type {EffectsSyncHint|null} */
let queuedHint = null;
/** @type {Promise<void>|null} */
let drainPromise = null;

export function isEffectsActive() {
  return state.denoise.enabled || state.gate.enabled || state.eq.enabled || state.deesser.enabled;
}

/**
 * The buffer playback/waveform/export/copy must read from: the processed
 * parallel buffer when effects are on, else the raw capture. Length parity
 * is the validity invariant — a raw mutation that hasn't been synced yet
 * changes the length, and raw is the safe fallback until the pipeline commits.
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
 * drain when there's nothing to process. Effect toggles are per-track settings
 * and survive — and so does queuedHint: hints queued against the old buffer
 * degrade gracefully (cache validation fails → full resync), so wiping the
 * queue here would only risk dropping a needed sync.
 */
export function resetEffectsCaches() {
  denoiseCache = null;
  lastCommitted = null;
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
    drainPromise = (async () => {
      try {
        const deps = await loadDeps();
        while (queuedHint) {
          const hintToRun = queuedHint;
          queuedHint = null;
          try {
            await runOneSync(hintToRun, deps);
          } catch (err) {
            console.warn('[nemo-audio]', err);
            // A permanent denoise failure (e.g. WASM failed to load) would
            // otherwise error-toast on every future append — turn it off and
            // rebuild without it.
            if (state.denoise.enabled) {
              state.denoise.enabled = false;
              deps.refreshTrackFxUI();
              deps.showToast(`Noise removal failed and was turned off: ${err.message}`, true);
              queuedHint = mergeSyncHints(queuedHint, { type: 'light' });
            } else {
              deps.showToast(`Effect processing failed: ${err.message}`, true);
            }
          }
        }
      } catch (err) {
        console.warn('[nemo-audio]', err);
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
      deps.drawPlaybackWaveform(currentPlaybackRatio());
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
      // Sync-stage-only pass (gate/EQ/de-esser toggle or settings change) — the
      // denoise cache already covers the whole buffer, so skip the slow stage.
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
  deps.drawPlaybackWaveform(currentPlaybackRatio());
}

// Chain the fast synchronous stages (gate → EQ → de-esser) onto the denoise
// base and commit the processed buffer. Split out so applyEffectsRemap can run
// it synchronously.
function rebuildEffectsBufferFromCaches(fingerprint = null) {
  const buf = state.originalBuffer;
  if (!buf) { state.effectsBuffer = null; lastCommitted = null; return; }
  // Base: the denoise cache when denoise is on, else the raw buffer.
  /** @type {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(c:number)=>Float32Array}} */
  let cur = state.denoise.enabled && denoiseCache ? denoiseCache : buf;
  if (state.gate.enabled) cur = applyNoiseGate(cur, state.gate, makeCache);
  if (state.eq.enabled) cur = applyEq(cur, state.eq, makeCache);
  if (state.deesser.enabled) cur = applyDeEsser(cur, state.deesser, makeCache);
  // If nothing produced a new buffer (all stages off), there's no processed
  // parallel — getSourceBuffer falls back to raw.
  state.effectsBuffer = cur === buf ? null : toAudioBuffer(cur);
  lastCommitted = fingerprint || computeEffectsFingerprint();
}

function toAudioBuffer(bufferLike) {
  const buf = state.audioContext.createBuffer(bufferLike.numberOfChannels, bufferLike.length, bufferLike.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    buf.copyToChannel(bufferLike.getChannelData(c), c);
  }
  return buf;
}

// ===== UI =====

function setBusy(busy, deps) {
  state.denoise.processing = busy;
  deps.refreshTrackFxUI();
  // Transport and the other tools stay disabled while a denoise run owns the
  // pipeline.
  deps.setTransportDisabled(busy || !state.recordedBuffer);
}

/**
 * Re-sync the per-track FX UI to the ACTIVE track's effect state. Called when
 * the active track changes, since denoise/gate/eq/deesser are per-track.
 */
export async function refreshEffectsUI() {
  const deps = await loadDeps();
  deps.refreshTrackFxUI();
}

// ===== Toggle handlers (wired in tracks.js) =====

export async function toggleDenoise(enabled) {
  if (state.denoise.processing) return;
  const deps = await loadDeps();
  if (state.isPlaying) deps.pausePlayback();
  state.denoise.enabled = !!enabled;
  deps.refreshTrackFxUI();
  if (!state.originalBuffer) {
    deps.showToast(enabled ? 'Noise removal on' : 'Noise removal off');
    return;
  }
  await requestEffectsSync({ type: enabled ? 'full' : 'light' });
  // The drain may have flipped denoise back off on failure (it toasts itself).
  if (state.denoise.enabled === !!enabled) {
    deps.showToast(enabled ? 'Noise removal on' : 'Noise removal off');
  }
}

/**
 * Toggle one of the fast synchronous per-track effects (gate/EQ/de-esser).
 * @param {{enabled: boolean}} fx - the live effect object (e.g. state.gate)
 * @param {boolean} enabled
 * @param {string} label - toast label, e.g. 'Noise gate'
 */
async function toggleSyncEffect(fx, enabled, label) {
  const deps = await loadDeps();
  if (state.isPlaying) deps.pausePlayback();
  fx.enabled = !!enabled;
  deps.refreshTrackFxUI();
  if (state.originalBuffer) await requestEffectsSync({ type: 'light' });
  deps.showToast(`${label} ${enabled ? 'on' : 'off'}`);
}

export const toggleGate = (enabled) => toggleSyncEffect(state.gate, enabled, 'Noise gate');
export const toggleEq = (enabled) => toggleSyncEffect(state.eq, enabled, 'EQ');
export const toggleDeesser = (enabled) => toggleSyncEffect(state.deesser, enabled, 'De-esser');

/**
 * Live re-apply when a per-track effect's settings change while it's enabled.
 * Silent — the waveform redraw is the feedback.
 */
export async function refreshSyncEffects() {
  if (!state.originalBuffer || !isEffectsActive()) return;
  await requestEffectsSync({ type: 'light' });
}
