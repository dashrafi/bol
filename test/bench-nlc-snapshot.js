// Bol — can a hybrid/recurrent model (Qwen3.5) skip re-reading the system prompt?
// llama.cpp cannot rewind such a model's state to a shared prefix, so every
// dictation re-evaluates ~1,800 prompt tokens (18 s per dictation on CPU). This
// probe evaluates ONLY the system-prompt prefix once, saves that state, and
// restores it before each dictation so only the user's words are processed.
//
//   node test/bench-nlc-snapshot.js <corpus.json> --gguf ollama:qwen3.5:4b [--threads 6] [--gpu false] [--ids a,b]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cleanup = require('../src/main/cleanup');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
function ollamaBlob(ref) {
  const [name, tag] = ref.split(':');
  const root = path.join(os.homedir(), '.ollama', 'models');
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifests', 'registry.ollama.ai', 'library', name, tag || 'latest'), 'utf8'));
  return path.join(root, 'blobs', m.layers.find((l) => /image\.model$/.test(l.mediaType)).digest.replace(':', '-'));
}
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); }

(async () => {
  const corpus = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ids = arg('ids', '') ? arg('ids', '').split(',') : null;
  const cases = ids ? corpus.filter((c) => ids.includes(c.id)) : corpus;
  let gguf = arg('gguf', 'ollama:qwen3.5:4b');
  if (gguf.startsWith('ollama:')) gguf = ollamaBlob(gguf.slice(7));
  const gpu = arg('gpu', 'false') === 'false' ? false : arg('gpu', 'auto');
  const threads = +arg('threads', '6') || undefined;

  const { getLlama, LlamaChatSession, resolveChatWrapper } = await import('node-llama-cpp');
  const llama = await getLlama({ gpu, logLevel: 'error', build: 'never' });
  const model = await llama.loadModel({ modelPath: gguf });
  const context = await model.createContext({ contextSize: 6144, threads });
  const seq = context.getSequence();
  const wrapper = resolveChatWrapper(model);
  const dictionary = ['Bol', 'Wispr Flow', 'DigitalOcean', 'RDP', 'PakWheels', 'OLX'].map((w) => ({ word: w }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-snap-'));

  // Exact tokens the chat template produces for the system part: the common
  // prefix of two renderings that differ only in the user message.
  const snapshots = {};
  async function snapshotFor(system) {
    if (snapshots[system]) return snapshots[system];
    const render = (u) => wrapper.generateContextState({ chatHistory: [{ type: 'system', text: system }, { type: 'user', text: u }, { type: 'model', response: [] }] }).contextText.tokenize(model.tokenizer);
    const prefix = commonPrefix(render('first message A'), render('second message B'));
    await seq.clearHistory();
    const t = Date.now();
    await seq.evaluateWithoutGeneratingNewTokens(prefix);
    const file = path.join(stateDir, 'snap-' + Object.keys(snapshots).length + '.bin');
    await seq.saveStateToFile(file);
    snapshots[system] = { file, tokens: prefix.length, ms: Date.now() - t, bytes: fs.statSync(file).size };
    console.log(`snapshot: ${prefix.length} prompt tokens evaluated once in ${snapshots[system].ms} ms, state file ${(snapshots[system].bytes / 1048576).toFixed(1)} MB`);
    return snapshots[system];
  }

  for (const k of cases) {
    const style = cleanup.pickStyle('auto', 'concise', k.raw);
    // App context goes into the user turn so the system prompt is identical for
    // every dictation of a style, which is what makes the snapshot reusable.
    const system = cleanup.buildSystemPrompt({ dictionary, snippets: [] }, 'auto', style);
    const snap = await snapshotFor(system);
    const t = Date.now();
    await seq.loadStateFromFile(snap.file, { acceptRisk: true });
    const tLoad = Date.now() - t;
    const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system, autoDisposeSequence: false });
    const before = seq.nextTokenIndex;
    let text = await session.prompt(k.raw, { maxTokens: 512, temperature: 0, budgets: { thoughtTokens: 0 } });
    session.dispose({ disposeSequence: false });
    text = cleanup.finishAiText(String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim());
    console.log(`${k.id.padEnd(16)} ${style.padEnd(8)} total ${String(Date.now() - t).padStart(6)} ms (state restore ${tLoad} ms, sequence had ${before} tokens) | ${text.slice(0, 90)}`);
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('snapshot bench failed:', e && e.stack || e); process.exit(1); });
