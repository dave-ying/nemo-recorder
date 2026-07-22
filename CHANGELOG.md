# Changelog

All notable user-facing changes to Nemo Recorder are documented here.

## 2026-07-22

- Added a Help modal with keyboard shortcuts, changelog, and About panels.
- Added keyboard shortcuts for playback, segment navigation, editing, and opening the Record modal.
- Added a right-click segment context menu with Copy, Paste, Duplicate, and Delete actions.
- Added direct paste-at-playhead support, splitting a segment when the playhead is in the middle of it.
- Improved the visual feedback for segment drag-and-drop reordering.
- Enabled automatic development-server port selection.

## 2026-07-21

- Added drag-and-drop segment reordering with live drag animations.
- Improved split behavior so the playhead snaps to the next segment after splitting.
- Added division handles at segment gaps and updated the split icon.
- Reorganized editing controls into the top toolbar and moved Export to the transport bar.
- Added a GitHub link to the application footer.
- Moved capture settings into the Record modal and removed the separate settings modal.
- Expanded supported audio import formats and added clearer format-specific decode errors.
- Added a 500 MB import size guard and browser-aware error guidance.
- Added microphone capability detection and an input-device picker.
- Removed redundant floating upload, record, scissors, and delete controls from the editor canvas.

## 2026-07-20

- Added a standalone Record modal with microphone status, capture settings, live waveform, and seekable review.
- Added an append-audio menu for adding more audio by upload or recording.
- Added confirmation before discarding recorded audio.
- Improved Record modal playback, seeking, and playhead behavior.
- Improved segment-boundary handling and the layout of the editor waveform and transport controls.
- Improved waveform rendering performance by caching reusable drawing layers.
- Added upload support to the initial and ready views.
- Consolidated the app into a single editor page with header-based controls.
- Renamed the app from Nemo Record to Nemo Recorder.

## 2026-07-19

- Added undo and redo history for segment edits.
- Added arrow-key scrubbing with hold-to-accelerate behavior.
- Added keyboard navigation between segments.
- Added draggable playhead carets and improved split-line and segment-boundary visuals.
- Added segment hover states, selection feedback, and click-outside deselection.
- Added a skip-forward control that navigates between segments.
- Simplified the editor layout and removed redundant file-information readouts.
- Added the local development-server launch configuration.

## 2026-07-18

- Initial release of Nemo Recorder, a browser-based lossless PCM audio recorder.
