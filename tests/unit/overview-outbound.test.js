'use strict';

// Batch E2: the Overview dept tiles' OUTBOUND line. One grouped Neon read of
// outbound_calls, bucketed into the same five card periods as the inbound
// stats and attributed through the same roster map, computed INSIDE the cached
// Overview blob (so the 5-minute auto-refresh never reaches Neon) and stripped
// for everyone but admins while OUTBOUND_VETTING_GATE_ stands (6c).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'CompanyOverview.gs', 'Data.gs'] });
const LATEST = '2026-09-21';
const DEPTS = ['CSR', 'Spanish', 'Sales', 'PAP', 'CSR Backup'];

function dal(date, agent, r, m, a) {
  return { dateIso: date, agent: agent, totalUnique: r, totalRung: r, totalMissed: m, totalAnswered: a,
           tttSec: a * 90, attSec: 90, avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0, queueSplit: '' };
}

// Per-agent period counts in the shape ovOutboundSql_'s json_agg returns.
function agentRow(agent, p, c) {
  const r = { agent: agent };
  ['yesterday', 'last30', 'last60', 'last90', 'ytd'].forEach(function (k, i) {
    r['p_' + k] = p[i]; r['c_' + k] = c[i];
  });
  return r;
}
const NEON_JSON = JSON.stringify({
  coverageStart: '2026-07-10',
  agents: [
    agentRow('Anna', [5, 40, 70, 90, 120], [2, 20, 35, 45, 60]),   // CSR + Spanish
    agentRow('Bob',  [3, 10, 10, 10, 10],  [3, 5, 5, 5, 5]),       // CSR
    agentRow('Off Roster', [9, 9, 9, 9, 9], [9, 9, 9, 9, 9]),      // no dept
  ],
});

let conn;
function fakeConn(json, opts) {
  const c = { sql: [], closed: false, opened: 0 };
  c.createStatement = function () {
    return {
      executeQuery: function (sql) {
        c.sql.push(sql);
        if (opts && opts.throws) throw new Error('boom');
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
  h.ctx.sheetFetchDqeRows_ = function () {
    return [dal(LATEST, 'Anna', 10, 2, 8), dal(LATEST, 'Bob', 6, 1, 5), dal(LATEST, 'Cara', 7, 0, 7)];
  };
  h.ctx.inboundQueuesForDept_ = function () { return []; };
  h.ctx.computeQcdSnapshots_ = function () { return { _companyDaily: {} }; };
  h.ctx.computeOverviewPipelineFreshness_ = function () { return null; };
  h.ctx.computeOverviewOrphanNag_ = function () { return null; };
  h.ctx.computeOverviewUnmappedQcd_ = function () { return null; };
  h.ctx.logReportUsage_ = function () {};
  h.ctx.egress = [];
  h.ctx.neonNoteEgress_ = function (bytes, label) { h.ctx.egress.push(label); };
  conn = opts.noConn ? null : fakeConn(opts.json === undefined ? NEON_JSON : opts.json, opts);
  if (opts.noHelper) delete h.ctx.getDashboardNeonConn_;
  else h.ctx.getDashboardNeonConn_ = function () { if (conn) conn.opened++; return conn; };
  if (opts.gate === undefined) delete h.ctx.OUTBOUND_VETTING_GATE_;
  else h.ctx.OUTBOUND_VETTING_GATE_ = opts.gate;
}
function tile(p, name) { return p.depts.filter(function (d) { return d.name === name; })[0]; }

test('E2: the SQL buckets the SAME five card periods the inbound stats use, over the existing read window', function () {
  const w = h.call('ovWindows_', LATEST);
  const sql = h.call('ovOutboundSql_', w, LATEST);
  assert.match(sql, new RegExp("count\\(\\*\\) FILTER \\(WHERE call_date = '" + LATEST + "'::date\\) AS p_yesterday"));
  assert.match(sql, new RegExp("FILTER \\(WHERE call_date >= '" + w.trendStartIso + "'::date AND connected\\) AS c_last30"));
  assert.match(sql, new RegExp("call_date >= '" + w.last60StartIso + "'::date\\) AS p_last60"));
  assert.match(sql, new RegExp("call_date >= '" + w.last90StartIso + "'::date\\) AS p_last90"));
  assert.match(sql, new RegExp("call_date >= '" + w.ytdStartIso + "'::date\\) AS p_ytd"));
  assert.match(sql, new RegExp("WHERE call_date BETWEEN '" + w.readFromIso + "'::date AND '" + LATEST + "'::date GROUP BY agent_name"));
  assert.match(sql, /json_agg\(t\)/, 'one json string per read (the neon-layer json_agg rule)');
  assert.match(sql, /'coverageStart', \(SELECT MIN\(call_date\)::text FROM outbound_calls\)/);
});

test('E2: shaping attributes through the roster map -- two rosters count in both, off-roster in none', function () {
  const w = h.call('ovWindows_', LATEST);
  const by = { Anna: ['CSR', 'Spanish'], Bob: ['CSR'] };
  const out = h.call('ovOutboundShape_', JSON.parse(NEON_JSON), DEPTS, by, w, LATEST);
  assert.equal(out.coverageStart, '2026-07-10');
  assert.deepEqual(JSON.parse(JSON.stringify(out.byDept.CSR.yesterday)), { placed: 8, connected: 5, pct: 62.5, partial: false });
  assert.equal(out.byDept.Spanish.last30.placed, 40);
  assert.equal(out.byDept.Spanish.last30.pct, 50);
  assert.deepEqual(JSON.parse(JSON.stringify(out.byDept.Sales.last30)), { placed: 0, connected: 0, pct: null, partial: false },
    'a dept with no outbound carries zeros and a null rate, never a divide-by-zero');
  // YTD starts Jan 1, before capture began: flagged so the tile says "since".
  assert.equal(out.byDept.CSR.ytd.partial, true);
  assert.equal(out.byDept.CSR.last30.partial, false);
  const total = DEPTS.reduce(function (s, d) { return s + out.byDept[d].ytd.placed; }, 0);
  assert.equal(total, 120 * 2 + 10, 'Off Roster is attributed to no dept');
});

test('E2: an admin gets the per-dept outbound block + coverage start, from ONE metered read', function () {
  install({});
  const p = h.call('getCompanyOverview', {});
  assert.equal(p.outboundCoverageStart, '2026-07-10');
  assert.equal(tile(p, 'CSR').outbound.yesterday.placed, 8);
  assert.equal(tile(p, 'Sales').outbound.yesterday.placed, 0);
  assert.equal(tile(p, 'CSR Backup'), undefined, 'hidden depts still have no tile');
  assert.equal(conn.sql.length, 1);
  assert.ok(conn.closed, 'the connection is closed');
  assert.deepEqual(h.ctx.egress, ['overviewOutbound']);
});

test('E2: the line rides the CACHED blob -- a repeat load (the 5-min auto-refresh) never reaches Neon', function () {
  install({});
  h.call('getCompanyOverview', {});
  const p = h.call('getCompanyOverview', { auto: true });
  assert.equal(conn.opened, 1, 'served from the cache');
  assert.equal(tile(p, 'CSR').outbound.last30.placed, 50);
});

test('E2: stripped for a manager and for View-as while the 6c gate stands (and when the gate is absent)', function () {
  [undefined, true].forEach(function (gate) {
    install({ gate: gate, user: { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] } });
    const p = h.call('getCompanyOverview', {});
    assert.equal(p.outboundCoverageStart, undefined);
    p.depts.forEach(function (d) { assert.equal(d.outbound, undefined, d.name + ' outbound leaked'); });
    install({ gate: gate });
    const v = h.call('getCompanyOverview', { viewAsDept: 'CSR' });
    v.depts.forEach(function (d) { assert.equal(d.outbound, undefined, 'view-as ' + d.name); });
  });
  // An all-departments manager is still a manager: stripped too.
  install({ user: { email: 'a@x.com', role: 'manager', allDepts: true, department: null, departments: DEPTS.slice() } });
  assert.equal(tile(h.call('getCompanyOverview', {}), 'CSR').outbound, undefined);
});

test('E2: the RELEASED path (gate false) serves it to managers, and the shared blob is untouched by a strip', function () {
  install({ gate: true, user: { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] } });
  h.call('getCompanyOverview', {});                 // computes + caches, then strips the copy
  h.ctx.OUTBOUND_VETTING_GATE_ = false;
  const p = h.call('getCompanyOverview', {});       // cached blob, released gate
  assert.equal(tile(p, 'CSR').outbound.yesterday.placed, 8, 'the strip never mutated the cached blob');
  assert.equal(p.outboundCoverageStart, '2026-07-10');
});

test('E2: no Neon (unconfigured, unreachable, a throw, an empty result) = no line, and the payload is otherwise unchanged', function () {
  install({ noHelper: true });
  const base = h.call('getCompanyOverview', {});
  assert.equal(base.outboundCoverageStart, undefined);
  base.depts.forEach(function (d) { assert.equal(d.outbound, undefined); });
  [{ noConn: true }, { throws: true }, { json: null }].forEach(function (o) {
    install(o);
    const p = h.call('getCompanyOverview', {});
    assert.deepEqual(JSON.parse(JSON.stringify(p)), JSON.parse(JSON.stringify(base)), JSON.stringify(o));
    if (conn) assert.ok(conn.closed, 'closed on the failure path too');
  });
});

test('E2: the client renders the line ONLY when the server shipped it, in the outbound hue', function () {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-3-overview.html'), 'utf8');
  const fn = src.slice(src.indexOf('function ovBuildOutboundLine_'), src.indexOf('function ovBuildGridTile_'));
  assert.match(fn, /var ob = dept && dept\.outbound && dept\.outbound\[ovCardPeriod\];\s*if \(!ob\) return '';/);
  assert.match(fn, /OB_CONNECTED_DEF_/, 'one definition of Connected');
  assert.equal((src.match(/\+\s*ovBuildOutboundLine_\(dept\)/g) || []).length, 2, 'the grid tile AND the expanded sub-queue card');
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'styles.html'), 'utf8');
  assert.match(css, /\.ov-dir-pill \{[^}]*var\(--dir-out-soft\)[^}]*var\(--dir-out\)/);
});
