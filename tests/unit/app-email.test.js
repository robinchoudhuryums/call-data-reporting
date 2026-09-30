'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

// R28 + EML-2: every dashboard email goes through sendAppEmail_ (Config.gs),
// which sends the first admin a COPY so a wrong recipient, a broken template,
// or a send that never happens is seen the day it happens. EML-2 (owner,
// 2026-09-30): the copy is a SEPARATE "[Copy]" message To the admin, never a
// BCC -- the app sends AS the admin, and a BCC to the sender's own mailbox
// never reaches the inbox. Pinned:
//   (1) default copy = first admin; EMAIL_BCC overrides; none/off disables;
//   (2) an address already in to/cc/bcc gets no copy;
//   (3) the copy names the original recipients and carries the content;
//   (4) a failed copy never fails the real send;
//   (5) both MailApp signatures (object and positional) are accepted;
//   (6) the SWEEP: no dashboard .gs calls MailApp.sendEmail directly.

const h = loadGas({ files: ['Config.gs'] });
const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function reset(extra) {
  h.state.props = Object.assign({ ADMIN_EMAILS: 'robin@x.com, second@x.com' }, extra || {});
  h.state.sentEmails.length = 0;
}
function sent() { return JSON.parse(JSON.stringify(h.state.sentEmails)); }

test('EML-2: the first admin gets a SEPARATE [Copy] message To them -- never a BCC', function () {
  reset();
  h.call('sendAppEmail_', { to: 'mgr@x.com', cc: 'lead@x.com', subject: 's',
    htmlBody: '<html><body style="x"><p>hello</p></body></html>', name: 'Dash' });
  const m = sent();
  assert.equal(m.length, 2, 'the real email, then the copy');
  assert.equal(m[0].to, 'mgr@x.com');
  assert.equal(m[0].bcc, undefined, 'no BCC on the real email');
  assert.equal(m[1].to, 'robin@x.com');
  assert.equal(m[1].cc, undefined);
  assert.equal(m[1].subject, '[Copy] s');
  assert.equal(m[1].name, 'Dash');
  assert.match(m[1].body, /Sent to: mgr@x\.com · cc: lead@x\.com/);
  assert.match(m[1].htmlBody, /^<html><body style="x"><div[^>]*>Copy of an email the dashboard sent\. Sent to: mgr@x\.com · cc: lead@x\.com<\/div><p>hello<\/p>/,
    'the banner sits INSIDE the body, the original content follows');
});

test('EML-2: an address already receiving the email gets no copy', function () {
  reset();
  h.call('sendAppEmail_', { to: 'robin@x.com,second@x.com', subject: 's', body: 'b' });
  assert.equal(sent().length, 1, 'admin-only alerts do not arrive twice');
  reset();
  h.call('sendAppEmail_', { to: 'mgr@x.com', cc: 'Robin@X.com', subject: 's', body: 'b' });
  assert.equal(sent().length, 1, 'case-insensitive, cc counts');
});

test('EML-2: EMAIL_BCC overrides the copy list; none/off disables; a caller bcc is kept on the real email', function () {
  reset({ EMAIL_BCC: 'audit@x.com; robin@x.com' });
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b', bcc: 'keep@x.com' });
  let m = sent();
  assert.equal(m[0].bcc, 'keep@x.com');
  assert.deepEqual(m.slice(1).map(function (x) { return x.to; }), ['audit@x.com', 'robin@x.com']);
  assert.match(m[1].body, /bcc: keep@x\.com/, 'the copy shows the caller\'s bcc too');
  ['none', 'OFF'].forEach(function (v) {
    reset({ EMAIL_BCC: v });
    h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
    assert.equal(sent().length, 1, v + ' disables the copy');
  });
});

test('ENG-6: a malformed EMAIL_BCC entry is dropped, never handed to MailApp (one typo failed EVERY send)', function () {
  reset({ EMAIL_BCC: 'audit@x.com, robin@x,com' });   // the comma typo splits into 'robin@x' + 'com'
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
  assert.deepEqual(sent().slice(1).map(function (x) { return x.to; }), ['audit@x.com'], 'the valid entry still applies');
  const cfg = JSON.parse(JSON.stringify(h.call('appEmailBccConfig_')));
  assert.deepEqual(cfg, { mode: 'list', valid: ['audit@x.com'], invalid: ['robin@x', 'com'] });
  // Nothing valid -> the default first-admin copy, not silently nobody.
  reset({ EMAIL_BCC: 'robin at x dot com' });
  h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' });
  assert.equal(sent()[1].to, 'robin@x.com');
  assert.equal(h.call('appEmailBccConfig_').mode, 'default');
});

test('EML-2: a failed copy never fails the real send', function () {
  reset();
  const orig = h.ctx.MailApp.sendEmail;
  let n = 0;
  h.ctx.MailApp.sendEmail = function (m) { n++; if (n === 2) throw new Error('quota'); h.state.sentEmails.push(m); };
  try {
    assert.doesNotThrow(function () { h.call('sendAppEmail_', { to: 'mgr@x.com', subject: 's', body: 'b' }); });
    assert.equal(sent().length, 1);
  } finally { h.ctx.MailApp.sendEmail = orig; }
});

test('R28: the positional (to, subject, body) form is accepted', function () {
  reset();
  h.call('sendAppEmail_', 'mgr@x.com', 'subj', 'plain');
  const m = sent();
  assert.equal(m[0].to, 'mgr@x.com'); assert.equal(m[0].subject, 'subj'); assert.equal(m[0].body, 'plain');
  assert.equal(m[1].to, 'robin@x.com');
  assert.match(m[1].body, /Sent to: mgr@x\.com\n\nplain$/);
});

test('R28 sweep: no dashboard .gs calls MailApp.sendEmail except the chokepoint', function () {
  const offenders = fs.readdirSync(DASH)
    .filter(function (f) { return f.endsWith('.gs') && f !== 'Config.gs'; })
    .filter(function (f) { return /MailApp\.sendEmail\(|GmailApp\.sendEmail\(/.test(fs.readFileSync(path.join(DASH, f), 'utf8')); });
  assert.deepEqual(offenders, [],
    'route the send through sendAppEmail_ (Config.gs) so the admin copy + EMAIL_BCC apply: ' + offenders.join(', '));
  const cfg = fs.readFileSync(path.join(DASH, 'Config.gs'), 'utf8');
  const body = cfg.slice(cfg.indexOf('function sendAppEmail_('), cfg.indexOf('function appEmailCopyMessage_('));
  assert.equal((cfg.match(/MailApp\.sendEmail\(/g) || []).length, 2, 'only the real send and the admin copy');
  assert.equal((body.match(/MailApp\.sendEmail\(/g) || []).length, 2, 'both live inside sendAppEmail_');
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

// EML-2 in cdr-report: the DCTR is the one report email with no admin
// recipient (the Daily Queue Report CCs the admin; the batch zip goes To the
// person who ran it; failure notices go To NEON_WRITE_CONFIG.alertEmail), so
// it sends the admin a separate [Copy] -- the same rule as the dashboard.
const em = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'emailDailyReport.js'] });

test('EML-2 (cdr-report): sendReportAdminCopy_ sends a [Copy] To the alert address, never twice, never throwing', function () {
  em.state.sentEmails.length = 0;
  const admin = em.ctx.NEON_WRITE_CONFIG.alertEmail;
  const c = JSON.parse(JSON.stringify(em.call('sendReportAdminCopy_',
    { to: 'customersuccess@x.com', subject: 'DCTR - 09/29/2026', body: 'Attached.', attachments: ['blob'] })));
  assert.equal(c.to, admin);
  assert.equal(c.subject, '[Copy] DCTR - 09/29/2026');
  assert.match(c.body, /^Copy of an email sent to: customersuccess@x\.com\n\nAttached\.$/);
  assert.deepEqual(c.attachments, ['blob'], 'the copy carries the PDF');
  assert.equal(em.state.sentEmails.length, 1);
  assert.equal(em.call('sendReportAdminCopy_', { to: 'a@x.com', cc: admin.toUpperCase(), subject: 's' }), null,
    'already on cc -> no copy');
  const orig = em.ctx.MailApp.sendEmail;
  em.ctx.MailApp.sendEmail = function () { throw new Error('quota'); };
  try { assert.equal(em.call('sendReportAdminCopy_', { to: 'a@x.com', subject: 's' }), null); }
  finally { em.ctx.MailApp.sendEmail = orig; }
});

test('EML-2 (cdr-report): the DCTR send is followed by the admin copy', function () {
  const src = fs.readFileSync(path.join(DASH, '..', 'cdr-report', 'emailDailyReport.js'), 'utf8');
  assert.match(src, /MailApp\.sendEmail\(dctrMsg\);\s*\n\s*sendReportAdminCopy_\(dctrMsg\);/);
});
