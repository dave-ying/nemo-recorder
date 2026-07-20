const KNOWN_UNSUPPORTED_RE = /\.(wma|amr|awb|mid|midi|ape|ac3|dts|ra|aup)$/i;

export const unsupportedFormatError = (fileName) => {
  if (KNOWN_UNSUPPORTED_RE.test(fileName)) {
    const ext = fileName.match(KNOWN_UNSUPPORTED_RE)[1].toUpperCase();
    return `${ext} files can't be decoded by browsers — convert to MP3 or WAV first`;
  }
  return `"${fileName}" couldn't be decoded — unsupported or corrupt file`;
};

export const formatTime = (seconds) => {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds * 1000) % 1000);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
};

export const formatSize = (bytes) => {
  if (bytes < 1024) return bytes.toFixed(0) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
};
