'use strict';

// Neon read metering for the CDR REPORT project (neonEgress.js).
//
// The gap this closes was found the expensive way. When the Neon data-transfer
// quota blew a SECOND time, the dashboard's counter read ~196 MB against a
// 5 GB cap -- about 4% of the overage. The other 96% was in cdr-report and
// cdr-import, which had ZERO metering callsites between them, because Script
// Properties are per-project and the dashboard's gauge structurally cannot see
// across the boundary. A budget gauge blind to two thirds of the system turns
// every overage into an investigation instead of a lookup.
//
// Two things are pinned here:
//   1. the meter's own behaviour -- accumulation, month rollover, surface
//      capping, and the best-effort contract (it must never break a read);
//   2. COVERAGE (the C2 question, "what enforces this?") -- every Neon read in
//      cdr-report either meters or is on an explicit allowlist. Prose could
//      not keep the first version of this claim true; a tripwire can.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-report', files: ['neonEgress.js'] });

function reset() {
  Object.keys(h.state.props).forEach(function (k) { delete h.state.props[k]; });
}
function stored() {
  return JSON.parse(h.state.props.NEON_EGRESS_MTD || 'null');
}
// The meter keys on the UTC month; pin "now" so a test run near a month
// boundary cannot flake.
function atUtcMonth(y, m, fn) {
  const RealDate = h.ctx.Date;
  function FakeDate() {
    if (arguments.length === 0) return new RealDate(RealDate.UTC(y, m - 1, 15, 12, 0, 0));
    return new RealDate(...arguments);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.now = function () { return RealDate.UTC(y, m - 1, 15, 12, 0, 0); };
  h.ctx.Date = FakeDate;
  try { return fn(); } finally { h.ctx.Date = RealDate; }
}

// ── The meter ─────────────────────────────────────────────────────────────

test('reads accumulate into bytes, reads and a per-surface breakdown', function () {
  reset();
  atUtcMonth(2026, 9, function () {
    h.fn('cdrNoteEgress_')(1000, 'export:inbound');
    h.fn('cdrNoteEgress_')(500, 'export:inbound');
    h.fn('cdrNoteEgress_')(250, 'export:outbound');
  });
  const cur = stored();
  assert.equal(cur.m, '2026-09');
  assert.equal(cur.bytes, 1750);
  assert.equal(cur.reads, 3);
  assert.deepEqual(cur.by['export:inbound'], { b: 1500, r: 2 });
  assert.deepEqual(cur.by['export:outbound'], { b: 250, r: 1 });
});

test('a new UTC month RESETS the counters rather than accumulating forever', function () {
  reset();
  atUtcMonth(2026, 9, function () { h.fn('cdrNoteEgress_')(900, 'export:inbound'); });
  atUtcMonth(2026, 10, function () { h.fn('cdrNoteEgress_')(100, 'export:outbound'); });
  const cur = stored();
  assert.equal(cur.m, '2026-10');
  assert.equal(cur.bytes, 100, 'September bytes must not carry into October');
  assert.equal(cur.reads, 1);
  assert.equal(cur.by['export:inbound'], undefined);
});

test('zero and negative byte counts are ignored (no phantom reads)', function () {
  reset();
  atUtcMonth(2026, 9, function () {
    [0, -5, null, undefined, NaN, 'abc'].forEach(function (v) {
      h.fn('cdrNoteEgress_')(v, 'export:inbound');
    });
  });
  assert.equal(h.state.props.NEON_EGRESS_MTD, undefined,
    'a non-positive read must not even create the record');
});

test('surface labels are capped, and overflow lands in "other" rather than unbounded', function () {
  // The property has a size limit; an unbounded label set (say, one per date)
  // would grow the record until writes fail.
  reset();
  atUtcMonth(2026, 9, function () {
    for (let i = 0; i < 40; i++) h.fn('cdrNoteEgress_')(10, 'surface-' + i);
  });
  const cur = stored();
  assert.ok(Object.keys(cur.by).length <= 25,
    'labels grew unbounded: ' + Object.keys(cur.by).length);
  assert.ok(cur.by.other && cur.by.other.r > 0, 'overflow must fold into "other"');
  assert.equal(cur.bytes, 400, 'every read still counts toward the total');
});

test('an over-long label is truncated, not stored whole', function () {
  reset();
  atUtcMonth(2026, 9, function () {
    h.fn('cdrNoteEgress_')(10, 'x'.repeat(200));
  });
  Object.keys(stored().by).forEach(function (k) {
    assert.ok(k.length <= 24, 'label not truncated: ' + k.length);
  });
});

test('the meter NEVER throws, even when the properties store fails', function () {
  // The contract that matters most: a gauge must not be able to break the
  // read it measures. Every callsite is post-fetch and unguarded.
  reset();
  const realProps = h.ctx.PropertiesService;
  h.ctx.PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function () { throw new Error('store down'); },
        setProperty: function () { throw new Error('store down'); },
      };
    },
  };
  assert.doesNotThrow(function () { h.fn('cdrNoteEgress_')(100, 'export:inbound'); });
  h.ctx.PropertiesService = realProps;
});

test('a corrupt stored record is replaced, not propagated', function () {
  reset();
  h.state.props.NEON_EGRESS_MTD = '{not json';
  atUtcMonth(2026, 9, function () { h.fn('cdrNoteEgress_')(42, 'export:inbound'); });
  const cur = stored();
  assert.equal(cur.bytes, 42);
  assert.equal(cur.m, '2026-09');
});

// ── The reader ────────────────────────────────────────────────────────────

test('the reader ranks surfaces busiest-first', function () {
  reset();
  atUtcMonth(2026, 9, function () {
    h.fn('cdrNoteEgress_')(100, 'small');
    h.fn('cdrNoteEgress_')(9000, 'huge');
    h.fn('cdrNoteEgress_')(500, 'mid');
    const out = h.fn('cdrReadEgress_')();
    assert.equal(out.bytes, 9600);
    // out.top is built inside the vm realm, so .map yields a vm array --
    // assert/strict compares prototypes and fails on identical contents.
    deepEqual(out.top.map(function (t) { return t.label; }), ['huge', 'mid', 'small'],
      'the ranking is the whole point -- reduction starts from evidence');
  });
});

test('a FROZEN record from an earlier month reads as zero AND says so', function () {
  // The exact shape the real investigation hit: reads stopped (outage /
  // read-source flip), so the record sat frozen at an old month. Reporting
  // last month's total as if it were this month's would have been worse than
  // useless -- but silently zeroing hides that reads stopped at all.
  reset();
  atUtcMonth(2026, 8, function () { h.fn('cdrNoteEgress_')(5000, 'export:inbound'); });
  atUtcMonth(2026, 9, function () {
    const out = h.fn('cdrReadEgress_')();
    assert.equal(out.bytes, 0);
    assert.equal(out.reads, 0);
    assert.equal(out.staleMonth, '2026-08', 'a frozen counter is itself a finding');
  });
});

test('the reader survives an absent or corrupt record', function () {
  reset();
  atUtcMonth(2026, 9, function () {
    assert.equal(h.fn('cdrReadEgress_')().bytes, 0);
    h.state.props.NEON_EGRESS_MTD = 'garbage';
    assert.equal(h.fn('cdrReadEgress_')().bytes, 0);
  });
});

// ── Coverage tripwire (C2: what enforces this?) ───────────────────────────

// Neon reads that legitimately carry no meaningful payload. Each entry is a
// FILE:REASON pair so adding one is a deliberate, reviewable act.
const UNMETERED_ALLOWED = {
  'dbHistorical.js': 'testConnection() probe -- SELECT current_database(), now()',
  'neonbackfill.js': 'COUNT(*) verification reads + a write-path id subselect',
  // INV-16: neonWrite.js is byte-identical across cdr-report and cdr-import.
  // Instrumenting it here alone would break check-duplicated-files.sh, and its
  // one read is a parent-id subselect inside a write transaction.
  'neonWrite.js': 'INV-16 duplicated pair; write-path id subselect only',
  // The existence probe (to_regclass) is unmetered; the payload read in the
  // same file IS metered, which the assertion below verifies separately.
};

test('coverage: every Neon-reading file in cdr-report meters or is allowlisted', function () {
  const dir = path.join(__dirname, '..', '..', 'apps-script', 'cdr-report');
  const offenders = [];
  fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); }).forEach(function (f) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (src.indexOf('executeQuery') === -1) return;          // not a reader
    if (src.indexOf('cdrNoteEgress_(') !== -1) return;        // metered
    if (Object.prototype.hasOwnProperty.call(UNMETERED_ALLOWED, f)) return;
    offenders.push(f);
  });
  assert.deepEqual(offenders, [],
    'a cdr-report file reads from Neon but never calls cdrNoteEgress_. That is '
    + 'how the transfer cap blew twice with nothing to point at: the dashboard '
    + 'gauge cannot see this project. Meter the read, or add the file to '
    + 'UNMETERED_ALLOWED with the reason its reads carry no payload.');
});

test('coverage: the two DAILY export triggers are metered (the largest readers)', function () {
  // Named explicitly rather than left to the sweep above: these two run on a
  // schedule and json_agg a whole window, so they are the ones most likely to
  // dominate a month -- and the ones a future refactor could silently drop.
  ['inboundCallsExport.js', 'outboundCallsExport.js'].forEach(function (f) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps-script', 'cdr-report', f), 'utf8');
    assert.ok(/cdrNoteEgress_\(\s*json/.test(src),
      f + ' must meter its json_agg payload read');
  });
});

test('coverage: the allowlist has no stale entries', function () {
  // A file that stopped reading from Neon, or started metering, should leave
  // the allowlist -- otherwise it silently exempts a future reader.
  const dir = path.join(__dirname, '..', '..', 'apps-script', 'cdr-report');
  const stale = Object.keys(UNMETERED_ALLOWED).filter(function (f) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return true;
    const src = fs.readFileSync(p, 'utf8');
    return src.indexOf('executeQuery') === -1 || src.indexOf('cdrNoteEgress_(') !== -1;
  });
  assert.deepEqual(stale, [],
    'UNMETERED_ALLOWED names a file that no longer needs the exemption');
});
