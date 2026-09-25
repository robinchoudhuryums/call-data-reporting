'use strict';

// ENG-3 (broad-scan 2026-09-23): the daily alerts' DQE-readiness gate.
//
// The 8 AM trigger assessed the previous business day at that minute; when
// the morning import had not landed, every dept read 0 rung -> `no-data`, no
// retry, and an `ok` Health outcome. Alerts now reuse the digest's R31 gate
// (digestDailyDecision_ + digestLatestDqeIso_): defer with a one-shot retry
// until the noon cutoff, then assess anyway with a LATE outcome; a run marker
// keeps a retry from re-alerting a day already assessed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Alerts.gs', 'Digest.gs',
  'SystemHealth.gs'] });

// Tue 2026-09-22 in Chicago -> assesses Mon 2026-09-21.
function at(hhmm) { return new Date('2026-09-22T' + hhmm + ':00-05:00'); }

function install(latestDqe, props) {
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
  const made = [];
  h.ctx.ScriptApp = {
    getProjectTriggers: function () { return made.slice(); },
    deleteTrigger: function (t) { made.splice(made.indexOf(t), 1); },
    newTrigger: function (fn) {
      const b = { timeBased: function () { return b; }, after: function () { return b; },
        create: function () { const t = { getHandlerFunction: function () { return fn; } }; made.push(t); return t; } };
      return b;
    },
  };
  h.ctx.getCompanyHolidayRanges_ = function () { return []; };
  h.ctx.digestLatestDqeIso_ = function () { return latestDqe; };
  const calls = [];
  h.ctx.runAlertsCore_ = function (dateIso, dryRun, by) {
    calls.push(dateIso + '|' + by);
    return [{ status: 'sent' }, { status: 'above-threshold' }];
  };
  return { made: made, calls: calls };
}

test('ENG-3: data not landed before the cutoff -> DEFER with a one-shot retry, nothing assessed', function () {
  const env = install('2026-09-18');   // latest DQE is the Friday before
  const res = h.call('alertsGatedAttempt_', at('08:05'), 'trigger');
  assert.equal(res.decision, 'defer');
  assert.equal(env.calls.length, 0, 'no department assessed against missing data');
  assert.deepEqual(env.made.map(function (t) { return t.getHandlerFunction(); }), ['runDailyAlertsRetry_']);
  assert.match(h.state.props.ALERTS_LAST_RESULT, /^DEFERRED 2026-09-21: DQE data is through 2026-09-18/);
  assert.equal(h.state.props.ALERTS_RUN_MARKER, undefined);
});

test('ENG-3: data landed -> assess once, mark the day, clear the retry; a later retry is a no-op', function () {
  const env = install('2026-09-21');
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');   // (fresh) runs
  assert.deepEqual(env.calls.slice(), ['2026-09-21|daily-trigger']);
  assert.equal(h.state.props.ALERTS_RUN_MARKER, '2026-09-21');
  assert.match(h.state.props.ALERTS_LAST_RESULT, /^ok 2026-09-21:/);
  assert.equal(env.made.length, 0);
  const again = h.call('alertsGatedAttempt_', at('09:05'), 'retry');
  assert.equal(again.decision, 'done');
  assert.equal(env.calls.length, 1, 'a day is never re-alerted');
});

test('ENG-3: still missing at the noon cutoff -> assess anyway and record LATE (a bad Health outcome)', function () {
  const env = install('2026-09-18');
  const res = h.call('alertsGatedAttempt_', at('12:05'), 'retry');
  assert.equal(res.decision, 'run-late');
  assert.equal(env.calls.length, 1);
  const out = h.state.props.ALERTS_LAST_RESULT;
  assert.match(out, /^LATE 2026-09-21: DQE data was still only through 2026-09-18 at the 12:00 cutoff/);
  assert.equal(h.call('healthOutcomeIsBad_', out), true);
});

test('ENG-3: an all-no-data run leads EMPTY (bad), errors still lead FAILED-PARTIAL', function () {
  install('2026-09-21');
  const empty = h.call('alertsOutcomeString_', '2026-09-21', [{ status: 'no-data' }, { status: 'no-data' }]);
  assert.match(empty, /^EMPTY 2026-09-21: every dept had no data; 2 dept\(s\) assessed/);
  assert.equal(h.call('healthOutcomeIsBad_', empty), true);
  const mixed = h.call('alertsOutcomeString_', '2026-09-21', [{ status: 'no-data' }, { status: 'sent' }]);
  assert.match(mixed, /^ok /);
  assert.match(h.call('alertsOutcomeString_', '2026-09-21', [{ status: 'error' }], { lateLatest: 'x' }), /^FAILED-PARTIAL/);
});

test('ENG-3: weekends and holidays still skip before the gate; uninstall clears a pending retry', function () {
  const env = install('2026-09-18');
  assert.equal(h.call('alertsGatedAttempt_', new Date('2026-09-26T08:05:00-05:00'), 'trigger').decision, 'skip-weekend');
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');   // schedules a retry
  assert.equal(env.made.length, 1);
  h.call('uninstallAlertTrigger_');
  assert.equal(env.made.length, 0, 'the retry does not outlive the uninstall');
});

// Batch 4 follow-on (the ENG-5 pattern): an assessment stamps ALERTS_STARTED
// before it runs, so a run killed at the execution ceiling -- which records no
// outcome and skips the catch -- is visible as INTERRUPTED on the Health page.
test('Batch 4 follow-on: an assessment stamps ALERTS_STARTED; a DEFER does not', function () {
  install('2026-09-18');
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');   // defers
  assert.equal(h.state.props.ALERTS_STARTED, undefined, 'nothing was assessed, nothing started');
  install('2026-09-21');
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');   // runs
  assert.ok(h.state.props.ALERTS_STARTED, 'the run stamps its start');
  assert.ok(Date.parse(h.state.props.ALERTS_LAST) >= Date.parse(h.state.props.ALERTS_STARTED),
    'a finished run records its outcome AFTER the start, so it never reads INTERRUPTED');
});

// ENG-4 (broad-scan 2026-09-23, Batch 8, re-scoped after ENG-3): a second
// admin's trigger is a second daily run. The run marker was read before and
// written after the run, so two runs firing together both alerted. The date
// is now claimed under the script lock; a concurrent run stands down.
test('ENG-4: a run in flight for the same date makes a concurrent trigger stand down', function () {
  const env = install('2026-09-21', { ALERTS_RUN_CLAIM: '2026-09-21|' + Date.now() });
  const res = h.call('alertsGatedAttempt_', at('08:05'), 'trigger');
  assert.equal(res.decision, 'in-flight');
  assert.equal(env.calls.length, 0, 'the second trigger assessed nothing');
});

test('ENG-4: the claim is released after the run (and a stale claim is ignored)', function () {
  let env = install('2026-09-21');
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');
  assert.equal(env.calls.length, 1);
  assert.equal(h.state.props.ALERTS_RUN_CLAIM, undefined, 'released on the success path');
  env = install('2026-09-21', { ALERTS_RUN_CLAIM: '2026-09-21|' + (Date.now() - 21 * 60000) });
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');
  assert.equal(env.calls.length, 1, 'a claim older than the stale limit is a killed run, ignored');
  env = install('2026-09-21');
  h.ctx.runAlertsCore_ = function () { throw new Error('boom'); };
  h.call('alertsGatedAttempt_', at('08:05'), 'trigger');
  assert.equal(h.state.props.ALERTS_RUN_CLAIM, undefined, 'released on the throw path too');
});

test('ENG-4: a BUSY script lock (some other admin write) reschedules instead of losing the day', function () {
  const env = install('2026-09-21');
  h.state.lockBusy = true;
  try {
    const res = h.call('alertsGatedAttempt_', at('08:05'), 'trigger');
    assert.equal(res.decision, 'defer');
    assert.equal(env.calls.length, 0);
    assert.deepEqual(env.made.map(function (t) { return t.getHandlerFunction(); }), ['runDailyAlertsRetry_']);
    assert.match(h.state.props.ALERTS_LAST_RESULT, /^DEFERRED 2026-09-21: the script lock was busy/);
  } finally { h.state.lockBusy = false; }
});
