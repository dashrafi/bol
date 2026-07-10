// Bol — AudioWorklet downsampler. Runs on the audio rendering thread.
// Accepts any context sample rate, mixes to mono, linear-interpolation
// resamples to 16000 Hz, and ships 1600-sample (100 ms) Int16 frames to the
// node via port.postMessage with a transferable ArrayBuffer.
'use strict';

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms @ 16 kHz -> 3200 bytes PCM16

class BolDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope (the context rate).
    this._ratio = sampleRate / TARGET_RATE;
    this._pos = 0;      // fractional read position relative to the current block start
    this._last = 0;     // final sample of the previous block, for cross-block interpolation
    this._frame = new Int16Array(FRAME_SAMPLES);
    this._fill = 0;
    this._sumSq = 0;
    this._mix = null;   // scratch buffer for multi-channel mixdown
    this._stopped = false;

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

    // Linear-interpolation resample. `pos` may start slightly negative (in
    // (-1, 0)) meaning "between the last sample of the previous block and the
    // first sample of this one".
    let pos = this._pos;
    const ratio = this._ratio;
    const lastIndex = len - 1;
    while (pos <= lastIndex) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 < 0 ? this._last : mono[i0];
      let out;
      if (frac === 0) {
        out = s0;
      } else {
        // frac > 0 implies i0 <= lastIndex - 1, so i0 + 1 is in bounds.
        const s1 = mono[i0 + 1];
        out = s0 + (s1 - s0) * frac;
      }
      this._emit(out);
      pos += ratio;
    }

    this._last = mono[lastIndex];
    this._pos = pos - len;
    return true;
  }
}

registerProcessor('bol-downsampler', BolDownsampler);
