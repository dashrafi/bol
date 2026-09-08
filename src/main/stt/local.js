// Bol — A3: local STT provider. Runs Whisper via @huggingface/transformers inside
// an Electron utilityProcess worker (./localWorker.js). The worker is forked lazily
// on first use and kept warm afterwards so subsequent dictations skip model load.
// Session interface is identical to the cloud providers:
//   createSession(cfg, dictionaryWords, { onPartial, onFinal, onError }) -> { feed, end, abort }
//   test(cfg) -> Promise<{ ok, error? }>
'use strict';

const path = require('path');

const INSTALL_MSG = 'Local model support not installed — run: npm i @huggingface/transformers';
const DEFAULT_MODEL = 'onnx-community/whisper-small';

// Dictionary words become a short Whisper decoder prompt ("Bol, Wispr Flow, …")
// so proper nouns are spelled the way the user wrote them instead of the nearest
// common word ("Bulk", "with spare flow"). Pure helper shared with the worker.
const { promptTextFromWords } = require('./localWorker');

let worker = null; // warm utilityProcess child
let nextId = 1;
const pending = new Map(); // id -> { onPartial, onFinal, onError }

// utilityProcess only exists in the Electron main process — guard the require.
function getUtilityProcess() {
  try {
    const electron = require('electron');
    if (electron && electron.utilityProcess && typeof electron.utilityProcess.fork === 'function') {
      return electron.utilityProcess;
    }
  } catch (e) { /* not running inside Electron main */ }
  return null;
}

// True when @huggingface/transformers is installed. ESM-only export maps make
// require.resolve throw even though the package is present — treat those codes
// as "installed"; only a genuine module-not-found means missing.
function packageResolvable() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch (e) {
    const code = e && e.code;
    return code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_REQUIRE_ESM';
  }
}

function failAllPending(err) {
  const entries = Array.from(pending.values());
  pending.clear();
  for (const p of entries) {
    try { p.onError(err); } catch (e) { /* listener error must not cascade */ }
  }
}

function ensureWorker() {
  if (worker) return worker;
  const utilityProcess = getUtilityProcess();
  if (!utilityProcess) throw new Error('Local STT is only available in the Electron main process');

  const env = Object.assign({}, process.env);
  if (!env.BOL_MODELS_DIR) {
    // Orchestrator normally sets this before any session; compute a fallback anyway.
    try {
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        env.BOL_MODELS_DIR = path.join(app.getPath('userData'), 'models');
      }
    } catch (e) { /* leave unset; transformers falls back to its default cache */ }
  }

  const child = utilityProcess.fork(path.join(__dirname, 'localWorker.js'), [], {
    serviceName: 'bol-local-stt',
    stdio: process.env.BOL_DEBUG ? 'inherit' : 'ignore',
    env,
  });

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || msg.id == null) return;
    const p = pending.get(msg.id);
    if (!p) return; // aborted or already settled
    if (msg.type === 'progress') {
      try { p.onPartial(String(msg.message || '')); } catch (e) {}
    } else if (msg.type === 'result') {
      pending.delete(msg.id);
      try { p.onFinal(typeof msg.text === 'string' ? msg.text : ''); } catch (e) {}
    } else if (msg.type === 'error') {
      pending.delete(msg.id);
      try { p.onError(new Error(msg.error ? String(msg.error) : 'Local transcription failed')); } catch (e) {}
    }
  });

  child.on('exit', () => {
    if (worker === child) worker = null; // next session re-forks
    failAllPending(new Error('Local STT worker stopped unexpectedly'));
  });

  worker = child;
  return child;
}

function createSession(cfg, dictionaryWords, handlers) {
  handlers = handlers || {};
  const onPartial = typeof handlers.onPartial === 'function' ? handlers.onPartial : function () {};
  const onFinal = typeof handlers.onFinal === 'function' ? handlers.onFinal : function () {};
  const onError = typeof handlers.onError === 'function' ? handlers.onError : function () {};

  const sttCfg = (cfg && cfg.stt) || {};
  const model = sttCfg.localModel || DEFAULT_MODEL;
  const language = (sttCfg.language && sttCfg.language !== 'auto') ? String(sttCfg.language) : null;
  const prompt = promptTextFromWords(dictionaryWords);

  const id = nextId++;
  const chunks = [];
  let ended = false;
  let aborted = false;
  let settled = false; // exactly one terminal callback (onFinal or onError)

  return {
    feed(buf) {
      if (ended || aborted || !buf) return;
      try {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (b.length) chunks.push(b);
      } catch (e) { /* malformed chunk — drop it */ }
    },

    end() {
      if (ended || aborted) return;
      ended = true;

      let pcm;
      try { pcm = Buffer.concat(chunks); } catch (e) { pcm = Buffer.alloc(0); }
      chunks.length = 0;

      // Under 20ms of 16 kHz / 16-bit audio — nothing meaningful to transcribe.
      if (pcm.length < 640) {
        settled = true;
        setImmediate(() => { if (!aborted) onFinal(''); });
        return;
      }

      // Cheap pre-check so we do not fork a worker that is doomed to fail.
      if (!packageResolvable()) {
        settled = true;
        setImmediate(() => { if (!aborted) onError(new Error(INSTALL_MSG)); });
        return;
      }

      let child;
      try {
        child = ensureWorker();
      } catch (e) {
        settled = true;
        setImmediate(() => { if (!aborted) onError(e); });
        return;
      }

      pending.set(id, {
        onPartial: (m) => { if (!aborted && !settled) onPartial(m); },
        onFinal: (t) => { if (aborted || settled) return; settled = true; onFinal(t); },
        onError: (e) => { if (aborted || settled) return; settled = true; onError(e); },
      });

      try {
        child.postMessage({ type: 'run', id, pcm, model, language, prompt });
      } catch (e) {
        pending.delete(id);
        settled = true;
        setImmediate(() => { if (!aborted) onError(e); });
      }
    },

    abort() {
      if (aborted) return;
      aborted = true;
      chunks.length = 0;
      if (pending.has(id)) {
        pending.delete(id);
        // Let the worker skip posting a result for this id; the model itself keeps
        // loading in the background so the next attempt starts warm.
        if (worker) {
          try { worker.postMessage({ type: 'abort', id }); } catch (e) {}
        }
      }
    },
  };
}

function test(cfg) { // cfg unused — local test is just "is the package installed"
  return Promise.resolve(packageResolvable() ? { ok: true } : { ok: false, error: INSTALL_MSG });
}

// Fork the worker and load the model ahead of the first dictation (at boot and on
// hotkey-down). On a fresh install this is what starts the one-time model
// download, so it happens in the background instead of inside a dictation.
function warm(cfg) {
  try {
    if (!packageResolvable()) return false;
    const child = ensureWorker();
    const sttCfg = (cfg && cfg.stt) || {};
    child.postMessage({ type: 'warm', model: sttCfg.localModel || DEFAULT_MODEL });
    return true;
  } catch (e) { return false; }
}

module.exports = { createSession, test, warm };
