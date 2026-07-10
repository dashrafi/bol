// Bol — main process orchestrator. Owns the dictation pipeline state machine,
// window lifecycle, and every IPC handler. Modules per CONTRACTS.md.
'use strict';

const { app, BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');

const SMOKE = process.argv.includes('--smoke');

// ---------- modules ----------
const config = require('./config');
const store = require('./store');
const analytics = require('./analytics');
const hotkeys = require('./hotkeys');
const injector = require('./injector');
const stt = require('./stt');
const cleanup = require('./cleanup');
const commandMode = require('./commandMode');
const snippets = require('./snippets');
const tray = require('./tray');

// ---------- state ----------
const S = { IDLE: 'idle', LISTENING: 'listening', FINALIZING: 'finalizing', POLISHING: 'polishing', INSERTING: 'inserting' };
let state = S.IDLE;
let enabled = true;
let current = null; // { session, mode: 'dictate'|'command', via: 'ptt'|'toggle', app, title, startTs, chunks }
let wins = { app: null, hud: null, recorder: null };
let quitting = false;

function log(...a) { if (process.env.BOL_DEBUG) console.log('[bol]', ...a); }

// localOnly hard enforcement: never hand a cloud provider to the pipeline when set.
function effectiveConfig() {
  const cfg = JSON.parse(JSON.stringify(config.get()));
  if (cfg.privacy && cfg.privacy.localOnly) {
    cfg.stt.provider = 'local';
    if (cfg.cleanup.mode === 'full') cfg.cleanup.mode = 'light';
  }
  return cfg;
}

// ---------- HUD ----------
function hudSend(payload) {
  if (SMOKE) return;
  const cfg = config.get();
  if (!cfg.ui.hud) return;
  if (!wins.hud || wins.hud.isDestroyed()) return;
  if (payload.state !== 'idle' && !wins.hud.isVisible()) {
    positionHud();
    wins.hud.showInactive();
  }
  wins.hud.webContents.send('hud:state', payload);
  if (payload.state === 'idle') setTimeout(() => { if (wins.hud && !wins.hud.isDestroyed() && state === S.IDLE) wins.hud.hide(); }, 250);
}

function positionHud() {
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = disp.workArea;
  const w = 560, h = 84;
  wins.hud.setBounds({ x: Math.round(x + (width - w) / 2), y: Math.round(y + height - h - 24), width: w, height: h });
}

// ---------- pipeline ----------
async function startCapture(mode, via) {
  if (!enabled || state !== S.IDLE) return;
  const cfg = effectiveConfig();
  state = S.LISTENING;
  tray.setState('listening');

  let target = { exe: '', title: '' };
  try { target = await injector.getActiveWindow(); } catch (e) { log('activeWindow failed', e.message); }

  const dict = store.dictionary.list().map(d => d.word);
  let sess;
  try {
    sess = stt.createSession(cfg, dict, {
      onPartial: (text) => { if (current && current.session === sess) hudSend({ state: 'listening', partial: text }); },
      onFinal: (text) => onFinal(sess, text),
      onError: (err) => onPipelineError(sess, err),
    });
  } catch (e) { return onPipelineError(null, e); }

  current = { session: sess, mode, via, app: target.exe, title: target.title, startTs: Date.now(), chunks: 0 };
  hudSend({ state: 'listening', partial: '', message: mode === 'command' ? 'Command…' : '' });
  recorderSend('rec:start', { deviceId: cfg.mic.deviceId, gain: cfg.mic.gain, whisperMode: cfg.mic.whisperMode });
}

function stopCapture() {
  if (state !== S.LISTENING || !current) return;
  state = S.FINALIZING;
  tray.setState('busy');
  recorderSend('rec:stop');
  hudSend({ state: 'transcribing' });
  const sess = current.session;
  try { sess.end(); } catch (e) { onPipelineError(sess, e); }
  // watchdog: if the provider never calls onFinal, unstick after 15s
  setTimeout(() => { if (current && current.session === sess && state === S.FINALIZING) onPipelineError(sess, new Error('Transcription timed out')); }, 15000);
}

function cancelCapture() {
  if (!current) return;
  try { current.session.abort(); } catch {}
  recorderSend('rec:stop');
  current = null;
  state = S.IDLE;
  tray.setState(enabled ? 'idle' : 'disabled');
  hudSend({ state: 'idle' });
}

async function onFinal(sess, raw) {
  if (!current || current.session !== sess) return; // stale/aborted session
  const ctx = current;
  current = null;
  const cfg = effectiveConfig();
  const durationMs = Date.now() - ctx.startTs;
  raw = (raw || '').trim();

  if (!raw) {
    state = S.IDLE; tray.setState(enabled ? 'idle' : 'disabled');
    hudSend({ state: 'error', message: "Didn't catch that — try again" });
    setTimeout(() => hudSend({ state: 'idle' }), 1800);
    return;
  }

  try {
    if (ctx.mode === 'command') {
      state = S.POLISHING; hudSend({ state: 'polishing', message: 'Applying…' });
      const res = await commandMode.run(raw, { injector, cfg, dictionary: store.dictionary.list() });
      state = S.IDLE; tray.setState('idle');
      hudSend({ state: 'inserting' });
      setTimeout(() => hudSend({ state: 'idle' }), 700);
      log('command done', res);
      return;
    }

    state = S.POLISHING; hudSend({ state: 'polishing' });
    const polished = await cleanup.polish(raw, {
      cfg, app: ctx.app, title: ctx.title,
      dictionary: store.dictionary.list(),
      snippets: store.snippets.list(),
      customInstructions: cfg.cleanup.customInstructions,
    });
    const text = (polished.text || '').trim();
    if (!text) {
      state = S.IDLE; tray.setState('idle');
      hudSend({ state: 'error', message: 'Nothing to insert' });
      setTimeout(() => hudSend({ state: 'idle' }), 1500);
      return;
    }

    state = S.INSERTING; hudSend({ state: 'inserting' });
    try { await injector.paste(text); }
    catch (e) { log('paste failed, typing fallback', e.message); await injector.typeText(text); }

    if (config.get().privacy.storeHistory) {
      store.history.add({ raw, polished: text, app: ctx.app, title: ctx.title, durationMs, provider: cfg.stt.provider });
    }
    analytics.record({ words: text.split(/\s+/).filter(Boolean).length, durationMs, app: ctx.app });
    state = S.IDLE; tray.setState('idle');
    hudSend({ state: 'idle' });
  } catch (e) { onPipelineError(null, e); }
}

function onPipelineError(sess, err) {
  if (sess && current && current.session !== sess) return; // stale
  log('pipeline error', err);
  if (current) { try { current.session.abort(); } catch {} }
  current = null;
  recorderSend('rec:stop');
  state = S.IDLE;
  tray.setState(enabled ? 'idle' : 'disabled');
  hudSend({ state: 'error', message: (err && err.message) ? String(err.message).slice(0, 120) : 'Something went wrong' });
  setTimeout(() => hudSend({ state: 'idle' }), 2500);
}

// ---------- windows ----------
function recorderSend(ch, payload) {
  if (wins.recorder && !wins.recorder.isDestroyed()) wins.recorder.webContents.send(ch, payload);
}

function createWindows() {
  const preload = path.join(__dirname, 'preload.js');

  wins.recorder = new BrowserWindow({
    show: false, width: 120, height: 80, skipTaskbar: true,
    webPreferences: { preload, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  wins.recorder.loadFile(path.join(__dirname, '..', 'renderer', 'recorder', 'recorder.html'));

  wins.hud = new BrowserWindow({
    show: false, width: 560, height: 84, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  wins.hud.setAlwaysOnTop(true, 'screen-saver');
  wins.hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wins.hud.loadFile(path.join(__dirname, '..', 'renderer', 'hud', 'hud.html'));

  wins.app = new BrowserWindow({
    show: false, width: 1120, height: 760, minWidth: 900, minHeight: 620,
    backgroundColor: '#0b0e17', autoHideMenuBar: true, title: 'Bol',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  wins.app.loadFile(path.join(__dirname, '..', 'renderer', 'app', 'index.html'));
  wins.app.on('close', (e) => { if (!quitting) { e.preventDefault(); wins.app.hide(); } });

  // mic permission for the recorder window
  wins.recorder.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
}

function showDashboard() {
  if (wins.app && !wins.app.isDestroyed()) { wins.app.show(); wins.app.focus(); }
}

// ---------- IPC ----------
let micPending = null;
function registerIpc() {
  ipcMain.handle('settings:get', () => config.get());
  ipcMain.handle('settings:set', (e, patch) => {
    config.set(patch); // fires config.onChange -> broadcast('settings:changed') once
    const cfg = config.get();
    if (patch && patch.hotkeys) hotkeys.update(cfg.hotkeys);
    if (patch && patch.ui && typeof patch.ui.launchAtLogin === 'boolean') {
      try { app.setLoginItemSettings({ openAtLogin: cfg.ui.launchAtLogin }); } catch {}
    }
    // NOTE: no explicit broadcast here — config.onChange (wired in boot) already
    // emits settings:changed on set(), so broadcasting again would double-fire it.
    return cfg;
  });
  ipcMain.handle('settings:captureHotkey', async () => hotkeys.captureNext());

  ipcMain.handle('mic:list', () => new Promise((resolve) => {
    micPending = resolve;
    recorderSend('mic:enumerate');
    setTimeout(() => { if (micPending) { micPending([]); micPending = null; } }, 2500);
  }));
  ipcMain.on('mic:devices', (e, devices) => { if (micPending) { micPending(devices || []); micPending = null; } });

  ipcMain.handle('history:list', (e, q) => store.history.list(q || {}));
  ipcMain.handle('history:delete', (e, id) => store.history.delete(id));
  ipcMain.handle('history:clear', () => store.history.clear());

  ipcMain.handle('dict:list', () => store.dictionary.list());
  ipcMain.handle('dict:add', (e, entry) => store.dictionary.add(entry.word, { soundsLike: entry.soundsLike }));
  ipcMain.handle('dict:remove', (e, word) => store.dictionary.remove(word));
  ipcMain.handle('dict:suggest', () => store.dictionary.suggestFromHistory(store.history.list({ limit: 500 })));

  ipcMain.handle('snippets:list', () => store.snippets.list());
  ipcMain.handle('snippets:add', (e, s) => store.snippets.add(s.trigger, s.text));
  ipcMain.handle('snippets:remove', (e, trigger) => store.snippets.remove(trigger));

  ipcMain.handle('analytics:get', () => analytics.get());
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('test:stt', () => stt.test(effectiveConfig()).catch(e => ({ ok: false, error: e.message })));
  ipcMain.handle('test:cleanup', () => cleanup.test(config.get()).catch(e => ({ ok: false, error: e.message })));

  // From the dashboard the target app isn't focused — put it on the clipboard instead.
  ipcMain.handle('insert:text', (e, text) => { clipboard.writeText(String(text || '')); return { copied: true }; });

  // recorder events
  ipcMain.on('audio:chunk', (e, buf) => {
    if (state === S.LISTENING && current) { current.chunks++; try { current.session.feed(Buffer.from(buf)); } catch {} }
  });
  ipcMain.on('audio:level', (e, level) => { if (state === S.LISTENING) hudSend({ state: 'listening', level }); });
  ipcMain.on('audio:error', (e, msg) => { if (state === S.LISTENING || state === S.FINALIZING) onPipelineError(null, new Error(msg || 'Microphone error')); });

  ipcMain.on('hud:cancel', () => cancelCapture());
}

function broadcast(ch, payload) {
  for (const w of [wins.app, wins.hud, wins.recorder]) {
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload);
  }
}

// ---------- boot ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => showDashboard());

  app.whenReady().then(async () => {
    const paths = { userData: app.getPath('userData') };
    process.env.BOL_MODELS_DIR = path.join(paths.userData, 'models');

    config.init(paths);
    store.init(paths);
    analytics.init(paths);

    const bootReport = { injector: 'ok', hotkeys: 'ok' };
    try { injector.init(path.join(__dirname, 'helper', 'winhelper.ps1')); }
    catch (e) { bootReport.injector = 'failed: ' + e.message; console.error('[bol] injector init failed', e); }

    createWindows();
    registerIpc();

    try {
      hotkeys.init({
        onPTTDown: () => startCapture('dictate', 'ptt'),
        onPTTUp: () => stopCapture(),
        onToggle: () => { (state === S.IDLE) ? startCapture('dictate', 'toggle') : (state === S.LISTENING && current && current.via === 'toggle' && stopCapture()); },
        onCommandDown: () => startCapture('command', 'ptt'),
        onCommandUp: () => stopCapture(),
      }, config.get().hotkeys);
      bootReport.hotkeys = hotkeys.mode;
    } catch (e) { bootReport.hotkeys = 'failed: ' + e.message; console.error('[bol] hotkeys init failed', e); }

    tray.create({
      onOpen: () => showDashboard(),
      onToggleEnabled: () => { enabled = !enabled; if (!enabled) cancelCapture(); tray.setState(enabled ? 'idle' : 'disabled'); return enabled; },
      onQuit: () => { quitting = true; app.quit(); },
      getState: () => ({ enabled, state }),
    });

    config.onChange(() => broadcast('settings:changed', config.get()));

    if (SMOKE) {
      const mods = Object.entries(bootReport).map(([k, v]) => `${k}=${v}`).join(' ');
      setTimeout(() => { console.log(`SMOKE OK modules: ${mods} state=${state}`); quitting = true; app.exit(0); }, 2500);
      return;
    }

    if (!config.get().ui.onboarded) showDashboard();
  });

  app.on('before-quit', () => {
    quitting = true;
    try { hotkeys.stop(); } catch {}
    try { injector.stop(); } catch {}
  });
  app.on('window-all-closed', (e) => { /* tray app — keep alive */ });
}
