// Generates build/icon.png (256x256) and build/icon.ico (PNG-embedded ICO) for the
// installer/exe — same mic-in-rounded-square mark as the tray, no binary assets in git.
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 256;

// ---- CRC32 (PNG) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- signed-distance helpers ----
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}
function cov(d) { return Math.max(0, Math.min(1, 0.5 - d)); }

// ---- draw ----
const img = Buffer.alloc(S * S * 4);
const bgR = 56;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // rounded-square background with a diagonal #6c7bff -> #9a5bff gradient
    const dBg = sdRoundRect(x, y, S / 2, S / 2, S / 2 - 8, S / 2 - 8, bgR);
    const aBg = cov(dBg);
    if (aBg <= 0) { img[i + 3] = 0; continue; }
    const t = Math.max(0, Math.min(1, (x + y) / (2 * S)));
    let r = Math.round(0x6c + (0x9a - 0x6c) * t);
    let g = Math.round(0x7b + (0x5b - 0x7b) * t);
    let b = 0xff;

    // white mic glyph via max-coverage of its parts
    let a = 0;
    a = Math.max(a, cov(sdRoundRect(x, y, 128, 104, 30, 48, 30)));            // capsule
    const dRing = Math.abs(Math.hypot(x - 128, y - 138) - 54) - 7;            // cradle ring
    a = Math.max(a, y >= 138 ? cov(dRing) : 0);
    a = Math.max(a, cov(sdRoundRect(x, y, 128, 205, 6, 14, 5)));              // stem
    a = Math.max(a, cov(sdRoundRect(x, y, 128, 224, 34, 7, 6)));              // base

    if (a > 0) { r = Math.round(r + (255 - r) * a); g = Math.round(g + (255 - g) * a); b = 255; }
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = Math.round(aBg * 255);
  }
}

const png = encodePng(img, S, S);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);

// ICO container with the PNG embedded (Vista+ supports PNG entries; 0 = 256px)
const header = Buffer.from([0, 0, 1, 0, 1, 0]);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0; // 256x256, no palette
entry.writeUInt16LE(1, 4);  // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // offset
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, entry, png]));
console.log('icon.png', png.length, 'bytes; icon.ico written');
