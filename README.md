# Bol — speak anywhere, it types

**Bol** (بول — Urdu: *speak*) is a Windows-first, system-wide AI dictation app: hold a key, talk, release — polished text lands in whatever textbox has focus. Email, Slack, code editor, browser, anywhere.

Wispr-Flow-class, but yours: **100% free, zero API keys, zero subscription, zero telemetry — runs entirely on your PC.**

## Free by default — no keys, nothing leaves your machine

Out of the box Bol needs **no API keys and no signup**:

- **Speech-to-text:** **local Whisper** on your PC — 8-bit `whisper-small`, a ~250 MB one-time download, then fully offline. It loads at startup, not in the middle of your first dictation.
- **AI cleanup:** your **local Ollama** if you have it. Bol picks whichever chat model you already have installed and **starts Ollama itself** if it is installed but not running. No Ollama? An instant **offline regex cleaner** takes over. Either way, $0.
- **Roman Urdu / Hindi / Hinglish** is auto-routed to the offline cleaner so it's **never translated** — it comes out exactly as you spoke it.

Want more speed/quality? Optional **free-tier cloud** (Groq for STT + cleanup) or paid providers (Deepgram, Anthropic) are a dropdown away — but never required.

## ⚠️ Your antivirus will probably warn you. Here's why, honestly.

Bol is **unsigned** (a code-signing certificate costs money), and to do its job it must:

- install a **global keyboard hook** — that's how `F9` works in every app
- **inject keystrokes** via `SendInput` from a PowerShell helper — that's how the text lands in your textbox
- **read and write the clipboard** — that's how pasting works

That combination is, behaviourally, indistinguishable from a keylogger, so heuristic scanners flag it. Nothing is infected and nothing phones home — but you should not take that on trust. Instead:

- **Read the source.** It is all here, plain JavaScript, no bundler, no minification, ~7,000 lines.
- **Check the network yourself.** The only outbound requests are the one-time model download and, if *you* configure a cloud provider, that provider. `Local only` mode in Settings hard-blocks even those.
- **Build it yourself** with `npm install && npm run dist` instead of trusting a binary.

Windows SmartScreen will also say "unknown publisher" → **More info → Run anyway**.

## Features

- **Push-to-talk** (default `F9`) — hold while talking, or switch Settings → *How the key works* to **Hands-free**: press once, walk around and talk, press again to send (up to 20 min). A dedicated hands-free toggle (`F10`) is there too — works in any app
- **AI auto-edits** — fillers, false starts, punctuation and capitalization fixed by a local model; raw and light (offline regex) modes too
- **Tone matching** — formal in Outlook, casual in Slack; per-app rules you control + custom instructions
- **Command mode** (`F8`) — select text, hold, say *"make this more polite"* / *"bullet these"* — voice-edits in place; with nothing selected it generates
- **Personal dictionary** — names/jargon spelled right, fed to the STT engine and the AI; auto-suggests from your history
- **Snippets** — say *"insert address"*, full text expands
- **Multilingual + code-switching** — Urdu/Hindi/Hinglish preserved exactly as spoken, never force-translated; auto language detect
- **Whisper mode** — speak quietly, input gain boosted
- **Live HUD** — floating pill with waveform + streaming transcript; click to cancel
- **History & analytics** — searchable dictations, words/WPM/minutes-saved/streak, top apps
- **Privacy switch** — `Local only` forces on-device Whisper + offline cleanup; nothing leaves the machine

## STT providers (pick in Settings)

| Provider | Type | Notes |
|---|---|---|
| **Local Whisper** (default) | on-device | **free, no key, offline**; ~250 MB one-time download, 8-bit weights (~1.3 GB RAM) |
| **Groq / OpenAI** | batch cloud | Groq **free tier** (`whisper-large-v3-turbo`) or OpenAI (set base URL) |
| **Deepgram** | streaming cloud | fastest feel — live partials while you speak (paid key) |

## Cleanup engines (pick in Settings)

| Engine | Type | Notes |
|---|---|---|
| **Ollama** (default) | local LLM | **free, no key**, runs on your PC. Bol auto-detects your best installed model and starts Ollama if it is idle |
| **Offline cleaner** | regex | automatic fallback if Ollama isn't running — zero deps, instant |
| **Free cloud** | OpenAI-compatible | Groq (free tier) or Gemini / OpenAI (needs that free/paid key) |
| **Anthropic** | Claude | optional, paid — not required |

Code-switched speech (Roman Urdu / Hinglish) always uses the offline cleaner so it's never translated.

## Run

```
npm install
npm start
```

First run opens the onboarding wizard — with the defaults you just click through it (no keys). Then Bol lives in the tray.

For the best free cleanup, install [Ollama](https://ollama.com) and pull any chat model (`ollama pull qwen2.5:7b`). Bol finds whichever model you have and starts the server itself when it is idle. If Ollama isn't installed at all, the offline cleaner takes over automatically.

```
npm test         # unit tests
npm run smoke    # headless boot check
npm run dist     # build the Windows installer into dist/
```

Diagnostics (no Electron needed):

```
node src/main/stt/localWorker.js --file clip.wav --prompt "Bol, Wispr Flow"
node test/bench-stt.js clip.wav --dtype q8 --runs 2
```

## Architecture

Electron, no bundler, plain JS. `src/main/index.js` is the pipeline state machine
(`hotkey ▸ mic ▸ STT (local Whisper / cloud) ▸ cleanup (Ollama / offline / cloud) ▸ SendInput paste`).
The AI layer (`src/main/llm.js`) speaks OpenAI-compatible (Ollama/Groq/Gemini/OpenAI) and Anthropic.
Text injection via a persistent PowerShell helper (`SendInput` + clipboard swap). Global hotkeys via
`uiohook-napi` (keydown/keyup push-to-talk). See `CONTRACTS.md` for every module interface.

All data is local JSON in `%APPDATA%/bol` — yours to read, export, or delete.
