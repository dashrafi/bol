// Bol — first-run onboarding (A8). Registers window.BolPages.onboarding.
// Shown while cfg.ui.onboarded is false; sidebar is hidden by the shell.
'use strict';
(function () {
  window.BolPages = window.BolPages || {};
  var STYLE_ID = 'bol-onb-style';
  var cfg = null, step = 0, meterStop = null;

  function invoke(ch, p) {
    try { if (window.bol && window.bol.invoke) return Promise.resolve(window.bol.invoke(ch, p)); }
    catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('bridge unavailable'));
  }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var a in attrs) {
      if (a === 'class') e.className = attrs[a];
      else if (a === 'text') e.textContent = attrs[a];
      else if (a === 'html') e.innerHTML = attrs[a];
      else if (a.slice(0, 2) === 'on') e.addEventListener(a.slice(2).toLowerCase(), attrs[a]);
      else if (attrs[a] != null && attrs[a] !== false) e.setAttribute(a, attrs[a]);
    }
    (kids || []).forEach(function (k) { if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return e;
  }
  function patch(p) {
    deepMerge(cfg, p);
    invoke('settings:set', p)
      .then(function (c) { if (c) cfg = window.bolConfig = c; })
      .catch(function (e) { if (window.bolToast) window.bolToast('Could not save: ' + (e && e.message), 'error'); });
  }
  function deepMerge(t, s) { for (var k in s) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = t[k] || {}; deepMerge(t[k], s[k]); } else t[k] = s[k]; } return t; }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.onb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:30px}',
      '.onb-card{width:100%;max-width:540px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:38px 40px;box-shadow:0 30px 80px rgba(0,0,0,.45);animation:onb-in .3s ease both}',
      '@keyframes onb-in{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}',
      '.onb-dots{display:flex;gap:7px;margin-bottom:26px}',
      '.onb-dot{width:26px;height:4px;border-radius:2px;background:rgba(255,255,255,.14)}',
      '.onb-dot.on{background:linear-gradient(90deg,#6c7bff,#9a5bff)}',
      '.onb-mark{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#6c7bff,#9a5bff);display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 10px 30px rgba(108,123,255,.4)}',
      '.onb-mark svg{width:28px;height:28px;color:#fff}',
      '.onb h1{font-size:25px;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;color:#fff}',
      '.onb p{font-size:14px;line-height:1.6;color:#aab0cf;margin:0 0 18px}',
      '.onb-lbl{font-size:11.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#8d93b4;margin:14px 0 7px;display:block}',
      '.onb-in,.onb-sel{width:100%;box-sizing:border-box;background:rgba(9,12,22,.6);border:1px solid rgba(255,255,255,.12);border-radius:11px;color:#e9ebf8;padding:11px 13px;font-size:14px;font-family:inherit;outline:none}',
      '.onb-in:focus,.onb-sel:focus{border-color:rgba(108,123,255,.7);box-shadow:0 0 0 3px rgba(108,123,255,.16)}',
      '.onb-foot{display:flex;justify-content:space-between;align-items:center;margin-top:30px}',
      '.onb-btn{border:0;border-radius:12px;padding:12px 26px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,#6c7bff,#9a5bff);color:#fff;box-shadow:0 8px 24px rgba(108,123,255,.3)}',
      '.onb-btn:active{transform:scale(.98)}',
      '.onb-btn.ghost{background:none;box-shadow:none;color:#9298b8;padding:12px 10px}',
      '.onb-btn:disabled{opacity:.4;cursor:default}',
      '.onb-test{font-size:12.5px;margin-top:10px;min-height:16px}',
      '.onb-test.ok{color:#8ff0bf}.onb-test.err{color:#ffb3c1}',
      '.onb-meter{height:12px;border-radius:8px;background:rgba(9,12,22,.7);overflow:hidden;margin-top:8px;border:1px solid rgba(255,255,255,.1)}',
      '.onb-meter-fill{height:100%;width:0;background:linear-gradient(90deg,#6c7bff,#58d68d);transition:width .06s linear}',
      '.onb-key{display:inline-flex;min-width:120px;justify-content:center;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e9ebf8;border-radius:11px;padding:11px 16px;font-family:"Cascadia Code",Consolas,monospace;font-size:14px;font-weight:700;cursor:pointer}',
      '.onb-key.arm{border-color:rgba(108,123,255,.7);color:#b0baff;background:rgba(108,123,255,.14)}',
    ].join('\n');
    document.head.appendChild(h('style', { id: STYLE_ID, text: css }));
  }

  function dots() {
    var d = h('div', { class: 'onb-dots' });
    for (var i = 0; i < 4; i++) d.appendChild(h('div', { class: 'onb-dot' + (i <= step ? ' on' : '') }));
    return d;
  }
  var MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

  function stopMeter() { if (meterStop) { try { meterStop(); } catch (e) {} meterStop = null; } }

  function startMeter(fillEl, statusEl) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { statusEl.className = 'onb-test err'; statusEl.textContent = 'No microphone API available'; return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      statusEl.className = 'onb-test ok'; statusEl.textContent = '✓ Mic working — speak to see the meter move';
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var src = ctx.createMediaStreamSource(stream);
      var an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      var data = new Uint8Array(an.fftSize); var raf;
      function loop() {
        an.getByteTimeDomainData(data);
        var sum = 0; for (var i = 0; i < data.length; i++) { var v = (data[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / data.length);
        fillEl.style.width = Math.min(100, rms * 320) + '%';
        raf = requestAnimationFrame(loop);
      }
      loop();
      meterStop = function () { cancelAnimationFrame(raf); stream.getTracks().forEach(function (t) { t.stop(); }); ctx.close(); };
    }).catch(function (e) {
      statusEl.className = 'onb-test err';
      statusEl.textContent = e && e.name === 'NotAllowedError' ? '✗ Mic permission denied' : '✗ ' + (e.message || 'mic error');
    });
  }

  function render(el) {
    injectStyle();
    cfg = window.bolConfig;
    stopMeter();
    if (!cfg) { invoke('settings:get').then(function (c) { cfg = window.bolConfig = c; render(el); }); return; }
    el.innerHTML = '';
    var body = h('div');
    var next = h('button', { class: 'onb-btn', type: 'button', text: step === 3 ? 'Start using Bol' : 'Continue' });
    var back = h('button', { class: 'onb-btn ghost', type: 'button', text: step === 0 ? '' : 'Back' });
    back.style.visibility = step === 0 ? 'hidden' : 'visible';
    back.addEventListener('click', function () { step = Math.max(0, step - 1); render(el); });
    next.addEventListener('click', function () {
      if (step === 3) {
        stopMeter();
        patch({ ui: { onboarded: true } });
        // Leave the wizard immediately — never wait on the settings:changed
        // round-trip (if it is missed, the user is stuck clicking forever).
        if (window.BolShell && typeof window.BolShell.finishOnboarding === 'function') window.BolShell.finishOnboarding();
        return;
      }
      step++; render(el);
    });

    if (step === 0) {
      body.appendChild(h('div', { class: 'onb-mark', html: MIC_SVG }));
      body.appendChild(h('h1', { text: 'Welcome to Bol' }));
      body.appendChild(h('p', { text: 'Speak anywhere on Windows and Bol types polished text into whatever app has focus — email, Slack, your editor, the browser. Free by default, no subscription, no account, nothing sent to any server.' }));
      body.appendChild(h('p', { text: "It works out of the box with $0 keys — local voice recognition on your PC. Let's set it up in three quick steps." }));
    } else if (step === 1) {
      body.appendChild(h('h1', { text: 'Choose your voice engine' }));
      body.appendChild(h('p', { text: 'Local Whisper runs on your PC — free, no key, works offline (recommended). Prefer a faster cloud? Groq has a free tier. You can switch any time in Settings.' }));
      var prov = h('select', { class: 'onb-sel' });
      [['local', 'Local Whisper — free, no key, offline (recommended)'], ['openai', 'Groq / OpenAI Whisper — free tier, needs a key'], ['deepgram', 'Deepgram — streaming cloud, needs a key']].forEach(function (o) {
        var op = h('option', { value: o[0], text: o[1] }); if (cfg.stt.provider === o[0]) op.selected = true; prov.appendChild(op);
      });
      body.appendChild(h('label', { class: 'onb-lbl', text: 'Speech-to-text provider' }));
      body.appendChild(prov);
      var keyWrap = h('div');
      var testRes = h('div', { class: 'onb-test' });
      function paintKey() {
        keyWrap.innerHTML = '';
        var p = cfg.stt.provider;
        if (p === 'local') { keyWrap.appendChild(h('p', { text: 'No key needed — the voice model (~75MB) downloads on first use, then works fully offline. For cleanup, Bol uses your local Ollama if running, else an instant offline cleaner — also $0.', style: 'margin-top:14px' })); return; }
        var lbl = p === 'deepgram' ? 'Deepgram API key' : 'API key';
        keyWrap.appendChild(h('label', { class: 'onb-lbl', text: lbl }));
        var key = p === 'deepgram' ? cfg.stt.deepgramKey : cfg.stt.openaiKey;
        var inp = h('input', { class: 'onb-in', type: 'password', placeholder: 'Paste your key…', value: key || '' });
        inp.addEventListener('input', function () { patch(p === 'deepgram' ? { stt: { deepgramKey: inp.value } } : { stt: { openaiKey: inp.value } }); });
        keyWrap.appendChild(inp);
        var t = h('button', { class: 'onb-key', type: 'button', text: 'Test key', style: 'margin-top:12px;min-width:0;padding:9px 18px;font-family:inherit' });
        t.addEventListener('click', function () {
          testRes.className = 'onb-test'; testRes.textContent = 'Testing…';
          invoke('test:stt').then(function (r) { if (r && r.ok) { testRes.className = 'onb-test ok'; testRes.textContent = '✓ Key works'; } else { testRes.className = 'onb-test err'; testRes.textContent = '✗ ' + ((r && r.error) || 'failed'); } });
        });
        keyWrap.appendChild(t);
      }
      prov.addEventListener('change', function () { patch({ stt: { provider: prov.value } }); paintKey(); });
      paintKey();
      body.appendChild(keyWrap); body.appendChild(testRes);
    } else if (step === 2) {
      body.appendChild(h('h1', { text: 'Set your hotkey & test the mic' }));
      body.appendChild(h('p', { text: 'Hold the push-to-talk key and speak; release and your words appear. Pick a key you can reach easily.' }));
      body.appendChild(h('label', { class: 'onb-lbl', text: 'Push-to-talk key' }));
      var btn = h('button', { class: 'onb-key', type: 'button', text: (cfg.hotkeys.pushToTalk && cfg.hotkeys.pushToTalk.label) || 'F9' });
      btn.addEventListener('click', function () {
        if (btn.classList.contains('arm')) return;
        btn.classList.add('arm'); btn.textContent = 'Press a key…';
        invoke('settings:captureHotkey').then(function (res) {
          btn.classList.remove('arm');
          if (res && res.code) { btn.textContent = res.label; patch({ hotkeys: { pushToTalk: { code: res.code, label: res.label } } }); }
          else btn.textContent = (cfg.hotkeys.pushToTalk && cfg.hotkeys.pushToTalk.label) || 'F9';
        }).catch(function () { btn.classList.remove('arm'); btn.textContent = (cfg.hotkeys.pushToTalk && cfg.hotkeys.pushToTalk.label) || 'F9'; });
      });
      body.appendChild(btn);
      body.appendChild(h('label', { class: 'onb-lbl', text: 'Microphone check' }));
      var fill = h('div', { class: 'onb-meter-fill' });
      body.appendChild(h('div', { class: 'onb-meter' }, [fill]));
      var st = h('div', { class: 'onb-test' });
      body.appendChild(st);
      startMeter(fill, st);
    } else {
      body.appendChild(h('div', { class: 'onb-mark', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }));
      body.appendChild(h('h1', { text: "You're all set" }));
      body.appendChild(h('p', { text: 'Bol now lives in your system tray. Hold ' + ((cfg.hotkeys.pushToTalk && cfg.hotkeys.pushToTalk.label) || 'F9') + ' anywhere and start talking. Everything — history, dictionary, tone — is in the dashboard.' }));
      body.appendChild(h('p', { text: 'Tip: add names and jargon to your Dictionary so they always come out spelled right.' }));
    }

    var card = h('div', { class: 'onb-card' }, [dots(), body, h('div', { class: 'onb-foot' }, [back, next])]);
    el.appendChild(h('div', { class: 'onb' }, [card]));
  }

  window.BolPages.onboarding = { render: render };
})();
