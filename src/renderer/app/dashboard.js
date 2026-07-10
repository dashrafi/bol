// Bol — Dashboard page. Registers window.BolPages.dashboard (A9).
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
    '.bp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:16px}',
    '.bp-stat{padding:20px 22px;position:relative;overflow:hidden}',
    '.bp-stat::before{content:"";position:absolute;inset:0;background:radial-gradient(130% 90% at 0% 0%,rgba(108,123,255,.14),transparent 62%);pointer-events:none}',
    '.bp-stat-val{font-size:30px;font-weight:700;letter-spacing:-.03em;color:#fff;line-height:1.15;white-space:nowrap}',
    '.bp-stat-val .bp-fire{font-size:22px;margin-left:2px}',
    '.bp-stat-label{margin-top:6px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8d93b4}',
    '.bp-panel{padding:20px 22px;margin-bottom:16px;overflow:visible}',
    '.bp-panel-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14px;font-weight:700;color:#dfe2f5;margin:0 0 16px}',
    '.bp-panel-title small{font-size:12px;font-weight:500;color:#8d93b4}',
    '.bp-dash-grid{display:grid;grid-template-columns:1fr 1.3fr;gap:14px;align-items:start}',
    '@media(max-width:920px){.bp-dash-grid{grid-template-columns:1fr}}',
    '.bp-dash-grid .bp-panel{margin-bottom:0}',
    '.bp-chart{display:flex;align-items:flex-end;gap:4px;height:168px;padding-top:30px}',
    '.bp-chart-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative;cursor:default}',
    '.bp-chart-bar{width:100%;min-height:3px;border-radius:4px 4px 2px 2px;background:linear-gradient(180deg,#6c7bff,#9a5bff);opacity:.9;transition:filter .12s ease}',
    '.bp-chart-bar.bp-zero{background:rgba(255,255,255,.08)}',
    '.bp-chart-col:hover .bp-chart-bar{filter:brightness(1.4)}',
    '.bp-chart-tip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:rgba(14,17,30,.97);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 10px;font-size:11.5px;color:#dfe2f5;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s ease;z-index:6;box-shadow:0 6px 20px rgba(0,0,0,.45)}',
    '.bp-chart-tip b{color:#fff;font-weight:700}',
    '.bp-chart-col:hover .bp-chart-tip{opacity:1}',
    '.bp-chart-tip.bp-tip-left{left:0;transform:none}',
    '.bp-chart-tip.bp-tip-right{left:auto;right:0;transform:none}',
    '.bp-chart-axis{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:#666d92}',
    '.bp-apps{display:flex;flex-direction:column;gap:14px}',
    '.bp-app-head{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;margin-bottom:6px}',
    '.bp-app-name{font-weight:600;color:#dfe2f5;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bp-app-words{color:#8d93b4;flex:none}',
    '.bp-app-bar{height:8px;background:rgba(255,255,255,.07);border-radius:999px;overflow:hidden}',
    '.bp-app-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#6c7bff,#9a5bff)}',
    '.bp-recent{display:flex;flex-direction:column}',
    '.bp-recent-row{display:flex;gap:12px;align-items:baseline;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}',
    '.bp-recent-row:first-child{padding-top:0}',
    '.bp-recent-row:last-child{border-bottom:none;padding-bottom:0}',
    '.bp-recent-text{flex:1;min-width:0;font-size:13px;color:#c6cae4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bp-recent-meta{flex:none;font-size:11.5px;color:#8d93b4;display:flex;gap:8px;align-items:baseline}',
    '.bp-dash-note{font-size:12.5px;color:#8d93b4;padding:8px 0}',
  ].join('\n');

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

  function fmt(n) {
    n = Math.round(+n || 0);
    try { return n.toLocaleString('en-US'); } catch (e) { return String(n); }
  }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

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
    return MON[dt.getMonth()] + ' ' + dt.getDate();
  }

  // Normalize analytics.days (array of {date,words,...} or map date->{...}) into a
  // dense 30-day window ending today, so the chart is always 30 bars.
  function last30(daysRaw) {
    var map = {};
    var arr = [];
    if (Array.isArray(daysRaw)) {
      arr = daysRaw;
    } else if (daysRaw && typeof daysRaw === 'object') {
      arr = Object.keys(daysRaw).map(function (k) {
        var v = daysRaw[k] || {};
        return { date: k, words: v.words, sessions: v.sessions };
      });
    }
    arr.forEach(function (d) { if (d && d.date) map[String(d.date)] = d; });
    var out = [];
    var now = new Date();
    for (var i = 29; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      var key = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      var rec = map[key] || {};
      out.push({
        date: key,
        label: MON[d.getMonth()] + ' ' + d.getDate(),
        words: Math.max(0, Math.round(+rec.words || 0)),
        sessions: Math.max(0, Math.round(+rec.sessions || 0)),
      });
    }
    return out;
  }

  // topApps may arrive as [{app,words}] / [{exe,words}] / [[name,words]] / {exe:words}
  function normalizeTopApps(raw) {
    var list = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (it) {
        if (Array.isArray(it)) list.push({ name: String(it[0] || ''), words: +it[1] || 0 });
        else if (it && typeof it === 'object') {
          list.push({
            name: String(it.app || it.exe || it.name || ''),
            words: +(it.words != null ? it.words : (it.count != null ? it.count : it.total)) || 0,
          });
        }
      });
    } else if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) { list.push({ name: k, words: +raw[k] || 0 }); });
    }
    return list.filter(function (a) { return a.name; })
      .sort(function (a, b) { return b.words - a.words; })
      .slice(0, 5);
  }

  function normalizeList(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.items)) return res.items;
    return [];
  }

  // ---------------------------------------------------------------- render
  function render(el) {
    ensureStyle('bp-style-base', BASE_CSS);
    ensureStyle('bp-style-dashboard', PAGE_CSS);
    var mySeq = ++seq;
    el.innerHTML = '';

    var page = document.createElement('div');
    page.className = 'bp-page bp-dash';
    page.innerHTML =
      '<header class="bp-head">' +
        '<div>' +
          '<h1 class="bp-title">Dashboard</h1>' +
          '<p class="bp-sub">Your dictation, at a glance.</p>' +
        '</div>' +
      '</header>' +
      '<div data-role="body">' +
        '<div class="bp-stats"><div class="bp-skel"></div><div class="bp-skel"></div><div class="bp-skel"></div><div class="bp-skel"></div></div>' +
        '<div class="bp-skel" style="height:220px"></div>' +
      '</div>';
    el.appendChild(page);

    var body = page.querySelector('[data-role="body"]');

    Promise.all([
      invoke('analytics:get').catch(function () { return null; }),
      invoke('history:list', { query: '', limit: 5, offset: 0 }).catch(function () { return []; }),
    ]).then(function (results) {
      if (mySeq !== seq) return;
      paint(body, results[0] || {}, normalizeList(results[1]));
    });
  }

  function statCard(valueHtml, label) {
    return '<div class="bp-card bp-stat">' +
      '<div class="bp-stat-val">' + valueHtml + '</div>' +
      '<div class="bp-stat-label">' + esc(label) + '</div>' +
    '</div>';
  }

  function paint(body, an, recent) {
    var totalWords = +an.totalWords || 0;
    var avgWpm = +an.avgWpm || 0;
    var minutesSaved = Math.max(0, Math.round(+an.minutesSaved || 0));
    var streak = Math.max(0, Math.round(+an.streakDays || 0));
    var days = last30(an.days);
    var apps = normalizeTopApps(an.topApps);

    // --- hero stats
    var html = '<div class="bp-stats">' +
      statCard(fmt(totalWords), 'Total words') +
      statCard(fmt(avgWpm), 'Avg words / min') +
      statCard(fmt(minutesSaved), 'Minutes saved') +
      statCard(fmt(streak) + ' <span class="bp-fire">🔥</span>', streak === 1 ? 'Day streak' : 'Day streak') +
    '</div>';

    // --- 30-day bar chart
    var maxWords = 1;
    var windowTotal = 0;
    days.forEach(function (d) { windowTotal += d.words; if (d.words > maxWords) maxWords = d.words; });
    var cols = '';
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var pct = Math.max(0, Math.min(100, (d.words / maxWords) * 100));
      var tipPos = i < 3 ? ' bp-tip-left' : (i > days.length - 4 ? ' bp-tip-right' : '');
      var tip = '<b>' + esc(d.label) + '</b> · ' + fmt(d.words) + (d.words === 1 ? ' word' : ' words') +
        (d.sessions ? ' · ' + d.sessions + (d.sessions === 1 ? ' session' : ' sessions') : '');
      cols += '<div class="bp-chart-col">' +
        '<div class="bp-chart-tip' + tipPos + '">' + tip + '</div>' +
        '<div class="bp-chart-bar' + (d.words ? '' : ' bp-zero') + '" style="height:' + (d.words ? pct.toFixed(1) : 0) + '%"></div>' +
      '</div>';
    }
    html += '<section class="bp-card bp-panel">' +
      '<h2 class="bp-panel-title">Last 30 days <small>' + fmt(windowTotal) + ' words</small></h2>' +
      '<div class="bp-chart">' + cols + '</div>' +
      '<div class="bp-chart-axis"><span>' + esc(days[0].label) + '</span><span>' + esc(days[days.length - 1].label) + '</span></div>' +
    '</section>';

    // --- top apps + recent activity
    var appsHtml;
    if (apps.length) {
      var maxApp = apps[0].words || 1;
      appsHtml = '<div class="bp-apps">' + apps.map(function (a) {
        var w = Math.max(3, Math.min(100, (a.words / maxApp) * 100));
        return '<div class="bp-app-row">' +
          '<div class="bp-app-head"><span class="bp-app-name">' + esc(a.name) + '</span><span class="bp-app-words">' + fmt(a.words) + ' words</span></div>' +
          '<div class="bp-app-bar"><div class="bp-app-fill" style="width:' + w.toFixed(1) + '%"></div></div>' +
        '</div>';
      }).join('') + '</div>';
    } else {
      appsHtml = '<div class="bp-dash-note">Dictate into a few apps and your most-used ones show up here.</div>';
    }

    var recentHtml;
    if (recent.length) {
      recentHtml = '<div class="bp-recent">' + recent.map(function (it) {
        var text = String(it.polished || it.raw || '');
        return '<div class="bp-recent-row">' +
          '<span class="bp-recent-text" title="' + esc(text.slice(0, 400)) + '">' + esc(text) + '</span>' +
          '<span class="bp-recent-meta">' +
            (it.app ? '<span class="bp-badge">' + esc(it.app) + '</span>' : '') +
            '<span>' + esc(relTime(it.ts)) + '</span>' +
          '</span>' +
        '</div>';
      }).join('') + '</div>';
    } else {
      recentHtml = '<div class="bp-empty" style="padding:26px 12px">' + ICON_MIC +
        '<p class="bp-empty-title">No dictations yet</p>' +
        '<p class="bp-empty-hint">Hold your push-to-talk key in any app and speak — your first dictation will show up here.</p>' +
      '</div>';
    }

    html += '<div class="bp-dash-grid">' +
      '<section class="bp-card bp-panel"><h2 class="bp-panel-title">Top apps</h2>' + appsHtml + '</section>' +
      '<section class="bp-card bp-panel"><h2 class="bp-panel-title">Recent activity</h2>' + recentHtml + '</section>' +
    '</div>';

    body.innerHTML = html;
  }

  window.BolPages.dashboard = { render: render };
})();
