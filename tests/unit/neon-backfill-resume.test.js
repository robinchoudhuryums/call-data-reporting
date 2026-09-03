'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// T-8 / T-7 (2026-09-03 broad scan): the cdr-report Neon backfills'
// resume pointers and sanitizer-loss tally.
//
// T-8: the four `*_RESUME` Script Properties were bare row INDEXES into the
// getDisplayValues() grid. A row deleted or inserted above the pointer
// between runs (the duplicate-merge repair, a force re-import that shrank a
// date) shifted every later row, so a resumed run silently skipped rows for
// good -- on exactly the path the Aug-gap runbook says to run. The pointer
// now carries {index, rowCount, key} and restarts from 0 on any mismatch.
//
// T-7: the DQE backfills EXCLUDE (null) or SENTINEL (#REBUILD) cells the
// sanitizers cannot recover, silently. The run now tallies them into its
// completion log and `DQE_UPSERT_LAST` / `DQE_BACKFILL_LAST`.
//
// Driven through the real backfillDQEHistoryUpsert against a fake sheet and a
// recording JDBC conn (the direct-call-backfill pattern); the DO-NOTHING
// backfill shares the helpers, and its pointer is pinned through nbResumeRead_
// directly. neonWrite.js is loaded for parseDateForNeon.

const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'neonbackfill.js'] });

// 34-col DQE row: A month, B date, C agent, D exts, E-J numerics, K-AC 19
// slots (idx 10-28), AD/AE/AF (idx 29-31), AG/AH abd waits.
function dqeRow(date, agent, over) {
  const r = new Array(34).fill('');
  r[0] = 'August 2026'; r[1] = date; r[2] = agent; r[3] = '103';
  r[4] = '3'; r[5] = '4'; r[6] = '1'; r[7] = '3'; r[8] = '0:12:00'; r[9] = '0:04:00';
  r[32] = '0:01:00'; r[33] = '';
  return Object.assign(r, over || {});
}

// One upsert statement per batch; every row binds 35 params (34 cols +
// queue_split). Row count per statement = binds / 35.
const DQE_BINDS_PER_ROW = 35;

// The fingerprint key joins the key columns with U+0001 (nbResumeKey_).
function K() { return Array.prototype.slice.call(arguments).join('\u0001'); }

function fakeConn(cap) {
  return {
    setAutoCommit: function () {},
    createStatement: function () { return { execute: function () { return true; }, close: function () {} }; },
    prepareStatement: function (sql) {
      const binds = [];
      const st = {
        setString: function (i, v) { binds[i - 1] = v; },
        setInt: function (i, v) { binds[i - 1] = v; },
        setDouble: function (i, v) { binds[i - 1] = v; },
        execute: function () { cap.statements.push({ sql: sql, binds: binds.slice() }); return true; },
        close: function () {},
      };
      return st;
    },
    commit: function () { cap.commits++; },
    rollback: function () { cap.rollbacks++; },
    close: function () { cap.closes++; },
  };
}

function install(rows) {
  h.state.props = { NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p' };
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DQE Historical Data': [new Array(34).fill('h')].concat(rows) },
  });
  const cap = { statements: [], commits: 0, rollbacks: 0, closes: 0 };
  h.ctx.getNeonConn_backfill = function () { return fakeConn(cap); };
  return cap;
}

function upsertedRows(cap) {
  return cap.statements.reduce(function (n, s) {
    return n + (s.sql.indexOf('INSERT INTO dqe_history') === 0 ? s.binds.length / DQE_BINDS_PER_ROW : 0);
  }, 0);
}

const ROWS = [
  dqeRow('08/05/2026', 'Anna'),
  dqeRow('08/05/2026', 'Ben'),
  dqeRow('08/06/2026', 'Anna'),
  dqeRow('08/06/2026', 'Ben'),
];

test('T-8: a full run clears the pointer and stores an OK summary in DQE_UPSERT_LAST', function () {
  const cap = install(ROWS);
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 4);
  assert.equal(h.state.props.DQE_UPSERT_RESUME, undefined, 'pointer cleared on completion');
  assert.match(h.state.props.DQE_UPSERT_LAST, /^OK \d{4}-\d{2}-\d{2}T.* upserted=4 cells nulled=0 sentineled=0 rows-with-loss=0$/);
});

test('T-8: a fingerprinted pointer whose sheet is UNCHANGED resumes at its index', function () {
  const cap = install(ROWS);
  // Resume at index 2 (the 08/06 Anna row): fingerprint = 4 rows, that row's key.
  h.state.props.DQE_UPSERT_RESUME = JSON.stringify({ index: 2, rowCount: 4, key: K('08/06/2026', 'Anna') });
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 2, 'only the two rows from index 2 on');
  const dates = cap.statements[0].binds.filter(function (v, i) { return i % DQE_BINDS_PER_ROW === 1; });
  assert.deepEqual(dates, ['2026-08-06', '2026-08-06']);
});

test('T-8: a row deleted above the pointer changes the row count -> restart from 0, nothing skipped', function () {
  // The duplicate-merge repair removed the 08/05 Ben row after the pointer
  // was saved. Positionally, index 2 is now the 08/06 BEN row, so the old
  // bare-index resume would have skipped 08/06 Anna for good.
  const cap = install([ROWS[0], ROWS[2], ROWS[3]]);
  h.state.props.DQE_UPSERT_RESUME = JSON.stringify({ index: 2, rowCount: 4, key: K('08/06/2026', 'Anna') });
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 3, 'every surviving row, from the top');
});

test('T-8: same row count but a different row at the index (one deleted, one inserted) -> restart from 0', function () {
  const cap = install([ROWS[0], ROWS[2], ROWS[3], dqeRow('08/07/2026', 'Anna')]);
  h.state.props.DQE_UPSERT_RESUME = JSON.stringify({ index: 2, rowCount: 4, key: K('08/06/2026', 'Anna') });
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 4, 'the fingerprint caught the shift');
});

test('T-8: a legacy bare-integer pointer has no fingerprint -> restart from 0 (never trusted positionally)', function () {
  const cap = install(ROWS);
  h.state.props.DQE_UPSERT_RESUME = '2';
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 4);
});

test('T-8: the pointer written on a batch failure carries the fingerprint (index, rowCount, key)', function () {
  const cap = install(ROWS);
  const conn = fakeConn(cap);
  conn.prepareStatement = function () {
    return { setString: function () {}, setInt: function () {}, setDouble: function () {},
             execute: function () { throw new Error('boom'); }, close: function () {} };
  };
  h.ctx.getNeonConn_backfill = function () { return conn; };
  assert.throws(function () { h.call('backfillDQEHistoryUpsert'); }, /boom/);
  const st = JSON.parse(h.state.props.DQE_UPSERT_RESUME);
  assert.deepEqual(st, { index: 0, rowCount: 4, key: K('08/05/2026', 'Anna') });
  assert.equal(cap.rollbacks, 1);
});

test('T-8: nbResumeRead_ covers the CDR / QCD pointers with their own key columns', function () {
  const props = { bag: {}, getProperty: function (k) { return this.bag[k] || null; },
                  setProperty: function (k, v) { this.bag[k] = String(v); } };
  const cdr = [['m', 'w', '08/05/2026', 'CSR', 'Anna'], ['m', 'w', '08/05/2026', 'CSR', 'Ben']];
  h.fn('nbResumeWrite_')(props, 'CDR_BACKFILL_RESUME', 1, cdr, h.ctx.NB_CDR_KEY_COLS_);
  assert.deepEqual(JSON.parse(props.bag.CDR_BACKFILL_RESUME),
    { index: 1, rowCount: 2, key: K('08/05/2026', 'CSR', 'Ben') });
  assert.equal(h.fn('nbResumeRead_')(props, 'CDR_BACKFILL_RESUME', cdr, h.ctx.NB_CDR_KEY_COLS_), 1);
  // The dept of the row at the index changed -> 0.
  const cdr2 = [cdr[0], ['m', 'w', '08/05/2026', 'Sales', 'Ben']];
  assert.equal(h.fn('nbResumeRead_')(props, 'CDR_BACKFILL_RESUME', cdr2, h.ctx.NB_CDR_KEY_COLS_), 0);
  // An index at/after the end with a matching row count is "complete" (the
  // caller's own >= data.length check reports it), not a restart.
  h.fn('nbResumeWrite_')(props, 'QCD_BACKFILL_RESUME', 2, cdr, h.ctx.NB_QCD_KEY_COLS_);
  assert.equal(h.fn('nbResumeRead_')(props, 'QCD_BACKFILL_RESUME', cdr, h.ctx.NB_QCD_KEY_COLS_), 2);
  // Unset -> 0, no throw.
  assert.equal(h.fn('nbResumeRead_')(props, 'DQE_BACKFILL_RESUME', cdr, h.ctx.NB_DQE_KEY_COLS_), 0);
});

test('T-7: coerced cells the sanitizers exclude are COUNTED, per cell and per row, into DQE_UPSERT_LAST', function () {
  const cap = install([
    // Slot K coerced to a bare serial (nulled), AD coerced to scientific
    // notation (sentineled), AF a lossless date-render (RECOVERED, not counted).
    dqeRow('08/05/2026', 'Anna', { 10: '0.433020833333', 29: '1.76E+24', 31: '12/30/1899 10:23:33' }),
    // Already-marked #REBUILD is not re-counted; a clean row counts nothing.
    dqeRow('08/05/2026', 'Ben', { 29: '#REBUILD', 30: '1762242202191,1762242165529' }),
    dqeRow('08/06/2026', 'Anna', { 10: '10:23:33,10:08:41' }),
  ]);
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 3, 'lossy rows are still mirrored (with the cells excluded)');
  assert.match(h.state.props.DQE_UPSERT_LAST, /upserted=3 cells nulled=1 sentineled=1 rows-with-loss=1$/);
  // And the mirrored values are what the sanitizers decided.
  const b = cap.statements[0].binds;
  assert.equal(b[10], null, 'coerced slot excluded');
  assert.equal(b[29], '#REBUILD', 'lost AD sentineled');
  assert.equal(b[31], '10:23:33', 'AF date-render recovered, not counted as loss');
  assert.equal(b[DQE_BINDS_PER_ROW + 29], '#REBUILD', 'pre-marked sentinel passes through');
});

test('T-7: nbSanitizeDqeCells_ tallies without changing what the sanitizers return', function () {
  const tally = h.fn('nbNewSanTally_')();
  const r = dqeRow('08/05/2026', 'Anna', { 12: '17,622,419,789,481,700,000', 30: '17,622,419,789,481,700,000,000', 31: '0.5' });
  const out = h.fn('nbSanitizeDqeCells_')(r, tally);
  assert.equal(out.slots.length, 19);
  assert.equal(out.slots[2], null);
  assert.equal(out.abMissedIds, '#REBUILD');
  assert.equal(out.abMissedTimes, null);
  assert.equal(out.abParentIds, null, 'empty AD stays NULL (0 abandoned)');
  // Cross-realm (vm) object: compare fields, not prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(tally)), { nulled: 2, sentineled: 1, rowsAffected: 1 });
});


test('Batch 2 follow-on: the upsert leaves a Pipeline Health row -- success when clean, failure when cells were excluded or a batch threw', function () {
  const rows = [];
  h.ctx.logPipelineHealth_ = function (ss, ev) { rows.push(ev); };
  try {
    let cap = install(ROWS);
    h.call('backfillDQEHistoryUpsert');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, 'dqeUpsert');
    assert.equal(rows[0].status, 'success');
    assert.equal(rows[0].rows, 4);
    assert.match(rows[0].notes, /nulled=0 sentineled=0/);

    rows.length = 0;
    cap = install([dqeRow('08/05/2026', 'Anna', { 10: '0.433020833333' })]);
    h.call('backfillDQEHistoryUpsert');
    assert.equal(rows[0].status, 'failure', 'excluded cells are the cue to run the sheetRepairs');
    assert.match(rows[0].notes, /nulled=1 .*EXCLUDED/);

    rows.length = 0;
    cap = install(ROWS);
    const conn = fakeConn(cap);
    conn.prepareStatement = function () {
      return { setString: function () {}, setInt: function () {}, setDouble: function () {},
               execute: function () { throw new Error('boom'); }, close: function () {} };
    };
    h.ctx.getNeonConn_backfill = function () { return conn; };
    assert.throws(function () { h.call('backfillDQEHistoryUpsert'); }, /boom/);
    assert.equal(rows[0].status, 'failure');
    assert.match(rows[0].notes, /threw: boom/);
  } finally {
    delete h.ctx.logPipelineHealth_;
  }
});
