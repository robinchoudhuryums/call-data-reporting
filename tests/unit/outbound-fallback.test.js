'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Outbound report NEON-DOWN SHEET FALLBACK.
//
// `outbound_calls` had no sheet primary, so a Neon outage took the Outbound
// report, the call-path drill's outbound arm and Caller Lookup's outbound
// section fully dark. cdr-report/outboundCallsExport.js now mirrors the table
// into an "Outbound Calls" tab; this suite pins the dashboard side:
//   (1) SOURCE PARITY, the headline -- ONE fixture served through the Neon
//       path (as the SQL's json blob) and through the sheet fallback produces
//       the SAME payload modulo the disclosure fields. Both routes share the
//       pure outboundShapeReport_ AND (CE-1) the one episode engine, so this
//       pins the SHEET-side mirror of every SQL clause that builds the event
//       rows: the abandon population (disposition + work window + is_internal
//       exclusion + dept attribution), the window split, the integer caller
//       keys, the dial / answered-call spans, and the per-agent aggregation.
//   (2) fallback payloads are NEVER cached; healthy payloads still cache.
//   (3) all three failure branches (conn null / null result / query throw)
//       reach the fallback; missing tabs keep available=false.
//   (4) anonymous abandons are excluded from the tracked denominator, never
//       counted as "not called back" (the contract rule).

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs',
          'InboundReport.gs', 'OutboundReport.gs'],
});

const FROM = '2026-08-10', TO = '2026-08-11';
const PW = { from: '2026-08-06', to: '2026-08-07' };

// ── One fixture, two shapes ────────────────────────────────────────────────
// Outbound rows: [date, callId, calleeHash, agent, ext, dept, connected,
//                 talkSec, ringSec, attempts, callStart, journey]
const OB_ROWS = [
  ['2026-08-10', 'o1', 'hashA', 'Ann', '101', 'Customer Success', 'TRUE', 60, 5, 1, '09:00:00', ''],
  ['2026-08-10', 'o2', 'hashB', 'Ann', '101', 'Customer Success', 'FALSE', 0, 9, 2, '10:00:00', ''],
  ['2026-08-11', 'o3', 'hashA', 'Bob', '102', 'Customer Success', 'TRUE', 30, 4, 1, '08:30:00', ''],
  // Prior-window activity (feeds agentsPrior only).
  ['2026-08-06', 'o0', 'hashZ', 'Ann', '101', 'Customer Success', 'TRUE', 15, 2, 1, '09:15:00', ''],
];
// Inbound rows: the Inbound Calls tab's 17 cols. Index map used below:
// 0 date, 3 callerHash, 5 disposition, 7 abandonedOnHold, 10 entryQueue,
// 12 finalDept, 15 callStart, 16 isInternal.
let ibSeq = 0;
function ibRow(date, hash, disposition, entryQueue, callStart, opts) {
  opts = opts || {};
  const r = new Array(17).fill('');
  r[0] = date; r[1] = opts.id || ('ib' + (++ibSeq)); r[3] = hash; r[5] = disposition;
  r[6] = disposition === 'abandoned' ? (opts.stage || (entryQueue ? 'queue' : 'ivr')) : '';
  r[7] = opts.onHold ? 'TRUE' : 'FALSE';
  r[10] = entryQueue; r[12] = opts.finalDept || ''; r[15] = callStart;
  r[16] = opts.internal ? 'TRUE' : 'FALSE';
  return r;
}
const IB_ROWS = [
  // Called back by o1 (same hash, same day, later): counts + connected.
  ibRow('2026-08-10', 'hashA', 'abandoned', 'A_Q_CSR', '08:00:00'),
  // Tracked, never called back (no outbound to hashC).
  ibRow('2026-08-10', 'hashC', 'abandoned', 'A_Q_CSR', '08:05:00'),
  // Anonymous abandon: counted in the total, EXCLUDED from tracked.
  ibRow('2026-08-11', '', 'abandoned', 'A_Q_CSR', '08:10:00'),
  // Excluded: answered (not an abandon).
  ibRow('2026-08-10', 'hashB', 'answered', 'A_Q_CSR', '09:30:00'),
  // Excluded: internal-origin row.
  ibRow('2026-08-10', 'hashB', 'abandoned', 'A_Q_CSR', '08:20:00', { internal: true }),
  // Excluded: outside the 06:30-15:00 PST work window.
  ibRow('2026-08-10', 'hashB', 'abandoned', 'A_Q_CSR', '18:00:00'),
  // Excluded from the CSR dept view: another dept's entry queue.
  ibRow('2026-08-10', 'hashB', 'abandoned', 'A_Q_Sales', '08:25:00'),
  // Prior window, tracked + called back by o0.
  ibRow('2026-08-06', 'hashZ', 'abandoned', 'A_Q_CSR', '09:00:00'),
  // CE-1: hashC tries again the next day -> joins hashC's open episode.
  ibRow('2026-08-11', 'hashC', 'abandoned', 'A_Q_CSR', '08:15:00'),
  // CE-1: hashD abandons, then gets through on the same queue -> "got through".
  ibRow('2026-08-10', 'hashD', 'abandoned', 'A_Q_CSR', '08:40:00'),
  ibRow('2026-08-10', 'hashD', 'answered', 'A_Q_CSR', '09:05:00'),
  // CE-1: a phone-menu hang-up (no queue) -- counted, never an episode.
  ibRow('2026-08-10', 'hashM', 'abandoned', '', '08:45:00'),
];

/** The blob shape computeOutboundReport_'s SQL returns, from the same rows. */
function neonBlobFromFixture(dept) {
  const inWin = function (r) {
    const cs = r[15];
    return !cs || (cs >= '06:30:00' && cs < '15:00:00');
  };
  const inDept = function (r) {
    if (!dept) return true;
    return String(r[10]).trim().toLowerCase() === 'a_q_csr';
  };
  const agentsFor = (f, t) => {
    const by = {};
    OB_ROWS.filter((r) => r[0] >= f && r[0] <= t).forEach((r) => {
      const a = by[r[3]] || (by[r[3]] = { agent: r[3], ob_total: 0, ob_connected: 0,
        ob_talk_sec: 0, attempts: 0, ob_unconn_brief: 0, ob_unconn_real: 0, ob_days: 0, _d: {} });
      a.ob_total++;
      if (!a._d[r[0]]) { a._d[r[0]] = true; a.ob_days++; }   // count(DISTINCT call_date)
      if (r[6] === 'TRUE') a.ob_connected++;
      // (4) the ring split, as the SQL FILTERs would compute it. Only a
      // PRESENT ring classifies; blank stays unknown.
      else if (r[8] !== '' && r[8] != null) {
        if (Number(r[8]) < 8) a.ob_unconn_brief++; else a.ob_unconn_real++;
      }
      a.ob_talk_sec += r[7]; a.attempts += r[9];
    });
    return Object.keys(by).map((k) => { delete by[k]._d; return by[k]; })
      .sort((x, y) => (y.ob_total - x.ob_total) || (x.agent < y.agent ? -1 : 1));
  };
  // CE-1: the EVENT rows obCallbackEventsSql_ returns, hand-derived from the
  // fixture with the SQL's own clauses (independently of the sheet adapter).
  const rangeFrom = PW.from, endIso = '2026-08-14';   // TO + OUTBOUND_CALLBACK_WINDOW_DAYS
  const winOf = (d) => (d >= FROM ? 'cur' : (d <= PW.to ? 'pri' : 'gap'));
  const abs = IB_ROWS.filter((r) => r[0] >= rangeFrom && r[0] <= TO && r[5] === 'abandoned'
    && r[16] !== 'TRUE' && inWin(r) && inDept(r));
  const counts = {};
  abs.forEach((r) => {
    const q = String(r[10]).trim().toLowerCase();
    const kind = q ? 'queue' : (r[6] === 'direct' ? 'direct' : 'menu');
    const key = [winOf(r[0]), kind, !r[3], q].join('|');
    const c = counts[key] || (counts[key] = { w: winOf(r[0]), kind: kind, anon: !r[3], q: q, n: 0 });
    c.n++;
  });
  const tracked = abs.filter((r) => r[3] && String(r[10]).trim() && winOf(r[0]) !== 'gap');
  const hashes = Array.from(new Set(tracked.map((r) => r[3]))).sort();   // dense_rank() OVER (ORDER BY h)
  const k = {}; hashes.forEach((x, i) => { k[x] = i + 1; });
  const byKey = (a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    || (String(a[2]) < String(b[2]) ? -1 : String(a[2]) > String(b[2]) ? 1 : 0);
  return {
    agents: agentsFor(FROM, TO),
    cbCounts: Object.keys(counts).map((x) => counts[x]),
    cbAb: tracked.map((r) => [k[r[3]], r[0], r[15] || null, String(r[10]).trim().toLowerCase(), r[1]]).sort(byKey),
    cbOb: OB_ROWS.filter((o) => k[o[2]] && o[0] >= rangeFrom && o[0] <= endIso)
      .map((o) => [k[o[2]], o[0], o[10] || null, o[1], o[3], o[6] === 'TRUE']).sort(byKey),
    cbAns: IB_ROWS.filter((r) => k[r[3]] && r[5] === 'answered' && r[16] !== 'TRUE'
        && String(r[10]).trim() && r[0] >= rangeFrom && r[0] <= endIso)
      .map((r) => [k[r[3]], r[0], r[15] || null, String(r[10]).trim().toLowerCase()]).sort(byKey),
    agentsPrior: agentsFor(PW.from, PW.to),
    coverageStart: OB_ROWS.map((r) => r[0]).sort()[0],
  };
}

function fakeTab(rows, width) {
  return {
    getLastRow: function () { return rows.length + 1; },
    getMaxColumns: function () { return width; },
    getLastColumn: function () { return width; },
    getRange: function (row, col, numRows, numCols) {
      return {
        getDisplayValues: function () {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const src = rows[row - 2 + i] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v == null ? '' : String(v));
            }
            out.push(line);
          }
          return out;
        },
      };
    },
  };
}

function install(opts) {
  opts = opts || {};
  h.state.cache.clear();
  h.state.props = { ADMIN_EMAILS: 'x@x.com', SPREADSHEET_ID: 'fake' };
  h.state.userEmail = 'x@x.com';
  h.ctx.resolveUser_ = function () { return { role: 'admin', department: null, email: 'x@x.com' }; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.reportFreshnessTag_ = function () { return 'tag'; };
  h.ctx.logReportUsage_ = function () {};
  h.ctx.computePriorWindow_ = function () { return { from: PW.from, to: PW.to }; };
  h.ctx.inboundQueuesForDept_ = function (d) { return d === 'Sales' ? ['A_Q_Sales'] : ['A_Q_CSR']; };
  h.ctx.getFinalDeptLabels_ = function (d) { return [String(d).toLowerCase()]; };
  h.ctx.getAllFinalDeptLabels_ = function () { return ['csr', 'sales']; };
  h.ctx.buildDeptsByAgent_ = function () {
    return { Ann: ['CSR'], Bob: ['CSR'] };
  };
  install.connCalls = 0;
  h.ctx.getDashboardNeonConn_ = function () { install.connCalls++; return opts.conn || null; };
  h.ctx.openSpreadsheet_ = function () {
    return {
      getSheetByName: function (name) {
        if (name === 'Outbound Calls') return opts.noOb ? null : fakeTab(OB_ROWS, 12);
        if (name === 'Inbound Calls') return opts.noIb ? null : fakeTab(IB_ROWS, 17);
        return null;
      },
    };
  };
}

function connReturning(json) {
  return {
    createStatement: function () {
      return {
        executeQuery: function () {
          let n = 0;
          return { next: function () { return n++ === 0; },
                   getString: function () { return json; }, close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

test('parity: the sheet fallback and the Neon path produce the SAME payload', function () {
  // Neon path over the fixture-derived blob...
  install({ conn: connReturning(JSON.stringify(neonBlobFromFixture('CSR'))) });
  const live = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(live.meta.available, true);
  assert.ok(!live.meta.fallbackSource, 'the live path carries no disclosure');

  // ...and the sheet path over the SAME rows.
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(fb.meta.available, true, 'the fallback serves a usable payload');
  assert.equal(fb.meta.fallbackSource, 'sheet');

  // The headline: every number agrees.
  assert.deepEqual(JSON.parse(JSON.stringify(fb.kpis)), JSON.parse(JSON.stringify(live.kpis)));
  assert.deepEqual(JSON.parse(JSON.stringify(fb.callback)), JSON.parse(JSON.stringify(live.callback)));
  assert.deepEqual(JSON.parse(JSON.stringify(fb.agents)), JSON.parse(JSON.stringify(live.agents)));
  assert.deepEqual(JSON.parse(JSON.stringify(fb.daily)), JSON.parse(JSON.stringify(live.daily)));
  assert.deepEqual(JSON.parse(JSON.stringify(fb.callbackByHour)), JSON.parse(JSON.stringify(live.callbackByHour)));
  assert.deepEqual(JSON.parse(JSON.stringify(fb.callbackPrior)),
                   JSON.parse(JSON.stringify(live.callbackPrior)));
});

test('the callback rule survives the mirror: hash match, window, ordering, anonymity', function () {
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  const cb = fb.callback;
  // 5 abandons pass the CSR denominator (hashA, hashC x2, hashD, anonymous);
  // the answered / internal / out-of-window / other-dept rows are excluded,
  // and the no-queue hashM hang-up is not on CSR's queues at all.
  assert.equal(cb.abandonedTotal, 5);
  assert.equal(cb.abandonedAnonymous, 1);
  assert.equal(cb.abandonedTracked, 4, 'anonymous never lands in the tracked attempts');
  assert.equal(cb.episodes, 3, 'hashC’s second try joined its open episode');
  assert.equal(cb.repeatEpisodes, 1);
  assert.equal(cb.own, 1, 'only hashA has a qualifying later dial -- from Ann, on the CSR roster');
  assert.equal(cb.ownConnected, 1);
  assert.equal(cb.gotThrough, 1, 'hashD reached the queue on a later call');
  assert.equal(cb.none, 1);
  assert.equal(cb.own + cb.other + cb.gotThrough + cb.pending + cb.none, cb.episodes);
});

test('CE-1 company view: both paths agree, the per-dept table included, and phone-menu hang-ups are counted apart', function () {
  install({ conn: connReturning(JSON.stringify(neonBlobFromFixture(''))) });
  const live = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  assert.equal(fb.meta.fallbackSource, 'sheet');
  ['callback', 'callbackByDept', 'daily', 'callbackPrior'].forEach(function (k) {
    assert.deepEqual(JSON.parse(JSON.stringify(fb[k])), JSON.parse(JSON.stringify(live[k])), k);
  });
  assert.equal(live.callback.phoneMenuAbandons, 1, 'hashM: counted ...');
  assert.ok(live.callbackByDept.rows.every(function (r) { return r.dept !== ''; }));
  assert.equal(live.callbackByDept.total.episodes, live.callback.episodes, '... and never an episode');
});

test('fallback payloads are NEVER cached; healthy payloads still are', function () {
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(fb.meta.fallbackSource, 'sheet');
  assert.equal(h.state.cache.size, 0, 'an outage payload must not pin under the live key');

  install({ conn: connReturning(JSON.stringify(neonBlobFromFixture('CSR'))) });
  h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.ok(h.state.cache.size > 0, 'a healthy payload still caches');
});

test('every Neon failure branch reaches the fallback; missing tabs stay unavailable', function () {
  // (a) connection null
  install({ conn: null });
  assert.equal(h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' })
    .meta.fallbackSource, 'sheet');
  // (b) null result from the query
  install({ conn: connReturning(null) });
  assert.equal(h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' })
    .meta.fallbackSource, 'sheet');
  // (c) the query throws
  install({ conn: { createStatement: function () { throw new Error('boom'); }, close: function () {} } });
  assert.equal(h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' })
    .meta.fallbackSource, 'sheet');
  // (d) no export tab -> honestly unavailable, never a false zero
  install({ conn: null, noOb: true });
  const none = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(none.meta.available, false);
  assert.ok(!none.meta.fallbackSource);
});

test('the fallback discloses how far the copy reaches (meta.fallbackThrough)', function () {
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  // The OLDER of the two tabs bounds what the payload can know.
  assert.equal(fb.meta.fallbackThrough, '2026-08-11');
});

// PCR-3 (broad-scan 2026-09-23): a callback counts through abandon date + 3
// INCLUSIVE, so an uncalled abandon exactly 3 days ago is still pending today.
// Both paths used a strict '>' (and the SQL used Neon's UTC current_date).
test('PCR-3: a pending episode includes an abandon exactly N days old, against the script-TZ today', function () {
  install({ conn: null });
  const realToday = h.ctx.obTodayIso_;
  // hashC tried 2026-08-10 and again 08-11: its window runs to 08-11 + 3.
  h.ctx.obTodayIso_ = function () { return '2026-08-14'; };
  try {
    const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
    assert.equal(fb.callback.pending, 1, 'last attempt 08-11: it can still be called back on 08-14 (inclusive)');
    h.ctx.obTodayIso_ = function () { return '2026-08-15'; };
    h.state.cache.clear();
    assert.equal(h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' }).callback.pending, 0,
      'one day later it is outside the window');
  } finally { h.ctx.obTodayIso_ = realToday; }
});

// PC-6 (broad-scan 2026-10-01): the Outbound Calls tab must carry an UNKNOWN
// ring as a blank -- the export used to COALESCE it to 0, which this fallback
// classifies as a "brief" (misdial) ring while the Neon path calls it unknown.
test('PC-6: the export keeps a NULL ring blank, and the fallback reads blank as unknown', function () {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script',
    'cdr-report', 'outboundCallsExport.js'), 'utf8');
  assert.ok(!/COALESCE\(o\.ring_seconds\s*,\s*0\)/.test(src), 'a NULL ring must not be exported as 0');
  assert.ok(/COALESCE\(o\.ring_seconds::text\s*,\s*''\)/.test(src));
  assert.equal(h.call('outboundClassifyRing_', ''), 'unknown');
  assert.equal(h.call('outboundClassifyRing_', '0'), 'brief', 'which is exactly what the old export produced');
});

// PC-9 (broad-scan 2026-10-01): the sheet fallback floors the window per ENTRY
// queue like the SQL's inboundWindowStartSql_ -- 06:00 for the CSR family
// (R49), 06:30 for everything else.
test('PC-9: the fallback counts a 06:10 CSR-family abandon, but not a 06:10 one on another queue or a 05:55 one', function () {
  const extra = [
    ibRow('2026-08-10', 'hashE', 'abandoned', 'A_Q_CSR', '06:10:00'),      // counted (early family)
    ibRow('2026-08-10', 'hashF', 'abandoned', 'A_Q_CSR', '05:55:00'),      // before even the early floor
    ibRow('2026-08-10', 'hashG', 'abandoned', 'A_Q_Billing', '06:10:00'),  // in dept, NOT early family
  ];
  install({ conn: null });
  h.ctx.inboundQueuesForDept_ = function () { return ['A_Q_CSR', 'A_Q_Billing']; };
  const base = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' }).callback.abandonedTotal;
  Array.prototype.push.apply(IB_ROWS, extra);
  try {
    h.state.cache.clear();
    const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
    assert.equal(fb.callback.abandonedTotal, base + 1, 'only the 06:10 A_Q_CSR abandon joins the denominator');
  } finally { IB_ROWS.splice(IB_ROWS.length - extra.length, extra.length); }
});

// ── Batch D: the My Department outbound view (getDeptOutboundSummary) ──────
// It is the Outbound report's per-agent half, so the pins are about staying
// the SAME numbers through every route: the Neon path, the sheet fallback,
// and the report itself.

function deptBlob() {
  const b = neonBlobFromFixture('CSR');
  return { agents: b.agents, coverageStart: b.coverageStart };
}

test('Batch D: the dept outbound view agrees with the Outbound report agent-for-agent', function () {
  install({ conn: connReturning(JSON.stringify(neonBlobFromFixture('CSR'))) });
  h.ctx.teamAvgExcludeSet_ = function () { return {}; };
  h.ctx.rosterSetHash_ = function () { return 'r'; };
  const report = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  install({ conn: connReturning(JSON.stringify(deptBlob())) });
  const view = h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  const strip = (list) => JSON.parse(JSON.stringify(list)).map((a) => {
    delete a.excludedFromTeamAvg; return a;
  });
  assert.deepEqual(strip(view.agents), strip(report.agents), 'same rows, same attribution');
  assert.equal(view.totals.obTotal, report.kpis.obTotal);
  assert.equal(view.totals.obConnected, report.kpis.obConnected);
  assert.equal(view.totals.obTalkSec, report.kpis.obTalkSec);
  const ann = view.agents.find((a) => a.agent === 'Ann');
  assert.equal(ann.obDays, 1, 'Ann dialled on one day in the window');
  assert.equal(ann.obPerDay, 2);
});

test('Batch D: Neon down -> the Outbound Calls tab serves the SAME rows, and is never cached', function () {
  install({ conn: connReturning(JSON.stringify(deptBlob())) });
  h.ctx.teamAvgExcludeSet_ = function () { return {}; };
  h.ctx.rosterSetHash_ = function () { return 'r'; };
  const live = h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  assert.ok(!live.meta.fallbackSource);
  install({ conn: null });
  h.ctx.teamAvgExcludeSet_ = function () { return {}; };
  h.ctx.rosterSetHash_ = function () { return 'r'; };
  const fb = h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(fb.meta.fallbackSource, 'sheet');
  assert.deepEqual(JSON.parse(JSON.stringify(fb.agents)), JSON.parse(JSON.stringify(live.agents)),
    'obDays included: the sheet counts distinct dates like count(DISTINCT call_date)');
  // A second call still recomputes -- the degraded payload was not pinned.
  const again = h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(again.meta.cacheHit, false);
  assert.ok(install.connCalls >= 2, 'the recovered-Neon check runs every time');
});

test('Batch D: a healthy payload is cached on the freshness-tagged, roster-hashed key', function () {
  install({ conn: connReturning(JSON.stringify(deptBlob())) });
  h.ctx.teamAvgExcludeSet_ = function () { return {}; };
  h.ctx.rosterSetHash_ = function () { return 'r'; };
  h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  const keys = Array.from(h.state.cache.keys());
  assert.ok(keys.some((k) => k === 'deptOutbound:v1:CSR:' + FROM + ':' + TO + ':tag:r'), keys.join(' | '));
  const hit = h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(hit.meta.cacheHit, true);
});

test('Batch D: the same 6c gate as the report -- a manager is refused while it stands; a company view is refused', function () {
  install({ conn: connReturning(JSON.stringify(deptBlob())) });
  h.ctx.resolveUser_ = function () { return { role: 'manager', department: 'CSR', departments: ['CSR'], email: 'm@x.com' }; };
  assert.throws(function () {
    h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'CSR' });
  }, /admin-only while it is being vetted/);
  install({ conn: connReturning(JSON.stringify(deptBlob())) });
  assert.throws(function () {
    h.call('getDeptOutboundSummary', { from: FROM, to: TO, department: 'ALL' });
  }, /department is required/);
});

test('Batch D: team per-day leaves the dept’s team-average excludes out; totals keep them', function () {
  const rows = [
    { agent: 'Ann', scopeDept: 'CSR', obTotal: 20, obConnected: 10, obTalkSec: 600, attempts: 22, obDays: 4 },
    { agent: 'Mgr', scopeDept: 'CSR', obTotal: 2, obConnected: 1, obTalkSec: 60, attempts: 2, obDays: 2 },
  ];
  const t = h.call('deptObTotals_', rows, { CSR: { Mgr: true } });
  assert.equal(t.obTotal, 22, 'the manager’s calls stay in the totals (R18 rule)');
  assert.equal(t.obPerDay, 5, 'Ann alone: 20 calls over 4 days');
  assert.equal(t.obConnectRate, 50);
  assert.equal(t.obAttSec, 60);
});

test('Batch D: a parent view groups agents by their in-scope dept with per-dept subtotals', function () {
  const shaped = { meta: {}, agents: [
    { agent: 'Ann', scopeDept: 'CSR', obTotal: 3, obConnected: 1, obDays: 1 },
    { agent: 'Sol', scopeDept: 'Spanish', obTotal: 5, obConnected: 2, obDays: 2 },
  ] };
  const out = h.call('deptOutboundProject_', { dept: 'CSR', from: FROM, to: TO, scopeDepts: ['CSR', 'Spanish'] },
    shaped, { CSR: {}, Spanish: {} });
  assert.equal(out.deptGroups.length, 2);
  assert.equal(out.deptGroups[1].dept, 'Spanish');
  assert.equal(out.deptGroups[1].totals.obTotal, 5);
  assert.equal(out.totals.obTotal, 8);
  const single = h.call('deptOutboundProject_', { dept: 'CSR', from: FROM, to: TO, scopeDepts: ['CSR'] },
    { meta: {}, agents: [] }, { CSR: {} });
  assert.equal(single.deptGroups, null, 'no grouping for a dept without sub-queues');
});

test('Batch D: the report and the view read ONE SQL definition and ONE sheet aggregation', function () {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script',
    'department-dashboard', 'OutboundReport.gs'), 'utf8');
  const report = src.slice(src.indexOf('function computeOutboundReport_('), src.indexOf('function outboundShapeReport_('));
  const view = src.slice(src.indexOf('function computeDeptOutbound_('), src.indexOf('function getDeptOutboundSummary('));
  assert.match(report, /const agentsSel = outboundAgentsSel_;/);
  assert.match(view, /outboundAgentsSel_\(scope\.from, scope\.to\)/);
  assert.match(view, /obAgentsFromGrid_\(ob\.grid, scope\.from, scope\.to\)/);
  assert.match(src, /var agentsFor = function \(fromIso, toIso\) \{ return obAgentsFromGrid_\(obGrid, fromIso, toIso\); \};/);
  assert.match(view, /neonNoteEgress_\(json \? json\.length : 0, 'deptOutbound'\)/);
  // The mocked connection never runs SQL, so the "/ day" denominator's clause
  // is pinned at the source: it must count DAYS, not rows.
  const sel = src.slice(src.indexOf('function outboundAgentsSel_('), src.indexOf('function computeOutboundReport_('));
  assert.match(sel, /'count\(DISTINCT call_date\) AS ob_days '/);
});
