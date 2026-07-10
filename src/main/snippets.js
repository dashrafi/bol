// Bol — snippets.js (A4). Deterministic spoken-snippet expansion.
// Pre-pass that runs BEFORE any AI cleanup: replaces "insert <trigger>" and
// "<trigger> daalo" with the snippet's text. Kept dumb and safe on purpose —
// exact trigger word match only, case-insensitive. Also required by cleanup.js
// so the same trigger list can be described in the AI prompt.
'use strict';

// Escape a string for literal use inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * expandSpoken(text, snippets) -> string
 * text: raw transcript (any string; non-strings returned as '').
 * snippets: [{ trigger, text }] — trigger is a single word (store.js enforces
 * that, but multi-word triggers are tolerated here by literal matching).
 *
 * Recognized spoken patterns (case-insensitive, whole-word):
 *   "insert <trigger>"   e.g. "insert address"
 *   "<trigger> daalo"    e.g. "address daalo"
 * Each occurrence is replaced inline with the snippet's exact text.
 */
function expandSpoken(text, snippets) {
  if (typeof text !== 'string') return '';
  if (!text || !Array.isArray(snippets) || snippets.length === 0) return text;

  let out = text;
  for (const s of snippets) {
    if (!s || typeof s.trigger !== 'string' || typeof s.text !== 'string') continue;
    const trig = s.trigger.trim();
    if (!trig) continue;

    const esc = escapeRegExp(trig);
    // Only apply \b where the trigger edge is a word character, otherwise
    // the boundary assertion would never match (e.g. trigger "@sig").
    const lead = /^[A-Za-z0-9_]/.test(trig) ? '\\b' : '';
    const tail = /[A-Za-z0-9_]$/.test(trig) ? '\\b' : '';

    let re;
    try {
      re = new RegExp(
        '(?:\\binsert\\s+' + lead + esc + tail + '|' + lead + esc + '\\s+daalo\\b)',
        'gi'
      );
    } catch (e) {
      continue; // malformed trigger — never crash the pipeline over a snippet
    }
    // Function replacement so "$" sequences in snippet text are inserted literally.
    out = out.replace(re, () => s.text);
  }
  return out;
}

module.exports = { expandSpoken };
