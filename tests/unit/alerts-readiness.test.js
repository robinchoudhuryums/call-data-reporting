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

// F19 (broad-scan 2026-10-14): `skipped` rows (an inactive dept, a duplicate
// row, a skip date) are config, not data. Counting them made EMPTY
// unreachable once any one existed, so an all-no-data run read `ok`.
test('F19: EMPTY is judged over the ASSESSED depts -- a skipped config row cannot hide it', function () {
  install('2026-09-21');
  const withSkip = h.call('alertsOutcomeString_', '2026-09-21',
    [{ status: 'no-data' }, { status: 'no-data' }, { status: 'skipped' }]);
  assert.match(withSkip, /^EMPTY 2026-09-21: every dept had no data/);
  assert.equal(h.call('healthOutcomeIsBad_', withSkip), true);
  assert.match(h.call('alertsOutcomeString_', '2026-09-21', [{ status: 'skipped' }, { status: 'skipped' }]), /^ok /,
    'nothing assessed at all (every dept configured off) is not EMPTY');
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

// ── EN-2 / AC-4 / EN-5 (broad-scan 2026-10-01) ─────────────────────────────
// A fresh harness: the tests above stub runAlertsCore_ itself.
const h2 = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Alerts.gs', 'Digest.gs',
  'SystemHealth.gs'] });

// A LockService that knows whether the script lock is HELD (the shim's only
// answers tryLock). `held` is what an escalation write / digest would contend on.
function trackingLock() {
  const st = { held: 0, peakDuringSend: 0 };
  h2.ctx.LockService = { getScriptLock: function () {
    let mine = false;
    return {
      tryLock: function () { if (st.held) return false; st.held++; mine = true; return true; },
      waitLock: function () { st.held++; mine = true; },
      releaseLock: function () { if (mine) { st.held--; mine = false; } },
      hasLock: function () { return mine; },
    };
  } };
  return st;
}

function installCore(lockState, sent) {
  h2.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h2.state.userEmail = 'admin@x.com';
  h2.ctx.isIsoDate_ = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); };   // lives in Data.gs (not loaded)
  h2.ctx.openSpreadsheet_ = function () { return { getSheetByName: function () { return {}; } }; };
  h2.ctx.appendAlertLog_ = function () {};
  h2.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h2.ctx.readAlertConfig_ = function () {
    return [{ department: 'CSR', active: true, threshold: 90, skipDates: '' },
            { department: 'Sales', active: true, threshold: 90, skipDates: '' }];
  };
  h2.ctx.getRosterForDepartment_ = function () { return { names: ['A'] }; };
  h2.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 5, missed: 5, pct: 50 }; };
  h2.ctx.resolveRecipients_ = function () { return ['m@x.com']; };
  h2.ctx.sendAlertEmail_ = function (entry) {
    sent.push(entry.department);
    lockState.peakDuringSend = Math.max(lockState.peakDuringSend, lockState.held);
  };
}

test('EN-2 / AC-4: a real alerts run sends with the script lock FREE (digests, coaching and escalation writes are not starved)', function () {
  const lock = trackingLock();
  const sent = [];
  installCore(lock, sent);
  const res = h2.call('runAlertsCore_', '2026-09-21', false, 'daily-trigger');
  assert.equal(sent.length, 2, 'both depts below threshold were alerted');
  assert.equal(lock.peakDuringSend, 0,
    'pre-fix the F4 lock was held across every compute + send (minutes at 8 AM)');
  assert.ok(res.every(function (r) { return r.status === 'sent'; }));
  // ...and while it runs, another writer can take the lock (an escalation verb's tryLock).
  h2.ctx.sendAlertEmail_ = function () {
    const other = h2.ctx.LockService.getScriptLock();
    assert.ok(other.tryLock(15000), 'an escalation write mid-alerts-run gets the lock');
    other.releaseLock();
  };
  h2.call('runAlertsCore_', '2026-09-21', false, 'daily-trigger');
});

test('EN-2: a manual send is refused while a run for the SAME date is in flight (the double-click guard)', function () {
  trackingLock();
  const sent = [];
  installCore({ held: 0, peakDuringSend: 0 }, sent);
  h2.state.props.ALERTS_RUN_CLAIM = '2026-09-21|' + Date.now();
  assert.throws(function () { h2.call('sendAlerts', { date: '2026-09-21' }); }, /already in progress/);
  assert.equal(sent.length, 0);
});

test('EN-5: a manual send marks the date, so the 8 AM trigger does not send the same alerts again', function () {
  trackingLock();
  const sent = [];
  installCore({ held: 0, peakDuringSend: 0 }, sent);
  h2.ctx.getCompanyHolidayRanges_ = function () { return []; };
  h2.ctx.digestLatestDqeIso_ = function () { return '2026-09-21'; };
  h2.call('sendAlerts', { date: '2026-09-21' });
  assert.equal(sent.length, 2);
  assert.equal(h2.state.props.ALERTS_RUN_MARKER, '2026-09-21');
  assert.match(h2.state.props.ALERTS_LAST_RESULT, /^\S+ 2026-09-21:/, 'the outcome the trigger will not write is recorded');
  assert.equal(h2.state.props.ALERTS_RUN_CLAIM, undefined, 'claim released');
  const res = h2.call('alertsGatedAttempt_', new Date('2026-09-22T08:05:00-05:00'), 'trigger');
  assert.equal(res.decision, 'done');
  assert.equal(sent.length, 2, 'pre-fix: the trigger re-sent both depts');

  // A deliberate sequential re-send is still allowed, and a BACK-dated one
  // never moves the marker backwards (that would re-open the newer day).
  h2.call('sendAlerts', { date: '2026-09-21' });
  assert.equal(sent.length, 4);
  h2.call('sendAlerts', { date: '2026-09-18' });
  assert.equal(h2.state.props.ALERTS_RUN_MARKER, '2026-09-21');
});

// B2/ENG-1 (broad-scan 2026-10-12): an admin re-installing the triggers
// mid-morning, after a DEFERRED, deleted the pending one-shot retry with them
// -- that day's alerts / digests never went out. A re-install now keeps it;
// an explicit uninstall still removes it.
function fullTriggers_() {
  const made = [];
  h.ctx.ScriptApp = {
    WeekDay: { MONDAY: 'MONDAY' },
    getProjectTriggers: function () { return made.slice(); },
    deleteTrigger: function (t) { made.splice(made.indexOf(t), 1); },
    newTrigger: function (fn) {
      const b = {};
      ['timeBased', 'after', 'everyDays', 'atHour', 'onWeekDay', 'onMonthDay'].forEach(function (k) {
        b[k] = function () { return b; };
      });
      b.create = function () { const t = { getHandlerFunction: function () { return fn; } }; made.push(t); return t; };
      return b;
    },
  };
  return function () { return made.map(function (t) { return t.getHandlerFunction(); }).sort(); };
}

test('B2/ENG-1: re-installing the alert trigger KEEPS a pending retry; uninstall removes it', function () {
  install('2026-09-18');
  const names = fullTriggers_();
  h.call('installAlertTrigger_');
  h.call('alertsScheduleRetry_');                       // a DEFERRED left a one-shot retry
  h.call('installAlertTrigger_');                       // the admin re-installs mid-morning
  assert.deepEqual(names(), ['runDailyAlertsRetry_', 'runDailyAlerts_'], 'one daily trigger, the retry survives');
  h.call('uninstallAlertTrigger_');
  assert.deepEqual(names(), [], 'turning alerts off takes the retry with it');
});

test('B2/ENG-1: re-installing the digest triggers KEEPS pending retries; uninstall removes them', function () {
  install('2026-09-18');
  const names = fullTriggers_();
  h.ctx.assertAdmin_ = function () {};
  h.ctx.logStatusReturn_ = function (x) { return x; };
  h.call('installDigestTriggers');
  h.ctx.ScriptApp.newTrigger('runDailyDigestRetry_').timeBased().after(1).create();
  h.call('installDigestTriggers');
  assert.deepEqual(names(), ['runDailyDigestRetry_', 'runDailyDigests_', 'runMonthlyDigests_', 'runWeeklyDigests_']);
  h.call('uninstallDigestTriggers');
  assert.deepEqual(names(), []);
});

// ENG-7 (broad-scan 2026-10-12): a failed Alert Log append after a send used
// to abort the run mid-way, and the failure email's "re-send by hand" would
// re-alert the depts already emailed.
test('ENG-7: a failing Alert Log append does not stop the run; every dept is assessed, the outcome is FAILED-LOG and admins are told NOT to re-send', function () {
  trackingLock();
  const sent = [];
  installCore({ held: 0, peakDuringSend: 0 }, sent);
  h2.ctx.appendAlertLog_ = function () { throw new Error('Service Spreadsheets timed out'); };
  h2.state.sentEmails.length = 0;
  const res = h2.call('runAlertsCore_', '2026-09-21', false, 'daily-trigger');
  assert.deepEqual(sent, ['CSR', 'Sales'], 'pre-fix the run died after CSR; Sales was never assessed');
  assert.equal(res.length, 2);
  assert.ok(res.every(function (r) { return r.status === 'sent'; }), 'a log failure does not turn a send into an error row');
  assert.match(res[0].notes, /NOT written to the Alert Log/);
  assert.equal(res.logFailures.length, 2);
  assert.deepEqual(Array.from(res.sentDepts), ['CSR', 'Sales']);
  const outcome = h2.call('alertsOutcomeString_', '2026-09-21', res, null);
  assert.match(outcome, /^FAILED-LOG 2026-09-21: 2 Alert Log row\(s\) not written/);
  assert.equal(h2.call('healthOutcomeIsBad_', outcome), true);

  h2.call('alertsNotifyLogFailures_', '2026-09-21', res);
  const mail = h2.state.sentEmails.filter(function (m) { return /not written/.test(m.subject); })[0];
  assert.ok(mail, 'the admins get one email');
  assert.match(mail.body, /Alerts sent: CSR, Sales/);
  assert.match(mail.body, /Do not re-send/);
});

test('ENG-7: an error that still escapes the run names the depts already emailed in the trigger failure email', function () {
  trackingLock();
  const sent = [];
  installCore({ held: 0, peakDuringSend: 0 }, sent);
  h2.ctx.getCompanyHolidayRanges_ = function () { return []; };
  h2.ctx.digestLatestDqeIso_ = function () { return '2026-09-21'; };
  // CSR sends, then something outside the per-dept try throws on Sales.
  h2.ctx.readAlertConfig_ = function () {
    return [{ department: 'CSR', active: true, threshold: 90, skipDates: '' },
            { department: 'Sales', threshold: 90, skipDates: '', get active() { throw new Error('boom'); } }];
  };
  h2.state.sentEmails.length = 0;
  h2.call('alertsGatedAttempt_', new Date('2026-09-22T08:05:00-05:00'), 'trigger');
  assert.deepEqual(sent, ['CSR']);
  const mail = h2.state.sentEmails.filter(function (m) { return /trigger failed/.test(m.subject); })[0];
  assert.ok(mail);
  assert.match(mail.body, /Already emailed before the stop \(a manual Send would repeat them\): CSR/);
});

test('ENG-7 follow-on: each unlogged row carries logFailed (a serializable field), and the modal warns on it', function () {
  trackingLock();
  const sent = [];
  installCore({ held: 0, peakDuringSend: 0 }, sent);
  let n = 0;
  h2.ctx.appendAlertLog_ = function () { if (++n === 2) throw new Error('timed out'); };
  const res = JSON.parse(JSON.stringify(h2.call('runAlertsCore_', '2026-09-21', false, 'daily-trigger')));
  assert.deepEqual(res.map(function (r) { return !!r.logFailed; }), [false, true], 'survives JSON (the client sees it)');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-7-admin.html'), 'utf8');
  assert.match(src, /filter\(function \(r\) \{ return r\.logFailed; \}\)/, 'the send handler counts unlogged rows');
  assert.match(src, /do not send again to rebuild the log/);
});
