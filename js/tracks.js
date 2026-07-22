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

import { state, createTrack } from './state.js';
import { el } from './dom.js';
import { rebuildPlaybackBuffer, rebuildMix } from './editing.js';
import { drawPlaybackWaveform, hideSegmentTrash } from './waveform.js';
import { resetHistory } from './history.js';
import { pausePlayback } from './playback.js';
import { openRecordModal } from './record-modal.js';
import { updateEmptyState, updateSegmentCountDisplay, setTransportDisabled, showToast } from './ui.js';
import { formatTime } from './utils.js';
import { computePeaksForRange } from './waveform-math.js';
import { trackSourceBuffer } from './effects.js';

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

// ===== Master mix transport =====

let masterSource = null;
let masterStartTime = 0;
let masterOffset = 0;
let masterRaf = 0;
let masterPlaying = false;

export function isMasterPlaying() {
  return masterPlaying;
}

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
