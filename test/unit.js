// Bol unit tests — pure-logic modules only (no Electron needed): node test/unit.js
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok', name); }
  catch (e) { fail++; console.error('  FAIL', name, '-', e.message); }
}

// Electron-free require shim: modules under test must not import electron at top level,
// except analytics/store/config which only need paths at init.
console.log('cleanup.localCleanup');
const cleanup = require('../src/main/cleanup');
t('strips english fillers', () => {
  const out = cleanup.localCleanup('um so basically I think, you know, we should ship it');
  assert(!/\bum\b/i.test(out) && !/you know/i.test(out), out);
});
t('collapses immediate repeats', () => {
  const out = cleanup.localCleanup('the the plan is is ready');
  assert(!/\bthe the\b/i.test(out) && !/\bis is\b/i.test(out), out);
});
t('adds terminal punctuation + capitalizes', () => {
  const out = cleanup.localCleanup('ship it tomorrow');
  assert(/^[A-Z]/.test(out) && /[.!?]$/.test(out), out);
});
t('keeps roman urdu words that are not fillers', () => {
  const out = cleanup.localCleanup('kal subah demo hai ready raho');
  assert(/kal subah demo hai/i.test(out), out);
});
t('empty in, empty out', () => {
  assert.strictEqual(cleanup.localCleanup('   '), '');
});
t('strips a hedge filler that follows a stripped hesitation filler', () => {
  const out = cleanup.localCleanup('um, you know, we should ship it');
  assert(!/you know/i.test(out), out);
  assert(/we should ship it/i.test(out), out);
});
t('pure-noise / punctuation-only input returns empty', () => {
  assert.strictEqual(cleanup.localCleanup('... , .'), '');
  assert.strictEqual(cleanup.localCleanup('um uh'), '');
});

console.log('llm.endpointFor (free-first provider routing)');
const llm = require('../src/main/llm');
t('defaults to local Ollama, no key', () => {
  const ep = llm.endpointFor({});
  assert.strictEqual(ep.local, true);
  assert(/127\.0\.0\.1:11434\/v1\/chat\/completions$/.test(ep.url), ep.url);
  assert.strictEqual(ep.key, '');
});
t('ollama url normalizes trailing slash / /v1', () => {
  const ep = llm.endpointFor({ provider: 'ollama', ollamaUrl: 'http://localhost:11434/v1/' });
  assert(/\/v1\/chat\/completions$/.test(ep.url) && !/v1\/v1/.test(ep.url), ep.url);
});
t('openai provider defaults to Groq free endpoint, needs key', () => {
  const ep = llm.endpointFor({ provider: 'openai' });
  assert(/api\.groq\.com\/openai\/v1\/chat\/completions$/.test(ep.url), ep.url);
  assert.strictEqual(ep.local, false);
});
t('anthropic provider routes to messages API', () => {
  const ep = llm.endpointFor({ provider: 'anthropic', anthropicKey: 'k' });
  assert.strictEqual(ep.kind, 'anthropic');
  assert(/anthropic\.com\/v1\/messages$/.test(ep.url), ep.url);
});

console.log('cleanup.looksNonEnglish (protects Hinglish from translation)');
t('detects Roman Urdu / Hinglish', () => {
  assert.strictEqual(cleanup.looksNonEnglish('kal subah demo ready hai bhai'), true);
  assert.strictEqual(cleanup.looksNonEnglish('client ko email kardenge aur phir call'), true);
});
t('leaves plain English for the LLM', () => {
  assert.strictEqual(cleanup.looksNonEnglish('the meeting is at four pm tomorrow'), false);
  assert.strictEqual(cleanup.looksNonEnglish('ship the demo and email the client'), false);
});
t('flags real non-Latin script', () => {
  assert.strictEqual(cleanup.looksNonEnglish('کل صبح ڈیمو تیار ہے'), true);
});

console.log('wav.pcm16ToWav');
const wav = require('../src/main/stt/wav');
t('valid RIFF header for 16k mono pcm16', () => {
  const pcm = Buffer.alloc(3200); // 100ms silence
  const w = wav.pcm16ToWav([pcm], 16000);
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(w.readUInt32LE(24), 16000);          // sample rate
  assert.strictEqual(w.readUInt16LE(22), 1);              // channels
  assert.strictEqual(w.readUInt16LE(34), 16);             // bits
  assert.strictEqual(w.readUInt32LE(4), w.length - 8);    // riff size
  assert.strictEqual(w.readUInt32LE(w.indexOf(Buffer.from('data')) + 4), 3200); // data size
});
t('concatenates multiple buffers', () => {
  const w = wav.pcm16ToWav([Buffer.alloc(100), Buffer.alloc(60)], 16000);
  assert.strictEqual(w.readUInt32LE(w.indexOf(Buffer.from('data')) + 4), 160);
});

console.log('snippets.expandSpoken');
const snippets = require('../src/main/snippets');
const SNIPS = [{ trigger: 'address', text: 'House 12, Street 4, Islamabad' }];
t('expands "insert <trigger>"', () => {
  const out = snippets.expandSpoken('please insert address here', SNIPS);
  assert(out.includes('House 12'), out);
});
t('expands "<trigger> daalo"', () => {
  const out = snippets.expandSpoken('address daalo aur send karo', SNIPS);
  assert(out.includes('House 12'), out);
});
t('no false expansion on partial words', () => {
  const out = snippets.expandSpoken('the addressee was wrong', SNIPS);
  assert(!out.includes('House 12'), out);
});

console.log('analytics math');
const analytics = require('../src/main/analytics');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-test-'));
analytics.init({ userData: tmp });
t('records and aggregates', () => {
  analytics.record({ words: 120, durationMs: 60000, app: 'slack' });
  analytics.record({ words: 60, durationMs: 30000, app: 'chrome' });
  const a = analytics.get();
  assert.strictEqual(a.totalWords, 180);
  assert.strictEqual(a.totalSessions, 2);
  assert.strictEqual(a.avgWpm, Math.round(180 / (90000 / 60000)));
  assert(a.streakDays >= 1, 'streak ' + a.streakDays);
  assert(Array.isArray(a.days) && a.days.length === 30, 'days window');
  assert(a.topApps.length === 2);
});
t('minutesSaved clamps >= 0', () => {
  const a = analytics.get();
  assert(a.minutesSaved >= 0);
});

console.log('store: history/dictionary/snippets');
const store = require('../src/main/store');
store.init({ userData: tmp });
t('history add/list/query/delete', () => {
  store.history.add({ raw: 'umm hello world', polished: 'Hello world.', app: 'slack', title: 't', durationMs: 900, provider: 'deepgram' });
  store.history.add({ raw: 'kal meeting hai', polished: 'Kal meeting hai.', app: 'outlook', title: 't', durationMs: 800, provider: 'deepgram' });
  const all = store.history.list({});
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].polished, 'Kal meeting hai.'); // newest first
  assert(all[0].words === 3);
  const q = store.history.list({ query: 'hello' });
  assert.strictEqual(q.length, 1);
  store.history.delete(all[0].id);
  assert.strictEqual(store.history.list({}).length, 1);
});
t('dictionary add/remove dedupes', () => {
  store.dictionary.add('Timegram');
  store.dictionary.add('Timegram');
  assert.strictEqual(store.dictionary.list().filter(d => d.word === 'Timegram').length, 1);
  store.dictionary.remove('Timegram');
  assert.strictEqual(store.dictionary.list().length, 0);
});
t('snippets add/remove', () => {
  store.snippets.add('sig', 'Best, Danish');
  assert.strictEqual(store.snippets.list()[0].trigger, 'sig');
  store.snippets.remove('sig');
  assert.strictEqual(store.snippets.list().length, 0);
});

console.log('config defaults + merge');
const config = require('../src/main/config');
config.init({ userData: tmp });
t('required keys exist', () => {
  const c = config.get();
  for (const k of ['hotkeys', 'stt', 'cleanup', 'mic', 'ui', 'privacy']) assert(c[k], 'missing ' + k);
  assert.strictEqual(c.stt.provider, 'local');       // free/keyless default
  assert.strictEqual(c.cleanup.provider, 'ollama');  // free/local default
  assert.strictEqual(c.cleanup.mode, 'full');
});
t('set patch deep-merges and persists', () => {
  config.set({ stt: { deepgramKey: 'dgk' } });
  const c = config.get();
  assert.strictEqual(c.stt.deepgramKey, 'dgk');
  assert.strictEqual(c.stt.provider, 'local'); // untouched sibling survives
});
t('a UTF-8 BOM does not wipe saved settings', () => {
  // Editors and PowerShell's Set-Content add a BOM; JSON.parse throws on it, which
  // used to be treated as "corrupt" and silently reset every user setting.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-bom-'));
  fs.writeFileSync(path.join(dir, 'config.json'),
    '﻿' + JSON.stringify({ stt: { localModel: 'onnx-community/whisper-small' } }), 'utf8');
  const fresh = require('../src/main/config');
  fresh.init({ userData: dir });
  assert.strictEqual(fresh.get().stt.localModel, 'onnx-community/whisper-small');
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json.bak')), false, 'must not quarantine a BOM file');
  fs.rmSync(dir, { recursive: true, force: true });
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
