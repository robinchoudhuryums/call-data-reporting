'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// S2C-2 (owner rulings 2026-09-28): a caller who hung up during a transfer
// the target dept never answered counts for that TARGET dept in the Inbound
// report's "Abandoned on hold" tile -- whether they were ON HOLD (a warm
// transfer) or sent straight into the target queue (a BLIND transfer, "user
// error, but it happens").
// Pins:
//   (1) total / answered never move; the tile is raw - out + in, in the
//       company view too (there `in` is the target-queue ones, `out` is 0);
//   (2) the SQL rule: driven from the internal records, joined back by PK,
//       exactly ONE unanswered inbound-kind link, qualifying on hold OR an
//       abandoned transfer; out = on hold + in scope + target outside the
//       dept's queues, in = target inside and not already counted here;
//   (3) the sample tool's pure tally applies the SAME rule and names the
//       not-counted neighbours.
// The SQL itself was executed against Postgres 16 on a fixture before it
// shipped (fix-history S2C-2); these pins keep its shape from drifting.

const h = loadGas({ files: ['Config.gs', 'InboundReport.gs'] });

function fakeConn(payload) {
  const cap = { sqls: [] };
  return {
    cap: cap,
    conn: {
      createStatement: function () {
        return {
          executeQuery: function (sql) {
            cap.sqls.push(sql);
            if (/information_schema/.test(sql)) return { next: function () { return false; }, close: function () {} };
            let done = false;
            return { next: function () { if (done) return false; done = true; return true; },
                     getString: function () { return JSON.stringify(payload); }, close: function () {} };
          },
          close: function () {},
        };
      },
      close: function () {},
    },
  };
}
function install(payload) {
  h.ctx.computePriorWindow_ = function () { return { from: '2026-06-01', to: '2026-06-08' }; };
  h.ctx.inboundDialInLabels_ = function () { return {}; };
  h.ctx.getAllFinalDeptLabels_ = function () { return ['customer success', 'inside sales']; };
  h.ctx.getFinalDeptLabels_ = function (d) { return d === 'CSR' ? ['customer success'] : ['inside sales']; };
  h.ctx.getOverviewParentMap_ = function () { return {}; };
  const f = fakeConn(payload);
  h.ctx.getDashboardNeonConn_ = function () { return f.conn; };
  return f;
}
const PAYLOAD = {
  kpis: { total: 40, answered: 30, abandoned: 5, abandonedOnHold: 6 },
  kpisPrior: { total: 38, answered: 29, abandonedOnHold: 4 },
  xfer: { out: 2, in: 3 }, xferPrior: { out: 1, in: 0 },
  xferUn: { n: 7, linked: 4 }, xferUnPrior: { n: 5, linked: 1 },
  byInsurer: [], byDialIn: [], byQueue: [], byDialInInsurer: [], daily: [], outsideWindow: {},
};
const DEPT = { from: '2026-06-09', to: '2026-06-16', dept: 'CSR', companyView: false, deptQueues: ['A_Q_CSR'] };

test('S2C-2: a dept view moves on-hold transfer abandons -- and ONLY that tile', function () {
  install(PAYLOAD);
  const r = JSON.parse(JSON.stringify(h.call('computeInboundReport_', DEPT)));
  assert.equal(r.kpis.abandonedOnHold, 6 - 2 + 3);
  assert.equal(r.kpis.onHoldTransferOut, 2);
  assert.equal(r.kpis.onHoldTransferIn, 3);
  assert.equal(r.kpis.total, 40, 'the answering dept keeps the call');
  assert.equal(r.kpis.answered, 30, 'its agent did answer it');
  assert.equal(r.kpisPrior.abandonedOnHold, 4 - 1 + 0, 'the delta chip compares like with like');
});

test('S2C-2: the company view adds the TARGET-QUEUE transfer abandons (an on-hold move nets to zero)', function () {
  const f = install(Object.assign({}, PAYLOAD, { xfer: { out: 0, in: 2 }, xferPrior: { out: 0, in: 1 } }));
  const r = JSON.parse(JSON.stringify(h.call('computeInboundReport_',
    { from: '2026-06-09', to: '2026-06-16', dept: '', companyView: true, deptQueues: [] })));
  assert.equal(r.kpis.abandonedOnHold, 6 + 2);
  assert.equal(r.kpis.onHoldTransferIn, 2);
  assert.equal(r.kpis.total, 40);
  assert.equal(r.kpisPrior.abandonedOnHold, 4 + 1);
  const sql = f.cap.sqls.join('\n');
  assert.match(sql, /'xfer', \(SELECT json_build_object\('out', 0, 'in', count\(\*\) FILTER \(WHERE NOT s\.oh AND s\.xab AND s\.hung\)\)/,
    'company-wide only the target-queue ones are new');
});

test('S2C-2 SQL: driven from the internal records; unique unanswered link; on hold OR an abandoned transfer', function () {
  const f = install(PAYLOAD);
  h.call('computeInboundReport_', DEPT);
  const sql = f.cap.sqls.join('\n');
  assert.match(sql, /'xfer', \(SELECT json_build_object\('out'/);
  assert.match(sql, /'xferPrior', /);
  assert.match(sql, /FROM inbound_calls x JOIN inbound_calls c ON c\.call_date = x\.call_date AND c\.call_id = x\.related_call_id/,
    'a PK join from the few internal rows, never a per-answered-row correlated scan');
  assert.match(sql, /GROUP BY c\.call_date, c\.call_id HAVING count\(\*\) = 1/, 'UNIQUE unanswered link only');
  assert.match(sql, /COALESCE\(x\.related_call_kind, 'inbound'\) = 'inbound'/, 'an OUTBOUND link is not a transfer of this caller');
  assert.match(sql, /x\.disposition <> 'answered'/, 'the target never picked up');
  assert.match(sql, /bool_or\(x\.disposition = 'abandoned'\) AS xab/, 'the target-queue shape: the transfer itself abandoned');
  assert.match(sql, /c\.disposition = 'answered' AND COALESCE\(c\.is_internal, FALSE\) = FALSE/);
  assert.match(sql, /'out', count\(\*\) FILTER \(WHERE s\.oh AND s\.hung AND s\.ind AND s\.xt NOT IN \('a_q_csr'\)\)/,
    'out: only an ON-HOLD abandon this dept answered was ever counted here');
  assert.match(sql, /'in', count\(\*\) FILTER \(WHERE \(s\.oh OR s\.xab\) AND s\.hung AND s\.xt IN \('a_q_csr'\) AND NOT \(s\.oh AND s\.ind\)\)/,
    'in: any transfer abandon into our queues not already counted here');
  // The CALLER must have hung up: their call ended by the time the transfer
  // attempt did (an agent abandoning a consult and going back is not one).
  assert.match(sql, /AS hung/);
  assert.ok(sql.indexOf(h.call('inboundJourneyEndSql_', 'c.journey') + ' <= '
    + h.call('inboundJourneyEndSql_', 'x.journey') + ' + 30') !== -1, 'caller end <= transfer end + 30s');
});

test('S2C-2: a journey\'s end is max(t + secs) over its OWN events (the synthetic transfer ones excluded)', function () {
  const j = JSON.stringify([{ t: '10:00:00', secs: 30 }, { t: '10:01:00', secs: 600 },
                            { t: '11:00:00', secs: 5, transfer: true }, { t: 'bad', secs: 9 }]);
  assert.equal(h.call('xferJourneyEndSec_', j), 10 * 3600 + 11 * 60);
  assert.equal(h.call('xferJourneyEndSec_', null), null, 'no journey -> unknown -> not counted');
  assert.equal(h.call('xferJourneyEndSec_', '[]'), null);
});

// The caller's call and the transfer attempt, as journeys: caller off at
// `callerOff`, transfer attempt 10:02:00 for `xferSecs` seconds.
function cj(callerOff) { return JSON.stringify([{ t: '10:00:00', secs: callerOff }]); }
function xj(xferSecs) { return JSON.stringify([{ t: '10:02:00', secs: xferSecs }]); }

test('S2C-2 sample tool: the same rule, both shapes, and every not-counted neighbour is named', function () {
  const labelsOf = function (d) { return d === 'CSR' ? ['customer success'] : ['inside sales']; };
  const map = { pairs: [{ queue: 'a_q_csr', dept: 'CSR' }, { queue: 'a_q_sales', dept: 'Sales' }] };
  const rows = [
    { d: '2026-06-09', s: '09:00:00', id: 'c1', fd: 'Customer Success', oh: true, hold: 40, cj: cj(150),
      l: [{ id: 'x1', q: 'a_q_sales', disp: 'missed', j: xj(120) }] },                                    // on hold -> Sales
    { d: '2026-06-09', id: 'c2', fd: 'Customer Success', oh: true, cj: cj(150),
      l: [{ id: 'x2', q: 'a_q_sales', disp: 'answered', j: xj(120) }] },                                  // target answered
    { d: '2026-06-09', id: 'c3', fd: 'Customer Success', oh: true, cj: cj(150),
      l: [{ id: 'x3', q: 'a_q_sales', disp: 'abandoned', j: xj(120) }, { id: 'x4', q: 'a_q_sales', disp: 'missed', j: xj(120) }] }, // ambiguous
    { d: '2026-06-09', id: 'c4', fd: 'Customer Success', oh: true, cj: cj(150),
      l: [{ id: 'x5', q: 'a_q_csr', disp: 'abandoned', j: xj(120) }] },                                   // on hold, own dept
    { d: '2026-06-09', id: 'c5', fd: 'Customer Success', oh: false, cj: cj(150),
      l: [{ id: 'x6', q: 'a_q_sales', disp: 'abandoned', j: xj(120) }] },                                 // in target queue -> Sales
    { d: '2026-06-09', id: 'c6', fd: 'Customer Success', oh: false, cj: cj(150),
      l: [{ id: 'x7', q: 'a_q_sales', disp: 'missed', j: xj(120) }] },                                    // not an abandon
    { d: '2026-06-09', id: 'c7', fd: 'Customer Success', oh: false, cj: cj(150),
      l: [{ id: 'x8', q: 'a_q_csr', disp: 'abandoned', j: xj(120) }] },                                   // in target queue, own dept: still NEW
    { d: '2026-06-09', id: 'c8', fd: 'Customer Success', oh: false, cj: cj(900),
      l: [{ id: 'x9', q: 'a_q_sales', disp: 'abandoned', j: xj(120) }] },                   // agent gave up; caller stayed
  ];
  const t = JSON.parse(JSON.stringify(h.call('xferSampleTally_', rows, map, labelsOf)));
  assert.deepEqual(t.moved.map(function (m) { return [m.callId, m.shape, m.targetDepts]; }),
    [['c1', 'on hold', ['Sales']], ['c5', 'in target queue', ['Sales']], ['c7', 'in target queue', ['CSR']]]);
  assert.deepEqual([t.targetAnswered, t.ambiguous, t.sameDept, t.notAbandoned, t.callerStayed], [1, 1, 1, 1, 1]);
  assert.deepEqual(t.stayed.map(function (m) { return [m.callId, m.callerEndSec, m.xferEndSec]; }),
    [['c8', 10 * 3600 + 900, 10 * 3600 + 120 + 120]],
    'caller off 10:15:00, transfer attempt over at 10:04:00 -- the caller was still with us');
  assert.equal(t.byRoute['in target queue: Customer Success -> a_q_sales (Sales)'], 1);
  assert.ok(!/hash|caller_number/i.test(JSON.stringify(t)), 'ids, times, queues and labels only');
});

// ---------------------------------------------------------------------------
// S2C-6 (owner ruling 2026-09-28): "Transfers not answered" -- a SEPARATE tile
// counting, the way QCD does, every internal call into the dept's queues that
// was abandoned after MORE than 60 s in the queue, linked to a customer call
// or not. "Abandoned on hold" is untouched by it.

test('S2C-6: the tally lands in its OWN fields and moves nothing else', function () {
  install(PAYLOAD);
  const r = JSON.parse(JSON.stringify(h.call('computeInboundReport_', DEPT)));
  assert.equal(r.kpis.xferUnanswered, 7);
  assert.equal(r.kpis.xferUnansweredLinked, 4);
  assert.equal(r.kpisPrior.xferUnanswered, 5, 'the delta chip has a prior side');
  assert.equal(r.kpis.abandonedOnHold, 6 - 2 + 3, 'Abandoned on hold keeps the v14 rule');
  assert.equal(r.kpis.abandoned, 5);
  assert.equal(r.kpis.total, 40, 'internal calls never enter the inbound total');
});

test('S2C-6 SQL: internal, abandoned, > 60 s of own queue time, linked or not; dept = entry queue', function () {
  const f = install(PAYLOAD);
  h.call('computeInboundReport_', DEPT);
  const sql = f.cap.sqls.join('\n');
  const i = sql.indexOf("'xferUn', ");
  assert.ok(i !== -1 && sql.indexOf("'xferUnPrior', ") !== -1);
  const body = sql.slice(i, sql.indexOf("'xferUnPrior', "));
  assert.match(body, /count\(\*\) FILTER \(WHERE c\.related_call_id IS NOT NULL\)/);
  assert.match(body, /AND COALESCE\(c\.is_internal, false\) AND c\.disposition = 'abandoned'/,
    'QCD has no missed state: only abandoned attempts count');
  assert.ok(!/related_call_id =|JOIN/.test(body), 'UNLINKED attempts count too -- no join to a customer call');
  assert.match(body, /lower\(trim\(c\.entry_queue\)\) IN \('a_q_csr'\)/);
  assert.ok(body.indexOf('COALESCE(' + h.call('inboundQueueWaitSql_', 'c.journey') + ', c.wait_seconds, 0) > 60') !== -1,
    'QCD\'s strict waitDec > time1Min, on the attempt\'s own queue time');
  assert.ok(body.indexOf(h.call('inboundWindowClause_', true)) !== -1, 'work-window scoped');
});

test('S2C-6 SQL: the company view counts every queue', function () {
  const f = install(PAYLOAD);
  h.call('computeInboundReport_', { from: '2026-06-09', to: '2026-06-16', dept: '', companyView: true, deptQueues: [] });
  const sql = f.cap.sqls.join('\n');
  const body = sql.slice(sql.indexOf("'xferUn', "), sql.indexOf("'xferUnPrior', "));
  assert.ok(!/entry_queue\)\) IN/.test(body), "no queue filter company-wide");
});

test('S2C-6: queue wait = max own queue-leg secs (synthetic transfer events excluded)', function () {
  const j = JSON.stringify([{ t: '10:00:00', kind: 'queue', secs: 400, transfer: true, origin: true },
                            { t: '10:00:30', kind: 'queue', secs: 95 }, { t: '10:00:40', kind: 'leg', secs: 300 },
                            { t: '10:02:00', kind: 'queue', secs: 'x' }]);
  assert.equal(h.call('xferQueueWaitSec_', j), 95);
  assert.equal(h.call('xferQueueWaitSec_', '[]'), null);
  assert.equal(h.call('xferQueueWaitSec_', 'nope'), null);
});

test('S2C-6 sample tool: same threshold and wait rule; names what it did not count', function () {
  const q = function (secs) { return JSON.stringify([{ t: '10:00:00', kind: 'queue', secs: secs }]); };
  const map = { pairs: [{ queue: 'a_q_service', dept: 'Service' }] };
  const rows = [
    { d: '2026-06-09', s: '10:00:00', id: 'u1', q: 'a_q_service', disp: 'abandoned', linked: true, ws: 5, j: q(125) },
    { d: '2026-06-09', id: 'u2', q: 'a_q_service', disp: 'abandoned', linked: false, ws: 500, j: q(61) },
    { d: '2026-06-09', id: 'u3', q: 'a_q_service', disp: 'abandoned', linked: false, ws: 500, j: q(60) },   // exactly 60: QCD's > is strict
    { d: '2026-06-09', id: 'u4', q: 'a_q_other', disp: 'abandoned', linked: false, ws: 90, j: '[]' },       // no queue leg -> wait_seconds
    { d: '2026-06-09', id: 'u5', q: 'a_q_service', disp: 'missed', linked: true, ws: 300, j: q(300) },
    { d: '2026-06-09', id: 'u6', q: 'a_q_service', disp: 'abandoned', linked: false, ws: null, j: '[]' },
  ];
  const t = JSON.parse(JSON.stringify(h.call('xferUnansweredTally_', rows, map)));
  assert.deepEqual(t.counted.map(function (m) { return [m.callId, m.waitSec, m.linked]; }),
    [['u1', 125, true], ['u2', 61, false], ['u4', 90, false]]);
  assert.deepEqual([t.linked, t.underThreshold, t.missed, t.noWait], [1, 1, 1, 1]);
  assert.equal(t.byQueue['a_q_service (Service)'], 2);
  assert.equal(t.byQueue['a_q_other (NO DEPT)'], 1);
});
