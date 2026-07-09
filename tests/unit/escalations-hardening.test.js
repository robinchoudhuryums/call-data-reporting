'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Batch-5 Escalations hardening: the F-44 occurred_at validator and the
// F-45 row-level access gate. Both are pure -- no Neon / sheet doubles.

const h = loadGas({ files: ['Escalations.gs'] });

test('F-44: escCleanDateTime_ accepts the documented shapes only', function () {
  const f = h.fn('escCleanDateTime_');
  // Valid: bare ISO date, datetime-local (T), space-separated, with seconds.
  assert.equal(f('2026-01-05'), '2026-01-05');
  assert.equal(f('2026-01-05T14:30'), '2026-01-05T14:30');
  assert.equal(f('2026-01-05 14:30'), '2026-01-05 14:30');
  assert.equal(f('2026-01-05T14:30:59'), '2026-01-05T14:30:59');
  assert.equal(f('  2026-01-05T14:30  '), '2026-01-05T14:30'); // trimmed
  // Blank / null -> '' (stored NULL via NULLIF).
  assert.equal(f(''), '');
  assert.equal(f(null), '');
  assert.equal(f('   '), '');
});

test('F-44: out-of-range fields and trailing garbage return "" (stored NULL), not a Postgres throw', function () {
  const f = h.fn('escCleanDateTime_');
  // The old regex was unanchored at the end: these all "passed" validation
  // and died later in the ::timestamptz cast as an opaque save error.
  assert.equal(f('2026-01-01T99:99'), '');       // hour/min out of range
  assert.equal(f('2026-01-01junk'), '');         // trailing garbage
  assert.equal(f('2026-13-01'), '');             // month 13
  assert.equal(f('2026-00-10'), '');             // month 0
  assert.equal(f('2026-01-32'), '');             // day 32
  assert.equal(f('2026-01-05T14:30:60'), '');    // second 60
  assert.equal(f('2026-01-05T24:00'), '');       // hour 24
  assert.equal(f('not a date'), '');
  assert.equal(f('01/05/2026'), '');             // wrong shape entirely
});

test('F-45: escAssertRowAccess_ pins managers to the row\'s stored dept', function () {
  const f = h.fn('escAssertRowAccess_');
  const mgr = { role: 'manager', department: 'CSR' };
  assert.doesNotThrow(function () { f(mgr, 'CSR'); });
  assert.throws(function () { f(mgr, 'Sales'); }, /Not authorized for this department/);
  // Exact match only -- no case folding (matches the dashboard convention).
  assert.throws(function () { f(mgr, 'csr'); }, /Not authorized for this department/);
});

test('F-45: admins pass for ANY stored dept, including one no longer on the roster', function () {
  const f = h.fn('escAssertRowAccess_');
  const admin = { role: 'admin', department: null };
  // The reason the row gate is NOT assertDeptAccess_: a row whose stored
  // dept was renamed/retired after it was written must stay reachable by
  // admins, or it becomes permanently unresolvable.
  assert.doesNotThrow(function () { f(admin, 'CSR'); });
  assert.doesNotThrow(function () { f(admin, 'Renamed Legacy Dept'); });
  assert.doesNotThrow(function () { f(admin, null); });
});

test('F-45: unauthenticated / role-none callers are refused outright', function () {
  const f = h.fn('escAssertRowAccess_');
  assert.throws(function () { f(null, 'CSR'); }, /Not authorized\./);
  assert.throws(function () { f({ role: 'none' }, 'CSR'); }, /Not authorized\./);
});
