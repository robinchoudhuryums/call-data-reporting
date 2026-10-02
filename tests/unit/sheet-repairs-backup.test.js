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
  const keep = h.ctx.HR_BACKUP_KEEP_;
  // keep + 2 applies, labelled l00, l01, ... so the two OLDEST must be pruned.
  const labels = [];
  for (let i = 0; i < keep + 2; i++) labels.push('l' + (i < 10 ? '0' : '') + i);
  labels.forEach(function (label) { h.call('hrBackupBeforeApply_', ss, dqe, label, 600); });
  const tabs = tabsOf(backupSs());
  const dqeTabs = tabs.filter(function (t) { return t.indexOf('DQE Historical Data|') === 0; });
  assert.equal(dqeTabs.length, keep, 'pruned to ' + keep + ': ' + dqeTabs.join(', '));
  const survivors = labels.slice(2);
  assert.ok(dqeTabs.every(function (t) { return survivors.some(function (l) { return new RegExp('\\|' + l + '(-\\d+)?$').test(t); }); }),
    'the NEWEST survive (l00, l01 pruned): ' + dqeTabs.join(', '));
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
                   'mergeDqeDuplicateRows_', 'normalizeDqeDateColumn_', 'repairQcdViolationFlags_'];
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

// CRT-5 (broad-scan 2026-09-23): the keep window must hold a whole DQE repair
// chain (five applies on one sheet) so the pre-chain original survives it.
test('CRT-5: HR_BACKUP_KEEP_ covers the five-apply DQE chain', function () {
  assert.ok(h.ctx.HR_BACKUP_KEEP_ >= 5, 'keep=' + h.ctx.HR_BACKUP_KEEP_);
});

// ---- broad-scan 2026-10-01 Batch 9 (CR-1 / CR-2 / CR-3 / CR-4 / CR-7) -------

test('CR-1: every DQE bulk apply snapshots FIRST, then re-verifies, then writes (source pin)', function () {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-report', 'sheetRepairs.js'), 'utf8');
  [['repairDqeAbandonedIds_', 'repairDqeAbandonedIds'], ['repairDqeOldPstTimestampShift_', 'repairDqeOldPstTimestampShift'],
   ['mergeDqeDuplicateRows_', 'repairDqeDuplicateMerge'], ['normalizeDqeDateColumn_', 'repairDqeDateNormalize'],
   ['repairDqeSlotTimestamps_', 'repairDqeSlotTimestamps'],
   ['repairQcdViolationFlags_', 'repairQcdViolationFlags']].forEach(function (p) {   // QO-2: the QCD twin
    const start = src.indexOf('function ' + p[0] + '(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end > 0 ? end : undefined);
    const backup = body.indexOf('hrBackupBeforeApply_(');
    const reverify = body.indexOf("hrReverifyRows_(sheet, rowSnap, '" + p[1] + "')");
    const firstWrite = body.search(/\.setValues\(|\.deleteRow\(|\.setValue\(/);
    assert.ok(backup > 0 && reverify > 0, p[0] + ' has both');
    assert.ok(backup < reverify, p[0] + ': the snapshot (a long copy) runs BEFORE the re-check, never after it');
    assert.ok(reverify < firstWrite, p[0] + ': the re-check is the last step before the first write');
  });
});

test('CR-4: the backup prunes to KEEP-1 BEFORE copying, so the workbook never holds KEEP+1 copies', function () {
  const keep = h.ctx.HR_BACKUP_KEEP_;
  const ss = install({ 'DQE Historical Data': dqeGrid(2) });
  const sheet = ss.getSheetByName('DQE Historical Data');
  let peak = 0;
  const realCopy = sheet.copyTo;
  sheet.copyTo = function (target) {
    const mine = target.getSheets().filter(function (t) { return t.getName().indexOf('DQE Historical Data|') === 0; });
    peak = Math.max(peak, mine.length + 1);   // the tabs already there + the one being copied
    return realCopy.call(this, target);
  };
  for (let i = 0; i < keep + 3; i++) h.call('hrBackupBeforeApply_', ss, sheet, 'run' + i, 600);
  assert.ok(peak <= keep, 'peak ' + peak + ' copies held during a copy, cap ' + keep);
  const left = tabsOf(backupSs()).filter(function (t) { return t.indexOf('DQE Historical Data|') === 0; });
  assert.equal(left.length, keep, 'the newest KEEP survive');
  assert.ok(left.some(function (t) { return /\|run\d+$/.test(t) && t.endsWith('run' + (keep + 2)); }), 'incl. the newest');
});

test('CR-7: the col D preview classifies clean / single / merged cells and writes nothing', function () {
  const ss = install({ 'DQE Historical Data': [
    ['Month', 'Date', 'Agent', 'Exts'],
    ['Jun', '06/01/2026', 'A', '103,108'],
    ['Jun', '06/01/2026', 'B', 103],
    ['Jun', '06/02/2026', 'C', 103108],
    ['Jun', '06/02/2026', 'D', ''],
  ] });
  const sheet = ss.getSheetByName('DQE Historical Data');
  sheet.setValues = sheet.setValue = function () { throw new Error('preview wrote'); };
  const res = h.call('previewDqeQueueExtColumn');
  assert.equal(res.text, 1);
  assert.equal(res.singleNumeric, 1, 'a single ext stored as a number is lossless');
  assert.equal(res.mergedNumeric, 1, '103108 is a merged "103,108"');
  assert.equal(res.empty, 1);
  assert.deepEqual(Array.from(res.mergedDates), ['06/02/2026']);
});
