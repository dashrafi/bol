// Bol HUD renderer — plain browser JS, talks to main only via window.bol.
// Receives `hud:state {state, partial?, level?, message?}`; click anywhere cancels.
(function () {
  'use strict';

  var BAR_COUNT = 12;
  var MIN_SCALE = 0.12;

  var pill = document.getElementById('pill');
  var waveEl = document.getElementById('wave');
  var textWrap = document.getElementById('textWrap');
  var textEl = document.getElementById('text');
  var labelEl = document.getElementById('label');

  // ---------- waveform bars (symmetric envelope, mirrored wobble) ----------
  var bars = [];
  var env = [];
  var phase = [];
  var speed = [];
  (function buildBars() {
    var half = BAR_COUNT / 2;
    var i, el;
    for (i = 0; i < half; i++) {
      phase[i] = Math.random() * Math.PI * 2;
      speed[i] = 2.2 + Math.random() * 2.2;
    }
    for (i = 0; i < BAR_COUNT; i++) {
      // sin envelope peaks at the center → symmetric silhouette
      env[i] = 0.35 + 0.65 * Math.sin(Math.PI * (i + 0.5) / BAR_COUNT);
      var m = i < half ? i : BAR_COUNT - 1 - i; // mirror wobble left↔right
      if (i >= half) { phase[i] = phase[m]; speed[i] = speed[m]; }
      el = document.createElement('i');
      waveEl.appendChild(el);
      bars.push(el);
    }
  })();

  // ---------- state ----------
  var state = 'idle';
  var hidden = true;
  var partial = '';
  var message = '';
  var levelTarget = 0;
  var levelSmooth = 0;
  var lastLevelAt = 0;
  var rafId = 0;

  // Perceptual shaping: speech RMS is small (~0.05–0.3); lift it into a visible range.
  function shapeLevel(l) {
    if (!(typeof l === 'number') || !isFinite(l)) return 0;
    l = Math.max(0, Math.min(1, l));
    return Math.min(1, Math.pow(l, 0.55) * 1.5);
  }

  function animate(now) {
    rafId = 0;
    if (state !== 'listening') return;
    // smooth decay when level updates stop arriving (they're throttled ~60ms)
    if (now - lastLevelAt > 140) {
      levelTarget *= 0.92;
      if (levelTarget < 0.01) levelTarget = 0;
    }
    // rise fast, fall gently
    levelSmooth += (levelTarget - levelSmooth) * (levelTarget > levelSmooth ? 0.35 : 0.12);
    var t = now * 0.001;
    for (var i = 0; i < BAR_COUNT; i++) {
      var wob = 0.7 + 0.3 * Math.sin(t * speed[i] + phase[i]);
      var s = MIN_SCALE + env[i] * levelSmooth * wob * (1 - MIN_SCALE);
      if (s > 1) s = 1;
      bars[i].style.transform = 'scaleY(' + s.toFixed(3) + ')';
    }
    rafId = requestAnimationFrame(animate);
  }

  function startWave() {
    waveEl.classList.remove('settle');
    if (!rafId) rafId = requestAnimationFrame(animate);
  }

  function stopWave() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    levelTarget = 0;
    levelSmooth = 0;
    waveEl.classList.add('settle');
    for (var i = 0; i < BAR_COUNT; i++) {
      bars[i].style.transform = 'scaleY(' + MIN_SCALE + ')';
    }
  }

  // ---------- transcript (fixed box: content changes never move layout) ----------
  var lastRendered = null;
  function renderText() {
    var t = partial.replace(/\s+/g, ' ').trim();
    var placeholder = !t;
    var out = t || message || 'Listening…';
    if (out === lastRendered && placeholder === textEl.classList.contains('placeholder')) return;
    lastRendered = out;
    textEl.classList.toggle('placeholder', placeholder);
    textEl.textContent = out;
    // keep the tail (last words) visible; fade the clipped left edge
    var overflowing = textWrap.scrollWidth > textWrap.clientWidth + 1;
    textWrap.classList.toggle('fade', overflowing && !placeholder);
    textWrap.scrollLeft = overflowing ? textWrap.scrollWidth : 0;
  }

  function renderLabel() {
    var text;
    if (state === 'transcribing') text = message || 'Transcribing…';
    else if (state === 'polishing') text = message || 'Polishing…';
    else if (state === 'inserting') text = message || 'Inserted';
    else if (state === 'error') text = message || 'Something went wrong';
    else text = message || 'Working…'; // unknown non-idle state: safe generic busy
    if (labelEl.textContent !== text) labelEl.textContent = text;
  }

  // ---------- show / hide with enter animation ----------
  function show(nextState) {
    pill.setAttribute('data-state', nextState);
    if (hidden) {
      hidden = false;
      // snap to the new state's geometry without animating from the stale one
      pill.classList.add('snap');
      void pill.offsetWidth; // force reflow while transitions are disabled
      pill.classList.remove('snap');
      pill.classList.remove('hidden');
      pill.classList.add('enter'); // scale/fade in, 150ms
    }
  }

  function hide() {
    if (!hidden) {
      hidden = true;
      pill.classList.remove('enter');
      pill.classList.add('hidden');
    }
  }

  pill.addEventListener('animationend', function (e) {
    if (e.animationName === 'hud-enter') pill.classList.remove('enter');
  });

  // ---------- hud:state handler ----------
  function onHudState(payload) {
    payload = payload || {};
    var next = typeof payload.state === 'string' && payload.state ? payload.state : 'idle';

    // Merge partial-payload updates: level-only messages must not wipe the
    // transcript, and partial-only messages must not reset the meter.
    if (payload.partial !== undefined) partial = payload.partial == null ? '' : String(payload.partial);
    if (payload.message !== undefined) message = payload.message == null ? '' : String(payload.message);
    if (typeof payload.level === 'number' && isFinite(payload.level)) {
      levelTarget = shapeLevel(payload.level);
      lastLevelAt = (window.performance && performance.now) ? performance.now() : Date.now();
    }

    var changed = next !== state;
    if (changed) {
      // fresh listening session with no explicit partial/message → start clean
      if (next === 'listening') {
        if (payload.partial === undefined) partial = '';
        if (payload.message === undefined) message = '';
        lastRendered = null;
      } else if (payload.message === undefined) {
        // A new stage with no message of its own must not inherit the last one
        // ("Transcribing…" was showing through the whole polishing step).
        message = '';
      }
      state = next;
    }

    if (state === 'idle') {
      hide();
      stopWave();
      partial = '';
      message = '';
      lastRendered = null;
      return;
    }

    show(state);

    if (state === 'listening') {
      renderText();
      startWave();
    } else {
      if (changed) stopWave();
      renderLabel();
    }
  }

  if (window.bol && typeof window.bol.on === 'function') {
    window.bol.on('hud:state', function (payload) {
      try { onHudState(payload); } catch (e) { /* never let a render error kill the HUD */ }
    });
  }

  // click anywhere → cancel the capture
  document.addEventListener('click', function () {
    try {
      if (window.bol && typeof window.bol.send === 'function') window.bol.send('hud:cancel');
    } catch (e) { /* ignore */ }
  });

  // no navigation, no context menu, no drag — this is a passive overlay
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });
})();
