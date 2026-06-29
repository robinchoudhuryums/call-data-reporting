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
function fakeConn(payload) {
  return {
    createStatement: function () {
      return {
        executeQuery: function (sql) {
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
