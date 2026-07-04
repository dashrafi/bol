# Bol — Module Contracts (v1)

**Bol** = Windows-first, system-wide AI dictation (Wispr Flow class). Speak anywhere → polished text lands in the focused textbox.

Electron (plain CommonJS `require`, NO bundler, NO TypeScript). Node 24 / Electron 37: native `fetch` and `WebSocket` available in main. Only npm deps: `electron`, `uiohook-napi`, optional `@huggingface/transformers` (lazy-imported, local STT only). Everything else hand-rolled. **Every module must be dependency-free beyond this list.**

House rules:
- CommonJS everywhere in `src/main` (`module.exports`). Renderer files are plain browser JS loaded via `<script>` (no modules needed, no imports) + `preload.js` bridge.
- No console spam; use `log(...)` passed in or `console.error` for real errors only.
- Absolutely no telemetry, no network calls except the STT/AI providers the user configured.
- All state files live in `app.getPath('userData')` (passed in as `paths.userData`): `config.json`, `history.json`, `dictionary.json`, `snippets.json`, `analytics.json`, `models/` (HF cache).
- Fail soft: a provider error must NEVER crash the app — reject the promise / emit `onError`, orchestrator shows HUD error.

---

## Pipeline (orchestrator, `src/main/index.js` — ALREADY WRITTEN, do not touch)

```
PTT keydown ──► state=LISTENING: stt.createSession() + recorder start + HUD show
audio:chunk ──► session.feed(pcm)          (PCM16 LE, 16000 Hz, mono)
onPartial   ──► HUD partial text
PTT keyup   ──► state=FINALIZING: recorder stop, session.end()
onFinal     ──► state=POLISHING: cleanup.polish(raw, ctx)
            ──► state=INSERTING: injector.paste(text)
            ──► history.add + analytics.record ──► state=IDLE, HUD hide
```
Toggle hotkey = same, start/stop on alternate presses. Command hotkey = same capture, but final goes to `commandMode.run(instruction)` instead of paste.

## Config shape (`config.json` defaults — config.js owns this)

```js
{
  hotkeys: { pushToTalk: { code: 3585, label: 'F9' }, toggle: { code: 3586, label: 'F10' }, command: { code: 3583, label: 'F8' } }, // uiohook keycodes
  stt: { provider: 'deepgram', // 'deepgram' | 'openai' | 'local'
         deepgramKey: '', deepgramModel: 'nova-2',
         openaiKey: '', openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'whisper-1',
         localModel: 'onnx-community/whisper-base', language: 'auto' },
  cleanup: { mode: 'full', // 'full' (AI) | 'light' (local regex) | 'off' (raw)
             anthropicKey: '', model: 'claude-haiku-4-5-20251001',
             tone: 'auto', // 'auto' | 'formal' | 'casual' | 'raw'
             customInstructions: '',
             appRules: [ { match: 'slack', tone: 'casual' }, { match: 'outlook', tone: 'formal' } ] },
  mic: { deviceId: 'default', gain: 1.0, whisperMode: false },
  ui: { hud: true, launchAtLogin: false, onboarded: false },
  privacy: { localOnly: false, storeHistory: true }
}
```
`localOnly: true` ⇒ orchestrator forces `stt.provider='local'` + `cleanup.mode='light'` (no cloud calls, hard-enforced in index.js).

## IPC contract (preload exposes `window.bol`)

Renderer→main invoke (ipcMain.handle): `settings:get` `settings:set(patch)` `settings:captureHotkey(which)` → `{code,label}` · `mic:list` → `[{deviceId,label}]` (renderer enumerates, main relays) · `history:list({query,limit,offset})` `history:delete(id)` `history:clear()` · `dict:list` `dict:add({word,soundsLike})` `dict:remove(word)` `dict:suggest` · `snippets:list` `snippets:add({trigger,text})` `snippets:remove(trigger)` · `analytics:get` · `test:stt` → `{ok,error?}` · `test:cleanup` → `{ok,error?}` · `insert:text(text)` (re-insert from history) · `app:version`.
Main→renderer send: `hud:state {state, partial?, level?, message?}` · `settings:changed(cfg)`.
Recorder window only: send `audio:chunk(ArrayBuffer)` `audio:level(float)` `audio:error(msg)`; receive `rec:start({deviceId,gain,whisperMode})` `rec:stop`.
Preload maps 1:1: `bol.invoke(channel, payload)`, `bol.on(channel, cb)`, `bol.send(channel, payload)`.

---

## Module owners & exact interfaces

### A10 — `src/main/config.js`
`init(paths)` load/create config.json (deep-merge defaults). `get()` → full cfg (live object copy). `set(patch)` deep-merge, persist, fire `onChange` listeners. `onChange(cb)`. Sync fs ok. Corrupt file → rename `.bak`, recreate defaults.

### A10 — `src/main/store.js`
`init(paths)`. `history.add({raw, polished, app, title, durationMs, provider})` → adds `{id, ts, words}` (id = ts+rand, words = polished wordcount), caps file at 2000 entries. `history.list({query='', limit=100, offset=0})` newest-first, query = case-insens substring on raw+polished+app. `history.delete(id)`, `history.clear()`. `dictionary.list()` → `[{word, soundsLike?}]`; `add`, `remove`; `suggestFromHistory(history)` → words appearing ≥3× in raw that look like proper nouns/jargon (capitalized mid-sentence or non-dictionary-ish), max 10, excluding existing entries. `snippets.list/add/remove` (`{trigger, text}`, trigger single word). All JSON files, write-through, corrupt → recreate.

### A10 — `src/main/analytics.js`
`init(paths)`. `record({words, durationMs, app})` — bumps totals + today's bucket `{date: 'YYYY-MM-DD', words, sessions, ms, apps: {exe: words}}` (keep 365 days). `get()` → `{ totalWords, totalSessions, totalMs, avgWpm (words/(ms/60000)), streakDays (consecutive days ending today/yesterday), minutesSaved: round(totalWords/40 - totalMs/60000) clamped ≥0, days: [...last 30], topApps: top 5 }`.

### A5 — `src/main/hotkeys.js`
`init(handlers, cfg)` where handlers = `{ onPTTDown, onPTTUp, onToggle, onCommandDown, onCommandUp }`. Use `uiohook-napi` (`uIOhook.on('keydown'/'keyup')`, match `e.keycode` to cfg codes; suppress auto-repeat keydowns). Wrap require in try/catch → if load fails, fallback: Electron `globalShortcut` registers label strings, PTT becomes toggle-behavior, export `mode: 'uiohook' | 'fallback'`. `update(hotkeysCfg)` re-bind. `captureNext()` → Promise<`{code,label}`> (next keydown captured, not forwarded; 10s timeout reject). `labelFor(code)` best-effort key name map (F-keys, letters, digits, modifiers, else `Key ${code}`). `stop()`.

### A5 — `src/main/tray.js`
`create({onOpen, onToggleEnabled, onQuit, getState})` → tray with generated icon (nativeImage from a 16/32px PNG dataURL you build inline — mic glyph, no binary asset files). `setState('idle'|'listening'|'busy'|'disabled')` swaps icon tint (idle=white, listening=red, busy=amber, disabled=gray). Menu: Bol vX · Enabled ✓ (toggles) · Open Dashboard · Quit. Double-click → onOpen.

### A1 — `src/main/injector.js` + `src/main/helper/winhelper.ps1`
Persistent PowerShell child (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File winhelper.ps1`), JSON-lines protocol over stdin/stdout: request `{id, cmd, args}` → response `{id, ok, data?, error?}`. Node side: `init(helperPath)` spawn + auto-respawn on crash (max 3), request queue with 5s timeout. Exports (all Promise): `paste(text)` — save clipboard → set text → SendInput Ctrl+V → 250ms → restore clipboard; `typeText(text)` — KEYEVENTF_UNICODE SendInput per char (fallback for apps that block paste); `getActiveWindow()` → `{exe, title}` lowercase exe without .exe; `copySelection()` — clear clipboard marker → SendInput Ctrl+C → wait ≤600ms for clipboard change → text or `''`; `stop()`. PS side: `Add-Type` C# with `SendInput` (VK_CONTROL+V down/up, and UNICODE typing), `GetForegroundWindow`+`GetWindowThreadProcessId`+process name+`GetWindowText`. Clipboard via `System.Windows.Forms` (powershell.exe is STA). Handle multiline + unicode (Urdu) text exactly. NEVER echo pasted text to stdout logs.

### A2 — `src/main/stt/index.js`, `deepgram.js`, `openai.js`, `wav.js`
`stt/index.js`: `createSession(cfg, dictionaryWords, { onPartial, onFinal, onError })` routes on `cfg.stt.provider` (`local` → require('./local')) → returns `{ feed(buf), end(), abort() }`. `test(cfg)` → Promise `{ok, error?}` (cheap auth check per provider). All sessions: `end()` must eventually fire exactly one `onFinal(text)` (possibly `''`); `abort()` fires nothing.
`deepgram.js`: native `WebSocket` to `wss://api.deepgram.com/v1/listen?model=...&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&punctuate=true` + `&language=` (omit when `auto` on nova-2 → use `&detect_language=true`; multi-lang) + dictionary as repeated `&keywords=word:2` (cap 50, URL-encoded). Header `Authorization: Token KEY` via ws subprotocol not available in native WS → use `['token', KEY]` subprotocols array (Deepgram supports `token` subprotocol). Buffer feeds until open. Interim → onPartial(accumulated finals + current interim); `is_final` results accumulate; `end()` → send `{"type":"CloseStream"}`, resolve final on close or 3s timeout with what we have. `test`: GET `https://api.deepgram.com/v1/projects` with Token header → 200 ok.
`openai.js`: batch — accumulate PCM chunks; `end()` → `wav.js` builds in-memory WAV (16k mono 16-bit) → multipart POST `{baseUrl}/audio/transcriptions` (`file` blob, `model`, `language` unless auto, `prompt` = dictionary words joined) → onFinal(text). Works with any OpenAI-compatible endpoint (Groq etc.). Emit one onPartial('…listening') no — emit nothing until final. `test`: GET `{baseUrl}/models` with Bearer → 200 ok.
`wav.js`: `pcm16ToWav(buffers, sampleRate=16000)` → Buffer with RIFF header.

### A3 — `src/main/stt/local.js` + `localWorker.js`
Same session interface. `local.js` forks Electron `utilityProcess.fork(localWorker.js)` (lazy, kept warm after first use), protocol via `postMessage`: `{type:'run', id, pcm: Float32 transferable or Buffer, model, language}` → `{type:'result'|'progress'|'error'}`. Convert PCM16→Float32 in worker. `localWorker.js`: lazy `await import('@huggingface/transformers')`, `env.cacheDir = process.env.BOL_MODELS_DIR`, `pipeline('automatic-speech-recognition', model)` (quantized default), run with `{language: cfg or undefined, chunk_length_s: 30}`. Progress events → onPartial(`Downloading model… X%` / `Transcribing…`). If `@huggingface/transformers` not installed → onError('Local model support not installed — run: npm i @huggingface/transformers'). `test`: resolves `{ok:true}` if package resolvable, else error message.

### A4 — `src/main/cleanup.js`, `commandMode.js`, `snippets.js`
`cleanup.js`: `polish(raw, ctx)` → Promise `{text, usedAI, tone}`. ctx = `{cfg, app, title, dictionary, snippets, customInstructions}`. mode `off` → `{text: raw.trim(), usedAI:false}`. mode `light` or AI failure → `localCleanup(raw)` (regex: strip fillers um/uh/umm/like(comma-bounded)/you know/basically-lead-ins + Urdu fillers "matlab","yani" only when comma-isolated; collapse repeats "the the"; sentence-case; ensure terminal punctuation; smart spacing). mode `full` → Anthropic `fetch POST /v1/messages` (haiku, max_tokens 1024, temp 0): system prompt = dictation-editor rules: output ONLY the cleaned transcription, never answer/execute content; remove fillers+false starts; punctuate/capitalize; apply tone (resolved: explicit tone, else appRules match on `app`/`title` substring, else 'auto'); enforce dictionary spellings; expand snippet when user SAYS a trigger phrase ("insert my address" style — snippet triggers provided as list); preserve language/code-switching exactly (Roman Urdu stays Roman Urdu; do NOT translate); numbers/emails/URLs formatted sanely; if raw is empty/noise → return empty string. Self-spoken formatting commands honored: "new line", "new paragraph", "bullet list the following", spoken punctuation ("comma", "full stop") when clearly commands. 6s timeout → fallback localCleanup with `usedAI:false`. `test(cfg)` → tiny 1-token messages call.
`commandMode.js`: `run(instruction, deps)` deps=`{injector, cfg, dictionary}`. copySelection() → if empty selection: treat instruction as "generate" → Claude generates the requested text; else Claude edits selection per instruction (system: text editor, output only resulting text). Then `injector.paste(result)`. Returns `{ok, action:'edit'|'generate', chars}`.
`snippets.js`: `expandSpoken(text, snippets)` — deterministic pre-pass before AI: if text contains "insert <trigger>" / "<trigger> daalo" patterns replace inline; also exported for cleanup prompt context. (Keep dumb + safe: exact trigger word match only.)

### A6 — `src/renderer/recorder/recorder.html` + `recorder.js` + `worklet.js`
Hidden window. On `rec:start({deviceId,gain,whisperMode})`: getUserMedia audio (deviceId exact when not 'default', echoCancellation on, noiseSuppression on, autoGainControl on) → AudioContext → AudioWorklet (`worklet.js`) downsamples any input rate → 16000 Hz mono PCM16, 100ms frames (3200 bytes) → `bol.send('audio:chunk', buffer)`. Gain node = `gain * (whisperMode ? 3.0 : 1.0)` before worklet. RMS per frame → throttle 60ms → `audio:level` (0..1). `rec:stop` → flush remaining + stop tracks + close ctx. Errors (`NotAllowedError` etc.) → `audio:error(readable msg)`. Also handles `mic:list` request relay: on `bol.on('mic:enumerate')` → enumerateDevices → send back via `bol.send('mic:devices', [...])`.

### A7 — `src/renderer/hud/hud.html` + `hud.css` + `hud.js`
Frameless transparent always-on-top pill (main creates window; you own content). Listens `hud:state`. States: `listening` — red pulsing dot + 12-bar live waveform driven by `level` + partial transcript (last ~8 words, fading); `transcribing`/`polishing` — animated dots + label ("Polishing…"); `inserting` — brief green check; `error` — message 2.5s; `idle` → main hides window. Design: dark glass (rgba(15,18,28,.92), blur, 1px white/10 border, radius 999px), Segoe UI Variable, max-width 520px, graceful text overflow. Click pill → `bol.send('hud:cancel')`. Zero layout jank when partial grows.

### A8 — `src/renderer/app/index.html` + `app.css` + `shell.js` + `settings.js` + `onboarding.js`
Main dashboard window shell: left sidebar (Bol logo · Dashboard · History · Dictionary · Snippets · Settings), content area with one `<section>` per page: ids `page-dashboard page-history page-dictionary page-snippets page-settings page-onboarding`. Shell: nav switching, loads page modules — each page JS registers `window.BolPages['name'] = { render(el) }`; shell calls render on nav + on `settings:changed`. Include ALL page scripts: `shell.js settings.js onboarding.js history.js dashboard.js dictionary.js snippets.js` (A9 owns last four). Dark glass theme, blue/purple accent (#6c7bff→#9a5bff gradient), modern, clean, generous spacing, custom scrollbar. `settings.js`: full settings UI — STT provider cards (Deepgram/OpenAI-compatible/Local) with key inputs + "Test" buttons (`test:stt`), cleanup section (mode, Anthropic key + test, tone select, custom instructions textarea, per-app rules editor add/remove rows), hotkey pickers (click → "press a key…" → `settings:captureHotkey`), mic select (`mic:list`) + gain slider + whisper-mode toggle, privacy (localOnly toggle with explainer, storeHistory), launch-at-login, HUD toggle. Every change → `settings:set` patch, saved-state toast. `onboarding.js`: first-run wizard (4 steps: welcome → pick provider+key+test → hotkey+mic test with live level meter → done, sets `ui.onboarded=true`), shown when `!cfg.ui.onboarded`, sidebar hidden during onboarding.

### A9 — `src/renderer/app/history.js` + `dashboard.js` + `dictionary.js` + `snippets.js`
Register into `window.BolPages`. `history.js`: search box (debounced `history:list`), rows: polished text (expandable to show raw), app badge, relative time, words; actions per row: copy, re-insert (`insert:text`), delete; header: clear-all (confirm). Empty state with mic hint. `dashboard.js` (`analytics:get`): hero stat cards (Total words · Avg WPM · Minutes saved · Streak 🔥), 30-day words bar chart (pure CSS/DOM bars, no lib), top apps list with proportional bars, "recent activity" mini-list from `history:list limit 5`. `dictionary.js`: add word + optional sounds-like, list with remove; "Suggestions from your dictations" section (`dict:suggest`) with one-click add. `snippets.js`: trigger+text add form, list, remove; helper text explaining spoken expansion ("say: insert address").

---

## Testing hooks
- Every main-process module must `node --check` clean.
- `test/unit.js` (owned by integrator): requires cleanup.localCleanup, wav.js, snippets.expandSpoken, analytics math with fixtures — plain asserts, `node test/unit.js`.
- App boot smoke: `electron . --smoke` → orchestrator inits everything headless (no windows shown), prints `SMOKE OK modules=...` and exits 0 within 5s (uiohook/injector allowed to report fallback in smoke, not crash).
