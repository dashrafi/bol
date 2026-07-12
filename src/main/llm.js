// Bol — llm.js. One chat() over three provider shapes so cleanup/command work
// FREE and KEYLESS by default:
//   'ollama'    → local Ollama at 127.0.0.1:11434 (OpenAI-compatible, no key) — DEFAULT
//   'openai'    → any OpenAI-compatible endpoint: Groq (free tier), OpenAI,
//                 Gemini's OpenAI-compat URL, LM Studio, etc. (needs that key)
//   'anthropic' → Claude /v1/messages (optional; needs an Anthropic key)
// chat() throws on failure so callers can fall back to the offline cleaner.
'use strict';

const ANTHROPIC_VERSION = '2023-06-01';

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
    model: cc.ollamaModel || 'qwen2.5:3b',
    local: true,
    label: 'Ollama',
  };
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

// chat(cleanupCfg, systemPrompt, userText, {maxTokens, timeoutMs}) -> Promise<string>
async function chat(c, system, user, opts) {
  const ep = endpointFor(c);
  const maxTokens = (opts && opts.maxTokens) || 1024;
  const timeoutMs = (opts && opts.timeoutMs) || (ep.local ? 15000 : 8000);
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

    // OpenAI-compatible (Ollama / Groq / OpenAI / Gemini-compat / LM Studio).
    if (!ep.local && !ep.key) throw new Error('No API key set for the cloud AI provider');
    const headers = { 'content-type': 'application/json' };
    if (ep.key) headers['authorization'] = 'Bearer ' + ep.key;
    const resp = await fetch(ep.url, {
      method: 'POST', signal: controller.signal, headers,
      body: JSON.stringify({ model: ep.model, temperature: 0, max_tokens: maxTokens, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!resp.ok) throw new Error(await errText(resp, ep.label));
    const data = await resp.json();
    const msg = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message;
    return (msg && typeof msg.content === 'string') ? msg.content : '';
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(ep.label + ' timed out');
    // Ollama-not-running is the common local failure — give an actionable message.
    if (ep.local && /ECONNREFUSED|fetch failed|ENOTFOUND|network|Failed to fetch/i.test(String(e && e.message))) {
      const host = ep.url.replace('/v1/chat/completions', '');
      throw new Error('Ollama not reachable at ' + host + ' — start Ollama, or switch cleanup to Offline');
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
    await chat(c, 'Reply with exactly: ok', 'ping', { maxTokens: 5, timeoutMs: ep.local ? 15000 : 8000 });
    return { ok: true, provider: (c && c.provider) || 'ollama', model: ep.model };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'AI test failed' };
  }
}

module.exports = { chat, test, endpointFor };
