'use strict';

// OVD-1 (owner 2026-11-02, from the approved mock): the Overview dept tile's
// split bar shows the DIRECT-LINE answer rate -- answered / (answered + missed
// while free), a ring while on another call shown but left out of the rate
// (the Direct Calls report's rule). One grouped Neon read of
// direct_call_history by department, on the SAME connection as the outbound
// line, in the cached blob, admin-only (stripped for everyone else).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'CompanyOverview.gs', 'Data.gs'] });
const LATEST = '2026-09-21';
const DEPTS = ['CSR', 'Spanish', 'Sales', 'PAP', 'CSR Backup'];
const PERIODS = ['yesterday', 'last30', 'last60', 'last90', 'ytd'];

function dal(date, agent, r, m, a) {
  return { dateIso: date, agent: agent, totalUnique: r, totalRung: r, totalMissed: m, totalAnswered: a,
           tttSec: a * 90, attSec: 90, avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0, queueSplit: '' };
}
function deptRow(dept, a, mf, mb, pa, pmf) {
  const r = { dept: dept };
  PERIODS.forEach(function (k, i) {
    r['da_' + k] = a[i]; r['dmf_' + k] = mf[i]; r['dmb_' + k] = mb[i];
    if (pa) { r['pda_' + k] = pa[i]; r['pdmf_' + k] = pmf[i]; }
  });
  return r;
}
const DIRECT = { coverageStart: '2026-07-10', through: LATEST, depts: [
  deptRow('CSR', [18, 300, 500, 700, 900], [2, 30, 50, 70, 100], [1, 9, 9, 9, 9], [17, 280, 400, 400, 400], [3, 40, 60, 60, 60]),
  deptRow('Sales', [0, 40, 40, 40, 40], [0, 10, 10, 10, 10], [2, 2, 2, 2, 2], [6, 30, 30, 30, 30], [2, 10, 10, 10, 10]),
  deptRow('Gone Dept', [5, 5, 5, 5, 5], [5, 5, 5, 5, 5], [5, 5, 5, 5, 5]),
] };
const OUTBOUND = { coverageStart: '2026-07-10', agents: [] };

let conn;
function fakeConn(opts) {
  opts = opts || {};
  const c = { sql: [], closed: false, opened: 0 };
  c.createStatement = function () {
    return {
      executeQuery: function (sql) {
        c.sql.push(sql);
        const direct = /FROM direct_call_history/.test(sql);
        if (direct && opts.directThrows) throw new Error('direct boom');
        if (!direct && opts.outboundThrows) throw new Error('outbound boom');
        const json = direct ? (opts.directJson === undefined ? JSON.stringify(DIRECT) : opts.directJson) : JSON.stringify(OUTBOUND);
        let read = false;
        return { next: function () { if (read) return false; read = true; return true; },
                 getString: function () { return json; }, close: function () {} };
      },
      close: function () {},
    };
  };
  c.close = function () { c.closed = true; };
  return c;
}

function install(opts) {
  opts = opts || {};
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 301', 'Bob, 302'], Spanish: ['Anna, 301'],
      Sales: ['Cara, 401'], PAP: ['Dev, 501'], 'CSR Backup': ['Hidden Hal, 601'] }),
    'DQE Historical Data': [['h'], ['x']],
    'Alert Log': [['Timestamp', 'Dept', 'Date', 'Rate', 'Threshold', 'Status', 'Sent', 'Triggered By']],
  } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
  h.ctx.COMPANY_HOLIDAYS_SOURCE_ = '';
  h.ctx.getAllDepartments_ = function () { return DEPTS.slice(); };
  h.ctx.resolveUser_ = function () {
    return opts.user || { email: 'admin@x.com', role: 'admin', department: null, departments: DEPTS.slice(), allDepts: false };
  };
  h.ctx.getLatestDataDate = function () { return LATEST; };
  h.ctx.getDqeReadSource_ = function () { return 'sheet'; };
  h.ctx.sheetFetchDqeRows_ = function () { return [dal(LATEST, 'Anna', 10, 2, 8), dal(LATEST, 'Cara', 7, 0, 7)]; };
  h.ctx.inboundQueuesForDept_ = function () { return []; };
  h.ctx.computeQcdSnapshots_ = function () { return { _companyDaily: {} }; };
  h.ctx.computeOverviewPipelineFreshness_ = function () { return null; };
  h.ctx.computeOverviewOrphanNag_ = function () { return null; };
  h.ctx.computeOverviewUnmappedQcd_ = function () { return null; };
  h.ctx.logReportUsage_ = function () {};
  h.ctx.egress = [];
  h.ctx.neonNoteEgress_ = function (bytes, label) { h.ctx.egress.push(label); };
  conn = opts.noConn ? null : fakeConn(opts);
  if (opts.noHelper) delete h.ctx.getDashboardNeonConn_;
  else h.ctx.getDashboardNeonConn_ = function () { if (conn) conn.opened++; return conn; };
  // Release the outbound gate so a manager test isolates the DIRECT strip.
  if (opts.obGate === undefined) delete h.ctx.OUTBOUND_VETTING_GATE_;
  else h.ctx.OUTBOUND_VETTING_GATE_ = opts.obGate;
}
function tile(p, name) { return p.depts.filter(function (d) { return d.name === name; })[0]; }
const plain = function (x) { return JSON.parse(JSON.stringify(x)); };

test('OVD-1: the SQL sums answered / missed free / missed busy per department for the five card periods + their INV-28 priors', function () {
  const w = h.call('ovWindows_', LATEST);
  const pw = h.call('ovOutboundPriorWindows_', w, LATEST);
  const sql = h.call('ovDirectSql_', w, LATEST, pw);
  assert.match(sql, new RegExp("COALESCE\\(sum\\(ib_int_answered\\+ib_ext_answered\\) FILTER \\(WHERE call_date = '" + LATEST + "'::date\\), 0\\) AS da_yesterday"));
  assert.match(sql, new RegExp("sum\\(ib_int_missed_free\\+ib_ext_missed_free\\) FILTER \\(WHERE call_date >= '" + w.trendStartIso + "'::date\\), 0\\) AS dmf_last30"));
  assert.match(sql, new RegExp("sum\\(ib_int_missed_busy\\+ib_ext_missed_busy\\) FILTER \\(WHERE call_date >= '" + w.ytdStartIso + "'::date\\), 0\\) AS dmb_ytd"));
  PERIODS.forEach(function (k) {
    assert.ok(sql.indexOf("FILTER (WHERE call_date BETWEEN '" + pw[k].from + "'::date AND '" + pw[k].to + "'::date), 0) AS pda_" + k) !== -1, 'pda_' + k);
    assert.ok(sql.indexOf('AS pdmf_' + k) !== -1, 'pdmf_' + k);
  });
  assert.match(sql, /GROUP BY department\) t\)/, 'one row per department -- the table carries it, no roster map');
  assert.match(sql, /json_agg\(t\)/, 'one json string per read (the neon-layer json_agg rule)');
  assert.match(sql, /'through', \(SELECT MAX\(call_date\)::text FROM direct_call_history\)/);
  const lo = PERIODS.map(function (k) { return pw[k].from; }).concat([w.readFromIso]).sort()[0];
  assert.ok(sql.indexOf("WHERE call_date BETWEEN '" + lo + "'::date AND '" + LATEST + "'::date GROUP BY") !== -1,
    'the read widens to the earliest prior window');
  assert.doesNotMatch(sql, /p_yesterday/, 'never mistaken for the outbound read');
});

test('OVD-1: shaping -- the rate leaves busy rings out, an unknown dept is dropped, a period before capture is partial with no prior', function () {
  const w = h.call('ovWindows_', LATEST);
  const pw = h.call('ovOutboundPriorWindows_', w, LATEST);
  const out = h.call('ovDirectShape_', DIRECT, DEPTS, w, LATEST, pw);
  assert.deepEqual(plain(out.byDept.CSR.yesterday), { answered: 18, missedFree: 2, missedBusy: 1, rate: 90, partial: false,
    prior: { answered: 17, missedFree: 3, rate: 85 } }, '18 / (18 + 2): the busy ring is not in the rate');
  assert.equal(out.byDept.Sales.yesterday.rate, null, 'only busy rings: nothing to rate, never a divide-by-zero');
  assert.equal(out.byDept.Sales.yesterday.missedBusy, 2);
  assert.deepEqual(plain(out.byDept.PAP.last30), { answered: 0, missedFree: 0, missedBusy: 0, rate: null, partial: false,
    prior: { answered: 0, missedFree: 0, rate: null } }, 'a covered window with no calls is a real zero');
  assert.equal(out.byDept['Gone Dept'], undefined, 'a department the roster does not know is dropped');
  assert.equal(out.byDept.CSR.ytd.partial, true);
  ['last60', 'last90', 'ytd'].forEach(function (k) {
    assert.ok(pw[k].from < '2026-07-10', k + ' fixture');
    assert.equal(out.byDept.CSR[k].prior, null, k + ': no comparison against an uncaptured period');
  });
  assert.equal(out.through, LATEST);
  assert.equal(out.coverageStart, '2026-07-10');
  assert.equal(h.call('ovDirectRate_', 3, 1), 75);
});

test('OVD-1: an admin gets each tile’s direct block + coverage, through, prior windows -- one connection, two metered reads', function () {
  install({});
  const p = h.call('getCompanyOverview', {});
  assert.equal(tile(p, 'CSR').direct.yesterday.rate, 90);
  assert.equal(tile(p, 'Spanish').direct.yesterday.answered, 0, 'a dept with no rows carries the zero block');
  assert.equal(p.directCoverageStart, '2026-07-10');
  assert.equal(p.directThrough, LATEST);
  assert.ok(p.directPriorWindows && p.directPriorWindows.last30.from);
  assert.equal(conn.opened, 1);
  assert.ok(conn.closed);
  assert.deepEqual(h.ctx.egress, ['overviewOutbound', 'overviewDirect']);
  const again = h.call('getCompanyOverview', { auto: true });
  assert.equal(conn.opened, 1, 'the 5-min auto-refresh is served from the cached blob');
  assert.equal(tile(again, 'CSR').direct.last30.answered, 300);
});

test('OVD-1: stripped for every non-admin -- a manager, an all-departments manager, View-as -- even with the outbound gate released', function () {
  const check = function (p, who) {
    ['directCoverageStart', 'directThrough', 'directPriorWindows'].forEach(function (k) { assert.equal(p[k], undefined, who + ' ' + k); });
    p.depts.forEach(function (d) { assert.equal(d.direct, undefined, who + ' ' + d.name); });
  };
  install({ obGate: false, user: { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] } });
  const m = h.call('getCompanyOverview', {});
  check(m, 'manager');
  assert.ok(tile(m, 'CSR').outbound, 'the outbound line follows its OWN gate (released here)');
  install({ obGate: false, user: { email: 'a@x.com', role: 'manager', allDepts: true, department: null, departments: DEPTS.slice() } });
  check(h.call('getCompanyOverview', {}), 'all-dept manager');
  install({ obGate: false });
  check(h.call('getCompanyOverview', { viewAsDept: 'CSR' }), 'view-as');
  // The strip never touches the shared cached blob.
  const a = h.call('getCompanyOverview', {});
  assert.equal(tile(a, 'CSR').direct.yesterday.rate, 90);
});

test('OVD-1: each read fails on its own -- a broken direct read keeps the outbound line, and the reverse', function () {
  install({ directThrows: true });
  let p = h.call('getCompanyOverview', {});
  assert.equal(tile(p, 'CSR').direct, undefined);
  assert.equal(p.directThrough, undefined);
  assert.ok(tile(p, 'CSR').outbound, 'outbound unaffected');
  assert.ok(conn.closed);
  install({ outboundThrows: true });
  p = h.call('getCompanyOverview', {});
  assert.equal(tile(p, 'CSR').outbound, undefined);
  assert.equal(tile(p, 'CSR').direct.yesterday.rate, 90, 'direct unaffected');
  install({ directJson: null });
  assert.equal(tile(h.call('getCompanyOverview', {}), 'CSR').direct, undefined, 'an empty result = no line');
  [{ noHelper: true }, { noConn: true }].forEach(function (o) {
    install(o);
    const q = h.call('getCompanyOverview', {});
    q.depts.forEach(function (d) { assert.equal(d.direct, undefined); assert.equal(d.outbound, undefined); });
  });
});

test('OVD-1: the client draws the direct row (the tile’s bar) whenever shipped, and the outbound connected bar only without it', function () {
  const dir = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
  const src = fs.readFileSync(path.join(dir, 'script-3-overview.html'), 'utf8');
  const line = src.slice(src.indexOf('function ovBuildOutboundLine_'), src.indexOf('function ovBuildObRow_'));
  assert.match(line, /return ovBuildObRow_\(dept\) \+ ovBuildDirectLine_\(dept\);/, 'both call sites (tile + sub-queue card) get both rows');
  assert.match(line, /var dl = dept && dept\.direct && dept\.direct\[ovCardPeriod\];\s*if \(!dl\) return '';/);
  assert.match(line, /\{ cls: 'good', n: a, label: 'answered' \},\s*\{ cls: 'bad', n: mf, label: 'missed while free' \},\s*\{ cls: 'soft', n: mb, label: 'missed while on another call' \}/);
  assert.match(line, /obRateChip_\(dl\.rate, pr\.rate, a \+ mf,/, 'the chip is in points and mutes on a thin window, like the outbound rate');
  const ob = src.slice(src.indexOf('function ovBuildObRow_'), src.indexOf('function ovBuildGridTile_'));
  assert.match(ob, /var obBar = ob\.placed > 0 && !\(dept\.direct && dept\.direct\[ovCardPeriod\]\)/);
});
