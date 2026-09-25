'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

// R28: every dashboard email goes through sendAppEmail_ (Config.gs), which
// BCCs the first admin by default so a wrong recipient, a broken template, or
// a send that never happens is seen the day it happens. Pinned:
//   (1) default BCC = first admin; EMAIL_BCC overrides; none/off disables;
//   (2) an address already in to/cc/bcc is never added twice;
//   (3) both MailApp signatures (object and positional) are accepted;
//   (4) the SWEEP: no dashboard .gs calls MailApp.sendEmail directly.

const h = loadGas({ files: ['Config.gs'] });
const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function reset(extra) {
  h.state.props = Object.assign({ ADMIN_EMAILS: 'robin@x.com, second@x.com' }, extra || {});
  h.state.sentEmails.length = 0;
}

test('R28: the first admin is BCC\'d by default', function () {
  reset();
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', htmlBody: '<p>x</p>' });
  assert.equal(h.state.sentEmails.length, 1);
  assert.equal(h.state.sentEmails[0].bcc, 'robin@x.com');
  assert.equal(h.state.sentEmails[0].to, 'mgr@x.com', 'the rest of the message is untouched');
});

test('R28: an address already receiving the email is not BCC\'d again', function () {
  reset();
  h.call('sendAppEmail_', { to: 'robin@x.com,second@x.com', subject: 's', body: 'b' });
  assert.equal(h.state.sentEmails[0].bcc, undefined, 'admin-only alerts do not arrive twice');
  reset();
  h.call('sendAppEmail_', { to: 'mgr@x.com', cc: 'Robin@X.com', subject: 's', body: 'b' });
  assert.equal(h.state.sentEmails[0].bcc, undefined, 'case-insensitive, cc counts');
});

test('R28: EMAIL_BCC overrides the list; none/off disables; an existing bcc is kept', function () {
  reset({ EMAIL_BCC: 'audit@x.com; robin@x.com' });
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b', bcc: 'keep@x.com' });
  assert.equal(h.state.sentEmails[0].bcc, 'keep@x.com,audit@x.com,robin@x.com');
  reset({ EMAIL_BCC: 'none' });
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
  assert.equal(h.state.sentEmails[0].bcc, undefined);
  reset({ EMAIL_BCC: 'OFF' });
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
  assert.equal(h.state.sentEmails[0].bcc, undefined);
});

test('ENG-6: a malformed EMAIL_BCC entry is dropped, never handed to MailApp (one typo failed EVERY send)', function () {
  reset({ EMAIL_BCC: 'audit@x.com, robin@x,com' });   // the comma typo splits into 'robin@x' + 'com'
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
  assert.equal(h.state.sentEmails[0].bcc, 'audit@x.com', 'the valid entry still applies');
  const cfg = JSON.parse(JSON.stringify(h.call('appEmailBccConfig_')));
  assert.deepEqual(cfg, { mode: 'list', valid: ['audit@x.com'], invalid: ['robin@x', 'com'] });
  // Nothing valid -> the default first-admin BCC, not silently nobody.
  reset({ EMAIL_BCC: 'robin at x dot com' });
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
  assert.equal(h.state.sentEmails[0].bcc, 'robin@x.com');
  assert.equal(h.call('appEmailBccConfig_').mode, 'default');
});

test('R28: the positional (to, subject, body) form is accepted', function () {
  reset();
  h.call('sendAppEmail_', 'mgr@x.com', 'subj', 'plain');
  const m = h.state.sentEmails[0];
  assert.equal(m.to, 'mgr@x.com'); assert.equal(m.subject, 'subj'); assert.equal(m.body, 'plain');
  assert.equal(m.bcc, 'robin@x.com');
});

test('R28 sweep: no dashboard .gs calls MailApp.sendEmail except the chokepoint', function () {
  const offenders = fs.readdirSync(DASH)
    .filter(function (f) { return f.endsWith('.gs') && f !== 'Config.gs'; })
    .filter(function (f) { return /MailApp\.sendEmail\(|GmailApp\.sendEmail\(/.test(fs.readFileSync(path.join(DASH, f), 'utf8')); });
  assert.deepEqual(offenders, [],
    'route the send through sendAppEmail_ (Config.gs) so the default BCC + EMAIL_BCC apply: ' + offenders.join(', '));
  const cfg = fs.readFileSync(path.join(DASH, 'Config.gs'), 'utf8');
  assert.equal((cfg.match(/MailApp\.sendEmail\(/g) || []).length, 1, 'exactly one real send in the whole dashboard');
});

// SEC-2 (broad-scan 2026-09-23, Batch 8): a per-USER cap on user-triggered
// report emails. The MailApp quota is shared with alerts / digests / the
// watchdogs and every send also BCCs an admin, so a devtools loop on one
// report-email endpoint could starve every engine for the day.
test('SEC-2: the throttle admits up to the cap per user, then refuses with a readable error', function () {
  reset();
  h.state.cache.clear();
  const cap = h.ctx.USER_REPORT_EMAIL_CAP_;
  for (let i = 0; i < cap; i++) h.call('assertReportEmailThrottle_', 'Mgr@X.com');
  assert.throws(function () { h.call('assertReportEmailThrottle_', 'mgr@x.com'); },
    /report emails in the last 6 hours/, 'case-insensitive: the same user');
  h.call('assertReportEmailThrottle_', 'other@x.com');   // a different user is unaffected
});

test('SEC-2: stamps older than the window fall away', function () {
  reset();
  h.state.cache.clear();
  const old = Date.now() - (h.ctx.USER_REPORT_EMAIL_WINDOW_S_ + 60) * 1000;
  const stamps = new Array(h.ctx.USER_REPORT_EMAIL_CAP_).fill(old);
  h.ctx.CacheService.getScriptCache().put('mailThrottle:v1:mgr@x.com', JSON.stringify(stamps), 600);
  h.call('assertReportEmailThrottle_', 'mgr@x.com');   // does not throw
});

test('SEC-2 sweep: every user-triggered report-email endpoint is throttled', function () {
  // Every PUBLIC (non-underscore) .gs function whose body calls sendAppEmail_
  // must call assertReportEmailThrottle_, unless it is on this list with a
  // reason. A new report-email endpoint joins the throttle, or this list.
  const EXEMPT = {
    runLiveSmoke: 'admin-only editor/Health smoke run; one email per run',
    reportClientIssue: 'has its own per-signature + rolling-window email cap (R19)',
  };
  const offenders = [];
  fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    const re = /^function (\w+)\(/gm;
    let m; const starts = [];
    while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
    starts.forEach(function (s, i) {
      const body = src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
      if (/_$/.test(s.name) || EXEMPT[s.name]) return;
      if (/sendAppEmail_\(/.test(body) && !/assertReportEmailThrottle_\(/.test(body)) offenders.push(f + ':' + s.name);
    });
  });
  assert.deepEqual(offenders, [], 'unthrottled user-triggered senders: ' + offenders.join(', '));
});
