export const LIVE_SECONDS = 4;
export const WAVEFORM_SCALE = 0.88;

export const MIN_SEGMENT_SAMPLES = 500;
export const SEGMENT_GAP_CSS_PX = 8;
export const SEGMENT_CORNER_RADIUS_CSS_PX = 6;
export const SEGMENT_VERTICAL_INSET_CSS_PX = 3;
export const SEGMENT_SHADOW_BLUR_CSS_PX = 8;
export const SEGMENT_SHADOW_OFFSET_Y_CSS_PX = 3;
export const SEGMENT_EDGE_WIDTH_CSS_PX = 1;

export const WAVEFORM_STYLE = {
  midlineColor: 'rgba(255, 255, 255, 0.04)',
  playedColor: 'rgba(77, 216, 200, 0.95)',
  unplayedColor: 'rgba(77, 216, 200, 0.28)',
  segmentCardBg: 'rgba(255, 255, 255, 0.035)',
  segmentEdgeColor: 'rgba(255, 255, 255, 0.12)',
  segmentShadowColor: 'rgba(0, 0, 0, 0.6)',
  hoverCardBg: 'rgba(255, 255, 255, 0.07)',
  hoverEdgeColor: 'rgba(255, 255, 255, 0.28)',
  selectedPlayedColor: 'rgba(77, 216, 200, 0.95)',
  selectedUnplayedColorDim: 'rgba(77, 216, 200, 0.34)',
  selectedUnplayedColorBright: 'rgba(77, 216, 200, 0.52)',
  selectedEdgeColor: 'rgba(77, 216, 200, 0.8)',
  selectedGlowColor: 'rgba(77, 216, 200, 0.45)',
  deletePlayedColor: 'rgba(255, 58, 92, 0.95)',
  deleteUnplayedColorDim: 'rgba(255, 58, 92, 0.34)',
  deleteUnplayedColorBright: 'rgba(255, 58, 92, 0.58)',
  deleteEdgeColor: 'rgba(255, 58, 92, 0.9)',
  deleteGlowColor: 'rgba(255, 58, 92, 0.55)',
  tickColor: 'rgba(110, 110, 122, 0.5)'
};

export const SELECTION_PULSE_PERIOD_SEC = 2;
export const DELETE_PULSE_PERIOD_SEC = 0.55;
export const SEGMENT_DELETE_ANIM_MS = 480;

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
 * @property {number} hoverSegmentIndex - segment currently under the mouse cursor (hover, distinct from selected)
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
 * @property {AudioBuffer|null} pendingTakeBuffer
 * @property {'fresh'|'append'|null} recordModalContext
 * @property {AudioBufferSourceNode|null} previewSource
 * @property {number} previewStartTime
 * @property {number} previewOffset
 * @property {boolean} isPreviewing
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
  hoverSegmentIndex: -1,
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
  draggingPlayhead: false,
  pendingTakeBuffer: null,
  recordModalContext: null,
  previewSource: null,
  previewStartTime: 0,
  previewOffset: 0,
  isPreviewing: false
};


