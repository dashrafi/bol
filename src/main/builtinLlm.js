// Bol — built-in AI cleanup (main-process side). Forks ./builtinLlmWorker.js in
// an Electron utilityProcess and exposes chat()/warm()/status(). Used when the
// PC has no Ollama, so a fresh install gets AI tidy-up with nothing else to
// install: the model downloads once in the background, like Whisper.
'use strict';

const path = require('path');

// The one GGUF model the built-in engine downloads. Chosen with test/bench-nlc.js
// + test/score-cleanup.js on Bol's own prompt over real dictations; see
// CONTRACTS.md "Built-in AI". Must be Apache-2.0/MIT so Bol can ship it freely.
// sha256/size are the Hugging Face LFS values: the download is verified, and a
// changed upstream file is refused rather than silently used.
// Why this one (2026-10-18, 35 cases = 27 of the owner's real dictations + 8
// adversarial): Qwen3.5-4B passed 7/7 adversarial checks (never answered a
// dictated question, never obeyed "write me a poem", kept 3:30 / rupees /
// email, applied "no wait" corrections) and left 3 of 35 filler phrases.
// Qwen2.5-1.5B answered a dictated question and wrote the poem; Qwen3.5-2B was
// safe but barely edited (9 of 17 rambles unchanged). Qwen2.5-3B is better than
// both but its licence forbids commercial use.
const MODEL = {
  id: 'qwen3.5-4b-q4_k_m',
  label: 'Qwen3.5 4B',
  repo: 'unsloth/Qwen3.5-4B-GGUF',
  file: 'Qwen3.5-4B-Q4_K_M.gguf',
  sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
  size: 2740937888,
  license: 'Apache-2.0',
};

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }
let status = { state: 'idle' };
const statusListeners = new Set();

function getUtilityProcess() {
  try {
    const electron = require('electron');
    if (electron && electron.utilityProcess && typeof electron.utilityProcess.fork === 'function') return electron.utilityProcess;
  } catch (e) { /* not inside Electron main */ }
  return null;
}

function setStatus(s) {
  status = s;
  for (const fn of statusListeners) { try { fn(Object.assign({}, status)); } catch (e) {} }
}

function failAll(err) {
  const all = Array.from(pending.values());
  pending.clear();
  for (const p of all) { clearTimeout(p.timer); try { p.reject(err); } catch (e) {} }
}

// Outside Electron (eval/bench scripts) the same worker runs under plain Node via
// child_process.fork — but only when asked, so unit tests never start a download.
function nodeForkAllowed() { return process.env.BOL_BUILTIN_IN_NODE === '1'; }

function ensureWorker() {
  if (worker) return worker;
  const up = getUtilityProcess();
  if (!up && !nodeForkAllowed()) throw new Error('Built-in AI is only available inside the app');
  const env = Object.assign({}, process.env);
  if (!env.BOL_MODELS_DIR) {
    try { env.BOL_MODELS_DIR = path.join(require('electron').app.getPath('userData'), 'models'); }
    catch (e) { env.BOL_MODELS_DIR = path.join(process.env.APPDATA || '', 'bol', 'models'); }
  }
  const file = path.join(__dirname, 'builtinLlmWorker.js');
  const child = up
    ? up.fork(file, [], { serviceName: 'bol-builtin-ai', stdio: process.env.BOL_DEBUG ? 'inherit' : 'ignore', env })
    : require('child_process').fork(file, [], { env, stdio: process.env.BOL_DEBUG ? 'inherit' : ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.post = (m) => (typeof child.postMessage === 'function' ? child.postMessage(m) : child.send(m));
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'status') { const s = Object.assign({}, msg); delete s.type; setStatus(s); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === 'result') p.resolve({ text: String(msg.text || ''), device: msg.device, ms: msg.ms });
    else {
      const err = new Error(msg.error || 'Built-in AI failed');
      err.code = msg.code === 'not-ready' ? 'BUILTIN_NOT_READY' : 'BUILTIN_FAILED';
      p.reject(err);
    }
  });
  child.on('exit', () => {
    if (worker === child) worker = null;
    setStatus({ state: 'idle' });
    failAll(new Error('Built-in AI stopped unexpectedly'));
  });
  worker = child;
  return child;
}

function modelMsg() { return { model: Object.assign({}, MODEL) }; }

// Load (first time: download) the model in the background. Never throws.
// primes = [{ slot: 'concise'|'clean', system }]: system prompts to evaluate as
// soon as the model is loaded, so the first dictation does not pay for them.
function warm(primes) {
  try { ensureWorker().post(Object.assign({ type: 'warm', primes: Array.isArray(primes) ? primes : [] }, modelMsg())); return true; }
  catch (e) { return false; }
}

// chat(system, user, { maxTokens, timeoutMs, slot }) -> Promise<{ text, device, ms }>
// Rejects fast (code BUILTIN_NOT_READY) while the model is still downloading.
function chat(system, user, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let child;
    try { child = ensureWorker(); } catch (e) { reject(e); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      try { child.post({ type: 'abort', id }); } catch (e) {}
      reject(new Error('Built-in AI timed out'));
    }, Math.max(5000, +o.timeoutMs || 60000));
    pending.set(id, { resolve, reject, timer });
    try {
      child.post(Object.assign({ type: 'chat', id, slot: o.slot === 'clean' ? 'clean' : 'concise', system: String(system || ''), user: String(user || ''), maxTokens: +o.maxTokens || 512 }, modelMsg()));
    } catch (e) {
      pending.delete(id); clearTimeout(timer); reject(e);
    }
  });
}

function getStatus() { return Object.assign({ model: MODEL.id, label: MODEL.label }, status); }
function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
function available() { return !!getUtilityProcess() || nodeForkAllowed(); }

module.exports = { chat, warm, getStatus, onStatus, available, MODEL };
