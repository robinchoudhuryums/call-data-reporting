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

// R24 egress: the DAL fetch ships POSITIONAL json_build_array rows (base
// cols 0..12, queue_split fixed at slot 12, detail cols 13..33 when the SQL
// selects them) -- this fixture mirrors that protocol, keyed off the SQL the
// reader actually issued, so a position drift between SQL and parse loop
// fails HERE.
function neonRowsFor(fromIso, toIso, sql) {
  const withDetail = String(sql || '').indexOf('slot_0800_0830') !== -1;
  return DATASET
    .filter(function (r) { return r.date >= fromIso && r.date <= toIso; })
    .map(function (r) {
      const row = ['', r.date, r.agent, r.ext || '',
        0, r.rung || 0, r.missed || 0, r.answered || 0,
        r.ttt || '', r.att || '', '', '',
        '' /* queue_split (none in this dataset; '' when skipped, slot fixed) */];
      if (withDetail) {
        SLOT_COLS.forEach(function (c, i) { row.push((r.slots && r.slots[i]) || ''); });
        row.push(r.abdIds || '', r.abdTimes || '');
      }
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
            return rsFor(JSON.stringify(neonRowsFor(params[1], params[2], sql)));
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
  h.ctx.DQE_DATE_BOUNDS_MEMO_ = null;   // F9: shared date-column bounds scan
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = (source === 'neon')
    ? fakeNeonConn
    : function () { return null; };
  // R6: sentinels attribute by queue NAME against the dept's effective list.
  h.ctx.queuesForDept_ = function (d) { return d === 'Alpha' ? ['A_Q_Alpha'] : []; };
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

test('CORE-2 (F-35): active-agents picker serves from Neon when the DQE sheet is GONE', function () {
  // The sheet-retirement end state: reads on neon, sheet trimmed/archived.
  // The old early-returns sat above the Neon branch, so the IR/Insights
  // pickers rendered zero active agents while the report bodies computed
  // fine from dqe_history.
  install('neon');
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER },   // no 'DQE Historical Data'
  });
  const res = h.call('computeActiveAgentsInRange_', 'Alpha', '2026-03-09', '2026-03-15',
    { names: ['Anna', 'Ben'] });
  assert.ok(res.agents.indexOf('Anna') !== -1, 'Anna active from dqe_history despite no sheet');
  assert.ok(res.agents.indexOf('Ben') !== -1);

  // Neon down + no sheet -> clean empty shape, no crash.
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  h.state.cache.clear();
  const empty = h.call('computeActiveAgentsInRange_', 'Alpha', '2026-03-09', '2026-03-15',
    { names: ['Anna', 'Ben'] });
  assert.equal(empty.agents.length, 0);
  assert.equal(empty.floaters.length, 0);
});

test('LM2: neonDqeRowsUsable_ trusts reachable-empty, falls back only on unreachable', function () {
  const reachableEmpty = [];
  reachableEmpty._neonReachable = true;            // healthy read, genuinely-empty window
  assert.equal(h.call('neonDqeRowsUsable_', [{}]), true, 'has rows -> use neon');
  assert.equal(h.call('neonDqeRowsUsable_', reachableEmpty), true, 'reachable-empty -> use neon (skip the redundant sheet scan)');
  assert.equal(h.call('neonDqeRowsUsable_', []), false, 'plain [] (unreachable/errored) -> fall back to sheet');
  assert.equal(h.call('neonDqeRowsUsable_', null), false, 'null -> fall back');
});

// --- R8-C1/C2 (audit 2026-07-21): the outage + trimmed-sheet corner ----------

test('R8-C1: Neon unreachable + NO sheet -> outage-empty shape carries meta.sourceUnavailable', function () {
  install('neon');
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // outage
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER },   // DQE sheet trimmed/retired
  });
  const r = h.call('computeMissedCallsReport_', 'Alpha', '2026-03-09', '2026-03-15', 'roster');
  assert.equal(r.meta.sourceUnavailable, true,
    'outage empty is FLAGGED so callers skip the cache put');
  assert.equal(r.meta.totalMissed, 0);
});

test('R8-C1: Neon REACHABLE-empty + no sheet is a real (unflagged, cacheable) empty', function () {
  install('neon');   // fake conn serves the dataset; ask outside its dates
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER },
  });
  const r = h.call('computeMissedCallsReport_', 'Alpha', '2030-01-01', '2030-01-07', 'roster');
  assert.ok(!r.meta.sourceUnavailable, 'reachable-empty (LM2 trusted) is NOT flagged');
  assert.equal(r.meta.totalMissed, 0);
});

test('R8-C2: getLatestDataDate does NOT cache the negative sentinel after a failed neon read', function () {
  install('neon');
  h.ctx.neonGetMaxDqeDate_ = function () { return null; };   // neon errored/empty
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER },   // no DQE sheet to fall back to
  });
  h.state.cache.clear();
  const out = h.call('getLatestDataDate');
  assert.equal(out, null);
  let negativeCached = false;
  h.state.cache.forEach(function (v, k) {
    if (String(k).indexOf('latestDate:') === 0) negativeCached = true;
  });
  assert.equal(negativeCached, false,
    'no latestDate: entry pinned -- next request retries the recovered source');
  delete h.ctx.neonGetMaxDqeDate_;
});

test('R8-C2: the sheet source still caches its negative (empty install, no outage involved)', function () {
  install('sheet');
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER },   // no DQE sheet at all
  });
  h.state.cache.clear();
  assert.equal(h.call('getLatestDataDate'), null);
  let cachedNegative = 0;
  h.state.cache.forEach(function (v, k) {
    if (String(k).indexOf('latestDate:') === 0) cachedNegative++;
  });
  assert.equal(cachedNegative, 1, 'sheet-source empty install keeps the cheap negative cache');
});

// ---- F9: one shared DQE date-column scan for both bounds --------------------
// getLatestDataDate (MAX) and getLatestDataDates (MAX + MIN/dqeEarliest) each
// ran their own whole-column getValues(), so a cold cache read a multi-year
// column TWICE per 5-min expiry. sheetScanDqeDateBounds_ yields both from one
// scan, memoized per execution.

test('F9: sheetScanDqeDateBounds_ returns both bounds from ONE column read', function () {
  install('sheet');
  let reads = 0;
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const realGetRange = sheet.getRange.bind(sheet);
  sheet.getRange = function (r, c, nr, nc) { reads++; return realGetRange(r, c, nr, nc); };

  const b = h.call('sheetScanDqeDateBounds_');
  assert.ok(b.max, 'max resolved');
  assert.ok(b.min, 'min resolved');
  assert.ok(b.min <= b.max, 'min is not after max');
  assert.ok(b.rows > 0, 'row count reported');
  const afterFirst = reads;
  assert.equal(afterFirst, 1, 'exactly one range read');

  // Memoized: a second call adds no read.
  h.call('sheetScanDqeDateBounds_');
  assert.equal(reads, afterFirst, 'second call served from the per-execution memo');
  sheet.getRange = realGetRange;
});

test('F9: a COLD cache serves getLatestDataDate + getLatestDataDates from one scan', function () {
  install('sheet');
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  let dateColReads = 0;
  const realGetRange = sheet.getRange.bind(sheet);
  sheet.getRange = function (r, c, nr, nc) {
    // HISTORICAL_COLS.DATE === 2; count only whole-column date scans.
    if (c === 2 && nc === 1 && nr > 1) dateColReads++;
    return realGetRange(r, c, nr, nc);
  };
  const max = h.call('getLatestDataDate');
  const blob = h.call('getLatestDataDates');
  assert.ok(max, 'latest resolved');
  assert.equal(blob.dqe, max, 'the blob agrees with the single-source reader');
  assert.ok(blob.dqeEarliest, 'coverage start resolved (R12-26)');
  assert.ok(blob.dqeEarliest <= blob.dqe, 'earliest is not after latest');
  assert.equal(dateColReads, 1,
    'ONE date-column scan for both readers (was 2 before F9)');
  sheet.getRange = realGetRange;
});

test('F9: a missing DQE sheet yields empty bounds and still caches the negative', function () {
  install('sheet');
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago', sheets: { 'DO NOT EDIT!': ROSTER },
  });
  h.ctx.DQE_DATE_BOUNDS_MEMO_ = null;
  h.state.cache.clear();
  const b = h.call('sheetScanDqeDateBounds_');
  assert.equal(b.max, null);
  assert.equal(b.min, null);
  assert.equal(b.rows, 0);
  assert.equal(h.call('getLatestDataDate'), null, 'reader still returns null');
});

// ---- Batch 6: the DQE read-source gate must not pass on ZERO comparisons ----
// Symmetric to the QCD gate fix. Today the extraInNeon check happens to catch
// the sheet-empty case (every Neon row reads as "extra"), but that protection
// is incidental -- it would become a false CLEAN the moment the verdict stopped
// counting extras, which is exactly what the QCD gate did. Made explicit.

function dqeParityRun_() {
  const lines = [];
  const realLogger = h.ctx.Logger;
  h.ctx.Logger = { log: function () {
    let s = String(arguments[0]);
    for (let i = 1; i < arguments.length; i++) s = s.replace(/%s/, String(arguments[i]));
    lines.push(s);
  } };
  let out;
  try { out = h.call('compareDqeSources_'); } finally { h.ctx.Logger = realLogger; }
  return { log: lines.join('\n'), verdict: out };
}

test('Batch 6: DQE gate — ZERO sheet rows is INCONCLUSIVE, never a pass', function () {
  install('sheet');
  h.state.props.DQE_PARITY_FROM = '2030-01-01';
  h.state.props.DQE_PARITY_TO = '2030-01-07';
  h.ctx.sheetFetchDqeRows_ = function () { return []; };
  h.ctx.neonFetchDqeRows_ = function () { return []; };
  const r = dqeParityRun_();
  assert.doesNotMatch(r.log, /PARITY CLEAN/, 'never claims a pass with nothing compared');
  assert.equal(r.verdict.clean, false);
  assert.ok(r.verdict.error, 'carries a reason instead of returning undefined');
  delete h.ctx.sheetFetchDqeRows_; delete h.ctx.neonFetchDqeRows_;
});

test('Batch 6: DQE gate — a real matching range reports clean + the compared count', function () {
  install('sheet');
  h.state.props.DQE_PARITY_FROM = '2026-03-09';
  h.state.props.DQE_PARITY_TO = '2026-03-09';
  const row = { dateIso: '2026-03-09', agent: 'Sonia', totalUnique: 1, totalRung: 2,
                totalMissed: 0, totalAnswered: 2, tttSec: 903, attSec: 181,
                avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0, queueExt: '103',
                slots: new Array(19).fill(''), abandonedParentIds: '', abandonedMissedTimes: '' };
  h.ctx.sheetFetchDqeRows_ = function () { return [row]; };
  h.ctx.neonFetchDqeRows_ = function () { return [row]; };
  const r = dqeParityRun_();
  assert.match(r.log, /PARITY CLEAN/);
  assert.equal(r.verdict.clean, true);
  assert.equal(r.verdict.compared, 1, 'a pass is backed by a real compared count');
  delete h.ctx.sheetFetchDqeRows_; delete h.ctx.neonFetchDqeRows_;
});
