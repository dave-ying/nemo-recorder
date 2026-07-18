// Encoder worker sources, kept as strings so workers can be created from Blob URLs.
// This module must stay DOM-free so it can be imported by tests (Node) as well as the app.

// lamejs is vendored locally (vendor/lame.min.js, MIT-licensed lamejs 1.2.1) so MP3
// export works offline and doesn't depend on a CDN. Resolved to an absolute URL because
// Blob-URL workers cannot resolve relative importScripts paths.
const LAME_URL = new URL('../vendor/lame.min.js', import.meta.url).href;

export const wavWorkerCode = `
  function encodeWAV(channels, sampleRate, bitDepth) {
    const numChannels = channels.length;
    const numSamples = channels[0].length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numSamples * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    if (bitDepth === 16) {
      const int16 = new Int16Array(buffer, 44);
      let idx = 0;
      for (let i = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++) {
          const s = Math.max(-1, Math.min(1, channels[c][i]));
          int16[idx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
      }
    } else if (bitDepth === 32) {
      const float32 = new Float32Array(buffer, 44);
      let idx = 0;
      for (let i = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++) {
          float32[idx++] = Math.max(-1, Math.min(1, channels[c][i]));
        }
      }
    } else if (bitDepth === 24) {
      const bytes = new Uint8Array(buffer, 44);
      let idx = 0;
      for (let i = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++) {
          let val = Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 0x7FFFFF);
          if (val < 0) val += 0x1000000;
          bytes[idx++] = val & 0xFF;
          bytes[idx++] = (val >> 8) & 0xFF;
          bytes[idx++] = (val >> 16) & 0xFF;
        }
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  self.onmessage = function(e) {
    try {
      const { channels, sampleRate, bitDepth } = e.data;
      const blob = encodeWAV(channels, sampleRate, bitDepth);
      self.postMessage({ blob });
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  };
`;

export const mp3WorkerCode = `
  let lameLoaded = false;
  try {
    importScripts(${JSON.stringify(LAME_URL)});
    lameLoaded = true;
  } catch (e) {
    // Reported via postMessage on the first encode request below.
  }

  self.onmessage = function(e) {
    if (!lameLoaded) {
      self.postMessage({ error: 'Failed to load MP3 encoder' });
      return;
    }
    try {
      const { channels, sampleRate, bitrate } = e.data;
      const numChannels = channels.length;
      const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
      const mp3Data = [];
      const blockLength = 1152;

      const int16Channels = channels.map(ch => {
        const int16 = new Int16Array(ch.length);
        for (let i = 0; i < ch.length; i++) {
          let s = Math.max(-1, Math.min(1, ch[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16;
      });

      if (numChannels === 1) {
        const left = int16Channels[0];
        for (let i = 0; i < left.length; i += blockLength) {
          const chunk = left.subarray(i, i + blockLength);
          const mp3buf = mp3encoder.encodeBuffer(chunk);
          if (mp3buf.length > 0) mp3Data.push(new Int8Array(mp3buf));
        }
      } else {
        const left = int16Channels[0];
        const right = int16Channels[1];
        for (let i = 0; i < left.length; i += blockLength) {
          const chunkL = left.subarray(i, i + blockLength);
          const chunkR = right.subarray(i, i + blockLength);
          const mp3buf = mp3encoder.encodeBuffer(chunkL, chunkR);
          if (mp3buf.length > 0) mp3Data.push(new Int8Array(mp3buf));
        }
      }

      const end = mp3encoder.flush();
      if (end.length > 0) mp3Data.push(new Int8Array(end));

      const blob = new Blob(mp3Data, { type: 'audio/mp3' });
      self.postMessage({ blob });
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  };
`;
