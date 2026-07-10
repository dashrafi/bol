# Bol — speak anywhere, it types

**Bol** (بول — Urdu: *speak*) is a Windows-first, system-wide AI dictation app: hold a key, talk, release — polished text lands in whatever textbox has focus. Email, Slack, code editor, browser, anywhere.

Wispr-Flow-class, but yours: **bring your own API keys, zero subscription, zero telemetry, and a 100% local/offline mode.**

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
| **Deepgram** (default) | streaming cloud | fastest feel — live partials while you speak |
| **OpenAI-compatible** | batch cloud | works with OpenAI Whisper or Groq (set base URL) |
| **Local Whisper** | on-device | free + offline; first run downloads the model |

Cleanup uses the **Anthropic API** (Claude Haiku) — or the offline regex cleaner in `light` mode.

## Run

```
npm install
npm start
```

First run opens the onboarding wizard (provider + key → hotkeys → mic test). Then Bol lives in the tray.

```
npm test        # unit tests
npm run smoke   # headless boot check
```

## Architecture

Electron, no bundler, plain JS. `src/main/index.js` is the pipeline state machine
(`hotkey ▸ mic ▸ STT stream ▸ Claude polish ▸ SendInput paste`). Text injection via a persistent
PowerShell helper (`SendInput` + clipboard swap). Global hotkeys via `uiohook-napi` (keydown/keyup
push-to-talk). See `CONTRACTS.md` for every module interface.

All data is local JSON in `%APPDATA%/bol` — yours to read, export, or delete.
