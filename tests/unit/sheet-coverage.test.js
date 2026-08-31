'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert');   // cross-realm (tests/README.md)
const { loadGas } = require('../harness/loadGas');

// R25: SHEET coverage check — the sheet-side twin of runNeonCoverageCheck.
//
// The blind spot it closes: every existing sheet watcher looks at the
// TRAILING edge (freshness/staleness) or per-agent silence, and the Neon
// coverage check compares the two sides — so a date missing from BOTH is
// invisible. An import that skips Tuesday while Wednesday succeeds leaves a
// permanent hole that no signal reports and every report quietly averages
// over. Pinned here:
//   (1) an interior missing business day IS found;
//   (2) weekends, company holidays, and dates BEFORE the sheet's first row
//       are not gaps (the three false-positive sources);
//   (3) a MISSING sheet is reported distinctly from one with holes;
//   (4) it opens no Neon connection — it must work during an outage, which
//       is exactly when a missed import is most likely;
//   (5) admin-gated, read-only, and it emails only when there is a finding.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'SheetCoverage.gs'],
});

const SPECS = [{ sheet: 'DQE Historical Data', dateCol: 2, label: 'DQE', fix: 'refix' }];

function counts(isos) {
  const c = {};
  isos.forEach(function (d) { c[d] = (c[d] || 0) + 1; });
  return c;
}

// Mon 2026-08-10 .. Fri 2026-08-14 is a clean business week.
test('an interior missing business day is FOUND', function () {
  const got = h.call('sheetCoverageAssess_', SPECS, '2026-08-10', '2026-08-14',
    { 'DQE Historical Data': counts(['2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14']) },
    { 'DQE Historical Data': '2026-08-01' }, function () { return false; });
  assert.equal(got.length, 1);
  deepEqual(got[0].gaps, ['2026-08-12'], 'Wednesday is missing and must be reported');
  assert.equal(got[0].missingSheet, false);
});

test('weekends are never gaps', function () {
  // Sat 15th + Sun 16th absent, every weekday present.
  const got = h.call('sheetCoverageAssess_', SPECS, '2026-08-10', '2026-08-17',
    { 'DQE Historical Data': counts(['2026-08-10', '2026-08-11', '2026-08-12',
                                     '2026-08-13', '2026-08-14', '2026-08-17']) },
    { 'DQE Historical Data': '2026-08-01' }, function () { return false; });
  deepEqual(got[0].gaps, []);
});

test('company holidays are never gaps', function () {
  const got = h.call('sheetCoverageAssess_', SPECS, '2026-08-10', '2026-08-14',
    { 'DQE Historical Data': counts(['2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14']) },
    { 'DQE Historical Data': '2026-08-01' },
    function (iso) { return iso === '2026-08-12'; });
  deepEqual(got[0].gaps, [], 'the one absent weekday is a declared holiday');
});

test('dates BEFORE the sheet begins are not gaps (the floor)', function () {
  // Sheet starts Wednesday; Mon/Tue predate it and must not be flagged.
  const got = h.call('sheetCoverageAssess_', SPECS, '2026-08-10', '2026-08-14',
    { 'DQE Historical Data': counts(['2026-08-12', '2026-08-13', '2026-08-14']) },
    { 'DQE Historical Data': '2026-08-12' }, function () { return false; });
  deepEqual(got[0].gaps, []);
});

test('a MISSING sheet is reported distinctly from one with holes', function () {
  const got = h.call('sheetCoverageAssess_', SPECS, '2026-08-10', '2026-08-14',
    { 'DQE Historical Data': null }, {}, function () { return false; });
  assert.equal(got[0].missingSheet, true, 'needs a different operator response than a gap');
  deepEqual(got[0].gaps, []);
});

test('an empty-but-present sheet flags every business day (a real, total gap)', function () {
  const got = h.call('sheetCoverageAssess_', SPECS, '2026-08-10', '2026-08-14',
    { 'DQE Historical Data': {} }, { 'DQE Historical Data': null },
    function () { return false; });
  assert.equal(got[0].missingSheet, false);
  assert.equal(got[0].gaps.length, 5, 'Mon-Fri all missing');
});

// ── The live runner ──────────────────────────────────────────────────────

function installRunner(sheets) {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.sentEmails = [];
  installRunner.neonCalls = 0;
  h.ctx.getDashboardNeonConn_ = function () { installRunner.neonCalls++; return null; };
  h.ctx.openSpreadsheet_ = function () {
    return {
      getSheetByName: function (n) {
        const rows = sheets[n];
        if (!rows) return null;
        return {
          getLastRow: function () { return rows.length + 1; },
          getRange: function (r, c, nr) {
            return { getDisplayValues: function () {
              return rows.slice(r - 2, r - 2 + nr).map(function (d) { return [d]; });
            } };
          },
        };
      },
    };
  };
}

test('the live runner opens NO Neon connection (it must work during an outage)', function () {
  installRunner({ 'DQE Historical Data': ['2026-08-10'] });
  h.call('runSheetCoverageCheck');
  assert.equal(installRunner.neonCalls, 0,
    'a sheet-side check that needs Neon is useless exactly when it matters most');
});

test('the runner records an OPS-8 prefixed outcome and emails only on findings', function () {
  // A sheet holding only dates far in the past -> every in-window day is a
  // gap, but they are all BELOW the floor... so use a recent-but-holed sheet.
  const today = new Date();
  const iso = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
         + '-' + String(d.getDate()).padStart(2, '0');
  };
  const days = [];
  for (let i = 1; i <= 20; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) days.push(iso(d));
  }
  // Drop one business day to create a hole.
  const holed = days.slice(); const dropped = holed.splice(2, 1)[0];
  installRunner({ 'DQE Historical Data': holed });
  const res = h.call('runSheetCoverageCheck');
  assert.ok(res.findings > 0, 'the hole is found');
  const flagged = res.sheets.filter(function (s) { return s.sheet === 'DQE Historical Data'; })[0];
  assert.ok(flagged.gaps.indexOf(dropped) !== -1, 'the dropped day is named');
  assert.match(h.state.props.SHEET_COVERAGE_LAST_RESULT, /^GAPS /, 'OPS-8 prefix coded');
  assert.equal(h.state.sentEmails.length, 1, 'admins are told');
  assert.match(h.state.sentEmails[0].subject, /Sheet coverage/);
});

test('a clean window records CLEAN and sends NO email (no crying wolf)', function () {
  const today = new Date();
  const iso = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
         + '-' + String(d.getDate()).padStart(2, '0');
  };
  const days = [];
  for (let i = 1; i <= 40; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) days.push(iso(d));
  }
  installRunner({
    'DQE Historical Data': days,
    'QCD Historical Data': days,
    'Direct Call History': days,
  });
  const res = h.call('runSheetCoverageCheck');
  assert.equal(res.findings, 0);
  assert.match(h.state.props.SHEET_COVERAGE_LAST_RESULT, /^CLEAN /);
  assert.equal(h.state.sentEmails.length, 0);
});

test('non-admins are refused', function () {
  installRunner({ 'DQE Historical Data': [] });
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('runSheetCoverageCheck'); }, /admin/i);
});
