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
  'auditQueueSplitAttribution', 'probeAnswerRateFormulas', 'probeBriefThresholds'];

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

// ENG-14 (broad-scan 2026-10-12): diagnoseAbandoned attributes sentinel rows
// by queue NAME through the report's own helper, so its "== what the report
// will show" tally matches the Missed report (it still matched by extension).
test('ENG-14: diagnoseAbandoned matches sentinels by NAME (the report\'s helper), not by col-D extension overlap', function () {
  const { dqeRow, dqeSheet } = require('../harness/fixtures');
  const hd = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs', 'MissedCallsReport.gs', 'Diagnostics.gs'] });
  hd.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  hd.state.userEmail = 'admin@x.com';
  hd.ctx.inboundQueuesForDept_ = function (d) { return d === 'CSR' ? ['A_Q_CSR'] : []; };
  hd.ctx.getLatestDataDate = function () { return '2026-10-09'; };
  hd.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ CSR: ['Ann, 101'] }),
    'DQE Historical Data': dqeSheet([
      // CSR's own queue, sharing NO extension with the roster: the report counts it.
      dqeRow({ date: '2026-10-09', agent: 'A_Q_CSR', ext: '999', abdIds: '111' }),
      // Another dept's queue that SHARES the roster's extension: the report does not.
      dqeRow({ date: '2026-10-09', agent: 'A_Q_Sales', ext: '101', abdIds: '222' }),
      dqeRow({ date: '2026-10-09', agent: 'Ann', ext: '101', abdIds: '333' }),
    ]),
  } });
  const t = hd.call('diagnoseAbandoned');
  assert.equal(t.sentinelHits, 1);
  assert.equal(t.sentinelMiss, 1);
  assert.equal(t.sentinelParents, 1, 'only A_Q_CSR (pre-fix: A_Q_Sales by its shared extension, A_Q_CSR dropped)');
  assert.equal(t.union, 2, 'Ann\'s 333 + A_Q_CSR\'s 111');
  // The report itself, on the same rows, reaches the same union.
  const r = hd.call('computeMissedCallsReport_', 'CSR', '2026-10-09', '2026-10-09', 'roster');
  assert.equal(r.meta.abandonedCallCount, t.union);
});

test('ENG-14 follow-on: with the sheet retired on a Neon-read install, diagnoseAbandoned says it cannot trace (never an empty tally)', function () {
  const hd = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs', 'MissedCallsReport.gs', 'Diagnostics.gs'] });
  hd.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com', DQE_READ_SOURCE: 'neon' };
  hd.state.userEmail = 'admin@x.com';
  hd.ctx.getLatestDataDate = function () { return '2026-10-09'; };
  hd.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid({ CSR: ['Ann, 101'] }) } });
  const r = JSON.parse(JSON.stringify(hd.call('diagnoseAbandoned')));
  assert.deepEqual(r, { sheetUnavailable: true, neonReads: true });
});

// F46 (broad-scan 2026-10-14): the closing verdict keyed on DROPPED volume
// alone, so a run that had just printed "?? ... DOUBLE-COUNTED" lines ended
// with "Every queue in the split is claimed by exactly one dept ... the fix
// working". A double-claimed queue now gets its own verdict.
test('F46: auditQueueSplitAttribution names a double-claimed queue in its verdict, never "exactly one dept"', function () {
  const ha = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'NeonRead.gs', 'Diagnostics.gs'] });
  ha.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com', QUEUE_SPLIT_AUDIT_DATE: '2026-10-09' };
  ha.state.userEmail = 'admin@x.com';
  const W = 35;   // through col AI (Queue Split)
  const row = function (agent, split) {
    const r = new Array(W).fill('');
    r[1] = '2026-10-09'; r[2] = agent; r[5] = '4'; r[7] = '3';
    r[34] = JSON.stringify(split);
    return r;
  };
  ha.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ CSR: ['Ann, 101'], Sales: ['Bo, 201'] }),
    'DQE Historical Data': [new Array(W).fill('')].concat([
      row('Ann', { A_Q_Shared: { r: 4, a: 3 } }),
      row('Bo', { A_Q_Shared: { r: 4, a: 3 } }),
    ]),
  } });
  ha.ctx.inboundQueuesForDept_ = function () { return ['A_Q_Shared']; };   // BOTH depts map it
  const logs = [];
  ha.ctx.Logger = { log: function () {
    const a = Array.prototype.slice.call(arguments);
    let i = 1;
    logs.push(String(a[0]).replace(/%s/g, function () { return String(a[i++]); }));
  } };
  ha.call('auditQueueSplitAttribution');
  const text = logs.join('\n');
  assert.match(text, /\?\? A_Q_Shared .* DOUBLE-COUNTED/);
  assert.match(text, />> DOUBLE-COUNTED: 1 queue\(s\) are claimed by more than one dept/);
  assert.match(text, /A_Q_Shared \(CSR \+ Sales, rung=8\)/);
  assert.doesNotMatch(text, /claimed by exactly one dept/, 'the contradiction is gone');
});
