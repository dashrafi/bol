// Bol — how the dictation key behaves. Pure decisions, kept out of index.js so
// they can be unit-tested without Electron.
//
//   'hold'      (default) press = start, release = stop. A quick tap latches
//               into hands-free until the next tap (handled in stopCapture).
//   'handsfree' press = start, press again = stop and type it. Release does
//               nothing, so the user can walk away from the keyboard.
'use strict';

const HOLD = 'hold';
const HANDS_FREE = 'handsfree';

// A held key is only a safety net against a stuck key; a hands-free recording is
// the user deliberately talking for a while (Wispr's hands-free cap is 20 min).
const HOLD_CAP_MS = 5 * 60 * 1000;
const HANDS_FREE_CAP_MS = 20 * 60 * 1000;

// While the model downloads or a long recording is transcribed, each progress
// message from the worker buys at least this much more time.
const PROGRESS_GRACE_MS = 2 * 60 * 1000;

function normalizeMode(mode) {
  return mode === HANDS_FREE ? HANDS_FREE : HOLD;
}

// What a dictation-key event should do: 'start' | 'stop' | 'ignore'.
// ctx = { mode, event: 'down'|'up', state, via, trigger }
//   state   orchestrator state ('idle' | 'listening' | 'finalizing' | ...)
//   via     how the live capture started ('ptt' | 'tap-toggle' | 'handsfree' | 'toggle')
//   trigger which key owns the live capture ('ptt' | 'toggle' | 'command')
function keyAction(ctx) {
  const c = ctx || {};
  const ownsCapture = c.state === 'listening' && c.trigger === 'ptt';

  if (normalizeMode(c.mode) === HANDS_FREE) {
    if (c.event !== 'down') return 'ignore';        // releasing the key never stops it
    if (c.state === 'idle') return 'start';
    if (ownsCapture) return 'stop';                 // second press = send
    return 'ignore';                                // busy transcribing, or F10/F8 owns it
  }

  // hold: preserve the original behaviour exactly — stopCapture() applies the
  // tap-latch and owner checks itself.
  if (c.event === 'down') return (ownsCapture && c.via === 'tap-toggle') ? 'stop' : 'start';
  return 'stop';
}

function sessionCapMs(via) {
  return via === 'ptt' ? HOLD_CAP_MS : HANDS_FREE_CAP_MS;
}

// How long transcription may take before the orchestrator gives up. It used to
// be a flat 15 s, which is shorter than on-device Whisper needs for anything
// past about a minute of speech — exactly the recordings hands-free produces.
function finalizeTimeoutMs(recordedMs) {
  const ms = Math.max(0, Number(recordedMs) || 0);
  return Math.min(45 * 60 * 1000, 30000 + Math.round(ms * 1.5));
}

module.exports = {
  HOLD, HANDS_FREE, HOLD_CAP_MS, HANDS_FREE_CAP_MS, PROGRESS_GRACE_MS,
  normalizeMode, keyAction, sessionCapMs, finalizeTimeoutMs,
};
