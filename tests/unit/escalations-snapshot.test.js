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
    { pending: 1, in_progress: 1, pending_review: 0, resolved: 0, rejected: 0, removed: 0 },
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

// PCR-8 (broad-scan 2026-09-23): only the delete (2a) force-refreshed the
// snapshot; every other committed write left it up to the refresh window
// stale, so an outage in that window served a just-resolved row as open.
test('PCR-8: every committed escalation write force-refreshes the snapshot, past the age gate', function () {
  h.state.props = {};
  seedSnapshot_();   // fresh: the age gate alone would skip the refresh
  const calls = [];
  const conn = {
    setAutoCommit: function (v) { calls.push('autocommit:' + v); },
    prepareStatement: function () {
      calls.push('query');
      return { setString: function () {}, executeQuery: function () {
        return { next: function () { return true; },
                 getString: function () { return JSON.stringify([row('n1', 'CSR', 'pending')]); }, close: function () {} };
      }, close: function () {} };
    },
  };
  h.call('escSnapshotAfterWrite_', conn);
  // ESC-S1: the second query re-reads the open rows' activity threads.
  assert.deepEqual(calls, ['autocommit:true', 'query', 'query'], 'leaves the transaction, then re-reads despite the fresh snapshot');
  assert.equal(h.call('escSnapshotLoad_').rows[0].id, 'n1', 'the snapshot now holds the post-write open set');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'Escalations.gs'), 'utf8');
  ['createEscalation', 'updateEscalation', 'moveEscalation', 'linkEscalationDepartment', 'removeEscalationDepartment', 'restoreEscalationDepartment',
   'resolveEscalation', 'reopenEscalation', 'startEscalation',
   'approveEscalation', 'rejectEscalation', 'updateEscalationComment'].forEach(function (fn) {
    assert.match(src, new RegExp("conn\\.commit\\(\\);\\n    Logger\\.log\\('" + fn + ": [^\\n]*\\n    escSnapshotAfterWrite_\\(conn\\);"),
      fn + ' refreshes the snapshot right after its commit');
  });
});

// ── ESC-S1 (2026-09-30, owner ask): the OFFLINE THREAD ─────────────────────
// The open rows' activity threads ride beside the rows snapshot, so Activity
// still opens (read-only) while Neon is down -- authorized exactly like the
// live path, a thread stored whole or not at all.

function act(e, g, action, detail, dept, removed, cut) {
  return { e: e, g: g, action: action, actor: 'm@x.com', at: '2026-08-18 10:00:00',
           detail: detail, cut: !!cut, department: dept, removed: !!removed };
}

test('ESC-S1: escSnapshotActPack_ keys a linked thread by group (dept-tagged) and a standalone one by id, once each', function () {
  const rows = [Object.assign(row('c1', 'CSR', 'pending'), { group_id: 'g1' }), row('c2', 'CSR', 'pending'),
                Object.assign(row('s1', 'Sales', 'pending'), { group_id: 'g1' })];
  const p = h.ctx.escSnapshotActPack_(rows, [
    act('c1', 'g1', 'created', 'r', 'CSR'), act('s1', 'g1', 'comment', 'not ours', 'Sales', true, true),
    act('c2', null, 'created', 'r2', 'CSR'), act('zz', null, 'created', 'not in the snapshot', 'CSR'),
  ]);
  const t = JSON.parse(JSON.stringify(p.threads));
  assert.deepEqual(Object.keys(t).sort(), ['c2', 'g1'], 'one entry per thread; strays dropped');
  assert.equal(t.g1.length, 2);
  assert.deepEqual(t.g1[1], { a: 'comment', u: 'm@x.com', t: '2026-08-18 10:00:00', d: 'not ours', c: 1, dp: 'Sales', r: 1 });
  assert.equal(t.c2[0].dp, null, 'a standalone thread carries no department tag');
  assert.equal(p.count, 2);
  assert.equal(p.truncated, false);
});

test('ESC-S1: a thread that would pass the ceiling is skipped WHOLE and the pack is flagged truncated', function () {
  const big = new Array(600).join('x');
  const rows = [], entries = [];
  for (let i = 0; i < 150; i++) {
    rows.push(row('r' + i, 'CSR', 'pending'));
    entries.push(act('r' + i, null, 'comment', big, 'CSR'));
  }
  const p = h.ctx.escSnapshotActPack_(rows, entries);
  assert.equal(p.truncated, true);
  assert.ok(p.count > 0 && p.count < 150);
  // ESC-D6: the budget is BYTES (UTF-8), the per-property cap's own unit.
  assert.ok(Buffer.byteLength(JSON.stringify(p.threads), 'utf8') <= h.ctx.ESC_SNAPSHOT_CHUNK_BYTES * h.ctx.ESC_SNAPSHOT_ACT_MAX_CHUNKS);
  assert.ok(Object.keys(p.threads).indexOf('r0') !== -1, 'newest rows kept first');
  Object.keys(p.threads).forEach(function (k) { assert.equal(p.threads[k].length, 1, 'never a partial thread'); });
});

test('ESC-S1: the refresh reads standalone threads by id and linked ones by group, detail capped, in one query', function () {
  h.state.props = {};
  const seen = [];
  const conn = { prepareStatement: function (sql) {
    const params = [];
    seen.push({ sql: sql, params: params });
    return { setString: function (i, v) { params[i - 1] = v; }, executeQuery: function () {
      return { next: function () { return true; },
               getString: function () { return JSON.stringify([act('c1', null, 'created', 'r', 'CSR')]); }, close: function () {} };
    }, close: function () {} };
  } };
  h.call('escSnapshotActRefresh_', conn, [row('c1', 'CSR', 'pending'), Object.assign(row('s1', 'Sales', 'pending'), { group_id: 'g1' })]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /\(e\.group_id IS NULL AND a\.escalation_id IN \(\?\)\) OR e\.group_id IN \(\?\)/);
  assert.match(seen[0].sql, /left\(a\.detail, 600\)/);
  assert.deepEqual(seen[0].params, ['c1', 'g1']);
  const loaded = h.call('escSnapshotActLoad_');
  assert.ok(loaded && loaded.at);
  assert.equal(loaded.threads.c1.length, 1);
});

test('ESC-S1: with Neon DOWN, Activity serves the offline thread under the SAME row gate; misses keep the unavailable shape', function () {
  installUser_();   // CSR manager
  h.state.props = {};
  h.call('escSnapshotStore_', [Object.assign(row('c1', 'CSR', 'pending'), { group_id: 'g1' }), row('s1', 'Sales', 'pending'),
                                row('c9', 'CSR', 'pending')]);
  h.call('escSnapshotActStore_', h.ctx.escSnapshotActPack_([Object.assign(row('c1', 'CSR', 'pending'), { group_id: 'g1' }), row('s1', 'Sales', 'pending')], [
    act('c1', 'g1', 'created', 'r', 'CSR'), act('x2', 'g1', 'comment', 'long…', 'Power', true, true), act('s1', null, 'created', 'r', 'Sales'),
  ]));
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  const ok = JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 'c1' })));
  assert.equal(ok.available, true);
  assert.equal(ok.linked, true);
  assert.ok(ok.snapshotAsOf);
  assert.deepEqual(ok.rows[1], { action: 'comment', actor: 'm@x.com', at: '2026-08-18 10:00:00', detail: 'long…',
                                  shortened: true, department: 'Power', removed: true });
  // ESC-D5: another dept's row and an id the snapshot does not hold return the
  // SAME shape -- offline, existence in another dept must not be detectable (L9).
  const denied = JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 's1' })));
  const missing = JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 'nope' })));
  assert.deepEqual(missing, { available: false, rows: [] });
  assert.deepEqual(denied, missing, 'a denial is indistinguishable from not-found on the offline path');
  // A snapshotted row whose thread did not fit: unavailable + snapshotMissing.
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 'c9' }))), { available: false, rows: [], snapshotMissing: true });
  // A MID-QUERY death serves it too.
  h.ctx.getDashboardNeonConn_ = function () {
    return { prepareStatement: function () { throw new Error('connection reset'); },
             createStatement: function () { throw new Error('connection reset'); }, close: function () {} };
  };
  h.ctx.escEnsureTable_ = function () {};
  assert.equal(JSON.parse(JSON.stringify(h.call('getEscalationActivity', { id: 'c1' }))).snapshotAsOf, ok.snapshotAsOf);
});

// ESC-D6 (broad-scan 2026-10-01): the ~9KB per-property cap is BYTES. Chunks
// were cut at 8000 CHARACTERS, so multi-byte content (accented names, emoji in
// a comment) produced over-cap values -- and the failed setProperty vanished in
// an empty catch.
test('ESC-D6: chunks are cut by UTF-8 bytes, never split a surrogate pair, and round-trip', function () {
  const chunk = h.ctx.escChunkUtf8_;
  const s1 = 'a' + '\u00e9'.repeat(10) + '\ud83d\ude00'.repeat(5) + 'z';
  const parts = Array.from(chunk(s1, 7));
  assert.equal(parts.join(''), s1, 'lossless');
  parts.forEach(function (p) {
    assert.ok(Buffer.byteLength(p, 'utf8') <= 7, 'every piece within the byte cap');
    assert.ok(!/[\ud800-\udbff]$/.test(p), 'no piece ends on a lone high surrogate');
  });
  assert.equal(h.ctx.escUtf8Len_(s1), Buffer.byteLength(s1, 'utf8'));
  assert.deepEqual(Array.from(chunk('', 10)), []);
});

test('ESC-D6: a multi-byte snapshot stays under the cap per property and still loads', function () {
  h.state.props = {};
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const r = row('m' + i, 'CSR', 'pending');
    r.reason = '\u00e9\u00e8\u00ea\ud83d\ude00'.repeat(120);   // ~1.7KB of UTF-8, ~600 chars
    rows.push(r);
  }
  const packed = h.ctx.escSnapshotChunk_(rows);
  packed.chunks.forEach(function (c) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= 8000, 'pre-ESC-D6 an 8000-CHAR chunk of this was ~20KB');
  });
  assert.ok(packed.chunks.length <= h.ctx.ESC_SNAPSHOT_MAX_CHUNKS);
  h.call('escSnapshotStore_', rows);
  const loaded = JSON.parse(JSON.stringify(h.call('escSnapshotLoad_')));
  assert.equal(loaded.rows.length, packed.count);
  assert.equal(loaded.rows[0].reason, rows[0].reason);
});

test('ESC-D6: a failed property write is LOGGED, not swallowed', function () {
  const lines = [];
  const realLogger = h.ctx.Logger, realProps = h.ctx.PropertiesService;
  h.ctx.Logger = { log: function (m) { lines.push(String(m)); } };
  h.ctx.PropertiesService = { getScriptProperties: function () {
    return { setProperty: function () { throw new Error('Argument too large: value'); },
             deleteProperty: function () {}, getProperty: function () { return null; } };
  } };
  try {
    h.call('escSnapshotStore_', [row('a', 'CSR', 'pending')]);
    h.call('escSnapshotActStore_', { threads: { a: [] }, count: 1 });
  } finally { h.ctx.Logger = realLogger; h.ctx.PropertiesService = realProps; }
  assert.ok(lines.some(function (l) { return /escSnapshotStore_: snapshot NOT stored: Argument too large/.test(l); }));
  assert.ok(lines.some(function (l) { return /escSnapshotActStore_: threads NOT stored/.test(l); }));
});
