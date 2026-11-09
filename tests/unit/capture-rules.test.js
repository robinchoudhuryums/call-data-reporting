'use strict';
// Broad-scan 2026-11-09, Batch 2 -- capture rules and ingest validation
// (cdr-import; the CAP family). Each test drives the real code:
//   CAP-1  the Direct engine uses the captures' caller-direction test, so a
//          recording leg marked Incoming no longer hides an outbound call
//   CAP-2  a roster / alias read that throws is retried, then SAID
//   CAP-3  a source whose columns moved is refused before anything is written
//   CAP-4  a missed direct call is "busy" only if every ring found them busy
//   CAP-5  a per-call backfill stopped by an unreachable Neon logs failure
//   CAP-6  the dial-in reading uses the build's own per-leg credit rule
//   CAP-7  a failed post-write sort does not fail a DQE build that wrote

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const J = function (v) { return JSON.parse(JSON.stringify(v)); };
const read = function (rel) { return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'); };
const PH_HEADER = ['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes'];

// ── the Direct engine (CAP-1, CAP-4, CAP-6) ──────────────────────────────────

function directRow(o) {
  const r = new Array(40).fill('');
  r[0] = o.cid; r[2] = o.start || ''; r[3] = o.connected || ''; r[4] = o.stop || ''; r[5] = o.dir;
  r[6] = o.talk || ''; r[7] = o.callTime || ''; r[8] = o.caller || ''; r[9] = o.callerName || '';
  r[10] = o.callee || ''; r[11] = o.calleeName || ''; r[14] = o.parent || 'N/A'; r[16] = o.dialIn || '';
  r[23] = o.missed ? 'Missed' : ''; r[25] = o.answered ? 'Answered' : ''; r[36] = o.dept || '';
  return r;
}
const grid = function (rows) { return [new Array(40).fill('')].concat(rows); };

test('CAP-1: an outbound call whose CallRecording leg is marked Incoming is still a Direct outbound call', function () {
  // The real project shape: the captures' NX-2 test is in scope.
  const h = loadGas({ project: 'cdr-import', files: ['inboundCalls.js', 'directCallMetrics.js'] });
  const MAPS = { extToAgent: { '107': { name: 'Alan (Abhishek) Verma', dept: 'Sales' } },
    queueExtSet: new Set(['103']), exclusions: new Set(['103']) };
  const D = '10/19/2026 ', CUST = '17275550199';
  const out = directRow({ cid: '1783985220389', start: D + '11:34:57', connected: D + '11:35:01', stop: D + '11:35:22',
    dir: 'Outgoing', talk: '0:00:21', callTime: '0:00:25', caller: '107', callerName: 'Alan (Abhishek) Verma',
    callee: CUST, calleeName: 'N/A', answered: true });
  const rec = directRow({ cid: '1783985220389', start: D + '11:35:02', stop: D + '11:35:22', dir: 'Incoming',
    caller: CUST, callerName: 'N/A', callee: 'CallRecording', calleeName: 'N/A' });
  const plain = J(h.call('computeDirectCallMetrics', grid([out]), MAPS, { events: true }));
  const withRec = J(h.call('computeDirectCallMetrics', grid([out, rec]), MAPS, { events: true }));
  assert.equal(plain.rows[0].ob_ext_total, 1);
  assert.deepEqual(withRec.rows, plain.rows, 'the recording leg changes nothing -- it used to erase the call (rows: [])');
  assert.equal(withRec.events.length, 1);
  assert.equal(withRec.events[0].direction, 'out');

  // A REAL inbound call still files the agent's own Outgoing talk leg as that call's talk (PC-4).
  const inbound = directRow({ cid: 'IN1', start: D + '12:00:00', connected: D + '12:00:05', stop: D + '12:01:05', dir: 'Incoming',
    talk: '0:00:00', callTime: '0:00:05', caller: CUST, callee: '107', calleeName: 'Alan (Abhishek) Verma' });
  const ownTalk = directRow({ cid: 'IN1', start: D + '12:00:05', stop: D + '12:01:05', dir: 'Outgoing', talk: '0:01:00',
    callTime: '0:01:00', caller: '107', callerName: 'Alan (Abhishek) Verma', callee: CUST });
  const pc4 = J(h.call('computeDirectCallMetrics', grid([inbound, ownTalk]), MAPS, {}));
  assert.equal(pc4.rows[0].ib_ext_answered, 1);
  assert.equal(pc4.rows[0].ob_ext_total, 0, 'not a fake outbound');

  // No bare group test is left in the engine (per-call-capture.md's NX-2 rule).
  const src = read('apps-script/cdr-import/directCallMetrics.js');
  const fn = src.slice(src.indexOf('function computeDirectCallMetrics('), src.indexOf('\nfunction dcDiagSummary_'));
  assert.match(fn, /const callerIncoming = \(typeof icIsCallerIncoming_ === 'function'\)\s*\n\s*\? icIsCallerIncoming_/);
  assert.match(fn, /if \(!q \|\| !callerIncoming\(q\)\) continue;/);
  assert.ok(!/if \(!q \|\| String\(q\[C\.DIR\] \|\| ''\) !== 'Incoming'\) continue;/.test(fn), 'the bare Direction test is gone');
});

test('CAP-4: a call taken in the gap between two rings of one call does not excuse the miss', function () {
  const h = loadGas({ project: 'cdr-import', files: ['directCallMetrics.js'] });
  const MAPS = { extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
    queueExtSet: new Set(['103']), exclusions: new Set(['103']) };
  const D = '11/05/2026 ', C1 = '15552223333';
  const ring1 = directRow({ cid: 'R1', start: D + '10:00:00', stop: D + '10:00:20', dir: 'Incoming', callTime: '0:00:20',
    caller: C1, callee: '101', calleeName: 'Anna', missed: true });
  const bobAns = directRow({ cid: 'R1b', parent: 'R1', start: D + '10:00:20', connected: D + '10:00:25', stop: D + '10:06:00',
    dir: 'Incoming', talk: '0:05:35', callTime: '0:05:40', caller: C1, callee: '102', calleeName: 'Bob', answered: true });
  const ring2 = directRow({ cid: 'R1c', parent: 'R1', start: D + '10:06:00', stop: D + '10:06:20', dir: 'Internal', callTime: '0:00:20',
    caller: '102', callerName: 'Bob', callee: '101', calleeName: 'Anna', missed: true });
  // Anna's unrelated call 10:02-10:04: inside the first-ring..last-ring span, overlapping NEITHER ring.
  const gapCall = directRow({ cid: 'X9', start: D + '10:02:00', connected: D + '10:02:05', stop: D + '10:04:00', dir: 'Incoming',
    talk: '0:01:55', callTime: '0:02:00', caller: '15558889999', callee: '101', calleeName: 'Anna', answered: true });
  const anna = function (rows) {
    const res = J(h.call('computeDirectCallMetrics', grid(rows), MAPS, { events: true }));
    const a = res.rows.filter(function (x) { return x.agent === 'Anna'; })[0];
    const ev = res.events.filter(function (e) { return e.agent === 'Anna' && e.callId === 'R1'; })[0];
    return { free: a.ib_ext_missed_free + a.ib_int_missed_free, busy: a.ib_ext_missed_busy + a.ib_int_missed_busy,
      outcome: ev.outcome, busyWith: ev.busyWith };
  };
  assert.deepEqual(anna([ring1, bobAns, ring2, gapCall]), { free: 1, busy: 0, outcome: 'missed_free', busyWith: null },
    'free at both rings: a miss (it read missed_busy, naming the gap call)');

  // Busy at EVERY ring is still excused, and names the first ring's call.
  const busy1 = directRow({ cid: 'B1', start: D + '09:59:00', connected: D + '09:59:05', stop: D + '10:00:30', dir: 'Incoming',
    talk: '0:01:25', callTime: '0:01:30', caller: '15557771111', callee: '101', calleeName: 'Anna', answered: true });
  const busy2 = directRow({ cid: 'B2', start: D + '10:05:30', connected: D + '10:05:35', stop: D + '10:07:00', dir: 'Outgoing',
    talk: '0:01:25', callTime: '0:01:30', caller: '101', callerName: 'Anna', callee: '15557772222', answered: true });
  const both = anna([ring1, bobAns, ring2, busy1, busy2]);
  assert.equal(both.outcome, 'missed_busy');
  assert.equal(both.busy, 1);
  assert.equal(both.busyWith, 'an outside caller', 'who the FIRST ring\'s call was with');
  // Busy at only one of the two rings: free at the other, so a miss.
  assert.equal(anna([ring1, bobAns, ring2, busy1]).outcome, 'missed_free');
  // A single-ring miss is judged exactly as before.
  assert.equal(anna([ring1, bobAns, busy1]).outcome, 'missed_busy');
  assert.equal(anna([ring1, bobAns, gapCall]).outcome, 'missed_free');
});

test('CAP-6: the dial-in reading credits a blank-named leg the way the build does', function () {
  const h = loadGas({ project: 'cdr-import', files: ['directCallMetrics.js'] });
  // Ext 150 is still listed under a former employee; 8x8 names only New Hire on it today.
  const MAPS = { extToAgent: { '150': { name: 'Old Hand', dept: 'Sales' } },
    extCands: { '150': [{ name: 'Old Hand', dept: 'Sales' }] },
    nameCells: { 'Old Hand': [{ name: 'Old Hand', dept: 'Sales' }], 'New Hire': [{ name: 'New Hire', dept: 'CSR' }] },
    queueExtSet: new Set(['103']), exclusions: new Set(['103']) };
  const D = '11/05/2026 ';
  const rows = grid([
    directRow({ cid: 'N1', start: D + '09:00:00', dir: 'Outgoing', talk: '0:00:30', callTime: '0:00:35', caller: '150',
      callerName: 'New Hire', callee: '15550001111', answered: true, dept: 'CSR' }),
    directRow({ cid: 'S1', start: D + '10:00:00', connected: D + '10:00:05', stop: D + '10:01:05', dir: 'Incoming', talk: '0:01:00',
      callTime: '0:01:05', caller: '15552223333', callee: '150', calleeName: '', dialIn: '15557770000', answered: true, dept: 'CSR' }),
    directRow({ cid: 'S2', start: D + '11:00:00', connected: D + '11:00:05', stop: D + '11:01:05', dir: 'Incoming', talk: '0:01:00',
      callTime: '0:01:05', caller: '15552224444', callee: '150', calleeName: 'New Hire', dialIn: '15557770000', answered: true, dept: 'CSR' }),
  ]);
  const res = h.call('computeDirectCallMetrics', rows, MAPS, { events: true });
  assert.equal(typeof res.resolveLeg, 'function', 'the build exposes its own resolver');
  assert.deepEqual(Object.keys(res).sort(), ['events', 'meta', 'rows'], '...non-enumerably: the result\'s shape is unchanged');
  assert.equal(res.resolveLeg('150', '').agent.name, 'New Hire', 'blank leg on a reassigned extension -> the person 8x8 names that day');
  const ann = J(h.call('dcDialInAnnotate_', rows, res.events, MAPS, res.resolveLeg));
  assert.equal(ann['S1|New Hire'].via, 'straight', 'the blank-named leg IS the agent\'s own (it read "colleague")');
  assert.equal(ann['S2|New Hire'].via, 'straight');
  // Without the resolver (an old caller) the raw rule still answers -- no throw.
  assert.equal(J(h.call('dcDialInAnnotate_', rows, res.events, MAPS))['S2|New Hire'].via, 'straight');
  // Both production callers pass it.
  const src = read('apps-script/cdr-import/directCallMetrics.js');
  assert.match(src, /dcDialInAnnotate_\(dayRows, result\.events \|\| \[\], maps, result\.resolveLeg\)/);
  assert.match(src, /dcDialInAnnotate_\(rows, res\.events \|\| \[\], maps, res\.resolveLeg\)/);
});

// ── the DQE build (CAP-2, CAP-7) ─────────────────────────────────────────────

function dqeHarness(project) {
  const h = loadGas({ project: project || 'cdr-import', files: ['buildDQEHistoricalData.js'] });
  h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
  h.ctx.notifyNeonWriteFailure = function () {};
  function leg(o) {
    const r = new Array(44).fill('');
    r[0] = o.callId; r[1] = '1'; r[2] = o.start; r[4] = o.start; r[6] = o.talk || '0:00:00'; r[7] = '0:00:10';
    r[8] = o.caller || ''; r[10] = o.callee || ''; r[11] = o.calleeName || ''; r[14] = o.parentCall || 'N/A';
    r[22] = o.callerId || ''; r[25] = o.answered ? 'Answered' : '';
    return r;
  }
  const raw = [new Array(44).fill('hdr')];
  [['A', 'Roman Robin Paulose'], ['B', 'Sarah Q. Smith']].forEach(function (p) {
    raw.push(leg({ callId: 'P' + p[0], start: '07/09/2026 7:00:00', talk: '0:03:00', calleeName: p[1] }));
    raw.push(leg({ callId: 'Q' + p[0], start: '07/09/2026 7:00:00', caller: 'CallQueue(103)', calleeName: p[1],
      parentCall: 'P' + p[0], callerId: 'A_Q_CSR', answered: true }));
  });
  const ss = makeFakeSpreadsheet({ sheets: {
    'Raw Data': raw,
    'DO NOT EDIT!': rosterGrid({ CSR: ['Roman (Robin) Paulose, 103', 'Sarah Smith, 103'] }),
    'Agent Alias Overrides': [['Old Name', 'Canonical Name', 'Active'], ['Sarah Q. Smith', 'Sarah Smith', true]],
    'DQE Historical Data': [new Array(37).fill('h')],
    'Pipeline Health': [PH_HEADER],
  } });
  h.state.spreadsheet = ss;
  const run = function () { h.call('buildDQEHistoricalData', ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'), { skipNeon: true }); };
  const names = function () { return ss._sheet('DQE Historical Data')._data.slice(1).map(function (r) { return r[2]; }).filter(Boolean).sort(); };
  const health = function () { return ss._sheet('Pipeline Health')._data.slice(1).map(function (r) { return { step: r[1], status: r[2], notes: String(r[5]) }; }); };
  // Make the first `n` getRange calls on a sheet throw.
  const failReads = function (sheetName, n) {
    const sh = ss._sheet(sheetName), real = sh.getRange;
    let left = n;
    sh.getRange = function () { if (left > 0) { left--; throw new Error('Service Spreadsheets timed out'); } return real.apply(sh, arguments); };
  };
  return { h: h, ss: ss, run: run, names: names, health: health, failReads: failReads };
}

test('CAP-2: one transient roster read error is retried and the day is canonicalized as usual', function () {
  const d = dqeHarness();
  d.failReads('DO NOT EDIT!', 1);
  d.run();
  assert.deepEqual(d.names(), ['Roman (Robin) Paulose', 'Sarah Smith']);
  assert.deepEqual(d.health().map(function (r) { return r.step + '|' + r.status; }), ['buildDQE|success']);
});

test('CAP-2: a roster read that keeps failing still builds, and SAYS the names were not matched', function () {
  const d = dqeHarness();
  d.failReads('DO NOT EDIT!', 99);
  d.run();
  assert.deepEqual(d.names(), ['Roman Robin Paulose', 'Sarah Q. Smith'], 'written as received');
  const rows = d.health();
  const bad = rows.filter(function (r) { return r.step === 'buildDQE:roster'; });
  assert.equal(bad.length, 1, 'it used to be a plain success row and nothing else');
  assert.equal(bad[0].status, 'failure');
  assert.match(bad[0].notes, /callDate=07\/09\/2026 \| the DO NOT EDIT! roster could not be read \(Service Spreadsheets timed out\)/);
  assert.match(bad[0].notes, /Force re-import this date/);
  assert.ok(rows.some(function (r) { return r.step === 'buildDQE' && r.status === 'success'; }), 'the build itself still completes');
});

test('CAP-2: an alias-sheet read failure is said too; the roster match still applies', function () {
  const d = dqeHarness();
  d.failReads('Agent Alias Overrides', 99);
  d.run();
  assert.deepEqual(d.names(), ['Roman (Robin) Paulose', 'Sarah Q. Smith'], 'roster matched; the alias was not applied');
  const bad = d.health().filter(function (r) { return r.step === 'buildDQE:roster'; });
  assert.equal(bad.length, 1);
  assert.match(bad[0].notes, /the Agent Alias Overrides sheet could not be read .* alias overrides were NOT applied/);
});

test('CAP-2: the loader never throws, a MISSING sheet is not an error, and Health knows the step', function () {
  const h = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js'] });
  const none = h.call('loadRosterCanonicalNames_', makeFakeSpreadsheet({ sheets: { 'Other': [['x']] } }));
  assert.deepEqual(J(none), { canonicalSet: {}, strippedMap: {}, aliasMap: {} }, 'no roster sheet: empty maps, no readError');
  const boom = h.call('loadRosterCanonicalNames_', { getSheetByName: function () { throw new Error('nope'); } });
  assert.equal(boom.readError, 'nope');
  assert.deepEqual(J(boom.canonicalSet), {});
  const health = read('apps-script/department-dashboard/SystemHealth.gs');
  const list = health.slice(health.indexOf('var HEALTH_FAILURE_ONLY_STEPS_ = ['), health.indexOf('function healthFailureOnlyStep_'));
  assert.match(list, /'buildDQE:roster'/, 'failure-only: it never logs a success, so it must age out');
});

test('CAP-7: a post-write sort that throws does not fail the build -- rows written, mirror run, success logged', function () {
  const d = dqeHarness();
  let mirrored = 0;
  d.h.ctx.writeDQERowsToNeon = function (rows) { mirrored = rows.length; return { skipped: 0 }; };
  const dqe = d.ss._sheet('DQE Historical Data');
  // A third row so the sort runs (it is skipped for a one-row sheet).
  const realGetRange = dqe.getRange;
  dqe.getRange = function () {
    const rng = realGetRange.apply(dqe, arguments);
    rng.sort = function () { throw new Error('sort service error'); };
    return rng;
  };
  assert.doesNotThrow(function () {
    d.h.call('buildDQEHistoricalData', d.ss._sheet('Raw Data'), dqe, {});
  }, 'it used to escape, and the caller emailed "DQE was NOT refreshed"');
  assert.equal(d.names().length, 2, 'the rows are in the sheet');
  assert.equal(mirrored, 2, 'the Neon mirror still ran');
  const rows = d.health();
  const sortRow = rows.filter(function (r) { return r.step === 'historicalSort:DQE'; });
  assert.equal(sortRow.length, 1);
  assert.equal(sortRow[0].status, 'failure');
  assert.match(sortRow[0].notes, /post-write sort threw: sort service error -- the rows are written/);
  assert.ok(rows.some(function (r) { return r.step === 'buildDQE' && r.status === 'success'; }));
});

// ── the source layout (CAP-3) ────────────────────────────────────────────────

function feedRow(i, shift) {
  const r = new Array(44).fill('');
  r[0] = 'C' + i; r[1] = '1'; r[2] = '07/09/2026 ' + (7 + (i % 8)) + ':' + String(i % 60).padStart(2, '0') + ':00';
  r[4] = r[2]; r[5] = i % 3 === 0 ? 'Outgoing' : 'Incoming'; r[6] = '0:01:00'; r[7] = '0:01:10';
  r[8] = '15550001111'; r[10] = '101'; r[14] = 'N/A'; r[23] = i % 4 === 0 ? 'Missed' : ''; r[25] = i % 4 === 0 ? '' : 'Answered';
  if (shift != null) { r.splice(shift, 0, 'INSERTED'); r.length = 44; }
  return r;
}
function feed(n, shift) {
  const g = [new Array(44).fill('hdr')];
  for (let i = 0; i < n; i++) g.push(feedRow(i, shift));
  return g;
}

test('CAP-3: sourceLayoutProblem_ accepts a real-shaped day and names what moved on a shifted one', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const p = function (g) { return h.call('sourceLayoutProblem_', g); };
  assert.equal(p(feed(60)), '');
  assert.match(p(feed(60, 3)), /^column F should hold Incoming \/ Outgoing \/ Internal, but none of 60 rows does/,
    'one column inserted after Start Time: the Direction column now holds something else');
  assert.match(p(feed(60, 1)), /^column C should hold each call's start time, but only 0 of 60 rows have one there/);
  assert.match(p(feed(250, 12)), /^columns X and Z should hold "Missed" \/ "Answered", but none of 250 rows has either/,
    'an insert past Direction is caught at the flag columns');
  assert.equal(p(feed(60, 12)), '', 'the flag rule waits for a workday-sized grid: a quiet day can hold neither');
  // Presence, not purity: unfamiliar values never refuse a good day.
  const odd = feed(60);
  for (let i = 1; i <= 50; i++) { odd[i][5] = 'SomethingNew'; odd[i][23] = 'N/A'; odd[i][25] = 'N/A'; }
  assert.equal(p(odd), '');
  // A tiny grid is not judged; blank padding rows are not counted.
  assert.equal(p(feed(5, 3)), '');
  assert.equal(p(feed(60).concat([new Array(44).fill(''), new Array(44).fill('')])), '');
  assert.equal(p([]), '');
  assert.equal(p(null), '');
});

test('CAP-3: a shifted source is refused before the Raw Data rewrite and the force-delete', function () {
  const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  const ISO = '2026-07-09';
  const sheets = {
    'Raw Data': [new Array(44).fill('keep')], 'CDR Output': [['h']], 'DO NOT EDIT!': [['h']],
    'CDR Historical Data': [['A', 'B', 'Date'], ['m', 'x', '07/09/2026']],
    'Q Path Historical Data': [['A', 'B', 'Date'], ['m', 'x', '07/09/2026']],
    'QCD Historical Data': [['A', 'B', 'Date'], ['m', 'x', '07/09/2026']],
    'CSR Transfer Historical Data': [['A', 'B', 'Date'], ['m', 'x', '07/09/2026']],
    'DQE Historical Data': [['A', 'Date'], ['m', '07/09/2026']],
    'Direct Call History': [['A', 'Date'], ['m', '07/09/2026']],
  };
  sheets['Call_Legs_' + ISO] = feed(60, 3);
  h.state.props = {};
  const ss = makeFakeSpreadsheet({ sheets: sheets });
  ss.toast = function () {};
  h.state.spreadsheet = ss;
  const calls = [], logged = [];
  h.ctx.calculateMetricsInMemory = function () { calls.push('compute'); return {}; };
  h.ctx.deleteHistoricalRowsForDate = function () { calls.push('delete'); return 1; };
  h.ctx.processIntegratedHistory = function () { calls.push('write'); const r = []; r.counts = {}; return r; };
  h.ctx.logPipelineHealthWithFallback_ = function (s, ev) { logged.push(J(ev)); };
  h.ctx.notifyImportFailure_ = function () { calls.push('email'); };
  const out = h.call('processNewImport', true, ISO, false, ss, null, { noAlert: true });
  assert.match(out, /^ERROR: Source layout mismatch: in Call_Legs_2026-07-09 column F should hold Incoming/);
  assert.match(out, /Nothing was deleted or written/);
  assert.deepEqual(calls, ['email'], 'no compute, no delete, no write -- and the failure is emailed');
  assert.equal(ss._sheet('Raw Data')._data[0][0], 'keep', 'Raw Data was not restaged');
  assert.deepEqual(logged.map(function (e) { return e.step + '|' + e.status; }), ['autoImport|failure']);
  // Order pin: the layout check precedes the tab-date check (which passes a grid with no dated row).
  const src = read('apps-script/cdr-import/autoImport.js');
  assert.ok(src.indexOf('assertSourceLayout_(cleanData, latestName);') < src.indexOf('assertSourceDateMatchesTab_(cleanData, dateObj, latestName);'));
  assert.ok(src.indexOf('assertSourceLayout_(cleanData, latestName);') < src.indexOf('rawDataSheet.clearContents();'));
});

// ── the per-call backfills (CAP-5) ───────────────────────────────────────────

test('CAP-5: a backfill stopped by an unreachable Neon logs FAILURE; a time-budget stop stays a success', function () {
  const h = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'autoImport.js', 'inboundCalls.js', 'outboundCalls.js'] });
  const rows = [];
  h.ctx.icFetchMirroredDates_ = function () { return {}; };
  h.ctx.ocFetchMirroredDates_ = function () { return {}; };
  h.ctx.logPipelineHealthWithFallback_ = function (ss, ev) { rows.push(J(ev)); };
  const sheets = function () { return makeFakeSpreadsheet({ sheets: { 'Call_Legs_2026-09-01': [['CALL ID'], ['1']] } }); };
  [['backfillInboundCalls', 'inboundBackfill', 'writeInboundCallsToNeon'],
   ['backfillOutboundCalls', 'outboundBackfill', 'writeOutboundCallsToNeon']].forEach(function (t) {
    rows.length = 0;
    h.state.spreadsheet = sheets();
    h.ctx[t[2]] = function () { return { inserted: 0, skipped: 5 }; };   // Neon unreachable
    const res = h.call(t[0], null, null, false);
    const row = rows.filter(function (r) { return r.step === t[1]; })[0];
    assert.equal(row.status, 'failure', t[0] + ': it logged success with "STOPPED: Neon unreachable" in the note');
    assert.match(row.notes, /STOPPED: Neon unreachable at 2026-09-01/);
    assert.equal(res.unreachable, true);

    rows.length = 0;
    h.state.spreadsheet = sheets();
    h.ctx[t[2]] = function () { return { inserted: 3 }; };
    h.call(t[0], null, null, false);
    assert.equal(rows.filter(function (r) { return r.step === t[1]; })[0].status, 'success', t[0] + ': a clean run stays green');
  });
  // Only the unreachable stop is a failure: the status reads `unreachable`, not `stoppedEarly`.
  ['inboundCalls.js', 'outboundCalls.js'].forEach(function (f) {
    const src = read('apps-script/cdr-import/' + f);
    assert.match(src, /status:\s+\(failures\.length \|\| hashlessDates\.length \|\| unreachable\) \? 'failure' : 'success'/);
    assert.ok(!/\|\| stoppedEarly\) \? 'failure'/.test(src), f + ': a time-budget stop made progress and is not a failure');
  });
});
