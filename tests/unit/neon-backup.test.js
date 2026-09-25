'use strict';

// ENG-1 (broad-scan 2026-09-23): the Neon backup's closed-month rule.
//
// The monthly per-call backup (NeonBackup.gs) used to skip a closed month
// forever once its file existed. The last write of a month's file is the
// last Saturday run INSIDE that month, so the days after it (plus the last
// day's next-morning ingest) were never backed up -- and NeonRetention later
// nulls journeys / deletes those rows, which exist nowhere else.
//
// These tests drive the REAL runNeonBackup_ against an in-memory Drive
// folder and a fake Neon connection whose rows are dated per day, across the
// month boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'NeonRetention.gs', 'NeonBackup.gs'] });
const RealDate = Date;

let now = null;          // the fixed "current time" while a run executes
let files = {};          // name -> { content, updated }
let inbound = [];        // inbound_calls call_date ISO strings, one row each

function fileObj(name) {
  return {
    getName: function () { return name; },
    getLastUpdated: function () { return new RealDate(files[name].updated); },
    setContent: function (c) { files[name] = { content: c, updated: now }; },
    setTrashed: function () { delete files[name]; },
    getBlob: function () { return { getDataAsString: function () { return files[name].content; } }; },
  };
}
const folder = {
  getId: function () { return 'F'; },
  getFilesByName: function (n) {
    let used = false;
    return {
      hasNext: function () { return !used && (n in files); },
      next: function () { used = true; return fileObj(n); },
    };
  },
  createFile: function (n, c) { files[n] = { content: c, updated: now }; },
  getFiles: function () {
    const ks = Object.keys(files); let i = 0;
    return { hasNext: function () { return i < ks.length; }, next: function () { return fileObj(ks[i++]); } };
  },
};

function mkConn() {
  return {
    prepareStatement: function (sql) {
      const params = [];
      return {
        setString: function (i, v) { params[i - 1] = v; },
        executeQuery: function () {
          let j = '';
          if (/MIN\(call_date\).*FROM inbound_calls/.test(sql)) {
            j = inbound.length ? inbound.slice().sort()[0].slice(0, 7) : null;
          } else if (/MIN\(/.test(sql)) {
            j = null;                                       // other tables empty
          } else if (/FROM inbound_calls WHERE call_date >= \?/.test(sql)) {
            j = inbound.filter(function (d) { return d >= params[0] && d < params[1]; }).sort()
              .map(function (d) { return JSON.stringify({ call_date: d }); }).join('\n');
          } else if (/FROM inbound_calls WHERE call_date > \?/.test(sql)) {
            j = inbound.filter(function (d) { return d > params[0] && d < params[1]; }).sort()
              .map(function (d) { return JSON.stringify({ call_date: d }); }).join('\n');
          }
          let served = false;
          return {
            next: function () { if (served) return false; served = true; return true; },
            getString: function () { return j; },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function install() {
  files = {}; inbound = [];
  h.state.props = { NEON_BACKUP_FOLDER_ID: 'F' };
  h.ctx.DriveApp = { getFolderById: function () { return folder; }, createFolder: function () { return folder; } };
  h.ctx.getDashboardNeonConn_ = mkConn;
  h.ctx.getConfigSource_ = function () { return 'sheet'; };
}

// Run the real backup "at" 06:00 Central on `iso` (the Saturday trigger hour).
function runAt(iso) {
  now = new RealDate(iso + 'T11:00:00Z').getTime();
  const fixed = now;
  class FakeDate extends RealDate {
    constructor() { if (arguments.length) super(...arguments); else super(fixed); }
    static now() { return fixed; }
  }
  h.ctx.Date = FakeDate;
  try { h.call('runNeonBackup_'); } finally { h.ctx.Date = RealDate; }
  return h.state.props.NEON_BACKUP_LAST_RESULT;
}

function days(from, to) {
  const out = [];
  for (let d = new RealDate(from + 'T12:00:00Z'); d <= new RealDate(to + 'T12:00:00Z'); d = new RealDate(d.getTime() + 864e5)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function rowsIn(name) {
  if (!files[name]) return [];
  return files[name].content.split('\n').filter(Boolean).map(function (l) { return JSON.parse(l).call_date; });
}

// -- pure decision table -------------------------------------------------

test('ENG-1: nbClosedMonthAction_ decision table', function () {
  const o = { graceDays: 3, journeyDays: 90 };
  // No file yet -> fetch the whole month.
  assert.equal(h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: null }, '2026-10-03', o), 'write');
  // Written in-month (the old freeze point) -> not final, young -> rewrite.
  assert.equal(h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: '2026-09-26' }, '2026-10-03', o), 'rewrite');
  // Written after close but inside the grace window -> still rewrite.
  assert.equal(h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: '2026-10-03' }, '2026-10-10', o), 'rewrite');
  // Written on/after close + grace -> final.
  assert.equal(h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: '2026-10-04' }, '2026-10-10', o), 'skip');
  // Unreadable timestamp ('') is treated as NOT final, never as absent.
  assert.equal(h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: '' }, '2026-10-10', o), 'rewrite');
  // Old non-final month (journeys may be pruned) -> lossless tail, never a rewrite.
  assert.equal(h.call('nbClosedMonthAction_', '2026-03', { lastUpdatedIso: '2026-03-28' }, '2026-09-26', o), 'tail');
  assert.equal(h.call('nbClosedMonthAction_', '2026-03',
    { lastUpdatedIso: '2026-03-28', tailUpdatedIso: '2026-09-26' }, '2026-10-03', o), 'skip');
  // Unknown journey horizon fails toward the lossless tail.
  assert.equal(h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: '2026-09-26' }, '2026-10-03', { graceDays: 3 }), 'tail');
  // A month that STARTED inside the journey horizon's 2-day slack is not young.
  assert.equal(h.call('nbClosedMonthAction_', '2026-07', { lastUpdatedIso: '2026-07-25' }, '2026-09-28', o), 'tail');
  assert.equal(h.call('nbClosedMonthAction_', '2026-07', { lastUpdatedIso: '2026-07-25' }, '2026-09-27', o), 'rewrite');
});

test('ENG-1: nbAddDaysIso_ crosses month/year boundaries', function () {
  assert.equal(h.call('nbAddDaysIso_', '2026-10-01', 3), '2026-10-04');
  assert.equal(h.call('nbAddDaysIso_', '2026-12-30', 3), '2027-01-02');
  assert.equal(h.call('nbAddDaysIso_', '2026-03-01', -1), '2026-02-28');
});

// -- the real run across a month boundary --------------------------------

test('ENG-1: the month after the last in-month Saturday is backed up (was: frozen at 09-26)', function () {
  install();
  inbound = days('2026-09-01', '2026-09-25');          // Sat 09-26 06:00: through Fri's ingest
  runAt('2026-09-26');
  assert.deepEqual(rowsIn('inbound_calls-2026-09.jsonl'), days('2026-09-01', '2026-09-25'));

  inbound = days('2026-09-01', '2026-10-02');          // the tail days + 09-30's 10-01 ingest
  const r1 = runAt('2026-10-03');
  assert.match(r1, /^ok /);
  assert.deepEqual(rowsIn('inbound_calls-2026-09.jsonl'), days('2026-09-01', '2026-09-30'),
    'the first run after close rewrites the closed month in full');

  // A late re-import lands a row for 09-30 after the first post-close run.
  inbound = days('2026-09-01', '2026-10-09').concat(['2026-09-30']);
  runAt('2026-10-10');                                  // 10-03 < 10-04 finalOn -> rewrite once more
  assert.equal(rowsIn('inbound_calls-2026-09.jsonl').filter(function (d) { return d === '2026-09-30'; }).length, 2,
    'the grace window picks up a late re-import');

  inbound.push('2026-09-15');                           // after FINAL, the month is frozen
  const r3 = runAt('2026-10-17');
  assert.match(r3, /inbound_calls ok \(1 month file\(s\) written, 1 closed skipped\)/);
  assert.equal(rowsIn('inbound_calls-2026-09.jsonl').length, 31, 'final month is not rewritten');
});

test('ENG-1: a pre-fix legacy month too old to rewrite gets a tail file, then is final', function () {
  install();
  // March was frozen at its last in-month Saturday (03-28) by the old rule.
  files['inbound_calls-2026-03.jsonl'] = {
    content: days('2026-03-01', '2026-03-27').map(function (d) { return JSON.stringify({ call_date: d }); }).join('\n'),
    updated: new RealDate('2026-03-28T11:00:00Z').getTime(),
  };
  inbound = days('2026-03-01', '2026-09-25');
  const r = runAt('2026-09-26');
  assert.match(r, /closed-month tail\(s\) written/);
  assert.deepEqual(rowsIn('inbound_calls-2026-03.tail.jsonl'), days('2026-03-28', '2026-03-31'),
    'tail = exactly the rows after the frozen file, nothing duplicated');
  assert.equal(rowsIn('inbound_calls-2026-03.jsonl').length, 27, 'the journey-bearing file is never overwritten');

  const before = files['inbound_calls-2026-03.tail.jsonl'].updated;
  runAt('2026-10-03');
  assert.equal(files['inbound_calls-2026-03.tail.jsonl'].updated, before, 'a final tail is not refetched');
});

test('ENG-1: an unreadable last row fails the table loudly instead of guessing a cut-off', function () {
  install();
  files['inbound_calls-2026-03.jsonl'] = { content: 'not json', updated: new RealDate('2026-03-28T11:00:00Z').getTime() };
  inbound = days('2026-03-01', '2026-09-25');
  const r = runAt('2026-09-26');
  assert.match(r, /^FAILED /);
  assert.match(r, /inbound_calls FAILED: tail for 2026-03/);
  assert.ok(!files['inbound_calls-2026-03.tail.jsonl']);
});

test('ENG-1: a full rewrite trashes a stale tail so a restore never duplicates rows', function () {
  install();
  files['inbound_calls-2026-09.jsonl'] = {
    content: JSON.stringify({ call_date: '2026-09-01' }), updated: new RealDate('2026-09-26T11:00:00Z').getTime(),
  };
  files['inbound_calls-2026-09.tail.jsonl'] = { content: '', updated: new RealDate('2026-09-26T11:00:00Z').getTime() };
  inbound = days('2026-09-01', '2026-10-02');
  runAt('2026-10-03');
  assert.ok(!files['inbound_calls-2026-09.tail.jsonl']);
  assert.equal(rowsIn('inbound_calls-2026-09.jsonl').length, 30);
});
