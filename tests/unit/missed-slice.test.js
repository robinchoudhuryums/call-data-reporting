'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert');   // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// Phase 1 of the chart->Missed drill-down (docs/insights-drilldown-spec.md):
// getMissedCallsSlice returns the SAME per-call Missed detail
// computeMissedCallsReport_ produces, narrowed to a weekday (isoDow) + CST hour
// window (+ optional agent/queue). It's the "DQE missed-ring lens" the heatmap
// cell drill + Queue-health hand-off surface as a SEPARATE labeled lens.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs',
          'MissedCallsReport.gs'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 501', 'Ben, 502'] });

// Same in-source formula the slice uses (Mon=1 .. Sun=7), so the test never
// hard-codes an absolute weekday -- it derives it from the same date.
function isoDow(iso) {
  const p = iso.split('-');
  const wd = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  return wd === 0 ? 7 : wd;
}

function install(dataset) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  delete h.state.props.DQE_READ_SOURCE;
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(dataset.map(dqeRow)) },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = function () { return null; };
}

// 2026-03-09 (M) and 2026-03-16 (M, +7d) share a weekday; 2026-03-10 (Tu) is a
// different weekday -- so weekday-filter assertions hold regardless of the
// absolute dow value.
function dataset() {
  return [
    // Anna, Monday: one ring at 10:15 (in the 10:00-10:30 slot) and one at
    // 11:45 (out of that slot) -- one DQE row per (agent, date).
    { date: '2026-03-09', agent: 'Anna', ext: '501', rung: 5, missed: 2, answered: 3,
      slots: ['', '', '', '10:15:00 AM', '', '11:45:00 AM'] },
    // Anna, the following Monday: a ring at 10:20 (same slot, same weekday).
    { date: '2026-03-16', agent: 'Anna', ext: '501', rung: 3, missed: 1, answered: 2,
      slots: ['', '', '', '10:20:00 AM'] },
    // Ben, Tuesday: a ring at 10:15 (same time-of-day, different weekday).
    { date: '2026-03-10', agent: 'Ben', ext: '502', rung: 2, missed: 1, answered: 1,
      slots: ['', '', '', '10:15:00 AM'] },
  ];
}

const RANGE = { department: 'Alpha', from: '2026-03-01', to: '2026-03-31' };
const MON = isoDow('2026-03-09');

test('slice: weekday + CST hour window keeps only the matching entries', function () {
  install(dataset());
  const r = h.call('getMissedCallsSlice',
    Object.assign({}, RANGE, { isoDow: MON, hourStart: '10:00', hourEnd: '10:30' }));
  // Monday 10:15 (Anna 03-09) + Monday 10:20 (Anna 03-16). The Monday 11:45 is
  // out of the window; the Tuesday 10:15 (Ben) is the wrong weekday.
  assert.equal(r.entries.length, 2);
  assert.equal(r.meta.matchedCount, 2);
  assert.equal(r.entries[0].date, '2026-03-09');   // chronological
  assert.equal(r.entries[0].who, 'Anna');
  assert.equal(r.entries[1].date, '2026-03-16');
  assert.equal(r.meta.lens, 'dqe-missed');
  assert.equal(r.meta.source, 'dqe');
  assert.equal(r.meta.filter.isoDow, MON);
  assert.equal(r.meta.filter.hourStart, '10:00');
});

test('slice: weekday only keeps every Monday entry (no hour window)', function () {
  install(dataset());
  const r = h.call('getMissedCallsSlice', Object.assign({}, RANGE, { isoDow: MON }));
  // Anna 03-09 10:15, Anna 03-09 11:45, Anna 03-16 10:20 -- all Mondays. Ben
  // (Tuesday) excluded.
  assert.equal(r.entries.length, 3);
  assert.ok(r.entries.every(function (e) { return e.who === 'Anna'; }));
});

test('slice: hour window only crosses weekdays (Tuesday 10:15 included)', function () {
  install(dataset());
  const r = h.call('getMissedCallsSlice',
    Object.assign({}, RANGE, { hourStart: '10:00', hourEnd: '10:30' }));
  // Anna 03-09 10:15, Ben 03-10 10:15, Anna 03-16 10:20 -- the 11:45 is out.
  assert.equal(r.entries.length, 3);
  const whos = r.entries.map(function (e) { return e.who; }).sort();
  deepEqual(whos, ['Anna', 'Anna', 'Ben']);
});

test('slice: agent filter matches only that agent', function () {
  install(dataset());
  const r = h.call('getMissedCallsSlice', Object.assign({}, RANGE, { agent: 'Ben' }));
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].who, 'Ben');
  assert.equal(r.entries[0].date, '2026-03-10');
});

test('slice: an empty filter returns every missed ring in range', function () {
  install(dataset());
  const r = h.call('getMissedCallsSlice', RANGE);
  assert.equal(r.entries.length, 4);   // 2 Anna(03-09) + 1 Anna(03-16) + 1 Ben(03-10)
});

test('slice validation: bad isoDow / half-open window / missing dept throw', function () {
  install(dataset());
  assert.throws(function () {
    h.call('getMissedCallsSlice', Object.assign({}, RANGE, { isoDow: 9 }));
  }, /isoDow must be 1-7/);
  assert.throws(function () {
    h.call('getMissedCallsSlice', Object.assign({}, RANGE, { hourStart: '10:00' }));
  }, /must be given together/);
  assert.throws(function () {
    h.call('getMissedCallsSlice', Object.assign({}, RANGE, { hourStart: '11:00', hourEnd: '10:00' }));
  }, /hourStart must be before hourEnd/);
  assert.throws(function () {
    h.call('getMissedCallsSlice', { from: '2026-03-01', to: '2026-03-31' });
  }, /Department is required/);
});

test('slice: pure filter helper flattens agents + queue-only entries', function () {
  install(dataset());
  // Build a payload directly and exercise the pure filter (no auth/compute).
  const report = {
    agents: [{ name: 'Anna', missedTimes: [
      { date: '2026-03-09', time: '10:15', label: '10:15 AM', abandoned: true,  parentId: 'P1', sortKey: 36900, bucket: 4 },
      { date: '2026-03-09', time: '11:45', label: '11:45 AM', abandoned: false, parentId: null, sortKey: 42300, bucket: 7 },
    ] }],
    queueOnly: [{ queue: 'A_Q_Alpha', entries: [
      { date: '2026-03-09', time: '10:05', label: '10:05 AM', abandoned: true, parentId: 'P2', sortKey: 36300, bucket: 4 },
    ] }],
  };
  const start = (10 * 60) * 60, end = (10 * 60 + 30) * 60;
  const out = h.call('missedSliceFilter_', report,
    { isoDow: MON, startSec: start, endSec: end });
  // Anna 10:15 (P1) + queue A_Q_Alpha 10:05 (P2) -- both Monday, both in slot.
  // The 11:45 is out of the window.
  assert.equal(out.entries.length, 2);
  assert.equal(out.abandonedCount, 2);
  assert.equal(out.entries[0].source, 'queue');   // 10:05 sorts before 10:15
  assert.equal(out.entries[0].who, 'A_Q_Alpha');
  assert.equal(out.entries[1].source, 'agent');
  assert.equal(out.entries[1].parentId, 'P1');
});
