// Bol — A3: local STT worker. Runs inside an Electron utilityProcess forked by
// ./local.js. Lazily imports @huggingface/transformers (dynamic import from CJS),
// points its cache at BOL_MODELS_DIR, keeps the ASR pipeline warm, and transcribes
// PCM16LE mono 16 kHz buffers.
//
// Protocol (postMessage):
//   in : { type:'run', id, pcm: Buffer|TypedArray|ArrayBuffer, model, language|null }
//   in : { type:'abort', id }
//   out: { type:'progress', id, message }     — 'Downloading model… X%' / 'Transcribing…'
//   out: { type:'result', id, text }          — exactly one terminal message per run
//   out: { type:'error', id, error }
'use strict';

const INSTALL_MSG = 'Local model support not installed — run: npm i @huggingface/transformers';

let transformersPromise = null; // promise of the imported module
let asrPromise = null;          // promise of the warm ASR pipeline
let asrModel = '';              // model id asrPromise was built for
let progressSink = null;        // active run's download-progress reporter
const abortedIds = new Set();
let runChain = Promise.resolve(); // serialize runs — one transcription at a time

function post(msg) {
  try {
    if (process.parentPort) process.parentPort.postMessage(msg);
  } catch (e) { /* parent gone — nothing useful to do */ }
}

function isModuleNotFound(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  return /Cannot find (module|package)/i.test(String(err.message || ''));
}

function loadTransformers() {
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers').then((m) => {
      const mod = (m && typeof m.pipeline === 'function')
        ? m
        : (m && m.default && typeof m.default.pipeline === 'function' ? m.default : m);
      try {
        if (mod && mod.env && process.env.BOL_MODELS_DIR) {
          mod.env.cacheDir = process.env.BOL_MODELS_DIR;
        }
      } catch (e) { /* cache dir stays default */ }
      return mod;
    });
    // Allow a retry on a later run and avoid unhandled-rejection noise.
    transformersPromise.catch(() => { transformersPromise = null; });
  }
  return transformersPromise;
}

// Aggregates per-file download progress into one 0–100 percentage; returns the
// rounded value only when it changed, else null.
function makeDownloadTracker() {
  const files = new Map();
  let lastPct = -1;
  return (p) => {
    if (!p || typeof p !== 'object' || !p.file) return null;
    if (p.status === 'progress') {
      files.set(p.file, { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
    } else if (p.status === 'done') {
      const f = files.get(p.file);
      if (f && f.total) f.loaded = f.total;
      else return null;
    } else {
      return null;
    }
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    if (!total) return null;
    const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
    if (pct === lastPct) return null;
    lastPct = pct;
    return pct;
  };
}

async function getAsr(model) {
  const tf = await loadTransformers();
  if (!tf || typeof tf.pipeline !== 'function') throw new Error(INSTALL_MSG);
  if (asrPromise && asrModel === model) return asrPromise;
  asrModel = model;
  const tracker = makeDownloadTracker();
  // progress_callback reads the module-level progressSink so a run that starts
  // while a download is already in flight still receives progress updates.
  asrPromise = tf.pipeline('automatic-speech-recognition', model, {
    progress_callback: (p) => {
      try {
        const pct = tracker(p);
        if (pct != null && typeof progressSink === 'function') progressSink(pct);
      } catch (e) { /* progress must never break the load */ }
    },
  });
  asrPromise.catch(() => {
    if (asrModel === model) { asrPromise = null; asrModel = ''; }
  });
  return asrPromise;
}

// PCM16LE (any Buffer/TypedArray/ArrayBuffer shape that survives structured clone)
// -> Float32Array in -1..1. DataView handles unaligned offsets safely.
function toFloat32(pcm) {
  if (!pcm) return new Float32Array(0);
  if (pcm instanceof Float32Array) return pcm;
  let u8 = null;
  if (ArrayBuffer.isView(pcm)) u8 = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  else if (pcm instanceof ArrayBuffer) u8 = new Uint8Array(pcm);
  else if (pcm && pcm.type === 'Buffer' && Array.isArray(pcm.data)) u8 = Uint8Array.from(pcm.data);
  if (!u8) return new Float32Array(0);
  const samples = Math.floor(u8.byteLength / 2);
  const out = new Float32Array(samples);
  const dv = new DataView(u8.buffer, u8.byteOffset, samples * 2);
  for (let i = 0; i < samples; i++) {
    out[i] = dv.getInt16(i * 2, true) / 32768;
  }
  return out;
}

function extractText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out.trim();
  if (typeof out.text === 'string') return out.text.trim();
  if (Array.isArray(out)) {
    return out
      .map((c) => (c && typeof c.text === 'string') ? c.text : '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

async function handleRun(msg) {
  const id = msg.id;
  try {
    const float32 = toFloat32(msg.pcm);
    if (!float32.length) {
      if (!abortedIds.has(id)) post({ type: 'result', id, text: '' });
      return;
    }

    progressSink = (pct) => {
      if (!abortedIds.has(id)) {
        post({ type: 'progress', id, message: 'Downloading model… ' + pct + '%' });
      }
    };
    const asr = await getAsr(String(msg.model || 'onnx-community/whisper-base'));
    progressSink = null;
    if (abortedIds.has(id)) return;

    post({ type: 'progress', id, message: 'Transcribing…' });
    const options = { chunk_length_s: 30 };
    if (msg.language) options.language = String(msg.language);
    let out;
    try {
      out = await asr(float32, options);
    } catch (err) {
      // English-only checkpoints (e.g. whisper-*.en) reject a language option —
      // retry once without it instead of failing the dictation.
      if (!options.language) throw err;
      out = await asr(float32, { chunk_length_s: 30 });
    }
    if (abortedIds.has(id)) return;

    post({ type: 'result', id, text: extractText(out) });
  } catch (err) {
    if (!abortedIds.has(id)) {
      post({
        type: 'error',
        id,
        error: isModuleNotFound(err)
          ? INSTALL_MSG
          : String((err && err.message) || err || 'Local transcription failed'),
      });
    }
  } finally {
    progressSink = null;
    abortedIds.delete(id);
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (e) => {
    const msg = (e && e.data !== undefined) ? e.data : e;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'abort') {
      abortedIds.add(msg.id);
      return;
    }
    if (msg.type === 'run' && msg.id != null) {
      // Serialize: handleRun never rejects, so the chain cannot break.
      runChain = runChain.then(() => handleRun(msg));
    }
  });
}
