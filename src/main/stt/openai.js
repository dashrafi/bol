// Bol — OpenAI-compatible batch STT. Accumulates PCM16 chunks, wraps them in a
// WAV via wav.js on end(), and POSTs multipart to {baseUrl}/audio/transcriptions.
// Works with api.openai.com, Groq, and any compatible endpoint. Emits nothing
// until the final transcript (batch provider — no interim results).
'use strict';

const wav = require('./wav');

function baseUrlOf(cfg) {
  const raw = (cfg && cfg.stt && cfg.stt.openaiBaseUrl) || 'https://api.openai.com/v1';
  return String(raw).trim().replace(/\/+$/, '');
}

async function readErrorDetail(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      const inner = j && j.error;
      detail = (inner && (inner.message || (typeof inner === 'string' ? inner : ''))) || (j && j.message) || '';
    } catch {
      detail = String(body || '').slice(0, 200);
    }
  } catch {}
  if (typeof detail !== 'string') detail = '';
  detail = detail.replace(/\s+/g, ' ').trim();
  return 'HTTP ' + res.status + (detail ? ' — ' + detail.slice(0, 160) : '');
}

function createSession(cfg, dictionaryWords, handlers) {
  const h = handlers || {};
  const onFinal = typeof h.onFinal === 'function' ? h.onFinal : () => {};
  const onError = typeof h.onError === 'function' ? h.onError : () => {};

  const stt = (cfg && cfg.stt) || {};
  const key = stt.openaiKey;
  if (!key) throw new Error('OpenAI-compatible API key is not set — add it in Settings');

  const chunks = [];
  const controller = new AbortController(); // lets abort() cancel an in-flight upload
  let ended = false;
  let done = false; // terminal (final/error/abort) — no more callbacks

  async function transcribe() {
    if (!chunks.length) return '';
    const wavBuf = wav.pcm16ToWav(chunks, 16000);
    chunks.length = 0;

    const form = new FormData();
    form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', stt.openaiModel || 'whisper-1');
    // Whisper-style endpoints expect ISO-639-1 ('en'), not a region tag ('en-US').
    const lang = String(stt.language || 'auto').trim().toLowerCase().split(/[-_]/)[0];
    if (lang && lang !== 'auto') form.append('language', lang);
    const words = (Array.isArray(dictionaryWords) ? dictionaryWords : [])
      .map((w) => String(w == null ? '' : w).trim())
      .filter(Boolean);
    if (words.length) form.append('prompt', words.slice(0, 100).join(', '));

    let res;
    try {
      res = await fetch(baseUrlOf(cfg) + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key },
        body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(14000)]),
      });
    } catch (e) {
      if (e && e.name === 'TimeoutError') throw new Error('Transcription request timed out');
      throw new Error('Transcription request failed: ' + (e && e.message ? e.message : String(e)));
    }
    if (!res.ok) throw new Error('Transcription failed: ' + (await readErrorDetail(res)));

    let data = null;
    try { data = await res.json(); } catch {}
    return data && typeof data.text === 'string' ? data.text.trim() : '';
  }

  return {
    feed(buf) {
      if (done || ended || !buf) return;
      const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (chunk.length) chunks.push(chunk);
    },
    end() {
      if (done || ended) return;
      ended = true;
      transcribe().then(
        (text) => { if (!done) { done = true; try { onFinal(text); } catch {} } },
        (err) => { if (!done) { done = true; try { onError(err instanceof Error ? err : new Error(String(err))); } catch {} } }
      );
    },
    abort() {
      done = true;
      chunks.length = 0;
      try { controller.abort(); } catch {}
    },
  };
}

async function test(cfg) {
  const stt = (cfg && cfg.stt) || {};
  if (!stt.openaiKey) return { ok: false, error: 'API key is not set' };
  const base = baseUrlOf(cfg);
  try {
    const res = await fetch(base + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + stt.openaiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key (HTTP ' + res.status + ')' };
    return { ok: false, error: 'Endpoint returned HTTP ' + res.status };
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'request timed out' : (e && e.message ? e.message : String(e));
    return { ok: false, error: 'Could not reach ' + base + ': ' + msg };
  }
}

module.exports = { createSession, test };
