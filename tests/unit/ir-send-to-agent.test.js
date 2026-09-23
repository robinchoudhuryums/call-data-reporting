'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// "Email this Individual Report to the agent" (owner ruling 2026-09).
//
// Managers were mailing an agent's report to THEMSELVES and forwarding it.
// This sends it directly -- and the whole risk of that convenience is
// MIS-DELIVERY, so the recipient is resolved and authorized entirely
// SERVER-side. The client supplies an agent NAME (and optionally a typed
// address); it can never name a destination we trust. Three gates, each
// pinned below:
//   1. DEPT   -- caller entitled to the agent's dept AND the agent is on
//                that dept's roster (exact INV-04 match);
//   2. ADDRESS-- the registered Access Control address wins whenever one
//                exists; a typed address is consulted only without one;
//   3. DOMAIN -- a typed address must be on the sender's own domain (or one
//                listed in AGENT_EMAIL_DOMAINS).
// Plus: the send-to-self path is UNCHANGED when sendToAgent is absent.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'EmailKit.gs', 'IndividualReport.gs'],
});

// A-5: the payload must now BE a PNG (magic bytes), not merely a data URL.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
const PNG = 'data:image/png;base64,' + PNG_BYTES.toString('base64');

// Access Control rows: [email, dept, notes, role, agentName]
const AC_ROWS = [
  ['mgr@co.com', 'CSR', '', 'manager', ''],
  ['anna@co.com', 'CSR', '', 'agent', 'Anna Smith'],
];

function install(opts) {
  opts = opts || {};
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@co.com' };
  if (opts.props) Object.keys(opts.props).forEach(function (k) { h.state.props[k] = opts.props[k]; });
  h.state.userEmail = opts.email || 'mgr@co.com';
  h.state.sentEmails = [];
  h.ctx.resolveUser_ = function () {
    return opts.user || { role: 'manager', email: 'mgr@co.com',
                          department: 'CSR', departments: ['CSR'] };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.getRosterForDepartment_ = function (d) {
    return { names: d === 'CSR' ? ['Anna Smith', 'Bob Jones'] : ['Cara Lee'],
             byAgent: {}, allExtensions: {} };
  };
  h.ctx.logReportUsage_ = function () {};
  h.ctx.openSpreadsheet_ = function () {
    return {
      getSheetByName: function (n) {
        if (n !== 'Access Control') return null;
        const rows = opts.acRows === undefined ? AC_ROWS : opts.acRows;
        return {
          getLastRow: function () { return rows.length + 1; },
          getLastColumn: function () { return opts.acWidth || 5; },
          getRange: function (row, col, numRows, numCols) {
            return { getValues: function () {
              return rows.slice(row - 2, row - 2 + numRows)
                         .map(function (r) { return r.slice(col - 1, col - 1 + numCols); });
            } };
          },
        };
      },
    };
  };
}

function send(req) {
  return h.call('sendIndividualReportEmail',
    Object.assign({ imageBase64: PNG, dateLabel: 'Aug 2026' }, req));
}

test('send-to-self is UNCHANGED when sendToAgent is absent', function () {
  install({});
  const res = send({});
  assert.equal(res.to, 'mgr@co.com');
  assert.equal(res.sentToAgent, null);
  assert.equal(h.state.sentEmails.length, 1);
  assert.equal(h.state.sentEmails[0].to, 'mgr@co.com');
  assert.match(h.state.sentEmails[0].htmlBody, /sent only to you/);
});

test('gate 2: the REGISTERED address wins, and the client cannot override it', function () {
  install({});
  const res = send({ sendToAgent: true, department: 'CSR', agentName: 'Anna Smith' });
  assert.equal(res.to, 'anna@co.com', 'resolved from Access Control, not from the client');
  assert.equal(res.sentToAgent, 'Anna Smith');
  assert.equal(h.state.sentEmails[0].to, 'anna@co.com');
  // The agent should know who sent it and where to ask questions.
  assert.match(h.state.sentEmails[0].htmlBody, /Sent to you by mgr@co\.com/);
  // A different typed address is refused outright rather than silently ignored.
  assert.throws(function () {
    send({ sendToAgent: true, department: 'CSR', agentName: 'Anna Smith',
           toEmail: 'someone.else@co.com' });
  }, /registered address on file/);
});

test('gate 3: a typed address is allowed only on an allowed domain', function () {
  // Bob has no Access Control row -> a typed address is consulted.
  install({});
  const ok = send({ sendToAgent: true, department: 'CSR', agentName: 'Bob Jones',
                    toEmail: 'bob@co.com' });
  assert.equal(ok.to, 'bob@co.com');

  install({});
  assert.throws(function () {
    send({ sendToAgent: true, department: 'CSR', agentName: 'Bob Jones',
           toEmail: 'bob@gmail.com' });
  }, /company address/, 'an off-domain address must never receive performance data');

  install({});
  assert.throws(function () {
    send({ sendToAgent: true, department: 'CSR', agentName: 'Bob Jones', toEmail: 'not-an-email' });
  }, /email address/);

  install({});
  assert.throws(function () {
    send({ sendToAgent: true, department: 'CSR', agentName: 'Bob Jones' });
  }, /No address is on file/);
});

test('gate 3: AGENT_EMAIL_DOMAINS widens the allowlist (a second company domain)', function () {
  install({ props: { AGENT_EMAIL_DOMAINS: '@other.com, third.com' } });
  assert.equal(send({ sendToAgent: true, department: 'CSR', agentName: 'Bob Jones',
                      toEmail: 'bob@other.com' }).to, 'bob@other.com');
  install({ props: { AGENT_EMAIL_DOMAINS: '@other.com' } });
  assert.throws(function () {
    send({ sendToAgent: true, department: 'CSR', agentName: 'Bob Jones', toEmail: 'b@elsewhere.com' });
  }, /company address/);
});

test('gate 1: a crafted agent name or another dept reaches nobody', function () {
  install({});
  assert.throws(function () {
    send({ sendToAgent: true, department: 'CSR', agentName: 'Not A Real Agent',
           toEmail: 'x@co.com' });
  }, /not on the CSR roster/, 'an off-roster name must not be mailable');

  // A CSR manager may not send for a Sales agent (assertDeptAccess_ pins them).
  install({});
  assert.throws(function () {
    send({ sendToAgent: true, department: 'Sales', agentName: 'Cara Lee', toEmail: 'c@co.com' });
  }, /authorized/i);

  install({});
  assert.throws(function () {
    send({ sendToAgent: true, agentName: 'Anna Smith' });
  }, /department is required/);
});

test('an ADMIN may send for any dept; the agent gate still applies', function () {
  const admin = { role: 'admin', email: 'admin@co.com', department: null, departments: [] };
  install({ email: 'admin@co.com', user: admin });
  assert.equal(send({ sendToAgent: true, department: 'Sales', agentName: 'Cara Lee',
                      toEmail: 'cara@co.com' }).to, 'cara@co.com');
  install({ email: 'admin@co.com', user: admin });
  assert.throws(function () {
    send({ sendToAgent: true, department: 'Sales', agentName: 'Anna Smith', toEmail: 'a@co.com' });
  }, /not on the Sales roster/, 'right dept, wrong roster: still refused');
});

test('a pre-migration Access Control sheet (no Agent Name column) falls back to typed', function () {
  install({ acWidth: 3, acRows: [['mgr@co.com', 'CSR', '']] });
  assert.equal(send({ sendToAgent: true, department: 'CSR', agentName: 'Anna Smith',
                      toEmail: 'anna@co.com' }).to, 'anna@co.com');
});


// ---- A-5 (broad-scan 2026-09-17): the image and the subject are client-supplied ----

test('A-5: a non-PNG payload is refused even when it is a well-formed data URL', function () {
  install();
  assert.throws(function () {
    h.call('sendIndividualReportEmail', { imageBase64: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64'), dateLabel: 'x' });
  }, /not a PNG/);
  assert.throws(function () {
    h.call('sendIndividualReportEmail', { imageBase64: 'data:text/html;base64,' + Buffer.from('<b>').toString('base64'), dateLabel: 'x' });
  }, /Malformed image payload/);
  assert.equal(h.state.sentEmails.length, 0);
});

test('A-5: an oversize payload is refused before decoding', function () {
  install();
  const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 4096) / 0.75));
  assert.throws(function () {
    h.call('sendIndividualReportEmail', { imageBase64: big, dateLabel: 'x' });
  }, /too large/);
  assert.equal(h.state.sentEmails.length, 0);
});

test('A-5: the subject is one printable line, capped -- a header-injection label cannot reach the mail', function () {
  install();
  h.call('sendIndividualReportEmail', { imageBase64: PNG, dateLabel: 'Aug 2026\r\nBcc: evil@x.com\n' + 'z'.repeat(300) });
  assert.equal(h.state.sentEmails.length, 1);
  const subj = h.state.sentEmails[0].subject;
  // The CR/LF that would have started a new header is flattened to a space:
  // "Bcc: evil@x.com" survives only as inert subject TEXT.
  assert.doesNotMatch(subj, /[\r\n]/);
  assert.ok(subj.length <= 'Individual Report: '.length + 120, 'capped: ' + subj.length);
  assert.match(subj, /^Individual Report: Aug 2026 Bcc: evil@x\.com z/);
});

test('A-5: an Access Control read failure SURFACES instead of reading as "no address on file"', function () {
  install();
  const realOpen = h.ctx.openSpreadsheet_;
  h.ctx.openSpreadsheet_ = function () {
    const ss = realOpen();
    const sheet = ss.getSheetByName('Access Control');
    sheet.getRange = function () { throw new Error('Service Spreadsheets timed out'); };
    return { getSheetByName: function (n) { return n === 'Access Control' ? sheet : null; } };
  };
  // Anna HAS a registered address; with the read swallowed, a typed address
  // would have been accepted for her. It must refuse instead.
  assert.throws(function () {
    h.call('sendIndividualReportEmail', { imageBase64: PNG, dateLabel: 'x', sendToAgent: true,
      department: 'CSR', agentName: 'Anna Smith', toEmail: 'anna.other@co.com' });
  }, /Could not read Access Control/);
  assert.equal(h.state.sentEmails.length, 0);
});

// SEC-3 (broad-scan 2026-09-23): the gate was a bare `role === 'none'` check,
// so the AGENT role (and any future role) reached the send-to-self path.
test('SEC-3: an agent (or any non-manager role) cannot send an IR email', function () {
  install({ user: { role: 'agent', email: 'anna@co.com', department: null, departments: [],
                    agentDept: 'CSR', agentName: 'Anna Smith' } });
  assert.throws(function () { send({}); }, /Not authorized/);
  install({ user: { role: 'supervisor', email: 'x@co.com', department: 'CSR', departments: ['CSR'] } });
  assert.throws(function () { send({}); }, /Not authorized/);
  assert.equal(h.state.sentEmails.length, 0);
  install({ email: 'admin@co.com', user: { role: 'admin', email: 'admin@co.com', department: null, departments: ['CSR', 'Sales'] } });
  assert.equal(send({}).to, 'admin@co.com', 'admins still send to themselves');
});
