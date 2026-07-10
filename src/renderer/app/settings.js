// Bol — Settings page (A8). Registers window.BolPages.settings.
// The full config surface: STT providers, cleanup/AI, hotkeys, mic, privacy.
'use strict';
(function () {
  window.BolPages = window.BolPages || {};
  var STYLE_ID = 'bol-settings-style';
  var cfg = null;

  function invoke(ch, p) {
    try { if (window.bol && window.bol.invoke) return Promise.resolve(window.bol.invoke(ch, p)); }
    catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('bridge unavailable'));
  }
  function toast(m, k) { if (window.bolToast) window.bolToast(m, k); }

  // patch({section:{key:val}}) -> persist + local mirror
  var saveTimer = null;
  function patch(p, quiet) {
    deepMerge(cfg, p);
    invoke('settings:set', p).then(function (c) { if (c) cfg = c; }).catch(function () {});
    if (!quiet) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { toast('Saved', 'ok'); }, 260);
    }
  }
  function deepMerge(t, s) {
    for (var k in s) {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = t[k] || {}; deepMerge(t[k], s[k]); }
      else t[k] = s[k];
    }
    return t;
  }

  // tiny DOM helper
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var a in attrs) {
      if (a === 'class') e.className = attrs[a];
      else if (a === 'html') e.innerHTML = attrs[a];
      else if (a === 'text') e.textContent = attrs[a];
      else if (a.slice(0, 2) === 'on') e.addEventListener(a.slice(2).toLowerCase(), attrs[a]);
      else if (attrs[a] != null && attrs[a] !== false) e.setAttribute(a, attrs[a]);
    }
    (kids || []).forEach(function (k) { if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return e;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.st{max-width:900px;margin:0 auto;padding:30px 34px 70px;color:#e9ebf8;font-family:inherit;animation:st-in .28s ease both}',
      '@keyframes st-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.st h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0 0 4px;color:#fff}',
      '.st-lede{color:#9298b8;font-size:13.5px;margin:0 0 26px}',
      '.st-sec{background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:22px 24px;margin:0 0 18px}',
      '.st-sec h2{font-size:15px;font-weight:700;margin:0 0 3px;color:#fff;letter-spacing:-.01em}',
      '.st-sec .st-desc{color:#8d93b4;font-size:12.5px;margin:0 0 18px;line-height:1.5}',
      '.st-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 0;border-top:1px solid rgba(255,255,255,.06)}',
      '.st-row:first-of-type{border-top:0}',
      '.st-row .l{font-size:13.5px;font-weight:600;color:#dfe2f5}',
      '.st-row .h{font-size:12px;color:#8d93b4;margin-top:3px;line-height:1.45;max-width:440px}',
      '.st-field{display:flex;flex-direction:column;gap:7px;padding:12px 0;border-top:1px solid rgba(255,255,255,.06)}',
      '.st-field:first-of-type{border-top:0}',
      '.st-lbl{font-size:11.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#8d93b4}',
      '.st-in,.st-sel,.st-ta{width:100%;box-sizing:border-box;background:rgba(9,12,22,.6);border:1px solid rgba(255,255,255,.11);border-radius:10px;color:#e9ebf8;padding:9px 12px;font-size:13.5px;font-family:inherit;outline:none}',
      '.st-in:focus,.st-sel:focus,.st-ta:focus{border-color:rgba(108,123,255,.65);box-shadow:0 0 0 3px rgba(108,123,255,.16)}',
      '.st-ta{resize:vertical;min-height:70px;line-height:1.5}',
      '.st-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#e9ebf8;border-radius:10px;padding:8px 14px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap}',
      '.st-btn:hover{background:rgba(255,255,255,.11)}',
      '.st-btn:active{transform:scale(.97)}',
      '.st-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:6px}',
      '.st-card{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:13px 14px;cursor:pointer;background:rgba(255,255,255,.03);transition:border-color .15s,background .15s}',
      '.st-card:hover{background:rgba(255,255,255,.06)}',
      '.st-card.sel{border-color:rgba(108,123,255,.7);background:rgba(108,123,255,.12);box-shadow:0 0 0 3px rgba(108,123,255,.12)}',
      '.st-card .n{font-size:13.5px;font-weight:700;color:#fff}',
      '.st-card .d{font-size:11.5px;color:#9298b8;margin-top:4px;line-height:1.4}',
      '.st-toggle{position:relative;width:42px;height:24px;border-radius:999px;background:rgba(255,255,255,.14);border:0;cursor:pointer;flex:none;transition:background .18s}',
      '.st-toggle::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .18s}',
      '.st-toggle.on{background:linear-gradient(135deg,#6c7bff,#9a5bff)}',
      '.st-toggle.on::after{transform:translateX(18px)}',
      '.st-key{display:flex;gap:8px;align-items:center}',
      '.st-keybtn{min-width:96px;justify-content:center;font-family:"Cascadia Code",Consolas,monospace}',
      '.st-keybtn.arm{border-color:rgba(108,123,255,.7);color:#b0baff;background:rgba(108,123,255,.13)}',
      '.st-test{font-size:12px;margin-left:10px}',
      '.st-test.ok{color:#8ff0bf}.st-test.err{color:#ffb3c1}',
      '.st-rule{display:flex;gap:8px;align-items:center;margin-top:8px}',
      '.st-rule .st-in{flex:1}',
      '.st-mini{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.05);color:#cfd3ee;border-radius:9px;width:34px;height:34px;flex:none;cursor:pointer;font-size:16px;line-height:1}',
      '.st-inline{display:flex;align-items:center;gap:10px}',
      '.st-range{flex:1;accent-color:#7d8aff}',
    ].join('\n');
    document.head.appendChild(h('style', { id: STYLE_ID, text: css }));
  }

  function toggle(on, onChange) {
    var b = h('button', { class: 'st-toggle' + (on ? ' on' : ''), type: 'button' });
    b.addEventListener('click', function () {
      var next = !b.classList.contains('on');
      b.classList.toggle('on', next); onChange(next);
    });
    return b;
  }
  function row(label, hint, control) {
    return h('div', { class: 'st-row' }, [
      h('div', {}, [h('div', { class: 'l', text: label }), hint ? h('div', { class: 'h', text: hint }) : null]),
      control,
    ]);
  }
  function field(label, control) {
    return h('div', { class: 'st-field' }, [h('label', { class: 'st-lbl', text: label }), control]);
  }
  function input(val, ph, onInput, type) {
    var e = h('input', { class: 'st-in', type: type || 'text', placeholder: ph || '', value: val || '' });
    e.addEventListener('input', function () { onInput(e.value); });
    return e;
  }
  function select(val, opts, onChange) {
    var s = h('select', { class: 'st-sel' });
    opts.forEach(function (o) {
      var op = h('option', { value: o.v, text: o.t }); if (o.v === val) op.selected = true; s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  // ---------------------------------------------------------------- sections
  function sttSection() {
    var sec = h('div', { class: 'st-sec' }, [
      h('h2', { text: 'Speech-to-text' }),
      h('div', { class: 'st-desc', text: 'Which engine turns your voice into text. Deepgram streams live; Local runs fully offline.' }),
    ]);
    var cards = h('div', { class: 'st-cards' });
    var providers = [
      { v: 'deepgram', n: 'Deepgram', d: 'Streaming cloud — fastest, live partials' },
      { v: 'openai', n: 'OpenAI / Groq', d: 'Whisper API, any compatible base URL' },
      { v: 'local', n: 'Local Whisper', d: 'On-device, free, offline' },
    ];
    var detail = h('div');
    function paintDetail() {
      detail.innerHTML = '';
      var p = cfg.stt.provider;
      if (p === 'deepgram') {
        detail.appendChild(field('Deepgram API key', input(cfg.stt.deepgramKey, 'Token…', function (v) { patch({ stt: { deepgramKey: v } }, true); }, 'password')));
        detail.appendChild(field('Model', select(cfg.stt.deepgramModel, [{ v: 'nova-2', t: 'nova-2 (multilingual)' }, { v: 'nova-3', t: 'nova-3 (English keyterms)' }], function (v) { patch({ stt: { deepgramModel: v } }); })));
      } else if (p === 'openai') {
        detail.appendChild(field('API key', input(cfg.stt.openaiKey, 'sk-… or gsk_…', function (v) { patch({ stt: { openaiKey: v } }, true); }, 'password')));
        detail.appendChild(field('Base URL', input(cfg.stt.openaiBaseUrl, 'https://api.openai.com/v1', function (v) { patch({ stt: { openaiBaseUrl: v } }, true); })));
        detail.appendChild(field('Model', input(cfg.stt.openaiModel, 'whisper-1', function (v) { patch({ stt: { openaiModel: v } }, true); })));
      } else {
        detail.appendChild(field('Local model', select(cfg.stt.localModel, [
          { v: 'onnx-community/whisper-tiny', t: 'tiny — fastest, lowest accuracy' },
          { v: 'onnx-community/whisper-base', t: 'base — balanced (recommended)' },
          { v: 'onnx-community/whisper-small', t: 'small — slower, more accurate' },
        ], function (v) { patch({ stt: { localModel: v } }); })));
        detail.appendChild(h('div', { class: 'st-desc', text: 'First use downloads the model (~75MB for base) into your profile — one time.' }));
      }
      detail.appendChild(field('Language', select(cfg.stt.language, [
        { v: 'auto', t: 'Auto-detect' }, { v: 'en', t: 'English' }, { v: 'ur', t: 'Urdu' },
        { v: 'hi', t: 'Hindi' }, { v: 'multi', t: 'Multi (code-switching)' },
      ], function (v) { patch({ stt: { language: v } }); })));
      var testBtn = h('button', { class: 'st-btn', type: 'button', text: 'Test connection' });
      var testRes = h('span', { class: 'st-test' });
      testBtn.addEventListener('click', function () {
        testRes.className = 'st-test'; testRes.textContent = 'Testing…';
        invoke('test:stt').then(function (r) {
          if (r && r.ok) { testRes.className = 'st-test ok'; testRes.textContent = '✓ Works'; }
          else { testRes.className = 'st-test err'; testRes.textContent = '✗ ' + ((r && r.error) || 'failed'); }
        }).catch(function (e) { testRes.className = 'st-test err'; testRes.textContent = '✗ ' + e.message; });
      });
      detail.appendChild(h('div', { class: 'st-field' }, [h('div', { class: 'st-inline' }, [testBtn, testRes])]));
    }
    providers.forEach(function (pr) {
      var c = h('div', { class: 'st-card' + (cfg.stt.provider === pr.v ? ' sel' : '') }, [
        h('div', { class: 'n', text: pr.n }), h('div', { class: 'd', text: pr.d }),
      ]);
      c.addEventListener('click', function () {
        patch({ stt: { provider: pr.v } });
        cards.querySelectorAll('.st-card').forEach(function (x) { x.classList.remove('sel'); });
        c.classList.add('sel'); paintDetail();
      });
      cards.appendChild(c);
    });
    sec.appendChild(cards); sec.appendChild(detail); paintDetail();
    return sec;
  }

  function cleanupSection() {
    var sec = h('div', { class: 'st-sec' }, [
      h('h2', { text: 'AI cleanup' }),
      h('div', { class: 'st-desc', text: 'Polishes the raw transcript — removes fillers, fixes punctuation, matches tone. This is what makes dictation read like you typed it.' }),
    ]);
    sec.appendChild(field('Mode', select(cfg.cleanup.mode, [
      { v: 'full', t: 'Full — Claude cleans every dictation (best)' },
      { v: 'light', t: 'Light — offline regex cleanup, no AI' },
      { v: 'off', t: 'Off — insert raw transcript' },
    ], function (v) { patch({ cleanup: { mode: v } }); render(host); })));
    if (cfg.cleanup.mode === 'full') {
      sec.appendChild(field('Anthropic API key', input(cfg.cleanup.anthropicKey, 'sk-ant-…', function (v) { patch({ cleanup: { anthropicKey: v } }, true); }, 'password')));
      sec.appendChild(field('Model', select(cfg.cleanup.model, [
        { v: 'claude-haiku-4-5-20251001', t: 'Claude Haiku 4.5 — fast + cheap (recommended)' },
        { v: 'claude-sonnet-5', t: 'Claude Sonnet 5 — highest quality' },
      ], function (v) { patch({ cleanup: { model: v } }); })));
      sec.appendChild(field('Default tone', select(cfg.cleanup.tone, [
        { v: 'auto', t: 'Auto (match the app)' }, { v: 'formal', t: 'Formal' },
        { v: 'casual', t: 'Casual' }, { v: 'raw', t: 'Raw (minimal edits)' },
      ], function (v) { patch({ cleanup: { tone: v } }); })));
      var ta = h('textarea', { class: 'st-ta', placeholder: 'e.g. Prefer British spelling. Keep my bullet points terse.' });
      ta.value = cfg.cleanup.customInstructions || '';
      ta.addEventListener('input', function () { patch({ cleanup: { customInstructions: ta.value } }, true); });
      sec.appendChild(field('Custom instructions (optional)', ta));

      // per-app tone rules
      var rulesWrap = h('div', { class: 'st-field' }, [h('label', { class: 'st-lbl', text: 'Per-app tone rules' })]);
      var list = h('div');
      function paintRules() {
        list.innerHTML = '';
        (cfg.cleanup.appRules || []).forEach(function (r, i) {
          var mi = h('input', { class: 'st-in', placeholder: 'app match (e.g. slack)', value: r.match || '' });
          mi.addEventListener('input', function () { cfg.cleanup.appRules[i].match = mi.value; patch({ cleanup: { appRules: cfg.cleanup.appRules } }, true); });
          var ts = select(r.tone, [{ v: 'formal', t: 'formal' }, { v: 'casual', t: 'casual' }, { v: 'raw', t: 'raw' }, { v: 'auto', t: 'auto' }], function (v) { cfg.cleanup.appRules[i].tone = v; patch({ cleanup: { appRules: cfg.cleanup.appRules } }); });
          var del = h('button', { class: 'st-mini', type: 'button', text: '×', title: 'Remove' });
          del.addEventListener('click', function () { cfg.cleanup.appRules.splice(i, 1); patch({ cleanup: { appRules: cfg.cleanup.appRules } }); paintRules(); });
          list.appendChild(h('div', { class: 'st-rule' }, [mi, ts, del]));
        });
        var add = h('button', { class: 'st-btn', type: 'button', text: '+ Add rule', style: 'margin-top:10px' });
        add.addEventListener('click', function () { cfg.cleanup.appRules = cfg.cleanup.appRules || []; cfg.cleanup.appRules.push({ match: '', tone: 'casual' }); patch({ cleanup: { appRules: cfg.cleanup.appRules } }, true); paintRules(); });
        list.appendChild(add);
      }
      paintRules(); rulesWrap.appendChild(list); sec.appendChild(rulesWrap);

      var testBtn = h('button', { class: 'st-btn', type: 'button', text: 'Test Claude key' });
      var testRes = h('span', { class: 'st-test' });
      testBtn.addEventListener('click', function () {
        testRes.className = 'st-test'; testRes.textContent = 'Testing…';
        invoke('test:cleanup').then(function (r) {
          if (r && r.ok) { testRes.className = 'st-test ok'; testRes.textContent = '✓ Works'; }
          else { testRes.className = 'st-test err'; testRes.textContent = '✗ ' + ((r && r.error) || 'failed'); }
        }).catch(function (e) { testRes.className = 'st-test err'; testRes.textContent = '✗ ' + e.message; });
      });
      sec.appendChild(h('div', { class: 'st-field' }, [h('div', { class: 'st-inline' }, [testBtn, testRes])]));
    }
    return sec;
  }

  function hotkeysSection() {
    var sec = h('div', { class: 'st-sec' }, [
      h('h2', { text: 'Hotkeys' }),
      h('div', { class: 'st-desc', text: 'Hold push-to-talk and speak; release to insert. Toggle starts/stops hands-free. Command edits selected text by voice.' }),
    ]);
    [['pushToTalk', 'Push-to-talk', 'Hold to dictate'],
     ['toggle', 'Hands-free toggle', 'Press once to start, again to stop'],
     ['command', 'Command mode', 'Edit selected text by voice']].forEach(function (hk) {
      var key = hk[0];
      var btn = h('button', { class: 'st-btn st-keybtn', type: 'button', text: (cfg.hotkeys[key] && cfg.hotkeys[key].label) || '—' });
      btn.addEventListener('click', function () {
        if (btn.classList.contains('arm')) return;
        btn.classList.add('arm'); btn.textContent = 'Press a key…';
        invoke('settings:captureHotkey').then(function (res) {
          btn.classList.remove('arm');
          if (res && res.code) { btn.textContent = res.label; patch({ hotkeys: (function () { var o = {}; o[key] = { code: res.code, label: res.label }; return o; })() }); }
          else { btn.textContent = (cfg.hotkeys[key] && cfg.hotkeys[key].label) || '—'; }
        }).catch(function () { btn.classList.remove('arm'); btn.textContent = (cfg.hotkeys[key] && cfg.hotkeys[key].label) || '—'; toast('Capture cancelled'); });
      });
      sec.appendChild(row(hk[1], hk[2], h('div', { class: 'st-key' }, [btn])));
    });
    return sec;
  }

  function micSection() {
    var sec = h('div', { class: 'st-sec' }, [
      h('h2', { text: 'Microphone' }),
      h('div', { class: 'st-desc', text: 'Input device and gain. Whisper mode boosts quiet speech.' }),
    ]);
    var sel = h('select', { class: 'st-sel' });
    sel.appendChild(h('option', { value: 'default', text: 'System default' }));
    invoke('mic:list').then(function (devs) {
      (devs || []).forEach(function (d) { var o = h('option', { value: d.deviceId, text: d.label || 'Microphone' }); if (d.deviceId === cfg.mic.deviceId) o.selected = true; sel.appendChild(o); });
      if (cfg.mic.deviceId === 'default') sel.value = 'default';
    }).catch(function () {});
    sel.addEventListener('change', function () { patch({ mic: { deviceId: sel.value } }); });
    sec.appendChild(field('Device', sel));

    var g = h('input', { class: 'st-range', type: 'range', min: '0.5', max: '3', step: '0.1', value: String(cfg.mic.gain || 1) });
    var gv = h('span', { class: 'l', text: (cfg.mic.gain || 1).toFixed(1) + '×', style: 'min-width:38px;text-align:right' });
    g.addEventListener('input', function () { gv.textContent = parseFloat(g.value).toFixed(1) + '×'; patch({ mic: { gain: parseFloat(g.value) } }, true); });
    sec.appendChild(field('Input gain', h('div', { class: 'st-inline' }, [g, gv])));
    sec.appendChild(row('Whisper mode', 'Extra gain for speaking quietly', toggle(cfg.mic.whisperMode, function (v) { patch({ mic: { whisperMode: v } }); })));
    return sec;
  }

  function privacySection() {
    var sec = h('div', { class: 'st-sec' }, [
      h('h2', { text: 'Privacy & general' }),
      h('div', { class: 'st-desc', text: 'Nothing leaves your machine except calls to the providers you configured. No account, no telemetry.' }),
    ]);
    sec.appendChild(row('Local-only mode', 'Force on-device Whisper + offline cleanup. Zero cloud calls — audio never leaves this PC.', toggle(cfg.privacy.localOnly, function (v) { patch({ privacy: { localOnly: v } }); render(host); })));
    sec.appendChild(row('Store history', 'Keep a searchable local log of your dictations.', toggle(cfg.privacy.storeHistory, function (v) { patch({ privacy: { storeHistory: v } }); })));
    sec.appendChild(row('Show HUD', 'The floating pill with the live waveform while dictating.', toggle(cfg.ui.hud, function (v) { patch({ ui: { hud: v } }); })));
    sec.appendChild(row('Launch at login', 'Start Bol in the tray when Windows boots.', toggle(cfg.ui.launchAtLogin, function (v) { patch({ ui: { launchAtLogin: v } }); })));
    return sec;
  }

  var host = null;
  function render(el) {
    host = el;
    injectStyle();
    cfg = window.bolConfig;
    if (!cfg) { invoke('settings:get').then(function (c) { cfg = window.bolConfig = c; render(el); }); el.innerHTML = ''; return; }
    el.innerHTML = '';
    var wrap = h('div', { class: 'st' }, [
      h('h1', { text: 'Settings' }),
      h('p', { class: 'st-lede', text: 'Bring your own keys. Pay providers at cost. No subscription.' }),
      sttSection(), cleanupSection(), hotkeysSection(), micSection(), privacySection(),
    ]);
    el.appendChild(wrap);
  }

  window.BolPages.settings = { render: render };
})();
