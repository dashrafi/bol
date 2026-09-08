// Bol — store.js (A10). Owns history.json, dictionary.json, snippets.json.
// Write-through JSON persistence (tmp+rename), corrupt files recreated.
'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_CAP = 2000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let dir = null; // userData dir (null before init → in-memory only)
let historyEntries = [];   // newest-first: [{id, ts, raw, polished, app, title, durationMs, provider, words}]
let dictEntries = [];      // [{word, soundsLike?}]
let snippetEntries = [];   // [{trigger, text}]

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------
function fileFor(name) {
  return dir ? path.join(dir, name) : null;
}

function loadArray(name) {
  const file = fileFor(name);
  if (!file) return [];
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`[bol] store: ${name} corrupt, recreating:`, e.message);
    try { fs.renameSync(file, file + '.bak'); } catch (e2) { /* best effort */ }
    return [];
  }
}

function saveArray(name, arr) {
  const file = fileFor(name);
  if (!file) return;
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8'); } catch (e2) {
      console.error(`[bol] store: failed to persist ${name}:`, e2.message);
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e3) { /* ignore */ }
  }
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function init(paths) {
  try {
    dir = (paths && paths.userData) || null;
    if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ } }
    historyEntries = loadArray('history.json')
      .filter(e => e && typeof e === 'object')
      .slice(0, HISTORY_CAP);
    dictEntries = loadArray('dictionary.json')
      .filter(e => e && typeof e === 'object' && typeof e.word === 'string' && e.word.trim());
    snippetEntries = loadArray('snippets.json')
      .filter(e => e && typeof e === 'object' && typeof e.trigger === 'string' && e.trigger.trim() && typeof e.text === 'string');
  } catch (e) {
    console.error('[bol] store: init failed, running in-memory:', e.message);
    historyEntries = []; dictEntries = []; snippetEntries = [];
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------
const history = {
  add(entry) {
    try {
      const e = entry || {};
      const ts = Date.now();
      const rec = {
        id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
        ts,
        raw: String(e.raw || ''),
        polished: String(e.polished || ''),
        app: String(e.app || ''),
        title: String(e.title || ''),
        durationMs: toInt(e.durationMs, 0),
        provider: String(e.provider || ''),
        cleanup: String(e.cleanup || ''), // 'ai' | 'offline' | 'mixed-language' | 'ollama-down' | 'timeout' | ...
        inserted: e.inserted !== false,   // false = it went to the clipboard instead of the app
        words: wordCount(e.polished),
      };
      historyEntries.unshift(rec);
      if (historyEntries.length > HISTORY_CAP) historyEntries = historyEntries.slice(0, HISTORY_CAP);
      saveArray('history.json', historyEntries);
      return Object.assign({}, rec);
    } catch (err) {
      console.error('[bol] store: history.add failed:', err.message);
      return null;
    }
  },

  list(opts) {
    try {
      const o = opts || {};
      const query = String(o.query || '').toLowerCase();
      const limit = toInt(o.limit, 100);
      const offset = toInt(o.offset, 0);
      let rows = historyEntries; // already newest-first
      if (query) {
        rows = rows.filter(e =>
          (`${e.raw || ''} ${e.polished || ''} ${e.app || ''}`).toLowerCase().includes(query));
      }
      return rows.slice(offset, offset + limit).map(e => Object.assign({}, e));
    } catch (err) {
      console.error('[bol] store: history.list failed:', err.message);
      return [];
    }
  },

  delete(id) {
    try {
      const before = historyEntries.length;
      const target = String(id);
      historyEntries = historyEntries.filter(e => String(e.id) !== target);
      if (historyEntries.length !== before) saveArray('history.json', historyEntries);
      return { ok: historyEntries.length !== before };
    } catch (err) {
      console.error('[bol] store: history.delete failed:', err.message);
      return { ok: false };
    }
  },

  clear() {
    try {
      historyEntries = [];
      saveArray('history.json', historyEntries);
      return { ok: true };
    } catch (err) {
      console.error('[bol] store: history.clear failed:', err.message);
      return { ok: false };
    }
  },
};

// ---------------------------------------------------------------------------
// dictionary
// ---------------------------------------------------------------------------

// Common words that may show up capitalized mid-sentence in transcripts but
// are never dictionary material.
const SUGGEST_STOP = new Set([
  'i', 'im', 'ive', 'ill', 'id', 'a', 'an', 'the', 'and', 'or', 'but', 'so',
  'ok', 'okay', 'yes', 'no', 'not', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'it',
  'its', 'this', 'that', 'these', 'those', 'we', 'you', 'he', 'she', 'they',
  'my', 'me', 'our', 'your', 'his', 'her', 'their', 'us', 'them', 'will',
  'would', 'can', 'could', 'should', 'have', 'has', 'had', 'do', 'does',
  'did', 'just', 'like', 'also', 'then', 'than', 'there', 'here', 'what',
  'when', 'where', 'who', 'why', 'how', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'today', 'tomorrow', 'yesterday',
]);

const dictionary = {
  list() {
    return dictEntries.map(e => Object.assign({}, e));
  },

  add(word, opts) {
    try {
      const w = String(word || '').trim();
      if (!w) return dictionary.list();
      const soundsLike = opts && typeof opts.soundsLike === 'string' && opts.soundsLike.trim()
        ? opts.soundsLike.trim() : undefined;
      const lower = w.toLowerCase();
      const existing = dictEntries.find(e => e.word.toLowerCase() === lower);
      if (existing) {
        // Dedupe: refresh the entry rather than adding a sibling.
        existing.word = w;
        if (soundsLike) existing.soundsLike = soundsLike;
      } else {
        const rec = { word: w };
        if (soundsLike) rec.soundsLike = soundsLike;
        dictEntries.push(rec);
      }
      saveArray('dictionary.json', dictEntries);
      return dictionary.list();
    } catch (err) {
      console.error('[bol] store: dictionary.add failed:', err.message);
      return dictionary.list();
    }
  },

  remove(word) {
    try {
      const lower = String(word || '').trim().toLowerCase();
      const before = dictEntries.length;
      dictEntries = dictEntries.filter(e => e.word.toLowerCase() !== lower);
      if (dictEntries.length !== before) saveArray('dictionary.json', dictEntries);
      return dictionary.list();
    } catch (err) {
      console.error('[bol] store: dictionary.remove failed:', err.message);
      return dictionary.list();
    }
  },

  // Heuristic: scan raw transcripts for words appearing >= 3 times that look
  // like proper nouns or jargon (capitalized mid-sentence, acronyms,
  // camelCase, letter+digit mixes). Excludes existing entries. Max 10.
  suggestFromHistory(historyList) {
    try {
      const existing = new Set(dictEntries.map(e => e.word.toLowerCase()));
      const counts = new Map(); // lower -> { count, display, qualifies }

      for (const h of Array.isArray(historyList) ? historyList : []) {
        const raw = String((h && h.raw) || '');
        if (!raw) continue;
        const tokens = raw.split(/\s+/);
        let sentenceStart = true;
        for (const tok of tokens) {
          const stripped = tok.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
          const endsSentence = /[.!?]["')\]]*$/.test(tok);
          if (!stripped) { if (endsSentence) sentenceStart = true; continue; }
          const lower = stripped.toLowerCase();

          const isCapMid = !sentenceStart && /^[A-Z][a-z]+$/.test(stripped) && stripped.length >= 3;
          const isAcronym = /^[A-Z]{2,8}$/.test(stripped);
          const isCamel = /^[a-z]+[A-Z][A-Za-z]*$/.test(stripped) || /^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(stripped);
          const hasDigitMix = /[A-Za-z]/.test(stripped) && /\d/.test(stripped) && stripped.length >= 2;
          const qualifies = (isCapMid || isAcronym || isCamel || hasDigitMix) && !SUGGEST_STOP.has(lower);

          let rec = counts.get(lower);
          if (!rec) { rec = { count: 0, display: stripped, qualifies: false }; counts.set(lower, rec); }
          rec.count++;
          if (qualifies) {
            rec.qualifies = true;
            rec.display = stripped; // prefer the qualifying (cased) spelling
          }
          sentenceStart = endsSentence;
        }
      }

      const out = [];
      for (const rec of counts.values()) {
        if (!rec.qualifies || rec.count < 3) continue;
        if (existing.has(rec.display.toLowerCase())) continue;
        out.push(rec);
      }
      out.sort((a, b) => b.count - a.count);
      return out.slice(0, 10).map(r => r.display);
    } catch (err) {
      console.error('[bol] store: dictionary.suggestFromHistory failed:', err.message);
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// snippets
// ---------------------------------------------------------------------------
const snippets = {
  list() {
    return snippetEntries.map(e => Object.assign({}, e));
  },

  add(trigger, text) {
    try {
      // Trigger is a single word — take the first word, lowercased.
      const trig = String(trigger || '').trim().split(/\s+/)[0].toLowerCase()
        .replace(/[^a-z0-9؀-ۿ_-]/g, '');
      const body = String(text || '');
      if (!trig || !body) return snippets.list();
      const existing = snippetEntries.find(e => e.trigger === trig);
      if (existing) existing.text = body;
      else snippetEntries.push({ trigger: trig, text: body });
      saveArray('snippets.json', snippetEntries);
      return snippets.list();
    } catch (err) {
      console.error('[bol] store: snippets.add failed:', err.message);
      return snippets.list();
    }
  },

  remove(trigger) {
    try {
      const trig = String(trigger || '').trim().toLowerCase();
      const before = snippetEntries.length;
      snippetEntries = snippetEntries.filter(e => e.trigger !== trig);
      if (snippetEntries.length !== before) saveArray('snippets.json', snippetEntries);
      return snippets.list();
    } catch (err) {
      console.error('[bol] store: snippets.remove failed:', err.message);
      return snippets.list();
    }
  },
};

module.exports = { init, history, dictionary, snippets };
