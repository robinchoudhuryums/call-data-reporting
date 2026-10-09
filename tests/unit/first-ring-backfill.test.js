'use strict';

// BF-1: the one-off backfill of inbound_calls.first_ring_seconds from the
// STORED journey (cdr-import/inboundCalls.js, previewFirstRingBackfill /
// backfillFirstRingFromJourney). FO-1 captures the first person's ring at
// import; rows captured before it read NULL ("ring unknown", kept in the
// direct-line rate). Their raw legs are pruned at ~14 days, but each journey
// leg still carries its length (`secs`), which on an unanswered leg is exactly
// what icFirstRingSec_ computes. Pinned here:
//   (1) the matcher: the FIRST non-queue journey leg naming the line owner --
//       verbatim or through the capture's canonicalizer -- and an answered
//       or length-less leg stays unknown, never 0;
//   (2) the population (the only rows the misdial filter reads), the
//       NULL-only write, chunking by date, PREVIEW never writing, every
//       statement bounded, and no caller hash leaving the database;
//   (3) the log's misdial line matches the dashboard's.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const h = loadGas({ project: 'cdr-import',
  files: ['buildDQEHistoricalData.js', 'inboundCalls.js', 'outboundCalls.js'] });

function installRoster() {
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid({
    CSR: ['Roman (Robin) Paulose, 214', 'Maria Garcia, 215'],
  }) } });
  h.ctx.getTargetSsId_ = function () { return 'fake'; };
  h.ctx.IC_AGENT_CANON_MEMO_ = null;
}

const ev = (n, k, s) => ({ n: n, k: k, s: s == null ? null : String(s) });

test('BF-1 matcher: the first leg naming the line owner, verbatim or canonicalized', function () {
  installRoster();
  const canon = h.call('icAgentCanonicalizer_');
  const f = function (events, who) { return h.call('icFirstRingFromJourney_', events, who, canon); };
  // IVR legs come first and name no agent; the owner's leg is the ring.
  assert.equal(f([ev('Introduction - New', 'leg', 15), ev('Maria Garcia', 'leg', 24)], 'Maria Garcia'), 24);
  // A journey PC-1's rewrite has not reached still holds the RAW feed name.
  assert.equal(f([ev('Roman Robin Paulose', 'leg', 5)], 'Roman (Robin) Paulose'), 5, 'canonicalized like the capture');
  // The FIRST such leg: a later re-ring of the same person is not the first ring.
  assert.equal(f([ev('Maria Garcia', 'leg', 3), ev('Maria Garcia', 'leg', 30)], 'Maria Garcia'), 3);
  assert.equal(f([ev('Maria Garcia', 'leg', 0)], 'Maria Garcia'), 0, 'a real 0 s ring stays 0');
  assert.equal(f([ev('Maria Garcia', 'leg', '7.6')], 'Maria Garcia'), 8, 'rounded like the capture');
});

test('BF-1 matcher: anything it cannot decide stays unknown (null), never 0', function () {
  installRoster();
  const canon = h.call('icAgentCanonicalizer_');
  const f = function (events, who) { return h.call('icFirstRingFromJourney_', events, who, canon); };
  assert.equal(f([ev('Introduction - New', 'leg', 15)], 'Maria Garcia'), null, 'no leg names the line owner');
  assert.equal(f([ev('Maria Garcia', 'answer', 90)], 'Maria Garcia'), null, 'an answered leg’s length includes talk');
  assert.equal(f([ev('Maria Garcia', 'leg', null)], 'Maria Garcia'), null, 'no length on the leg');
  assert.equal(f([ev('Maria Garcia', 'leg', 'x')], 'Maria Garcia'), null);
  assert.equal(f([], 'Maria Garcia'), null);
  assert.equal(f([ev('Maria Garcia', 'leg', 5)], ''), null, 'no line owner');
  assert.equal(f(null, 'Maria Garcia'), null);
});

// A fake Neon connection: answers the span query and the per-chunk event
// query from `rowsByChunk`, and records every statement.
function backfillConn(log, span, rowsByChunk) {
  const stmt = function () {
    return {
      setQueryTimeout: function (s) { log.timeouts.push(s); },
      execute: function (q) { log.ddl.push(q); return true; },
      executeQuery: function (q) {
        log.queries.push(q);
        let v = null;
        if (/json_build_array\(min\(c\.call_date\)/.test(q)) v = JSON.stringify(span);
        else {
          const m = /BETWEEN '(\d{4}-\d{2}-\d{2})'::date AND '(\d{4}-\d{2}-\d{2})'::date/.exec(q);
          v = JSON.stringify((m && rowsByChunk[m[1] + '..' + m[2]]) || []);
        }
        let n = 0;
        return { next: function () { return n++ === 0; }, getString: function () { return v; }, close: function () {} };
      },
      executeUpdate: function (q) { log.updates.push(q); return (q.match(/::date,/g) || []).length; },
      close: function () {},
    };
  };
  return { setAutoCommit: function (b) { log.autoCommit = b; }, createStatement: stmt,
           close: function () { log.closed = true; } };
}

const ROWS_ = {
  '2026-06-01..2026-07-01': [
    ['2026-06-02', 'c1', 'Maria Garcia', [ev('Introduction - New', 'leg', 10), ev('Maria Garcia', 'leg', 4)]],
    ['2026-06-03', 'c2', 'Roman (Robin) Paulose', [ev('Roman Robin Paulose', 'leg', 25)]],
    ['2026-06-04', 'c3', 'Maria Garcia', [ev('Introduction - New', 'leg', 10)]],   // undecided
  ],
  '2026-07-02..2026-07-10': [
    ['2026-07-05', "c'4", 'Maria Garcia', [ev('Maria Garcia', 'leg', 9)]],
  ],
};

test('BF-1 PREVIEW: reads the direct-line population in date chunks, writes nothing, bounds every statement', function () {
  installRoster();
  const log = { queries: [], updates: [], ddl: [], timeouts: [] };
  h.ctx.getReachableNeonConn_ = function () { return backfillConn(log, ['2026-06-01', '2026-07-10'], ROWS_); };
  const out = JSON.parse(JSON.stringify(h.call('previewFirstRingBackfill')));
  assert.equal(log.updates.length, 0, 'a preview never writes');
  assert.deepEqual([out.candidates, out.derived, out.undecided, out.misdials, out.written], [4, 3, 1, 1, 0]);
  assert.deepEqual(out.chunks.map((c) => c.from + '..' + c.to), ['2026-06-01..2026-07-01', '2026-07-02..2026-07-10'],
    '31-day chunks, the last one cut at the newest candidate');
  const q = log.queries[1];
  // The population: exactly the rows the dashboard's misdial filter reads.
  assert.match(q, /c\.first_ring_seconds IS NULL AND c\.disposition IN \('missed', 'abandoned'\)/);
  assert.match(q, /COALESCE\(c\.is_internal, FALSE\) = FALSE/);
  assert.match(q, /COALESCE\(trim\(c\.entry_queue\), ''\) = '' AND COALESCE\(trim\(c\.first_agent\), ''\) <> ''/);
  assert.match(q, /c\.journey IS NOT NULL AND c\.journey <> ''/);
  // Only the non-queue events' name / kind / secs leave the database.
  assert.match(q, /COALESCE\(x\.e->>'kind', ''\) <> 'queue'/);
  assert.match(q, /WITH ORDINALITY AS x\(e, ord\)/);
  assert.ok(!/caller_hash/.test(q), 'no caller hash is read');
  assert.ok(log.timeouts.length >= 3 && log.timeouts.every((s) => s === 120), 'every query is bounded');
  assert.match(log.ddl[0], /ADD COLUMN IF NOT EXISTS first_ring_seconds integer/);
  assert.equal(log.closed, true);
});

test('BF-1 APPLY: one NULL-only UPDATE per chunk, values escaped, undecided rows left alone', function () {
  installRoster();
  const log = { queries: [], updates: [], ddl: [], timeouts: [] };
  h.ctx.getReachableNeonConn_ = function () { return backfillConn(log, ['2026-06-01', '2026-07-10'], ROWS_); };
  const out = h.call('backfillFirstRingFromJourney');
  assert.equal(log.updates.length, 2);
  assert.match(log.updates[0], /^UPDATE inbound_calls c SET first_ring_seconds = v\.r FROM \(VALUES /);
  assert.match(log.updates[0], /WHERE c\.call_date = v\.d AND c\.call_id = v\.id AND c\.first_ring_seconds IS NULL$/,
    'a value the capture already wrote is never overwritten');
  assert.ok(log.updates[0].indexOf("('2026-06-02'::date,'c1',4)") !== -1);
  assert.ok(log.updates[0].indexOf("('2026-06-03'::date,'c2',25)") !== -1, 'the canonicalized match');
  assert.ok(log.updates[0].indexOf("'c3'") === -1, 'an undecided row is not written');
  assert.ok(log.updates[1].indexOf("('2026-07-05'::date,'c''4',9)") !== -1, 'the id is SQL-escaped');
  assert.equal(out.written, 3);
  assert.equal(log.autoCommit, true, 'each chunk stands alone: a cut-short run keeps what it did');
});

test('BF-1: nothing to do is a clean no-op; Neon unreachable throws with the reason', function () {
  installRoster();
  const log = { queries: [], updates: [], ddl: [], timeouts: [] };
  h.ctx.getReachableNeonConn_ = function () { return backfillConn(log, [null, null], {}); };
  const out = h.call('backfillFirstRingFromJourney');
  assert.equal(out.candidates, 0);
  assert.equal(log.updates.length, 0);
  h.ctx.getReachableNeonConn_ = function () { return null; };
  assert.throws(function () { h.call('previewFirstRingBackfill'); }, /Neon unreachable/);
});

test('BF-1: the log’s misdial line is the dashboard’s', function () {
  const ob = fs.readFileSync(path.join(__dirname, '../../apps-script/department-dashboard/OutboundReport.gs'), 'utf8');
  const m = /var OUTBOUND_BRIEF_RING_SEC_ = (\d+);/.exec(ob);
  assert.ok(m, 'the dashboard constant moved');
  assert.equal(h.ctx.BF_RING_MISDIAL_SEC_, Number(m[1]));
});
