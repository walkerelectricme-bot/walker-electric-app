/**
 * store.js (v1.0 offline): where the phone keeps things. A small adapter interface so the back end can change later
 * (Firebase, or a different phone database) without touching the screens or the sync rules:
 *
 *   open() -> Promise            get(store, key) -> Promise<value|undefined>     put(store, value, key?) -> Promise
 *   del(store, key) -> Promise   all(store) -> Promise<[values]>                 clear(store) -> Promise
 *
 * Stores: 'kv' (cached server data and settings, by key), 'outbox' (changes waiting to sync, keyPath cid, oldest first
 * by seq) and 'problems' (changes the server refused, keyPath cid, shown to the person until dismissed).
 *
 * IdbStore = IndexedDB on the phone. MIGRATIONS is the versioned list of schema steps. A new app version may ADD a step;
 * it must never drop or clear the outbox, so changes made before an update always survive the update.
 * MemoryStore = the same interface in memory (tests, and a fallback when IndexedDB is unavailable, e.g. private mode).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WesStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'wes-offline';

  /** MIGRATIONS[i] upgrades the database from version i to i + 1. Only ever append. */
  var MIGRATIONS = [
    function v1(db) {
      db.createObjectStore('kv');
      var ob = db.createObjectStore('outbox', { keyPath: 'cid' });
      ob.createIndex('seq', 'seq', { unique: false });
      db.createObjectStore('problems', { keyPath: 'cid' });
    }
  ];

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function IdbStore(opts) {
    opts = opts || {};
    this.idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this.name = opts.name || DB_NAME;
    this.migrations = opts.migrations || MIGRATIONS;
    this.version = this.migrations.length;
    this.db = null;
  }
  IdbStore.prototype.open = function () {
    var self = this;
    if (self.db) return Promise.resolve(self);
    if (!self.idb) return Promise.reject(new Error('IndexedDB is not available'));
    return new Promise(function (resolve, reject) {
      var r = self.idb.open(self.name, self.version);
      r.onupgradeneeded = function (ev) {
        var db = r.result, from = ev.oldVersion || 0;
        for (var v = from; v < self.version; v++) self.migrations[v](db, r.transaction);
      };
      r.onsuccess = function () {
        self.db = r.result;
        // Another tab opened a newer version: close so its upgrade can run (it keeps the outbox).
        self.db.onversionchange = function () { try { self.db.close(); } catch (e) {} self.db = null; };
        resolve(self);
      };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { /* waits for the other tab to close */ };
    });
  };
  IdbStore.prototype._tx = function (store, mode) {
    var self = this;
    return self.open().then(function () { return self.db.transaction(store, mode).objectStore(store); });
  };
  IdbStore.prototype.get = function (store, key) { return this._tx(store, 'readonly').then(function (s) { return req(s.get(key)); }); };
  IdbStore.prototype.put = function (store, value, key) {
    return this._tx(store, 'readwrite').then(function (s) { return req(key === undefined ? s.put(value) : s.put(value, key)); });
  };
  IdbStore.prototype.del = function (store, key) { return this._tx(store, 'readwrite').then(function (s) { return req(s.delete(key)); }); };
  IdbStore.prototype.clear = function (store) { return this._tx(store, 'readwrite').then(function (s) { return req(s.clear()); }); };
  IdbStore.prototype.all = function (store) {
    return this._tx(store, 'readonly').then(function (s) {
      var src = store === 'outbox' ? s.index('seq') : s;
      return req(src.getAll());
    });
  };
  IdbStore.prototype.close = function () { if (this.db) { this.db.close(); this.db = null; } };

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function MemoryStore() { this.data = { kv: {}, outbox: {}, problems: {} }; }
  MemoryStore.prototype.open = function () { return Promise.resolve(this); };
  MemoryStore.prototype.get = function (store, key) { return Promise.resolve(clone(this.data[store][key])); };
  MemoryStore.prototype.put = function (store, value, key) {
    var k = key === undefined ? value.cid : key;
    this.data[store][k] = clone(value);
    return Promise.resolve(k);
  };
  MemoryStore.prototype.del = function (store, key) { delete this.data[store][key]; return Promise.resolve(); };
  MemoryStore.prototype.clear = function (store) { this.data[store] = {}; return Promise.resolve(); };
  MemoryStore.prototype.all = function (store) {
    var d = this.data[store], vals = Object.keys(d).map(function (k) { return clone(d[k]); });
    if (store === 'outbox') vals.sort(function (a, b) { return a.seq - b.seq; });
    return Promise.resolve(vals);
  };
  MemoryStore.prototype.close = function () {};

  /** IndexedDB when it works, else memory (the app still runs; it just can't keep changes across a restart). */
  function openBest(opts) {
    var s = new IdbStore(opts);
    return s.open().catch(function () { var m = new MemoryStore(); m.volatile = true; return m; });
  }

  return { IdbStore: IdbStore, MemoryStore: MemoryStore, MIGRATIONS: MIGRATIONS, DB_NAME: DB_NAME, openBest: openBest };
});
