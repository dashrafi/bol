// Bol — wav.js: minimal in-memory WAV (RIFF) encoder for raw PCM16 LE audio.
// No deps. Used by the batch STT providers to wrap mic PCM into an uploadable file.
'use strict';

/**
 * Build a complete WAV file Buffer from raw PCM16 little-endian samples.
 * @param {Buffer|Buffer[]} buffers  one Buffer or an array of Buffers of raw PCM16LE audio
 * @param {number} [sampleRate=16000]
 * @param {number} [channels=1]
 * @returns {Buffer} RIFF/WAVE file contents
 */
function pcm16ToWav(buffers, sampleRate = 16000, channels = 1) {
  const parts = Array.isArray(buffers) ? buffers : [buffers];
  const clean = [];
  for (const p of parts) {
    if (Buffer.isBuffer(p)) clean.push(p);
    else if (p instanceof Uint8Array) clean.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
    else if (p instanceof ArrayBuffer) clean.push(Buffer.from(p));
  }
  let data = clean.length === 1 ? clean[0] : Buffer.concat(clean);
  // PCM16 samples are 2 bytes — drop a trailing half-sample byte if present.
  if (data.length % 2 === 1) data = data.subarray(0, data.length - 1);

  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);       // RIFF chunk size = file size - 8
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                    // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20);                     // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

// Inverse for diagnostics (`Bol --transcribe clip.wav`): a RIFF/WAVE buffer →
// { pcm: Buffer (PCM16LE), sampleRate, channels }. Throws on anything but PCM16.
function wavToPcm16(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12, sampleRate = 0, channels = 0, bits = 0, pcm = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') { channels = b.readUInt16LE(body + 2); sampleRate = b.readUInt32LE(body + 4); bits = b.readUInt16LE(body + 14); }
    if (id === 'data') { pcm = b.subarray(body, Math.min(body + size, b.length)); break; }
    off = body + size + (size & 1);
  }
  if (!pcm || !sampleRate) throw new Error('wav has no fmt/data chunk');
  if (bits !== 16) throw new Error('only 16-bit PCM wav is supported');
  return { pcm: Buffer.from(pcm), sampleRate, channels };
}

module.exports = {
  wavToPcm16, pcm16ToWav };
