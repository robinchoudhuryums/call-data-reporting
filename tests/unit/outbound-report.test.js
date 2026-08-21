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

// Util.gs joins the load for the vetting probe (assertAdmin_ /
// logStatusReturn_); the pre-existing tests are unaffected by it.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'InboundReport.gs', 'OutboundReport.gs'] });

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
  // Work-window scope (owner ruling), the inbound-window-scope pattern:
  // EVERY `FROM inbound_calls c` sub-select (callback + the v2 daily series)
  // must carry the clause — a new sub-select without it silently widens.
  const froms = r.sql.split('FROM inbound_calls c').length - 1;
  const windowed = r.sql.split(
    "c.call_start IS NULL OR (c.call_start >= '06:30:00' AND c.call_start < '15:00:00')").length - 1;
  assert.ok(froms >= 2, 'callback + daily both scan inbound_calls');
  assert.equal(windowed, froms,
    'every dept-facing FROM inbound_calls c must be window-scoped — found ' + windowed + '/' + froms);
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

// ── v2 follow-ons ───────────────────────────────────────────────────────────

test('outbound v2: the abandon denominator EXCLUDES is_internal rows (the inbound metric-query rule v1 missed)', function () {
  const r = runCompute_('CSR');
  assert.match(r.sql, /COALESCE\(c\.is_internal, FALSE\) = FALSE/);
});

test('outbound v2: pendingTail counts tracked, un-called-back abandons still inside the window', function () {
  const r = runCompute_('CSR');
  assert.match(r.sql,
    /'pendingTail', count\(\*\) FILTER \(WHERE c\.caller_hash IS NOT NULL AND cb\.delay_sec IS NULL AND c\.call_date > current_date - 3\)/);
});

test('outbound v2: the daily series groups the SAME join by call_date (chart can never disagree with the KPI)', function () {
  const r = runCompute_('CSR');
  assert.match(r.sql, /'callbackDaily',[\s\S]*GROUP BY c\.call_date/);
  const shaped = runCompute_('CSR', Object.assign({}, BLOB_, {
    callbackDaily: [
      { d: '2026-08-18', tracked: 8, called_back: 6 },
      { d: '2026-08-19', tracked: 0, called_back: 0 },
    ],
  })).out;
  assert.deepEqual(shaped.daily, [
    { date: '2026-08-18', tracked: 8, calledBack: 6, ratePct: 75 },
    { date: '2026-08-19', tracked: 0, calledBack: 0, ratePct: null },
  ], 'a zero-tracked day carries null, never NaN');
});

test('outbound v2: prior-window blocks appear when computePriorWindow_ exists, and route through the SAME roster filter', function () {
  h.ctx.computePriorWindow_ = function () { return { from: '2026-07-14', to: '2026-08-01' }; };
  try {
    const blob = Object.assign({}, BLOB_, {
      agentsPrior: [
        { agent: 'Ann',   ob_total: 20, ob_connected: 10, ob_talk_sec: 2000, attempts: 22 },
        { agent: 'Bob',   ob_total: 99, ob_connected: 99, ob_talk_sec: 9999, attempts: 99 },
        { agent: 'Ghost', ob_total: 50, ob_connected: 50, ob_talk_sec: 5000, attempts: 50 },
      ],
      callbackPrior: { abandonedTotal: 20, abandonedAnonymous: 2, calledBack: 9 },
    });
    const r = runCompute_('CSR', blob);
    assert.match(r.sql, /'agentsPrior'/);
    assert.match(r.sql, /'callbackPrior'/);
    assert.match(r.sql, /2026-07-14/);
    // Prior KPIs exclude Bob (Sales roster) and Ghost (unrostered) exactly
    // like the current window — the delta chips compare like with like.
    assert.equal(r.out.kpisPrior.obTotal, 20);
    assert.equal(r.out.kpisPrior.agents, 1);
    assert.equal(r.out.callbackPrior.abandonedTracked, 18);
    assert.equal(r.out.callbackPrior.calledBackPct, 50);
  } finally {
    delete h.ctx.computePriorWindow_;
  }
});

test('outbound v2: without computePriorWindow_ (or prior data) the prior blocks are null — no chip, no crash', function () {
  const r = runCompute_('CSR');
  assert.ok(!/agentsPrior/.test(r.sql));
  assert.equal(r.out.kpisPrior, null);
  assert.equal(r.out.callbackPrior, null);
});

function uncalledRow_(id, date) {
  return { call_date: date || '2026-08-19', call_id: id, cst_start: '10:41:00',
           entry_queue: 'A_Q_CSR', final_queue: 'A_Q_CSR', abandon_stage: 'queue',
           abandoned_on_hold: false, wait_seconds: 95, hold_seconds: null };
}

test('outbound v2: getOutboundUncalled lists tracked, un-called-back abandons — same predicates, no caller identity', function () {
  h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
  const conn = makeConn_(JSON.stringify([uncalledRow_('c1'), uncalledRow_('c2', '2026-08-18')]));
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  const out = JSON.parse(JSON.stringify(h.call('getOutboundUncalled',
    { from: '2026-08-01', to: '2026-08-19', department: 'CSR' })));
  const sql = conn.sql.join('\n');
  assert.match(sql, /c\.caller_hash IS NOT NULL AND cb\.delay_sec IS NULL/,
    'tracked + not called back — the KPI\'s own definition');
  assert.match(sql, /COALESCE\(c\.is_internal, FALSE\) = FALSE/);
  assert.match(sql, /c\.call_start IS NULL OR \(c\.call_start >= '06:30:00'/,
    'work-window scoped like the report');
  assert.match(sql, /'a_q_csr'/, 'dept predicate applied');
  assert.match(sql, /o\.callee_hash = c\.caller_hash/);
  assert.match(sql, /LIMIT 201/, 'cap + 1 for the truncation probe');
  assert.ok(!/caller_hash/.test(JSON.stringify(out)), 'no hash in the response');
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[0].callId, 'c1');
  assert.equal(out.calls[0].cstStart, '10:41:00');
  assert.equal(out.meta.truncated, false);
  assert.equal(conn.closed, true);

  // Truncation: 201 rows back → newest 200 kept + flagged.
  const many = [];
  for (let i = 0; i < 201; i++) many.push(uncalledRow_('id' + i));
  const conn2 = makeConn_(JSON.stringify(many));
  h.ctx.getDashboardNeonConn_ = function () { return conn2; };
  const big = JSON.parse(JSON.stringify(h.call('getOutboundUncalled',
    { from: '2026-08-01', to: '2026-08-19', department: 'CSR' })));
  assert.equal(big.calls.length, 200);
  assert.equal(big.meta.truncated, true);

  // Gate: rides the same resolver (manager refused while vetted).
  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  assert.throws(function () {
    h.call('getOutboundUncalled', { from: '2026-08-01', to: '2026-08-19' });
  }, /admin-only while it is being vetted/);
  h.state.testUser = null;

  // No conn → clean unavailable.
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.equal(h.call('getOutboundUncalled',
    { from: '2026-08-01', to: '2026-08-19', department: 'CSR' }).meta.available, false);
});

// ── The vetting instrument (runOutboundVettingCheck) ────────────────────────

// The vetting tests stub the two compute globals; capture the REAL vm
// functions here so the last vetting test can restore them (assignment
// over a vm global loses the original -- delete would remove it entirely).
const REAL_COMPUTE_OUTBOUND_ = h.ctx.computeOutboundReport_;
const REAL_COMPUTE_INBOUND_ = h.ctx.computeInboundReport_;
function restoreVetStubs_() {
  h.ctx.computeOutboundReport_ = REAL_COMPUTE_OUTBOUND_;
  h.ctx.computeInboundReport_ = REAL_COMPUTE_INBOUND_;
}

function makeVetConn_(pairsJson, opts) {
  opts = opts || {};
  const conn = {
    sql: [], prepared: [], closed: false,
    createStatement: function () {
      return {
        executeQuery: function (s) {
          conn.sql.push(s);
          let n = 0;
          return { next: function () { return n++ === 0; },
                   getString: function () { return pairsJson; }, close: function () {} };
        },
        close: function () {},
      };
    },
    prepareStatement: function (s) {
      const ps = { _p: {}, setString: function (i, v) { ps._p[i] = v; } };
      ps.executeQuery = function () {
        conn.prepared.push({ sql: s, p: ps._p });
        // Called-back verification (binds the outbound id) expects 1;
        // not-called-back verification expects 0 -- opts flip them to
        // simulate a wrong verdict.
        const isPair = /o\.call_id = \?/.test(s);
        const n = isPair ? (opts.pairVerifyCount !== undefined ? opts.pairVerifyCount : 1)
                         : (opts.uncalledVerifyCount !== undefined ? opts.uncalledVerifyCount : 0);
        let done = 0;
        return { next: function () { return done++ === 0; },
                 getString: function () { return String(n); }, close: function () {} };
      };
      ps.close = function () {};
      return ps;
    },
    close: function () { conn.closed = true; },
  };
  return conn;
}

const VET_PAIRS_ = JSON.stringify([
  { a_id: 'ab1', a_date: '2026-08-19', a_start: '10:00:00',
    o_id: 'ob1', o_date: '2026-08-19', o_start: '11:00:00' },
  { a_id: 'ab2', a_date: '2026-08-18', a_start: '09:00:00',
    o_id: null, o_date: null, o_start: null },
]);

function installVetStubs_(obAbandoned, ibAbandoned, conn) {
  h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
  h.state.props = { OUTBOUND_VETTING_FROM: '2026-08-06', OUTBOUND_VETTING_TO: '2026-08-19' };
  h.ctx.computeOutboundReport_ = function () {
    return { meta: { available: true }, callback: { abandonedTotal: obAbandoned } };
  };
  h.ctx.computeInboundReport_ = function () {
    return { meta: { available: true }, kpis: { abandoned: ibAbandoned } };
  };
  h.ctx.getDashboardNeonConn_ = function () { return conn || makeVetConn_(VET_PAIRS_); };
}

test('vetting: clean run — parity across both code paths + both sample verdicts re-verified → ok', function () {
  const conn = makeVetConn_(VET_PAIRS_);
  installVetStubs_(25, 25, conn);
  const out = JSON.parse(JSON.stringify(h.call('runOutboundVettingCheck')));
  assert.match(out.result, /^ok parity 25 abandons/);
  assert.match(out.result, /1 called-back \+ 1 not-called-back/);
  assert.equal(conn.closed, true);
  // The pairs sweep carries the report's own denominator predicates.
  const pairs = conn.sql.join('\n');
  assert.match(pairs, /COALESCE\(c\.is_internal, FALSE\) = FALSE/);
  assert.match(pairs, /c\.call_start IS NULL OR \(c\.call_start >= '06:30:00'/);
  assert.match(pairs, /c\.caller_hash IS NOT NULL/);
  assert.match(pairs, /o\.callee_hash = c\.caller_hash/);
  assert.match(pairs, /LIMIT 200\)/);
  // Per-sample re-verification: bound params, never inlined ids; explicit
  // hash-equality + timestamp-ordering in a separately-written query.
  assert.equal(conn.prepared.length, 2);
  const pairV = conn.prepared.filter(function (q) { return /o\.call_id = \?/.test(q.sql); })[0];
  assert.ok(pairV, 'called-back verification ran');
  assert.equal(pairV.p[1], 'ab1');
  assert.equal(pairV.p[3], 'ob1');
  assert.match(pairV.sql, /o\.callee_hash = c\.caller_hash/);
  assert.match(pairV.sql, />= \(c\.call_date::timestamp/);
  const uncV = conn.prepared.filter(function (q) { return /SELECT caller_hash FROM inbound_calls/.test(q.sql); })[0];
  assert.ok(uncV, 'not-called-back verification ran');
  assert.equal(uncV.p[1], 'ab2');
});

test('vetting: the two reports disagreeing is a MISMATCH, never ok', function () {
  installVetStubs_(25, 24);
  assert.match(h.call('runOutboundVettingCheck').result, /^MISMATCH parity: outbound=25 vs inbound=24/);
});

test('vetting: zero abandons is INCONCLUSIVE (the Batch-6 gate contract) — parity over nothing certifies nothing', function () {
  installVetStubs_(0, 0);
  const out = h.call('runOutboundVettingCheck');
  assert.match(out.result, /^INCONCLUSIVE \(0 abandons/);
  assert.ok(!/^ok/.test(out.result));
});

test('vetting: a failed sample re-verification is a MISMATCH naming the call', function () {
  const conn = makeVetConn_(VET_PAIRS_, { pairVerifyCount: 0 });   // pair no longer verifies
  installVetStubs_(25, 25, conn);
  const out = h.call('runOutboundVettingCheck');
  assert.match(out.result, /^MISMATCH samples: 1\/2/);
  assert.match(out.result, /ab1/);
});

test('vetting: unavailable computes and bad props FAIL loudly; the gate is admin-only', function () {
  installVetStubs_(25, 25);
  h.ctx.computeOutboundReport_ = function () { return { meta: { available: false }, callback: {} }; };
  assert.match(h.call('runOutboundVettingCheck').result, /^FAILED \(outbound compute unavailable/);

  installVetStubs_(25, 25);
  h.ctx.computeInboundReport_ = function () { return { meta: { available: true, unmapped: true }, kpis: {} }; };
  h.state.props.OUTBOUND_VETTING_DEPT = 'CSR';
  assert.match(h.call('runOutboundVettingCheck').result, /^FAILED \(dept has no mapped queues/);

  installVetStubs_(25, 25);
  h.state.props.OUTBOUND_VETTING_FROM = 'last week';
  assert.throws(function () { h.call('runOutboundVettingCheck'); }, /YYYY-MM-DD/);

  installVetStubs_(25, 25);
  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  assert.throws(function () { h.call('runOutboundVettingCheck'); }, /admin/i);
  h.state.testUser = null;
});

test('vetting: unset date props default to a ~14-day window and still run', function () {
  installVetStubs_(25, 25);
  delete h.state.props.OUTBOUND_VETTING_FROM;
  delete h.state.props.OUTBOUND_VETTING_TO;
  const out = h.call('runOutboundVettingCheck');
  assert.match(out.result, /^ok parity 25/);
  assert.match(out.result, /\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/);
  restoreVetStubs_();   // last vetting test: hand the real computes back
});

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
