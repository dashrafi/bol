// Bol — History page. Registers window.BolPages.history (A9).
// Plain browser script: no modules, talks to main only via window.bol.
'use strict';
(function () {
  window.BolPages = window.BolPages || {};

  var PAGE_LIMIT = 50;
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
    '.bp-hist-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.bp-search{position:relative}',
    '.bp-search input{width:260px;padding-left:34px}',
    '.bp-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:#666d92;pointer-events:none}',
    '.bp-hist-list{display:flex;flex-direction:column;gap:12px}',
    '.bp-hist-row{padding:16px 18px;display:flex;gap:14px;align-items:flex-start;transition:border-color .15s ease}',
    '.bp-hist-row:hover{border-color:rgba(255,255,255,.17)}',
    '.bp-hist-main{flex:1;min-width:0}',
    '.bp-hist-text{font-size:14px;line-height:1.6;color:#e9ebf8;white-space:pre-wrap;word-break:break-word}',
    '.bp-hist-meta{display:flex;align-items:center;gap:12px;margin-top:9px;font-size:12px;color:#8d93b4;flex-wrap:wrap}',
    '.bp-hist-raw{margin-top:12px;padding:11px 14px;background:rgba(0,0,0,.28);border:1px dashed rgba(255,255,255,.13);border-radius:10px}',
    '.bp-hist-raw-label{font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#7d84ab;margin-bottom:5px}',
    '.bp-hist-raw-text{font-size:13px;line-height:1.55;color:#aab0cf;white-space:pre-wrap;word-break:break-word}',
    '.bp-hist-actions{display:flex;gap:6px;flex:none}',
    '.bp-hist-actions .bp-icon-btn[data-act="raw"].bp-open{color:#b0baff;border-color:rgba(108,123,255,.45);background:rgba(108,123,255,.12)}',
    '.bp-hist-actions .bp-icon-btn[data-act="raw"] svg{transition:transform .18s ease}',
    '.bp-hist-actions .bp-icon-btn[data-act="raw"].bp-open svg{transform:rotate(180deg)}',
    '.bp-hist-more{display:flex;justify-content:center;margin-top:18px}',
    '.bp-hist-err{padding:20px;text-align:center;color:#ffa8b8;font-size:13px}',
  ].join('\n');

  var ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  var ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  var ICON_INSERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  var ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4"/><path d="M8 22h8"/></svg>';

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

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function relTime(ts) {
    var t = +ts || 0;
    if (!t) return '';
    var diff = Date.now() - t;
    if (diff < 45000) return 'just now';
    var m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    var dt = new Date(t);
    var y = dt.getFullYear() !== new Date().getFullYear() ? ' ' + dt.getFullYear() : '';
    return MON[dt.getMonth()] + ' ' + dt.getDate() + y;
  }

  function normalizeList(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.items)) return res.items;
    return [];
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return invoke('insert:text', text); });
    }
    return invoke('insert:text', text);
  }

  // ---------------------------------------------------------------- render
  function render(el) {
    ensureStyle('bp-style-base', BASE_CSS);
    ensureStyle('bp-style-history', PAGE_CSS);
    var mySeq = ++seq;
    el.innerHTML = '';

    var state = { query: '', items: [], done: false, loading: false, loadedOnce: false };

    var page = document.createElement('div');
    page.className = 'bp-page bp-hist';
    page.innerHTML =
      '<header class="bp-head">' +
        '<div>' +
          '<h1 class="bp-title">History</h1>' +
          '<p class="bp-sub">Everything you’ve dictated, newest first. Expand a row to compare the raw transcript with the polished text.</p>' +
        '</div>' +
        '<div class="bp-hist-controls">' +
          '<div class="bp-search">' + ICON_SEARCH +
            '<input class="bp-input" type="text" placeholder="Search dictations…" aria-label="Search history">' +
          '</div>' +
          '<button class="bp-btn bp-btn-danger" data-act="clear" type="button">Clear all</button>' +
        '</div>' +
      '</header>' +
      '<div class="bp-hist-list" data-role="list"></div>' +
      '<div class="bp-hist-more" data-role="more" hidden>' +
        '<button class="bp-btn" type="button">Load more</button>' +
      '</div>';
    el.appendChild(page);

    var listEl = page.querySelector('[data-role="list"]');
    var moreWrap = page.querySelector('[data-role="more"]');
    var moreBtn = moreWrap.querySelector('button');
    var searchInput = page.querySelector('.bp-search input');
    var clearBtn = page.querySelector('[data-act="clear"]');

    // -- skeleton while first load runs
    listEl.innerHTML = '<div class="bp-skel"></div><div class="bp-skel"></div><div class="bp-skel"></div>';

    function emptyState() {
      var div = document.createElement('div');
      div.className = 'bp-card bp-empty';
      if (state.query) {
        div.innerHTML = ICON_SEARCH +
          '<p class="bp-empty-title">No matches for “' + esc(state.query) + '”</p>' +
          '<p class="bp-empty-hint">Try a different word — search looks at the raw transcript, the polished text, and the app name.</p>';
      } else {
        div.innerHTML = ICON_MIC +
          '<p class="bp-empty-title">Nothing here yet</p>' +
          '<p class="bp-empty-hint">Hold your push-to-talk key in any app and start speaking — every dictation lands here automatically.</p>';
      }
      return div;
    }

    function rowEl(item) {
      var row = document.createElement('article');
      row.className = 'bp-card bp-hist-row';
      var polished = String(item.polished || item.raw || '');
      var raw = String(item.raw || '');
      var words = (item.words != null && isFinite(+item.words))
        ? +item.words
        : polished.split(/\s+/).filter(Boolean).length;
      row.innerHTML =
        '<div class="bp-hist-main">' +
          '<div class="bp-hist-text">' + esc(polished) + '</div>' +
          '<div class="bp-hist-meta">' +
            (item.app ? '<span class="bp-badge" title="' + esc(item.title || item.app) + '">' + esc(item.app) + '</span>' : '') +
            '<span>' + esc(relTime(item.ts)) + '</span>' +
            '<span>' + words + (words === 1 ? ' word' : ' words') + '</span>' +
            (item.provider ? '<span>' + esc(item.provider) + '</span>' : '') +
          '</div>' +
          '<div class="bp-hist-raw" hidden>' +
            '<div class="bp-hist-raw-label">Raw transcript</div>' +
            '<div class="bp-hist-raw-text">' + esc(raw || '(no raw transcript stored)') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="bp-hist-actions">' +
          '<button class="bp-icon-btn" data-act="raw" type="button" title="Show raw transcript">' + ICON_CHEV + '</button>' +
          '<button class="bp-icon-btn" data-act="copy" type="button" title="Copy text">' + ICON_COPY + '</button>' +
          '<button class="bp-icon-btn" data-act="insert" type="button" title="Re-insert (copies to clipboard)">' + ICON_INSERT + '</button>' +
          '<button class="bp-icon-btn bp-danger" data-act="del" type="button" title="Delete">' + ICON_TRASH + '</button>' +
        '</div>';

      row.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
        if (!btn || !row.contains(btn)) return;
        var act = btn.getAttribute('data-act');
        if (act === 'raw') {
          var rawBox = row.querySelector('.bp-hist-raw');
          var open = rawBox.hasAttribute('hidden');
          if (open) rawBox.removeAttribute('hidden'); else rawBox.setAttribute('hidden', '');
          btn.classList.toggle('bp-open', open);
          btn.title = open ? 'Hide raw transcript' : 'Show raw transcript';
        } else if (act === 'copy') {
          copyText(polished).then(function () { toast('Copied to clipboard'); })
            .catch(function () { toast('Could not copy'); });
        } else if (act === 'insert') {
          invoke('insert:text', polished)
            .then(function () { toast('Copied — paste it where you need it'); })
            .catch(function () { toast('Could not re-insert'); });
        } else if (act === 'del') {
          btn.disabled = true;
          invoke('history:delete', item.id).then(function () {
            if (mySeq !== seq) return;
            state.items = state.items.filter(function (it) { return it.id !== item.id; });
            paint();
            toast('Deleted');
          }).catch(function () { btn.disabled = false; toast('Could not delete'); });
        }
      });
      return row;
    }

    function paint() {
      listEl.innerHTML = '';
      if (!state.items.length) {
        listEl.appendChild(emptyState());
      } else {
        for (var i = 0; i < state.items.length; i++) listEl.appendChild(rowEl(state.items[i]));
      }
      moreWrap.hidden = state.done || !state.items.length;
      clearBtn.disabled = !state.items.length && !state.query;
    }

    function paintError(err) {
      listEl.innerHTML = '';
      var d = document.createElement('div');
      d.className = 'bp-card bp-hist-err';
      d.textContent = 'Could not load history' + (err && err.message ? ' — ' + err.message : '') + '.';
      listEl.appendChild(d);
      moreWrap.hidden = true;
    }

    function load(reset) {
      if (state.loading) return;
      state.loading = true;
      moreBtn.disabled = true;
      var offset = reset ? 0 : state.items.length;
      invoke('history:list', { query: state.query, limit: PAGE_LIMIT, offset: offset })
        .then(function (res) {
          if (mySeq !== seq) return;
          var batch = normalizeList(res);
          state.items = reset ? batch : state.items.concat(batch);
          state.done = batch.length < PAGE_LIMIT;
          state.loadedOnce = true;
          paint();
        })
        .catch(function (err) { if (mySeq === seq) paintError(err); })
        .then(function () {
          if (mySeq !== seq) return;
          state.loading = false;
          moreBtn.disabled = false;
        });
    }

    // -- search (debounced)
    var deb = null;
    searchInput.addEventListener('input', function () {
      if (deb) clearTimeout(deb);
      deb = setTimeout(function () {
        if (mySeq !== seq) return;
        var q = searchInput.value.trim();
        if (q === state.query && state.loadedOnce) return;
        state.query = q;
        load(true);
      }, 250);
    });

    // -- clear all (two-step confirm)
    var armTimer = null;
    function disarmClear() {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      delete clearBtn.dataset.armed;
      clearBtn.classList.remove('bp-armed');
      clearBtn.textContent = 'Clear all';
    }
    clearBtn.addEventListener('click', function () {
      if (clearBtn.dataset.armed) {
        disarmClear();
        clearBtn.disabled = true;
        invoke('history:clear').then(function () {
          if (mySeq !== seq) return;
          state.items = [];
          state.done = true;
          paint();
          toast('History cleared');
        }).catch(function () {
          if (mySeq !== seq) return;
          clearBtn.disabled = false;
          toast('Could not clear history');
        });
      } else {
        clearBtn.dataset.armed = '1';
        clearBtn.classList.add('bp-armed');
        clearBtn.textContent = 'Really clear everything?';
        armTimer = setTimeout(disarmClear, 3500);
      }
    });

    // -- load more
    moreBtn.addEventListener('click', function () { load(false); });

    load(true);
  }

  window.BolPages.history = { render: render };
})();
