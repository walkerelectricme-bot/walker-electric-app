/**
 * engine.js (v1.0 offline): the phone side of the app. The screens (the unchanged v0.9 page script) call
 * google.script.run.apiXxx(key, ...) as before; shell.js hands every call to Engine.handle(fn, args), which:
 *
 *  - Time card (my own): works with or without signal. Reads are built on the phone from the cached entries plus the
 *    changes still waiting in the outbox (timecore.js = the v0.9 rules). Writes (save / edit / delete a block, Clock in,
 *    Clock out) are checked with the same rules, put in the outbox with a client-made ID (UUID) and the phone time,
 *    and synced: right away when there is signal (so a server refusal shows like it did in v0.9), else later.
 *  - Jobs (7 days back to 14 ahead), Odds and Ends, finish lists, points, the v1.2 materials list: shown from the server
 *    when there is signal, from the phone's copy when there is not.
 *  - v1.3 completed slips (jobs and Odds and Ends): saved on the phone FIRST (IndexedDB 'slips', the offline slip queue),
 *    then sent: right away when there is signal (a refusal shows on the form like before), else later. Each slip has a
 *    client-made ID (clientSlipId); the server keeps the first result for that ID (Api.gs slipOnce_), so a retry after a
 *    lost reply never makes a second slip or SLIP: event. Network trouble / 5xx = retry with backoff (30 s, 2 min, 5 min,
 *    then every 15 min); a refusal by the server = "Needs attention" with the server's message (no more retries until the
 *    tech edits it or taps Sync now). The finish-list part of a slip goes up after the slip, with its own ID.
 *  - v1.4 generator service tool (only with GENERATOR_MODE mods / inapp): the generator copy (stops, details, search,
 *    "Not serviced this year") works with no signal; a service is an outbox op (genService, client ID = SubmissionID) shown
 *    as "Waiting to upload" until the server has it; "Make this the usual order" is an outbox op too (genLoopOrder), and so
 *    is a generator's pin (genSetPin; the location is read only when the tech taps "Use my location", in the page).
 *  - Everything else (photos, work orders, moderator screens...): needs signal, with a clear message.
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
  // v1.3 offline slip queue
  var SLIP_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]; // then 15 min, capped
  var SLIP_RETRY = /^(OFFLINE|ACCESS|SERVER|BUSY|RETRY|SETUP)$/;
  var SLIP_TIMEOUT_MS = 30000;
  var SLIP_QUEUED_MSG = 'Saved on this phone. Waiting to sync: it goes to the office by itself when you have signal.';
  // v1.4 generator service tool
  var KV_KEYS = ['boot', 'time', 'jobs', 'odds', 'finish', 'points', 'mats', 'reads', 'gen', 'genSent'];
  var GEN_FRESH_MS = 5 * 60 * 1000;       // the generator copy younger than this opens without asking the server
  var GEN_QUEUED_MSG = 'Saved on this phone. Waiting to upload: it goes to the Generator Service Database by itself when you have signal.';
  var GEN_NO_COPY = 'OFFLINE: No signal. The generator list shows here once this phone has it (open Generator service once with signal).';

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
   * s: {online, pending, problems, attention, lastSync (ms or 0), now (ms), syncing}. Returns {state, text}:
   * green "Updated X min ago" | amber "N waiting to sync" | gray "Offline, last updated <time>" | red "N couldn't sync".
   * v1.3: pending includes slips waiting in the slip queue; attention = slips the server refused ("N slips need attention").
   */
  function statusLine(s) {
    var now = s.now || Date.now();
    if (s.attention > 0 && !(s.problems > 0)) {
      return { state: 'red', text: s.attention + (s.attention === 1 ? ' slip needs' : ' slips need') + ' attention. Tap to see.' };
    }
    if (s.problems > 0 && s.attention > 0) {
      return { state: 'red', text: (s.problems + s.attention) + ' changes couldn\'t sync. Tap to see.' };
    }
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
    this.slips = [];          // v1.3 offline slip queue (every person on this phone; mySlips() = mine)
    this.slipBusy = {};       // cid -> true while that slip is on its way
    this.slipListeners = [];  // fn(event, item, info) for slips finished or refused in the background
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
      return Promise.all([self.store.get('kv', 'meta'), self.store.all('outbox'), self.store.all('problems'),
        Promise.resolve().then(function () { return self.store.all('slips'); }).catch(function () { return []; })]);
    }).then(function (r) {
      if (r[0]) self.meta = Object.assign(self.meta, r[0]);
      if (!self.meta.deviceId) self.meta.deviceId = uuid();
      self.outbox = r[1] || []; self.problems = r[2] || [];
      self.slips = (r[3] || []).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      return Promise.all(KV_KEYS.map(function (k) {
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
      KV_KEYS.forEach(function (k) { self.store.del('kv', k); });
    }
    self.meta.owner = self.owner;
    return self.saveMeta();
  };
  Engine.prototype.myOps = function () { var o = this.owner; return this.outbox.filter(function (x) { return x.owner === o; }); };
  Engine.prototype.pendingCount = function () { return this.myOps().length; };

  Engine.prototype.status = function () {
    return statusLine({ online: this.likelyOnline(), pending: this.pendingCount() + this.slipsWaiting().length, problems: this.problems.length,
                        attention: this.slipsAttention().length, lastSync: this.meta.lastSync, now: this.nowMs(), syncing: !!this.syncing });
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

  function isGenOp(op) { return /^gen/.test(String(op && op.type || '')); }

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
    this.myOps().forEach(function (op) { if (!isGenOp(op)) applyOp(list, op, me, off); }); // v1.4: generator ops are not time
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
    return Promise.all(KV_KEYS.map(function (k) { return s.del('kv', k); }));
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
    var loopFailed = false;
    self.syncing = self.init().then(function () { return self.syncLoop(opts, 0); })
      .catch(function () { loopFailed = true; })
      .then(function () { return self.flushSlips(opts); }) // v1.3: slips waiting in the slip queue (never rejects)
      .then(function () {
        if (loopFailed) return;
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
    var wire = ops.map(function (o) { return { cid: o.cid, type: o.type, ref: o.ref, entry: o.entry, gen: o.gen, phoneTime: o.phoneTime }; });
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
            if (isGenOp(o)) writes.push(self.genAfter(o, r)); // v1.4: the generator copy is out of date now
            if (r.status === 'rejected') {
              var pr = { cid: r.cid, type: o.type, entry: o.entry, gen: o.gen, message: r.message || 'Not saved.', at: self.nowMs() };
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
    var gv = self.genCache() ? self.genCache().data.version : ''; // v1.4: unchanged generator copy = {same: true}, no data
    return self.rcall('apiOfflineSnapshot', [gv ? { genVersion: gv } : {}], 60000).then(function (s) {
      var at = self.nowMs(), w = [];
      if (s.boot) w.push(self.setKv('boot', s.boot));
      if (s.time) w.push(self.setKv('time', s.time));
      if (s.points !== undefined) w.push(self.setKv('points', { at: at, data: s.points }));
      if (s.jobs) w.push(self.setKv('jobs', { at: at, from: s.jobs.from, to: s.jobs.to, days: s.jobs.days }));
      if (s.odds) w.push(self.setKv('odds', { at: at, data: s.odds }));
      if (s.finish) w.push(self.setKv('finish', { at: at, data: s.finish }));
      if (s.mats) w.push(self.setKv('mats', { at: at, data: s.mats })); // v1.2 materials picker list (search works with no signal)
      if (s.gen) w.push(self.genStore(s.gen)); // v1.4 generator service tool (stops, search, not serviced this year with no signal)
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
    ['jobs', 'odds', 'finish', 'points', 'mats'].forEach(function (k) { if (self.kv[k]) self.kv[k].at = 0; });
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
      setTimeout(function () { self.syncNow({ force: true }); }, 0); // app open: slips waiting go up now (no backoff wait)
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

  /* ---------------- v1.3 offline slip queue ---------------- */

  /** Wait before the next try after `attempts` failed tries: 30 s, 2 min, 5 min, then 15 min (capped). */
  function slipBackoff(attempts) {
    var i = Math.min(Math.max(attempts || 1, 1), SLIP_BACKOFF_MS.length) - 1;
    return SLIP_BACKOFF_MS[i];
  }
  /** 'retry' (no signal, timeout, 5xx, busy), 'denied' (the sign-in link stopped working) or 'rejected' (the server said no). */
  function slipFailKind(e) {
    var code = String(e && e.code || '');
    if (SLIP_RETRY.test(code)) return 'retry';
    if (DENIED.test(code)) return 'denied';
    return 'rejected';
  }
  function cleanMsg(e) { return String(e && e.message || e || '').replace(/^Error:\s*/, '').replace(/^[A-Z_]+:\s*/, ''); }
  function slipTarget(it) { return it.kind + ':' + (it.kind === 'oddSlip' ? it.oddId : (it.input.eventId || '') + '|' + (it.input.date || '')); }

  Engine.prototype.mySlips = function () {
    var o = this.owner;
    return this.slips.filter(function (s) { return s.owner === o; });
  };
  Engine.prototype.slipsWaiting = function () { return this.mySlips().filter(function (s) { return s.status !== 'attention'; }); };
  Engine.prototype.slipsAttention = function () { return this.mySlips().filter(function (s) { return s.status === 'attention'; }); };
  Engine.prototype.slipById = function (cid) { return this.mySlips().filter(function (s) { return s.cid === cid; })[0] || null; };
  /** The queued slip for a job on a day (or an odd job), if any. */
  Engine.prototype.slipFor = function (eventId, date, oddId) {
    return this.mySlips().filter(function (s) {
      return oddId ? s.kind === 'oddSlip' && s.oddId === oddId : s.kind === 'slip' && s.input.eventId === eventId && s.input.date === date;
    })[0] || null;
  };
  Engine.prototype.onSlip = function (fn) { this.slipListeners.push(fn); };
  Engine.prototype.slipEmit = function (ev, it, info) {
    this.slipListeners.forEach(function (f) { try { f(ev, it, info); } catch (e) {} });
  };
  Engine.prototype.slipsDue = function () {
    var self = this, now = self.nowMs();
    return self.slipsWaiting().some(function (s) { return !self.slipBusy[s.cid] && (s.nextAt || 0) <= now; });
  };
  Engine.prototype.slipSave = function (it) {
    var self = this;
    it.updatedAt = self.nowMs();
    var i = self.slips.map(function (s) { return s.cid; }).indexOf(it.cid);
    if (i >= 0) self.slips[i] = it; else self.slips.push(it);
    return self.store.put('slips', clone(it));
  };
  Engine.prototype.slipDrop = function (cid) {
    var self = this;
    self.slips = self.slips.filter(function (s) { return s.cid !== cid; });
    return self.store.del('slips', cid);
  };

  /**
   * A completed slip from the form. Saved on the phone FIRST (so nothing is ever lost), then sent when there is signal.
   * phoneOpts: {fin: finish-list follow-up (apiFinishFromSlip input) or null, ctx: what the queue screen and Edit need
   * (title, place, the finish part of the form), replace: cid of the queued slip this one replaces (Edit)}.
   * Resolves with the server's result (+ .finish) when it went up now, or {queued: true, cid, message} when it waits.
   * Rejects only when the server refused it right away (the form is still open, like before) or the phone can't keep it.
   */
  Engine.prototype.queueSlip = function (kind, oddId, input, phoneOpts) {
    var self = this;
    phoneOpts = phoneOpts || {};
    input = clone(input || {});
    if (kind === 'oddSlip' && !oddId) return Promise.reject(err('Pick the odd job first.'));
    var d = self.clock(), cid = uuid();
    input.clientSlipId = cid;
    input.clientApp = self.version;
    input.phoneTime = d.toISOString();
    var it = { cid: cid, seq: ++self.meta.seq, owner: self.owner, kind: kind, oddId: String(oddId || ''), input: input,
               fin: phoneOpts.fin ? clone(phoneOpts.fin) : null, finCid: cid + '-f', ctx: clone(phoneOpts.ctx || {}), stage: 'slip',
               status: 'pending', attempts: 0, nextAt: 0, lastError: '', lastTryAt: 0, createdAt: d.getTime(), updatedAt: d.getTime(),
               result: null, edited: !!phoneOpts.replace };
    // One slip per job and day (or odd job) in the queue: a new one (or an Edit) replaces the one waiting, never adds a second.
    var target = slipTarget(it), old = self.mySlips().filter(function (s) {
      return (phoneOpts.replace && s.cid === phoneOpts.replace) || (s.stage === 'slip' && slipTarget(s) === target);
    });
    if (old.length) it.edited = true; // it replaces a slip that was waiting: a refusal keeps it (Needs attention), nothing is lost
    if (old.some(function (s) { return self.slipBusy[s.cid]; })) {
      return Promise.reject(err('This slip is on its way to the office right now. Try again in a moment.'));
    }
    if (old.some(function (s) { return s.stage !== 'slip'; })) {
      return Promise.reject(err('That slip already reached the office (only its finish-list part is waiting), so it can\'t be changed here. Open the job to replace it.'));
    }
    // Write first: the slip is on the phone before any network call. Then drop the one it replaces.
    return self.slipSave(it).then(function () {
      return Promise.all(old.map(function (s) { return self.slipDrop(s.cid); }));
    }, function (e) {
      self.slips = self.slips.filter(function (s) { return s.cid !== cid; });
      throw err('This phone could not save the slip (' + cleanMsg(e) + '). Nothing was sent. Try again, or write it down.');
    }).then(function () {
      return self.saveMeta();
    }).then(function () {
      self.emit();
      if (!self.isOnline() || self.denied) return self.queuedResult(it);
      return self.sendSlip(it, { immediate: true }).then(function (o) {
        if (o.state === 'done') return o.result;
        if (o.state === 'rejected' && !it.edited) throw err(o.message);
        if (o.state === 'rejected') throw err(o.message + ' It is kept in Slips waiting to sync (Needs attention) so you can fix it.');
        return self.queuedResult(it);
      });
    });
  };
  Engine.prototype.queuedResult = function (it) {
    var vol = !!(this.store && (this.store.volatile || (typeof this.store.isVolatile === 'function' && this.store.isVolatile())));
    return { ok: true, queued: true, cid: it.cid, status: it.status, lastError: it.lastError,
             message: SLIP_QUEUED_MSG + (vol ? ' This phone can\'t keep it if the app is closed (private browsing?): keep the app open until it syncs.' : ''),
             volatile: vol };
  };

  /**
   * One try for one queued slip (the slip, then its finish-list part). Resolves {state: done | retry | rejected | denied,
   * result, message}; never rejects. done = the slip is on the server and out of the queue.
   */
  Engine.prototype.sendSlip = function (it, o) {
    var self = this;
    o = o || {};
    if (self.slipBusy[it.cid]) return Promise.resolve({ state: 'retry', message: 'Already on its way.' });
    self.slipBusy[it.cid] = true;
    it.lastTryAt = self.nowMs();
    self.emit();
    var fail = function (e, stage) {
      var kind = slipFailKind(e), msg = cleanMsg(e) || 'Not sent.';
      it.attempts = (it.attempts || 0) + 1;
      it.lastError = msg;
      if (kind === 'retry') {
        it.status = 'pending';
        it.nextAt = self.nowMs() + slipBackoff(it.attempts);
        return self.slipSave(it).then(function () { return { state: 'retry', message: msg, stage: stage }; });
      }
      if (stage === 'finish') {
        // The slip itself is saved; only the finish-list part was refused (as before: "Finish list NOT updated").
        it.finishError = msg;
        return self.slipFinal(it, o).then(function () { return { state: 'done', result: self.slipResult(it) }; });
      }
      if (kind === 'rejected' && o.immediate && !it.edited) {
        // The person is still on the form: the error shows there, like before, and the slip leaves the queue.
        return self.slipDrop(it.cid).then(function () { return { state: 'rejected', message: msg }; });
      }
      it.status = 'attention';
      it.nextAt = 0;
      if (kind === 'denied') it.lastError = msg + ' (Open your personal link again, then tap Sync now.)';
      return self.slipSave(it).then(function () {
        if (!o.immediate) self.slipEmit('attention', clone(it), { message: it.lastError });
        return { state: kind, message: it.lastError };
      });
    };
    var step = it.stage === 'finish' ? Promise.resolve() : self.rcall(it.kind === 'oddSlip' ? 'apiOddSlip' : 'apiSubmitSlip',
      it.kind === 'oddSlip' ? [it.oddId, it.input] : [it.input], SLIP_TIMEOUT_MS).then(function (r) {
        it.result = r; it.stage = 'finish'; it.status = 'pending'; it.lastError = '';
        if (!it.fin) return 'final';
        return self.slipSave(it);
      }, function (e) { throw { slipFail: e, stage: 'slip' }; });
    var p = step.then(function (x) {
      if (x === 'final') return self.slipFinal(it, o).then(function () { return { state: 'done', result: self.slipResult(it) }; });
      if (!it.fin) return self.slipFinal(it, o).then(function () { return { state: 'done', result: self.slipResult(it) }; });
      var fin = Object.assign({}, it.fin, { clientSlipId: it.finCid, clientApp: self.version });
      return self.rcall('apiFinishFromSlip', [fin], SLIP_TIMEOUT_MS).then(function (f) {
        it.finishResult = f;
        return self.slipFinal(it, o).then(function () { return { state: 'done', result: self.slipResult(it) }; });
      }, function (e) { throw { slipFail: e, stage: 'finish' }; });
    }).catch(function (x) {
      if (x && x.slipFail) return fail(x.slipFail, x.stage);
      return fail(x, it.stage);
    }).then(function (out) {
      delete self.slipBusy[it.cid];
      // The slip is on the server but its finish-list part waits: show the slip as saved now (the list follows).
      if (out.state === 'retry' && out.stage === 'finish' && o.immediate) {
        it.slipShown = true;
        self.slipSave(it);
        out = { state: 'done', result: self.slipResult(it, true) };
      }
      self.emit();
      return out;
    }, function (e) {
      delete self.slipBusy[it.cid];
      self.emit();
      return { state: 'retry', message: cleanMsg(e) };
    });
    return p;
  };
  /** The server's slip result + what happened to the finish-list part: finish {result} | {error} | {queued: true}. */
  Engine.prototype.slipResult = function (it, finQueued) {
    var r = clone(it.result) || {};
    if (it.fin) r.finish = finQueued ? { queued: true } : it.finishError ? { error: it.finishError } : { result: clone(it.finishResult) || {} };
    return r;
  };
  Engine.prototype.slipFinal = function (it, o) {
    var self = this;
    return self.slipDrop(it.cid).then(function () {
      self.staleAll(); // the jobs / odd jobs the phone has a copy of changed
      if (!o.immediate) self.slipEmit('done', clone(it), { result: self.slipResult(it) });
    });
  };

  /** Sends the queued slips that are due (all of them when opts.force), oldest first. Never rejects. */
  Engine.prototype.flushSlips = function (opts) {
    var self = this;
    opts = opts || {};
    if (!self.key || self.denied || !self.isOnline()) return Promise.resolve();
    var now = self.nowMs();
    var due = self.slipsWaiting().filter(function (s) { return !self.slipBusy[s.cid] && (opts.force || (s.nextAt || 0) <= now); });
    var i = 0;
    function next() {
      if (i >= due.length) return Promise.resolve();
      var it = due[i++];
      if (!self.slipById(it.cid)) return next(); // deleted or replaced meanwhile
      return self.sendSlip(it, {}).then(function (o) {
        if (o.state === 'retry' && self.reachable === false) return; // no signal: the rest wait for the next try
        return next();
      });
    }
    return next().catch(function () {});
  };

  /** Pending slips screen: Sync now for one slip (also one that needs attention: it gets one more try). */
  Engine.prototype.retrySlip = function (cid) {
    var self = this, it = self.slipById(cid);
    if (!it) return Promise.reject(err('That slip is no longer waiting (it may have synced already).'));
    if (self.slipBusy[cid]) return Promise.resolve({ state: 'retry', message: 'Already on its way.' });
    it.status = 'pending'; it.nextAt = 0;
    self.reachable = null;
    return self.slipSave(it).then(function () {
      self.emit();
      if (!self.isOnline()) return { state: 'retry', message: 'No signal right now. It goes up by itself when you have signal.' };
      return self.sendSlip(it, {});
    });
  };
  /** Pending slips screen: Sync now for all (slips that need attention get one more try too). */
  Engine.prototype.requeueAll = function () {
    var self = this;
    self.reachable = null;
    return Promise.all(self.mySlips().filter(function (s) { return s.status === 'attention' || s.nextAt; }).map(function (s) {
      s.status = 'pending'; s.nextAt = 0;
      return self.slipSave(s);
    })).then(function () { self.emit(); });
  };
  /** Pending slips screen: Delete (the screen asks first). */
  Engine.prototype.deleteSlip = function (cid) {
    var self = this;
    if (self.slipBusy[cid]) return Promise.reject(err('This slip is on its way to the office right now. Try again in a moment.'));
    if (!self.slipById(cid)) return Promise.resolve();
    return self.slipDrop(cid).then(function () { self.emit(); });
  };

  /* ---------------- v1.4 generator service tool ---------------- */
  /*
   * kv 'gen' = {at, data}: the server's generator copy (Generators.gs genSnapshot_; codes already stripped there). Stops,
   * stop details, search and "Not serviced this year" work from it with no signal. A service is an outbox op (genService,
   * client ID = SubmissionID): saved on the phone first, "Waiting to upload" until the server has it. "Make this the usual
   * order" is an outbox op too (genLoopOrder), refused by the server if someone changed the loop meanwhile.
   * kv 'genSent' = services that went up since the copy was made (shown as done until the next copy has them).
   */
  Engine.prototype.genCache = function () { return this.kv.gen && this.kv.gen.data ? this.kv.gen : null; };
  /** A copy from the server: full data, {same} (unchanged), {enabled:false} (turned off: drop it) or {error} (keep ours). */
  Engine.prototype.genStore = function (d) {
    var self = this;
    if (!d || typeof d !== 'object') return Promise.resolve();
    if (d.enabled === false) {
      if (d.error) return Promise.resolve();
      delete self.kv.gen;
      return self.store.del('kv', 'gen');
    }
    if (d.same) {
      if (!self.genCache() || self.genCache().data.version !== d.version) return Promise.resolve();
      self.kv.gen.at = self.nowMs();
      return self.store.put('kv', self.kv.gen, 'gen');
    }
    if (!d.generators || !d.loops) return Promise.resolve();
    var w = [self.setKv('gen', { at: self.nowMs(), data: d })];
    var sent = (self.kv.genSent || []).filter(function (x) {
      var h = (d.history && d.history[x.gid]) || [];
      return x.day === d.today && !h.some(function (l) { return l.logId === x.logId; });
    });
    w.push(self.setKv('genSent', sent));
    return Promise.all(w);
  };
  /** After the server finished a generator op: a service is remembered as done; the copy is refreshed on the next open. */
  Engine.prototype.genAfter = function (o, r) {
    var self = this;
    if (self.kv.gen) self.kv.gen.at = 0;
    if (r.status === 'done' && o.type === 'genSetPin' && r.gen && r.gen.applied && r.gen.pin) self.genPinIntoCache(o.gen.generatorId, r.gen.pin);
    if (r.status !== 'done' || o.type !== 'genService') return Promise.resolve();
    var g = o.gen || {}, sent = (self.kv.genSent || []).filter(function (x) { return x.cid !== o.cid; });
    sent.push({ cid: o.cid, gid: g.generatorId, date: g.serviceDate, day: self.today(), logId: r.entryId || '', at: self.nowMs() });
    return self.setKv('genSent', sent);
  };
  /** The copy + what only this phone knows: services waiting to upload, sent, refused; usual orders waiting. */
  Engine.prototype.genView = function () {
    var self = this, c = self.genCache();
    var d = clone(c.data), pending = [], orders = [], pins = [];
    self.myOps().forEach(function (o) {
      if (o.type === 'genService') pending.push({ cid: o.cid, gid: o.gen.generatorId, date: o.gen.serviceDate, tries: o.tries || 0, lastError: o.lastError || '', at: o.createdAt });
      if (o.type === 'genLoopOrder') orders.push({ cid: o.cid, loopId: o.gen.loopId, order: clone(o.gen.order) });
      if (o.type === 'genSetPin') pins.push({ cid: o.cid, gid: o.gen.generatorId });
    });
    // a pin waiting to upload already shows (and Navigate already uses it) on this phone
    self.myOps().forEach(function (o) {
      var g = o.type === 'genSetPin' && d.generators[o.gen.generatorId];
      if (!g) return;
      g.pin = { lat: o.gen.lat, lng: o.gen.lng, source: o.gen.source, acc: o.gen.source === 'gps' ? o.gen.acc : null, by: 'you', date: localDs(new Date(o.createdAt || 0)), pending: true };
      g.nav = genPinNav(g.pin);
    });
    d.local = { pending: pending, orders: orders, pins: pins, sent: clone(self.kv.genSent || []),
                problems: self.problems.filter(isGenOp).map(function (p) { return { cid: p.cid, type: p.type, gid: p.gen && p.gen.generatorId, loopId: p.gen && p.gen.loopId, message: p.message }; }),
                at: c.at, online: self.likelyOnline(), phone: true };
    return d;
  };
  Engine.prototype.genSnapshot = function (force) {
    var self = this, c = self.genCache();
    if (c && ((!force && self.nowMs() - c.at < GEN_FRESH_MS) || !self.likelyOnline())) return Promise.resolve(self.genView());
    if (!self.likelyOnline()) return Promise.reject(err(GEN_NO_COPY, 'OFFLINE'));
    return self.rcall('apiGenSnapshot', [c ? c.data.version : ''], 30000).then(function (d) {
      return self.genStore(d).then(function () {
        if (!self.genCache()) throw err('The generator tool is not turned on for you yet.');
        return self.genView();
      });
    }, function (e) {
      if (NETWORKISH.test(e.code || '') && self.genCache()) return self.genView();
      if (NETWORKISH.test(e.code || '')) throw err(GEN_NO_COPY, 'OFFLINE');
      if (/not turned on/i.test(e.message || '')) { delete self.kv.gen; self.store.del('kv', 'gen'); }
      throw e;
    });
  };
  /** A service from the form: on the phone first, then up (now with signal, else later). Never a fake "saved". */
  Engine.prototype.genSubmit = function (p) {
    var self = this;
    p = clone(p || {});
    if (!p.generatorId) return Promise.reject(err('Pick the generator first.'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.serviceDate || ''))) p.serviceDate = self.today();
    var op = { cid: uuid(), type: 'genService', gen: p };
    p.submissionId = op.cid;
    return self.enqueue(op).then(function () { return self.settle(op); }).then(function (r) {
      if (r && r.status === 'rejected') {
        self.dismissProblem(op.cid); // shown now, on the form
        throw err(r.message || 'That service was not saved.');
      }
      if (r && r.status === 'done') return Object.assign({ ok: true, queued: false, logId: r.entryId }, clone(r.gen) || {});
      return { ok: true, queued: true, cid: op.cid, message: GEN_QUEUED_MSG };
    });
  };
  /** "Make this the usual order": refused (CHANGED: ...) if the loop changed since this phone's copy. */
  Engine.prototype.genUsualOrder = function (loopId, baseSig, order) {
    var self = this;
    if (self.myOps().some(function (o) { return o.type === 'genLoopOrder' && o.gen.loopId === loopId; })) {
      return Promise.reject(err('Your last usual order for this loop is still waiting to upload. Try again once it has synced.'));
    }
    var op = { cid: uuid(), type: 'genLoopOrder', gen: { loopId: String(loopId || ''), baseSig: String(baseSig || ''), order: clone(order || []) } };
    return self.enqueue(op).then(function () { return self.settle(op); }).then(function (r) {
      if (r && r.status === 'rejected') {
        self.dismissProblem(op.cid);
        if (self.kv.gen) self.kv.gen.at = 0;
        throw err(r.message || 'The usual order was not saved.');
      }
      if (r && r.status === 'done') {
        var c = self.genCache(), l = c && c.data.loops.filter(function (x) { return x.id === loopId; })[0];
        if (l) {
          var by = {};
          l.stops.forEach(function (s) { by[s.key] = s; });
          if (op.gen.order.every(function (k) { return by[k]; })) l.stops = op.gen.order.map(function (k) { return by[k]; });
          if (r.gen && r.gen.sig) l.sig = r.gen.sig;
          self.store.put('kv', c, 'gen');
        }
        return { ok: true, queued: false };
      }
      return { ok: true, queued: true, message: 'Saved on this phone. The usual order uploads when you have signal.' };
    });
  };
  function genPinNav(pin) { return 'https://www.google.com/maps/dir/?api=1&destination=' + pin.lat + ',' + pin.lng; }
  Engine.prototype.genPinIntoCache = function (gid, pin) {
    var c = this.genCache(), g = c && c.data.generators[gid];
    if (!g) return;
    g.pin = clone(pin); g.nav = genPinNav(pin);
    this.store.put('kv', c, 'gen');
  };
  /**
   * A pin the tech set (GPS at the unit, or the map): saved on the phone first, then up. p = {generatorId, lat, lng,
   * source: gps | map, acc (metres, gps), at (when captured)}. Only what the tech tapped; the phone keeps no other location.
   */
  Engine.prototype.genSetPin = function (p) {
    var self = this;
    p = p || {};
    var lat = Number(p.lat), lng = Number(p.lng);
    if (!p.generatorId) return Promise.reject(err('Pick the generator first.'));
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return Promise.reject(err('That pin has no valid location.'));
    var gen = { generatorId: String(p.generatorId), lat: lat, lng: lng, source: p.source === 'map' ? 'map' : 'gps',
                acc: p.source === 'map' ? '' : Number(p.acc), at: p.at || self.clock().toISOString() };
    var op = { cid: uuid(), type: 'genSetPin', gen: gen };
    return self.enqueue(op).then(function () { return self.settle(op); }).then(function (r) {
      if (r && r.status === 'rejected') {
        self.dismissProblem(op.cid);
        throw err(r.message || 'That pin was not saved.');
      }
      if (r && r.status === 'done') return { ok: true, queued: false, applied: !!(r.gen && r.gen.applied), pin: r.gen && r.gen.pin };
      return { ok: true, queued: true, message: 'Pin saved on this phone. It uploads when you have signal.' };
    });
  };
  /** Needs signal: full history, loop changes, add a generator. A fresh copy that comes back is kept. */
  Engine.prototype.genPass = function (fn, args) {
    var self = this;
    if (!self.likelyOnline()) return Promise.reject(err('OFFLINE: This needs signal. Stops, search and the service form work without it.', 'OFFLINE'));
    return self.rcall(fn, args, 30000).then(function (r) {
      if (r && r.snapshot) return self.genStore(r.snapshot).then(function () { r.snapshot = self.genCache() ? self.genView() : r.snapshot; return r; });
      return r;
    }, function (e) {
      if (e.code === 'OFFLINE') throw err('OFFLINE: This needs signal. Stops, search and the service form work without it.', 'OFFLINE');
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
        // v1.3 offline slip queue: args = [input, phoneOpts] / [oddId, input, phoneOpts] (phoneOpts never reaches the server)
        case 'apiSubmitSlip': return self.queueSlip('slip', '', args[0], args[1]);
        case 'apiOddSlip': return self.queueSlip('oddSlip', args[0], args[1], args[2]);
        case 'apiPoints': return self.read(fn, args, self.reads().points || null, function (d) { self.remember('points', d); });
        // v1.2 materials picker: the list from the phone's copy when there is no signal (edits need signal)
        case 'apiMaterials': return self.read(fn, args, self.reads().mats || (self.kv.mats ? { at: self.kv.mats.at, data: self.kv.mats.data } : null),
          function (d) { self.remember('mats', d); },
          'OFFLINE: No signal. Material suggestions show once this phone has the list (open the app once with signal).');
        // v1.4 generator service tool: the phone's copy, services and the usual order through the outbox
        case 'apiGenSnapshot': return self.genSnapshot(args[0] === 'refresh');
        case 'apiGenSubmitService': return self.genSubmit(args[0]);
        case 'apiGenSetUsualOrder': return self.genUsualOrder(args[0], args[1], args[2]);
        case 'apiGenSetPin': return self.genSetPin(args[0]);
        case 'apiGenHistory': case 'apiGenSaveLoop': case 'apiGenAddStop': case 'apiGenRemoveStop': case 'apiGenAddGenerator':
          return self.genPass(fn, args);
        default: return self.passthrough(fn, args);
      }
    });
  };

  return { Engine: Engine, statusLine: statusLine, applyOp: applyOp, GEN_QUEUED_MSG: GEN_QUEUED_MSG, uuid: uuid, hash: hash, NEEDS_SIGNAL: NEEDS_SIGNAL, QUEUED_MSG: QUEUED_MSG,
           slipBackoff: slipBackoff, slipFailKind: slipFailKind, SLIP_BACKOFF_MS: SLIP_BACKOFF_MS, SLIP_QUEUED_MSG: SLIP_QUEUED_MSG };
});
