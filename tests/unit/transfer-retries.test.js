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
  'Omar Power': ['Power'], 'Sub Rep': ['PowerSub'], 'Two Roster': ['Power', 'Sales'], 'Sam Seller': ['Sales'], 'Cleo Desk': ['CSR'] };
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
  // Two colleagues in the sender's OWN department: never a retry.
  [[ans('09:00:00', 'Daniel (Dishant) Sahani', 100), att('09:01:00', 'Camila (Cheshta) Bhutani', { secs: 2 }), att('09:01:30', 'Cleo Desk', { secs: 2 })], null],
  // ── P3 (owner 2026-11-13): answered, then redirected (indexes 12..17) ──
  // 12: the owner's example -- X answers and talks, the CSR then goes to Y, and Y takes the caller.
  [[q('10:00:00', 'A_Q_CSR'), ans('10:00:05', 'Daniel (Dishant) Sahani', 600), cons('10:02:00', 'Rhea Power'), cons('10:05:00', 'Omar Power'),
    ans('10:06:00', 'Omar Power', 240, { transfer: true, handover: true })], null],
  // 13: X answered, then Y did not pick up -- nobody in Power took it.
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 600), cons('10:02:00', 'Rhea Power'), att('10:05:00', 'Omar Power', { secs: 20 })], null],
  // 14: X answered, Y was consulted, and X took the call after all.
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 600), cons('10:02:00', 'Rhea Power'), cons('10:05:00', 'Omar Power'),
    ans('10:07:00', 'Rhea Power', 100, { transfer: true, handover: true })], null],
  // 15: a miss, then two consults -- a retry (Rhea -> Omar) AND a redirect (Omar -> Sub Rep).
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 600), att('10:02:00', 'Rhea Power', { secs: 3 }), cons('10:02:30', 'Omar Power'), cons('10:04:00', 'Sub Rep')], null],
  // 16: the same person consulted twice is no redirect.
  [[ans('10:00:05', 'Daniel (Dishant) Sahani', 600), cons('10:02:00', 'Rhea Power'), cons('10:05:00', 'Rhea Power')], null],
  // 17: an OUTBOUND call -- the dialling agent is the sender; there is no answer time.
  [[cons('11:00:00', 'Rhea Power'), cons('11:03:00', 'Omar Power'), ans('11:04:00', 'Omar Power', 90, { transfer: true, handover: true })], 'Camila (Cheshta) Bhutani'],
  // 18: Power took the caller EARLIER (a hand-over to Omar), the call came back to a CSR, who then
  // consulted two Power people and nobody took it -- the earlier hand-over is not about this consult.
  [[ans('09:00:00', 'Sam Seller', 100), ans('09:05:00', 'Omar Power', 60, { transfer: true, handover: true }),
    ans('09:10:00', 'Daniel (Dishant) Sahani', 300), cons('09:12:00', 'Rhea Power'), cons('09:15:00', 'Sub Rep')], null],
];

test('TR-1: PARITY -- the dashboard mirror reads every corpus journey exactly as cdr-import\'s tfRetriesOfJourney_', function () {
  const lk = imp.call('tfBounceLookups_', imp.call('tfRosterFromGrid_', ['CSR', 'Power', 'PowerSub', 'Sales'], [
    ['Daniel (Dishant) Sahani, 352', 'Rhea Power, 401', 'Sub Rep, 403', 'Sam Seller, 300'],
    ['Camila (Cheshta) Bhutani, 240', 'Omar Power, 402', '', 'Two Roster, 410'],
    ['Cleo Desk, 241', 'Two Roster, 410', '', ''],
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

test('TR-2: ring time decides before voicemail, in BOTH copies -- a quick send-to-voicemail is a decline', function () {
  const cases = [
    [{ consult: true, secs: 3 }, 'answered'],
    [{ secs: 3, voicemail: true }, 'quickDecline'],     // sent straight to voicemail: the TR-0 census's 20
    [{ secs: 8, voicemail: true }, 'quickDecline'],     // the line itself is a decline
    [{ secs: 9, voicemail: true }, 'voicemail'],
    [{ secs: 15, voicemail: true }, 'voicemail'],       // rang out to voicemail (~12-17 s timeout)
    [{ voicemail: true }, 'voicemail'],                 // untimed voicemail stays voicemail
    [{ secs: 2 }, 'quickDecline'],
    [{ secs: 20 }, 'rangOut'],
    [{}, 'unknown'],
  ];
  cases.forEach(function (c) {
    assert.equal(imp.ctx.tfRetryOutcome_(c[0]), c[1], 'cdr-import ' + JSON.stringify(c[0]));
    assert.equal(dash.ctx.trRetryOutcome_(c[0]), c[1], 'dashboard ' + JSON.stringify(c[0]));
  });
  assert.equal(imp.ctx.TF_RETRY_QUICK_SECS_, dash.ctx.TR_QUICK_SECS_, 'one decline line, two copies');
  // End to end on a journey, both copies: sent to voicemail within 2 s, then a colleague answers.
  const lk = imp.call('tfBounceLookups_', imp.call('tfRosterFromGrid_', ['CSR', 'Power'], [
    ['Daniel (Dishant) Sahani, 352', 'Rhea Power, 401'], ['', 'Omar Power, 402'],
  ]), [], null);
  const j = [ans('10:00:05', 'Daniel (Dishant) Sahani', 300), att('10:02:00', 'Rhea Power', { secs: 2, voicemail: true }),
    cons('10:02:30', 'Omar Power')];
  const a = plain(imp.call('tfRetriesOfJourney_', j, lk.deptsOfAgent, null));
  const d = plain(dash.call('trRetriesOfJourney_', j, dash.call('trDeptsOfAgentFn_', BY_AGENT, PARENT), null));
  assert.deepEqual(d, a, 'the two copies agree');
  assert.equal(a.cases.length, 1);
  assert.equal(a.cases[0].first.outcome, 'quickDecline');
  assert.equal(a.cases[0].second.outcome, 'answered');
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
  assert.equal(seen.length, 2, 'the journeys, then (P10) the direct-call records of the cases found');
  // P3: a missed ring (a retry) OR an answered consult (answered, then redirected).
  assert.match(seen[0].sql, /FROM inbound_calls WHERE call_date BETWEEN \?::date AND \?::date AND COALESCE\(is_internal, false\) = false AND journey LIKE '%"transfer":true%' AND \(journey LIKE '%"missed":true%' OR journey LIKE '%"consult":true%'\) UNION ALL/);
  assert.match(seen[0].sql, /FROM outbound_calls WHERE call_date BETWEEN \?::date AND \?::date AND journey LIKE '%"transfer":true%' AND \(journey LIKE '%"missed":true%' OR journey LIKE '%"consult":true%'\)\) t$/);
  assert.match(seen[0].sql, /UNION ALL SELECT 'outbound', call_date::text, call_id, call_start, agent_name, journey FROM outbound_calls/);
  assert.ok(!/caller_hash|callee_hash|dial_in/.test(seen[0].sql), 'no number or hash is selected');
  assert.deepEqual(seen[0].p, ['2026-10-01', '2026-10-30', '2026-10-01', '2026-10-30']);
  assert.deepEqual(metered, ['transfer-retries', 'transfer-retries']);
  assert.equal(out.meta.available, true);
  assert.equal(out.cases.length, 1);
  assert.equal(out.cases[0].first.name, 'Rhea Power');
  dash.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.equal(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }).meta.available, false);
  delete dash.ctx.getDashboardNeonConn_;
  delete dash.ctx.neonNoteEgress_;
});

// ── P10 (owner 2026-11-13): was the person tried first free? ─────────────────
// A person-transfer attempt is its own internal call, held in `direct_calls` as
// an inbound internal direct call to the person tried -- with missed_free /
// missed_busy and who the blocking call was with. The journey event carries no
// call id for it, so the two are matched on date + person + time (+ sender).
const dRow = (start, ring, outcome, other, busyWith) => ({ start, ring, outcome, other: other === undefined ? null : other, busyWith: busyWith || null });
const match = (rows, t, sender, slack) => plain(dash.call('trAvailMatch_', rows, t, sender, slack));

test('P10: an attempt matches the direct-call record whose ring holds its time -- free, or on a call and with whom', function () {
  assert.deepEqual(match([dRow('10:02:00', 3, 'missed_free', 'Dan')], '10:02:00', 'Dan'), { off: 0, bySender: true, state: 'free' });
  assert.deepEqual(match([dRow('10:02:00', 20, 'missed_busy', 'Dan', 'Kim Lee')], '10:02:00', 'Dan'),
    { off: 0, bySender: true, state: 'busy', with: 'Kim Lee' });
  // a second ring of the same call sits later inside the record's ring
  assert.equal(match([dRow('10:02:00', 25, 'missed_free', 'Dan')], '10:02:18', 'Dan').state, 'free');
  // three seconds either side of the ring is allowed, four is not
  assert.equal(match([dRow('10:02:03', 5, 'missed_free', 'Dan')], '10:02:00', 'Dan').state, 'free');
  assert.equal(match([dRow('10:02:04', 5, 'missed_free', 'Dan')], '10:02:00', 'Dan').state, 'noRow');
  assert.equal(match([dRow('10:02:00', 5, 'missed_free', 'Dan')], '10:02:08', 'Dan').state, 'free');
  assert.equal(match([dRow('10:02:00', 5, 'missed_free', 'Dan')], '10:02:09', 'Dan').state, 'noRow');
  // the probe's wide pass reaches further
  assert.equal(match([dRow('10:02:20', 5, 'missed_free', 'Dan')], '10:02:00', 'Dan', 30).state, 'free');
  assert.equal(match([], '10:02:00', 'Dan').state, 'noRow');
  assert.equal(match(null, '10:02:00', 'Dan').state, 'noRow');
  assert.equal(match([dRow('10:02:00', 3, 'missed_free', 'Dan')], '', 'Dan').state, 'noRow', 'an attempt with no time matches nothing');
});

test('P10: a record naming another caller is never ours; the sender\'s own beats an unnamed one; a tie is no guess', function () {
  // Someone else rang the same person in the same second: not this attempt.
  assert.equal(match([dRow('10:02:00', 3, 'missed_busy', 'Someone Else', 'Kim Lee')], '10:02:00', 'Dan').state, 'noRow');
  // Two records fit; the one naming the sender is the attempt.
  const two = [dRow('10:02:00', 3, 'missed_busy', null, 'Kim Lee'), dRow('10:02:01', 3, 'missed_free', 'Dan')];
  assert.deepEqual(match(two, '10:02:00', 'Dan'), { off: -1, bySender: true, state: 'free' });
  // A record with no caller name is accepted on time alone, and says so.
  assert.deepEqual(match([dRow('10:02:00', 3, 'missed_free', null)], '10:02:00', 'Dan'), { off: 0, bySender: false, state: 'free' });
  // Two equally close records: ambiguous, never a pick.
  assert.equal(match([dRow('10:02:01', 3, 'missed_free', 'Dan'), dRow('10:01:59', 3, 'missed_busy', 'Dan')], '10:02:00', 'Dan').state, 'ambiguous');
  // The closer of two wins when one is closer.
  assert.equal(match([dRow('10:02:02', 3, 'missed_free', 'Dan'), dRow('10:02:00', 3, 'missed_busy', 'Dan', 'a queue call')], '10:02:00', 'Dan').state, 'busy');
  // The record says ANSWERED (or nothing): the journey's missed ring denies it.
  assert.equal(match([dRow('10:02:00', 3, 'answered', 'Dan')], '10:02:00', 'Dan').state, 'conflict');
  assert.equal(match([dRow('10:02:00', 3, null, 'Dan')], '10:02:00', 'Dan').state, 'conflict');
});

const caseOf = (date, callId, sender, name, t) => ({ date, callId, senderName: sender, dept: 'Power', first: { name, t, secs: 3, outcome: 'quickDecline' } });

test('P10: every case gets its state; a date with no direct-call record is told apart from a ring not found', function () {
  const cases = [
    caseOf('2026-11-10', 'A1', 'Dan', 'Rhea Power', '10:02:00'),
    caseOf('2026-11-10', 'A2', 'Dan', 'Omar Power', '11:00:00'),
    caseOf('2026-11-11', 'A3', 'Dan', 'Rhea Power', '09:00:00'),
    caseOf('2026-11-01', 'A4', 'Dan', 'Rhea Power', '09:00:00'),
    caseOf('2026-11-10', 'A5', 'Dan', 'Rhea Power', '15:00:00'),
  ];
  const direct = { days: ['2026-11-10', '2026-11-11'], rows: [
    { date: '2026-11-10', agent: 'Rhea Power', start: '10:02:00', ring: 3, outcome: 'missed_free', other: 'Dan', busyWith: null },
    { date: '2026-11-10', agent: 'Omar Power', start: '11:00:01', ring: 20, outcome: 'missed_busy', other: null, busyWith: 'an outside caller' },
    { date: '2026-11-10', agent: 'Rhea Power', start: '15:00:00', ring: 4, outcome: 'answered', other: 'Dan', busyWith: null },
    // the same second, another person: never read for Rhea
    { date: '2026-11-11', agent: 'Omar Power', start: '09:00:00', ring: 3, outcome: 'missed_free', other: 'Dan', busyWith: null },
  ] };
  const t = plain(dash.call('trAttachAvailability_', cases, direct));
  const got = plain(cases).map((c) => c.first.avail);
  assert.deepEqual(got, [{ state: 'free' }, { state: 'busy', with: 'an outside caller' }, { state: 'noRow' }, { state: 'noDay' }, { state: 'conflict' }]);
  assert.deepEqual([t.attempts, t.known, t.free, t.busy, t.noDay, t.noRow, t.ambiguous, t.conflict], [5, 2, 1, 1, 1, 1, 0, 1]);
  assert.equal(t.bySender, 1, 'one match had the sender named on the record');
  assert.deepEqual(t.offsets, { exact: 1, near: 1, inRing: 0 });
  assert.deepEqual(t.samples.noRow, ['2026-11-11 A3 Rhea Power 09:00:00']);
  assert.deepEqual(t.samples.conflict, ['2026-11-10 A5 Rhea Power 15:00:00']);
  // No record at all (the read returned nothing): every case is a date with none.
  const bare = [caseOf('2026-11-10', 'A1', 'Dan', 'Rhea Power', '10:02:00')];
  assert.equal(plain(dash.call('trAttachAvailability_', bare, null)).noDay, 1);
});

test('P10: the ranking counts free and on-a-call apart, past the list cap; with no availability the payload is what it was', function () {
  const fn = dash.call('trDeptsOfAgentFn_', BY_AGENT, PARENT);
  const rows = [
    { kind: 'inbound', date: '2026-10-29', callId: 'A1', start: '10:00:00', agent: null, journey: JSON.stringify(CORPUS[0][0]) },
    { kind: 'outbound', date: '2026-10-30', callId: 'B1', start: '11:00:00', agent: 'Camila (Cheshta) Bhutani', journey: JSON.stringify(CORPUS[5][0]) },
  ];
  const direct = { days: ['2026-10-29', '2026-10-30'], rows: [
    { date: '2026-10-29', agent: 'Rhea Power', start: '10:02:00', ring: 3, outcome: 'missed_free', other: 'Daniel (Dishant) Sahani', busyWith: null },
    { date: '2026-10-30', agent: 'Rhea Power', start: '11:00:00', ring: 2, outcome: 'missed_busy', other: 'Camila (Cheshta) Bhutani', busyWith: 'Omar Power' },
  ] };
  let seenCases = 0;
  const withAv = plain(dash.call('trBuildFromRows_', rows, fn, '', { attach: function (cases) {
    seenCases = cases.length;
    return dash.call('trAttachAvailability_', cases, direct);
  } }));
  assert.equal(seenCases, 2, 'the attach step sees every case, before the tallies');
  assert.deepEqual(withAv.summary.callees[0], { name: 'Rhea Power', dept: 'Power', n: 2, quickDecline: 2, free: 1, busy: 1 });
  assert.deepEqual([withAv.summary.avail.known, withAv.summary.avail.free, withAv.summary.avail.busy], [2, 1, 1]);
  assert.deepEqual(withAv.cases.map((c) => c.first.avail), [{ state: 'busy', with: 'Omar Power' }, { state: 'free' }]);
  assert.ok(!JSON.stringify(withAv).match(/\d{10}/), 'no phone-number-shaped value in the payload');
  const bare = plain(dash.call('trBuildFromRows_', rows, fn, ''));
  assert.equal(bare.summary.avail, undefined);
  assert.equal(bare.cases[0].first.avail, undefined);
  assert.deepEqual(bare.summary.callees[0], { name: 'Rhea Power', dept: 'Power', n: 2, quickDecline: 2 });
});

// A fake connection answering the journeys read, then the direct-call read.
function trConn(journeyRows, direct, seen) {
  return { prepareStatement: function (sql) { const p = []; seen.push({ sql, p });
    return { setString: function (i, v) { p[i - 1] = v; },
      executeQuery: function () {
        if (/direct_calls/.test(sql) && direct === 'throw') throw new Error('relation "direct_calls" does not exist');
        let used = false;
        return { next: () => { if (used) return false; used = true; return true; },
          getString: () => JSON.stringify(/direct_calls/.test(sql) ? direct : journeyRows), close: () => {} }; },
      close: () => {} }; }, close: () => {} };
}
const TR_JROWS = [{ kind: 'inbound', date: '2026-10-29', callId: 'A1', start: '10:00:00', agent: null, journey: JSON.stringify(CORPUS[0][0]) }];

test('P10: the direct-call read asks only for the cases\' own (date, person) pairs, inbound internal, with no hash or number', function () {
  install('admin@x.com');
  const seen = [];
  dash.ctx.getDashboardNeonConn_ = function () {
    return trConn(TR_JROWS, { days: ['2026-10-29'], rows: [
      { date: '2026-10-29', agent: 'Rhea Power', start: '10:02:00', ring: 3, outcome: 'missed_busy', other: 'Daniel (Dishant) Sahani', busyWith: 'Omar Power' }] }, seen);
  };
  const out = plain(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }));
  delete dash.ctx.getDashboardNeonConn_;
  assert.equal(seen.length, 2);
  const q2 = seen[1];
  assert.match(q2.sql, /FROM direct_calls d JOIN \(SELECT DISTINCT \(x->>0\)::date AS dt, x->>1 AS ag FROM json_array_elements\(\?::json\) x\) p ON d\.call_date = p\.dt AND d\.agent_name = p\.ag WHERE d\.direction = 'in' AND d\.side = 'int'/);
  assert.match(q2.sql, /to_jsonb\(d\)->>'busy_with'/, 'a table without the busy_with column still answers');
  assert.match(q2.sql, /WHERE EXISTS \(SELECT 1 FROM direct_calls e WHERE e\.call_date = q\.dt\)/, 'which of the dates hold any record');
  assert.ok(!/other_hash|other_ext|dial_in|caller_hash/.test(q2.sql), 'employee names only: no hash, extension or dialled number');
  assert.ok(!/INSERT|UPDATE|DELETE|ALTER|CREATE/i.test(q2.sql), 'read-only');
  assert.deepEqual(q2.p, [JSON.stringify([['2026-10-29', 'Rhea Power']]), JSON.stringify([['2026-10-29', 'Rhea Power']])]);
  assert.deepEqual(out.cases[0].first.avail, { state: 'busy', with: 'Omar Power' });
  assert.equal(out.summary.avail.known, 1);
  assert.deepEqual(out.summary.callees[0], { name: 'Rhea Power', dept: 'Power', n: 1, quickDecline: 1, free: 0, busy: 1 });
});

test('P10: a failed direct-call read never costs the list; no retry means no second read', function () {
  install('admin@x.com');
  let seen = [];
  dash.ctx.getDashboardNeonConn_ = function () { return trConn(TR_JROWS, 'throw', seen); };
  const out = plain(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }));
  assert.equal(out.meta.available, true, 'the list still reads');
  assert.equal(out.cases.length, 1);
  assert.equal(out.cases[0].first.avail, undefined, 'no state is invented');
  assert.deepEqual(out.summary.avail, { unavailable: true, attempts: 1, known: 0 });
  // A reply of the wrong shape (an array, an empty string) reads as "no records".
  seen = [];
  dash.ctx.getDashboardNeonConn_ = function () { return trConn(TR_JROWS, [], seen); };
  const odd = plain(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }));
  assert.deepEqual(odd.cases[0].first.avail, { state: 'noDay' });
  // No case found: the direct-call table is never asked.
  seen = [];
  dash.ctx.getDashboardNeonConn_ = function () { return trConn([], { days: [], rows: [] }, seen); };
  const none = plain(dash.call('getTransferRetries', { from: '2026-10-01', to: '2026-10-30' }));
  delete dash.ctx.getDashboardNeonConn_;
  assert.equal(seen.length, 1);
  assert.equal(none.summary.avail, undefined);
});

test('P10: the read-only check is admin-only, reads the last 30 days and gives a verdict on the match rate', function () {
  install('manager@x.com');
  assert.throws(() => dash.call('probeTransferRetryAvailability'), /admin/i);
  install('admin@x.com');
  // 24 retried calls on one covered date; 22 have a direct-call record.
  const jrows = [], drows = [];
  for (let i = 0; i < 24; i++) {
    const mm = String(i).padStart(2, '0');
    jrows.push({ kind: 'inbound', date: '2026-11-10', callId: 'C' + i, start: '10:00:00', agent: null,
      journey: JSON.stringify([ans('10:00:05', 'Daniel (Dishant) Sahani', 300), att('10:' + mm + ':30', 'Rhea Power', { secs: 3 }), cons('10:' + mm + ':50', 'Omar Power')]) });
    if (i < 22) drows.push({ date: '2026-11-10', agent: 'Rhea Power', start: '10:' + mm + ':30', ring: 3,
      outcome: i % 2 ? 'missed_busy' : 'missed_free', other: 'Daniel (Dishant) Sahani', busyWith: i % 2 ? 'Omar Power' : null });
  }
  // One more record 20 s late: only the wide pass finds it.
  drows.push({ date: '2026-11-10', agent: 'Rhea Power', start: '10:22:50', ring: 3, outcome: 'missed_free', other: 'Daniel (Dishant) Sahani', busyWith: null });
  const seen = [];
  dash.ctx.getDashboardNeonConn_ = function () { return trConn(jrows, { days: ['2026-11-10'], rows: drows }, seen); };
  const out = plain(dash.call('probeTransferRetryAvailability'));
  assert.equal(out.verdict, 'GOOD');
  assert.equal(out.covered, 24);
  assert.equal(out.ratePct, 91.7);
  assert.deepEqual([out.tally.known, out.tally.free, out.tally.busy, out.tally.noRow], [22, 11, 11, 2]);
  assert.equal(out.wide.known, 23, 'the 30 s allowance finds one more');
  assert.equal(seen.length, 2, 'the journeys and the direct-call records, once each');
  seen.forEach((q) => assert.ok(!/INSERT|UPDATE|DELETE|ALTER|CREATE/i.test(q.sql), 'writes nothing'));
  const days = (iso) => Math.round((Date.parse(seen[0].p[1] + 'T00:00:00Z') - Date.parse(iso + 'T00:00:00Z')) / 86400000);
  assert.equal(days(seen[0].p[0]), 29, 'thirty days, ending yesterday');
  // Under 20 attempts on covered dates: no verdict either way.
  dash.ctx.getDashboardNeonConn_ = function () { return trConn(jrows.slice(0, 5), { days: ['2026-11-10'], rows: drows }, []); };
  assert.equal(dash.call('probeTransferRetryAvailability').verdict, 'INCONCLUSIVE');
  // Most not found: POOR. A date with no record at all is left out of the rate.
  dash.ctx.getDashboardNeonConn_ = function () { return trConn(jrows, { days: ['2026-11-10'], rows: drows.slice(0, 6) }, []); };
  assert.equal(dash.call('probeTransferRetryAvailability').verdict, 'POOR');
  dash.ctx.getDashboardNeonConn_ = function () { return trConn(jrows, { days: [], rows: [] }, []); };
  const uncovered = plain(dash.call('probeTransferRetryAvailability'));
  assert.equal(uncovered.verdict, 'INCONCLUSIVE');
  assert.equal(uncovered.tally.noDay, 24);
  dash.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.equal(dash.call('probeTransferRetryAvailability').verdict, 'FAILED');
  delete dash.ctx.getDashboardNeonConn_;
});

// ── P3 (owner 2026-11-13): answered, then redirected ─────────────────────────
// "A CSR calls the Power department, agent X answers and they discuss for some
// time, then on that same call the CSR has to call another Power agent Y, and Y
// takes the transfer." The first attempt was ANSWERED, so it is not a retry
// (`cases`); it is its own list (`redirects`) and no `cases` figure moves.
const dfnP3 = () => dash.call('trDeptsOfAgentFn_', BY_AGENT, PARENT);
const readJ = (i) => plain(dash.call('trRetriesOfJourney_', CORPUS[i][0], dfnP3(), CORPUS[i][1]));

test('P3: X answers and talks, the sender goes to Y in the same department, and Y takes the call', function () {
  const r = readJ(12);
  assert.equal(r.cases.length, 0, 'the first attempt was answered: not a retry');
  assert.equal(r.redirects.length, 1);
  const c = r.redirects[0];
  assert.deepEqual([c.senderName, c.senderDept, c.dept], ['Daniel (Dishant) Sahani', 'CSR', 'Power']);
  assert.deepEqual([c.senderAt, c.queue, c.beforeSecs], ['10:00:05', 'A_Q_CSR', 115], 'when the sender answered, the queue, and time on the call before the first try');
  assert.deepEqual(c.first, { name: 'Rhea Power', t: '10:02:00', talk: 40 });
  assert.equal(c.second.name, 'Omar Power');
  assert.equal(c.second.outcome, 'answered');
  assert.equal(c.second.talk, 40);
  assert.equal(c.gapSecs, 180);
  assert.equal(c.takenBy, 'Omar Power');
});

test('P3: who took the call -- nobody, the first person after all, or the second', function () {
  assert.equal(readJ(13).redirects[0].takenBy, null, 'Y did not pick up and no one in Power took the caller');
  assert.equal(readJ(13).redirects[0].second.outcome, 'rangOut');
  assert.equal(readJ(13).redirects[0].second.talk, null, 'a missed ring has no talk');
  assert.equal(readJ(14).redirects[0].takenBy, 'Rhea Power', 'X took it after all');
  assert.equal(readJ(16).redirects.length, 0, 'the same person twice is no redirect');
  // A hand-over BEFORE the consult is not about it: Power took the caller earlier, the call came
  // back to a CSR, and nobody in Power took it after the two consults.
  assert.equal(readJ(18).redirects.length, 1);
  assert.deepEqual([readJ(18).redirects[0].first.name, readJ(18).redirects[0].second.name], ['Rhea Power', 'Sub Rep']);
  assert.equal(readJ(18).redirects[0].takenBy, null);
});

test('P3: a retry and a redirect can sit on one call, and the retry is read exactly as before', function () {
  const r = readJ(15);
  assert.equal(r.cases.length, 1);
  assert.deepEqual([r.cases[0].first.name, r.cases[0].first.outcome, r.cases[0].second.name], ['Rhea Power', 'quickDecline', 'Omar Power']);
  assert.deepEqual([r.cases[0].senderAt, r.cases[0].beforeSecs], ['10:00:05', 115], 'the retry rows gain the sender detail too');
  assert.equal(r.redirects.length, 1);
  assert.deepEqual([r.redirects[0].first.name, r.redirects[0].second.name], ['Omar Power', 'Sub Rep'], 'a sub-queue is the same department');
  // The original corpus (0..11) holds one two-consult call (#4): no retry there, then or now.
  assert.equal(readJ(4).cases.length, 0);
  assert.equal(readJ(4).redirects.length, 1);
});

test('P3: an outbound call names the dialling agent, with no answer time', function () {
  const c = readJ(17).redirects[0];
  assert.deepEqual([c.senderName, c.senderAt, c.beforeSecs, c.queue], ['Camila (Cheshta) Bhutani', null, null, null]);
  assert.equal(c.takenBy, 'Omar Power');
});

test('P3: the payload carries the redirects apart from the cases, with who answered first most often', function () {
  const rows = [12, 13, 14, 15, 0].map(function (i, n) {
    return { kind: 'inbound', date: '2026-11-0' + (n + 1), callId: 'R' + i, start: '10:00:00', agent: null, journey: JSON.stringify(CORPUS[i][0]) };
  });
  const all = plain(dash.call('trBuildFromRows_', rows, dfnP3(), ''));
  assert.deepEqual(all.redirects.map((c) => c.callId), ['R15', 'R14', 'R13', 'R12'], 'newest first');
  assert.equal(all.summary.redirects, 4);
  assert.equal(all.summary.redirectsTaken, 1, 'only R12 ended with someone ELSE in the department taking the call');
  assert.deepEqual(all.summary.redirectFirsts[0], { name: 'Rhea Power', dept: 'Power', n: 3, talkSecs: 120, tookByOther: 1 });
  assert.equal(all.redirectsTruncated, false);
  // The retry figures are what they were: two calls here carry a retry (R15, R0).
  assert.equal(all.summary.cases, 2);
  assert.deepEqual(all.cases.map((c) => c.callId), ['R0', 'R15'], 'newest first');
  assert.deepEqual(all.summary.byOutcome, { quickDecline: 2 });
  assert.equal(plain(dash.call('trBuildFromRows_', rows, dfnP3(), 'Sales')).redirects.length, 0, 'the department filter applies to both lists');
  assert.ok(!JSON.stringify(all).match(/\d{10}/), 'no phone-number-shaped value in the payload');
});

test('P3: the cdr-import diagnostic counts the redirects apart from its retry figures', function () {
  const lk = imp.call('tfBounceLookups_', imp.call('tfRosterFromGrid_', ['CSR', 'Power'], [
    ['Daniel (Dishant) Sahani, 352', 'Rhea Power, 401'], ['', 'Omar Power, 402'],
  ]), [], null);
  let st = {};
  [12, 13, 0].forEach(function (i) {
    st = imp.call('tfRetryFold_', st, imp.call('tfRetriesOfJourney_', CORPUS[i][0], lk.deptsOfAgent, null), 'C' + i, 'inbound', {});
  });
  st = plain(st);
  assert.equal(st.cases, 1, 'the one retry');
  assert.equal(st.redirects, 2);
  assert.deepEqual(st.redirectFirst, { 'Rhea Power (Power)': 2 });
  assert.deepEqual(st.redirectTook, { 'the second person took it': 1, 'nobody in that department took the call': 1 });
  assert.match(st.redirectSamples[0], /^C12 \(inbound\) Daniel \(Dishant\) Sahani \(CSR\) -> Rhea Power: answered, talked 40s; 180s later -> Omar Power: .*; Omar Power took the call$/);
  assert.match(imp.call('tfRetryLine_', st), /RETRIED in the same department 1 .*; ANSWERED then redirected in the same department 2$/);
});

// Owner 2026-11-13: the modal printed stored (Pacific) times while every other
// surface shows Central. Every time it prints now goes through trWhen_, which
// is the journey drill's own shift -- a second conversion would drift from it.
test('Transfer retries prints its times in Central, through the journey drill\'s shift', function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-7-admin.html'), 'utf8');
  assert.match(src, /function trWhen_\(hms\) \{ return hms \? clCstTime_\(hms\) : ''; \}/, 'trWhen_ is the journey drill shift');
  const from = src.indexOf('function trSenderHtml_');
  const to = src.indexOf("$('tr-rnote')");
  assert.ok(from > 0 && to > from, 'the render block is where it was');
  const block = src.slice(from, to);
  // Every line that reads a stored clock time (.t, .senderAt, .start) wraps it.
  const lines = block.split('\n').filter(function (l) { return /c\.senderAt|c\.(?:first|second)\.t\b|c\.start\b/.test(l); });
  assert.equal(lines.length, 3, 'the three time prints (who answered, and each list\'s When cell)');
  lines.forEach(function (l) { assert.match(l, /trWhen_\(c\.(?:senderAt|first\.t \|\| c\.start)\)/, 'a stored time printed without the Central shift: ' + l.trim()); });
});
