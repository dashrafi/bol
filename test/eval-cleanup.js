// Bol — cleanup eval. Runs a corpus of transcripts through the REAL polish()
// against the live local model and writes every output to JSON for review.
//
//   node test/eval-cleanup.js <corpus.json> <out.json> [--style concise|clean]
//                             [--model qwen2.5:7b] [--dict "Bol,Wispr Flow"]
//
// corpus.json = [{ id, kind, app, raw }]. Uses the Ollama URL/model from the
// user's own config (%APPDATA%/bol/config.json) unless --model is given.
// Nothing here writes to the app's config, history or dictionary.
'use strict';

const fs = require('fs');
const path = require('path');
const cleanup = require('../src/main/cleanup');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

(async () => {
  const corpusFile = process.argv[2];
  const outFile = process.argv[3];
  if (!corpusFile || !outFile || corpusFile.startsWith('--')) {
    console.error('usage: node test/eval-cleanup.js <corpus.json> <out.json> [--style concise|clean] [--model M] [--dict "a,b"]');
    process.exit(2);
  }
  const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  const style = arg('style', 'concise');

  let userCleanup = {};
  try {
    userCleanup = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'bol', 'config.json'), 'utf8').replace(/^﻿/, '')).cleanup || {};
  } catch (e) { /* no user config — defaults below */ }
  const c = Object.assign(
    { mode: 'full', provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'auto', preserveMixedLanguage: true, tone: 'auto', appRules: [] },
    userCleanup,
    { mode: 'full', provider: 'ollama', style, tone: 'auto', customInstructions: '' },
  );
  if (arg('model', '')) c.ollamaModel = arg('model', '');
  const cfg = { cleanup: c };
  const dictionary = arg('dict', '') ? arg('dict', '').split(',').map((w) => ({ word: w.trim() })).filter((d) => d.word) : [];

  const w = await cleanup.warm(cfg);
  console.log('warm:', JSON.stringify(w), '| style', style, '| dict', dictionary.length);

  const results = [];
  for (const k of corpus) {
    const t0 = Date.now();
    const r = await cleanup.polish(k.raw, { cfg, app: k.app || '', title: '', dictionary, snippets: [] });
    results.push({
      id: k.id, kind: k.kind, app: k.app || '', style, model: (w && w.model) || c.ollamaModel,
      raw: k.raw, text: r.text, usedAI: r.usedAI, styleUsed: r.style || null, reason: r.reason || null,
      ms: Date.now() - t0, inWords: words(k.raw), outWords: words(r.text),
    });
    process.stdout.write(r.usedAI ? '.' : 'x');
  }
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));

  const ai = results.filter((r) => r.usedAI).length;
  const retried = results.filter((r) => r.reason && /^concise-rejected/.test(r.reason)).length;
  const real = results.filter((r) => r.kind === 'real' && r.usedAI);
  const ratio = real.length ? real.reduce((a, r) => a + r.outWords / Math.max(1, r.inWords), 0) / real.length : 0;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${results.length} cases | AI ${ai} | fell back to Clean ${retried} | offline ${results.length - ai}`);
  console.log(`real dictations: output/input words avg ${(ratio * 100).toFixed(0)}% | latency median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms`);
  console.log('wrote', outFile);
})().catch((e) => { console.error('eval failed:', e && e.stack || e); process.exit(1); });
