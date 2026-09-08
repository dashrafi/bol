// Bol — A3: local STT worker. Runs inside an Electron utilityProcess forked by
// ./local.js. Lazily imports @huggingface/transformers (dynamic import from CJS),
// points its cache at BOL_MODELS_DIR, keeps the ASR pipeline warm, and transcribes
// PCM16LE mono 16 kHz buffers.
//
// Protocol (postMessage):
//   in : { type:'run', id, pcm: Buffer|TypedArray|ArrayBuffer, model, language|null, prompt|'' }
//   in : { type:'abort', id }
//   out: { type:'progress', id, message }     — 'Downloading model… X%' / 'Transcribing…'
//   out: { type:'result', id, text }          — exactly one terminal message per run
//   out: { type:'error', id, error }
//
// Diagnostic CLI (same code path, no Electron):
//   node src/main/stt/localWorker.js --file clip.wav [--model M] [--language en] [--prompt "Bol, Wispr Flow"]
'use strict';

const INSTALL_MSG = 'Local model support not installed — run: npm i @huggingface/transformers';

// Model host for first-run downloads. Defaults to the hf-mirror.com mirror because
// huggingface.co is intermittently blocked/reset on some networks (verified on the
// owner's connection). Override with BOL_HF_ENDPOINT=https://huggingface.co to use
// the primary host. Whichever host is primary, the other one is tried when a
// download fails, so one dead mirror never blocks the first dictation. Cached
// models never re-download regardless.
const HF_ENDPOINT = process.env.BOL_HF_ENDPOINT || 'https://hf-mirror.com';
const HF_FALLBACK = /hf-mirror\.com/i.test(HF_ENDPOINT) ? 'https://huggingface.co' : 'https://hf-mirror.com';

// Weight precision. 'q8' (8-bit) gives the same words as full precision on our
// benchmark (test/bench-stt.js) while cutting resident memory from ~3 GB to
// ~1.3 GB and the first download from 968 MB to 249 MB for whisper-small. If a
// checkpoint has no quantized files we fall back to full precision automatically.
const DEFAULT_DTYPE = process.env.BOL_WHISPER_DTYPE || 'q8';

// Whisper's decoder context is 448 tokens; a prompt longer than ~half of it
// starts crowding out the transcript, so the dictionary prompt is capped.
const PROMPT_MAX_WORDS = 40;
const PROMPT_MAX_CHARS = 300;
const PROMPT_MAX_TOKENS = 200;

let transformersPromise = null; // promise of the imported module
let asrPromise = null;          // promise of the warm ASR pipeline
let asrModel = '';              // model id asrPromise was built for
let progressSink = null;        // active run's download-progress reporter
let currentPrompt = null;       // { text, languageCode } for the run in flight
const abortedIds = new Set();
let runChain = Promise.resolve(); // serialize runs — one transcription at a time

const DEBUG = !!process.env.BOL_DEBUG;
function log() {
  if (!DEBUG) return;
  try { console.error.apply(console, ['[bol-stt]'].concat(Array.from(arguments))); } catch (e) {}
}

let post = function (msg) {
  try {
    if (process.parentPort) process.parentPort.postMessage(msg);
  } catch (e) { /* parent gone — nothing useful to do */ }
};

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
        if (mod && mod.env) {
          if (process.env.BOL_MODELS_DIR) mod.env.cacheDir = process.env.BOL_MODELS_DIR;
          // Point downloads at the reliable mirror (see HF_ENDPOINT note above).
          mod.env.remoteHost = HF_ENDPOINT;
        }
      } catch (e) { /* host/cache dir stay default */ }
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

// ---------------------------------------------------------------------------
// Dictionary prompt — pure helpers (unit-tested; no transformers.js needed)
// ---------------------------------------------------------------------------

// Turns dictionary words into the short comma-separated prompt Whisper biases on.
function promptTextFromWords(words) {
  if (!Array.isArray(words)) return '';
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const s = String(w == null ? '' : w).trim().replace(/\s+/g, ' ');
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= PROMPT_MAX_WORDS) break;
  }
  let text = out.join(', ');
  if (text.length > PROMPT_MAX_CHARS) text = text.slice(0, PROMPT_MAX_CHARS).replace(/,[^,]*$/, '');
  return text;
}

// Builds Whisper's decoder prefix: <|startofprev|> + prompt tokens + the normal
// start tokens (<|startoftranscript|> [<|lang|> <|transcribe|>] [<|notimestamps|>]).
// Mirrors `prompt_ids` in the Python library, which transformers.js lacks.
// Returns null when the generation config cannot support a prompt.
function buildDecoderPrefix(gc, promptIds, languageCode, returnTimestamps) {
  if (!gc || typeof gc.prev_sot_token_id !== 'number' || typeof gc.decoder_start_token_id !== 'number') return null;
  if (!Array.isArray(promptIds) || !promptIds.length) return null;
  const ids = [gc.prev_sot_token_id].concat(promptIds.slice(0, PROMPT_MAX_TOKENS));
  const prefixLength = ids.length;
  ids.push(gc.decoder_start_token_id);
  if (gc.is_multilingual) {
    const langToId = gc.lang_to_id || {};
    const wanted = '<|' + String(languageCode || 'en').toLowerCase() + '|>';
    const langId = typeof langToId[wanted] === 'number' ? langToId[wanted] : langToId['<|en|>'];
    if (typeof langId === 'number') ids.push(langId);
    const taskId = gc.task_to_id && gc.task_to_id.transcribe;
    if (typeof taskId === 'number') ids.push(taskId);
  }
  if (!returnTimestamps && typeof gc.no_timestamps_token_id === 'number') ids.push(gc.no_timestamps_token_id);
  return { decoder_input_ids: ids, prefixLength };
}

// The model returns the whole sequence including our prefix; everything before
// <|startoftranscript|> is the prompt and must not reach the transcript.
function stripPromptRow(row, sotId) {
  if (!Array.isArray(row)) return row;
  const i = row.indexOf(sotId);
  return i > 0 ? row.slice(i) : row;
}

// Wraps pipeline.model.generate once so every chunk of every run gets the
// current run's prompt, and the prompt tokens are stripped from the output.
function installPromptHook(tf, asr) {
  if (!asr || !asr.model || typeof asr.model.generate !== 'function' || asr.__bolPromptHook) return;
  const orig = asr.model.generate.bind(asr.model);
  asr.model.generate = async function (opts) {
    const p = currentPrompt;
    if (!p || !p.text) return orig(opts);
    let built = null;
    let gc = null;
    try {
      gc = asr.model.generation_config;
      const enc = asr.tokenizer(' ' + p.text, { add_special_tokens: false, return_tensor: false });
      const promptIds = (enc && enc.input_ids ? enc.input_ids : []).map(Number).filter((n) => Number.isFinite(n));
      const rt = !!((opts && opts.generation_config && opts.generation_config.return_timestamps) || (opts && opts.return_timestamps));
      built = buildDecoderPrefix(gc, promptIds, p.languageCode, rt);
    } catch (e) {
      log('prompt build failed, transcribing without it:', e && e.message);
      built = null;
    }
    if (!built) return orig(opts);
    const out = await orig(Object.assign({}, opts || {}, { decoder_input_ids: built.decoder_input_ids }));
    try {
      const rows = out && typeof out.tolist === 'function' ? out.tolist() : null;
      if (!rows || !rows.length || !tf || !tf.Tensor) return out;
      const row = rows[0].map(Number);
      const kept = stripPromptRow(row, gc.decoder_start_token_id);
      if (kept === row) return out;
      return new tf.Tensor('int64', BigInt64Array.from(kept.map((n) => BigInt(n))), [1, kept.length]);
    } catch (e) {
      log('prompt strip failed, returning raw output:', e && e.message);
      return out;
    }
  };
  asr.__bolPromptHook = true;
}

// ---------------------------------------------------------------------------
// Pipeline construction: dtype fallback + host fallback
// ---------------------------------------------------------------------------

function looksLikeDownloadFailure(err) {
  const m = String((err && err.message) || err || '');
  return /fetch|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|Could not locate|404|403|5\d\d|Unauthorized|Failed to load/i.test(m);
}

async function buildAsr(tf, model, progress_callback) {
  const attempts = [];
  const dtypes = DEFAULT_DTYPE && DEFAULT_DTYPE !== 'fp32' ? [DEFAULT_DTYPE, null] : [null];
  for (const dtype of dtypes) {
    attempts.push({ dtype, host: HF_ENDPOINT });
    if (HF_FALLBACK !== HF_ENDPOINT) attempts.push({ dtype, host: HF_FALLBACK });
  }
  let lastErr = null;
  for (const a of attempts) {
    try {
      if (tf.env) tf.env.remoteHost = a.host;
      const opts = { progress_callback };
      if (a.dtype) opts.dtype = a.dtype;
      const asr = await tf.pipeline('automatic-speech-recognition', model, opts);
      asr.__bolDtype = a.dtype || 'fp32';
      asr.__bolHost = a.host;
      installPromptHook(tf, asr);
      log('pipeline ready', model, 'dtype=' + asr.__bolDtype, 'host=' + a.host);
      return asr;
    } catch (err) {
      lastErr = err;
      if (isModuleNotFound(err)) throw err;
      log('pipeline attempt failed', model, 'dtype=' + (a.dtype || 'fp32'), 'host=' + a.host, '->', (err && err.message) || err);
      if (!looksLikeDownloadFailure(err) && a.dtype == null) throw err; // not a download problem: stop retrying
    }
  }
  throw lastErr || new Error('Could not load the local model');
}

async function getAsr(model) {
  const tf = await loadTransformers();
  if (!tf || typeof tf.pipeline !== 'function') throw new Error(INSTALL_MSG);
  if (asrPromise && asrModel === model) return asrPromise;
  asrModel = model;
  const tracker = makeDownloadTracker();
  // progress_callback reads the module-level progressSink so a run that starts
  // while a download is already in flight still receives progress updates.
  const progress_callback = (p) => {
    try {
      const pct = tracker(p);
      if (pct != null && typeof progressSink === 'function') progressSink(pct);
    } catch (e) { /* progress must never break the load */ }
  };
  asrPromise = buildAsr(tf, model, progress_callback);
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

// Config language values -> Whisper language codes. 'auto' and 'multi' have no
// Whisper equivalent in transformers.js (no detection yet); English is what the
// library would pick anyway, and it keeps Roman-Urdu dictation in Roman script.
function whisperLanguageCode(language) {
  const l = String(language || '').trim().toLowerCase();
  if (!l || l === 'auto' || l === 'multi') return null;
  return l;
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
    const asr = await getAsr(String(msg.model || 'onnx-community/whisper-small'));
    progressSink = null;
    if (abortedIds.has(id)) return;

    post({ type: 'progress', id, message: 'Transcribing…' });
    // Whisper only sees 30 s at a time. Long dictation is split into chunks, and
    // without OVERLAP (stride) the words sitting on a chunk boundary get cut in
    // half and mis-heard. stride_length_s makes neighbouring chunks share 5 s of
    // audio on each side so every word is transcribed with full context.
    const baseOptions = { chunk_length_s: 30, stride_length_s: 5 };
    const options = Object.assign({}, baseOptions);
    const languageCode = whisperLanguageCode(msg.language);
    if (languageCode) options.language = languageCode;
    const promptText = typeof msg.prompt === 'string' ? msg.prompt.trim() : '';
    currentPrompt = promptText ? { text: promptText, languageCode: languageCode || 'en' } : null;
    if (currentPrompt) log('prompt:', currentPrompt.text);
    let out;
    try {
      out = await asr(float32, options);
    } catch (err) {
      // English-only checkpoints (e.g. whisper-*.en) reject a language option —
      // retry once without it instead of failing the dictation.
      if (!options.language) throw err;
      out = await asr(float32, baseOptions);
    } finally {
      currentPrompt = null;
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
    currentPrompt = null;
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
    } else if (msg.type === 'warm') {
      // Load (or download) the model now so the first dictation does not wait for it.
      runChain = runChain.then(() => getAsr(String(msg.model || 'onnx-community/whisper-small')).then(
        () => log('warm: model ready'),
        (err) => log('warm failed (will retry on next dictation):', err && err.message)));
    }
  });
} else if (typeof require !== 'undefined' && require.main === module) {
  // Diagnostic CLI: exercises exactly the worker code path on a wav file.
  const fs = require('fs');
  const path = require('path');
  const argv = process.argv.slice(2);
  const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def; };
  const file = opt('file', '');
  if (!file) {
    console.error('usage: node src/main/stt/localWorker.js --file clip.wav [--model onnx-community/whisper-small] [--language en] [--prompt "Bol, Wispr Flow"]');
    process.exit(2);
  }
  if (!process.env.BOL_MODELS_DIR && process.env.APPDATA) process.env.BOL_MODELS_DIR = path.join(process.env.APPDATA, 'bol', 'models');
  const b = fs.readFileSync(file);
  // Minimal RIFF reader: PCM16 mono; 16 kHz expected (what the app feeds).
  let off = 12, data = null, rate = 16000, ch = 1;
  while (off + 8 <= b.length) {
    const cid = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (cid === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); }
    if (cid === 'data') { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!data) { console.error('not a PCM wav'); process.exit(2); }
  if (rate !== 16000 || ch !== 1) console.error(`warning: wav is ${rate} Hz / ${ch} ch; the worker expects 16 kHz mono`);
  const t0 = Date.now();
  post = (m) => {
    if (m.type === 'progress') console.error('[progress] ' + m.message);
    else console.log(JSON.stringify(Object.assign({ ms: Date.now() - t0, rssMB: Math.round(process.memoryUsage().rss / 1048576) }, m)));
  };
  handleRun({ type: 'run', id: 1, pcm: data, model: opt('model', 'onnx-community/whisper-small'), language: opt('language', null), prompt: opt('prompt', '') })
    .then(() => process.exit(0));
}

module.exports = { promptTextFromWords, buildDecoderPrefix, stripPromptRow, whisperLanguageCode, PROMPT_MAX_WORDS };
