'use strict';
// Broad-scan 2026-11-09, Batch 1 -- "destructive rebuild paths that report
// success" (cdr-import). Each test drives the REAL code path the finding was
// reproduced on:
//   RB-1  a bulk date whose DQE rebuild failed is reported, not "✅ Success"
//   RB-7  bulk-run bookkeeping after errors (count, queue guard, Health row)
//   RB-2  the editor-run Direct build takes the day most rows are on
//   RB-3  "Make a date whole" writes through the DAILY path, not the bulk queue
//   RB-4  the QCD force-loss guard counts rows that carry a call
//   RB-5  a resumed batch archive still mirrors CDR / QCD to Neon
//   RB-6  the CSR header-order refusal runs before the force-delete

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'autoImport.js'), 'utf8');
const PH_HEADER = ['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes'];
function phRows(ss) {
  return ss._sheet('Pipeline Health')._data.slice(1)
    .map(function (r) { return { step: r[1], status: r[2], rows: r[3], notes: String(r[5]) }; });
}
function fakeUi(alerts, answer) {
  return { ButtonSet: { OK: 'OK', YES_NO: 'YN', OK_CANCEL: 'OC' }, Button: { OK: 'OK', YES: 'YES', NO: 'NO' },
    alert: function (t, m) { alerts.push([String(t), String(m == null ? '' : m)]); return answer || 'YES'; },
    prompt: function () { return { getSelectedButton: function () { return 'CANCEL'; } }; } };
}

// The fake sheet does not model clearContents; Raw Data's staging rewrite needs it.
function withClearContents(ss, width) {
  const rd = ss._sheet('Raw Data');
  rd.clearContents = function () { rd._data.length = 0; rd._data.push(new Array(width).fill('')); return rd; };
  return ss;
}

// A one-leg source tab at the staging width (the import rewrites Raw Data 44 wide).
function legsTab(start) {
  const hdr = new Array(44).fill('h');
  const row = new Array(44).fill('');
  row[0] = 'r'; row[2] = start;
  return [hdr, row];
}

// ── RB-1 + RB-7: the bulk queue ────────────────────────────────────────────────

function bulkHarness() {
  const h = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'autoImport.js'] });
  h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
  h.ctx.notifyNeonWriteFailure = function () {};
  function leg(o) {
    const r = new Array(44).fill('');
    r[0] = o.callId; r[1] = '1'; r[2] = o.start; r[4] = o.start; r[6] = o.talk || '0:00:00'; r[7] = '0:00:10';
    r[8] = o.caller || ''; r[10] = o.callee || ''; r[11] = o.calleeName || ''; r[14] = o.parentCall || 'N/A';
    r[22] = o.callerId || ''; r[25] = o.answered ? 'Answered' : '';
    return r;
  }
  function day(tag, mdY, withQueue) {
    const rows = [new Array(44).fill('hdr')];
    rows.push(leg({ callId: 'P' + tag, start: mdY + ' 7:00:00', talk: '0:03:00', calleeName: 'Anna' }));
    if (withQueue) {
      rows.push(leg({ callId: 'Q' + tag, start: mdY + ' 7:00:00', caller: 'CallQueue(103)', calleeName: 'Anna',
        parentCall: 'P' + tag, callerId: 'A_Q_CSR', answered: true }));
    }
    return rows;
  }
  // Three days; the MIDDLE one has no recognizable queue leg, so its forced
  // DQE rebuild yields zero rows and refuses (refuseIfForce_).
  const source = makeFakeSpreadsheet({ sheets: {
    'Call_Legs_2026-07-07': day('0707', '07/07/2026', true),
    'Call_Legs_2026-07-08': day('0708', '07/08/2026', false),
    'Call_Legs_2026-07-09': day('0709', '07/09/2026', true),
  } });
  source.toast = function () {};
  function oldRow(d) { const r = new Array(37).fill(''); r[0] = 'July 2026'; r[1] = d; r[2] = 'Anna'; r[4] = 9; r[5] = 9; r[7] = 9; return r; }
  const target = makeFakeSpreadsheet({ sheets: {
    'Raw Data': [new Array(44).fill('')],
    'CDR Output': [['']],
    'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    'DQE Historical Data': [new Array(37).fill('h'), oldRow('7/7/2026'), oldRow('7/8/2026'), oldRow('7/9/2026')],
    'CDR Historical Data': [['h']], 'Q Path Historical Data': [['h']], 'QCD Historical Data': [['h']],
    'CSR Transfer Historical Data': [['h']], 'Direct Call History': [['h']],
    'Pending Archive': [new Array(34).fill('h')],
    'Pipeline Health': [PH_HEADER],
  } });
  withClearContents(target, 44);
  h.state.spreadsheet = source;
  h.state.spreadsheetsById = h.state.spreadsheetsById || {};
  h.state.spreadsheetsById.TGT = target;
  h.state.props = { TARGET_SS_ID: 'TGT', bulkQueue: JSON.stringify(['2026-07-07', '2026-07-08', '2026-07-09']),
    bulkIndex: '0', bulkReport: '[]' };
  // Only the engines that need hand-maintained operator sheets are stubbed.
  h.ctx.calculateMetricsInMemory = function () { return { Agents: { Names: [] }, DeptPaths: [], SalesStats: { total: 0 }, NameToDept: {} }; };
  h.ctx.calcQcdReport = function () { return null; };
  h.ctx.calcCsrReport = function () { return null; };
  h.ctx.appendToAuditLog = function () {};
  const alerts = [];
  h.ctx.SpreadsheetApp.getUi = function () { return fakeUi(alerts); };
  return { h: h, target: target, alerts: alerts };
}

test('RB-1: a bulk date whose DQE rebuild failed is reported ❌ and stays flagged; the others stay ✅', function () {
  const b = bulkHarness();
  b.h.ctx.processBatchArchive = function () { return { cdrCount: 0, qpathCount: 0, qcdCount: 0, csrCount: 0 }; };
  b.h.call('processBulkQueue');

  const fin = b.alerts[b.alerts.length - 1];
  assert.match(fin[0], /Bulk finished — 1 date\(s\) FAILED or were not fully rebuilt/, 'the closing alert is not a plain "Bulk Complete"');
  const lines = fin[1].split('\n');
  assert.ok(lines.some(function (l) { return /^✅ 2026-07-07: Success/.test(l); }));
  assert.ok(lines.some(function (l) { return /^✅ 2026-07-09: Success/.test(l); }));
  const bad = lines.filter(function (l) { return /2026-07-08/.test(l); });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^❌ 2026-07-08: NOT fully rebuilt — DQE Historical Data was NOT rebuilt \(its existing rows for this date were deleted first\)/);
  assert.ok(!/✅ 2026-07-08/.test(fin[1]), 'never a success line for the failed date');

  // The failure-only row: the next date's bulkBackfill:DQE success cannot supersede it.
  const ph = phRows(b.target);
  const guard = ph.filter(function (r) { return r.step === 'bulkBackfill:DQE-guard'; });
  assert.equal(guard.length, 1);
  assert.equal(guard[0].status, 'failure');
  assert.match(guard[0].notes, /Jul 08 2026 \| the bulk rebuild did NOT produce this date AFTER its existing rows were deleted/);
  const last = {};
  ph.forEach(function (r) { last[r.step] = r.status; });
  assert.equal(last['bulkBackfill:DQE'], 'success', 'the per-date step IS superseded -- which is why the guard row exists');
  assert.equal(last['bulkBackfill:DQE-guard'], 'failure');

  // RB-7: the completion note counts what happened, not the queue length.
  const done = ph.filter(function (r) { return r.step === 'bulkBackfill:paused' && r.status === 'success'; });
  assert.equal(done.length, 1);
  assert.equal(done[0].rows, 2);
  assert.match(done[0].notes, /3 date\(s\) processed -- 2 rebuilt, 1 FAILED or not fully rebuilt/);
  assert.equal(b.h.state.props.bulkQueue, undefined, 'a completed run closes its queue');
});

test('RB-1: the bulk branch returns PARTIAL for a failed Direct rebuild too, and the guard steps are failure-only on Health', function () {
  // The branch is mid-processNewImport, so the Direct half is pinned by source.
  assert.match(SRC, /bulkFailures\.push\('Direct Call History was NOT rebuilt: ' \+ dmsg\);/);
  assert.match(SRC, /bulkDateFailureRow_\(targetSS, 'bulkBackfill:Direct-guard', dateObj, false, dmsg\);/);
  assert.match(SRC, /bulkDateFailureRow_\(targetSS, 'bulkBackfill:Direct-guard', dateObj, true, zmsg\);/, 'a rebuild-to-zero counts');
  assert.match(SRC, /if \(bulkFailures\.length\) return `PARTIAL: \$\{durationSeconds\}s \| ` \+ bulkFailures\.join\(' \| '\);/);
  const health = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'SystemHealth.gs'), 'utf8');
  const list = health.slice(health.indexOf('var HEALTH_FAILURE_ONLY_STEPS_ = ['), health.indexOf('function healthFailureOnlyStep_'));
  assert.match(list, /'bulkBackfill:DQE-guard'/);
  assert.match(list, /'bulkBackfill:Direct-guard'/);
});

test('RB-7: the tally and the completion note are honest about failed and missing dates', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const J = function (v) { return JSON.parse(JSON.stringify(v)); };
  const report = ['✅ 2026-07-07: Success (1.0s)', '❌ 2026-07-08: NOT fully rebuilt — x', '⚪ 2026-07-09: Skipped (No Sheet)',
    '❌ 2026-07-10: Failed (boom)', '⚠️ 2026-07-11: ALREADY PROCESSED', '---', '✅ Batch archive complete (CDR: +1)',
    'ℹ️ DQE Neon mirror was deferred'];
  assert.deepEqual(J(h.call('bulkReportTally_', report)), { ok: 1, failed: 2, missing: 1, other: 1, trimmed: false });
  assert.equal(J(h.call('bulkReportTally_', ['… (5 earlier lines trimmed -- see Pipeline Health for per-date rows)'].concat(report))).trimmed, true);
  const note = h.call('bulkCompleteNote_', 5, { ok: 1, failed: 2, missing: 1, other: 1, trimmed: false });
  assert.match(note, /^bulk run complete: 5 date\(s\) processed -- 1 rebuilt, 2 FAILED or not fully rebuilt/);
  assert.match(note, /1 with no Call_Legs tab/);
  assert.equal(h.call('bulkCompleteNote_', 3, { ok: 3, failed: 0, missing: 0, other: 0 }),
    'bulk run complete: 3 date(s) processed -- 3 rebuilt; the queued rows are archived to the historical sheets.');
});

test('RB-7: a failed final archive keeps the bulk run open, so Pending Archive cannot be cleared by hand', function () {
  const b = bulkHarness();
  b.h.ctx.processBatchArchive = function () { throw new Error('QCD append exploded'); };
  b.h.call('processBulkQueue');
  const fin = b.alerts[b.alerts.length - 1];
  assert.match(fin[0], /Archive failed/);
  assert.match(fin[1], /Resume Bulk\s+Processing' to retry the archive/);
  assert.ok(!b.alerts.some(function (a) { return /Bulk Complete|Bulk finished/.test(a[0]); }), 'not reported as complete');
  assert.equal(b.h.state.props.bulkIndex, '3', 'index parked past the last date: Resume goes straight to the archive');
  assert.ok(b.h.state.props.bulkQueue, 'queue kept');
  const gap = phRows(b.target).filter(function (r) { return r.step === 'bulkBackfill:paused'; });
  assert.equal(gap[gap.length - 1].status, 'failure');

  // clearPendingArchive's P-13 refusal therefore still applies.
  const before = b.alerts.length;
  b.h.call('clearPendingArchive');
  assert.match(b.alerts[before][0], /Bulk run in progress/);

  // Resume retries only the archive; a clean one closes the run.
  b.h.ctx.processBatchArchive = function () { return { cdrCount: 0, qpathCount: 0, qcdCount: 0, csrCount: 0 }; };
  b.h.call('processBulkQueue');
  assert.equal(b.h.state.props.bulkIndex, undefined);
  assert.equal(b.h.state.props.bulkQueue, undefined);
});

// ── RB-5 + RB-7: the batch archive ─────────────────────────────────────────────

function archiveHarness(historyHasDate) {
  const h = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'NeonMirror.js', 'autoImport.js'] });
  const alerts = [];
  h.ctx.SpreadsheetApp.getUi = function () { return fakeUi(alerts); };
  function pend(type) {
    const r = new Array(34).fill('');
    r[0] = '2026-07-08'; r[1] = type; r[2] = type === 'QCD' ? 'A_Q_CSR' : 'Anna'; r[3] = 'July, 26'; r[4] = 'Week 2';
    r[5] = type === 'QCD' ? 'Total Calls' : 'CSR'; r[6] = 10; r[7] = 9; r[8] = 1;
    return r;
  }
  const cdrOld = new Array(26).fill(''); cdrOld[2] = '7/8/2026'; cdrOld[3] = 'CSR'; cdrOld[4] = 'Anna'; cdrOld[5] = 7;
  const qcdOld = new Array(12).fill(''); qcdOld[2] = '7/8/2026'; qcdOld[3] = 'A_Q_CSR'; qcdOld[4] = 'Total Calls'; qcdOld[5] = 10;
  const ss = makeFakeSpreadsheet({ sheets: {
    'Pending Archive': [new Array(34).fill('h'), pend('CDR'), pend('QCD')],
    'CDR Historical Data': historyHasDate ? [new Array(26).fill('h'), cdrOld] : [new Array(26).fill('h')],
    'Q Path Historical Data': [new Array(11).fill('h')],
    'QCD Historical Data': historyHasDate ? [new Array(12).fill('h'), qcdOld] : [new Array(12).fill('h')],
    'CSR Transfer Historical Data': [new Array(18).fill('h')],
    'Pipeline Health': [PH_HEADER],
  } });
  h.state.spreadsheet = ss;
  h.state.spreadsheetsById = h.state.spreadsheetsById || {};
  h.state.spreadsheetsById.TGT = ss;
  h.state.props = { TARGET_SS_ID: 'TGT', NEON_HOST: 'x' };
  const calls = [];
  h.ctx.writeCDRRowsToNeon = function (rows, o) {
    calls.push({ type: 'CDR', n: rows.length, authoritative: !!(o && o.authoritative), date: rows[0].callDate, agent: rows[0].agentName, ob: rows[0].obTotal });
    return {};
  };
  h.ctx.writeQCDRowsToNeon = function (rows, o) {
    calls.push({ type: 'QCD', n: rows.length, authoritative: !!(o && o.authoritative), queue: rows[0].callQueue, total: rows[0].totalCalls });
    return {};
  };
  h.ctx.notifyNeonWriteFailure = function () {};
  h.ctx.appendToAuditLog = function () {};
  return { h: h, ss: ss, calls: calls, alerts: alerts };
}

test('RB-5: a resumed archive (dates already in history) still mirrors CDR + QCD, from the SHEET rows', function () {
  const a = archiveHarness(true);
  const res = JSON.parse(JSON.stringify(a.h.call('processBatchArchive', true, true)));
  assert.deepEqual(res, { cdrCount: 0, qpathCount: 0, qcdCount: 0, csrCount: 0 }, 'the dedup still appends nothing twice');
  assert.equal(a.calls.length, 2, 'both mirrors ran -- they used to be skipped with no gap row');
  const cdr = a.calls.filter(function (c) { return c.type === 'CDR'; })[0];
  const qcd = a.calls.filter(function (c) { return c.type === 'QCD'; })[0];
  assert.equal(cdr.authoritative, true);
  assert.equal(String(cdr.ob), '7', 'the HISTORY row (7), not the queued row (10): the sheet is the truth on a resume');
  assert.equal(cdr.agent, 'Anna');
  assert.equal(qcd.authoritative, true);
  assert.equal(qcd.queue, 'A_Q_CSR');
  assert.equal(phRows(a.ss).filter(function (r) { return /:neon$/.test(r.step); }).length, 0, 'a clean resume logs no gap');
});

test('RB-5: a normal first archive mirrors once (inline) and the resume helper stays out of it', function () {
  const a = archiveHarness(false);
  const res = JSON.parse(JSON.stringify(a.h.call('processBatchArchive', true, true)));
  assert.equal(res.cdrCount, 1);
  assert.equal(res.qcdCount, 1);
  assert.deepEqual(a.calls.map(function (c) { return c.type; }), ['CDR', 'QCD'], 'exactly one mirror per type');
  assert.equal(String(a.calls[0].ob), '10', 'the freshly appended rows');
});

test('RB-5: an unreachable Neon on the resumed dates logs the failure-only gap row, once per type', function () {
  const a = archiveHarness(true);
  a.h.ctx.writeCDRRowsToNeon = function (rows) { return { skipped: rows.length }; };
  a.h.ctx.writeQCDRowsToNeon = function () { throw new Error('boom'); };
  a.h.call('processBatchArchive', true, true);
  const gaps = phRows(a.ss).filter(function (r) { return /:neon$/.test(r.step); });
  assert.deepEqual(gaps.map(function (r) { return r.step + '|' + r.status; }).sort(),
    ['processBatchArchive:CDR:neon|failure', 'processBatchArchive:QCD:neon|failure']);
  assert.match(gaps.filter(function (r) { return /CDR/.test(r.step); })[0].notes, /2026-07-08 \(1 date\(s\)\).*Neon unreachable \(dates a resumed archive found already in history\)/);
  assert.match(gaps.filter(function (r) { return /QCD/.test(r.step); })[0].notes, /mirror error: boom/);
  assert.equal(a.ss._sheet('Pending Archive')._data.slice(1).filter(function (r) { return r[0] !== ''; }).length, 0,
    'a mirror gap never blocks the archive itself');
});

test('RB-5: bulkArchiveResumedDates_ is the dates the dedup dropped, keyed the dedup\'s way', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const d = function (day) { return new Date(2026, 6, day, 12); };
  const batch = [[0, 0, d(8)], [0, 0, d(8)], [0, 0, d(9)], [0, 0, d(10)]];
  const kept = [[0, 0, d(9)]];
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('bulkArchiveResumedDates_', batch, kept, 'America/Mexico_City'))),
    ['2026-07-08', '2026-07-10']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('bulkArchiveResumedDates_', batch, batch, 'America/Mexico_City'))), []);
});

test('RB-7: the standalone "Process Batch Archive" clears the Health row and closes a run that only had the archive left', function () {
  const a = archiveHarness(false);
  a.h.state.props.bulkQueue = JSON.stringify(['2026-07-08']);
  a.h.state.props.bulkIndex = '1';
  a.h.state.props.bulkReport = '[]';
  a.h.call('processBatchArchive', true, false);
  const cleared = phRows(a.ss).filter(function (r) { return r.step === 'bulkBackfill:paused'; });
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].status, 'success');
  assert.equal(a.h.state.props.bulkIndex, undefined, 'every date was processed: the run is over');
  assert.equal(a.h.state.props.bulkQueue, undefined);

  // A run still mid-queue keeps its state (its remaining dates are not processed yet).
  const m = archiveHarness(false);
  m.h.state.props.bulkQueue = JSON.stringify(['2026-07-08', '2026-07-09']);
  m.h.state.props.bulkIndex = '1';
  m.h.call('processBatchArchive', true, false);
  assert.equal(m.h.state.props.bulkIndex, '1');
  // Called BY the bulk queue it logs nothing of its own (the queue logs the completion).
  const q = archiveHarness(false);
  q.h.call('processBatchArchive', true, true);
  assert.equal(phRows(q.ss).filter(function (r) { return r.step === 'bulkBackfill:paused'; }).length, 0);
});

// ── RB-2: the editor-run Direct build ──────────────────────────────────────────

function directHarness() {
  const h = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'autoImport.js', 'directCallMetrics.js'] });
  const MAPS = { extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
    queueExtSet: new Set(['103']), exclusions: new Set(['103']) };
  function row(o) {
    const r = new Array(40).fill('');
    r[0] = o.cid; r[2] = o.start || ''; r[5] = o.dir; r[6] = o.talk || ''; r[7] = o.callTime || '';
    r[8] = o.caller || ''; r[9] = (MAPS.extToAgent[o.caller] || {}).name || '';
    r[10] = o.callee || ''; r[11] = (MAPS.extToAgent[o.callee] || {}).name || '';
    r[14] = 'N/A'; r[25] = o.answered ? 'Answered' : '';
    return r;
  }
  const HDR = ['Month Year', 'Date', 'Department', 'Agent', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'];
  // D-1 (11/04) already holds its correct rows.
  const hist = [HDR,
    ['November 2026', '11/4/2026', 'CSR', 'Anna', 0, 0, 0, 0, 25, 1, 0, 3000, 0, 0, 0, 4, 4, 300],
    ['November 2026', '11/4/2026', 'CSR', 'Bob', 0, 0, 0, 0, 12, 0, 0, 900, 0, 0, 0, 2, 2, 100]];
  // Raw Data is day D (11/05); its FIRST row is one carry-over leg from D-1.
  const raw = [new Array(40).fill('')];
  raw.push(row({ cid: 'CARRY', start: '11/04/2026 14:59:50', dir: 'Incoming', talk: '0:00:40', callTime: '0:00:45',
    caller: '15551110000', callee: '101', answered: true }));
  for (let i = 0; i < 30; i++) {
    raw.push(row({ cid: 'D' + i, start: '11/05/2026 10:' + String(i).padStart(2, '0') + ':00', dir: 'Incoming',
      talk: '0:00:30', callTime: '0:00:35', caller: '1555222' + String(1000 + i), callee: i % 2 ? '101' : '102', answered: true }));
  }
  const ss = makeFakeSpreadsheet({ sheets: { 'Direct Call History': hist, 'Raw Data': raw, 'DO NOT EDIT!': [['x']],
    'Pipeline Health': [PH_HEADER] } });
  h.state.spreadsheet = ss;
  h.state.spreadsheetsById = h.state.spreadsheetsById || {};
  h.state.spreadsheetsById.TGT = ss;
  h.state.props = { TARGET_SS_ID: 'TGT' };
  h.ctx.dcBuildExtMaps_ = function () { return MAPS; };
  const neon = [];
  h.ctx.writeDirectCallRowsToNeon_ = function (rows, my, iso) { neon.push({ iso: iso, rows: rows.length }); return { inserted: rows.length }; };
  return { h: h, ss: ss, raw: raw, neon: neon };
}

test('RB-2: runDirectCallBuild builds the day MOST rows are on -- a D-1 carry-over first row no longer overwrites D-1', function () {
  const d = directHarness();
  const out = JSON.parse(JSON.stringify(d.h.call('runDirectCallBuild')));
  assert.match(out.date, /^11\/05\/2026/, 'day D, not the first row\'s day');
  assert.equal(out.rows, 2);
  assert.deepEqual(d.neon, [{ iso: '2026-11-05', rows: 2 }], 'Neon replaces day D only');
  const sheet = d.ss._sheet('Direct Call History')._data.slice(1);
  const d1 = sheet.filter(function (r) { return String(r[1]) === '11/4/2026'; });
  assert.deepEqual(d1.map(function (r) { return [r[3], r[8]]; }), [['Anna', 25], ['Bob', 12]], 'D-1\'s rows are untouched');
  assert.equal(sheet.length, 4, 'D-1 kept + day D written');
  const row = phRows(d.ss).filter(function (r) { return /directBuild/.test(r.notes); })[0];
  assert.equal(row.status, 'success');
  assert.match(row.notes, /strayLegs=1/, 'the carry-over leg is counted, not built');
});

test('RB-2: dcGridMajorityDay_ -- the majority day, a tie to the later day, null with no dated row', function () {
  const d = directHarness();
  const J = function (v) { return JSON.parse(JSON.stringify(v)); };
  const m = d.h.call('dcGridMajorityDay_', d.raw);
  assert.equal(m.iso, '2026-11-05');
  assert.equal(m.strays, 1);
  assert.deepEqual(J(m.strayByDay), { '2026-11-04': 1 });
  assert.equal(m.date.getFullYear() + '-' + (m.date.getMonth() + 1) + '-' + m.date.getDate(), '2026-11-5');
  assert.equal(d.h.call('dcGridMajorityDay_', [['h'], ['a', 'b', '']]), null);
  // The read-only diagnostic uses the same day rule (it used the first row too).
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'directCallMetrics.js'), 'utf8');
  const diag = src.slice(src.indexOf('function diagnoseDirectCallCounting()'));
  assert.match(diag.slice(0, 1600), /const majority = dcGridMajorityDay_\(raw\);\s*\n\s*const isoDate = majority \? majority\.iso : toIso\(dateStr\);/);
});

test('RB-2: a grid with no dated row builds nothing and deletes nothing', function () {
  const d = directHarness();
  const rd = d.ss._sheet('Raw Data');
  rd._data.length = 0;
  rd._data.push(new Array(40).fill(''), new Array(40).fill(''));
  const out = JSON.parse(JSON.stringify(d.h.call('runDirectCallBuild')));
  assert.deepEqual(out, { rows: 0 });
  assert.equal(d.neon.length, 0);
  assert.equal(d.ss._sheet('Direct Call History')._data.length, 3);
});

// ── RB-3: Make a date whole ────────────────────────────────────────────────────

test('RB-3: "Make a date whole" writes through the DAILY path -- nothing is queued to Pending Archive', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const ISO = '2026-09-23';
  const sheets = {
    'Raw Data': [['h']], 'CDR Output': [['h']], 'DO NOT EDIT!': [['h']],
    'CDR Historical Data': [['A', 'B', 'Date'], ['m', 'x', '09/23/2026']],
    'DQE Historical Data': [['A', 'Date'], ['m', '09/23/2026']],
    'Direct Call History': [['A', 'Date'], ['m', '09/23/2026']],
    'Q Path Historical Data': [['A', 'B', 'Date']],
    'QCD Historical Data': [['A', 'B', 'Date']],
    'CSR Transfer Historical Data': [['A', 'B', 'Date']],
  };
  sheets['Call_Legs_' + ISO] = legsTab('09/23/2026 10:00:00');
  sheets['Raw Data'] = [new Array(44).fill('')];
  h.state.props = {};
  h.state.spreadsheet = withClearContents(makeFakeSpreadsheet({ sheets: sheets }), 44);
  h.state.spreadsheet.toast = function () {};
  const calls = [];
  let skipFlags = null;
  const stubs = {
    calculateMetricsInMemory: function () { return {}; }, calcQcdReport: function () { return {}; }, calcCsrReport: function () { return {}; },
    queueToPendingArchive: function () { calls.push('queue'); return { byType: {} }; },
    processIntegratedHistory: function (ss, out, results, dateObj, skipCDR, skipQPath, skipQCD, skipCSR, skipDQE, raw, force) {
      calls.push('daily');
      skipFlags = { cdr: skipCDR, qpath: skipQPath, qcd: skipQCD, csr: skipCSR, dqe: skipDQE, force: force };
      const r = []; r.counts = { cdr: 0, qpath: 1, qcd: 48, csr: 3, dqe: 0, neon: 'ok' }; return r;
    },
    updateOutputSheet: function () {}, updateQcdrOutputSheet: function () {},
    pendingImportPerCallCatchUp_: function () { return true; }, pendingImportDerivedCatchUp_: function () { return true; },
    logPipelineHealthWithFallback_: function () {},
  };
  Object.keys(stubs).forEach(function (k) { h.ctx[k] = stubs[k]; });
  const out = h.call('makeDateWhole_', ISO, h.state.spreadsheet);
  assert.deepEqual(calls, ['daily'], 'the daily write path, never the bulk queue');
  assert.deepEqual(JSON.parse(JSON.stringify(skipFlags)), { cdr: true, qpath: false, qcd: false, csr: false, dqe: true, force: false },
    'non-force: only the sheets that lack the date are written');
  assert.match(out.report, /imported the missing sheets \(Q Path Historical Data, QCD Historical Data, CSR Transfer Historical Data\): DONE: /);

  // A failed import comes back as "ERROR: ..." (no throw, no second dialog) and the date is not whole.
  const alerts = [];
  h.ctx.SpreadsheetApp.getUi = function () { return fakeUi(alerts); };
  h.ctx.notifyImportFailure_ = function () {};
  h.ctx.processIntegratedHistory = function () { throw new Error('quota'); };
  const bad = h.call('makeDateWhole_', ISO, h.state.spreadsheet);
  assert.equal(bad.whole, false);
  assert.match(bad.report, /imported the missing sheets \([^)]*\): ERROR: quota/);
  assert.equal(alerts.length, 0, 'noAlert: the report carries the failure, no stacked "Process Failed" dialog');
});

// ── RB-4: the QCD force-loss guard ────────────────────────────────────────────

test('RB-4: the QCD guard fires on a rebuild that wrote 48 rows carrying no call', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  // The real engine on an empty day: 48 rows, none with a call.
  const labels = [];
  for (let r = 2; r <= 49; r++) labels.push(['Q' + r, 'Total Calls']);
  const tgt = { getSheetByName: function (n) { return n === 'QCDR Output' ? { getRange: function () { return { getValues: function () { return labels; } }; } } : null; },
    getRangeByName: function (n) { return n === 'csr_team' ? { getValues: function () { return [['Anna, 201']]; } } : null; } };
  const qcd = h.call('calcQcdReport', [new Array(44).fill('hdr'), new Array(44).fill('')], tgt);
  const hist = qcd.output.map(function (r) { return ['m', 'w', 'd', 'q', 's', r[0], r[1], r[2], r[3], r[4]]; });
  assert.equal(hist.length, 48, 'the engine always emits every row -- why the row count could never be zero');
  assert.equal(h.call('qcdRowsWithCalls_', hist, 5), 0);
  assert.equal(h.call('qcdRowsWithCalls_', [[0, 0, 0, 0, 0, 3, 2, 1], [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, '', '', '1']], 5), 2);

  const appended = [];
  const fakeSS = { getSheetByName: function (n) { return n === 'Pipeline Health' ? { appendRow: function (r) { appended.push(r); } } : null; } };
  const g = h.fn('guardForceRebuildLoss_');
  g(fakeSS, 'processIntegratedHistory:QCD', new Date(2026, 6, 14), true, h.call('qcdRowsWithCalls_', hist, 5), hist.length);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][2], 'failure');
  assert.match(String(appended[0][5]), /FORCE rebuild wrote 48 row\(s\) but NONE carries a call, AFTER the date was cleared/);
  appended.length = 0;
  g(fakeSS, 'processIntegratedHistory:QCD', new Date(2026, 6, 14), true, 12, 48);   // a real day
  g(fakeSS, 'processIntegratedHistory:QCD', new Date(2026, 6, 14), false, 0, 48);   // not a force rebuild
  assert.equal(appended.length, 0);

  // Wiring: both QCD call sites pass the call-row count, not the row count.
  assert.match(SRC, /guardForceRebuildLoss_\(targetSS, 'processIntegratedHistory:QCD', dateObj, force && fdel\.qcd,\s*\n\s*qcdRowsWithCalls_\(qcdBatch, 5\), qcdBatch\.length\);/);
  assert.match(SRC, /force && forceDeleted\.qcd, \(queued && queued\.callRows\) \? \(queued\.callRows\.QCD \|\| 0\) : queuedQcd, queuedQcd\);/);
  assert.ok(!/'processIntegratedHistory:QCD', dateObj, force && fdel\.qcd, qcdBatch\.length\)/.test(SRC), 'the old row-count form is gone');
});

test('RB-4: queueToPendingArchive reports how many queued QCD rows carry a call', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const ss = makeFakeSpreadsheet({ sheets: { 'Pending Archive': [new Array(34).fill('h')], 'CSR Transfer Historical Data': [new Array(18).fill('h')] } });
  const results = { qcdData: { output: [[5, 4, 1, '0:01:00', '0:00:10'], [0, 0, 0, '0:00:00', '0:00:00'], ['', '', '', '', '']],
    labels: [['A_Q_CSR', 'Total Calls'], ['A_Q_Sales', 'Total Calls'], ['x', 'y']] } };
  const out = JSON.parse(JSON.stringify(h.call('queueToPendingArchive', ss, results, new Date(2026, 6, 8, 12), true, true, false, true)));
  assert.equal(out.byType.QCD, 2, 'two rows queued (the all-blank one is skipped)');
  assert.equal(out.callRows.QCD, 1, 'one of them carries a call');
});

// ── RB-6: the CSR header refusal ───────────────────────────────────────────────

test('RB-6: a reordered CSR header keeps the date\'s existing rows -- the check runs before the force-delete', function () {
  function run(headerProblem) {
    const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
    const ISO = '2026-09-23';
    const sheets = {
      'Raw Data': [['h']], 'CDR Output': [['h']], 'DO NOT EDIT!': [['h']],
      'CDR Historical Data': [['A', 'B', 'Date'], ['m', 'x', '09/23/2026']],
      'Q Path Historical Data': [['A', 'B', 'Date'], ['m', 'x', '09/23/2026']],
      'QCD Historical Data': [['A', 'B', 'Date'], ['m', 'x', '09/23/2026']],
      'CSR Transfer Historical Data': [['A', 'B', 'Date'], ['m', 'x', '09/23/2026']],
      'DQE Historical Data': [['A', 'Date'], ['m', '09/23/2026']],
      'Direct Call History': [['A', 'Date'], ['m', '09/23/2026']],
    };
    sheets['Call_Legs_' + ISO] = legsTab('09/23/2026 10:00:00');
    sheets['Raw Data'] = [new Array(44).fill('')];
    h.state.props = {};
    const ss = withClearContents(makeFakeSpreadsheet({ sheets: sheets }), 44);
    ss.toast = function () {};
    h.state.spreadsheet = ss;
    const deleted = [], logged = [];
    let seen = null;
    const order = [];
    h.ctx.calculateMetricsInMemory = function () { return {}; };
    h.ctx.calcQcdReport = function () { return {}; };
    h.ctx.calcCsrReport = function () { return { headers: ['Q1', 'Q2'] }; };
    h.ctx.updateOutputSheet = function () {};
    h.ctx.updateQcdrOutputSheet = function () {};
    h.ctx.csrHistoryHeaderProblem_ = function () { order.push('check'); return headerProblem; };
    h.ctx.deleteHistoricalRowsForDate = function (sheet) { order.push('delete'); deleted.push(sheet.getName()); return 1; };
    h.ctx.logPipelineHealthWithFallback_ = function (s, ev) { logged.push(JSON.parse(JSON.stringify(ev))); };
    h.ctx.processIntegratedHistory = function (tss, out, results, dateObj, skipCDR, skipQPath, skipQCD, skipCSR, skipDQE, raw, force, fdel) {
      seen = { skipCSR: skipCSR, skipQCD: skipQCD, fdelCsr: fdel.csr, fdelQcd: fdel.qcd };
      const r = []; r.counts = { cdr: 0, qpath: 0, qcd: 0, csr: 0, dqe: 0, neon: 'ok' }; return r;
    };
    const outcome = h.call('processNewImport', true, ISO, false, ss, null, { noAlert: true });
    return { outcome: outcome, deleted: deleted, logged: logged, seen: seen, order: order };
  }

  const bad = run('CSR Transfer per-queue columns are out of order -- Q2 before Q1. Not written: re-align the two headers, then re-import the date.');
  assert.match(bad.outcome, /^DONE/);
  assert.ok(bad.deleted.indexOf('CSR Transfer Historical Data') === -1, 'the CSR rows are NOT deleted');
  assert.ok(bad.deleted.indexOf('QCD Historical Data') !== -1, 'the other sheets rebuild as before');
  assert.equal(bad.order[0], 'check', 'validated before any delete');
  assert.deepEqual(bad.seen, { skipCSR: true, skipQCD: false, fdelCsr: false, fdelQcd: true },
    'the write step skips CSR as it does for a present date, and the loss guard is not armed for it');
  const row = bad.logged.filter(function (e) { return e.step === 'processIntegratedHistory:CSR'; });
  assert.equal(row.length, 1);
  assert.equal(row[0].status, 'failure');
  assert.match(row[0].notes, /out of order.*EXISTING CSR Transfer rows were kept \(nothing was deleted\)/);

  const ok = run('');
  assert.ok(ok.deleted.indexOf('CSR Transfer Historical Data') !== -1, 'a clean header force-rebuilds CSR as before');
  assert.deepEqual(ok.seen, { skipCSR: false, skipQCD: false, fdelCsr: true, fdelQcd: true });
  assert.equal(ok.logged.filter(function (e) { return e.step === 'processIntegratedHistory:CSR'; }).length, 0);
});
