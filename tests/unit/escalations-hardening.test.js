'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Batch-5 Escalations hardening: the F-44 occurred_at validator and the
// F-45 row-level access gate. Both are pure -- no Neon / sheet doubles.

// Util.gs supplies assertManagerOrAdmin_ (the Phase A agent-role allowlist
// the escalation entry points now call).
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'Escalations.gs'] });   // Config.gs: sendAppEmail_ (R28)

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
          // ESC-L1/L2 group queries answer from the row's group fixture:
          // escGroupHasDept_ -> row.groupHit, escGroupActiveOthers_ ->
          // row.activeOthers, escGroupSize_ -> row.groupSize, escGroupDepts_ ->
          // row.groupDepts; every query is logged for the read-side pins.
          log.reads = (log.reads || []).concat([{ sql: sql, params: params.slice() }]);
          const isGroup = sql.indexOf('WHERE group_id = ?') !== -1;
          if (isGroup) log.groupProbes = (log.groupProbes || []).concat([params.slice()]);
          if (isGroup && sql.indexOf('SELECT department FROM') === 0) {
            const ds = (row && row.groupDepts) || [];
            let i = -1;
            return { next: function () { return ++i < ds.length; },
              getString: function () { return ds[i]; }, close: function () {} };
          }
          let n = row && row.n;
          if (isGroup && sql.indexOf('SELECT count(*)') === 0) {
            n = sql.indexOf("status <> 'removed'") !== -1 ? (row.activeOthers || 0) : (row.groupSize || 0);
          }
          const hit = !isGroup ? !!row
            : sql.indexOf('SELECT count(*)') === 0 ? true
            : !!(row && row.groupHit);
          return {
            next: function () { if (done) return false; done = true; return hit; },
            getString: function (col) {
              const map = { status: row.status, department: row.department,
                caller: row.caller, patient_name: row.patientName, trx: row.trx,
                area: row.area, reason: row.reason, source: row.source, n: n,
                group_id: row.groupId, j: row.j, status_before_removal: row.statusBeforeRemoval };
              // ESC-L3: escGroupHasDept_ reads the SIBLING's status.
              if (isGroup && sql.indexOf('SELECT status FROM') === 0 && row.groupHitStatus) map.status = row.groupHitStatus;
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

// -- R20: per-dept badge counts ----------------------------------------------

// Fake conn for the grouped badge query: one rs row per department.
function badgeConn(rows) {
  return {
    prepareStatement: function () {
      let i = -1;
      return {
        setString: function () {},
        executeQuery: function () {
          return {
            next: function () { i++; return i < rows.length; },
            getString: function (col) {
              const r = rows[i];
              const map = { department: r.dept, n_open: String(r.open),
                n_review: String(r.review), n_overdue: String(r.overdue) };
              return map[col] == null ? null : map[col];
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

test('R20: getEscalationsBadge sums totals from per-dept groups; byDept lists open depts busiest-first, review-only depts excluded', function () {
  h.state.userEmail = 'a@x.com';
  h.ctx.resolveUser_ = function () { return { role: 'admin', email: 'a@x.com' }; };
  h.ctx.getDashboardNeonConn_ = function () {
    return badgeConn([
      { dept: 'CSR',     open: 1, review: 0, overdue: 0 },
      { dept: 'Sales',   open: 3, review: 1, overdue: 2 },
      { dept: 'Billing', open: 0, review: 2, overdue: 0 },   // review-only: totals yes, byDept no
    ]);
  };
  const b = h.call('getEscalationsBadge');
  assert.equal(b.available, true);
  assert.equal(b.open, 4);
  assert.equal(b.review, 3);
  assert.equal(b.overdue, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(b.byDept)), [
    { dept: 'Sales', open: 3, overdue: 2 },
    { dept: 'CSR',   open: 1, overdue: 0 },
  ]);
});

// -- Phase A (agent role): deny sweep -----------------------------------------
// The fail-closed agent user shape (departments []) plus the new allowlists
// must refuse an agent at EVERY escalation surface. If a future verb accepts
// one, this sweep is the tripwire.

const AGENT_FIXTURE_ = {
  email: 'agent1@x.com', role: 'agent', department: null, departments: [],
  assignedDepartments: [], allDepts: false, agentDept: 'CSR', agentName: 'Maria Lopez',
};

test('Phase A sweep: escalation entry points + row gate + verbs all refuse the agent role', function () {
  const log = { writes: [] };
  installReview(AGENT_FIXTURE_,
    { status: 'pending', department: 'CSR', caller: 'c', patientName: 'p',
      trx: 't', area: '', reason: 'r', source: 'manual' }, log);

  assert.throws(function () { h.call('getEscalationsInit'); }, /Not authorized/);
  assert.throws(function () { h.call('getEscalationsBadge'); }, /Not authorized/);
  assert.throws(function () { h.call('getEscalations', {}); }, /Not authorized/);
  assert.throws(function () { h.fn('escAssertRowAccess_')(AGENT_FIXTURE_, 'CSR'); }, /Not authorized/);
  // Worklist verbs ride escAssertRowAccess_ -- exercise two directly to pin
  // the wiring, not just the helper.
  assert.throws(function () { h.call('resolveEscalation', { id: 'e1', resolution: 'x' }); }, /Not authorized/);
  assert.throws(function () { h.call('approveEscalation', { id: 'e1' }); }, /Not authorized/);
  assert.throws(function () { h.call('deleteEscalation', { id: 'e1' }); }, /admin-only/);   // 2a
  assert.equal(log.writes.length, 0, 'nothing was written on any refused call');
});

// -- 2a: admin permanent delete ----------------------------------------------

test('2a: deleteEscalation is ADMIN-ONLY -- a manager on the row\'s own dept and the all-departments manager are both refused', function () {
  const log = { writes: [] };
  installReview({ role: 'manager', department: 'CSR', departments: ['CSR'], email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('deleteEscalation', { id: 'e1' }); }, /admin-only/);
  installReview({ role: 'manager', allDepts: true, department: null, departments: ['CSR', 'Sales'], email: 'all@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('deleteEscalation', { id: 'e1' }); }, /admin-only/);
  assert.equal(log.writes.length, 0, 'no writes on a refusal');
});

test('2a: an admin delete removes the activity trail THEN the row in ONE transaction, refreshes the snapshot, and audits without PHI', function () {
  const log = { writes: [] };
  installReview({ role: 'admin', email: 'admin@x.com' },
    { status: 'resolved', department: 'Sales', caller: 'Jane Caller', patientName: 'Pat Patient', trx: 'TRX9', reason: 'r' }, log);
  const usage = [];
  h.ctx.logReportUsage_ = function (report, dept, user, cacheHit) { usage.push({ report: report, dept: dept, email: user && user.email, cacheHit: cacheHit }); };
  const snap = [];
  h.ctx.escSnapshotMaybeRefresh_ = function (conn, force) { snap.push({ force: !!force, afterCommit: log.commits === 1 }); };
  const res = h.call('deleteEscalation', { id: 'e1' });
  assert.equal(res.id, 'e1'); assert.equal(res.deleted, 1);   // property checks: vm-realm object
  const dels = log.writes.map(function (w) { return w.sql; });
  assert.deepEqual(dels, ['DELETE FROM escalation_activity WHERE escalation_id = ?', 'DELETE FROM escalations WHERE id = ?'],
    'trail first (no orphaned activity rows), then the row, nothing else');
  assert.equal(log.writes[0].params[0], 'e1');
  assert.equal(log.writes[1].params[0], 'e1');
  assert.equal(log.commits, 1, 'one commit');
  assert.equal(log.rollbacks || 0, 0);
  assert.deepEqual(snap, [{ force: true, afterCommit: true }], 'the outage snapshot is refreshed UNCONDITIONALLY, after the commit');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].report, 'escalations:delete');
  assert.equal(usage[0].dept, 'Sales');
  assert.equal(usage[0].email, 'admin@x.com');
  const audit = JSON.stringify(usage);
  ['Jane Caller', 'Pat Patient', 'TRX9', 'e1'].forEach(function (pii) {
    assert.ok(audit.indexOf(pii) === -1, 'the usage row must not carry "' + pii + '" (no PHI, no id in the usage sheet)');
  });
});

test('2a: an unknown id is a no-op -- { deleted: 0 }, no writes, no throw (double click / stale card)', function () {
  const log = { writes: [] };
  installReview({ role: 'admin', email: 'admin@x.com' }, null, log);
  h.ctx.logReportUsage_ = function () { throw new Error('must not be called'); };
  const res = h.call('deleteEscalation', { id: 'nope' });
  assert.equal(res.id, 'nope'); assert.equal(res.deleted, 0);   // property checks: vm-realm object
  assert.equal(log.writes.length, 0);
  assert.equal(log.commits || 0, 0);
  assert.throws(function () { h.call('deleteEscalation', {}); }, /Missing escalation id/);
});

test('2a: a failed DELETE rolls back and surfaces the error -- never a half-deleted escalation', function () {
  const log = { writes: [] };
  installReview({ role: 'admin', email: 'admin@x.com' }, { status: 'pending', department: 'CSR', reason: 'r' }, log);
  const conn = h.ctx.getDashboardNeonConn_();
  const orig = conn.prepareStatement;
  conn.prepareStatement = function (sql) {
    const st = orig(sql);
    if (sql.indexOf('DELETE FROM escalations WHERE') === 0) st.execute = function () { throw new Error('boom'); };
    return st;
  };
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  assert.throws(function () { h.call('deleteEscalation', { id: 'e1' }); }, /boom/);
  assert.equal(log.rollbacks, 1, 'rolled back');
  assert.equal(log.commits || 0, 0, 'never committed');
});

// ESC-R1 (owner ruling 2026-09-30): an ADMIN moves an escalation to another
// department. Pending and in-progress only; the status is kept; the move is
// its own `reassigned` activity row; the new dept's managers are notified
// under NOTIFY_ON_NEW_ESCALATION; updateEscalation can no longer change the
// department.
function installMove(user, row, log, extraProps) {
  installReview(user, row, log);
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales', 'Power']; };
  h.ctx.escSnapshotAfterWrite_ = function () {};
  h.ctx.lookupDeptManagers_ = function (d) { return d === 'Sales' ? ['sales.mgr@x.com'] : []; };
  h.state.props = Object.assign({ ADMIN_EMAILS: 'admin@x.com' }, extraProps || {});
  h.state.sentEmails.length = 0;
  // Gap #3's tests above leave a throwing MailApp behind -- install a fresh capture.
  h.ctx.MailApp = { sendEmail: function (m) { h.state.sentEmails.push(m); } };
}

test('ESC-R1: moveEscalation is ADMIN-ONLY -- a dept manager and the all-departments manager are refused', function () {
  const log = { writes: [] };
  installMove({ role: 'manager', department: 'CSR', departments: ['CSR'], email: 'mgr@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('moveEscalation', { id: 'e1', department: 'Sales' }); }, /admin-only/);
  installMove({ role: 'manager', allDepts: true, department: null, departments: ['CSR', 'Sales'], email: 'all@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('moveEscalation', { id: 'e1', department: 'Sales' }); }, /admin-only/);
  assert.equal(log.writes.length, 0, 'no writes on a refusal');
});

test('ESC-R1: an admin moves a PENDING escalation -- dept updated, status untouched, "reassigned" trail row, new dept notified', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' },
    { status: 'pending', department: 'CSR', patientName: 'Pat', trx: 'T1', reason: 'r' }, log,
    { NOTIFY_ON_NEW_ESCALATION: 'true' });
  h.state.userEmail = 'admin@x.com';
  const res = JSON.parse(JSON.stringify(h.call('moveEscalation', { id: 'e1', department: 'Sales', note: 'Sales owns this account' })));
  assert.deepEqual(res, { id: 'e1', from: 'CSR', to: 'Sales' });
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; });
  assert.equal(upd.length, 1);
  assert.equal(upd[0].sql, 'UPDATE escalations SET department = ?, updated_at = now() WHERE id = ?', 'the department only -- never the status');
  assert.deepEqual(upd[0].params, ['Sales', 'e1']);
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[2], 'reassigned');
  assert.equal(act.params[3], 'admin@x.com');
  assert.equal(act.params[4], 'CSR → Sales: Sales owns this account');
  assert.equal(log.commits, 1);
  const real = h.state.sentEmails.filter(function (m) { return !/^\[Copy\] /.test(m.subject); });
  assert.equal(real.length, 1, 'the NEW dept\'s managers are told');
  assert.equal(real[0].to, 'sales.mgr@x.com');
  assert.equal(real[0].subject, 'Escalation moved to Sales');
  assert.match(real[0].htmlBody, /moved to your department from CSR/);
});

test('ESC-R1: an IN-PROGRESS escalation moves too and stays in progress; no email with the flag off', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' },
    { status: 'in_progress', department: 'CSR', reason: 'r' }, log);
  h.call('moveEscalation', { id: 'e1', department: 'Power' });
  const sqls = log.writes.map(function (w) { return w.sql; });
  assert.ok(sqls.every(function (q) { return q.indexOf('SET status') === -1; }), 'status is not touched');
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[4], 'CSR → Power', 'no note -> just the move');
  assert.equal(h.state.sentEmails.length, 0, 'NOTIFY_ON_NEW_ESCALATION unset -> no email');
});

test('ESC-R1: resolved / rejected / awaiting-review / same-dept / unknown-dept moves are refused with no writes', function () {
  [['resolved', /reopen it first/], ['rejected', /reopen it first/], ['pending_review', /approve or reject it first/]]
    .forEach(function (c) {
      const log = { writes: [] };
      installMove({ role: 'admin', email: 'admin@x.com' }, { status: c[0], department: 'CSR', reason: 'r' }, log);
      assert.throws(function () { h.call('moveEscalation', { id: 'e1', department: 'Sales' }); }, c[1], c[0]);
      assert.equal(log.writes.length, 0, c[0] + ': no writes');
    });
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, { status: 'pending', department: 'CSR', reason: 'r' }, log);
  assert.throws(function () { h.call('moveEscalation', { id: 'e1', department: 'CSR' }); }, /already assigned to CSR/);
  assert.throws(function () { h.call('moveEscalation', { id: 'e1', department: 'Nope' }); }, /Unknown department: Nope/);
  assert.equal(log.writes.length, 0);
});

test('ESC-R1: updateEscalation no longer changes the department (a move is its own recorded action)', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, { status: 'pending', department: 'CSR', reason: 'r' }, log);
  h.call('updateEscalation', { id: 'e1', department: 'Sales', reason: 'new reason' });
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.ok(upd.sql.indexOf('department') === -1, 'the edit UPDATE never names the department column');
  assert.ok(upd.params.indexOf('Sales') === -1);
});

// ESC-L1 (Step 2a, owner ruling 2026-09-30): one escalation assigned to
// several departments = one LINKED COPY per department sharing a group_id.
// Each dept works its own copy; the card names the others; counting stays
// per copy with a "(N linked)" label; one email per manager across the group.
test('ESC-L1: escRequestedDepts_ takes `departments` or the legacy single `department`, trimmed + de-duplicated', function () {
  const f = h.fn('escRequestedDepts_');
  assert.deepEqual(JSON.parse(JSON.stringify(f({ departments: [' CSR', 'Sales', 'CSR', ''] }))), ['CSR', 'Sales']);
  assert.deepEqual(JSON.parse(JSON.stringify(f({ department: 'Power' }))), ['Power']);
  assert.throws(function () { f({ departments: [] }); }, /Pick at least one department/);
  assert.throws(function () { f({}); }, /Pick at least one department/);
});

test('ESC-L1: a two-department create writes two copies sharing ONE group_id, each with its own trail row, in ONE commit', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, null, log);
  const res = JSON.parse(JSON.stringify(h.call('createEscalation',
    { departments: ['CSR', 'Sales'], reason: 'Caller disputes both teams', patientName: 'Pat' })));
  const ins = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalations ') === 0; });
  assert.equal(ins.length, 2, 'one row per department');
  assert.deepEqual(ins.map(function (w) { return w.params[1]; }), ['CSR', 'Sales']);
  assert.ok(ins[0].params[11], 'a group id is bound');
  assert.equal(ins[0].params[11], ins[1].params[11], 'both copies share the group id');
  assert.notEqual(ins[0].params[0], ins[1].params[0], 'each copy has its own id');
  assert.equal(ins[0].params[4], 'Pat'); assert.equal(ins[1].params[4], 'Pat');
  const acts = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; });
  assert.deepEqual(acts.map(function (w) { return w.params[1]; }), ins.map(function (w) { return w.params[0]; }),
    'a created trail row per copy');
  assert.equal(log.commits, 1, 'all copies atomically');
  assert.equal(res.groupId, ins[0].params[11]);
  assert.equal(res.ids.length, 2);
  assert.equal(res.id, res.ids[0], 'legacy `id` is the first copy');
});

test('ESC-L1: a single-department create stays standalone (group_id NULL) -- byte-compatible with the legacy payload', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, null, log);
  const res = JSON.parse(JSON.stringify(h.call('createEscalation', { department: 'CSR', reason: 'r' })));
  const ins = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalations ') === 0; });
  assert.equal(ins.length, 1);
  assert.equal(ins[0].params[11], '', "'' binds through NULLIF -> NULL");
  assert.equal(res.groupId, null);
  // An unknown dept anywhere in the list refuses the whole create.
  const log2 = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, null, log2);
  assert.throws(function () { h.call('createEscalation', { departments: ['CSR', 'Nope'], reason: 'r' }); }, /Unknown department: Nope/);
  assert.equal(log2.writes.length, 0);
});

test('ESC-L1: escLinkedRecipientGroups_ sends one email per manager -- a manager of two linked depts gets ONE naming both', function () {
  const f = h.fn('escLinkedRecipientGroups_');
  // csr2 shares csr's department set -> one message To both; CSR@X.com is a
  // case-variant repeat of csr@x.com -> not a second recipient.
  const mgrs = { CSR: ['csr@x.com', 'Both@x.com', 'csr2@x.com', 'CSR@X.com'], Sales: ['both@x.com', 'sales@x.com'], Power: [] };
  const g = JSON.parse(JSON.stringify(f(['CSR', 'Sales', 'Power'], function (d) { return mgrs[d]; })));
  assert.deepEqual(g, [
    { depts: ['CSR'], emails: ['csr@x.com', 'csr2@x.com'] },
    { depts: ['CSR', 'Sales'], emails: ['Both@x.com'] },
    { depts: ['Sales'], emails: ['sales@x.com'] },
  ]);
});

test('ESC-L1: a linked create emails each manager set once, naming the other linked departments (flag-gated)', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, null, log, { NOTIFY_ON_NEW_ESCALATION: 'true' });
  h.ctx.lookupDeptManagers_ = function (d) { return d === 'CSR' ? ['csr@x.com'] : d === 'Sales' ? ['sales@x.com'] : []; };
  h.call('createEscalation', { departments: ['CSR', 'Sales'], reason: 'r' });
  const real = h.state.sentEmails.filter(function (m) { return !/^\[Copy\] /.test(m.subject); });
  assert.equal(real.length, 2);
  const csr = real.filter(function (m) { return m.to === 'csr@x.com'; })[0];
  assert.equal(csr.subject, 'New escalation logged — CSR');
  assert.match(csr.htmlBody, /also assigned to Sales/);
  const sales = real.filter(function (m) { return m.to === 'sales@x.com'; })[0];
  assert.match(sales.htmlBody, /also assigned to CSR/);
  // Flag off -> nothing.
  installMove({ role: 'admin', email: 'admin@x.com' }, null, { writes: [] });
  h.call('createEscalation', { departments: ['CSR', 'Sales'], reason: 'r' });
  assert.equal(h.state.sentEmails.length, 0);
});

test('ESC-L1: moving a linked copy into a dept that already holds one is refused with no writes', function () {
  const log = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', groupHit: true }, log);
  assert.throws(function () { h.call('moveEscalation', { id: 'e1', department: 'Sales' }); },
    /Sales already has a linked copy of this escalation/);
  assert.equal(log.writes.length, 0);
  assert.deepEqual(log.groupProbes[0], ['g1', 'Sales', 'e1'], 'probe excludes the moving copy itself');
  // No sibling there -> the move goes through; a standalone row never probes.
  const log2 = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', groupHit: false }, log2);
  h.call('moveEscalation', { id: 'e1', department: 'Power' });
  assert.equal(log2.commits, 1);
  const log3 = { writes: [] };
  installMove({ role: 'admin', email: 'admin@x.com' }, { status: 'pending', department: 'CSR', reason: 'r' }, log3);
  h.call('moveEscalation', { id: 'e1', department: 'Sales' });
  assert.equal((log3.groupProbes || []).length, 0);
});

test('ESC-L1: the list + snapshot SELECTs carry group_id and the per-row linked summary', function () {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../apps-script/department-dashboard/Escalations.gs'), 'utf8');
  const linkedUses = src.split('ESC_LINKED_SQL_ + ').length - 1;
  assert.equal(linkedUses, 2, 'getEscalations AND the snapshot query select the linked summary');
  assert.match(h.ctx.ESC_LINKED_SQL_, /s\.group_id = e\.group_id AND s\.id <> e\.id/, 'siblings only, never the row itself');
});

function linkedBadgeConn(failLinked, rows) {
  const seen = [];
  return { seen: seen, conn: {
    prepareStatement: function (sql) {
      seen.push(sql);
      return {
        setString: function () {},
        executeQuery: function () {
          if (failLinked && sql.indexOf('n_linked') !== -1) throw new Error('column "group_id" does not exist');
          let i = -1;
          return { next: function () { return ++i < rows.length; },
            getString: function (c) { return rows[i][c] == null ? null : String(rows[i][c]); }, close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () {},
  } };
}

test('ESC-L1: the badge reports the open linked copies, and FALLS BACK to the pre-2a query when group_id is missing', function () {
  h.ctx.resolveUser_ = function () { return { role: 'admin', email: 'admin@x.com' }; };
  const rows = [{ department: 'CSR', n_open: 3, n_review: 1, n_linked: 2, n_overdue: 1 },
                { department: 'Sales', n_open: 1, n_review: 0, n_linked: 1, n_overdue: 0 }];
  let b = linkedBadgeConn(false, rows);
  h.ctx.getDashboardNeonConn_ = function () { return b.conn; };
  let out = JSON.parse(JSON.stringify(h.call('getEscalationsBadge')));
  assert.equal(out.available, true);
  assert.equal(out.open, 4);
  assert.equal(out.linked, 3);
  b = linkedBadgeConn(true, rows);
  h.ctx.getDashboardNeonConn_ = function () { return b.conn; };
  out = JSON.parse(JSON.stringify(h.call('getEscalationsBadge')));
  assert.equal(out.available, true, 'a missing column costs the label, never the badge');
  assert.equal(out.open, 4);
  assert.equal(out.linked, 0);
  assert.equal(b.seen.length, 2);
  assert.equal(b.seen[1].indexOf('n_linked'), -1);
});

// ESC-L2 (Step 2b, owner decisions 2026-09-30): the SHARED THREAD across
// linked copies, admin edit sync, "Link another department", the soft
// REMOVE (kept in the thread, read-only for the removed dept) and
// delete-all-linked.
const ADMIN = { role: 'admin', email: 'admin@x.com' };
const CSR_MGR = { role: 'manager', department: 'CSR', departments: ['CSR'], email: 'mgr@x.com' };

test('ESC-L2: every write verb refuses a REMOVED copy with no writes (read-only once removed)', function () {
  const removed = { status: 'removed', department: 'CSR', reason: 'r', groupId: 'g1' };
  [
    [CSR_MGR, 'resolveEscalation', { id: 'e1', resolution: 'done' }],
    [CSR_MGR, 'reopenEscalation', { id: 'e1', reason: 'why' }],
    [CSR_MGR, 'startEscalation', { id: 'e1' }],
    [CSR_MGR, 'updateEscalationComment', { id: 'e1', comments: 'note' }],
    [ADMIN, 'updateEscalation', { id: 'e1', reason: 'x' }],
    [ADMIN, 'moveEscalation', { id: 'e1', department: 'Sales' }],
    [ADMIN, 'linkEscalationDepartment', { id: 'e1', department: 'Sales' }],
  ].forEach(function (c) {
    const log = { writes: [] };
    installMove(c[0], removed, log);
    assert.throws(function () { h.call(c[1], c[2]); }, /CSR was removed from this escalation/, c[1]);
    assert.equal(log.writes.length, 0, c[1] + ': no writes');
  });
});

test('ESC-L2: a linked copy\'s Activity is the WHOLE group thread, tagged by department; the gate stays on the requested copy', function () {
  const log = { writes: [] };
  installMove(CSR_MGR, { status: 'removed', department: 'CSR', reason: 'r', groupId: 'g1',
    j: JSON.stringify([{ action: 'comment', department: 'Sales', removed: false }]) }, log);
  const res = JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 'e1' })));
  assert.equal(res.linked, true);
  assert.equal(res.rows[0].department, 'Sales');
  const q = log.reads.filter(function (r) { return r.sql.indexOf('escalation_activity') !== -1; })[0];
  assert.match(q.sql, /JOIN escalations e ON e\.id = a\.escalation_id WHERE e\.group_id = \?/);
  assert.deepEqual(q.params, ['e1', 'g1'], 'own-flag id, then the group');
  // A manager of ANOTHER dept gets the not-found shape and no thread query.
  const log2 = { writes: [] };
  installMove({ role: 'manager', department: 'Sales', departments: ['Sales'], email: 's@x.com' },
    { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', j: '[{"action":"x"}]' }, log2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 'e1' }))), { available: true, rows: [] });
  assert.equal(log2.reads.filter(function (r) { return r.sql.indexOf('escalation_activity') !== -1; }).length, 0);
  // A standalone row keeps the single-row query.
  const log3 = { writes: [] };
  installMove(CSR_MGR, { status: 'pending', department: 'CSR', reason: 'r', j: '[]' }, log3);
  const r3 = h.call('getEscalationActivity', { id: 'e1' });
  assert.equal(r3.linked, false);
  const q3 = log3.reads.filter(function (r) { return r.sql.indexOf('escalation_activity') !== -1; })[0];
  assert.match(q3.sql, /WHERE escalation_id = \?\) t$/);
});

test('ESC-L2: an admin edit of a linked copy writes the shared fields to EVERY copy (one statement), one trail entry', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', groupSize: 3 }, log);
  h.call('updateEscalation', { id: 'e1', reason: 'corrected reason', patientName: 'Pat' });
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; });
  assert.equal(upd.length, 1);
  assert.match(upd[0].sql, /WHERE group_id = \?$/);
  assert.equal(upd[0].params[6], 'g1');
  assert.ok(upd[0].sql.indexOf('status') === -1, 'never the per-copy status');
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; });
  assert.equal(act.length, 1);
  assert.equal(act[0].params[1], 'e1');
  assert.match(act[0].params[4], /applied to all 3 linked copies/);
  // Standalone: the old WHERE id = ?.
  const log2 = { writes: [] };
  installMove(ADMIN, { status: 'pending', department: 'CSR', reason: 'r' }, log2);
  h.call('updateEscalation', { id: 'e1', reason: 'x' });
  const u2 = log2.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.match(u2.sql, /WHERE id = \?$/);
  assert.equal(u2.params[6], 'e1');
});

test('ESC-L2: linking a department to a STANDALONE escalation stamps a new group on it and copies the fields in SQL', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'resolved', department: 'CSR', reason: 'r', patientName: 'Pat' }, log,
    { NOTIFY_ON_NEW_ESCALATION: 'true' });
  const res = JSON.parse(JSON.stringify(h.call('linkEscalationDepartment', { id: 'e1', department: 'Sales', note: 'billing side' })));
  const grp = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations SET group_id') === 0; });
  assert.equal(grp.length, 1, 'the source joins the new group');
  assert.deepEqual(grp[0].params, [res.groupId, 'e1']);
  const ins = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalations') === 0; })[0];
  assert.match(ins.sql, /SELECT \?, \?, occurred_at, caller, patient_name, trx, area, reason, \?, \?, \?, \? FROM escalations WHERE id = \?/);
  assert.deepEqual(ins.params, [res.newId, 'Sales', 'pending', 'admin@x.com', 'manual', res.groupId, 'e1']);
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[1], res.newId);
  assert.equal(act.params[2], 'linked');
  assert.equal(act.params[4], 'Sales added to this escalation (linked from CSR): billing side');
  assert.equal(log.commits, 1);
  const real = h.state.sentEmails.filter(function (m) { return !/^\[Copy\] /.test(m.subject); });
  assert.equal(real.length, 1);
  assert.equal(real[0].to, 'sales.mgr@x.com');
  assert.match(real[0].htmlBody, /also assigned to CSR/);
});

test('ESC-L2: linking into an existing group reuses its id; refusals write nothing', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'in_progress', department: 'CSR', reason: 'r', groupId: 'g1', groupDepts: ['CSR', 'Power'] }, log);
  const res = h.call('linkEscalationDepartment', { id: 'e1', department: 'Sales' });
  assert.equal(res.groupId, 'g1');
  assert.equal(log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations SET group_id') === 0; }).length, 0);
  [
    [{ status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', groupHit: true }, 'Sales', /Sales already has a linked copy/],
    [{ status: 'pending', department: 'CSR', reason: 'r' }, 'CSR', /already assigned to CSR/],
    [{ status: 'pending_review', department: 'CSR', reason: 'r' }, 'Sales', /awaiting review/],
    [{ status: 'rejected', department: 'CSR', reason: 'r' }, 'Sales', /pending, in-progress or resolved/],
    [{ status: 'pending', department: 'CSR', reason: 'r' }, 'Nope', /Unknown department: Nope/],
  ].forEach(function (c) {
    const l = { writes: [] };
    installMove(ADMIN, c[0], l);
    assert.throws(function () { h.call('linkEscalationDepartment', { id: 'e1', department: c[1] }); }, c[2]);
    assert.equal(l.writes.length, 0);
  });
  installMove(CSR_MGR, { status: 'pending', department: 'CSR', reason: 'r' }, { writes: [] });
  assert.throws(function () { h.call('linkEscalationDepartment', { id: 'e1', department: 'Sales' }); }, /admin-only/);
});

test('ESC-L2: REMOVE is a soft status with who / when / why, a "removed" thread entry, and one commit', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'in_progress', department: 'CSR', reason: 'r', groupId: 'g1', activeOthers: 1 }, log);
  const res = JSON.parse(JSON.stringify(h.call('removeEscalationDepartment', { id: 'e1', reason: 'Dispute upheld: billing matter' })));
  assert.deepEqual(res, { id: 'e1', department: 'CSR' });
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.match(upd.sql, /removed_by = \?, removed_at = now\(\), removed_reason = \?, status_before_removal = \?/);
  assert.deepEqual(upd.params, ['removed', 'admin@x.com', 'Dispute upheld: billing matter', 'in_progress', 'e1'],
    'ESC-L3: the prior status is kept for a restore');
  assert.equal(log.writes.filter(function (w) { return w.sql.indexOf('DELETE') === 0; }).length, 0, 'never a delete');
  const act = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(act.params[2], 'removed');
  assert.equal(act.params[4], 'CSR removed from this escalation (was in_progress): Dispute upheld: billing matter');
  assert.equal(log.commits, 1);
});

test('ESC-L2: REMOVE refuses a missing reason, a standalone escalation, the LAST active copy, an already-removed copy, and managers', function () {
  [
    [ADMIN, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', activeOthers: 1 }, '', /reason for removing/],
    [ADMIN, { status: 'pending', department: 'CSR', reason: 'r' }, 'why', /one department only/],
    [ADMIN, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', activeOthers: 0 }, 'why', /last department still on this escalation/],
    [ADMIN, { status: 'removed', department: 'CSR', reason: 'r', groupId: 'g1', activeOthers: 1 }, 'why', /already removed/],
    [CSR_MGR, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', activeOthers: 1 }, 'why', /admin-only/],
  ].forEach(function (c) {
    const log = { writes: [] };
    installMove(c[0], c[1], log);
    assert.throws(function () { h.call('removeEscalationDepartment', { id: 'e1', reason: c[2] }); }, c[3]);
    assert.equal(log.writes.length, 0);
  });
});

test('ESC-L2: delete defaults to ONE copy; allLinked deletes every copy + the whole thread in one transaction', function () {
  const usage = [];
  const log = { writes: [] };
  installMove(ADMIN, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', groupSize: 3, groupDepts: ['CSR', 'Sales'] }, log);
  h.ctx.logReportUsage_ = function (report, dept) { usage.push(dept); };
  const one = JSON.parse(JSON.stringify(h.call('deleteEscalation', { id: 'e1' })));
  assert.equal(one.deleted, 1);
  assert.deepEqual(log.writes.map(function (w) { return w.params; }), [['e1'], ['e1']], 'by id only');
  const log2 = { writes: [] };
  installMove(ADMIN, { status: 'removed', department: 'Power', reason: 'r', groupId: 'g1', groupSize: 3, groupDepts: ['CSR', 'Sales'] }, log2);
  h.ctx.logReportUsage_ = function (report, dept) { usage.push(dept); };
  const all = JSON.parse(JSON.stringify(h.call('deleteEscalation', { id: 'e1', allLinked: true })));
  assert.deepEqual(all, { id: 'e1', deleted: 3, allLinked: true });
  assert.equal(log2.writes.length, 2);
  assert.match(log2.writes[0].sql, /DELETE FROM escalation_activity WHERE escalation_id IN \(SELECT id FROM escalations WHERE group_id = \?\)/);
  assert.equal(log2.writes[1].sql, 'DELETE FROM escalations WHERE group_id = ?');
  assert.deepEqual(log2.writes[1].params, ['g1']);
  assert.equal(log2.commits, 1);
  assert.equal(usage[1], 'CSR + Sales + Power', 'the audit names every department, never an id or PHI');
});

test('ESC-L2: "removed" is a list filter + count, and the list carries who/when/why for the card', function () {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../apps-script/department-dashboard/Escalations.gs'), 'utf8');
  assert.match(src, /'rejected', 'removed', 'all'\]\.indexOf\(status\)/);
  assert.match(src, /count\(\*\) FILTER \(WHERE status = 'removed'\) AS n_removed/);
  assert.match(src, /removed_by, removed_at::text AS removed_at, removed_reason, /);
  // The open-status lists (badge / snapshot / overdue) never include it.
  assert.ok(!/IN \('pending','in_progress'[^)]*'removed'/.test(src));
});

// ESC-L3 (2026-09-30): RESTORE a removed department -- the undo of a
// removal. Admin-only; back to the status it had; the thread keeps both.
test('ESC-L3: restore returns a removed copy to its PRIOR status, clears the removal record, and adds a "restored" entry', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'removed', department: 'CSR', reason: 'r', groupId: 'g1', statusBeforeRemoval: 'in_progress',
    groupDepts: ['Sales'] }, log, { NOTIFY_ON_NEW_ESCALATION: 'true' });
  h.ctx.lookupDeptManagers_ = function (d) { return d === 'CSR' ? ['csr@x.com'] : []; };
  const res = JSON.parse(JSON.stringify(h.call('restoreEscalationDepartment', { id: 'e1', note: 'dispute reopened' })));
  assert.deepEqual(res, { id: 'e1', department: 'CSR', status: 'in_progress' });
  const upd = log.writes.filter(function (w) { return w.sql.indexOf('UPDATE escalations') === 0; })[0];
  assert.match(upd.sql, /removed_by = NULL, removed_at = NULL, removed_reason = NULL, status_before_removal = NULL/);
  assert.deepEqual(upd.params, ['in_progress', 'e1']);
  const a = log.writes.filter(function (w) { return w.sql.indexOf('INSERT INTO escalation_activity') === 0; })[0];
  assert.equal(a.params[2], 'restored');
  assert.equal(a.params[4], 'CSR restored to this escalation (back to in progress): dispute reopened');
  assert.equal(log.commits, 1);
  const real = h.state.sentEmails.filter(function (m) { return !/^\[Copy\] /.test(m.subject); });
  assert.equal(real.length, 1);
  assert.equal(real[0].subject, 'Escalation returned to CSR');
  assert.match(real[0].htmlBody, /also assigned to Sales/);
});

test('ESC-L3: a copy removed while RESOLVED comes back resolved (no email); an unknown prior status comes back pending', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'removed', department: 'CSR', reason: 'r', groupId: 'g1', statusBeforeRemoval: 'resolved' }, log,
    { NOTIFY_ON_NEW_ESCALATION: 'true' });
  h.ctx.lookupDeptManagers_ = function () { return ['csr@x.com']; };
  assert.equal(h.call('restoreEscalationDepartment', { id: 'e1' }).status, 'resolved');
  assert.equal(h.state.sentEmails.length, 0, 'nothing re-enters a worklist -> no email');
  const f = h.fn('escRestoreStatus_');
  assert.equal(f(null), 'pending');
  assert.equal(f('removed'), 'pending');
  assert.equal(f('pending_review'), 'pending');
  assert.equal(f('in_progress'), 'in_progress');
});

test('ESC-L3: only a REMOVED copy restores, only for an admin; linking or moving onto a removed dept points at Restore', function () {
  const log = { writes: [] };
  installMove(ADMIN, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1' }, log);
  assert.throws(function () { h.call('restoreEscalationDepartment', { id: 'e1' }); }, /not removed from this escalation/);
  assert.equal(log.writes.length, 0);
  installMove(CSR_MGR, { status: 'removed', department: 'CSR', reason: 'r', groupId: 'g1' }, { writes: [] });
  assert.throws(function () { h.call('restoreEscalationDepartment', { id: 'e1' }); }, /admin-only/);
  ['linkEscalationDepartment', 'moveEscalation'].forEach(function (fn) {
    const l = { writes: [] };
    installMove(ADMIN, { status: 'pending', department: 'CSR', reason: 'r', groupId: 'g1', groupHit: true, groupHitStatus: 'removed' }, l);
    assert.throws(function () { h.call(fn, { id: 'e1', department: 'Sales' }); }, /Sales was removed from this escalation — use Restore/, fn);
    assert.equal(l.writes.length, 0, fn);
  });
});

// ESC-G1 (reflect 207-211): a REMOVED copy is read-only, but only the verbs
// written in 2b were taught that. This sweep makes it structural: every
// PUBLIC Escalations.gs function that commits a write must call
// escAssertNotRemoved_ -- or be listed here with the reason it may not.
const ESC_REMOVED_GUARD_EXEMPT = {
  createEscalation: 'writes NEW copies -- there is no existing copy to be removed',
  removeEscalationDepartment: 'refuses a removed copy itself ("already removed")',
  restoreEscalationDepartment: 'REQUIRES a removed copy -- it is the undo',
  deleteEscalation: 'admin cleanup may delete a removed copy (and delete-all reaches them)',
  approveEscalation: 'pending_review-only allowlist; a removed copy can never be pending_review',
  rejectEscalation: 'pending_review-only allowlist; a removed copy can never be pending_review',
  backfillEscalationActivity: 'editor-run migration; inserts seed trail rows only, never a status change',
};

function escPublicWriters() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../apps-script/department-dashboard/Escalations.gs'), 'utf8');
  const out = {};
  const re = /^function ([A-Za-z0-9]+)\s*\(/gm;
  let m;
  const starts = [];
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  starts.forEach(function (s, i) {
    const body = src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
    if (/conn\.commit\(\)/.test(body)) out[s.name] = body;   // public (no trailing _) + commits = a write verb
  });
  return out;
}

test('ESC-G1: every public escalation write verb refuses a removed copy, or is an exemption with a reason', function () {
  const writers = escPublicWriters();
  assert.ok(Object.keys(writers).length >= 10, 'the sweep found the write verbs');
  const missing = Object.keys(writers).filter(function (n) {
    return !ESC_REMOVED_GUARD_EXEMPT[n] && writers[n].indexOf('escAssertNotRemoved_(') === -1;
  });
  assert.deepEqual(missing, [], 'add escAssertNotRemoved_(meta) after the row gate, or exempt it here with a reason');
  // No stale exemptions: each one must still be a public writer.
  Object.keys(ESC_REMOVED_GUARD_EXEMPT).forEach(function (n) {
    assert.ok(writers[n], n + ' is exempt but is no longer a public write verb -- drop the exemption');
  });
});

// ESC-DDL / ESC-U1 (reflect 207-211): the linked-copy schema migration is
// best-effort but no longer SILENT, and the database enforces one copy per
// department per group.
function ddlConn(failOn) {
  const ran = [];
  return { ran: ran, conn: { createStatement: function () {
    return { execute: function (sql) {
      ran.push(sql);
      if (failOn && failOn.test(sql)) throw new Error('boom: ' + sql.slice(0, 30));
    }, close: function () {} };
  } } };
}

test('ESC-U1: escEnsureTable_ builds the PARTIAL unique (group_id, department) index, non-concurrently', function () {
  const d = ddlConn(null);
  h.call('escEnsureTable_', d.conn);
  const uq = d.ran.filter(function (q) { return /CREATE UNIQUE INDEX/.test(q); });
  assert.equal(uq.length, 1);
  assert.equal(uq[0], 'CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_group_dept ON escalations (group_id, department) WHERE group_id IS NOT NULL');
  assert.ok(!/CONCURRENTLY/.test(uq[0]), 'a failed concurrent build would leave an INVALID index behind');
});

test('ESC-DDL: a failing column DDL is LOGGED (not silent) and never blocks the index; a failing index build is logged, never thrown', function () {
  const logs = [];
  const prevLogger = h.ctx.Logger;
  h.ctx.Logger = { log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); } };
  try {
    const d = ddlConn(/ADD COLUMN IF NOT EXISTS group_id/);
    assert.doesNotThrow(function () { h.call('escEnsureTable_', d.conn); });
    assert.ok(logs.some(function (l) { return /escEnsureTable_: linked-copy column DDL failed: boom/.test(l); }), logs.join('|'));
    assert.ok(d.ran.some(function (q) { return /CREATE UNIQUE INDEX/.test(q); }), 'the index still attempted');
    logs.length = 0;
    const d2 = ddlConn(/CREATE UNIQUE INDEX/);
    assert.doesNotThrow(function () { h.call('escEnsureTable_', d2.conn); });
    assert.ok(logs.some(function (l) { return /unique \(group_id, department\) index not built/.test(l); }));
    assert.ok(d2.ran.some(function (q) { return /CREATE TABLE IF NOT EXISTS escalation_activity/.test(q); }), 'later DDL still runs');
  } finally { h.ctx.Logger = prevLogger; }
});

test('ESC-DDL: escSchemaVerdict_ -- no table muted, missing columns warn (the outage case), missing index warn, else ok', function () {
  const f = h.fn('escSchemaVerdict_');
  const all = ['id', 'department', 'status', 'group_id', 'removed_by', 'removed_at', 'removed_reason', 'status_before_removal'];
  assert.equal(f({ columns: [], indexes: [] }).status, 'muted');
  const m = f({ columns: all.filter(function (c) { return c !== 'removed_at' && c !== 'group_id'; }), indexes: ['idx_escalations_group_dept'] });
  assert.equal(m.status, 'warn');
  assert.equal(m.value, 'missing column(s): group_id, removed_at');
  assert.match(m.hint, /EVERY escalation save and live Activity fail/);
  const i = f({ columns: all, indexes: ['escalations_pkey'] });
  assert.equal(i.status, 'warn');
  assert.match(i.value, /one-copy-per-department index missing/);
  assert.match(i.hint, /HAVING count\(\*\) > 1/);
  assert.equal(f({ columns: all, indexes: ['idx_escalations_group_dept'] }).status, 'ok');
});

test('ESC-DDL: escSchemaRead_ is one metered read of the live columns + index names', function () {
  let sqlSeen = '', metered = null;
  const prev = h.ctx.neonNoteEgress_;
  h.ctx.neonNoteEgress_ = function (n, label) { metered = label; };
  try {
    const conn = { createStatement: function () { return {
      executeQuery: function (sql) { sqlSeen = sql; let d = false;
        return { next: function () { if (d) return false; d = true; return true; },
          getString: function () { return JSON.stringify({ cols: ['id', 'group_id'], idx: ['escalations_pkey'] }); }, close: function () {} }; },
      close: function () {} }; } };
    const r = JSON.parse(JSON.stringify(h.call('escSchemaRead_', conn)));
    assert.deepEqual(r, { columns: ['id', 'group_id'], indexes: ['escalations_pkey'] });
    assert.match(sqlSeen, /information_schema\.columns/);
    assert.match(sqlSeen, /pg_indexes/);
    assert.equal(metered, 'escalations');
  } finally { h.ctx.neonNoteEgress_ = prev; }
});
