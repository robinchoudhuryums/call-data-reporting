'use strict';
// Roadmap 1b: every bulk repair apply snapshots the sheet into the standing
// backup workbook BEFORE its first write; previews and small applies never do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// buildDQEHistoricalData.js supplies dateAtSheetMidnight_ (R46) for the
// end-to-end date-normalize apply below.
const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'buildDQEHistoricalData.js', 'sheetRepairs.js'] });

function install(sheets) {
  h.state.props = { SPREADSHEET_ID: 'fake' };   // a FRESH property store: HR_BACKUP_SS_ID must not leak between tests
  h.state.spreadsheetsById = {};
  h.state.createdSpreadsheets = [];
  h.state.strictOpenById = true;                // an unknown id THROWS, like the real API
  h.state.spreadsheet = makeFakeSpreadsheet({ id: 'fake', sheets: sheets });
  return h.state.spreadsheet;
}
function dqeGrid(nRows) {
  const rows = [['Month', 'Date', 'Agent', 'x']];
  for (let i = 0; i < nRows; i++) rows.push(['Sep, 26', '9/9/2026', 'agent' + i, 'x']);
  return rows;
}
function backupSs() { return h.state.createdSpreadsheets[0] || null; }
function tabsOf(ss) { return ss.getSheets().map(function (t) { return t.getName(); }); }

test('1b: below the threshold nothing is created, stored or copied', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(3) });
  const res = h.call('hrBackupBeforeApply_', ss, ss.getSheetByName('DQE Historical Data'), 'x', 499);
  assert.equal(res, null);
  assert.equal(h.state.createdSpreadsheets.length, 0, 'no backup workbook created');
  assert.equal(h.state.props.HR_BACKUP_SS_ID, undefined, 'no id stored');
});

test('1b: at the threshold the backup workbook is created ONCE, its id stored, and the sheet copied under a dated|label tab', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(3) });
  const sheet = ss.getSheetByName('DQE Historical Data');
  const a = h.call('hrBackupBeforeApply_', ss, sheet, 'date-normalize', 500);
  const b = h.call('hrBackupBeforeApply_', ss, sheet, 'pst-shift', 9000);
  assert.equal(h.state.createdSpreadsheets.length, 1, 'one standing workbook, reused');
  assert.equal(h.state.props.HR_BACKUP_SS_ID, backupSs().getId(), 'its id is remembered');
  assert.match(a.tab, /^DQE Historical Data\|\d{8}-\d{4}\|date-normalize$/);
  assert.match(b.tab, /^DQE Historical Data\|\d{8}-\d{4}\|pst-shift$/);
  assert.equal(a.url, backupSs().getUrl());
  assert.equal(a.cells, 500);
  const tabs = tabsOf(backupSs());
  assert.ok(tabs.includes(a.tab) && tabs.includes(b.tab), 'both tabs exist: ' + tabs.join(', '));
  // The copy is a real copy: same grid as the source at the time of the call.
  const copy = backupSs().getSheetByName(a.tab);
  assert.deepEqual(copy._data, sheet._data);
  assert.notEqual(copy._data, sheet._data, 'and not the same array (a later write must not reach the backup)');
});

test('1b: a same-minute re-run with the same label gets a suffixed tab, never an overwrite', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(2) });
  const sheet = ss.getSheetByName('DQE Historical Data');
  const a = h.call('hrBackupBeforeApply_', ss, sheet, 'date-normalize', 600);
  const b = h.call('hrBackupBeforeApply_', ss, sheet, 'date-normalize', 600);
  assert.equal(b.tab, a.tab + '-2');
  assert.equal(tabsOf(backupSs()).filter(function (t) { return t.indexOf('DQE Historical Data|') === 0; }).length, 2);
});

test('1b: the prune keeps the newest HR_BACKUP_KEEP_ tabs per SOURCE sheet and leaves other sheets\' tabs alone', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(2), 'QCD Historical Data': [['h'], ['r']] });
  const dqe = ss.getSheetByName('DQE Historical Data');
  const qcd = ss.getSheetByName('QCD Historical Data');
  h.call('hrBackupBeforeApply_', ss, qcd, 'other', 600);   // a different source sheet's tab
  ['a', 'b', 'c', 'd', 'e'].forEach(function (label) { h.call('hrBackupBeforeApply_', ss, dqe, label, 600); });
  const keep = h.ctx.HR_BACKUP_KEEP_;
  const tabs = tabsOf(backupSs());
  const dqeTabs = tabs.filter(function (t) { return t.indexOf('DQE Historical Data|') === 0; });
  assert.equal(dqeTabs.length, keep, 'pruned to ' + keep + ': ' + dqeTabs.join(', '));
  assert.ok(dqeTabs.every(function (t) { return /\|(c|d|e)$/.test(t); }), 'the NEWEST survive (a, b pruned): ' + dqeTabs.join(', '));
  assert.equal(tabs.filter(function (t) { return t.indexOf('QCD Historical Data|') === 0; }).length, 1, 'another sheet\'s backup untouched');
  assert.ok(tabs.includes('Sheet1'), 'the workbook\'s default tab is never a prune target');
});

test('1b: a stored id whose workbook is gone is replaced -- the backup still happens', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(2) });
  h.state.props.HR_BACKUP_SS_ID = 'deleted-long-ago';
  const res = h.call('hrBackupBeforeApply_', ss, ss.getSheetByName('DQE Historical Data'), 'x', 600);
  assert.ok(res && res.tab, 'a snapshot was taken');
  assert.equal(h.state.createdSpreadsheets.length, 1, 'a fresh workbook was created');
  assert.equal(h.state.props.HR_BACKUP_SS_ID, backupSs().getId(), 'and the id re-stored');
});

test('1b: repairDqeDateNormalize snapshots BEFORE writing -- the tab holds the PRE-repair values -- and the preview never does', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(600) });   // 600 text cells >= threshold
  const sheet = ss.getSheetByName('DQE Historical Data');
  h.call('previewDqeDateNormalize');
  assert.equal(h.state.createdSpreadsheets.length, 0, 'preview: no backup');
  const res = h.call('repairDqeDateNormalize');
  assert.equal(res.applied, true);
  assert.ok(res.backup && /\|date-normalize$/.test(res.backup.tab), 'the apply reports its snapshot');
  const copy = backupSs().getSheetByName(res.backup.tab);
  assert.equal(copy._data[1][1], '9/9/2026', 'the snapshot holds the ORIGINAL text cell');
  assert.ok(sheet._data[1][1] instanceof Date, 'while the live sheet now holds the Date');
});

test('1b: a small apply (under the threshold) writes the sheet but takes no snapshot', function () {
  const ss = install({ 'DQE Historical Data': dqeGrid(3) });
  const res = h.call('repairDqeDateNormalize');
  assert.equal(res.applied, true);
  assert.equal(res.backup, null);
  assert.equal(h.state.createdSpreadsheets.length, 0);
});

test('1b: every bulk apply in sheetRepairs.js calls the backup before its first write (source pin)', function () {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-report', 'sheetRepairs.js'), 'utf8');
  const applies = ['repairDqeSlotTimestamps_', 'repairDqeAbandonedIds_', 'repairDqeOldPstTimestampShift_',
                   'mergeDqeDuplicateRows_', 'normalizeDqeDateColumn_'];
  applies.forEach(function (fn) {
    const start = src.indexOf('function ' + fn + '(');
    assert.ok(start > 0, fn + ' found');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end > 0 ? end : undefined);
    const call = body.indexOf('hrBackupBeforeApply_(');
    assert.ok(call > 0, fn + ' calls the backup');
    // The first setValues/deleteRow/setNumberFormat AFTER the dry-run branch must
    // come after the backup call. (The slot repair's per-group format toggles
    // before its scan are preview-safe and restored; its VALUE writes follow.)
    const firstWrite = body.search(/\.setValues\(|\.deleteRow\(|\.setValue\(/);
    assert.ok(firstWrite > call, fn + ': the backup precedes the first value write');
  });
});
