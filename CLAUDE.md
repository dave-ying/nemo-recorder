# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Nemo Recorder is a browser-based, truly lossless PCM audio recorder. It captures raw audio from the Web Audio API via `AudioWorklet` (bypassing `MediaRecorder`'s lossy Opus/Vorbis encoding), and lets the user trim/split/delete segments on a waveform before exporting to WAV or MP3. It's a vanilla JS, zero-runtime-dependency, no-build-step app — plain ES modules served as static files.

## Commands

```bash
npm run dev     # node dev-server.js — static file server at http://localhost:5173 (required: ES modules don't load over file://)
npm test        # node --test "tests/**/*.test.js" — Node's built-in test runner
npm run check   # tsc --noEmit -p jsconfig.json — type-checks the JS via JSDoc annotations (checkJs, no build output)
```

Run a single test file directly: `node --test tests/waveform-math.test.js`

There is no bundler/build step — files are served as-is. `dev-server.js` is a minimal zero-dependency static server (only exists because browsers block ES module imports from `file://`); any static server works instead.

## Architecture

### Module structure (`js/`)

All modules communicate through one shared mutable `state` object (`js/state.js`) — there is no framework, no event bus, no reactive layer. Modules import `state` directly and mutate it; DOM updates are then triggered imperatively (e.g. `drawPlaybackWaveform(ratio)`, `updateSegmentCountDisplay()`). When editing behavior, trace effects through `state` rather than expecting props/events to flow.

- **`state.js`** — the single `AppState` object (JSDoc-typed) plus layout/style constants (`WAVEFORM_STYLE` colors, segment gap/corner/shadow px, `LIVE_SECONDS`, `MIN_SEGMENT_SAMPLES`). Start here to understand what fields exist before touching any feature.
- **`dom.js`** — one-time `getElementById` lookups into a typed `el` object, plus the two canvas 2D contexts (`liveCtx`, `waveCtx`). Element IDs are static in `index.html`; add new DOM refs here rather than querying ad hoc.
- **`main.js`** — wires all DOM event listeners (buttons, keyboard shortcuts, drag/resize handlers) to functions exported by the other modules. This is the composition root; it contains almost no logic of its own — look here to find *what triggers what*, then follow into the relevant module for *how*.
- **`audio.js`** — mic connection/capabilities detection, `AudioWorklet` setup (worklet processor source is an inline string, loaded via a `data:` URL — no separate worklet file), recording start/stop, live ring-buffer used for the recording-view waveform.
- **`upload.js`** — lets the user pick an existing audio file (from `connectView` or `readyView`) instead of recording one, via `<input type="file">` + `AudioContext.decodeAudioData`. Reuses `editing.js`'s `loadBufferAsRecording()` to land in the same playback-ready state a mic capture would.
- **`waveform.js`** — canvas rendering for the playback waveform: segment "cards" with gaps, peak computation from the recorded buffer, playhead/scissors/trash positioning, segment hover/selection. This is the largest and most visual-detail-heavy module.
- **`waveform-math.js`** — pure, DOM-free geometry functions (`computeSegmentBoundsPure`, `audioRatioToVisualRatio`, `visualRatioToAudioRatio`) that map between audio-time ratios and on-screen pixel ratios, accounting for the gaps drawn between segment cards. Kept pure specifically so it's unit-testable in Node without a DOM — this is where segment/gap math bugs should be fixed, and where their tests live.
- **`editing.js`** — segment operations: split at playhead, delete segment (by index or at playhead), `rebuildPlaybackBuffer()` which reconstitutes `state.recordedBuffer` from `state.originalBuffer` + `state.segments` whenever segments change, and `loadBufferAsRecording()` which installs a brand-new full-length `AudioBuffer` (from either a finished mic capture or an uploaded file) as the current recording. `state.originalBuffer` (the raw capture) is never mutated; edits only change the `segments` array and the derived `recordedBuffer`.
- **`playback.js`** — `AudioBufferSourceNode`-based playback (start/pause/seek), driven by `requestAnimationFrame` for waveform/time sync.
- **`scrub.js`** — held-arrow-key scrubbing with acceleration (ramps from `SCRUB_MIN_SPEED` to `SCRUB_MAX_SPEED` the longer a key is held).
- **`export.js`** — export modal UI + lazily-created Web Workers for encoding (one worker per format, created on first use). Talks to `worker-code.js` for the actual worker source.
- **`worker-code.js`** — WAV and MP3 encoder source, kept as **template-literal strings** (not real worker files) so they can be spun up from Blob URLs and also imported directly into Node tests via `vm.runInContext`. This file is intentionally DOM-free — don't add browser-only APIs to the worker source strings.
- **`ui.js`** — small generic DOM helpers: toasts, header state management (`updateHeaderState`), recording UI mode (`setRecordingUI`), empty-state display (`updateEmptyState`), transport button enable/disable, quality-option rendering.
- **`utils.js`** — pure formatting helpers (`formatTime`, `formatSize`).

### Vendored dependencies

`vendor/lame.min.js` is a vendored copy of lamejs (MIT) for client-side MP3 encoding, loaded via `importScripts` inside the MP3 worker (resolved to an absolute URL since Blob-URL workers can't resolve relative `importScripts` paths). There are no npm runtime dependencies — `typescript` is the only devDependency, used solely for `npm run check`.

### Editor modes (single view)

The app has a single view (the editor). Three modes are driven by state, not DOM views:
- **Empty** — no `state.recordedBuffer` and not recording. Shows the empty-state placeholder with an upload button. Transport is disabled.
- **Recording** — `state.isRecording` is true. Live meter bar replaces the timeline ruler, live canvas overlays the waveform, stop button replaces the play button.
- **Editing** — `state.recordedBuffer` is set. Full waveform rendering, segment editing (split/delete/drag/trash/scissors), playback transport.

Mode transitions are handled by `setRecordingUI()` and `updateEmptyState()` in `ui.js`, not by toggling view containers. `state.originalBuffer` holds the untouched capture; `state.segments` (array of `{start, end}` sample ranges into `originalBuffer`) plus `rebuildPlaybackBuffer()` in `editing.js` produce `state.recordedBuffer`, which is what's actually played back and exported.

### Segment card rendering

Segments are drawn as visually separated "cards" with gaps between them (`SEGMENT_GAP_CSS_PX`), even though the underlying audio is contiguous. This creates a mapping problem — audio-time ratios and on-screen pixel ratios diverge at segment boundaries — solved by the pure functions in `waveform-math.js`. Any change to playhead positioning, drag-handles, or click-to-seek needs to go through `audioRatioToVisualRatio`/`visualRatioToAudioRatio`, not naive linear interpolation.

## Testing

Tests are plain Node `node:test` files with no test framework/runner beyond that. `tests/waveform-math.test.js` covers the pure geometry functions; `tests/core.test.js` covers `utils.js` formatters and both encoder workers (running the WAV worker's string source via `new Function`, and the MP3 worker's via `vm.runInContext` with the real vendored lamejs loaded through a mocked `importScripts`). When adding logic that can be expressed DOM-free, prefer putting it in a pure module (like `waveform-math.js`) so it stays testable the same way.
