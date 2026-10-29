/**
 * sw.js (v1.0 offline): the service worker. It keeps the app's own files on the phone so the app opens with no signal.
 *  - The app files (the "shell") are cached by version. A new version installs in the background and WAITS: the page
 *    shows "New version, tap to refresh" and only swaps when the person taps it and nothing is open (shell.js).
 *  - Data never goes through this cache: calls to the Apps Script data service (POST) go straight to the network, and
 *    the time card, outbox and cached jobs live in IndexedDB (store.js), which updates never touch.
 */
var VERSION = 'wes-shell-v1.1-073f20dafd';
var SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './css/shell.css', './js/timecore.js', './js/store.js',
  './js/remote.js', './js/engine.js', './js/shell.js', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }));
  // No skipWaiting() here: the page decides when it is safe to swap (never mid-slip or mid-edit).
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    var old = keys.filter(function (k) { return k.indexOf('wes-shell-') === 0 && k !== VERSION; });
    return Promise.all(old.map(function (k) { return caches['delete'](k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (ev) {
  if (ev.data && ev.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;                       // data service calls: always the network
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Google, map links: not ours to cache
  if (req.mode === 'navigate') {
    // The app page: the cached copy (works with no signal); ?k= sign-in links open the same page.
    ev.respondWith(caches.match('./index.html').then(function (hit) { return hit || fetch(req); }));
    return;
  }
  ev.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); }));
});
