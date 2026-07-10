'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// The last unit-coverage gap from the scan: the Neon writers' FIELD
// MAPPINGS (chunking/commit discipline is pinned by
// neon-write-chunking.test.js). A recording fake conn captures the SQL
// column list + every bound param (index, JDBC setter, value) so a
// column added/reordered on one side of the INSERT silently shifting
// every subsequent value now fails here instead of writing garbage.
// One copy suffices: neonWrite.js is INV-16 byte-identical across
// cdr-report / cdr-import (guard-enforced).

const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js'] });

function recConn(cap) {
  return {
    setAutoCommit: function () {},
    prepareStatement: function (sql) {
      cap.sql = sql;
      cap.params = [];
      return {
        setString: function (i, v) { cap.params[i - 1] = { m: 'string', v: v }; },
        setInt:    function (i, v) { cap.params[i - 1] = { m: 'int',    v: v }; },
        setDouble: function (i, v) { cap.params[i - 1] = { m: 'double', v: v }; },
        execute: function () { return true; },
        close: function () {},
      };
    },
    createStatement: function () { return { execute: function () {}, close: function () {} }; },
    commit: function () {}, rollback: function () {}, close: function () {},
  };
}

function install(cap) {
  h.ctx.getReachableNeonConn_ = function () { return recConn(cap); };
}

// First parenthesized group of the INSERT = the column list.
function columnsOf(sql) {
  return sql.match(/\(([^)]+)\)/)[1].split(',').map(function (s) { return s.trim(); });
}

function values(cap) { return cap.params.map(function (p) { return p ? p.v : undefined; }); }
function methods(cap) { return cap.params.map(function (p) { return p ? p.m : undefined; }); }

test('DQE writer: 34 params bind in the dqe_history column order', function () {
  const cap = {};
  install(cap);
  h.fn('writeDQERowsToNeon')([{
    monthYear: 'June 2026', callDate: '06/22/2026', agentName: 'Anna',
    queueExtensions: '103,204', totalUnique: 5, totalRung: 10, totalMissed: 2,
    totalAnswered: 8, ttt: '0:15:03', att: '0:03:01',
    // Sparse slots: index 0 + 2 populated, 1 empty -> NULL, rest absent -> NULL.
    slots: ['9:00:00', '', '10:23:33,10:08:41'],
    abParentIds: 'PA,PB', abMissedIds: 'QA', abMissedTimes: '9:05:00',
    avgAbdWait: '0:00:40', csrAvgAbdWait: '',
  }]);

  assert.deepEqual(columnsOf(cap.sql), [
    'month_year', 'call_date', 'agent_name', 'queue_extensions',
    'total_unique', 'total_rung', 'total_missed', 'total_answered', 'ttt', 'att',
    'slot_0800_0830', 'slot_0830_0900', 'slot_0900_0930', 'slot_0930_1000', 'slot_1000_1030',
    'slot_1030_1100', 'slot_1100_1130', 'slot_1130_1200', 'slot_1200_1230', 'slot_1230_1300',
    'slot_1300_1330', 'slot_1330_1400', 'slot_1400_1430', 'slot_1430_1500', 'slot_1500_1530',
    'slot_1530_1600', 'slot_1600_1630', 'slot_1630_1700', 'slot_1700_1730',
    'abandoned_parent_ids', 'abandoned_missed_ids', 'abandoned_missed_times',
    'avg_abd_wait', 'csr_avg_abd_wait',
  ]);
  assert.equal(cap.params.length, 34);
  assert.deepEqual(values(cap), [
    'June 2026', '2026-06-22', 'Anna', '103,204',   // MM/DD/YYYY -> ISO (parseDateForNeon)
    5, 10, 2, 8, '0:15:03', '0:03:01',
    '9:00:00', null, '10:23:33,10:08:41',            // '' and absent slots -> NULL
    null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null,
    'PA,PB', 'QA', '9:05:00',
    '0:00:40', null,                                 // normalizeDuration: '' -> NULL
  ]);
  // JDBC setter types: counts are ints, everything else strings here.
  assert.deepEqual(methods(cap).slice(4, 10),
    ['int', 'int', 'int', 'int', 'string', 'string']);
});

test('QCD writer: 12 params bind in the qcd_history column order (pct is a double)', function () {
  const cap = {};
  install(cap);
  h.fn('writeQCDRowsToNeon')([{
    monthYear: 'June 2026', week: 'Week 4', callDate: '06/22/2026',
    callQueue: 'A_Q_CSR', callSource: 'Total Calls',
    totalCalls: 100, totalAnswered: 90, abandoned: 10,
    longestWait: '0:01:00', avgAnswer: '0:00:20', abandonedPct: 10, violations: 1,
  }]);

  assert.deepEqual(columnsOf(cap.sql), [
    'month_year', 'week', 'call_date', 'call_queue', 'call_source',
    'total_calls', 'total_answered', 'abandoned', 'longest_wait', 'avg_answer',
    'abandoned_pct', 'violations',
  ]);
  assert.deepEqual(values(cap), [
    'June 2026', 'Week 4', '2026-06-22', 'A_Q_CSR', 'Total Calls',
    100, 90, 10, '0:01:00', '0:00:20', 10, 1,
  ]);
  assert.equal(methods(cap)[10], 'double');   // abandoned_pct
  assert.equal(methods(cap)[11], 'int');      // violations
});

test('CDR writer (no HMAC): 21 params bind in the call_history_dept order; JSONB fields NULL', function () {
  const cap = {};
  install(cap);
  delete h.state.props.HMAC_SECRET;   // no secret -> name-list JSONB skipped
  const res = h.fn('writeCDRRowsToNeon')([{
    callDate: '2026-06-22', dept: 'CSR', agentName: 'Anna',
    obTotal: '7', obAns: '5', obMiss: '2',
    ibTotal: '20', ibAns: '18', ibMiss: '2', ibAnsInt: '3', ibAnsExt: '15',
    obExtTotal: '4', obExtAns: '3', obExtTTT: '0:10:00', obExtATT: '0:02:30',
  }]);

  assert.deepEqual(columnsOf(cap.sql), [
    'call_date', 'department', 'agent_name',
    'ob_total', 'ob_answered', 'ob_missed',
    'ob_list_total_entries', 'ob_list_answered_entries', 'ob_list_missed_entries',
    'ib_total', 'ib_answered', 'ib_missed',
    'ib_answered_internal', 'ib_answered_external',
    'ib_list_total_entries', 'ib_list_answered_entries', 'ib_list_missed_entries',
    'ob_ext_total', 'ob_ext_answered', 'ob_ext_ttt_sec', 'ob_ext_att_sec',
  ]);
  assert.deepEqual(values(cap), [
    '2026-06-22', 'CSR', 'Anna',
    7, 5, 2,
    null, null, null,          // JSONB name lists skipped without HMAC_SECRET
    20, 18, 2, 3, 15,
    null, null, null,
    4, 3, 600, 150,            // cdrTimeToSeconds_: 0:10:00 / 0:02:30
  ]);
  assert.equal(res.inserted, 1);
  assert.equal(res.phones, 0, 'no phone child rows without HMAC_SECRET');
});

test('IMP-12: external non-phone CNAM display names are masked to initials', function () {
  const out = JSON.parse(h.fn('cdrParseNameFieldJson_')(
    'Jane Doe (3) | SMITH JOHN (2), +13125550100 (1)', false, 'test-secret'));
  // Internal side stays raw (sheet-parity, accepted policy).
  assert.equal(out.internal[0].display, 'Jane Doe');
  assert.equal(out.internal[0].count, 3);
  // External personal name -> initials only; the raw name never lands in Neon.
  assert.equal(out.external[0].display, 'S.J.');
  assert.equal(out.external[0].phone_hash, null);
  assert.equal(out.external[0].count, 2);
  // External phone-shaped entries keep the existing hash-only shape.
  assert.equal(out.external[1].display, null);
  assert.ok(out.external[1].phone_hash, 'phone entry still hashed');
});
