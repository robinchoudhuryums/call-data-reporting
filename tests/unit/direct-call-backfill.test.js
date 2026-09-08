'use strict';

// Phase 3: backfillDirectCallToNeon (cdr-import) -- the deferred end-pass that
// mirrors the whole `Direct Call History` sheet to Neon direct_call_history
// with ON CONFLICT DO UPDATE, following the DQE skipNeon + backfill pattern.
// A fake JDBC conn captures the upsert SQL + binds so we can assert: it reads
// the sheet, binds call_date/month_year PER ROW (multi-date), issues the
// ON CONFLICT DO UPDATE, opens ONE connection, and survives empty/missing
// sheets. Also pins the shared dcUpsertRows_ SQL shape (the refactor guard).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'directCallMetrics.js'] });

const HEADERS = [
  'Month Year', 'Date', 'Department', 'Agent',
  'IB Int Answered', 'IB Int Missed (free)', 'IB Int Missed (busy)', 'IB Int Talk (s)',
  'IB Ext Answered', 'IB Ext Missed (free)', 'IB Ext Missed (busy)', 'IB Ext Talk (s)',
  'OB Int Total', 'OB Int Connected', 'OB Int Talk (s)',
  'OB Ext Total', 'OB Ext Connected', 'OB Ext Talk (s)',
];
// Two dates, three agent-day rows.
const SHEET_ROWS = [
  ['March 2026', '03/09/2026', 'CSR', 'Anna', 8, 1, 0, 480, 12, 2, 1, 720, 3, 2, 120, 4, 3, 200],
  ['March 2026', '03/09/2026', 'CSR', 'Bob',  4, 0, 0, 240, 6, 1, 0, 360, 2, 1, 60, 1, 1, 50],
  ['March 2026', '03/10/2026', 'CSR', 'Anna', 5, 1, 0, 300, 7, 0, 0, 420, 1, 1, 30, 2, 2, 90],
];

// Fake JDBC conn that records every statement -- the R39 inline-literal
// upserts (createStatement().execute(sql)) AND the bound ones (the DELETE,
// plus the oversize fallback) -- with binds and commits.
function fakeConn(capture) {
  let auto = true;
  function stmt(sql) {
    const binds = [];
    return {
      _sql: sql, _binds: binds,
      setString: function (i, v) { binds[i - 1] = v; },
      setInt: function (i, v) { binds[i - 1] = v; },
      execute: function () { capture.executed.push({ sql: sql, binds: binds.slice(), bound: true }); return true; },
      close: function () {},
    };
  }
  return {
    setAutoCommit: function (v) { auto = v; capture.autoCommit = v; },
    createStatement: function () {
      return {
        execute: function (sql) {
          if (/^CREATE TABLE/.test(sql)) { capture.ddl++; return true; }   // CREATE TABLE
          capture.executed.push({ sql: sql, binds: [], bound: false });
          return true;
        },
        close: function () {},
      };
    },
    prepareStatement: function (sql) { const s = stmt(sql); capture.prepared.push(s); return s; },
    commit: function () { capture.commits++; },
    rollback: function () { capture.rollbacks++; },
    close: function () { capture.closes++; },
  };
}

// Decode an inline upsert's VALUES list into rows of 18 JS values (dollar-
// quoted text -> string, bare numbers -> number, NULL -> null).
function tuplesOf(sql) {
  const vals = sql.slice(sql.indexOf(' VALUES ') + 8, sql.indexOf(' ON CONFLICT'));
  const re = /\$(nqx*)\$([\s\S]*?)\$\1\$|NULL|-?\d+(?:\.\d+)?/g;
  const toks = [];
  let m;
  while ((m = re.exec(vals)) !== null) {
    if (m[1] !== undefined) toks.push(m[2]);
    else if (m[0] === 'NULL') toks.push(null);
    else toks.push(Number(m[0]));
  }
  const rows = [];
  for (let i = 0; i < toks.length; i += 18) rows.push(toks.slice(i, i + 18));
  return rows;
}
// The bound path's binds, chunked per row, for the parity test.
function boundRowsOf(binds) {
  const rows = [];
  for (let i = 0; i < binds.length; i += 18) rows.push(binds.slice(i, i + 18));
  return rows;
}
const JDBC_SQL_CAP = 44000;

function install(sheetRows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  delete h.state.props.DIRECT_UPSERT_RESUME;
  delete h.state.props.DIRECT_UPSERT_SINCE;
  h.ctx.getTargetSsId_ = function () { return 'fake'; };   // openById -> the fake SS
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: sheetRows ? { 'Direct Call History': [HEADERS].concat(sheetRows) } : {},
  });
}

test('backfillDirectCallToNeon: one connection, per-row dates, ON CONFLICT upsert', function () {
  install(SHEET_ROWS);
  const cap = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  let opened = 0;
  h.ctx.getReachableNeonConn_ = function () { opened++; return fakeConn(cap); };

  const res = h.call('backfillDirectCallToNeon');
  assert.equal(res.upserted, 3);
  assert.equal(opened, 1, 'opens exactly one connection for the whole pass');
  assert.equal(cap.autoCommit, false, 'runs in an explicit transaction');
  assert.ok(cap.ddl >= 1, 'ensures the table');
  assert.equal(cap.executed.length, 1, 'one batched statement (< BATCH_SIZE rows)');
  assert.equal(cap.commits, 1);
  assert.equal(cap.closes, 1);

  const ex = cap.executed[0];
  assert.match(ex.sql, /INSERT INTO direct_call_history/);
  assert.match(ex.sql, /ON CONFLICT \(call_date, department, agent_name\) DO UPDATE SET/);
  assert.match(ex.sql, /updated_at = now\(\)/);
  assert.ok(!/call_date = EXCLUDED/.test(ex.sql), 'PK columns are not in the UPDATE set');

  // R39: inline literals, zero binds. 3 rows * 18 values. Row 0:
  // monthYear, isoDate, dept, agent, then the 14 metrics.
  assert.equal(ex.bound, false, 'the upsert is inline (R39), not a prepared statement');
  assert.equal(ex.binds.length, 0);
  const rows = tuplesOf(ex.sql);
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], 'March 2026');
  assert.equal(rows[0][1], '2026-03-09', 'call_date rendered per row (ISO from MM/DD/YYYY)');
  assert.equal(rows[0][2], 'CSR');
  assert.equal(rows[0][3], 'Anna');
  assert.deepEqual(rows[0].slice(4), [8, 1, 0, 480, 12, 2, 1, 720, 3, 2, 120, 4, 3, 200]);
  assert.equal(rows[2][1], '2026-03-10', 'multi-date: row 3 carries its own date');
});

test('DIRECT_UPSERT_SINCE date floor limits which rows upsert', function () {
  install(SHEET_ROWS);
  h.state.props.DIRECT_UPSERT_SINCE = '2026-03-10';
  const cap = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  const res = h.call('backfillDirectCallToNeon');
  assert.equal(res.upserted, 1, 'only the 03/10 row is on/after the floor');
  const rows = tuplesOf(cap.executed[0].sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], '2026-03-10');
});

test('missing sheet / unreachable Neon -> clean no-op', function () {
  install(null);   // no Direct Call History sheet
  h.ctx.getReachableNeonConn_ = function () { throw new Error('should not be called'); };
  assert.equal(h.call('backfillDirectCallToNeon').upserted, 0);

  install(SHEET_ROWS);
  h.ctx.getReachableNeonConn_ = function () { return null; };   // unreachable
  const res = h.call('backfillDirectCallToNeon');
  assert.equal(res.upserted, 0);
  assert.equal(res.unreachable, true);
});

test('dcUpsertRows_ + writeDirectCallRowsToNeon_ share the same single-date SQL', function () {
  // The daily writer routes through dcUpsertRows_; assert the single-date path
  // still emits one ON CONFLICT statement binding the shared (monthYear,isoDate)
  // across all rows (the refactor guard).
  const cap = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  const rows = [
    { agent: 'Anna', dept: 'CSR', ib_int_answered: 8, ib_int_missed_free: 1, ib_int_missed_busy: 0,
      ib_int_talk_sec: 480, ib_ext_answered: 12, ib_ext_missed_free: 2, ib_ext_missed_busy: 1,
      ib_ext_talk_sec: 720, ob_int_total: 3, ob_int_connected: 2, ob_int_talk_sec: 120,
      ob_ext_total: 4, ob_ext_connected: 3, ob_ext_talk_sec: 200 },
  ];
  const res = h.call('writeDirectCallRowsToNeon_', rows, 'March 2026', '2026-03-09');
  assert.equal(res.inserted, 1);
  // IMP-5: the daily single-date writer is AUTHORITATIVE -- it deletes the
  // date's rows in the same transaction before the upsert, so a force
  // re-import whose rebuilt day drops an agent removes the phantom Neon
  // row. (The multi-date backfill above stays upsert-only: its 50-row
  // batches can hold PARTIAL dates.)
  assert.equal(cap.executed.length, 2, 'DELETE + upsert');
  assert.match(cap.executed[0].sql, /DELETE FROM direct_call_history WHERE call_date = \?::date/);
  assert.equal(cap.executed[0].binds[0], '2026-03-09');
  assert.match(cap.executed[1].sql, /ON CONFLICT \(call_date, department, agent_name\) DO UPDATE SET/);
  assert.equal(tuplesOf(cap.executed[1].sql)[0][1], '2026-03-09');
  assert.equal(cap.commits, 1, 'delete + upsert commit atomically');
});

test('P-5: an EMPTY row set still clears the date in Neon (matches the sheet delete)', function () {
  const cap = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  const res = h.call('writeDirectCallRowsToNeon_', [], 'March 2026', '2026-03-09');
  assert.equal(res.inserted, 0);
  assert.equal(cap.executed.length, 1, 'DELETE only -- no upsert for zero rows');
  assert.match(cap.executed[0].sql, /DELETE FROM direct_call_history WHERE call_date = \?::date/);
  assert.equal(cap.executed[0].binds[0], '2026-03-09');
  assert.equal(cap.commits, 1, 'the delete IS the correction and commits');
});

test('P-5: empty rows with NO date is still a clean no-op (nothing to clear)', function () {
  const cap = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  const res = h.call('writeDirectCallRowsToNeon_', [], 'March 2026', null);
  assert.equal(res.inserted, 0);
  assert.equal(cap.executed.length, 0, 'no connection work without a date');
});

test('C-5: an EMPTY roster read refuses the rebuild (delete-then-rewrite must not erase the date)', function () {
  // dcBuildExtMaps_ silently returns empty maps on a blank config read; with
  // no agent extensions the engine cannot produce rows, so the refresh would
  // delete the date's sheet + Neon rows and write nothing (the C-5 loss
  // signature). buildDirectCallFromRaw_ must throw BEFORE any write -- ss is
  // null here to prove nothing was touched.
  const rawDisp = [
    ['CALL ID', 'LEG', 'START', 'x'],
    ['1', '1', '03/09/2026 10:00:00', 'x'],
  ];
  const emptyConfig = { getLastRow: function () { return 1; } };
  assert.throws(function () {
    h.fn('buildDirectCallFromRaw_')(null, rawDisp, emptyConfig, {});
  }, /ZERO agent[\s\S]*extensions/);
});

test('P-4: buildDirectCallFromRaw_ refuses a derived date that disagrees with expectedDate', function () {
  // The guard throws BEFORE any sheet/Neon write touches the derived date, so
  // ss/configSheet are never reached -- pass nulls to prove it.
  const rawDisp = [
    ['CALL ID', 'LEG', 'START', 'x'],
    ['1', '1', '03/08/2026 10:00:00', 'x'],   // stray carry-over first row (D-1)
  ];
  assert.throws(function () {
    h.fn('buildDirectCallFromRaw_')(null, rawDisp, null, { expectedDate: new Date(2026, 2, 9, 12, 0, 0) });
  }, /derives date 2026-03-08 but the caller expected 2026-03-09/);
});

// ── R39: inline-literal upsert pins ─────────────────────────────────────────
function metricRow(agent, extra) {
  return Object.assign({ monthYear: 'March 2026', isoDate: '2026-03-09', dept: 'CSR', agent: agent,
    ib_int_answered: 8, ib_int_missed_free: 1, ib_int_missed_busy: 0, ib_int_talk_sec: 480,
    ib_ext_answered: 12, ib_ext_missed_free: 2, ib_ext_missed_busy: 1, ib_ext_talk_sec: 720,
    ob_int_total: 3, ob_int_connected: 2, ob_int_talk_sec: 120,
    ob_ext_total: 4, ob_ext_connected: 3, ob_ext_talk_sec: 200 }, extra || {});
}

test('R39: inline == bound value-for-value, incl. quotes, NULL month and the `v | 0` coercions', function () {
  const rows = [
    metricRow("O'Brien, Pat", { ib_int_talk_sec: 3.9, ob_ext_total: 'abc', ob_int_talk_sec: null, ob_ext_talk_sec: '12' }),
    metricRow('Dee $nq$ Jones', { monthYear: null, ib_ext_answered: undefined, ob_ext_connected: true }),
  ];
  const inl = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.fn('dcUpsertRows_')(fakeConn(inl), rows);
  assert.equal(inl.executed.length, 1);
  assert.equal(inl.executed[0].bound, false);
  const inline = tuplesOf(inl.executed[0].sql);

  const bnd = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.fn('dcBoundUpsert_')(fakeConn(bnd), rows);
  assert.equal(bnd.executed.length, 1);
  assert.equal(bnd.executed[0].bound, true);
  // The bound path passes `v | 0` to setInt; normalize its 4 text binds
  // the same way the inline decoder does (null stays null).
  const bound = boundRowsOf(bnd.executed[0].binds).map(function (r) {
    return r.map(function (v, i) { return (i < 4 && v !== null && v !== undefined) ? String(v) : (v === undefined ? null : v); });
  });
  assert.deepEqual(inline, bound, 'same values in the same order on both paths');
  assert.equal(inline[0][3], "O'Brien, Pat", 'a quote inside a dollar-quoted literal survives');
  assert.equal(inline[1][3], 'Dee $nq$ Jones', 'a value containing the tag gets a longer tag');
  assert.deepEqual(inline[0].slice(4), [8, 1, 0, 3, 12, 2, 1, 720, 3, 2, 0, 0, 3, 12], '`v | 0` semantics');
  assert.ok(inl.executed[0].sql.indexOf('?') === -1, 'no placeholders anywhere in the inline statement');
});

test('R39: size-packed under the JDBC cap; an oversize tuple alone falls back to the bound statement', function () {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push(metricRow('Agent number ' + i, { isoDate: '2026-03-' + String(1 + (i % 28)).padStart(2, '0') }));
  const cap = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.fn('dcUpsertRows_')(fakeConn(cap), rows);
  assert.ok(cap.executed.length >= 2, 'packed into several statements: ' + cap.executed.length);
  let total = 0;
  cap.executed.forEach(function (e) {
    assert.equal(e.bound, false);
    assert.ok(e.sql.length < JDBC_SQL_CAP, 'under the cap: ' + e.sql.length);
    total += tuplesOf(e.sql).length;
  });
  assert.equal(total, 1500, 'every row present across the statements');
  assert.equal(cap.commits, 0, 'dcUpsertRows_ never commits -- the caller owns the transaction');

  // A single tuple over the cap cannot be packed: it goes through the
  // ORIGINAL bound statement on its own, and the rows around it still inline.
  const huge = metricRow(new Array(31000).join('x'));
  const cap2 = { executed: [], prepared: [], commits: 0, rollbacks: 0, closes: 0, ddl: 0 };
  h.fn('dcUpsertRows_')(fakeConn(cap2), [metricRow('A'), huge, metricRow('B')]);
  const bound = cap2.executed.filter(function (e) { return e.bound; });
  const inline = cap2.executed.filter(function (e) { return !e.bound; });
  assert.equal(bound.length, 1, 'exactly the oversize row via bound params');
  assert.equal(bound[0].binds.length, 18);
  assert.equal(bound[0].binds[3].length, 30999);
  assert.equal(inline.reduce(function (n, e) { return n + tuplesOf(e.sql).length; }, 0), 2, 'A and B inline');
});
