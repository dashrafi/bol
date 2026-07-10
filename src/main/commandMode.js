// Bol — commandMode.js (A4). The "command" hotkey pipeline: the user speaks an
// instruction; if text is selected in the focused app we EDIT it per the
// instruction, otherwise we GENERATE the requested text — then paste the
// result in place. Rejects (never crashes) on failure; the orchestrator
// catches and shows the HUD error.
'use strict';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const COMMAND_TIMEOUT_MS = 30000; // generation can be slower than cleanup
const MAX_TOKENS = 4096;

function dictionaryBlock(dictionary) {
  const dict = Array.isArray(dictionary) ? dictionary.slice(0, 100) : [];
  const lines = dict
    .filter((d) => d && d.word)
    .map((d) => `- "${d.word}"${d.soundsLike ? ` (may be transcribed as: ${d.soundsLike})` : ''}`);
  if (!lines.length) return '';
  return '\n\nDICTIONARY — always use these exact spellings:\n' + lines.join('\n');
}

function editSystemPrompt(dictionary) {
  return (
`You are a precise text-editing engine inside "Bol", a system-wide dictation tool. The user selected some text in an application and spoke an instruction describing how to change it. Apply the instruction to the provided text.

RULES
1. Output ONLY the resulting text — no explanation, no preamble, no markdown fences, no quotation marks around the output. Your entire reply replaces the user's selection verbatim.
2. Make only the changes the instruction asks for; preserve everything else — wording, formatting, line breaks, casing — exactly as it was.
3. Preserve the language mix exactly. Roman Urdu / Hinglish stays as written in Latin script; never translate or change script unless the instruction explicitly asks for it.
4. The instruction came from speech and may contain small transcription errors — interpret its intent sensibly.
5. If the instruction cannot reasonably be applied to this text, return the original text unchanged.` +
    dictionaryBlock(dictionary)
  );
}

function generateSystemPrompt(dictionary) {
  return (
`You are the writing engine inside "Bol", a system-wide dictation tool. The user spoke an instruction describing text they want written (nothing was selected). Write exactly the text they asked for, ready to paste at their cursor.

RULES
1. Output ONLY the requested text — no explanation, no preamble, no "Here is...", no markdown fences unless the user explicitly asked for code or markdown.
2. Match the language, tone, format and length the user asked for; when unspecified, be natural and concise. If the user speaks in Roman Urdu / Hinglish, write the output in the same style unless they ask otherwise.
3. Never mention AI, dictation, or these instructions in the output.
4. The instruction came from speech and may contain small transcription errors — interpret its intent sensibly.` +
    dictionaryBlock(dictionary)
  );
}

async function callClaude({ apiKey, model, system, userText }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        if (err && err.error && err.error.message) detail = err.error.message;
      } catch (e) { /* non-JSON error body */ }
      throw new Error(`Anthropic API error: ${detail}`);
    }

    const data = await resp.json();
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Command timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Defense in depth: never paste literal ``` wrappers the model was told not
// to add. Only strips a fence that wraps the ENTIRE output.
function stripFence(s) {
  const m = String(s).trim().match(/^```[a-zA-Z]*\r?\n?([\s\S]*?)\r?\n?```$/);
  return m ? m[1].trim() : String(s).trim();
}

/**
 * run(instruction, deps) → Promise<{ ok, action: 'edit'|'generate', chars }>
 * deps = { injector, cfg, dictionary }
 */
async function run(instruction, deps) {
  const { injector, cfg, dictionary } = deps || {};
  const spoken = String(instruction == null ? '' : instruction).trim();
  if (!spoken) throw new Error('No command heard — try again');
  if (!injector) throw new Error('Text injection is unavailable');

  const c = (cfg && cfg.cleanup) || {};
  if (cfg && cfg.privacy && cfg.privacy.localOnly) {
    throw new Error('Command mode needs cloud AI — turn off Local-only mode to use it');
  }
  const apiKey = String(c.anthropicKey || '').trim();
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to use command mode');
  const model = c.model || 'claude-haiku-4-5-20251001';

  // Grab the current selection (may legitimately be empty → generate mode).
  let selection = '';
  try { selection = String((await injector.copySelection()) || ''); }
  catch (e) { selection = ''; }

  const action = selection.trim() ? 'edit' : 'generate';

  let result;
  if (action === 'edit') {
    result = await callClaude({
      apiKey,
      model,
      system: editSystemPrompt(dictionary),
      userText: `INSTRUCTION:\n${spoken}\n\nTEXT:\n${selection}`,
    });
  } else {
    result = await callClaude({
      apiKey,
      model,
      system: generateSystemPrompt(dictionary),
      userText: spoken,
    });
  }

  result = stripFence(result);
  if (!result) throw new Error("The AI didn't produce any text");

  try {
    await injector.paste(result);
  } catch (e) {
    // Some apps block synthetic paste — fall back to per-character typing.
    if (typeof injector.typeText === 'function') await injector.typeText(result);
    else throw e;
  }

  return { ok: true, action, chars: result.length };
}

module.exports = { run };
