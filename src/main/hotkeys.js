// Bol — A5: global hotkeys.
// Primary engine: uiohook-napi (true keydown/keyup anywhere in the OS).
// Fallback engine: Electron globalShortcut (press-only, so PTT degrades to toggle).
'use strict';

// Canonical uiohook-napi UiohookKey values (verified against the installed
// package). Used only when the native module fails to load — when it loads,
// the reverse map is built from the live UiohookKey export instead.
const KEY_TABLE = {
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
  Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Escape: 1, Space: 57,
  PageUp: 3657, PageDown: 3665, End: 3663, Home: 3655,
  ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424,
  Insert: 3666, Delete: 3667,
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50,
  N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76,
  Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadMultiply: 55, NumpadAdd: 78, NumpadSubtract: 74, NumpadDecimal: 83,
  NumpadDivide: 3637, NumpadEnter: 3612,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  F11: 87, F12: 88, F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102,
  F20: 103, F21: 104, F22: 105, F23: 106, F24: 107,
  Semicolon: 39, Equal: 13, Comma: 51, Minus: 12, Period: 52, Slash: 53,
  Backquote: 41, BracketLeft: 26, Backslash: 43, BracketRight: 27, Quote: 40,
  Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54,
  Meta: 3675, MetaRight: 3676, NumLock: 69, ScrollLock: 70, PrintScreen: 3639,
};

let uIOhook = null;
let keyDefs = KEY_TABLE;
try {
  const m = require('uiohook-napi');
  uIOhook = m.uIOhook;
  if (m.UiohookKey && typeof m.UiohookKey === 'object') keyDefs = m.UiohookKey;
} catch (e) {
  console.error('[bol] uiohook-napi unavailable, hotkeys will use globalShortcut fallback:', e.message);
}

// code -> label reverse map, built from the authoritative key table.
const codeToLabel = {};
for (const name of Object.keys(keyDefs)) {
  const code = keyDefs[name];
  if (typeof code === 'number' && !(code in codeToLabel)) codeToLabel[code] = name;
}

function labelFor(code) {
  return codeToLabel[code] || ('Key ' + code);
}

// Correct default codes (F9/F10/F8), exported so config defaults can be validated.
const defaults = {
  pushToTalk: { code: keyDefs.F9, label: 'F9' },
  toggle: { code: keyDefs.F10, label: 'F10' },
  command: { code: keyDefs.F8, label: 'F8' },
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let mode = uIOhook ? 'uiohook' : 'fallback';
let H = {};                    // handlers
let binds = null;              // { pushToTalk|toggle|command: {code,label} }
let started = false;           // uiohook running
const downKeys = new Set();    // physical down-state per keycode (auto-repeat suppression)
let swallowUpCode = null;      // swallow the keyup that follows a captured keydown
let capture = null;            // { resolve, reject, timer } — uiohook capture
let fbAccels = [];             // fallback: currently registered accelerators
let fbCaptureAccels = [];      // fallback: temporary capture accelerators
let fbPttHeld = false;         // fallback PTT toggle emulation
let fbCmdHeld = false;

function safe(fn) {
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { console.error('[bol] hotkey handler error:', e); }
}

function setBinds(cfg) {
  const src = (cfg && cfg.hotkeys && typeof cfg.hotkeys === 'object') ? cfg.hotkeys : (cfg || {});
  binds = {};
  for (const which of ['pushToTalk', 'toggle', 'command']) {
    const d = defaults[which];
    const b = (src[which] && typeof src[which] === 'object') ? src[which] : {};
    const code = Number.isFinite(b.code) ? b.code : d.code;
    const label = (typeof b.label === 'string' && b.label) ? b.label : labelFor(code);
    binds[which] = { code, label };
  }
}

// ---------------------------------------------------------------------------
// uiohook engine
// ---------------------------------------------------------------------------
function onKeyDown(e) {
  try {
    const code = e && e.keycode;
    if (typeof code !== 'number') return;
    if (downKeys.has(code)) return; // OS auto-repeat — key is already physically down
    downKeys.add(code);

    if (capture) {
      const c = capture;
      capture = null;
      clearTimeout(c.timer);
      swallowUpCode = code; // don't let the matching keyup hit the handlers
      try { c.resolve({ code, label: labelFor(code) }); } catch {}
      return; // swallowed — not forwarded to hotkey handlers
    }
    if (!binds) return;
    if (code === binds.pushToTalk.code) return safe(H.onPTTDown);
    if (code === binds.toggle.code) return safe(H.onToggle);
    if (code === binds.command.code) return safe(H.onCommandDown);
  } catch (err) {
    console.error('[bol] hotkeys keydown error:', err);
  }
}

function onKeyUp(e) {
  try {
    const code = e && e.keycode;
    if (typeof code !== 'number') return;
    downKeys.delete(code);
    if (swallowUpCode === code) { swallowUpCode = null; return; }
    if (!binds) return;
    if (code === binds.pushToTalk.code) return safe(H.onPTTUp);
    if (code === binds.command.code) return safe(H.onCommandUp);
  } catch (err) {
    console.error('[bol] hotkeys keyup error:', err);
  }
}

// ---------------------------------------------------------------------------
// fallback engine (Electron globalShortcut — press events only)
// ---------------------------------------------------------------------------
function getGlobalShortcut() {
  try {
    const gs = require('electron').globalShortcut;
    return gs || null;
  } catch { return null; }
}

// Map a uiohook-style label to an Electron accelerator string (single key).
function accelForLabel(label) {
  if (!label || typeof label !== 'string') return null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(label)) return label;
  if (/^[A-Z0-9]$/.test(label)) return label;
  const direct = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    NumpadMultiply: 'nummult', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    NumpadDecimal: 'numdec', NumpadDivide: 'numdiv', NumpadEnter: 'Enter',
    CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock',
    PrintScreen: 'PrintScreen',
  };
  if (direct[label]) return direct[label];
  const np = /^Numpad([0-9])$/.exec(label);
  if (np) return 'num' + np[1];
  const punct = {
    Semicolon: ';', Equal: '=', Comma: ',', Minus: '-', Period: '.',
    Slash: '/', Backquote: '`', BracketLeft: '[', Backslash: '\\',
    BracketRight: ']', Quote: "'",
  };
  if (punct[label]) return punct[label];
  return null; // bare modifiers etc. can't be globalShortcut accelerators
}

function fbUnregister() {
  const gs = getGlobalShortcut();
  if (gs) {
    for (const accel of fbAccels) { try { gs.unregister(accel); } catch {} }
  }
  fbAccels = [];
  fbPttHeld = false;
  fbCmdHeld = false;
}

function fbRegister() {
  if (fbCaptureAccels.length) return; // capture in progress — re-registered when it finishes
  fbUnregister();
  const gs = getGlobalShortcut();
  if (!gs || !binds) return;
  // PTT and command have no keyup in globalShortcut → alternate presses act as toggle.
  const actions = {
    pushToTalk: () => {
      if (!fbPttHeld) { fbPttHeld = true; safe(H.onPTTDown); }
      else { fbPttHeld = false; safe(H.onPTTUp); }
    },
    toggle: () => safe(H.onToggle),
    command: () => {
      if (!fbCmdHeld) { fbCmdHeld = true; safe(H.onCommandDown); }
      else { fbCmdHeld = false; safe(H.onCommandUp); }
    },
  };
  const used = new Set();
  for (const which of ['pushToTalk', 'toggle', 'command']) {
    const b = binds[which];
    const accel = accelForLabel(b.label) || accelForLabel(labelFor(b.code));
    if (!accel || used.has(accel)) continue;
    try {
      if (gs.register(accel, actions[which])) { fbAccels.push(accel); used.add(accel); }
    } catch (e) {
      console.error('[bol] fallback hotkey register failed for', accel, e.message);
    }
  }
}

// Keys offered during fallback capture (globalShortcut can't observe arbitrary keys,
// so we temporarily register a broad candidate set and resolve on whichever fires).
const CAPTURE_CANDIDATES = (() => {
  const names = [];
  for (let i = 1; i <= 24; i++) names.push('F' + i);
  for (let i = 65; i <= 90; i++) names.push(String.fromCharCode(i));
  for (let i = 0; i <= 9; i++) names.push(String(i));
  names.push('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
    'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete');
  return names;
})();

function fbCaptureNext() {
  return new Promise((resolve, reject) => {
    const gs = getGlobalShortcut();
    if (!gs) return reject(new Error('Hotkey capture is unavailable'));
    fbUnregister(); // free current binds so the user can re-pick the same key
    let done = false;
    let timer = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const accel of fbCaptureAccels) { try { gs.unregister(accel); } catch {} }
      fbCaptureAccels = [];
      fbRegister();
      if (err) reject(err); else resolve(val);
    };
    for (const name of CAPTURE_CANDIDATES) {
      const code = keyDefs[name];
      if (typeof code !== 'number') continue;
      const accel = accelForLabel(name);
      if (!accel) continue;
      try {
        if (gs.register(accel, () => finish(null, { code, label: name }))) fbCaptureAccels.push(accel);
      } catch {}
    }
    timer = setTimeout(() => finish(new Error('Timed out waiting for a key press')), 10000);
    if (!fbCaptureAccels.length) finish(new Error('Hotkey capture is unavailable in fallback mode'));
  });
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
function init(handlers, cfg) {
  H = handlers || {};
  setBinds(cfg);

  if (uIOhook) {
    try {
      uIOhook.on('keydown', onKeyDown);
      uIOhook.on('keyup', onKeyUp);
      uIOhook.start();
      started = true;
      mode = 'uiohook';
      return;
    } catch (e) {
      console.error('[bol] uiohook start failed, using globalShortcut fallback:', e.message);
      try { uIOhook.removeAllListeners('keydown'); uIOhook.removeAllListeners('keyup'); } catch {}
      started = false;
    }
  }
  mode = 'fallback';
  fbRegister();
}

function update(hotkeysCfg) {
  setBinds(hotkeysCfg);
  if (mode === 'fallback') fbRegister();
  // uiohook mode reads `binds` live on every event — nothing else to do.
}

function captureNext() {
  if (capture || fbCaptureAccels.length) {
    return Promise.reject(new Error('Hotkey capture already in progress'));
  }
  if (mode === 'uiohook' && started) {
    return new Promise((resolve, reject) => {
      const c = { resolve, reject, timer: null };
      c.timer = setTimeout(() => {
        if (capture === c) {
          capture = null;
          reject(new Error('Timed out waiting for a key press'));
        }
      }, 10000);
      capture = c;
    });
  }
  return fbCaptureNext();
}

function stop() {
  if (capture) {
    const c = capture;
    capture = null;
    clearTimeout(c.timer);
    try { c.reject(new Error('Hotkeys stopped')); } catch {}
  }
  if (uIOhook) {
    try { uIOhook.removeAllListeners('keydown'); uIOhook.removeAllListeners('keyup'); } catch {}
    if (started) {
      try { uIOhook.stop(); } catch (e) { console.error('[bol] uiohook stop failed:', e.message); }
      started = false;
    }
  }
  const gs = getGlobalShortcut();
  if (gs) {
    for (const accel of fbCaptureAccels) { try { gs.unregister(accel); } catch {} }
  }
  fbCaptureAccels = [];
  fbUnregister();
  downKeys.clear();
  swallowUpCode = null;
}

module.exports = {
  init,
  update,
  captureNext,
  labelFor,
  stop,
  defaults,
  get mode() { return mode; },
};
