'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// RPT-1 / RPT-2 regression pins for computeMissedCallsReport_:
//  - RPT-1: rows whose K-AC slots are EMPTY but whose AD carries abandoned
//    parent ids (a legitimate F-2 output: unpairable parents are appended to
//    AD with no AE/AF partner; rings outside the 6:00-15:30 slot band emit
//    no slot timestamps) must still feed the dept-wide unique-abandoned
//    counts AND still trip the lost-detail flag when the cell is corrupted.
//  - RPT-2: the AF<->AD pairing is positional (F-2 lockstep). Two missed
//    legs in the same second must keep DISTINCT parent ids on their
//    abandoned entries -- not both render the last id.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs',
          'MissedCallsReport.gs'],
});

const ROSTER = rosterGrid({
  Alpha: ['Anna, 501', 'Ben, 502'],
});

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

test('RPT-1: abandoned parents on a ZERO-slot row still count (agent + sentinel)', function () {
  install([
    // Anna missed one ring at 9:05 (not abandoned). Same day, AD carries an
    // abandoned parent with NO pairable missed leg (empty AF) -- the F-2
    // append shape. Pre-fix the early-continue was fine for THIS row (it has
    // a slot), so put the unpaired parent on a slot-less row instead:
    { date: '2026-03-10', agent: 'Anna', ext: '501', rung: 6, missed: 1, answered: 5,
      slots: ['', '', '9:05:11 AM'] },
    // Ben: NO slot timestamps at all, but AD holds an abandoned parent
    // (unpairable-parent append / out-of-band ring). Pre-fix this row was
    // skipped before AD was read -- P9 vanished from the counts.
    { date: '2026-03-10', agent: 'Ben', ext: '502', rung: 2, missed: 0, answered: 2,
      abdIds: 'P9', abdTimes: '' },
    // Sentinel with a no-ring abandon and no slot timestamp: pre-fix its
    // parent never reached uniqueNoRingParents either.
    { date: '2026-03-10', agent: 'A_Q_Alpha', ext: '501', rung: 0, missed: 0, answered: 0,
      abdIds: 'P10', abdTimes: '' },
  ]);
  const r = h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both');
  assert.equal(r.meta.abandonedCallCount, 2, 'P9 + P10 counted despite empty K-AC');
  assert.equal(r.meta.noRingAbandonCount, 1, 'sentinel no-ring parent P10 counted');
  assert.equal(r.meta.queueOnlyUniqueCount, 0,
    'no queue-only RING EVENTS -- P10 has no slot timestamp, so no timeline entry');
  // The zero-slot rows still contribute NO timeline entries / chart rings.
  assert.equal(r.meta.totalMissed, 1, 'only Anna\'s real ring is a missed-ring event');
  assert.equal(r.meta.abandonedRings, 0, 'no abandoned RINGS -- counts came from AD only');
});

test('RPT-1: a corrupted AD cell on a zero-slot row still trips the lost-detail flag', function () {
  install([
    // Coerced multi-value AD cell (the documented Number-coercion shape) on
    // a row with NO slot timestamps. Pre-fix: skipped before classification,
    // so the "abandoned detail unavailable -- rebuild" note never rendered.
    { date: '2026-03-10', agent: 'Ben', ext: '502', rung: 2, missed: 0, answered: 2,
      abdIds: '17,622,419,789,481,700,000,000,000', abdTimes: '' },
  ]);
  const r = h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both');
  assert.equal(r.meta.abandonedDetailLost, true, 'lost AD detail flagged on a slot-less row');
  assert.equal(JSON.stringify(r.meta.abandonedDetailLostDates), JSON.stringify(['2026-03-10']));
  assert.equal(r.meta.abandonedCallCount, 0, 'a lost cell is never split into fake ids');
});

test('RPT-2: duplicate-second missed legs keep DISTINCT positionally-paired parent ids', function () {
  install([
    // Two missed legs in the SAME second on two different abandoned parents
    // (P1 then P2, chronological -- the F-2 write order), plus a third at a
    // different time (P3). The slot cell carries the duplicate second twice.
    { date: '2026-03-10', agent: 'Anna', ext: '501', rung: 6, missed: 3, answered: 3,
      slots: ['', '', '9:05:11 AM,9:05:11 AM', '', '9:40:00 AM'],
      abdIds: 'P1,P2,P3', abdTimes: '9:05:11 AM,9:05:11 AM,9:40:00 AM' },
  ]);
  const r = h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both');
  const anna = r.agents.filter(function (a) { return a.name === 'Anna'; })[0];
  assert.ok(anna, 'Anna has a timeline');
  const abandoned = anna.missedTimes.filter(function (e) { return e.abandoned; });
  assert.equal(abandoned.length, 3, 'all three rings are abandoned');
  const ids = abandoned.map(function (e) { return e.parentId; }).sort();
  assert.equal(ids.join(','), 'P1,P2,P3',
    'duplicate seconds carry DISTINCT parent ids (pre-fix: P2,P2,P3)');
  assert.equal(r.meta.abandonedRings, 3);
  assert.equal(r.meta.abandonedCallCount, 3);
});

test('RPT-2: an AF entry marks at most ONE ring at that second as abandoned', function () {
  install([
    // Two rings in the same second but only ONE abandoned event at that
    // time. Pre-fix both rings rendered as abandoned (key-set match);
    // now exactly one does, carrying the paired id.
    { date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, missed: 2, answered: 3,
      slots: ['', '', '9:05:11 AM,9:05:11 AM'],
      abdIds: 'P1', abdTimes: '9:05:11 AM' },
  ]);
  const r = h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both');
  const anna = r.agents.filter(function (a) { return a.name === 'Anna'; })[0];
  const abandoned = anna.missedTimes.filter(function (e) { return e.abandoned; });
  assert.equal(abandoned.length, 1, 'one AF entry -> one abandoned ring');
  assert.equal(abandoned[0].parentId, 'P1');
  assert.equal(anna.missedTimes.length, 2, 'the other ring still renders, un-flagged');
});
