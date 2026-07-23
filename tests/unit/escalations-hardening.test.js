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
  // L6: impossible calendar dates (day in 1-31 but not real for the month)
  // must also store NULL, not reach Postgres.
  assert.equal(f('2026-02-31'), '');             // Feb 31
  assert.equal(f('2026-04-31'), '');             // Apr has 30 days
  assert.equal(f('2026-02-29'), '');             // 2026 is not a leap year
  assert.equal(f('2024-02-29'), '2024-02-29');   // 2024 IS a leap year -> valid
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

test('R8-4: an ALL-departments manager (allDepts) passes the row gate for ANY dept', function () {
  const f = h.fn('escAssertRowAccess_');
  // resolveUser_'s ALL-sentinel shape: role manager, department null,
  // allDepts true. Pre-fix `rowDept !== null` threw on EVERY row -- the
  // role could see all-dept lists but act on nothing, and activity
  // timelines rendered silently blank via the L9 not-found shape.
  const allMgr = { role: 'manager', department: null, allDepts: true };
  assert.doesNotThrow(function () { f(allMgr, 'CSR'); });
  assert.doesNotThrow(function () { f(allMgr, 'Sales'); });
  // Like admins, entitled even to rows whose stored dept was renamed.
  assert.doesNotThrow(function () { f(allMgr, 'Renamed Legacy Dept'); });
  // A single-dept manager with allDepts explicitly false stays pinned.
  assert.throws(function () {
    f({ role: 'manager', department: 'CSR', allDepts: false }, 'Sales');
  }, /Not authorized for this department/);
});

test('Tier C: a multi-dept manager passes the row gate for any assigned dept', function () {
  const f = h.fn('escAssertRowAccess_');
  const multi = { role: 'manager', department: 'CSR', allDepts: false, departments: ['CSR', 'Sales'] };
  assert.doesNotThrow(function () { f(multi, 'CSR'); });
  assert.doesNotThrow(function () { f(multi, 'Sales'); });
  assert.throws(function () { f(multi, 'Power'); }, /Not authorized for this department/);
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
    // C6 widened the fallback message to "pending or in-progress" (an
    // in_progress row now resolves); rejected/pending_review are still refused.
  }, /Only a pending or in-progress escalation can be resolved/);
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

test('C6: startEscalation promotes pending -> in_progress with a "started" activity row; pending-only', function () {
  const log = { writes: [] };
  // A pending row starts, writing status=in_progress + a 'started' activity
  // entry (the actor is the owner). Reuses the exact write/txn template.
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  const res = h.call('startEscalation', { id: 'e1', note: 'on it' });
  assert.equal(res.id, 'e1');
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations SET status') === 0; })[0];
  assert.equal(upd.params[0], 'in_progress');
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[2], 'started');

  // Already in progress -> refused, no writes.
  const log2 = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'in_progress', department: 'CSR', reason: 'r' }, log2);
  assert.throws(function () { h.call('startEscalation', { id: 'e1' }); }, /already in progress/);
  assert.equal(log2.writes.length, 0);

  // A pending_review row can't be started (must be approved first).
  const log3 = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending_review', department: 'CSR', reason: 'r', source: 'team-tools' }, log3);
  assert.throws(function () { h.call('startEscalation', { id: 'e1' }); }, /Only a pending escalation can be started/);
  assert.equal(log3.writes.length, 0);

  // Cross-dept manager is refused by the row gate (no writes).
  const log4 = { writes: [] };
  installReview({ role: 'manager', department: 'Sales', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log4);
  assert.throws(function () { h.call('startEscalation', { id: 'e1' }); }, /Not authorized for this department/);
  assert.equal(log4.writes.length, 0);
});

test('C6: resolveEscalation accepts an in_progress row (worklist completion)', function () {
  const log = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'in_progress', department: 'CSR', reason: 'r' }, log);
  const res = h.call('resolveEscalation', { id: 'e1', resolution: 'handled it' });
  assert.equal(res.id, 'e1');
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.equal(upd.params[0], 'resolved');
});

test('NEO-2: comments are worklist-only, required non-empty, and resolve preserves an existing comment', function () {
  const log = { writes: [] };
  // Empty comment refused (used to silently NULL the row's comment).
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('updateEscalationComment', { id: 'e1', comments: '   ' }); },
    /comment is required/);
  assert.equal(log.writes.length, 0);

  // pending_review is immutable external input until the review boundary runs.
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending_review', department: 'CSR', reason: 'r', source: 'team-tools' }, log);
  assert.throws(function () { h.call('updateEscalationComment', { id: 'e1', comments: 'note' }); },
    /awaiting review/);
  assert.equal(log.writes.length, 0);

  // rejected is terminal.
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'rejected', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('updateEscalationComment', { id: 'e1', comments: 'note' }); },
    /rejected.*cannot be annotated/);

  // pending + resolved rows accept comments.
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  h.call('updateEscalationComment', { id: 'e1', comments: 'call them back tomorrow' });
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations SET comments') === 0; })[0];
  assert.ok(upd, 'comment update executed');
  assert.equal(upd.params[0], 'call them back tomorrow');

  // Resolve with a BLANK comment keeps the row's existing comment (COALESCE).
  const log2 = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log2);
  h.call('resolveEscalation', { id: 'e1', resolution: 'handled' });
  const res = log2.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations SET status') === 0; })[0];
  assert.ok(/COALESCE\(NULLIF\(\?, ''\), comments\)/.test(res.sql),
    'blank resolve comment preserves the stored one instead of NULLing it');
});

// ── Gap #3: count-only pending-review ping (escPendingReviewPing_) ───────────
function pingConn(state) {
  return {
    createStatement: function () {
      return {
        executeQuery: function () {
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return state.baselineMax; },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    prepareStatement: function () {
      return {
        setString: function (i, v) { state.boundWatermark = v; },
        executeQuery: function () {
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function (col) {
              if (col === 'n') return String(state.newCount);
              if (col === 'maxts') return state.newMax;
              if (col === 'depts') return state.depts;
              return '';
            },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function installPing(state) {
  h.state.props = { NOTIFY_PENDING_REVIEW: 'true', ADMIN_EMAILS: 'admin@x.com' };
  h.ctx.getAdminEmails_ = function () { return ['admin@x.com']; };
  h.ctx.getDashboardNeonConn_ = function () { return pingConn(state); };
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (m) { mails.push(m); } };
  return mails;
}

test('Gap #3: flag off -> no query, no mail', function () {
  const state = { baselineMax: '2026-07-01 10:00:00', newCount: 3, newMax: '', depts: '' };
  const mails = installPing(state);
  h.state.props.NOTIFY_PENDING_REVIEW = 'false';
  h.ctx.getDashboardNeonConn_ = function () { throw new Error('must not connect'); };
  h.call('escPendingReviewPing_');
  assert.equal(mails.length, 0);
});

test('Gap #3: first run baselines silently; second run pings once and advances the watermark', function () {
  const state = { baselineMax: '2026-07-01 10:00:00', newCount: 2,
                  newMax: '2026-07-02 09:00:00', depts: 'CSR, Sales' };
  const mails = installPing(state);
  h.call('escPendingReviewPing_');   // baseline
  assert.equal(mails.length, 0, 'no backlog blast');
  assert.equal(h.state.props.ESC_REVIEW_PING_WATERMARK, '2026-07-01 10:00:00');
  h.call('escPendingReviewPing_');   // real run
  assert.equal(mails.length, 1, 'one count-only email');
  assert.equal(state.boundWatermark, '2026-07-01 10:00:00', 'queried since the baseline');
  assert.match(mails[0].subject, /2 escalation submissions awaiting review/);
  assert.match(mails[0].body, /CSR, Sales/);
  assert.ok(mails[0].body.indexOf('patient') === -1 || /no call\/patient detail/.test(mails[0].body),
    'PII-free: only the count-only disclaimer mentions patients');
  assert.equal(h.state.props.ESC_REVIEW_PING_WATERMARK, '2026-07-02 09:00:00', 'advanced after confirmed send');
});

test('Gap #3: a mail failure leaves the watermark un-advanced (OPS-1 retry)', function () {
  const state = { baselineMax: '2026-07-01 10:00:00', newCount: 1,
                  newMax: '2026-07-02 09:00:00', depts: 'CSR' };
  installPing(state);
  h.state.props.ESC_REVIEW_PING_WATERMARK = '2026-07-01 10:00:00';
  h.ctx.MailApp = { sendEmail: function () { throw new Error('quota'); } };
  h.call('escPendingReviewPing_');
  assert.equal(h.state.props.ESC_REVIEW_PING_WATERMARK, '2026-07-01 10:00:00',
    'same batch retries on the next hourly run');
});
