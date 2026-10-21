'use strict';

// probeOutboundCallMix (owner 2026-10-21): "are these CSRs' outbound calls
// really customers?" The capture keeps only calls to a 10+ digit number, so
// extension dials never count -- this READ-ONLY editor tool sorts chosen
// agents' calls into company line / colleague / inbound twin / misdial /
// redial / external, with sample call ids for the phone portal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'InboundReport.gs', 'CallerLookup.gs', 'AgentDay.gs', 'OutboundReport.gs'] });
const J = (x) => JSON.parse(JSON.stringify(x));

function install() {
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  h.ctx.buildDeptsByAgent_ = function () { return { Ann: ['CSR'], Cal: ['Sales'] }; };
  h.ctx.resolveUser_ = function () { return { email: 'a@x.com', role: 'admin', departments: ['CSR'] }; };
  h.ctx.assertAdmin_ = function () {};
}
install();

const ROSTER = { Ann: ['CSR'], Cal: ['Sales'] };
const row = (o) => Object.assign({ call_id: 'c', call_date: '2026-10-01', call_start: '09:00:00', agent: 'Ann',
  callee_hash: 'h-cust', connected: true, ring_seconds: 12, attempts: 1, journey: null, prev_gap: null, twin: false }, o);

test('bucket: first match wins -- company line, colleague, inbound twin, misdial, redial, external', function () {
  const ctx = { companyHashes: { 'h-main': 'Main line' }, roster: ROSTER, briefSec: 8 };
  const B = (o) => h.ctx.obMixBucket_(row(o), ctx);
  assert.equal(B({ callee_hash: 'h-main', twin: true }), 'company-line', 'a company number beats everything');
  assert.equal(B({ journey: JSON.stringify([{ t: '09:00:01', name: 'Cal', kind: 'answer' }]), twin: true }), 'colleague',
    'a roster colleague named in the path (not the dialler)');
  assert.equal(B({ journey: JSON.stringify([{ name: 'Ann', kind: 'answer' }]) }), 'external', 'the dialler naming herself is no colleague');
  assert.equal(B({ journey: JSON.stringify([{ name: 'A.P.', kind: 'answer' }]) }), 'external', 'a masked outside leg never matches');
  assert.equal(B({ twin: true }), 'inbound-twin');
  assert.equal(B({ connected: false, ring_seconds: 3 }), 'misdial');
  assert.equal(B({ connected: false, ring_seconds: 20 }), 'external', 'a call that rang out is a real attempt');
  assert.equal(B({ attempts: 3 }), 'redial');
  assert.equal(B({ prev_gap: 300 }), 'redial', 'the same number again within 10 minutes');
  assert.equal(B({ prev_gap: 900 }), 'external');
  assert.equal(B({}), 'external');
});

test('summarize: per-agent counts and shares, samples capped, busiest first', function () {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(row({ call_id: 'm' + i, connected: false, ring_seconds: 2 }));
  rows.push(row({ call_id: 'x1' }));
  rows.push(row({ call_id: 'b1', agent: 'Bob', callee_hash: 'h-main' }));
  const s = J(h.ctx.obMixSummarize_(rows, { companyHashes: { 'h-main': 'Main line' }, roster: ROSTER, briefSec: 8 }));
  assert.equal(s.totals.placed, 9);
  assert.equal(s.totals.misdial, 7);
  assert.equal(s.agents[0].agent, 'Ann');
  assert.equal(s.agents[0].samples.misdial.length, 5, 'OB_MIX_SAMPLES_ caps the ids');
  assert.equal(s.agents[0].share.misdial, 0.875);
  assert.deepEqual(s.agents[1].samples['company-line'][0], { callId: 'b1', date: '2026-10-01', start: '09:00:00', label: 'Main line' });
});

test('agent list: comma or newline, trimmed, de-duplicated', function () {
  assert.deepEqual(J(h.ctx.obMixAgentList_(' Ann, Bob\nAnn ,, ')), ['Ann', 'Bob']);
  assert.deepEqual(J(h.ctx.obMixAgentList_(null)), []);
});

function fakeConn(rows, dialIns) {
  const conn = { sql: [], binds: [], closed: false,
    createStatement: function () {   // obProbeAnchorDate_
      return { executeQuery: function () { let n = 0; return { next: () => n++ === 0, getString: () => '2026-10-20', close() {} }; }, close() {} };
    },
    prepareStatement: function (s) {
      conn.sql.push(s);
      const b = {};
      conn.binds.push(b);
      return {
        setString: function (i, v) { b[i] = v; },
        setQueryTimeout: function () {},
        executeQuery: function () {
          // Apps Script's JDBC counts EVERY '?' in the text as a slot, string
          // literals included -- the live "Invalid argument" (2026-10-21).
          const slots = (s.match(/\?/g) || []).length;
          assert.equal(slots, Object.keys(b).length, 'every ? in the SQL is a bound slot: ' + s.slice(0, 80));
          let n = 0;
          const j = /dial_in_number/.test(s) && !/outbound_calls/.test(s) ? JSON.stringify(dialIns || []) : JSON.stringify(rows);
          return { next: () => n++ === 0, getString: () => j, close() {} };
        },
        close() {},
      };
    },
    close: function () { conn.closed = true; },
  };
  return conn;
}

test('probe: read-only, metered, agents bound, a company dial-in recognised through the same HMAC as the capture', function () {
  const secret = 's3cret';
  const mainHash = h.ctx.callerLookupHashPhone_('+18665550100', secret);
  const conn = fakeConn([
    row({ call_id: 'k1', callee_hash: mainHash }),
    row({ call_id: 'k2' }),
    row({ call_id: 'k3', connected: false, ring_seconds: 1 }),
  ], ['+1 (866) 555-0100']);
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  const egress = [];
  h.ctx.neonNoteEgress_ = function (n, label) { egress.push(label); };
  h.state.props.HMAC_SECRET = secret;
  h.state.props.OUTBOUND_MIX_AGENTS = 'Ann';
  h.state.props.OUTBOUND_PROBE_FROM = '2026-10-01';
  h.state.props.OUTBOUND_PROBE_TO = '2026-10-20';
  const out = J(h.call('probeOutboundCallMix'));
  assert.match(out.result, /^OK 2026-10-01\.\.2026-10-20[^:]*: 3 placed -- company-line 1 \(33\.3%\)/);
  assert.equal(out.totals.misdial, 1);
  assert.equal(out.totals.external, 1);
  assert.ok(conn.sql.every((s) => !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(s)), 'read-only');
  assert.ok(egress.length >= 2 && egress.every((l) => l === 'outbound-mix'), 'every read is metered under its own label');
  const main = conn.binds[conn.sql.findIndex((s) => /outbound_calls/.test(s))];
  assert.equal(main[3], 'Ann', 'the asked agent is a bound parameter, never spliced into the SQL');
  assert.ok(conn.closed);
  delete h.state.props.OUTBOUND_MIX_AGENTS;
});

test('probe: unset agents -> the window\'s top diallers; Neon down -> FAILED, nothing thrown', function () {
  const conn = fakeConn([]);
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  const out = J(h.call('probeOutboundCallMix'));
  assert.match(out.result, /^INCONCLUSIVE/);
  assert.equal(out.agentsAsked, 'top 10 diallers');
  assert.match(conn.sql.find((s) => /outbound_calls/.test(s)), /ORDER BY count\(\*\) DESC LIMIT 10/);
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.match(J(h.call('probeOutboundCallMix')).result, /^FAILED \(Neon unreachable\)/);
});
