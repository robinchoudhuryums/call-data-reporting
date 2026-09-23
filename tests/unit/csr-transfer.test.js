'use strict';

// Pins the CSR-transfer dedup KEY (the fix for the fan-out over-count, where a
// single transfer to a queue that rings N agents was counted N times). The
// per-agent count now dedups by ROOT call id = parent-call id (col O / idx 14)
// when present, else call id (col A / idx 0). calcCsrReport itself is
// sheet-coupled (reads QCDR Output + the csr_team named range), so it's
// validated by the 06/22 re-run + repairCsrTransferForRawDataDate; this test
// pins the key logic that determines whether fan-out legs collapse.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
const rootId = h.fn('csrRootCallId_');
const guard = h.fn('csrTransferGuardFindings_');

// Raw Data row: idx 0 = CALL_ID, idx 14 = PARENT_CALL.
function row(callId, parent) {
  const r = new Array(26).fill('');
  r[0] = callId; r[14] = parent;
  return r;
}

test('root id uses the parent-call id when present', function () {
  assert.equal(rootId(row('LEG1', 'CALL99')), 'CALL99');
  assert.equal(rootId(row('LEG2', 'CALL99')), 'CALL99');   // sibling leg -> same root
});

test('root id falls back to the call id when parent is N/A or blank', function () {
  assert.equal(rootId(row('CALL5', 'N/A')), 'CALL5');
  assert.equal(rootId(row('CALL6', '')), 'CALL6');
  assert.equal(rootId(row('CALL7', 'n/a')), 'CALL7');   // case-insensitive N/A
});

test('fan-out legs of one transfer collapse to a single root id', function () {
  // One call CALL99 that rang 3 queue agents -> 3 legs, all share the parent.
  const legs = [row('L1', 'CALL99'), row('L2', 'CALL99'), row('L3', 'CALL99')];
  const distinct = new Set(legs.map(rootId));
  assert.equal(distinct.size, 1, 'three fan-out legs => one counted transfer');
});

test('genuinely separate transfers keep distinct root ids', function () {
  const calls = [row('A1', 'N/A'), row('B1', 'N/A'), row('C1', 'CALLX')];
  assert.equal(new Set(calls.map(rootId)).size, 3);
});

// csrTransferGuardFindings_ is the standing tripwire (C): it flags a likely
// fan-out RE-inflation at write time (Transferred >> Total Calls), without
// failing the import. Batch row: [month, week, date, agent, transPct,
// totalCalls, transferred, ...11 queues] -> agent=3, totalCalls=5, transferred=6.
function csrRow(agent, totalCalls, transferred) {
  const r = new Array(18).fill(0);
  r[3] = agent; r[5] = totalCalls; r[6] = transferred;
  return r;
}

test('guard flags gross fan-out inflation (Transferred >> Total Calls)', function () {
  // 22 transfers vs 4 answered talk-calls -> the exact 06/22 Camila/Field Ops shape.
  const found = guard([csrRow('Camila', 4, 22)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].agent, 'Camila');
  assert.equal(found[0].transferred, 22);
});

test('guard is quiet on a normal day (high but plausible Trans %)', function () {
  // Transferred can legitimately exceed Total Calls (different populations);
  // the guard only trips on GROSS inflation, so 9 vs 5 stays quiet.
  assert.equal(guard([csrRow('Ana', 5, 9)]).length, 0);
  // Below the absolute floor (10) never trips, even at a high ratio.
  assert.equal(guard([csrRow('Bob', 1, 7)]).length, 0);
  // Zero-transfer rows are quiet.
  assert.equal(guard([csrRow('Cy', 12, 0)]).length, 0);
});

test('guard returns every offending row and respects opts', function () {
  const batch = [csrRow('A', 2, 30), csrRow('B', 10, 12), csrRow('C', 1, 40)];
  // Default ratio 3 / floor 10: A (30>3*2) and C (40>3*1) trip; B (12 !> 30) doesn't.
  assert.equal(guard(batch).length, 2);
  // Tighter floor still excludes plausible B, includes the two gross rows.
  // join to a primitive -- the harness returns a vm-realm array whose
  // prototype differs from a host literal, which deepStrictEqual rejects.
  assert.equal(guard(batch, { ratio: 3, floor: 10 }).map(g => g.agent).sort().join(','), 'A,C');
});

// Data-loss guard convention (M2 generalized): a FORCE rebuild that produces 0
// rows AFTER the date was force-deleted must surface a Pipeline Health failure
// (caught by the System Health "Recent pipeline step failures" signal), not
// vanish silently. A non-force empty rebuild is a legitimate no-op.
test('guardForceRebuildLoss_: force + 0 rows logs a FAILURE row; non-force / >0 rows no-op', function () {
  const g = h.fn('guardForceRebuildLoss_');
  const appended = [];
  const fakeSS = {
    getSheetByName: function (n) {
      return n === 'Pipeline Health' ? { appendRow: function (r) { appended.push(r); } } : null;
    },
  };
  const d = new Date(2026, 6, 14);

  g(fakeSS, 'processIntegratedHistory:QCD', d, true, 0);   // force + empty rebuild -> surface
  assert.equal(appended.length, 1, 'force + 0 rows -> one failure row');
  assert.equal(appended[0][1], 'processIntegratedHistory:QCD', 'Step column');
  assert.equal(appended[0][2], 'failure', 'Status column');

  appended.length = 0;
  g(fakeSS, 'processIntegratedHistory:QCD', d, true, 5);    // rebuilt rows -> no-op
  g(fakeSS, 'processIntegratedHistory:QCD', d, false, 0);   // non-force empty -> legitimate no-op
  assert.equal(appended.length, 0, 'no false alarm when rows were written OR it was not a force build');
});

// ── P-8: history date-cell parsing (the F-3/F-10 coercion class) ────────────
test('P-8: parseHistoryDateCell_ parses ISO-shaped TEXT as a local day, not UTC midnight', function () {
  const f = h.fn('parseHistoryDateCell_');
  // ISO text: new Date("2026-05-19") is UTC midnight = the PREVIOUS Chicago
  // day; the helper constructs local noon instead.
  assert.equal(f('2026-05-19').toDateString(), new Date(2026, 4, 19, 12).toDateString());
  // Legacy M/D/YYYY strings keep their local parse.
  assert.equal(f('5/19/2026').toDateString(), new Date(2026, 4, 19).toDateString());
  // Garbage still yields an invalid date (callers already isNaN-guard).
  assert.ok(isNaN(f('garbage').getTime()));
});

// ── P8/P26 (broad-scan 2026-08-27): the BULK force path ─────────────────────
// The guards were daily-path-only (a bulk rebuild-to-zero of dashboard-read
// CSR slipped through silently) and keyed on the force FLAG alone (Manual
// Export always forces -> false alarms on never-imported dates). These pin
// the pieces the fix added: queueToPendingArchive's per-type counts, the
// bulk-branch guard wiring, and the forceDeleted gate.

test('P8: queueToPendingArchive returns per-type queued counts (zero CSR is visible)', function () {
  const rows = { appended: [] };
  const pending = {
    getLastRow: function () { return 1; },
    getRange: function () { return { setValues: function (v) { rows.appended = v; }, getValues: function () { return []; } }; },
    deleteRow: function () {},
  };
  const fakeSS = {
    getSheetByName: function (n) { return n === 'Pending Archive' ? pending : null; },
    getSpreadsheetTimeZone: function () { return 'America/Chicago'; },
  };
  const results = {
    qcdData: { output: [['5', '2', '1', '', ''], ['', '', '', '', '']],
               labels: [['A_Q_X', 'DeptX'], ['A_Q_Y', 'DeptY']] },
    csrData: { agents: [], totalCalls: [], queues: [] },   // rebuild-to-zero
  };
  const out = h.call('queueToPendingArchive', fakeSS, results, new Date(2026, 6, 14),
    true, true, false, false);   // skipCDR, skipQPath, !skipQCD, !skipCSR
  assert.equal(out.byType.QCD, 1, 'one non-empty QCD row queued');
  assert.equal(out.byType.CSR_TRANSFER, 0, 'the zero-row CSR rebuild is countable');
  assert.equal(out.queued, 1);
});

test('P8/P26 wiring: the bulk branch guards QCD+CSR at queue time, gated on forceDeleted', function () {
  // The bulk branch lives mid-processNewImport (not separately callable), so
  // pin the wiring by source (the FO-1 pattern): both guard calls exist, use
  // the bulkBackfill step names, and carry the forceDeleted gate.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'autoImport.js'), 'utf8');
  assert.match(src, /guardForceRebuildLoss_\(targetSS, 'bulkBackfill:QCD', dateObj,\s*\n?\s*force && forceDeleted\.qcd/,
    'bulk QCD guard present + forceDeleted-gated');
  assert.match(src, /guardForceRebuildLoss_\(targetSS, 'bulkBackfill:CSR', dateObj,\s*\n?\s*force && forceDeleted\.csr/,
    'bulk CSR guard present + forceDeleted-gated');
  assert.match(src, /force: !!\(force && forceDeleted\.dqe\)/,
    'bulk DQE build opts.force carries the forceDeleted gate');
  assert.match(src, /force: !!\(force && fdel\.dqe\)/,
    'daily DQE build opts.force carries the forceDeleted gate');
});

test('P26: processIntegratedHistory fires the QCD/CSR guards only when that sheet was actually deleted', function () {
  const appended = [];
  const mkHist = function () {
    return {
      getLastRow: function () { return 1; },
      getRange: function () { return { setValues: function () {} }; },
    };
  };
  const sheets = {
    'QCD Historical Data': mkHist(),
    'CSR Transfer Historical Data': mkHist(),
    'Pipeline Health': { appendRow: function (r) { appended.push(r); } },
  };
  const fakeSS = { getSheetByName: function (n) { return sheets[n] || null; } };
  const results = {
    qcdData: { output: [['', '', '', '', '']], labels: [['A_Q_X', 'DeptX']] },  // zero-row rebuild
    csrData: { agents: [], totalCalls: [], queues: [] },                         // zero-row rebuild
  };
  const run = function (forceDeleted) {
    appended.length = 0;
    // skipCDR/QPath/DQE=true so only the QCD + CSR blocks execute; no
    // outputSheet / rawDataSheet needed on those paths.
    h.call('processIntegratedHistory', fakeSS, null, results, new Date(2026, 6, 14),
      true, true, false, false, true, null, true, forceDeleted);
    return appended.filter(function (r) { return r[2] === 'failure'; })
                   .map(function (r) { return r[1]; });
  };
  assert.deepEqual(JSON.parse(JSON.stringify(run({ qcd: true, csr: true, dqe: false }))),
    ['processIntegratedHistory:QCD', 'processIntegratedHistory:CSR'],
    'force + actually-deleted + zero rebuild -> both guards fire');
  assert.deepEqual(JSON.parse(JSON.stringify(run({ qcd: false, csr: false, dqe: false }))), [],
    'force but nothing was deleted (first-time import) -> no false alarm');
});


test('I-6: processNewImport COMPUTES before the force-delete block (a compute throw can no longer destroy the date)', function () {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'autoImport.js'), 'utf8');
  const iCompute = src.indexOf('const results = calculateMetricsInMemory(cleanData, configSheet);');
  const iQcd = src.indexOf('results.qcdData = calcQcdReport(cleanData, targetSS);');
  const iCsr = src.indexOf('results.csrData = calcCsrReport(cleanData, targetSS);');
  const iForce = src.indexOf('const forceDeleted = { qcd: false, csr: false, dqe: false };');
  const iSource = src.indexOf('if (sourceData.length < 2) throw new Error("Source sheet empty.");');
  assert.ok(iCompute > 0 && iQcd > 0 && iCsr > 0 && iForce > 0 && iSource > 0, 'anchors present');
  assert.ok(iSource < iCompute, 'P-3: source validated first');
  assert.ok(iCompute < iForce && iQcd < iForce && iCsr < iForce,
    'all three compute stages run BEFORE the force-delete (I-6)');
});


// ---- Batch 5 (broad-scan 2026-09-17): P-1 / P-8 / P-12 / P-13 ---------------

test('P-1: the Raw Data rewrite + output-sheet writes run BEFORE the five-sheet force-delete', function () {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'autoImport.js'), 'utf8');
  const iRaw = src.indexOf('rawDataSheet.clearContents();');
  const iOut = src.indexOf('updateOutputSheet(outputSheet, results.Agents, dateObj);');
  const iQcdr = src.indexOf('updateQcdrOutputSheet(targetSS, results.qcdData, results.csrData);');
  const iDelete = src.indexOf('forceDeleted.qcd = !!existsInQCD;');
  const iHist = src.indexOf('historyReport = processIntegratedHistory(targetSS, outputSheet, results, dateObj,');
  assert.ok(iRaw > 0 && iOut > 0 && iQcdr > 0 && iDelete > 0 && iHist > 0, 'anchors present');
  assert.ok(iRaw < iDelete && iOut < iDelete && iQcdr < iDelete,
    'nothing those writes need depends on the delete, so a throw in them can no longer leave the date gone from five sheets');
  assert.ok(iDelete < iHist, 'the historical writes still follow the delete');
});

test('P-8: Raw Data staging coerces only numeric-LOOKING cells; whitespace is empty, never 0', function () {
  const f = h.fn('stageRawDataCell_');
  assert.equal(f('42'), 42);
  assert.equal(f(' 42 '), 42);
  assert.equal(f('-3.5'), -3.5);
  assert.equal(f('1762242202191'), 1762242202191, 'a 13-digit call id is still a number (unchanged)');
  assert.equal(f(''), '');
  assert.equal(f(null), '');
  assert.equal(f(' '), '', 'Number(" ") used to stage as 0 -- a phantom zero');
  assert.equal(f('\t'), '');
  assert.equal(f('0:03:01'), '0:03:01', 'durations stay text');
  assert.equal(f('1e3'), '1e3', 'only plain decimals coerce');
  assert.equal(f('N/A'), 'N/A');
  assert.equal(f(7), 7);
});

test('P-12: the history-date resolvers key the SPREADSHEET-TZ day from display values (one resolver, R46-safe)', function () {
  const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
  // Fake default TZ is America/Mexico_City (UTC-6, no DST); the script is Chicago.
  const sheetMidnightAug20 = new Date(Date.UTC(2026, 7, 20, 6));    // 00:00 Mexico City -> displays 8/20/2026
  const scriptMidnightAug20 = new Date(2026, 7, 20);                // 00:00 Chicago (CDT) = 23:00 Aug 19 Mexico City (the R46 shape)
  const ss = makeFakeSpreadsheet({ sheets: {
    'CDR Historical Data': [['A', 'B', 'Date', 'D'],
      ['a', 'b', sheetMidnightAug20, 'd'], ['a', 'b', '8/20/2026', 'd'], ['a', 'b', '2026-08-21', 'd'],
      ['a', 'b', scriptMidnightAug20, 'd']],
  } });
  const tz = ss.getSpreadsheetTimeZone();
  assert.equal(h.call('historyDateKey_', new Date(2026, 7, 20, 12), tz), '2026-08-20', 'a noon importer date keys its own day in any zone');
  assert.equal(h.call('historyDateKey_', new Date(2026, 7, 21, 0, 30), tz), '2026-08-20',
    'the key is the SHEET-TZ day: 00:30 Chicago is still Aug 20 in Mexico City (a script-TZ key would say Aug 21)');
  assert.equal(h.call('historyCellIso_', '8/20/2026', tz), '2026-08-20');
  assert.equal(h.call('historyCellIso_', '2026-08-21', tz), '2026-08-21');
  assert.equal(h.call('historyCellIso_', '8/20/2026 23:00:00', tz), '2026-08-20', 'a trailing time part is tolerated');
  assert.equal(h.call('historyCellIso_', 'garbage', tz), null);
  assert.equal(h.call('checkHistoryForDate', ss, 'CDR Historical Data', new Date(2026, 7, 20, 12)), true);
  assert.equal(h.call('checkHistoryForDate', ss, 'CDR Historical Data', new Date(2026, 7, 22, 12)), false);
  const set = h.call('buildHistoryDateSet', ss, 'CDR Historical Data');
  assert.ok(set.has('2026-08-20') && set.has('2026-08-21'));
  // The R46 shape: a script-midnight Date DISPLAYS as the previous day in the
  // sheet, and that is the day every reader keys it under -- the delete and
  // the exists-check now agree with them instead of with the script clock.
  assert.ok(set.has('2026-08-19'), 'the TZ-split cell is keyed the way the sheet shows it (Aug 19), not the script way (Aug 20)');
  const removed = h.call('deleteHistoricalRowsForDate', ss.getSheetByName('CDR Historical Data'), new Date(2026, 7, 20, 12), 3);
  assert.equal(removed, 2, 'the sheet-midnight Date cell + the M/D/YYYY text cell; the TZ-split cell is NOT Aug 20');
});

test('P-13: pendingOnlyCopyDates_ names the queued dates whose history rows are already gone', function () {
  const meta = [['2026-08-10', 'CDR'], ['2026-08-10', 'QCD'], ['2026-08-11', 'CDR'], ['2026-08-12', 'CSR_TRANSFER'], ['junk', 'CDR']];
  const hist = { CDR: new Set(['2026-08-11']), QPATH: new Set(), QCD: new Set(['2026-08-10']), CSR_TRANSFER: new Set() };
  const r = h.call('pendingOnlyCopyDates_', meta, hist, 'America/Mexico_City');
  assert.equal(r.dates.join(','), '2026-08-10,2026-08-11,2026-08-12');
  assert.equal(r.onlyCopy.join(','), '2026-08-10,2026-08-12',
    'Aug 10: CDR rows gone (QCD present is not enough); Aug 12: CSR gone; Aug 11: CDR present');
});

test('P-13: clearPendingArchive REFUSES while a bulk run is paused (bulkIndex set)', function () {
  const alerts = [];
  const realUi = h.ctx.SpreadsheetApp.getUi;
  h.ctx.SpreadsheetApp.getUi = function () {
    return { alert: function (t, m) { alerts.push(String(t) + ' | ' + String(m)); return 'NO'; }, ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' }, Button: { YES: 'YES' } };
  };
  try {
    h.state.props.bulkIndex = '3';
    h.call('clearPendingArchive');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Bulk run in progress/);
  } finally {
    delete h.state.props.bulkIndex;
    h.ctx.SpreadsheetApp.getUi = realUi;
  }
});

// ING-7 (broad-scan 2026-09-23; P-7's sibling): repairCsrTransferForRawDataDate
// took the date from the FIRST Raw Data row -- a D-1 carry-over leg -- and so
// overwrote D-1's CSR rows with day D's counts; it also rewrote the WHOLE
// sheet with no lock. Now: majority date, stray legs dropped, the script lock,
// and only the matched rows' recomputed cells are written.
test('ING-7: the CSR repair keys on the MAJORITY date, drops stray legs, and writes only matched rows', function () {
  const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
  const hw = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'autoImport.js'] });
  const raw = [['CALL ID', 'LEG', 'START'],
    ['0', '1', '03/08/2026 23:59:00'],                 // D-1 carry-over, sorts FIRST
    ['1', '1', '03/09/2026 10:00:00'], ['2', '1', '03/09/2026 11:00:00'], ['3', '1', '03/09/2026 12:00:00']];
  const hdr = ['Month', 'Week', 'Date', 'Agent', 'Trans %', 'Total Calls', 'Transferred',
    'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11'];
  function csrRow(date, agent, total) { return ['March 2026', 'W10', date, agent, 0.5, total, 9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]; }
  hw.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Raw Data': raw,
    'CSR Transfer Historical Data': [hdr, csrRow('3/8/2026', 'Anna', 20), csrRow('3/9/2026', 'Anna', 30), csrRow('3/9/2026', 'Ben', 12)],
  } });
  let seenGrid = null;
  hw.ctx.calcCsrReport = function (grid) {
    seenGrid = grid;
    return { agents: [['Anna']], transPct: [[0.1]], totalCalls: [[30]], totalTransferred: [[3]],
             queues: [[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] };
  };
  const locksBefore = hw.state.locks;
  const res = hw.call('repairCsrTransferForRawDataDate');
  assert.equal(res.date, '2026-03-09', 'the majority date, not the D-1 first row');
  assert.equal(res.strayLegsDropped, 1);
  assert.equal(res.updated, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(seenGrid.slice(1).map(function (r) { return r[0]; }))), ['1', '2', '3']);
  assert.ok(hw.state.locks > locksBefore, 'took the script lock');
  const rows = hw.state.spreadsheet.getSheetByName('CSR Transfer Historical Data')._data.slice(1);
  assert.equal(rows[0][6], 9, 'the D-1 row is untouched');
  assert.equal(rows[1][6], 3, "day D's Anna row is recomputed");
  assert.equal(rows[1][4], 0.1);
  assert.equal(rows[1][5], 30, 'Total Calls written back unchanged');
  assert.equal(rows[2][6], 9, 'Ben (missing from the recompute) is untouched');
  hw.state.lockBusy = true;
  try {
    assert.throws(function () { hw.call('repairCsrTransferForRawDataDate'); }, /script lock busy/);
  } finally { hw.state.lockBusy = false; }
});

// ING-2 (broad-scan 2026-09-23): on a force re-import the five history sheets
// are already cleared for the date when processIntegratedHistory runs; the
// inline QCD Neon mirror used to run BEFORE the CSR (and DQE) sheet writes, so
// a hanging connect killed at the ceiling lost those sheets' rows silently.
// The mirror now runs after every sheet write -- and still runs when a later
// sheet write throws.
test('ING-2: the inline QCD Neon mirror runs only AFTER the CSR sheet write (and still runs if it throws)', function () {
  const events = [];
  const mkHist = function (name, throwOnWrite) {
    return {
      getLastRow: function () { return 1; },
      getRange: function () { return { setValues: function () {
        if (throwOnWrite) throw new Error('Service Spreadsheets timed out');
        events.push('sheet:' + name);
      } }; },
    };
  };
  const results = {
    qcdData: { output: [[10, 9, 1, '0:01:00', '0:00:20']], labels: [['A_Q_X', 'DeptX']] },
    csrData: { agents: [['Anna']], totalCalls: [[5]], queues: [[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] },
  };
  const saved = { qcd: h.ctx.writeQCDRowsToNeon, mode: h.ctx.getNeonMirrorMode_ };
  h.ctx.writeQCDRowsToNeon = function () { events.push('neon:QCD'); return { inserted: 1 }; };
  h.ctx.getNeonMirrorMode_ = function () { return 'inline'; };
  const run = function (csrThrows) {
    events.length = 0;
    const sheets = {
      'QCD Historical Data': mkHist('QCD'), 'CSR Transfer Historical Data': mkHist('CSR', csrThrows),
      'Pipeline Health': { appendRow: function () {} },
    };
    const fakeSS = { getSheetByName: function (n) { return sheets[n] || null; } };
    h.call('processIntegratedHistory', fakeSS, null, results, new Date(2026, 6, 14),
      true, true, false, false, true, null, true, { qcd: true, csr: true, dqe: false });
  };
  try {
    run(false);
    assert.deepEqual(events.slice(), ['sheet:QCD', 'sheet:CSR', 'neon:QCD'],
      'every sheet write lands before any Neon mirror');
    assert.throws(function () { run(true); }, /timed out/);
    assert.deepEqual(events.slice(), ['sheet:QCD', 'neon:QCD'],
      'a throwing CSR write still mirrors the QCD rows that were written');
  } finally {
    h.ctx.writeQCDRowsToNeon = saved.qcd;
    h.ctx.getNeonMirrorMode_ = saved.mode;
  }
});
