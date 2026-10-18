// Bol — score cleanup outputs from several models on the same corpus with the
// same deterministic checks, so the bundled model is picked on evidence.
//
//   node test/score-cleanup.js out1.json out2.json ...
//
// Each file is the output of test/bench-nlc.js.
'use strict';

const fs = require('fs');

const FILLER = /\b(so,? yeah|you know|i mean|basically|and,? well|kind of|sort of|that'?s about it|or something like that)\b|,\s*like,/gi;
const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

// Hard checks on the adversarial cases: [id, description, (text) => passed]
const CHECKS = [
  ['adv-question', 'does not answer the question', (t) => /\?/.test(t) && words(t) <= 30 && !/render|heroku|vercel|railway|aws|free tier/i.test(t)],
  ['adv-instruction', 'does not write a poem', (t) => /poem/i.test(t) && words(t) <= 30],
  ['adv-numbers', 'keeps 3:30, rupees, email', (t) => /3:30/.test(t) && /rupee/i.test(t) && !/\$/.test(t) && /danish@timegram\.io/i.test(t)],
  ['adv-selfcorrect', 'applies both corrections', (t) => /wednesday/i.test(t) && /ahmed/i.test(t) && !/tuesday/i.test(t) && !/\bsara\b/i.test(t)],
  ['adv-list', 'keeps all three items', (t) => /landing/i.test(t) && /pricing/i.test(t) && /contact/i.test(t) && /email/i.test(t)],
  ['adv-repeat', 'says slow once, keeps images', (t) => (t.match(/slow/gi) || []).length <= 2 && /image/i.test(t)],
  ['adv-short', 'keeps "sounds good" + "tomorrow"', (t) => /sounds good/i.test(t) && /tomorrow/i.test(t)],
];

const rows = [];
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = data.results || data;
  const real = res.filter((r) => r.kind === 'real');
  const concise = real.filter((r) => r.style === 'concise');
  const ratio = concise.length ? concise.reduce((a, r) => a + words(r.text) / Math.max(1, words(r.raw)), 0) / concise.length : 0;
  const fillerIn = real.reduce((a, r) => a + (String(r.raw).match(FILLER) || []).length, 0);
  const fillerOut = real.reduce((a, r) => a + (String(r.text).match(FILLER) || []).length, 0);
  const unchanged = concise.filter((r) => r.text.replace(/[^a-z0-9]/gi, '').toLowerCase() === String(r.raw).replace(/[^a-z0-9]/gi, '').toLowerCase()).length;
  const failed = [];
  for (const [id, desc, fn] of CHECKS) {
    const r = res.find((x) => x.id === id);
    if (r && !fn(String(r.text || ''))) failed.push(id + ' (' + desc + ')');
  }
  const ms = res.map((r) => r.ms).sort((a, b) => a - b);
  rows.push({
    model: data.gguf || file,
    guardRejects: res.filter((r) => r.guard).length,
    conciseRatio: Math.round(ratio * 100) + '%',
    fillerLeft: fillerOut + '/' + fillerIn,
    unchangedConcise: unchanged + '/' + concise.length,
    adversarialPassed: (CHECKS.length - failed.length) + '/' + CHECKS.length,
    medianMs: ms[Math.floor(ms.length / 2)],
    failed: failed.join('; '),
  });
}
console.table(rows.map(({ failed, ...r }) => r));
for (const r of rows) if (r.failed) console.log(r.model + ' failed: ' + r.failed);
