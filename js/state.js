export const LIVE_SECONDS = 4;
export const WAVEFORM_SCALE = 0.88;

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
  dragCardBg: 'rgba(36, 39, 50, 0.98)',
  dropZoneBg: 'rgba(0, 0, 0, 0.18)',
  dropZoneEdgeColor: 'rgba(255, 255, 255, 0.16)',
  deletePlayedColor: 'rgba(255, 58, 92, 0.95)',
  deleteUnplayedColorDim: 'rgba(255, 58, 92, 0.34)',
  deleteUnplayedColorBright: 'rgba(255, 58, 92, 0.58)',
  deleteEdgeColor: 'rgba(255, 58, 92, 0.9)',
  deleteGlowColor: 'rgba(255, 58, 92, 0.55)',
  tickColor: 'rgba(110, 110, 122, 0.5)'
};

// ===== Effects model =====
//
// Effects are split into two tiers:
//   - Per-track "source cleanup" — denoise, noise gate, EQ, de-esser. Each
//     lives on the Track (see below) and applies to everything on that track.
//   - Master "finishing" — loudness normalization (state.master.loudness),
//     applied to the summed mix in editing.js's rebuildMix().
// There is no per-segment scoping: to exclude part of a recording from an
// effect, move that segment to its own track.

/** Clone a segment/clip (including its timeline position `tStart` when set). */
export function cloneSeg(s) {
  return { start: s.start, end: s.end, origin: s.origin, tStart: s.tStart };
}

export const SELECTION_PULSE_PERIOD_SEC = 2;
export const DELETE_PULSE_PERIOD_SEC = 0.55;
export const SEGMENT_DELETE_ANIM_MS = 480;

// Segment reorder drag animation tuning. The live drag uses an exponential
// approach (segments ease toward their would-be positions every frame); the
// settle phase (after pointerup) uses a fixed-duration ease-out so the
// floating card snaps cleanly into its final slot.
export const SEGMENT_DRAG_LIFT_CSS_PX = 14;
// Vertical headroom above the waveform canvas for the dragged card, used by
// the drag overlay canvas in waveform.js. Must equal the `top`/`height` offset
// on `.drag-overlay-canvas` in styles.css. Sized to cover the lift (14) +
// 1.03× scale-up + edge glow with margin; stays inside `.waveform-container`'s
// 32px top margin and the 26px ruler band above.
export const SEGMENT_DRAG_HEADROOM_CSS_PX = 28;
export const SEGMENT_DRAG_SETTLE_MS = 220;
export const SEGMENT_DRAG_SHADOW_BLUR_CSS_PX = 20;
export const SEGMENT_DRAG_SHADOW_OFFSET_Y_CSS_PX = 9;
export const SEGMENT_DRAG_APPROACH_RATE = 22; // per-second convergence rate for live ease
export const SEGMENT_DRAG_SCALE_MAX = 0.03; // extra uniform scale-up applied to the fully-lifted card

export const APPEND_BUTTON_SIZE_CSS_PX = 32;

/**
 * @typedef {Object} SegmentDragSnapshot
 * @property {number} srcIndex - index of the segment being reordered
 * @property {number} currentClientX - last pointer client X (updated each move)
 * @property {number} dropInsertIndex - raw insert index in [0, segments.length] computed from currentClientX
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
 * @typedef {Object} ClipboardSegment
 * @property {Float32Array[]} channels - copied PCM data, one array per channel
 * @property {number} length - sample length of the copied audio
 * @property {number} sampleRate
 */

/**
 * @typedef {Object} MicCapabilities
 * @property {number[]} supportedRates
 * @property {number[]} supportedChannels
 * @property {number[]} supportedBitDepths
 */

/**
 * A single audio track. The app is multi-track: `state.tracks` holds one or
 * more of these, and `state.activeTrackIndex` selects the one that record /
 * upload / paste / edit operations target. Everything that used to be a
 * top-level `state` field for the (single) recording now lives per-track;
 * `state.originalBuffer`, `state.segments`, `state.effectsBuffer`, and the
 * per-track cleanup effects `state.denoise`/`state.gate`/`state.eq`/
 * `state.deesser` are accessor proxies onto the active track (see the `state`
 * object below) so existing single-track code keeps working unchanged.
 * (Loudness is NOT per-track — it's a master finishing effect in state.master.)
 *
 * `state.recordedBuffer` is NOT per-track — it is the mixed-down master
 * (all tracks summed) that playback and export consume.
 *
 * @typedef {Object} Track
 * @property {number} id - stable unique id (for keying UI / undo)
 * @property {string} name - user-facing lane label
 * @property {AudioBuffer|null} originalBuffer - untouched captured/loaded PCM for this track
 * @property {AudioBuffer|null} effectsBuffer - processed full-length parallel of originalBuffer (see effects.js); null when no effects on
 * @property {Array<{start: number, end: number, origin: string, tStart?: number}>} segments - {start,end} ranges into originalBuffer for this track
 * @property {{enabled: boolean, processing: boolean}} denoise - RNNoise noise removal
 * @property {{enabled: boolean, thresholdDb: number, attackMs: number, holdMs: number, releaseMs: number}} gate - noise gate
 * @property {{enabled: boolean, lowGainDb: number, midGainDb: number, highGainDb: number}} eq - 3-band EQ
 * @property {{enabled: boolean, thresholdDb: number, amount: number}} deesser - de-esser
 * @property {boolean} muted - excluded from the mixdown when true
 * @property {boolean} solo - when any track is soloed, only soloed tracks are mixed
 * @property {number} gainDb - per-track mix gain in dB (0 = unity)
 * @property {number} offsetSamples - timeline start offset (samples): the track's clips begin this far into the master timeline (free positioning, Model B)
 */

let _trackIdCounter = 0;

/**
 * Build a fresh, empty track with per-track effect defaults.
 * @param {Partial<Track>} [overrides]
 * @returns {Track}
 */
export function createTrack(overrides = {}) {
  return {
    id: ++_trackIdCounter,
    name: 'Track 1',
    originalBuffer: null,
    effectsBuffer: null,
    segments: [],
    denoise: { enabled: false, processing: false },
    gate: { enabled: false, thresholdDb: -45, attackMs: 5, holdMs: 100, releaseMs: 200 },
    eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
    deesser: { enabled: false, thresholdDb: -28, amount: 0.6 },
    muted: false,
    solo: false,
    gainDb: 0,
    offsetSamples: 0,
    ...overrides
  };
}

/** The track that record/upload/edit/paste operations currently target. */
export function getActiveTrack() {
  return state.tracks[state.activeTrackIndex];
}

/**
 * @typedef {Object} AppState
 * @property {Track[]} tracks - all audio tracks (>=1)
 * @property {number} activeTrackIndex - index into `tracks` of the operation target
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
 * @property {number} recordedTotalSamples - total samples captured so far (for duration cap warning)
 * @property {AudioBuffer|null} originalBuffer
 * @property {AudioBuffer|null} recordedBuffer - the ACTIVE track's editor buffer (its kept segments concatenated); what the waveform editor draws and edits
 * @property {AudioBuffer|null} mixBuffer - the master mixdown of ALL audible tracks at their offsets/gains; what master playback and export consume
 * @property {Array<{start: number, end: number, origin: string, tStart?: number}>} segments
 * @property {number} bufferEpoch - incremented on every PCM-mutating operation (paste/delete/append/duplicate/reorder); used by undo to skip rebuild for PCM-neutral edits (split)
 * @property {AudioBufferSourceNode|null} playbackSource
 * @property {number} playbackStartTime
 * @property {number} playbackOffset
 * @property {number} timelineSec - the shared timeline playhead position in project seconds (maintained by timeline.js); the authority for clip-level split/delete-at-playhead
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
 * @property {AudioBuffer|null} effectsBuffer - processed full-length parallel of originalBuffer (same length) with the enabled effects applied (see js/effects.js); null when no effects are on. Segment {start, end} ranges index into it interchangeably because every effect is length-preserving.
 * @property {{loudness: {enabled: boolean, targetLufs: number, truePeakDbtp: number}}} master - master "finishing" effects applied to the summed mix (see rebuildMix in editing.js); loudness normalization for now
 * @property {{thresholdDb: number, minSilenceMs: number}} trimSilence - settings for the Trim Silence button (see js/trim-silence.js)
 * @property {{sampleRate: number, bitDepth: number, channels: number}} settings
 * @property {{format: string, quality: number}} exportSettings
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
 * @property {{enabled: boolean, processing: boolean}} denoise - active track's noise-removal effect (proxy; see js/effects.js)
 * @property {{enabled: boolean, thresholdDb: number, attackMs: number, holdMs: number, releaseMs: number}} gate - active track's noise gate (proxy)
 * @property {{enabled: boolean, lowGainDb: number, midGainDb: number, highGainDb: number}} eq - active track's EQ (proxy)
 * @property {{enabled: boolean, thresholdDb: number, amount: number}} deesser - active track's de-esser (proxy)
 * @property {ClipboardSegment|null} clipboardSegment - last segment copied via Copy (context menu or Ctrl+C)
 */

/** @type {AppState} */
export const state = {
  tracks: [createTrack()],
  activeTrackIndex: 0,
  // Per-track fields are proxied onto the active track so single-track code
  // (which reads state.originalBuffer / state.segments / etc. directly) keeps
  // working while the multi-track model lives underneath. See createTrack().
  get originalBuffer() { return this.tracks[this.activeTrackIndex].originalBuffer; },
  set originalBuffer(v) { this.tracks[this.activeTrackIndex].originalBuffer = v; },
  get effectsBuffer() { return this.tracks[this.activeTrackIndex].effectsBuffer; },
  set effectsBuffer(v) { this.tracks[this.activeTrackIndex].effectsBuffer = v; },
  get segments() { return this.tracks[this.activeTrackIndex].segments; },
  set segments(v) { this.tracks[this.activeTrackIndex].segments = v; },
  get denoise() { return this.tracks[this.activeTrackIndex].denoise; },
  set denoise(v) { this.tracks[this.activeTrackIndex].denoise = v; },
  get gate() { return this.tracks[this.activeTrackIndex].gate; },
  set gate(v) { this.tracks[this.activeTrackIndex].gate = v; },
  get eq() { return this.tracks[this.activeTrackIndex].eq; },
  set eq(v) { this.tracks[this.activeTrackIndex].eq = v; },
  get deesser() { return this.tracks[this.activeTrackIndex].deesser; },
  set deesser(v) { this.tracks[this.activeTrackIndex].deesser = v; },
  // Master "finishing" effects — applied to the summed mix, not per-track.
  master: { loudness: { enabled: false, targetLufs: -16, truePeakDbtp: -1 } },
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
  recordedTotalSamples: 0,
  recordedBuffer: null,
  mixBuffer: null,
  bufferEpoch: 0,
  playbackSource: null,
  playbackStartTime: 0,
  playbackOffset: 0,
  timelineSec: 0,
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
  liveResizeHandler: null,
  isDownloading: false,
  /** @type {{thresholdDb: number, minSilenceMs: number}} */
  trimSilence: { thresholdDb: -40, minSilenceMs: 500 },
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
  isPreviewing: false,
  clipboardSegment: null
};

/**
 * The current playhead position as a 0..1 ratio of the active track's editor
 * buffer (state.recordedBuffer). Returns 0 when there is no buffer or it has
 * zero duration. Consolidates an expression that was duplicated across modules.
 */
export function currentPlaybackRatio() {
  return state.recordedBuffer && state.recordedBuffer.duration > 0
    ? state.playbackOffset / state.recordedBuffer.duration
    : 0;
}


