// Bol — A5: system tray. Icon is a mic glyph generated at runtime as a real PNG
// (hand-rolled encoder: zlib deflate + CRC32 — zero binary assets, zero deps),
// tinted per state: idle=white, listening=red, busy=amber, disabled=gray.
'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// minimal PNG encoder (RGBA8, no interlace)
// ---------------------------------------------------------------------------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // raw scanlines, each prefixed with filter byte 0 (None)
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// mic glyph rasterizer — signed-distance shapes with 1px anti-aliasing,
// resolution-independent so 16px and 32px renders both look crisp.
// ---------------------------------------------------------------------------
function drawMic(size, rgb) {
  const s = size;
  const buf = Buffer.alloc(s * s * 4);
  const cx = s / 2;

  // geometry in pixels (normalized to size)
  const bodyAy = 0.24 * s, bodyBy = 0.42 * s, bodyR = 0.155 * s; // capsule body
  const arcCy = 0.46 * s, arcR = 0.29 * s, arcT = 0.05 * s;      // cradle (lower half-ring)
  const stemAy = 0.75 * s, stemBy = 0.82 * s, stemR = 0.045 * s; // stem
  const baseHalf = 0.16 * s, baseY = 0.88 * s, baseR = 0.05 * s; // base bar

  // distance from point to segment AB
  const segDist = (px, py, ax, ay, bx, by) => {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const denom = abx * abx + aby * aby;
    let t = denom > 0 ? (apx * abx + apy * aby) / denom : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = apx - abx * t, dy = apy - aby * t;
    return Math.sqrt(dx * dx + dy * dy);
  };

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5, py = y + 0.5;

      // body capsule
      let d = segDist(px, py, cx, bodyAy, cx, bodyBy) - bodyR;
      // stem
      d = Math.min(d, segDist(px, py, cx, stemAy, cx, stemBy) - stemR);
      // base bar (horizontal capsule)
      d = Math.min(d, segDist(px, py, cx - baseHalf, baseY, cx + baseHalf, baseY) - baseR);
      // cradle: ring clipped to the lower half-plane (y >= arc center)
      const rx = px - cx, ry = py - arcCy;
      let ad = Math.abs(Math.sqrt(rx * rx + ry * ry) - arcR) - arcT;
      ad = Math.max(ad, -ry);
      d = Math.min(d, ad);

      let a = 0.5 - d; // 1px anti-alias band around the zero contour
      if (a <= 0) continue;
      if (a > 1) a = 1;
      const i = (y * s + x) * 4;
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// icons + tray
// ---------------------------------------------------------------------------
const COLORS = {
  idle: [236, 239, 244],      // white
  listening: [235, 73, 92],   // red
  busy: [255, 179, 64],       // amber
  disabled: [124, 128, 138],  // gray
};
const TOOLTIPS = {
  idle: 'Ready',
  listening: 'Listening…',
  busy: 'Working…',
  disabled: 'Disabled',
};

let tray = null;
let callbacks = {};
let icons = null;
let currentState = 'idle';

function buildIcons() {
  const out = {};
  for (const state of Object.keys(COLORS)) {
    const rgb = COLORS[state];
    const png16 = encodePng(drawMic(16, rgb), 16, 16);
    const png32 = encodePng(drawMic(32, rgb), 32, 32);
    const img = nativeImage.createFromDataURL('data:image/png;base64,' + png16.toString('base64'));
    try {
      img.addRepresentation({ scaleFactor: 2.0, dataURL: 'data:image/png;base64,' + png32.toString('base64') });
    } catch {} // 1x representation alone is fine
    out[state] = img;
  }
  return out;
}

function safe(fn) {
  if (typeof fn !== 'function') return;
  try { return fn(); } catch (e) { console.error('[bol] tray callback error:', e); }
}

function safeGetState() {
  try {
    const st = typeof callbacks.getState === 'function' ? callbacks.getState() : null;
    return (st && typeof st === 'object') ? st : {};
  } catch { return {}; }
}

function buildMenu() {
  let version = '';
  try { version = app.getVersion() || ''; } catch {}
  const st = safeGetState();
  return Menu.buildFromTemplate([
    { label: 'Bol' + (version ? ' v' + version : ''), enabled: false },
    { type: 'separator' },
    {
      label: 'Enabled',
      type: 'checkbox',
      checked: st.enabled !== false,
      click: () => { safe(callbacks.onToggleEnabled); refreshMenu(); },
    },
    { label: 'Open Dashboard', click: () => safe(callbacks.onOpen) },
    { type: 'separator' },
    { label: 'Quit', click: () => safe(callbacks.onQuit) },
  ]);
}

function refreshMenu() {
  if (!tray || tray.isDestroyed()) return;
  try { tray.setContextMenu(buildMenu()); } catch (e) { console.error('[bol] tray menu update failed:', e.message); }
}

function create(opts) {
  callbacks = opts || {};
  try {
    if (!icons) icons = buildIcons();
    tray = new Tray(icons[currentState] || icons.idle);
    tray.setToolTip('Bol — ' + (TOOLTIPS[currentState] || TOOLTIPS.idle));
    refreshMenu();
    tray.on('double-click', () => safe(callbacks.onOpen));
    return tray;
  } catch (e) {
    console.error('[bol] tray create failed:', e.message);
    tray = null;
    return null;
  }
}

function setState(state) {
  currentState = Object.prototype.hasOwnProperty.call(COLORS, state) ? state : 'idle';
  if (!tray || tray.isDestroyed()) return;
  try {
    if (!icons) icons = buildIcons();
    tray.setImage(icons[currentState]);
    tray.setToolTip('Bol — ' + TOOLTIPS[currentState]);
    refreshMenu(); // keep the Enabled checkmark in sync
  } catch (e) {
    console.error('[bol] tray setState failed:', e.message);
  }
}

module.exports = { create, setState };
