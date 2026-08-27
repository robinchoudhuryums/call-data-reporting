'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Coaching / turnover-suggestion engine, Phase 1 (dark). The pure gates are
// the point here: the half-the-team-rate RATIO (owner ruling after the first
// live preview -- ring-level data makes any fixed floor near 50% fire on
// everyone) AND the behind-team points floor AND missed-volume, over
// computeSummary_-shaped rows; TEAM_AVG_EXCLUDES out of both the team
// aggregate and candidacy. previewCoachingFlags is exercised with stubbed
// computeSummary_ / dept / holiday plumbing (its own compute is pinned by the
// dept-summary suite).

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Coaching.gs'] });

function row(agent, answered, missed, opts) {
  opts = opts || {};
  return {
    agent: agent,
    matchedViaRoster: opts.roster !== false,
    totalAnswered: answered,
    totalMissed: missed,
    totalRung: answered + missed,
  };
}

test('coaching: all three gates must hold — a qualifying agent is flagged with rate/team/ratio detail', function () {
  // Team aggregate INCLUDES the candidate (only TEAM_AVG_EXCLUDES leave it):
  // (180+170+15)/(200+200+70) = 365/470 = 77.66%. Low answers 15/70 = 21.4%,
  // i.e. 27.6% as often as the team — under the half-the-team ratio gate.
  const rows = [row('Anna', 180, 20), row('Bob', 170, 30), row('Low', 15, 55)];
  const flags = h.call('computeCoachingFlags_', rows, []);
  assert.equal(flags.length, 1);
  const f = flags[0];
  assert.equal(f.agent, 'Low');
  assert.equal(f.ratePct, 21.4, '15/70');
  assert.equal(f.teamRatePct, 77.7, 'team aggregate includes the candidate');
  assert.equal(f.gapPts, 56.2, 'gap behind team (77.66 - 21.43, rounded once)');
  assert.equal(f.teamRatioPct, 27.6, 'answers ~28% as often as the team');
  assert.equal(f.missed, 55);
});

test('coaching: the volume gate blocks a low-rate agent under the missed floor', function () {
  // 5/15 = 25% answered — terrible, but only 15 missed rings (< 20).
  const rows = [row('Anna', 180, 20), row('Quiet', 5, 15)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: the RATIO gate spares an agent who is behind but answers more than half as often as the team', function () {
  // Mid 55% vs a team of 86.8% -- 63% as often, i.e. behind by 32 points yet
  // clearly participating. The old absolute-50% floor would have flagged
  // nothing here either, but for the wrong reason (it sat above every real
  // team rate); this pins the gate that now does the work.
  const rows = [row('Anna', 900, 100), row('Mid', 55, 45)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
  // Drop to 40% of the team rate and the same agent IS flagged.
  const worse = [row('Anna', 900, 100), row('Mid', 30, 70)];
  const flags = h.call('computeCoachingFlags_', worse, []);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].agent, 'Mid');
});

test('coaching: ring-level reality — a whole team under 50% produces NO flags on its own', function () {
  // The measured shape of this install (team aggregates 17-49%): a fixed
  // absolute floor near 50% would flag every agent in every dept. Ratios do
  // not, because everyone here answers about as often as everyone else.
  const rows = [row('A', 40, 60), row('B', 38, 62), row('C', 42, 58)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: the points floor still blocks noise when HALF the team rate is a tiny gap', function () {
  // Team 3.5%: B answers 1% -- 29% as often (past the ratio gate) but only
  // 2.5 points behind, which is noise. The absolute floor holds the line.
  const rows = [row('A', 6, 94), row('B', 1, 99)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: a team that answers nothing yields no flags (no baseline to be half of)', function () {
  const rows = [row('A', 0, 50), row('B', 0, 60)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: the relative gate blocks a struggling agent on a struggling team', function () {
  // Everyone ~45% — Low is not 5 pts behind the team, so no flag (team
  // problem, not a person problem).
  const rows = [row('A', 45, 55), row('B', 46, 54), row('C', 44, 56)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: TEAM_AVG_EXCLUDES leaves both the team aggregate and candidacy', function () {
  // Manager Robin has awful numbers; excluded, so (a) he is never flagged and
  // (b) the team rate is computed without him — which is what pushes Low over
  // the relative gate.
  const rows = [row('Anna', 180, 20), row('Robin Choudhury', 5, 95), row('Low', 25, 45)];
  const withEx = h.call('computeCoachingFlags_', rows, ['Robin Choudhury']);
  assert.deepEqual(Array.from(withEx.map(function (f) { return f.agent; })), ['Low']);
  const without = h.call('computeCoachingFlags_', rows, []);
  assert.ok(without.some(function (f) { return f.agent === 'Robin Choudhury'; }),
    'un-excluded, the manager row would be flagged — the exclusion is doing the work');
});

test('coaching: non-roster rows and zero-activity rows are ignored', function () {
  const rows = [row('Floater', 10, 60, { roster: false }), row('Idle', 0, 0), row('Anna', 180, 20)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: window walks back over weekends and holidays', function () {
  // 2026-07-20 is a Monday. 10 working days back with 2026-07-10 (Fri) a
  // holiday: to=07-20, then 07-17..13 (5), 07-10 skipped (holiday), 07-09..07
  // (3), 07-06 (Mon) = 10th.
  const win = h.call('coachingWindowFromLatest_', '2026-07-20', 10, function (iso) {
    return iso === '2026-07-10';
  });
  assert.equal(win.to, '2026-07-20');
  assert.equal(win.from, '2026-07-06');
  // A Sunday latest steps back to Friday first.
  const win2 = h.call('coachingWindowFromLatest_', '2026-07-19', 5, function () { return false; });
  assert.equal(win2.to, '2026-07-17');
  assert.equal(win2.from, '2026-07-13');
});

test('coaching: previewCoachingFlags is admin-gated, scans every dept best-effort, stamps dept on each flag', function () {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  // Auth.gs isn't loaded — stub the resolver assertAdmin_ leans on.
  h.ctx.resolveUser_ = function () {
    return { email: h.state.userEmail, role: h.state.userEmail === 'admin@x.com' ? 'admin' : 'none' };
  };
  h.ctx.getLatestDataDate = function () { return '2026-07-20'; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales', 'Broken']; };
  h.ctx.getTeamAvgExcludes_ = function () { return []; };
  h.ctx.computeSummary_ = function (dept) {
    if (dept === 'Broken') throw new Error('boom');
    if (dept === 'CSR') return { rows: [row('Anna', 180, 20), row('Low', 15, 55)] };
    return { rows: [row('Sane', 90, 10)] };
  };
  const out = h.call('previewCoachingFlags');
  assert.equal(out.available, true);
  assert.deepEqual(JSON.parse(JSON.stringify(out.window)), { from: '2026-07-07', to: '2026-07-20' },
    '10 business days back from Mon 07-20, no holidays configured');
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].dept, 'CSR');
  assert.equal(out.flags[0].agent, 'Low');
  assert.equal(out.errors.length, 1, 'a throwing dept records an error, not a dead scan');
  assert.equal(out.errors[0].dept, 'Broken');
  assert.equal(out.thresholds.minMissed, 20);
  assert.equal(out.thresholds.maxTeamRatio, 0.5);

  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('previewCoachingFlags'); }, /admin/i);
});

// ── F-e: the delivery layer (weekly email + Neon worklist) ─────────────────
//
// Owner rulings pinned here: a SEPARATE worklist (no Escalations write
// anywhere), admin-only email until released, email ONLY on NEW flags,
// recovered open rows reported but never auto-closed.

function makeConn_(openRowsJson, opts) {
  opts = opts || {};
  const conn = {
    sql: [], params: [], committed: 0, rolledBack: 0, closed: false,
    createStatement: function () {
      return {
        execute: function (s) { conn.sql.push(s); },
        executeQuery: function (s) { conn.sql.push(s); return makeRs_(); },
        close: function () {},
      };
    },
    prepareStatement: function (s) {
      conn.sql.push(s);
      const ps = {
        _p: {},
        setString: function (i, v) { ps._p[i] = v; },
        executeQuery: function () { return makeRs_(); },
        execute: function () { conn.params.push({ sql: s, p: ps._p }); },
        executeUpdate: function () {
          conn.params.push({ sql: s, p: ps._p });
          return opts.updateResult === undefined ? 1 : opts.updateResult;
        },
        close: function () {},
      };
      return ps;
    },
    setAutoCommit: function () {},
    commit: function () { conn.committed++; },
    rollback: function () { conn.rolledBack++; },
    close: function () { conn.closed = true; },
  };
  function makeRs_() {
    let n = 0;
    return {
      next: function () { return n++ === 0; },
      getString: function () { return openRowsJson || '[]'; },
      close: function () {},
    };
  }
  return conn;
}

function flag_(dept, agent) {
  return { dept: dept, agent: agent, ratePct: 21.4, teamRatePct: 77.7,
           teamRatioPct: 27.6, gapPts: 56.2, missed: 55, rung: 70, answered: 15 };
}

function installDeliveryStubs_(previewFlags, openRowsJson, connOpts) {
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', DASHBOARD_URL: 'https://app/exec' };
  h.state.sentEmails.length = 0;
  h.ctx.computeCoachingPreview_ = function () {
    return { available: true, window: { from: '2026-07-07', to: '2026-07-20' },
             flags: previewFlags, errors: [], thresholds: {} };
  };
  const conn = makeConn_(openRowsJson, connOpts);
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  return conn;
}

test('coaching delivery: diff splits new / continuing / recovered — recovered rows are NEVER auto-closed', function () {
  const open = [
    { id: 'id-1', department: 'CSR', agent_name: 'Still Bad' },
    { id: 'id-2', department: 'Sales', agent_name: 'Recovered' },
  ];
  const flags = [flag_('CSR', 'Still Bad'), flag_('CSR', 'Brand New')];
  const d = JSON.parse(JSON.stringify(h.call('coachingDeliveryDiff_', flags, open)));
  assert.deepEqual(d.newFlags.map(function (f) { return f.agent; }), ['Brand New']);
  assert.deepEqual(d.continuing.map(function (c) { return c.id; }), ['id-1']);
  assert.deepEqual(d.recoveredOpenRows.map(function (r) { return r.id; }), ['id-2'],
    'reported for the email, and nothing in the run closes it');
  // Same agent name in a DIFFERENT dept is a different key (no cross-dept
  // de-dup — owner ruling, Shamir Alam under investigation).
  const d2 = h.call('coachingDeliveryDiff_', [flag_('Sales', 'Still Bad')], open);
  assert.equal(d2.newFlags.length, 1);
});

test('coaching delivery: a run with a NEW flag inserts, updates the continuing row, commits once, and emails admins', function () {
  const conn = installDeliveryStubs_(
    [flag_('CSR', 'Still Bad'), flag_('CSR', 'Brand New')],
    JSON.stringify([{ id: 'id-1', department: 'CSR', agent_name: 'Still Bad' }]));
  const out = JSON.parse(JSON.stringify(h.call('coachingDeliveryRun_')));
  assert.match(out.result, /^ok 1 new, 1 continuing, 0 recovered-open/);
  assert.match(out.result, /emailed admins/);
  assert.equal(conn.committed, 1, 'one transaction');
  assert.equal(conn.closed, true);
  const inserts = conn.params.filter(function (x) { return /INSERT INTO coaching_flags/.test(x.sql); });
  const updates = conn.params.filter(function (x) { return /UPDATE coaching_flags/.test(x.sql); });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].p[2], 'CSR');
  assert.equal(inserts[0].p[3], 'Brand New');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].p[10], 'id-1', 'continuing update targets the open row id');
  assert.match(updates[0].sql, /times_flagged = times_flagged \+ 1/);
  assert.equal(h.state.sentEmails.length, 1);
  const mail = h.state.sentEmails[0];
  assert.equal(mail.to, 'admin@x.com', 'admin-only until released (owner ruling)');
  assert.match(mail.body, /Brand New/);
  assert.match(mail.body, /#\/admin\/coaching/, 'deep link to the worklist route');
  assert.match(mail.body, /Admin-only until released/);
});

test('coaching delivery: nothing NEW → no email (continuing flags are not news; quota is shared — B3)', function () {
  installDeliveryStubs_(
    [flag_('CSR', 'Still Bad')],
    JSON.stringify([
      { id: 'id-1', department: 'CSR', agent_name: 'Still Bad' },
      { id: 'id-2', department: 'Sales', agent_name: 'Recovered' },
    ]));
  const out = h.call('coachingDeliveryRun_');
  assert.match(out.result, /^ok 0 new, 1 continuing, 1 recovered-open/);
  assert.match(out.result, /no email \(nothing new\)/);
  assert.equal(h.state.sentEmails.length, 0);
});

test('coaching delivery: Neon down / flags unavailable each skip LOUDLY (OPS-8 bad-word result), never throw', function () {
  installDeliveryStubs_([flag_('CSR', 'X')], '[]');
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  const down = h.call('coachingDeliveryRun_');
  assert.match(down.result, /^skipped \(Neon unreachable/);
  assert.equal(h.state.sentEmails.length, 0, 'no email without a worklist to land cards in');

  h.ctx.computeCoachingPreview_ = function () { return { available: false, reason: 'no DQE data' }; };
  assert.match(h.call('coachingDeliveryRun_').result, /^skipped \(no DQE data\)/);
});

test('coaching delivery: a mid-txn failure rolls back and rethrows into the handler\'s ERROR result', function () {
  const conn = installDeliveryStubs_([flag_('CSR', 'Brand New')], '[]');
  const realPrepare = conn.prepareStatement;
  conn.prepareStatement = function (s) {
    if (/INSERT INTO coaching_flags/.test(s)) throw new Error('disk full');
    return realPrepare(s);
  };
  assert.throws(function () { h.call('coachingDeliveryRun_'); }, /disk full/);
  assert.equal(conn.rolledBack, 1);
  assert.equal(conn.committed, 0);
  assert.equal(conn.closed, true, 'connection closed on the failure path too');
});

test('coaching delivery: runCoachingDelivery_ is FLAG-GATED and records OPS-8 outcome props', function () {
  let ran = 0;
  // Save/RESTORE the real binding: `delete h.ctx.coachingDeliveryRun_` used
  // to remove the ORIGINAL vm global (the stub had overwritten the same own
  // property), leaving every later test without the real function.
  const realDeliveryRun = h.ctx.coachingDeliveryRun_;
  h.ctx.coachingDeliveryRun_ = function () { ran++; return { result: 'ok 0 new, 0 continuing, 0 recovered-open (a..b) — no email (nothing new)' }; };
  h.state.props = {};   // flag unset → no-op, no outcome stamped
  h.call('runCoachingDelivery_');
  assert.equal(ran, 0);
  assert.equal(h.state.props.COACHING_DELIVERY_LAST_RESULT, undefined);

  h.state.props = { COACHING_DELIVERY_ENABLED: 'true' };
  h.call('runCoachingDelivery_');
  assert.equal(ran, 1);
  assert.ok(h.state.props.COACHING_DELIVERY_LAST, 'timestamp stamped');
  assert.match(h.state.props.COACHING_DELIVERY_LAST_RESULT, /^ok /);

  // A throw inside the run lands as ERROR: (the classifier's bad-word match).
  h.ctx.coachingDeliveryRun_ = function () { throw new Error('boom'); };
  h.call('runCoachingDelivery_');
  assert.match(h.state.props.COACHING_DELIVERY_LAST_RESULT, /^ERROR: boom/);
  h.ctx.coachingDeliveryRun_ = realDeliveryRun;
});

function installAdmin_() {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { ADMIN_EMAILS: 'admin@x.com' };
  h.ctx.resolveUser_ = function () {
    return { email: h.state.userEmail, role: h.state.userEmail === 'admin@x.com' ? 'admin' : 'none' };
  };
}

test('coaching worklist: admin-gated; status filter maps to the WHERE clause; no conn → available:false', function () {
  installAdmin_();
  const conn = makeConn_('[]');
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  const out = JSON.parse(JSON.stringify(h.call('getCoachingWorklist', { status: 'closed' })));
  assert.equal(out.available, true);
  assert.equal(out.meta.status, 'closed');
  assert.ok(conn.sql.some(function (s) { return /status <> 'open'/.test(s); }),
    'closed = everything not open (resolved + dismissed)');
  // Unknown filter falls back to open; open filters on = 'open'.
  const conn2 = makeConn_('[]');
  h.ctx.getDashboardNeonConn_ = function () { return conn2; };
  assert.equal(h.call('getCoachingWorklist', { status: 'sneaky' }).meta.status, 'open');
  assert.ok(conn2.sql.some(function (s) { return /WHERE status = 'open'/.test(s); }));

  h.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.equal(h.call('getCoachingWorklist', {}).available, false);

  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('getCoachingWorklist', {}); }, /admin/i);
});

test('coaching close: open-only UPDATE — a stale id / already-closed row is a clear error, never a silent overwrite', function () {
  installAdmin_();
  const conn = makeConn_('[]');
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  const before = h.state.locks;
  const out = h.call('updateCoachingFlagStatus', { id: 'id-9', action: 'Resolved', note: '  talked on Friday  ' });
  assert.equal(out.status, 'resolved', 'action is case-normalized');
  assert.equal(h.state.locks, before + 1, 'LockService serialization (INV-01 data-mutation set)');
  const upd = conn.params.filter(function (x) { return /UPDATE coaching_flags/.test(x.sql); })[0];
  assert.match(upd.sql, /AND status = 'open'/);
  assert.equal(upd.p[1], 'resolved');
  assert.equal(upd.p[2], 'talked on Friday', 'note trimmed');
  assert.equal(upd.p[3], 'admin@x.com', 'closed_by audit');
  assert.equal(upd.p[4], 'id-9');

  // 0 rows updated → the race error.
  h.ctx.getDashboardNeonConn_ = function () { return makeConn_('[]', { updateResult: 0 }); };
  assert.throws(function () { h.call('updateCoachingFlagStatus', { id: 'id-9', action: 'resolved' }); },
    /not open any more/);

  // Validation: bad action, missing id, oversize note capped not rejected.
  assert.throws(function () { h.call('updateCoachingFlagStatus', { id: 'x', action: 'deleted' }); },
    /resolved.*dismissed/i);
  assert.throws(function () { h.call('updateCoachingFlagStatus', { action: 'resolved' }); }, /Missing flag id/);
  const conn3 = makeConn_('[]');
  h.ctx.getDashboardNeonConn_ = function () { return conn3; };
  h.call('updateCoachingFlagStatus', { id: 'x', action: 'dismissed', note: new Array(700).join('n') });
  const upd3 = conn3.params.filter(function (x) { return /UPDATE coaching_flags/.test(x.sql); })[0];
  assert.equal(upd3.p[2].length, 500, 'note capped at COACHING_NOTE_MAX_');

  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('updateCoachingFlagStatus', { id: 'x', action: 'resolved' }); }, /admin/i);
});

test('coaching triggers: install sets the enabled flag, uninstall clears it (the flag-gated-engine pattern)', function () {
  installAdmin_();
  h.call('installCoachingDeliveryTrigger');
  assert.equal(h.state.props.COACHING_DELIVERY_ENABLED, 'true');
  h.call('uninstallCoachingDeliveryTrigger');
  assert.equal(h.state.props.COACHING_DELIVERY_ENABLED, undefined);
});

// P13 (broad-scan 2026-08-27, OPS-1): flags commit BEFORE the email, so a
// failed send used to orphan the batch — next run classed them 'continuing'
// ("not re-notified") and no path ever emailed them. Un-notified flags now
// park in COACHING_NOTIFY_PENDING and fold into the next send; the property
// clears only on a CONFIRMED send.
//

test('coaching delivery P13: a failed send keeps the committed flags PENDING and says so', function () {
  const conn = installDeliveryStubs_([flag_('CSR', 'Brand New')], '[]');
  const realMail = h.ctx.MailApp;
  h.ctx.MailApp = { sendEmail: function () { throw new Error('Service invoked too many times'); } };
  let out;
  try { out = h.call('coachingDeliveryRun_'); } finally { h.ctx.MailApp = realMail; }
  assert.match(out.result, /EMAIL NOT SENT \(send failed\); 1 flag\(s\) kept pending/);
  assert.equal(conn.committed, 1, 'the data work still committed — only the notification is pending');
  const pending = JSON.parse(h.state.props.COACHING_NOTIFY_PENDING);
  assert.deepEqual(pending.flags.map(function (f) { return f.agent; }), ['Brand New']);
});

test('coaching delivery P13: the next run folds pending flags into its email and clears the marker', function () {
  installDeliveryStubs_([], '[]');   // nothing new this run
  h.state.props.COACHING_NOTIFY_PENDING = JSON.stringify({
    window: { from: '2026-07-07', to: '2026-07-20' },
    flags: [{ dept: 'CSR', agent: 'Brand New', ratePct: 10, teamRatePct: 40,
              teamRatioPct: 25, gapPts: 30, missed: 30, rung: 40, answered: 4 }],
  });
  const out = h.call('coachingDeliveryRun_');
  assert.match(out.result, /emailed admins \(incl\. 1 retried from a previous failed send\)/);
  assert.equal(h.state.sentEmails.length, 1);
  assert.match(h.state.sentEmails[0].body, /Brand New/);
  assert.equal(h.state.props.COACHING_NOTIFY_PENDING, undefined, 'cleared on the confirmed send');
});

test('coaching delivery P13: no admin recipients parks the batch instead of claiming a send', function () {
  installDeliveryStubs_([flag_('CSR', 'Nobody Told')], '[]');
  h.state.props.ADMIN_EMAILS = '';
  h.ctx.getAdminEmails_ = function () { return []; };
  let out;
  try { out = h.call('coachingDeliveryRun_'); } finally { delete h.ctx.getAdminEmails_; }
  assert.match(out.result, /EMAIL NOT SENT \(no admin recipients\)/);
  assert.ok(h.state.props.COACHING_NOTIFY_PENDING, 'batch parked for retry');
});
