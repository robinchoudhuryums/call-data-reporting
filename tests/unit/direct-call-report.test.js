'use strict';

// DirectCallReport.gs (dashboard) -- the Neon-backed per-agent direct-call
// report. The SQL aggregation runs in Neon, so the unit-testable surface is:
// (1) the auth gate (admin-only while vetted; manager rejected), (2) the
// derived-rate shaping (inbound answer rate EXCLUDES the busy carve-out; ATT
// = talk/answered), and (3) the unavailable/empty fallbacks. A fake JDBC conn
// serves the json_build_object payload the read SQL would return.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'NeonRead.gs', 'DirectCallReport.gs'],
});

// One logical day's aggregate, as the read SQL's json_build_object would emit.
const PAYLOAD = {
  kpis: {
    agents: 2,
    ibAnswered: 30, ibMissedFree: 10, ibMissedBusy: 5, ibTalkSec: 1800,
    obTotal: 12, obConnected: 9, obTalkSec: 900,
  },
  agents: [
    { agent: 'Anna', dept: 'CSR', ib_answered: 20, ib_missed_free: 5, ib_missed_busy: 3,
      ib_talk_sec: 1200, ib_int_answered: 8, ib_ext_answered: 12,
      ob_total: 7, ob_connected: 5, ob_talk_sec: 500, ob_int_total: 3, ob_ext_total: 4 },
    { agent: 'Bob', dept: 'CSR', ib_answered: 10, ib_missed_free: 5, ib_missed_busy: 2,
      ib_talk_sec: 600, ib_int_answered: 4, ib_ext_answered: 6,
      ob_total: 5, ob_connected: 4, ob_talk_sec: 400, ob_int_total: 2, ob_ext_total: 3 },
  ],
};

function rsFor(json) {
  let c = false;
  return { next: function () { if (c) return false; c = true; return true; },
           getString: function () { return json; }, close: function () {} };
}
// D1: the coverage read ('mx' = the last date with data, 'days' = the dates
// with rows) runs first. Default: every date through 2026-06-07 has data, so
// REQ is neither clamped nor gappy.
function allDays(from, to) {
  const out = [];
  for (let d = new Date(from + 'T12:00:00Z'); d <= new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const FULL_COVERAGE = { mx: '2026-06-07', days: allDays('2026-04-01', '2026-06-07') };
function fakeConn(payload, coverage) {
  return {
    sql: [],
    createStatement: function () {
      const self = this;
      return {
        executeQuery: function (sql) {
          self.sql.push(sql);
          if (sql.indexOf("'mx'") !== -1) return rsFor(JSON.stringify(coverage || FULL_COVERAGE));
          if (sql.indexOf('FROM direct_call_history') !== -1) return rsFor(JSON.stringify(payload));
          throw new Error('Unexpected SQL: ' + sql);
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function installAdmin(conn) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 101'], Sales: ['Carl, 201'] }),
      'Access Control': [['Email', 'Department', 'Notes'], ['manager@x.com', 'CSR', '']],
    },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = conn || function () { return fakeConn(PAYLOAD); };
}

const REQ = { from: '2026-06-01', to: '2026-06-07', department: '' };

test('A-1: the agent role is refused by the allowlist, not the vetting message', function () {
  // The agent role's fail-closed shape is neither 'none' nor 'manager'; a
  // role-none denylist passed it to the admin-style dept branch. It must be
  // refused by assertManagerOrAdmin_ BEFORE the temporary vetting throw, so
  // releasing the report (removing that throw) cannot widen it to agents.
  // Real Auth.gs resolution: an agent row + the Phase A flag.
  installAdmin();
  h.state.props.AGENT_ROLE_ENABLED = 'true';
  h.state.spreadsheet.getSheetByName('Access Control')
    .appendRow(['agent@x.com', 'CSR', '', 'agent', 'Anna']);
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.state.userEmail = 'agent@x.com';
  assert.throws(function () { h.call('getDirectCallReport', REQ); }, /^Error: Not authorized\.$/);
  assert.throws(function () {
    h.call('getDirectCallReport', Object.assign({}, REQ, { department: 'ALL' }));
  }, /^Error: Not authorized\.$/);
  delete h.state.props.AGENT_ROLE_ENABLED;
});

test('admin-only while vetted: a manager is rejected', function () {
  installAdmin();
  h.state.userEmail = 'manager@x.com';   // not an admin
  assert.throws(function () { h.call('getDirectCallReport', REQ); }, /admin-only/);
});

test('validation: from must be on or before to', function () {
  installAdmin();
  assert.throws(function () {
    h.call('getDirectCallReport', { from: '2026-06-09', to: '2026-06-01' });
  }, /on or before/);
});

test('derived rates: answer rate excludes the busy carve-out; ATT = talk/answered', function () {
  installAdmin();
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.meta.available, true);
  // Team answer rate = answered / (answered + missed_free) = 30/40 = 75%.
  // The 5 busy misses are EXCLUDED from the denominator.
  assert.equal(out.kpis.ibAnswerRate, 75);
  assert.equal(out.kpis.ibMissedBusy, 5);
  // Team inbound ATT = 1800 / 30 = 60s.
  assert.equal(out.kpis.ibAttSec, 60);
  // Outbound ATT = 900 / 9 = 100s.
  assert.equal(out.kpis.obAttSec, 100);

  // Per-agent shaping.
  const anna = out.agents.filter(function (a) { return a.agent === 'Anna'; })[0];
  assert.equal(anna.ibAnswerRate, 80);          // 20/(20+5)
  assert.equal(anna.ibAttSec, 60);              // 1200/20
  assert.equal(anna.obAttSec, 100);             // 500/5
  assert.equal(anna.ibIntAnswered, 8);
  assert.equal(anna.ibExtAnswered, 12);
});

test('answer rate is null when there are no in-window inbound rings', function () {
  installAdmin(function () {
    return fakeConn({ kpis: { agents: 1, ibAnswered: 0, ibMissedFree: 0, ibMissedBusy: 0,
      ibTalkSec: 0, obTotal: 3, obConnected: 2, obTalkSec: 120 },
      agents: [{ agent: 'Anna', dept: 'CSR', ib_answered: 0, ib_missed_free: 0, ib_missed_busy: 0,
        ib_talk_sec: 0, ib_int_answered: 0, ib_ext_answered: 0,
        ob_total: 3, ob_connected: 2, ob_talk_sec: 120, ob_int_total: 1, ob_ext_total: 2 }] });
  });
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.kpis.ibAnswerRate, null);
  assert.equal(out.agents[0].ibAnswerRate, null);
  assert.equal(out.agents[0].obAttSec, 60);     // 120/2
});

test('Neon unreachable -> meta.available=false (clean unavailable state)', function () {
  installAdmin(function () { return null; });
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.meta.available, false);
  assert.deepEqual(JSON.parse(JSON.stringify(out.agents)), []);
});

test('v2: kpisPrior + deptsPrior shaped when present; null/[] when absent', function () {
  // Absent (fixture without prior keys) -> defaults, no throw.
  installAdmin();
  const noPrior = h.call('getDirectCallReport', REQ);
  assert.equal(noPrior.kpisPrior, null);
  assert.deepEqual(JSON.parse(JSON.stringify(noPrior.deptsPrior)), []);

  // Present -> derived rate/ATT on the prior block + per-dept rows.
  installAdmin(function () {
    return fakeConn({
      kpis: { agents: 1, ibAnswered: 20, ibMissedFree: 5, ibMissedBusy: 0, ibTalkSec: 400,
        obTotal: 4, obConnected: 3, obTalkSec: 300 },
      agents: [{ agent: 'Anna', dept: 'CSR', ib_answered: 20, ib_missed_free: 5, ib_missed_busy: 0,
        ib_talk_sec: 400, ib_int_answered: 8, ib_ext_answered: 12,
        ob_total: 4, ob_connected: 3, ob_talk_sec: 300, ob_int_total: 2, ob_ext_total: 2 }],
      kpisPrior: { ibAnswered: 15, ibMissedFree: 5, ibMissedBusy: 1, ibTalkSec: 300,
        obTotal: 2, obConnected: 2, obTalkSec: 200 },
      deptsPrior: [{ dept: 'CSR', ib_answered: 15, ib_missed_free: 5, ib_missed_busy: 1, ob_total: 2 }],
    });
  });
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.kpisPrior.ibAnswered, 15);
  assert.equal(out.kpisPrior.ibAnswerRate, 75);   // 15/(15+5)
  assert.equal(out.kpisPrior.ibAttSec, 20);       // 300/15
  assert.equal(out.deptsPrior[0].dept, 'CSR');
  assert.equal(out.deptsPrior[0].ibAnswerRate, 75);
});

// ── D1 (owner 2026-10-21): coverage -- clamp, missing workdays, prior gaps ──

test('D1: an end date past the last imported day is CLAMPED to it, said so, and never cached', function () {
  // REQ ends Sun 06-07; the data stops Fri 06-05 (the not-yet-imported case).
  const conn = fakeConn(PAYLOAD, { mx: '2026-06-05', days: allDays('2026-04-01', '2026-06-05') });
  installAdmin(function () { return conn; });
  const out = h.call('getDirectCallReport', { from: '2026-06-01', to: '2026-06-09', department: '' });
  assert.equal(out.meta.requestedTo, '2026-06-09');
  assert.equal(out.meta.to, '2026-06-05');
  assert.equal(out.meta.clampedTo, true);
  assert.equal(out.meta.dataThrough, '2026-06-05');
  assert.equal(out.meta.missingCount, 0, 'the clamped window has every workday');
  const main = conn.sql.find((s) => s.indexOf("'kpis'") !== -1);
  assert.match(main, /BETWEEN '2026-06-01'::date AND '2026-06-05'::date/, 'the sums read the clamped window');
  assert.ok(!/'2026-06-09'::date/.test(main), 'never the asked end');
  const keys = Array.from(h.state.cache.keys()).filter((k) => /^directCall:/.test(k));
  assert.deepEqual(keys, [], 'a clamped payload is not cached -- tomorrow\'s import must show at once');
});

test('D1: a workday with no rows is listed, and the prior comparison is dropped', function () {
  const days = allDays('2026-04-01', '2026-06-07').filter((d) => d !== '2026-06-03');   // Wed missing
  installAdmin(function () {
    return fakeConn(Object.assign({}, PAYLOAD, { kpisPrior: { ibAnswered: 15, ibMissedFree: 5 }, deptsPrior: [{ dept: 'CSR', ib_answered: 15 }] }),
      { mx: '2026-06-07', days: days });
  });
  const out = h.call('getDirectCallReport', REQ);
  assert.deepEqual(JSON.parse(JSON.stringify(out.meta.missingDates)), ['2026-06-03']);
  assert.equal(out.meta.missingCount, 1);
  assert.equal(out.meta.priorSuppressed, true);
  assert.equal(out.kpisPrior, null, 'a holey window must not meet a whole one');
  assert.deepEqual(Array.from(h.state.cache.keys()).filter((k) => /^directCall:/.test(k)), [], 'nor is a gappy one cached');
  assert.deepEqual(JSON.parse(JSON.stringify(out.deptsPrior)), []);
});

test('D1: weekends and company holidays are never "missing"; a gap in the PRIOR window also drops the chips', function () {
  h.state.props.COMPANY_HOLIDAYS = '2026-06-02';
  const days = allDays('2026-04-01', '2026-06-07').filter((d) => d !== '2026-06-02' && d !== '2026-06-06' && d !== '2026-05-27');
  installAdmin(function () { return fakeConn(Object.assign({}, PAYLOAD, { kpisPrior: { ibAnswered: 15 } }), { mx: '2026-06-07', days: days }); });
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.meta.missingCount, 0, 'Tue 06-02 is a holiday, Sat 06-06 a weekend');
  assert.equal(out.meta.priorMissingCount, 1, 'Wed 05-27 sits in the prior window');
  assert.equal(out.meta.priorSuppressed, true);
  assert.equal(out.kpisPrior, null);
  delete h.state.props.COMPANY_HOLIDAYS;
});

test('D1: no data at all in the window -> an empty payload that says so', function () {
  installAdmin(function () { return fakeConn(PAYLOAD, { mx: '2026-05-15', days: [] }); });
  const out = h.call('getDirectCallReport', REQ);
  assert.equal(out.meta.noDataInRange, true);
  assert.equal(out.meta.dataThrough, '2026-05-15');
  assert.equal(out.kpis.ibAnswered, 0);
});

test('D1: the internal / external split rides every agent row and the totals', function () {
  let seen = null;
  installAdmin(function () {
    return seen = fakeConn({ kpis: Object.assign({}, PAYLOAD.kpis, { ibIntAnswered: 12, ibExtAnswered: 18, obIntTotal: 5, obExtTotal: 7, obIntConnected: 4, obExtConnected: 5 }),
      agents: [Object.assign({}, PAYLOAD.agents[0], { ib_int_missed_free: 2, ib_ext_missed_free: 3, ob_int_connected: 2, ob_ext_connected: 3 })] });
  });
  const out = JSON.parse(JSON.stringify(h.call('getDirectCallReport', REQ)));
  assert.deepEqual(out.kpis.split.ibAnswered, { int: 12, ext: 18 });
  assert.deepEqual(out.kpis.split.obTotal, { int: 5, ext: 7 });
  assert.deepEqual(out.agents[0].split.ibMissedFree, { int: 2, ext: 3 });
  assert.deepEqual(out.agents[0].split.obConnected, { int: 2, ext: 3 });
  assert.deepEqual(out.agents[0].split.ibAnswered, { int: 8, ext: 12 });
  // The fake returns its fixture whatever the SQL says, so pin the query
  // itself: every split column is selected, per agent AND for the totals.
  const main = seen.sql.find((q) => q.indexOf("'kpis'") !== -1);
  ['ib_int_missed_free', 'ib_ext_missed_free', 'ib_int_missed_busy', 'ib_ext_missed_busy', 'ob_int_connected', 'ob_ext_connected']
    .forEach((c) => assert.match(main, new RegExp('sum\\(' + c + '\\) AS ' + c), c + ' per agent'));
  ['ibIntMissedFree', 'ibExtMissedFree', 'ibIntMissedBusy', 'ibExtMissedBusy', 'obIntTotal', 'obExtTotal', 'obIntConnected', 'obExtConnected']
    .forEach((c) => assert.ok(main.indexOf("'" + c + "'") !== -1, c + ' in the totals'));
});

test('D1: dcMissingWorkdays_ lists at most 60 but counts all', function () {
  const r = h.call('dcMissingWorkdays_', '2026-01-01', '2026-12-31', {}, null);
  assert.equal(r.dates.length, 60);
  assert.ok(r.count > 250);
});
