// Bol — text injection layer (A1). Persistent PowerShell helper over JSON-lines.
// Exports: init(helperPath), paste(text,{pressEnter}), typeText(text,{pressEnter}),
//          getActiveWindow(), copySelection(), stop().
'use strict';
const { spawn } = require('child_process');

let child = null;
let helperPath = null;
let respawns = 0;
const MAX_RESPAWNS = 3;
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
  child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onData);
  child.on('exit', onExit);
  child.on('error', () => { /* surfaced via pending-request timeouts */ });
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
  const err = new Error('injection helper exited');
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
  if (respawns < MAX_RESPAWNS) { respawns++; spawnHelper(); }
}

function whenReady() {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => readyWaiters.push(resolve));
}

function request(cmd, args, timeoutMs) {
  return whenReady().then(() => new Promise((resolve, reject) => {
    if (!child) return reject(new Error('helper not running'));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(cmd + ' timed out'));
    }, timeoutMs || 5000);
    pending.set(id, { resolve, reject, timer });
    try { child.stdin.write(asciiJson({ id, cmd, args: args || {} }) + '\n'); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  }));
}

function init(p) {
  helperPath = p;
  respawns = 0;
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
  respawns = MAX_RESPAWNS; // block auto-respawn on intentional stop
  if (child) { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} child = null; }
}

module.exports = { init, paste, typeText, getActiveWindow, copySelection, stop };
