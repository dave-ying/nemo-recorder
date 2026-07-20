import { state } from './state.js';
import { el } from './dom.js';
import { drawPlaybackWaveform } from './waveform.js';
import { formatTime } from './utils.js';

const PLAYBACK_END_THRESHOLD = 0.01;
const PLAYBACK_END_TOLERANCE = 0.05;
let playbackRafId;

// The context is suspended whenever nothing is audible (see suspendWhenIdle),
// so a running state here always means audio is actually flowing.
function suspendWhenIdle() {
  if (state.audioContext && state.audioContext.state === 'running') {
    state.audioContext.suspend().catch(e => console.warn('[nemo-recorder]', e.message));
  }
}

export async function startPlayback() {
  if (!state.recordedBuffer || !state.audioContext) return;
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  if (state.playbackOffset >= state.recordedBuffer.duration - PLAYBACK_END_THRESHOLD) state.playbackOffset = 0;

  state.playbackSource = state.audioContext.createBufferSource();
  state.playbackSource.buffer = state.recordedBuffer;
  state.playbackSource.connect(state.audioContext.destination);

  state.playbackSource.onended = () => {
    if (state.isPlaying) {
      const elapsed = state.audioContext.currentTime - state.playbackStartTime + state.playbackOffset;
      if (elapsed >= state.recordedBuffer.duration - PLAYBACK_END_TOLERANCE) {
        state.isPlaying = false;
        state.playbackOffset = 0;
        el.playButton.classList.remove('playing');
        drawPlaybackWaveform(0);
        el.timeCurrent.textContent = '00:00.000';
        suspendWhenIdle();
      }
    }
  };

  state.playbackStartTime = state.audioContext.currentTime;
  state.playbackSource.start(0, state.playbackOffset);
  state.isPlaying = true;
  el.playButton.classList.add('playing');
  animatePlayback();
}

export function pausePlayback() {
  if (!state.playbackSource) return;
  const elapsed = state.audioContext.currentTime - state.playbackStartTime + state.playbackOffset;
  state.playbackOffset = Math.min(elapsed, state.recordedBuffer.duration);
  try { state.playbackSource.stop(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
  try { state.playbackSource.disconnect(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
  state.playbackSource = null;
  state.isPlaying = false;
  el.playButton.classList.remove('playing');
  if (playbackRafId) cancelAnimationFrame(playbackRafId);
  const ratio = state.recordedBuffer.duration > 0 ? state.playbackOffset / state.recordedBuffer.duration : 0;
  drawPlaybackWaveform(ratio);
  suspendWhenIdle();
}

function animatePlayback() {
  if (!state.isPlaying || !state.audioContext || !state.recordedBuffer) return;
  const elapsed = state.audioContext.currentTime - state.playbackStartTime + state.playbackOffset;
  if (elapsed >= state.recordedBuffer.duration) {
    state.isPlaying = false;
    state.playbackOffset = 0;
    el.playButton.classList.remove('playing');
    drawPlaybackWaveform(0);
    el.timeCurrent.textContent = '00:00.000';
    suspendWhenIdle();
    return;
  }
  const ratio = elapsed / state.recordedBuffer.duration;
  el.timeCurrent.textContent = formatTime(elapsed);
  drawPlaybackWaveform(ratio);
  playbackRafId = requestAnimationFrame(animatePlayback);
}

export function seekToRatio(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  const wasPlaying = state.isPlaying;
  if (state.isPlaying) pausePlayback();
  state.playbackOffset = Math.max(0, Math.min(state.recordedBuffer.duration, ratio * state.recordedBuffer.duration));
  el.timeCurrent.textContent = formatTime(state.playbackOffset);
  drawPlaybackWaveform(ratio);
  if (wasPlaying) startPlayback();
}
