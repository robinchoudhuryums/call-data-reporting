'use strict';

// EXC-2 -- exception days phase 2 (owner 2026-11-06, Operator State #81).
// Phase 1 left an exception day out of every DQE / QCD figure; the per-call
// reports kept counting it. Pinned here:
//   - the shared SQL form (exceptionNotInSql_): '' with no exception day (the
//     query is then exactly what it was), all-department vs one-department
//     days, the company view's per-row department form, the admin include
//     switch;
//   - each surface wiring it in: the Inbound report (current + prior + the
//     transfer tallies), the Direct Calls report (Neon + sheet fallback + the
//     missing-workday rule), the Overview tiles' outbound and direct lines,
//     and My Department's outbound table (agents grouped under ONE dept);
//   - the call-level views MARK a call instead of hiding it (Caller Lookup,
//     the call path drill, Agent Day).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const J = (x) => JSON.parse(JSON.stringify(x));
const OUTAGE = { date: '2026-09-21', depts: [], reason: '8x8 outage' };
const DRILL = { date: '2026-09-23', depts: ['CSR'], reason: 'Fire drill' };

function withDays(h, days, include) {
  h.ctx.getExceptionDays_ = function () { return days.map(function (d) { return Object.assign({}, d, { depts: d.depts.slice() }); }); };
  h.ctx.exceptionIncludeOn_ = function () { return !!include; };
}

// ── The shared SQL form ────────────────────────────────────────────────────

const u = loadGas({ files: ['Config.gs', 'Util.gs'] });

test('exceptionNotInSql_: no exception day -> "" (every query exactly what it was)', function () {
  withDays(u, []);
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', null), '');
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', 'CSR', 'c.department'), '');
});

test('exceptionNotInSql_: an all-department day leaves every scope; a day outside the window is ignored', function () {
  withDays(u, [OUTAGE, { date: '2026-10-05', depts: [], reason: 'later' }]);
  const want = " AND c.call_date NOT IN ('2026-09-21'::date)";
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', null), want);
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', 'Sales'), want);
});

test('exceptionNotInSql_: a one-department day leaves THAT department only; the company view keeps it unless rows carry a department', function () {
  withDays(u, [OUTAGE, DRILL]);
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', 'CSR'),
    " AND c.call_date NOT IN ('2026-09-21'::date, '2026-09-23'::date)");
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', 'Sales'),
    " AND c.call_date NOT IN ('2026-09-21'::date)");
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', null),
    " AND c.call_date NOT IN ('2026-09-21'::date)", 'a company figure keeps a one-department day');
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', null, 'c.department'),
    " AND c.call_date NOT IN ('2026-09-21'::date) AND NOT (c.call_date = '2026-09-23'::date AND c.department IN ('CSR'))",
    'rows that carry their department drop the scoped day for that department, so the cards add up');
});

test('exceptionNotInSql_: an admin who includes them gets ""; a department name is SQL-escaped', function () {
  withDays(u, [OUTAGE], true);
  assert.equal(u.call('exceptionNotInSql_', 'c.call_date', '2026-09-01', '2026-09-30', null), '');
  withDays(u, [{ date: '2026-09-23', depts: ["O'Brien Ops"], reason: '' }]);
  assert.match(u.call('exceptionNotInSql_', 'call_date', '2026-09-01', '2026-09-30', null, 'department'),
    /department IN \('O''Brien Ops'\)/);
});

test('exceptionDaysNoteFor_: absent with none; a company view can name a scoped day with its departments', function () {
  withDays(u, []);
  assert.equal(u.call('exceptionDaysNoteFor_', '2026-09-01', '2026-09-30', null), undefined);
  withDays(u, [OUTAGE, DRILL]);
  assert.deepEqual(J(u.call('exceptionDaysNoteFor_', '2026-09-01', '2026-09-30', 'CSR')),
    [{ date: '2026-09-21', reason: '8x8 outage' }, { date: '2026-09-23', reason: 'Fire drill' }]);
  assert.deepEqual(J(u.call('exceptionDaysNoteFor_', '2026-09-01', '2026-09-30', null)),
    [{ date: '2026-09-21', reason: '8x8 outage' }]);
  assert.deepEqual(J(u.call('exceptionDaysNoteFor_', '2026-09-01', '2026-09-30', null, true)),
    [{ date: '2026-09-21', reason: '8x8 outage' }, { date: '2026-09-23', reason: 'Fire drill — CSR only' }]);
});

test('exceptionDayMark_: the call-level label; ignores the include switch (nothing there is left out)', function () {
  withDays(u, [OUTAGE, DRILL], true);
  assert.deepEqual(J(u.call('exceptionDayMark_', '2026-09-21')), { date: '2026-09-21', reason: '8x8 outage' });
  assert.deepEqual(J(u.call('exceptionDayMark_', '2026-09-23')), { date: '2026-09-23', reason: 'Fire drill — CSR only' });
  assert.equal(u.call('exceptionDayMark_', '2026-09-23', 'Sales'), null, 'scoped to another department');
  assert.equal(u.call('exceptionDayMark_', '2026-09-23', null), null, 'null = all-department days only');
  assert.ok(u.call('exceptionDayMark_', '2026-09-23', 'CSR'));
  assert.equal(u.call('exceptionDayMark_', '2026-09-22'), null);
});

// ── Inbound report ────────────────────────────────────────────────────────

function capturingConn(sqls, bodyFor) {
  return {
    createStatement: function () {
      return {
        executeQuery: function (sql) {
          sqls.push(String(sql));
          let done = false;
          const body = bodyFor ? bodyFor(String(sql)) : '{}';
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return body; },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

const ib = loadGas({ files: ['Config.gs', 'Util.gs', 'InboundReport.gs'] });

function ibRun(days, scope) {
  withDays(ib, days);
  const sqls = [];
  ib.ctx.getDashboardNeonConn_ = function () { return capturingConn(sqls, function (s) {
    return s.indexOf('information_schema') !== -1 ? '' : JSON.stringify({ kpis: {}, kpisPrior: {} });
  }); };
  ib.ctx.computePriorWindow_ = function () { return { from: '2026-09-14', to: '2026-09-18' }; };
  ib.ctx.inboundDeptPredicate_ = function (dept) { return dept ? " AND c.entry_queue = 'A_Q_CSR'" : ''; };
  ib.ctx.inboundDialInLabels_ = function () { return {}; };
  const out = ib.call('computeInboundReport_', Object.assign({ from: '2026-09-21', to: '2026-09-25', dept: '',
    deptQueues: [], companyView: true }, scope || {}));
  return { out: out, sql: sqls.filter(function (s) { return s.indexOf('json_build_object') !== -1; }).pop() || '' };
}

test('Inbound: no exception day -> the report SQL is byte-identical to the pre-EXC-2 query and meta has no exceptionDays', function () {
  const none = ibRun([]);
  assert.equal(none.sql.indexOf('NOT IN'), -1);
  assert.equal(none.out.meta.exceptionDays, undefined);
});

test('Inbound: every current-window figure and the transfer tallies leave the day; the prior window too', function () {
  const r = ibRun([OUTAGE, { date: '2026-09-15', depts: [], reason: 'prior outage' }]);
  const cur = (r.sql.match(/c\.call_date NOT IN \('2026-09-21'::date\)/g) || []).length;
  // dr (kpis, byInsurer, byDialIn, byQueue, byDialInInsurer, daily), drOutside, xferUn
  assert.ok(cur >= 8, 'current-window clause count ' + cur);
  assert.match(r.sql, /x\.call_date NOT IN \('2026-09-21'::date\)/, 'the S2C-2 tally (aliased x) leaves it too');
  assert.match(r.sql, /c\.call_date NOT IN \('2026-09-15'::date\)/, 'the prior window leaves its own exception day');
  assert.deepEqual(J(r.out.meta.exceptionDays), [{ date: '2026-09-21', reason: '8x8 outage' }]);
});

test('Inbound: a one-department day leaves that department view only', function () {
  const csr = ibRun([{ date: '2026-09-22', depts: ['CSR'], reason: 'drill' }],
    { dept: 'CSR', deptQueues: ['A_Q_CSR'], companyView: false });
  assert.match(csr.sql, /NOT IN \('2026-09-22'::date\)/);
  const company = ibRun([{ date: '2026-09-22', depts: ['CSR'], reason: 'drill' }]);
  assert.equal(company.sql.indexOf('NOT IN'), -1, 'the company view keeps a one-department day');
});

// ── Direct Calls report ───────────────────────────────────────────────────

const dc = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'DirectCallReport.gs'] });

function dcInstall(days) {
  withDays(dc, days);
  dc.ctx.computePriorWindow_ = function () { return { from: '2026-09-14', to: '2026-09-18' }; };
  dc.ctx.getCompanyHolidayRanges_ = function () { return []; };
  dc.ctx.isIsoDate_ = function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(String(x)); };
}

test('Direct (Neon): every figure query leaves the day, the company view per row department; the coverage read does not', function () {
  dcInstall([OUTAGE, DRILL]);
  const sqls = [];
  dc.ctx.getDashboardNeonConn_ = function () { return capturingConn(sqls, function (s) {
    if (s.indexOf("'mx'") !== -1) return JSON.stringify({ mx: '2026-09-25', days: ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'] });
    if (s.indexOf('WITH m AS') === 0) return '[]';
    return JSON.stringify({ kpis: {}, agents: [], kpisPrior: {}, deptsPrior: [] });
  }); };
  const out = dc.call('computeDirectCallReport_', { from: '2026-09-21', to: '2026-09-25', dept: '', companyView: true });
  const cov = sqls.filter(function (s) { return s.indexOf("'mx'") !== -1; })[0];
  assert.equal(cov.indexOf('NOT'), -1, 'the coverage read sees every date (it decides what is missing, not what counts)');
  const main = sqls.filter(function (s) { return s.indexOf("'kpis'") !== -1; })[0];
  assert.match(main, /c\.call_date NOT IN \('2026-09-21'::date\) AND NOT \(c\.call_date = '2026-09-23'::date AND c\.department IN \('CSR'\)\)/);
  const via = sqls.filter(function (s) { return s.indexOf('WITH m AS') === 0; })[0];
  assert.match(via, /c\.call_date NOT IN \('2026-09-21'::date\)/, 'the DID-2 split reconciles with the figures');
  assert.deepEqual(J(out.meta.exceptionDays).map(function (d) { return d.reason; }), ['8x8 outage', 'Fire drill — CSR only']);
});

test('Direct: an exception day with no rows is not a "missing workday"', function () {
  dcInstall([OUTAGE]);
  const fn = dc.call('dcHolidayFn_', { companyView: true, dept: '' });
  assert.equal(fn('2026-09-21'), true);
  assert.equal(fn('2026-09-22'), false);
  const miss = dc.call('dcMissingWorkdays_', '2026-09-21', '2026-09-22', { '2026-09-22': true }, fn);
  assert.equal(miss.count, 0);
});

test('Direct (sheet fallback): a row on an exception day for its own department is left out', function () {
  dcInstall([DRILL]);
  dc.ctx.getDashboardNeonConn_ = function () { return null; };
  const rows = [
    ['Sep 2026', '2026-09-23', 'CSR', 'Ana',  2, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ['Sep 2026', '2026-09-23', 'Sales', 'Cara', 3, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ['Sep 2026', '2026-09-24', 'CSR', 'Ana',  1, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  dc.ctx.openSpreadsheet_ = function () { return { getSheetByName: function () {
    return { getLastRow: function () { return rows.length + 1; },
      getRange: function (r0, c0, nr, nc) { return { getDisplayValues: function () {
        const out = [];
        for (let i = 0; i < nr; i++) { const src = rows[r0 - 2 + i] || []; const line = [];
          for (let c = 0; c < nc; c++) line.push(src[c0 - 1 + c] == null ? '' : String(src[c0 - 1 + c])); out.push(line); }
        return out; } }; } };
  } }; };
  const out = dc.call('computeDirectCallReport_', { from: '2026-09-23', to: '2026-09-24', dept: '', companyView: true });
  assert.equal(out.meta.fallbackSource, 'sheet');
  assert.equal(out.kpis.ibAnswered, 3 + 1, "CSR's drill-day row left; Sales' row on the same day kept");
});

// ── Overview tiles: outbound + direct lines ───────────────────────────────

const ov = loadGas({ files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs'] });
const W = { readFromIso: '2026-09-01', trendStartIso: '2026-09-01', last60StartIso: '2026-08-01',
            last90StartIso: '2026-07-01', ytdStartIso: '2026-01-01' };

test('Overview outbound: no exception day -> no clause and no xd group', function () {
  withDays(ov, []);
  const sql = ov.call('ovOutboundSql_', W, '2026-09-25', {}, {});
  assert.equal(sql.indexOf('NOT IN'), -1);
  assert.equal(sql.indexOf('xd'), -1);
  assert.match(sql, /GROUP BY agent_name\) t\)/);
});

test('Overview outbound: an all-department day leaves the read; a scoped one is grouped out and dropped for its departments only', function () {
  withDays(ov, [OUTAGE, DRILL]);
  const scoped = ov.call('ovScopedExceptionDays_', '2026-01-01', '2026-09-25');
  assert.deepEqual(J(scoped), { '2026-09-23': ['CSR'] });
  const sql = ov.call('ovOutboundSql_', W, '2026-09-25', {}, scoped);
  assert.match(sql, /call_date NOT IN \('2026-09-21'::date\)/);
  assert.match(sql, /CASE WHEN call_date IN \('2026-09-23'::date\) THEN call_date::text END AS xd/);
  assert.match(sql, /GROUP BY agent_name, 2\) t\)/);
  // Ana is on CSR and Sales: her drill-day calls leave CSR's tile and stay on Sales'.
  const raw = { coverageStart: '2026-01-01', agents: [
    { agent: 'Ana', p_last30: 10, c_last30: 5 },
    { agent: 'Ana', xd: '2026-09-23', p_last30: 4, c_last30: 2 },
  ] };
  const shaped = ov.call('ovOutboundShape_', raw, ['CSR', 'Sales'], { Ana: ['CSR', 'Sales'] }, W, '2026-09-25', {}, scoped);
  assert.equal(shaped.byDept.CSR.last30.placed, 10);
  assert.equal(shaped.byDept.Sales.last30.placed, 14);
});

test('Overview direct: rows carry their department, so a scoped day leaves that department only', function () {
  withDays(ov, [OUTAGE, DRILL]);
  const sql = ov.call('ovDirectSql_', W, '2026-09-25', {});
  assert.match(sql, /call_date NOT IN \('2026-09-21'::date\) AND NOT \(call_date = '2026-09-23'::date AND department IN \('CSR'\)\)/);
  withDays(ov, []);
  assert.equal(ov.call('ovDirectSql_', W, '2026-09-25', {}).indexOf('NOT'), -1);
});

// ── My Department outbound table ──────────────────────────────────────────

const ob = loadGas({ files: ['Config.gs', 'Util.gs', 'OutboundReport.gs'] });

test('My Department outbound: all-department days by date, a scoped day by the agents grouped under that dept', function () {
  withDays(ob, [OUTAGE, { date: '2026-09-23', depts: ['PAP'], reason: 'drill' }, { date: '2026-09-24', depts: ['Field Ops'], reason: 'elsewhere' }]);
  const scope = { dept: 'Sales', from: '2026-09-21', to: '2026-09-25', scopeDepts: ['Sales', 'PAP'] };
  // Ana is on both rosters (grouped under Sales, the parent wins); Pat is PAP-only.
  const exc = ob.call('deptObExceptions_', scope, { Ana: ['Sales', 'PAP'], Pat: ['PAP'], Zed: ['Field Ops'] });
  assert.equal(exc.sql, " AND o.call_date NOT IN ('2026-09-21'::date)"
    + " AND NOT (o.call_date = '2026-09-23'::date AND COALESCE(trim(o.agent_name), '') IN ('Pat'))");
  assert.equal(exc.skip('2026-09-21', 'Ana'), true);
  assert.equal(exc.skip('2026-09-23', 'Pat'), true);
  assert.equal(exc.skip('2026-09-23', 'Ana'), false, 'Ana is grouped under Sales, which the drill did not touch');
  assert.equal(exc.skip('2026-09-24', 'Zed'), false, 'a day for a department outside the view');
  assert.deepEqual(J(exc.days).map(function (d) { return d.date; }), ['2026-09-21', '2026-09-23']);
  withDays(ob, []);
  const none = ob.call('deptObExceptions_', scope, { Ana: ['Sales'] });
  assert.equal(none.sql, '');
  assert.equal(none.skip, null);
});

test('outboundAgentsSel_: the clause sits inside the WHERE; without it the SQL is unchanged', function () {
  const base = ob.call('outboundAgentsSel_', '2026-09-21', '2026-09-25');
  const withExc = ob.call('outboundAgentsSel_', '2026-09-21', '2026-09-25', " AND o.call_date NOT IN ('2026-09-21'::date)");
  assert.equal(withExc.replace(" AND o.call_date NOT IN ('2026-09-21'::date)", ''), base);
  assert.match(withExc, /::date AND o\.call_date NOT IN \('2026-09-21'::date\) GROUP BY 1/);
});

test('obAgentsFromGrid_: the skip test drops the same calls the SQL clause does', function () {
  const grid = [
    ['2026-09-21', '', '', 'Ana', '', '', 'TRUE', 60, '', 1],
    ['2026-09-22', '', '', 'Ana', '', '', 'TRUE', 30, '', 1],
  ];
  ob.ctx.ncCellDateIso_ = function (v) { return String(v); };
  const all = J(ob.call('obAgentsFromGrid_', grid, '2026-09-21', '2026-09-22'));
  const kept = J(ob.call('obAgentsFromGrid_', grid, '2026-09-21', '2026-09-22', function (iso) { return iso === '2026-09-21'; }));
  assert.equal(all[0].ob_total, 2);
  assert.equal(kept[0].ob_total, 1);
});

// ── Call-level views mark, never hide ─────────────────────────────────────

const cl = loadGas({ files: ['Config.gs', 'Util.gs', 'CallerLookup.gs'] });

test('Caller Lookup: an inbound or outbound call on an exception day carries the mark; others carry none', function () {
  withDays(cl, [OUTAGE]);
  assert.deepEqual(J(cl.call('callerLookupShapeCall_', { call_date: '2026-09-21' }).exceptionDay),
    { date: '2026-09-21', reason: '8x8 outage' });
  assert.equal(cl.call('callerLookupShapeCall_', { call_date: '2026-09-22' }).exceptionDay, undefined);
  assert.ok(cl.call('callerLookupShapeOutbound_', { call_date: '2026-09-21' }).exceptionDay);
});

test('the call path drill: a found call on an exception day is marked; a miss is not', function () {
  const ij = loadGas({ files: ['Config.gs', 'Util.gs', 'InboundReport.gs'] });
  withDays(ij, [OUTAGE]);
  ij.ctx.getCallJourneyImpl_ = function (req) {
    return req.callId === 'hit' ? { available: true, found: true, call: { callDate: '2026-09-21' } }
      : { available: true, found: false };
  };
  assert.deepEqual(J(ij.call('getCallJourney', { callId: 'hit', date: '2026-09-21' }).exceptionDay),
    { date: '2026-09-21', reason: '8x8 outage' });
  assert.equal(ij.call('getCallJourney', { callId: 'miss', date: '2026-09-21' }).exceptionDay, undefined);
});
