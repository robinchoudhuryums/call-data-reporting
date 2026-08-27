'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// The DQE-silence watchdog (DqeSilenceWatch.gs): alerts when a department's
// mapped queues show QCD volume while ZERO DQE rows match its roster -- the
// Field Ops Power failure shape (2026-06-17: the phone system dropped the
// A_Q_* token from the caller-ID column, per-agent data vanished silently for
// two months while queue totals kept flowing). These tests pin the pure
// decision core dqeSilenceAssess_; the sheet/DAL reads are thin adapters over
// readers pinned by their own suites.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DqeSilenceWatch.gs'] });

const OPTS = { minDays: 2, minCalls: 5 };
// vm-context objects carry the OTHER realm's Object.prototype, which
// assert/strict's deepEqual rejects -- JSON-normalize before comparing.
const call = (perDept, prev, dateIso, opts) =>
  JSON.parse(JSON.stringify(
    h.call('dqeSilenceAssess_', perDept, prev, opts || OPTS, dateIso || '2026-08-14')));

test('a healthy dept (DQE rows present) never enters the streak map', function () {
  const r = call([{ dept: 'CSR', qcdCalls: 349, dqeRows: 16 }], {});
  assert.deepEqual(r.streaks, {});
  assert.deepEqual(r.alerts, []);
});

test('silence day 1 starts a streak but does NOT alert (one day can be legitimate)', function () {
  const r = call([{ dept: 'Field Ops Power', qcdCalls: 25, dqeRows: 0 }], {});
  assert.deepEqual(r.streaks, {
    'Field Ops Power': { since: '2026-08-14', days: 1, calls: 25, alerted: false },
  });
  assert.deepEqual(r.alerts, []);
});

test('day 2 over both thresholds alerts ONCE, and the streak marks itself alerted', function () {
  const prev = { 'Field Ops Power': { since: '2026-08-13', days: 1, calls: 25, alerted: false } };
  const r = call([{ dept: 'Field Ops Power', qcdCalls: 20, dqeRows: 0 }], prev);
  assert.equal(r.alerts.length, 1);
  assert.deepEqual(r.alerts[0], { dept: 'Field Ops Power', since: '2026-08-13', days: 2, calls: 45 });
  assert.equal(r.streaks['Field Ops Power'].alerted, true);
  // Day 3: the episode keeps growing but never re-mails.
  const r3 = call([{ dept: 'Field Ops Power', qcdCalls: 30, dqeRows: 0 }], r.streaks);
  assert.deepEqual(r3.alerts, []);
  assert.equal(r3.streaks['Field Ops Power'].days, 3);
});

test('the call-volume floor is CUMULATIVE, so a 1-2-call dept (Denials) still alerts eventually', function () {
  // Days pass the day threshold long before calls pass the volume one --
  // a per-day floor would mean Denials never alerts at all.
  let streaks = {};
  let alerts = [];
  const days = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
  for (const d of days) {
    const r = call([{ dept: 'Denials', qcdCalls: 2, dqeRows: 0 }], streaks, d);
    streaks = r.streaks;
    alerts = alerts.concat(r.alerts);
  }
  // 2+2+2 = 6 calls crosses minCalls=5 on day 3.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].days, 3);
  assert.equal(alerts[0].calls, 6);
  assert.equal(alerts[0].since, '2026-08-11');
});

test('recovery deletes the streak, and a NEW episode re-arms the alert', function () {
  const prev = { 'Field Ops Power': { since: '2026-08-10', days: 4, calls: 90, alerted: true } };
  const healthy = call([{ dept: 'Field Ops Power', qcdCalls: 25, dqeRows: 5 }], prev);
  assert.deepEqual(healthy.streaks, {});
  // Fresh silence after recovery is a new episode: counts from 1, alerts again
  // once it crosses the thresholds.
  const d1 = call([{ dept: 'Field Ops Power', qcdCalls: 25, dqeRows: 0 }], healthy.streaks, '2026-08-18');
  assert.equal(d1.streaks['Field Ops Power'].days, 1);
  const d2 = call([{ dept: 'Field Ops Power', qcdCalls: 25, dqeRows: 0 }], d1.streaks, '2026-08-19');
  assert.equal(d2.alerts.length, 1);
});

test('a zero-QCD day is NO SIGNAL: streak neither grows nor resets', function () {
  const prev = { 'Denials': { since: '2026-08-12', days: 2, calls: 4, alerted: false } };
  const r = call([{ dept: 'Denials', qcdCalls: 0, dqeRows: 0 }], prev);
  assert.deepEqual(r.streaks, prev, 'a quiet queue proves nothing either way');
  assert.deepEqual(r.alerts, []);
});

test('a dept missing from the read carries its streak forward untouched', function () {
  const prev = { 'Ghost Dept': { since: '2026-08-12', days: 2, calls: 9, alerted: false } };
  const r = call([{ dept: 'CSR', qcdCalls: 300, dqeRows: 12 }], prev);
  assert.deepEqual(r.streaks['Ghost Dept'], prev['Ghost Dept']);
});

test('independent depts track independent episodes in one pass', function () {
  const prev = { 'Field Ops Power': { since: '2026-08-13', days: 1, calls: 25, alerted: false } };
  const r = call([
    { dept: 'Field Ops Power', qcdCalls: 25, dqeRows: 0 },   // crosses -> alert
    { dept: 'Denials',         qcdCalls: 2,  dqeRows: 0 },   // day 1 -> watch
    { dept: 'CSR',             qcdCalls: 349, dqeRows: 16 }, // healthy
  ], prev);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].dept, 'Field Ops Power');
  assert.equal(r.streaks['Denials'].days, 1);
  assert.ok(!r.streaks['CSR']);
});

// P2 (broad-scan 2026-08-27, the OPS-1 discipline): dqeSilenceSendAlert_ must
// return true ONLY on a confirmed send -- the trigger wrapper marks episodes
// `alerted` off this boolean, so an empty recipient list or a MailApp throw
// (the quota-exhausted morning) returning anything truthy would permanently
// silence the episode with zero emails sent.
test('OPS-1: send confirms true on success, false on empty recipients, false on MailApp throw', function () {
  const alerts = [{ dept: 'Field Ops Power', since: '2026-08-12', days: 2, calls: 45 }];

  h.ctx.getAdminEmails_ = function () { return ['admin@x.com']; };
  h.state.sentEmails.length = 0;
  assert.equal(h.call('dqeSilenceSendAlert_', alerts, '2026-08-13'), true, 'confirmed send -> true');
  assert.equal(h.state.sentEmails.length, 1, 'one email actually sent');

  h.ctx.getAdminEmails_ = function () { return []; };
  assert.equal(h.call('dqeSilenceSendAlert_', alerts, '2026-08-13'), false, 'no recipients -> false');

  h.ctx.getAdminEmails_ = function () { return ['admin@x.com']; };
  const realMail = h.ctx.MailApp;
  h.ctx.MailApp = { sendEmail: function () { throw new Error('Service invoked too many times'); } };
  try {
    assert.equal(h.call('dqeSilenceSendAlert_', alerts, '2026-08-13'), false, 'MailApp throw -> false, not a crash');
  } finally { h.ctx.MailApp = realMail; }
});
