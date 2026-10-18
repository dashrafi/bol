// Bol — end-to-end test of the built-in AI engine exactly as the app runs it:
// src/main/builtinLlm.js forks src/main/builtinLlmWorker.js, which downloads the
// real GGUF (resumable, SHA256-checked), loads it with node-llama-cpp, and answers
// through the same chat path as a dictation. Then runs cleanup.polish() with
// Ollama unreachable, i.e. the situation on a friend's PC.
//
//   BOL_MODELS_DIR=<dir> node test/e2e-builtin.js <corpus.json> [--ids a,b] [--cpu]
'use strict';

process.env.BOL_BUILTIN_IN_NODE = '1';
process.env.BOL_NO_OLLAMA_AUTOSTART = '1';
if (process.argv.includes('--cpu')) process.env.BOL_LLM_DEVICE = 'cpu';

const fs = require('fs');
const builtin = require('../src/main/builtinLlm');
const cleanup = require('../src/main/cleanup');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

(async () => {
  const corpus = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ids = arg('ids', '') ? arg('ids', '').split(',') : null;
  const cases = ids ? corpus.filter((c) => ids.includes(c.id)) : corpus;
  console.log('models dir:', process.env.BOL_MODELS_DIR || '(default)', '| model:', builtin.MODEL.repo + '/' + builtin.MODEL.file);

  let last = '';
  builtin.onStatus((s) => {
    const line = s.state + (s.pct != null ? ' ' + s.pct + '%' : '') + (s.device ? ' on ' + s.device : '') + (s.error ? ' ERROR ' + s.error : '');
    if (line !== last && (s.state !== 'downloading' || s.pct % 10 === 0)) { console.log('[status] ' + line); last = line; }
  });
  const t0 = Date.now();
  const cfg = { cleanup: { mode: 'full', provider: 'ollama', ollamaUrl: 'http://127.0.0.1:9', ollamaModel: 'auto', style: 'concise', tone: 'auto', preserveMixedLanguage: true, appRules: [] } };
  const dictionary = ['Bol', 'Wispr Flow'].map((w) => ({ word: w }));
  // Same call the app makes at boot: loads the model and primes both prompts.
  console.log('warm:', JSON.stringify(await cleanup.warm(cfg, { dictionary, snippets: [] })));
  for (;;) {
    const s = builtin.getStatus();
    if (s.state === 'ready') break;
    if (s.state === 'error') { console.error('LOAD FAILED: ' + s.error); process.exit(1); }
    if (Date.now() - t0 > 90 * 60 * 1000) { console.error('gave up waiting'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('ready after ' + Math.round((Date.now() - t0) / 1000) + ' s on ' + builtin.getStatus().device);

  for (const k of cases) {
    const t = Date.now();
    const r = await cleanup.polish(k.raw, { cfg, app: k.app || '', title: '', dictionary, snippets: [] });
    console.log(`\n[${k.id}] ${Date.now() - t} ms usedAI=${r.usedAI} engine=${r.engine || '-'} style=${r.style || '-'} reason=${r.reason || '-'}`);
    console.log('IN : ' + k.raw.slice(0, 220));
    console.log('OUT: ' + String(r.text).slice(0, 260));
  }
  process.exit(0);
})().catch((e) => { console.error('e2e failed:', e && e.stack || e); process.exit(1); });
