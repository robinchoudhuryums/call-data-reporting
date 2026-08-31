'use strict';

// insuranceNumbers.js (cdr-report) -- the {phone_hash -> insurer} reference
// table the Inbound report's insurer labels join against. Previously
// untested.
//
// Every failure mode in this file is SELF-CONCEALING: a number that
// normalizes to a form the call side never produces simply hashes to
// something no row matches, so the insurer silently renders as
// "(unlabeled)". There is no error, no count discrepancy, and nothing on the
// Health page -- the label just quietly never appears. REP-7 was exactly
// this (10-digit sheet entries could never match the "+1XXXXXXXXXX" call-side
// hashes), which is why the normalizer is pinned input-by-input here.
//
// The other pinned contract is CROSS-PROJECT: hashPhone (cdr-report) and
// cdrHashPhone_ (cdr-import/neonWrite.js) are two hand-maintained
// implementations that MUST agree, or the reference table and the mirrored
// call rows are hashed under different rules and nothing ever joins. The
// files are in different projects, so check-duplicated-files.sh does not
// cover the pair; this asserts it behaviorally.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({
  project: 'cdr-report',
  files: ['dbHistorical.js', 'insuranceNumbers.js'],
  capture: ['INSURANCE_BLOCK_START_COL', 'INSURANCE_BLOCK_END_COL'],
});
const START = h.consts.INSURANCE_BLOCK_START_COL;   // col X (24)
const END   = h.consts.INSURANCE_BLOCK_END_COL;     // col AG (33)

// A "DO NOT EDIT!" grid wide enough to hold the insurance block. The fake
// sheet ENFORCES getMaxColumns (F-5/F-6), so a short grid throws rather than
// silently reading blanks.
function rosterWithInsurance(columns) {
  const width = END + 2;
  const rows = [];
  const maxLen = Math.max.apply(null, columns.map(function (c) { return c.numbers.length; }).concat([0]));
  for (let r = 0; r <= maxLen; r++) rows.push(new Array(width).fill(''));
  columns.forEach(function (col, i) {
    const c = START - 1 + i;                       // 0-indexed grid position
    rows[0][c] = col.name;                         // header row
    col.numbers.forEach(function (n, j) { rows[j + 1][c] = n; });
  });
  return rows;
}

function read(columns) {
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': rosterWithInsurance(columns) },
  });
  return h.fn('readInsuranceNumberRows_')();
}

// ── The normalizer: every accepted form must land on ONE canonical string ──

test('all the punctuation variants of one number canonicalize identically', function () {
  // The sheet is admin-maintained by hand, so these are the shapes that
  // actually get pasted in. Any of them normalizing differently means that
  // insurer silently stops matching.
  const rows = read([{ name: 'Aetna', numbers: [
    '+18006334227', '18006334227', '+1 (800) 633-4227',
    '1-800-633-4227', ' +1 800 633 4227 ', '+1.800.633.4227',
  ] }]);
  assert.equal(rows.length, 6, 'every variant should be accepted');
  rows.forEach(function (r) {
    assert.equal(r.number, '+18006334227', 'variant did not canonicalize');
    assert.equal(r.insurance, 'Aetna');
  });
});

test('REP-7: a 10-digit entry gains the US country code rather than being accepted as-is', function () {
  // The call side hashes "+1XXXXXXXXXX". Accepting "+XXXXXXXXXX" verbatim
  // produced a hash that could never match, with no signal at all.
  const rows = read([{ name: 'Cigna', numbers: ['8006334227'] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, '+18006334227');
});

test('entries too short to be a phone number are dropped, not padded', function () {
  const rows = read([{ name: 'Humana', numbers: ['12345', '633-4227', '0', 'n/a', '+1'] }]);
  deepEqual(rows, []);
});

test('a column with no header is ignored even when it holds numbers', function () {
  // An unnamed column is an in-progress edit, not an insurer -- labelling
  // those calls with '' would be worse than leaving them unlabeled.
  const rows = read([
    { name: '',      numbers: ['+18001111111'] },
    { name: 'Aetna', numbers: ['+18002222222'] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].insurance, 'Aetna');
});

test('a header with surrounding whitespace is trimmed, not treated as distinct', function () {
  const rows = read([{ name: '  Aetna  ', numbers: ['+18006334227'] }]);
  assert.equal(rows[0].insurance, 'Aetna');
});

test('several insurers in adjacent columns are read independently', function () {
  const rows = read([
    { name: 'Aetna',  numbers: ['+18001111111', '+18001111112'] },
    { name: 'Cigna',  numbers: ['+18002222221'] },
    { name: 'Humana', numbers: ['+18003333331', '+18003333332', '+18003333333'] },
  ]);
  assert.equal(rows.length, 6);
  const byInsurer = {};
  rows.forEach(function (r) { byInsurer[r.insurance] = (byInsurer[r.insurance] || 0) + 1; });
  assert.deepEqual(byInsurer, { Aetna: 2, Cigna: 1, Humana: 3 });
});

test('a missing "DO NOT EDIT!" sheet returns empty rather than throwing', function () {
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  deepEqual(h.fn('readInsuranceNumberRows_')(), []);
});

// ── Cross-project hash equivalence ────────────────────────────────────────

test('hashPhone (cdr-report) matches cdrHashPhone_ (cdr-import) byte for byte', function () {
  // Two hand-maintained implementations in DIFFERENT projects, so the
  // INV-16 duplicated-files guard does not cover the pair. If they diverge,
  // the reference table and the mirrored call rows are hashed under
  // different rules and NOTHING joins -- every insurer goes silently
  // unlabeled, which looks identical to "these insurers never called".
  const hImport = loadGas({ project: 'cdr-import', files: ['neonWrite.js'] });
  const SECRET = 'test-secret-value';
  h.state.props.HMAC_SECRET = SECRET;

  ['+18006334227', '+15551234567', '+448001111111', '+1', 'not-a-number'].forEach(function (n) {
    const a = h.fn('hashPhone')(n);
    const b = hImport.fn('cdrHashPhone_')(n, SECRET);
    assert.equal(a, b, 'hash divergence for ' + JSON.stringify(n));
    assert.match(a, /^[0-9a-f]{64}$/, 'expected 64-char lowercase hex');
  });
});

test('both hash implementations return null for an empty input', function () {
  const hImport = loadGas({ project: 'cdr-import', files: ['neonWrite.js'] });
  h.state.props.HMAC_SECRET = 'test-secret-value';
  ['', '   ', null, undefined].forEach(function (n) {
    assert.equal(h.fn('hashPhone')(n), null, 'cdr-report hashPhone(' + JSON.stringify(n) + ')');
    assert.equal(hImport.fn('cdrHashPhone_')(n, 'test-secret-value'), null,
      'cdr-import cdrHashPhone_(' + JSON.stringify(n) + ')');
  });
});

// ── The PHI contract + the sync's replace semantics ───────────────────────

// Captures everything the sync binds or executes, so we can assert on the
// FULL set of values that would reach Neon.
function runSync(columns, opts) {
  opts = opts || {};
  h.state.props.HMAC_SECRET = opts.secret === undefined ? 'test-secret-value' : opts.secret;
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': rosterWithInsurance(columns) },
  });
  const executed = [], bound = [], events = [];
  h.ctx.getNeonConn = function () {
    return {
      setAutoCommit: function () {},
      createStatement: function () {
        return { execute: function (sql) { executed.push(sql); }, close: function () {} };
      },
      prepareStatement: function () {
        let cur = {};
        return {
          setString: function (i, v) { cur[i] = v; },
          execute: function () { bound.push([cur[1], cur[2]]); cur = {}; },
          close: function () {},
        };
      },
      commit: function () { events.push('commit'); },
      rollback: function () { events.push('rollback'); },
      close: function () { events.push('close'); },
    };
  };
  h.fn('syncInsuranceNumbersToNeon')();
  return { executed: executed, bound: bound, events: events };
}

test('PHI: only the hash and the label reach Neon -- never the raw number', function () {
  // The entire design rests on this: insurer lines are not PHI, but the
  // table lives beside call data and the raw numbers must not travel.
  const NUMBER = '+18006334227';
  const out = runSync([{ name: 'Aetna', numbers: [NUMBER] }]);

  assert.equal(out.bound.length, 1);
  const [hash, label] = out.bound[0];
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(label, 'Aetna');

  const everything = JSON.stringify(out.bound) + JSON.stringify(out.executed);
  assert.ok(everything.indexOf(NUMBER) === -1, 'the raw number reached Neon');
  assert.ok(everything.indexOf('8006334227') === -1, 'the raw digits reached Neon');
});

test('the sync is a FULL replace, so a number removed from the sheet disappears', function () {
  const out = runSync([{ name: 'Aetna', numbers: ['+18006334227'] }]);
  assert.ok(out.executed.some(function (s) { return /DELETE FROM insurance_numbers/.test(s); }),
    'without the DELETE, a de-listed number keeps its label forever');
  assert.ok(out.executed.some(function (s) { return /CREATE TABLE IF NOT EXISTS insurance_numbers/.test(s); }));
  assert.deepEqual(out.events, ['commit', 'close']);
});

test('the same number under two insurers collapses to ONE row (last wins)', function () {
  // phone_hash is the PRIMARY KEY, so an un-deduped second insert would
  // abort the whole transaction and leave the table empty.
  const out = runSync([
    { name: 'Aetna', numbers: ['+18006334227'] },
    { name: 'Cigna', numbers: ['+1 (800) 633-4227'] },   // same number, different form
  ]);
  assert.equal(out.bound.length, 1, 'the duplicate hash must be collapsed before insert');
  assert.equal(out.bound[0][1], 'Cigna', 'last listed insurer wins');
});

test('no HMAC secret: the sync aborts BEFORE opening a connection', function () {
  h.state.props.HMAC_SECRET = '';
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': rosterWithInsurance([{ name: 'Aetna', numbers: ['+18006334227'] }]) },
  });
  let opened = 0;
  h.ctx.getNeonConn = function () { opened++; throw new Error('should not be reached'); };
  assert.doesNotThrow(function () { h.fn('syncInsuranceNumbersToNeon')(); });
  assert.equal(opened, 0, 'hashing with an empty secret would write junk hashes '
    + 'that match nothing, and the DELETE would have already run');
});

test('an empty sheet block aborts before opening a connection too', function () {
  // Otherwise the DELETE would run and wipe a good table on an accidental
  // run against a sheet whose block has been cleared.
  h.state.props.HMAC_SECRET = 'test-secret-value';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterWithInsurance([]) } });
  let opened = 0;
  h.ctx.getNeonConn = function () { opened++; throw new Error('should not be reached'); };
  assert.doesNotThrow(function () { h.fn('syncInsuranceNumbersToNeon')(); });
  assert.equal(opened, 0);
});
