// Bol — app shell (A8). Nav switching, toast host, version, settings:changed re-render,
// and first-run onboarding gating. Plain browser script; talks to main via window.bol.
'use strict';
(function () {
  window.BolPages = window.BolPages || {};
  var current = 'dashboard';
  var cfg = null;

  // ------------------------------------------------------------ toast
  var toastRoot = null;
  window.bolToast = function (msg, kind) {
    if (!toastRoot) toastRoot = document.getElementById('toast-root');
    if (!toastRoot) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = String(msg);
    toastRoot.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, 2600);
  };

  function invoke(ch, payload) {
    try {
      if (window.bol && typeof window.bol.invoke === 'function') return Promise.resolve(window.bol.invoke(ch, payload));
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('bridge unavailable'));
  }

  // ------------------------------------------------------------ page routing
  function sectionFor(name) { return document.getElementById('page-' + name); }

  function show(name) {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active');
    var sec = sectionFor(name);
    if (!sec) return;
    sec.classList.add('active');
    current = name;
    var items = document.querySelectorAll('.nav-item');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('sel', items[j].getAttribute('data-page') === name);
    }
    render(name);
  }

  function render(name) {
    var sec = sectionFor(name);
    var page = window.BolPages[name];
    if (!sec || !page || typeof page.render !== 'function') return;
    try { page.render(sec); } catch (e) { /* a page error must not brick the shell */ if (window.console) console.error('page render failed:', name, e); }
  }

  // ------------------------------------------------------------ onboarding gate
  function applyGate() {
    var onboarding = !cfg || !cfg.ui || !cfg.ui.onboarded;
    document.body.classList.toggle('onboarding', onboarding);
    if (onboarding) { show('onboarding'); }
    else if (current === 'onboarding') { show('dashboard'); }
  }

  // ------------------------------------------------------------ boot
  function wireNav() {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        if (document.body.classList.contains('onboarding')) return;
        show(this.getAttribute('data-page'));
      });
    }
  }

  function boot() {
    toastRoot = document.getElementById('toast-root');
    wireNav();
    invoke('app:version').then(function (v) {
      var el = document.getElementById('app-version');
      if (el) el.textContent = 'v' + v;
    }).catch(function () {});

    invoke('settings:get').then(function (c) {
      cfg = c;
      window.bolConfig = c;
      applyGate();
      if (!document.body.classList.contains('onboarding')) show('dashboard');
    }).catch(function () { show('dashboard'); });

    if (window.bol && typeof window.bol.on === 'function') {
      window.bol.on('settings:changed', function (c) {
        cfg = c;
        window.bolConfig = c;
        var wasOnboarding = document.body.classList.contains('onboarding');
        applyGate();
        // If not a gate transition, refresh whatever page is open so it reflects new settings.
        if (!wasOnboarding && !document.body.classList.contains('onboarding')) render(current);
      });
    }
  }

  // expose for onboarding to jump into the app after finishing
  window.BolShell = { show: show, render: function () { render(current); }, getConfig: function () { return cfg; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
