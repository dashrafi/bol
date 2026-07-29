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

let debugLogPath = null; // set at boot; file logging survives detached/GUI launches where stdout is lost
function log(...a) {
  if (!process.env.BOL_DEBUG) return;
  const line = '[' + new Date().toISOString().slice(11, 23) + '] ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log('[bol]', line);
  if (debugLogPath) { try { require('fs').appendFileSync(debugLogPath, line + '\n'); } catch {} }
}

// localOnly hard enforcement: never hand a cloud provider to the pipeline when set.
// STT → local Whisper; cleanup → offline regex; but command mode has no offline
// path, so pin its provider to Ollama (local) so it still works fully on-device.
function effectiveConfig() {
  const cfg = JSON.parse(JSON.stringify(config.get()));
  if (cfg.privacy && cfg.privacy.localOnly) {
    cfg.stt.provider = 'local';
    cfg.cleanup.provider = 'ollama';
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
let pendingStop = false;      // a keyup arrived during startCapture's await, before `current` existed
let startingTrigger = null;   // which trigger's capture is mid-startup (for owner-matched pendingStop)
let preBuffer = [];           // audio that arrives before the STT session exists (first words!)
let preMaxLevel = 0;

async function startCapture(mode, via) {
  if (!enabled || state !== S.IDLE) return;
  const cfg = effectiveConfig();
  const trigger = via === 'toggle' ? 'toggle' : (mode === 'command' ? 'command' : 'ptt');
  state = S.LISTENING;
  pendingStop = false;
  startingTrigger = trigger;
  preBuffer = [];
  preMaxLevel = 0;
  tray.setState('listening');

  // Start the mic IMMEDIATELY — the foreground lookup + session setup below cost
  // hundreds of ms, and any words spoken in that window were being lost. Frames
  // that arrive before the session exists land in preBuffer and are fed later.
  recorderSend('rec:start', { deviceId: cfg.mic.deviceId, gain: cfg.mic.gain, whisperMode: cfg.mic.whisperMode });
  hudSend({ state: 'listening', partial: '', message: mode === 'command' ? 'Command…' : '' });

  let target = { exe: '', title: '' };
  try { target = await injector.getActiveWindow(); } catch (e) { log('activeWindow failed', e.message); }
  startingTrigger = null;

  // The user may have released PTT (or cancelled) during the await above, when
  // `current` was still null so stopCapture couldn't act. Honor that now.
  if (pendingStop || state !== S.LISTENING) {
    pendingStop = false;
    preBuffer = [];
    recorderSend('rec:stop');
    if (state === S.LISTENING) { state = S.IDLE; tray.setState(enabled ? 'idle' : 'disabled'); hudSend({ state: 'idle' }); }
    return;
  }

  const dict = store.dictionary.list().map(d => d.word);
  let sess;
  try {
    sess = stt.createSession(cfg, dict, {
      onPartial: (text) => { if (current && current.session === sess) hudSend({ state: 'listening', partial: text }); },
      onFinal: (text) => onFinal(sess, text),
      onError: (err) => onPipelineError(sess, err),
    });
  } catch (e) { return onPipelineError(null, e); }

  current = { session: sess, mode, via, trigger, app: target.exe, title: target.title, startTs: Date.now(), chunks: 0, maxLevel: preMaxLevel };
  // Hand the buffered first words to the session in order.
  for (const b of preBuffer) { current.chunks++; try { sess.feed(b); } catch {} }
  preBuffer = [];
  // Safety net: a forgotten hands-free/tap-toggle session auto-finalizes after
  // 5 minutes instead of holding the mic open forever.
  const guarded = current;
  setTimeout(() => {
    if (state === S.LISTENING && current === guarded) { log('max session length reached — auto-stopping'); stopCapture(); }
  }, 5 * 60 * 1000);
  log('LISTENING', mode, via, 'stt=' + cfg.stt.provider, 'app=' + target.exe);
}

function stopCapture(owner) {
  if (state !== S.LISTENING) return;
  if (!current) {
    // keyup landed before startCapture assigned `current` — record intent so the
    // resuming startCapture cancels instead of starting a mic nothing stops.
    if (!owner || owner === startingTrigger) pendingStop = true;
    return;
  }
  if (owner && current.trigger !== owner) return; // stray keyup from a different trigger
  // A quick TAP (released under 350ms) means the user expects start/stop toggling,
  // not push-to-talk — keep listening; the next tap of the same key stops it.
  if (current.via === 'ptt' && current.mode === 'dictate' && (Date.now() - current.startTs) < 350) {
    current.via = 'tap-toggle';
    log('tap detected -> hands-free until next tap');
    hudSend({ state: 'listening', message: 'Recording — tap again to stop' });
    return;
  }
  log('FINALIZING, chunks fed =', current.chunks, 'maxLevel =', (current.maxLevel || 0).toFixed(3));
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
  pendingStop = false;
  startingTrigger = null;
  if (!current) { if (state === S.LISTENING) { state = S.IDLE; tray.setState(enabled ? 'idle' : 'disabled'); hudSend({ state: 'idle' }); } return; }
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
  log('onFinal: raw len', raw.length, JSON.stringify(raw).slice(0, 100), 'maxLevel', (ctx.maxLevel || 0).toFixed(3));

  // Whisper emits bracketed sentinels and stock hallucinations ("you",
  // "Thank you.") on silent/near-silent audio — never paste those.
  if (/^[\[\(][^\]\)]{0,30}[\]\)]$/.test(raw)) raw = '';
  if ((ctx.maxLevel || 0) < 0.02 && raw.split(/\s+/).length <= 4) raw = '';

  if (!raw) {
    state = S.IDLE; tray.setState(enabled ? 'idle' : 'disabled');
    hudSend({ state: 'error', message: "Couldn't hear you — check your mic, or pick the right one in Settings" });
    setTimeout(() => hudSend({ state: 'idle' }), 2600);
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
    try { await injector.paste(text); log('PASTED', text.length, 'chars into', ctx.app); }
    catch (e) { log('paste failed, typing fallback', e.message); await injector.typeText(text); }

    if (config.get().privacy.storeHistory) {
      store.history.add({ raw, polished: text, app: ctx.app, title: ctx.title, durationMs, provider: cfg.stt.provider });
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    analytics.record({ words: wordCount, durationMs, app: ctx.app });
    state = S.IDLE; tray.setState('idle');

    // Partial-capture warning: a long recording that produced very few words
    // (or barely-audible input) means the mic missed most of the speech. The
    // text still pasted — but tell the user WHY it came out short.
    const secs = durationMs / 1000;
    const sparse = secs > 5 && (wordCount / secs) < 0.8;
    const quiet = (ctx.maxLevel || 0) < 0.06;
    if (sparse || quiet) {
      log('unclear-audio warning: words/s =', (wordCount / secs).toFixed(2), 'maxLevel =', (ctx.maxLevel || 0).toFixed(3));
      hudSend({ state: 'error', message: "Couldn't hear parts of that — speak closer, or pick the right mic in Settings" });
      setTimeout(() => hudSend({ state: 'idle' }), 3500);
    } else {
      hudSend({ state: 'idle' });
    }
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
  ipcMain.on('mic:devices', (e, devices) => {
    if (process.env.BOL_DEBUG) log('mics:', JSON.stringify((devices || []).map(d => d.label || d.deviceId)));
    if (micPending) { micPending(devices || []); micPending = null; }
  });

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
    if (state !== S.LISTENING) return;
    if (current) {
      current.chunks++;
      if (current.chunks === 1 || current.chunks % 20 === 0) log('audio chunks:', current.chunks);
      try { current.session.feed(Buffer.from(buf)); } catch (err) { log('feed error', err.message); }
    } else if (preBuffer.length < 100) {
      // session still being created — keep the first words (up to ~10s)
      preBuffer.push(Buffer.from(buf));
    }
  });
  ipcMain.on('audio:level', (e, level) => {
    if (typeof level === 'number') {
      if (current) current.maxLevel = Math.max(current.maxLevel || 0, level);
      else preMaxLevel = Math.max(preMaxLevel, level);
    }
    if (state === S.LISTENING) hudSend({ state: 'listening', level });
  });
  ipcMain.on('audio:error', (e, msg) => { log('audio:error', msg); if (state === S.LISTENING || state === S.FINALIZING) onPipelineError(null, new Error(msg || 'Microphone error')); });

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
    if (process.env.BOL_DEBUG) {
      debugLogPath = path.join(paths.userData, 'debug.log');
      try { require('fs').writeFileSync(debugLogPath, ''); } catch {}
      log('BOOT pid', process.pid, 'version', app.getVersion());
      // QA hook: uiohook cannot see SendInput-injected keys, so automated tests
      // drive the pipeline via a trigger file instead of the real hotkey.
      // Write "start" / "stop" to <userData>/trigger.txt.
      const trigPath = path.join(paths.userData, 'trigger.txt');
      let lastTrig = '';
      setInterval(() => {
        let t = '';
        try { t = require('fs').readFileSync(trigPath, 'utf8').trim(); } catch { return; }
        if (t === lastTrig) return;
        lastTrig = t;
        log('TRIGGER', t);
        if (t.startsWith('start')) { recorderSend('mic:enumerate'); startCapture('dictate', 'ptt'); }
        else if (t.startsWith('stop')) stopCapture('ptt');
      }, 300);
    }

    config.init(paths);
    store.init(paths);
    analytics.init(paths);

    const bootReport = { injector: 'ok', hotkeys: 'ok' };
    // powershell.exe cannot read from inside app.asar — in packaged builds the
    // helper is asarUnpacked, so point at the unpacked copy.
    const helperPath = path.join(__dirname, 'helper', 'winhelper.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    try { injector.init(helperPath); }
    catch (e) { bootReport.injector = 'failed: ' + e.message; console.error('[bol] injector init failed', e); }

    createWindows();
    registerIpc();

    try {
      hotkeys.init({
        onPTTDown: () => {
          // Second tap of a tap-toggle capture stops it (duration is now > 350ms,
          // so stopCapture finalizes instead of re-converting).
          if (state === S.LISTENING && current && current.trigger === 'ptt' && current.via === 'tap-toggle') return stopCapture('ptt');
          startCapture('dictate', 'ptt');
        },
        onPTTUp: () => stopCapture('ptt'),
        onToggle: () => { (state === S.IDLE) ? startCapture('dictate', 'toggle') : (state === S.LISTENING && current && current.via === 'toggle' && stopCapture('toggle')); },
        onCommandDown: () => startCapture('command', 'ptt'),
        onCommandUp: () => stopCapture('command'),
      }, config.get().hotkeys);
      bootReport.hotkeys = hotkeys.mode;
      if (process.env.BOL_DEBUG) hotkeys.setDebugSink((line) => log(line));
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

    // Diagnostic: `electron . --capture <png>` renders the dashboard fully wired,
    // saves a screenshot, and exits. Used to verify the UI renders headlessly.
    const capIdx = process.argv.indexOf('--capture');
    if (capIdx !== -1) {
      const outPath = process.argv[capIdx + 1] || 'bol-capture.png';
      wins.app.show(); wins.app.focus();
      const grab = async () => {
        let png = null;
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const img = await wins.app.webContents.capturePage();
            if (img && !img.isEmpty()) { png = img.toPNG(); if (png && png.length > 1000) break; }
          } catch (e) { console.error('capture attempt failed', e.message); }
        }
        if (png && png.length > 1000) { require('fs').writeFileSync(outPath, png); console.log('CAPTURE OK ' + outPath + ' (' + png.length + ' bytes)'); }
        else console.error('CAPTURE FAIL empty image');
        quitting = true; app.exit(png ? 0 : 1);
      };
      if (wins.app.webContents.isLoading()) wins.app.webContents.once('did-finish-load', grab);
      else grab();
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
