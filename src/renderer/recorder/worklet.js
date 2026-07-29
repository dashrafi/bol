// Bol — AudioWorklet downsampler. Runs on the audio rendering thread.
// Accepts any context sample rate, mixes to mono, LOW-PASS FILTERS, then
// resamples to 16000 Hz and ships 1600-sample (100 ms) Int16 frames to the node
// via port.postMessage with a transferable ArrayBuffer.
//
// The low-pass stage is not optional: decimating 48 kHz -> 16 kHz without it
// folds everything above 8 kHz back into the speech band as aliasing noise,
// landing right on the 4-8 kHz consonant cues ("s", "sh", "t", "k", "f") that
// speech recognition needs — which showed up as wrong words ("scratch" heard as
// "Skype"). A 6th-order Butterworth (3 cascaded biquads) at 7.4 kHz fixes it for
// a few multiply-adds per sample.
'use strict';

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms @ 16 kHz -> 3200 bytes PCM16
const CUTOFF_HZ = 7400;     // just under the 8 kHz Nyquist of the target rate
// Butterworth cascade Q values for a 6th-order response.
const BUTTER_Q = [0.51763809, 0.70710678, 1.93185165];

// RBJ cookbook low-pass biquad, direct form I.
class Biquad {
  constructor(cutoff, rate, q) {
    const w0 = (2 * Math.PI * cutoff) / rate;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// Anti-aliased decimator: feed source-rate mono samples, get 16 kHz samples out.
class Resampler {
  constructor(sourceRate, onSample) {
    this.ratio = sourceRate / TARGET_RATE;
    this.onSample = onSample;
    this.pos = 0;   // fractional read position within the current block
    this.last = 0;  // last filtered sample of the previous block
    this.filters = (sourceRate > TARGET_RATE)
      ? BUTTER_Q.map((q) => new Biquad(CUTOFF_HZ, sourceRate, q))
      : null; // already at/below the target rate: nothing to alias
    this.buf = null;
  }

  // block: Float32Array of mono samples at the source rate
  push(block) {
    const len = block.length;
    if (!len) return;
    let filtered = block;
    if (this.filters) {
      if (!this.buf || this.buf.length !== len) this.buf = new Float32Array(len);
      filtered = this.buf;
      const f = this.filters;
      for (let i = 0; i < len; i++) {
        let s = block[i];
        for (let k = 0; k < f.length; k++) s = f[k].process(s);
        filtered[i] = s;
      }
    }

    // Linear interpolation on the band-limited signal. `pos` may start slightly
    // negative, meaning "between the previous block's last sample and this one's
    // first".
    let pos = this.pos;
    const ratio = this.ratio;
    const lastIndex = len - 1;
    while (pos <= lastIndex) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 < 0 ? this.last : filtered[i0];
      this.onSample(frac === 0 ? s0 : s0 + (filtered[i0 + 1] - s0) * frac);
      pos += ratio;
    }
    this.last = filtered[lastIndex];
    this.pos = pos - len;
  }
}

// The processor half only exists inside AudioWorkletGlobalScope; the DSP above is
// plain JS so the unit tests can require this file and verify it in Node.
if (typeof AudioWorkletProcessor !== 'undefined') {

class BolDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frame = new Int16Array(FRAME_SAMPLES);
    this._fill = 0;
    this._sumSq = 0;
    this._mix = null;   // scratch buffer for multi-channel mixdown
    this._stopped = false;
    // `sampleRate` is a global in AudioWorkletGlobalScope (the context rate).
    this._resampler = new Resampler(sampleRate, (s) => this._emit(s));

    this.port.onmessage = (e) => {
      const type = e.data && e.data.type;
      if (type === 'stop') {
        this._flush();
        this._stopped = true;
        this.port.postMessage({ type: 'stopped' });
      } else if (type === 'flush') {
        this._flush();
      }
    };
  }

  _emit(sample) {
    let s = sample;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    this._sumSq += s * s;
    this._frame[this._fill++] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
    if (this._fill === FRAME_SAMPLES) {
      const rms = Math.sqrt(this._sumSq / FRAME_SAMPLES);
      const buffer = this._frame.buffer;
      this.port.postMessage({ type: 'frame', buffer: buffer, rms: rms }, [buffer]);
      this._frame = new Int16Array(FRAME_SAMPLES);
      this._fill = 0;
      this._sumSq = 0;
    }
  }

  _flush() {
    if (this._fill > 0) {
      const rms = Math.sqrt(this._sumSq / this._fill);
      const part = this._frame.slice(0, this._fill); // fresh copy -> safe to transfer
      this.port.postMessage({ type: 'frame', buffer: part.buffer, rms: rms }, [part.buffer]);
      this._fill = 0;
      this._sumSq = 0;
    }
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;

    // Mix down to mono (the node is configured mono, but stay defensive).
    const channels = input.length;
    const len = input[0].length;
    let mono;
    if (channels === 1) {
      mono = input[0];
    } else {
      if (!this._mix || this._mix.length !== len) this._mix = new Float32Array(len);
      mono = this._mix;
      for (let i = 0; i < len; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += input[c][i];
        mono[i] = acc / channels;
      }
    }

    this._resampler.push(mono);
    return true;
  }
}

registerProcessor('bol-downsampler', BolDownsampler);

} // end AudioWorkletProcessor guard

// Exported for the unit tests (no-op inside AudioWorkletGlobalScope).
if (typeof module !== 'undefined' && module.exports) module.exports = { Resampler, Biquad, TARGET_RATE };
