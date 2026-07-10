// Bol — analytics.js (A10). Per-day usage buckets in analytics.json.
// Local-time YYYY-MM-DD keys, 365-day retention, derived stats in get().
'use strict';

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 365;
const WINDOW_DAYS = 30;
const TYPING_WPM = 40; // baseline typing speed for minutesSaved

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let file = null; // absolute path to analytics.json (null before init)
let data = null; // { totalWords, totalSessions, totalMs, days: { 'YYYY-MM-DD': bucket } }
// bucket = { date, words, sessions, ms, apps: { exe: words } }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

function emptyData() {
  return { totalWords: 0, totalSessions: 0, totalMs: 0, days: {} };
}

function sanitizeBucket(key, raw) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const apps = {};
  if (b.apps && typeof b.apps === 'object' && !Array.isArray(b.apps)) {
    for (const exe of Object.keys(b.apps)) {
      const w = toCount(b.apps[exe]);
      if (exe && w > 0) apps[exe] = w;
    }
  }
  return {
    date: key,
    words: toCount(b.words),
    sessions: toCount(b.sessions),
    ms: toCount(b.ms),
    apps,
  };
}

function sanitize(parsed) {
  const out = emptyData();
  if (!parsed || typeof parsed !== 'object') return out;
  out.totalWords = toCount(parsed.totalWords);
  out.totalSessions = toCount(parsed.totalSessions);
  out.totalMs = toCount(parsed.totalMs);
  const days = parsed.days;
  const isDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k);
  if (Array.isArray(days)) {
    for (const b of days) {
      if (b && typeof b.date === 'string' && isDate(b.date)) out.days[b.date] = sanitizeBucket(b.date, b);
    }
  } else if (days && typeof days === 'object') {
    for (const key of Object.keys(days)) {
      if (isDate(key)) out.days[key] = sanitizeBucket(key, days[key]);
    }
  }
  return out;
}

function prune() {
  const cutoff = fmt(addDays(startOfToday(), -(RETENTION_DAYS - 1)));
  for (const key of Object.keys(data.days)) {
    if (key < cutoff) delete data.days[key];
  }
}

function save() {
  if (!file) return;
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e2) {
      console.error('[bol] analytics: failed to persist analytics.json:', e2.message);
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e3) { /* ignore */ }
  }
}

function ensureData() {
  if (!data) data = emptyData();
  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function init(paths) {
  try {
    const userData = paths && paths.userData;
    if (!userData) { ensureData(); return; }
    try { fs.mkdirSync(userData, { recursive: true }); } catch (e) { /* exists */ }
    file = path.join(userData, 'analytics.json');
    if (fs.existsSync(file)) {
      try {
        data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (e) {
        console.error('[bol] analytics: analytics.json corrupt, recreating:', e.message);
        try { fs.renameSync(file, file + '.bak'); } catch (e2) { /* best effort */ }
        data = emptyData();
      }
    } else {
      data = emptyData();
    }
    prune();
    save();
  } catch (e) {
    console.error('[bol] analytics: init failed, running in-memory:', e.message);
    ensureData();
  }
}

function record(entry) {
  try {
    ensureData();
    const e = entry || {};
    const words = toCount(e.words);
    const ms = toCount(e.durationMs);
    const app = typeof e.app === 'string' ? e.app.trim().toLowerCase() : '';

    const key = fmt(new Date());
    let bucket = data.days[key];
    if (!bucket) bucket = data.days[key] = { date: key, words: 0, sessions: 0, ms: 0, apps: {} };

    bucket.words += words;
    bucket.sessions += 1;
    bucket.ms += ms;
    if (app && words > 0) bucket.apps[app] = (bucket.apps[app] || 0) + words;

    data.totalWords += words;
    data.totalSessions += 1;
    data.totalMs += ms;

    prune();
    save();
  } catch (err) {
    console.error('[bol] analytics: record failed:', err.message);
  }
}

function get() {
  try {
    ensureData();
    const totalWords = toCount(data.totalWords);
    const totalSessions = toCount(data.totalSessions);
    const totalMs = toCount(data.totalMs);

    const avgWpm = totalMs > 0 ? Math.round(totalWords / (totalMs / 60000)) : 0;
    const minutesSaved = Math.max(0, Math.round(totalWords / TYPING_WPM - totalMs / 60000));

    // Streak: consecutive days with activity ending today OR yesterday.
    const active = new Set();
    for (const key of Object.keys(data.days)) {
      const b = data.days[key];
      if ((b.sessions || 0) > 0 || (b.words || 0) > 0) active.add(key);
    }
    let streakDays = 0;
    let cursor = startOfToday();
    if (!active.has(fmt(cursor))) cursor = addDays(cursor, -1); // allow streak ending yesterday
    while (active.has(fmt(cursor))) {
      streakDays++;
      cursor = addDays(cursor, -1);
    }

    // Last 30 days, oldest → newest, missing days zero-filled.
    const days = [];
    const today = startOfToday();
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const key = fmt(addDays(today, -i));
      const b = data.days[key];
      days.push({
        date: key,
        words: b ? toCount(b.words) : 0,
        sessions: b ? toCount(b.sessions) : 0,
        ms: b ? toCount(b.ms) : 0,
      });
    }

    // Top 5 apps by words across all retained days.
    const appTotals = new Map();
    for (const key of Object.keys(data.days)) {
      const apps = data.days[key].apps || {};
      for (const exe of Object.keys(apps)) {
        appTotals.set(exe, (appTotals.get(exe) || 0) + toCount(apps[exe]));
      }
    }
    const topApps = Array.from(appTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app, words]) => ({ app, words }));

    return { totalWords, totalSessions, totalMs, avgWpm, streakDays, minutesSaved, days, topApps };
  } catch (err) {
    console.error('[bol] analytics: get failed:', err.message);
    return {
      totalWords: 0, totalSessions: 0, totalMs: 0, avgWpm: 0,
      streakDays: 0, minutesSaved: 0, days: [], topApps: [],
    };
  }
}

module.exports = { init, record, get };
