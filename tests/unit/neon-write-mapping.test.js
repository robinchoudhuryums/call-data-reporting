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

test('DQE writer: 35 params bind in the dqe_history column order', function () {
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
    queueSplit: '{"A_Q_CSR":{"u":5,"r":10,"m":2,"a":8,"t":180,"n":1,"mt":"9:05:00"}}',
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
    'queue_split',                                   // sub-queue Phase 1
  ]);
  assert.equal(cap.params.length, 35);
  assert.deepEqual(values(cap), [
    'June 2026', '2026-06-22', 'Anna', '103,204',   // MM/DD/YYYY -> ISO (parseDateForNeon)
    5, 10, 2, 8, '0:15:03', '0:03:01',
    '9:00:00', null, '10:23:33,10:08:41',            // '' and absent slots -> NULL
    null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null,
    'PA,PB', 'QA', '9:05:00',
    '0:00:40', null,                                 // normalizeDuration: '' -> NULL
    '{"A_Q_CSR":{"u":5,"r":10,"m":2,"a":8,"t":180,"n":1,"mt":"9:05:00"}}',
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

// Ordered-recording conn for the P-6 tests: captures EVERY statement's SQL
// + bound params in execution order (recConn above keeps only the last one).
function seqConn(log) {
  function stmt(sql) {
    const entry = { sql: sql, params: [] };
    log.push(entry);
    return {
      setString: function (i, v) { entry.params[i - 1] = v; },
      setInt:    function (i, v) { entry.params[i - 1] = v; },
      setDouble: function (i, v) { entry.params[i - 1] = v; },
      execute: function (adhoc) { if (typeof adhoc === 'string') log.push({ sql: adhoc, params: [] }); return true; },
      close: function () {},
    };
  }
  return {
    setAutoCommit: function () {},
    prepareStatement: stmt,
    createStatement: function () { return stmt('(adhoc)'); },
    commit: function () {}, rollback: function () {}, close: function () {},
  };
}

test('P-6: authoritative CDR write deletes phone children THEN parents for the payload dates, before the insert', function () {
  const log = [];
  h.ctx.getReachableNeonConn_ = function () { return seqConn(log); };
  delete h.state.props.HMAC_SECRET;
  h.fn('writeCDRRowsToNeon')([
    { callDate: '2026-06-22', dept: 'CSR',   agentName: 'Anna' },
    { callDate: '2026-06-23', dept: 'Sales', agentName: 'Bob' },
    { callDate: '06/22/2026', dept: 'CSR',   agentName: 'Cara' },  // non-ISO -> parseDateForNeon, dedups into 06-22
  ], { authoritative: true });

  const sqls = log.map(function (e) { return e.sql; });
  assert.match(sqls[0], /DELETE FROM call_history_phones WHERE call_history_id IN \(SELECT id FROM call_history_dept WHERE call_date IN \(\?::date,\?::date\)\)/,
    'children deleted first, via the parent-id subselect');
  assert.deepEqual(Array.from(log[0].params), ['2026-06-22', '2026-06-23']);
  assert.match(sqls[1], /DELETE FROM call_history_dept WHERE call_date IN \(\?::date,\?::date\)/,
    'parents deleted second');
  assert.deepEqual(Array.from(log[1].params), ['2026-06-22', '2026-06-23']);
  assert.match(sqls[2], /INSERT INTO call_history_dept/, 'insert runs after both deletes');
});

test('P-6: non-authoritative CDR write issues no deletes (pre-P-6 behavior byte-identical)', function () {
  const log = [];
  h.ctx.getReachableNeonConn_ = function () { return seqConn(log); };
  delete h.state.props.HMAC_SECRET;
  h.fn('writeCDRRowsToNeon')([
    { callDate: '2026-06-22', dept: 'CSR', agentName: 'Anna' },
  ]);
  assert.ok(log.length >= 1, 'at least the insert ran');
  assert.match(log[0].sql, /INSERT INTO call_history_dept/, 'first statement is the insert');
  log.forEach(function (e) {
    assert.ok(!/DELETE FROM call_history/.test(e.sql), 'no authoritative delete without the flag');
  });
});

test('P-2: external-only NOP cells (leading separator) parse as EXTERNAL and mask', function () {
  // autoImport.js::join now emits "\n|\n" + ext when the internal side is
  // empty, so the parser's pipe contract holds for external-only cells.
  const out = JSON.parse(h.fn('cdrParseNameFieldJson_')(
    '\n|\nSMITH JOHN (2), +13125550100 (1)', false, 'test-secret'));
  assert.deepEqual(out.internal, [], 'no internal entries on an external-only cell');
  assert.equal(out.external[0].display, 'S.J.', 'external CNAM masked to initials');
  assert.equal(out.external[1].display, null);
  assert.ok(out.external[1].phone_hash, 'external phone entry hashed');
});

test('P-2 hardening: phone-shaped entries hash on the INTERNAL side too', function () {
  // A pre-fix external-only cell parses as internal (no pipe); no employee
  // name is phone-shaped, so the internal path also stores hash-only for
  // phone-shaped entries -- a raw number can no longer land in Neon JSONB.
  const out = JSON.parse(h.fn('cdrParseNameFieldJson_')(
    'Jane Doe (2), +13125550100 (1)', false, 'test-secret'));
  assert.equal(out.internal[0].display, 'Jane Doe', 'internal names stay raw (IMP-12 policy)');
  assert.equal(out.internal[1].display, null, 'internal phone-shaped entry not stored raw');
  assert.ok(out.internal[1].phone_hash, 'internal phone-shaped entry hashed');
});

test('P-2: autoImport join() always emits the separator when an external side exists', function () {
  const imp = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const join = imp.fn('join');
  assert.equal(join('a', 'b'), 'a\n|\nb', 'both sides unchanged');
  assert.equal(join('a', ''), 'a', 'internal-only unchanged');
  assert.equal(join('', ''), '', 'empty unchanged');
  assert.equal(join('', 'b'), '\n|\nb', 'external-only now carries the separator');
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


// ── I2-9 / I-5: parseDateForNeon returns an ISO-shaped cell VERBATIM ────────
//
// `new Date('2026-05-19')` is UTC midnight, which formatted in the script TZ
// (Chicago) is 2026-05-18 -- so every sheet-fed caller (the backfills, the
// deferred mirror's tail match, the duplicate-merge repair, the Direct
// backfill, the CSR repair/vet) keyed an ISO-text row one day early, where
// ON CONFLICT DO UPDATE then overwrote the WRONG date's row. The paste-old-rows
// flow and a yyyy-mm-dd number format both produce that cell shape.
test('I2-9: ISO-shaped cells are returned verbatim, never TZ-shifted', function () {
  const f = h.fn('parseDateForNeon');
  assert.equal(f('2026-05-19'), '2026-05-19');
  assert.equal(f(' 2026-05-19 '), '2026-05-19');
  assert.equal(f('2026-05-19 10:23:33'), '2026-05-19', 'ISO date + time keeps the date part');
  // The M/D/YYYY display path is unchanged.
  assert.equal(f('5/19/2026'), '2026-05-19');
  assert.equal(f('05/19/2026 10:23:33'), '2026-05-19');
  assert.equal(f(''), null);
  assert.equal(f(null), null);
  assert.equal(f('not a date'), null);
  // A 'T'-joined ISO INSTANT is a UTC timestamp: it still goes through the
  // Date parse + script-TZ format (Chicago is UTC-5 in May).
  assert.equal(f('2026-05-19T03:00:00Z'), '2026-05-18');
});

// ── R27: the call_history_phones write gate ────────────────────────────────
// The child rows are written only when CDR_PHONES_MIRROR is exactly 'on'.
// Unset = OFF (the deploy itself stops the table's growth); the main
// call_history_dept write is unaffected either way.
test('R27: phone children are gated OFF by default and ON only with CDR_PHONES_MIRROR=on', function () {
  const cap = {};
  install(cap);
  h.state.props.HMAC_SECRET = 'secret';
  let childCalls = 0;
  const realChild = h.ctx.cdrInsertPhoneChildRows_;
  h.ctx.cdrInsertPhoneChildRows_ = function () { childCalls++; return 7; };
  try {
    const row = { callDate: '2026-06-22', dept: 'CSR', agentName: 'Anna', phonesX: '555-0100 (0:01:00)' };
    delete h.state.props.CDR_PHONES_MIRROR;
    let res = h.fn('writeCDRRowsToNeon')([row]);
    assert.equal(res.inserted, 1, 'the parent row still writes');
    assert.equal(childCalls, 0, 'unset -> no phone children');
    assert.equal(res.phones, 0);
    assert.equal(res.phonesGated, true);

    h.state.props.CDR_PHONES_MIRROR = 'off';
    res = h.fn('writeCDRRowsToNeon')([row]);
    assert.equal(childCalls, 0, 'anything but "on" is off');

    h.state.props.CDR_PHONES_MIRROR = 'ON';
    res = h.fn('writeCDRRowsToNeon')([row]);
    assert.equal(childCalls, 1, '"on" (case-insensitive) writes them');
    assert.equal(res.phones, 7);
    assert.equal(res.phonesGated, false);

    // The deferred off-path mirror honors the same gate.
    delete h.state.props.CDR_PHONES_MIRROR;
    const m = h.fn('mirrorCdrPhonesToNeon')([row]);
    assert.deepEqual(JSON.parse(JSON.stringify(m)), { phones: 0, skipped: 0, phonesGated: true });
    assert.equal(childCalls, 1);
  } finally {
    h.ctx.cdrInsertPhoneChildRows_ = realChild;
    delete h.state.props.HMAC_SECRET;
    delete h.state.props.CDR_PHONES_MIRROR;
  }
});
