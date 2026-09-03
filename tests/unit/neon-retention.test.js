'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// R27: the Neon retention prune -- the storage-cap control. Pinned here:
//   (1) horizons are FLOORED, and the call-row floor sits strictly above the
//       coverage checks' maximum window, so a pruned date can never read as a
//       coverage gap;
//   (2) the plan touches exactly the six (table, action) pairs and never the
//       phones / dept / direct / escalation tables; every statement is
//       ctid-batched with a LIMIT;
//   (3) the executor keeps batching a step until a batch comes back short,
//       stops on the run budget (reported `ok`, not FAILED), treats a missing
//       table as a clean per-step skip, and isolates a throwing step;
//   (4) the outcome is OPS-8 prefix-coded, admins are emailed only on FAILED;
//   (5) the weekly handler is flag-gated and never throws; install/uninstall
//       are admin-gated and reversible.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonRetention.gs'] });
const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function props(extra) {
  h.state.userEmail = 'admin@x.com';
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, extra || {});
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: {} });
  return { getProperty: function (k) { return h.state.props[k] == null ? null : h.state.props[k]; } };
}

test('R27: horizons default, honor overrides, and are floored', function () {
  const d = h.call('neonRetentionSettings_', props());
  assert.deepEqual(JSON.parse(JSON.stringify(d)), { journeyDays: 90, callDays: 400, historyMonths: 13 });
  const o = h.call('neonRetentionSettings_', props({
    NEON_RETENTION_JOURNEY_DAYS: '120', NEON_RETENTION_CALL_DAYS: '500', NEON_RETENTION_HISTORY_MONTHS: '18' }));
  assert.deepEqual(JSON.parse(JSON.stringify(o)), { journeyDays: 120, callDays: 500, historyMonths: 18 });
  const f = h.call('neonRetentionSettings_', props({
    NEON_RETENTION_JOURNEY_DAYS: '5', NEON_RETENTION_CALL_DAYS: '30', NEON_RETENTION_HISTORY_MONTHS: '2' }));
  assert.deepEqual(JSON.parse(JSON.stringify(f)), { journeyDays: 30, callDays: 367, historyMonths: 13 },
    'an operator cannot set a horizon below the floors');
  const junk = h.call('neonRetentionSettings_', props({ NEON_RETENTION_CALL_DAYS: 'lots' }));
  assert.equal(junk.callDays, 400, 'unparseable -> default');
});

test('R27: the call-row floor is strictly above the coverage checks\' max window', function () {
  const floors = h.ctx.NEON_RETENTION_FLOORS_;
  ['NeonCoverage.gs', 'SheetCoverage.gs'].forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    const m = src.match(/days > (\d+)\)/);
    assert.ok(m, f + ' names its max window as `days > N)`');
    assert.ok(floors.callDays > Number(m[1]),
      f + ' can look back ' + m[1] + ' days; a retention floor of ' + floors.callDays
      + ' must exceed it or a pruned date reads as a coverage gap');
  });
  // 13 months is also past the 366-day coverage window and the INV-29 12-month trend.
  assert.ok(floors.historyMonths >= 13);
});

test('R27: the plan is six ctid-batched statements over exactly the retained tables', function () {
  const plan = h.call('neonRetentionPlan_', { journeyDays: 90, callDays: 400, historyMonths: 13 }, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.map(function (s) { return s.key; }))),
    ['inbound_calls:journey', 'outbound_calls:journey', 'inbound_calls:rows',
     'outbound_calls:rows', 'dqe_history:rows', 'qcd_history:rows']);
  plan.forEach(function (s) {
    assert.match(s.sql, /WHERE ctid IN \(SELECT ctid FROM \w+ WHERE .* LIMIT 5000\)$/, s.key + ' is ctid-batched');
    assert.ok(!/call_history_phones|call_history_dept|direct_call_history|escalation|coaching/.test(s.sql),
      s.key + ' must never touch the untouchable tables');
  });
  assert.match(plan[0].sql, /^UPDATE inbound_calls SET journey = NULL .*journey IS NOT NULL AND call_date < CURRENT_DATE - 90 /);
  assert.match(plan[2].sql, /^DELETE FROM inbound_calls .*call_date < CURRENT_DATE - 400 /);
  assert.match(plan[4].sql, /^DELETE FROM dqe_history .*call_date < \(CURRENT_DATE - INTERVAL '13 months'\)::date /);
  // Operator input reaches the SQL only as integers.
  const evil = h.call('neonRetentionPlan_', { journeyDays: '90; DROP TABLE x', callDays: 400, historyMonths: 13 }, 10);
  assert.match(evil[0].sql, /CURRENT_DATE - 90 LIMIT 10\)$/);
});

// A recording conn: `counts[key]` is the sequence of update counts a step's
// batches return; `throws[key]` makes the step's first statement throw.
function conn(counts, throws) {
  const seen = [];
  return {
    seen: seen,
    createStatement: function () {
      return {
        setQueryTimeout: function () {},
        executeUpdate: function (sql) {
          seen.push(sql);
          const tk = Object.keys(throws || {}).filter(function (k) { return sql.indexOf(k) >= 0; })[0];
          if (tk) throw new Error(throws[tk]);
          const key = Object.keys(counts).filter(function (k) { return sql.indexOf(k) >= 0; })[0];
          const q = counts[key] || [];
          return q.length ? q.shift() : 0;
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function plan(batch) {
  return h.call('neonRetentionPlan_', { journeyDays: 90, callDays: 400, historyMonths: 13 }, batch);
}

test('R27: a step keeps batching until a batch comes back short', function () {
  const c = conn({ 'SET journey = NULL WHERE ctid IN (SELECT ctid FROM inbound_calls': [3, 3, 1],
                   'DELETE FROM qcd_history': [0] });
  const res = h.call('neonRetentionExecute_', c, plan(3), { batch: 3 });
  const inb = res.steps[0];
  assert.equal(inb.rows, 7); assert.equal(inb.batches, 3); assert.equal(inb.done, true);
  assert.equal(res.steps[5].batches, 1, 'a zero first batch ends the step');
  assert.equal(res.rows, 7);
  assert.equal(res.errors.length, 0);
  assert.equal(c.seen.length, 3 + 1 + 1 + 1 + 1 + 1, 'one statement per batch, every step visited');
});

test('R27: the run budget stops batching and is reported ok (it continues next run)', function () {
  let t = 0;
  const c = conn({ 'FROM inbound_calls WHERE journey': [5, 5, 5, 5, 5] });
  const res = h.call('neonRetentionExecute_', c, plan(5),
    { batch: 5, budgetMs: 100, now: function () { t += 60; return t; } });
  assert.equal(res.budgetHit, true);
  assert.ok(res.steps[0].rows > 0 && res.steps[0].done === false, 'first step left unfinished');
  assert.equal(res.steps[1].batches, 0, 'later steps not attempted this run');
  const s = h.call('neonRetentionSummary_', { journeyDays: 90, callDays: 400, historyMonths: 13 }, res);
  assert.match(s, /^ok pruned \d+ row\(s\), budget hit/);
  assert.match(s, /inbound_calls:journey=\d+\+/, 'an unfinished step is marked with +');
});

test('R27: a not-yet-created table is a clean per-step skip; a throwing step is isolated and FAILED', function () {
  const c = conn({ 'DELETE FROM dqe_history': [2] },
    { 'outbound_calls SET journey': 'ERROR: relation "outbound_calls" does not exist',
      'DELETE FROM inbound_calls': 'deadlock detected' });
  const res = h.call('neonRetentionExecute_', c, plan(5), { batch: 5 });
  assert.equal(res.steps[1].skipped, 'table not created yet');
  assert.equal(res.steps[2].error, 'deadlock detected');
  assert.equal(res.steps[4].rows, 2, 'steps after the throw still run');
  assert.deepEqual(JSON.parse(JSON.stringify(res.errors)), ['inbound_calls:rows: deadlock detected']);
  const s = h.call('neonRetentionSummary_', { journeyDays: 90, callDays: 400, historyMonths: 13 }, res);
  assert.match(s, /^FAILED 1 step\(s\) threw/);
  assert.match(s, /outbound_calls:journey=n\/a/);
  assert.match(s, /inbound_calls:rows=ERR/);
});

function runWith(counts, throws) {
  props();
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (m) { mails.push(m); } };
  h.ctx.getDashboardNeonConn_ = function () { return conn(counts, throws); };
  return mails;
}

test('R27: runNeonRetentionPrune is admin-gated, records the OPS-8 outcome, emails only on FAILED', function () {
  const mails = runWith({ 'DELETE FROM qcd_history': [4] });
  const out = h.call('runNeonRetentionPrune');
  assert.equal(out.rows, 4);
  assert.match(h.state.props.NEON_RETENTION_LAST_RESULT, /^ok pruned 4 row\(s\)/);
  assert.ok(h.state.props.NEON_RETENTION_LAST);
  assert.equal(mails.length, 0, 'a clean run is silent');

  const mails2 = runWith({}, { 'DELETE FROM dqe_history': 'boom' });
  h.call('runNeonRetentionPrune');
  assert.match(h.state.props.NEON_RETENTION_LAST_RESULT, /^FAILED /);
  assert.equal(mails2.length, 1);
  assert.match(mails2[0].subject, /Neon retention prune FAILED/);

  h.ctx.getDashboardNeonConn_ = function () { return null; };
  const sk = h.call('runNeonRetentionPrune');
  assert.equal(sk.skipped, true);
  assert.match(h.state.props.NEON_RETENTION_LAST_RESULT, /^skipped \(Neon unreachable/);

  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('runNeonRetentionPrune'); }, /admin/i);
});

test('R27: the weekly handler NO-OPS when the flag is off, runs when on, never throws', function () {
  runWith({ 'DELETE FROM qcd_history': [1] });
  delete h.state.props.NEON_RETENTION_LAST_RESULT;
  h.call('runNeonRetentionWeekly_');
  assert.ok(!('NEON_RETENTION_LAST_RESULT' in h.state.props), 'installed-but-disabled must do nothing');
  h.state.props.NEON_RETENTION_ENABLED = 'true';
  h.call('runNeonRetentionWeekly_');
  assert.match(h.state.props.NEON_RETENTION_LAST_RESULT, /^ok pruned 1 /);
  h.ctx.getDashboardNeonConn_ = function () { throw new Error('connect exploded'); };
  assert.doesNotThrow(function () { h.call('runNeonRetentionWeekly_'); });
  assert.match(h.state.props.NEON_RETENTION_LAST_RESULT, /^FAILED connect exploded/);
});

test('R27: install/uninstall are admin-gated and fully reversible', function () {
  props();
  const made = [];
  h.ctx.ScriptApp = {
    WeekDay: { SUNDAY: 'SUN' },
    getProjectTriggers: function () { return made.slice(); },
    deleteTrigger: function (t) { made.splice(made.indexOf(t), 1); },
    newTrigger: function (fn) {
      const t = { getHandlerFunction: function () { return fn; } };
      const b = { timeBased: function () { return b; }, onWeekDay: function (d) { b.day = d; return b; },
                  atHour: function () { return b; },
                  create: function () { made.push(t); return t; } };
      return b;
    },
  };
  const on = h.call('installNeonRetentionTrigger');
  assert.equal(on.enabled, true); assert.equal(on.installed, true);
  assert.equal(on.settings.callDays, 400);
  assert.equal(h.state.props.NEON_RETENTION_ENABLED, 'true');
  const off = h.call('uninstallNeonRetentionTrigger');
  assert.equal(off.enabled, false); assert.equal(off.installed, false);
  assert.ok(!('NEON_RETENTION_ENABLED' in h.state.props));
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('installNeonRetentionTrigger'); }, /admin/i);
});
