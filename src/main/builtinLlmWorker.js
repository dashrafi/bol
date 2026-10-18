// Bol — built-in AI cleanup worker. Runs inside an Electron utilityProcess forked
// by ./builtinLlm.js (or a plain Node child under test scripts). It downloads one
// small GGUF chat model once, then runs it with llama.cpp loaded IN-PROCESS via
// node-llama-cpp: no separate .exe for antivirus to quarantine (a bundled
// llama-server.exe was deleted by Avast mid-run), any Windows GPU through
// Vulkan, CPU otherwise. Its own process, so a 1-2 GB first-run download never
// blocks transcription.
//
// Protocol (postMessage):
//   in : { type:'warm', model, primes:[{ slot:'concise'|'clean', system }] }
//   in : { type:'chat', id, model, slot:'concise'|'clean', system, user, maxTokens }
//   in : { type:'abort', id }
//   in : { type:'status' }
//   out: { type:'status', state:'idle'|'downloading'|'loading'|'ready'|'error', pct?, device?, model?, error? }
//   out: { type:'result', id, text, device, ms }
//   out: { type:'error', id, code:'not-ready'|'failed', error }
// model = { id, label, repo, file, sha256, size }
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const HOSTS = process.env.BOL_HF_ENDPOINT
  ? [process.env.BOL_HF_ENDPOINT, 'https://huggingface.co', 'https://hf-mirror.com']
  : ['https://huggingface.co', 'https://hf-mirror.com'];
// Free the model's memory after this long without a dictation; reloading a
// downloaded model takes a couple of seconds and happens while the user speaks.
const IDLE_UNLOAD_MS = 30 * 60 * 1000;
const CONTEXT_SIZE = 6144;
const MAX_SNAPSHOTS = 4; // saved system-prompt states kept on disk (about 100 MB each)

const DEBUG = !!process.env.BOL_DEBUG;
function log() { if (DEBUG) { try { console.error.apply(console, ['[bol-llm]'].concat(Array.from(arguments))); } catch (e) {} } }

// Electron utilityProcess talks over process.parentPort; under plain Node
// (child_process.fork, used by test/eval scripts) it is process.send.
let post = function (msg) {
  try {
    if (process.parentPort) process.parentPort.postMessage(msg);
    else if (typeof process.send === 'function') process.send(msg);
  } catch (e) { /* parent gone */ }
};

let state = { state: 'idle' };
function setState(s) { state = Object.assign({}, s); post(Object.assign({ type: 'status' }, state)); }

function modelsDir() {
  return path.join(process.env.BOL_MODELS_DIR || path.join(process.env.APPDATA || '.', 'bol', 'models'), 'gguf');
}
function modelPath(m) { return path.join(modelsDir(), m.file); }

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i >= 20) throw e; await new Promise((r) => setTimeout(r, 250)); } // a scanner may hold the file briefly
  }
}

// Downloads the GGUF once, resuming a partial file, and verifies its SHA256.
let downloading = null;
function ensureDownloaded(m) {
  const final = modelPath(m);
  if (fs.existsSync(final) && fs.statSync(final).size === m.size) return Promise.resolve(final);
  if (downloading) return downloading;
  downloading = (async () => {
    fs.mkdirSync(modelsDir(), { recursive: true });
    const part = final + '.part';
    let lastErr = null;
    for (const host of HOSTS) {
      try {
        let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (have > m.size) { fs.rmSync(part, { force: true }); have = 0; }
        if (have < m.size) {
          const url = host.replace(/\/+$/, '') + '/' + m.repo + '/resolve/main/' + m.file;
          const headers = have ? { range: 'bytes=' + have + '-' } : {};
          const resp = await fetch(url, { headers, redirect: 'follow' });
          if (resp.status === 200 && have) { have = 0; } // server ignored the range: start over
          else if (!(resp.status === 200 || resp.status === 206)) throw new Error('HTTP ' + resp.status + ' from ' + host);
          let got = have;
          let lastPct = -1;
          const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
          const body = Readable.fromWeb(resp.body);
          body.on('data', (chunk) => {
            got += chunk.length;
            const pct = Math.floor((got / m.size) * 100);
            if (pct !== lastPct) { lastPct = pct; setState({ state: 'downloading', pct, model: m.id }); }
          });
          await pipeline(body, out);
        }
        if (fs.statSync(part).size !== m.size) throw new Error('download incomplete');
        setState({ state: 'loading', model: m.id });
        const digest = await sha256File(part);
        if (digest !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error('checksum mismatch, discarded'); }
        await renameWithRetry(part, final);
        return final;
      } catch (e) {
        lastErr = e;
        log('download via', host, 'failed:', e && e.message);
      }
    }
    throw lastErr || new Error('model download failed');
  })();
  downloading.then(() => { downloading = null; }, () => { downloading = null; });
  return downloading;
}

let nlc = null;      // node-llama-cpp module
let loaded = null;   // { key, llama, model, context, sequence, device }
let loading = null;  // { key, promise }
let idleTimer = null;
const aborters = new Map(); // chat id -> AbortController
let chain = Promise.resolve(); // one generation at a time

async function loadNlc() {
  if (!nlc) nlc = await import('node-llama-cpp');
  return nlc;
}

// GPU through Vulkan when it works (any NVIDIA / AMD / Intel GPU), else CPU.
async function openModel(file) {
  const { getLlama } = await loadNlc();
  const tries = process.env.BOL_LLM_DEVICE === 'cpu' ? [false] : ['auto', false];
  let lastErr = null;
  for (const gpu of tries) {
    let llama = null, model = null;
    try {
      llama = await getLlama({ gpu, logLevel: 'error', build: 'never' });
      model = await llama.loadModel({ modelPath: file });
      const context = await model.createContext({ contextSize: { min: 4096, max: CONTEXT_SIZE } });
      const device = llama.gpu && model.gpuLayers > 0 ? 'gpu' : 'cpu';
      return { llama, model, context, sequence: context.getSequence(), device };
    } catch (e) {
      lastErr = e;
      log('open with gpu=' + gpu + ' failed:', e && e.message);
      try { if (model) await model.dispose(); } catch (e2) {}
      try { if (llama) await llama.dispose(); } catch (e2) {}
    }
  }
  throw lastErr || new Error('could not load the built-in AI model');
}

function ensureLoaded(m) {
  const key = m.id;
  if (loaded && loaded.key === key) return Promise.resolve(loaded);
  if (loading && loading.key === key) return loading.promise;
  const promise = (async () => {
    if (loaded) { await unload(); }
    const cached = fs.existsSync(modelPath(m)) && fs.statSync(modelPath(m)).size === m.size;
    setState(cached ? { state: 'loading', model: m.id } : { state: 'downloading', pct: 0, model: m.id });
    const file = await ensureDownloaded(m);
    setState({ state: 'loading', model: m.id });
    const o = await openModel(file);
    loaded = Object.assign({ key }, o);
    setState({ state: 'ready', model: m.id, device: o.device });
    log('ready', m.id, 'on', o.device);
    return loaded;
  })();
  loading = { key, promise };
  promise.then(() => { if (loading && loading.key === key) loading = null; },
    (err) => { if (loading && loading.key === key) loading = null; setState({ state: 'error', model: m.id, error: String((err && err.message) || err) }); });
  return promise;
}

async function unload() {
  const l = loaded;
  loaded = null;
  for (const v of snapshots.values()) { try { fs.rmSync(v.file, { force: true }); } catch (e) {} }
  snapshots.clear();
  if (!l) return;
  try { await l.context.dispose(); } catch (e) {}
  try { await l.model.dispose(); } catch (e) {}
  try { await l.llama.dispose(); } catch (e) {}
}

function armIdleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (!loaded) return;
    log('idle: unloading model');
    await unload();
    setState({ state: 'idle' });
  }, IDLE_UNLOAD_MS);
}

async function handleChat(msg) {
  const id = msg.id;
  const m = msg.model;
  if (!(loaded && loaded.key === m.id)) {
    let failed = null;
    const p = ensureLoaded(m);
    p.catch((err) => { failed = err || new Error('load failed'); });
    // Wait for a downloaded model to load (seconds), but bail out the moment a
    // download is needed — a dictation must not sit behind a gigabyte.
    for (;;) {
      if (loaded && loaded.key === m.id) break;
      if (failed) { post({ type: 'error', id, code: 'failed', error: String(failed.message || failed) }); return; }
      if (state.state === 'downloading') {
        post({ type: 'error', id, code: 'not-ready', error: 'Built-in AI is downloading' + (state.pct != null ? ' (' + state.pct + '%)' : '') });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const t0 = Date.now();
  const ac = new AbortController();
  aborters.set(id, ac);
  let session = null;
  try {
    const { LlamaChatSession } = await loadNlc();
    const system = String(msg.system || '');
    // Start from the saved state of this exact system prompt, so the session only
    // has to read the user's words.
    await restoreSystemState(system);
    session = new LlamaChatSession({ contextSequence: loaded.sequence, systemPrompt: system, autoDisposeSequence: false });
    const text = await session.prompt(String(msg.user || ''), {
      maxTokens: Math.max(16, Math.min(2048, +msg.maxTokens || 512)),
      temperature: 0,
      budgets: { thoughtTokens: 0 }, // reasoning models answer directly
      signal: ac.signal,
      stopOnAbortSignal: true,
    });
    if (ac.signal.aborted) return; // the caller already gave up (timeout)
    post({ type: 'result', id, text: String(text || ''), device: loaded.device, ms: Date.now() - t0 });
  } catch (err) {
    if (!ac.signal.aborted) post({ type: 'error', id, code: 'failed', error: String((err && err.message) || err) });
  } finally {
    aborters.delete(id);
    try { if (session) session.dispose({ disposeSequence: false }); } catch (e) {}
    armIdleUnload();
  }
}

// ---------------------------------------------------------------------------
// System-prompt snapshots. The cleanup prompt is ~1,800 tokens and identical for
// every dictation of a given style. Hybrid models such as Qwen3.5 cannot rewind
// their state to a shared prefix, so without this every dictation re-read the
// whole prompt (18 s on a CPU, measured). Instead the system part is evaluated
// once, its state saved, and each dictation starts from a restore (tens of ms),
// so only the user's own words are processed. Works the same for plain models.
// ---------------------------------------------------------------------------
const snapshots = new Map(); // system prompt -> { file, tokens, used }
function stateDir() { return path.join(modelsDir(), 'state'); }
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); }

// The exact tokens the chat template produces for the system part: the common
// prefix of two renderings that differ only in the user message.
async function systemTokens(system) {
  const { resolveChatWrapper } = await loadNlc();
  if (!loaded.wrapper) loaded.wrapper = resolveChatWrapper(loaded.model);
  const render = (u) => loaded.wrapper.generateContextState({
    chatHistory: [{ type: 'system', text: system }, { type: 'user', text: u }, { type: 'model', response: [] }],
  }).contextText.tokenize(loaded.model.tokenizer);
  return commonPrefix(render('first message A'), render('second message B'));
}

async function ensureSnapshot(system) {
  const have = snapshots.get(system);
  if (have && fs.existsSync(have.file)) { have.used = Date.now(); return have; }
  const tokens = await systemTokens(system);
  fs.mkdirSync(stateDir(), { recursive: true });
  const name = crypto.createHash('sha1').update(loaded.key + '\n' + system).digest('hex').slice(0, 16) + '.bin';
  const file = path.join(stateDir(), name);
  await loaded.sequence.clearHistory();
  await loaded.sequence.evaluateWithoutGeneratingNewTokens(tokens);
  await loaded.sequence.saveStateToFile(file);
  const snap = { file, tokens: tokens.length, used: Date.now() };
  snapshots.set(system, snap);
  // Keep the disk bounded: drop the least recently used snapshots.
  while (snapshots.size > MAX_SNAPSHOTS) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of snapshots) if (v.used < oldest) { oldest = v.used; oldestKey = k; }
    const gone = snapshots.get(oldestKey);
    snapshots.delete(oldestKey);
    try { fs.rmSync(gone.file, { force: true }); } catch (e) {}
  }
  return snap;
}

async function restoreSystemState(system) {
  try {
    const snap = await ensureSnapshot(system);
    await loaded.sequence.loadStateFromFile(snap.file, { acceptRisk: true });
  } catch (e) {
    // A failed restore only costs speed: start clean and read the prompt in full.
    log('snapshot restore failed, reading the prompt in full:', e && e.message);
    try { await loaded.sequence.clearHistory(); } catch (e2) {}
  }
}

// Evaluate each slot's system prompt right after loading, in the background, so
// the first dictation only pays for its own words. Prompts that are already
// cached are skipped by llama.cpp's prefix reuse, so re-priming is cheap.
async function prime(primes) {
  for (const p of primes) {
    if (!loaded) return;
    const t0 = Date.now();
    try { await ensureSnapshot(String(p.system || '')); log('primed', p.slot, 'in', Date.now() - t0, 'ms'); }
    catch (e) { log('prime failed', p.slot, e && e.message); }
  }
}

function onMessage(e) {
  const msg = (e && e.data !== undefined && e.type === undefined) ? e.data : e;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'abort') { const a = aborters.get(msg.id); if (a) a.abort(); return; }
  if (msg.type === 'warm') {
    const primes = Array.isArray(msg.primes) ? msg.primes : [];
    ensureLoaded(msg.model).then(() => { chain = chain.then(() => prime(primes)); armIdleUnload(); }, () => {});
    return;
  }
  if (msg.type === 'status') { post(Object.assign({ type: 'status' }, state)); return; }
  if (msg.type === 'chat' && msg.id != null) chain = chain.then(() => handleChat(msg));
}

// Snapshot files only make sense for the model state that wrote them.
try { fs.rmSync(stateDir(), { recursive: true, force: true }); } catch (e) { /* nothing left over */ }
if (process.parentPort) process.parentPort.on('message', onMessage);
else if (typeof process.send === 'function') process.on('message', onMessage);

module.exports = { modelPath, sha256File };
