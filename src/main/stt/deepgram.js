// Bol — Deepgram streaming STT over the native WebSocket (no SDK).
// Auth uses the ['token', KEY] subprotocol pair (native WebSocket cannot set headers).
// Session contract: end() eventually fires exactly one terminal callback
// (onFinal with the accumulated transcript, or onError); abort() fires nothing.
'use strict';

const DG_WS_URL = 'wss://api.deepgram.com/v1/listen';
const DG_API_URL = 'https://api.deepgram.com/v1';
const CLOSE_TIMEOUT_MS = 3000; // safety: resolve with what we have if the socket won't close
const OPEN_TIMEOUT_MS = 10000; // safety: fail if the handshake never completes
const MAX_PENDING_BYTES = 15 * 1024 * 1024; // ~8 min of 16k/16-bit mono buffered pre-open

function buildUrl(cfg, dictionaryWords) {
  const stt = (cfg && cfg.stt) || {};
  const parts = [
    'model=' + encodeURIComponent(stt.deepgramModel || 'nova-2'),
    'encoding=linear16',
    'sample_rate=16000',
    'channels=1',
    'interim_results=true',
    'smart_format=true',
    'punctuate=true',
  ];
  const lang = String(stt.language || 'auto').trim();
  if (lang && lang.toLowerCase() !== 'auto') parts.push('language=' + encodeURIComponent(lang));
  else parts.push('detect_language=true');

  // Dictionary boosting: repeated keywords params, capped at 50, word URL-encoded.
  const words = Array.isArray(dictionaryWords) ? dictionaryWords : [];
  let added = 0;
  for (const w of words) {
    if (added >= 50) break;
    const word = String(w == null ? '' : w).trim();
    if (!word) continue;
    parts.push('keywords=' + encodeURIComponent(word) + ':2');
    added++;
  }
  return DG_WS_URL + '?' + parts.join('&');
}

function createSession(cfg, dictionaryWords, handlers) {
  const h = handlers || {};
  const onPartial = typeof h.onPartial === 'function' ? h.onPartial : () => {};
  const onFinal = typeof h.onFinal === 'function' ? h.onFinal : () => {};
  const onError = typeof h.onError === 'function' ? h.onError : () => {};

  const key = cfg && cfg.stt && cfg.stt.deepgramKey;
  if (!key) throw new Error('Deepgram API key is not set — add it in Settings');

  let ws;
  try {
    ws = new WebSocket(buildUrl(cfg, dictionaryWords), ['token', key]);
  } catch (e) {
    throw new Error('Could not open Deepgram connection: ' + (e && e.message ? e.message : String(e)));
  }
  try { ws.binaryType = 'arraybuffer'; } catch {}

  let opened = false;   // socket reached OPEN
  let ended = false;    // end() was called
  let done = false;     // terminal state reached (final/error/abort) — no more callbacks
  let lastError = null;
  let closeTimer = null;
  let openTimer = null;
  let pendingBytes = 0;
  const pending = [];   // audio buffered before the socket opens
  const finals = [];    // accumulated is_final transcript segments

  function accumulated() {
    return finals.join(' ').replace(/\s+/g, ' ').trim();
  }

  function detachSocket() {
    try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; } catch {}
    try {
      if (ws.readyState === 0 /* CONNECTING */ || ws.readyState === 1 /* OPEN */) ws.close();
    } catch {}
  }

  function clearTimers() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  }

  function finish(text) {
    if (done) return;
    done = true;
    clearTimers();
    detachSocket();
    try { onFinal(text); } catch {}
  }

  function fail(err) {
    if (done) return;
    done = true;
    clearTimers();
    detachSocket();
    try { onError(err instanceof Error ? err : new Error(String(err))); } catch {}
  }

  // If the handshake never completes (blackholed network), don't sit in
  // LISTENING forever. After end() the close-timer path resolves instead.
  openTimer = setTimeout(() => {
    openTimer = null;
    if (done || opened || ended) return;
    fail(lastError || new Error('Could not connect to Deepgram (timed out)'));
  }, OPEN_TIMEOUT_MS);

  function sendCloseStream() {
    try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
  }

  ws.onopen = () => {
    if (done) return;
    opened = true;
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    try {
      for (const chunk of pending) ws.send(chunk);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    pending.length = 0;
    pendingBytes = 0;
    if (ended) sendCloseStream();
  };

  ws.onmessage = (ev) => {
    if (done) return;
    let msg;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      msg = JSON.parse(raw);
    } catch { return; }
    if (!msg || msg.type !== 'Results' || !msg.channel) return;

    const alt = Array.isArray(msg.channel.alternatives) ? msg.channel.alternatives[0] : null;
    const transcript = alt && alt.transcript ? String(alt.transcript).trim() : '';

    if (msg.is_final) {
      if (transcript) finals.push(transcript);
      if (!ended) { try { onPartial(accumulated()); } catch {} }
    } else if (transcript && !ended) {
      const text = (accumulated() + ' ' + transcript).trim();
      try { onPartial(text); } catch {}
    }
  };

  ws.onerror = (ev) => {
    if (done) return;
    const msg = (ev && (ev.message || (ev.error && ev.error.message))) || 'Deepgram connection error';
    lastError = new Error(msg);
    // Mid-stream failure → surface immediately. After end(), let close/timeout
    // resolve with whatever transcript we already accumulated.
    if (!ended) fail(lastError);
  };

  ws.onclose = (ev) => {
    if (done) return;
    if (ended) {
      finish(accumulated());
    } else {
      const code = ev && ev.code ? ' (code ' + ev.code + ')' : '';
      fail(lastError || new Error('Deepgram connection closed unexpectedly' + code));
    }
  };

  return {
    feed(buf) {
      if (done || ended || !buf) return;
      const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (!chunk.length) return;
      if (opened && ws.readyState === 1) {
        try { ws.send(chunk); } catch (e) { lastError = e instanceof Error ? e : new Error(String(e)); }
      } else if (!opened && pendingBytes < MAX_PENDING_BYTES) {
        pending.push(chunk); // flushed on open
        pendingBytes += chunk.length;
      }
    },
    end() {
      if (done || ended) return;
      ended = true;
      if (opened && ws.readyState === 1) sendCloseStream();
      // else: onopen flushes buffered audio, then sends CloseStream.
      closeTimer = setTimeout(() => {
        const text = accumulated();
        if (!text && lastError) fail(lastError);
        else finish(text);
      }, CLOSE_TIMEOUT_MS);
    },
    abort() {
      if (done) return;
      done = true;
      clearTimers();
      pending.length = 0;
      pendingBytes = 0;
      detachSocket();
    },
  };
}

async function test(cfg) {
  const key = cfg && cfg.stt && cfg.stt.deepgramKey;
  if (!key) return { ok: false, error: 'Deepgram API key is not set' };
  try {
    const res = await fetch(DG_API_URL + '/projects', {
      method: 'GET',
      headers: { Authorization: 'Token ' + key },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid Deepgram API key (HTTP ' + res.status + ')' };
    return { ok: false, error: 'Deepgram returned HTTP ' + res.status };
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'request timed out' : (e && e.message ? e.message : String(e));
    return { ok: false, error: 'Could not reach Deepgram: ' + msg };
  }
}

module.exports = { createSession, test };
