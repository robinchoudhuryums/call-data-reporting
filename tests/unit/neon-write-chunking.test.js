'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// F-21: the three Neon writers chunk their multi-row INSERTs (statement-size
// + 65,535-bind-param caps) while keeping ONE commit per writer call (the
// Neon write discipline). Fake JDBC conn counts statements, rows per
// statement, and commits.

const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js'] });

function fakeConn(log) {
  return {
    setAutoCommit: function () {},
    prepareStatement: function (sql) {
      // One "(?," per row placeholder -- counts the rows in this statement.
      log.stmtRows.push((sql.match(/\(\?[,:]/g) || []).length);
      return {
        setString: function () {}, setInt: function () {}, setDouble: function () {},
        execute: function () { return true; }, executeQuery: function () { throw new Error('unexpected'); },
        close: function () {},
      };
    },
    createStatement: function () { return { execute: function () {}, close: function () {} }; },
    commit: function () { log.commits++; },
    rollback: function () { log.rollbacks++; },
    close: function () { log.closed = true; },
  };
}

function install(log) {
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(log); };
}

test('F-21: writeDQERowsToNeon chunks at 400 rows/statement with ONE commit', function () {
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
  assert.equal(JSON.stringify(log.stmtRows), JSON.stringify([400, 400, 100]));
  assert.equal(log.commits, 1, 'single commit across all chunks');
  assert.equal(log.rollbacks, 0);
  assert.ok(log.closed, 'connection closed');
});

test('F-21: writeQCDRowsToNeon chunks at 1000 rows/statement with ONE commit', function () {
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
  assert.equal(JSON.stringify(log.stmtRows), JSON.stringify([1000, 1000, 500]));
  assert.equal(log.commits, 1);
});

test('F-21: writeCDRRowsToNeon (main insert, no HMAC) chunks at 500 rows with ONE commit', function () {
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const rows = [];
  for (let i = 0; i < 1100; i++) {
    rows.push({ callDate: '2026-06-22', dept: 'CSR', agentName: 'A' + i,
                obExtTTT: '0:01:00', obExtATT: '0:00:30' });
  }
  const res = h.fn('writeCDRRowsToNeon')(rows);
  assert.equal(res.inserted, 1100);
  assert.equal(JSON.stringify(log.stmtRows), JSON.stringify([500, 500, 100]));
  assert.equal(log.commits, 1);
});

test('daily-scale batches still produce exactly one statement (common path unchanged)', function () {
  const log = { stmtRows: [], commits: 0, rollbacks: 0 };
  install(log);
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ monthYear: 'June 2026', callDate: '06/22/2026', agentName: 'A' + i,
                queueExtensions: '', slots: [], abParentIds: '', abMissedIds: '',
                abMissedTimes: '', ttt: '0:01:00', att: '0:01:00' });
  }
  h.fn('writeDQERowsToNeon')(rows);
  assert.equal(JSON.stringify(log.stmtRows), JSON.stringify([250]));
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
