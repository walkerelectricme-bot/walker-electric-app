/**
 * engine.js (v1.0 offline): the phone side of the app. The screens (the unchanged v0.9 page script) call
 * google.script.run.apiXxx(key, ...) as before; shell.js hands every call to Engine.handle(fn, args), which:
 *
 *  - Time card (my own): works with or without signal. Reads are built on the phone from the cached entries plus the
 *    changes still waiting in the outbox (timecore.js = the v0.9 rules). Writes (save / edit / delete a block, Clock in,
 *    Clock out) are checked with the same rules, put in the outbox with a client-made ID (UUID) and the phone time,
 *    and synced: right away when there is signal (so a server refusal shows like it did in v0.9), else later.
 *  - Jobs (7 days back to 14 ahead), Odds and Ends, finish lists, points: shown from the server when there is signal,
 *    from the phone's copy when there is not.
 *  - Everything else (slips, photos, work orders, moderator screens...): needs signal, with a clear message.
 *
 * Sync: when the app opens, on the browser "online" event, about every 60 s (shell.js), and when the status line is
 * tapped. Changes go up in batches (apiSync), oldest first; the server is idempotent on the client ID, so a retry after
 * a dropped connection never makes a duplicate. Each batch carries the app version.
 * The store (store.js) and the remote (remote.js) are adapters, so the back end can move (e.g. Firebase) later.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./timecore.js'));
  else root.WesEngine = factory(root.WesTimeCore);
})(typeof self !== 'undefined' ? self : this, function (TC) {
  'use strict';

  var EDIT_FIELDS = ['Date', 'DayType', 'Start', 'End', 'BreakMin', 'Hours', 'Note'];
  var DENIED = /^(NOT_INVITED|BAD_LINK|INACTIVE)$/;
  var NETWORKISH = /^(OFFLINE|ACCESS|SETUP)$/;
  var READ_FRESH_MS = 2 * 60 * 1000;     // a cached read younger than this is shown without asking the server
  var FULL_EVERY_MS = 15 * 60 * 1000;    // jobs / odds / finish lists / points refresh
  var PULL_EVERY_MS = 50 * 1000;         // time card refresh when nothing is waiting
  var BATCH = 25;
  var QUEUED_MSG = 'Saved on this phone. It syncs when you have signal.';
  var NEEDS_SIGNAL = 'OFFLINE: This needs signal. Your time card works without it; this screen opens again once you are back online.';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clone(v) { return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)); }
  function normEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }
  function err(msg, code) { var e = new Error(msg); if (code) e.code = code; return e; }
  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }
  function uuid() {
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Array(16);
    for (var i = 0; i < 16; i++) b[i] = c && c.getRandomValues ? c.getRandomValues(new Uint8Array(1))[0] : Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = b.map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function localDs(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function localHm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function stamp(d) { return localDs(d) + ' ' + localHm(d); }

  /* ---------------- The status line (pure, so it is easy to test) ---------------- */

  function clock12(d) { var h = d.getHours(); return (h % 12 === 0 ? 12 : h % 12) + ':' + pad2(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM'); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function whenLabel(ms, now) {
    var d = new Date(ms), n = new Date(now);
    return localDs(d) === localDs(n) ? clock12(d) : MON[d.getMonth()] + ' ' + d.getDate() + ', ' + clock12(d);
  }
  /**
   * s: {online, pending, problems, lastSync (ms or 0), now (ms), syncing}. Returns {state, text}:
   * green "Updated X min ago" | amber "N waiting to sync" | gray "Offline, last updated <time>" | red "N couldn't sync".
   */
  function statusLine(s) {
    var now = s.now || Date.now();
    if (s.problems > 0) {
      return { state: 'red', text: s.problems + (s.problems === 1 ? ' change' : ' changes') + ' couldn\'t sync. Tap to see.' };
    }
    if (s.pending > 0) {
      return { state: 'amber', text: (s.syncing && s.online ? 'Syncing ' + s.pending : s.pending + ' waiting to sync') + (s.online ? '' : ' (no signal)') };
    }
    if (!s.online) return { state: 'gray', text: s.lastSync ? 'Offline, last updated ' + whenLabel(s.lastSync, now) : 'Offline, not updated yet' };
    if (!s.lastSync) return { state: 'gray', text: s.syncing ? 'Updating\u2026' : 'Not updated yet. Tap to update.' };
    var min = Math.floor((now - s.lastSync) / 60000);
    var ago = min < 1 ? 'just now' : min < 60 ? min + ' min ago' : min < 24 * 60 ? Math.floor(min / 60) + ' h ago' : 'on ' + whenLabel(s.lastSync, now);
    return { state: 'green', text: 'Updated ' + ago };
  }

  /* ---------------- Engine ---------------- */

  function Engine(opts) {
    opts = opts || {};
    this.store = opts.store;
    this.remote = opts.remote;
    this.version = opts.version || 'v1.0';
    this.clock = opts.now || function () { return new Date(); };
    this.isOnline = opts.isOnline || function () { return typeof navigator === 'undefined' || navigator.onLine !== false; };
    this.listeners = [];
    this.key = ''; this.owner = '';
    this.kv = {};            // in-memory copy of the 'kv' store
    this.outbox = []; this.problems = [];
    this.meta = { deviceId: '', seq: 0, lastSync: 0, lastFull: 0, owner: '' };
    this.results = {};       // cid -> server result (this session)
    this.reachable = null;   // false after a network failure, until the next success or "online" event
    this.syncing = null; this.denied = null;
    this.ready = null;
  }

  Engine.prototype.on = function (fn) { this.listeners.push(fn); };
  Engine.prototype.emit = function () { var self = this; this.listeners.forEach(function (f) { try { f(self); } catch (e) {} }); };
  Engine.prototype.nowMs = function () { return this.clock().getTime(); };
  Engine.prototype.today = function () { return localDs(this.clock()); };
  Engine.prototype.likelyOnline = function () { return this.isOnline() && this.reachable !== false; };

  Engine.prototype.init = function () {
    var self = this;
    if (self.ready) return self.ready;
    self.ready = self.store.open().then(function () {
      return Promise.all([self.store.get('kv', 'meta'), self.store.all('outbox'), self.store.all('problems')]);
    }).then(function (r) {
      if (r[0]) self.meta = Object.assign(self.meta, r[0]);
      if (!self.meta.deviceId) self.meta.deviceId = uuid();
      self.outbox = r[1] || []; self.problems = r[2] || [];
      return Promise.all(['boot', 'time', 'jobs', 'odds', 'finish', 'points', 'reads'].map(function (k) {
        return self.store.get('kv', k).then(function (v) { if (v !== undefined) self.kv[k] = v; });
      }));
    }).then(function () { return self.saveMeta(); }).then(function () { return self; });
    return self.ready;
  };
  Engine.prototype.saveMeta = function () { return this.store.put('kv', this.meta, 'meta'); };
  Engine.prototype.setKv = function (k, v) { this.kv[k] = v; return this.store.put('kv', v, k); };

  /** A new key on this phone (someone else signed in): drop the cached data of the previous person. */
  Engine.prototype.setKey = function (key) {
    var self = this;
    key = String(key || '');
    if (!key || key === self.key) return Promise.resolve();
    self.key = key; self.owner = hash(key); self.denied = null;
    if (self.meta.owner && self.meta.owner !== self.owner) {
      self.kv = {};
      self.meta.lastSync = 0; self.meta.lastFull = 0;
      ['boot', 'time', 'jobs', 'odds', 'finish', 'points', 'reads'].forEach(function (k) { self.store.del('kv', k); });
    }
    self.meta.owner = self.owner;
    return self.saveMeta();
  };
  Engine.prototype.myOps = function () { var o = this.owner; return this.outbox.filter(function (x) { return x.owner === o; }); };
  Engine.prototype.pendingCount = function () { return this.myOps().length; };

  Engine.prototype.status = function () {
    return statusLine({ online: this.likelyOnline(), pending: this.pendingCount(), problems: this.problems.length,
                        lastSync: this.meta.lastSync, now: this.nowMs(), syncing: !!this.syncing });
  };

  /* ---------------- My time entries: server copy + the outbox replayed on top ---------------- */

  function findRef(list, ref) {
    ref = ref || {};
    for (var i = 0; i < list.length; i++) {
      if ((ref.entryId && list[i].id === ref.entryId) || (ref.cid && list[i].cid === ref.cid)) return list[i];
    }
    return null;
  }
  /** The id the screens use: a server EntryID, or "c:<client id>" for a block made on the phone and not synced yet. */
  function findById(list, id) {
    id = String(id || '');
    if (id.indexOf('c:') === 0) return findRef(list, { cid: id.slice(2) });
    return findRef(list, { entryId: id });
  }
  function refOf(e) { return e.pending && e.id.indexOf('c:') === 0 ? { cid: e.cid } : { entryId: e.id }; }

  /** Stored values from an outbox entry (already checked when it was made). */
  function valsOf(p, offDayHours) {
    var s = TC.parseTime(p.start), e = TC.parseTime(p.end), hours;
    if (s !== null && e !== null) hours = TC.round2((e - s) / 60);
    else if (s === null && e === null && p.dayType !== 'Work') hours = offDayHours;
    else hours = 0;
    return { Date: p.date, DayType: p.dayType, Start: s === null ? '' : TC.hm(s), End: e === null ? '' : TC.hm(e), BreakMin: 0,
             Hours: hours, Note: String(p.note || '').trim(), Source: p.source === 'ClockButton' ? 'ClockButton' : 'Manual' };
  }

  function applyOp(list, op, me, offDayHours) {
    var p = op.entry || {}, at = stamp(new Date(op.createdAt || 0)), e;
    if ((op.type === 'save' && !op.ref) || op.type === 'clockIn') {
      if (findRef(list, { cid: op.cid })) return; // already on the server (the reply was lost): don't show it twice
      var v = op.type === 'clockIn'
        ? { Date: p.date, DayType: 'Work', Start: p.start, End: '', BreakMin: 0, Hours: 0, Note: String(p.note || '').trim(), Source: 'ClockButton' }
        : valsOf(p, offDayHours);
      list.push(TC.viewFrom(v, { id: 'c:' + op.cid, cid: op.cid, email: me, pending: true, createdAt: at }));
      return;
    }
    e = findRef(list, op.ref);
    if (!e) return;
    if (op.type === 'delete') { list.splice(list.indexOf(e), 1); return; }
    var vals = op.type === 'clockOut' ? valsOf({ date: e.date, dayType: 'Work', start: e.start, end: p.end, note: e.note, source: e.source }, offDayHours)
                                      : valsOf(p, offDayHours);
    var n = TC.viewFrom(vals, { id: e.id, cid: e.cid, email: me, edited: true, pending: true, createdAt: e.createdAt, updatedAt: at, updatedBy: me });
    n.source = e.source;
    Object.keys(n).forEach(function (k) { e[k] = n[k]; });
  }

  Engine.prototype.timeData = function () { return this.kv.time || null; };
  Engine.prototype.me = function () { var t = this.timeData(); return t ? t.email : ''; };
  Engine.prototype.entries = function () {
    var t = this.timeData();
    if (!t) return [];
    var list = clone(t.entries || []), me = t.email, off = t.offDayHours;
    this.myOps().forEach(function (op) { applyOp(list, op, me, off); });
    if (t.allotment) TC.markOverAllotment(list, t.allotment, t.year);
    return list;
  };
  /** Can the phone build the card for this date? (this year's data, from the week before Jan 1) */
  Engine.prototype.canLocal = function (refDate) {
    var t = this.timeData(), d = TC.normDate(refDate) || this.today();
    return !!(t && t.allotment && d >= t.from && TC.yearOf(d) === t.year);
  };
  Engine.prototype.card = function (refDate, list) {
    var t = this.timeData();
    var tc = TC.timeCard(list || this.entries(), refDate || this.today(), { email: t.email, today: this.today(), allotment: t.allotment });
    tc.offline = { pending: this.pendingCount() };
    return tc;
  };

  /* ---------------- Time card writes (checked on the phone with the v0.9 rules, then queued) ---------------- */

  Engine.prototype.enqueue = function (op) {
    var self = this;
    var d = self.clock();
    op.cid = op.cid || uuid();
    op.seq = ++self.meta.seq;
    op.owner = self.owner;
    op.phoneTime = d.toISOString();
    op.createdAt = d.getTime();
    op.appVersion = self.version;
    op.tries = 0;
    self.outbox.push(op);
    return Promise.all([self.store.put('outbox', op), self.saveMeta()]).then(function () { self.emit(); return op; });
  };

  /** Queue the op; with signal, wait (up to ~10 s) for the server so a refusal shows now, as in v0.9. */
  Engine.prototype.settle = function (op) {
    var self = this;
    if (!self.likelyOnline()) return Promise.resolve(null);
    var timer;
    var wait = new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, 10000); });
    return Promise.race([self.syncNow().then(function () { return self.results[op.cid] || null; }, function () { return null; }), wait])
      .then(function (r) { clearTimeout(timer); return r; });
  };

  Engine.prototype.writeResult = function (op, extra) {
    var self = this;
    return self.enqueue(op).then(function () { return self.settle(op); }).then(function (r) {
      if (r && r.status === 'rejected') {
        // Shown now (the person is still on the form), so it does not also sit in the "couldn't sync" list.
        self.dismissProblem(op.cid);
        throw err(r.message || 'That change was not saved.');
      }
      var list = self.entries();
      var entry = op.ref ? findRef(list, op.ref) || (r && r.entryId ? findRef(list, { entryId: r.entryId }) : null)
                         : findRef(list, { cid: op.cid });
      var done = !!(r && r.status === 'done');
      var warning = '';
      if (entry && entry.overAllotment && op.type === 'save') {
        warning = 'No ' + entry.dayType.toLowerCase() + ' days left for ' + TC.yearOf(entry.date) + '. Saved anyway and flagged for ' +
          ((self.kv.boot && self.kv.boot.app && self.kv.boot.app.contactNames) || 'Doug or Duane') + '.';
      }
      if (!done) warning = warning ? warning + ' ' + QUEUED_MSG : QUEUED_MSG;
      var res = { ok: true, created: !op.ref && op.type !== 'clockOut', unchanged: false, changed: extra && extra.changed || [],
                  entry: entry, timeCard: self.card(entry ? entry.date : self.today(), list), points: done && r.points ? r.points : null,
                  queued: !done };
      if (warning) res.warning = warning;
      return res;
    });
  };

  Engine.prototype.saveEntry = function (input) {
    var self = this, t = self.timeData();
    input = input || {};
    var today = self.today(), list = self.entries();
    var e = input.entryId ? findById(list, input.entryId) : null;
    if (input.entryId && !e) return Promise.reject(err('That entry was not found (it may have been deleted). Reload and try again.'));
    var v, reason;
    try {
      v = TC.normalizeEntryInput(Object.assign({}, input, { allowOpen: !!input.entryId }), today, t.offDayHours);
      reason = TC.checkReason(input.reason, false);
      if (e) {
        if (!v.End && v.DayType === 'Work' && e.end) throw err('A work block needs a start and an end time.');
        var clash = TC.blockConflict(list, v, e);
        if (clash) throw err(clash);
      } else {
        var clash2 = TC.blockConflict(list, v, null);
        if (clash2) throw err(clash2);
      }
    } catch (x) { return Promise.reject(x); }
    var entry = { date: v.Date, dayType: v.DayType, start: v.Start, end: v.End, note: v.Note, source: v.Source };
    if (e) {
      var before = TC.coreOf(e);
      var changed = EDIT_FIELDS.filter(function (f) { return String(before[f]) !== String(v[f]); });
      if (!changed.length) {
        return Promise.resolve({ ok: true, created: false, unchanged: true, changed: [], entry: e, timeCard: self.card(e.date, list), points: null });
      }
      if (reason.length < 3) return Promise.reject(err('Please say why you are changing this entry.'));
      entry.reason = reason;
      return self.writeResult({ type: 'save', ref: refOf(e), entry: entry }, { changed: changed });
    }
    return self.writeResult({ type: 'save', entry: entry });
  };

  Engine.prototype.clockIn = function (note) {
    var self = this, t = self.timeData(), d = self.clock(), today = localDs(d), list = self.entries(), v;
    try {
      v = TC.normalizeEntryInput({ date: today, dayType: 'Work', start: localHm(d), end: '', note: note, source: 'ClockButton', allowOpen: true },
                                 today, t.offDayHours);
      var clash = TC.blockConflict(list, v, null);
      if (clash) throw err(clash);
    } catch (x) { return Promise.reject(x); }
    return self.writeResult({ type: 'clockIn', entry: { date: v.Date, start: v.Start, note: v.Note } });
  };

  Engine.prototype.clockOut = function () {
    var self = this, d = self.clock(), today = localDs(d), list = self.entries();
    var op = TC.openOf(list, null);
    if (!op) return Promise.reject(err('You are not clocked in.'));
    if (op.date !== today) {
      return Promise.reject(err('Your block from ' + TC.dayLabel(op.date) + ' (since ' + TC.time12(op.start) +
        ') was never closed. Open that day and enter its end time.'));
    }
    var end = localHm(d);
    if (TC.parseTime(end) <= TC.parseTime(op.start)) return Promise.reject(err('You clocked in less than a minute ago. Try again in a minute.'));
    return self.writeResult({ type: 'clockOut', ref: refOf(op), entry: { date: op.date, end: end } }, { changed: ['End', 'Hours'] });
  };

  Engine.prototype.deleteEntry = function (id, reason) {
    var self = this, list = self.entries();
    reason = String(reason || '').trim();
    if (reason.length < 3) return Promise.reject(err('Please say why you are deleting this entry.'));
    if (TC.looksSecret(reason)) return Promise.reject(err('The reason can\'t hold access codes or passwords.'));
    var e = findById(list, id);
    if (!e) return Promise.reject(err('That entry was not found (it may already be deleted).'));
    var op = { type: 'delete', ref: refOf(e), entry: { date: e.date, reason: reason } };
    return self.enqueue(op).then(function () { return self.settle(op); }).then(function (r) {
      if (r && r.status === 'rejected') { self.dismissProblem(op.cid); throw err(r.message || 'That entry was not deleted.'); }
      return { ok: true, timeCard: self.card(e.date), points: r && r.status === 'done' && r.points ? r.points : null, queued: !(r && r.status === 'done') };
    });
  };

  /* ---------------- Sync ---------------- */

  Engine.prototype.dismissProblem = function (cid) {
    var self = this;
    self.problems = self.problems.filter(function (p) { return p.cid !== cid; });
    return self.store.del('problems', cid).then(function () { self.emit(); });
  };

  /** Cached copies (not the outbox) for this sign-in. */
  Engine.prototype.dropCaches = function () {
    var s = this.store;
    this.kv = {};
    return Promise.all(['boot', 'time', 'jobs', 'odds', 'finish', 'points', 'reads'].map(function (k) { return s.del('kv', k); }));
  };

  Engine.prototype.noteFailure = function (e) {
    if (e && DENIED.test(e.code || '')) {
      // This link no longer works: the phone stops showing that person's cached data. The outbox stays.
      this.denied = e;
      this.dropCaches();
    } else if (e && NETWORKISH.test(e.code || '')) this.reachable = false;
    this.lastError = e;
  };

  Engine.prototype.rcall = function (fn, args, timeoutMs) {
    var self = this;
    return self.remote.call(fn, args, self.key, { timeoutMs: timeoutMs }).then(function (r) {
      self.reachable = true;
      return r;
    }, function (e) { self.noteFailure(e); throw e; });
  };

  /** Sends what is waiting (oldest first, in batches), then refreshes. Never rejects. opts: {full, pull} */
  Engine.prototype.syncNow = function (opts) {
    var self = this;
    opts = opts || {};
    if (!self.key) return Promise.resolve();
    if (self.syncing) return self.syncing;
    self.syncing = self.init().then(function () { return self.syncLoop(opts, 0); })
      .then(function () {
        var due = opts.full || !self.meta.lastFull || self.nowMs() - self.meta.lastFull > FULL_EVERY_MS;
        if (due && self.reachable !== false && !self.denied) return self.pullFull().catch(function () {});
      })
      .catch(function () {})
      .then(function () { self.syncing = null; self.emit(); });
    self.emit();
    return self.syncing;
  };

  Engine.prototype.syncLoop = function (opts, round) {
    var self = this;
    var ops = self.myOps().slice(0, BATCH);
    if (!ops.length && !opts.pull && !opts.full && self.meta.lastSync && self.nowMs() - self.meta.lastSync < PULL_EVERY_MS) return Promise.resolve();
    if (round > 20) return Promise.resolve();
    var wire = ops.map(function (o) { return { cid: o.cid, type: o.type, ref: o.ref, entry: o.entry, phoneTime: o.phoneTime }; });
    return self.rcall('apiSync', [{ appVersion: self.version, deviceId: self.meta.deviceId, ops: wire, pull: true }], 30000)
      .then(function (res) {
        var byCid = {}, gone = {}, stop = false, writes = [];
        ops.forEach(function (o) { byCid[o.cid] = o; });
        (res.results || []).forEach(function (r) {
          var o = byCid[r.cid];
          if (!o) return;
          self.results[r.cid] = r;
          if (r.status === 'done' || r.status === 'rejected') {
            gone[r.cid] = true;
            writes.push(self.store.del('outbox', r.cid));
            if (r.status === 'rejected') {
              var pr = { cid: r.cid, type: o.type, entry: o.entry, message: r.message || 'Not saved.', at: self.nowMs() };
              self.problems.push(pr);
              writes.push(self.store.put('problems', pr));
            }
          } else {
            stop = true;
            o.tries = (o.tries || 0) + 1; o.lastError = r.message || '';
            writes.push(self.store.put('outbox', o));
          }
        });
        self.outbox = self.outbox.filter(function (o) { return !gone[o.cid]; });
        if (res.time) writes.push(self.setKv('time', res.time));
        self.meta.lastSync = self.nowMs();
        writes.push(self.saveMeta());
        return Promise.all(writes).then(function () {
          self.emit();
          if (!stop && ops.length && self.myOps().length) return self.syncLoop({ pull: false }, round + 1);
        });
      });
  };

  /** Everything the phone keeps for no-signal use (Api.gs apiOfflineSnapshot). */
  Engine.prototype.pullFull = function () {
    var self = this;
    return self.rcall('apiOfflineSnapshot', [{}], 60000).then(function (s) {
      var at = self.nowMs(), w = [];
      if (s.boot) w.push(self.setKv('boot', s.boot));
      if (s.time) w.push(self.setKv('time', s.time));
      if (s.points !== undefined) w.push(self.setKv('points', { at: at, data: s.points }));
      if (s.jobs) w.push(self.setKv('jobs', { at: at, from: s.jobs.from, to: s.jobs.to, days: s.jobs.days }));
      if (s.odds) w.push(self.setKv('odds', { at: at, data: s.odds }));
      if (s.finish) w.push(self.setKv('finish', { at: at, data: s.finish }));
      self.meta.lastFull = at; self.meta.lastSync = at;
      w.push(self.saveMeta());
      return Promise.all(w).then(function () { self.emit(); return s; });
    });
  };

  /* ---------------- Reads: server when there is signal, the phone's copy when not ---------------- */

  Engine.prototype.reads = function () { return this.kv.reads || (this.kv.reads = {}); };
  Engine.prototype.remember = function (k, data) {
    this.reads()[k] = { at: this.nowMs(), data: data };
    return this.store.put('kv', this.kv.reads, 'reads');
  };
  /** After a change made through the server (a slip, an odd job...), the next read asks the server again. */
  Engine.prototype.staleAll = function () {
    var self = this, r = self.reads();
    Object.keys(r).forEach(function (k) { r[k].at = 0; });
    ['jobs', 'odds', 'finish', 'points'].forEach(function (k) { if (self.kv[k]) self.kv[k].at = 0; });
  };

  /** cached: {at, data} or null. A fresh copy (or no signal) -> the copy; else the server, falling back to the copy. */
  Engine.prototype.read = function (fn, args, cached, remember, missing) {
    var self = this;
    if (cached && (self.nowMs() - cached.at < READ_FRESH_MS || !self.likelyOnline())) return Promise.resolve(clone(cached.data));
    if (!self.likelyOnline()) return Promise.reject(err(missing || NEEDS_SIGNAL, 'OFFLINE'));
    return self.rcall(fn, args, 12000).then(function (data) {
      if (remember) remember(data);
      return data;
    }, function (e) {
      if (NETWORKISH.test(e.code || '') && cached) return clone(cached.data);
      if (NETWORKISH.test(e.code || '')) throw err(missing || NEEDS_SIGNAL, 'OFFLINE');
      throw e;
    });
  };

  /** The jobs window kept on the phone: 7 days back to 14 days ahead of the last full sync. */
  Engine.prototype.jobsFor = function (ds) {
    var self = this, j = self.kv.jobs, r = self.reads()['jobs:' + ds];
    var cached = r || (j && j.days && j.days[ds] ? { at: j.at, data: j.days[ds] } : null);
    if (!cached && !self.likelyOnline()) {
      return Promise.resolve({ ok: false, date: ds, dateLabel: TC.dayLabel(ds), events: [],
        message: 'No signal. This phone keeps the jobs from ' +
          (j ? TC.dayLabel(j.from) + ' to ' + TC.dayLabel(j.to) : '7 days back to 14 days ahead once it has synced') + '.' });
    }
    return self.read('apiJobs', [ds], cached, function (d) { if (d && d.ok) self.remember('jobs:' + ds, d); });
  };

  Engine.prototype.weekStrip = function (refDate) {
    var self = this, ref = TC.normDate(refDate) || self.today();
    var ws = TC.weekStart(ref), days = [], allCached = true;
    for (var i = 0; i < 7; i++) {
      var ds = TC.addDays(ws, i), r = self.reads()['jobs:' + ds], j = self.kv.jobs;
      var day = r ? r.data : j && j.days ? j.days[ds] : null;
      if (!day) allCached = false;
      days.push(day);
    }
    if (self.canLocal(ref) && (allCached || !self.likelyOnline())) return Promise.resolve(self.localStrip(ref, days));
    if (!self.likelyOnline()) return Promise.reject(err(NEEDS_SIGNAL, 'OFFLINE'));
    return self.rcall('apiWeekStrip', [refDate], 12000).catch(function (e) {
      if (NETWORKISH.test(e.code || '') && self.canLocal(ref)) return self.localStrip(ref, days);
      if (NETWORKISH.test(e.code || '')) throw err(NEEDS_SIGNAL, 'OFFLINE');
      throw e;
    });
  };
  Engine.prototype.localStrip = function (ref, jobDays) {
    var tc = this.card(ref);
    return {
      label: tc.week.label, start: tc.week.start, prev: tc.week.prev, next: tc.week.next, isCurrent: tc.week.isCurrent,
      calendarOk: true, offline: true,
      days: tc.week.days.map(function (d, i) {
        var jd = jobDays[i], n = 0;
        if (jd && jd.events) jd.events.forEach(function (e) { if (String(e.title || '').indexOf('SLIP: ') !== 0) n++; });
        return { date: d.date, dow: d.dow, dayNum: d.dayNum, label: d.label, isToday: d.isToday, isFuture: d.isFuture,
                 hours: d.hours, dayType: d.dayType, open: d.open, jobCount: n };
      })
    };
  };

  /** Home's first call. From the phone's copy when there is one (instant, works with no signal), else from the server. */
  Engine.prototype.boot = function () {
    var self = this;
    if (self.denied) return Promise.reject(self.denied);
    var have = self.kv.boot && self.timeData() && self.kv.boot.user && normEmail(self.kv.boot.user.email) === normEmail(self.me());
    if (have) {
      setTimeout(function () { self.syncNow(); }, 0);
      return Promise.resolve(self.composeBoot());
    }
    if (!self.likelyOnline()) {
      return Promise.reject(err('OFFLINE: No signal. Open the app once with signal so it can set itself up on this phone.', 'OFFLINE'));
    }
    return self.pullFull().then(function () {
      self.meta.lastSync = self.nowMs();
      return self.composeBoot();
    }, function (e) {
      if (NETWORKISH.test(e.code || '') && e.code !== 'OFFLINE') throw err(e.code + ': ' + e.message, e.code);
      if (e.code === 'OFFLINE') throw err('OFFLINE: No signal. Open the app once with signal so it can set itself up on this phone.', 'OFFLINE');
      throw e;
    });
  };
  Engine.prototype.composeBoot = function () {
    var b = clone(this.kv.boot), d = this.clock();
    b.today = localDs(d);
    b.nowHm = localHm(d);
    b.timeCard = this.card(b.today);
    if (this.kv.points && this.kv.points.data) b.points = clone(this.kv.points.data);
    b.app = b.app || {};
    b.app.serverVersion = b.app.version;
    b.app.version = this.version;
    b.offline = true;
    return b;
  };

  /** History of a block: from the server, or "waiting to sync" for one made on this phone. */
  Engine.prototype.history = function (id) {
    var self = this, e = findById(self.entries(), id);
    if (String(id).indexOf('c:') === 0) {
      return Promise.resolve([{ action: 'Create', field: '(all)', oldValue: '', newValue: '', reason: 'Made on this phone, waiting to sync',
                                by: self.me(), at: e ? e.createdAt : '' }]);
    }
    if (!self.likelyOnline()) return Promise.reject(err(NEEDS_SIGNAL, 'OFFLINE'));
    return self.rcall('apiEntryHistory', [id], 12000).catch(function (x) {
      if (NETWORKISH.test(x.code || '')) throw err(NEEDS_SIGNAL, 'OFFLINE');
      throw x;
    });
  };

  /** Anything not handled on the phone: straight to the server, or "needs signal". */
  Engine.prototype.passthrough = function (fn, args) {
    var self = this;
    if (!self.likelyOnline()) return Promise.reject(err(NEEDS_SIGNAL, 'OFFLINE'));
    return self.rcall(fn, args).then(function (r) {
      if (!/^api(Points|Gallery|JobPhotos|PhotoJobNames|PhotoThumbs|PhotoFull|WorkOrders?|Mod(Users|TimeOverview|TimeOff|Settings|Points|Rewards))$/.test(fn)) {
        self.staleAll(); // it may have changed something the phone has a copy of
      }
      return r;
    }, function (e) {
      if (NETWORKISH.test(e.code || '') && e.code === 'OFFLINE') throw err(NEEDS_SIGNAL, 'OFFLINE');
      throw e;
    });
  };

  /** The one entry point: args are exactly what the page passes to google.script.run (key first). */
  Engine.prototype.handle = function (fn, args) {
    var self = this;
    args = Array.prototype.slice.call(args || []);
    var key = args.shift();
    return self.init().then(function () { return self.setKey(key); }).then(function () {
      if (!self.key) {
        throw err('NOT_INVITED: Sign-in link needed. Open the personal link from your invite email on this phone, or paste it below.', 'NOT_INVITED');
      }
      if (self.denied && fn !== 'apiBootstrap') throw self.denied;
      var me = self.me();
      var mine = function (email) { return !email || normEmail(email) === normEmail(me); };
      switch (fn) {
        case 'apiBootstrap': return self.boot();
        case 'apiTimeCard':
          if (mine(args[1]) && self.canLocal(args[0])) return self.card(args[0]);
          return self.passthrough(fn, args);
        case 'apiWeekStrip': return self.weekStrip(args[0]);
        case 'apiSaveEntry':
          if (mine(args[0] && args[0].email) && self.timeData()) return self.saveEntry(args[0]);
          return self.passthrough(fn, args);
        case 'apiClockIn': return self.timeData() ? self.clockIn(args[0]) : self.passthrough(fn, args);
        case 'apiClockOut': return self.timeData() ? self.clockOut() : self.passthrough(fn, args);
        case 'apiDeleteEntry': {
          var own = self.timeData() && findById(self.entries(), args[0]);
          return own ? self.deleteEntry(args[0], args[1]) : self.passthrough(fn, args);
        }
        case 'apiEntryHistory': return self.history(args[0]);
        case 'apiJobs': return self.jobsFor(TC.normDate(args[0]) || self.today());
        case 'apiJobDetail': {
          var k = 'job:' + args[0] + '|' + (args[1] || '');
          return self.read(fn, args, self.reads()[k], function (d) { self.remember(k, d); },
            'OFFLINE: No signal. This job\'s notes show here once you have signal (or once you have opened it with signal).');
        }
        case 'apiOddsList': return self.read(fn, args, self.reads().odds || (self.kv.odds ? { at: self.kv.odds.at, data: self.kv.odds.data.list } : null),
          function (d) { self.remember('odds', d); });
        case 'apiOdd': {
          var ko = 'odd:' + args[0], co = self.reads()[ko];
          if (!co && self.kv.odds) {
            var od = self.kv.odds.data, l = od.list, all = [].concat(l.open || [], l.verify || [], l.done || []);
            var hit = all.filter(function (o) { return o.id === args[0]; })[0];
            if (hit) co = { at: self.kv.odds.at, data: { odd: hit, techs: od.techs, priorities: od.priorities } };
          }
          return self.read(fn, args, co, function (d) { self.remember(ko, d); });
        }
        case 'apiFinishLists': return self.read(fn, args, self.reads().finish || (self.kv.finish ? { at: self.kv.finish.at, data: { lists: self.kv.finish.data.lists } } : null),
          function (d) { self.remember('finish', d); });
        case 'apiFinishList': {
          var kf = 'finish:' + args[0], cf = self.reads()[kf];
          if (!cf && self.kv.finish && self.kv.finish.data.details[args[0]]) cf = { at: self.kv.finish.at, data: self.kv.finish.data.details[args[0]] };
          return self.read(fn, args, cf, function (d) { self.remember(kf, d); });
        }
        case 'apiPoints': return self.read(fn, args, self.reads().points || null, function (d) { self.remember('points', d); });
        default: return self.passthrough(fn, args);
      }
    });
  };

  return { Engine: Engine, statusLine: statusLine, applyOp: applyOp, uuid: uuid, hash: hash, NEEDS_SIGNAL: NEEDS_SIGNAL, QUEUED_MSG: QUEUED_MSG };
});
