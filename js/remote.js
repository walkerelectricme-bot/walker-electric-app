/**
 * remote.js (v1.0 offline): how the phone reaches the back end. Swappable: anything with
 *   call(fn, args, key, opts) -> Promise<result>   (rejects with err.code: OFFLINE, ACCESS, BAD_LINK, BUSY, ...)
 * works. AppsScriptRemote talks to the Apps Script data service (Api.gs doPost): POST, text/plain (no CORS preflight),
 * the personal key in the body, no cookies. A later FirebaseRemote would implement the same call().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WesRemote = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function codedError(code, message) { var e = new Error(message); e.code = code; return e; }

  function AppsScriptRemote(opts) {
    opts = opts || {};
    this.url = opts.url || '';
    this.version = opts.version || '';
    this.fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(typeof self !== 'undefined' ? self : this) : null);
    this.timeoutMs = opts.timeoutMs || 25000;
  }
  AppsScriptRemote.prototype.call = function (fn, args, key, o) {
    var self = this;
    o = o || {};
    if (!self.url || /PASTE/.test(self.url)) return Promise.reject(codedError('SETUP', 'The app server address is not set yet (config.js).'));
    if (!self.fetch) return Promise.reject(codedError('OFFLINE', 'No connection.'));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var ms = o.timeoutMs || self.timeoutMs, timer = null;
    var body = JSON.stringify({ k: key || '', fn: fn, args: args || [], v: self.version });
    var p = self.fetch(self.url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body,
      redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
    });
    var t = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject(codedError('OFFLINE', 'No signal (the server did not answer in time).')); }, ms);
    });
    return Promise.race([p, t]).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) {
          // An HTML sign-in page instead of JSON: the deployment is not open to the phone app ("Anyone") yet.
          throw codedError('ACCESS', 'The app server did not answer as expected. Doug: check the deployment access (GO-LIVE.md step 3).');
        }
        if (j && j.ok) return j.result;
        var er = (j && j.error) || {};
        throw codedError(er.code || 'ERROR', er.message || 'Something went wrong.');
      });
    }, function (err) {
      clearTimeout(timer);
      if (err && err.code) throw err;
      throw codedError('OFFLINE', 'No signal.');
    });
  };

  return { AppsScriptRemote: AppsScriptRemote, codedError: codedError };
});
