'use strict';

// C3 edit UIs -- server write RPCs for Alert Config + Digest Config. These
// write the ACTIVE source (sheet by default; Neon when CONFIG_SOURCE=neon).
// Tests cover the sheet path (default): admin-gated, validated, upsert by key,
// remove by key. Mirrors access-control-editor.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Alerts.gs', 'Digest.gs'] });

const ROSTER_HEADERS = (function () { return new Array(5).fill('').concat(['CSR', 'Sales']); })();

function install(alertRows, digestRows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  delete h.state.props.CONFIG_SOURCE;   // sheet path
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'DO NOT EDIT!': [ROSTER_HEADERS],
      'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates']].concat(alertRows || []),
      'Digest Config': [['Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format']].concat(digestRows || []),
    },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
}
function rows(name) { return h.state.spreadsheet.getSheetByName(name)._data.slice(1); }

// ---- Alert Config ----
test('saveAlertConfigRow appends + upserts by department', function () {
  install([], []);
  h.call('saveAlertConfigRow', { department: 'CSR', threshold: 92, extraRecipients: 'a@x.com', active: true, notes: 'n', skipDates: '' });
  assert.equal(rows('Alert Config').length, 1);
  assert.equal(rows('Alert Config')[0][0], 'CSR');
  assert.equal(rows('Alert Config')[0][1], '92');
  // Upsert same dept -> updates in place.
  h.call('saveAlertConfigRow', { department: 'CSR', threshold: 80, active: false });
  assert.equal(rows('Alert Config').length, 1);
  assert.equal(rows('Alert Config')[0][1], '80');
  assert.equal(rows('Alert Config')[0][3], 'FALSE');
});

test('saveAlertConfigRow validates dept, threshold, emails', function () {
  install([], []);
  assert.throws(function () { h.call('saveAlertConfigRow', { department: 'Nope', threshold: 92 }); }, /not a department/);
  assert.throws(function () { h.call('saveAlertConfigRow', { department: 'CSR', threshold: 0 }); }, /between 1 and 100/);
  assert.throws(function () { h.call('saveAlertConfigRow', { department: 'CSR', threshold: 150 }); }, /between 1 and 100/);
  assert.throws(function () { h.call('saveAlertConfigRow', { department: 'CSR', threshold: 92, extraRecipients: 'junk' }); }, /Invalid extra-recipient/);
  assert.equal(rows('Alert Config').length, 0);
});

test('removeAlertConfigRow deletes by department', function () {
  install([['CSR', '92', '', 'TRUE', '', ''], ['Sales', '90', '', 'TRUE', '', '']], []);
  const res = h.call('removeAlertConfigRow', { department: 'CSR' });
  assert.equal(res.removed, 1);
  assert.equal(rows('Alert Config').length, 1);
  assert.equal(rows('Alert Config')[0][0], 'Sales');
});

// ---- Digest Config ----
test('saveDigestConfigRow appends + upserts by (email, dept)', function () {
  install([], []);
  h.call('saveDigestConfigRow', { email: 'M@X.com', department: 'CSR', cadence: 'daily', format: 'summary', active: true });
  assert.equal(rows('Digest Config').length, 1);
  // Same email+dept -> update; different cadence.
  h.call('saveDigestConfigRow', { email: 'm@x.com', department: 'CSR', cadence: 'weekly', format: 'insights', active: false });
  assert.equal(rows('Digest Config').length, 1);
  assert.equal(rows('Digest Config')[0][2], 'weekly');
  assert.equal(rows('Digest Config')[0][5], 'insights');
  // Same email, DIFFERENT dept -> new row.
  h.call('saveDigestConfigRow', { email: 'm@x.com', department: 'Sales', cadence: 'daily' });
  assert.equal(rows('Digest Config').length, 2);
});

test('saveDigestConfigRow validates email, dept, cadence', function () {
  install([], []);
  assert.throws(function () { h.call('saveDigestConfigRow', { email: 'nope', department: 'CSR', cadence: 'daily' }); }, /valid email/);
  assert.throws(function () { h.call('saveDigestConfigRow', { email: 'a@b.com', department: 'Nope', cadence: 'daily' }); }, /not a department/);
  assert.throws(function () { h.call('saveDigestConfigRow', { email: 'a@b.com', department: 'CSR', cadence: 'hourly' }); }, /daily, weekly, or monthly/);
  assert.equal(rows('Digest Config').length, 0);
});

test('removeDigestConfigRow deletes by (email, dept)', function () {
  install([], [['m@x.com', 'CSR', 'daily', 'TRUE', '', 'summary'], ['m@x.com', 'Sales', 'daily', 'TRUE', '', 'summary']]);
  const res = h.call('removeDigestConfigRow', { email: 'M@X.com', department: 'CSR' });
  assert.equal(res.removed, 1);
  assert.equal(rows('Digest Config').length, 1);
  assert.equal(rows('Digest Config')[0][1], 'Sales');
});

test('all C3 write RPCs are admin-gated', function () {
  install([], []);
  h.state.userEmail = 'manager@x.com';
  assert.throws(function () { h.call('saveAlertConfigRow', { department: 'CSR', threshold: 92 }); });
  assert.throws(function () { h.call('removeAlertConfigRow', { department: 'CSR' }); });
  assert.throws(function () { h.call('saveDigestConfigRow', { email: 'a@b.com', department: 'CSR', cadence: 'daily' }); });
  assert.throws(function () { h.call('removeDigestConfigRow', { email: 'a@b.com', department: 'CSR' }); });
});
