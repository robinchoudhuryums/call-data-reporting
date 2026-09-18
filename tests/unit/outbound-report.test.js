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
  assert.match(ok.result, /repeat-callee modal ring 25s AGREES/);

  // Same spike, but repeat callees answer at 40s — two methods disagreeing
  // is exactly what the operator must see before trusting the band.
  installProbe_(probeConn_(probeJson1_({ repeatRingHist: hist_({ 40: 70, 25: 3 }) }), PROBE_JSON2_));
  const dis = h.call('probeOutboundAnswerQuality');
  assert.equal(dis.repeat.agreesWithSpike, false);
  assert.match(dis.result, /repeat-callee modal ring 40s DISAGREES/);
  assert.match(dis.result, /^ok bimodal/, 'a disagreement is disclosed, not a verdict downgrade');
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
