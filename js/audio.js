import { state, LIVE_SECONDS, WAVEFORM_SCALE, WAVEFORM_STYLE } from './state.js';
import { el, liveCtx } from './dom.js';
import { formatTime } from './utils.js';
import { showToast, renderQualityOptions, updateBitrate, updateSegmentCountDisplay, resetReadouts, setTransportDisabled, updateHeaderState, setRecordingUI, updateEmptyState } from './ui.js';
import { fillWaveformPathLive, hideSegmentTrash, clearSegmentHover, drawPlaybackWaveform } from './waveform.js';
import { pausePlayback } from './playback.js';
import { resetHistory } from './history.js';
import { loadBufferAsRecording } from './editing.js';

let liveRafId;

const LEVEL_DECAY = 0.92;
const LEVEL_METER_SCALE = 160;

const workletCode = `
  class RecorderProcessor extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0];
      if (input.length > 0) {
        const channels = input.map(ch => {
          const copy = new Float32Array(ch.length);
          copy.set(ch);
          return copy;
        });
        this.port.postMessage({ type: 'audio', channels }, channels.map(c => c.buffer));
      }
      return true;
    }
  }
  registerProcessor('recorder-processor', RecorderProcessor);
`;

export async function connectMicrophone() {
  el.connectButton.disabled = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });

    const track = stream.getAudioTracks()[0];
    state.micLabel = track.label || 'Unknown Microphone';

    let caps = {}, trackSettings = {};
    try { caps = track.getCapabilities() || {}; } catch (e) { console.warn('[nemo-recorder]', e.message); }
    try { trackSettings = track.getSettings() || {}; } catch (e) { console.warn('[nemo-recorder]', e.message); }

    const candidateRates = [44100, 48000, 96000, 192000];
    let supportedRates;
    if (caps.sampleRate && typeof caps.sampleRate === 'object') {
      supportedRates = candidateRates.filter(r => r >= caps.sampleRate.min && r <= caps.sampleRate.max);
      if (!supportedRates.length) supportedRates = [trackSettings.sampleRate || 48000];
    } else if (trackSettings.sampleRate) {
      supportedRates = [trackSettings.sampleRate];
    } else {
      supportedRates = [48000];
    }

    let maxChannels = 1;
    if (caps.channelCount && typeof caps.channelCount === 'object') maxChannels = caps.channelCount.max || 1;
    else if (trackSettings.channelCount) maxChannels = trackSettings.channelCount;
    const supportedChannels = maxChannels >= 2 ? [1, 2] : [1];

    const supportedBitDepths = [16, 24, 32];

    state.micCapabilities = { supportedRates, supportedChannels, supportedBitDepths };

    state.settings.sampleRate = supportedRates[supportedRates.length - 1];
    state.settings.channels = supportedChannels[supportedChannels.length - 1];
    state.settings.bitDepth = 32;

    // Capabilities and label are captured above; release the mic immediately so
    // the tab doesn't hold a live capture stream (and show Chrome's recording
    // indicator) while idle. ensureMediaStream() re-acquires it on record.
    stream.getTracks().forEach(t => t.stop());
    el.micName.textContent = state.micLabel;

    renderQualityOptions();
    updateBitrate();
    updateHeaderState();
    showToast(`Connected: ${state.micLabel}`);
  } catch (err) {
    console.error(err);
    const msg = err.name === 'NotAllowedError' ? 'Microphone permission denied'
      : err.name === 'NotFoundError' ? 'No microphone found'
      : (err.message || 'Failed to connect microphone');
    showToast(msg, true);
  } finally {
    el.connectButton.disabled = false;
  }
}

export function releaseMicStream() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
}

export function disconnectMicrophone() {
  stopRecordingNodes();
  releaseMicStream();
  if (state.audioContext) {
    try { state.audioContext.close(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
    state.audioContext = null;
    state.workletLoaded = false;
  }
  state.micCapabilities = null;
  state.originalBuffer = null;
  state.recordedBuffer = null;
  state.segments = [];
  state.cachedPeaks = null;
  state.cachedPath = null;
  resetHistory();
  hideSegmentTrash();
  el.playheadScissors.classList.remove('visible');
  state.hoverRatio = -1;
  resetReadouts();
  updateSegmentCountDisplay();
  updateHeaderState();
  updateEmptyState();
}

export async function ensureAudioContext() {
  if (state.audioContext && state.audioContext.state !== 'closed') {
      if (state.audioContext.sampleRate === state.settings.sampleRate) {
        if (state.audioContext.state === 'suspended') await state.audioContext.resume();
        return state.audioContext;
      }
      try { await state.audioContext.close(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
      state.audioContext = null;
      state.workletLoaded = false;
  }

  try {
    state.audioContext = new AudioContext({ sampleRate: state.settings.sampleRate, latencyHint: 'interactive' });
  } catch (e) {
    state.audioContext = new AudioContext();
  }

  if (state.audioContext.sampleRate !== state.settings.sampleRate) {
    showToast(`Browser used ${state.audioContext.sampleRate} Hz (rate not supported by system)`);
    state.settings.sampleRate = state.audioContext.sampleRate;
    el.rateOptions.querySelectorAll('.quality-option').forEach(b => {
      b.classList.toggle('active', parseInt(/** @type {HTMLElement} */ (b).dataset.value) === state.settings.sampleRate);
    });
    updateBitrate();
  }

  if (!state.workletLoaded) {
    const workletUrl = 'data:application/javascript;base64,' + btoa(workletCode);
    try {
      await state.audioContext.audioWorklet.addModule(workletUrl);
      state.workletLoaded = true;
    } catch (err) {
      throw new Error('AudioWorklet failed to load — try a modern Chrome/Edge/Firefox');
    }
  }

  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  return state.audioContext;
}

async function ensureMediaStream() {
  let needsNewStream = !state.mediaStream ||
    state.mediaStream.getAudioTracks().length === 0 ||
    state.mediaStream.getAudioTracks()[0].readyState !== 'live';

  if (!needsNewStream) {
    const currentSettings = state.mediaStream.getAudioTracks()[0].getSettings();
    const channelMismatch = currentSettings.channelCount !== undefined && state.settings.channels !== currentSettings.channelCount;
    const rateMismatch = currentSettings.sampleRate !== undefined && state.settings.sampleRate !== currentSettings.sampleRate;

    if (channelMismatch || rateMismatch) {
      needsNewStream = true;
    }
  }

  if (needsNewStream) {
    if (state.mediaStream) state.mediaStream.getTracks().forEach(t => t.stop());

    const constraints = {
      audio: {
        channelCount: state.settings.channels,
        channelCountMode: 'explicit',
        sampleRate: state.settings.sampleRate,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      },
      video: false
    };

    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name === 'OverconstrainedError') {
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
          ...constraints,
          audio: { ...constraints.audio, sampleRate: undefined }
        });
        showToast(`Mic couldn't match exact rate; using closest available.`);
      } else {
        throw err;
      }
    }
  }
}

export async function startRecording() {
  try {
    el.recordButton.disabled = true;
    await ensureAudioContext();

    await ensureMediaStream();

    state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.workletNode = new AudioWorkletNode(state.audioContext, 'recorder-processor', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: state.settings.channels, channelCountMode: 'explicit', channelInterpretation: 'speakers'
    });

    state.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'audio') {
        state.recordedChunks.push(e.data.channels);
        processLiveAudio(e.data.channels);
      }
    };

    state.sourceNode.connect(state.workletNode);

    const size = LIVE_SECONDS * state.audioContext.sampleRate;
    state.liveBuffer = new Float32Array(size);
    state.liveWritePos = 0;
    state.liveFilled = 0;
    state.liveLevel = 0;
    state.recordedChunks = [];
    state.recordStartTime = performance.now();
    state.isRecording = true;

    setRecordingUI(true);
    startLiveAnimation();

  } catch (err) {
    console.error(err);
    showToast(err.name === 'NotAllowedError' ? 'Microphone permission denied' : (err.message || 'Failed to start recording'), true);
    stopRecordingNodes();
    releaseMicStream();
    updateHeaderState();
  } finally {
    el.recordButton.disabled = false;
  }
}

export function processLiveAudio(channels) {
  const len = channels[0].length;
  const nch = channels.length;
  const buf = state.liveBuffer;
  const bufLen = buf.length;
  let writePos = state.liveWritePos;
  let filled = state.liveFilled;
  let maxLevel = 0;

  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < nch; c++) {
      const v = channels[c][i];
      s += v;
      const av = v < 0 ? -v : v;
      if (av > maxLevel) maxLevel = av;
    }
    if (nch > 1) s /= nch;
    buf[writePos] = s;
    writePos++;
    if (writePos >= bufLen) writePos = 0;
    if (filled < bufLen) filled++;
  }

  state.liveWritePos = writePos;
  state.liveFilled = filled;
  state.liveLevel = Math.max(maxLevel, state.liveLevel * LEVEL_DECAY);
}

export function startLiveAnimation() {
  if (liveRafId) cancelAnimationFrame(liveRafId);
  const dpr = window.devicePixelRatio || 1;

  const resize = () => {
    const rect = el.liveCanvas.getBoundingClientRect();
    el.liveCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
    el.liveCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
    state.livePeaks = null;
  };
  resize();

  if (state.liveResizeHandler) window.removeEventListener('resize', state.liveResizeHandler);
  state.liveResizeHandler = resize;
  window.addEventListener('resize', resize);

  const draw = () => {
    if (!state.isRecording) return;

    const W = el.liveCanvas.width;
    const H = el.liveCanvas.height;
    const midY = H / 2;

    liveCtx.clearRect(0, 0, W, H);

    liveCtx.strokeStyle = WAVEFORM_STYLE.midlineColor;
    liveCtx.lineWidth = 1;
    liveCtx.beginPath();
    liveCtx.moveTo(0, midY);
    liveCtx.lineTo(W, midY);
    liveCtx.stroke();

    if (state.liveBuffer && state.liveFilled > 0) {
      const buf = state.liveBuffer;
      const bufLen = buf.length;
      const filled = state.liveFilled;
      const samplesPerPixel = filled / W;
      const startIdx = filled < bufLen ? 0 : state.liveWritePos;

      if (!state.livePeaks || state.livePeaksWidth !== W) {
        state.livePeaks = new Float32Array(W * 2);
        state.livePeaksWidth = W;
      }
      const peaks = state.livePeaks;

      for (let x = 0; x < W; x++) {
        const startSample = (x * samplesPerPixel) | 0;
        const endSample = ((x + 1) * samplesPerPixel) | 0;
        let min = 0, max = 0;
        if (startSample < endSample) {
          min = 1; max = -1;
          for (let s = startSample; s < endSample; s++) {
            const v = buf[(startIdx + s) % bufLen];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          if (min > max) { min = 0; max = 0; }
        }
        peaks[x * 2] = min;
        peaks[x * 2 + 1] = max;
      }

      const grad = liveCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(255, 140, 66, 0.9)');
      grad.addColorStop(0.5, 'rgba(255, 100, 50, 0.7)');
      grad.addColorStop(1, 'rgba(255, 140, 66, 0.9)');
      liveCtx.fillStyle = grad;
      fillWaveformPathLive(liveCtx, peaks, 0, W, midY, WAVEFORM_SCALE);

      liveCtx.strokeStyle = 'rgba(255, 140, 66, 0.95)';
      liveCtx.lineWidth = 2 * dpr;
      liveCtx.shadowColor = 'rgba(255, 140, 66, 0.8)';
      liveCtx.shadowBlur = 10;
      liveCtx.beginPath();
      liveCtx.moveTo(W - 1, 0);
      liveCtx.lineTo(W - 1, H);
      liveCtx.stroke();
      liveCtx.shadowBlur = 0;
    }

    el.liveTimer.textContent = formatTime((performance.now() - state.recordStartTime) / 1000);
    el.levelFill.style.width = Math.min(100, state.liveLevel * LEVEL_METER_SCALE) + '%';

    liveRafId = requestAnimationFrame(draw);
  };

  draw();
}

export function stopRecordingNodes() {
  if (state.sourceNode) { try { state.sourceNode.disconnect(); } catch(e) { console.warn('[nemo-recorder]', e.message); } state.sourceNode = null; }
  if (state.workletNode) { try { state.workletNode.disconnect(); } catch(e) { console.warn('[nemo-recorder]', e.message); } state.workletNode = null; }
  state.isRecording = false;
}

export function stopRecording() {
  if (!state.isRecording) return;
  state.isRecording = false;
  if (liveRafId) cancelAnimationFrame(liveRafId);
  if (state.liveResizeHandler) window.removeEventListener('resize', state.liveResizeHandler);
  stopRecordingNodes();
  // Release the capture stream and park the audio thread: a live mic track or a
  // running AudioContext keeps Chrome's tab-recording indicator on and exempts
  // the tab from throttling, degrading the whole browser while we sit idle in
  // the editor. Playback resumes the context on demand.
  releaseMicStream();
  if (state.audioContext) state.audioContext.suspend().catch(e => console.warn('[nemo-recorder]', e.message));

  if (state.recordedChunks.length === 0) {
    setRecordingUI(false);
    updateEmptyState();
    showToast('No audio captured', true);
    return;
  }

  const numChannels = state.recordedChunks[0].length;
  const totalLength = state.recordedChunks.reduce((sum, chs) => sum + chs[0].length, 0);
  const combined = [];
  for (let c = 0; c < numChannels; c++) {
    const arr = new Float32Array(totalLength);
    let offset = 0;
    for (const chs of state.recordedChunks) {
      arr.set(chs[c], offset);
      offset += chs[c].length;
    }
    combined.push(arr);
  }

  const buffer = state.audioContext.createBuffer(numChannels, totalLength, state.audioContext.sampleRate);
  for (let c = 0; c < numChannels; c++) buffer.copyToChannel(combined[c], c);

  loadBufferAsRecording(buffer, 'Capture complete — lossless PCM ready');
  setRecordingUI(false);
}

export function rerecord() {
  if (state.isPlaying) pausePlayback();
  setRecordingUI(false);
  stopRecordingNodes();
  releaseMicStream();
  if (state.audioContext) {
    try { state.audioContext.close(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
    state.audioContext = null;
    state.workletLoaded = false;
  }
  state.recordedChunks = [];
  state.originalBuffer = null;
  state.recordedBuffer = null;
  state.segments = [];
  state.playbackOffset = 0;
  state.cachedPeaks = null;
  state.cachedPath = null;
  state.hoverRatio = -1;
  state.hoveredSegmentIndex = -1;
  resetHistory();
  clearSegmentHover();
  hideSegmentTrash();
  el.playheadScissors.classList.remove('visible');

  resetReadouts();
  updateSegmentCountDisplay();
  setTransportDisabled(true);
  updateHeaderState();
  updateEmptyState();
  showToast('Ready for next take');
}
