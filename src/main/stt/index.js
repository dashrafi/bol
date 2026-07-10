// Bol — STT router. Picks the provider module from cfg.stt.provider and
// normalizes session handlers. './local' is required lazily inside its case so
// the app runs fine when the optional local-STT dependency is absent.
'use strict';

const NOOP = () => {};

function normalizeHandlers(handlers) {
  const h = handlers || {};
  return {
    onPartial: typeof h.onPartial === 'function' ? h.onPartial : NOOP,
    onFinal: typeof h.onFinal === 'function' ? h.onFinal : NOOP,
    onError: typeof h.onError === 'function' ? h.onError : NOOP,
  };
}

function providerOf(cfg) {
  return (cfg && cfg.stt && cfg.stt.provider) || 'deepgram';
}

function moduleFor(provider) {
  switch (provider) {
    case 'deepgram':
      return require('./deepgram');
    case 'openai':
      return require('./openai');
    case 'local': {
      // Lazy on purpose: keeps the app working when local STT support is missing.
      try {
        return require('./local');
      } catch (e) {
        throw new Error('Local STT is unavailable: ' + (e && e.message ? e.message : String(e)));
      }
    }
    default:
      throw new Error('Unknown STT provider: ' + provider);
  }
}

/**
 * Create a streaming/batch transcription session for the configured provider.
 * Returned session: { feed(buf), end(), abort() }.
 * end() eventually fires exactly one onFinal(text) (possibly ''); abort() fires nothing.
 */
function createSession(cfg, dictionaryWords, handlers) {
  const provider = providerOf(cfg);
  const mod = moduleFor(provider);
  const words = Array.isArray(dictionaryWords) ? dictionaryWords : [];
  return mod.createSession(cfg, words, normalizeHandlers(handlers));
}

/**
 * Cheap auth/availability check for the configured provider.
 * Always resolves { ok, error? } — never rejects, never throws.
 */
async function test(cfg) {
  try {
    const mod = moduleFor(providerOf(cfg));
    const res = await mod.test(cfg);
    if (res && typeof res.ok === 'boolean') return res;
    return { ok: false, error: 'Provider test returned no result' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { createSession, test };
