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

// -- Phase 2: external-submission review verbs --------------------------------

// Fake JDBC conn: escRowFull_/escRowMeta_ SELECTs return `row`; every other
// prepared statement records its SQL + bound params into `log.writes`.
function reviewConn(row, log) {
  return {
    createStatement: function () { return { execute: function () {}, close: function () {} }; },
    prepareStatement: function (sql) {
      const params = [];
      return {
        setString: function (i, v) { params[i - 1] = v; },
        executeQuery: function () {
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return !!row; },
            getString: function (col) {
              const map = { status: row.status, department: row.department,
                caller: row.caller, patient_name: row.patientName, trx: row.trx,
                area: row.area, reason: row.reason, source: row.source, n: row.n };
              return map[col] == null ? null : map[col];
            },
            close: function () {},
          };
        },
        execute: function () { log.writes.push({ sql: sql, params: params.slice() }); return true; },
        close: function () {},
      };
    },
    setAutoCommit: function () {},
    commit: function () { log.commits = (log.commits || 0) + 1; },
    rollback: function () { log.rollbacks = (log.rollbacks || 0) + 1; },
    close: function () {},
  };
}

function installReview(user, row, log) {
  h.ctx.resolveUser_ = function () { return user; };
  h.ctx.getDashboardNeonConn_ = function () { return reviewConn(row, log); };
  h.state.userEmail = user.email || 'mgr@x.com';
}

test('Phase 2: approve promotes a pending_review row to pending with NORMALIZED fields', function () {
  const log = { writes: [] };
  const longCaller = new Array(5000).join('x');   // over the 4000 cap
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending_review', department: 'CSR', caller: '  ' + longCaller,
      patientName: ' Pat ', trx: 'T1', area: '', reason: '  needs a callback  ',
      source: 'team-tools' }, log);
  const res = h.call('approveEscalation', { id: 'e1' });
  assert.equal(res.id, 'e1');
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.ok(upd, 'primary UPDATE ran');
  assert.equal(upd.params[0], 'pending');                 // promoted
  assert.equal(upd.params[1].length, 4000, 'caller capped at ESC_MAX_TEXT');
  assert.equal(upd.params[2], 'Pat', 'trimmed');
  assert.equal(upd.params[5], 'needs a callback');        // reason normalized
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.ok(act, 'activity row written in the same txn');
  assert.equal(act.params[2], 'approved');
  assert.equal(log.commits, 1, 'one commit (atomic)');
});

test('Phase 2: approve is pending_review-ONLY and per-dept gated', function () {
  const log = { writes: [] };
  // Wrong status: a normal pending row cannot be "approved".
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('approveEscalation', { id: 'e1' }); },
    /Only a pending-review submission/);
  // Wrong dept: the row gate (escAssertRowAccess_) refuses, nothing written.
  installReview({ role: 'manager', department: 'Sales', email: 'mgr@x.com' },
    { status: 'pending_review', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('approveEscalation', { id: 'e1' }); },
    /Not authorized for this department/);
  assert.equal(log.writes.length, 0, 'no writes on refusal');
});

test('Phase 2: a submission with an empty reason cannot be approved (untrusted-input boundary)', function () {
  const log = { writes: [] };
  installReview({ role: 'admin', department: null, email: 'admin@x.com' },
    { status: 'pending_review', department: 'CSR', reason: '   ', source: 'team-tools' }, log);
  assert.throws(function () { h.call('approveEscalation', { id: 'e1' }); },
    /no reason text/);
  assert.equal(log.writes.length, 0);
});

test('Phase 2: reject requires a reason, is pending_review-only, retains the row', function () {
  const log = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending_review', department: 'CSR', reason: 'r', source: 'team-tools' }, log);
  assert.throws(function () { h.call('rejectEscalation', { id: 'e1' }); },
    /reason for rejecting is required/);
  const res = h.call('rejectEscalation', { id: 'e1', reason: 'duplicate of e0' });
  assert.equal(res.id, 'e1');
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.equal(upd.params[0], 'rejected');
  assert.ok(upd.sql.indexOf('DELETE') === -1, 'row retained, never deleted');
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[2], 'rejected');
  assert.equal(act.params[4], 'duplicate of e0', 'reason lands in the trail');
  // A resolved row cannot be rejected.
  installReview({ role: 'admin', department: null, email: 'a@x.com' },
    { status: 'resolved', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('rejectEscalation', { id: 'e1', reason: 'x' }); },
    /Only a pending-review submission/);
});

test('Phase 2: escNormalizeReviewFields_ is the same escClean_ the create path uses', function () {
  const out = h.call('escNormalizeReviewFields_', {
    caller: '  a  ', patientName: null, trx: 'T', area: undefined,
    reason: '  why  ',
  });
  assert.equal(out.caller, 'a');
  assert.equal(out.patientName, '');
  assert.equal(out.reason, 'why');
});

test('NEO-1: resolveEscalation is PENDING-only -- pending_review and rejected rows are refused', function () {
  // The pre-fix guard was "not already resolved", which let a manager (a)
  // resolve an un-reviewed external submission WITHOUT passing
  // approveEscalation's trust boundary, and (b) walk a terminal rejected
  // row back into the worklist via resolve -> reopen.
  const log = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending_review', department: 'CSR', reason: 'r', source: 'team-tools' }, log);
  assert.throws(function () {
    h.call('resolveEscalation', { id: 'e1', resolution: 'called them back' });
  }, /awaiting review/);
  assert.equal(log.writes.length, 0, 'no writes on a pending_review refusal');

  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'rejected', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () {
    h.call('resolveEscalation', { id: 'e1', resolution: 'called them back' });
  }, /Only a pending escalation can be resolved/);
  assert.equal(log.writes.length, 0, 'no writes on a rejected refusal');

  // Resolved keeps its dedicated reopen-first message (F-43 unchanged).
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'resolved', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () {
    h.call('resolveEscalation', { id: 'e1', resolution: 'x' });
  }, /already resolved.*Reopen it first/);
  assert.equal(log.writes.length, 0);

  // A genuinely pending row still resolves, with its activity row.
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  const res = h.call('resolveEscalation', { id: 'e1', resolution: 'called them back' });
  assert.equal(res.id, 'e1');
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.equal(upd.params[0], 'resolved');
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[2], 'resolved');
});
