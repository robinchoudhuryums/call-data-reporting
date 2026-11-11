'use strict';

// NUM-1..10 (broad scan 2026-11-09, Batch 3): numbers a manager reads that
// disagreed with another number on the same screen, or with the same number
// on another screen.
//
//   NUM-1  CSR transfer figures leave out exception days (#81), as the totals
//          beside them do.
//   NUM-2  the Insights cache key separates an agent-free run (idle agents
//          dropped, IDLE-2) from a run that names the whole roster.
//   NUM-3  a department's own callback figures match its row in Callbacks by
//          department: the engine sees the other teams' attempts too, so a
//          dial another team made for its OWN episode is consumed there.
//   NUM-4  one Overview tile takes ONE queue-split fail-open verdict (its
//          30-day span), not one per pass.
//   NUM-5  the Transfer retries department filter folds a sub-queue to its
//          parent, as the cases are.
//   NUM-6  the Overview says so when the latest day is an exception day.
//   NUM-7  a crossover agent is still counted once in a combined view when an
//          exception day applies to one of their two departments.
//   NUM-8  a sub-queue with no mapped queues is an all-queue superset (DATA-8).
//   NUM-9  an outbound-only agent day does not say "no per-call rows".
//   NUM-10 the Direct tab orders before it caps, and its summary reads past
//          the list's cap.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const plain = (x) => JSON.parse(JSON.stringify(x));
const MEMOS = ['DEPT_CONFIG_ROWS_MEMO_', 'QCD_SHEET_DATA_MEMO_', 'DQE_DATE_BOUNDS_MEMO_', 'DQE_SHEET_ROWS_MEMO_',
  'DQE_DATE_COL_MEMO_', 'DQE_EXT_GRID_MEMO_', 'EXCEPTION_DAYS_MEMO_', 'COMPANY_HOLIDAYS_MEMO_'];

// ── NUM-1 / NUM-7 / NUM-8: My Department ────────────────────────────────────
const dept = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs', 'Data.gs',
          'NeonRead.gs', 'ExceptionDays.gs'],
  capture: ['SHEETS', 'EXCEPTION_DAYS_HEADERS'],
});
function installDept(excRows, dqe, roster, extraSheets, props) {
  dept.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
  dept.state.userEmail = 'admin@x.com';
  const sheets = Object.assign({ 'DO NOT EDIT!': roster, 'DQE Historical Data': dqe }, extraSheets || {});
  sheets[dept.consts.SHEETS.EXCEPTION_DAYS] = [dept.consts.EXCEPTION_DAYS_HEADERS.slice()].concat(excRows || []);
  dept.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  dept.state.cache.clear();
  MEMOS.forEach(function (k) { dept.ctx[k] = null; });
}
const CSRT_HEADER = ['Month Year', 'Week', 'Date', 'Agent', 'Trans %', 'Total Calls', 'Transferred',
  'Sales', 'Service', 'Billing', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11'];
function trow(date, agent, calls, tr) {
  const r = new Array(18).fill('');
  r[0] = 'Sep 2026'; r[2] = date; r[3] = agent; r[5] = String(calls); r[6] = String(tr); r[7] = String(tr);
  return r;
}

test('NUM-1: the CSR transfer figures leave out an exception day', function () {
  const dqe = dqeSheet([
    dqeRow({ date: '2026-09-21', agent: 'Anna', ext: '103', rung: 50, missed: 30, answered: 20 }),
    dqeRow({ date: '2026-09-22', agent: 'Anna', ext: '103', rung: 40, missed: 2, answered: 38 }),
  ]);
  const transfer = { 'CSR Transfer Historical Data': [CSRT_HEADER, trow('2026-09-21', 'Anna', 20, 18), trow('2026-09-22', 'Anna', 38, 4)] };
  const roster = rosterGrid({ CSR: ['Anna, 103'] });
  const req = { department: 'CSR', from: '2026-09-21', to: '2026-09-22' };

  installDept([], dqe, roster, transfer);
  const whole = dept.call('getDepartmentSummary', req).csrTransfer;
  assert.equal(whole.totalCalls, 58, 'with no exception day both days count');
  assert.equal(whole.transferred, 22);

  installDept([['2026-09-21', '', '8x8 outage', 'TRUE', 'a', '']], dqe, roster, transfer);
  const p = dept.call('getDepartmentSummary', req);
  assert.equal(p.totals.totalAnswered, 38, 'the agent table leaves the day out');
  assert.equal(p.csrTransfer.totalCalls, 38, 'and so does the transfer tile beside it');
  assert.equal(p.csrTransfer.transferred, 4);
  assert.equal(p.csrTransfer.days, 1);
  assert.deepEqual(plain(p.csrTransfer.daily).map(function (d) { return d.date; }), ['2026-09-22']);
});

test('NUM-7: a crossover agent is counted once when an exception day applies to one of the two departments', function () {
  const dqe = dqeSheet([
    dqeRow({ date: '2026-08-11', agent: 'Anna', ext: '103', rung: 30, missed: 5, answered: 25, unique: 30 }),
    dqeRow({ date: '2026-08-12', agent: 'Anna', ext: '103', rung: 20, missed: 5, answered: 15, unique: 20 }),
  ]);
  const roster = rosterGrid({ CSR: ['Anna, 103'], Spanish: ['Anna, 104'] });
  const req = { department: 'CSR', from: '2026-08-11', to: '2026-08-12' };
  const groups = function (p) { const o = {}; p.deptGroups.forEach(function (g) { o[g.dept] = g.totals.totalRung; }); return o; };

  installDept([], dqe, roster);
  const clean = dept.call('getDepartmentSummary', req);
  assert.equal(clean.totals.totalRung, 50);
  assert.equal(clean.totals.crossoverAgentCount, 1);

  // The sub-queue's row is the smaller one (it appears second).
  installDept([['2026-08-12', 'Spanish', 'Spanish line down', 'TRUE', 'a', '']], dqe, roster);
  const child = dept.call('getDepartmentSummary', req);
  assert.deepEqual(groups(child), { CSR: 50, Spanish: 30 }, 'each subtotal is still that department\'s own view');
  assert.equal(child.totals.totalRung, 50, 'the grand total counts her calls once (was 80)');
  assert.equal(child.totals.totalAnswered, 40);
  assert.equal(child.totals.crossoverAgentCount, 1);

  // The parent's row is the smaller one (it appears first): the same total.
  installDept([['2026-08-12', 'CSR', 'CSR line down', 'TRUE', 'a', '']], dqe, roster);
  const parent = dept.call('getDepartmentSummary', req);
  assert.deepEqual(groups(parent), { CSR: 30, Spanish: 50 });
  assert.equal(parent.totals.totalRung, 50);
  assert.equal(parent.totals.crossoverAgentCount, 1);
});

test('NUM-8: a sub-queue with no mapped queues is an all-queue superset of the parent\'s slice', function () {
  const split = JSON.stringify({
    A_Q_CSR: { u: 6, r: 6, m: 2, a: 4, t: 400, n: 4, mt: '' },
    A_Q_Spanish: { u: 4, r: 4, m: 1, a: 3, t: 300, n: 3, mt: '' } });
  const run = function (childQueues) {
    const row = dqeRow({ date: '2026-10-05', agent: 'Anna', ext: '103', rung: 10, missed: 3, answered: 7, unique: 10 });
    row.vals[34] = split; row.disp[34] = split;
    const sheet = dqeSheet([row]);
    sheet.values[0][34] = ''; sheet.displays[0][34] = '';
    installDept([], sheet, rosterGrid({ CSR: ['Anna, 103'], Spanish: ['Anna, 104'] }), null, { QUEUE_SPLIT_SCOPE: 'dept' });
    const prev = dept.ctx.inboundQueuesForDept_;
    dept.ctx.inboundQueuesForDept_ = function (d) { return d === 'CSR' ? ['A_Q_CSR'] : childQueues; };
    try { return dept.call('getDepartmentSummary', { department: 'CSR', from: '2026-10-05', to: '2026-10-05' }); }
    finally { dept.ctx.inboundQueuesForDept_ = prev; }
  };
  const mapped = run(['A_Q_Spanish']);
  assert.equal(mapped.totals.totalRung, 10, 'two narrowed rows partition the day');
  assert.equal(mapped.totals.crossoverAgentCount, 0);
  const unmapped = run([]);
  assert.equal(unmapped.totals.totalRung, 10, 'the 6 CSR rings are not counted twice (was 16)');
  assert.equal(unmapped.totals.totalAnswered, 7);
  assert.equal(unmapped.totals.crossoverAgentCount, 1);
});

// ── NUM-2: Insights ─────────────────────────────────────────────────────────
test('NUM-2: an agent-free Insights run and a whole-roster pick do not share a cache entry', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs',
    'Data.gs', 'NeonRead.gs', 'InsightsReport.gs', 'Digest.gs', 'EmailKit.gs'] });
  const rows = [
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 9 }),
    dqeRow({ date: '2026-03-05', agent: 'Anna', ext: '501', rung: 8, missed: 1, answered: 7 }),
    dqeRow({ date: '2026-03-05', agent: 'Ben', ext: '501', rung: 6, missed: 4, answered: 2 }),
  ];
  const install = function () {
    h.state.userEmail = 'admin@x.com';
    h.state.props.SPREADSHEET_ID = 'fake'; h.state.props.ADMIN_EMAILS = 'admin@x.com';
    h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
      'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202', 'Dan, 203'], Beta: ['Cara, 301'] }),
      'DQE Historical Data': dqeSheet(rows) } });
    MEMOS.forEach(function (k) { h.ctx[k] = null; });
    h.state.cache.clear();
  };
  const names = function (d) { return plain(d.agentData).map(function (a) { return a.name; }).sort(); };
  const base = { department: 'Alpha', from: '2026-03-09', to: '2026-03-15' };
  const all = Object.assign({ agents: ['Anna', 'Ben', 'Dan'] }, base);

  install();
  const free1 = h.call('getInsightsReport', base);
  const all1 = h.call('getInsightsReport', all);
  assert.deepEqual(names(free1), ['Anna'], 'agent-free: idle agents dropped');
  assert.equal(all1.meta.cacheHit, false, 'the named run is not served the agent-free payload');
  assert.deepEqual(names(all1), ['Anna', 'Ben', 'Dan'], 'a named pick keeps every agent it named');

  install();
  h.call('getInsightsReport', all);
  const free2 = h.call('getInsightsReport', base);
  assert.equal(free2.meta.cacheHit, false);
  assert.deepEqual(names(free2), ['Anna'], 'and the other order');

  // Each still caches under its own key.
  assert.equal(h.call('getInsightsReport', base).meta.cacheHit, true);
  assert.equal(h.call('getInsightsReport', all).meta.cacheHit, true);
});

// ── NUM-3: callbacks ────────────────────────────────────────────────────────
const ob = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'InboundReport.gs', 'OutboundReport.gs'] });
const CB_CTX = {
  from: '2026-10-05', to: '2026-10-05', todayIso: '2026-10-20', windowDays: 3,
  ownersOf: { a_q_sales: ['Sales'], a_q_billing: ['Billing'] }, parentOf: {}, childrenOf: {},
  homesOf: function (a) { return ({ Bea: ['Billing'], Sam: ['Sales'] })[a] || []; },
};
// One caller abandons on the Sales queue, then on the Billing queue. A Billing
// agent calls them back. Nobody from Sales ever dials.
const CB_OB = [[1, '2026-10-05', '10:00:00', 'o1', 'Bea', true]];

test('NUM-3: a department view reaches the outcome its row in Callbacks by department shows', function () {
  const company = plain(ob.call('obCallbackEpisodes_', { ab: [
    [1, '2026-10-05', '09:00:00', 'a_q_sales', 'c1'],
    [1, '2026-10-05', '09:05:00', 'a_q_billing', 'c2']], ob: CB_OB, ans: [] }, CB_CTX));
  const companySales = company.filter(function (e) { return e.teamKey === 'Sales'; })[0];
  assert.equal(companySales.outcome, 'none', 'company view: Billing\'s dial is Billing\'s own callback');

  // The Sales view's rows: both attempts, the Billing one flagged not-mine.
  const rows = [
    [1, '2026-10-05', '09:00:00', 'a_q_sales', 'c1', true],
    [1, '2026-10-05', '09:05:00', 'a_q_billing', 'c2', false]];
  const all = plain(ob.call('obCallbackEpisodes_', { ab: rows, ob: CB_OB, ans: [] }, CB_CTX));
  const mine = plain(ob.call('obEpMineOnly_', all, rows));
  assert.equal(mine.length, 1, 'only the department\'s own episode is kept');
  assert.equal(mine[0].teamKey, 'Sales');
  assert.equal(mine[0].outcome, 'none', 'and it is "not called back", as in the company table (was "another team")');

  // The old read -- Sales' attempts only -- is what produced the disagreement.
  const narrow = plain(ob.call('obCallbackEpisodes_', { ab: [rows[0].slice(0, 5)], ob: CB_OB, ans: [] }, CB_CTX));
  assert.equal(narrow[0].outcome, 'other');
});

test('NUM-3: obEpMineOnly_ keeps every episode when no row is flagged, and drops only all-not-mine ones', function () {
  const eps = [{ k: 1, attempts: [{ iso: '2026-10-05', id: 'c1' }] }, { k: 1, attempts: [{ iso: '2026-10-05', id: 'c2' }] }];
  assert.equal(ob.call('obEpMineOnly_', eps, [[1, '2026-10-05', '09:00:00', 'q', 'c1'], [1, '2026-10-05', '09:05:00', 'q', 'c2']]).length, 2,
    'five-element rows (the company view, older fixtures) are all the view\'s own');
  assert.equal(ob.call('obEpMineOnly_', eps, [[1, '2026-10-05', '09:00:00', 'q', 'c1', true], [1, '2026-10-05', '09:05:00', 'q', 'c2', false]]).length, 1);
  // CE-3's rows carry a teams ARRAY at index 5: never read as "not mine".
  assert.equal(ob.call('obEpMineOnly_', eps, [[1, '2026-10-05', '09:00:00', 'q', 'c1', ['Sales']], [1, '2026-10-05', '09:05:00', 'q', 'c2', ['Billing']]]).length, 2);
  assert.deepEqual(plain(ob.call('obEpMineOnly_', null, null)), []);
});

test('NUM-3: the event SQL reads every queue in a department view and counts only its own', function () {
  const deptSql = ob.call('obCallbackEventsSql_', { dept: 'Sales' }, ['A_Q_Sales'], '2026-10-05', '2026-10-05', '2026-10-05', null);
  assert.match(deptSql.with, /AS mine FROM inbound_calls c WHERE /, 'the predicate is a column');
  // The column is inboundDeptPredicate_'s text minus its leading AND: if that
  // function's shape changes, this fails here rather than as a SQL error.
  assert.match(deptSql.with, /COALESCE\(\(+c\.disposition='answered'/, 'the expression opens on the predicate itself');
  assert.doesNotMatch(deptSql.with, /COALESCE\(\(\s*AND\b/);
  assert.doesNotMatch(deptSql.with.split(' AS mine FROM inbound_calls c WHERE ')[1].split('), cb_k')[0], /a_q_sales/,
    'and no longer narrows the read');
  assert.match(deptSql.with, /'a_q_sales'/, 'the predicate itself is still the shared one');
  assert.match(deptSql.with, /q <> '' AND mine\) x\)/, 'caller keys come from the department\'s own attempts');
  assert.match(deptSql.fields, /FROM cb_ab WHERE mine GROUP BY/, 'the counts are the department\'s own');
  assert.match(deptSql.fields, /a\.q, a\.cid, a\.mine\)/, 'each attempt row says whose it is');

  const co = ob.call('obCallbackEventsSql_', { dept: null, companyView: true }, [], '2026-10-05', '2026-10-05', '2026-10-05', null);
  assert.match(co.with, /COALESCE\(TRUE, FALSE\) AS mine/);
  assert.match(co.fields, /a\.q, a\.cid\) /, 'the company view\'s rows keep their five elements');
});

test('NUM-3: the sheet fallback builds the same rows (other teams\' attempts kept for a shared caller only)', function () {
  let seq = 0;
  const ib = function (date, hash, q, start) {
    const r = new Array(17).fill('');
    r[0] = date; r[1] = 'ib' + (++seq); r[3] = hash; r[5] = 'abandoned'; r[6] = 'queue'; r[7] = 'FALSE';
    r[10] = q; r[15] = start; r[16] = 'FALSE';
    return r;
  };
  const grid = [
    ib('2026-10-05', 'hA', 'A_Q_Sales', '09:00:00'),     // ib1: Sales' own
    ib('2026-10-05', 'hA', 'A_Q_Billing', '09:05:00'),   // ib2: the same caller, another team's queue
    ib('2026-10-05', 'hB', 'A_Q_Billing', '09:10:00'),   // ib3: a caller Sales never had
  ];
  const scope = { dept: 'Sales', from: '2026-10-05', to: '2026-10-05' };
  const blob = plain(ob.call('obBuildBlobFromGrids_', scope, [], grid, null, ['A_Q_Sales']));
  assert.deepEqual(blob.cbAb, [
    [1, '2026-10-05', '09:00:00', 'a_q_sales', 'ib1', true],
    [1, '2026-10-05', '09:05:00', 'a_q_billing', 'ib2', false]]);
  assert.deepEqual(blob.cbCounts, [{ w: 'cur', kind: 'queue', anon: false, q: 'a_q_sales', n: 1 }],
    'only the department\'s own abandon is counted');
  const co = plain(ob.call('obBuildBlobFromGrids_', { dept: null, companyView: true, from: '2026-10-05', to: '2026-10-05' }, [], grid, null, []));
  assert.equal(co.cbAb.length, 3);
  assert.ok(co.cbAb.every(function (r) { return r.length === 5; }), 'the company view\'s rows are unchanged');
});

// ── NUM-4: Overview ─────────────────────────────────────────────────────────
test('NUM-4: one Overview tile takes one queue-split verdict across its two passes', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'CompanyOverview.gs', 'Data.gs'] });
  const LATEST = '2026-09-21';
  const dal = function (date, r, m, a, q) {
    return { dateIso: date, agent: 'Anna', totalUnique: r, totalRung: r, totalMissed: m, totalAnswered: a,
      tttSec: a * 90, attSec: 90, avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0,
      queueSplit: JSON.stringify({ [q]: { u: r, r: r, m: m, a: a, t: a * 90, n: a, mt: '' } }) };
  };
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com', QUEUE_SPLIT_SCOPE: 'dept' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ Service: ['Anna, 301'] }),
    'DQE Historical Data': [['h'], ['x']],
    'Alert Log': [['Timestamp', 'Dept', 'Date', 'Rate', 'Threshold', 'Status', 'Sent', 'Triggered By']] } });
  h.ctx.getAllDepartments_ = function () { return ['Service']; };
  h.ctx.resolveUser_ = function () { return { email: 'admin@x.com', role: 'admin', department: null, departments: ['Service'] }; };
  h.ctx.getLatestDataDate = function () { return LATEST; };
  h.ctx.getDqeReadSource_ = function () { return 'sheet'; };
  // The alias list still names the queue's OLD raw name (renamed upstream in the spring).
  h.ctx.inboundQueuesForDept_ = function () { return ['A_Q_ServiceOld']; };
  h.ctx.sheetFetchDqeRows_ = function () {
    return [dal('2026-02-10', 20, 2, 18, 'A_Q_ServiceOld'), dal(LATEST, 30, 3, 27, 'A_Q_Service')];
  };
  h.ctx.computeQcdSnapshots_ = function () { return { _companyDaily: {} }; };
  ['computeOverviewPipelineFreshness_', 'computeOverviewOrphanNag_', 'computeOverviewUnmappedQcd_'].forEach(function (k) {
    h.ctx[k] = function () { return null; };
  });
  h.ctx.logReportUsage_ = function () {};
  const t = h.call('getCompanyOverview', {}).depts[0];
  assert.equal(t.latest.rung, 30, 'the 30-day pass fell open (its span holds only the new name)');
  assert.equal(t.periods.yesterday.rung, 30, 'and the wider pass follows it for the same day (was 0)');
  assert.equal(t.periods.last30.rung, 30);
  assert.equal(t.periods.ytd.rung, 50, 'a fall-open is the whole tile\'s: the year shows every queue');
});

test('NUM-4: verdictFromIso -- the named span decides; with no evidence in it, every row does', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'Data.gs'] });
  h.state.props = { QUEUE_SPLIT_SCOPE: 'dept' };
  h.ctx.inboundQueuesForDept_ = function () { return ['A_Q_Old']; };
  const row = function (date, q) {
    return { dateIso: date, agent: 'Anna', totalUnique: 5, totalRung: 5, totalMissed: 1, totalAnswered: 4, tttSec: 40, attSec: 10,
      queueSplit: JSON.stringify({ [q]: { u: 5, r: 5, m: 1, a: 4, t: 40, n: 4, mt: '' } }) };
  };
  const mk = function () { return [row('2026-02-10', 'A_Q_Old'), row('2026-09-21', 'A_Q_New')]; };
  const whole = h.call('queueSplitNarrowedCopy_', mk(), 'Svc');
  assert.equal(whole.info.fellOpenUnmatched, false, 'assessed over every row, the old name matches');
  assert.equal(whole.rows[1].totalRung, 0, 'so the recent day narrows to nothing');
  const tile = h.call('queueSplitNarrowedCopy_', mk(), 'Svc', { verdictFromIso: '2026-08-23' });
  assert.equal(tile.info.fellOpenUnmatched, true, 'the recent span holds only a name the dept does not claim');
  assert.deepEqual(tile.rows.map(function (r) { return r.totalRung; }), [5, 5]);
  const empty = h.call('queueSplitNarrowedCopy_', mk(), 'Svc', { verdictFromIso: '2026-10-01' });
  assert.equal(empty.info.fellOpenUnmatched, false, 'no evidence in the span: the whole-row verdict stands');
  // A span whose evidence matches narrows as before.
  h.ctx.inboundQueuesForDept_ = function () { return ['A_Q_New']; };
  const ok = h.call('queueSplitNarrowedCopy_', mk(), 'Svc', { verdictFromIso: '2026-08-23' });
  assert.equal(ok.info.fellOpenUnmatched, false);
  assert.deepEqual(ok.rows.map(function (r) { return r.totalRung; }), [0, 5]);
});

// ── NUM-5: Transfer retries ─────────────────────────────────────────────────
test('NUM-5: the Transfer retries filter folds a sub-queue to its parent', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'TransferRetries.gs'] });
  const parentOf = { PAP: 'Sales' };
  assert.equal(h.call('trFoldDept_', 'PAP', parentOf), 'Sales');
  assert.equal(h.call('trFoldDept_', 'Sales', parentOf), 'Sales');
  assert.equal(h.call('trFoldDept_', '', parentOf), '');
  const fn = h.call('trDeptsOfAgentFn_', { Cara: ['CSR'], Pat: ['PAP'], Pia: ['PAP'] }, parentOf);
  const rows = [{ kind: 'inbound', date: '2026-11-03', callId: 'c1', start: '09:00:00', agent: null, journey: [
    { t: '09:00:00', name: 'A_Q_CSR', kind: 'queue' },
    { t: '09:00:10', name: 'Cara', kind: 'answer', talk: 600 },
    { t: '09:03:00', name: 'Pat', kind: 'leg', missed: true, transfer: true, secs: 4 },
    { t: '09:03:30', name: 'Pia', kind: 'answer', talk: 60, transfer: true, consult: true },
  ] }];
  const count = function (d) { return plain(h.call('trBuildFromRows_', rows, fn, d)).cases.length; };
  assert.equal(count('Sales'), 1);
  assert.equal(count('PAP'), 0, 'the pure builder matches the folded name only');
  assert.equal(count(h.call('trFoldDept_', 'PAP', parentOf)), 1, 'which is what the endpoint now passes');
  const src = fs.readFileSync(path.join(DASH, 'TransferRetries.gs'), 'utf8');
  assert.match(src, /var filterDept = dept \? trFoldDept_\(dept, parentOf\) : '';/);
  assert.match(src, /trBuildFromRows_\(Array\.isArray\(rows\) \? rows : \[\], fn, filterDept\)/);
  assert.match(src, /out\.meta\.deptAsked = dept; out\.meta\.dept = filterDept;/);
});

// ── NUM-6: Overview note (client) ───────────────────────────────────────────
/** One top-level function's source from a client fragment, by brace matching. */
function clientFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' not found');
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(at, i + 1);
}

test('NUM-6: the Overview says so when the latest day is an exception day', function () {
  const ov = fs.readFileSync(path.join(DASH, 'script-3-overview.html'), 'utf8');
  const core = fs.readFileSync(path.join(DASH, 'script-1-core.html'), 'utf8');
  const ctx = vm.createContext({ ovLastData: null });
  vm.runInContext("var EXC_WD_ = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];"
    + "var EXC_MON_ = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];"
    + clientFn(core, 'excDateLabel_') + clientFn(ov, 'ovLatestExceptionFor_') + clientFn(ov, 'ovLatestExceptionNote_'), ctx);
  const note = function (data, deptName, single) {
    ctx.ovLastData = data;
    return vm.runInContext('ovLatestExceptionNote_(' + JSON.stringify(deptName) + ', ' + single + ')', ctx);
  };
  const all = { latestDate: '2026-09-21', exceptionDays: [{ date: '2026-09-21', depts: [], reason: '8x8 outage' }] };
  assert.match(note(all, 'CSR', true), /^Mon Sep 21 is an exception day \(8x8 outage\) and is left out of the figures\./);
  assert.match(note(all, null, true), /exception day/, 'the company snapshot too');
  assert.equal(note(all, 'CSR', false), '', 'a longer window has figures to show');
  const one = { latestDate: '2026-09-21', exceptionDays: [{ date: '2026-09-21', depts: ['Spanish'], reason: '' }] };
  assert.match(note(one, 'Spanish', true), /^Mon Sep 21 is an exception day and is left out/);
  assert.equal(note(one, 'CSR', true), '', 'a one-department day is only that department\'s');
  assert.equal(note(one, null, true), '', 'and never the company\'s');
  assert.equal(note({ latestDate: '2026-09-22', exceptionDays: all.exceptionDays }, 'CSR', true), '', 'an earlier day is not the latest');
  assert.equal(note({ latestDate: '2026-09-21' }, 'CSR', true), '');
  assert.equal(note(null, 'CSR', true), '');
  // The tile and the company snapshot both render it.
  assert.match(ov, /const excNote = ovLatestExceptionNote_\(dept\.name, ovCardPeriod === 'yesterday'\);/);
  assert.match(ov, /ov-dept-exc-note">' \+ escapeHtml\(excNote\)/);
  assert.match(ov, /escapeHtml\(ovLatestExceptionNote_\(null, true\)\)/);
});

// ── NUM-9 / NUM-10: Agent day ───────────────────────────────────────────────
const ad = loadGas({ files: ['Config.gs', 'Util.gs', 'AgentDay.gs'] });

test('NUM-9: an outbound-only day is not "no per-call rows"', function () {
  const r = ad.ctx.agentDayDegradedReason_;
  const meta = { tier: 'degraded', ageDays: 2, journeyHorizonDays: 90, captureHorizonDays: 400 };
  assert.equal(r(meta, true, { inbound: 0, outbound: 4 }), 'outbound-only');
  assert.equal(r(meta, true, { inbound: 2, outbound: 4 }), 'not-captured', 'inbound rows without a journey keep the old reason');
  assert.equal(r(meta, true, { inbound: 0, outbound: 0 }), 'not-captured');
  assert.equal(r(meta, true), 'not-captured', 'older callers (no counts) are unchanged');
  assert.equal(r(meta, false, { inbound: 0, outbound: 4 }), 'neon-down', 'the outage and the horizons still come first');
  assert.equal(r(Object.assign({}, meta, { ageDays: 120 }), true, { inbound: 0, outbound: 4 }), 'journey-pruned');
  assert.equal(ad.ctx.agentDayTier_(0, false, 4), 'degraded', 'the tier rule itself is untouched');
  const gs = fs.readFileSync(path.join(DASH, 'AgentDay.gs'), 'utf8');
  assert.match(gs, /\{ inbound: cap\.inbound\.length, outbound: cap\.outbound\.length \}\);/);
  const client = fs.readFileSync(path.join(DASH, 'script-10-escalations.html'), 'utf8');
  assert.match(client, /if \(reason === 'outbound-only'\) \{/);
  assert.match(client, /<strong>Outbound calls only\.<\/strong>/);
});

test('NUM-10: the Direct tab orders before it caps, and its summary reads past the list cap', function () {
  const gs = fs.readFileSync(path.join(DASH, 'AgentDay.gs'), 'utf8');
  assert.match(gs, /'ORDER BY call_start, call_id LIMIT ' \+ \(AGENT_DAY_DIRECT_READ_MAX_ \+ 1\) \+ '\) t\), '/);
  assert.doesNotMatch(gs, /agent_name = \? '\s*\n\s*\+ 'LIMIT /, 'no unordered LIMIT on the direct read');
  const mk = function (n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ call_id: 'x' + i, direction: 'in', side: 'ext', call_start: '09:00:00', ring_sec: 5, talk_sec: 10,
        outcome: 'answered', in_window: true });
    }
    return out;
  };
  const cap = function (n) { return { available: true, directStart: '2026-11-01', direct: mk(n), inbound: [] }; };
  const day = plain(ad.call('agentDayDirect_', cap(900), 'Anna', '2026-11-03'));
  assert.equal(day.rows.length, 300, 'the list keeps its cap');
  assert.equal(day.truncated, true);
  assert.equal(day.summary.in.total, 900, 'the summary counts the day');
  assert.equal(day.summary.capped, undefined);
  const huge = plain(ad.call('agentDayDirect_', cap(2001), 'Anna', '2026-11-03'));
  assert.equal(huge.summary.in.total, 2000);
  assert.equal(huge.summary.capped, 2000, 'past the read bound the summary says what it covers');
  const client = fs.readFileSync(path.join(DASH, 'script-10-escalations.html'), 'utf8');
  assert.match(client, /if \(s\.capped\) html \+= /);
});
