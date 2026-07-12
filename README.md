# Bol — speak anywhere, it types

**Bol** (بول — Urdu: *speak*) is a Windows-first, system-wide AI dictation app: hold a key, talk, release — polished text lands in whatever textbox has focus. Email, Slack, code editor, browser, anywhere.

Wispr-Flow-class, but yours: **100% free, zero API keys, zero subscription, zero telemetry — runs entirely on your PC.**

## Free by default — no keys, nothing leaves your machine

Out of the box Bol needs **no API keys and no signup**:

- **Speech-to-text:** **local Whisper** on your PC (downloads a ~75MB model once, then fully offline).
- **AI cleanup:** your **local Ollama** (`ollama pull qwen2.5:3b`) if it's running; otherwise an instant **offline regex cleaner**. Either way, $0.
- **Roman Urdu / Hindi / Hinglish** is auto-routed to the offline cleaner so it's **never translated** — it comes out exactly as you spoke it.

Want more speed/quality? Optional **free-tier cloud** (Groq for STT + cleanup) or paid providers (Deepgram, Anthropic) are a dropdown away — but never required.

## Features

- **Push-to-talk** (default `F9`) + **hands-free toggle** (`F10`) — works in any app
- **AI auto-edits** — fillers, false starts, punctuation, capitalization fixed by Claude; raw and light (offline regex) modes too
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
| **Local Whisper** (default) | on-device | **free, no key, offline**; first run downloads the model |
| **Groq / OpenAI** | batch cloud | Groq **free tier** (`whisper-large-v3-turbo`) or OpenAI (set base URL) |
| **Deepgram** | streaming cloud | fastest feel — live partials while you speak (paid key) |

## Cleanup engines (pick in Settings)

| Engine | Type | Notes |
|---|---|---|
| **Ollama** (default) | local LLM | **free, no key**, runs on your PC; `ollama pull qwen2.5:3b` |
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

For the best free cleanup, install [Ollama](https://ollama.com) and run `ollama pull qwen2.5:3b` before first use. If Ollama isn't present, Bol falls back to the offline cleaner automatically.

```
npm test        # unit tests
npm run smoke   # headless boot check
```

## Architecture

Electron, no bundler, plain JS. `src/main/index.js` is the pipeline state machine
(`hotkey ▸ mic ▸ STT (local Whisper / cloud) ▸ cleanup (Ollama / offline / cloud) ▸ SendInput paste`).
The AI layer (`src/main/llm.js`) speaks OpenAI-compatible (Ollama/Groq/Gemini/OpenAI) and Anthropic.
Text injection via a persistent PowerShell helper (`SendInput` + clipboard swap). Global hotkeys via
`uiohook-napi` (keydown/keyup push-to-talk). See `CONTRACTS.md` for every module interface.

All data is local JSON in `%APPDATA%/bol` — yours to read, export, or delete.
