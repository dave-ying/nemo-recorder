const KNOWN_UNSUPPORTED_RE = /\.(wma|amr|awb|mid|midi|ape|ac3|dts|ra|aup)$/i;
const OGG_FAMILY_RE = /\.(ogg|oga|opus|weba|webm)$/i;   // decodable everywhere except WebKit (Safari + all iOS browsers)
const APPLE_FAMILY_RE = /\.(aif|aiff|aifc|caf)$/i;       // decodable only on WebKit

export const unsupportedFormatError = (fileName, isWebKit = false) => {
  const known = fileName.match(KNOWN_UNSUPPORTED_RE);
  if (known) {
    return `${known[1].toUpperCase()} files can't be decoded by browsers — convert to MP3 or WAV first`;
  }
  if (isWebKit && OGG_FAMILY_RE.test(fileName)) {
    return `Safari can't decode OGG/Opus/WebM audio — try Chrome or Firefox, or convert to MP3/WAV`;
  }
  if (!isWebKit && APPLE_FAMILY_RE.test(fileName)) {
    return `This browser can't decode AIFF/CAF audio — try Safari, or convert to WAV/FLAC`;
  }
  return `"${fileName}" couldn't be decoded — unsupported or corrupt file`;
};

export const formatTime = (seconds) => {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
};

export const formatSize = (bytes) => {
  if (bytes < 1024) return bytes.toFixed(0) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
};
