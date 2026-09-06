// Bol — STT benchmark. Runs the same transformers.js Whisper pipeline the app's
// local worker uses, against a wav file, and prints transcript + timing + RSS.
//
//   node test/bench-stt.js <file.wav> [--model onnx-community/whisper-small]
//                          [--dtype fp32|q8|fp16|"enc=fp32,dec=q8"] [--language en]
//                          [--cache <dir>] [--host https://huggingface.co] [--runs 1]
//
// The wav must be PCM16 mono (any rate; 16 kHz preferred — that is what the app feeds).
// Nothing here touches the app's config or history.
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data') { data = b.subarray(body, Math.min(body + size, b.length)); break; }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('wav missing fmt/data chunk');
  if (fmt.bits !== 16) throw new Error('only PCM16 supported (got ' + fmt.bits + ' bits)');
  const n = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    out[i] = s / fmt.channels / 32768;
  }
  return { samples: out, rate: fmt.rate };
}

// Linear resample to 16 kHz (bench convenience only; the app has a proper filter in worklet.js).
function to16k(samples, rate) {
  if (rate === 16000) return samples;
  const ratio = rate / 16000;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, samples.length - 1), t = p - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

function parseDtype(s) {
  if (!s) return undefined;
  if (s.indexOf('=') < 0) return s;
  const m = {};
  for (const part of s.split(',')) {
    const [k, v] = part.split('=');
    if (k === 'enc') m.encoder_model = v;
    else if (k === 'dec') m.decoder_model_merged = v;
    else m[k] = v;
  }
  return m;
}

(async () => {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('usage: node test/bench-stt.js <file.wav> [--model M] [--dtype D] [--language L] [--cache DIR] [--host URL] [--runs N]'); process.exit(2); }
  const model = arg('model', 'onnx-community/whisper-small');
  const dtype = parseDtype(arg('dtype', ''));
  const language = arg('language', 'en');
  const runs = parseInt(arg('runs', '1'), 10) || 1;
  const cacheDir = arg('cache', path.join(process.env.APPDATA || '', 'bol', 'models'));
  const host = arg('host', process.env.BOL_HF_ENDPOINT || 'https://hf-mirror.com');

  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = cacheDir;
  tf.env.remoteHost = host;
  tf.env.allowLocalModels = false;

  const wav = readWav(file);
  const audio = to16k(wav.samples, wav.rate);
  const seconds = audio.length / 16000;
  let peak = 0; for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  console.log(`audio: ${seconds.toFixed(1)}s @16k, peak ${peak.toFixed(3)} | model ${model} | dtype ${JSON.stringify(dtype || 'default(fp32)')} | language ${language}`);

  const t0 = Date.now();
  const opts = {};
  if (dtype) opts.dtype = dtype;
  const asr = await tf.pipeline('automatic-speech-recognition', model, opts);
  const loadMs = Date.now() - t0;
  console.log(`model load: ${loadMs} ms, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);

  // --prompt "Bol, Wispr Flow": bias the decoder toward these spellings the way
  // Whisper's `prompt_ids` does in Python. transformers.js has no prompt_ids yet, so
  // we prepend <|startofprev|> + prompt tokens to decoder_input_ids and strip them
  // from the returned sequence so they cannot leak into the transcript.
  const prompt = arg('prompt', '');
  if (prompt) {
    const gc = asr.model.generation_config;
    const enc = asr.tokenizer(' ' + prompt.trim(), { add_special_tokens: false, return_tensor: false });
    const promptIds = enc.input_ids.map(Number);
    const prefix = [gc.prev_sot_token_id].concat(promptIds);
    const langTok = gc.lang_to_id && gc.lang_to_id['<|' + (language === 'auto' ? 'en' : language) + '|>'];
    const init = [gc.decoder_start_token_id, langTok, gc.task_to_id && gc.task_to_id.transcribe].filter((t) => t != null);
    const origGenerate = asr.model.generate.bind(asr.model);
    let leaked = 0;
    asr.model.generate = async (opts) => {
      const rt = (opts.generation_config && opts.generation_config.return_timestamps) || opts.return_timestamps;
      const decoder_input_ids = prefix.concat(init, rt ? [] : [gc.no_timestamps_token_id]);
      const out = await origGenerate(Object.assign({}, opts, { decoder_input_ids }));
      const rows = out.tolist();
      const row = rows[0].map(Number);
      // Strip our prefix (everything before <|startoftranscript|>) so the prompt never reaches the decoder.
      const sot = row.indexOf(gc.decoder_start_token_id);
      const kept = sot >= 0 ? row.slice(sot) : row;
      if (sot !== prefix.length) leaked++;
      return new tf.Tensor('int64', BigInt64Array.from(kept.map(BigInt)), [1, kept.length]);
    };
    console.log(`prompt bias: "${prompt}" -> ${promptIds.length} tokens prepended (prefix ${prefix.length}, init ${init.length})`);
    process.on('exit', () => { if (leaked) console.log(`WARNING: prefix position mismatch in ${leaked} chunk(s)`); });
  }

  for (let r = 0; r < runs; r++) {
    const t1 = Date.now();
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, language: language === 'auto' ? undefined : language, task: 'transcribe' });
    const ms = Date.now() - t1;
    console.log(`run ${r + 1}: ${ms} ms (${(seconds * 1000 / ms).toFixed(1)}x realtime), rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
    console.log('TEXT: ' + String(out && out.text || '').trim());
  }
})().catch((e) => { console.error('bench failed:', e && e.stack || e); process.exit(1); });
