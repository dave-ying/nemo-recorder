export const $ = (id) => document.getElementById(id);

/**
 * @typedef {Object} AppElements
 * @property {HTMLButtonElement} connectButton
 * @property {HTMLButtonElement} disconnectButton
 * @property {HTMLDivElement} emptyState
 * @property {HTMLButtonElement} emptyStateRecordButton
 * @property {HTMLButtonElement} emptyStateUploadButton
 * @property {HTMLInputElement} fileInput
 * @property {HTMLButtonElement} recordButton
 * @property {HTMLButtonElement} stopButton
 * @property {HTMLButtonElement} restartButton
 * @property {HTMLButtonElement} skipForwardButton
 * @property {HTMLButtonElement} playButton
 * @property {HTMLButtonElement} downloadButton
 * @property {HTMLButtonElement} splitButton
 * @property {HTMLButtonElement} deleteButton
 * @property {HTMLButtonElement} undoButton
 * @property {HTMLButtonElement} redoButton
 * @property {HTMLButtonElement} transportUploadButton
 * @property {HTMLButtonElement} transportRecordButton
 * @property {HTMLButtonElement} playheadScissors
 * @property {HTMLButtonElement} playheadCaretTop
 * @property {HTMLSpanElement} playheadLine
 * @property {HTMLButtonElement} segmentTrash
 * @property {HTMLDivElement} playbackView
 * @property {HTMLDivElement} headerMicInfo
 * @property {HTMLDivElement} liveMeterBar
 * @property {HTMLButtonElement} settingsButton
 * @property {HTMLCanvasElement} liveCanvas
 * @property {HTMLCanvasElement} waveformCanvas
 * @property {HTMLCanvasElement} timelineRulerCanvas
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
 * @property {HTMLDivElement} qualityModal
 * @property {HTMLButtonElement} qualityModalClose
 * @property {HTMLDivElement} exportModal
 * @property {HTMLButtonElement} exportClose
 * @property {HTMLDivElement} exportQualityGrid
 * @property {HTMLSpanElement} exportSize
 * @property {HTMLSpanElement} exportDetail
 * @property {HTMLButtonElement} exportConfirm
 * @property {HTMLButtonElement} appendButton
 * @property {HTMLDivElement} appendMenu
 * @property {HTMLButtonElement} appendMenuUpload
 * @property {HTMLButtonElement} appendMenuRecord
 * @property {HTMLInputElement} appendFileInput
 */

// Element IDs are static in index.html, so a single cast here gives every
// consumer precise element types instead of `HTMLElement | null` everywhere.
export const el = /** @type {AppElements} */ (/** @type {any} */ ({
  connectButton: $('connectButton'), disconnectButton: $('disconnectButton'),
  emptyState: $('emptyState'), emptyStateRecordButton: $('emptyStateRecordButton'), emptyStateUploadButton: $('emptyStateUploadButton'), fileInput: $('fileInput'),
  recordButton: $('recordButton'), stopButton: $('stopButton'),
  restartButton: $('restartButton'), skipForwardButton: $('skipForwardButton'), playButton: $('playButton'), downloadButton: $('downloadButton'),
  splitButton: $('splitButton'), deleteButton: $('deleteButton'),
  undoButton: $('undoButton'), redoButton: $('redoButton'),
  transportUploadButton: $('transportUploadButton'), transportRecordButton: $('transportRecordButton'),
  playheadScissors: $('playheadScissors'), playheadCaretTop: $('playheadCaretTop'), playheadLine: $('playheadLine'), segmentTrash: $('segmentTrash'),
  headerMicInfo: $('headerMicInfo'), settingsButton: $('settingsButton'),
  liveMeterBar: $('liveMeterBar'), playbackView: $('playbackView'),
  liveCanvas: $('liveCanvas'), waveformCanvas: $('waveformCanvas'), timelineRulerCanvas: $('timelineRulerCanvas'),
  waveformContainer: $('waveformContainer'), segmentCountEl: $('segmentCount'),
  liveTimer: $('liveTimer'), levelFill: $('levelFill'),
  timeCurrent: $('timeCurrent'), timeTotal: $('timeTotal'),
  micName: $('micName'),
  rateOptions: $('rateOptions'), bitOptions: $('bitOptions'), chOptions: $('chOptions'),
  bitrateReadout: $('bitrateReadout'), toast: $('toast'), toastMessage: $('toastMessage'),
  qualityModal: $('qualityModal'), qualityModalClose: $('qualityModalClose'),
  exportModal: $('exportModal'), exportClose: $('exportClose'),
  exportQualityGrid: $('exportQualityGrid'), exportSize: $('exportSize'),
  exportDetail: $('exportDetail'), exportConfirm: $('exportConfirm'),
  appendButton: $('appendButton'), appendMenu: $('appendMenu'),
  appendMenuUpload: $('appendMenuUpload'), appendMenuRecord: $('appendMenuRecord'),
  appendFileInput: $('appendFileInput')
}));

export const liveCtx = /** @type {CanvasRenderingContext2D} */ (el.liveCanvas.getContext('2d'));
export const waveCtx = /** @type {CanvasRenderingContext2D} */ (el.waveformCanvas.getContext('2d'));
export const rulerCtx = /** @type {CanvasRenderingContext2D} */ (el.timelineRulerCanvas.getContext('2d'));
