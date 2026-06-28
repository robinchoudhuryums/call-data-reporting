'use strict';

// C3: Alert Config + Digest Config readers must produce IDENTICAL parsed
// output whether they read the sheet (default) or the Neon alert_config /
// digest_config tables (CONFIG_SOURCE=neon), and must fall back to the sheet
// when Neon is unreachable. Fake JDBC serves the json_agg payloads.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'NeonRead.gs', 'DeptConfig.gs', 'Alerts.gs', 'Digest.gs'],
});

// Logical config rows.
const ALERT_ROWS = [
  ['CSR', '85', 'extra@x.com, two@x.com', 'TRUE', 'note', '2026-12-25'],
  ['Sales', '90', '', 'FALSE', '', ''],
];
const DIGEST_ROWS = [
  ['m@x.com', 'CSR', 'daily', 'TRUE', 'n', 'summary'],
  ['m2@x.com', 'Sales', 'weekly', 'FALSE', '', 'insights'],
];

function rsFor(json) {
  let c = false;
  return { next: function () { if (c) return false; c = true; return true; },
           getString: function () { return json; }, close: function () {} };
}
function fakeConn() {
  return {
    createStatement: function () {
      return {
        execute: function () { return true; },   // CREATE TABLE
        executeQuery: function (sql) {
          if (sql.indexOf('FROM alert_config') !== -1) {
            return rsFor(JSON.stringify(ALERT_ROWS.map(function (r) {
              return { department: r[0], threshold: r[1], extra_recipients: r[2],
                       active: r[3] !== 'FALSE', notes: r[4], skip_dates: r[5] };
            })));
          }
          if (sql.indexOf('FROM digest_config') !== -1) {
            return rsFor(JSON.stringify(DIGEST_ROWS.map(function (r) {
              return { email: r[0], department: r[1], cadence: r[2],
                       active: r[3] !== 'FALSE', notes: r[4], format: r[5] };
            })));
          }
          throw new Error('Unexpected SQL: ' + sql);
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function installSheet() {
  h.state.props.SPREADSHEET_ID = 'fake';
  delete h.state.props.CONFIG_SOURCE;
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates']].concat(ALERT_ROWS),
      'Digest Config': [['Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format']].concat(DIGEST_ROWS),
    },
  });
}
function installNeon(conn) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.CONFIG_SOURCE = 'neon';
  h.ctx.getDashboardNeonConn_ = conn;
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });   // no sheets -> proves Neon read
}

const J = function (x) { return JSON.stringify(x); };

test('Alert Config: Neon read matches the sheet read', function () {
  installSheet();
  const fromSheet = h.call('readAlertConfig_');
  installNeon(fakeConn);
  const fromNeon = h.call('readAlertConfig_');
  assert.equal(J(fromNeon), J(fromSheet));
  assert.equal(fromNeon.length, 2);
});

test('Digest Config: Neon read matches the sheet read', function () {
  installSheet();
  const fromSheet = h.call('readDigestConfig_');
  installNeon(fakeConn);
  const fromNeon = h.call('readDigestConfig_');
  assert.equal(J(fromNeon), J(fromSheet));
  assert.equal(fromNeon.length, 2);
});

test('CONFIG_SOURCE=neon but unreachable -> Alert/Digest fall back to the sheet', function () {
  installSheet();                       // sheet has the data
  h.state.props.CONFIG_SOURCE = 'neon';
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // unreachable
  assert.equal(h.call('readAlertConfig_').length, 2);
  assert.equal(h.call('readDigestConfig_').length, 2);
});
