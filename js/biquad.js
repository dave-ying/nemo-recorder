// Pure biquad IIR filter helpers (no DOM, no app state) — shared by eq.js and
// deesser.js. Coefficient formulas follow the RBJ Audio EQ Cookbook. Kept
// separate so both effect modules stay Node-testable without duplicating the
// math. (loudness-normalize.js keeps its own inlined copy to stay fully
// self-contained for the BS.1770 chain.)

/**
 * Compute normalized (a0-divided) biquad coefficients.
 *
 * @param {'lowshelf'|'highshelf'|'peaking'|'lowpass'|'highpass'|'bandpass'} type
 * @param {number} sampleRate
 * @param {number} frequency
 * @param {number} q
 * @param {number} [gainDb] - shelf/peaking gain (ignored by pass filters)
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function biquadCoefficients(type, sampleRate, frequency, q, gainDb = 0) {
  const w0 = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + beta);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - beta);
      a0 = (A + 1) + (A - 1) * cos + beta;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - beta;
      break;
    }
    case 'highshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + beta);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - beta);
      a0 = (A + 1) - (A - 1) * cos + beta;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - beta;
      break;
    }
    case 'peaking': {
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowpass': {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'bandpass': { // constant 0 dB peak gain
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    default:
      b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Run a biquad (Direct Form I) over a channel, returning a new Float32Array.
 *
 * @param {Float32Array} input
 * @param {{b0:number,b1:number,b2:number,a1:number,a2:number}} c
 * @returns {Float32Array}
 */
export function runBiquad(input, c) {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}
