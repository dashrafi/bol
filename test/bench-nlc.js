// Bol — benchmark llama.cpp loaded IN-PROCESS through node-llama-cpp (no separate
// .exe, so antivirus has no unsigned server binary to quarantine) on Bol's real
// cleanup prompt.
//
//   node test/bench-nlc.js <corpus.json> <out.json> --gguf <file|ollama:name:tag>
//        [--gpu false|vulkan|auto] [--vk-device 0] [--threads 6] [--ids a,b]
//
// --vk-device restricts Vulkan to one adapter (GGML_VK_VISIBLE_DEVICES), e.g. the
// Intel iGPU, to model a typical laptop. It must be set before llama.cpp loads.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
if (arg('vk-device', '') !== '') process.env.GGML_VK_VISIBLE_DEVICES = arg('vk-device', '');

const cleanup = require('../src/main/cleanup');

function ollamaBlob(ref) {
  const [name, tag] = ref.split(':');
  const root = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifests', 'registry.ollama.ai', 'library', name, tag || 'latest'), 'utf8'));
  return path.join(root, 'blobs', manifest.layers.find((l) => /image\.model$/.test(l.mediaType)).digest.replace(':', '-'));
}

(async () => {
  const [corpusFile, outFile] = process.argv.slice(2);
  let gguf = arg('gguf', '');
  const label = gguf;
  if (gguf.startsWith('ollama:')) gguf = ollamaBlob(gguf.slice(7));
  const gpuArg = arg('gpu', 'auto');
  const gpu = gpuArg === 'false' ? false : gpuArg;
  const threads = +arg('threads', '0') || undefined;
  let corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  const ids = arg('ids', '') ? arg('ids', '').split(',') : null;
  if (ids) corpus = corpus.filter((c) => ids.includes(c.id));
  const dictionary = ['Bol', 'Wispr Flow', 'DigitalOcean', 'RDP', 'PakWheels', 'OLX'].map((w) => ({ word: w }));

  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  const t0 = Date.now();
  const llama = await getLlama({ gpu, logLevel: 'error' });
  const devices = llama.gpu ? await llama.getGpuDeviceNames() : [];
  const model = await llama.loadModel({ modelPath: gguf });
  const context = await model.createContext({ contextSize: 6144, threads });
  const sequence = context.getSequence();
  console.log(`model ${label} gpu=${llama.gpu || 'cpu'} devices=${JSON.stringify(devices)} gpuLayers=${model.gpuLayers} threads=${context.currentThreads} ready in ${Date.now() - t0} ms, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);

  const results = [];
  for (const k of corpus) {
    const style = cleanup.pickStyle('auto', 'concise', k.raw);
    const system = cleanup.buildSystemPrompt({ app: k.app || '', title: '', dictionary, snippets: [] }, 'auto', style);
    const maxTokens = Math.max(256, Math.min(2048, Math.ceil(k.raw.length / 2.5) + 128));
    const t = Date.now();
    const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system, autoDisposeSequence: false });
    let text = await session.prompt(k.raw, { maxTokens, temperature: 0, budgets: { thoughtTokens: 0 } });
    session.dispose({ disposeSequence: false });
    const ms = Date.now() - t;
    text = String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
    if (/\[EMPTY\]/i.test(text)) text = '';
    const finished = text ? cleanup.finishAiText(text) : '';
    const guard = cleanup.guardAiOutput(k.raw, finished, style, dictionary);
    results.push({ id: k.id, kind: k.kind, style, raw: k.raw, text: finished, ms, guard });
    console.log(`${k.id.padEnd(16)} ${style.padEnd(8)} ${String(ms).padStart(6)} ms  ${String(finished.split(/\s+/).filter(Boolean).length).padStart(4)} words  guard=${guard || 'ok'}`);
  }
  fs.writeFileSync(outFile, JSON.stringify({ gguf: label, gpu: llama.gpu || 'cpu', devices, results }, null, 1));
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms | guard rejects ${results.filter((r) => r.guard).length}/${results.length} | rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  await model.dispose();
  process.exit(0);
})().catch((e) => { console.error('bench failed:', e && e.stack || e); process.exit(1); });
