// Bol — Dictionary page. Registers window.BolPages.dictionary (A9).
// Plain browser script: no modules, talks to main only via window.bol.
'use strict';
(function () {
  window.BolPages = window.BolPages || {};

  var seq = 0; // render token: stale async results are dropped

  // ---------------------------------------------------------------- styles
  var BASE_CSS = [
    '.bp-page{max-width:1040px;margin:0 auto;padding:30px 34px 56px;color:#e9ebf8;font-family:"Segoe UI Variable Text","Segoe UI Variable","Segoe UI",system-ui,sans-serif;animation:bp-in .28s ease both}',
    '@keyframes bp-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.bp-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;margin:0 0 24px}',
    '.bp-title{margin:0;font-size:26px;font-weight:700;letter-spacing:-.02em;color:#fff}',
    '.bp-sub{margin:7px 0 0;font-size:13.5px;line-height:1.55;color:#9298b8;max-width:600px}',
    '.bp-card{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.028));border:1px solid rgba(255,255,255,.09);border-radius:16px;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}',
    '.bp-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#e9ebf8;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;user-select:none;transition:background .15s ease,border-color .15s ease,color .15s ease,transform .1s ease}',
    '.bp-btn:hover{background:rgba(255,255,255,.11)}',
    '.bp-btn:active{transform:scale(.97)}',
    '.bp-btn:disabled{opacity:.45;cursor:default;transform:none}',
    '.bp-btn-primary{border-color:transparent;background:linear-gradient(135deg,#6c7bff,#9a5bff);color:#fff;box-shadow:0 4px 18px rgba(108,123,255,.25)}',
    '.bp-btn-primary:hover{background:linear-gradient(135deg,#7d8aff,#a76fff)}',
    '.bp-btn-danger:hover{background:rgba(255,92,120,.14);border-color:rgba(255,92,120,.45);color:#ffa8b8}',
    '.bp-btn.bp-armed{background:rgba(255,92,120,.18);border-color:rgba(255,92,120,.55);color:#ffb3c1}',
    '.bp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#aab0cf;cursor:pointer;flex:none;transition:background .15s ease,color .15s ease,border-color .15s ease}',
    '.bp-icon-btn:hover{background:rgba(255,255,255,.13);color:#fff}',
    '.bp-icon-btn.bp-danger:hover{background:rgba(255,92,120,.15);border-color:rgba(255,92,120,.4);color:#ffa8b8}',
    '.bp-icon-btn svg{width:15px;height:15px;pointer-events:none}',
    '.bp-input,.bp-textarea{width:100%;box-sizing:border-box;background:rgba(9,12,22,.55);border:1px solid rgba(255,255,255,.11);border-radius:10px;color:#e9ebf8;padding:9px 13px;font-size:13.5px;font-family:inherit;outline:none;transition:border-color .15s ease,box-shadow .15s ease}',
    '.bp-input::placeholder,.bp-textarea::placeholder{color:#63698e}',
    '.bp-input:focus,.bp-textarea:focus{border-color:rgba(108,123,255,.65);box-shadow:0 0 0 3px rgba(108,123,255,.16)}',
    '.bp-textarea{resize:vertical;min-height:80px;line-height:1.5}',
    '.bp-label{display:block;font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#8d93b4;margin:0 0 6px}',
    '.bp-badge{display:inline-flex;align-items:center;gap:5px;background:rgba(108,123,255,.13);border:1px solid rgba(108,123,255,.28);color:#b0baff;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;letter-spacing:.02em;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:54px 24px;color:#8d93b4}',
    '.bp-empty svg{width:42px;height:42px;margin-bottom:14px;color:#585f88}',
    '.bp-empty-title{font-size:15px;font-weight:600;color:#c6cae4;margin:0 0 6px}',
    '.bp-empty-hint{font-size:13px;line-height:1.6;margin:0;max-width:400px}',
    '.bp-kbd{display:inline-block;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-bottom-width:2px;border-radius:6px;padding:1px 7px;font-size:11.5px;font-weight:600;color:#dfe2f5}',
    '.bp-skel{height:64px;border-radius:16px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.08),rgba(255,255,255,.04));background-size:200% 100%;animation:bp-shimmer 1.3s linear infinite}',
    '@keyframes bp-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
    '.bp-toast-wrap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;z-index:9999;pointer-events:none}',
    '.bp-toast{display:flex;align-items:center;gap:9px;background:rgba(17,20,33,.95);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 18px;font-size:13px;font-weight:600;color:#e9ebf8;box-shadow:0 10px 34px rgba(0,0,0,.5);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);animation:bp-toast-in .22s ease both}',
    '.bp-toast.bp-toast-out{animation:bp-toast-out .25s ease both}',
    '@keyframes bp-toast-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '@keyframes bp-toast-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(8px)}}',
    '.bp-toast-dot{width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,#6c7bff,#9a5bff);flex:none}',
  ].join('\n');

  var PAGE_CSS = [
    '.bp-dict-form{display:flex;gap:12px;align-items:flex-end;padding:18px 20px;flex-wrap:wrap}',
    '.bp-dict-field{flex:1 1 200px;min-width:180px}',
    '.bp-dict-field .bp-opt{font-weight:500;text-transform:none;letter-spacing:0;color:#666d92}',
    '.bp-panel{padding:20px 22px;margin-top:16px}',
    '.bp-panel-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14px;font-weight:700;color:#dfe2f5;margin:0 0 6px}',
    '.bp-panel-sub{font-size:12.5px;color:#8d93b4;margin:0 0 14px;line-height:1.5}',
    '.bp-chips{display:flex;flex-wrap:wrap;gap:8px}',
    '.bp-chip{display:inline-flex;align-items:center;gap:7px;background:rgba(154,91,255,.12);border:1px solid rgba(154,91,255,.32);color:#cdb6ff;border-radius:999px;padding:6px 13px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
    '.bp-chip:hover{background:rgba(154,91,255,.24);border-color:rgba(154,91,255,.5)}',
    '.bp-chip:disabled{opacity:.5;cursor:default}',
    '.bp-chip .bp-chip-plus{font-size:14px;line-height:1;color:#b18aff}',
    '.bp-dict-rows{margin-top:8px}',
    '.bp-dict-row{display:flex;align-items:center;gap:12px;padding:11px 2px;border-bottom:1px solid rgba(255,255,255,.06)}',
    '.bp-dict-row:last-child{border-bottom:none}',
    '.bp-dict-word{font-weight:600;font-size:14px;color:#e9ebf8;overflow-wrap:anywhere}',
    '.bp-dict-sounds{flex:1;min-width:0;color:#8d93b4;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bp-dict-note{font-size:12.5px;color:#8d93b4;padding:6px 0}',
  ].join('\n');

  var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  var ICON_BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';

  // --------------------------------------------------------------- helpers
  function ensureStyle(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function invoke(ch, payload) {
    try {
      if (window.bol && typeof window.bol.invoke === 'function') return Promise.resolve(window.bol.invoke(ch, payload));
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('Bridge unavailable'));
  }

  function toast(msg) {
    try { if (typeof window.bolToast === 'function') { window.bolToast(msg); return; } } catch (e) { /* fall through */ }
    ensureStyle('bp-style-base', BASE_CSS);
    var wrap = document.querySelector('.bp-toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'bp-toast-wrap'; document.body.appendChild(wrap); }
    var t = document.createElement('div');
    t.className = 'bp-toast';
    t.innerHTML = '<span class="bp-toast-dot"></span>' + esc(msg);
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('bp-toast-out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, 2600);
  }

  function normalizeEntries(res) {
    var arr = Array.isArray(res) ? res : (res && Array.isArray(res.items) ? res.items : []);
    return arr.map(function (e) {
      if (typeof e === 'string') return { word: e, soundsLike: '' };
      if (e && typeof e === 'object') return { word: String(e.word || ''), soundsLike: String(e.soundsLike || '') };
      return { word: '', soundsLike: '' };
    }).filter(function (e) { return e.word; });
  }

  function normalizeSuggestions(res) {
    var arr = Array.isArray(res) ? res : (res && Array.isArray(res.items) ? res.items : []);
    var out = [];
    arr.forEach(function (s) {
      var w = typeof s === 'string' ? s : (s && typeof s === 'object' ? String(s.word || s.text || '') : '');
      w = w.trim();
      if (w) out.push(w);
    });
    return out;
  }

  // ---------------------------------------------------------------- render
  function render(el) {
    ensureStyle('bp-style-base', BASE_CSS);
    ensureStyle('bp-style-dictionary', PAGE_CSS);
    var mySeq = ++seq;
    el.innerHTML = '';

    var page = document.createElement('div');
    page.className = 'bp-page bp-dict';
    page.innerHTML =
      '<header class="bp-head">' +
        '<div>' +
          '<h1 class="bp-title">Dictionary</h1>' +
          '<p class="bp-sub">Teach Bol the names, jargon, and brand words it should always spell correctly. Add a “sounds like” hint when a word keeps getting misheard.</p>' +
        '</div>' +
      '</header>' +
      '<div class="bp-card">' +
        '<form class="bp-dict-form" data-role="form">' +
          '<div class="bp-dict-field">' +
            '<label class="bp-label">Word or name</label>' +
            '<input class="bp-input" data-role="word" type="text" placeholder="e.g. Timegram" autocomplete="off" spellcheck="false">' +
          '</div>' +
          '<div class="bp-dict-field">' +
            '<label class="bp-label">Sounds like <span class="bp-opt">(optional)</span></label>' +
            '<input class="bp-input" data-role="sounds" type="text" placeholder="e.g. time gram" autocomplete="off" spellcheck="false">' +
          '</div>' +
          '<button class="bp-btn bp-btn-primary" type="submit">Add word</button>' +
        '</form>' +
      '</div>' +
      '<section class="bp-card bp-panel" data-role="suggest-panel">' +
        '<h2 class="bp-panel-title">✨ Suggestions from your dictations</h2>' +
        '<p class="bp-panel-sub">Unusual words that keep showing up in your raw transcripts — one click adds them.</p>' +
        '<div data-role="suggest"><div class="bp-skel" style="height:36px"></div></div>' +
      '</section>' +
      '<section class="bp-card bp-panel">' +
        '<h2 class="bp-panel-title">Your words <small data-role="count"></small></h2>' +
        '<div class="bp-dict-rows" data-role="list"><div class="bp-skel"></div></div>' +
      '</section>';
    el.appendChild(page);

    var form = page.querySelector('[data-role="form"]');
    var wordInput = page.querySelector('[data-role="word"]');
    var soundsInput = page.querySelector('[data-role="sounds"]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var suggestBox = page.querySelector('[data-role="suggest"]');
    var listBox = page.querySelector('[data-role="list"]');
    var countEl = page.querySelector('[data-role="count"]');

    var entries = [];

    function paintList() {
      countEl.textContent = entries.length ? '(' + entries.length + ')' : '';
      listBox.innerHTML = '';
      if (!entries.length) {
        var empty = document.createElement('div');
        empty.className = 'bp-empty';
        empty.style.padding = '30px 12px';
        empty.innerHTML = ICON_BOOK +
          '<p class="bp-empty-title">No custom words yet</p>' +
          '<p class="bp-empty-hint">Add product names, teammates, or Roman Urdu terms above and Bol will spell them right every time.</p>';
        listBox.appendChild(empty);
        return;
      }
      entries.forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'bp-dict-row';
        row.innerHTML =
          '<span class="bp-dict-word">' + esc(entry.word) + '</span>' +
          '<span class="bp-dict-sounds">' + (entry.soundsLike ? 'sounds like “' + esc(entry.soundsLike) + '”' : '') + '</span>' +
          '<button class="bp-icon-btn bp-danger" type="button" title="Remove ' + esc(entry.word) + '">' + ICON_TRASH + '</button>';
        row.querySelector('button').addEventListener('click', function () {
          this.disabled = true;
          invoke('dict:remove', entry.word).then(function () {
            if (mySeq !== seq) return;
            toast('Removed “' + entry.word + '”');
            load();
          }).catch(function () { toast('Could not remove word'); });
        });
        listBox.appendChild(row);
      });
    }

    function paintSuggestions(words) {
      suggestBox.innerHTML = '';
      if (!words.length) {
        var note = document.createElement('div');
        note.className = 'bp-dict-note';
        note.textContent = 'No suggestions right now — they appear once Bol notices unfamiliar words you dictate often.';
        suggestBox.appendChild(note);
        return;
      }
      var chips = document.createElement('div');
      chips.className = 'bp-chips';
      words.forEach(function (w) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'bp-chip';
        chip.title = 'Add “' + w + '” to your dictionary';
        chip.innerHTML = esc(w) + ' <span class="bp-chip-plus">+</span>';
        chip.addEventListener('click', function () {
          chip.disabled = true;
          addWord(w, '', function ok() { /* load() repaints everything */ }, function fail() { chip.disabled = false; });
        });
        chips.appendChild(chip);
      });
      suggestBox.appendChild(chips);
    }

    function addWord(word, soundsLike, onOk, onFail) {
      invoke('dict:add', { word: word, soundsLike: soundsLike || undefined })
        .then(function () {
          if (mySeq !== seq) return;
          toast('Added “' + word + '”');
          if (onOk) onOk();
          load();
        })
        .catch(function () {
          toast('Could not add word');
          if (onFail) onFail();
        });
    }

    function load() {
      Promise.all([
        invoke('dict:list').catch(function () { return []; }),
        invoke('dict:suggest').catch(function () { return []; }),
      ]).then(function (results) {
        if (mySeq !== seq) return;
        entries = normalizeEntries(results[0]);
        var existing = {};
        entries.forEach(function (e) { existing[e.word.toLowerCase()] = true; });
        var suggestions = normalizeSuggestions(results[1]).filter(function (w) { return !existing[w.toLowerCase()]; });
        paintList();
        paintSuggestions(suggestions);
      });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var word = wordInput.value.trim();
      var sounds = soundsInput.value.trim();
      if (!word) { toast('Type a word first'); wordInput.focus(); return; }
      var dup = entries.some(function (e) { return e.word.toLowerCase() === word.toLowerCase(); });
      if (dup) { toast('“' + word + '” is already in your dictionary'); return; }
      submitBtn.disabled = true;
      addWord(word, sounds, function () {
        if (mySeq !== seq) return;
        wordInput.value = '';
        soundsInput.value = '';
        submitBtn.disabled = false;
        wordInput.focus();
      }, function () {
        if (mySeq !== seq) return;
        submitBtn.disabled = false;
      });
    });

    load();
  }

  window.BolPages.dictionary = { render: render };
})();
