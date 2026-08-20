'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Batch G: the Outbound report — the first read surface over Neon's
// outbound_calls beyond Caller Lookup. Pins the two CONTRACT caveats
// (roster-dept attribution — never the raw CDR org label; "connected" as a
// disclosed stricter subset of "called back"), the abandon side's reuse of
// the Inbound report's dept predicate + work-window clause (the owner
// ruling: out-of-window calls are never a dept metric), and the callback
// linkage's hash join + window.

const h = loadGas({ files: ['Config.gs', 'InboundReport.gs', 'OutboundReport.gs'] });

// Cross-file stubs (Data.gs / QCDReport.gs / DeptConfig.gs not loaded — each
// stub mirrors the real signature; the real implementations are pinned by
// their own suites).
function installStubs_() {
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.queuesForDept_ = function (dept) { return dept === 'CSR' ? ['A_Q_CustomerSuccess'] : ['A_Q_Sales']; };
  h.ctx.getInboundQueueAliases_ = function (dept) { return dept === 'CSR' ? ['A_Q_CSR'] : []; };
  h.ctx.resolveUser_ = function () {
    return h.state.testUser || { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
  };
}
installStubs_();

function makeConn_(json, opts) {
  opts = opts || {};
  const conn = {
    sql: [], closed: false,
    createStatement: function () {
      return {
        executeQuery: function (s) {
          conn.sql.push(s);
          if (opts.throwOnQuery) throw new Error('connection reset');
          let n = 0;
          return { next: function () { return n++ === 0; },
                   getString: function () { return json; },
                   close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () { conn.closed = true; },
  };
  return conn;
}

const BLOB_ = {
  agents: [
    { agent: 'Ann',   ob_total: 40, ob_connected: 30, ob_talk_sec: 6000, attempts: 45 },
    { agent: 'Bob',   ob_total: 10, ob_connected: 5,  ob_talk_sec: 1000, attempts: 12 },
    { agent: 'Casey', ob_total: 8,  ob_connected: 4,  ob_talk_sec: 800,  attempts: 9 },
    { agent: 'Ghost', ob_total: 3,  ob_connected: 0,  ob_talk_sec: 0,    attempts: 3 },
  ],
  callback: { abandonedTotal: 25, abandonedAnonymous: 5, calledBack: 14,
              calledBackConnected: 9, medianCallbackSec: 1980.4 },
  coverageStart: '2026-08-15',
};

const ROSTER_ = { Ann: ['CSR'], Bob: ['Sales'], Casey: ['CSR', 'Sales'] };

function scope_(dept) {
  return { from: '2026-08-01', to: '2026-08-19', dept: dept || '',
           companyView: !dept, user: { role: 'admin' } };
}

// ── The resolver (gate) ─────────────────────────────────────────────────────

test('outbound resolver: admin-only while vetted; validation; ALL → company view', function () {
  h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
  const s = h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'ALL' });
  assert.equal(s.dept, '');
  assert.equal(s.companyView, true);
  assert.equal(h.call('outboundResolveRequest_',
    { from: '2026-08-01', to: '2026-08-19', department: 'CSR' }).dept, 'CSR');

  assert.throws(function () {
    h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'Nope' });
  }, /Unknown department/);
  assert.throws(function () {
    h.call('outboundResolveRequest_', { from: 'yesterday', to: '2026-08-19' });
  }, /YYYY-MM-DD/);
  assert.throws(function () {
    h.call('outboundResolveRequest_', { from: '2026-08-19', to: '2026-08-01' });
  }, /on or before/);
  assert.throws(function () {
    h.call('outboundResolveRequest_', { from: '2020-01-01', to: '2026-08-19' });
  }, /capped/);

  // The vetting gate: manager (and none) refused — the latent per-dept path
  // below it is release-day behavior, mirrored from directCallResolveRequest_.
  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  assert.throws(function () {
    h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19' });
  }, /admin-only while it is being vetted/);
  h.state.testUser = { email: 'n@x.com', role: 'none' };
  assert.throws(function () {
    h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19' });
  }, /Not authorized/);
  h.state.testUser = null;
});

// ── The SQL (pinned properties, not literal bytes) ──────────────────────────

function runCompute_(dept, blob) {
  const conn = makeConn_(JSON.stringify(blob || BLOB_));
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  h.ctx.buildDeptsByAgent_ = function () { return ROSTER_; };
  const out = JSON.parse(JSON.stringify(h.call('computeOutboundReport_', scope_(dept))));
  return { out: out, sql: conn.sql.join('\n'), conn: conn };
}

test('outbound SQL: the abandon side reuses the Inbound dept predicate AND the work-window clause', function () {
  const r = runCompute_('CSR');
  // Work-window scope (owner ruling): the one `FROM inbound_calls c` carries it.
  assert.equal(r.sql.split('FROM inbound_calls c').length - 1, 1);
  assert.match(r.sql, /c\.call_start IS NULL OR \(c\.call_start >= '06:30:00' AND c\.call_start < '15:00:00'\)/,
    'the abandon denominator is work-window-scoped like every dept-facing inbound figure');
  // Dept attribution via the shared predicate: RAW alias (a_q_csr) included,
  // lower-cased — so the callback denominator is EXACTLY the Inbound
  // report's Abandoned population for the same scope.
  assert.match(r.sql, /'a_q_csr'/);
  assert.match(r.sql, /disposition = 'abandoned'/);
});

test('outbound SQL: callback linkage joins by caller hash within the callback window', function () {
  const r = runCompute_('CSR');
  assert.match(r.sql, /o\.callee_hash = c\.caller_hash/, 'the hash spaces are shared (CLAUDE.md)');
  assert.match(r.sql, /o\.call_date <= c\.call_date \+ 3/, 'OUTBOUND_CALLBACK_WINDOW_DAYS');
  assert.match(r.sql, /ORDER BY o\.call_date, COALESCE\(o\.call_start,'00:00:00'\) LIMIT 1/,
    'EARLIEST callback wins — median delay measures the first dial');
});

test('outbound SQL: agents group by agent_name ONLY — the raw CDR org label is never read', function () {
  const r = runCompute_('CSR');
  assert.match(r.sql, /GROUP BY agent_name\)/);
  assert.ok(!/o\.department/.test(r.sql) && !/agent_dept/.test(r.sql),
    'the contract caveat: attribution is roster-side, the org-label column stays unread');
});

test('outbound SQL: company view drops the dept predicate but keeps the window clause', function () {
  const r = runCompute_('');
  assert.ok(!/entry_queue/.test(r.sql), 'no dept scoping in the company view');
  assert.match(r.sql, /c\.call_start IS NULL OR \(c\.call_start >= '06:30:00'/,
    'the work-window ruling applies to the company figure too');
});

// ── Roster attribution + shaping (pure) ─────────────────────────────────────

test('outbound shaping: dept view keeps ONLY that roster\'s agents; off-roster dialers disclosed, not silently dropped', function () {
  const r = runCompute_('CSR');
  assert.deepEqual(r.out.agents.map(function (a) { return a.agent; }), ['Ann', 'Casey'],
    'Bob (Sales roster) and Ghost (no roster) are out; crossover Casey is in');
  assert.equal(r.out.meta.offRosterAgents, 2);
  // KPIs reconcile against the rows shown.
  assert.equal(r.out.kpis.obTotal, 48);
  assert.equal(r.out.kpis.obConnected, 34);
  assert.equal(r.out.kpis.agents, 2);
  assert.equal(r.out.kpis.obConnectRate, 70.8, '34/48 rounded to 0.1');
  assert.equal(r.out.kpis.obAttSec, Math.round(6800 / 34));
});

test('outbound shaping: company view shows everyone — crossover labeled with all homes, no roster = "Unrostered"', function () {
  const r = runCompute_('');
  const byName = {};
  r.out.agents.forEach(function (a) { byName[a.agent] = a; });
  assert.equal(r.out.agents.length, 4);
  assert.equal(byName.Casey.dept, 'CSR, Sales');
  assert.equal(byName.Ghost.dept, 'Unrostered');
  assert.equal(r.out.meta.unrosteredAgents, 1);
  assert.equal(r.out.meta.offRosterAgents, 0);
  assert.equal(byName.Ghost.obConnectRate, 0, '0/3 is a real 0%, not null');
  assert.equal(byName.Ghost.obAttSec, 0, 'no connected calls → no ATT, never NaN');
});

test('outbound shaping: callback rate uses TRACKED abandons — anonymous callers are not "not called back"', function () {
  const cb = runCompute_('CSR').out.callback;
  assert.equal(cb.abandonedTotal, 25);
  assert.equal(cb.abandonedAnonymous, 5);
  assert.equal(cb.abandonedTracked, 20);
  assert.equal(cb.calledBack, 14);
  assert.equal(cb.calledBackPct, 70, '14/20, NOT 14/25');
  assert.equal(cb.calledBackConnected, 9, 'the disclosed stricter subset');
  assert.equal(cb.medianCallbackSec, 1980, 'rounded to whole seconds');
});

test('outbound shaping: zero tracked abandons → null rate (never NaN/Infinity)', function () {
  const blob = JSON.parse(JSON.stringify(BLOB_));
  blob.callback = { abandonedTotal: 3, abandonedAnonymous: 3, calledBack: 0,
                    calledBackConnected: 0, medianCallbackSec: null };
  const cb = runCompute_('CSR', blob).out.callback;
  assert.equal(cb.abandonedTracked, 0);
  assert.equal(cb.calledBackPct, null);
  assert.equal(cb.medianCallbackSec, null);
});

// ── Failure modes ───────────────────────────────────────────────────────────

test('outbound: no conn → unavailable; a mid-query death → unavailable with the conn closed', function () {
  h.ctx.buildDeptsByAgent_ = function () { return ROSTER_; };
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  const down = JSON.parse(JSON.stringify(h.call('computeOutboundReport_', scope_('CSR'))));
  assert.equal(down.meta.available, false);
  assert.deepEqual(down.agents, []);

  const conn = makeConn_('{}', { throwOnQuery: true });
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  const died = JSON.parse(JSON.stringify(h.call('computeOutboundReport_', scope_('CSR'))));
  assert.equal(died.meta.available, false, 'the catch path returns the clean unavailable shape');
  assert.equal(conn.closed, true, 'finally closes the connection');
});
