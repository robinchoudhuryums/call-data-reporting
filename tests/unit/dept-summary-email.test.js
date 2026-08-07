'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// Round-16: sendDepartmentSummaryEmail -- the My Department "Email me this
// report" export. Caller-recipient, rides getDepartmentSummary for auth +
// compute, renders through EmailKit (the Daily Call Queue Report's house
// style). These tests pin the recipient contract, the auth gate, and the
// EmailKit shape (KPI tiles + the volume-tally cells + worst-first order).
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs',
          'EmailKit.gs', 'DeptSummaryEmail.gs'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'] });

function install() {
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'DO NOT EDIT!': ROSTER,
      'DQE Historical Data': dqeSheet([
        // Ben misses more (worse answer rate) -> must sort FIRST.
        dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 9, att: '0:03:00' }),
        dqeRow({ date: '2026-03-10', agent: 'Ben',  ext: '502', rung: 10, missed: 6, answered: 4, att: '0:02:00' }),
      ]),
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.DQE_DATE_BOUNDS_MEMO_ = null;
  h.state.cache.clear();
  h.state.sentEmails.length = 0;
}

const REQ = { department: 'Alpha', from: '2026-03-09', to: '2026-03-15' };

test('dept email: sends the EmailKit-styled summary to the caller only', function () {
  install();
  const res = h.call('sendDepartmentSummaryEmail', REQ);
  assert.equal(res.to, 'admin@x.com');
  assert.equal(h.state.sentEmails.length, 1);
  const mail = h.state.sentEmails[0];
  assert.equal(mail.to, 'admin@x.com');
  assert.equal(mail.subject, 'My Department: Alpha · 2026-03-09 – 2026-03-15');
  const html = mail.htmlBody;
  // EmailKit shell: the kicker + 600px card + footer note.
  assert.match(html, /Call Data · My Department/);
  assert.match(html, /width="600"/);
  assert.match(html, /not a subscription/);
  // KPI row binds the real totals: 13 answered / 7 missed = 65% (under the
  // 92% seed goal -> bad tile red value).
  assert.match(html, /65\.0%/);
  assert.match(html, /92% goal/);
  // The agent table carries the volume tally (green answered block cells).
  assert.match(html, /width="5" style="background:#3d9476/);
  // Worst answer rate first: Ben (40%) before Anna (90%).
  assert.ok(html.indexOf('Ben') < html.indexOf('Anna'), 'worst-first sort');
  assert.match(html, /sorted worst answer rate first/);
});

test('dept email: unauthorized caller is rejected before any send', function () {
  install();
  h.state.userEmail = 'stranger@x.com';   // not admin, no Access Control row
  assert.throws(function () { h.call('sendDepartmentSummaryEmail', REQ); }, /Not authorized/);
  assert.equal(h.state.sentEmails.length, 0);
});

test('dept email: invalid request surfaces getDepartmentSummary\'s validation', function () {
  install();
  assert.throws(function () {
    h.call('sendDepartmentSummaryEmail', { department: 'Alpha', from: '2026-03-15', to: '2026-03-09' });
  }, /from must be on or before to/);
  assert.equal(h.state.sentEmails.length, 0);
});
