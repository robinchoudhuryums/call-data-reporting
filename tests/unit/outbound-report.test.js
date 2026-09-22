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
    // A-1: the AGENT role (fail-closed shape: department null, departments
    // []) is neither 'none' nor 'manager'. A role-none DENYLIST let it fall
    // through to the admin-style branch -- company view, any dept -- the
    // day the gate flips. The allowlist refuses it before the dept branch.
    h.state.testUser = { email: 'a@x.com', role: 'agent', department: null, departments: [],
                         agentDept: 'CSR', agentName: 'Agent One' };
    assert.throws(function () {
      h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19' });
    }, /Not authorized/);
    assert.throws(function () {
      h.call('outboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'ALL' });
    }, /Not authorized/);
    // Same allowlist on the Inbound resolver (loaded in this suite), with its
    // own vetting gate still standing: the agent must be refused by the
    // allowlist, never by the "admin-only while vetted" message.
    assert.throws(function () {
      h.call('inboundResolveRequest_', { from: '2026-08-01', to: '2026-08-19', department: 'ALL' });
    }, /^Error: Not authorized\.$/);
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

// ══ probeOutboundAnswerQuality — STEP 1 of the answer-quality work ═════════
//
// docs/outbound-callback-dept-plan.md Part 2. The probe exists to answer ONE
// question with data: is the ring distribution on connected calls bimodal,
// with a tight spike at the carrier's no-answer timeout? If it is, a
// voicemail threshold is defensible; if it is not, the probe must REFUSE to
// hand over a number. So the tests below spend most of their effort on the
// refusals — a probe that only knows how to say yes is worse than none,
// because its "yes" carries no information.

// ── The pure spike detector ────────────────────────────────────────────────

// Builds a sparse [{sec, n}] histogram from a {sec: n} literal.
function hist_(map) {
  return Object.keys(map).map(function (k) { return { sec: Number(k), n: map[k] }; });
}
// A realistic shape: a broad human cluster over 1-10s plus a tight timeout
// spike at 24-26s. `scale` multiplies everything so the sample-size gate can
// be crossed or not without changing the SHAPE.
function bimodal_(scale, peakSec) {
  peakSec = peakSec || 25;
  const m = {};
  [12, 20, 26, 30, 28, 24, 18, 14, 10, 8].forEach(function (n, i) { m[i + 1] = n * scale; });
  // The shoulders clear half of the peak, so the FWHM band is 24..26 --
  // the multi-second case. The single-second case has its own test.
  m[peakSec - 1] = 50 * scale; m[peakSec] = 90 * scale; m[peakSec + 1] = 48 * scale;
  return m;
}
function total_(map) {
  return Object.keys(map).reduce(function (a, k) { return a + map[k]; }, 0);
}

test('probe/spike: a real bimodal distribution yields the band off the measured spike', function () {
  const m = bimodal_(3);
  const s = JSON.parse(JSON.stringify(h.ctx.obProbeRingSpike_(hist_(m), total_(m))));
  assert.equal(s.spike, true);
  assert.equal(s.reason, 'ok');
  assert.equal(s.peakSec, 25);
  // FWHM: 24 and 26 both clear half of 270, so the band is 24..26.
  assert.equal(s.leftSec, 24);
  assert.equal(s.rightSec, 26);
  assert.equal(s.widthSec, 3);
  // The plan's two parameters, read straight off the spike.
  assert.equal(s.suggestedVmRingSec, 24, 'the threshold is the LEFT edge, not the peak');
  assert.equal(s.suggestedToleranceSec, 1, 'the tolerance is the half-width');
  assert.ok(s.belowShare > 0.15, 'the human cluster below the spike is what makes it bimodal');
});

test('probe/spike: REFUSES a sample too small to mean anything', function () {
  // The same SHAPE, a tenth of the mass: a textbook spike over 38 calls is
  // still 38 calls.
  const m = { 1: 3, 2: 5, 3: 6, 4: 5, 5: 4, 24: 5, 25: 9, 26: 4 };
  assert.ok(total_(m) < 200, 'fixture must sit under the gate');
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, false);
  assert.equal(s.reason, 'too-few-rows');
  assert.equal(s.suggestedVmRingSec, null, 'no number is offered on a refusal');
  assert.match(h.ctx.obProbeSpikeHint_(s), /widen OUTBOUND_PROBE_FROM/);
});

test('probe/spike: REFUSES a flat distribution — the plan\'s "say so" case', function () {
  // Every second equally likely: there is no timeout to find.
  const m = {};
  for (let i = 1; i <= 60; i++) m[i] = 20;
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, false);
  assert.equal(s.reason, 'flat');
  assert.match(h.ctx.obProbeSpikeHint_(s), /distribution is flat, so no threshold is defensible/);
});

test('probe/spike: a human cluster TALLER than the spike is still bimodal', function () {
  // The case that matters most in practice and that a global-max peak
  // search gets wrong: most calls are answered by people, so the human mode
  // (700 at 4s) towers over the timeout spike (150 at 25s). The spike is
  // sought in the at-or-above-floor region precisely so this still reads as
  // bimodal instead of "the modal ring is 4s".
  const m = { 1: 40, 2: 120, 3: 300, 4: 700, 5: 260, 6: 100, 7: 40, 8: 20,
              24: 90, 25: 150, 26: 85 };
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, true);
  assert.equal(s.peakSec, 25, 'the 700-call bucket at 4s must not become the peak');
  assert.equal(s.suggestedVmRingSec, 24);
  assert.ok(s.belowShare > 0.5, 'the human cluster is the mass below, not a competitor');
});

test('probe/spike: nothing rings past the floor → no candidate timeout', function () {
  const m = { 1: 200, 2: 400, 3: 500, 4: 300, 5: 150 };
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, false);
  assert.equal(s.reason, 'empty-region');
  assert.match(h.ctx.obProbeSpikeHint_(s), /no candidate timeout to measure/);
});

test('probe/spike: REFUSES a high peak with NO cluster below it (not bimodal)', function () {
  // Everything piles at 25s and nothing rings short. One mode is not two;
  // the voicemail story requires people AND machines.
  const m = { 24: 60, 25: 900, 26: 50, 40: 5, 45: 5 };
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, false);
  assert.equal(s.reason, 'unimodal');
  assert.match(h.ctx.obProbeSpikeHint_(s), /no human cluster/);
  // One decimal, so a refusal never reads as a contradiction (the live run
  // printed "only 8% (need 8%)" for 7.6% vs 8.0%).
  assert.match(h.ctx.obProbeSpikeHint_(s), /\d\.\d% of connects ring SHORTER/);
});

test('probe/spike: REFUSES a broad hump at the right place (a cluster, not a timeout)', function () {
  // Mass spread over ~20 seconds around 30s: plausible-looking, and exactly
  // the shape a half-open threshold would misread as a hard timeout.
  const m = { 1: 60, 2: 80, 3: 90, 4: 70, 5: 50, 6: 40, 7: 30, 8: 20 };
  for (let i = 20; i <= 42; i++) m[i] = 60 + (i === 31 ? 20 : 0);
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, false);
  assert.equal(s.reason, 'too-wide');
  assert.match(h.ctx.obProbeSpikeHint_(s), /broad cluster, not a fixed timeout/);
});

test('probe/spike: REFUSES a tight spike too small to build a rule on', function () {
  // A genuine narrow spike at 25s, but it is ~3% of connects. Real, and not
  // worth reclassifying a report over.
  const m = {};
  for (let i = 1; i <= 10; i++) m[i] = 200;
  m[25] = 70;
  const s = h.ctx.obProbeRingSpike_(hist_(m), total_(m));
  assert.equal(s.spike, false);
  assert.equal(s.reason, 'spike-too-small');
  assert.match(h.ctx.obProbeSpikeHint_(s), /too little to build a rule on/);
  // The live refusal's exact shape: 7.6% against an 8.0% floor must not both
  // render as "8%". A refusal has to be legible as a refusal.
  const live = h.ctx.obProbeSpikeHint_({ reason: 'spike-too-small', spikeShare: 0.076 });
  assert.match(live, /only 7\.6% of connects \(need 8\.0%\)/);
});

test('probe/spike: a zero median bucket is unbounded prominence, not a crash', function () {
  // Concentrated data leaves most of the 61 buckets empty, so the median IS
  // zero — the ratio gate must not divide by it, and the JSON must not carry
  // an Infinity (JSON.stringify turns it into null silently).
  const m = { 2: 300, 3: 200, 24: 120, 25: 400, 26: 110 };
  const s = JSON.parse(JSON.stringify(h.ctx.obProbeRingSpike_(hist_(m), total_(m))));
  assert.equal(s.baseline, 0);
  assert.equal(s.ratio, null, 'reported as null, and the share/width gates carry the decision');
  assert.equal(s.spike, true);
  // The shoulders here sit UNDER half the peak, so the measured spike is a
  // single second and the tolerance is 0. Reported as measured rather than
  // padded to look safer -- a fabricated width is a fabricated parameter.
  assert.equal(s.leftSec, 25);
  assert.equal(s.rightSec, 25);
  assert.equal(s.suggestedVmRingSec, 25);
  assert.equal(s.suggestedToleranceSec, 0);
});

test('probe/spike: out-of-domain buckets are ignored, not folded into the edges', function () {
  const m = bimodal_(3);
  const rows = hist_(m).concat([{ sec: 90, n: 5000 }, { sec: -3, n: 5000 }, { sec: null, n: 9 }]);
  const s = h.ctx.obProbeRingSpike_(rows, total_(m));
  assert.equal(s.peakSec, 25, 'a 90s row must not become the peak by clamping to 60');
  assert.equal(s.spike, true);
});

// ── The review sampler (Step 1b ground truth) ──────────────────────────────

function revRows_() {
  // One row per stratum, with ring values that would GIVE THE STRATUM AWAY if
  // they reached the worksheet.
  return [
    { stratum: 'A-instant', callDate: '2026-09-02', time: '09:14:00', agent: 'Ann A', ext: '101', dept: 'CSR',
      ring: 0, talk: 120, attempts: 1, connected: true },
    { stratum: 'B-human', callDate: '2026-09-03', time: '10:01:00', agent: 'Bob B', ext: '102', dept: 'Sales',
      ring: 6, talk: 90, attempts: 1, connected: true },
    { stratum: 'C-inband', callDate: '2026-09-04', time: '11:22:00', agent: 'Cid C', ext: '103', dept: 'CSR',
      ring: 31, talk: 35, attempts: 1, connected: true },
    { stratum: 'D-above', callDate: '2026-09-05', time: '12:40:00', agent: 'Dee D', ext: '104', dept: 'Power',
      ring: 44, talk: 20, attempts: 1, connected: true },
    { stratum: 'E-unconnected', callDate: '2026-09-08', time: '13:05:00', agent: 'Eve E', ext: '105', dept: 'Sales',
      ring: 28, talk: null, attempts: 3, connected: false },
  ];
}

test('review: the worksheet is BLINDED — no ring, talk or stratum reaches it', function () {
  const rows = h.ctx.obReviewShuffleAndToken_(revRows_(), function () { return 0.5; });
  const ws = h.ctx.obReviewGridToTsv_(h.ctx.obReviewWorksheetGrid_(rows));
  // The locator fields must be there, or the operator cannot find the call.
  assert.match(ws, /Ann A/);
  assert.match(ws, /2026-09-04\t11:22:00/, 'date and time must locate the recording');
  // And the hypothesis must NOT be.
  ['A-instant', 'B-human', 'C-inband', 'D-above', 'E-unconnected'].forEach(function (id) {
    assert.ok(ws.indexOf(id) === -1, 'the worksheet must not name the stratum: ' + id);
  });
  const head = ws.split('\n')[0];
  assert.ok(!/ring/i.test(head) && !/talk/i.test(head),
    'no ring or talk column may appear in the worksheet header: ' + head);
  // A ring of 31 in a labelling sheet is the answer written next to the
  // question. Checked per row, since a bare "31" could appear in a date.
  ws.split('\n').slice(1).forEach(function (line) {
    const cells = line.split('\t');
    assert.equal(cells.length, h.ctx.OB_REVIEW_WS_HEADER_.length,
      'every row carries the header column count');
    assert.ok(cells.indexOf('31') === -1 && cells.indexOf('44') === -1,
      'a ring value must not appear as a cell: ' + line);
  });
});

test('review: the recording link is a TEMPLATE, and renders as a bare URL', function () {
  const row = { callDate: '2026-09-21', time: '16:55:00', agent: 'Ann A', ext: '101' };
  const t = 'https://admin.8x8.com/recordings?date={date}&ext={ext}&q={agent}';
  const url = h.ctx.obReviewRecordingUrl_(t, row);
  assert.equal(url, 'https://admin.8x8.com/recordings?date=2026-09-21&ext=101&q=Ann%20A',
    'placeholders substitute and each value is URI-encoded');
  // The trap: a =HYPERLINK() formula would be neutralised by sheetSafeCell_
  // into visible text, so the cell must be a bare URL that Sheets auto-links.
  assert.ok(!/^=/.test(url), 'never a formula');
  assert.equal(h.ctx.sheetSafeCell_(url), url,
    'and it must survive the injection guard unchanged, or the link breaks');
});

test('review: no template means no link, and a non-URL template is refused', function () {
  const row = { callDate: '2026-09-21', time: '16:55:00', agent: 'Ann A', ext: '101' };
  ['', null, undefined, '   '].forEach(function (t) {
    assert.equal(h.ctx.obReviewRecordingUrl_(t, row), '', 'absent template -> empty cell');
  });
  // A stray non-http value must not reach a cell as if it were a link.
  assert.equal(h.ctx.obReviewRecordingUrl_('javascript:alert(1)', row), '');
  assert.equal(h.ctx.obReviewRecordingUrl_('admin.8x8.com/{date}', row), '',
    'a scheme-less template is refused rather than rendered half-built');
});

test('review: the Label column constant actually points at the Label column', function () {
  // Not a tautology, unlike deriving a fixture from the same constant: this
  // pins the constant against the HEADER TEXT, so a wrong index bites even
  // though every fixture and the tally read it from the same place.
  assert.match(h.ctx.OB_REVIEW_WS_HEADER_[h.ctx.OB_REVIEW_LABEL_COL_ - 1], /^Label/,
    'OB_REVIEW_LABEL_COL_ must index the Label column, or the scorer tallies the wrong cell');
  // And the two columns the listener fills are the last two, so a new column
  // cannot be inserted between them and the label.
  assert.equal(h.ctx.OB_REVIEW_WS_HEADER_.length, h.ctx.OB_REVIEW_LABEL_COL_ + 1,
    'Notes is expected to follow Label as the final column');
});

test('review: {callid} is NOT a supported placeholder', function () {
  // Supporting it would mean selecting call_id, trading this tool's
  // no-call-id property for a link that cannot resolve anyway -- the CDR
  // Call ID is numeric, the recording id is a UUID.
  const row = { callDate: '2026-09-21', time: '16:55:00', agent: 'A', ext: '1' };
  const out = h.ctx.obReviewRecordingUrl_('https://x/{callid}', row);
  assert.equal(out, 'https://x/{callid}',
    'an unsupported placeholder is left literal, never silently filled');
  assert.ok(!/call_id/.test(String(h.ctx.obReviewRecordingUrl_)),
    'and the helper must not reach for a call id');
});

test('review: the link column does not break the blinding', function () {
  const rows = h.ctx.obReviewShuffleAndToken_(revRows_(), function () { return 0.5; });
  const ws = h.ctx.obReviewGridToTsv_(h.ctx.obReviewWorksheetGrid_(
    rows, 'https://admin.8x8.com/recordings?date={date}&ext={ext}'));
  assert.match(ws, /admin\.8x8\.com/, 'the link renders');
  ['A-instant', 'C-inband'].forEach(function (id) {
    assert.ok(ws.indexOf(id) === -1, 'still no stratum in the worksheet: ' + id);
  });
  ws.split('\n').slice(1).forEach(function (line) {
    const cells = line.split('\t');
    assert.ok(cells.indexOf('31') === -1 && cells.indexOf('44') === -1,
      'and still no ring value: ' + line);
  });
});

test('review: the key carries the stratum and joins back on Token', function () {
  const rows = h.ctx.obReviewShuffleAndToken_(revRows_(), function () { return 0.5; });
  const key = h.ctx.obReviewGridToTsv_(h.ctx.obReviewKeyGrid_(rows));
  assert.match(key, /C-inband/);
  assert.match(key, /\t31\t/, 'the key is where the ring belongs');
  const wsTokens = h.ctx.obReviewGridToTsv_(h.ctx.obReviewWorksheetGrid_(rows)).split('\n').slice(1)
    .map(function (l) { return l.split('\t')[0]; }).sort();
  const keyTokens = key.split('\n').slice(1)
    .map(function (l) { return l.split('\t')[0]; }).sort();
  assert.deepEqual(keyTokens, wsTokens, 'every worksheet row must be resolvable in the key');
  assert.equal(new Set(keyTokens).size, keyTokens.length, 'tokens must be unique');
});

test('review: tokens are assigned AFTER the shuffle, so their order leaks nothing', function () {
  // A reversing "shuffle" (always pick index 0) makes the property checkable:
  // if tokens were assigned before shuffling, R01 would still sit on the
  // A-instant row. Assigned after, it must land on whatever moved to front.
  const rows = h.ctx.obReviewShuffleAndToken_(revRows_(), function () { return 0; });
  const first = rows[0];
  assert.equal(first.token, 'R01');
  assert.notEqual(first.stratum, 'A-instant',
    'R01 must not be pinned to the first stratum — that is the leak this ordering prevents');
  // And every input row still has exactly one token.
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map(function (r) { return r.token; })).size, 5);
});

test('review: agent names from the CDR feed are neutralised for the paste target', function () {
  const rows = h.ctx.obReviewShuffleAndToken_([
    { stratum: 'C-inband', callDate: '2026-09-04', time: '11:22:00',
      agent: '=HYPERLINK("http://x","clickme")', ext: '@101', dept: '+CSR', ring: 31, talk: 35,
      attempts: 1, connected: true },
    { stratum: 'B-human', callDate: '2026-09-05', time: '09:00:00',
      agent: 'Tab\tInjected', ext: '5\t5', dept: 'Sales', ring: 5, talk: 60, attempts: 1, connected: true },
  ], function () { return 0.5; });
  const ws = h.ctx.obReviewGridToTsv_(h.ctx.obReviewWorksheetGrid_(rows));
  assert.match(ws, /'=HYPERLINK/, 'a formula-shaped agent name is prefixed (sheetSafeCell_)');
  assert.match(ws, /'\+CSR/, 'and so is a formula-shaped department');
  ws.split('\n').forEach(function (line) {
    assert.equal(line.split('\t').length, h.ctx.OB_REVIEW_WS_HEADER_.length,
      'an embedded tab must be flattened or it shifts every column after it: ' + line);
  });
});

test('review: the strata mirror Step 1b and never select on the thing being inferred', function () {
  const strata = h.ctx.OB_REVIEW_STRATA_;
  assert.equal(strata.length, 6);
  // Joined rather than deepEqual: the array crosses the vm realm boundary, so
  // a structural compare fails on reference identity (the harness trap).
  assert.equal(strata.map(function (s) { return s.id; }).join('|'),
    'A-instant|B-human|B2-shoulder|C-inband|D-above|E-unconnected');
  // The whole methodological point: a stratum may select on stored facts
  // (connected, ring, talk) and never on a voicemail judgement.
  strata.forEach(function (st) {
    assert.match(st.sql, /^(connected|NOT connected)/,
      st.id + ' must key off the stored connected flag');
    assert.ok(!/voicemail|vm|machine/i.test(st.sql),
      st.id + ' must not select on the label being tested: ' + st.sql);
  });
  // C is the measured band from the 09-18 histogram. Looked up by ID, not by
  // position -- inserting B2 moved C's index and broke the old assertion.
  const cBand = strata.filter(function (st) { return st.id === 'C-inband'; })[0];
  assert.ok(cBand, 'the in-band stratum must exist');
  assert.match(cBand.sql, /ring_seconds BETWEEN 20 AND 32/);
});

test('review: the sampler emits NO caller identity', function () {
  // The convention this tool was expected to break, and does not: a recording
  // is found by agent + time, so no number, hash or call id is needed. A pin,
  // because a later "add the call id, it is handy" would be invisible.
  const fn = OB_SRC.slice(OB_SRC.indexOf('function sampleOutboundCallsForReview'),
    OB_SRC.indexOf('// probeOutboundAnswerQuality --'));
  assert.ok(fn.length > 200, 'the function must be found for this pin to mean anything');
  [/callee_hash/, /\bcall_id\b/, /caller_hash/, /phone_hash/, /phone_number/].forEach(function (re) {
    assert.ok(!re.test(fn), 'the review sampler must not select ' + re);
  });
  // Identifiers, not the WORD: the operator instructions legitimately say to
  // find the recording in the phone system, and an earlier version of this
  // pin failed on that prose — a pin that fires on documentation teaches
  // people to weaken it.
  assert.match(fn, /phone system/, 'the locator instructions are expected prose here');
  // And the two TSV writers cannot leak one either.
  assert.ok(!/hash|call_id|phone/i.test(String(h.ctx.obReviewGridToTsv_(
    h.ctx.obReviewWorksheetGrid_(
      h.ctx.obReviewShuffleAndToken_(revRows_(), function () { return 0.5; }))))));
});

test('review: a start timestamp that will not parse still yields a locator', function () {
  assert.equal(h.ctx.obReviewStartParts_('2026-09-04 09:05:07').time, '09:05:07');
  assert.equal(h.ctx.obReviewStartParts_('9:05').time, '09:05:00', 'padded, seconds defaulted');
  assert.equal(h.ctx.obReviewStartParts_('garbage').time, 'garbage',
    'an unparseable start is passed through — a bad locator beats a blank one');
  assert.equal(h.ctx.obReviewStartParts_(null).time, '');
});

// ── The window anchor, the Wilson interval and the verdict rule ────────────

function propsOf_(map) {
  return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
}
// 2026-09-22T18:00Z — so "yesterday" in America/Chicago is 2026-09-21.
const NOW_ = Date.UTC(2026, 8, 22, 18, 0, 0);

test('window: an UNSET window ends at the latest date the data holds', function () {
  const w = h.ctx.obProbeWindow_(propsOf_({}), NOW_, '2026-09-18');
  assert.equal(w.to, '2026-09-18', 'the anchor pulls the window back off the empty tail');
  assert.equal(w.from, '2026-08-22', '28 days inclusive, counted back from the anchor');
  assert.equal(w.anchoredTo, true);
});

test('window: the anchor is CAPPED at yesterday — the P16 rule', function () {
  // A mid-day import lands a PARTIAL today. max(call_date) is then today, and
  // measuring it is exactly the bug P16 recorded, so the anchor must not
  // widen the window past yesterday.
  const w = h.ctx.obProbeWindow_(propsOf_({}), NOW_, '2026-09-22');
  assert.equal(w.to, '2026-09-21', 'today must never become the window end');
  assert.equal(w.anchoredTo, false, 'and the result is not reported as anchored');
  // A FUTURE anchor (a clock-skewed or bad row) is likewise capped.
  assert.equal(h.ctx.obProbeWindow_(propsOf_({}), NOW_, '2026-12-01').to, '2026-09-21');
});

test('window: an EXPLICIT window is never moved by the anchor', function () {
  const w = h.ctx.obProbeWindow_(
    propsOf_({ OUTBOUND_PROBE_FROM: '2026-07-01', OUTBOUND_PROBE_TO: '2026-07-31' }),
    NOW_, '2026-09-18');
  assert.equal(w.from, '2026-07-01');
  assert.equal(w.to, '2026-07-31', 'a date the operator typed is a decision, not a default');
});

test('window: a missing or malformed anchor falls back to the calendar default', function () {
  assert.equal(h.ctx.obProbeWindow_(propsOf_({}), NOW_, null).to, '2026-09-21');
  assert.equal(h.ctx.obProbeWindow_(propsOf_({}), NOW_, 'garbage').to, '2026-09-21');
  assert.equal(h.ctx.obProbeWindow_(propsOf_({}), NOW_).to, '2026-09-21');
});

test('window: an invalid explicit window still throws before any connection', function () {
  assert.throws(function () {
    h.ctx.obProbeWindow_(propsOf_({ OUTBOUND_PROBE_FROM: '2026-09-30', OUTBOUND_PROBE_TO: '2026-09-01' }),
      NOW_, '2026-09-18');
  }, /from <= to/);
});

test('wilson: the interval never leaves [0,1] and never collapses at the edges', function () {
  // The two cases a normal approximation gets wrong, which is why this is
  // Wilson: a unanimous small sample, and a zero-success one.
  const all = h.ctx.obWilsonInterval_(20, 20);
  assert.equal(all.share, 1);
  assert.ok(all.hi <= 1, 'cannot exceed 100%, got ' + all.hi);
  assert.ok(all.lo > 0.8 && all.lo < 1, 'a unanimous n=20 still has a lower bound, got ' + all.lo);
  const none = h.ctx.obWilsonInterval_(0, 20);
  assert.equal(none.share, 0);
  assert.ok(none.lo >= 0 && none.hi > 0,
    'zero successes must still carry width, got ' + none.lo + '..' + none.hi);
  // And it narrows with n, which is the whole argument for weighting stratum C.
  const at12 = h.ctx.obWilsonInterval_(9, 12), at20 = h.ctx.obWilsonInterval_(15, 20);
  assert.ok(at20.halfWidthPts < at12.halfWidthPts,
    'n=20 must be tighter than n=12 at the same share');
  assert.equal(h.ctx.obWilsonInterval_(1, 0), null, 'nonsense input returns null, never a number');
  assert.equal(h.ctx.obWilsonInterval_(5, 3), null);
});

test('tally: a BLANK label is never folded into "not voicemail"', function () {
  // Folding blanks in would bias the one share the audit measures, toward
  // refusing the band. They are counted separately instead.
  // Built through the real grid builder so the Label lands in the real Label
  // column -- a literal row would silently drift when a column is added.
  const ws = [h.ctx.OB_REVIEW_WS_HEADER_].concat([
    ['R01', 'voicemail'], ['R02', ''], ['R03', 'HUMAN'], ['R04', 'banana'],
  ].map(function (pair) {
    const row = h.ctx.OB_REVIEW_WS_HEADER_.map(function () { return ''; });
    row[0] = pair[0];
    row[h.ctx.OB_REVIEW_LABEL_COL_ - 1] = pair[1];
    return row;
  }));
  const key = [
    h.ctx.OB_REVIEW_KEY_HEADER_,
    ['R01', 'C-inband', 31, 35, 1, 'yes'],
    ['R02', 'C-inband', 26, 40, 1, 'yes'],
    ['R03', 'C-inband', 21, 50, 1, 'yes'],
    ['R04', 'C-inband', 30, 20, 1, 'yes'],
  ];
  const t = h.ctx.obReviewTally_(ws, key);
  const c = t.byStratum['C-inband'];
  assert.equal(c.n, 4);
  assert.equal(c.labels.voicemail, 1);
  assert.equal(c.labels.human, 1, 'case is normalised');
  assert.equal(c.unlabelled, 1);
  assert.equal(t.unlabelled, 1);
  assert.equal(t.unrecognised.join(','), 'R04=banana');
  assert.equal(c.labels.banana, undefined, 'an invented label joins no tally');
  assert.equal(t.labelled, 2, 'only recognised, non-blank labels count as labelled');
});

test('tally: a worksheet token with no key row is reported, not silently dropped', function () {
  const ws = [h.ctx.OB_REVIEW_WS_HEADER_].concat(['R01', 'R99'].map(function (tok) {
    const row = h.ctx.OB_REVIEW_WS_HEADER_.map(function () { return ''; });
    row[0] = tok;
    row[h.ctx.OB_REVIEW_LABEL_COL_ - 1] = 'voicemail';
    return row;
  }));
  const key = [h.ctx.OB_REVIEW_KEY_HEADER_, ['R01', 'C-inband', 31, 35, 1, 'yes']];
  const t = h.ctx.obReviewTally_(ws, key);
  assert.equal(t.tokensMissingKey.join(','), 'R99');
  assert.equal(t.byStratum['C-inband'].n, 1);
});

// Builds a tally literal for the verdict rule.
function cTally_(voicemail, human, controls) {
  const by = { 'C-inband': { n: voicemail + human, unlabelled: 0,
                             labels: { voicemail: voicemail, human: human } } };
  Object.keys(controls || {}).forEach(function (k) { by[k] = controls[k]; });
  return { byStratum: by, unlabelled: 0, unrecognised: [], tokensMissingKey: [],
           totalRows: voicemail + human, labelled: voicemail + human };
}

test('verdict: VALIDATED needs the lower bound clear, not just the point estimate', function () {
  // 14/20 = 70% — but the interval reaches down toward the coin flip, which
  // is precisely the call this audit exists to make, so it must NOT validate.
  const weak = h.ctx.obReviewVerdict_(cTally_(14, 6));
  assert.equal(weak.verdict, 'inconclusive', 'a 70% point estimate at n=20 is not a validation');
  assert.match(weak.reason, /interval spans|covers both/);
  // 19/20 clears it.
  const strong = h.ctx.obReviewVerdict_(cTally_(19, 1));
  assert.equal(strong.verdict, 'validated');
  assert.match(strong.reason, /EXCLUDE the instant population/,
    'a validation must carry the #65 obligation with it');
});

test('verdict: REFUTED when the upper bound is under the coin flip', function () {
  const v = h.ctx.obReviewVerdict_(cTally_(2, 18));
  assert.equal(v.verdict, 'refuted');
  assert.match(v.reason, /RELABEL/, 'and it names the alternative rather than just saying no');
  assert.match(v.reason, /do not set OUTBOUND_VM_RING_SEC/i);
});

test('verdict: too few labelled rows is INCONCLUSIVE, never a guess', function () {
  const v = h.ctx.obReviewVerdict_(cTally_(4, 1));
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reason, /only 5 stratum-C rows labelled/);
  const none = h.ctx.obReviewVerdict_({ byStratum: {} });
  assert.equal(none.verdict, 'inconclusive');
  assert.match(none.reason, /no stratum-C rows/);
});

test('verdict: a FAILED CONTROL downgrades a validation — the data is in question', function () {
  // E is the only real control left: a NOT-connected row carrying a real
  // conversation means the stored `connected` flag is wrong, which would
  // invalidate everything else.
  const v = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'E-unconnected': { n: 6, unlabelled: 0, labels: { human: 5, 'no-answer': 1 } },
  }));
  assert.equal(v.verdict, 'inconclusive',
    'a broken connected flag must not be outvoted by stratum C');
  assert.match(v.reason, /CONTROL/);
  assert.ok(v.notes.some(function (n) { return /connected. flag is wrong/.test(n); }));
  // A control that behaves leaves the validation standing.
  const ok = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'E-unconnected': { n: 6, unlabelled: 0, labels: { 'no-answer': 6 } },
  }));
  assert.equal(ok.verdict, 'validated');
  assert.equal(ok.notes.length, 0);
});

test('verdict: voicemail in the FAST bands is a RECALL finding, not a control failure', function () {
  // The call that forced this: 1783984138413 rang 8s and was voicemail (agent
  // left a message, then a silent line for ~2 min). A fast ring does not mean
  // a person answered, so a voicemail-heavy 0-11s band says the ring cannot
  // SEE that population -- it does not say stratum C is untrustworthy.
  const v = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'A-instant': { n: 8, unlabelled: 0, labels: { human: 5, voicemail: 3 } },
    'B-human': { n: 5, unlabelled: 0, labels: { human: 3, voicemail: 2 } },
  }));
  assert.equal(v.verdict, 'validated',
    'precision in C is unaffected by voicemail the threshold never claims');
  assert.ok(v.recallCeiling, 'the recall ceiling must be quantified');
  assert.equal(v.recallCeiling.n, 13);
  assert.equal(v.recallCeiling.voicemail, 5);
  assert.ok(v.notes.some(function (n) { return /THE RING CANNOT SEE IT/.test(n); }));
  assert.ok(v.notes.some(function (n) { return /reached. stays OVER-COUNTED/.test(n); }),
    'and it must name the consequence for the number managers act on');
  assert.ok(v.notes.some(function (n) { return /do not enable .strict./i.test(n); }));
  // Clean fast bands say nothing.
  const clean = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'A-instant': { n: 8, unlabelled: 0, labels: { human: 8 } },
    'B-human': { n: 5, unlabelled: 0, labels: { human: 5 } },
  }));
  assert.equal(clean.verdict, 'validated');
  assert.equal(clean.notes.length, 0);
  assert.equal(clean.recallCeiling.share, 0);
});

test('verdict: PARTIAL labelling still yields the findings it has earned', function () {
  // The defect this pin exists for: the findings used to sit AFTER the
  // stratum-C guards, so labelling the fast bands and not C returned an
  // empty result and the listening effort was wasted. Found on the owner's
  // first live run, where every row was still blank.
  const partial = {
    byStratum: {
      'C-inband': { n: 20, unlabelled: 20, labels: {} },          // none labelled yet
      'A-instant': { n: 8, unlabelled: 0, labels: { human: 5, voicemail: 3 } },
      'B-human': { n: 5, unlabelled: 0, labels: { human: 3, voicemail: 2 } },
      'B2-shoulder': { n: 12, unlabelled: 0, labels: { voicemail: 7, human: 5 } },
      'E-unconnected': { n: 4, unlabelled: 0, labels: { 'no-answer': 4 } },
    },
    unlabelled: 20, unrecognised: [], tokensMissingKey: [], totalRows: 49, labelled: 29,
  };
  const v = h.ctx.obReviewVerdict_(partial);
  assert.equal(v.verdict, 'inconclusive', 'no C rows means no verdict, which is correct');
  assert.match(v.reason, /only 0 stratum-C rows labelled/);
  assert.match(v.reason, /stand on their own strata/,
    'and the reason must point at the findings rather than reading as "nothing to report"');
  // ...but every finding that does not depend on C must be present.
  assert.ok(v.recallCeiling, 'the recall ceiling stands on A+B alone');
  assert.equal(v.recallCeiling.n, 13);
  assert.equal(v.recallCeiling.voicemail, 5);
  assert.ok(v.shoulder, 'the shoulder stands on B2 alone');
  assert.equal(v.shoulder.n, 12);
  assert.ok(v.controls['E-unconnected'], 'and the control was still checked');
  assert.ok(v.notes.some(function (n) { return /THE RING CANNOT SEE IT/.test(n); }));
  assert.ok(v.notes.some(function (n) { return /BAND STARTS TOO HIGH/.test(n); }));
});

test('verdict: an ENTIRELY blank sheet reports nothing, and says so plainly', function () {
  // The owner's first run: 54 rows, 0 labelled. Must not invent findings.
  const blank = {
    byStratum: {
      'C-inband': { n: 20, unlabelled: 20, labels: {} },
      'A-instant': { n: 8, unlabelled: 8, labels: {} },
      'B2-shoulder': { n: 12, unlabelled: 12, labels: {} },
    },
    unlabelled: 40, unrecognised: [], tokensMissingKey: [], totalRows: 40, labelled: 0,
  };
  const v = h.ctx.obReviewVerdict_(blank);
  assert.equal(v.verdict, 'inconclusive');
  assert.equal(v.recallCeiling, null, 'no labels, no recall claim');
  assert.equal(v.shoulder, null, 'no labels, no shoulder claim');
  assert.equal(v.notes.length, 0, 'and no notes invented from nothing');
  assert.ok(!/stand on their own strata/.test(v.reason),
    'nor a pointer to findings that do not exist');
});

test('verdict: an IVR in a fast band counts toward the RECALL ceiling', function () {
  // From the first live labelling round: 2 of 12 rows came back `ivr`, which
  // a voicemail-only measure treats as neither hit nor miss. An auto-attendant
  // is just as invisible to a ring threshold and just as much a non-reach, so
  // the ceiling is measured on NOT-REACHED (voicemail + ivr).
  const v = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'A-instant': { n: 8, unlabelled: 0, labels: { human: 5, ivr: 3 } },
    'B-human': { n: 5, unlabelled: 0, labels: { human: 4, voicemail: 1 } },
  }));
  assert.ok(v.recallCeiling);
  assert.equal(v.recallCeiling.n, 13);
  assert.equal(v.recallCeiling.notReached, 4, '3 ivr + 1 voicemail');
  assert.equal(v.recallCeiling.voicemail, 1, 'and voicemail is still broken out');
  assert.ok(v.notes.some(function (n) { return /1 voicemail, 3 IVR/.test(n); }),
    'the note must show the split, or an IVR-heavy result reads as voicemail');
  // Both measures appear per band.
  assert.equal(v.byBand['A-instant'].notReachedShare, 0.375);
  assert.equal(v.byBand['A-instant'].voicemailShare, 0);
});

test('verdict: no-answer and unclear are NOT folded into not-reached', function () {
  // Folding them in would bias the measure: on a connected row `no-answer`
  // means the listener heard no answer at all (a labelling problem), and
  // `unclear` is an honest abstention.
  const v = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'A-instant': { n: 8, unlabelled: 0, labels: { human: 4, 'no-answer': 2, unclear: 2 } },
  }));
  assert.equal(v.byBand['A-instant'].notReachedShare, 0,
    'neither label may count as a miss');
  assert.equal(v.recallCeiling.notReached, 0);
  assert.equal(v.notes.length, 0, 'and nothing is flagged from abstentions');
});

test('verdict: too few fast-band rows says nothing about recall', function () {
  const v = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'A-instant': { n: 2, unlabelled: 0, labels: { voicemail: 2 } },
  }));
  assert.equal(v.recallCeiling, null,
    '2 rows cannot carry a claim about a population');
  assert.equal(v.notes.length, 0);
});

test('review: the connected ring bands TILE 0..inf with no gap', function () {
  // The defect this pin exists for: B was 2-11 and C was 20-32, so ring 12-19
  // belonged to NO stratum -- and the first two labelled voicemails the owner
  // produced rang at 18 s and 22 s. One of them could never have been drawn,
  // in exactly the region where the band's left edge is in question.
  const bands = h.ctx.OB_REVIEW_STRATA_
    .filter(function (st) { return st.ring; })
    .map(function (st) { return { id: st.id, lo: st.ring[0], hi: st.ring[1] }; })
    .sort(function (a, b) { return a.lo - b.lo; });
  assert.ok(bands.length >= 4, 'the connected strata must declare ring ranges');
  assert.equal(bands[0].lo, 0, 'the first band must start at 0');
  assert.equal(bands[bands.length - 1].hi, null, 'the last band must be open-ended');
  for (let i = 1; i < bands.length; i++) {
    assert.equal(bands[i].lo, bands[i - 1].hi + 1,
      'gap or overlap between ' + bands[i - 1].id + ' (..' + bands[i - 1].hi + ') and '
      + bands[i].id + ' (' + bands[i].lo + '..)');
  }
  // Every second 0..60 is claimed exactly once.
  for (let sec = 0; sec <= 60; sec++) {
    const hits = bands.filter(function (b) {
      return sec >= b.lo && (b.hi === null || sec <= b.hi);
    });
    assert.equal(hits.length, 1, 'ring ' + sec + 's is claimed by ' + hits.length + ' strata');
  }
});

test('review: each stratum SQL matches its declared ring range', function () {
  // The range is what the gap test reasons about; the SQL is what actually
  // runs. A drift between them would make the partition pin vacuous.
  h.ctx.OB_REVIEW_STRATA_.forEach(function (st) {
    if (!st.ring) { assert.match(st.sql, /^NOT connected$/); return; }
    const lo = st.ring[0], hi = st.ring[1];
    if (hi === null) {
      assert.ok(st.sql.indexOf('ring_seconds >= ' + lo) >= 0,
        st.id + ' sql must say >= ' + lo + ', got: ' + st.sql);
    } else if (lo === 0) {
      assert.ok(st.sql.indexOf('ring_seconds <= ' + hi) >= 0,
        st.id + ' sql must say <= ' + hi + ', got: ' + st.sql);
    } else {
      assert.ok(st.sql.indexOf('BETWEEN ' + lo + ' AND ' + hi) >= 0,
        st.id + ' sql must say BETWEEN ' + lo + ' AND ' + hi + ', got: ' + st.sql);
    }
  });
});

test('review: the worksheet states the TERMINAL-OUTCOME convention', function () {
  // Data-quality rule, not decoration: one live row hit a screening prompt,
  // went unanswered, then took a voicemail -- all on one leg. Without the
  // convention two listeners label that differently and the tally moves. It
  // lives on the sheet because that is where someone labelling row 34 looks.
  assert.match(OB_SRC, /LABEL THE TERMINAL OUTCOME/,
    'the instruction must reach the worksheet');
  assert.match(OB_SRC, /Reaching voicemail and NOT leaving a message is still/,
    'and resolve the no-message case, which a listener will hit');
  assert.match(OB_SRC, /Use "ivr" only when the call ENDED at a menu/,
    'and bound `ivr` to a terminal outcome');
});

test('review: the two REAL labelled voicemails each land in a stratum', function () {
  // Ground truth, 2026-09-21, same agent two minutes apart, both confirmed
  // voicemail-with-message from the recordings. Derived from the raw CDR:
  // ring = CONNECTED - START on the external Outgoing leg.
  const real = [
    { call: '1783984138942', ring: 22, talk: 73, expect: 'C-inband' },
    { call: '1783984138898', ring: 18, talk: 30, expect: 'B2-shoulder' },
  ];
  real.forEach(function (r) {
    const owners = h.ctx.OB_REVIEW_STRATA_.filter(function (st) {
      return st.ring && r.ring >= st.ring[0] && (st.ring[1] === null || r.ring <= st.ring[1]);
    });
    assert.equal(owners.length, 1,
      'call ' + r.call + ' (ring ' + r.ring + 's) must be sampleable, got ' + owners.length);
    assert.equal(owners[0].id, r.expect,
      'call ' + r.call + ' belongs in ' + r.expect + ', got ' + owners[0].id);
  });
});

test('review: a voicemail-heavy shoulder is REPORTED, and does not downgrade C', function () {
  // The shoulder answers a different question from the controls -- where the
  // band's edge belongs, not whether the strata are trustworthy -- so it must
  // not turn a validated C into inconclusive.
  const v = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'B2-shoulder': { n: 12, unlabelled: 0, labels: { voicemail: 7, human: 5 } },
  }));
  assert.equal(v.verdict, 'validated', 'the shoulder is a finding, not a control failure');
  assert.ok(v.shoulder && v.shoulder.n === 12);
  assert.ok(v.notes.some(function (n) { return /BAND STARTS TOO HIGH/.test(n); }),
    'and it must say the left edge is missing calls');
  // A quiet shoulder says nothing.
  const quiet = h.ctx.obReviewVerdict_(cTally_(19, 1, {
    'B2-shoulder': { n: 12, unlabelled: 0, labels: { human: 11, voicemail: 1 } },
  }));
  assert.equal(quiet.verdict, 'validated');
  assert.equal(quiet.notes.length, 0);
});

test('review: stratum C carries the listening budget', function () {
  const strata = h.ctx.OB_REVIEW_STRATA_;
  const byId = {};
  strata.forEach(function (st) { byId[st.id] = st.want; });
  assert.ok(byId['C-inband'] >= 20, 'C decides, so it gets the most, got ' + byId['C-inband']);
  strata.forEach(function (st) {
    if (st.id === 'C-inband') return;
    assert.ok(st.want < byId['C-inband'],
      st.id + ' must not be sampled as heavily as C, which carries the main decision');
    assert.ok(st.want >= 3, st.id + ' still needs enough rows to sanity-check');
  });
  // B2 decides the band's LEFT EDGE, so it outranks the pure controls.
  ['A-instant', 'B-human', 'D-above', 'E-unconnected'].forEach(function (id) {
    assert.ok(byId['B2-shoulder'] > byId[id],
      'B2 answers a question and must be sampled above the ' + id + ' control');
  });
});

// ── The multi-modal band detector ──────────────────────────────────────────

// The LIVE 2026-09-18 shape, from the numbers the run recorded (Step 1
// RESULTS in docs/outbound-callback-dept-plan.md): bumps at 21s (2,077),
// 26-27s (927 / 1,010) and 30-31s (1,784 / 3,022) over a ~330 baseline, with
// 40.6% of connects at a 0s ring. This is the distribution the single-peak
// detector refused at 7.7% against the 8% floor, so it is the fixture that
// decides whether the band fallback was worth building.
function liveMultiModal_() {
  const m = {};
  m[0] = 25000;                                   // the #65 instant population
  [3000, 2400, 1900, 1500, 1200, 1000, 850, 700, 600, 520, 460].forEach(function (n, i) {
    m[i + 1] = n;                                 // the human cluster, decaying
  });
  for (let i = 12; i <= 19; i++) m[i] = 350;       // the trough between the two populations
  const band = { 20: 400, 21: 2077, 22: 500, 23: 400, 24: 380, 25: 600, 26: 927,
                 27: 1010, 28: 700, 29: 800, 30: 1784, 31: 3022, 32: 900 };
  Object.keys(band).forEach(function (k) { m[k] = band[k]; });
  for (let i = 33; i <= 60; i++) m[i] = 300;       // the long tail
  return m;
}

test('probe/band: the LIVE multi-modal shape is refused by the peak test and found by the band', function () {
  const m = liveMultiModal_();
  const rows = hist_(m), tot = total_(m);

  // First, the premise: the single-peak detector still refuses it, for one of
  // the two reasons the band fallback is gated on. If this ever stops being
  // true the fallback is dead code and this test says so.
  const sp = h.ctx.obProbeRingSpike_(rows, tot);
  assert.equal(sp.spike, false, 'the live shape must still defeat the one-peak test');
  assert.ok(sp.reason === 'spike-too-small' || sp.reason === 'too-wide',
    'and it must fail for a reason a band can legitimately explain, got ' + sp.reason);

  const b = JSON.parse(JSON.stringify(h.ctx.obProbeRingBand_(rows, tot)));
  assert.equal(b.band, true, 'the band detector must find what the peak test could not');
  assert.equal(b.reason, 'ok');
  // The band must span the bumps, not sit on one of them.
  assert.ok(b.leftSec <= 21 && b.rightSec >= 31,
    'the band must cover the 21s and 31s bumps, got ' + b.leftSec + '-' + b.rightSec);
  assert.ok(b.peaks.length >= 3, 'the multi-modal structure is reported, got ' + b.peaks.length);
  // The parameters follow the same contract as the spike path.
  assert.equal(b.suggestedVmRingSec, b.leftSec, 'the threshold is the LEFT edge');
  assert.equal(b.suggestedToleranceSec, Math.ceil((b.rightSec - b.leftSec) / 2));
  // And the number the whole fallback exists to surface.
  assert.ok(b.purity > 0.55 && b.purity < 0.95,
    'the live band is impure but usable; a purity of 1 would mean the baseline vanished, got ' + b.purity);
  assert.equal(b.bandCount, b.baselineCount + b.excessCount,
    'the mass decomposition must add up, or the disclosed ceiling is wrong');
});

test('probe/band: REFUSES a band that is mostly baseline (band-impure)', function () {
  // A broad gentle bulge: elevated enough to be found (1.8x baseline, so the
  // edges survive the trim) and wide enough to clear the share gates, but its
  // mass is mostly the baseline traffic running underneath it. A threshold
  // here would flag ~56% humans. This is the gate no earlier test looked at.
  const m = { 0: 8000 };
  for (let i = 1; i <= 11; i++) m[i] = 1200;
  for (let i = 12; i <= 19; i++) m[i] = 1000;
  for (let i = 20; i <= 35; i++) m[i] = 1800;      // 1.8x baseline -> purity 0.44
  for (let i = 36; i <= 60; i++) m[i] = 1000;
  const b = h.ctx.obProbeRingBand_(hist_(m), total_(m));
  assert.equal(b.baseline, 1000, 'fixture must pin the baseline the purity is measured against');
  assert.ok(b.bandShare >= 0.12 && b.excessShare >= 0.06,
    'the fixture must REACH the purity gate rather than trip an earlier one');
  assert.equal(b.band, false);
  assert.equal(b.reason, 'band-impure');
  assert.equal(b.suggestedVmRingSec, null, 'no number is offered on a refusal');
  assert.match(h.ctx.obProbeBandHint_(b), /precision ceiling|took a while/i);
});

test('probe/band: REFUSES the upper tail of the human cluster (no-trough)', function () {
  // Elevated AND pure enough to pass every mass gate, but the three seconds
  // immediately below it are nearly as busy -- the signature of people
  // answering slowly, not of a distinct voicemail population. This is the
  // gate that carries the weight now that the scan objective is known not to
  // steer away from the human cluster on its own.
  const m = { 0: 3000 };
  for (let i = 1; i <= 11; i++) m[i] = 1500;       // the human cluster
  for (let i = 12; i <= 17; i++) m[i] = 200;
  for (let i = 18; i <= 19; i++) m[i] = 900;       // the shoulder, nearly as busy as the band
  for (let i = 20; i <= 35; i++) m[i] = 1000;
  for (let i = 36; i <= 60; i++) m[i] = 200;
  const b = h.ctx.obProbeRingBand_(hist_(m), total_(m));
  assert.equal(b.leftSec, 20, 'the scan must find the bulge before the gate can refuse it');
  assert.ok(b.purity >= 0.55, 'the fixture must PASS purity so the shoulder gate is what fires');
  assert.equal(b.band, false);
  assert.equal(b.reason, 'no-trough');
  assert.ok(b.shoulderRatio > 0.6, 'and it must be refused on the measured shoulder');
  assert.equal(b.suggestedVmRingSec, null);
  assert.match(h.ctx.obProbeBandHint_(b), /upper tail of people/i);
});

test('probe/band: REFUSES a sample too small, before looking at shape', function () {
  const m = { 1: 20, 2: 15, 21: 10, 26: 12, 31: 14 };
  assert.ok(total_(m) < 200);
  const b = h.ctx.obProbeRingBand_(hist_(m), total_(m));
  assert.equal(b.band, false);
  assert.equal(b.reason, 'too-few-rows');
  assert.match(h.ctx.obProbeBandHint_(b), /widen OUTBOUND_PROBE_FROM/);
});

test('probe/band: the FLOOR is what keeps the scan off the human cluster', function () {
  // At fixed window width, maximising mass-above-baseline and maximising mass
  // pick the same window -- the subtracted term is constant -- so the scan
  // objective cannot be what avoids the human cluster. The floor is. Here the
  // busiest 16s window by far starts at 1s; the band must not be reported
  // there however much mass sits in it.
  const m = { 0: 4000 };
  for (let i = 1; i <= 16; i++) m[i] = 5000;        // the heaviest window in the histogram
  for (let i = 17; i <= 60; i++) m[i] = 150;
  const b = h.ctx.obProbeRingBand_(hist_(m), total_(m));
  assert.ok(b.leftSec === null || b.leftSec >= 12,
    'no band may be reported below OB_PROBE_VM_FLOOR_SEC_, got ' + b.leftSec);
  assert.equal(b.band, false, 'and a histogram with nothing above the floor yields no band');
});

test('probe/band: a band is never offered where the peak test already passed', function () {
  // Behaviour preservation. The probe consults the band ONLY for the two
  // multi-modal refusals; a clean bimodal shape must keep taking the peak
  // path, whose narrower band implies the better precision.
  const src = OB_SRC;
  const m = src.match(/var BAND_ELIGIBLE_ = \{([^}]*)\}/);
  assert.ok(m, 'the eligibility map must exist -- it is what keeps the peak path unchanged');
  const keys = m[1].match(/'[a-z-]+'/g) || [];
  assert.deepEqual(keys.sort(), ["'spike-too-small'", "'too-wide'"],
    'only the two multi-modal refusals may fall through to the band');
  assert.match(src, /var band = \(!spike\.spike && BAND_ELIGIBLE_\[spike\.reason\]\)/,
    'and the fallback must be gated on a REFUSED spike, never run alongside a passing one');
});

// ── The pure talk-trough detector ──────────────────────────────────────────

test('probe/trough: a real dip between hangups and conversations is measured', function () {
  // 5s buckets, DENSE: a hangup cluster at 0-5s, a dip at 15s, conversations
  // peaking at 60s.
  const m = { 0: 300, 5: 200, 10: 80, 15: 20, 20: 90, 25: 140, 30: 200, 35: 240,
              40: 270, 45: 300, 50: 380, 55: 440, 60: 500, 65: 380, 70: 300 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, true);
  assert.equal(t.troughSec, 15);
  assert.equal(t.suggestedMinTalkSec, 15);
  assert.equal(t.suggestedIsMeasured, true);
});

test('probe/trough: NO dip falls back to the candidate and says it is unmeasured', function () {
  // Monotonically decreasing, DENSE: nothing separates short from long. (The
  // fixture was sparse when the mode gate caught this case first; with the
  // two-hump search it has to be dense, or the empty-bucket guard would be
  // what refuses and this would stop testing monotonicity.)
  const m = { 0: 500, 5: 400, 10: 300, 15: 200, 20: 150, 25: 120, 30: 100,
              35: 80, 40: 60, 45: 50, 50: 40, 55: 30, 60: 20 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, false);
  assert.equal(t.reason, 'unimodal');
  assert.equal(t.suggestedMinTalkSec, 10, 'the plan\'s candidate');
  assert.equal(t.suggestedIsMeasured, false,
    'the caption must be able to say this number was NOT measured');
});

test('probe/trough: a SINGLE hump has no boundary to name', function () {
  // Rise then fall. Every bucket has a taller neighbour on ONE side only, so
  // there is no split with hump on both — the case a below-the-mode search
  // could not distinguish from a real two-hump distribution.
  const m = { 0: 100, 5: 300, 10: 700, 15: 900, 20: 700, 25: 300, 30: 100 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, false);
  assert.equal(t.reason, 'unimodal');
  assert.equal(t.suggestedIsMeasured, false);
});

test('probe/trough: the LIVE 2026-09-15 histogram — the trough ABOVE the mode', function () {
  // The regression that motivated the two-hump search. The real distribution
  // peaks at the 5s bucket and dips at 20s, with a SECOND hump at 35-40s
  // (where a voicemail greeting + message lands). Searching only below the
  // mode returned 'mode-at-floor' — a wrong answer dressed as a refusal.
  const m = { 0: 2014, 5: 4985, 10: 2713, 15: 2195, 20: 1659, 25: 2418, 30: 3332,
              35: 3847, 40: 3485, 45: 2840, 50: 2451, 55: 2035, 60: 1735, 65: 1552,
              70: 1377, 75: 1083, 80: 923, 85: 849, 90: 745, 95: 700, 100: 624 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, true);
  assert.equal(t.modeSec, 5, 'the mode is the LOW cluster here');
  assert.equal(t.troughSec, 20, 'the boundary sits ABOVE the mode');
  assert.equal(t.leftPeakSec, 5);
  assert.equal(t.rightPeakSec, 35, 'the second hump the trough separates');
  assert.equal(t.suggestedMinTalkSec, 20);
  assert.equal(t.suggestedIsMeasured, true);
});

test('probe/trough: a SHALLOW dip is not a boundary', function () {
  const m = { 0: 300, 5: 260, 10: 240, 15: 250, 20: 280, 25: 320, 30: 400,
              35: 430, 40: 460, 45: 480, 50: 490, 55: 495, 60: 500 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, false);
  assert.equal(t.reason, 'shallow');
  assert.equal(t.suggestedIsMeasured, false);
});

test('probe/trough: an EMPTY bucket is absence of data, not the perfect trough', function () {
  // Sparse data dips to zero between samples. A zero is arithmetically the
  // deepest trough there can be, so without this guard the detector is most
  // confident exactly where the histogram is least trustworthy.
  const m = { 0: 400, 5: 300, 10: 0, 15: 0, 20: 120, 25: 200, 30: 300, 35: 400, 40: 500 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, false);
  assert.equal(t.reason, 'sparse');
  assert.equal(t.suggestedIsMeasured, false);
});

test('probe/trough: too few rows refuses like the spike gate', function () {
  const m = { 0: 30, 15: 5, 60: 40 };
  const t = h.ctx.obProbeTalkTrough_(hist_(m), total_(m));
  assert.equal(t.trough, false);
  assert.equal(t.reason, 'too-few-rows');
});

// ── The probe end to end ───────────────────────────────────────────────────

function probeConn_(json1, json2) {
  const conn = {
    prepared: [], closed: false,
    prepareStatement: function (s) {
      const ps = { _p: {}, sql: s,
        setString: function (i, v) { ps._p[i] = v; },
        setInt: function (i, v) { ps._p[i] = v; } };
      ps.executeQuery = function () {
        conn.prepared.push({ sql: s, p: ps._p });
        const j = /'quadrants'/.test(s) ? json2 : json1;
        let n = 0;
        return { next: function () { return n++ === 0; },
                 getString: function () { return j; }, close: function () {} };
      };
      ps.close = function () {};
      return ps;
    },
    close: function () { conn.closed = true; },
  };
  return conn;
}

const PROBE_BIMODAL_ = bimodal_(3);
function probeJson1_(over) {
  const m = PROBE_BIMODAL_;
  return JSON.stringify(Object.assign({
    connTotal: 900, conn1: total_(m), conn1RingNull: 12, conn1RingOver: 4,
    ringHist: hist_(m), ringHistAll: hist_(m),
    talkTotal: 700, talkOver: 30,
    talkHist: hist_({ 0: 300, 5: 200, 10: 80, 15: 20, 20: 90, 25: 140, 30: 200,
                      35: 240, 40: 270, 45: 300, 50: 380, 55: 440, 60: 500 }),
    repeatGroups: 88, repeatRingHist: hist_({ 24: 3, 25: 60, 26: 5, 31: 2 }),
    repeatRingHistNoInstant: hist_({ 24: 3, 25: 60, 26: 5, 31: 2 }),
  }, over || {}));
}
const PROBE_JSON2_ = JSON.stringify({
  quadrants: { total: 800, bandLongTalk: 40, bandShortTalk: 260,
               outLongTalk: 420, outShortTalk: 80, atOrAboveThreshold: 330 },
  attempts: [{ attempts: 1, n: 600, inBand: 180 }, { attempts: 2, n: 150, inBand: 70 },
             { attempts: 3, n: 90, inBand: 60 }],
});

function installProbe_(conn) {
  h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
  h.state.props = { OUTBOUND_PROBE_FROM: '2026-08-01', OUTBOUND_PROBE_TO: '2026-08-28' };
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
}

test('probe: a clean bimodal run reports MEASURED parameters and sets nothing', function () {
  const conn = probeConn_(probeJson1_(), PROBE_JSON2_);
  installProbe_(conn);
  const out = JSON.parse(JSON.stringify(h.call('probeOutboundAnswerQuality')));
  assert.match(out.result, /^ok bimodal: ring spike at 25s \(band 24-26s/);
  assert.match(out.result, /nothing was set/);
  assert.match(out.result, /OUTBOUND_ANSWER_QUALITY stays off/);
  assert.deepEqual(out.suggested, {
    OUTBOUND_VM_RING_SEC: 24,
    OUTBOUND_VM_RING_TOLERANCE_SEC: 1,
    OUTBOUND_MIN_TALK_SEC: 15,
    OUTBOUND_ANSWER_QUALITY: 'off',
  });
  assert.equal(out.quadrants.bandShortTalk, 260);
  assert.equal(out.byAttempts.length, 3);
  assert.equal(conn.closed, true);
  // The probe NEVER writes a Script Property other than self-clearing its
  // own window. If it ever set the values it suggests, the "measure, then
  // decide" separation the plan rests on would be gone.
  assert.equal(h.state.props.OUTBOUND_VM_RING_SEC, undefined);
  assert.equal(h.state.props.OUTBOUND_ANSWER_QUALITY, undefined);
});

test('probe: the repeat check is an INDEPENDENT estimate, reported as agreement', function () {
  installProbe_(probeConn_(probeJson1_(), PROBE_JSON2_));
  const ok = h.call('probeOutboundAnswerQuality');
  assert.equal(ok.repeat.modalRingSec, 25);
  assert.equal(ok.repeat.agreesWithSpike, true);
  assert.equal(ok.repeat.modalRingSecNoInstant, 25);
  assert.equal(ok.repeat.agreesWithSpikeNoInstant, true);
  assert.match(ok.result, /repeat-callee modal ring \(instant excluded\) 25s AGREES/);
  assert.match(ok.result, /unfiltered 25s AGREES/);

  // Same spike, but repeat callees answer at 40s — two methods disagreeing
  // is exactly what the operator must see before trusting the band.
  installProbe_(probeConn_(probeJson1_({
    repeatRingHist: hist_({ 40: 70, 25: 3 }),
    repeatRingHistNoInstant: hist_({ 40: 70, 25: 3 }),
  }), PROBE_JSON2_));
  const dis = h.call('probeOutboundAnswerQuality');
  assert.equal(dis.repeat.agreesWithSpike, false);
  assert.equal(dis.repeat.agreesWithSpikeNoInstant, false);
  assert.match(dis.result, /\(instant excluded\) 40s DISAGREES/);
  assert.match(dis.result, /^ok bimodal/, 'a disagreement is disclosed, not a verdict downgrade');
});

test('probe: the window reports whether it was ANCHORED to the data', function () {
  // Why this is not cosmetic: a fallback to the calendar produces the SAME
  // dates as an anchor that happens to land on yesterday, so a silent anchor
  // failure is invisible without this -- and the anchor exists precisely to
  // stop the window covering days with no data. Pinned in source across all
  // four tools, since the probe suite mocks the connection and never runs
  // the anchor query.
  const sites = OB_SRC.match(/anchoredToData: !!win\.anchoredTo/g) || [];
  assert.equal(sites.length, 4,
    'all four outbound tools must disclose it, got ' + sites.length);
  const anchors = OB_SRC.match(/anchor = obProbeAnchorDate_\(conn\)/g) || [];
  assert.equal(anchors.length, 4, 'and each must capture the anchor it resolved');
  assert.match(OB_SRC, /anchored to the latest data/,
    'the human-readable label must say so too');
});

test('probe: the instant-excluded repeat SQL is actually built (source pin)', function () {
  // Why a SOURCE pin and not a behavioural one: the probe suite drives a
  // MOCKED connection that returns fixture JSON keyed by field name, so the
  // query text is never executed and a typo in it would leave every test
  // green. Found by a bite-check that refused to bite.
  assert.match(OB_SRC, /'repeatRingHistNoInstant',\s*\(SELECT/,
    'the instant-excluded histogram must be selected under the key the reader expects');
  // And the exclusion must reuse #65's definition of instant rather than a
  // local copy, or the two tools disagree about which rows they mean.
  const frag = OB_SRC.slice(OB_SRC.indexOf("'repeatRingHistNoInstant'"));
  const stmt = frag.slice(0, frag.indexOf('rr2)'));
  assert.match(stmt, /ring_seconds > '\s*\+\s*OB_INSTANT_RING_SEC_/,
    'the instant floor must come from OB_INSTANT_RING_SEC_, got: ' + stmt.slice(0, 400));
  assert.match(stmt, /HAVING count\(\*\) >= 2/,
    'it must still be a REPEAT-callee check, not a plain histogram');
  assert.match(stmt, /GROUP BY 1,2/, 'grouped by (callee, ring) like its unfiltered twin');
});

test('probe: the instant-excluded repeat check rescues a SWAMPED signal', function () {
  // The 09-18 live shape: the unfiltered check peaks at 0s because 40.6% of
  // connects ring <= 1s and sit in that one bucket regardless of destination,
  // so it DISAGREED with a perfectly good spike. Excluding the instant rows
  // must recover the real per-destination timeout — which is the whole point
  // of the second histogram.
  installProbe_(probeConn_(probeJson1_({
    repeatRingHist: hist_({ 0: 900, 25: 60 }),          // swamped by instant
    repeatRingHistNoInstant: hist_({ 25: 60, 31: 4 }),  // the signal underneath
  }), PROBE_JSON2_));
  const out = h.call('probeOutboundAnswerQuality');
  assert.equal(out.repeat.modalRingSec, 0, 'the unfiltered reading is kept, not replaced');
  assert.equal(out.repeat.agreesWithSpike, false, 'and it still reads as a disagreement');
  assert.equal(out.repeat.modalRingSecNoInstant, 25);
  assert.equal(out.repeat.agreesWithSpikeNoInstant, true,
    'while the instant-excluded reading AGREES — the disagreement was an artifact');
  assert.match(out.result, /\(instant excluded\) 25s AGREES/);
  assert.match(out.result, /unfiltered 0s DISAGREES/,
    'both must appear, so the 0s peak stays visible as the thing explained');
});

test('probe: no spike → INCONCLUSIVE, EXPLORATORY cut only, no suggestion, params KEPT', function () {
  const flat = {};
  for (let i = 1; i <= 60; i++) flat[i] = 20;
  const conn = probeConn_(probeJson1_({ conn1: total_(flat), ringHist: hist_(flat) }), PROBE_JSON2_);
  installProbe_(conn);
  const out = JSON.parse(JSON.stringify(h.call('probeOutboundAnswerQuality')));
  assert.match(out.result, /^INCONCLUSIVE /);
  assert.match(out.result, /do NOT set OUTBOUND_VM_RING_SEC or enable OUTBOUND_ANSWER_QUALITY/);
  // The line that must never blur: a refusal carries the cross-tab for
  // DIAGNOSIS, and carries no parameter anyone could set.
  assert.equal(out.suggested, undefined, 'a refusal must not smuggle a number out');
  assert.equal(out.band, undefined, 'and no measured band either');
  assert.equal(out.quadrants, undefined, 'the MEASURED slot stays empty on a refusal');
  assert.ok(out.exploratory, 'but the cross-tab is still produced — the gap the live run exposed');
  assert.match(out.exploratory.note, /^EXPLORATORY/);
  assert.match(out.exploratory.note, /not measured parameters and must not be set as any/);
  assert.equal(out.exploratory.refusedBecause, 'flat', 'says WHICH gate refused');
  assert.ok(out.exploratory.quadrants, 'the cut itself');
  assert.match(out.result, /EXPLORATORY ring×talk cut/,
    'the verdict line says so too — the payload alone is not where a reader looks first');
  assert.equal(conn.prepared.length, 2, 'the exploratory cut is a real second query');
  // A refused run still carries the FWHM edges it walked before failing a
  // gate, and they span most of a flat histogram — so an agreement check
  // that forgets to require a spike reports the repeat-callee evidence as
  // CONFIRMING a band that was just rejected.
  assert.equal(out.repeat.modalRingSec, 25, 'the independent estimate is still reported');
  assert.equal(out.repeat.agreesWithSpike, false,
    'there is no spike to agree with — agreement is never claimed on a refusal');
  // The self-cleaning rule: only a clean verdict clears the window, so the
  // widen-and-re-run loop re-measures the same range.
  assert.equal(h.state.props.OUTBOUND_PROBE_FROM, '2026-08-01');
});

test('probe: a refusal with NO usable peak gets NO exploratory cut either', function () {
  // A too-few-rows refusal returns before the FWHM edges are computed, so
  // there is no observed band to cut at. Cutting at nothing would be worse
  // than not cutting — the block must be ABSENT, not empty-but-present.
  const tiny = { 1: 20, 2: 30, 25: 25, 26: 10 };
  const conn = probeConn_(probeJson1_({ conn1: total_(tiny), ringHist: hist_(tiny) }), PROBE_JSON2_);
  installProbe_(conn);
  const out = JSON.parse(JSON.stringify(h.call('probeOutboundAnswerQuality')));
  assert.match(out.result, /^INCONCLUSIVE /);
  assert.equal(out.spike.reason, 'too-few-rows');
  assert.equal(out.exploratory, undefined);
  assert.equal(out.suggested, undefined);
  assert.equal(conn.prepared.length, 1, 'no band, no second query — the original rule still holds');
  assert.doesNotMatch(out.result, /EXPLORATORY/);
});

test('probe: the clean run self-clears its window params (and only then)', function () {
  installProbe_(probeConn_(probeJson1_(), PROBE_JSON2_));
  h.call('probeOutboundAnswerQuality');
  assert.equal(h.state.props.OUTBOUND_PROBE_FROM, undefined);
  assert.equal(h.state.props.OUTBOUND_PROBE_TO, undefined);
});

test('probe: spike detection reads the SINGLE-ATTEMPT histogram, never all-attempts', function () {
  // The capture detail the plan missed: `connected` can come from a later
  // leg while `ring_seconds` describes the first, so a multi-attempt row
  // mixes two legs' facts. Feed a clean single-attempt histogram and a
  // deliberately corrupted all-attempts one; the verdict must follow the
  // former.
  const junk = {};
  for (let i = 1; i <= 60; i++) junk[i] = 500;
  installProbe_(probeConn_(probeJson1_({ ringHistAll: hist_(junk) }), PROBE_JSON2_));
  const out = h.call('probeOutboundAnswerQuality');
  assert.match(out.result, /^ok bimodal: ring spike at 25s/);
  assert.ok(out.ringHistAllAttempts.length, 'still REPORTED — nothing is hidden');
});

test('probe: query 1 binds the window and scopes every sub-select to connected rows', function () {
  const conn = probeConn_(probeJson1_(), PROBE_JSON2_);
  installProbe_(conn);
  h.call('probeOutboundAnswerQuality');
  const q1 = conn.prepared[0];
  const binds = (q1.sql.match(/\?::date/g) || []).length;
  assert.ok(binds >= 20, 'every sub-select carries the window');
  assert.equal(Object.keys(q1.p).length, binds, 'every placeholder is bound');
  for (let i = 1; i + 1 <= binds; i += 2) {
    assert.equal(q1.p[i], '2026-08-01');
    assert.equal(q1.p[i + 1], '2026-08-28');
  }
  assert.match(q1.sql, /AND connected /, 'ring length only means anything on a connect');
  assert.match(q1.sql, /COALESCE\(attempts,1\) = 1/);
  // PHI: aggregates only. The repeat check groups BY the hash and returns
  // counts; no hash, number or call id may be selected out.
  assert.ok(!/SELECT callee_hash[^,)]*\)::text/.test(q1.sql));
  assert.ok(!/json_agg\([^)]*callee_hash/.test(q1.sql),
    'a hash must never reach the payload');
});

test('probe: query 2 cuts at the RESOLVED band with bound ints, in positional order', function () {
  const conn = probeConn_(probeJson1_(), PROBE_JSON2_);
  installProbe_(conn);
  h.call('probeOutboundAnswerQuality');
  assert.equal(conn.prepared.length, 2);
  const q2 = conn.prepared[1];
  // 19 params: 4 quadrant triples, the half-open threshold, the quadrant
  // window, the attempts band, the attempts window.
  assert.equal(Object.keys(q2.p).length, 19);
  assert.equal(q2.p[1], 24); assert.equal(q2.p[2], 26); assert.equal(q2.p[3], 15);
  assert.equal(q2.p[13], 24, 'the half-open reading uses the LEFT edge');
  assert.equal(q2.p[14], '2026-08-01'); assert.equal(q2.p[15], '2026-08-28');
  assert.equal(q2.p[16], 24); assert.equal(q2.p[17], 26);
  assert.equal(q2.p[18], '2026-08-01'); assert.equal(q2.p[19], '2026-08-28');
  // BOTH out-of-band cells, not just one: a NULL ring is counted by
  // `NOT BETWEEN` as NULL, so a cell missing the guard drops those rows
  // from the quadrants entirely and the four cells quietly stop summing.
  assert.equal((q2.sql.match(/ring_seconds IS NULL OR ring_seconds NOT BETWEEN/g) || []).length, 2,
    'a NULL ring must land OUTSIDE the band in every out-of-band cell');
  assert.match(q2.sql, /'total', count\(\*\)/,
    'the total is what makes a non-summing quadrant set visible');
});

test('probe: admin-gated, Neon-down is FAILED, a bad window throws', function () {
  installProbe_(probeConn_(probeJson1_(), PROBE_JSON2_));
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.match(h.call('probeOutboundAnswerQuality').result, /^FAILED \(Neon unreachable\)/);

  installProbe_(probeConn_(probeJson1_(), PROBE_JSON2_));
  h.state.props.OUTBOUND_PROBE_FROM = '2026-09-01';
  h.state.props.OUTBOUND_PROBE_TO = '2026-08-01';
  assert.throws(function () { h.call('probeOutboundAnswerQuality'); }, /from <= to/);

  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  assert.throws(function () { h.call('probeOutboundAnswerQuality'); }, /admin/i);
  h.state.testUser = null;
});

test('probe: unset window props default to a ~28-day range ending yesterday', function () {
  installProbe_(probeConn_(probeJson1_(), PROBE_JSON2_));
  delete h.state.props.OUTBOUND_PROBE_FROM;
  delete h.state.props.OUTBOUND_PROBE_TO;
  const out = h.call('probeOutboundAnswerQuality');
  const days = Math.round(
    (new Date(out.window.to + 'T12:00:00Z') - new Date(out.window.from + 'T12:00:00Z')) / 86400000);
  assert.equal(days, 27, 'a distribution needs more mass than the vetting check\'s parity count');
  // P16: script TZ, or an evening run defaults "yesterday" to a partial,
  // still-importing day.
  assert.match(OB_SRC, /function obProbeWindow_[\s\S]*?Utilities\.formatDate\(d, TZ,/);
});

test('probe: the source keeps its read-only contract', function () {
  const body = OB_SRC.slice(OB_SRC.indexOf('function probeOutboundAnswerQuality'));
  const probe = body.slice(0, body.indexOf('\nfunction obProbeSpikeHint_'));
  assert.ok(!/setProperty\(/.test(probe), 'the probe measures; it never sets a parameter');
  assert.ok(!/INSERT |UPDATE |DELETE /.test(probe), 'read-only against Neon');
  assert.match(probe, /assertAdmin_\(\);/);
  assert.match(probe, /neonNoteEgress_\([^,]+, 'outbound-probe'\)/,
    'every Neon read is egress-metered with a surface label (EA-1)');
});

// ══ probeOutboundInstantConnects — (c), the 0-1s population ════════════════
//
// The first answer-quality run found 40.6% of connected single-attempt calls
// recording a ring of 0-1s, which caps any ring-based classifier at ~60% of
// the population. This probe's job is to say WHICH of two causes it is, since
// they need opposite fixes: a wrong CONNECTED timestamp (recoverable from the
// journey we already store) or genuinely instant connects (permanent, and the
// classifier must exclude and disclose them). The tests below spend their
// effort on that fork and on the refusal between them.

// ── The pure derivation ────────────────────────────────────────────────────

test('instant/derive: the EXTERNAL leg is found by its marker, not by position', function () {
  // An outbound group can carry the agent's own leg first, so position is not
  // the identifier. '(external number)' is the AUTHORITATIVE marker, and it
  // stays first so a capture-side fix that starts labelling the leg wins here
  // with no reader change — measured, it currently never fires on outbound
  // (see the fallback tests below).
  const j = JSON.stringify([
    { t: '09:00:00', name: 'Ann Agent', kind: 'leg', secs: 30, talk: 25 },
    { t: '09:00:01', name: '(external number)', kind: 'answer', secs: 40, talk: 18, hold: 2 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 20, 'secs 40 − talk 18 − hold 2');
});

test('instant/derive: absent evidence is null, never a zero', function () {
  // A zero here would read as "connected instantly" and land in the very
  // bucket under investigation — the one place a default is most harmful.
  assert.equal(h.ctx.obInstantDerivedRing_(null), null);
  assert.equal(h.ctx.obInstantDerivedRing_('not json'), null);
  assert.equal(h.ctx.obInstantDerivedRing_('[]'), null);
  assert.equal(h.ctx.obInstantDerivedRing_(JSON.stringify([
    { name: 'Ann Agent', secs: 10 }])), null, 'no external leg at all');
  assert.equal(h.ctx.obInstantDerivedRing_(JSON.stringify([
    { name: '(external number)', talk: 5 }])), null, 'external leg with no duration');
});

test('instant/derive: never negative, and missing talk/hold count as zero', function () {
  assert.equal(h.ctx.obInstantDerivedRing_(JSON.stringify([
    { name: '(external number)', secs: 5, talk: 90 }])), 0, 'clamped, not negative');
  assert.equal(h.ctx.obInstantDerivedRing_(JSON.stringify([
    { name: '(external number)', secs: 12 }])), 12);
});

// The MEASURED fallback (probeOutboundJourneyShape, live 2026-09-18). The
// '(external number)' marker resolved 0 of 600 sampled rows, and the shape
// diagnostic showed why: `icBuildJourney_` labels an event from CALLEE_NAME,
// which an outbound dial leaves blank, so every outbound external leg is
// named '(unknown)'. On the answer key (rows that provably rang >= 17s) the
// first 'unknown'-class event covered 100% of rows at a median 27s with every
// value a real ring, and read a median 1s on the instant group — it tracks
// the stored ring across both populations, which an internal hop would not.

test('instant/derive: falls back to the first unknown-class leg (the measured marker)', function () {
  // The live outbound shape: two events, both '(unknown)', no marker in sight.
  const j = JSON.stringify([
    { t: '09:00:00', name: '(unknown)', kind: 'answer', secs: 45, talk: 18 },
    { t: '09:00:46', name: '(unknown)', kind: 'leg', secs: 80 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 27, 'secs 45 − talk 18, from the FIRST unknown leg');
});

test('instant/derive: the explicit marker still outranks an earlier unknown leg', function () {
  // Ordering matters: if a capture fix starts labelling the external leg, the
  // fallback must not shadow it from an earlier position.
  const j = JSON.stringify([
    { name: '(unknown)', kind: 'leg', secs: 90 },
    { name: '(external number)', kind: 'answer', secs: 40, talk: 18, hold: 2 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 20, 'the marked leg wins, not the first unknown one');
});

test('instant/derive: the fallback is by CLASS, so a leading queue is skipped', function () {
  // 12% of the sampled instant rows passed through a queue first. A queue
  // event classes as 'queue' whatever its name, so measuring it is impossible
  // here — a bare ev[0] fallback would have measured the hold music.
  const j = JSON.stringify([
    { name: '(unknown)', kind: 'queue', secs: 12 },
    { name: '(unknown)', kind: 'answer', secs: 30, talk: 25 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 5, 'the queue leg is not the external leg');
});

test('instant/derive: an unknown leg with no duration REFUSES rather than hunting on', function () {
  // Same rule as the marker arm: absent evidence is null. Walking past it to
  // a later leg would silently measure a different call segment.
  assert.equal(h.ctx.obInstantDerivedRing_(JSON.stringify([
    { name: '(unknown)', kind: 'leg', talk: 5 },
    { name: '(unknown)', kind: 'answer', secs: 30 },
  ])), null);
});

// ── The pure verdict ───────────────────────────────────────────────────────

const instStats_ = (share, median, rungMedian) => ({
  instant: { sampled: 300, realRingShare: share, medianDerived: median },
  rung: { sampled: 300, realRingShare: 0.95, medianDerived: rungMedian == null ? 21 : rungMedian },
});

test('instant/verdict: a healthy derived ring means the TIMESTAMP is wrong (recoverable)', function () {
  const v = h.ctx.obInstantVerdict_(instStats_(0.82, 19));
  assert.equal(v.code, 'ok');
  assert.equal(v.reason, 'connected-timestamp');
  assert.match(v.text, /RECOVERABLE from the journey/);
  assert.match(v.text, /82\.0%/, 'one decimal, like every other share here');
});

test('instant/verdict: no derived ring either means the calls really ARE instant', function () {
  const v = h.ctx.obInstantVerdict_(instStats_(0.04, 0));
  assert.equal(v.code, 'ok');
  assert.equal(v.reason, 'carrier-instant');
  assert.match(v.text, /must EXCLUDE them/);
  assert.match(v.text, /reachable population is the remainder/);
});

test('instant/verdict: the middle is REFUSED, not split down the middle', function () {
  // The two causes need opposite fixes, so averaging them would send the
  // remedy in one direction for calls that need the other.
  const v = h.ctx.obInstantVerdict_(instStats_(0.4, 6));
  assert.equal(v.code, 'INCONCLUSIVE');
  assert.equal(v.reason, 'mixed');
  assert.match(v.text, /BOTH causes are present, and they need opposite fixes/);
});

test('instant/verdict: no journeys to cross-check is INCONCLUSIVE, not carrier-instant', function () {
  // The dangerous default: zero samples gives share 0, which without this
  // guard reads as the strongest possible "genuinely instant" evidence.
  const v = h.ctx.obInstantVerdict_({ instant: { sampled: 0, realRingShare: 0 } });
  assert.equal(v.code, 'INCONCLUSIVE');
  assert.equal(v.reason, 'no-journeys');
});

// ── Concentration ──────────────────────────────────────────────────────────

test('instant/concentration: a few agents carrying the instant rows is flagged', function () {
  const agents = [];
  for (let i = 0; i < 12; i++) {
    agents.push({ agent: 'A' + i, n: 200, instant: i < 5 ? 160 : 4 });
  }
  const c = h.ctx.obInstantConcentration_(agents);
  assert.equal(c.concentrated, true);
  assert.equal(c.top.length, 5);
  assert.equal(c.top[0].rate, 0.8);
});

test('instant/concentration: the ACTIONABLE list is by RATE, the measure is by VOLUME', function () {
  // The trap this separation exists for: a very busy agent with a NORMAL
  // instant rate out-volumes everyone and would head a volume-sorted list —
  // sending someone to inspect the wrong phone. Zed has the most instant
  // calls; Ann has the anomalous rate.
  const agents = [
    { agent: 'Zed', n: 4000, instant: 600 },   // rate 0.15, top volume
    { agent: 'Ann', n: 200, instant: 180 },    // rate 0.90, the anomaly
    { agent: 'Bob', n: 200, instant: 20 },
    { agent: 'Cid', n: 200, instant: 20 },
    { agent: 'Dee', n: 200, instant: 20 },
    { agent: 'Eve', n: 200, instant: 20 },
    { agent: 'Fay', n: 200, instant: 20 },
  ];
  const c = h.ctx.obInstantConcentration_(agents);
  assert.equal(c.top[0].agent, 'Ann', 'the actionable list leads with the RATE outlier');
  assert.ok(c.topShare > 0.8, 'while the concentration MEASURE still counts Zed\'s volume');
});

test('instant/concentration: thin agents cannot swing the verdict', function () {
  // Six evenly-spread real agents plus five tiny all-instant ones. Without
  // the minimum-calls filter the tiny ones own the top 5 and the whole
  // population reads as "concentrated" on agents with 5 calls each.
  const agents = [];
  for (let i = 0; i < 6; i++) agents.push({ agent: 'Real' + i, n: 400, instant: 150 });
  for (let i = 0; i < 5; i++) agents.push({ agent: 'Thin' + i, n: 5, instant: 5 });
  const c = h.ctx.obInstantConcentration_(agents);
  assert.equal(c.concentrated, false);
  assert.equal(c.agents, 6, 'the five 5-call agents are not rated at all');
});

test('instant/concentration: a SMALL roster is judged against an even spread', function () {
  // Six agents sharing the instant rows EVENLY already put 83% in the top
  // five — a raw top-5 threshold calls that concentrated, which is an
  // artefact of the roster size and not a finding.
  const even = [];
  for (let i = 0; i < 6; i++) even.push({ agent: 'E' + i, n: 400, instant: 150 });
  const c = h.ctx.obInstantConcentration_(even);
  assert.equal(c.concentrated, false, 'even is never concentrated, however few agents');
  assert.ok(c.topShare > 0.8, 'even though the raw top-5 share is high');
  assert.equal(c.evenBaseline, 0.833, 'and the baseline it was judged against is reported');
});

test('instant/concentration: too few RATED agents is null, not a verdict', function () {
  // Two agents clear the minimum. Two agents cannot establish whether a
  // population is concentrated — there is nothing for them to be concentrated
  // against.
  const agents = [{ agent: 'A', n: 400, instant: 300 }, { agent: 'B', n: 400, instant: 250 },
                  { agent: 'C', n: 4, instant: 4 }];
  assert.equal(h.ctx.obInstantConcentration_(agents).concentrated, null);
});

test('instant/concentration: an even spread is not flagged', function () {
  const agents = [];
  for (let i = 0; i < 12; i++) agents.push({ agent: 'A' + i, n: 200, instant: 80 });
  assert.equal(h.ctx.obInstantConcentration_(agents).concentrated, false);
});

test('instant/concentration: thin agents are excluded, and too few to judge is null', function () {
  const thin = [{ agent: 'A', n: 5, instant: 5 }, { agent: 'B', n: 3, instant: 3 }];
  assert.equal(h.ctx.obInstantConcentration_(thin).concentrated, null,
    'an agent with 5 calls cannot carry a verdict');
  assert.equal(h.ctx.obInstantConcentration_([]).concentrated, null);
});

// ── End to end ─────────────────────────────────────────────────────────────

function instConn_(j1, j2) {
  const conn = {
    prepared: [], closed: false,
    prepareStatement: function (s) {
      const ps = { _p: {}, sql: s, setString: function (i, v) { ps._p[i] = v; },
                   setInt: function (i, v) { ps._p[i] = v; } };
      ps.executeQuery = function () {
        conn.prepared.push({ sql: s, p: ps._p });
        const j = /'buckets'/.test(s) ? j1 : j2;
        let n = 0;
        return { next: function () { return n++ === 0; },
                 getString: function () { return j; }, close: function () {} };
      };
      ps.close = function () {};
      return ps;
    },
    close: function () { conn.closed = true; },
  };
  return conn;
}

// Shaped on the live 2026-09-15 population: ~40% instant, a long human decay,
// the 17-32s spike region, and almost nothing past 32s.
const INST_J1_ = JSON.stringify({
  buckets: [{ ring: 0, n: 26854, talkMedian: 41, talkAvg: 96 },
            { ring: 2, n: 21609, talkMedian: 55, talkAvg: 120 },
            { ring: 17, n: 17280, talkMedian: 38, talkAvg: 88 },
            { ring: 33, n: 464, talkMedian: 60, talkAvg: 140 }],
  agents: [{ agent: 'Ann', n: 900, instant: 380 }, { agent: 'Bob', n: 800, instant: 300 },
           { agent: 'Cid', n: 700, instant: 260 }, { agent: 'Dee', n: 600, instant: 240 },
           { agent: 'Eve', n: 500, instant: 200 }, { agent: 'Fay', n: 400, instant: 150 },
           { agent: 'Gil', n: 300, instant: 120 }, { agent: 'Hal', n: 6, instant: 6 }],
  days: [{ d: '2026-09-01', n: 2400, instant: 980 }, { d: '2026-09-02', n: 2300, instant: 940 }],
});
function instJourneys_(instantDerived, rungDerived) {
  const mk = (grp, secs) => ({ grp: grp,
    journey: JSON.stringify([{ name: 'Ann Agent', secs: 5 },
                             { name: '(external number)', secs: secs + 30, talk: 30 }]) });
  return JSON.stringify(
    instantDerived.map((s) => mk('instant', s)).concat(rungDerived.map((s) => mk('rung', s))));
}

function installInstant_(conn) {
  h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales'] };
  h.state.props = { OUTBOUND_PROBE_FROM: '2026-08-18', OUTBOUND_PROBE_TO: '2026-09-14' };
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
}

test('instant: a wrong-timestamp population is diagnosed, with the control group quoted', function () {
  const conn = instConn_(INST_J1_, instJourneys_([18, 19, 20, 21, 22], [20, 21, 22, 23, 24]));
  installInstant_(conn);
  const out = JSON.parse(JSON.stringify(h.call('probeOutboundInstantConnects')));
  assert.equal(out.verdict, 'connected-timestamp');
  assert.match(out.result, /^ok \(connected-timestamp\)/);
  assert.match(out.result, /40\.6% of connected single-attempt calls ring <= 1s/);
  assert.match(out.result, /CONTROL: calls that provably rang/,
    'the derived number means nothing without the group that provably rang');
  assert.equal(out.instant.realRingShare, 1);
  assert.equal(out.instant.medianDerived, 20);
  assert.equal(out.rung.medianDerived, 22);
  assert.equal(conn.closed, true);
});

test('instant: a genuinely-instant population is diagnosed as permanent', function () {
  const conn = instConn_(INST_J1_, instJourneys_([0, 0, 0, 1, 0], [20, 21, 22, 23, 24]));
  installInstant_(conn);
  const out = h.call('probeOutboundInstantConnects');
  assert.equal(out.verdict, 'carrier-instant');
  assert.match(out.result, /^ok \(carrier-instant\)/);
  assert.match(out.result, /must EXCLUDE them/);
});

test('instant: the mixed case refuses rather than averaging two opposite remedies', function () {
  // 4 real rings out of 10 = 0.4, strictly inside the refusal band (0.2, 0.5).
  const conn = instConn_(INST_J1_, instJourneys_([0, 0, 0, 20, 21, 0, 22, 0, 23, 0],
                                                 [20, 21, 22, 23, 24]));
  installInstant_(conn);
  const out = h.call('probeOutboundInstantConnects');
  assert.equal(out.verdict, 'mixed');
  assert.match(out.result, /^INCONCLUSIVE \(mixed\)/);
});

test('instant: too thin a window refuses BEFORE fetching any journey', function () {
  const thin = JSON.stringify({ buckets: [{ ring: 0, n: 40 }, { ring: 2, n: 30 }],
                                agents: [], days: [] });
  const conn = instConn_(thin, instJourneys_([20], [20]));
  installInstant_(conn);
  const out = h.call('probeOutboundInstantConnects');
  assert.match(out.result, /^INCONCLUSIVE \(only 70 connected single-attempt calls/);
  assert.match(out.result, /widen OUTBOUND_PROBE_FROM/);
  assert.equal(out.verdict, undefined);
  assert.equal(conn.prepared.length, 1, 'no point sampling journeys from a window this thin');
});

test('instant: query 1 scopes to CONNECTED single-attempt rows with a ring, window bound', function () {
  const conn = instConn_(INST_J1_, instJourneys_([20], [20]));
  installInstant_(conn);
  h.call('probeOutboundInstantConnects');
  const q1 = conn.prepared[0].sql;
  assert.match(q1, /AND connected AND COALESCE\(attempts,1\) = 1 AND ring_seconds IS NOT NULL/);
  const binds = (q1.match(/\?::date/g) || []).length;
  assert.ok(binds >= 6, 'every sub-select carries the window');
  assert.equal(Object.keys(conn.prepared[0].p).length, binds, 'every placeholder is bound');
  assert.equal(conn.prepared[0].p[1], '2026-08-18');
  assert.equal(conn.prepared[0].p[2], '2026-09-14');
  // PHI: aggregates only. The journey sample is fetched, but no phone, hash
  // or call id may be selected in either statement.
  const all = conn.prepared.map((x) => x.sql).join('\n');
  assert.ok(!/callee_hash/.test(all), 'no hash leaves the database');
  assert.ok(!/call_id/.test(all), 'no call id either');
});

test('instant: the journey sample takes a matched CONTROL group, newest first', function () {
  const conn = instConn_(INST_J1_, instJourneys_([20], [20]));
  installInstant_(conn);
  h.call('probeOutboundInstantConnects');
  const q2 = conn.prepared[1].sql;
  assert.match(q2, /'instant' AS grp/);
  // Anchored on the real second SELECT, not on the words appearing anywhere:
  // a pin that a commented-out clause still satisfies is not a pin.
  assert.match(q2, /UNION ALL \(SELECT 'rung' AS grp/,
    'the control group is what makes the number mean anything');
  assert.match(q2, /ring_seconds <= 1 AND journey IS NOT NULL/);
  assert.match(q2, /ring_seconds >= 17 AND journey IS NOT NULL/);
  assert.equal((q2.match(/ORDER BY call_date DESC/g) || []).length, 2, 'newest first, both groups');
  assert.equal((q2.match(/LIMIT 300/g) || []).length, 2);
});

test('instant: a journey with no external leg is counted, not silently dropped', function () {
  const rows = JSON.stringify([
    { grp: 'instant', journey: JSON.stringify([{ name: 'Ann Agent', secs: 9 }]) },
    { grp: 'instant', journey: JSON.stringify([{ name: '(external number)', secs: 50, talk: 30 }]) },
    { grp: 'rung', journey: JSON.stringify([{ name: '(external number)', secs: 51, talk: 30 }]) },
  ]);
  const conn = instConn_(INST_J1_, rows);
  installInstant_(conn);
  const out = h.call('probeOutboundInstantConnects');
  assert.equal(out.instant.noExternalLeg, 1,
    'an unusable blob is reported — a silently smaller sample is a quietly weaker claim');
  assert.equal(out.instant.sampled, 1);
});

test('instant: admin-gated, Neon-down is FAILED, a bad window throws', function () {
  installInstant_(instConn_(INST_J1_, instJourneys_([20], [20])));
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.match(h.call('probeOutboundInstantConnects').result, /^FAILED \(Neon unreachable\)/);

  installInstant_(instConn_(INST_J1_, instJourneys_([20], [20])));
  h.state.props.OUTBOUND_PROBE_FROM = '2026-09-20';
  assert.throws(function () { h.call('probeOutboundInstantConnects'); }, /from <= to/);

  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  assert.throws(function () { h.call('probeOutboundInstantConnects'); }, /admin/i);
  h.state.testUser = null;
});

test('instant: the source keeps its read-only contract', function () {
  const body = OB_SRC.slice(OB_SRC.indexOf('function probeOutboundInstantConnects'));
  const probe = body.slice(0, body.indexOf('\n// ------'));
  assert.ok(!/setProperty\(/.test(probe), 'it measures; it never sets a parameter');
  assert.ok(!/clearToolParamsAfterCleanRun_/.test(probe),
    'and it does not clear the window either — the answer-quality probe owns those props');
  assert.ok(!/INSERT |UPDATE |DELETE /.test(probe), 'read-only against Neon');
  assert.match(probe, /assertAdmin_\(\);/);
  assert.match(probe, /neonNoteEgress_\([^,]+, 'outbound-instant'\)/);
});

// ---------------------------------------------------------------------------
// The journey-shape DIAGNOSTIC (2026-09-18). `probeOutboundInstantConnects`
// came back `no-journeys` on a live run -- zero usable external legs in 600
// sampled rows -- because `obInstantDerivedRing_` matches ONE name mask and
// `icBuildJourney_` emits several. These pin the diagnostic that decides the
// fix, and the property that makes it a diagnostic rather than a shape dump:
// it separates the two causes the old null conflated.
// ---------------------------------------------------------------------------

test('jshape: every mask branch icBuildJourney_ can emit gets its own CLASS', function () {
  const c = h.ctx.obJourneyNameClass_;
  assert.equal(c({ name: '(external number)' }), 'extNumber');
  assert.equal(c({ name: '(external caller)' }), 'extCaller');
  assert.equal(c({ name: 'A.P.' }), 'initials', 'cdrMaskExternalName_ output');
  assert.equal(c({ name: 'R.' }), 'initials', 'a single-word CNAM masks to one initial');
  assert.equal(c({ name: '(unknown)' }), 'unknown', 'empty / N/A callee name');
  assert.equal(c({ name: 'A_Q_CSR', kind: 'queue' }), 'queue', 'kind wins over the name');
  assert.equal(c({ name: 'Sonia Martinez' }), 'other', 'an internal agent CNAM');
  assert.equal(c(null), 'other');
});

test('jshape: the class is the ONLY thing derived from a name (no CNAM can leak)', function () {
  // The guard that keeps this probe inside the PHI rule: whatever goes in,
  // what comes out is one of six fixed strings.
  const CLASSES = ['extNumber', 'extCaller', 'initials', 'unknown', 'queue', 'other'];
  ['Jane Q Public', '+15551234567', 'ACME PHARMACY LLC', '', 'N/A'].forEach(function (n) {
    assert.ok(CLASSES.indexOf(h.ctx.obJourneyNameClass_({ name: n })) >= 0,
      'class for ' + JSON.stringify(n) + ' is one of the six, never the name');
  });
});

test('jshape: derived ring is secs minus talk and hold, floored at 0, null without secs', function () {
  const r = h.ctx.obJourneyEventRing_;
  assert.equal(r({ secs: 30, talk: 8, hold: 2 }), 20);
  assert.equal(r({ secs: 30 }), 30, 'absent talk/hold count as zero');
  assert.equal(r({ secs: 5, talk: 90 }), 0, 'never negative');
  assert.equal(r({ talk: 8 }), null, 'no secs = absent evidence, never a zero');
  assert.equal(r(null), null);
});

test('jshape: the CURRENT marker\'s null is split into its two causes', function () {
  // This is the whole point of the diagnostic. The live probe reported 300
  // noExternalLeg and could not say whether the marker missed or the matched
  // event had no duration -- which need different fixes.
  const rows = [
    [{ name: '(external number)', secs: 30, talk: 5 }],        // resolves -> 25
    [{ name: '(external number)' }],                            // matched, no secs
    [{ name: 'A.P.', secs: 22, talk: 2 }],                      // no match (initials)
    [{ name: '(unknown)', secs: 19 }],                          // no match (unknown)
  ];
  const s = h.ctx.obJourneyMarkerScores_(rows);
  assert.equal(s.rows, 4);
  // Field-by-field, not deepEqual: the object is built inside the vm realm.
  assert.equal(s.current.derived, 1);
  assert.equal(s.current.nullNoMatch, 2, 'initials + unknown: the marker never matched');
  assert.equal(s.current.nullMatchNoSecs, 1, 'matched, but the event carried no duration');
});

test('jshape: each candidate marker is scored for coverage AND median, first-of-class', function () {
  const rows = [
    [{ name: 'Agent One', secs: 4 }, { name: 'A.P.', secs: 30, talk: 8, hold: 2 }],
    [{ name: 'Agent Two', secs: 3 }, { name: 'B.Q.', secs: 24, talk: 4 }],
    [{ name: 'Agent Three', secs: 2 }],
  ];
  const s = h.ctx.obJourneyMarkerScores_(rows);
  // The initials class is present on 2 of 3 rows and derives 20 and 20.
  assert.equal(s.candidates.initials.rows, 2);
  assert.equal(s.candidates.initials.coverage, 0.667);
  assert.equal(s.candidates.initials.medianDerived, 20);
  assert.equal(s.candidates.initials.realRingShare, 1, 'both are real rings');
  // The current marker finds nothing here -- the live failure, reproduced.
  assert.equal(s.current.derived, 0);
  assert.equal(s.current.nullNoMatch, 3);
  // Positional candidates are scored too, and firstEvent is the WRONG answer
  // on this fixture (it reads the internal hop at 2-4s), which is exactly the
  // discrimination the rung control group provides.
  assert.equal(s.candidates.firstEvent.rows, 3);
  assert.equal(s.candidates.firstEvent.medianDerived, 3);
  assert.equal(s.candidates.lastEvent.medianDerived, 20);
  assert.ok(!('rings' in s.candidates.initials), 'per-call values are dropped, never returned');
});

test('jshape: counts events and rows per class, and tracks secs availability', function () {
  const rows = [
    [{ name: '(external number)', secs: 10 }, { name: '(external number)' }],
    [{ name: 'A_Q_CSR', kind: 'queue', secs: 3 }, { name: '(unknown)', secs: 8 }],
  ];
  const s = h.ctx.obJourneyMarkerScores_(rows);
  assert.equal(s.classEvents.extNumber, 2, 'two events');
  assert.equal(s.rowsWithClass.extNumber, 1, 'but only one row holds them');
  assert.equal(s.classWithSecs.extNumber, 1, 'one of the two carries secs');
  assert.equal(s.classEvents.queue, 1);
  assert.equal(s.classEvents.unknown, 1);
  assert.equal(s.eventCountHist[2], 2, 'both rows carry two events');
  assert.equal(Object.keys(s.eventCountHist).length, 1);
});

// DIFFERENTIAL: the shape diagnostic's recommendation must agree with the
// marker the probe actually uses (2026-09-21).
//
// Why this exists: probeOutboundJourneyShape scored the first `unknown`-class
// event at a median 1s on the instant group, and probeOutboundInstantConnects
// -- which derives through obInstantDerivedRing_, whose fallback IS that same
// marker -- then reported 68s on a sample drawn by BYTE-IDENTICAL SQL. One of
// those numbers has to be wrong, and the pair of tools is exactly the shape
// this repo has been bitten by four times: a verification tool contradicting
// the thing it is verifying, during the investigation it exists to serve.
//
// So pin the invariant rather than the numbers: for a journey with no
// '(external number)' event -- the measured production shape, 0 of 600 sampled
// events carried one -- the `unknown` candidate the diagnostic REPORTS and the
// value obInstantDerivedRing_ RETURNS must be the same value, always. If they
// ever diverge, the recommendation cannot be trusted and neither can a verdict
// built on it.
test('diagnostic/marker parity: the unknown candidate equals what the live marker returns', function () {
  // No extNumber (never observed on outbound). Mixes the P-11 era's masked
  // names with the pre-P-11 '(unknown)' so both arms of the marker are hit.
  const NAMES = ['(unknown)', '(external caller)', 'A.P.', 'Ann Agent'];
  const KINDS = ['leg', 'answer', 'queue'];
  let seed = 12345;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  let compared = 0;
  for (let i = 0; i < 3000; i++) {
    const ev = [];
    for (let k = 0, n = 1 + rnd(4); k < n; k++) {
      const e = { name: NAMES[rnd(NAMES.length)], kind: KINDS[rnd(KINDS.length)] };
      if (rnd(10) > 0) e.secs = rnd(200);
      if (rnd(3) === 0) e.talk = rnd(120);
      if (rnd(5) === 0) e.hold = rnd(30);
      ev.push(e);
    }
    const cands = h.ctx.obJourneyMarkerScores_([ev]).candidates;
    // The marker prefers the P-11 MASKED external leg (initials, else
    // '(external caller)') and only falls back to '(unknown)' for pre-P-11
    // rows -- so the candidate it must agree with is era-dependent. One row
    // in, so each candidate's median IS that row's derived value.
    const pick = cands.initials.rows ? cands.initials
      : (cands.extCaller.rows ? cands.extCaller : cands.unknown);
    const reported = pick.rows ? pick.medianDerived : null;
    const live = h.ctx.obInstantDerivedRing_(JSON.stringify(ev));
    assert.equal(reported, live,
      'journey ' + JSON.stringify(ev) + ': diagnostic says ' + reported + ', marker returns ' + live);
    compared++;
  }
  assert.ok(compared >= 3000, 'the sweep actually ran');
});

test('diagnostic/marker parity holds over a MULTI-ROW sample, not just per journey', function () {
  // The sweep above feeds ONE journey per call, so a bug in the diagnostic's
  // accumulation ACROSS rows would be invisible to it -- which was the real
  // gap in the first version of this proof.
  //
  // The live POST-P-11 shape: 2 events, one masked-initials external leg
  // carrying the talk (small ring) and one '(unknown)' leg carrying none
  // (its whole duration reads as a residual). Picking the wrong one of these
  // two is exactly what produced the 1s-vs-68s disagreement.
  const journeys = [];
  for (let i = 0; i < 300; i++) {
    journeys.push([
      { name: 'A.P.', kind: 'answer', secs: 100 + i, talk: 99 + i },
      { name: '(unknown)', kind: 'leg', secs: 60 + i },
    ]);
  }
  const cand = h.ctx.obJourneyMarkerScores_(journeys).candidates.initials;
  const derived = journeys.map((ev) => h.ctx.obInstantDerivedRing_(JSON.stringify(ev)));
  const kept = derived.filter((v) => v !== null);
  assert.equal(kept.length, journeys.length, 'the marker resolved every row');
  assert.equal(cand.medianDerived, h.ctx.obInstantMedian_(kept), 'medians agree over 300 rows');
  const real = kept.filter((v) => v >= 3).length;
  assert.equal(cand.realRingShare, Math.round(real / kept.length * 1000) / 1000,
    'real-ring shares agree over 300 rows');
});

// THE P-11 ERA SPLIT (measured 2026-09-21). This is what made two runs of the
// same marker disagree, and it is worth pinning because the capture changed
// under the reader rather than the reader changing.
//
// P-11 shipped 2026-09-17, adding the icBuildJourney_ branch that names a
// CALLEE-external leg with its MASKED CNAM. Before it, that leg had no name
// branch that fired and fell through to '(unknown)'. So:
//   pre-P-11 rows  -> the external leg IS the first '(unknown)' event
//   post-P-11 rows -> the external leg is masked initials, and the remaining
//                     '(unknown)' is the OTHER leg, whose secs-talk-hold is a
//                     residual rather than a ring
// A marker that only knows the pre-P-11 rule silently reads the wrong leg on
// every row captured after 2026-09-17 -- which is how a `carrier-instant`
// population (stored ring <= 1s, derived 1s) reported a 68s ring and flipped
// the verdict to `connected-timestamp`.

test('P-11 era: the MASKED external leg wins over the (unknown) leg beside it', function () {
  // Post-P-11: initials carry the talk, so the external ring is small and
  // agrees with a stored ring <= 1s. The other leg's 300s is a residual.
  const j = JSON.stringify([
    { name: '(unknown)', kind: 'leg', secs: 300 },
    { name: 'A.P.', kind: 'answer', secs: 240, talk: 239 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 1,
    'the masked external leg, not the 300s residual -- order in the blob must not matter');
});

test("P-11 era: '(external caller)' counts too -- it is the mask declining, not a different leg", function () {
  const j = JSON.stringify([
    { name: '(external caller)', kind: 'answer', secs: 50, talk: 20 },
    { name: '(unknown)', kind: 'leg', secs: 400 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 30);
});

test('PRE-P-11 era: with no masked leg, the first (unknown) is still the external one', function () {
  const j = JSON.stringify([
    { name: '(unknown)', kind: 'answer', secs: 45, talk: 18 },
    { name: '(unknown)', kind: 'leg', secs: 80 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 27, 'the pre-P-11 fallback must survive for history');
});

test('an internal agent CNAM is never the external leg in either era', function () {
  // 'Ann Agent' is class `other`: a real internal name, not a mask. It must
  // not be mistaken for the external party, or a dept would read its own
  // agent's leg as the customer's ring.
  const j = JSON.stringify([
    { name: 'Ann Agent', kind: 'answer', secs: 900, talk: 10 },
    { name: 'A.P.', kind: 'answer', secs: 60, talk: 55 },
  ]);
  assert.equal(h.ctx.obInstantDerivedRing_(j), 5, 'the masked leg, not the internal agent');
  // ...and with no masked leg at all, `other` still does not qualify.
  assert.equal(h.ctx.obInstantDerivedRing_(JSON.stringify([
    { name: 'Ann Agent', kind: 'answer', secs: 900, talk: 10 }])), null);
});
