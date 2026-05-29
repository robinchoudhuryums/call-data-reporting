'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// computeSummary_ pulls in roster reads (Auth.gs getAllDepartments_),
// the Dept Config accessors (DeptConfig.gs over CompanyOverview/Config),
// queuesForDept_ (QCDReport.gs), and the rest of Data.gs.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs'],
});

// Roster: Alpha = Anna/Ben; Beta = Cara (so Cara is a floater into
// Alpha when she rings Alpha's queue ext). Both Alpha agents carry
// ext 501 in their DQE rows, which is what makes 501 Alpha's
// data-derived queue ext set (getDeptQueueExts_ 'derived' path).
const ROSTER = rosterGrid({
  Alpha: ['Anna, 201', 'Ben, 202'],
  Beta:  ['Cara, 301'],
});

function install(rows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'DO NOT EDIT!': ROSTER,
      'DQE Historical Data': dqeSheet(rows),
      // No 'QCD Historical Data' + Alpha unmapped in DEPT_QCD_QUEUES
      // => computeDeptQcdSnapshot_ returns null (qcd: null).
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;     // reset per-execution memo
  h.state.cache.clear();
}

function rowFor(data, agent) {
  return data.rows.filter(function (r) { return r.agent === agent; })[0];
}

test('INV-02: duration columns are read from DISPLAY values, not getValue()', function () {
  // Single in-window day for Anna with the Sonia S7 spot-check values.
  const r = dqeRow({
    date: '2026-03-09', agent: 'Anna', ext: '501',
    unique: 5, rung: 10, missed: 2, answered: 8,
    ttt: '0:15:03', att: '0:03:01',
  });
  // Poke a deliberately-wrong VALUE into the TTT cell (mimicking the
  // TZ-shifted Date getValue() returns in prod). If computeSummary_
  // ever read the value instead of the display, this would corrupt TTT.
  r.vals[8] = new Date(0);
  install([r]);

  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');
  const anna = rowFor(data, 'Anna');
  assert.equal(anna.tttSeconds, 903);    // 0:15:03
  assert.equal(anna.attSeconds, 181);    // 0:03:01
});

test('INV-05: per-agent ATT is the simple mean of per-row ATT (not weighted)', function () {
  // Two in-window days; ATT 0:03:00 (180) and 0:05:00 (300).
  // Simple mean = 240; an answered-weighted mean would be
  // (180*2 + 300*18)/20 = 288, so this distinguishes the two.
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 4, answered: 2, att: '0:03:00', ttt: '0:06:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 20, answered: 18, att: '0:05:00', ttt: '1:30:00' }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both');
  const anna = rowFor(data, 'Anna');
  assert.equal(anna.attSeconds, 240);           // simple mean, NOT 288
  assert.equal(anna.totalAnswered, 20);         // answered still sums
  assert.equal(anna.totalRung, 24);
  assert.equal(anna.daysActive, 2);
});

test('INV-23: queue-sentinel rows are skipped (A_Q_*, Backup CSR)', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 5, answered: 5 }),
    dqeRow({ date: '2026-03-09', agent: 'A_Q_Alpha', ext: '501', rung: 99, missed: 99 }),
    dqeRow({ date: '2026-03-09', agent: 'Backup CSR', ext: '501', rung: 99, missed: 99 }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');
  const names = data.rows.map(function (r) { return r.agent; });
  assert.ok(names.indexOf('A_Q_Alpha') === -1, 'A_Q_ sentinel must not appear');
  assert.ok(names.indexOf('Backup CSR') === -1, 'Backup CSR sentinel must not appear');
  assert.ok(names.indexOf('Anna') !== -1);
});

test('INV-04: agent-name match is exact (case-sensitive); no fuzzy match', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 5, answered: 5 }),
    // lowercase "anna" with a non-overlapping ext -> neither roster nor
    // queue match -> excluded entirely.
    dqeRow({ date: '2026-03-09', agent: 'anna', ext: '999', rung: 7, answered: 7 }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');
  const names = data.rows.map(function (r) { return r.agent; });
  assert.ok(names.indexOf('Anna') !== -1);
  assert.ok(names.indexOf('anna') === -1, 'lowercase variant must not match the roster');
});

test('INV-53: queue-only floaters appear as rows but are excluded from totals', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', unique: 5, rung: 10, missed: 1, answered: 9, att: '0:03:00' }),
    dqeRow({ date: '2026-03-09', agent: 'Ben',  ext: '501', unique: 3, rung: 6,  missed: 2, answered: 4, att: '0:04:00' }),
    // Cara: on Beta roster, not Alpha; shares ext 501 -> floater into Alpha.
    dqeRow({ date: '2026-03-09', agent: 'Cara', ext: '501', unique: 2, rung: 100, missed: 50, answered: 50, att: '0:09:00' }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');

  const cara = rowFor(data, 'Cara');
  assert.equal(cara.matchedViaRoster, false);
  assert.equal(cara.matchedViaQueue, true);
  deepEqual(cara.sourceHomes, ['Beta']);   // her real roster home

  // Totals sum ONLY Anna + Ben (roster), excluding Cara's big numbers.
  assert.equal(data.totals.totalRung, 16);        // 10 + 6, NOT 116
  assert.equal(data.totals.totalAnswered, 13);    // 9 + 4, NOT 63
  assert.equal(data.totals.totalMissed, 3);
  assert.equal(data.totals.rosterAgentCount, 2);
  assert.equal(data.totals.queueOnlyAgentCount, 1);
  // totals ATT = simple mean of roster rows' ATT (180, 240) = 210.
  assert.equal(data.totals.attSeconds, 210);
});

test('S35 parity: roster scope totals == both scope totals (floater-exclusion invariant)', function () {
  const rows = [
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 10, answered: 9, att: '0:03:00' }),
    dqeRow({ date: '2026-03-09', agent: 'Cara', ext: '501', rung: 100, answered: 50, att: '0:09:00' }),
  ];
  install(rows);
  const both = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');
  install(rows);
  const roster = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'roster');

  // Both-scope shows Cara as a row; roster-scope omits her.
  assert.equal(both.rows.length, 2);
  assert.equal(roster.rows.length, 1);
  // ...but the totals are identical to the digit (totals filter to roster).
  assert.equal(both.totals.totalRung, roster.totals.totalRung);
  assert.equal(both.totals.totalAnswered, roster.totals.totalAnswered);
  assert.equal(both.totals.attSeconds, roster.totals.attSeconds);
});

test('E5/INV-30 v8: per-row prior-period deltas + meta.priorFrom/priorTo', function () {
  // User window: single day 2026-03-09. Prior window = 2026-03-08.
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 10, missed: 2, answered: 8 }),
    dqeRow({ date: '2026-03-08', agent: 'Anna', ext: '501', rung: 6,  missed: 1, answered: 5 }), // prior
    // Dan only has prior-window activity -> must be silently dropped.
    dqeRow({ date: '2026-03-08', agent: 'Ben',  ext: '501', rung: 4,  missed: 0, answered: 4 }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');

  assert.equal(data.meta.priorFrom, '2026-03-08');
  assert.equal(data.meta.priorTo, '2026-03-08');

  const anna = rowFor(data, 'Anna');
  assert.equal(anna.priorHasData, true);
  assert.equal(anna.priorRung, 6);
  assert.equal(anna.priorMissed, 1);
  assert.equal(anna.priorAnswered, 5);
  assert.equal(anna.totalRung, 10);   // user-window value unaffected by prior

  // Ben had ONLY prior-window rows -> no card.
  assert.equal(rowFor(data, 'Ben'), undefined);
});

test('meta + diagnostics: roster size, no-data list, queue-only matched', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 5, answered: 5 }),
    dqeRow({ date: '2026-03-09', agent: 'Cara', ext: '501', rung: 3, answered: 3 }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-09', 'both');
  assert.equal(data.meta.rosterSize, 2);          // Anna, Ben
  assert.equal(data.meta.department, 'Alpha');
  assert.equal(data.meta.scope, 'both');
  deepEqual(data.diagnostics.rosterWithNoData, ['Ben']); // Ben had no rows
  deepEqual(data.diagnostics.queueOnlyMatched, ['Cara']);
  assert.equal(data.qcd, null);                   // Alpha unmapped in QCD
});
