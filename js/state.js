export const LIVE_SECONDS = 4;
export const WAVEFORM_SCALE = 0.88;

export const MIN_SEGMENT_SAMPLES = 500;
export const SEGMENT_DRAG_THRESHOLD_CSS_PX = 4;
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

// Segment reorder drag animation tuning. The live drag uses an exponential
// approach (segments ease toward their would-be positions every frame); the
// settle phase (after pointerup) uses a fixed-duration ease-out so the
// floating card snaps cleanly into its final slot.
export const SEGMENT_DRAG_LIFT_CSS_PX = 14;
export const SEGMENT_DRAG_SETTLE_MS = 220;
export const SEGMENT_DRAG_SHADOW_BLUR_CSS_PX = 20;
export const SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX = 9;
export const SEGMENT_DRAG_APPROACH_RATE = 22; // per-second convergence rate for live ease

export const APPEND_BUTTON_SIZE_CSS_PX = 30;
export const APPEND_BUTTON_PAD_CSS_PX = 16;

/**
 * @typedef {Object} DragSnapshot
 * @property {number} handleIndex
 * @property {number} totalSamples
 * @property {number} startClientX
 * @property {number} accBeforeSegI
 * @property {number} segIStart
 * @property {number} segIP1End
 * @property {number} minAcc
 * @property {number} maxAcc
 */

/**
 * @typedef {Object} SegmentDragSnapshot
 * @property {number} srcIndex - index of the segment being reordered
 * @property {number} currentClientX - last pointer client X (updated each move)
 * @property {number} dropInsertIndex - raw insert index in [0, segments.length] computed from currentClientX
 * @property {number} playheadSegStart - {start} of the segment the playhead was in at drag-begin (for audio-content preservation), or -1
 * @property {number} playheadSegEnd - {end} of the same segment, or -1
 * @property {number} playheadOffsetInSeg - sample offset within that segment
 * @property {number} playheadSegOriginalIndex - ORIGINAL index of the playhead segment at drag-begin, or -1
 * @property {number} pointerX - current pointer X over the waveform canvas, in device px (for the floating card)
 * @property {number} pointerOffsetInCard - device-px offset of the pointer within the dragged card at drag-begin (so the floating card stays pinned to the grab point)
 * @property {Array<{drawStart: number, drawEnd: number}>} animBounds - per ORIGINAL segment index, current animated card bounds in device px
 * @property {Array<{drawStart: number, drawEnd: number}>} targetBounds - per ORIGINAL segment index, target card bounds in device px (from the live arrangement)
 * @property {Array<Path2D>} segPaths - per ORIGINAL segment index, the local waveform Path2D built once at drag-begin (so we can scaleX-render at any animated width)
 * @property {Array<number>} segPathWidths - per ORIGINAL segment index, the width each path was built for (so scaleX = animWidth / pathWidth)
 * @property {Array<{start: number, end: number}>} originalSegments - copy of state.segments' {start, end} at drag-begin (so the arrangement can be resolved even after state.segments is reordered at settle start)
 * @property {number[]} arrangement - current live arrangement as an array of ORIGINAL indices in their would-be order
 * @property {number} liftPx - current lift offset in device px (eases up during drag start, eases to 0 during settle)
 * @property {{ startTime: number, fromX: number, fromDrawEnd: number, fromLift: number, toX: number, toDrawEnd: number, toLift: number, duration: number, finalRatio: number } | null} settle - present during the post-release settle animation
 */

/**
 * @typedef {Object} PendingSegmentDrag
 * @property {number} index - segment index under the pointerdown
 * @property {number} startClientX
 * @property {number} startClientY
 */

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
 * @property {{deviceId: string, label: string}[]} micDevices - audioinput devices, populated after mic permission is granted
 * @property {string|null} micDeviceId - deviceId of the currently connected/selected microphone
 * @property {boolean} isRecording
 * @property {boolean} isPlaying
 * @property {Float32Array[][]} recordedChunks
 * @property {AudioBuffer|null} originalBuffer
 * @property {AudioBuffer|null} recordedBuffer
 * @property {Array<{start: number, end: number, origin: string}>} segments
 * @property {AudioBufferSourceNode|null} playbackSource
 * @property {number} playbackStartTime
 * @property {number} playbackOffset
 * @property {number} recordStartTime - performance.now() at recording start (drives live timer)
 * @property {number} selectedSegmentIndex
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
 * @property {number} draggingHandleIndex
 * @property {DragSnapshot|null} _dragSnapshot
 * @property {boolean} draggingPlayhead
 * @property {number} draggingSegmentIndex - segment being reordered via drag-and-drop (-1 when not dragging)
 * @property {PendingSegmentDrag|null} pendingSegmentDrag - tracks pointerdown on a segment before the drag threshold is crossed; if pointerup fires first, it is treated as a click (show/hide trash)
 * @property {SegmentDragSnapshot|null} _segmentDragSnapshot
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
  micDevices: [],
  micDeviceId: null,
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
  selectedSegmentIndex: -1,
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
  draggingPlayhead: false,
  draggingSegmentIndex: -1,
  pendingSegmentDrag: null,
  _segmentDragSnapshot: null,
  pendingTakeBuffer: null,
  recordModalContext: null,
  previewSource: null,
  previewStartTime: 0,
  previewOffset: 0,
  isPreviewing: false
};


