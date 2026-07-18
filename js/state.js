export const LIVE_SECONDS = 4;
export const WAVEFORM_SCALE = 0.88;
export const READOUT_IDS = ['readoutDurationBox', 'readoutRateBox', 'readoutBitBox', 'readoutChBox', 'readoutSizeBox'];

export const MIN_SEGMENT_SAMPLES = 500;

export const WAVEFORM_STYLE = {
  midlineColor: 'rgba(255, 255, 255, 0.04)',
  playedColor: 'rgba(77, 216, 200, 0.95)',
  unplayedColor: 'rgba(77, 216, 200, 0.28)',
  divisionColor: 'rgba(240, 238, 230, 0.45)',
  trashOverlayColor: 'rgba(255, 58, 92, 0.25)',
  trashBorderColor: 'rgba(255, 58, 92, 0.8)',
  playheadColor: '#ff8c42',
  playheadGlow: 'rgba(255, 140, 66, 0.7)',
  tickColor: 'rgba(110, 110, 122, 0.5)'
};

/**
 * @typedef {Object} MicCapabilities
 * @property {number[]} supportedRates
 * @property {number[]} supportedChannels
 * @property {number[]} supportedBitDepths
 */

/**
 * @typedef {Object} AppState
 * @property {AudioContext|null} audioContext
 * @property {MediaStream|null} mediaStream
 * @property {MediaStreamAudioSourceNode|null} sourceNode
 * @property {AudioWorkletNode|null} workletNode
 * @property {boolean} workletLoaded
 * @property {MicCapabilities|null} micCapabilities
 * @property {string} micLabel
 * @property {boolean} isRecording
 * @property {boolean} isPlaying
 * @property {Float32Array[][]} recordedChunks
 * @property {AudioBuffer|null} originalBuffer
 * @property {AudioBuffer|null} recordedBuffer
 * @property {Array<{start: number, end: number}>} segments
 * @property {AudioBufferSourceNode|null} playbackSource
 * @property {number} playbackStartTime
 * @property {number} playbackOffset
 * @property {number} recordStartTime - performance.now() at recording start (drives live timer)
 * @property {number} hoverRatio
 * @property {number} hoveredSegmentIndex
 * @property {boolean} isHoveringTrash
 * @property {Float32Array|null} liveBuffer
 * @property {number} liveWritePos
 * @property {number} liveFilled
 * @property {number} liveLevel
 * @property {Float32Array|null} livePeaks
 * @property {number} livePeaksWidth
 * @property {Float32Array|null} cachedPeaks
 * @property {number} cachedPeaksWidth
 * @property {Path2D|null} cachedPath
 * @property {(() => void)|null} liveResizeHandler
 * @property {boolean} isDownloading
 * @property {{sampleRate: number, bitDepth: number, channels: number}} settings
 * @property {{format: string, quality: number}} exportSettings
 * @property {number|null} trashHideTimer
 * @property {number|null} mouseMoveRaf
 * @property {number} draggingHandleIndex
 * @property {Object|null} _dragSnapshot
 * @property {boolean} draggingPlayhead
 */

/** @type {AppState} */
export const state = {
  audioContext: null,
  mediaStream: null,
  sourceNode: null,
  workletNode: null,
  workletLoaded: false,
  micCapabilities: null,
  micLabel: '',
  isRecording: false,
  isPlaying: false,
  recordedChunks: [],
  originalBuffer: null,
  recordedBuffer: null,
  segments: [],
  playbackSource: null,
  playbackStartTime: 0,
  playbackOffset: 0,
  recordStartTime: 0,
  hoverRatio: -1,
  hoveredSegmentIndex: -1,
  isHoveringTrash: false,
  liveBuffer: null,
  liveWritePos: 0,
  liveFilled: 0,
  liveLevel: 0,
  livePeaks: null,
  livePeaksWidth: 0,
  cachedPeaks: null,
  cachedPeaksWidth: 0,
  cachedPath: null,
  draggingHandleIndex: -1,
  _dragSnapshot: null,
  liveResizeHandler: null,
  isDownloading: false,
  settings: { sampleRate: 48000, bitDepth: 24, channels: 1 },
  exportSettings: { format: 'wav', quality: 32 },
  trashHideTimer: null,
  mouseMoveRaf: null,
  draggingPlayhead: false
};


