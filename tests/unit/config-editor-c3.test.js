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
  // R8-B4: the stored email is LOWERCASED at the editor -- the Neon path's
  // ON CONFLICT (email, department) PK is exact-case, so mixed-case saves
  // used to create duplicate rows there while the sheet path edited one.
  assert.equal(rows('Digest Config')[0][0], 'm@x.com',
    'mixed-case save stored lowercase (one PK key for both stores)');
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

// ---- R8-A5 (audit 2026-07-21): threshold drift honors OPS-9 first-row-wins ----
test('R8-A5: computeThresholdDrift_ uses the FIRST duplicate row\'s threshold, not the last', function () {
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  const logRows = [];
  for (let i = 0; i < 12; i++) {
    // [ts, dept, dateChecked, threshold, answerRate, sent, recipients, triggeredBy, notes, status]
    logRows.push(['t' + i, 'CSR', '2026-07-0' + (i % 9 + 1), 50, 62, 'FALSE', '', 'daily-trigger', '', 'above-threshold']);
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Alert Log': [['Timestamp', 'Department', 'Date Checked', 'Threshold %', 'Answer Rate %',
                   'Sent', 'Recipients', 'Triggered By', 'Notes', 'Status']].concat(logRows),
  } });
  // First row (authoritative, OPS-9): threshold 50 -> meanRate 62 >= 50+10 =
  // LENIENT. The hand-edited duplicate carries 95; pre-fix it OVERWROTE the
  // bucket and the chip read 'ok' against a threshold the engine never uses.
  const config = [
    { department: 'CSR', threshold: 50 },
    { department: 'CSR', threshold: 95, duplicateRow: true },
  ];
  const out = h.call('computeThresholdDrift_', config, 30);
  assert.equal(out.CSR.total, 12);
  assert.equal(out.CSR.fired, 0);
  assert.equal(out.CSR.severity, 'lenient', 'classified against the FIRST row\'s threshold (50)');
});
