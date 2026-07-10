// Bol — config.js (A10). Owns config.json: defaults, deep-merge load,
// atomic-ish persistence (tmp+rename), change listeners. Sync fs, fail-soft.
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
// Hotkey codes are uiohook-napi UiohookKey values (libuiohook VC_* codes):
// F8=0x0042(66), F9=0x0043(67), F10=0x0044(68). We resolve them from the
// package at runtime when it loads, so the stored codes can never drift from
// what hotkeys.js compares e.keycode against; the constants are the fallback
// when the native module is unavailable (they match UiohookKey exactly).
function resolveFnCodes() {
  const fallback = { F8: 66, F9: 67, F10: 68 };
  try {
    const { UiohookKey } = require('uiohook-napi');
    if (UiohookKey &&
        typeof UiohookKey.F8 === 'number' &&
        typeof UiohookKey.F9 === 'number' &&
        typeof UiohookKey.F10 === 'number') {
      return { F8: UiohookKey.F8, F9: UiohookKey.F9, F10: UiohookKey.F10 };
    }
  } catch (e) { /* native module not loadable here — fallback codes are correct */ }
  return fallback;
}

function buildDefaults() {
  const K = resolveFnCodes();
  return {
    hotkeys: {
      pushToTalk: { code: K.F9, label: 'F9' },
      toggle: { code: K.F10, label: 'F10' },
      command: { code: K.F8, label: 'F8' },
    },
    stt: {
      provider: 'deepgram', // 'deepgram' | 'openai' | 'local'
      deepgramKey: '',
      deepgramModel: 'nova-2',
      openaiKey: '',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiModel: 'whisper-1',
      localModel: 'onnx-community/whisper-base',
      language: 'auto',
    },
    cleanup: {
      mode: 'full', // 'full' (AI) | 'light' (local regex) | 'off' (raw)
      anthropicKey: '',
      model: 'claude-haiku-4-5-20251001',
      tone: 'auto', // 'auto' | 'formal' | 'casual' | 'raw'
      customInstructions: '',
      appRules: [
        { match: 'slack', tone: 'casual' },
        { match: 'outlook', tone: 'formal' },
      ],
    },
    mic: { deviceId: 'default', gain: 1.0, whisperMode: false },
    ui: { hud: true, launchAtLogin: false, onboarded: false },
    privacy: { localOnly: false, storeHistory: true },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  if (v === undefined || v === null) return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return undefined; }
}

// Deep merge: plain objects merge recursively; arrays and primitives replace.
// undefined patch values are skipped so partial patches never erase keys.
function deepMerge(base, patch) {
  const out = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === undefined) continue;
    if (isPlainObject(pv) && isPlainObject(out[key])) out[key] = deepMerge(out[key], pv);
    else out[key] = clone(pv);
  }
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let filePath = null;   // absolute path to config.json (null before init)
let cfg = null;        // live config object
const listeners = [];

function ensureCfg() {
  if (!cfg) cfg = buildDefaults();
  return cfg;
}

function persist() {
  if (!filePath) return;
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // rename can occasionally fail on Windows (AV/file locks) — fall back to
    // a direct write so the config is not silently lost.
    try { fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e2) {
      console.error('[bol] config: failed to persist config.json:', e2.message);
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e3) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function init(paths) {
  try {
    const userData = paths && paths.userData;
    if (!userData) { ensureCfg(); return get(); }
    try { fs.mkdirSync(userData, { recursive: true }); } catch (e) { /* exists */ }
    filePath = path.join(userData, 'config.json');

    const defaults = buildDefaults();
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        cfg = deepMerge(defaults, parsed);
      } catch (e) {
        // Corrupt config: preserve the bytes as .bak, recreate from defaults.
        console.error('[bol] config: config.json corrupt, resetting to defaults:', e.message);
        try { fs.renameSync(filePath, filePath + '.bak'); } catch (e2) { /* best effort */ }
        cfg = defaults;
      }
    } else {
      cfg = defaults;
    }
    persist();
  } catch (e) {
    console.error('[bol] config: init failed, running with in-memory defaults:', e.message);
    ensureCfg();
  }
  return get();
}

function get() {
  return clone(ensureCfg());
}

function set(patch) {
  try {
    cfg = deepMerge(ensureCfg(), patch);
    persist();
  } catch (e) {
    console.error('[bol] config: set failed:', e.message);
  }
  const snapshot = get();
  for (const cb of listeners.slice()) {
    try { cb(snapshot); } catch (e) { console.error('[bol] config: onChange listener threw:', e.message); }
  }
  return snapshot;
}

function onChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i !== -1) listeners.splice(i, 1);
  };
}

module.exports = { init, get, set, onChange };
