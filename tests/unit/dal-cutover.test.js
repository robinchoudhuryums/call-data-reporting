'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// F1 DAL cutover ACCURACY tests: the Missed Calls report and the
// active-agents picker subset must produce IDENTICAL payloads whether
// they read the DQE sheet (legacy path, the default) or dqe_history
// via neonFetchDqeRows_ (DQE_READ_SOURCE=neon). A fake JDBC connection
// serves json_agg payloads built from the SAME logical rows the sheet
// fixture holds -- including honoring the bound date params, so the
// Neon path's pre-filtering is exercised rather than bypassed.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs',
          'MissedCallsReport.gs'],
});

const ROSTER = rosterGrid({
  Alpha: ['Anna, 501', 'Ben, 502'],
  Beta:  ['Cara, 601'],
});

// One logical dataset, defined once, projected into BOTH sources.
// Slot strings live in sheet cols K..AC; in Neon they're the slot_*
// text columns in the same K..AC order.
const SLOT_COLS = [
  'slot_0800_0830', 'slot_0830_0900', 'slot_0900_0930', 'slot_0930_1000',
  'slot_1000_1030', 'slot_1030_1100', 'slot_1100_1130', 'slot_1130_1200',
  'slot_1200_1230', 'slot_1230_1300', 'slot_1300_1330', 'slot_1330_1400',
  'slot_1400_1430', 'slot_1430_1500', 'slot_1500_1530', 'slot_1530_1600',
  'slot_1600_1630', 'slot_1630_1700', 'slot_1700_1730',
];
const DATASET = [
  // Anna: two missed rings on 03-10, one of them abandoned (parent P1).
  { date: '2026-03-10', agent: 'Anna', ext: '501', rung: 6, missed: 2, answered: 4,
    ttt: '0:12:00', att: '0:03:00',
    slots: ['', '', '9:05:11 AM', '', '', '', '11:40:02 AM'],
    abdIds: 'P1', abdTimes: '11:40:02 AM' },
  // Ben: activity but no missed slots.
  { date: '2026-03-10', agent: 'Ben', ext: '502', rung: 3, missed: 0, answered: 3,
    ttt: '0:09:00', att: '0:03:00' },
  // Queue sentinel: a no-ring abandon on Alpha's shared queue ext.
  { date: '2026-03-11', agent: 'A_Q_Alpha', ext: '501', rung: 0, missed: 0, answered: 0,
    slots: ['10:15:00 AM'], abdIds: 'P2', abdTimes: '10:15:00 AM' },
  // Out-of-window row: must be excluded by BOTH sources.
  { date: '2026-02-01', agent: 'Anna', ext: '501', rung: 9, missed: 3, answered: 5,
    slots: ['8:01:00 AM'] },
];

function neonRowsFor(fromIso, toIso) {
  return DATASET
    .filter(function (r) { return r.date >= fromIso && r.date <= toIso; })
    .map(function (r) {
      const row = {
        month_year: '', d: r.date, agent_name: r.agent, queue_extensions: r.ext || '',
        total_unique: 0, total_rung: r.rung || 0, total_missed: r.missed || 0,
        total_answered: r.answered || 0, ttt: r.ttt || '', att: r.att || '',
        avg_abd_wait: '', csr_avg_abd_wait: '',
        abandoned_parent_ids: r.abdIds || '', abandoned_missed_times: r.abdTimes || '',
      };
      SLOT_COLS.forEach(function (c, i) { row[c] = (r.slots && r.slots[i]) || ''; });
      return row;
    });
}

// Fake JDBC surface: answers the two SQL shapes the DAL issues --
// the windowed dqe_history fetch (prepared, two date params) and the
// DISTINCT agent/ext pairs query (plain statement).
function fakeNeonConn() {
  const rsFor = function (json) {
    let consumed = false;
    return {
      next: function () { if (consumed) return false; consumed = true; return true; },
      getString: function () { return json; },
      close: function () {},
    };
  };
  return {
    prepareStatement: function (sql) {
      const params = {};
      return {
        setString: function (i, v) { params[i] = v; },
        executeQuery: function () {
          if (sql.indexOf('FROM dqe_history WHERE call_date BETWEEN') !== -1) {
            return rsFor(JSON.stringify(neonRowsFor(params[1], params[2])));
          }
          throw new Error('Unexpected prepared SQL: ' + sql);
        },
        close: function () {},
      };
    },
    createStatement: function () {
      return {
        executeQuery: function (sql) {
          if (sql.indexOf('SELECT DISTINCT agent_name, queue_extensions') !== -1) {
            const pairs = DATASET.map(function (r) {
              return { agent_name: r.agent, queue_extensions: r.ext || '' };
            });
            return rsFor(JSON.stringify(pairs));
          }
          throw new Error('Unexpected SQL: ' + sql);
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function install(source) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  if (source === 'neon') h.state.props.DQE_READ_SOURCE = 'neon';
  else delete h.state.props.DQE_READ_SOURCE;
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(DATASET.map(dqeRow)) },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = (source === 'neon')
    ? fakeNeonConn
    : function () { return null; };
}

/** Strips run-volatile fields so payload comparison is value-only. */
function scrub(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone.meta) { delete clone.meta.generatedAt; delete clone.meta.computeMs; delete clone.meta.cacheHit; }
  return clone;
}

test('DAL accuracy: Missed Calls payload is identical from sheet and Neon', function () {
  install('sheet');
  const fromSheet = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both'));

  install('neon');
  const fromNeon = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both'));

  assert.equal(JSON.stringify(fromNeon), JSON.stringify(fromSheet),
    'every field -- chart buckets, per-agent timestamps, abandoned flags/parents, queue-only section -- matches');
  // Sanity: the payload is non-trivial (the parity isn't two empties).
  assert.ok(fromSheet.meta.totalMissed >= 2, 'fixture produced missed rings');
  assert.ok((fromSheet.queueOnly || []).length === 1, 'sentinel row produced a queue-only section');
  assert.equal(fromSheet.agents[0].missedTimes.filter(function (t) { return t.abandoned; }).length, 1,
    'abandoned cross-reference held');
});

test('DAL accuracy: active-agents picker is identical from sheet and Neon', function () {
  const roster = { names: ['Anna', 'Ben'] };
  install('sheet');
  const fromSheet = h.call('computeActiveAgentsInRange_', 'Alpha', '2026-03-09', '2026-03-15', roster);

  install('neon');
  const fromNeon = h.call('computeActiveAgentsInRange_', 'Alpha', '2026-03-09', '2026-03-15', roster);

  assert.equal(JSON.stringify(fromNeon), JSON.stringify(fromSheet));
  assert.equal(fromSheet.agents.join(','), 'Anna,Ben', 'both active roster agents found');
});

test('DAL accuracy: window edges respected by both sources (Feb row excluded)', function () {
  install('sheet');
  const sheetWide = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-02-01', '2026-03-15', 'both'));
  install('neon');
  const neonWide = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-02-01', '2026-03-15', 'both'));
  assert.equal(JSON.stringify(neonWide), JSON.stringify(sheetWide));
  // The widened window now includes the Feb ring on both sides.
  install('sheet');
  const narrow = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both'));
  assert.ok(sheetWide.meta.totalMissed > narrow.meta.totalMissed, 'window widening adds the Feb ring');
});

test('DAL fallback: neon flag with no connection serves the sheet result', function () {
  install('neon');
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // Neon down
  const fallback = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both'));

  install('sheet');
  const sheet = scrub(h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'both'));
  assert.equal(JSON.stringify(fallback), JSON.stringify(sheet), 'graceful fallback, no throw');

  // Picker fallback too.
  install('neon');
  h.ctx.getDashboardNeonConn_ = function () { throw new Error('boom'); };
  const roster = { names: ['Anna', 'Ben'] };
  const pickerFallback = h.call('computeActiveAgentsInRange_', 'Alpha', '2026-03-09', '2026-03-15', roster);
  assert.equal(pickerFallback.agents.join(','), 'Anna,Ben');
});

test('DAL shape guard: default neonFetchDqeRows_ payload carries NO missed-detail keys', function () {
  install('neon');
  const rows = h.call('neonFetchDqeRows_', '2026-03-09', '2026-03-15');
  assert.ok(rows.length > 0);
  assert.ok(!('slots' in rows[0]), 'opt-out callers keep the pre-cutover row shape');
  const detail = h.call('neonFetchDqeRows_', '2026-03-09', '2026-03-15', { includeMissedDetail: true });
  assert.equal(detail[0].slots.length, 19);
});
