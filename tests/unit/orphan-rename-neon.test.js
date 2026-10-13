'use strict';

// S2B-3 / S2B-4 (broad-scan 2026-09-23, Batch 8): the ORDER of the rename's
// side effects, and the retry of a failed Neon mirror.
//
// S2B-3: the audit row used to be appended AFTER the Neon mirror. The mirror
// opens a connection that can hang past the execution ceiling, and a kill skips
// every catch -- so the irreversible sheet rename could land with no audit row.
// The row now lands first, and the Neon outcome follows as its own append-only
// `neon-rename` row (INV-47: nothing is overwritten).
//
// S2B-4: a failed Neon mirror leaves the sheet renamed and Neon not; with
// DQE_READ_SOURCE=neon the orphan is still listed, the admin retries, and the
// retry threw "No rows in DQE Historical Data" before it ever reached Neon.
// It is now a Neon-only retry.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'OrphanFix.gs'] });

function install(opts) {
  const events = [];
  h.state.props.NEON_HOST = opts.neon ? 'h' : undefined;
  if (!opts.neon) delete h.state.props.NEON_HOST;
  Object.assign(h.ctx, {
    assertAdmin_: function () {},
    assertOnSomeRoster_: function () {},
    assertNotOnAnyRoster_: function () {},
    assertOrphanFixLogExists_: function () {},
    renameHistoricalAgent_: function (f, t, out) {
      events.push('sheet-rename');
      if (out) out.collisionDates = (opts.collisions || []).slice();   // PC-4
      return opts.sheetRows;
    },
    upsertAgentAlias_: function () { events.push('alias'); },
    renameAgentInNeon_: function () { events.push('neon'); return opts.neonResult; },
    appendOrphanFixLog_: function (rec) { events.push('log:' + rec.action + ':' + (rec.notes || '')); },
    bustOrphanFixCache_: function () {},
    overviewCacheKey_: function () { return 'k'; },
    readAgentAliases_: function () { return []; },
    readOrphanFixLog_: function () { return []; },
  });
  return events;
}

const REQ = { fromName: 'Ann Orphan', toName: 'Ann (Annie) Roster' };

test('S2B-3: the audit row lands BEFORE the Neon mirror; the outcome follows as a neon-rename row', function () {
  const ev = install({ neon: true, sheetRows: 4, neonResult: { renamed: 4, skipped: 0 } });
  const res = h.call('applyOrphanRename', REQ);
  assert.equal(res.renamed, 4);
  assert.equal(res.neonRenamed, 4);
  const iLog = ev.findIndex(function (e) { return e.indexOf('log:rename:') === 0; });
  const iNeon = ev.indexOf('neon');
  assert.ok(iLog !== -1 && iNeon !== -1 && iLog < iNeon,
    'the rename audit row must be written before Neon is dialled: ' + JSON.stringify(ev));
  assert.match(ev[iLog], /Neon: mirror follows/);
  assert.ok(ev.some(function (e) { return e === 'log:neon-rename:Neon: 4 renamed'; }), JSON.stringify(ev));
});

test('S2B-3: a FAILED mirror is audited too, with the retry instruction', function () {
  const ev = install({ neon: true, sheetRows: 2, neonResult: null });
  h.call('applyOrphanRename', REQ);
  assert.ok(ev.some(function (e) { return /^log:neon-rename:Neon: write failed .* re-run the same rename/.test(e); }),
    JSON.stringify(ev));
});

test('S2B-3: without Neon configured there is no neon-rename row', function () {
  const ev = install({ neon: false, sheetRows: 2, neonResult: null });
  h.call('applyOrphanRename', REQ);
  assert.ok(!ev.some(function (e) { return e.indexOf('log:neon-rename') === 0; }), JSON.stringify(ev));
});

test('S2B-4: nothing left on the sheet but rows left in Neon -> a Neon-only retry, audited', function () {
  const ev = install({ neon: true, sheetRows: 0, neonResult: { renamed: 3, skipped: 1 } });
  const res = h.call('applyOrphanRename', REQ);
  assert.equal(res.renamed, 0);
  assert.equal(res.neonRenamed, 3);
  assert.equal(res.neonSkipped, 1);
  assert.ok(ev.some(function (e) { return e === 'log:neon-rename:Neon retry: 3 renamed, 1 conflict-skipped'; }),
    JSON.stringify(ev));
});

test('S2B-4: nothing on either side is still the original error', function () {
  install({ neon: true, sheetRows: 0, neonResult: { renamed: 0, skipped: 0 } });
  assert.throws(function () { h.call('applyOrphanRename', REQ); }, /No rows in DQE Historical Data/);
  install({ neon: false, sheetRows: 0, neonResult: null });
  assert.throws(function () { h.call('applyOrphanRename', REQ); }, /No rows in DQE Historical Data/);
  install({ neon: true, sheetRows: 0, neonResult: null });
  assert.throws(function () { h.call('applyOrphanRename', REQ); }, /could not be reached either/);
});

test('S2B-3: the Neon rename rides the shared connection and bounds its statements', function () {
  const src = fs.readFileSync(path.join(__dirname, '../../apps-script/department-dashboard/OrphanFix.gs'), 'utf8');
  const fn = src.slice(src.indexOf('function renameAgentInNeon_('), src.indexOf('function upsertAgentAlias_'));
  assert.match(fn, /conn = getDashboardNeonConn_\(\);/, 'the shared, down-memoized connection');
  assert.ok(!/Jdbc\.getConnection/.test(fn), 'no private JDBC connection');
  assert.equal((fn.match(/setQueryTimeout\(ORPHAN_NEON_STMT_TIMEOUT_S_\)/g) || []).length, 2, 'both statements bounded');
});

// PC-4 (broad-scan 2026-10-12, owner: skip collisions + warn). Days on which
// the target agent already has a row stay under the orphan's name on BOTH
// stores; the result names them and every audit row says so.
test('PC-4: a rename that skipped colliding days returns them and names them in the audit row', function () {
  const ev = install({ neon: true, sheetRows: 4, collisions: ['2026-09-02', '2026-09-03'],
                       neonResult: { renamed: 4, skipped: 2 } });
  const res = h.call('applyOrphanRename', REQ);
  assert.equal(res.renamed, 4);
  assert.deepEqual(Array.from(res.collisionDates), ['2026-09-02', '2026-09-03']);
  assert.ok(ev.some(function (e) {
    return /^log:rename:.*2 day\(s\) left under "Ann Orphan" because "Ann \(Annie\) Roster" already has a row that day .*repairDqeDuplicateMerge.*2026-09-02, 2026-09-03/.test(e);
  }), JSON.stringify(ev));
});

test('PC-4: when only colliding days remain, the retry explains instead of throwing or logging "0 renamed"', function () {
  const ev = install({ neon: true, sheetRows: 0, collisions: ['2026-09-02'], neonResult: { renamed: 0, skipped: 1 } });
  const realOpen = h.ctx.openSpreadsheet_;
  h.ctx.openSpreadsheet_ = function () { return { getSheetByName: function () { return {}; } }; };   // the alias-sheet pre-flight
  let res;
  try { res = h.call('applyOrphanRename', Object.assign({ alsoAddAlias: true }, REQ)); }
  finally { h.ctx.openSpreadsheet_ = realOpen; }
  assert.equal(res.renamed, 0);
  assert.deepEqual(Array.from(res.collisionDates), ['2026-09-02']);
  assert.ok(!ev.some(function (e) { return e.indexOf('log:neon-rename') === 0; }), 'no misleading "0 renamed" row');
  assert.ok(ev.some(function (e) { return /^log:alias-add:.*left under "Ann Orphan"/.test(e); }),
    'the alias write is audited with the collision note: ' + JSON.stringify(ev));
  // Without an alias nothing changed anywhere: no row at all, still no throw.
  const ev2 = install({ neon: false, sheetRows: 0, collisions: ['2026-09-02'], neonResult: null });
  assert.doesNotThrow(function () { h.call('applyOrphanRename', REQ); });
  assert.ok(!ev2.some(function (e) { return e.indexOf('log:') === 0; }), JSON.stringify(ev2));
});
