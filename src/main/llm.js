// Bol — llm.js. One chat() over three provider shapes so cleanup/command work
// FREE and KEYLESS by default:
//   'ollama'    → local Ollama at 127.0.0.1:11434 (no key) — DEFAULT. Uses Ollama's
//                 native /api/chat so the model can be pre-warmed on hotkey-down and
//                 kept in memory between dictations (keep_alive). If Ollama is
//                 installed but not running, it is started automatically.
//   'openai'    → any OpenAI-compatible endpoint: Groq (free tier), OpenAI,
//                 Gemini's OpenAI-compat URL, LM Studio, etc. (needs that key)
//   'anthropic' → Claude /v1/messages (optional; needs an Anthropic key)
// chat() throws on failure so callers can fall back to the offline cleaner.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ANTHROPIC_VERSION = '2023-06-01';

// How long Ollama keeps the cleanup model in memory after a request. The default
// (5 min) means a coffee break costs the next dictation a full model reload.
const OLLAMA_KEEP_ALIVE = '30m';
// Prompt (~1.2k tokens) + dictionary + a long dictation must fit; Ollama's default
// context is too small for that on some models. Warm-up MUST use the same value,
// because a different num_ctx makes Ollama reload the model.
const OLLAMA_NUM_CTX = 4096;
const OLLAMA_START_WAIT_MS = 9000;   // how long to wait for a freshly started server
const OLLAMA_START_RETRY_MS = 60000; // do not re-spawn more often than this

// Resolve a cleanup-config subtree to a concrete endpoint. Local providers need
// no key; cloud ones do. `.local` marks a call that never leaves the machine.
function endpointFor(c) {
  const cc = c || {};
  const provider = cc.provider || 'ollama';
  if (provider === 'anthropic') {
    return {
      kind: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      key: String(cc.anthropicKey || '').trim(),
      model: cc.anthropicModel || 'claude-haiku-4-5-20251001',
      local: false,
      label: 'Anthropic',
    };
  }
  if (provider === 'openai') {
    const base = String(cc.openaiBaseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    return {
      kind: 'openai',
      url: base + '/chat/completions',
      key: String(cc.openaiKey || '').trim(),
      model: cc.openaiModel || 'llama-3.3-70b-versatile',
      local: false,
      label: 'Cloud AI',
    };
  }
  // ollama (default): strip any trailing slash or /v1 the user pasted, re-add /v1.
  const base = String(cc.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
  return {
    kind: 'openai',
    url: base + '/v1/chat/completions',
    key: '',
    model: cc.ollamaModel || 'auto',
    local: true,
    label: 'Ollama',
    base,
  };
}

// Hardcoding one Ollama model means every machine that doesn't happen to have it
// silently loses AI cleanup. 'auto' asks Ollama what IS installed and picks the
// best instruction-following chat model available.
const MODEL_PREFERENCE = [
  /^qwen2\.5[:-]?(7b|14b|32b)/i, /^qwen3/i, /^llama3\.[12][:-]?(8b|70b)/i,
  /^mistral/i, /^gemma2?[:-]?(9b|12b|27b)/i, /^qwen2\.5/i, /^llama3/i, /^phi/i, /^gemma/i,
];
let autoModelCache = { base: null, model: null, at: 0 };

// Pure selection step, exported so it can be unit-tested without a live Ollama.
function pickBestModel(names) {
  const usable = (names || []).filter(Boolean).filter((n) => !/embed|bge|nomic|minilm/i.test(n));
  if (!usable.length) return null;
  for (const rx of MODEL_PREFERENCE) {
    const hit = usable.find((n) => rx.test(n));
    if (hit) return hit;
  }
  return usable[0];
}

async function listOllamaModels(base, timeoutMs) {
  const resp = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(timeoutMs || 4000) });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data && Array.isArray(data.models) ? data.models : []).map((m) => m && m.name).filter(Boolean);
}

async function resolveOllamaModel(base) {
  const now = Date.now();
  if (autoModelCache.base === base && autoModelCache.model && (now - autoModelCache.at) < 300000) return autoModelCache.model;
  let names = [];
  try { names = await listOllamaModels(base, 4000); }
  catch (e) { /* Ollama not running — caller falls back to the offline cleaner */ }
  const chosen = pickBestModel(names);
  if (!chosen) throw new Error('No Ollama model installed — install one (ollama pull qwen2.5:7b) or set cleanup to Offline');
  autoModelCache = { base, model: chosen, at: now };
  return chosen;
}

// ---------------------------------------------------------------------------
// Ollama lifecycle: reachability, auto-start, warm-up
// ---------------------------------------------------------------------------

function isLoopback(base) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(base || ''));
}

// Where the Windows installer puts Ollama, then PATH. Pure lookup, no spawning.
function findOllamaExe() {
  const cands = [];
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (d) cands.push(path.join(d, 'ollama.exe'));
  }
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* unreadable path */ }
  }
  return null;
}

async function reachable(base, timeoutMs) {
  try {
    const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(timeoutMs || 1500) });
    return r.ok;
  } catch (e) { return false; }
}

let startPromise = null;
let lastStartAttempt = 0;
let lastStartResult = { exe: null, started: false };

// Ollama installed but not running is the normal state after a reboot (its tray
// app is optional and the owner's PC does not autostart it). Start the server
// ourselves, detached and hidden, so "Tidy up my words" just works. Only ever
// touches a loopback address. Resolves true when the server answers.
async function ensureOllama(base) {
  if (!isLoopback(base)) return reachable(base, 2000);
  if (await reachable(base, 1200)) return true;
  if (startPromise) return startPromise;
  const now = Date.now();
  if (now - lastStartAttempt < OLLAMA_START_RETRY_MS) return false;
  lastStartAttempt = now;
  const exe = findOllamaExe();
  lastStartResult = { exe, started: false };
  if (!exe) return false;
  startPromise = (async () => {
    try {
      const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => { /* reported through the readiness poll below */ });
      child.unref();
    } catch (e) { return false; }
    const deadline = Date.now() + OLLAMA_START_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await reachable(base, 1000)) { lastStartResult.started = true; return true; }
    }
    return false;
  })();
  try { return await startPromise; } finally { startPromise = null; }
}

// Plain-language reason the local AI is unavailable, for the HUD/history.
function ollamaUnavailableMessage(base) {
  if (lastStartResult.exe && !lastStartResult.started) return 'Ollama is installed but did not start';
  if (!lastStartResult.exe && lastStartAttempt) return 'Ollama is not installed (ollama.com) — using offline cleanup';
  return 'Ollama not reachable at ' + base + ' — start Ollama, or switch cleanup to Offline';
}

function ollamaBody(model, messages, maxTokens) {
  return JSON.stringify({
    model,
    stream: false,
    keep_alive: OLLAMA_KEEP_ALIVE,
    messages,
    options: { temperature: 0, num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX },
  });
}

let warmed = { base: null, model: null, at: 0 };

// Load the cleanup model into memory before it is needed (called on hotkey-down,
// so the load overlaps with the user speaking). Never throws; resolves to
// { ok, model? }. Throttled: at most once a minute per model.
async function warm(c) {
  const ep = endpointFor(c);
  if (!ep.local) return { ok: false, reason: 'not-local' };
  try {
    if (!(await ensureOllama(ep.base))) return { ok: false, reason: 'unreachable' };
    const model = (!ep.model || ep.model === 'auto') ? await resolveOllamaModel(ep.base) : ep.model;
    const now = Date.now();
    if (warmed.base === ep.base && warmed.model === model && (now - warmed.at) < 60000) return { ok: true, model, cached: true };
    warmed = { base: ep.base, model, at: now };
    // An empty messages array makes Ollama load the model and return immediately.
    const resp = await fetch(ep.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: ollamaBody(model, [], 1),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) { warmed.at = 0; return { ok: false, reason: 'HTTP ' + resp.status, model }; }
    try { await resp.text(); } catch (e) { /* body irrelevant */ }
    return { ok: true, model };
  } catch (e) {
    warmed.at = 0;
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

async function errText(resp, label) {
  let detail = 'HTTP ' + resp.status;
  try {
    const e = await resp.json();
    if (e && e.error && e.error.message) detail = e.error.message;
    else if (e && typeof e.error === 'string') detail = e.error;
    else if (e && e.message) detail = e.message;
  } catch (_) { /* non-JSON body */ }
  return label + ' error: ' + detail;
}

// Strip a reasoning model's hidden scratchpad so it never lands in a document.
function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

// chat(cleanupCfg, systemPrompt, userText, {maxTokens, timeoutMs}) -> Promise<string>
async function chat(c, system, user, opts) {
  const ep = endpointFor(c);
  const maxTokens = (opts && opts.maxTokens) || 1024;
  const timeoutMs = (opts && opts.timeoutMs) || (ep.local ? 15000 : 8000);

  if (ep.local) {
    if (!(await ensureOllama(ep.base))) throw new Error(ollamaUnavailableMessage(ep.base));
    if (!ep.model || ep.model === 'auto') ep.model = await resolveOllamaModel(ep.base);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (ep.kind === 'anthropic') {
      if (!ep.key) throw new Error('No Anthropic API key set');
      const resp = await fetch(ep.url, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': ep.key, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ model: ep.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!resp.ok) throw new Error(await errText(resp, 'Anthropic'));
      const data = await resp.json();
      const blocks = data && Array.isArray(data.content) ? data.content : [];
      return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    }

    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

    if (ep.local) {
      // Native Ollama API: keep_alive + num_ctx + num_predict. A non-Ollama server
      // answering on this URL (LM Studio etc.) returns 404 here → OpenAI path below.
      const resp = await fetch(ep.base + '/api/chat', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: ollamaBody(ep.model, messages, maxTokens),
      });
      if (resp.status !== 404) {
        if (!resp.ok) throw new Error(await errText(resp, ep.label));
        const data = await resp.json();
        const content = data && data.message && typeof data.message.content === 'string' ? data.message.content : '';
        return stripThink(content);
      }
    }

    // OpenAI-compatible (Groq / OpenAI / Gemini-compat / LM Studio / Ollama's /v1).
    if (!ep.local && !ep.key) throw new Error('No API key set for the cloud AI provider');
    const headers = { 'content-type': 'application/json' };
    if (ep.key) headers['authorization'] = 'Bearer ' + ep.key;
    const resp = await fetch(ep.url, {
      method: 'POST', signal: controller.signal, headers,
      body: JSON.stringify({ model: ep.model, temperature: 0, max_tokens: maxTokens, stream: false, messages }),
    });
    if (!resp.ok) throw new Error(await errText(resp, ep.label));
    const data = await resp.json();
    const msg = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message;
    return stripThink((msg && typeof msg.content === 'string') ? msg.content : '');
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(ep.label + ' timed out');
    // Ollama-not-running is the common local failure — give an actionable message.
    if (ep.local && /ECONNREFUSED|fetch failed|ENOTFOUND|network|Failed to fetch/i.test(String(e && e.message))) {
      throw new Error(ollamaUnavailableMessage(ep.base));
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Cheap reachability/auth check. Never throws.
async function test(c) {
  const ep = endpointFor(c);
  try {
    await chat(c, 'Reply with exactly: ok', 'ping', { maxTokens: 5, timeoutMs: ep.local ? 20000 : 8000 });
    // report the model actually used, not the literal 'auto'
    let model = ep.model;
    if (ep.local && (!model || model === 'auto')) { try { model = await resolveOllamaModel(ep.base); } catch (_) {} }
    return { ok: true, provider: (c && c.provider) || 'ollama', model };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'AI test failed' };
  }
}

module.exports = { chat, test, warm, endpointFor, pickBestModel, findOllamaExe, isLoopback, stripThink, ensureOllama };
