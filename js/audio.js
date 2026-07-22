import { state, LIVE_SECONDS, WAVEFORM_SCALE, WAVEFORM_STYLE } from './state.js';
import { el, liveCtx } from './dom.js';
import { formatTime } from './utils.js';
import { showToast, renderQualityOptions, renderMicDeviceOptions, updateBitrate, updateSegmentCountDisplay, resetReadouts, setTransportDisabled, updateEmptyState } from './ui.js';
import { fillWaveformPathLive, hideSegmentTrash } from './waveform.js';
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

// Populates state.micDevices with audioinput devices. Labels are only
// non-empty once mic permission has been granted at least once, so this is
// called after a successful connect rather than on page load.
export async function refreshMicDeviceList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.micDevices = devices
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ deviceId: d.deviceId, label: d.label }));
  } catch (e) {
    console.warn('[nemo-recorder]', e.message);
  }
}

navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (!state.micCapabilities) return;
  await refreshMicDeviceList();
  renderMicDeviceOptions();
});

export async function connectMicrophone(deviceId) {
  try {
    const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });

    const track = stream.getAudioTracks()[0];
    state.micLabel = track.label || 'Unknown Microphone';

    let caps = {}, trackSettings = {};
    try { caps = track.getCapabilities() || {}; } catch (e) { console.warn('[nemo-recorder]', e.message); }
    try { trackSettings = track.getSettings() || {}; } catch (e) { console.warn('[nemo-recorder]', e.message); }

    state.micDeviceId = trackSettings.deviceId || deviceId || null;
    await refreshMicDeviceList();

    // Same unreliability as channelCount above: getCapabilities().sampleRate
    // reports the range the audio backend could resample to (often a huge
    // span like 3kHz-384kHz for every device), not the mic's true native
    // rate. Offering that whole range as "supported" rates would default new
    // recordings to the highest one (e.g. 192k) even on ordinary hardware —
    // inflating file size with interpolated data, not real extra fidelity.
    // getSettings().sampleRate is what the track is actually delivering, so
    // it's the only rate treated as genuinely detected.
    const candidateRates = [44100, 48000, 96000, 192000];
    let nativeRate = null;
    if (trackSettings.sampleRate) {
      nativeRate = trackSettings.sampleRate;
    } else if (caps.sampleRate && typeof caps.sampleRate === 'object') {
      nativeRate = candidateRates.find(r => r >= caps.sampleRate.min && r <= caps.sampleRate.max) || caps.sampleRate.min || 48000;
    }
    const supportedRates = [nativeRate || 48000];

    // getSettings().channelCount reflects the channel count the track is
    // actually running at, which is an accurate read of the hardware. Chrome's
    // getCapabilities().channelCount.max is unreliable and commonly reports 2
    // for mono-only mics (it describes what the audio pipeline could upmix to,
    // not the physical device), so it's only used as a fallback.
    let maxChannels = 1;
    if (trackSettings.channelCount) maxChannels = trackSettings.channelCount;
    else if (caps.channelCount && typeof caps.channelCount === 'object') maxChannels = caps.channelCount.max || 1;
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
    renderMicDeviceOptions();
    updateBitrate();

    // We request echoCancellation/noiseSuppression/autoGainControl: false for
    // a raw capture, but some drivers/OSes silently keep them on regardless.
    // getSettings() reports what's actually active, so use it to flag when
    // the capture isn't as unprocessed as the UI implies. Only a `=== true`
    // report counts — `undefined` just means the browser doesn't expose the
    // setting, not that processing is active.
    const stillProcessing = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
      .filter(key => trackSettings[key] === true)
      .map(key => key.replace(/([A-Z])/g, ' $1').toLowerCase());
    const processingNote = stillProcessing.length ? ` — driver kept ${stillProcessing.join(', ')} on` : '';
    showToast(`Connected: ${state.micLabel}${processingNote}`, stillProcessing.length > 0);
  } catch (err) {
    console.error(err);
    const msg = err.name === 'NotAllowedError' ? 'Microphone permission denied'
      : err.name === 'NotFoundError' ? 'No microphone found'
      : err.name === 'OverconstrainedError' ? 'Selected microphone is unavailable'
      : (err.message || 'Failed to connect microphone');
    showToast(msg, true);
  }
}

function releaseMicStream() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
}

export function disconnectMicrophone() {
  if (state.isPlaying) pausePlayback();
  state.clipboardSegment = null;
  stopRecordingNodes();
  releaseMicStream();
  if (state.audioContext) {
    try { state.audioContext.close(); } catch (e) { console.warn('[nemo-recorder]', e.message); }
    state.audioContext = null;
    state.workletLoaded = false;
  }
  state.micCapabilities = null;
  state.micDevices = [];
  state.micDeviceId = null;
  state.originalBuffer = null;
  state.recordedBuffer = null;
  state.segments = [];
  state.cachedPeaks = null;
  state.cachedPath = null;
  resetHistory();
  hideSegmentTrash();
  resetReadouts();
  updateSegmentCountDisplay();
  renderMicDeviceOptions();
  updateEmptyState();
}

async function ensureAudioContext() {
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
    const deviceMismatch = state.micDeviceId !== null && currentSettings.deviceId !== undefined && currentSettings.deviceId !== state.micDeviceId;

    if (channelMismatch || rateMismatch || deviceMismatch) {
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
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        ...(state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : {})
      },
      video: false
    };

    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name !== 'OverconstrainedError') throw err;
      try {
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
          ...constraints,
          audio: { ...constraints.audio, sampleRate: undefined }
        });
        showToast(`Mic couldn't match exact rate; using closest available.`);
      } catch (err2) {
        // Selected device likely unplugged since capability detection — fall
        // back to the system default mic rather than failing the recording.
        if (err2.name !== 'OverconstrainedError' || !constraints.audio.deviceId) throw err2;
        state.micDeviceId = null;
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
          ...constraints,
          audio: { ...constraints.audio, sampleRate: undefined, deviceId: undefined }
        });
        renderMicDeviceOptions();
        showToast(`Selected microphone unavailable; using default microphone.`);
      }
    }
  }
}

export async function startRecording() {
  try {
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
        const prevTotal = state.recordedTotalSamples;
        state.recordedTotalSamples += e.data.channels[0].length;
        // Warn once when crossing ~30 minutes (block sizes skip exact
        // thresholds, so test for a crossing, not equality)
        const threshold = 30 * 60 * state.audioContext.sampleRate;
        if (prevTotal < threshold && state.recordedTotalSamples >= threshold) {
          showToast('Recording has reached 30 minutes — consider saving to avoid memory issues', true);
        }
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
    state.recordedTotalSamples = 0;
    state.recordStartTime = performance.now();
    state.isRecording = true;

    startLiveAnimation();

  } catch (err) {
    console.error(err);
    showToast(err.name === 'NotAllowedError' ? 'Microphone permission denied' : (err.message || 'Failed to start recording'), true);
    stopRecordingNodes();
    releaseMicStream();
  }
}

function teardownCaptureSession() {
  state.isRecording = false;
  if (liveRafId) cancelAnimationFrame(liveRafId);
  if (state.liveResizeHandler) window.removeEventListener('resize', state.liveResizeHandler);
  stopRecordingNodes();
  releaseMicStream();
  if (state.audioContext) state.audioContext.suspend().catch(e => console.warn('[nemo-recorder]', e.message));
}

// Abort an in-progress capture without building a take: used when the record
// modal closes mid-recording. Mirrors stopRecording's cleanup minus the buffer.
export function cancelRecordingCapture() {
  teardownCaptureSession();
  state.recordedChunks = [];
  state.recordedTotalSamples = 0;
}

function processLiveAudio(channels) {
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

function startLiveAnimation() {
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

function stopRecordingNodes() {
  if (state.sourceNode) { try { state.sourceNode.disconnect(); } catch(e) { console.warn('[nemo-recorder]', e.message); } state.sourceNode = null; }
  if (state.workletNode) { try { state.workletNode.disconnect(); } catch(e) { console.warn('[nemo-recorder]', e.message); } state.workletNode = null; }
  state.isRecording = false;
}

export async function stopRecording() {
  if (!state.isRecording) return;
  teardownCaptureSession();
  liveCtx.clearRect(0, 0, el.liveCanvas.width, el.liveCanvas.height);

  if (state.recordedChunks.length === 0) {
    updateEmptyState();
    showToast('No audio captured', true);
    return;
  }

  const numChannels = state.recordedChunks[0].length;
  const totalLength = state.recordedChunks.reduce((sum, chs) => sum + chs[0].length, 0);

  const buffer = state.audioContext.createBuffer(numChannels, totalLength, state.audioContext.sampleRate);
  for (let c = 0; c < numChannels; c++) {
    let offset = 0;
    for (const chs of state.recordedChunks) {
      const src = /** @type {Float32Array<ArrayBuffer>} */ (/** @type {*} */ (chs[c]));
      buffer.copyToChannel(src, c, offset);
      offset += src.length;
    }
  }
  state.recordedChunks = [];

  // Called from the record modal: stash the take for its review flow. The
  // modal decides whether to load or append it (see record-modal.js).
  if (state.recordModalContext) {
    state.pendingTakeBuffer = buffer;
    return;
  }

  // Defensive fallback for any non-modal caller.
  loadBufferAsRecording(buffer, 'Capture complete — lossless PCM ready');
}


