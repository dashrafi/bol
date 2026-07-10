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

module.exports = { pcm16ToWav };
