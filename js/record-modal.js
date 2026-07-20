import { state } from './state.js';
import { el, reviewCtx } from './dom.js';
import { formatTime } from './utils.js';
import { updateEmptyState, setTransportDisabled } from './ui.js';
import { connectMicrophone, disconnectMicrophone, startRecording, stopRecording, cancelRecordingCapture } from './audio.js';
import { loadBufferAsRecording, appendBufferToRecording } from './editing.js';
import { computePeaksForRange, pickRulerIntervalSec, formatRulerLabel } from './waveform-math.js';

let reviewRafId = null;
let previewSeeking = false;
let previewStarting = false;
let previewGen = 0;
let cachedReviewPeaks = null;
let cachedReviewWidth = 0;

// ===== Modal open / close =====

export function openRecordModal(context) {
  if (el.recordModal.classList.contains('visible')) return;
  state.recordModalContext = context || 'fresh';
  el.recordModal.classList.add('visible');
  if (state.micCapabilities) showReadyState();
  else showDisconnectedState();
}

export function closeRecordModal() {
  if (!el.recordModal.classList.contains('visible')) return;
  if (state.isRecording) cancelRecordingCapture();
  stopPreview();
  state.pendingTakeBuffer = null;
  state.recordModalContext = null;
  el.recordModal.classList.remove('visible');
  if (state.recordedBuffer) setTransportDisabled(false);
  updateEmptyState();
}

// ===== State views =====

function showView(view) {
  el.rmReadyView.hidden = view !== 'ready';
  el.rmNoMicView.hidden = view !== 'nomic';
  el.rmCanvasWrap.hidden = view !== 'live';
  el.rmReviewWrap.hidden = view !== 'review';
}

function showDisconnectedState() {
  el.micName.textContent = 'No microphone connected';
  el.rmMicDot.classList.remove('connected');
  el.rmSettingsBtn.hidden = true;
  el.rmDisconnectBtn.hidden = true;
  showView('nomic');
  el.rmRecordingControls.hidden = true;
  el.rmReviewControls.hidden = true;
  el.rmActionsRight.hidden = true;
}

function showReadyState() {
  el.micName.textContent = state.micLabel || 'Microphone connected';
  el.rmMicDot.classList.add('connected');
  el.rmSettingsBtn.hidden = false;
  el.rmDisconnectBtn.hidden = false;
  const { sampleRate, bitDepth, channels } = state.settings;
  el.rmReadySpec.textContent = `${(sampleRate / 1000).toLocaleString()} kHz · ${bitDepth}-bit · ${channels === 2 ? 'Stereo' : 'Mono'}`;
  showView('ready');
  el.rmRecordingControls.hidden = true;
  el.rmReviewControls.hidden = true;
  el.rmActionsRight.hidden = true;
}

function showRecordingState() {
  el.rmSettingsBtn.hidden = true;
  el.rmDisconnectBtn.hidden = true;
  showView('live');
  el.rmRecordingControls.hidden = false;
  el.rmReviewControls.hidden = true;
  el.rmActionsRight.hidden = true;
}

function showReviewState() {
  showView('review');
  el.rmRecordingControls.hidden = true;
  el.rmReviewControls.hidden = false;
  el.rmActionsRight.hidden = false;
  el.rmPlayBtn.classList.remove('playing');
  cachedReviewPeaks = null;
  el.rmReviewCurrent.textContent = '00:00.000';
  el.rmReviewTotal.textContent = formatTime(state.pendingTakeBuffer.duration);
  renderReviewWaveform();
}

// ===== Modal button handlers =====

export async function handleModalConnect() {
  el.rmConnectBtn.disabled = true;
  await connectMicrophone();
  el.rmConnectBtn.disabled = false;
  if (state.micCapabilities) showReadyState();
}

export function handleModalDisconnect() {
  disconnectMicrophone();
  closeRecordModal();
}

export function handleModalSettings() {
  el.qualityModal.classList.add('visible');
}

export async function handleModalRecord() {
  if (state.isRecording) return;
  showRecordingState();
  await startRecording();
  // startRecording swallows its own errors; if it failed, revert the view
  if (!state.isRecording) showReadyState();
}

export async function handleModalStop() {
  if (!state.isRecording) return;
  await stopRecording();
  if (state.pendingTakeBuffer) showReviewState();
  else if (state.micCapabilities) showReadyState();
  else showDisconnectedState();
}

export async function handleModalAdd() {
  if (!state.pendingTakeBuffer) return;
  const buffer = state.pendingTakeBuffer;
  const context = state.recordModalContext;
  stopPreview();
  state.pendingTakeBuffer = null;
  state.recordModalContext = null;
  el.recordModal.classList.remove('visible');

  if (context === 'append' && state.originalBuffer) {
    await appendBufferToRecording(buffer, 'Appended new recording');
  } else {
    loadBufferAsRecording(buffer, 'Capture complete — lossless PCM ready');
  }
  updateEmptyState();
}

export function handleModalRetake() {
  stopPreview();
  state.pendingTakeBuffer = null;
  if (state.micCapabilities) showReadyState();
  else showDisconnectedState();
}

// ===== Preview playback =====

export function togglePreview() {
  if (state.isPreviewing) {
    pausePreview();
  } else if (previewStarting) {
    previewStarting = false;
  } else {
    playPreview();
  }
}

async function playPreview() {
  if (!state.pendingTakeBuffer || !state.audioContext) return;
  if (state.isPreviewing || previewStarting) return;
  previewStarting = true;

  if (state.audioContext.state === 'suspended') {
    try { await state.audioContext.resume(); }
    catch (e) { previewStarting = false; return; }
  }
  if (!previewStarting) return;

  if (state.previewOffset >= state.pendingTakeBuffer.duration - 0.01) {
    state.previewOffset = 0;
  }

  previewGen++;
  const currentGen = previewGen;

  state.previewSource = state.audioContext.createBufferSource();
  state.previewSource.buffer = state.pendingTakeBuffer;
  state.previewSource.connect(state.audioContext.destination);
  state.previewSource.onended = () => {
    if (state.isPreviewing && previewGen === currentGen) {
      state.isPreviewing = false;
      state.previewOffset = 0;
      el.rmPlayBtn.classList.remove('playing');
      if (reviewRafId) cancelAnimationFrame(reviewRafId);
      el.rmReviewCurrent.textContent = '00:00.000';
      renderReviewWaveform();
    }
  };

  state.previewStartTime = state.audioContext.currentTime;
  state.previewSource.start(0, state.previewOffset);
  state.isPreviewing = true;
  previewStarting = false;
  el.rmPlayBtn.classList.add('playing');
  animateReview();
}

function pausePreview() {
  if (!state.isPreviewing) return;
  const elapsed = state.audioContext.currentTime - state.previewStartTime + state.previewOffset;
  state.previewOffset = Math.min(elapsed, state.pendingTakeBuffer.duration);
  state.isPreviewing = false;
  previewGen++;
  try { state.previewSource.stop(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
  try { state.previewSource.disconnect(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
  state.previewSource = null;
  el.rmPlayBtn.classList.remove('playing');
  if (reviewRafId) cancelAnimationFrame(reviewRafId);
  renderReviewWaveform();
}

function stopPreview() {
  if (state.isPreviewing) pausePreview();
  previewStarting = false;
  state.previewOffset = 0;
  state.previewStartTime = 0;
  if (reviewRafId) cancelAnimationFrame(reviewRafId);
  reviewRafId = null;
}

function animateReview() {
  if (!state.isPreviewing || !state.pendingTakeBuffer) return;

  const delta = state.audioContext.currentTime - state.previewStartTime;
  state.previewOffset += delta;
  state.previewStartTime = state.audioContext.currentTime;

  if (state.previewOffset >= state.pendingTakeBuffer.duration) {
    state.isPreviewing = false;
    state.previewOffset = 0;
    el.rmPlayBtn.classList.remove('playing');
    el.rmReviewCurrent.textContent = '00:00.000';
    renderReviewWaveform();
    return;
  }

  el.rmReviewCurrent.textContent = formatTime(state.previewOffset);
  renderReviewWaveform();
  reviewRafId = requestAnimationFrame(animateReview);
}

function seekReview(ratio) {
  if (!state.pendingTakeBuffer) return;
  ratio = Math.max(0, Math.min(1, ratio));
  const wasPlaying = state.isPreviewing;
  if (wasPlaying) pausePreview();
  state.previewOffset = ratio * state.pendingTakeBuffer.duration;
  el.rmReviewCurrent.textContent = formatTime(state.previewOffset);
  renderReviewWaveform();
  if (wasPlaying) playPreview();
}

// ===== Review waveform rendering =====

function computeReviewPeaks(width) {
  if (!state.pendingTakeBuffer) return new Float32Array(width * 2);
  if (cachedReviewPeaks && cachedReviewWidth === width) return cachedReviewPeaks;

  const nch = state.pendingTakeBuffer.numberOfChannels;
  const len = state.pendingTakeBuffer.length;

  let data;
  if (nch === 1) {
    data = state.pendingTakeBuffer.getChannelData(0);
  } else {
    data = new Float32Array(len);
    const chans = [];
    for (let c = 0; c < nch; c++) chans.push(state.pendingTakeBuffer.getChannelData(c));
    for (let i = 0; i < len; i++) {
      let s = chans[0][i];
      for (let c = 1; c < nch; c++) s += chans[c][i];
      data[i] = s / nch;
    }
  }

  const peaks = computePeaksForRange(data, 0, len, width);
  cachedReviewPeaks = peaks;
  cachedReviewWidth = width;
  return peaks;
}

// Draws the full waveform with the played portion (left of the current
// preview offset) highlighted, and positions the playhead to match.
function renderReviewWaveform() {
  const canvas = el.rmReviewCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
    cachedReviewPeaks = null;
  }

  const RULER_H = 22 * dpr;
  const waveH = H - RULER_H;
  const midY = RULER_H + waveH / 2;
  const scale = 0.88;
  const duration = state.pendingTakeBuffer ? state.pendingTakeBuffer.duration : 0;
  const ratio = duration > 0 ? state.previewOffset / duration : 0;

  reviewCtx.clearRect(0, 0, W, H);

  if (duration > 0) {
    const intervalSec = pickRulerIntervalSec(duration, rect.width);
    const minorInterval = intervalSec / 5;
    const EPS = intervalSec * 1e-6;
    const majorTickH = 9 * dpr;
    const minorTickH = 5 * dpr;
    const labelGap = 4 * dpr;
    const lineW = Math.max(1, Math.round(dpr));

    reviewCtx.fillStyle = 'rgba(110, 110, 122, 0.35)';
    for (let t = 0; t <= duration + EPS; t += minorInterval) {
      const x = (t / duration) * W;
      reviewCtx.fillRect(x - lineW / 2, RULER_H - minorTickH, lineW, minorTickH);
    }

    reviewCtx.fillStyle = 'rgba(155, 155, 165, 0.55)';
    reviewCtx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    for (let t = 0; t <= duration + EPS; t += intervalSec) {
      const x = (t / duration) * W;
      reviewCtx.fillRect(x - lineW / 2, RULER_H - majorTickH, lineW, majorTickH);
      const label = formatRulerLabel(t, intervalSec);
      const tw = reviewCtx.measureText(label).width;
      const labelX = Math.max(2 * dpr, Math.min(W - tw - 2 * dpr, x - tw / 2));
      reviewCtx.fillText(label, labelX, RULER_H - majorTickH - labelGap);
    }
  }

  const peaks = computeReviewPeaks(W);
  const playheadX = Math.round(ratio * W);

  for (let x = 0; x < W; x++) {
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    const top = midY - max * midY * scale;
    const h = Math.max(1, (max - min) * midY * scale);
    reviewCtx.fillStyle = x < playheadX ? 'rgba(77, 216, 200, 0.95)' : 'rgba(77, 216, 200, 0.22)';
    reviewCtx.fillRect(x, top, 1, h);
  }

  el.rmPlayhead.style.left = `${ratio * rect.width}px`;
}

// ===== Review canvas pointer events (click-to-seek + drag) =====

function ratioFromPointerX(clientX) {
  const rect = el.rmReviewCanvasArea.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function onReviewPointerMove(e) {
  if (!previewSeeking) return;
  seekReview(ratioFromPointerX(e.clientX));
}

function onReviewPointerUp() {
  previewSeeking = false;
  el.rmPlayhead.classList.remove('dragging');
  window.removeEventListener('pointermove', onReviewPointerMove);
  window.removeEventListener('pointerup', onReviewPointerUp);
}

function startReviewDrag(e) {
  if (!state.pendingTakeBuffer) return;
  e.preventDefault();
  e.stopPropagation();
  seekReview(ratioFromPointerX(e.clientX));
  previewSeeking = true;
  el.rmPlayhead.classList.add('dragging');
  window.addEventListener('pointermove', onReviewPointerMove);
  window.addEventListener('pointerup', onReviewPointerUp);
}

// ===== Init =====

export function initRecordModal() {
  el.rmConnectBtn.addEventListener('click', handleModalConnect);
  el.rmSettingsBtn.addEventListener('click', handleModalSettings);
  el.rmDisconnectBtn.addEventListener('click', handleModalDisconnect);
  el.rmRecordBtn.addEventListener('click', handleModalRecord);
  el.rmStopBtn.addEventListener('click', handleModalStop);
  el.rmPlayBtn.addEventListener('click', togglePreview);
  el.rmRetakeBtn.addEventListener('click', handleModalRetake);
  el.rmAddBtn.addEventListener('click', handleModalAdd);
  el.recordModalClose.addEventListener('click', closeRecordModal);
  el.recordModal.addEventListener('click', (e) => {
    if (e.target === el.recordModal) closeRecordModal();
  });

  el.rmReviewCanvasArea.addEventListener('pointerdown', startReviewDrag);
  el.rmPlayhead.addEventListener('pointerdown', startReviewDrag);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (el.recordModal.classList.contains('visible') && !state.isRecording && state.pendingTakeBuffer) {
        cachedReviewPeaks = null;
        renderReviewWaveform();
      }
    }, 150);
  });
}
