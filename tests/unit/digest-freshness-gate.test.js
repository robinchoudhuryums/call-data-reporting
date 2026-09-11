'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// R31: the daily digest's freshness gate. The 8 AM trigger sent whatever the
// previous business day held at that minute; before the morning import
// landed that was blank KPI tiles beside a "What changed" callout (the two
// read different windows). Pinned here:
//   (1) the pure decision table (done / send / defer / send-stale);
//   (2) a deferred attempt records DEFERRED, schedules ONE one-shot retry,
//       and sends nothing; a fresh attempt sends and schedules nothing;
//   (3) past the cutoff it sends WITH the stale note; a failed schedule
//       falls through to a stale send rather than losing the day;
//   (4) an already-sent window is a no-op that clears pending retries;
//   (5) the retry handler deletes its own trigger; weekends still skip;
//   (6) end-to-end: the cutoff email carries the data-not-available callout
//       and the run record says so.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs',
          'DeptConfig.gs', 'Data.gs', 'InsightsReport.gs', 'Digest.gs', 'EmailKit.gs'],
});
const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'] });
const REAL_SEND = h.ctx.sendDigestsForCadence_;
const REAL_ATTEMPT = h.ctx.digestGatedAttempt_;

function install(opts) {
  opts = opts || {};
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.sentEmails.length = 0;
  h.ctx.sendDigestsForCadence_ = REAL_SEND;   // earlier tests stub it
  h.ctx.digestGatedAttempt_ = REAL_ATTEMPT;
  const rows = [];
  (opts.dates || []).forEach(function (d) {
    rows.push(dqeRow({ date: d, agent: 'Anna', ext: '201', rung: 10, missed: 1, answered: 9, att: '0:03:00' }));
  });
  const sheets = { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows) };
  if (opts.subscriber) {
    sheets['Digest Config'] = [['Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format'],
                               ['m@x.com', 'Alpha', 'daily', 'TRUE', '', 'summary']];
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.DQE_DATE_BOUNDS_MEMO_ = null; h.ctx.DQE_SHEET_ROWS_MEMO_ = null; h.ctx.DQE_DATE_COL_MEMO_ = null; h.ctx.DQE_EXT_GRID_MEMO_ = null;
  h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
  h.state.cache.clear();
  // Fake ScriptApp: records one-shot triggers with their delay.
  const made = [];
  h.ctx.ScriptApp = {
    getProjectTriggers: function () { return made.slice(); },
    deleteTrigger: function (t) { const i = made.indexOf(t); if (i >= 0) made.splice(i, 1); },
    newTrigger: function (fn) {
      if (opts.scheduleThrows) throw new Error('trigger quota');
      const t = { getHandlerFunction: function () { return fn; } };
      const b = { timeBased: function () { return b; }, after: function (ms) { t.afterMs = ms; return b; },
                  everyDays: function () { return b; }, atHour: function () { return b; },
                  create: function () { made.push(t); return t; } };
      return b;
    },
  };
  return made;
}
function stubSend() {
  const calls = [];
  h.ctx.sendDigestsForCadence_ = function (cadence, runOpts) { calls.push({ cadence: cadence, runOpts: runOpts }); };
  return calls;
}
// 2026-09-03 is a Wednesday; hh:mm are Central (CDT = UTC-5).
function at(hhmm) { return new Date('2026-09-03T' + hhmm + ':00-05:00'); }

test('R31: the decision table', function () {
  const d = function (hour, fresh, sent) { return h.call('digestDailyDecision_', hour, fresh, sent); };
  assert.equal(d(8, true, true), 'done', 'already sent wins over everything');
  assert.equal(d(8, true, false), 'send');
  assert.equal(d(8, false, false), 'defer');
  assert.equal(d(11, false, false), 'defer', 'still before the cutoff');
  assert.equal(d(12, false, false), 'send-stale', 'the cutoff hour sends regardless');
  assert.equal(d(15, false, false), 'send-stale');
  assert.equal(h.call('digestDailyDecision_', 9, false, false, 9), 'send-stale', 'cutoff is a parameter');
});

test('R31: digestLatestDqeIso_ reads the sheet bounds without a signed-in user', function () {
  install({ dates: ['2026-09-01', '2026-09-02'] });
  h.state.userEmail = '';
  assert.equal(h.call('digestLatestDqeIso_'), '2026-09-02');
  install({ dates: [] });
  assert.equal(h.call('digestLatestDqeIso_'), '', 'empty sheet -> unknown -> not fresh');
});

test('R31: not fresh before the cutoff -> DEFERRED, one retry scheduled, nothing sent', function () {
  const made = install({ dates: ['2026-09-01'] });      // window day 09-02 not landed
  const calls = stubSend();
  const r = h.call('digestDailyAttempt_', at('08:15'), 'trigger');
  assert.equal(r.decision, 'defer');
  assert.equal(calls.length, 0, 'no send');
  assert.equal(made.length, 1, 'exactly one retry trigger');
  assert.equal(made[0].getHandlerFunction(), 'runDailyDigestRetry_');
  assert.equal(made[0].afterMs, 60 * 60 * 1000);
  assert.match(h.state.props.DIGEST_LAST_RESULT_daily, /^DEFERRED 2026-09-02: DQE data is through 2026-09-01 at 08:15/);
  // A second deferral replaces, never stacks, the pending retry.
  h.call('digestDailyAttempt_', at('09:20'), 'retry');
  assert.equal(made.length, 1);
});

test('R31: fresh -> sends with no stale note and schedules nothing', function () {
  const made = install({ dates: ['2026-09-01', '2026-09-02'] });
  const calls = stubSend();
  const r = h.call('digestDailyAttempt_', at('08:15'), 'trigger');
  assert.equal(r.decision, 'send');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cadence, 'daily');
  assert.equal(calls[0].runOpts.window.toIso, '2026-09-02', 'the send gets the window the gate checked');
  assert.equal(calls[0].runOpts.staleLatest, undefined, 'no stale note on a fresh send');
  assert.equal(made.length, 0);
});

test('R31: past the cutoff -> sends with the stale note; a pending retry is cleared', function () {
  const made = install({ dates: ['2026-09-01'] });
  const calls = stubSend();
  h.call('digestDailyAttempt_', at('10:30'), 'trigger');   // leaves a retry pending
  assert.equal(made.length, 1);
  const r = h.call('digestDailyAttempt_', at('12:05'), 'retry');
  assert.equal(r.decision, 'send-stale');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runOpts.staleLatest, '2026-09-01');
  assert.equal(calls[0].runOpts.window.toIso, '2026-09-02');
  assert.equal(made.length, 0, 'no retry left behind after a send');
});

test('R31: a retry that cannot be scheduled falls through to a stale send (never loses the day)', function () {
  install({ dates: ['2026-09-01'], scheduleThrows: true });
  const calls = stubSend();
  const r = h.call('digestDailyAttempt_', at('08:40'), 'trigger');
  assert.equal(r.decision, 'send-stale');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runOpts.staleLatest, '2026-09-01');
});

test('R31: an already-sent window is done: no send, pending retries cleared', function () {
  const made = install({ dates: ['2026-09-01'] });
  const calls = stubSend();
  h.call('digestDailyAttempt_', at('08:15'), 'trigger');
  assert.equal(made.length, 1);
  h.state.props.DIGEST_RUN_MARKER_daily = '2026-09-02';
  const r = h.call('digestDailyAttempt_', at('09:15'), 'retry');
  assert.equal(r.decision, 'done');
  assert.equal(calls.length, 0);
  assert.equal(made.length, 0);
});

test('R31: the retry handler deletes its own trigger before attempting; weekends still skip', function () {
  const made = install({ dates: ['2026-09-01', '2026-09-02'] });
  const calls = stubSend();
  h.call('digestScheduleRetry_');
  assert.equal(made.length, 1);
  let pendingWhenAttempted = -1;
  h.ctx.digestGatedAttempt_ = function (cadence, now, source) {
    pendingWhenAttempted = made.length;
    return { decision: 'stubbed', cadence: cadence, source: source };
  };
  h.call('runDailyDigestRetry_');
  assert.equal(pendingWhenAttempted, 0, 'its own one-shot is removed BEFORE the attempt runs');
  h.ctx.digestGatedAttempt_ = REAL_ATTEMPT;
  // Saturday 2026-09-05 08:15 Central.
  const r = h.call('digestDailyAttempt_', new Date('2026-09-05T08:15:00-05:00'), 'trigger');
  assert.equal(r.decision, 'skip-weekend');
  assert.equal(calls.length, 0, 'nothing sent on a weekend');
});

test('R31 end-to-end: the cutoff send carries the data-not-available callout and the record says so', function () {
  install({ dates: ['2026-09-01'], subscriber: true });
  h.state.userEmail = '';
  const r = h.call('digestDailyAttempt_', at('12:10'), 'retry');
  assert.equal(r.decision, 'send-stale');
  assert.equal(h.state.sentEmails.length, 1, 'one subscriber');
  const m = h.state.sentEmails[0];
  assert.equal(m.to, 'm@x.com');
  assert.match(m.htmlBody, /Data not yet available for 2026-09-02/);
  assert.match(m.htmlBody, /data is through 2026-09-01/);
  assert.match(h.state.props.DIGEST_LAST_RESULT_daily, /^ok 2026-09-02: sent 1 of 1 -- sent at the 12:00 cutoff WITHOUT 2026-09-02 data \(DQE through 2026-09-01\)/);
  assert.equal(h.state.props.DIGEST_RUN_MARKER_daily, '2026-09-02', 'the window is claimed; the next attempt is done');
  // A fresh send has no callout.
  install({ dates: ['2026-09-01', '2026-09-02'], subscriber: true });
  h.call('digestDailyAttempt_', at('08:30'), 'trigger');
  assert.equal(h.state.sentEmails.length, 1);
  assert.ok(!/Data not yet available/.test(h.state.sentEmails[0].htmlBody));
  assert.match(h.state.props.DIGEST_LAST_RESULT_daily, /^ok 2026-09-02: sent 1 of 1 at /);
});

// ── R32: the gate covers weekly + monthly too, and quiet days explain themselves ──
test('R32: a Monday weekly run before Friday\'s build defers with its OWN retry handler; a holiday Monday does not skip it', function () {
  // Mon 2026-09-07 08:20 Central; window = Mon 08-31 .. Fri 09-04; data through Thu 09-03.
  const made = install({ dates: ['2026-09-03'] });
  const calls = stubSend();
  h.state.props.COMPANY_HOLIDAYS = '2026-09-07';   // Labor Day: weekly still runs (B-6)
  h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;             // the holiday list is memoized per execution
  const r = h.call('digestGatedAttempt_', 'weekly', new Date('2026-09-07T08:20:00-05:00'), 'trigger');
  assert.equal(r.decision, 'defer');
  assert.equal(calls.length, 0);
  assert.equal(made.length, 1);
  assert.equal(made[0].getHandlerFunction(), 'runWeeklyDigestRetry_');
  assert.match(h.state.props.DIGEST_LAST_RESULT_weekly, /^DEFERRED 2026-09-04: DQE data is through 2026-09-03/);
  // The daily attempt on that same holiday Monday DOES skip (F-6/S5).
  const d = h.call('digestGatedAttempt_', 'daily', new Date('2026-09-07T08:20:00-05:00'), 'trigger');
  assert.equal(d.decision, 'skip-holiday');
  // Friday lands -> the weekly retry sends with the checked window, no note.
  install({ dates: ['2026-09-03', '2026-09-04'] });
  const calls2 = stubSend();
  const r2 = h.call('digestGatedAttempt_', 'weekly', new Date('2026-09-07T09:25:00-05:00'), 'retry');
  assert.equal(r2.decision, 'send');
  assert.equal(calls2[0].cadence, 'weekly');
  assert.equal(calls2[0].runOpts.window.fromIso, '2026-08-31');
  assert.equal(calls2[0].runOpts.window.toIso, '2026-09-04');
  assert.equal(calls2[0].runOpts.staleLatest, undefined);
});

test('R32: a monthly run on the 1st before the month-end build defers, then sends stale at the cutoff', function () {
  // Tue 2026-09-01 08:05 Central; window = Aug 1..31; data through Aug 28.
  const made = install({ dates: ['2026-08-28'] });
  const calls = stubSend();
  let r = h.call('digestGatedAttempt_', 'monthly', new Date('2026-09-01T08:05:00-05:00'), 'trigger');
  assert.equal(r.decision, 'defer');
  assert.equal(made[0].getHandlerFunction(), 'runMonthlyDigestRetry_');
  r = h.call('digestGatedAttempt_', 'monthly', new Date('2026-09-01T12:03:00-05:00'), 'retry');
  assert.equal(r.decision, 'send-stale');
  assert.equal(calls[0].cadence, 'monthly');
  assert.equal(calls[0].runOpts.staleLatest, '2026-08-28');
  assert.equal(calls[0].runOpts.window.toIso, '2026-08-31');
  assert.equal(made.length, 0, 'the monthly retry is cleared after the send');
  // Clearing without a cadence removes every pending retry.
  h.call('digestScheduleRetry_', 'daily'); h.call('digestScheduleRetry_', 'weekly');
  assert.equal(made.length, 2);
  h.call('digestClearRetryTriggers_');
  assert.equal(made.length, 0);
});

test('R32: a quiet window with FRESH data explains its zero tiles; a stale send does not double up', function () {
  // Data exists for the window day, but Alpha's roster took no calls: the
  // sheet holds only a non-roster agent's row on that date.
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.sentEmails.length = 0;
  h.ctx.sendDigestsForCadence_ = REAL_SEND;
  const rows = [dqeRow({ date: '2026-09-02', agent: 'Zed Other', ext: '999', rung: 5, missed: 1, answered: 4, att: '0:01:00' })];
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows),
    'Digest Config': [['Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format'],
                      ['m@x.com', 'Alpha', 'daily', 'TRUE', '', 'summary']] } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.DQE_DATE_BOUNDS_MEMO_ = null; h.ctx.DQE_SHEET_ROWS_MEMO_ = null; h.ctx.DQE_DATE_COL_MEMO_ = null; h.ctx.DQE_EXT_GRID_MEMO_ = null; h.state.cache.clear();
  h.ctx.ScriptApp = { getProjectTriggers: function () { return []; }, deleteTrigger: function () {}, newTrigger: function () { throw new Error('unused'); } };
  const r = h.call('digestGatedAttempt_', 'daily', at('08:30'), 'trigger');
  assert.equal(r.decision, 'send', 'the day exists on the source, so it is fresh');
  const m = h.state.sentEmails[0];
  assert.match(m.htmlBody, /No calls recorded/);
  assert.match(m.htmlBody, /Alpha's roster on 2026-09-02/);
  assert.ok(!/Data not yet available/.test(m.htmlBody));
  // Stale path: the data-not-available callout only.
  const html = h.call('digestSummaryHtml_', 'Alpha', '2026-09-03', '2026-09-03', { stale: true });
  assert.ok(!/No calls recorded/.test(html), 'the stale callout (added by the sender) already explains the zeros');
});
