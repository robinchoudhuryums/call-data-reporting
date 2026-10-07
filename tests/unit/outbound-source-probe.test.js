'use strict';

// Batch C: probeOutboundSourceAgreement (OutboundReport.gs) -- can the
// day-level outbound counts in `CDR Historical Data` stand in for the
// per-call `outbound_calls` table, per agent per day?
//
// The verdict decides where Batch D's outbound view reads from, so it is
// pinned on the properties that make it trustworthy:
//   1. the verdict is PRE-REGISTERED on PLACED counts only -- duration and
//      connected are reported, never voted, because the two sources define
//      them differently (leg duration vs talk; >=20 s legs vs talk > 0);
//   2. a run over too little data, or with too many one-sided DATES, is
//      INCONCLUSIVE, never CLEAN;
//   3. agent-days present on one side only (a name difference) can fail it;
//   4. the sheet read is span-bounded, display-valued (INV-02) and keeps the
//      per-row date filter; the Neon read is bound, grouped and labelled;
//   5. admin-gated and read-only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'NeonCoverage.gs', 'InboundReport.gs', 'OutboundReport.gs'] });
// isIsoDate_ lives in Data.gs, which this suite does not load (the agent-day stub).
h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script',
  'department-dashboard', 'OutboundReport.gs'), 'utf8');

function days(n, startIso) {
  const out = [];
  const p = startIso.split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.UTC(p[0], p[1] - 1, p[2] + i)).toISOString().slice(0, 10));
  }
  return out;
}
function maps(agentDays, neonFn) {
  const s = {}, n = {};
  agentDays.forEach(function (k, i) {
    s[k] = { placed: 10, over20: 6, durSec: 900 };
    n[k] = neonFn ? neonFn(k, i) : { placed: 10, connected: 7, talkSec: 600, ringSec: 200 };
  });
  return { s: s, n: n };
}
const AGENT_DAYS = [];
days(10, '2026-09-01').forEach(function (d) {
  ['Ann Agent', 'Bo Caller', 'Cy Dialer'].forEach(function (a) { AGENT_DAYS.push(d + '|' + a); });
});

test('THE RULE: matching placed counts are CLEAN even though durations and connects differ', function () {
  const m = maps(AGENT_DAYS);
  const r = h.call('obSrcCompare_', m.s, m.n);
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.reasons));
  assert.equal(r.stats.compared, 30);
  assert.equal(r.stats.sheetDurSec, 27000);
  assert.equal(r.stats.neonTalkSec, 18000, 'durations are reported...');
  assert.equal(r.stats.neonTalkRingSec, 24000);
  assert.equal(r.stats.sheetOver20, 180);
  assert.equal(r.stats.neonConnected, 210, '...and connects too, but neither is voted');
});

test('placed counts within max(1 call, 5%) match; wider differences are MISMATCH', function () {
  const near = maps(AGENT_DAYS, function () { return { placed: 11, connected: 7, talkSec: 0, ringSec: 0 }; });
  const r1 = h.call('obSrcCompare_', near.s, near.n);
  assert.equal(r1.stats.matched, 30, 'one call apart is within tolerance');
  assert.equal(r1.verdict, 'MISMATCH', 'but 10% total drift still fails the company-total gate');
  assert.match(r1.reasons.join(' '), /placed totals differ by 9\.1%/);

  const off = maps(AGENT_DAYS, function (k, i) {
    return { placed: i % 4 === 0 ? 14 : 10, connected: 0, talkSec: 0, ringSec: 0 };
  });
  const r2 = h.call('obSrcCompare_', off.s, off.n);
  assert.equal(r2.verdict, 'MISMATCH');
  assert.match(r2.reasons.join(' '), /of agent-days match/);
  assert.ok(r2.stats.worst.length > 0 && Math.abs(r2.stats.worst[0].diff) === 4, 'the worst agent-days are listed');
});

test('too few agent-days is INCONCLUSIVE, never CLEAN', function () {
  const m = maps(AGENT_DAYS.slice(0, 5));
  const r = h.call('obSrcCompare_', m.s, m.n);
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.reasons[0], /5 agent-days compared/);
});

test('a date present on ONE side only is a coverage gap, left out -- and too many make the run INCONCLUSIVE', function () {
  const m = maps(AGENT_DAYS);
  // Neon is missing one whole date (an import that skipped the mirror).
  Object.keys(m.n).filter(function (k) { return k.indexOf('2026-09-03|') === 0; })
    .forEach(function (k) { delete m.n[k]; });
  const r = h.call('obSrcCompare_', m.s, m.n);
  assert.equal(r.verdict, 'CLEAN', 'one gap date of ten is left out, not counted against agreement');
  assert.equal(r.stats.compared, 27);
  assert.equal(r.stats.gapDates.length, 1);
  assert.equal(r.stats.gapDates[0].date, '2026-09-03');

  ['2026-09-04|', '2026-09-05|'].forEach(function (pre) {
    Object.keys(m.n).filter(function (k) { return k.indexOf(pre) === 0; }).forEach(function (k) { delete m.n[k]; });
  });
  const r2 = h.call('obSrcCompare_', m.s, m.n);
  assert.equal(r2.verdict, 'INCONCLUSIVE', '3 of 10 dates one-sided is past the 20% gate');
});

test('agent-days present on one side only (a NAME difference) fail the run', function () {
  const m = maps(AGENT_DAYS);
  // Neon stores Cy under a different spelling on every date.
  Object.keys(m.n).filter(function (k) { return /\|Cy Dialer$/.test(k); }).forEach(function (k) {
    m.n[k.replace('Cy Dialer', 'Cy  Dialer')] = m.n[k];
    delete m.n[k];
  });
  const r = h.call('obSrcCompare_', m.s, m.n);
  assert.equal(r.verdict, 'MISMATCH');
  assert.match(r.reasons.join(' '), /one side only -- likely an agent-NAME/);
  assert.ok(r.stats.sheetOnly.length > 0 && r.stats.neonOnly.length > 0);
});

test('durations parse from DISPLAY strings', function () {
  assert.equal(h.call('obSrcDurSec_', '1:02:03'), 3723);
  assert.equal(h.call('obSrcDurSec_', '4:05'), 245);
  assert.equal(h.call('obSrcDurSec_', '90'), 90);
  assert.equal(h.call('obSrcDurSec_', ''), 0);
  assert.equal(h.call('obSrcDurSec_', 'x:y'), 0);
});

test('columns resolve by HEADER name, falling back to the INV-52 positions', function () {
  const byName = h.call('obSrcColumns_', ['Month Year', 'Week', 'Date', 'Dept', 'AgentName', 'x', 'OB External Total']);
  assert.equal(byName.placed.idx, 6);
  assert.equal(byName.placed.by, 'OB External Total');
  const byPos = h.call('obSrcColumns_', []);
  assert.equal(byPos.placed.idx, 19);
  assert.equal(byPos.dur.idx, 21);
  assert.match(byPos.placed.by, /position 20/);
});

test('window: floored at outbound capture start, capped, and validated', function () {
  const props = function (o) { return { getProperty: function (k) { return o[k] || null; } }; };
  const w = h.call('obSrcWindow_', props({ OUTBOUND_SOURCE_FROM: '2026-06-01', OUTBOUND_SOURCE_TO: '2026-07-20' }));
  assert.equal(w.from, '2026-07-10', 'nothing to compare before capture');
  assert.throws(function () {
    h.call('obSrcWindow_', props({ OUTBOUND_SOURCE_FROM: '2026-07-10', OUTBOUND_SOURCE_TO: '2026-12-31' }));
  }, /capped at 92 days/);
  assert.throws(function () {
    h.call('obSrcWindow_', props({ OUTBOUND_SOURCE_FROM: '2026-08-02', OUTBOUND_SOURCE_TO: '2026-08-01' }));
  }, /from <= to/);
});

test('sheet read: span-bounded, per-row date filtered, display-valued, summed per agent-day', function () {
  const H = ['Month Year', 'Week', 'Date', 'Dept', 'AgentName'];
  for (let c = 5; c < 19; c++) H.push('m' + c);
  H.push('OB External Total', 'OB External Answered', 'OB External Total Duration');
  const row = function (date, agent, placed, over20, dur) {
    const r = ['', '', date, 'CSR', agent];
    for (let c = 5; c < 19; c++) r.push('');
    r.push(placed, over20, dur);
    return r;
  };
  const data = [H,
    row('9/1/2026', 'Ann Agent', 4, 2, '0:10:00'),
    row('8/1/2026', 'Ann Agent', 99, 9, '9:00:00'),   // out of window, INSIDE the span (out-of-order sheet)
    row('9/2/2026', 'Ann Agent', 3, 1, '0:05:00'),
    row('9/2/2026', 'Ann Agent', 1, 0, '0:01:00'),    // a second row the same agent-day: summed
    row('10/1/2026', 'Ann Agent', 50, 5, '1:00:00')]; // after the window
  const ss = makeFakeSpreadsheet({ sheets: { 'CDR Historical Data': data } });
  const out = h.call('obSrcReadSheet_', ss, '2026-09-01', '2026-09-30');
  assert.deepEqual(JSON.parse(JSON.stringify(out.map)), {
    '2026-09-01|Ann Agent': { placed: 4, over20: 2, durSec: 600 },
    '2026-09-02|Ann Agent': { placed: 4, over20: 1, durSec: 360 },
  }, 'the out-of-order 8/1 row sits inside the span and is still filtered out');
  assert.equal(out.rows, 3);
  assert.match(SRC, /function obSrcReadSheet_[\s\S]*?getDisplayValues\(\)[\s\S]*?getDisplayValues\(\)/,
    'both the date column and the grid are read as DISPLAY values (INV-02)');
});

test('the Neon read is bound, grouped per agent-day, selects no PHI, and is LABELLED', function () {
  const body = SRC.slice(SRC.indexOf('function obSrcReadNeon_'), SRC.indexOf('function probeOutboundSourceAgreement'));
  assert.match(body, /WHERE call_date BETWEEN \?::date AND \?::date/);
  assert.match(body, /GROUP BY call_date, agent_name/);
  assert.ok(!/callee_hash|call_id|journey/.test(body), 'no hash, call id or journey is selected');
  assert.match(body, /neonNoteEgress_\(j \? j\.length : 0, 'outbound-source'\)/);
});

test('admin-gated FIRST, read-only, and self-clears its window only on CLEAN', function () {
  const body = SRC.slice(SRC.indexOf('\nfunction probeOutboundSourceAgreement('));
  assert.match(body, /^\nfunction probeOutboundSourceAgreement\(\) \{\n  assertAdmin_\(\);/);
  assert.ok(!/setValues|setValue\(|appendRow|setProperty|INSERT|UPDATE |DELETE /.test(body),
    'the probe writes nothing');
  const clean = body.indexOf("cmp.verdict === 'CLEAN'");
  const clear = body.indexOf('clearToolParamsAfterCleanRun_');
  assert.ok(clean > 0 && clear > clean && clear < body.indexOf("cmp.verdict === 'MISMATCH'"),
    'the params clear only inside the CLEAN branch');
});

test('a non-admin is refused before anything is read', function () {
  const realAdmin = h.ctx.assertAdmin_;
  h.ctx.assertAdmin_ = function () { throw new Error('Admin only.'); };
  let opened = 0;
  h.ctx.getDashboardNeonConn_ = function () { opened++; return null; };
  assert.throws(function () { h.call('probeOutboundSourceAgreement'); }, /Admin only/);
  assert.equal(opened, 0);
  h.ctx.assertAdmin_ = realAdmin;
  delete h.ctx.getDashboardNeonConn_;
});
