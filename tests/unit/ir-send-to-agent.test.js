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

const PNG = 'data:image/png;base64,' + Buffer.from('x').toString('base64');

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
