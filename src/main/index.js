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
const pttMode = require('./pttMode');

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

// Which cleanup actually ran, recorded per dictation so "why wasn't my text
// tidied up?" has an answer instead of a guess. 'ai' | 'offline' | a reason.
function cleanupLabel(polished) {
  if (!polished) return '';
  if (polished.usedAI) return 'ai';
  return polished.reason ? String(polished.reason) : 'offline';
}

// Load the local Whisper model and the local cleanup model before they are
// needed. Called at boot and again on hotkey-down, so the model load overlaps
// with the user speaking instead of being paid after they stop. Never throws.
function warmModels(reason) {
  const cfg = effectiveConfig();
  try { stt.warm(cfg); } catch (e) { log('stt warm failed', e.message); }
  Promise.resolve()
    .then(() => cleanup.warm(cfg))
    .then((r) => { if (r && r.ok && !r.cached) log('cleanup model warm (' + reason + '):', r.model); },
          (e) => log('cleanup warm failed', e && e.message));
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
  // Both models load WHILE the user talks, so the wait after release is just
  // inference. This is also what starts Ollama when it is installed but idle.
  warmModels('hotkey');

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
      onPartial: (text) => {
        if (!current || current.session !== sess) return;
        if (state === S.LISTENING) return hudSend({ state: 'listening', partial: text });
        // After the key is released these are worker progress messages
        // ("Downloading model… 40%", "Transcribing…"). Keep the HUD on its
        // transcribing pill — flipping back to the red listening pill made it look
        // like it was still recording — and give a live job more time.
        hudSend({ state: 'transcribing', message: text });
        if (state === S.FINALIZING && (current.finalizeDeadline || 0) - Date.now() < pttMode.PROGRESS_GRACE_MS) {
          armFinalizeWatchdog(sess, pttMode.PROGRESS_GRACE_MS);
        }
      },
      onFinal: (text) => onFinal(sess, text),
      onError: (err) => onPipelineError(sess, err),
    });
  } catch (e) { return onPipelineError(null, e); }

  current = { session: sess, mode, via, trigger, app: target.exe, title: target.title, elevated: !!target.elevated, startTs: Date.now(), chunks: 0, maxLevel: preMaxLevel, warned: false };

  // The standing HUD line for this recording. Windows (UIPI) blocks a normal app
  // from typing into an elevated window, so that is said NOW rather than after the
  // user has finished dictating into a void; otherwise hands-free says how to send.
  const keyLabel = (cfg.hotkeys.pushToTalk && cfg.hotkeys.pushToTalk.label) || 'F9';
  if (target.elevated) current.hint = 'Admin window — Bol will copy the text for you to paste';
  else if (via === 'handsfree') current.hint = 'Recording — press ' + keyLabel + ' again to send';
  if (current.hint) hudSend({ state: 'listening', message: current.hint });

  // EARLY mic check — tell the user within ~1.2s that nothing is being heard,
  // instead of letting them talk for a minute and only finding out at the end.
  // Re-checks every second so the warning clears the moment audio appears.
  const watched = current;
  const micWatch = setInterval(() => {
    if (state !== S.LISTENING || current !== watched) return clearInterval(micWatch);
    if ((watched.maxLevel || 0) < 0.02) {
      watched.warned = true;
      hudSend({ state: 'listening', message: '⚠ Not hearing you — check your mic (Settings)' });
    } else if (watched.warned) {
      watched.warned = 'recovered';
      hudSend({ state: 'listening', message: watched.hint || '' });
    }
  }, 1200);
  // Hand the buffered first words to the session in order.
  for (const b of preBuffer) { current.chunks++; try { sess.feed(b); } catch {} }
  preBuffer = [];
  // Safety net: a session auto-finalizes instead of holding the mic open forever —
  // 5 min for a held key (a stuck key), 20 min once it is hands-free. A hold that
  // turns into a tap-latch mid-way gets the longer limit when the timer fires.
  const guarded = current;
  const capGuard = () => {
    if (state !== S.LISTENING || current !== guarded) return;
    const left = pttMode.sessionCapMs(guarded.via) - (Date.now() - guarded.startTs);
    if (left > 1000) { setTimeout(capGuard, left); return; }
    log('max session length reached — auto-stopping');
    stopCapture();
  };
  setTimeout(capGuard, pttMode.sessionCapMs(via));
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
    if (!current.elevated) current.hint = 'Recording — tap again to stop';
    hudSend({ state: 'listening', message: current.hint });
    return;
  }
  log('FINALIZING, chunks fed =', current.chunks, 'maxLevel =', (current.maxLevel || 0).toFixed(3));
  state = S.FINALIZING;
  tray.setState('busy');
  recorderSend('rec:stop');
  hudSend({ state: 'transcribing' });
  const sess = current.session;
  const recordedMs = Date.now() - current.startTs;
  // Arm before end(): a provider that fails synchronously clears `current`, and
  // the arm is then a no-op.
  armFinalizeWatchdog(sess, pttMode.finalizeTimeoutMs(recordedMs));
  try { sess.end(); } catch (e) { onPipelineError(sess, e); }
}

// Unsticks FINALIZING if the provider never answers. Sized to the recording (a
// flat 15 s used to kill any on-device transcription longer than about a minute
// of speech) and pushed back while the worker is still reporting progress.
function armFinalizeWatchdog(sess, ms) {
  if (!current || current.session !== sess) return;
  if (current.finalizeTimer) clearTimeout(current.finalizeTimer);
  current.finalizeDeadline = Date.now() + ms;
  current.finalizeTimer = setTimeout(() => {
    if (current && current.session === sess && state === S.FINALIZING) onPipelineError(sess, new Error('Transcription timed out'));
  }, ms);
}

// Routes the dictation key through the user's chosen mode (Settings → "How the
// key works").
function dictationKey(event) {
  const mode = pttMode.normalizeMode(config.get().ui && config.get().ui.dictationMode);
  const action = pttMode.keyAction({
    mode, event, state,
    via: current ? current.via : null,
    trigger: current ? current.trigger : startingTrigger,
  });
  if (action === 'start') startCapture('dictate', mode === pttMode.HANDS_FREE ? 'handsfree' : 'ptt');
  else if (action === 'stop') stopCapture('ptt');
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
  // BOL_DEBUG only: keep the exact audio the recogniser heard, so a bad
  // transcription can be reproduced and A/B tested offline instead of guessed at.
  if (process.env.BOL_DEBUG && ctx.pcm && ctx.pcm.length) {
    try {
      const wav = require('./stt/wav').pcm16ToWav(ctx.pcm, 16000);
      const p = path.join(app.getPath('userData'), 'last-dictation.wav');
      require('fs').writeFileSync(p, wav);
      log('audio saved for debugging:', p, wav.length, 'bytes');
    } catch (e) { log('wav dump failed', e.message); }
  }

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
    // Insertion must NEVER lose the dictation. An elevated target is skipped
    // outright (UIPI discards the keystrokes), and if both paste and typing are
    // refused the text goes to the clipboard so Ctrl+V still recovers it.
    let inserted = false;
    if (!ctx.elevated) {
      try { await injector.paste(text); inserted = true; log('PASTED', text.length, 'chars into', ctx.app); }
      catch (e1) {
        log('paste failed, typing fallback', e1.message);
        try { await injector.typeText(text); inserted = true; }
        catch (e2) { log('type failed too', e2.message); }
      }
    }
    if (!inserted) { try { clipboard.writeText(text); } catch (e) { log('clipboard write failed', e.message); } }

    if (config.get().privacy.storeHistory) {
      store.history.add({ raw, polished: text, app: ctx.app, title: ctx.title, durationMs, provider: cfg.stt.provider, cleanup: cleanupLabel(polished), inserted });
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    analytics.record({ words: wordCount, durationMs, app: ctx.app });
    state = S.IDLE; tray.setState('idle');

    if (!inserted) {
      hudSend({ state: 'error', message: ctx.elevated
        ? 'That window runs as administrator — copied instead, press Ctrl+V'
        : "Couldn't type here — copied instead, press Ctrl+V" });
      setTimeout(() => hudSend({ state: 'idle' }), 4000);
      return;
    }

    // Partial-capture note. The LIVE warning above is the primary signal (it fires
    // ~1.2s in, while the user can still react); this only covers the case where
    // audio was present but speech still came out sparse, and is skipped entirely
    // if the user was already warned during the recording.
    const secs = durationMs / 1000;
    const sparse = secs > 5 && (wordCount / secs) < 0.8;
    if (sparse && !ctx.warned) {
      log('sparse-speech note: words/s =', (wordCount / secs).toFixed(2), 'maxLevel =', (ctx.maxLevel || 0).toFixed(3));
      hudSend({ state: 'error', message: 'Only caught part of that — try speaking a little closer' });
      setTimeout(() => hudSend({ state: 'idle' }), 3000);
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
  // Which device the probe verified as actually producing audio.
  ipcMain.on('mic:picked', (e, info) => log('mic verified:', (info && info.label) || '?', 'peak=' + ((info && info.peak) || 0)));
  // A session came back as digital silence: the recorder has already dropped that
  // device and re-probed, so just record it.
  ipcMain.on('audio:silent', (e, info) => log('SILENT session on device', (info && info.deviceId) || '(default)', '— re-probing mics'));
  // The saved microphone no longer exists (e.g. a Bluetooth headset that left
  // Hands-Free mode). Clear it so Settings stops pointing at a missing device and
  // Bol goes back to auto-picking a verified one.
  ipcMain.on('mic:stale', (e, info) => {
    const id = info && info.deviceId;
    if (!id || config.get().mic.deviceId !== id) return;
    log('saved mic is gone — reverting to auto-select');
    config.set({ mic: { deviceId: 'default' } });
    broadcast('settings:changed', config.get());
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
      const chunk = Buffer.from(buf);
      if (process.env.BOL_DEBUG) { if (!current.pcm) current.pcm = []; current.pcm.push(chunk); }
      try { current.session.feed(chunk); } catch (err) { log('feed error', err.message); }
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
        // Hold mode: press starts, release stops, a quick tap latches (second tap
        // stops). Hands-free mode: press starts, press again sends. See pttMode.js.
        onPTTDown: () => dictationKey('down'),
        onPTTUp: () => dictationKey('up'),
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

    // Warm both models shortly after boot: on a fresh install this is what pulls
    // the Whisper model down in the background instead of inside the user's
    // first dictation, and it starts Ollama if it is installed but not running.
    if (!SMOKE) setTimeout(() => warmModels('boot'), 4000);

    if (SMOKE) {
      const mods = Object.entries(bootReport).map(([k, v]) => `${k}=${v}`).join(' ');
      setTimeout(() => { console.log(`SMOKE OK modules: ${mods} state=${state}`); quitting = true; app.exit(0); }, 2500);
      return;
    }

    // Diagnostic: `Bol.exe --transcribe <file.wav>` runs a wav through the REAL
    // configured STT path and prints the transcript. This is how a PACKAGED build
    // is proven to still transcribe — reading the package can't show that, and the
    // native ONNX binaries only resolve correctly inside the app's own asar.
    const trIdx = process.argv.indexOf('--transcribe');
    if (trIdx !== -1) {
      const file = process.argv[trIdx + 1];
      const started = Date.now();
      try {
        const { wavToPcm16 } = require('./stt/wav');
        const { pcm, sampleRate, channels } = wavToPcm16(require('fs').readFileSync(file));
        if (sampleRate !== 16000 || channels !== 1) console.error(`WARN wav is ${sampleRate} Hz / ${channels} ch; the pipeline feeds 16 kHz mono`);
        const dict = store.dictionary.list().map((d) => d.word);
        const cfg = effectiveConfig();
        console.log(`TRANSCRIBE start provider=${cfg.stt.provider} model=${cfg.stt.localModel} bytes=${pcm.length} dict=${dict.length}`);
        const sess = stt.createSession(cfg, dict, {
          onPartial: (m) => console.error('[progress] ' + m),
          onFinal: (text) => { console.log('TRANSCRIBE OK ' + (Date.now() - started) + 'ms rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB'); console.log('TEXT: ' + text); quitting = true; app.exit(0); },
          onError: (e) => { console.error('TRANSCRIBE FAIL ' + (e && e.message)); quitting = true; app.exit(1); },
        });
        sess.feed(pcm);
        sess.end();
      } catch (e) {
        console.error('TRANSCRIBE FAIL ' + (e && e.message));
        quitting = true; app.exit(1);
      }
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
      // Optional QA: `--exec "<js>"` runs JS in the dashboard renderer before the
      // capture (used to drive UI flows automatically) and prints its result.
      const execIdx = process.argv.indexOf('--exec');
      const execFileIdx = process.argv.indexOf('--exec-file'); // avoids shell quoting mangling
      let execJs = execIdx !== -1 ? process.argv[execIdx + 1] : null;
      if (execFileIdx !== -1) {
        try { execJs = require('fs').readFileSync(process.argv[execFileIdx + 1], 'utf8'); }
        catch (e) { console.error('EXEC FILE READ FAIL: ' + e.message); }
      }
      const run = async () => {
        if (execJs) {
          await new Promise((r) => setTimeout(r, 2500));
          try { console.log('EXEC RESULT: ' + JSON.stringify(await wins.app.webContents.executeJavaScript(execJs, true))); }
          catch (e) { console.error('EXEC FAIL: ' + e.message); }
        }
        await grab();
      };
      if (wins.app.webContents.isLoading()) wins.app.webContents.once('did-finish-load', run);
      else run();
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
