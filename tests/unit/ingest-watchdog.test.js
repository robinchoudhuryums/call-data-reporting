'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// OPS-1: the once-per-episode flag arms ONLY on a confirmed send -- a
// swallowed MailApp failure (quota-exhausted morning) used to arm it
// anyway, silencing the whole stale episode while LAST_RESULT claimed
// "alert sent".
// OPS-7: weekend/company-holiday days inside the stale gap earn a 24h
// staleness credit, and runs ON a company holiday are skipped.
const h = loadGas({ files: ['Config.gs', 'IngestWatchdog.gs'] });

// T-8 (broad-scan 2026-09-17): the trigger body is gated on the current
// weekday via `new Date()`, and this suite used to SKIP its run-gate tests on
// real weekends -- a Saturday CI run silently lost them. The harness fakes
// `ctx.Date` elsewhere, so the clock is pinned to a WEEKDAY here (Wed
// 2026-06-03, mid-morning Chicago) for every test; `atDate()` re-pins it for
// the one test that needs a weekend.
const RealDate = h.ctx.Date;
function fakeDate(fixed) {
  function FakeDate() {
    if (arguments.length === 0) return new RealDate(fixed.getTime());
    return new RealDate(...arguments);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.now = function () { return fixed.getTime(); };
  return FakeDate;
}
const WEEKDAY = new RealDate('2026-06-03T15:00:00Z');   // Wednesday, 10:00 Chicago
const SATURDAY = new RealDate('2026-06-06T15:00:00Z');
h.ctx.Date = fakeDate(WEEKDAY);
function atDate(d, fn) {
  h.ctx.Date = fakeDate(d);
  try { return fn(); } finally { h.ctx.Date = fakeDate(WEEKDAY); }
}
function isRealWeekend_() { return false; }   // the clock is pinned; kept so the gates below read as before

function install(freshness) {
  h.state.props = { INGEST_WATCHDOG_ENABLED: 'true', ADMIN_EMAILS: 'admin@x.com' };
  h.state.sentEmails.length = 0;
  h.ctx.computeOverviewPipelineFreshness_ = function () { return freshness; };
  delete h.ctx.isCompanyHoliday_;   // default: no holidays configured
}

test('OPS-1: a failed alert email does NOT arm the episode flag; the next run retries', function (t) {
  if (isRealWeekend_()) { t.diagnostic('weekend -- watchdog run-gate active, skipping'); return; }
  install({ hoursSinceFresh: 900, latestTimestamp: '2026-06-01 07:00' });   // way past any credit
  const realMail = h.ctx.MailApp;
  h.ctx.MailApp = { sendEmail: function () { throw new Error('Service invoked too many times'); } };
  try {
    h.call('runIngestWatchdog_');
    assert.equal(h.state.props.INGEST_WATCHDOG_ALERTED, undefined, 'flag NOT armed on a failed send');
    assert.match(h.state.props.INGEST_WATCHDOG_LAST_RESULT, /FAILED/, 'LAST_RESULT is honest about the failure');
  } finally { h.ctx.MailApp = realMail; }
  // Mail works again on the next run -> the alert actually goes out.
  h.call('runIngestWatchdog_');
  assert.equal(h.state.props.INGEST_WATCHDOG_ALERTED, 'true', 'flag armed on the confirmed send');
  assert.equal(h.state.sentEmails.length, 1, 'exactly one alert email');
  assert.match(h.state.props.INGEST_WATCHDOG_LAST_RESULT, /alert sent/);
  // Third run: already alerted -> no second email.
  h.call('runIngestWatchdog_');
  assert.equal(h.state.sentEmails.length, 1, 'once per episode');
  assert.match(h.state.props.INGEST_WATCHDOG_LAST_RESULT, /already alerted/);
});

test('OPS-1: a fresh build clears the episode flag', function (t) {
  if (isRealWeekend_()) { t.diagnostic('weekend -- skipping'); return; }
  install({ hoursSinceFresh: 2, latestTimestamp: 'now-ish' });
  h.state.props.INGEST_WATCHDOG_ALERTED = 'true';
  h.call('runIngestWatchdog_');
  assert.equal(h.state.props.INGEST_WATCHDOG_ALERTED, undefined, 'recovered -> re-armed for the next episode');
  assert.equal(h.state.props.INGEST_WATCHDOG_LAST_RESULT, 'fresh');
});

test('T-8: the run is skipped entirely on a WEEKEND (pinned clock, no real-calendar skip)', function () {
  install({ hoursSinceFresh: 900, latestTimestamp: 'stale' });
  atDate(SATURDAY, function () { h.call('runIngestWatchdog_'); });
  assert.equal(h.state.sentEmails.length, 0, 'no alert on a Saturday run');
  assert.equal(h.state.props.INGEST_WATCHDOG_LAST_RESULT, undefined, 'run gated before assessment');
  // And the same stale state on the pinned WEEKDAY does fire -- so the gate
  // above is the weekend, not a broken fixture.
  h.call('runIngestWatchdog_');
  assert.equal(h.state.sentEmails.length, 1, 'the weekday run alerts');
});

test('OPS-7: the run is skipped entirely on a company holiday', function (t) {
  if (isRealWeekend_()) { t.diagnostic('weekend -- skipping'); return; }
  install({ hoursSinceFresh: 900, latestTimestamp: 'stale' });
  h.ctx.isCompanyHoliday_ = function () { return true; };   // today is a holiday
  h.call('runIngestWatchdog_');
  assert.equal(h.state.sentEmails.length, 0, 'no alert on a holiday run');
  assert.equal(h.state.props.INGEST_WATCHDOG_LAST_RESULT, undefined, 'run gated before assessment');
});

test('OPS-7: non-business days inside the gap earn a 24h staleness credit', function () {
  // Any 7-day walk-back window contains at least 2 weekend days.
  delete h.ctx.isCompanyHoliday_;
  const week = h.call('ingestWatchdogNonBusinessCredit_', 7 * 24);
  assert.ok(week >= 48, '7-day gap credits at least the weekend (got ' + week + ')');
  // With every day a holiday, the whole walk-back is credited.
  h.ctx.isCompanyHoliday_ = function () { return true; };
  assert.equal(h.call('ingestWatchdogNonBusinessCredit_', 7 * 24), 7 * 24);
  delete h.ctx.isCompanyHoliday_;
  // Inconclusive freshness earns nothing.
  assert.equal(h.call('ingestWatchdogNonBusinessCredit_', null), 0);
});


test('O-7: an unreadable Pipeline Health RECORDS an INCONCLUSIVE outcome instead of returning silently', function (t) {
  if (isRealWeekend_()) { t.skip('weekend: the trigger body self-skips'); return; }
  install(null);   // computeOverviewPipelineFreshness_ -> null (missing/empty sheet, parse error)
  h.state.props.INGEST_WATCHDOG_LAST_RESULT = 'fresh';   // yesterday's verdict must not survive
  h.call('runIngestWatchdog_');
  assert.match(h.state.props.INGEST_WATCHDOG_LAST_RESULT, /^INCONCLUSIVE/, 'the Health page can now see it');
  assert.ok(h.state.props.INGEST_WATCHDOG_LAST, 'stamped');
  assert.equal(h.state.props.INGEST_WATCHDOG_ALERTED, undefined, 'no episode armed, no alarm');
  assert.equal(h.state.sentEmails.length, 0);
});

// O-4 (broad-scan 2026-09-17): the watchdog's own throw used to be Logger-only,
// leaving the previous "fresh" on the Health page for up to the 4-day STALE
// allowance while an hourly engine pushed nothing.
test('O-4: a throw before assessing records a FAILED outcome instead of keeping the old verdict', function (t) {
  if (isRealWeekend_()) { t.diagnostic('weekend -- watchdog run-gate active, skipping'); return; }
  install({ hoursSinceFresh: 2, latestTimestamp: '2026-06-01 07:00' });
  h.state.props.INGEST_WATCHDOG_LAST_RESULT = 'fresh';
  h.ctx.computeOverviewPipelineFreshness_ = function () { throw new Error('Service Spreadsheets timed out'); };
  h.call('runIngestWatchdog_');
  assert.match(h.state.props.INGEST_WATCHDOG_LAST_RESULT, /^FAILED \(threw before assessing\): Service Spreadsheets timed out/);
  assert.ok(h.state.props.INGEST_WATCHDOG_LAST, 'stamped');
});
