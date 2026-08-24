'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Direct Call report SHEET FALLBACK (DC-1). Unlike every other Neon surface,
// `Direct Call History` (the sheet) is the PRIMARY for this data -- Neon is
// the mirror -- yet the report used to go dark on a Neon failure. Pinned here:
//   (1) SOURCE PARITY, the headline: one fixture served through the Neon path
//       (as the SQL's json shape) and through the sheet fallback produces the
//       SAME payload (modulo the disclosure field) -- both routes share
//       directCallShapePayload_, and this pins the aggregation mirror too
//       (per-(agent,dept) grouping B-1, distinct-agent kpi count, ORDER BY,
//       busy carve-out exclusion from the rate, prior kpis/deptsPrior);
//   (2) fallback payloads are NEVER cached; healthy payloads still cache;
//   (3) all three failure branches (conn null / null result / query throw)
//       reach the fallback; a missing sheet keeps available=false;
//   (4) dept scoping mirrors the SQL's department = <dept> predicate.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'DirectCallReport.gs'],
});

function install(opts) {
  opts = opts || {};
  h.state.cache.clear();
  h.ctx.resolveUser_ = function () {
    return { role: 'admin', department: null, email: 'x@x.com' };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.reportFreshnessTag_ = function () { return 'tag'; };
  h.ctx.logReportUsage_ = function () {};
  // computePriorWindow_ lives in Data.gs (not loaded); BOTH paths call the
  // same function in prod, so its resolution is not what this suite pins.
  h.ctx.computePriorWindow_ = function () { return { from: PW.from, to: PW.to }; };
  install.connCalls = 0;
  h.ctx.getDashboardNeonConn_ = opts.conn !== undefined
    ? function () { install.connCalls++; return opts.conn; }
    : function () { install.connCalls++; return null; };
  install.ssOpened = 0;
  h.ctx.openSpreadsheet_ = function () {
    install.ssOpened++;
    return {
      getSheetByName: function (name) {
        if (name !== 'Direct Call History') return null;
        return opts.sheet || null;
      },
    };
  };
}

// Read-only fake of the Direct Call History sheet; `rows` are 18-wide
// display arrays (header implied at row 1).
function fakeSheet(rows) {
  return {
    getLastRow: function () { return rows.length + 1; },
    getRange: function (row, col, numRows, numCols) {
      return {
        getDisplayValues: function () {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = rows[row - 2 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v == null ? '' : String(v));
            }
            out.push(line);
          }
          return out;
        },
      };
    },
  };
}

// Sheet row: [MonthYear, Date, Dept, Agent, ibIntAns, ibIntMF, ibIntMB,
// ibIntTalk, ibExtAns, ibExtMF, ibExtMB, ibExtTalk, obIntTot, obIntConn,
// obIntTalk, obExtTot, obExtConn, obExtTalk]
function row(date, dept, agent, nums) {
  return ['Aug 2026', date, dept, agent].concat(nums);
}

function neonConnReturning(json) {
  return {
    createStatement: function () {
      return {
        executeQuery: function () {
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return json; },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

const FROM = '2026-08-19', TO = '2026-08-20';   // Wed-Thu
const PW = { from: '2026-08-17', to: '2026-08-18' };   // the stubbed prior window
const REQ = { from: FROM, to: TO, department: '' };

// The fixture. Ana is a crossover agent (rows in CSR and Sales) -- the kpi
// agent count must count her ONCE while the agents list carries two rows.
// Bob's busy misses must not drag his answer rate. Prior-window rows are
// placed via the REAL computePriorWindow_ so the R24 working-day semantics
// hold whatever they resolve to.
function fixtureRows(pw) {
  return [
    row(pw.from, 'CSR', 'Ana',  [1, 1, 0, 60,  0, 0, 0, 0,   1, 1, 30,  0, 0, 0]),
    row(pw.to,   'Sales', 'Cara', [2, 0, 0, 100, 0, 0, 0, 0,  0, 0, 0,  1, 1, 45]),
    row(FROM, 'CSR', 'Ana',  [3, 1, 0, 300,  2, 0, 1, 200,  1, 1, 50,  2, 1, 80]),
    row(FROM, 'CSR', 'Bob',  [0, 0, 4, 0,    1, 1, 0, 90,   0, 0, 0,   0, 0, 0]),
    row(TO,   'Sales', 'Ana', [5, 0, 0, 400,  0, 2, 0, 0,    3, 2, 120, 0, 0, 0]),
  ];
}

// Independent aggregation of the same fixture into the SQL's json shape --
// deliberately written from the SQL text, not by calling the fallback's
// helpers, so parity is a real cross-check.
function neonShapeFor(pw) {
  return JSON.stringify({
    kpis: { agents: 2, ibAnswered: 3 + 2 + 0 + 1 + 5 + 0, ibMissedFree: 1 + 0 + 0 + 1 + 0 + 2,
            ibMissedBusy: 0 + 1 + 4 + 0 + 0 + 0, ibTalkSec: 300 + 200 + 0 + 90 + 400 + 0,
            obTotal: 1 + 2 + 0 + 0 + 3 + 0, obConnected: 1 + 1 + 0 + 0 + 2 + 0,
            obTalkSec: 50 + 80 + 0 + 0 + 120 + 0 },
    agents: [
      { agent: 'Ana', dept: 'CSR', ib_answered: 5, ib_missed_free: 1, ib_missed_busy: 1,
        ib_talk_sec: 500, ib_int_answered: 3, ib_ext_answered: 2,
        ob_total: 3, ob_connected: 2, ob_talk_sec: 130, ob_int_total: 1, ob_ext_total: 2 },
      { agent: 'Ana', dept: 'Sales', ib_answered: 5, ib_missed_free: 2, ib_missed_busy: 0,
        ib_talk_sec: 400, ib_int_answered: 5, ib_ext_answered: 0,
        ob_total: 3, ob_connected: 2, ob_talk_sec: 120, ob_int_total: 3, ob_ext_total: 0 },
      { agent: 'Bob', dept: 'CSR', ib_answered: 1, ib_missed_free: 1, ib_missed_busy: 4,
        ib_talk_sec: 90, ib_int_answered: 0, ib_ext_answered: 1,
        ob_total: 0, ob_connected: 0, ob_talk_sec: 0, ob_int_total: 0, ob_ext_total: 0 },
    ],
    kpisPrior: { ibAnswered: 1 + 0 + 2 + 0, ibMissedFree: 1 + 0 + 0 + 0,
                 ibMissedBusy: 0, ibTalkSec: 60 + 100,
                 obTotal: 1 + 0 + 0 + 1, obConnected: 1 + 1, obTalkSec: 30 + 45 },
    deptsPrior: [
      { dept: 'CSR', ib_answered: 1, ib_missed_free: 1, ib_missed_busy: 0, ob_total: 1 },
      { dept: 'Sales', ib_answered: 2, ib_missed_free: 0, ib_missed_busy: 0, ob_total: 1 },
    ],
    coverageStart: pw.from,
  });
}

function strip(payload) {
  const p = JSON.parse(JSON.stringify(payload));
  delete p.meta.fallbackSource;
  delete p.meta.computeMs;
  delete p.meta.cacheHit;
  // deptsPrior arrives in SQL grouping order vs JS insertion order -- sort
  // both for the comparison (the client keys it by dept name).
  p.deptsPrior.sort(function (a, b) { return a.dept < b.dept ? -1 : 1; });
  return p;
}

test('DC-1 SOURCE PARITY: Neon path and sheet fallback produce the same payload from one fixture', function () {
  const pw = PW;
  const rows = fixtureRows(pw);

  install({ conn: neonConnReturning(neonShapeFor(pw)) });
  const viaNeon = h.call('computeDirectCallReport_', { from: FROM, to: TO, dept: '', companyView: true });
  assert.equal(viaNeon.meta.fallbackSource, undefined);
  assert.equal(install.ssOpened, 0, 'healthy Neon path never touches the sheet');

  install({ sheet: fakeSheet(rows) });   // conn null -> fallback
  const viaSheet = h.call('computeDirectCallReport_', { from: FROM, to: TO, dept: '', companyView: true });
  assert.equal(viaSheet.meta.available, true);
  assert.equal(viaSheet.meta.fallbackSource, 'sheet');

  assert.deepEqual(strip(viaSheet), strip(viaNeon),
    'the two sources must shape byte-identical payloads (shared shaper + mirrored aggregation)');
});

test('DC-1: fallback numbers -- busy carve-out, distinct-agent count, ordering', function () {
  const pw = PW;
  install({ sheet: fakeSheet(fixtureRows(pw)) });
  const out = h.call('computeDirectCallReport_', { from: FROM, to: TO, dept: '', companyView: true });
  assert.equal(out.kpis.agents, 2, 'crossover agent counted once (DISTINCT agent_name)');
  // Bob: 1 answered, 1 missed-free, 4 missed-busy -> rate excludes busy: 1/2.
  const bob = out.agents.filter(function (a) { return a.agent === 'Bob'; })[0];
  assert.equal(bob.ibAnswerRate, 50);
  assert.equal(bob.ibMissedBusy, 4);
  // Ordered ib_answered DESC then agent ASC: Ana(CSR,5), Ana(Sales,5), Bob(1).
  assert.deepEqual(JSON.parse(JSON.stringify(out.agents.map(function (a) { return a.agent + '/' + a.dept; }))),
    ['Ana/CSR', 'Ana/Sales', 'Bob/CSR']);
  assert.equal(out.meta.coverageStart, pw.from);
});

test('DC-1: dept scope mirrors the SQL department predicate', function () {
  const pw = PW;
  install({ sheet: fakeSheet(fixtureRows(pw)) });
  const out = h.call('computeDirectCallReport_', { from: FROM, to: TO, dept: 'CSR', companyView: false });
  assert.deepEqual(JSON.parse(JSON.stringify(out.agents.map(function (a) { return a.agent + '/' + a.dept; }))),
    ['Ana/CSR', 'Bob/CSR']);
  assert.equal(out.kpis.ibAnswered, 5 + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(out.deptsPrior)).map(function (d) { return d.dept; }),
    ['CSR'], 'prior aggregates scoped too');
});

test('DC-1: fallback payloads are never cached; healthy payloads still cache', function () {
  const pw = PW;
  install({ sheet: fakeSheet(fixtureRows(pw)) });
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.meta.fallbackSource, 'sheet');
  assert.equal(h.state.cache.size, 0, 'a recovered Neon must not be masked for the TTL');

  install({ conn: neonConnReturning(neonShapeFor(pw)) });
  h.call('getDirectCallReport', REQ);
  assert.equal(h.state.cache.size, 1);
});

test('DC-1: a query THROW (not just conn-null) reaches the fallback', function () {
  const pw = PW;
  const throwingConn = {
    createStatement: function () { throw new Error('connection reset'); },
    close: function () {},
  };
  install({ conn: throwingConn, sheet: fakeSheet(fixtureRows(pw)) });
  const out = h.call('computeDirectCallReport_', { from: FROM, to: TO, dept: '', companyView: true });
  assert.equal(out.meta.fallbackSource, 'sheet');
  assert.equal(out.meta.available, true);
});

test('DC-1: missing sheet keeps the old behavior (available=false)', function () {
  install({ sheet: null });
  const out = h.call('computeDirectCallReport_', { from: FROM, to: TO, dept: '', companyView: true });
  assert.equal(out.meta.available, false);
  assert.equal(out.meta.fallbackSource, undefined);
});
