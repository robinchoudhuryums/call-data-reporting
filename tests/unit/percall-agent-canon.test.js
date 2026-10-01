'use strict';

// PC-1 / PC-2 (broad-scan 2026-10-01): the per-call capture tables stored the
// RAW CDR agent name while every other surface keys on the roster name the DQE
// build canonicalizes to (INV-24). A nickname agent -- "Roman Robin Paulose" in
// the feed, "Roman (Robin) Paulose" on the roster, the ~90% orphan shape --
// vanished from the Outbound report's dept view (its callbacks read
// "Unrostered") and Agent Day / the agent app matched nothing for them.
//
// The fix is ONE canonicalizer shared by the build and the capture writers
// (canonicalizeAgentNameWith_, buildDQEHistoricalData.js -- both INV-16
// copies), applied at capture, plus an editor-run rewrite of stored rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const h = loadGas({ project: 'cdr-import',
  files: ['buildDQEHistoricalData.js', 'inboundCalls.js', 'outboundCalls.js'] });

const ROSTER = rosterGrid({
  CSR: ['Roman (Robin) Paulose, 214', 'Maria Garcia, 215'],
  Sales: ['Ana (Bob) Ruiz, 301', 'Ana (Cat) Ruiz, 302'],
});

function installRoster(aliases) {
  const sheets = { 'DO NOT EDIT!': ROSTER };
  if (aliases) sheets['Agent Alias Overrides'] = [['Old Name', 'Canonical Name', 'Active']].concat(aliases);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  h.ctx.getTargetSsId_ = function () { return 'fake'; };
  h.ctx.IC_AGENT_CANON_MEMO_ = null;
}

// ── The shared rule ─────────────────────────────────────────────────────────

test('canonicalizeAgentNameWith_: alias > exact > UNIQUE strip/flatten match; ambiguous and unknown kept', function () {
  installRoster([['Sarah Q. Smith', 'Maria Garcia', 'TRUE']]);
  const rc = h.call('loadRosterCanonicalNames_', h.state.spreadsheet);   // PC-1: accepts a Spreadsheet
  const c = function (n) { return h.call('canonicalizeAgentNameWith_', rc, n); };
  assert.equal(c('Roman Robin Paulose'), 'Roman (Robin) Paulose', 'flatten: the ~90% orphan case');
  assert.equal(c('Roman Paulose'), 'Roman (Robin) Paulose', 'strip: nickname omitted');
  assert.equal(c('Maria Garcia'), 'Maria Garcia', 'exact roster name kept');
  assert.equal(c('Sarah Q. Smith'), 'Maria Garcia', 'an active alias override wins');
  assert.equal(c('Ana Ruiz'), 'Ana Ruiz', 'ambiguous (two roster names strip to it) -> never a guess');
  assert.equal(c('Someone New'), 'Someone New', 'unknown -> as captured');
  assert.equal(c(''), '');
});

// ── Capture ─────────────────────────────────────────────────────────────────

test('PC-1: capture rewrites every AGENT name, never a queue, a masked customer or an IVR node', function () {
  installRoster();
  const recs = [{
    firstAgent: 'Roman Robin Paulose', originAgent: 'Roman Paulose', agentName: 'Roman Robin Paulose',
    journey: [
      { name: 'Introduction - New', kind: 'leg' },
      { name: 'A_Q_CSR', kind: 'queue' },
      { name: 'Roman Robin Paulose', kind: 'answer', talk: 90 },
      { name: 'J. S.', kind: 'leg' },
      { name: '(external caller)', kind: 'leg' },
    ],
  }];
  h.call('icCanonicalizeRecordAgents_', recs);
  const r = recs[0];
  assert.equal(r.firstAgent, 'Roman (Robin) Paulose');
  assert.equal(r.originAgent, 'Roman (Robin) Paulose');
  assert.equal(r.agentName, 'Roman (Robin) Paulose');
  assert.deepEqual(Array.from(r.journey).map(function (e) { return e.name; }),
    ['Introduction - New', 'A_Q_CSR', 'Roman (Robin) Paulose', 'J. S.', '(external caller)']);
});

test('PC-1: no roster (or no build file) -> the identity, never a failed capture', function () {
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  h.ctx.getTargetSsId_ = function () { return 'fake'; };
  h.ctx.IC_AGENT_CANON_MEMO_ = null;
  const recs = [{ agentName: 'Roman Robin Paulose', journey: [] }];
  h.call('icCanonicalizeRecordAgents_', recs);
  assert.equal(recs[0].agentName, 'Roman Robin Paulose');
});

function leg(o) {
  const r = new Array(44).fill('');
  r[0] = o.callId; r[1] = o.legId; r[2] = o.start; r[3] = o.connected || ''; r[4] = o.stop || '';
  r[5] = o.direction; r[6] = o.talk || '0:00:00'; r[7] = o.callTime || '0:00:00';
  r[8] = o.caller; r[9] = o.callerName || ''; r[10] = o.callee; r[11] = o.calleeName || '';
  r[14] = 'N/A'; r[16] = 'N/A';
  r[23] = '-'; r[24] = '-'; r[25] = o.answered || '-';
  r[32] = '0:00:00'; r[33] = 'N/A'; r[34] = 'N/A'; r[36] = o.dept || 'N/A';
  return r;
}

test('PC-1 end to end: the outbound writer stores the ROSTER name the Outbound report attributes by', function () {
  installRoster();
  const sql = [];
  h.ctx.getReachableNeonConn_ = function () {
    const stmt = function () { return { execute: function (q) { sql.push(q); return true; }, close: function () {} }; };
    return { setAutoCommit: function () {}, createStatement: stmt, commit: function () {}, rollback: function () {}, close: function () {} };
  };
  delete h.state.props.HMAC_SECRET;
  h.call('writeOutboundCallsToNeon', [
    leg({ callId: '910001', legId: 1, start: '07/22/2026 09:00:00', connected: '07/22/2026 09:00:10',
          stop: '07/22/2026 09:02:00', direction: 'Outgoing', talk: '0:01:50', caller: '214',
          callerName: 'Roman Robin Paulose', callee: '12145550123', answered: 'Answered', dept: 'CSR' }),
  ], { expectedDateIso: '2026-07-22' });
  const ins = sql.filter(function (q) { return /INSERT INTO outbound_calls/.test(q); })[0];
  assert.ok(ins, 'the row was written');
  assert.ok(ins.indexOf('Roman (Robin) Paulose') !== -1, 'pre-PC-1 the raw "Roman Robin Paulose" was stored');
});

// ── The stored-row rewrite ──────────────────────────────────────────────────

function rewriteConn(log, distinctByQuery) {
  return {
    setAutoCommit: function () {},
    close: function () { log.closed = true; },
    prepareStatement: function (q) {
      const binds = [];
      return {
        setQueryTimeout: function (s) { log.timeouts.push(s); },
        setString: function (i, v) { binds[i - 1] = v; },
        executeQuery: function () {
          let rows = [];
          if (/SELECT DISTINCT/.test(q)) {
            const key = Object.keys(distinctByQuery).filter(function (k) { return q.indexOf(k) !== -1; })[0];
            rows = (key ? distinctByQuery[key] : []).map(function (v) { return [v]; });
          } else if (/count\(\*\)/.test(q)) rows = [['3']];
          let i = -1;
          return { next: function () { i++; return i < rows.length; },
                   getString: function (n) { return rows[i][n - 1]; }, close: function () {} };
        },
        executeUpdate: function () { log.updates.push({ q: q, binds: binds.slice() }); return 2; },
        close: function () {},
      };
    },
  };
}

test('PC-1 rewrite: PREVIEW changes nothing and lists only names that canonicalize differently', function () {
  installRoster();
  const log = { updates: [], timeouts: [] };
  h.ctx.getReachableNeonConn_ = function () {
    return rewriteConn(log, {
      'agent_name FROM outbound_calls': ['Roman Robin Paulose', 'Maria Garcia', 'Ana Ruiz'],
      'first_agent FROM inbound_calls': ['Roman Paulose'],
      'origin_agent FROM inbound_calls': [],
      'FROM inbound_calls c, jsonb_array_elements': ['Roman Robin Paulose', 'Introduction - New'],
      'FROM outbound_calls c, jsonb_array_elements': [],
    });
  };
  const out = h.call('previewPerCallAgentNameRewrite');
  assert.equal(log.updates.length, 0, 'a preview never writes');
  assert.deepEqual(Array.from(out.columns).map(function (c) { return c.column + ':' + c.raw; }),
    ['agent_name:Roman Robin Paulose', 'first_agent:Roman Paulose'],
    'exact and ambiguous names are not candidates');
  assert.deepEqual(Array.from(out.journeys).map(function (j) { return j.table + ':' + j.raw; }), ['inbound_calls:Roman Robin Paulose']);
  assert.equal(out.columns[0].rows, 3);
  assert.ok(log.timeouts.length && log.timeouts.every(function (s) { return s === 120; }), 'every statement is bounded');
  assert.equal(log.closed, true);
});

test('PC-1 rewrite: APPLY issues bound UPDATEs for exactly the mapped pairs (queue legs untouched in SQL)', function () {
  installRoster();
  const log = { updates: [], timeouts: [] };
  h.ctx.getReachableNeonConn_ = function () {
    return rewriteConn(log, {
      'agent_name FROM outbound_calls': ['Roman Robin Paulose'],
      'first_agent FROM inbound_calls': [],
      'origin_agent FROM inbound_calls': [],
      'FROM inbound_calls c, jsonb_array_elements': ['Roman Robin Paulose'],
      'FROM outbound_calls c, jsonb_array_elements': [],
    });
  };
  const out = h.call('rewritePerCallAgentNames');
  assert.equal(log.updates.length, 2);
  assert.match(log.updates[0].q, /^UPDATE outbound_calls SET agent_name = \? WHERE agent_name = \?$/);
  assert.deepEqual(Array.from(log.updates[0].binds), ['Roman (Robin) Paulose', 'Roman Robin Paulose']);
  assert.match(log.updates[1].q, /UPDATE inbound_calls c SET journey/);
  assert.match(log.updates[1].q, /coalesce\(x\.e->>'kind', ''\) <> 'queue'/);
  assert.deepEqual(Array.from(log.updates[1].binds), ['Roman Robin Paulose', 'Roman (Robin) Paulose', 'Roman Robin Paulose']);
  assert.equal(out.stoppedAtBudget, false);
});
