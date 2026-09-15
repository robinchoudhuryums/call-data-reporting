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

// 6c: the RELEASE path. The vetting gate above is the only thing standing
// between this report and its managers, and until now nothing proved that
// removing it actually WORKS -- the per-dept branch beneath it has been
// unreachable dead code since the day it was written. Releasing on an
// unexercised branch is how a runbook's last step turns into an incident.
//
// These flip the real switch (hence `var`, not `const`, in OutboundReport.gs)
// and assert the latent per-dept semantics, so the operator's step 4 is a
// flag flip over tested behavior rather than a leap.
test('6c: with the vetting gate released, a single-dept manager is PINNED to their dept', function () {
  const orig = h.ctx.OUTBOUND_VETTING_GATE_;
  h.ctx.OUTBOUND_VETTING_GATE_ = false;
  try {
    h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
    // No dept passed -> their own, never a company view.
    const s = h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19' });
    assert.equal(s.dept, 'CSR');
    assert.equal(s.companyView, false, 'a single-dept manager must never get the company view');
    // ALL is not an escape hatch for them.
    assert.equal(h.call('outboundResolveRequest_',
      { from: '2026-08-01', to: '2026-08-19', department: 'ALL' }).dept, 'CSR');
    // Another dept is refused -- the release widens WHO may read, never WHAT.
    assert.throws(function () {
      h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'Sales' });
    }, /Not authorized for this department/);
    // role 'none' stays out regardless of the gate.
    h.state.testUser = { email: 'n@x.com', role: 'none' };
    assert.throws(function () {
      h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19' });
    }, /Not authorized/);
  } finally {
    h.ctx.OUTBOUND_VETTING_GATE_ = orig;
    h.state.testUser = null;
  }
});

test('6c: released, a MULTI-dept manager may pick any assigned dept and no other', function () {
  const orig = h.ctx.OUTBOUND_VETTING_GATE_;
  h.ctx.OUTBOUND_VETTING_GATE_ = false;
  try {
    h.state.testUser = { email: 'm2@x.com', role: 'manager', department: 'CSR', departments: ['CSR', 'Sales'] };
    assert.equal(h.call('outboundResolveRequest_',
      { from: '2026-08-01', to: '2026-08-19', department: 'Sales' }).dept, 'Sales');
    // Blank falls back to their FIRST dept, not a company view (Tier C).
    const blank = h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19' });
    assert.equal(blank.dept, 'CSR');
    assert.equal(blank.companyView, false);
    // An allDepts manager takes the admin-style branch: ALL means company.
    h.state.testUser = { email: 'all@x.com', role: 'manager', allDepts: true, departments: ['CSR', 'Sales'] };
    const all = h.call('outboundResolveRequest_',
      { from: '2026-08-01', to: '2026-08-19', department: 'ALL' });
    assert.equal(all.companyView, true);
  } finally {
    h.ctx.OUTBOUND_VETTING_GATE_ = orig;
    h.state.testUser = null;
  }
});

test('6c: the gate is the ONLY thing the release flips — admins are unaffected either way', function () {
  const orig = h.ctx.OUTBOUND_VETTING_GATE_;
  try {
    h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
    h.ctx.OUTBOUND_VETTING_GATE_ = true;
    const gated = h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'CSR' });
    h.ctx.OUTBOUND_VETTING_GATE_ = false;
    const open = h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'CSR' });
    assert.deepEqual(open, gated,
      'flipping the release switch must not change one byte of what an ADMIN '
      + 'resolves to -- if it does, the switch is doing more than releasing.');
  } finally {
    h.ctx.OUTBOUND_VETTING_GATE_ = orig;
    h.state.testUser = null;
  }
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

test('vetting: PASS self-clears OUTBOUND_VETTING_* params; MISMATCH/INCONCLUSIVE keep them for the re-run', function () {
  // Prop-registry batch: the tool params otherwise accumulate in the store
  // forever. Only the PASS verdict clears them — the OPS-8 gate contract's
  // fix-and-re-run loop needs the SAME window on a non-clean outcome.
  installVetStubs_(25, 24);
  h.call('runOutboundVettingCheck');   // MISMATCH
  assert.equal(h.state.props.OUTBOUND_VETTING_FROM, '2026-08-06', 'MISMATCH keeps the window');
  installVetStubs_(0, 0);
  h.call('runOutboundVettingCheck');   // INCONCLUSIVE
  assert.equal(h.state.props.OUTBOUND_VETTING_TO, '2026-08-19', 'INCONCLUSIVE keeps the window');
  installVetStubs_(25, 25, makeVetConn_(VET_PAIRS_));
  h.call('runOutboundVettingCheck');   // ok
  assert.ok(!('OUTBOUND_VETTING_FROM' in h.state.props), 'PASS clears FROM');
  assert.ok(!('OUTBOUND_VETTING_TO' in h.state.props), 'PASS clears TO');
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

// ══ The owner's six-point round (2026-09-15, outboundReport:v3) ════════════
//
// Five code points. Point 1 ("release it") is an operator gate, not code —
// Operator State #63 — and the per-dept CALLBACK table is parked awaiting an
// owner ruling, so neither appears here.
//
// The through-line worth pinning: every one of these four data additions has
// to land in the SQL *and* in the sheet fallback, because the two feed ONE
// shaper and the source-parity contract (outbound-fallback.test.js) compares
// them byte for byte. The shared ladder below is the mechanism that keeps the
// bucket boundaries from drifting; these tests are what keep the mechanism.

const plain_ = function (v) { return JSON.parse(JSON.stringify(v)); };

// ── (3) the time-to-callback distribution ──────────────────────────────────

test('(3) THE RULE: the SQL buckets and the fallback buckets come from ONE ladder', function () {
  // Not "they happen to agree today" — they are generated from the same
  // array, and this asserts the generation rather than a snapshot.
  const ladder = h.ctx.OUTBOUND_CALLBACK_BUCKETS_;
  const sql = h.ctx.outboundBucketSql_();
  ladder.forEach(function (b) {
    assert.ok(sql.indexOf("'" + b.key + "'") !== -1, 'the SQL omits bucket ' + b.key);
    if (b.maxSec !== null) {
      assert.ok(sql.indexOf('<= ' + b.maxSec) !== -1,
        'the SQL omits the ' + b.key + ' upper bound');
    }
  });
  assert.ok(sql.indexOf('cb.delay_sec >= 0') !== -1,
    'negative delays must be excluded, matching the median filter');
  // The LOWER bounds matter more than the upper ones here: SQL FILTERs are
  // independent (unlike the JS loop, which returns on first match), so
  // without `> prev` every bucket would also count everything below it and
  // the strip would total several times the callbacks it describes.
  const bounded = h.ctx.OUTBOUND_CALLBACK_BUCKETS_.slice(1);
  let prev = h.ctx.OUTBOUND_CALLBACK_BUCKETS_[0].maxSec;
  bounded.forEach(function (b) {
    assert.ok(sql.indexOf('cb.delay_sec > ' + prev) !== -1,
      'bucket ' + b.key + ' has no lower bound — the SQL buckets overlap');
    prev = b.maxSec;
  });
});

test('(3) the JS bucketer relies on an ASCENDING ladder — pin that it is one', function () {
  // The `d > prev` guard in outboundBucketDelays_ is defensive: the loop
  // returns on first match, so with a sorted ladder it is redundant (a
  // mutation removing it is equivalent). What is NOT redundant is the sort
  // order itself — an out-of-order ladder would silently swallow buckets.
  const ladder = h.ctx.OUTBOUND_CALLBACK_BUCKETS_;
  for (let i = 1; i < ladder.length; i++) {
    const prevMax = ladder[i - 1].maxSec;
    assert.notEqual(prevMax, null, 'only the LAST bucket may be open-ended');
    if (ladder[i].maxSec !== null) {
      assert.ok(ladder[i].maxSec > prevMax,
        'ladder must ascend: ' + ladder[i].key + ' <= ' + ladder[i - 1].key);
    }
  }
  assert.equal(ladder[ladder.length - 1].maxSec, null,
    'the final bucket must be open-ended or long delays vanish');
});

test('(3) buckets are cumulative-EXCLUSIVE, so they sum to the called-back total', function () {
  // A delay must land in exactly one bucket. If the bounds overlapped, the
  // strip would total more than the callbacks it describes.
  const b = h.ctx.outboundBucketDelays_([0, 899, 900, 901, 3600, 3601, 14400, 86400, 86401, 999999]);
  assert.deepEqual(plain_(b), { m15: 3, h1: 2, h4: 2, d1: 1, later: 2 });
  const total = Object.keys(b).reduce(function (a, k) { return a + b[k]; }, 0);
  assert.equal(total, 10, 'every non-negative delay lands in exactly one bucket');
});

test('(3) a negative or null delay is DROPPED, never bucketed', function () {
  const b = h.ctx.outboundBucketDelays_([-1, null, undefined, 60]);
  assert.equal(b.m15, 1);
  assert.equal(Object.keys(b).reduce(function (a, k) { return a + b[k]; }, 0), 1);
});

test('(3) an empty delay list yields all-zero buckets, not a missing key', function () {
  const b = h.ctx.outboundBucketDelays_([]);
  h.ctx.OUTBOUND_CALLBACK_BUCKETS_.forEach(function (x) {
    assert.equal(b[x.key], 0, 'bucket ' + x.key + ' must exist even at zero');
  });
});

// ── (2) the connected-callback rate ────────────────────────────────────────

test('(2) THE RULE: both callback rates divide by the SAME trackable denominator', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [], callback: { abandonedTotal: 25, abandonedAnonymous: 5,
        calledBack: 14, calledBackConnected: 7 } },
    {});
  assert.equal(out.callback.abandonedTracked, 20);
  assert.equal(out.callback.calledBackPct, 70);          // 14/20
  assert.equal(out.callback.calledBackConnectedPct, 35); // 7/20 — NOT 7/14
});

test('(2) the connected rate can never exceed the raw rate (it is a strict subset)', function () {
  [[10, 10], [10, 3], [0, 0]].forEach(function (pair) {
    const out = h.call('outboundShapeReport_',
      { from: 'a', to: 'b', dept: '', companyView: true },
      { agents: [], callback: { abandonedTotal: 20, abandonedAnonymous: 0,
          calledBack: pair[0], calledBackConnected: pair[1] } },
      {});
    if (out.callback.calledBackPct != null) {
      assert.ok(out.callback.calledBackConnectedPct <= out.callback.calledBackPct,
        'connected ' + out.callback.calledBackConnectedPct + '% > raw ' + out.callback.calledBackPct + '%');
    }
  });
});

test('(2) an all-anonymous window yields NULL rates, not 0% — nothing was trackable', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [], callback: { abandonedTotal: 6, abandonedAnonymous: 6,
        calledBack: 0, calledBackConnected: 0 } },
    {});
  assert.equal(out.callback.abandonedTracked, 0);
  assert.equal(out.callback.calledBackPct, null, '0% would read as a failure to call back');
  assert.equal(out.callback.calledBackConnectedPct, null);
});

test('(2) the PRIOR block carries the connected rate too, so the tile gets a real delta', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [], callback: { abandonedTotal: 10, abandonedAnonymous: 0, calledBack: 5, calledBackConnected: 2 },
      callbackPrior: { abandonedTotal: 10, abandonedAnonymous: 0, calledBack: 4, calledBackConnected: 1 } },
    {});
  assert.equal(out.callbackPrior.calledBackPct, 40);
  assert.equal(out.callbackPrior.calledBackConnectedPct, 10);
});

// ── (4) the unconnected ring split ─────────────────────────────────────────

test('(4) THE RULE: an unconnected call with NO ring is UNKNOWN, never filed as brief', function () {
  // 10 calls: 4 connected, 3 brief, 2 real, and 1 with no ring at all.
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [{ agent: 'Ann', ob_total: 10, ob_connected: 4,
        ob_unconn_brief: 3, ob_unconn_real: 2, ob_talk_sec: 100, attempts: 12 }],
      callback: {} },
    { Ann: ['CSR'] });
  const a = out.agents[0];
  assert.equal(a.obUnconnectedBrief, 3);
  assert.equal(a.obUnconnectedReal, 2);
  assert.equal(a.obUnconnectedUnknown, 1,
    'the unclassified remainder must stay visible, not be absorbed into a bucket');
  assert.equal(a.obUnconnectedBrief + a.obUnconnectedReal + a.obUnconnectedUnknown,
    a.obTotal - a.obConnected, 'the split must account for every unconnected call');
});

test('(4) THE BOUNDARY: a ring of exactly the threshold is a REAL attempt, not brief', function () {
  // The SQL says `ring_seconds < N` / `>= N`. The fallback must agree
  // EXACTLY, and only on the Neon-down path — where nobody would notice a
  // one-character drift. This is the pin that makes the two comparable.
  const N = h.ctx.OUTBOUND_BRIEF_RING_SEC_;
  assert.equal(h.ctx.outboundClassifyRing_(N - 1), 'brief');
  assert.equal(h.ctx.outboundClassifyRing_(N), 'real', 'the boundary belongs to REAL');
  assert.equal(h.ctx.outboundClassifyRing_(N + 1), 'real');
  assert.equal(h.ctx.outboundClassifyRing_(0), 'brief');
});

test('(4) a blank / non-numeric ring is UNKNOWN, never a default bucket', function () {
  ['', null, undefined, 'n/a'].forEach(function (v) {
    assert.equal(h.ctx.outboundClassifyRing_(v), 'unknown', 'input ' + JSON.stringify(v));
  });
});

test('(4) the fallback classifies through the SAME helper the boundary pin covers', function () {
  assert.match(OB_SRC, /var cls = outboundClassifyRing_\(row\[8\]\);/,
    'the sheet fallback must not re-implement the ring boundary inline — that '
    + 'is how the two paths drift on a path nobody watches');
});

test('(4) the unknown remainder can never go negative on inconsistent input', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [{ agent: 'Ann', ob_total: 2, ob_connected: 2,
        ob_unconn_brief: 5, ob_unconn_real: 5, ob_talk_sec: 0, attempts: 2 }], callback: {} },
    { Ann: ['CSR'] });
  assert.equal(out.agents[0].obUnconnectedUnknown, 0);
});

test('(4) the split rolls up into the scope KPIs and carries its threshold', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [
        { agent: 'Ann', ob_total: 6, ob_connected: 2, ob_unconn_brief: 3, ob_unconn_real: 1, ob_talk_sec: 60, attempts: 6 },
        { agent: 'Bob', ob_total: 4, ob_connected: 1, ob_unconn_brief: 0, ob_unconn_real: 2, ob_talk_sec: 30, attempts: 4 },
      ], callback: {} },
    { Ann: ['CSR'], Bob: ['CSR'] });
  assert.equal(out.kpis.obUnconnectedBrief, 3);
  assert.equal(out.kpis.obUnconnectedReal, 3);
  assert.equal(out.kpis.obUnconnectedUnknown, 1);
  assert.equal(out.kpis.briefRingSec, h.ctx.OUTBOUND_BRIEF_RING_SEC_,
    'the client labels the tiles with this threshold — it must ship, not be hardcoded there');
});

// ── (6) callback rate by abandon hour ──────────────────────────────────────

test('(6) THE RULE: the hour cut and the daily series describe the SAME population', function () {
  const blob = { agents: [], callback: {},
    callbackDaily: [{ d: '2026-08-10', tracked: 6, called_back: 3 },
                    { d: '2026-08-11', tracked: 4, called_back: 3 }],
    callbackByHour: [{ h: 8, tracked: 7, called_back: 4 }, { h: 9, tracked: 3, called_back: 2 }] };
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true }, blob, {});
  const dayTracked = out.daily.reduce(function (a, r) { return a + r.tracked; }, 0);
  const hourTracked = out.callbackByHour.reduce(function (a, r) { return a + r.tracked; }, 0);
  assert.equal(dayTracked, hourTracked, 'two cuts of one window must total alike');
  assert.equal(out.callbackByHour[0].ratePct, 57.1);
});

test('(6) an hour with no trackable abandons rates NULL, not 0% ', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true },
    { agents: [], callback: {}, callbackByHour: [{ h: 13, tracked: 0, called_back: 0 }] },
    {});
  assert.equal(out.callbackByHour[0].ratePct, null,
    '0% would brand a quiet hour as a total failure to call back');
});

test('(6) a payload with no hour data yields [], so the client hides the strip', function () {
  const out = h.call('outboundShapeReport_',
    { from: 'a', to: 'b', dept: '', companyView: true }, { agents: [], callback: {} }, {});
  assert.deepEqual(plain_(out.callbackByHour), []);
});

// ── (5) the email ──────────────────────────────────────────────────────────

const fs_ = require('fs');
const path_ = require('path');
const OB_SRC = fs_.readFileSync(path_.join(__dirname, '..', '..', 'apps-script',
  'department-dashboard', 'OutboundReport.gs'), 'utf8');

test('(5) the email goes through sendAppEmail_ and the banded EmailKit shell', function () {
  // R28 (BCC the first admin) and R30 (every shell caller passes `band`) are
  // swept repo-wide by app-email/email-kit-v2; pinned here too so a local
  // edit fails in the suite that owns this file.
  assert.match(OB_SRC, /function sendOutboundReportEmail\(req\)/);
  assert.match(OB_SRC, /sendAppEmail_\(\{ to: email,/,
    'never MailApp.sendEmail directly — it would skip the BCC rule');
  assert.match(OB_SRC, /ekShellHtml_\(\{\s*\n\s*band:/,
    'R30: the shell caller must pass a band');
});

test('(5) the email RECOMPUTES through the shared resolver — it cannot drift from the screen', function () {
  assert.match(OB_SRC,
    /function sendOutboundReportEmail\(req\) \{\s*\n\s*const scope = outboundResolveRequest_\(req\);/,
    'the email must inherit the vetting gate + per-dept pinning, not re-derive them');
  assert.match(OB_SRC, /const data = computeOutboundReport_\(scope\);/,
    'recompute, never trust a client-supplied payload');
  assert.match(OB_SRC, /logReportUsage_\('outbound:email'/,
    'a send is a usage event (INV-01 append-only carve-out)');
});

test('(5) the delay table stays QUIET when there is nothing to distribute', function () {
  assert.equal(h.ctx.outboundEmailDelayTable_(null, 0), '');
  assert.equal(h.ctx.outboundEmailDelayTable_({ m15: 0 }, 0), '',
    'zero callbacks must not render an all-zero table reading as "all slow"');
  const html = h.ctx.outboundEmailDelayTable_({ m15: 3, h1: 1, h4: 0, d1: 0, later: 0 }, 4);
  assert.match(html, /within 15 min/);
  assert.match(html, /75%/, 'the share of callbacks, not a raw count alone');
});
