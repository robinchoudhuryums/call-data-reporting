'use strict';

// CH-1 (broad-scan 2026-10-01): the Diagnostics.gs operator tools are run from
// the Apps Script editor's Run dropdown, which HIDES `_`-suffixed functions --
// so they must be public. Public means RPC-reachable, so each one must refuse a
// non-admin before it reads anything.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const TOOLS = ['diagnoseDate', 'whyNoMatches', 'diagnoseTimes', 'dumpCell', 'diagnoseAbandoned',
  'auditQueueSplitAttribution', 'probeAnswerRateFormulas'];

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'NeonRead.gs', 'Diagnostics.gs'] });

test('CH-1: every editor-run diagnostic is public (visible in the Run dropdown) and none is left _-suffixed', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'Diagnostics.gs'), 'utf8');
  TOOLS.forEach(function (n) {
    assert.match(src, new RegExp('^function ' + n + '\\(\\) \\{$', 'm'), n + ' is declared public, no arguments');
    assert.doesNotMatch(src, new RegExp('^function ' + n + '_\\(', 'm'), n + '_ is gone');
  });
  // Every public function in the file is one of the tools -- a new one must be
  // added to TOOLS (and so to the admin-gate test below).
  const publics = (src.match(/^function ([A-Za-z0-9]+)\(/gm) || []).map(function (l) { return l.slice(9, -1); });
  assert.deepEqual(publics.slice().sort(), TOOLS.slice().sort());
});

test('CH-1: each tool refuses a non-admin before reading anything', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.userEmail = 'manager@x.com';   // no Access Control row -> role none
  let opened = 0;
  const ss = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid({ CSR: ['Ann, 101'] }) } });
  h.state.spreadsheet = new Proxy(ss, { get: function (t, k) { if (k === 'getSheetByName') opened++; return t[k]; } });
  TOOLS.forEach(function (n) {
    const before = opened;
    assert.throws(function () { h.call(n); }, /admin/i, n + ' must refuse a non-admin');
    // resolveUser_ itself reads Access Control; the tool must not get further.
    assert.ok(opened - before <= 2, n + ' read the workbook past the gate (' + (opened - before) + ' sheet opens)');
  });
});
