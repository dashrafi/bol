// Bol — Snippets page. Registers window.BolPages.snippets (A9).
// Plain browser script: no modules, talks to main only via window.bol.
'use strict';
(function () {
  window.BolPages = window.BolPages || {};

  var seq = 0; // render token: stale async results are dropped

  var BASE_CSS = [
    '.bp-page{max-width:1040px;margin:0 auto;padding:30px 34px 56px;color:#e9ebf8;font-family:"Segoe UI Variable Text","Segoe UI Variable","Segoe UI",system-ui,sans-serif;animation:bp-in .28s ease both}',
    '@keyframes bp-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.bp-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;margin:0 0 24px}',
    '.bp-title{margin:0;font-size:26px;font-weight:700;letter-spacing:-.02em;color:#fff}',
    '.bp-sub{margin:7px 0 0;font-size:13.5px;line-height:1.55;color:#9298b8;max-width:640px}',
    '.bp-card{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.028));border:1px solid rgba(255,255,255,.09);border-radius:16px}',
    '.bp-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#e9ebf8;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .15s ease,transform .1s ease}',
    '.bp-btn:hover{background:rgba(255,255,255,.11)}',
    '.bp-btn:active{transform:scale(.97)}',
    '.bp-btn:disabled{opacity:.45;cursor:default;transform:none}',
    '.bp-btn-primary{border-color:transparent;background:linear-gradient(135deg,#6c7bff,#9a5bff);color:#fff;box-shadow:0 4px 18px rgba(108,123,255,.25)}',
    '.bp-btn-primary:hover{background:linear-gradient(135deg,#7d8aff,#a76fff)}',
    '.bp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#aab0cf;cursor:pointer;flex:none;transition:background .15s ease,color .15s ease}',
    '.bp-icon-btn.bp-danger:hover{background:rgba(255,92,120,.15);border-color:rgba(255,92,120,.4);color:#ffa8b8}',
    '.bp-icon-btn svg{width:15px;height:15px;pointer-events:none}',
    '.bp-input,.bp-textarea{width:100%;box-sizing:border-box;background:rgba(9,12,22,.55);border:1px solid rgba(255,255,255,.11);border-radius:10px;color:#e9ebf8;padding:10px 13px;font-size:13.5px;font-family:inherit;outline:none;transition:border-color .15s ease,box-shadow .15s ease}',
    '.bp-input::placeholder,.bp-textarea::placeholder{color:#63698e}',
    '.bp-input:focus,.bp-textarea:focus{border-color:rgba(108,123,255,.65);box-shadow:0 0 0 3px rgba(108,123,255,.16)}',
    '.bp-textarea{resize:vertical;min-height:70px;line-height:1.5}',
    '.bp-label{display:block;font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#8d93b4;margin:0 0 6px}',
    '.bp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:54px 24px;color:#8d93b4}',
    '.bp-empty svg{width:42px;height:42px;margin-bottom:14px;color:#585f88}',
    '.bp-empty-title{font-size:15px;font-weight:600;color:#c6cae4;margin:0 0 6px}',
    '.bp-empty-hint{font-size:13px;line-height:1.6;margin:0;max-width:420px}',
    '.bp-kbd{display:inline-block;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-bottom-width:2px;border-radius:6px;padding:1px 7px;font-size:11.5px;font-weight:600;color:#dfe2f5}',
    // page-specific
    '.bp-snip-form{display:flex;gap:14px;align-items:flex-start;padding:18px 20px;flex-wrap:wrap}',
    '.bp-snip-trigger{flex:0 0 200px}',
    '.bp-snip-text{flex:1 1 340px;min-width:260px}',
    '.bp-snip-add{align-self:stretch;display:flex;align-items:flex-end}',
    '.bp-rows{margin-top:18px}',
    '.bp-row{display:flex;align-items:flex-start;gap:14px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.06)}',
    '.bp-row:last-child{border-bottom:none}',
    '.bp-trig{flex:0 0 190px;display:flex;align-items:center;gap:8px}',
    '.bp-trig-say{font-size:11px;color:#666d92}',
    '.bp-trig-word{font-weight:700;font-size:13.5px;color:#cdb6ff;background:rgba(154,91,255,.12);border:1px solid rgba(154,91,255,.3);border-radius:8px;padding:3px 10px;overflow-wrap:anywhere}',
    '.bp-exp{flex:1;min-width:0;color:#c9cdec;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.bp-note{font-size:12.5px;color:#8d93b4;padding:8px 2px 0;line-height:1.5}',
  ].join('\n');

  var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  var ICON_ZAP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';

  function ensureStyle(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style'); s.id = id; s.textContent = css; document.head.appendChild(s);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function invoke(ch, payload) {
    try { if (window.bol && typeof window.bol.invoke === 'function') return Promise.resolve(window.bol.invoke(ch, payload)); }
    catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('Bridge unavailable'));
  }
  function toast(msg) { try { if (typeof window.bolToast === 'function') window.bolToast(msg); } catch (e) {} }

  // normalize a spoken trigger to a single lowercase word (matches snippets.expandSpoken on main)
  function normTrigger(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  function render(el) {
    ensureStyle('bp-snip-style', BASE_CSS);
    var mine = ++seq;
    el.innerHTML = '';

    var page = document.createElement('div');
    page.className = 'bp-page';
    page.innerHTML =
      '<div class="bp-head">' +
        '<div><h1 class="bp-title">Snippets</h1>' +
        '<p class="bp-sub">Say <span class="bp-kbd">insert&nbsp;&lt;trigger&gt;</span> (or “&lt;trigger&gt; daalo”) mid-dictation and Bol swaps in the full text — signatures, addresses, boilerplate. Triggers are single words, matched case-insensitively.</p></div>' +
      '</div>';

    // add form
    var form = document.createElement('div');
    form.className = 'bp-card bp-snip-form';
    form.innerHTML =
      '<div class="bp-snip-trigger"><label class="bp-label">Trigger word</label>' +
        '<input class="bp-input" id="bp-snip-trig" placeholder="address" autocomplete="off"></div>' +
      '<div class="bp-snip-text"><label class="bp-label">Expands to</label>' +
        '<textarea class="bp-textarea" id="bp-snip-text" placeholder="House 12, Street 4, F-8/3, Islamabad"></textarea></div>' +
      '<div class="bp-snip-add"><button class="bp-btn bp-btn-primary" id="bp-snip-save" type="button" disabled>Add snippet</button></div>';
    page.appendChild(form);

    var rows = document.createElement('div');
    rows.className = 'bp-rows';
    page.appendChild(rows);
    el.appendChild(page);

    var trig = form.querySelector('#bp-snip-trig');
    var text = form.querySelector('#bp-snip-text');
    var save = form.querySelector('#bp-snip-save');

    function validate() { save.disabled = !(normTrigger(trig.value) && text.value.trim()); }
    trig.addEventListener('input', validate);
    text.addEventListener('input', validate);

    function doSave() {
      var t = normTrigger(trig.value), body = text.value.trim();
      if (!t || !body) return;
      if (/\s/.test(t)) { toast('Trigger must be a single word'); return; }
      save.disabled = true;
      invoke('snippets:add', { trigger: t, text: body }).then(function () {
        trig.value = ''; text.value = ''; validate();
        toast('Snippet added');
        load();
      }).catch(function (e) { toast('Could not add: ' + e.message); validate(); });
    }
    save.addEventListener('click', doSave);
    trig.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); text.focus(); } });

    function load() {
      invoke('snippets:list').then(function (list) {
        if (mine !== seq) return;
        paint(list || []);
      }).catch(function () { if (mine === seq) paint([]); });
    }

    function paint(list) {
      rows.innerHTML = '';
      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'bp-card bp-empty';
        empty.innerHTML = ICON_ZAP +
          '<div class="bp-empty-title">No snippets yet</div>' +
          '<p class="bp-empty-hint">Add one above, then say “insert &lt;trigger&gt;” while dictating and the full text drops in. Great for email signatures, addresses, and canned replies.</p>';
        rows.appendChild(empty);
        return;
      }
      var card = document.createElement('div');
      card.className = 'bp-card';
      list.forEach(function (s) {
        var row = document.createElement('div');
        row.className = 'bp-row';
        row.innerHTML =
          '<div class="bp-trig"><span class="bp-trig-say">say</span><span class="bp-trig-word">' + esc(s.trigger) + '</span></div>' +
          '<div class="bp-exp">' + esc(s.text) + '</div>';
        var del = document.createElement('button');
        del.className = 'bp-icon-btn bp-danger';
        del.title = 'Remove'; del.innerHTML = ICON_TRASH;
        del.addEventListener('click', function () {
          del.disabled = true;
          invoke('snippets:remove', s.trigger).then(function () { toast('Removed'); load(); })
            .catch(function (e) { toast('Could not remove: ' + e.message); del.disabled = false; });
        });
        row.appendChild(del);
        card.appendChild(row);
      });
      rows.appendChild(card);

      var note = document.createElement('div');
      note.className = 'bp-note';
      note.innerHTML = 'Tip: keep triggers short and distinctive so they don’t collide with normal speech.';
      rows.appendChild(note);
    }

    load();
  }

  window.BolPages.snippets = { render: render };
})();
