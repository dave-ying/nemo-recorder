import { state } from './state.js';
import { el } from './dom.js';
import { drawPlaybackWaveform } from './waveform.js';
import { formatTime } from './utils.js';
import { pausePlayback } from './playback.js';

const FRAME_SECONDS = 1 / 60;

const SCRUB_HOLD_DELAY_MS = 180;
const SCRUB_MIN_SPEED = 0.1;
const SCRUB_ACCEL_PER_SECOND = 0.6;
const SCRUB_MAX_SPEED = 1.0;

let scrubState = null;
const heldArrows = new Set();

function stepBySeconds(deltaSec) {
  if (!state.recordedBuffer) return;
  if (state.isPlaying) pausePlayback();
  const dur = state.recordedBuffer.duration;
  const clamped = Math.max(0, Math.min(dur, state.playbackOffset + deltaSec));
  if (clamped === state.playbackOffset) return;
  state.playbackOffset = clamped;
  el.timeCurrent.textContent = formatTime(clamped);
  drawPlaybackWaveform(dur > 0 ? clamped / dur : 0);
}

function stopScrub() {
  if (!scrubState) return;
  if (scrubState.rafId) cancelAnimationFrame(scrubState.rafId);
  scrubState = null;
}

function scrubFrame() {
  if (!scrubState) return;
  if (state.isPlaying || !state.recordedBuffer || el.playbackView.hidden) {
    stopScrub();
    return;
  }
  const now = performance.now();
  const heldMs = now - scrubState.startTime;
  if (heldMs < SCRUB_HOLD_DELAY_MS) {
    scrubState.lastTime = now;
    scrubState.rafId = requestAnimationFrame(scrubFrame);
    return;
  }
  const accelSeconds = (heldMs - SCRUB_HOLD_DELAY_MS) / 1000;
  const speed = Math.min(SCRUB_MAX_SPEED, SCRUB_MIN_SPEED + accelSeconds * SCRUB_ACCEL_PER_SECOND);
  const dt = (now - scrubState.lastTime) / 1000;
  stepBySeconds(scrubState.direction * speed * dt);
  scrubState.lastTime = now;
  scrubState.rafId = requestAnimationFrame(scrubFrame);
}

function startScrub(direction) {
  if (scrubState) {
    if (scrubState.direction === direction) return;
    scrubState.direction = direction;
    scrubState.startTime = performance.now();
    scrubState.lastTime = scrubState.startTime;
    return;
  }
  stepBySeconds(direction * FRAME_SECONDS);
  const now = performance.now();
  scrubState = { direction, startTime: now, lastTime: now, rafId: null };
  scrubState.rafId = requestAnimationFrame(scrubFrame);
}

export function arrowKeyDown(code) {
  heldArrows.add(code);
  if (code === 'ArrowLeft') startScrub(-1);
  else if (code === 'ArrowRight') startScrub(1);
}

export function arrowKeyUp(code) {
  heldArrows.delete(code);
  if (!scrubState) return;
  if (code === 'ArrowLeft' && scrubState.direction === -1) {
    if (heldArrows.has('ArrowRight')) startScrub(1);
    else stopScrub();
  } else if (code === 'ArrowRight' && scrubState.direction === 1) {
    if (heldArrows.has('ArrowLeft')) startScrub(-1);
    else stopScrub();
  }
}


