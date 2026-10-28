/**
 * timecore.js (v1.0 offline): the v0.9 time card rules, on the phone, so the time card works with no signal.
 *
 * A line-by-line port of Time.gs / Util.gs (normalizeEntryInput_, blockConflict_, daySummary_, timeCard_, time off),
 * kept in step by test/offline.parity.test.js, which runs the same entries through the server code and this file and
 * expects the same time card. The server is still the judge: anything the phone saves is checked again on sync.
 * No location, ever. Notes that look like codes or passwords are refused here too (same patterns as Util.gs).
 * Works in the browser (window.WesTimeCore) and in Node tests (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WesTimeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_TYPES = ['Work', 'Sick', 'Vacation', 'Holiday'];
  var OFF_TYPES = { Sick: 'sick', Vacation: 'vacation', Holiday: 'holiday' };
  var DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function normEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }

  function normDate(v) {
    if (v === null || v === undefined || v === '') return '';
    var s = String(v).trim(), m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return '';
      y = +m[3]; mo = +m[1]; d = +m[2];
    }
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  function utc(ds) { var p = ds.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function addDays(ds, n) {
    var t = utc(ds); t.setUTCDate(t.getUTCDate() + n);
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }
  function dow(ds) { return utc(ds).getUTCDay(); }
  function yearOf(ds) { return Number(String(ds).slice(0, 4)); }
  function weekStart(ds) { return addDays(ds, -dow(ds)); }
  function dayLabel(ds) { var p = ds.split('-'); return DOW_NAMES[dow(ds)] + ' ' + MON_NAMES[+p[1] - 1] + ' ' + (+p[2]); }
  function weekLabel(ws) {
    var we = addDays(ws, 6), a = ws.split('-'), b = we.split('-');
    return MON_NAMES[+a[1] - 1] + ' ' + (+a[2]) + ' - ' + (a[1] === b[1] ? '' : MON_NAMES[+b[1] - 1] + ' ') + (+b[2]);
  }

  function parseTime(v) {
    if (v === null || v === undefined || v === '') return null;
    var s = String(v).trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
    var m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/);
    if (!m) return null;
    var h = +m[1], mi = m[2] ? +m[2] : 0, ap = m[3] || '';
    if (mi > 59) return null;
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap.charAt(0) === 'p' && h < 12) h += 12;
      if (ap.charAt(0) === 'a' && h === 12) h = 0;
    } else if (h > 23) return null;
    return h * 60 + mi;
  }
  function hm(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }
  function normHm(v) { var m = parseTime(v); return m === null ? '' : hm(m); }
  function time12(v) {
    var m = typeof v === 'number' ? v : parseTime(v);
    if (m === null || m === undefined) return '';
    var h = Math.floor(m / 60), mi = m % 60, ap = h < 12 ? 'AM' : 'PM';
    return (h % 12 === 0 ? 12 : h % 12) + ':' + pad2(mi) + ' ' + ap;
  }

  /* Same patterns as Util.gs (SECRET_RE_, PASSWORD_STRICT_RE_, KEY_LOC_RE_). */
  var SECRET_RE = /\b(alarm|gate|lock\s?box|key\s?pad|keypad|wi-?fi|password|passcode|pass\s?word|pin|code|combo|combination)s?\b[^\n]{0,20}?\d(?:[ #*-]?\d){2,}/i;
  var PASSWORD_STRICT_RE = /\b(?:password|passcode|pass\s?word|pwd|pw|wi-?fi\s+key|network\s+key)s?\s*(?:is|:|=)\s*\S+/i;
  var KEY_LOC_RE = /\b(?:(?:spare|hidden|house|door|front|back|extra|garage)\s+)?keys?\b(?=[^\n]{0,40}?\b(?:under|behind|inside|beneath|above|on top|hidden|located|lock\s?box|hook|planter|mat|rock|mailbox|flower ?pot|left (?:in|at|with))\b)[^\n]*/i;
  function looksSecret(text) {
    var s = String(text || '');
    return SECRET_RE.test(s) || PASSWORD_STRICT_RE.test(s) || KEY_LOC_RE.test(s);
  }

  /** normalizeEntryInput_ (Time.gs). Returns the stored values or throws the same friendly error. */
  function normalizeEntryInput(input, today, offDayHours) {
    input = input || {};
    var date = normDate(input.date);
    if (!date) throw new Error('Pick a valid date.');
    if (date < '2020-01-01') throw new Error('That date is too far back.');
    var dayType = '';
    DAY_TYPES.forEach(function (d) { if (d.toLowerCase() === str(input.dayType).toLowerCase()) dayType = d; });
    if (!dayType) throw new Error('Pick a day type: Work, Sick, Vacation or Holiday.');
    var s = parseTime(input.start), e = parseTime(input.end);
    if (str(input.start) && s === null) throw new Error('Start time is not a valid time.');
    if (str(input.end) && e === null) throw new Error('End time is not a valid time.');
    var open = false;
    if (dayType === 'Work') {
      if (date > today) throw new Error('You can\'t log work for a future date.');
      if (s !== null && e === null && date === today && input.allowOpen) open = true;
      else if (s === null || e === null) throw new Error('A work block needs a start and an end time.');
    } else {
      if ((s === null) !== (e === null)) throw new Error('Give both a start and an end time, or leave both blank.');
      if (date > addDays(today, 366)) throw new Error('That date is too far ahead.');
    }
    var hours;
    if (open) hours = 0;
    else if (s !== null) {
      if (e <= s) throw new Error('End time must be after start time (overnight shifts are not supported yet).');
      hours = round2((e - s) / 60);
    } else hours = offDayHours === undefined || offDayHours === null ? 8 : offDayHours;
    var note = str(input.note);
    if (note.length > 500) throw new Error('The note is too long (500 characters max).');
    if (looksSecret(note)) throw new Error('Notes can\'t hold door, alarm or gate codes, WiFi passwords or other access codes. Please take it out.');
    return { Date: date, DayType: dayType, Start: s === null ? '' : hm(s), End: e === null ? '' : hm(e),
             BreakMin: 0, Hours: hours, Note: note, Source: input.source === 'ClockButton' ? 'ClockButton' : 'Manual' };
  }

  function checkReason(reason, needed, what) {
    reason = str(reason);
    if (reason.length > 300) throw new Error('The reason is too long (300 characters max).');
    if (looksSecret(reason)) throw new Error('The reason can\'t hold access codes or passwords.');
    if (needed && reason.length < 3) throw new Error(what === 'delete' ? 'Please say why you are deleting this entry.' : 'Please say why you are changing this entry.');
    return reason;
  }

  /** An entry view (same fields as entryView_) from stored values. */
  function viewFrom(v, extra) {
    extra = extra || {};
    var start = normHm(v.Start), end = normHm(v.End);
    return {
      id: extra.id, email: normEmail(extra.email), date: v.Date, dateLabel: v.Date ? dayLabel(v.Date) : '',
      dayType: v.DayType, start: start, end: end, startLabel: time12(start), endLabel: time12(end),
      breakMin: 0, hours: round2(Number(v.Hours) || 0), note: str(v.Note), source: v.Source || 'Manual',
      overAllotment: false, edited: !!extra.edited, open: v.DayType === 'Work' && !!start && !end,
      createdAt: extra.createdAt || '', updatedAt: extra.updatedAt || '', updatedBy: extra.updatedBy || '',
      cid: extra.cid || '', pending: !!extra.pending
    };
  }
  /** Stored values (entryCore_) from a view. */
  function coreOf(e) {
    return { Date: e.date, DayType: e.dayType, Start: e.start, End: e.end, BreakMin: Number(e.breakMin) || 0,
             Hours: round2(Number(e.hours) || 0), Note: str(e.note) };
  }

  function rangeLabel(start, end) { return time12(start) + ' - ' + (end ? time12(end) : 'now'); }
  function openOf(entries, except) {
    var out = null;
    entries.forEach(function (r) { if (r !== except && r.dayType === 'Work' && r.start && !r.end) out = r; });
    return out;
  }
  /** blockConflict_ (Time.gs) over entry views of one person. '' when v fits. */
  function blockConflict(entries, v, except) {
    var others = entries.filter(function (r) { return r !== except && r.date === v.Date; }), day = dayLabel(v.Date);
    var off = others.filter(function (r) { return r.dayType !== 'Work'; })[0];
    if (off) return day + ' is already logged as ' + off.dayType + '. Change or delete that first.';
    if (v.DayType !== 'Work') {
      if (others.length) return 'There is already time logged for ' + day + '. A ' + v.DayType.toLowerCase() +
        ' day has to be the only entry that day: delete those blocks first.';
      return '';
    }
    if (v.Start && !v.End) {
      var op = openOf(entries, except);
      if (op) return 'You are already clocked in (' + dayLabel(op.date) + ' since ' + time12(op.start) + '). Clock out first.';
    }
    var s = parseTime(v.Start), e = v.End ? parseTime(v.End) : 24 * 60;
    for (var i = 0; i < others.length; i++) {
      var r = others[i], s2 = parseTime(r.start), e2 = r.end ? parseTime(r.end) : 24 * 60;
      if (s2 === null) continue;
      if (s < e2 && s2 < e) {
        return 'That overlaps your block ' + rangeLabel(r.start, r.end) + ' on ' + day + '. Change the times or edit that block.';
      }
    }
    return '';
  }

  /** recomputeOverAllotment_: flags Sick / Vacation / Holiday entries past the year's allotment, in date order. */
  function markOverAllotment(entries, allotment, year) {
    var counts = { Sick: 0, Vacation: 0, Holiday: 0 };
    entries.filter(function (r) { return yearOf(r.date) === year; })
      .slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .forEach(function (r) {
        var want = false;
        if (counts.hasOwnProperty(r.dayType)) {
          counts[r.dayType]++;
          var lim = allotment && allotment[OFF_TYPES[r.dayType]] ? allotment[OFF_TYPES[r.dayType]].total : null;
          if (lim !== null && lim !== undefined && counts[r.dayType] > lim) want = true;
        }
        r.overAllotment = want;
      });
  }

  function timeOffSummary(entries, allotment, year) {
    var list = entries.filter(function (e) { return yearOf(e.date) === year; });
    var out = { year: year, allotment: allotment, flagged: [], recent: [] };
    Object.keys(OFF_TYPES).forEach(function (ty) {
      var k = OFF_TYPES[ty];
      var used = list.filter(function (e) { return e.dayType === ty; }).length;
      var total = allotment[k].total;
      out[k] = { allotted: total, used: used, remaining: total === null ? null : round2(total - used),
                 over: total !== null && used > total, source: allotment[k].source };
    });
    list.forEach(function (e) { if (e.overAllotment) out.flagged.push(e); });
    out.recent = list.filter(function (e) { return e.dayType !== 'Work'; }).reverse().slice(0, 10);
    return out;
  }

  function sortByStart(list) {
    return list.slice().sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  }
  function daySummary(list) {
    var blocks = sortByStart(list), hours = 0;
    blocks.forEach(function (b) { hours += b.hours; });
    var off = blocks.filter(function (b) { return b.dayType !== 'Work'; })[0];
    return { entry: blocks[0] || null, blocks: blocks, hours: blocks.length ? round2(hours) : null,
             dayType: off ? off.dayType : blocks.length ? 'Work' : '',
             open: blocks.some(function (b) { return b.open; }),
             overAllotment: blocks.some(function (b) { return b.overAllotment; }),
             edited: blocks.some(function (b) { return b.edited; }) };
  }
  function byDateStable(entries) {
    return entries.map(function (e, i) { return [e, i]; })
      .sort(function (a, b) { return a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1]; })
      .map(function (x) { return x[0]; });
  }

  /** timeCard_ (Time.gs) from entry views. opts: {email, today, allotment, year} (allotment is for opts.year). */
  function timeCard(entries, refDate, opts) {
    var today = opts.today;
    refDate = normDate(refDate) || today;
    var ws = weekStart(refDate);
    var all = byDateStable(entries), byDate = {}, open = null;
    all.forEach(function (e) { (byDate[e.date] = byDate[e.date] || []).push(e); if (e.open) open = e; });
    var days = [], total = 0, work = 0;
    for (var i = 0; i < 7; i++) {
      var ds = addDays(ws, i), d = daySummary(byDate[ds] || []);
      days.push({ date: ds, label: dayLabel(ds), dow: DOW_NAMES[dow(ds)], dayNum: +ds.split('-')[2],
                  isToday: ds === today, isFuture: ds > today, entry: d.entry, blocks: d.blocks, hours: d.hours,
                  dayType: d.dayType, open: d.open, overAllotment: d.overAllotment, edited: d.edited });
      if (d.entry) { total += d.hours; if (d.dayType === 'Work') work += d.hours; }
    }
    var td = daySummary(byDate[today] || []);
    return {
      email: normEmail(opts.email), today: today, todayLabel: dayLabel(today), todayEntry: td.entry,
      todayBlocks: td.blocks, todayHours: td.hours, todayDayType: td.dayType, openBlock: open,
      week: { start: ws, end: addDays(ws, 6), label: weekLabel(ws), days: days, totalHours: round2(total),
              workHours: round2(work), prev: addDays(ws, -7), next: addDays(ws, 7), isCurrent: ws === weekStart(today) },
      timeOff: timeOffSummary(all, opts.allotment, yearOf(refDate))
    };
  }

  return {
    DAY_TYPES: DAY_TYPES, normDate: normDate, addDays: addDays, dow: dow, weekStart: weekStart, yearOf: yearOf,
    dayLabel: dayLabel, weekLabel: weekLabel, parseTime: parseTime, hm: hm, normHm: normHm, time12: time12, round2: round2,
    looksSecret: looksSecret, normalizeEntryInput: normalizeEntryInput, checkReason: checkReason, viewFrom: viewFrom,
    coreOf: coreOf, openOf: openOf, blockConflict: blockConflict, markOverAllotment: markOverAllotment,
    timeOffSummary: timeOffSummary, daySummary: daySummary, timeCard: timeCard
  };
});
