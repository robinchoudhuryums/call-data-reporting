'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// E2 (broad-scan Batch E): the escalations OUTAGE SNAPSHOT. During the
// 2026-08 Neon transfer-cap outage the whole worklist — a 100% Neon-backed
// surface with no sheet twin, by owner ruling — was invisible for two weeks,
// including read-only viewing. getEscalations now stores the OPEN rows in
// chunked Script Properties after successful reads and serves them back,
// viewer-scoped, when Neon is unreachable. Writes still hard-fail (INV-55
// untouched): a snapshot cannot drift while the only writer is down.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Escalations.gs'] });

function row(id, dept, status, occurredAt) {
  return { id: id, department: dept, status: status,
           occurred_at: occurredAt || '2026-08-18 10:00:00', caller: 'c',
           patient_name: 'p', trx: 't', area: 'a', reason: 'r',
           resolution: null, comments: null, created_by: 'x@x.com',
           created_at: '2026-08-18 10:00:00', resolved_by: null,
           resolved_at: null, source: 'admin' };
}

// ── The pure chunker ────────────────────────────────────────────────────────

test('E2: escSnapshotChunk_ splits at the property-size boundary and drops TAIL rows past the ceiling', function () {
  const small = h.ctx.escSnapshotChunk_([row('a', 'CSR', 'pending')]);
  assert.equal(small.chunks.length, 1);
  assert.equal(small.count, 1);
  assert.equal(small.truncated, false);
  assert.deepEqual(JSON.parse(small.chunks.join('')), [row('a', 'CSR', 'pending')]);

  // Rows fat enough that 150 of them cannot fit 6×8000 chars: the chunker
  // must drop from the TAIL (oldest — the list is newest-first) until it
  // fits, flag truncated, and never emit a chunk over the cap.
  const fat = [];
  for (let i = 0; i < 150; i++) {
    const r = row('id' + i, 'CSR', 'pending');
    r.reason = new Array(400).join('x');   // ~400B each → ~60KB total
    fat.push(r);
  }
  const packed = h.ctx.escSnapshotChunk_(fat);
  assert.equal(packed.truncated, true);
  assert.ok(packed.count < 150, 'tail rows dropped to fit');
  packed.chunks.forEach(function (c) { assert.ok(c.length <= 8000); });
  const round = JSON.parse(packed.chunks.join(''));
  assert.equal(round[0].id, 'id0', 'newest rows survive; the tail is what goes');
  assert.equal(round.length, packed.count);
});

test('E2: store → load round-trips through chunked properties; a torn write reads as ABSENT', function () {
  h.state.props = {};
  const rows = [row('a', 'CSR', 'pending'), row('b', 'Sales', 'in_progress')];
  h.call('escSnapshotStore_', rows);
  assert.ok(h.state.props.ESC_SNAPSHOT_META, 'meta written');
  const loaded = JSON.parse(JSON.stringify(h.call('escSnapshotLoad_')));
  assert.deepEqual(loaded.rows, rows);
  assert.ok(loaded.at, 'carries the as-of timestamp');

  // Torn write: meta says 1 chunk but the chunk is gone → null, never a
  // half-parsed list served to a manager.
  delete h.state.props.ESC_SNAPSHOT_1;
  assert.equal(h.call('escSnapshotLoad_'), null);
});

test('E2: a SHRINKING snapshot deletes the stale higher chunks before re-pointing meta', function () {
  h.state.props = {};
  // Big first store (multiple chunks)...
  const fat = [];
  for (let i = 0; i < 60; i++) { const r = row('id' + i, 'CSR', 'pending'); r.reason = new Array(300).join('y'); fat.push(r); }
  h.call('escSnapshotStore_', fat);
  assert.ok(h.state.props.ESC_SNAPSHOT_2, 'first store spans 2+ chunks');
  // ...then a small one: chunk 2 must not survive to poison a future read.
  h.call('escSnapshotStore_', [row('a', 'CSR', 'pending')]);
  assert.equal(h.state.props.ESC_SNAPSHOT_2, undefined, 'stale chunk deleted');
  assert.equal(JSON.parse(JSON.stringify(h.call('escSnapshotLoad_'))).rows.length, 1);
});

// ── The scoped serve ────────────────────────────────────────────────────────

function seedSnapshot_() {
  h.state.props = {};
  h.call('escSnapshotStore_', [
    row('c1', 'CSR', 'pending', '2026-08-18 09:00:00'),
    row('c2', 'CSR', 'in_progress', '2026-08-17 09:00:00'),
    row('s1', 'Sales', 'pending', '2026-08-16 09:00:00'),
    row('s2', 'Sales', 'pending_review', '2026-08-18 11:00:00'),
  ]);
}

test('E2: the serve path re-applies the viewer scope — a single-dept manager sees ONLY their dept', function () {
  seedSnapshot_();
  const out = JSON.parse(JSON.stringify(
    h.call('escSnapshotServe_', false, null, 'CSR', 'pending', 'CSR')));
  assert.deepEqual(out.rows.map(function (r) { return r.id; }), ['c1'],
    'status filter AND dept scope both applied');
  assert.deepEqual(out.meta.statusCounts,
    { pending: 1, in_progress: 1, pending_review: 0, resolved: 0, rejected: 0 },
    'band counts come from the dept-scoped OPEN rows; closed states are unknowable → 0');
  assert.ok(out.meta.snapshotAsOf, 'the banner key is set');
  assert.equal(out.available, true);
});

test('E2: scopeAll and a multi-dept list scope correctly; status=all returns every open row in scope', function () {
  seedSnapshot_();
  const all = JSON.parse(JSON.stringify(
    h.call('escSnapshotServe_', true, null, null, 'all', 'ALL')));
  assert.equal(all.rows.length, 4);
  const multi = JSON.parse(JSON.stringify(
    h.call('escSnapshotServe_', false, ['Sales'], null, 'all', 'Sales')));
  assert.deepEqual(multi.rows.map(function (r) { return r.id; }).sort(), ['s1', 's2']);
});

test('E2: requesting a CLOSED status against a snapshot serves an empty list, not a lie', function () {
  seedSnapshot_();
  const out = JSON.parse(JSON.stringify(
    h.call('escSnapshotServe_', true, null, null, 'resolved', 'ALL')));
  assert.deepEqual(out.rows, [], 'resolved history is not in the snapshot');
  assert.ok(out.meta.snapshotAsOf, 'the banner still explains why');
});

test('E2: no snapshot stored → serve returns null (caller falls back to plain unavailable)', function () {
  h.state.props = {};
  assert.equal(h.call('escSnapshotServe_', true, null, null, 'pending', 'ALL'), null);
});

// ── getEscalations end to end ───────────────────────────────────────────────

function installUser_() {
  h.state.userEmail = 'boss@x.com';
  h.ctx.resolveUser_ = function () {
    return { email: 'boss@x.com', role: 'manager', department: 'CSR',
             departments: ['CSR'], allDepts: false };
  };
  h.ctx.assertDeptAccess_ = function () {};
  h.ctx.logReportUsage_ = function () {};
}

test('E2: getEscalations serves the scoped snapshot when Neon is UNREACHABLE, flagged as such', function () {
  installUser_();
  seedSnapshot_();
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // outage
  const out = JSON.parse(JSON.stringify(h.call('getEscalations', { status: 'pending' })));
  assert.equal(out.available, true, 'the worklist renders instead of the unavailable state');
  assert.deepEqual(out.rows.map(function (r) { return r.id; }), ['c1']);
  assert.ok(out.meta.snapshotAsOf);
});

test('E2: with NO snapshot, the unreachable path keeps the pre-E2 unavailable shape exactly', function () {
  installUser_();
  h.state.props = {};
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  const out = JSON.parse(JSON.stringify(h.call('getEscalations', { status: 'pending' })));
  assert.equal(out.available, false);
  assert.deepEqual(out.rows, []);
});

test('E2: a MID-QUERY Neon death serves the snapshot too (conn opened, then died)', function () {
  installUser_();
  seedSnapshot_();
  h.ctx.getDashboardNeonConn_ = function () {
    return { prepareStatement: function () { throw new Error('connection reset'); },
             createStatement: function () { throw new Error('connection reset'); },
             close: function () {} };
  };
  h.ctx.escEnsureTable_ = function () {};   // table DDL is not what died here
  const out = JSON.parse(JSON.stringify(h.call('getEscalations', { status: 'pending' })));
  assert.equal(out.available, true);
  assert.ok(out.meta.snapshotAsOf);
});

test('E2: the refresh is AGE-GATED — a fresh snapshot does not re-query on every list load', function () {
  h.state.props = {};
  seedSnapshot_();   // stores with at = now
  let queries = 0;
  const conn = { prepareStatement: function () {
    queries++;
    return { setString: function () {}, executeQuery: function () {
      return { next: function () { return true; },
               getString: function () { return '[]'; }, close: function () {} };
    }, close: function () {} };
  } };
  h.call('escSnapshotMaybeRefresh_', conn);
  assert.equal(queries, 0, 'a snapshot younger than the refresh window is left alone');
  // Age it past the window → the refresh runs and re-stamps.
  const meta = JSON.parse(h.state.props.ESC_SNAPSHOT_META);
  meta.at = '2026-08-01T00:00:00.000Z';
  h.state.props.ESC_SNAPSHOT_META = JSON.stringify(meta);
  h.call('escSnapshotMaybeRefresh_', conn);
  assert.equal(queries, 1, 'a stale snapshot refreshes');
  assert.notEqual(JSON.parse(h.state.props.ESC_SNAPSHOT_META).at, '2026-08-01T00:00:00.000Z');
});
