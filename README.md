# Nemo Audio

Truly lossless PCM audio capture directly from the Web Audio API — no compression, no codecs, no compromises.

Unlike most browser recorders that use `MediaRecorder` (which forces lossy Opus/Vorbis encoding), Nemo Audio captures raw PCM from the Web Audio graph via `AudioWorklet`, giving the same fidelity as a professional DAW at the same sample rate and bit depth.

## Features

- **Lossless PCM capture** — bit-exact audio buffer, bypasses MediaRecorder entirely
- **Live waveform** — real-time ring-buffer waveform during recording
- **Interactive playback** — seek, split, delete, and reorder segments on the waveform
- **Trim Silence** — removes silent stretches automatically, with adjustable threshold and minimum duration
- **Normalize Loudness** — persistent effect that brings all audio to a target loudness (BS.1770 LUFS) with a true-peak ceiling; automatically applies to newly added audio, non-destructive
- **Remove Noise** — persistent RNNoise-powered background-noise suppression (fans, hum, hiss), per-channel so stereo stays stereo; automatically applies to newly added audio, non-destructive
- **Export WAV** — lossless PCM at your chosen quality settings
- **Export MP3** — compressed, powered by lamejs (client-side only)
- **Import audio files** — MP3, WAV, M4A/AAC, FLAC (all browsers); OGG/Opus/WebM (Chrome, Firefox, Edge); AIFF/CAF (Safari); audio tracks extracted from MP4/MOV/WebM video; files up to 500 MB
- **No analytics or telemetry** — all audio processing is local, no uploads to any server (fonts load from Google Fonts)

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
- Web Workers — WAV/MP3 encoding and RNNoise noise suppression (off the main thread)
- lamejs — client-side MP3 encoding (MIT license, vendored)
- rnnoise-wasm — neural noise suppression (Apache-2.0, Jitsi build, vendored)
- Zero runtime dependencies — no npm packages, no build tools

## License

MIT
