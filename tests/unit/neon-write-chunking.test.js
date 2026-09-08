'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// F-21: the three Neon writers chunk their multi-row INSERTs (statement-size
// + 65,535-bind-param caps) while keeping ONE commit per writer call (the
// Neon write discipline). Fake JDBC conn counts statements, rows per
// statement, and commits.

const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js'] });

// R38: the writers render inline tuples now; count the tuples in each
// executed statement (dollar-quote-aware) and record its size, since the
// packing rule is BY SIZE under the JDBC cap rather than by row count.
function countTuples(sql) {
  const at = sql.indexOf(') VALUES ');
  const vals = at >= 0 ? sql.slice(at + 9) : sql;
  let n = 0, depth = 0, i = 0;
  while (i < vals.length) {
    if (vals.startsWith(' ON CONFLICT', i)) break;
    const c = vals[i];
    if (c === '$') { const m = /^\$([a-z]*)\$/.exec(vals.slice(i)); const tag = m[0]; i = vals.indexOf(tag, i + tag.length) + tag.length; continue; }
    if (c === "'") { i = vals.indexOf("'", i + 1) + 1; continue; }
    if (c === '(') { if (depth === 0) n++; depth++; }
    else if (c === ')') depth--;
    i++;
  }
  return n;
}
const JDBC_SQL_CAP = 44000;

function fakeConn(log) {
  return {
    setAutoCommit: function () {},
    prepareStatement: function (sql) {
      // The bound path is the oversize-row fallback only (R38). One "(?,"
      // per row placeholder -- counts the rows in this statement.
      (log.boundRows = log.boundRows || []).push((sql.match(/\(\?[,:]/g) || []).length);
      return {
        setString: function () {}, setInt: function () {}, setDouble: function () {},
        execute: function () { return true; }, executeQuery: function () { throw new Error('unexpected'); },
        close: function () {},
      };
    },
    createStatement: function () {
      return {
        execute: function (sql) {
          if (/^INSERT INTO/.test(sql)) {
            log.stmtRows.push(countTuples(sql));
            (log.stmtChars = log.stmtChars || []).push(sql.length);
          }
          return true;
        },
        close: function () {},
      };
    },
    commit: function () { log.commits++; },
    rollback: function () { log.rollbacks++; },
    close: function () { log.closed = true; },
  };
}

function install(log) {
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(log); };
}

test('F-21/R38: writeDQERowsToNeon packs inline statements under the JDBC cap with ONE commit', function () {
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const rows = [];
  for (let i = 0; i < 900; i++) {
    rows.push({ monthYear: 'June 2026', callDate: '06/22/2026', agentName: 'A' + i,
                queueExtensions: '', slots: [], abParentIds: '', abMissedIds: '',
                abMissedTimes: '', ttt: '0:01:00', att: '0:01:00' });
  }
  const res = h.fn('writeDQERowsToNeon')(rows);
  assert.equal(res.inserted, 900);
  assert.equal(log.stmtRows.reduce(function (a, b) { return a + b; }, 0), 900, 'every row in exactly one inline statement');
  assert.ok(!log.boundRows, 'no bound fallback for ordinary rows');
  log.stmtChars.forEach(function (n) { assert.ok(n < JDBC_SQL_CAP, 'statement under the JDBC cap: ' + n); });
  assert.ok(log.stmtRows.length >= 2, 'a 900-row batch packs into several statements');
  assert.equal(log.commits, 1, 'single commit across all chunks');
  assert.equal(log.rollbacks, 0);
  assert.ok(log.closed, 'connection closed');
});

test('F-21/R38: writeQCDRowsToNeon packs inline statements under the JDBC cap with ONE commit', function () {
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const rows = [];
  for (let i = 0; i < 2500; i++) {
    // Unique conflict keys (call_date, call_queue, call_source) -- real QCD
    // batches are distinct per tuple; duplicates are collapsed by the
    // IMP-6 dedupe (covered by its own test below).
    rows.push({ monthYear: 'June 2026', week: 'W1', callDate: '06/22/2026',
                callQueue: 'A_Q_X' + i, callSource: 'Total Calls', totalCalls: 1,
                totalAnswered: 1, abandoned: 0, longestWait: '0:01:00',
                avgAnswer: '0:00:10', abandonedPct: 0, violations: 0 });
  }
  const res = h.fn('writeQCDRowsToNeon')(rows);
  assert.equal(res.inserted, 2500);
  assert.equal(log.stmtRows.reduce(function (a, b) { return a + b; }, 0), 2500, 'every row in exactly one inline statement');
  assert.ok(!log.boundRows, 'no bound fallback for ordinary rows');
  log.stmtChars.forEach(function (n) { assert.ok(n < JDBC_SQL_CAP, 'statement under the JDBC cap: ' + n); });
  assert.equal(log.commits, 1);
});

test('F-21/IMP-3/R38: writeCDRRowsToNeon (main insert, no HMAC) packs inline statements under the cap with ONE commit', function () {
  // IMP-3: 300 rows/chunk (was 500 -- a FULL 500-row chunk measured ~44.2KB
  // of SQL, at/over the observed ~44KB Apps Script JDBC statement cap).
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const rows = [];
  for (let i = 0; i < 1100; i++) {
    rows.push({ callDate: '2026-06-22', dept: 'CSR', agentName: 'A' + i,
                obExtTTT: '0:01:00', obExtATT: '0:00:30' });
  }
  const res = h.fn('writeCDRRowsToNeon')(rows);
  assert.equal(res.inserted, 1100);
  assert.equal(log.stmtRows.reduce(function (a, b) { return a + b; }, 0), 1100, 'every row in exactly one inline statement');
  assert.ok(!log.boundRows, 'no bound fallback for ordinary rows');
  log.stmtChars.forEach(function (n) { assert.ok(n < JDBC_SQL_CAP, 'statement under the JDBC cap: ' + n); });
  assert.equal(log.commits, 1);
});

test('daily-scale batches pack into a handful of statements, every one under the cap', function () {
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ monthYear: 'June 2026', callDate: '06/22/2026', agentName: 'A' + i,
                queueExtensions: '', slots: [], abParentIds: '', abMissedIds: '',
                abMissedTimes: '', ttt: '0:01:00', att: '0:01:00' });
  }
  h.fn('writeDQERowsToNeon')(rows);
  assert.equal(log.stmtRows.reduce(function (a, b) { return a + b; }, 0), 250, 'every row in exactly one inline statement');
  assert.ok(!log.boundRows, 'no bound fallback for ordinary rows');
  log.stmtChars.forEach(function (n) { assert.ok(n < JDBC_SQL_CAP, 'statement under the JDBC cap: ' + n); });
  assert.equal(log.commits, 1);
});

test('IMP-6: duplicate conflict-key rows are deduped LAST-write-wins (no "cannot affect row a second time")', function () {
  // Sheet-derived callers (the deferred Neon mirror, re-mirrors of pasted
  // history) can pass two rows for one (call_date, agent_name); Postgres
  // rejects the multi-row upsert outright, wedging the mirror-queue date.
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const mk = function (agent, ttt) {
    return { monthYear: 'June 2026', callDate: '06/22/2026', agentName: agent,
             queueExtensions: '', slots: [], abParentIds: '', abMissedIds: '',
             abMissedTimes: '', ttt: ttt, att: '0:01:00' };
  };
  const res = h.fn('writeDQERowsToNeon')([mk('Anna', '0:01:00'), mk('Ben', '0:02:00'), mk('Anna', '0:09:00')]);
  assert.equal(res.inserted, 2, 'duplicate Anna collapsed');
  assert.equal(JSON.stringify(log.stmtRows), JSON.stringify([2]), 'one statement, two unique rows');
  assert.equal(log.commits, 1);

  // Pure helper semantics: last occurrence wins, first-seen order kept,
  // unique input returned untouched (same reference).
  const dd = h.fn('neonDedupeByKey_');
  const rows = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }];
  const out = dd(rows, 'test', function (r) { return r.k; });
  assert.equal(out.length, 2);
  assert.equal(out[0].v, 3, 'last write wins for the duplicate key');
  assert.equal(out[1].v, 2);
  const uniq = [{ k: 'x' }, { k: 'y' }];
  assert.equal(dd(uniq, 'test', function (r) { return r.k; }), uniq, 'unique input passes through untouched');
});

// Recording conn for the IMP-5 / REP-2 tests: captures each statement's SQL
// (the counting fakeConn above only records placeholder-row counts).
function recordingConn(log) {
  const emptyRs = { next: function () { return false; }, close: function () {} };
  return {
    setAutoCommit: function () {},
    prepareStatement: function (sql) {
      log.sqls.push(sql);
      return {
        setString: function () {}, setInt: function () {}, setDouble: function () {},
        execute: function () { return true; },
        executeQuery: function () { return emptyRs; },
        close: function () {},
      };
    },
    createStatement: function () {
      return { execute: function (sql) { if (typeof sql === 'string') log.sqls.push(sql); return true; }, close: function () {} };
    },
    commit: function () { log.commits++; },
    rollback: function () { log.rollbacks++; },
    close: function () { log.closed = true; },
  };
}

test('IMP-5: { authoritative: true } DELETEs the payload dates in the same txn before inserting', function () {
  const log = { sqls: [], commits: 0, rollbacks: 0 };
  h.ctx.getReachableNeonConn_ = function () { return recordingConn(log); };
  const rows = [
    { monthYear: 'June 2026', callDate: '06/22/2026', agentName: 'Anna',
      queueExtensions: '', slots: [], abParentIds: '', abMissedIds: '',
      abMissedTimes: '', ttt: '0:01:00', att: '0:01:00' },
    { monthYear: 'June 2026', callDate: '06/23/2026', agentName: 'Anna',
      queueExtensions: '', slots: [], abParentIds: '', abMissedIds: '',
      abMissedTimes: '', ttt: '0:01:00', att: '0:01:00' },
  ];
  h.fn('writeDQERowsToNeon')(rows, { authoritative: true });
  assert.match(log.sqls[0], /^DELETE FROM dqe_history WHERE call_date IN \(\?::date,\?::date\)$/,
    'delete-first for BOTH distinct dates');
  assert.match(log.sqls[1], /^INSERT INTO dqe_history/);
  assert.equal(log.commits, 1, 'delete + insert commit atomically');

  // QCD variant.
  const qlog = { sqls: [], commits: 0, rollbacks: 0 };
  h.ctx.getReachableNeonConn_ = function () { return recordingConn(qlog); };
  h.fn('writeQCDRowsToNeon')([
    { monthYear: 'June 2026', week: 'W1', callDate: '06/22/2026', callQueue: 'A_Q_X',
      callSource: 'Total Calls', totalCalls: 1, totalAnswered: 1, abandoned: 0,
      longestWait: '0:01:00', avgAnswer: '0:00:10', abandonedPct: 0, violations: 0 },
  ], { authoritative: true });
  assert.match(qlog.sqls[0], /^DELETE FROM qcd_history WHERE call_date IN \(\?::date\)$/);
  assert.equal(qlog.commits, 1);

  // Without the flag: NO delete (partial-set callers like the bulk archive
  // and the row-batched backfills stay pure upserts).
  const plog = { sqls: [], commits: 0, rollbacks: 0 };
  h.ctx.getReachableNeonConn_ = function () { return recordingConn(plog); };
  h.fn('writeDQERowsToNeon')([rows[0]]);
  assert.equal(plog.sqls.filter(function (q) { return /^DELETE/.test(q); }).length, 0,
    'plain calls never delete');
});

test('REP-2: the phone-child parent-id lookup is chunked (400 rows/query)', function () {
  const log = { sqls: [], commits: 0, rollbacks: 0 };
  h.ctx.getReachableNeonConn_ = function () { return recordingConn(log); };
  h.state.props.HMAC_SECRET = 'test-secret';
  h.state.props.CDR_PHONES_MIRROR = 'on';   // R27: the phone path is gated
  try {
    const rows = [];
    for (let i = 0; i < 900; i++) {
      rows.push({ callDate: '2026-06-22', dept: 'CSR', agentName: 'A' + i,
                  obExtTTT: '0:01:00', obExtATT: '0:00:30',
                  phonesX: '+12145550000 0:01:00 (1)' });   // triggers the child path
    }
    h.fn('writeCDRRowsToNeon')(rows);
    const lookups = log.sqls.filter(function (q) { return q.indexOf('FROM call_history_dept d') !== -1; });
    assert.equal(lookups.length, 3, '900 rows -> 3 id-lookup queries (400/400/100)');
    lookups.forEach(function (q) {
      const tuples = (q.match(/\(\?::date, \?, \?\)/g) || []).length;
      assert.ok(tuples <= 400, 'each lookup stays within the chunk cap (got ' + tuples + ')');
    });
  } finally { delete h.state.props.HMAC_SECRET; }
});

test('IMP-4: phone children are per-parent DELETE-then-insert (corrections + removals propagate)', function () {
  // Fake conn: the prepared parent-id lookup serves ids 11/12 for the two
  // payload parents; createStatement captures the inline child DELETE +
  // INSERT SQL so the sequence is observable.
  const log = { sqls: [], commits: 0, rollbacks: 0 };
  const idRows = [
    { id: 11, d: '2026-06-22', dept: 'CSR', agent: 'Anna' },
    { id: 12, d: '2026-06-22', dept: 'CSR', agent: 'Ben' },
  ];
  function conn() {
    return {
      setAutoCommit: function () {},
      prepareStatement: function (sql) {
        log.sqls.push(sql);
        let i = -1;
        return {
          setString: function () {}, setInt: function () {},
          execute: function () { return true; },
          executeQuery: function () {
            if (sql.indexOf('FROM call_history_dept d') === -1) throw new Error('unexpected query');
            return {
              next: function () { i++; return i < idRows.length; },
              getString: function (col) {
                return col === 2 ? idRows[i].d : col === 3 ? idRows[i].dept : idRows[i].agent;
              },
              getInt: function () { return idRows[i].id; },
              close: function () {},
            };
          },
          close: function () {},
        };
      },
      createStatement: function () {
        return { execute: function (sql) { log.sqls.push(sql); }, close: function () {} };
      },
      commit: function () { log.commits++; },
      rollback: function () { log.rollbacks++; },
      close: function () {},
    };
  }
  h.ctx.getReachableNeonConn_ = function () { return conn(); };
  h.state.props.HMAC_SECRET = 'test-secret';
  h.state.props.CDR_PHONES_MIRROR = 'on';   // R27: the phone path is gated
  try {
    const rows = [
      { callDate: '2026-06-22', dept: 'CSR', agentName: 'Anna',
        obExtTTT: '0:01:00', obExtATT: '0:00:30', phonesX: '+12145550000 0:01:00 (2)' },
      // Ben's re-imported row has NO entries left: the per-parent delete
      // alone is his correction (phantom entries removed).
      { callDate: '2026-06-22', dept: 'CSR', agentName: 'Ben',
        obExtTTT: '0:01:00', obExtATT: '0:00:30' },
    ];
    h.fn('writeCDRRowsToNeon')(rows);
    const del = log.sqls.filter(function (q) { return /^DELETE FROM call_history_phones/.test(q); });
    assert.equal(del.length, 1, 'one per-parent delete statement');
    assert.match(del[0], /call_history_id IN \(11,12\)/, 'BOTH looked-up parents cleared, incl. the now-empty one');
    const childInserts = log.sqls.filter(function (q) { return /^INSERT INTO call_history_phones/.test(q); });
    assert.ok(childInserts.length >= 1, 'entries re-inserted after the delete');
    assert.match(childInserts[0], /ON CONFLICT ON CONSTRAINT uq_phone_entry DO NOTHING/,
      'DO NOTHING kept as the intra-payload dup guard');
    // Sequence: delete strictly before the first child insert.
    assert.ok(log.sqls.indexOf(del[0]) < log.sqls.indexOf(childInserts[0]));
    assert.equal(log.commits, 2, 'parent commit + one child (delete+insert) commit');
  } finally { delete h.state.props.HMAC_SECRET; }
});
