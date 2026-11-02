'use strict';

// TR-1 (owner 2026-11-02): the dashboard's Transfer retries list. The rule is
// cdr-import's tfRetriesOfJourney_ (TR-0's diagnostic), MIRRORED in
// TransferRetries.gs -- this suite drives BOTH copies over one set of
// journeys and fails on any difference, then pins the endpoint's gate, caps,
// SQL and payload shape.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const dash = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'DeptConfig.gs', 'TransferRetries.gs'] });
const imp = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'inboundCalls.js', 'transferFilter.js'] });

const BY_AGENT = { 'Daniel (Dishant) Sahani': ['CSR'], 'Camila (Cheshta) Bhutani': ['CSR'], 'Rhea Power': ['Power'],
  'Omar Power': ['Power'], 'Sub Rep': ['PowerSub'], 'Two Roster': ['Power', 'Sales'], 'Sam Seller': ['Sales'] };
const PARENT = { PowerSub: 'Power' };
const plain = (x) => JSON.parse(JSON.stringify(x));
const q = (t, name) => ({ t, name, kind: 'queue' });
const ans = (t, name, talk, x) => Object.assign({ t, name, kind: 'answer', talk: talk || 60 }, x || {});
const att = (t, name, x) => Object.assign({ t, name, kind: 'leg', missed: true, transfer: true }, x || {});
const cons = (t, name) => ({ t, name, kind: 'answer', talk: 40, transfer: true, consult: true });

// One corpus covering every branch of the rule.
const CORPUS = [
  [[q('10:00:00', 'A_Q_CSR'), ans('10:00:05', 'Daniel (Dishant) Sahani', 300), att('10:02:00', 'Rhea Power', { secs: 3 }), cons('10:02:20', 'Omar Power')], null],
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 300), att('10:02:00', 'Rhea Power', { secs: 25, voicemail: true }),
    att('10:02:40', 'Sub Rep', { secs: 30 }), att('10:03:30', 'Omar Power', { secs: 4 })], null],
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 300), att('10:02:00', 'Rhea Power', { secs: 20 }), att('10:03:00', 'Rhea Power', { secs: 20 })], null],
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 300), att('10:02:00', 'Camila (Cheshta) Bhutani', { secs: 3 })], null],
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 300), cons('10:02:00', 'Rhea Power'), cons('10:05:00', 'Omar Power')], null],
  [[att('11:00:00', 'Rhea Power', { secs: 2 }), att('11:00:30', 'Omar Power', { secs: 12 })], 'Camila (Cheshta) Bhutani'],
  [[att('11:00:00', 'Rhea Power', { secs: 2 }), att('11:00:30', 'ext 999', { secs: 2 })], 'Camila (Cheshta) Bhutani'],
  [[att('11:00:00', 'Rhea Power', { secs: 2 }), att('11:00:30', 'Two Roster', { secs: 2 })], 'Camila (Cheshta) Bhutani'],
  [[att('11:00:00', 'Rhea Power', { secs: 2 })], null],
  [[ans('09:00:00', 'Sam Seller', 100), ans('09:05:00', 'Daniel (Dishant) Sahani', 90, { transfer: true, handover: true }),
    att('09:06:00', 'Rhea Power'), att('09:06:20', 'Omar Power', { secs: 9 })], null],
  [[ans('09:00:00', 'Daniel (Dishant) Sahani', 100, { origin: true }), att('09:06:00', 'Rhea Power', { secs: 1 }), att('09:06:20', 'Omar Power', { secs: 1 })], null],
];

test('TR-1: PARITY -- the dashboard mirror reads every corpus journey exactly as cdr-import\'s tfRetriesOfJourney_', function () {
  const lk = imp.call('tfBounceLookups_', imp.call('tfRosterFromGrid_', ['CSR', 'Power', 'PowerSub', 'Sales'], [
    ['Daniel (Dishant) Sahani, 352', 'Rhea Power, 401', 'Sub Rep, 403', 'Sam Seller, 300'],
    ['Camila (Cheshta) Bhutani, 240', 'Omar Power, 402', '', 'Two Roster, 410'],
    ['', 'Two Roster, 410', '', ''],
  ]), [['PowerSub', 'A_Q_PowerSub', 'Power', '', '', true, '', '', '', '']], null);
  const dfn = dash.call('trDeptsOfAgentFn_', BY_AGENT, PARENT);
  let cases = 0;
  CORPUS.forEach(function (c, i) {
    const a = plain(imp.call('tfRetriesOfJourney_', c[0], lk.deptsOfAgent, c[1]));
    const b = plain(dash.call('trRetriesOfJourney_', c[0], dfn, c[1]));
    assert.deepEqual(b, a, 'journey #' + i);
    cases += a.cases.length;
  });
  assert.ok(cases >= 4, 'the corpus exercises real retries (' + cases + ')');
  assert.equal(dash.ctx.TR_QUICK_SECS_, imp.ctx.TF_RETRY_QUICK_SECS_, 'the decline line is the same number on both sides');
});

test('TR-1: the department lookup folds a sub-queue into its parent and dedupes', function () {
  const fn = dash.call('trDeptsOfAgentFn_', { A: ['PowerSub', 'Power'], B: ['Sales'] }, { PowerSub: 'Power' });
  assert.deepEqual(plain(fn('A')), ['Power']);
  assert.deepEqual(plain(fn('B')), ['Sales']);
  assert.deepEqual(plain(fn('nobody')), []);
});

test('TR-1: the payload -- newest first, filtered by the TRIED department, the callee + pair tallies', function () {
  const fn = dash.call('trDeptsOfAgentFn_', BY_AGENT, PARENT);
  const rows = [
    { kind: 'inbound', date: '2026-10-29', callId: 'A1', start: '10:00:00', agent: null, journey: JSON.stringify(CORPUS[0][0]) },
    { kind: 'outbound', date: '2026-10-30', callId: 'B1', start: '11:00:00', agent: 'Camila (Cheshta) Bhutani', journey: JSON.stringify(CORPUS[5][0]) },
    { kind: 'inbound', date: '2026-10-30', callId: 'C1', start: '09:00:00', agent: null, journey: 'not json' },
  ];
  const all = plain(dash.call('trBuildFromRows_', rows, fn, ''));
  assert.deepEqual(all.cases.map((c) => c.callId), ['B1', 'A1'], 'newest first; bad JSON skipped');
  assert.equal(all.summary.cases, 2);
  assert.equal(all.summary.calls, 2);
  assert.deepEqual(all.summary.byOutcome, { quickDecline: 2 });
  assert.deepEqual(all.summary.callees[0], { name: 'Rhea Power', dept: 'Power', n: 2, quickDecline: 2 });
  assert.deepEqual(all.summary.pairs, [{ pair: 'CSR → Power', n: 2 }]);
  assert.equal(all.cases[0].kind, 'outbound');
  assert.equal(all.cases[1].second.outcome, 'answered');
  const none = plain(dash.call('trBuildFromRows_', rows, fn, 'Sales'));
  assert.equal(none.cases.length, 0, 'only cases whose tried department is the one asked');
  assert.ok(!JSON.stringify(all).match(/\d{10}/), 'no phone-number-shaped value in the payload');
});

function install(email) {
  dash.state.userEmail = email;
  dash.state.props.ADMIN_EMAILS = 'admin@x.com';
  dash.state.props.SPREADSHEET_ID = 'fake';
  dash.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': rosterGrid({ CSR: ['Daniel (Dishant) Sahani, 352'], Power: ['Rhea Power, 401', 'Omar Power, 402'] }) },
  });
  dash.state.cache.clear();
  dash.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
}

test('TR-1: admin-only, dates validated, the window capped at 92 days, an unknown department refused', function () {
  install('manager@x.com');
  assert.throws(() => dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }), /admin/i);
  assert.throws(() => dash.call('getTransferRetriesInit'), /admin/i);
  install('admin@x.com');
  assert.throws(() => dash.call('getTransferRetries', { from: 'x', to: '2026-10-30' }), /YYYY-MM-DD/);
  assert.throws(() => dash.call('getTransferRetries', { from: '2026-10-30', to: '2026-10-01' }), /on or before/);
  assert.throws(() => dash.call('getTransferRetries', { from: '2026-01-01', to: '2026-10-30' }), /capped at 92/);
  assert.throws(() => dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30', dept: 'Nope' }), /Unknown department/);
});

test('TR-1: one metered read of both tables, journeys with a transfer AND a missed ring only, no number selected; Neon down reads unavailable', function () {
  install('admin@x.com');
  const seen = [];
  const metered = [];
  dash.ctx.neonNoteEgress_ = function (n, label) { metered.push(label); };
  dash.ctx.getDashboardNeonConn_ = function () {
    return { prepareStatement: function (sql) { const p = []; seen.push({ sql, p });
      return { setString: function (i, v) { p[i - 1] = v; },
        executeQuery: function () { let used = false; return { next: () => { if (used) return false; used = true; return true; },
          getString: () => JSON.stringify([{ kind: 'inbound', date: '2026-10-29', callId: 'A1', start: '10:00:00', agent: null, journey: JSON.stringify(CORPUS[0][0]) }]),
          close: () => {} }; }, close: () => {} }; }, close: () => {} };
  };
  const out = plain(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }));
  assert.equal(seen.length, 1, 'one query');
  assert.match(seen[0].sql, /FROM inbound_calls WHERE call_date BETWEEN \?::date AND \?::date AND COALESCE\(is_internal, false\) = false AND journey LIKE '%"transfer":true%' AND journey LIKE '%"missed":true%'/);
  assert.match(seen[0].sql, /UNION ALL SELECT 'outbound', call_date::text, call_id, call_start, agent_name, journey FROM outbound_calls/);
  assert.ok(!/caller_hash|callee_hash|dial_in/.test(seen[0].sql), 'no number or hash is selected');
  assert.deepEqual(seen[0].p, ['2026-10-01', '2026-10-30', '2026-10-01', '2026-10-30']);
  assert.deepEqual(metered, ['transfer-retries']);
  assert.equal(out.meta.available, true);
  assert.equal(out.cases.length, 1);
  assert.equal(out.cases[0].first.name, 'Rhea Power');
  dash.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.equal(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }).meta.available, false);
  delete dash.ctx.getDashboardNeonConn_;
  delete dash.ctx.neonNoteEgress_;
});
