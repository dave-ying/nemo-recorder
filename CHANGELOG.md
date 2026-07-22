# Changelog

All notable user-facing changes to Nemo Recorder are documented here.

## 2026-07-22

- Added a Trim Silence tool that removes silent stretches from the recording, with adjustable threshold and minimum duration.
- Added a Normalize Loudness tool that brings the recording to a target loudness (LUFS) with a true-peak ceiling.
- Added a Remove Noise tool that cleans up steady background noise (fans, hum, hiss) while keeping each channel intact.
- Added a Help panel with keyboard shortcuts, the changelog, and information about Nemo Recorder.
- Added keyboard shortcuts for common playback, editing, and segment-navigation actions.
- Added a right-click menu for copying, pasting, duplicating, and deleting segments.
- You can now paste audio at the playhead; the editor splits the segment first when needed.
- Improved the visual feedback when moving segments by dragging them.
- The playhead now stays in place when you drag a segment to reorder it, instead of moving along with the segment.

## 2026-07-21

- Added drag-and-drop reordering for segments.
- Improved splitting so the playhead moves to the next segment when a split is made.
- Added clearer controls for working with gaps between segments.
- Added microphone support checks and an input selector so you can choose a recording device.
- Recording settings (sample rate, bit depth, channels) now live in the recording panel.
- Added support for more audio formats, with clearer guidance when a file cannot be imported.
- Files larger than 500 MB are now rejected before processing begins.
- Simplified the editor controls by moving editing actions into the main toolbar.
- Added a GitHub link to the footer.

## 2026-07-20

- Added a dedicated recording panel with microphone status, recording settings, a live waveform, and a review step before adding audio to the editor.
- Added a menu for appending more audio by uploading a file or recording again.
- Added a confirmation step before discarding a recording.
- Improved recording review playback, seeking, and playhead behavior.
- Improved waveform rendering performance.
- Added audio-file upload from the initial and ready screens.
- Renamed the app from Nemo Record to Nemo Recorder.

## 2026-07-19

- Added undo and redo for segment edits.
- Added keyboard controls for precise playback and moving between segments.
- Added draggable playhead handles and clearer segment boundaries.
- Improved segment selection feedback and added a skip-forward control for navigating between segments.
- Simplified the editor layout and removed information that was not needed during editing.

## 2026-07-18

- Initial release of Nemo Recorder, a browser-based lossless audio recorder.
