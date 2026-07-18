# Nemo Record

Truly lossless PCM audio capture directly from the Web Audio API — no compression, no codecs, no compromises.

Unlike most browser recorders that use `MediaRecorder` (which forces lossy Opus/Vorbis encoding), Nemo Record captures raw PCM from the Web Audio graph via `AudioWorklet`, giving the same fidelity as a professional DAW at the same sample rate and bit depth.

## Features

- **Lossless PCM capture** — bit-exact audio buffer, bypasses MediaRecorder entirely
- **Live waveform** — real-time ring-buffer waveform during recording
- **Interactive playback** — seek, split, and delete segments on the waveform
- **Export WAV** — lossless PCM at your chosen quality settings
- **Export MP3** — compressed, powered by lamejs (client-side only)
- **Zero tracking** — all processing is local, no uploads, no analytics

## Usage

No build step required. Just serve the directory with a static HTTP server (needed for ES modules):

```bash
node dev-server.js
# opens at http://localhost:5173
```

Or any other static server:

```bash
npx serve .
```

## Tech Stack

- Vanilla JavaScript (ES2022 modules)
- Web Audio API — `AudioWorklet` for raw PCM capture
- HTML5 Canvas — live waveform and playback waveform rendering
- Web Workers — WAV and MP3 encoding (off the main thread)
- lamejs — client-side MP3 encoding (MIT license, vendored)
- Zero runtime dependencies — no npm packages, no build tools

## License

MIT
