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

// One upsert statement per batch; every row binds 37 params (34 cols +
// queue_split; Batch 3 appended after_hours_answered + after_hours_ttt).
// Row count per statement = binds / 37.
const DQE_BINDS_PER_ROW = 37;

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

test('Batch 3: the upsert binds AJ/AK from a 37-wide sheet, and NULL (never 0) where the sheet has none', function () {
  const cap = install([
    dqeRow('08/05/2026', 'Anna', { 35: '2', 36: '500' }),   // 37-wide: captured
    dqeRow('08/05/2026', 'Ben',  { 35: '0', 36: '0' }),     // captured, nothing after hours
    dqeRow('08/06/2026', 'Cara'),                            // pre-Batch-3 row: blank
  ]);
  h.call('backfillDQEHistoryUpsert');
  assert.equal(upsertedRows(cap), 3);
  const b = cap.statements[0].binds;
  assert.equal(b[35], '2');   assert.equal(b[36], '500');
  assert.equal(b[DQE_BINDS_PER_ROW + 35], '0', 'a captured 0 stays 0');
  assert.equal(b[DQE_BINDS_PER_ROW + 36], '0');
  assert.equal(b[2 * DQE_BINDS_PER_ROW + 35], null, 'blank AJ -> NULL (COALESCE keeps the stored value)');
  assert.equal(b[2 * DQE_BINDS_PER_ROW + 36], null);
  assert.match(cap.statements[0].sql, /after_hours_answered = COALESCE\(EXCLUDED\.after_hours_answered, dqe_history\.after_hours_answered\)/);
  assert.match(cap.statements[0].sql, /NULLIF\(\?, ''\)::int,NULLIF\(\?, ''\)::int\)/, 'the pair binds through NULLIF casts');
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

// ── R27: the CDR backfill's CDR_BACKFILL_BEFORE ceiling ───────────────────
// The Operator State #57 refill (TRUNCATE call_history_phones, rebuild the
// pre-capture block) must not re-create the post-capture phone rows: rows
// dated at/after the ISO ceiling are skipped; unset = every row (unchanged).
function cdrRow(date, agent) {
  const r = new Array(26).fill('');
  r[0] = 'July 2026'; r[1] = 'W1'; r[2] = date; r[3] = 'CSR'; r[4] = agent;
  r[23] = '+12145550000 0:01:00 (1)';
  return r;
}
function installCdr(rows, extraProps) {
  h.state.props = Object.assign({ NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p',
                                  HMAC_SECRET: 's' }, extraProps || {});
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'CDR Historical Data': [new Array(26).fill('h')].concat(rows) },
  });
  const cap = { statements: [], commits: 0, rollbacks: 0, closes: 0 };
  const c = fakeConn(cap);
  const realPrepare = c.prepareStatement;
  c.prepareStatement = function (sql) {
    const st = realPrepare(sql);
    st.getUpdateCount = function () { return -1; };
    st.executeQuery = function () {  // the parent-id lookup: no parents -> no phone rows
      cap.statements.push({ sql: sql, binds: [] });
      return { next: function () { return false; }, close: function () {} };
    };
    return st;
  };
  // R35: the parent upsert is an inline statement now -- record its SQL.
  c.createStatement = function () {
    return { execute: function (sql) { cap.statements.push({ sql: sql, binds: [] }); return true; },
             getUpdateCount: function () { return -1; }, close: function () {} };
  };
  h.ctx.getNeonConn_backfill = function () { return c; };
  return cap;
}
function cdrDatesBound(cap) {
  const ins = cap.statements.filter(function (s) { return /INSERT INTO call_history_dept/.test(s.sql); });
  const dates = [];
  ins.forEach(function (s) {
    const re = /\('(\d{4}-\d{2}-\d{2})'::date,/g;
    let m; while ((m = re.exec(s.sql)) !== null) dates.push(m[1]);
  });
  return dates;
}

test('R27: CDR_BACKFILL_BEFORE skips rows dated at/after the ceiling; unset keeps every row', function () {
  const rows = [cdrRow('07/08/2026', 'Anna'), cdrRow('07/09/2026', 'Ben'),
                cdrRow('07/10/2026', 'Cal'), cdrRow('07/13/2026', 'Dee')];
  let cap = installCdr(rows);
  h.call('backfillCDRHistory');
  assert.deepEqual(cdrDatesBound(cap), ['2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13']);

  cap = installCdr(rows, { CDR_BACKFILL_BEFORE: '2026-07-10' });
  h.call('backfillCDRHistory');
  assert.deepEqual(cdrDatesBound(cap), ['2026-07-08', '2026-07-09'], 'the capture-start day itself is excluded');
  assert.ok(!('CDR_BACKFILL_RESUME' in h.state.props), 'a completed run clears its pointer');

  cap = installCdr(rows, { CDR_BACKFILL_BEFORE: '7/10/2026' });
  h.call('backfillCDRHistory');
  assert.equal(cdrDatesBound(cap).length, 0, 'a non-ISO ceiling aborts before writing anything');
});

// ── R33: the phones-only refill (zero binds) ───────────────────────────────
// backfillCDRHistory bound five params per phone row -- ~5,600 bridge calls
// and five minutes for a 50-row batch on the 2026-09 refill. The refill of
// a truncated call_history_phones needs no parent upsert at all: parents
// are looked up per date with ONE json_agg query (zero binds) and the
// children go in as inline literals through cdrInsertPhoneChildRows_.
function phonesConn(cap, parents) {
  // parents: [{id, d, dept, a}] served by the json_agg lookup.
  return {
    setAutoCommit: function () {},
    prepareStatement: function () { cap.binds++; throw new Error('prepareStatement must not be used on the zero-bind path'); },
    createStatement: function () {
      return {
        execute: function (sql) { cap.statements.push({ sql: sql }); return true; },
        executeQuery: function (sql) {
          cap.statements.push({ sql: sql, query: true });
          const j = JSON.stringify(parents);
          return { next: function () { return true; }, getString: function () { return j; }, close: function () {} };
        },
        close: function () {},
      };
    },
    commit: function () { cap.commits++; }, rollback: function () { cap.rollbacks++; }, close: function () { cap.closes++; },
  };
}
function installPhones(rows, parents, extraProps) {
  h.state.props = Object.assign({ NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p', HMAC_SECRET: 's' }, extraProps || {});
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'CDR Historical Data': [new Array(26).fill('h')].concat(rows) },
  });
  const cap = { statements: [], commits: 0, rollbacks: 0, closes: 0, binds: 0 };
  h.ctx.getNeonConn_backfill = function () { return phonesConn(cap, parents); };
  return cap;
}

test('R33: backfillCDRPhonesOnly re-creates children for existing parents with zero binds', function () {
  const rows = [cdrRow('07/08/2026', 'Anna'), cdrRow('07/09/2026', 'Ben'),
                cdrRow('07/10/2026', 'Cal'), cdrRow('07/13/2026', 'Dee')];
  rows[1][23] = ''; rows[1][24] = ''; rows[1][25] = '';   // Ben: no phone cells -> skipped
  const parents = [{ id: 11, d: '2026-07-08', dept: 'CSR', a: 'Anna' }, { id: 12, d: '2026-07-09', dept: 'CSR', a: 'Ben' },
                   { id: 13, d: '2026-07-10', dept: 'CSR', a: 'Cal' }];
  const cap = installPhones(rows, parents, { CDR_BACKFILL_BEFORE: '2026-07-10' });
  h.call('backfillCDRPhonesOnly');
  assert.equal(cap.binds, 0, 'no prepared statements at all');
  const lookups = cap.statements.filter(function (s) { return s.query; });
  assert.equal(lookups.length, 1, 'one json_agg lookup for the batch');
  assert.match(lookups[0].sql, /json_agg\(json_build_object\('id', id, 'd', call_date::text, 'dept', department, 'a', agent_name\)\)/);
  assert.match(lookups[0].sql, /WHERE call_date IN \('2026-07-08'::date\)/, 'only the batch\'s dates, ceiling applied, no-phone rows skipped');
  const inserts = cap.statements.filter(function (s) { return /INSERT INTO call_history_phones/.test(s.sql); });
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /VALUES \(11,'ob_ext_list_total','[0-9a-f]{64}',60,1\)/, 'inline literal tuple for Anna\'s parent id');
  const dels = cap.statements.filter(function (s) { return /DELETE FROM call_history_phones WHERE call_history_id IN \(11\)/.test(s.sql); });
  assert.equal(dels.length, 1, 'the IMP-4 per-parent replace, scoped to the batch\'s own parent');
  assert.ok(!('CDR_PHONES_BACKFILL_RESUME' in h.state.props), 'a completed run clears its pointer');
  assert.ok(cap.commits >= 1);
});

test('R33: the refill resumes from its own pointer and a batch failure rolls back + re-points', function () {
  const rows = [cdrRow('07/08/2026', 'Anna'), cdrRow('07/09/2026', 'Ben')];
  const parents = [{ id: 11, d: '2026-07-08', dept: 'CSR', a: 'Anna' }, { id: 12, d: '2026-07-09', dept: 'CSR', a: 'Ben' }];
  const cap = installPhones(rows, parents);
  h.ctx.getNeonConn_backfill = function () {
    const c = phonesConn(cap, parents);
    c.createStatement = function () {
      return { execute: function (sql) { if (/INSERT/.test(sql)) throw new Error('boom'); return true; },
               executeQuery: function () { return { next: function () { return true; }, getString: function () { return JSON.stringify(parents); }, close: function () {} }; },
               close: function () {} };
    };
    return c;
  };
  assert.throws(function () { h.call('backfillCDRPhonesOnly'); }, /boom/);
  assert.equal(cap.rollbacks, 1);
  const st = JSON.parse(h.state.props.CDR_PHONES_BACKFILL_RESUME);
  assert.equal(st.index, 0, 'the batch start is re-pointed');
  // Honors a matching pointer: index past the end reports complete without touching Neon.
  h.fn('nbResumeWrite_')(h.state.props && { getProperty: function (k) { return h.state.props[k] || null; }, setProperty: function (k, v) { h.state.props[k] = String(v); } },
    'CDR_PHONES_BACKFILL_RESUME', 2, rows.map(function (r) { return r; }), h.ctx.NB_CDR_KEY_COLS_);
  const before = cap.statements.length;
  h.call('backfillCDRPhonesOnly');
  assert.equal(cap.statements.length, before, 'nothing executed when already complete');
});

test('R33: cdrInsertPhoneChildRows_ skips the bound lookup when given an idMap', function () {
  const cap = { statements: [], binds: 0 };
  const conn = phonesConn(cap, []);
  const n = h.fn('cdrInsertPhoneChildRows_')(conn,
    [{ callDate: '2026-07-08', dept: 'CSR', agentName: 'Anna', phonesX: '+12145550000 0:01:00 (1)' }],
    's', { idMap: { '2026-07-08|CSR|Anna': 77 } });
  assert.equal(n, 1);
  assert.equal(cap.binds, 0);
  assert.match(cap.statements.map(function (s) { return s.sql; }).join('\n'), /VALUES \(77,'ob_ext_list_total'/);
});

// ── R34: the missing-parents pass ──────────────────────────────────────────
// Finds sheet rows whose (date, dept, agent) has no call_history_dept row,
// upserts ONLY those parents, then their phone children (ceiling-gated).
function missingConn(cap, parents) {
  // R35: the parent upsert is inline too, so every statement -- lookups,
  // upserts, child deletes/inserts -- goes through createStatement(). The
  // fake parses the upsert's tuples so later lookups see the new parents.
  const c = phonesConn(cap, parents);
  const inner = c.createStatement;
  c.createStatement = function () {
    const st = inner();
    const exec = st.execute;
    st.execute = function (sql) {
      if (/^INSERT INTO call_history_dept/.test(sql)) {
        const re = /\('(\d{4}-\d{2}-\d{2})'::date,'((?:[^']|'')*)','((?:[^']|'')*)'/g;
        let m, n = 0;
        while ((m = re.exec(sql)) !== null) {
          parents.push({ id: 100 + parents.length, d: m[1], dept: m[2].replace(/''/g, "'"), a: m[3].replace(/''/g, "'") });
          n++;
        }
        cap.upsertRows = (cap.upsertRows || 0) + n;
      }
      return exec(sql);
    };
    st.getUpdateCount = function () { return -1; };
    return st;
  };
  return c;
}

test('R34: backfillCDRMissingParents fills only the rows with no parent, phones only before the ceiling', function () {
  const rows = [cdrRow('07/08/2026', 'Anna'),   // has a parent -> untouched
                cdrRow('07/09/2026', 'Ben'),    // MISSING, pre-capture -> parent + phones
                cdrRow('07/13/2026', 'Dee')];   // MISSING, post-capture -> parent only
  const parents = [{ id: 11, d: '2026-07-08', dept: 'CSR', a: 'Anna' }];
  const cap = installPhones(rows, parents, { CDR_BACKFILL_BEFORE: '2026-07-10' });
  h.ctx.getNeonConn_backfill = function () { return missingConn(cap, parents); };
  h.call('backfillCDRMissingParents');
  const upserts = cap.statements.filter(function (s) { return /INSERT INTO call_history_dept/.test(s.sql); });
  assert.equal(upserts.length, 1, 'one parent upsert statement for the batch');
  assert.equal(cap.binds, 0, 'zero binds: the parent upsert is inline too (R35)');
  assert.equal(cap.upsertRows, 2, 'exactly the two missing parents');
  assert.match(upserts[0].sql, /\('2026-07-09'::date,'CSR','Ben'/);
  assert.match(upserts[0].sql, /\('2026-07-13'::date,'CSR','Dee'/);
  const phoneInserts = cap.statements.filter(function (s) { return /INSERT INTO call_history_phones/.test(s.sql); });
  assert.equal(phoneInserts.length, 1, 'one inline phone insert');
  const benId = parents.filter(function (x) { return x.a === 'Ben'; })[0].id;
  const deeId = parents.filter(function (x) { return x.a === 'Dee'; })[0].id;
  assert.match(phoneInserts[0].sql, new RegExp('\\(' + benId + ",'ob_ext_list_total'"), 'Ben (pre-capture) gets phone children');
  assert.ok(phoneInserts[0].sql.indexOf('(' + deeId + ',') === -1, 'Dee (at/after the ceiling) gets none');
  assert.equal(cap.statements.filter(function (s) { return s.query; }).length, 2, 'two zero-bind lookups: before and after the upsert');
  assert.ok(!('CDR_MISSING_BACKFILL_RESUME' in h.state.props), 'a completed run clears its pointer');

  // A clean sheet writes nothing at all.
  const cap2 = installPhones([cdrRow('07/08/2026', 'Anna')], parents);
  h.ctx.getNeonConn_backfill = function () { return missingConn(cap2, parents); };
  h.call('backfillCDRMissingParents');
  assert.equal(cap2.statements.filter(function (s) { return /INSERT/.test(s.sql); }).length, 0);
});

test('R35: the parent upsert is inline, size-packed under the JDBC cap, quote-safe, one commit', function () {
  const cap = { statements: [], commits: 0, binds: 0 };
  const parents = [];
  const conn = missingConn(cap, parents);
  const rows = [];
  for (let i = 0; i < 700; i++) {
    rows.push({ callDate: '2026-04-2' + (i % 10), dept: 'CSR', agentName: "O'Brien " + i,
                obListTot: 'Alice Smith | Bob Jones', ibListAns: '+12145550000 0:01:00 (2)' });
  }
  const n = h.fn('nbUpsertCdrParents_')(conn, rows, 's');
  assert.equal(n, 700);
  assert.equal(cap.binds, 0);
  assert.equal(cap.commits, 1, 'one commit after all statements');
  const upserts = cap.statements.filter(function (s) { return /INSERT INTO call_history_dept/.test(s.sql); });
  assert.ok(upserts.length >= 2, 'packed into several statements: ' + upserts.length);
  upserts.forEach(function (s) { assert.ok(s.sql.length < 44000, 'under the JDBC cap: ' + s.sql.length); });
  assert.equal(cap.upsertRows, 700, 'every row present across the statements');
  assert.match(upserts[0].sql, /'O''Brien 0'/, 'a quote in a name is doubled, never a bind');
  assert.match(upserts[0].sql, /'::jsonb/, 'JSONB name lists ride as literals with the cast');
  assert.ok(upserts[0].sql.split('VALUES ')[1].indexOf('?') === -1, 'no placeholders in the VALUES');
  assert.throws(function () { h.fn('nbUpsertCdrParents_')(conn, [{ callDate: '7/9/2026', dept: 'CSR', agentName: 'x' }], 's'); },
    /callDate must be ISO/, 'a non-ISO date never reaches the SQL');
});


// ── R37: prune stale-name phantoms (rows the sheet no longer has) ───────────
function extrasConn(cap, cdrRows, dqeRows) {
  return {
    setAutoCommit: function () {},
    prepareStatement: function () { cap.binds++; throw new Error('no binds on the R37 path'); },
    createStatement: function () {
      return {
        execute: function (sql) { cap.statements.push({ sql: sql }); return true; },
        executeQuery: function (sql) {
          cap.statements.push({ sql: sql, query: true });
          const j = /FROM call_history_dept/.test(sql) ? JSON.stringify(cdrRows) : JSON.stringify(dqeRows);
          return { next: function () { return true; }, getString: function () { return j; }, close: function () {} };
        },
        close: function () {},
      };
    },
    commit: function () { cap.commits++; }, rollback: function () { cap.rollbacks++; }, close: function () {},
  };
}
function dqeMini(date, agent) { const r = new Array(34).fill(''); r[1] = date; r[2] = agent; return r; }

test('R37: preview lists Neon rows whose key the sheet lacks on sheet dates, touches nothing; prune deletes children-first, zero binds', function () {
  h.state.props = { NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'CDR Historical Data': [new Array(26).fill('h'), cdrRow('03/10/2026', 'Anna Smith'), cdrRow('03/10/2026', 'Ben')],
    'DQE Historical Data': [new Array(34).fill('h'), dqeMini('03/10/2026', 'Anna Smith')],
  } });
  const cdrNeon = [{ id: 1, d: '2026-03-10', dept: 'CSR', a: 'Anna Smith' }, { id: 2, d: '2026-03-10', dept: 'CSR', a: 'Ben' },
                   { id: 3, d: '2026-03-10', dept: 'CSR', a: 'Anna (Annie) Smith' },   // the renamed phantom
                   { id: 4, d: '2026-03-11', dept: 'CSR', a: 'Ghost' }];             // a date the sheet lacks: left alone
  const dqeNeon = [{ d: '2026-03-10', a: 'Anna Smith' }, { d: '2026-03-10', a: "O'Old Name" }];
  let cap = { statements: [], commits: 0, rollbacks: 0, binds: 0 };
  h.ctx.getNeonConn_backfill = function () { return extrasConn(cap, cdrNeon, dqeNeon); };
  const pv = h.call('previewNeonExtraRows');
  assert.deepEqual(JSON.parse(JSON.stringify(pv.cdr.extras)), [{ id: 3, key: '2026-03-10|CSR|Anna (Annie) Smith' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(pv.dqe.extras)), [{ d: '2026-03-10', a: "O'Old Name" }]);
  assert.equal(pv.applied, false);
  assert.equal(cap.statements.filter(function (s) { return /DELETE/.test(s.sql); }).length, 0, 'preview deletes nothing');
  assert.equal(cap.binds, 0);
  // Only the sheet's dates are looked up (the lookup SQL names them).
  assert.match(cap.statements[0].sql, /WHERE call_date IN \('2026-03-10'::date\)/);

  cap = { statements: [], commits: 0, rollbacks: 0, binds: 0 };
  h.ctx.getNeonConn_backfill = function () { return extrasConn(cap, cdrNeon, dqeNeon); };
  const pr = h.call('pruneNeonExtraRows');
  assert.equal(pr.applied, true);
  const dels = cap.statements.filter(function (s) { return /DELETE/.test(s.sql); }).map(function (s) { return s.sql; });
  assert.deepEqual(dels, [
    'DELETE FROM call_history_phones WHERE call_history_id IN (3)',
    'DELETE FROM call_history_dept WHERE id IN (3)',
    "DELETE FROM dqe_history WHERE (call_date, agent_name) IN (('2026-03-10'::date,'O''Old Name'))",
  ], 'children before parents; id 4 (date absent from the sheet) untouched; the quote is doubled');
  assert.equal(cap.commits, 2);
  assert.equal(cap.binds, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(pr.deleted)), { call_history_dept: 1, dqe_history: 1 });
});

test('R37: the prune refuses past the cap (a wrong sheet read must not wipe Neon)', function () {
  h.state.props = { NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'CDR Historical Data': [new Array(26).fill('h'), cdrRow('03/10/2026', 'Anna')],
    'DQE Historical Data': [new Array(34).fill('h')],
  } });
  const many = [];
  for (let i = 0; i < 2100; i++) many.push({ id: 10 + i, d: '2026-03-10', dept: 'CSR', a: 'X' + i });
  const cap = { statements: [], commits: 0, rollbacks: 0, binds: 0 };
  h.ctx.getNeonConn_backfill = function () { return extrasConn(cap, many, []); };
  assert.throws(function () { h.call('pruneNeonExtraRows'); }, /Refusing to prune 2100/);
  assert.equal(cap.statements.filter(function (s) { return /DELETE/.test(s.sql); }).length, 0);
  assert.equal(cap.commits, 0);
});
