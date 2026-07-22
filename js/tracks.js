// ===== Multi-track rail + master mix transport =====
//
// The editor edits ONE active track at a time with the full single-track
// waveform UI (state.recordedBuffer is the active track's own audio). This
// module adds the multi-track layer around it: a rail listing every track with
// per-track controls (record / upload / mute / solo / volume / timeline offset
// / delete), a "+ Add track" button, and a master transport that plays the
// mixed-down state.mixBuffer (all tracks summed at their offsets and gains).
//
// It reuses the existing record/upload/edit flows verbatim — a per-track
// record/upload button just makes that track active and triggers the same
// fresh-capture path the empty state uses, so captured audio lands on the
// selected lane.

import { state, createTrack, getActiveTrack } from './state.js';
import { el } from './dom.js';
import { rebuildPlaybackBuffer, rebuildMix, refreshMasterLoudness } from './editing.js';
import { drawPlaybackWaveform, hideSegmentTrash } from './waveform.js';
import { resetHistory } from './history.js';
import { pausePlayback } from './playback.js';
import { openRecordModal } from './record-modal.js';
import { updateEmptyState, updateSegmentCountDisplay, setTransportDisabled, showToast, attachToolbarPopover } from './ui.js';
import { formatTime } from './utils.js';
import { computePeaksForRange } from './waveform-math.js';
import { trackSourceBuffer, refreshEffectsUI, toggleDenoise, toggleGate, toggleEq, toggleDeesser, refreshSyncEffects } from './effects.js';

const MINI_DPR_CAP = 2;
export const TRACK_GAIN_MIN_DB = -30;
export const TRACK_GAIN_MAX_DB = 6;

/** True when any track holds audio (drives panel visibility). */
function anyTrackHasAudio() {
  return state.tracks.some(t => t.originalBuffer);
}

/** Show the tracks panel once there's at least one recording; hide otherwise. */
export function updateTracksPanel() {
  if (!el.tracksPanel) return;
  const show = anyTrackHasAudio();
  el.tracksPanel.hidden = !show;
  if (show) renderTrackList();
  updateMasterControls();
}

// ===== Track lifecycle =====

/** Add a fresh empty track and make it active (ready to record/upload into). */
export function addTrack() {
  if (state.isPlaying) pausePlayback();
  stopMasterPlayback();
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
  stopMasterPlayback();

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
  renderTrackList();
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

export function setGainDb(index, db) {
  const t = state.tracks[index];
  if (!t) return;
  t.gainDb = Math.max(TRACK_GAIN_MIN_DB, Math.min(TRACK_GAIN_MAX_DB, db));
  rebuildMix();
  updateMasterControls();
}

export function setOffsetSeconds(index, seconds) {
  const t = state.tracks[index];
  if (!t) return;
  const src = trackSourceBuffer(t);
  const sr = src ? src.sampleRate : (state.audioContext ? state.audioContext.sampleRate : 48000);
  t.offsetSamples = Math.max(0, Math.round(seconds * sr));
  rebuildMix();
  updateMasterControls();
}

function refreshMix() {
  rebuildMix();
  renderTrackList();
  updateMasterControls();
}

// ===== Rendering =====

function renderTrackList() {
  const list = el.trackList;
  if (!list) return;
  list.innerHTML = '';
  const anySolo = state.tracks.some(t => t.solo);

  state.tracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'track-row' + (i === state.activeTrackIndex ? ' is-active' : '');
    row.dataset.index = String(i);

    // Selecting the row (away from a control) makes the track active.
    row.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */(e.target).closest('.track-ctl')) return;
      setActiveTrack(i);
    });

    // --- Header: name + active dot ---
    const head = document.createElement('div');
    head.className = 'track-head';
    const dot = document.createElement('span');
    dot.className = 'track-active-dot';
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = track.name;
    head.append(dot, name);

    // --- Mini waveform overview ---
    const mini = document.createElement('canvas');
    mini.className = 'track-mini';
    drawMini(mini, track, i === state.activeTrackIndex);

    // --- Controls ---
    const ctls = document.createElement('div');
    ctls.className = 'track-controls';

    ctls.append(
      iconButton('track-ctl track-rec', 'Record into this track', SVG_MIC, () => { setActiveTrack(i); openRecordModal('fresh'); }),
      iconButton('track-ctl track-upload', 'Upload into this track', SVG_UPLOAD, () => { setActiveTrack(i); el.fileInput.click(); }),
      toggleButton('track-ctl track-mute' + (track.muted ? ' is-on' : ''), 'Mute', 'M', () => toggleMute(i)),
      toggleButton('track-ctl track-solo' + (track.solo ? ' is-on' : '') + (anySolo && !track.solo ? ' is-dimmed' : ''), 'Solo', 'S', () => toggleSolo(i))
    );

    // Effects dropdown — opening it makes the track active (effects.js edits the
    // active track). A dot marks tracks that have any cleanup effect on; the
    // button spins while its denoise is processing.
    const fxCount = enabledFxCount(track);
    const fxBusy = track.denoise.processing && i === state.activeTrackIndex;
    const fxBtn = iconButton(
      'track-ctl track-fx' + (fxCount > 0 ? ' is-on' : '') + (fxBusy ? ' is-busy' : ''),
      fxCount > 0 ? `Effects (${fxCount} on)` : 'Effects',
      fxBusy ? SVG_SPINNER : SVG_FX,
      () => toggleTrackFxPopover(i)
    );
    ctls.append(fxBtn);

    // Volume
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'track-ctl track-vol';
    vol.min = String(TRACK_GAIN_MIN_DB);
    vol.max = String(TRACK_GAIN_MAX_DB);
    vol.step = '1';
    vol.value = String(track.gainDb);
    vol.title = `Volume ${track.gainDb} dB`;
    vol.addEventListener('input', () => { setGainDb(i, Number(vol.value)); vol.title = `Volume ${track.gainDb} dB`; });
    ctls.append(vol);

    // Timeline offset (seconds) — free positioning on the master timeline
    const src = trackSourceBuffer(track);
    const sr = src ? src.sampleRate : 48000;
    const offWrap = document.createElement('label');
    offWrap.className = 'track-ctl track-offset';
    offWrap.title = 'Start offset on the master timeline (seconds)';
    const offSpan = document.createElement('span');
    offSpan.textContent = 'start';
    const off = document.createElement('input');
    off.type = 'number';
    off.min = '0';
    off.step = '0.1';
    off.value = (track.offsetSamples / sr).toFixed(1);
    off.addEventListener('change', () => setOffsetSeconds(i, Number(off.value)));
    offWrap.append(offSpan, off);
    ctls.append(offWrap);

    // Delete
    ctls.append(iconButton('track-ctl track-del', 'Delete track', SVG_TRASH, () => removeTrack(i)));

    row.append(head, mini, ctls);
    list.append(row);
  });
}

/** Draw a rough waveform overview of the track's source audio. */
function drawMini(canvas, track, active) {
  const rect = { w: 180, h: 34 };
  const dpr = Math.min(window.devicePixelRatio || 1, MINI_DPR_CAP);
  canvas.width = Math.floor(rect.w * dpr);
  canvas.height = Math.floor(rect.h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const src = trackSourceBuffer(track);
  if (!src || track.segments.length === 0) return;
  const W = canvas.width;
  const midY = canvas.height / 2;
  const data = src.getChannelData(0);
  const peaks = computePeaksForRange(data, 0, data.length, W);
  ctx.fillStyle = active ? 'rgba(77, 216, 200, 0.9)' : 'rgba(77, 216, 200, 0.45)';
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const max = peaks[x * 2 + 1];
    const h = Math.max(1, Math.abs(max) * midY * 0.9);
    ctx.rect(x, midY - h, 1, h * 2);
  }
  ctx.fill();
}

function iconButton(cls, title, svg, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  b.addEventListener('click', onClick);
  return b;
}

function toggleButton(cls, title, label, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.title = title;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const SVG_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const SVG_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const SVG_FX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>';
const SVG_SPINNER = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

// ===== Per-track effects dropdown + master finishing =====
//
// Cleanup effects (denoise/gate/EQ/de-esser) are per-track; the shared
// #trackFxPopover edits whichever track is active. A row's FX button opens it
// (after making that track active). The master #masterFxPopover holds the
// finishing loudness control, which applies to the summed mix (state.master).

/** Count of enabled cleanup effects on a track (drives the row's FX dot). */
function enabledFxCount(track) {
  return (track.denoise.enabled ? 1 : 0) + (track.gate.enabled ? 1 : 0)
    + (track.eq.enabled ? 1 : 0) + (track.deesser.enabled ? 1 : 0);
}

let fxPopoverOpen = false;

/** Toggle the FX popover for track i (opening it makes the track active). */
function toggleTrackFxPopover(i) {
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

/** Anchor the popover under the active row's FX button, clamped to the panel. */
function positionTrackFxPopover() {
  const btn = el.trackList.querySelector('.track-row.is-active .track-fx');
  const pop = el.trackFxPopover;
  if (!btn || !el.tracksPanel) return;
  const panelRect = el.tracksPanel.getBoundingClientRect();
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
  if (!el.tracksPanel || el.tracksPanel.hidden) { if (fxPopoverOpen) closeTrackFxPopover(); return; }
  renderTrackList();
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
    updateMasterControls();
    showToast(state.master.loudness.enabled ? 'Loudness normalization on (mix)' : 'Loudness normalization off');
  });
  el.masterTargetLufs.addEventListener('change', () => {
    const v = Number(el.masterTargetLufs.value);
    if (Number.isFinite(v)) state.master.loudness.targetLufs = Math.max(-70, Math.min(0, v));
    el.masterTargetLufs.value = String(state.master.loudness.targetLufs);
    refreshMasterLoudness();
    updateMasterControls();
  });
  el.masterTruePeak.addEventListener('change', () => {
    const v = Number(el.masterTruePeak.value);
    if (Number.isFinite(v)) state.master.loudness.truePeakDbtp = Math.min(0, v);
    el.masterTruePeak.value = String(state.master.loudness.truePeakDbtp);
    refreshMasterLoudness();
    updateMasterControls();
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
    updateMasterControls();
    showToast(`Loudness normalization on · ${lufs} LUFS`);
  });
}

// ===== Master mix transport =====

let masterSource = null;
let masterStartTime = 0;
let masterOffset = 0;
let masterRaf = 0;
let masterPlaying = false;

export function toggleMasterPlayback() {
  if (masterPlaying) stopMasterPlayback();
  else startMasterPlayback();
}

function startMasterPlayback() {
  if (!state.audioContext || !state.mixBuffer) return;
  if (state.isPlaying) pausePlayback(); // don't overlap with editor playback
  if (state.audioContext.state === 'suspended') state.audioContext.resume();
  if (masterOffset >= state.mixBuffer.duration - 0.01) masterOffset = 0;

  const src = state.audioContext.createBufferSource();
  masterSource = src;
  src.buffer = state.mixBuffer;
  src.connect(state.audioContext.destination);
  src.onended = () => {
    if (src !== masterSource) return;
    stopMasterPlayback(true);
  };
  masterStartTime = state.audioContext.currentTime;
  src.start(0, masterOffset);
  masterPlaying = true;
  animateMaster();
  updateMasterControls();
}

export function stopMasterPlayback(ended = false) {
  if (masterSource) {
    try { masterSource.stop(); } catch (e) { /* already stopped */ }
    try { masterSource.disconnect(); } catch (e) { /* already disconnected */ }
  }
  if (masterPlaying && !ended && state.audioContext && state.mixBuffer) {
    const elapsed = state.audioContext.currentTime - masterStartTime + masterOffset;
    masterOffset = Math.min(elapsed, state.mixBuffer.duration);
  }
  if (ended) masterOffset = 0;
  masterSource = null;
  masterPlaying = false;
  if (masterRaf) cancelAnimationFrame(masterRaf);
  updateMasterControls();
}

function animateMaster() {
  if (!masterPlaying || !state.audioContext || !state.mixBuffer) return;
  const elapsed = state.audioContext.currentTime - masterStartTime + masterOffset;
  if (elapsed >= state.mixBuffer.duration) {
    stopMasterPlayback(true);
    return;
  }
  if (el.masterTime) el.masterTime.textContent = `${formatTime(elapsed)} / ${formatTime(state.mixBuffer.duration)}`;
  masterRaf = requestAnimationFrame(animateMaster);
}

function updateMasterControls() {
  if (el.masterPlayButton) {
    el.masterPlayButton.classList.toggle('playing', masterPlaying);
    el.masterPlayButton.disabled = !state.mixBuffer;
  }
  if (el.masterTime && !masterPlaying) {
    const dur = state.mixBuffer ? state.mixBuffer.duration : 0;
    el.masterTime.textContent = `${formatTime(masterOffset)} / ${formatTime(dur)}`;
  }
}
