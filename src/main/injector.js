// Bol — text injection layer (A1). Persistent PowerShell helper over JSON-lines.
// Exports: init(helperPath), paste(text,{pressEnter}), typeText(text,{pressEnter}),
//          getActiveWindow(), copySelection(), stop().
'use strict';
const { spawn } = require('child_process');

let child = null;
let helperPath = null;
let respawns = 0;              // consecutive crashes; reset once a helper proves stable
const MAX_RESPAWNS = 3;
const STABLE_MS = 30000;       // a helper alive this long clears the crash budget
let stableTimer = null;
let stopped = false;           // set by stop(): never respawn again
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}
let ready = false;
const readyWaiters = [];
let buf = '';

// JSON with all non-ASCII escaped to \uXXXX — makes the stdin stream pure ASCII so no
// console-encoding mismatch can ever corrupt Urdu/emoji text on the way to PowerShell.
function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[-￿]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function spawnHelper() {
  if (stopped) return;
  buf = ''; // (#5) never carry a partial line from a crashed generation into the new one's beacon
  child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onData);
  child.on('exit', onExit);
  child.on('error', () => { /* surfaced via pending-request timeouts */ });
  // (#6) if this generation survives, treat earlier crashes as transient — so 3
  // crashes spread over hours don't permanently disable injection, while a tight
  // crash-loop (3 within STABLE_MS) still trips MAX_RESPAWNS and gives up.
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => { respawns = 0; stableTimer = null; }, STABLE_MS);
}

function onData(chunk) {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 0) { // readiness beacon
      ready = true;
      while (readyWaiters.length) readyWaiters.shift()();
      continue;
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'helper error'));
  }
}

function onExit() {
  child = null;
  ready = false;
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  const err = new Error('injection helper exited');
  const ps = Array.from(pending.values());
  pending.clear();
  for (const p of ps) { try { clearTimeout(p.timer); } catch {} try { p.reject(err); } catch {} }
  if (!stopped && respawns < MAX_RESPAWNS) { respawns++; spawnHelper(); }
  else {
    // Gave up (or stopping): unblock anyone awaiting readiness so their request
    // rejects (via !child) instead of hanging until its own timeout.
    const waiters = readyWaiters.splice(0);
    for (const fn of waiters) { try { fn(); } catch {} }
  }
}

function whenReady() {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => readyWaiters.push(resolve));
}

function request(cmd, args, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    // One timer covers BOTH the readiness wait AND the round-trip, so a helper
    // that never becomes ready can't hang the caller forever (#4).
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error(cmd + ' timed out')), timeoutMs || 5000);
    whenReady().then(() => {
      if (settled) return;
      if (!child) return done(reject, new Error('helper not running'));
      pending.set(id, { timer, resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) });
      try { child.stdin.write(asciiJson({ id, cmd, args: args || {} }) + '\n'); }
      catch (e) { done(reject, e); }
    });
  });
}

function init(p) {
  helperPath = p;
  respawns = 0;
  stopped = false;
  spawnHelper();
}

// paste: clipboard-swap + Ctrl+V (helper waits for modifier release, restores clipboard after).
function paste(text, opts) {
  const t = String(text == null ? '' : text);
  if (!t) return Promise.resolve();
  return request('paste', { text: t, pressEnter: !!(opts && opts.pressEnter) }, 8000);
}

// typeText: per-character Unicode SendInput — fallback for apps that block paste.
function typeText(text, opts) {
  const t = String(text == null ? '' : text);
  if (!t) return Promise.resolve();
  return request('type', { text: t, pressEnter: !!(opts && opts.pressEnter) }, Math.max(8000, t.length * 6));
}

// getActiveWindow -> {exe, title, elevated}. Never rejects the pipeline; degrades to blanks.
function getActiveWindow() {
  return request('active', {}, 4000)
    .then((d) => ({ exe: (d && d.exe) || '', title: (d && d.title) || '', elevated: !!(d && d.elevated) }))
    .catch(() => ({ exe: '', title: '', elevated: false }));
}

// copySelection -> selected text ('' if nothing selected). For command mode.
function copySelection() {
  return request('copysel', {}, 3000).then((d) => (d && d.text) || '').catch(() => '');
}

function stop() {
  stopped = true; // block auto-respawn on intentional stop
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  if (child) { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} }
  // child 'exit' -> onExit rejects any in-flight requests and unblocks readiness waiters.
}

module.exports = { init, paste, typeText, getActiveWindow, copySelection, stop };
