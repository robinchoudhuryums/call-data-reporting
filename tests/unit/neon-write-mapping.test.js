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
    // R38: the INSERT itself is an inline statement now -- record its SQL.
    createStatement: function () {
      return { execute: function (sql) { (cap.inline = cap.inline || []).push(sql); return true; }, close: function () {} };
    },
    commit: function () { cap.commits = (cap.commits || 0) + 1; }, rollback: function () {}, close: function () {},
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

// R38: the daily writers render INLINE tuples (dollar-quoted text, bare
// numbers, 'iso'::date, $..$::jsonb). This tokenizer walks the VALUES list
// dollar-quote-aware and decodes each token back to the value the old bound
// setter would have carried, so the column-order pins below compare the
// same lists they always did.
function rawTuplesOf(sql) {
  const at = sql.indexOf(') VALUES ');
  const vals = at >= 0 ? sql.slice(at + 9) : sql;
  const out = [];
  let i = 0;
  while (i < vals.length) {
    if (vals.startsWith(' ON CONFLICT', i)) break;
    if (vals[i] !== '(') { i++; continue; }
    i++;
    const tuple = []; let tok = '';
    while (i < vals.length) {
      const c = vals[i];
      if (c === '$') {
        const m = /^\$([a-z]*)\$/.exec(vals.slice(i));
        const tag = m[0];
        const end = vals.indexOf(tag, i + tag.length);
        tok += vals.slice(i, end + tag.length); i = end + tag.length; continue;
      }
      if (c === "'") { const end = vals.indexOf("'", i + 1); tok += vals.slice(i, end + 1); i = end + 1; continue; }
      if (c === ',') { tuple.push(tok); tok = ''; i++; continue; }
      if (c === ')') { tuple.push(tok); i++; break; }
      tok += c; i++;
    }
    out.push(tuple);
  }
  return out;
}
function decodeTok(t) {
  t = t.trim();
  if (t === 'NULL') return null;
  let m = /^\$([a-z]*)\$([\s\S]*)\$\1\$(::jsonb)?$/.exec(t);
  if (m) return m[2];
  m = /^'([^']*)'::date$/.exec(t);
  if (m) return m[1];
  if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(t)) return Number(t);
  return t;
}
function tuplesOf(sql) { return rawTuplesOf(sql).map(function (t) { return t.map(decodeTok); }); }

function lastInsert(cap) {
  const ins = (cap.inline || []).filter(function (q) { return /^INSERT INTO/.test(q); });
  return ins[ins.length - 1];
}

test('DQE writer: 35 params bind in the dqe_history column order', function () {
  const cap = {};
  install(cap);
  // Batch 3: the after-hours DDL is memoized per execution -- reset it so
  // this test observes the self-upgrade regardless of suite ordering.
  h.ctx.DQE_AFTER_HOURS_COLUMNS_READY_ = false;
  h.fn('writeDQERowsToNeon')([{
    monthYear: 'June 2026', callDate: '06/22/2026', agentName: 'Anna',
    queueExtensions: '103,204', totalUnique: 5, totalRung: 10, totalMissed: 2,
    totalAnswered: 8, ttt: '0:15:03', att: '0:03:01',
    // Sparse slots: index 0 + 2 populated, 1 empty -> NULL, rest absent -> NULL.
    slots: ['9:00:00', '', '10:23:33,10:08:41'],
    abParentIds: 'PA,PB', abMissedIds: 'QA', abMissedTimes: '9:05:00',
    avgAbdWait: '0:00:40', csrAvgAbdWait: '',
    queueSplit: '{"A_Q_CSR":{"u":5,"r":10,"m":2,"a":8,"t":180,"n":1,"mt":"9:05:00"}}',
    afterHoursAnswered: 1, afterHoursTtt: 240,         // Batch 3 (AJ/AK)
  }]);

  const dqeSql = lastInsert(cap);
  assert.deepEqual(columnsOf(dqeSql), [
    'month_year', 'call_date', 'agent_name', 'queue_extensions',
    'total_unique', 'total_rung', 'total_missed', 'total_answered', 'ttt', 'att',
    'slot_0800_0830', 'slot_0830_0900', 'slot_0900_0930', 'slot_0930_1000', 'slot_1000_1030',
    'slot_1030_1100', 'slot_1100_1130', 'slot_1130_1200', 'slot_1200_1230', 'slot_1230_1300',
    'slot_1300_1330', 'slot_1330_1400', 'slot_1400_1430', 'slot_1430_1500', 'slot_1500_1530',
    'slot_1530_1600', 'slot_1600_1630', 'slot_1630_1700', 'slot_1700_1730',
    'abandoned_parent_ids', 'abandoned_missed_ids', 'abandoned_missed_times',
    'avg_abd_wait', 'csr_avg_abd_wait',
    'queue_split',                                   // sub-queue Phase 1
    'after_hours_answered', 'after_hours_ttt',       // Batch 3
  ]);
  const dqeTuples = tuplesOf(dqeSql);
  assert.equal(dqeTuples.length, 1);
  assert.equal(dqeTuples[0].length, 37);
  assert.equal(cap.params, undefined, 'R38: no bound statement on the normal path');
  assert.deepEqual(dqeTuples[0], [
    'June 2026', '2026-06-22', 'Anna', '103,204',   // MM/DD/YYYY -> ISO (parseDateForNeon)
    5, 10, 2, 8, '0:15:03', '0:03:01',
    '9:00:00', null, '10:23:33,10:08:41',            // '' and absent slots -> NULL
    null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null,
    'PA,PB', 'QA', '9:05:00',
    '0:00:40', null,                                 // normalizeDuration: '' -> NULL
    '{"A_Q_CSR":{"u":5,"r":10,"m":2,"a":8,"t":180,"n":1,"mt":"9:05:00"}}',
    1, 240,                                          // Batch 3: bare ints
  ]);
  // Batch 3: the DDL self-upgrade adds BOTH after-hours columns idempotently.
  const ddl = (cap.inline || []).filter(function (q) { return /^ALTER TABLE/.test(q); }).join('\n');
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS after_hours_answered integer/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS after_hours_ttt integer/);
  // and the upsert COALESCEs them (a narrower sheet's NULL never erases a value).
  assert.match(dqeSql, /after_hours_answered = COALESCE\(EXCLUDED\.after_hours_answered, dqe_history\.after_hours_answered\)/);
  assert.match(dqeSql, /after_hours_ttt = COALESCE\(EXCLUDED\.after_hours_ttt, dqe_history\.after_hours_ttt\)/);
  // Renderings: counts are bare ints, everything else dollar-quoted text.
  const raw = rawTuplesOf(dqeSql)[0];
  assert.deepEqual(raw.slice(4, 8), ['5', '10', '2', '8']);
  assert.match(raw[8], /^\$nq\$0:15:03\$nq\$$/);
  assert.equal(raw[11], 'NULL');
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

  const qcdSql = lastInsert(cap);
  assert.deepEqual(columnsOf(qcdSql), [
    'month_year', 'week', 'call_date', 'call_queue', 'call_source',
    'total_calls', 'total_answered', 'abandoned', 'longest_wait', 'avg_answer',
    'abandoned_pct', 'violations',
  ]);
  assert.deepEqual(tuplesOf(qcdSql)[0], [
    'June 2026', 'Week 4', '2026-06-22', 'A_Q_CSR', 'Total Calls',
    100, 90, 10, '0:01:00', '0:00:20', 10, 1,
  ]);
  const qraw = rawTuplesOf(qcdSql)[0];
  assert.equal(qraw[10], '10', 'abandoned_pct is a bare number');
  assert.equal(qraw[11], '1');
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

  const cdrSql = lastInsert(cap);
  assert.deepEqual(columnsOf(cdrSql), [
    'call_date', 'department', 'agent_name',
    'ob_total', 'ob_answered', 'ob_missed',
    'ob_list_total_entries', 'ob_list_answered_entries', 'ob_list_missed_entries',
    'ib_total', 'ib_answered', 'ib_missed',
    'ib_answered_internal', 'ib_answered_external',
    'ib_list_total_entries', 'ib_list_answered_entries', 'ib_list_missed_entries',
    'ob_ext_total', 'ob_ext_answered', 'ob_ext_ttt_sec', 'ob_ext_att_sec',
  ]);
  assert.deepEqual(tuplesOf(cdrSql)[0], [
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
    // R38: an inline statement is logged when EXECUTED, in order with the binds.
    createStatement: function () {
      return { execute: function (sql) { log.push({ sql: sql, params: [] }); return true; }, close: function () {} };
    },
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

test('Batch 4: a BARE NUMBER (a serial rendered by a numeric format) is refused, never read as a year', function () {
  const f = h.fn('parseDateForNeon');
  // Before the guard `new Date('45726')` was the year 45726 -> '45726-01-01',
  // a valid-looking ISO that every sheet-fed caller would have keyed a row on.
  assert.equal(f('45726'), null);
  assert.equal(f(' 45726.5 '), null);
  assert.equal(f('0'), null);
  assert.equal(f('-3'), null);
  // The date-shaped inputs are untouched.
  assert.equal(f('5/19/2026'), '2026-05-19');
  assert.equal(f('2026-05-19'), '2026-05-19');
  assert.equal(f('May 19, 2026'), '2026-05-19', 'a free-form date string still parses');
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


// ── R38: the inline path -- escaping, numbers, parity with the bound path, fallback ──
test('R38: neonSqlLit_ dollar-quotes text byte-for-byte (quotes, backslashes, tag collision, NUL)', function () {
  const lit = h.fn('neonSqlLit_');
  assert.equal(lit(null), 'NULL');
  assert.equal(lit(undefined), 'NULL');
  assert.equal(lit(''), '$nq$$nq$', 'empty string stays an empty string, never NULL');
  assert.equal(lit("O'Brien"), "$nq$O'Brien$nq$", 'no quote doubling needed under dollar quoting');
  assert.equal(lit('{"n":"A \\"B\\" \\\\ C"}'), '$nq${"n":"A \\"B\\" \\\\ C"}$nq$', 'JSON backslashes untouched');
  assert.equal(lit('price $nq$ tag'), '$nqx$price $nq$ tag$nqx$', 'a value containing the tag gets a longer tag');
  assert.equal(lit('a\u0000b'), '$nq$ab$nq$', 'NUL stripped');
  assert.equal(lit(42), '$nq$42$nq$', 'a number given to the text renderer is text (setString semantics)');
  assert.equal(h.fn('neonSqlInt_')('7'), '7');
  assert.equal(h.fn('neonSqlInt_')(4.9), '4');
  assert.equal(h.fn('neonSqlInt_')('abc'), '0');
  assert.equal(h.fn('neonSqlInt_')(null), '0');
  assert.equal(h.fn('neonSqlNum_')(4.17), '4.17');
  assert.equal(h.fn('neonSqlNum_')('0.5'), '0.5');
  assert.equal(h.fn('neonSqlNum_')(NaN), '0');
  assert.equal(h.fn('neonSqlJson_')(null), 'NULL');
  assert.equal(h.fn('neonSqlJson_')('{"a":1}'), '$nq${"a":1}$nq$::jsonb');
  assert.throws(function () { h.fn('neonSqlDate_')('6/22/2026'); }, /ISO date required/);
});

// The strongest pin: for one representative row per writer, the decoded
// inline tuple equals, field for field, what the ORIGINAL bound statement
// (kept as the fallback) binds for the same row.
function boundValuesFor(boundFn, args) {
  const cap = {};
  const conn = recConn(cap);
  h.fn(boundFn).apply(null, [conn].concat(args));
  return values(cap);
}
test('R38 parity: DQE inline tuple == bound params, field for field', function () {
  const row = { monthYear: 'June 2026', callDate: '06/22/2026', agentName: "Anna O'Neil",
    queueExtensions: '103,204', totalUnique: 5, totalRung: '10', totalMissed: 2, totalAnswered: 8,
    ttt: '0:15:03', att: '0:03:01', slots: ['9:00:00', '', '10:23:33,10:08:41'],
    abParentIds: 'PA,PB', abMissedIds: 'QA', abMissedTimes: '9:05:00', avgAbdWait: '0:00:40', csrAvgAbdWait: '',
    queueSplit: '{"A_Q_CSR":{"u":5,"r":10,"m":2,"a":8,"t":180,"n":1,"mt":"9:05:00"}}',
    afterHoursAnswered: '3', afterHoursTtt: 615 };   // Batch 3: a string count coerces like totalRung
  const inline = tuplesOf('INSERT INTO x (a) VALUES ' + h.fn('dqeInlineTuple_')(row))[0];
  const bound = boundValuesFor('dqeBoundInsert_', [[row]]);
  assert.equal(inline.length, 37); assert.equal(bound.length, 37);
  // setInt coerces '10' -> 10 on the bridge; the inline renderer parses it.
  bound[5] = Number(bound[5]);
  // Batch 3: the after-hours pair binds as STRINGS through NULLIF(?, '')::int
  // (Postgres casts), so the bound values are the inline ints as text.
  bound[35] = Number(bound[35]); bound[36] = Number(bound[36]);
  assert.deepEqual(inline, bound);
  // A row without the pair (a pre-Batch-3 sheet re-mirrored) sends NULL on
  // BOTH transports -- the COALESCE contract depends on it.
  const bare = Object.assign({}, row); delete bare.afterHoursAnswered; delete bare.afterHoursTtt;
  const inlineBare = tuplesOf('INSERT INTO x (a) VALUES ' + h.fn('dqeInlineTuple_')(bare))[0];
  const boundBare = boundValuesFor('dqeBoundInsert_', [[bare]]);
  assert.deepEqual(inlineBare.slice(35), [null, null]);
  assert.deepEqual(boundBare.slice(35), [null, null]);
});
test('R38 parity: QCD inline tuple == bound params, field for field', function () {
  const row = { monthYear: 'June 2026', week: 'Week 4', callDate: '06/22/2026', callQueue: "A_Q_Sales's",
    callSource: 'Total Calls', totalCalls: 100, totalAnswered: 90, abandoned: 10,
    longestWait: '0:01:00', avgAnswer: '', abandonedPct: 4.17, violations: 1 };
  const inline = tuplesOf('INSERT INTO x (a) VALUES ' + h.fn('qcdInlineTuple_')(row))[0];
  const bound = boundValuesFor('qcdBoundInsert_', [[row]]);
  assert.deepEqual(inline, bound);
});
test('R38 parity: CDR inline tuple == bound params (HMAC on: JSON name lists ride as jsonb literals)', function () {
  const row = { callDate: '2026-06-22', dept: 'CSR', agentName: 'Anna "A" Smith',
    obTotal: '7', obAns: '5', obMiss: '2', obListTot: 'SMITH JOHN (2), +13125550100 (1)', obListAns: '', obListMiss: null,
    ibTotal: '20', ibAns: '18', ibMiss: '2', ibAnsInt: '3', ibAnsExt: '15',
    ibListTot: '\n|\nDOE JANE (1)', ibListAns: '', ibListMiss: '',
    obExtTotal: '4', obExtAns: '3', obExtTTT: '0:10:00', obExtATT: '0:02:30' };
  const inline = tuplesOf('INSERT INTO x (a) VALUES ' + h.fn('cdrInlineTuple_')(row, true, 'test-secret'))[0];
  const bound = boundValuesFor('cdrBoundInsert_', [[row], true, 'test-secret']);
  assert.equal(inline.length, 21);
  assert.deepEqual(inline, bound);
  assert.ok(typeof inline[6] === 'string' && inline[6].indexOf('"phone_hash"') >= 0, 'the JSON list survives the round trip');
  const raw = rawTuplesOf('INSERT INTO x (a) VALUES ' + h.fn('cdrInlineTuple_')(row, true, 'test-secret'))[0];
  assert.match(raw[6], /\$nq\$\{.*\}\$nq\$::jsonb$/, 'jsonb cast on the literal');
});

test('R38: an oversize row falls back to the bound statement; the rest stay inline; one commit', function () {
  const cap = {};
  install(cap);
  const mk = function (agent, ids) {
    return { monthYear: 'June 2026', callDate: '06/22/2026', agentName: agent, queueExtensions: '',
             slots: [], abParentIds: ids, abMissedIds: '', abMissedTimes: '', ttt: '0:01:00', att: '0:01:00' };
  };
  const huge = new Array(3200).fill('1762242202191').join(',');   // ~45 KB: cannot fit a statement alone
  const res = h.fn('writeDQERowsToNeon')([mk('A', 'x'), mk('B', huge), mk('C', 'y')]);
  assert.equal(res.inserted, 3);
  assert.equal((cap.inline || []).length, 2, 'A flushed before the fallback, C after it');
  assert.equal(cap.params.length, 37, 'B went through the original bound statement (35 + the Batch 3 pair)');
  assert.equal(cap.params[29].v, huge);
  assert.equal(cap.commits, 1, 'still ONE commit for the whole write');
  assert.deepEqual(tuplesOf(cap.inline[0])[0].slice(2, 3), ['A']);
  assert.deepEqual(tuplesOf(cap.inline[1])[0].slice(2, 3), ['C']);
});
