const $ = (id) => document.getElementById(id);

/**
 * @typedef {Object} AppElements
 * @property {HTMLDivElement} emptyState
 * @property {HTMLButtonElement} emptyStateRecordButton
 * @property {HTMLButtonElement} emptyStateUploadButton
 * @property {HTMLInputElement} fileInput
 * @property {HTMLButtonElement} restartButton
 * @property {HTMLButtonElement} skipForwardButton
 * @property {HTMLButtonElement} playButton
 * @property {HTMLButtonElement} downloadButton
 * @property {HTMLButtonElement} splitButton
 * @property {HTMLButtonElement} deleteSegmentButton
 * @property {HTMLButtonElement} undoButton
 * @property {HTMLButtonElement} redoButton
 * @property {HTMLButtonElement} playheadCaretTop
 * @property {HTMLSpanElement} playheadLine
 * @property {HTMLElement} stage
 * @property {HTMLDivElement} playbackView
 * @property {HTMLDivElement} editorSection
 * @property {HTMLDivElement} editorTopBar
 * @property {HTMLDivElement} transportBar
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
 * @property {HTMLDivElement} micDeviceRow
 * @property {HTMLSelectElement} micDeviceSelect
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
 * @property {HTMLButtonElement} appendButton
 * @property {HTMLDivElement} appendMenu
 * @property {HTMLButtonElement} appendMenuUpload
 * @property {HTMLButtonElement} appendMenuRecord
 * @property {HTMLInputElement} appendFileInput
 * @property {HTMLDivElement} recordModal
 * @property {HTMLButtonElement} recordModalClose
 * @property {HTMLDivElement} rmSettingsWrap
 * @property {HTMLSpanElement} rmMicDot
 * @property {HTMLButtonElement} rmConnectBtn
 * @property {HTMLButtonElement} rmSettingsBtn
 * @property {HTMLButtonElement} rmDisconnectBtn
 * @property {HTMLDivElement} rmReadyView
 * @property {HTMLDivElement} rmNoMicView
 * @property {HTMLDivElement} rmReadySpec
 * @property {HTMLDivElement} rmCanvasWrap
 * @property {HTMLDivElement} rmReviewWrap
 * @property {HTMLDivElement} rmReviewCanvasArea
 * @property {HTMLCanvasElement} rmReviewCanvas
 * @property {HTMLButtonElement} rmPlayhead
 * @property {HTMLDivElement} rmRecordingControls
 * @property {HTMLDivElement} rmReviewControls
 * @property {HTMLSpanElement} rmReviewCurrent
 * @property {HTMLSpanElement} rmReviewTotal
 * @property {HTMLButtonElement} rmRecordBtn
 * @property {HTMLButtonElement} rmStopBtn
 * @property {HTMLButtonElement} rmPlayBtn
 * @property {HTMLDivElement} rmActionsRight
 * @property {HTMLButtonElement} rmRetakeBtn
 * @property {HTMLButtonElement} rmAddBtn
 * @property {HTMLDivElement} confirmModal
 * @property {HTMLSpanElement} confirmTitle
 * @property {HTMLDivElement} confirmMessage
 * @property {HTMLButtonElement} confirmCancel
 * @property {HTMLButtonElement} confirmOk
 */

// Element IDs are static in index.html, so a single cast here gives every
// consumer precise element types instead of `HTMLElement | null` everywhere.
export const el = /** @type {AppElements} */ (/** @type {any} */ ({
  emptyState: $('emptyState'), emptyStateRecordButton: $('emptyStateRecordButton'), emptyStateUploadButton: $('emptyStateUploadButton'), fileInput: $('fileInput'),
  restartButton: $('restartButton'), skipForwardButton: $('skipForwardButton'), playButton: $('playButton'), downloadButton: $('downloadButton'),
  splitButton: $('splitButton'), deleteSegmentButton: $('deleteSegmentButton'),
  undoButton: $('undoButton'), redoButton: $('redoButton'),
  playheadCaretTop: $('playheadCaretTop'), playheadLine: $('playheadLine'),
  stage: $('stage'),
  playbackView: $('playbackView'), editorSection: $('editorSection'), editorTopBar: $('editorTopBar'), transportBar: $('transportBar'),
  liveCanvas: $('liveCanvas'), waveformCanvas: $('waveformCanvas'), timelineRulerCanvas: $('timelineRulerCanvas'),
  waveformContainer: $('waveformContainer'), segmentCountEl: $('segmentCount'),
  liveTimer: $('liveTimer'), levelFill: $('levelFill'),
  timeCurrent: $('timeCurrent'), timeTotal: $('timeTotal'),
  micName: $('micName'),
  micDeviceRow: $('micDeviceRow'), micDeviceSelect: $('micDeviceSelect'),
  rateOptions: $('rateOptions'), bitOptions: $('bitOptions'), chOptions: $('chOptions'),
  bitrateReadout: $('bitrateReadout'), toast: $('toast'), toastMessage: $('toastMessage'),
  exportModal: $('exportModal'), exportClose: $('exportClose'),
  exportQualityGrid: $('exportQualityGrid'), exportSize: $('exportSize'),
  exportDetail: $('exportDetail'), exportConfirm: $('exportConfirm'),
  appendButton: $('appendButton'), appendMenu: $('appendMenu'),
  appendMenuUpload: $('appendMenuUpload'), appendMenuRecord: $('appendMenuRecord'),
  appendFileInput: $('appendFileInput'),
  recordModal: $('recordModal'), recordModalClose: $('recordModalClose'),
  rmSettingsWrap: $('rmSettingsWrap'),
  rmMicDot: $('rmMicDot'),
  rmConnectBtn: $('rmConnectBtn'), rmSettingsBtn: $('rmSettingsBtn'), rmDisconnectBtn: $('rmDisconnectBtn'),
  rmReadyView: $('rmReadyView'), rmNoMicView: $('rmNoMicView'), rmReadySpec: $('rmReadySpec'),
  rmCanvasWrap: $('rmCanvasWrap'), rmReviewWrap: $('rmReviewWrap'),
  rmReviewCanvasArea: $('rmReviewCanvasArea'),
  rmReviewCanvas: $('rmReviewCanvas'),
  rmPlayhead: $('rmPlayhead'),
  rmRecordingControls: $('rmRecordingControls'), rmReviewControls: $('rmReviewControls'),
  rmReviewCurrent: $('rmReviewCurrent'), rmReviewTotal: $('rmReviewTotal'),
  rmRecordBtn: $('rmRecordBtn'), rmStopBtn: $('rmStopBtn'), rmPlayBtn: $('rmPlayBtn'),
  rmActionsRight: $('rmActionsRight'),
  rmRetakeBtn: $('rmRetakeBtn'), rmAddBtn: $('rmAddBtn'),
  confirmModal: $('confirmModal'), confirmTitle: $('confirmTitle'), confirmMessage: $('confirmMessage'),
  confirmCancel: $('confirmCancel'), confirmOk: $('confirmOk')
}));

export const liveCtx = /** @type {CanvasRenderingContext2D} */ (el.liveCanvas.getContext('2d'));
export const waveCtx = /** @type {CanvasRenderingContext2D} */ (el.waveformCanvas.getContext('2d'));
export const rulerCtx = /** @type {CanvasRenderingContext2D} */ (el.timelineRulerCanvas.getContext('2d'));
export const reviewCtx = /** @type {CanvasRenderingContext2D} */ (el.rmReviewCanvas.getContext('2d'));
