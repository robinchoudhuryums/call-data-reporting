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
