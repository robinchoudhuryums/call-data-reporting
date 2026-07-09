'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// logReportUsage_ (Util.gs) is the INV-01 telemetry carve-out: an
// append-only, best-effort row per report open. These tests pin the
// two properties that make it safe: it records both cache outcomes
// with the fixed schema, and it silently no-ops (never throws) when
// the Report Usage sheet doesn't exist (setup() not re-run).
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'] });
const USAGE_HEADER = ['Timestamp', 'Report', 'Department', 'Role', 'Email', 'Cache Hit'];

function install(withUsageSheet) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  const sheets = {
    'DO NOT EDIT!': ROSTER,
    'DQE Historical Data': dqeSheet([
      dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' }),
    ]),
  };
  if (withUsageSheet) sheets['Report Usage'] = [USAGE_HEADER.slice()];
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: sheets });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

const REQ = { department: 'Alpha', from: '2026-03-09', to: '2026-03-15' };

test('report usage: fresh + cache-hit opens each append one fixed-schema row', function () {
  install(true);
  h.call('getDepartmentSummary', REQ);             // fresh compute
  h.call('getDepartmentSummary', REQ);             // cache hit
  const rows = h.state.spreadsheet.getSheetByName('Report Usage')._data;
  assert.equal(rows.length, 3);                    // header + 2 usage rows
  const fresh = rows[1], hit = rows[2];
  assert.equal(fresh[1], 'summary');
  assert.equal(fresh[2], 'Alpha');
  assert.equal(fresh[3], 'admin');
  assert.equal(fresh[4], 'admin@x.com');
  assert.equal(fresh[5], 'FALSE');
  assert.equal(hit[5], 'TRUE');                    // second open served from cache
});

test('report usage: missing sheet (pre-setup install) is a silent no-op', function () {
  install(false);
  const data = h.call('getDepartmentSummary', REQ);   // must not throw
  assert.equal(data.meta.department, 'Alpha');
  assert.equal(h.state.spreadsheet.getSheetByName('Report Usage'), null);
});

test('F-27: cache-warm suppression -- no usage rows while REPORT_USAGE_SUPPRESS_ is set', function () {
  // warmReportCaches_ (CacheWarm.gs) sets the flag for the duration of a
  // warm run so automated warm traffic can't skew the report-retirement
  // evidence base (~14 fresh "summary" rows/day attributed to the admin).
  install(true);
  h.ctx.REPORT_USAGE_SUPPRESS_ = true;
  try {
    h.call('getDepartmentSummary', REQ);
  } finally {
    h.ctx.REPORT_USAGE_SUPPRESS_ = false;
  }
  const rows = h.state.spreadsheet.getSheetByName('Report Usage')._data;
  assert.equal(rows.length, 1, 'header only -- suppressed call appended nothing');
  // And a normal call afterwards logs again (flag reset works).
  h.state.cache.clear();
  h.call('getDepartmentSummary', REQ);
  assert.equal(h.state.spreadsheet.getSheetByName('Report Usage')._data.length, 2);
});
