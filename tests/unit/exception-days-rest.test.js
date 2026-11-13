'use strict';

// EXC-3 (#81 phase 3; broad-scan cycle 260, expansion E1 / G1). Exception
// days on the surfaces phases 1-2 left out: the callback figures (queue and
// direct lines, and their drill lists), the abandon heatmap (pinned in
// heatmap-fallback.test.js), the insurer daily drill, and the report emails'
// own text.
//
// ONE rule, the Inbound report's: a view leaves out an abandon whose date is
// an exception day FOR THAT VIEW -- a department view drops its own days and
// the all-department ones; the company view only all-department days. For
// callbacks that has two halves, and both are pinned here:
//   * the raw counts drop the day where they are read (SQL + its sheet twin),
//     so abandonedTotal keeps matching the Inbound report's Abandoned figure;
//   * an EPISODE leaves when its FIRST attempt fell on such a day, applied
//     AFTER the engine, so no other episode's outcome moves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'NeonCoverage.gs', 'EmailKit.gs', 'InboundReport.gs', 'OutboundReport.gs'],
});
const J = (x) => JSON.parse(JSON.stringify(x));
const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const src = (f) => fs.readFileSync(path.join(DASH, f), 'utf8');

function seed(days) {
  h.state.cache.clear();
  if (days) h.state.cache.set('excDays:v1', JSON.stringify(days));
}
const OUTAGE = '2026-09-21';
const ALL_DAY = [{ date: OUTAGE, depts: [], reason: '8x8 outage' }];
const SALES_DAY = [{ date: OUTAGE, depts: ['Sales'], reason: 'Sales line down' }];

// Two Sales callers: one hung up on the outage day, one the day after.
// Neither was called back.
const CB_DEPT = { ownersOf: { a_q_sales: ['Sales'] }, parentOf: {}, childrenOf: { Sales: [] } };
function blob() {
  return {
    agents: [],
    cbCounts: [{ w: 'cur', kind: 'queue', anon: false, q: 'a_q_sales', n: 2 }],
    cbAb: [[1, OUTAGE, '09:00:00', 'a_q_sales', 'c1'], [2, '2026-09-22', '09:00:00', 'a_q_sales', 'c2']],
    cbOb: [], cbAns: [], cbThrough: '2026-10-05',
  };
}
const DEPT_SCOPE = { from: '2026-09-21', to: '2026-09-25', dept: 'Sales', companyView: false, scopeDepts: ['Sales'] };
const CO_SCOPE = { from: '2026-09-21', to: '2026-09-25', dept: null, companyView: true };
const shape = (scope) => J(h.call('outboundShapeReport_', scope, blob(), {}, CB_DEPT, null));

test('callbacks: an episode whose FIRST attempt fell on an exception day leaves the figures, and the block says so', function () {
  seed(null);
  let out = shape(DEPT_SCOPE);
  assert.equal(out.callback.episodes, 2);
  assert.equal('exceptionDays' in out.callback, false, 'no exception day: the payload is what it was');

  seed(ALL_DAY);
  out = shape(DEPT_SCOPE);
  assert.equal(out.callback.episodes, 1, 'the outage-day caller is not in the callback figures');
  assert.equal(out.callback.none, 1);
  assert.deepEqual(out.daily.map((d) => d.date), ['2026-09-22'], 'nor on the per-day series');
  assert.deepEqual(out.callback.exceptionDays, [{ date: OUTAGE, reason: '8x8 outage' }]);
});

test('callbacks: a one-department day leaves that department\'s view only -- the company view keeps it', function () {
  seed(SALES_DAY);
  assert.equal(shape(DEPT_SCOPE).callback.episodes, 1, 'Sales\' own view');
  const co = shape(CO_SCOPE);
  assert.equal(co.callback.episodes, 2, 'the company line keeps a one-department day');
  assert.equal('exceptionDays' in co.callback, false);
  seed(ALL_DAY);
  assert.equal(shape(CO_SCOPE).callback.episodes, 1, 'an all-department day leaves the company view too');
});

test('callbacks: a dial placed ON an exception day still answers an earlier caller', function () {
  // The caller hung up on the 18th; the team called back on the outage day.
  seed(ALL_DAY);
  const b = blob();
  b.cbAb = [[1, '2026-09-18', '09:00:00', 'a_q_sales', 'c1']];
  b.cbOb = [[1, OUTAGE, '10:00:00', 'o1', 'Sam', true]];
  const out = J(h.call('outboundShapeReport_',
    { from: '2026-09-18', to: '2026-09-25', dept: 'Sales', companyView: false, scopeDepts: ['Sales'] },
    b, { Sam: ['Sales'] }, CB_DEPT, null));
  assert.equal(out.callback.episodes, 1);
  assert.equal(out.callback.own, 1, 'the callback counts -- only the ABANDON day decides');
});

test('callbacks: the raw counts drop the day in the SQL and in the sheet twin (abandonedTotal keeps Inbound parity)', function () {
  seed(SALES_DAY);
  const sql = h.call('obCallbackEventsSql_', DEPT_SCOPE, ['A_Q_Sales'], DEPT_SCOPE.from, DEPT_SCOPE.from, DEPT_SCOPE.to, null);
  assert.match(sql.fields, /FROM cb_ab WHERE mine AND d NOT IN \('2026-09-21'::date\) GROUP BY/);
  assert.doesNotMatch(sql.with, /NOT IN/, 'the EVENT rows are untouched: the engine still sees the day');
  const co = h.call('obCallbackEventsSql_', CO_SCOPE, [], CO_SCOPE.from, CO_SCOPE.from, CO_SCOPE.to, null);
  assert.match(co.fields, /FROM cb_ab WHERE mine GROUP BY/, 'company view: a one-department day stays');

  // The sheet twin: the same two abandons, built from the Inbound Calls grid.
  const row = (date, hash, id) => {
    const r = new Array(17).fill('');
    r[0] = date; r[1] = id; r[3] = hash; r[5] = 'abandoned'; r[10] = 'A_Q_Sales'; r[15] = '09:00:00'; r[16] = 'FALSE';
    return r;
  };
  const grid = [row(OUTAGE, 'h1', 'c1'), row('2026-09-22', 'h2', 'c2')];
  const twin = J(h.call('obBuildBlobFromGrids_', CO_SCOPE, [], grid, null, []));
  assert.equal(twin.cbCounts.reduce((s, r) => s + r.n, 0), 2, 'company view keeps both');
  assert.equal(twin.cbAb.length, 2);
  seed(ALL_DAY);
  const twin2 = J(h.call('obBuildBlobFromGrids_', CO_SCOPE, [], grid, null, []));
  assert.equal(twin2.cbCounts.reduce((s, r) => s + r.n, 0), 1, 'the count drops the day');
  assert.equal(twin2.cbAb.length, 2, 'the event rows keep it for the engine');
});

test('direct lines: the counts and the episodes leave the day out, in both sources', function () {
  seed(SALES_DAY);
  const sql = h.call('obDirectEventsSql_', ['Sam'], '2026-09-21', '2026-09-25', 0, 'Sales');
  assert.match(sql.fields, /FROM dl_ab WHERE inw AND d NOT IN \('2026-09-21'::date\) GROUP BY/);
  assert.match(h.call('obDirectEventsSql_', null, '2026-09-21', '2026-09-25', 0, null).fields,
    /FROM dl_ab WHERE inw GROUP BY/, 'company view: a one-department day stays');

  const row = (date, hash, id) => {
    const r = new Array(24).fill('');
    r[0] = date; r[1] = id; r[3] = hash; r[5] = 'missed'; r[15] = '09:00:00'; r[16] = 'FALSE'; r[22] = 'Sam'; r[23] = '20';
    return r;
  };
  const ib = [row(OUTAGE, 'h1', 'c1'), row('2026-09-22', 'h2', 'c2')];
  const ev = J(h.call('obDirectEventsFromGrids_', ['Sam'], '2026-09-21', '2026-09-25', 0, ib, [], 'Sales'));
  assert.equal(ev.dlCounts.reduce((s, r) => s + r.n, 0), 1, 'the sheet twin\'s count');
  assert.equal(ev.dlAb.length, 2, 'the event rows keep it for the engine');

  // obDirectBuild_ reads the team map; this suite has no roster sheet.
  h.ctx.getAllDepartments_ = function () { return ['Sales']; };
  h.ctx.queuesForDept_ = function () { return []; };
  h.ctx.getInboundQueueAliases_ = function () { return []; };
  h.ctx.getOverviewParentMap_ = function () { return {}; };
  const built = h.call('obDirectBuild_', Object.assign({ dlThrough: '2026-10-05' }, ev), DEPT_SCOPE, { Sam: ['Sales'] });
  assert.deepEqual(J(built.eps).map((e) => e.firstIso), ['2026-09-22']);
  assert.deepEqual(J(built.exceptionDays), [{ date: OUTAGE, reason: 'Sales line down' }]);
});

test('the insurer daily drill and both callback drill lists apply the step (source pins)', function () {
  const ib = src('InboundReport.gs');
  const daily = ib.slice(ib.indexOf('function getInboundInsurerDaily'), ib.indexOf('function scanInboundQueueNames_'));
  assert.match(daily, /inboundExcSql_\(scope\.from, scope\.to, scope\.dept \|\| null\)/, 'the drill reconciles with its parent row');
  assert.match(daily, /out\.meta\.exceptionDays = /);
  const ob = src('OutboundReport.gs');
  ['getOutboundUncalled', 'getOutboundCalledBack'].forEach(function (fn) {
    const i = ob.indexOf('function ' + fn + '(');
    const body = ob.slice(i, ob.indexOf('\nfunction ', i + 10));
    assert.match(body, /obEpWithoutExceptions_\(list\.eps, obExcDept_\(scope\)\)/, fn + ' lists the tile\'s own episodes');
    assert.match(body, /out\.meta\.exceptionDays = /, fn + ' says so');
  });
  // The alert reason keeps its own rule: the shared fetcher is not filtered.
  const i = ob.indexOf('function obCallbackListEpisodes_(');
  assert.doesNotMatch(ob.slice(i, ob.indexOf('\nfunction ', i + 10)), /obEpWithoutExceptions_/);
});

test('emails: the note is one sentence, the screen\'s own wording, and empty when nothing was left out', function () {
  const one = h.call('exceptionNoteText_', [{ date: OUTAGE, reason: '8x8 outage', rung: 1234 }]);
  assert.equal(one, '1 exception day left out (Mon Sep 21: 8x8 outage) — 1,234 calls not counted. Every figure here excludes it.');
  const two = h.call('exceptionNoteText_', [{ date: OUTAGE, reason: 'a' }, { date: '2026-09-22', reason: '' }]);
  assert.equal(two, '2 exception days left out (Mon Sep 21: a; Tue Sep 22). Every figure here excludes them.');
  assert.equal(h.call('exceptionNoteText_', []), '');
  assert.equal(h.call('exceptionNoteText_', [{ date: OUTAGE, reason: 'a' }], 'The callback figures exclude it.'),
    '1 exception day left out (Mon Sep 21: a). The callback figures exclude it.');
  // The client twin builds the same sentence (script-1-core excNoteText_).
  const core = src('script-1-core.html');
  assert.match(core, /' exception day' \+ \(list\.length === 1 \? '' : 's'\) \+ ' left out \('/);
  assert.match(core, /'\. Every figure here excludes ' \+ \(list\.length === 1 \? 'it' : 'them'\) \+ '\.'/);

  assert.equal(h.call('ekExceptionNoteRow_', undefined), '', 'no row when nothing was left out');
  const rowHtml = h.call('ekExceptionNoteRow_', [{ date: OUTAGE, reason: '<b>x</b>' }]);
  assert.match(rowHtml, /1 exception day left out/);
  assert.doesNotMatch(rowHtml, /<b>x<\/b>/, 'the reason is free text: escaped');
});

test('emails: every report email whose figures leave days out carries the note row', function () {
  [['DeptSummaryEmail.gs', /ekExceptionNoteRow_\(meta\.exceptionDays\)/],
   ['InboundReport.gs', /ekExceptionNoteRow_\(meta\.exceptionDays\)/],
   ['InsightsReport.gs', /ekExceptionNoteRow_\(data && data\.meta && data\.meta\.exceptionDays\)/],
   ['IndividualReport.gs', /ekExceptionNoteRow_\(f\.exceptionDays, /],
   ['OutboundReport.gs', /ekExceptionNoteRow_\(cb\.exceptionDays, /],
  ].forEach(function (p) { assert.match(src(p[0]), p[1], p[0]); });
  // An agent's copy names the day and its reason, never the department's volume on it.
  assert.match(src('IndividualReport.gs'), /\.map\(function \(e\) \{ return \{ date: e\.date, reason: e\.reason \}; \}\)/);
});

test('client: the part-of-page note is wired on each surface, and the inbound drills follow the admin switch', function () {
  const s9 = src('script-9-inbound-direct.html');
  assert.match(s9, /excPartHtml_\(cb\.exceptionDays, 'These callback figures exclude'\)/, 'the callback summary');
  assert.equal((s9.match(/excPartHtml_\(meta\.exceptionDays, 'This list excludes'\)/g) || []).length, 3, 'three drill lists');
  assert.match(s9, /excPartText_\(meta\.exceptionDays, 'These direct-line figures exclude'\)/, 'direct lines');
  assert.match(src('script-3-overview.html'), /excPartText_\(cb\.exceptionDays, 'These callback figures exclude'\)/, 'Overview callbacks');
  ['getInboundInsurerDaily', 'getInboundHeatmap', 'getInboundHeatmapCell'].forEach(function (fn) {
    assert.match(s9, new RegExp('\\.' + fn + '\\(excReq_\\('), fn + ' passes the include switch like its parent report');
  });
  // It is deliberately not the page-level `.exc-note` the switch repaints.
  const core = src('script-1-core.html');
  const i = core.indexOf('function excPartHtml_(');
  assert.doesNotMatch(core.slice(i, i + 300), /class="[^"]*\bexc-note\b/);
});
