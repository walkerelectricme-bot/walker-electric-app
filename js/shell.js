/**
 * shell.js (v1.0 offline): runs before the v0.9 page script in the installable app (web/index.html).
 *  - Takes the personal key from ?k= (then hides it from the address bar) and keeps it on the phone.
 *  - Provides google.script.run for the unchanged page script, backed by the offline engine (engine.js).
 *  - Draws the thin sync status line under the header (tap = sync now) and the "New version, tap to refresh" banner.
 *    A new version never swaps in while a form, slip or popup is open, so nothing being typed is lost; the outbox lives
 *    in IndexedDB and survives every update.
 *  - Registers the service worker (sw.js) so the app opens with no signal.
 *  - v1.1b: a small, dismissible "install this app" tip in a phone browser tab (iPhone Safari: Share > Add to Home Screen;
 *    Android Chrome: its Install prompt, or the menu hint). Never shown in the installed app.
 * No location is ever requested.
 */
(function () {
  'use strict';
  var CFG = window.WES_CONFIG || {};
  var LS_KEY = 'wes1.key';

  /* ---------------- The personal key ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function keyFrom(text) {
    var s = String(text || '');
    var m = /[?&#]k=([A-Za-z0-9_-]{20,100})/.exec(s) || /^\s*([A-Za-z0-9_-]{20,100})\s*$/.exec(s);
    return m ? m[1] : '';
  }
  var urlKey = keyFrom(location.search);
  if (urlKey) {
    lsSet(LS_KEY, urlKey);
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
  }

  /* ---------------- Engine ---------------- */
  var store = null;
  var lazyStore = {
    // The real store opens on first use (IndexedDB, or memory if the browser refuses it).
    open: function () { return WesStore.openBest().then(function (s) { store = s; return s; }); },
    get: function (a, b) { return store.get(a, b); },
    put: function (a, b, c) { return store.put(a, b, c); },
    del: function (a, b) { return store.del(a, b); },
    all: function (a) { return store.all(a); },
    clear: function (a) { return store.clear(a); }
  };
  var engine = new WesEngine.Engine({
    store: window.WES_TEST_STORE || lazyStore,
    remote: window.WES_TEST_REMOTE || new WesRemote.AppsScriptRemote({ url: CFG.execUrl, version: CFG.version }),
    version: CFG.version || 'v1.0',
    now: window.WES_TEST_NOW
  });
  window.WES_ENGINE = engine;

  /** google.script.run for the page: same chaining API, answered by the engine. */
  function runner(ok, fail) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (f) { return runner(f, fail); };
        if (prop === 'withFailureHandler') return function (f) { return runner(ok, f); };
        if (prop === 'withUserObject') return function () { return runner(ok, fail); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          engine.handle(String(prop), args).then(function (r) {
            if (ok) ok(r === undefined ? r : JSON.parse(JSON.stringify(r)));
          }, function (err) {
            afterFailure(err);
            if (fail) fail(err instanceof Error ? err : new Error(String(err && err.message || err)));
          });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { get run() { return runner(null, null); } };

  /* ---------------- Status line and the "couldn't sync" list ---------------- */
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var line = null, bar = null, panel = null;
  function mount() {
    var top = document.getElementById('topbar');
    if (!top || document.getElementById('syncline')) return;
    line = el('div', { id: 'syncline', role: 'button', tabindex: '0', 'aria-live': 'polite' }, '<span class="dot"></span><span class="txt"></span>');
    bar = el('div', { id: 'updbar', role: 'button', tabindex: '0', class: 'hidden' }, 'New version, tap to refresh');
    top.parentNode.insertBefore(line, top.nextSibling);
    top.parentNode.insertBefore(bar, line.nextSibling);
    line.addEventListener('click', onTapLine);
    line.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onTapLine(); } });
    bar.addEventListener('click', applyUpdate);
    draw();
    drawTip();
  }
  function draw() {
    if (!line) return;
    var s = engine.status();
    line.className = 'sync-' + s.state;
    line.querySelector('.txt').textContent = s.text;
  }
  function onTapLine() {
    if (engine.problems.length) { showProblems(); return; }
    engine.reachable = null;
    engine.syncNow({ full: true, pull: true });
    draw();
  }
  function opLabel(p) {
    var e = p.entry || {};
    var what = p.type === 'clockIn' ? 'Clock in' : p.type === 'clockOut' ? 'Clock out' : p.type === 'delete' ? 'Remove a block' : 'Time block';
    return what + (e.date ? ', ' + e.date : '') + (e.start ? ' ' + e.start + (e.end ? '-' + e.end : '') : '');
  }
  function showProblems() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = el('div', { id: 'syncproblems', class: 'card' },
      '<h3>Changes that couldn\'t sync</h3>' + engine.problems.map(function (p) {
        return '<div class="line"><div class="l"><span class="t">' + esc(opLabel(p)) + '</span><span class="s">' + esc(p.message) + '</span></div>' +
          '<span class="r"><button class="btn small okp" data-cid="' + esc(p.cid) + '">OK</button></span></div>';
      }).join('') + '<p class="muted small">The server said no to these (for example, a block that overlaps one made on another phone). ' +
      'Open the day and enter it again if it is still needed.</p>');
    var app = document.getElementById('app');
    app.parentNode.insertBefore(panel, app);
    Array.prototype.forEach.call(panel.querySelectorAll('.okp'), function (b) {
      b.onclick = function () {
        engine.dismissProblem(b.getAttribute('data-cid')).then(function () {
          if (!engine.problems.length && panel) { panel.parentNode.removeChild(panel); panel = null; }
          else showProblems();
        });
      };
    });
  }
  engine.on(function () { draw(); });

  /** A screen that needs signal and has nothing to show gets a clear message instead of "Loading..." forever. */
  function afterFailure(err) {
    var m = String(err && err.message || err);
    setTimeout(function () {
      var app = document.getElementById('app');
      if (/^OFFLINE:/.test(m) && app && app.children.length === 1 && app.querySelector('.loading')) {
        app.innerHTML = '<div class="card" id="needsSignal"><h2>Needs signal</h2><p>' + esc(m.replace(/^OFFLINE:\s*/, '')) + '</p>' +
          '<a class="btn block" href="#home">Back to Home</a></div>';
      }
      if (/^NOT_INVITED:/.test(m) && !lsGet(LS_KEY)) addPasteBox();
    }, 30);
  }
  /** iPhone home-screen apps don't share storage with Safari: let the person paste their invite link once. */
  function addPasteBox() {
    var card = document.querySelector('#app .denied');
    if (!card || document.getElementById('pasteKey')) return;
    var f = el('form', { id: 'pasteForm' },
      '<label class="field" for="pasteKey">Paste the link from your invite email</label>' +
      '<input type="url" id="pasteKey" autocomplete="off" placeholder="https://...?k=...">' +
      '<button class="btn primary block" type="submit" style="margin-top:10px">Sign in on this phone</button>');
    card.appendChild(f);
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var k = keyFrom(document.getElementById('pasteKey').value);
      if (!k) { window.alert('That does not look like your invite link. It ends with ?k= and a long code.'); return; }
      lsSet(LS_KEY, k);
      location.reload();
    };
  }

  /* ---------------- Updates (service worker) ---------------- */
  var waiting = null;
  /** Something typed but not saved in a form on the page. */
  function dirty() {
    return Array.prototype.some.call(document.querySelectorAll('#app input, #app textarea, #app select'), function (i) {
      if (i.type === 'checkbox' || i.type === 'radio') return i.checked !== i.defaultChecked;
      if (i.tagName === 'SELECT') return Array.prototype.some.call(i.options, function (o) { return o.selected !== o.defaultSelected; });
      return i.value !== i.defaultValue;
    });
  }
  /** Busy = a popup (job, slip form) is open, a form has unsaved typing, or a save is on its way: never swap versions then. */
  function busy() { return !!(document.getElementById('modalBack') || dirty() || document.querySelector('#app button[disabled]')); }
  function showUpdate(w) { waiting = w; if (bar) bar.classList.remove('hidden'); }
  function applyUpdate() {
    if (!waiting) return;
    if (busy()) {
      var t = document.getElementById('toast');
      if (t) {
        t.textContent = 'Finish or close what you are working on, then tap again.';
        t.classList.remove('hidden');
        setTimeout(function () { t.classList.add('hidden'); }, 4000);
      }
      return false;
    }
    var w = waiting; waiting = null;
    bar.textContent = 'Updating\u2026';
    w.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!reloading) { reloading = true; location.reload(); }
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(nw);
          });
        });
        setInterval(function () { reg.update().catch(function () {}); }, 30 * 60 * 1000);
      }).catch(function () {});
    });
  }

  /* ---------------- Install tip (v1.1b): only in a browser tab, never in the installed app ---------------- */
  var TIP_KEY = 'wes1.installTipOff';
  var installEvt = null, tipEl = null;
  /**
   * Pure: which tip to show. env: {ua, standalone (iOS navigator.standalone), displayStandalone (display-mode media),
   * dismissed, canPrompt}. Returns '' (none), 'ios', 'android-install' (Chrome offered its install prompt) or 'android-hint'.
   */
  function installTip(env) {
    if (!env || env.standalone || env.displayStandalone || env.dismissed) return '';
    var ua = String(env.ua || '');
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.touch);
    if (ios) return 'ios';
    if (/Android/.test(ua)) return env.canPrompt ? 'android-install' : 'android-hint';
    return '';
  }
  function tipEnv() {
    var dm = false;
    try { dm = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) {}
    return { ua: navigator.userAgent, standalone: navigator.standalone === true, displayStandalone: dm,
             dismissed: lsGet(TIP_KEY) === '1', canPrompt: !!installEvt, touch: (navigator.maxTouchPoints || 0) > 1 };
  }
  function hideTip(forGood) {
    if (forGood) lsSet(TIP_KEY, '1');
    if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
    tipEl = null;
  }
  function drawTip() {
    var kind = installTip(tipEnv());
    if (tipEl && tipEl.getAttribute('data-kind') === kind) return;
    hideTip(false);
    var top = document.getElementById('topbar');
    if (!kind || !top) return;
    var msg = kind === 'ios' ? 'Install this app: tap Share, then Add to Home Screen. You\'ll paste your invite link once after installing.'
      : kind === 'android-install' ? 'Install this app on your phone.'
      : 'Install this app: Chrome menu &#x22EE; &gt; Install app.';
    tipEl = el('div', { id: 'installtip', 'data-kind': kind, role: 'note' },
      '<span class="msg">' + msg + '</span>' +
      (kind === 'android-install' ? '<button type="button" class="btn small primary" id="installBtn">Install app</button>' : '') +
      '<button type="button" class="x" id="installX" aria-label="Hide this tip">&#x2715;</button>');
    var after = bar || line || top;
    after.parentNode.insertBefore(tipEl, after.nextSibling);
    tipEl.querySelector('#installX').onclick = function () { hideTip(true); };
    var ib = tipEl.querySelector('#installBtn');
    if (ib) ib.onclick = function () {
      var e = installEvt; installEvt = null;
      if (!e) { drawTip(); return; }
      try {
        e.prompt();
        Promise.resolve(e.userChoice).then(function (c) { if (c && c.outcome === 'accepted') hideTip(true); else drawTip(); }, drawTip);
      } catch (x) { drawTip(); }
    };
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; drawTip(); });
  window.addEventListener('appinstalled', function () { installEvt = null; hideTip(true); });

  /* ---------------- When to sync ---------------- */
  window.addEventListener('online', function () { engine.reachable = null; engine.syncNow({ pull: true }); draw(); });
  window.addEventListener('offline', function () { draw(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') engine.syncNow({ pull: true }); });
  setInterval(function () { engine.syncNow(); }, 60 * 1000);
  setInterval(draw, 15 * 1000);

  window.WES_SHELL = { urlKey: urlKey, mount: mount, draw: draw, busy: busy, showUpdate: showUpdate, applyUpdate: applyUpdate, keyFrom: keyFrom,
                    installTip: installTip, drawTip: drawTip };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
