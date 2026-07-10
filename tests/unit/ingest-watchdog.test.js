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

// The trigger body is gated on the REAL current weekday (no injectable
// clock in the Apps Script surface it uses). Self-skip on weekends so a
// Saturday CI run can't false-fail; every weekday run exercises it.
function isRealWeekend_() {
  const d = new Date().getDay();
  return d === 0 || d === 6;
}

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
