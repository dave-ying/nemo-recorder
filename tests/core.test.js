import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatTime, formatSize, unsupportedFormatError } from '../js/utils.js';
import { wavWorkerCode, mp3WorkerCode } from '../js/worker-code.js';

// ===== utils =====

test('formatTime formats mm:ss.mmm', () => {
  assert.equal(formatTime(0), '00:00.000');
  assert.equal(formatTime(61.5), '01:01.500');
  assert.equal(formatTime(125.042), '02:05.042');
});

test('formatTime clamps invalid input to zero', () => {
  assert.equal(formatTime(-5), '00:00.000');
  assert.equal(formatTime(Infinity), '00:00.000');
  assert.equal(formatTime(NaN), '00:00.000');
});

test('formatSize picks sensible units', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1048576), '5.00 MB');
});

test('unsupportedFormatError flags known-undecodable extensions', () => {
  assert.match(unsupportedFormatError('song.wma'), /^WMA files can't be decoded/i);
  assert.match(unsupportedFormatError('rec.amr'), /^AMR files can't be decoded/i);
  assert.match(unsupportedFormatError('podcast.mid'), /^MID files can't be decoded/i);
});

test('unsupportedFormatError ignores case', () => {
  assert.match(unsupportedFormatError('clip.WMA'), /^WMA files can't be decoded/i);
  assert.match(unsupportedFormatError('clip.Mid'), /^MID files can't be decoded/i);
});

test('unsupportedFormatError shows generic message for unknown extensions', () => {
  const msg = unsupportedFormatError('recording.mp3');
  assert.match(msg, /"recording\.mp3"/);
  assert.match(msg, /couldn't be decoded/i);
});

test('unsupportedFormatError: WebKit gets OGG-family hint', () => {
  assert.match(unsupportedFormatError('song.ogg', true), /^Safari can't decode OGG\/Opus\/WebM/);
  assert.match(unsupportedFormatError('clip.weba', true), /^Safari can't decode/);
  assert.match(unsupportedFormatError('movie.webm', true), /^Safari can't decode/);
});

test('unsupportedFormatError: non-WebKit gets AIFF-family hint', () => {
  assert.match(unsupportedFormatError('take.aiff', false), /^This browser can't decode AIFF\/CAF/);
  assert.match(unsupportedFormatError('take.caf'), /^This browser can't decode AIFF\/CAF/); // isWebKit defaults to false
});

test('unsupportedFormatError: native-family failure falls through to generic (corrupt file)', () => {
  assert.match(unsupportedFormatError('song.ogg', false), /couldn't be decoded/); // Chrome decodes OGG, so failure = corrupt
  assert.match(unsupportedFormatError('take.aiff', true), /couldn't be decoded/);  // Safari decodes AIFF, so failure = corrupt
});

test('unsupportedFormatError: known-undecodable message ignores the browser flag', () => {
  assert.match(unsupportedFormatError('x.wma', true), /^WMA files can't be decoded/);
  assert.match(unsupportedFormatError('x.wma', false), /^WMA files can't be decoded/);
});

// ===== WAV worker =====

// Runs the worker source string with a mocked `self`, returns the first posted message.
function runWavWorker(data) {
  const messages = [];
  const self = { postMessage: (m) => messages.push(m) };
  new Function('self', wavWorkerCode)(self);
  self.onmessage({ data });
  assert.equal(messages.length, 1);
  return messages[0];
}

function ascii(view, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

test('wav worker: valid 16-bit mono header and samples', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const msg = runWavWorker({ channels: [samples], sampleRate: 48000, bitDepth: 16 });
  assert.equal(msg.error, undefined);
  assert.equal(msg.blob.type, 'audio/wav');
  assert.equal(msg.blob.size, 44 + samples.length * 2);

  const v = new DataView(await msg.blob.arrayBuffer());
  assert.equal(ascii(v, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + samples.length * 2);
  assert.equal(ascii(v, 8, 4), 'WAVE');
  assert.equal(v.getUint16(20, true), 1); // PCM format tag
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint16(34, true), 16); // bits per sample
  assert.equal(ascii(v, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), samples.length * 2);

  assert.equal(v.getInt16(44, true), 0);       // 0
  assert.equal(v.getInt16(46, true), 16383);   // 0.5 * 0x7FFF, truncated
  assert.equal(v.getInt16(48, true), -16384);  // -0.5 * 0x8000
  assert.equal(v.getInt16(50, true), 32767);   // full scale
});

test('wav worker: 24-bit packs 3 little-endian bytes per sample', async () => {
  const samples = new Float32Array([0.5]);
  const msg = runWavWorker({ channels: [samples], sampleRate: 44100, bitDepth: 24 });
  assert.equal(msg.blob.size, 44 + 3);

  const v = new DataView(await msg.blob.arrayBuffer());
  assert.equal(v.getUint16(20, true), 1); // PCM tag (24-bit is integer PCM)
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(v.getUint32(40, true), 3);
  // round(0.5 * 0x7FFFFF) = 4194304 = 0x400000, little-endian
  assert.equal(v.getUint8(44), 0x00);
  assert.equal(v.getUint8(45), 0x00);
  assert.equal(v.getUint8(46), 0x40);
});

test('wav worker: 32-bit float uses format tag 3 and roundtrips', async () => {
  const samples = new Float32Array([0.25, -0.25]);
  const msg = runWavWorker({ channels: [samples], sampleRate: 96000, bitDepth: 32 });
  assert.equal(msg.blob.size, 44 + samples.length * 4);

  const v = new DataView(await msg.blob.arrayBuffer());
  assert.equal(v.getUint16(20, true), 3); // IEEE float tag
  assert.equal(v.getFloat32(44, true), 0.25);
  assert.equal(v.getFloat32(48, true), -0.25);
});

test('wav worker: samples are clamped to [-1, 1]', async () => {
  const msg = runWavWorker({ channels: [new Float32Array([1.5, -1.5])], sampleRate: 48000, bitDepth: 16 });
  const v = new DataView(await msg.blob.arrayBuffer());
  assert.equal(v.getInt16(44, true), 32767);
  assert.equal(v.getInt16(46, true), -32768);
});

test('wav worker: interleaves stereo channels', async () => {
  const left = new Float32Array([1, 0]);
  const right = new Float32Array([0, 1]);
  const msg = runWavWorker({ channels: [left, right], sampleRate: 48000, bitDepth: 16 });
  const v = new DataView(await msg.blob.arrayBuffer());
  assert.equal(v.getUint16(22, true), 2); // channel count
  assert.equal(v.getUint32(40, true), 2 * 2 * 2); // 2 samples * 2 ch * 2 bytes
  assert.deepEqual(
    [v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)],
    [32767, 0, 0, 32767] // L R L R
  );
});

test('wav worker: reports errors instead of throwing', () => {
  const msg = runWavWorker({ channels: [], sampleRate: 48000, bitDepth: 16 });
  assert.ok(msg.error);
});

// ===== MP3 worker (end-to-end with the vendored lamejs) =====

// Simulates the browser worker environment: importScripts loads the real
// vendored lamejs file, exactly as it will at runtime.
function runMp3Worker(data) {
  const lameSrc = readFileSync(new URL('../vendor/lame.min.js', import.meta.url), 'utf8');
  const messages = [];
  const sandbox = {
    self: { postMessage: (m) => messages.push(m) },
    importScripts: () => vm.runInContext(lameSrc, sandbox),
    Blob
  };
  vm.createContext(sandbox);
  vm.runInContext(mp3WorkerCode, sandbox);
  sandbox.self.onmessage({ data });
  assert.equal(messages.length, 1);
  return messages[0];
}

test('mp3 worker: encodes mono with vendored lamejs', () => {
  const silence = new Float32Array(48000); // 1s of silence
  const msg = runMp3Worker({ channels: [silence], sampleRate: 48000, bitrate: 128 });
  assert.equal(msg.error, undefined);
  assert.equal(msg.blob.type, 'audio/mp3');
  assert.ok(msg.blob.size > 0);
});

test('mp3 worker: encodes stereo with vendored lamejs', () => {
  const tone = new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5);
  const msg = runMp3Worker({ channels: [tone, tone], sampleRate: 48000, bitrate: 192 });
  assert.equal(msg.error, undefined);
  assert.ok(msg.blob.size > 0);
});
