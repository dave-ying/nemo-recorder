export const $ = (id) => document.getElementById(id);

/**
 * @typedef {Object} AppElements
 * @property {HTMLButtonElement} connectButton
 * @property {HTMLButtonElement} disconnectButton
 * @property {HTMLButtonElement} recordButton
 * @property {HTMLButtonElement} stopButton
 * @property {HTMLButtonElement} restartButton
 * @property {HTMLButtonElement} skipForwardButton
 * @property {HTMLButtonElement} playButton
 * @property {HTMLButtonElement} retryButton
 * @property {HTMLButtonElement} downloadButton
 * @property {HTMLButtonElement} splitButton
 * @property {HTMLButtonElement} deleteButton
 * @property {HTMLButtonElement} playheadScissors
 * @property {HTMLButtonElement} playheadCaretTop
 * @property {HTMLButtonElement} playheadCaretBottom
 * @property {HTMLButtonElement} segmentTrash
 * @property {HTMLDivElement} connectView
 * @property {HTMLDivElement} readyView
 * @property {HTMLDivElement} recordingView
 * @property {HTMLDivElement} playbackView
 * @property {HTMLCanvasElement} liveCanvas
 * @property {HTMLCanvasElement} waveformCanvas
 * @property {HTMLDivElement} waveformContainer
 * @property {HTMLDivElement} segmentCountEl
 * @property {HTMLDivElement} liveTimer
 * @property {HTMLDivElement} levelFill
 * @property {HTMLSpanElement} timeCurrent
 * @property {HTMLSpanElement} timeTotal
 * @property {HTMLDivElement} micName
 * @property {HTMLDivElement} rateOptions
 * @property {HTMLDivElement} bitOptions
 * @property {HTMLDivElement} chOptions
 * @property {HTMLSpanElement} bitrateReadout
 * @property {HTMLDivElement} toast
 * @property {HTMLSpanElement} toastMessage
 * @property {HTMLDivElement} exportModal
 * @property {HTMLButtonElement} exportClose
 * @property {HTMLDivElement} exportQualityGrid
 * @property {HTMLSpanElement} exportSize
 * @property {HTMLSpanElement} exportDetail
 * @property {HTMLButtonElement} exportConfirm
 */

// Element IDs are static in index.html, so a single cast here gives every
// consumer precise element types instead of `HTMLElement | null` everywhere.
export const el = /** @type {AppElements} */ (/** @type {any} */ ({
  connectButton: $('connectButton'), disconnectButton: $('disconnectButton'),
  recordButton: $('recordButton'), stopButton: $('stopButton'),
  restartButton: $('restartButton'), skipForwardButton: $('skipForwardButton'), playButton: $('playButton'), retryButton: $('retryButton'), downloadButton: $('downloadButton'),
  splitButton: $('splitButton'), deleteButton: $('deleteButton'),
  playheadScissors: $('playheadScissors'), playheadCaretTop: $('playheadCaretTop'), playheadCaretBottom: $('playheadCaretBottom'), segmentTrash: $('segmentTrash'),
  connectView: $('connectView'), readyView: $('readyView'),
  recordingView: $('recordingView'), playbackView: $('playbackView'),
  liveCanvas: $('liveCanvas'), waveformCanvas: $('waveformCanvas'),
  waveformContainer: $('waveformContainer'), segmentCountEl: $('segmentCount'),
  liveTimer: $('liveTimer'), levelFill: $('levelFill'),
  timeCurrent: $('timeCurrent'), timeTotal: $('timeTotal'),
  micName: $('micName'),
  rateOptions: $('rateOptions'), bitOptions: $('bitOptions'), chOptions: $('chOptions'),
  bitrateReadout: $('bitrateReadout'), toast: $('toast'), toastMessage: $('toastMessage'),
  exportModal: $('exportModal'), exportClose: $('exportClose'),
  exportQualityGrid: $('exportQualityGrid'), exportSize: $('exportSize'),
  exportDetail: $('exportDetail'), exportConfirm: $('exportConfirm')
}));

export const liveCtx = /** @type {CanvasRenderingContext2D} */ (el.liveCanvas.getContext('2d'));
export const waveCtx = /** @type {CanvasRenderingContext2D} */ (el.waveformCanvas.getContext('2d'));
