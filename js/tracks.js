// ===== Track lifecycle + per-track mix controls + effects UI =====
//
// The multi-lane timeline UI itself (rows, waveforms, shared playhead, mix
// transport) lives in timeline.js. This module owns the non-rendering side of
// multi-track: adding / removing / switching the active track, the per-track
// mix mutations (mute / solo / gain / offset), and the per-track cleanup-effects
// popover + master finishing popover. timeline.js statically imports the control
// mutations here; in return it registers its render/stop hooks via
// registerTimeline() (see _tl below) so we can trigger a re-render without a
// static import cycle.
//
// Record/upload flows are reused verbatim — a lane's record/upload button just
// makes that track active and triggers the same fresh-capture path the empty
// state uses, so captured audio lands on the selected lane.

import { state, createTrack, getActiveTrack } from './state.js';
import { el } from './dom.js';
import { rebuildPlaybackBuffer, rebuildMix, refreshMasterLoudness } from './editing.js';
import { drawPlaybackWaveform, hideSegmentTrash } from './waveform.js';
import { resetHistory } from './history.js';
import { pausePlayback } from './playback.js';
import { updateEmptyState, updateSegmentCountDisplay, setTransportDisabled, showToast, attachToolbarPopover } from './ui.js';
import { formatTime } from './utils.js';
import { trackSourceBuffer, refreshEffectsUI, toggleDenoise, toggleGate, toggleEq, toggleDeesser, refreshSyncEffects } from './effects.js';

export const TRACK_GAIN_MIN_DB = -30;
export const TRACK_GAIN_MAX_DB = 6;

// Timeline hooks, registered by timeline.js at init (see registerTimeline). This
// indirection avoids a static import cycle: timeline.js statically imports the
// control mutations below, and in return hands us its render/stop functions.
let _tl = { renderTimeline: () => {}, stopTimelinePlayback: () => {} };

/** Called once by timeline.initTimeline() to wire the timeline render/stop hooks. */
export function registerTimeline(hooks) { _tl = hooks; }

/** Re-render the whole multi-lane timeline (headers, lanes, playhead, transport). */
export function updateTracksPanel() {
  _tl.renderTimeline();
}

// ===== Track lifecycle =====

/** Add a fresh empty track and make it active (ready to record/upload into). */
export function addTrack() {
  if (state.isPlaying) pausePlayback();
  _tl.stopTimelinePlayback();
  const n = state.tracks.length + 1;
  state.tracks.push(createTrack({ name: `Track ${n}` }));
  setActiveTrack(state.tracks.length - 1);
  updateTracksPanel();
  showToast(`Track ${n} added — record or upload into it`);
}

/**
 * Remove a track. The last remaining track is never removed — it's reset to
 * an empty lane instead, so the app always has at least one track.
 */
export function removeTrack(index) {
  if (index < 0 || index >= state.tracks.length) return;
  if (state.isPlaying) pausePlayback();
  _tl.stopTimelinePlayback();

  if (state.tracks.length === 1) {
    state.tracks[0] = createTrack({ name: 'Track 1' });
    state.activeTrackIndex = 0;
  } else {
    state.tracks.splice(index, 1);
    if (state.activeTrackIndex >= state.tracks.length) {
      state.activeTrackIndex = state.tracks.length - 1;
    } else if (state.activeTrackIndex > index) {
      state.activeTrackIndex--;
    }
  }
  reloadActiveTrackEditor();
  rebuildMix();
  updateTracksPanel();
}

/**
 * Switch which track the editor edits. Rebuilds the editor buffer for that
 * track and resets the (per-active-track) undo history.
 */
export function setActiveTrack(index) {
  if (index < 0 || index >= state.tracks.length) return;
  if (state.activeTrackIndex !== index) {
    if (state.isPlaying) pausePlayback();
    state.activeTrackIndex = index;
  }
  reloadActiveTrackEditor();
  _tl.renderTimeline();
}

/** Rebuild the editor view/state for the current active track. */
function reloadActiveTrackEditor() {
  resetHistory();
  state.playbackOffset = 0;
  state.selectedSegmentIndex = -1;
  state.hoverSegmentIndex = -1;
  hideSegmentTrash();
  rebuildPlaybackBuffer();
  const dur = state.recordedBuffer ? state.recordedBuffer.duration : 0;
  el.timeCurrent.textContent = '00:00.000';
  el.timeTotal.textContent = formatTime(dur);
  updateSegmentCountDisplay();
  setTransportDisabled(!state.recordedBuffer);
  updateEmptyState();
  state.cachedPeaks = null;
  state.cachedPath = null;
  drawPlaybackWaveform(0);
  refreshEffectsUI(); // sync the per-track effects toolbar to this track
}

// ===== Per-track control mutations =====

export function toggleMute(index) {
  const t = state.tracks[index];
  if (!t) return;
  t.muted = !t.muted;
  refreshMix();
}

export function toggleSolo(index) {
  const t = state.tracks[index];
  if (!t) return;
  t.solo = !t.solo;
  refreshMix();
}

/**
 * @param {number} index
 * @param {number} db
 * @param {{rebuild?: boolean}} [opts] - rebuild:false updates the stored value
 *   only, skipping the O(all-samples) mixdown. Used for the live `input` events
 *   while dragging the volume slider; the `change` event (drag end) then does
 *   the single rebuild.
 */
export function setGainDb(index, db, { rebuild = true } = {}) {
  const t = state.tracks[index];
  if (!t) return;
  t.gainDb = Math.max(TRACK_GAIN_MIN_DB, Math.min(TRACK_GAIN_MAX_DB, db));
  if (rebuild) { rebuildMix(); _tl.renderTimeline(); }
}

export function setOffsetSeconds(index, seconds) {
  const t = state.tracks[index];
  if (!t) return;
  const src = trackSourceBuffer(t);
  const sr = src ? src.sampleRate : (state.audioContext ? state.audioContext.sampleRate : 48000);
  t.offsetSamples = Math.max(0, Math.round(seconds * sr));
  rebuildMix();
  _tl.renderTimeline();
}

function refreshMix() {
  rebuildMix();
  _tl.renderTimeline();
}

// ===== Lane control icons (consumed by timeline.js's lane headers) =====

export const SVG_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
export const SVG_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
export const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
export const SVG_FX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>';
export const SVG_SPINNER = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

// ===== Per-track effects dropdown + master finishing =====
//
// Cleanup effects (denoise/gate/EQ/de-esser) are per-track; the shared
// #trackFxPopover edits whichever track is active. A row's FX button opens it
// (after making that track active). The master #masterFxPopover holds the
// finishing loudness control, which applies to the summed mix (state.master).

/** Count of enabled cleanup effects on a track (drives the lane's FX dot). */
export function enabledFxCount(track) {
  return (track.denoise.enabled ? 1 : 0) + (track.gate.enabled ? 1 : 0)
    + (track.eq.enabled ? 1 : 0) + (track.deesser.enabled ? 1 : 0);
}

let fxPopoverOpen = false;

/** Toggle the FX popover for track i (opening it makes the track active). */
export function toggleTrackFxPopover(i) {
  if (fxPopoverOpen && i === state.activeTrackIndex) { closeTrackFxPopover(); return; }
  setActiveTrack(i);
  openTrackFxPopover();
}

function openTrackFxPopover() {
  syncTrackFxControls();
  const pop = el.trackFxPopover;
  pop.hidden = false;
  fxPopoverOpen = true;
  positionTrackFxPopover();
}

/** Anchor the popover under the active lane's FX button, clamped to the timeline. */
function positionTrackFxPopover() {
  const btn = el.timeline ? el.timeline.querySelector('.tl-lane.is-active .track-fx') : null;
  const pop = el.trackFxPopover;
  if (!btn || !el.timeline) return;
  const panelRect = el.timeline.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  let left = btnRect.left - panelRect.left;
  const top = btnRect.bottom - panelRect.top + 6;
  const maxLeft = panelRect.width - pop.offsetWidth - 8;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function closeTrackFxPopover() {
  el.trackFxPopover.hidden = true;
  fxPopoverOpen = false;
}

/** Push the active track's effect state into the popover controls. */
function syncTrackFxControls() {
  const t = getActiveTrack();
  el.trackFxTitle.textContent = `${t.name} · effects`;
  el.fxDenoiseEnabled.checked = t.denoise.enabled;
  el.fxDenoiseEnabled.disabled = t.denoise.processing;
  el.fxGateEnabled.checked = t.gate.enabled;
  el.fxGateThreshold.value = String(t.gate.thresholdDb);
  el.fxEqEnabled.checked = t.eq.enabled;
  el.fxEqLow.value = String(t.eq.lowGainDb);
  el.fxEqMid.value = String(t.eq.midGainDb);
  el.fxEqHigh.value = String(t.eq.highGainDb);
  el.fxDeesserEnabled.checked = t.deesser.enabled;
  el.fxDeesserAmount.value = String(t.deesser.amount);
}

/**
 * Refresh the FX UI to the active track's state — re-renders the rail (FX dots
 * / denoise spinner) and re-syncs the open popover. Called by effects.js after
 * a toggle/settings change and on active-track switch.
 */
export function refreshTrackFxUI() {
  if (!el.timeline || el.timeline.hidden) { if (fxPopoverOpen) closeTrackFxPopover(); return; }
  _tl.renderTimeline();
  if (fxPopoverOpen) { syncTrackFxControls(); positionTrackFxPopover(); }
}

/** Update the master "Finishing" button's active state. */
function updateMasterFxButton() {
  if (!el.masterFxButton) return;
  el.masterFxButton.classList.toggle('is-on', state.master.loudness.enabled);
}

/**
 * Wire the per-track FX popover controls and the master finishing popover.
 * Called once from main.js.
 */
export function initEffectsUI() {
  // --- Per-track cleanup effects ---
  el.fxDenoiseEnabled.addEventListener('change', () => toggleDenoise(el.fxDenoiseEnabled.checked));
  el.fxGateEnabled.addEventListener('change', () => toggleGate(el.fxGateEnabled.checked));
  el.fxGateThreshold.addEventListener('change', () => {
    const v = Math.round(Number(el.fxGateThreshold.value));
    if (Number.isFinite(v)) state.gate.thresholdDb = Math.max(-80, Math.min(0, v));
    el.fxGateThreshold.value = String(state.gate.thresholdDb);
    refreshSyncEffects();
  });
  el.fxEqEnabled.addEventListener('change', () => toggleEq(el.fxEqEnabled.checked));
  const wireEqBand = (input, key) => input.addEventListener('input', () => {
    const v = Math.round(Number(input.value));
    if (Number.isFinite(v)) state.eq[key] = Math.max(-12, Math.min(12, v));
    refreshSyncEffects();
  });
  wireEqBand(el.fxEqLow, 'lowGainDb');
  wireEqBand(el.fxEqMid, 'midGainDb');
  wireEqBand(el.fxEqHigh, 'highGainDb');
  el.fxDeesserEnabled.addEventListener('change', () => toggleDeesser(el.fxDeesserEnabled.checked));
  el.fxDeesserAmount.addEventListener('input', () => {
    const v = Number(el.fxDeesserAmount.value);
    if (Number.isFinite(v)) state.deesser.amount = Math.max(0, Math.min(1, v));
    refreshSyncEffects();
  });

  // Dismissal: outside pointerdown / Escape / blur / resize.
  document.addEventListener('pointerdown', (e) => {
    if (!fxPopoverOpen) return;
    const target = /** @type {Node} */ (e.target);
    if (el.trackFxPopover.contains(target)) return;
    if (/** @type {HTMLElement} */ (target).closest && /** @type {HTMLElement} */ (target).closest('.track-fx')) return;
    closeTrackFxPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (fxPopoverOpen && e.code === 'Escape') { e.stopImmediatePropagation(); closeTrackFxPopover(); }
  });
  window.addEventListener('blur', closeTrackFxPopover);
  window.addEventListener('resize', closeTrackFxPopover);

  // --- Master finishing (loudness on the whole mix) ---
  attachToolbarPopover(el.masterFxButton, el.masterFxPopover);
  el.masterLoudnessEnabled.checked = state.master.loudness.enabled;
  el.masterTargetLufs.value = String(state.master.loudness.targetLufs);
  el.masterTruePeak.value = String(state.master.loudness.truePeakDbtp);
  updateMasterFxButton();

  el.masterLoudnessEnabled.addEventListener('change', () => {
    state.master.loudness.enabled = el.masterLoudnessEnabled.checked;
    updateMasterFxButton();
    refreshMasterLoudness();
    _tl.renderTimeline();
    showToast(state.master.loudness.enabled ? 'Loudness normalization on (mix)' : 'Loudness normalization off');
  });
  el.masterTargetLufs.addEventListener('change', () => {
    const v = Number(el.masterTargetLufs.value);
    if (Number.isFinite(v)) state.master.loudness.targetLufs = Math.max(-70, Math.min(0, v));
    el.masterTargetLufs.value = String(state.master.loudness.targetLufs);
    refreshMasterLoudness();
    _tl.renderTimeline();
  });
  el.masterTruePeak.addEventListener('change', () => {
    const v = Number(el.masterTruePeak.value);
    if (Number.isFinite(v)) state.master.loudness.truePeakDbtp = Math.min(0, v);
    el.masterTruePeak.value = String(state.master.loudness.truePeakDbtp);
    refreshMasterLoudness();
    _tl.renderTimeline();
  });
  el.loudnessPresets.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.fx-preset');
    if (!btn) return;
    const lufs = Number(btn.getAttribute('data-lufs'));
    if (!Number.isFinite(lufs)) return;
    state.master.loudness.targetLufs = lufs;
    state.master.loudness.enabled = true;
    el.masterLoudnessEnabled.checked = true;
    el.masterTargetLufs.value = String(lufs);
    updateMasterFxButton();
    refreshMasterLoudness();
    _tl.renderTimeline();
    showToast(`Loudness normalization on · ${lufs} LUFS`);
  });
}

// Master mix playback now lives in timeline.js (the single shared-playhead
// transport plays state.mixBuffer). tracks.js only owns track lifecycle,
// per-track mix controls, and the effects UI.
