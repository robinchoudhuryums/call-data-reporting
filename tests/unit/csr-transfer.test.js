'use strict';

// Pins the CSR-transfer dedup KEY (the fix for the fan-out over-count, where a
// single transfer to a queue that rings N agents was counted N times). The
// per-agent count now dedups by ROOT call id = parent-call id (col O / idx 14)
// when present, else call id (col A / idx 0). calcCsrReport itself is
// sheet-coupled (reads QCDR Output + the csr_team named range), so it's
// validated by the 06/22 re-run + repairCsrTransferForRawDataDate; this test
// pins the key logic that determines whether fan-out legs collapse.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
const rootId = h.fn('csrRootCallId_');
const guard = h.fn('csrTransferGuardFindings_');

// Raw Data row: idx 0 = CALL_ID, idx 14 = PARENT_CALL.
function row(callId, parent) {
  const r = new Array(26).fill('');
  r[0] = callId; r[14] = parent;
  return r;
}

test('root id uses the parent-call id when present', function () {
  assert.equal(rootId(row('LEG1', 'CALL99')), 'CALL99');
  assert.equal(rootId(row('LEG2', 'CALL99')), 'CALL99');   // sibling leg -> same root
});

test('root id falls back to the call id when parent is N/A or blank', function () {
  assert.equal(rootId(row('CALL5', 'N/A')), 'CALL5');
  assert.equal(rootId(row('CALL6', '')), 'CALL6');
  assert.equal(rootId(row('CALL7', 'n/a')), 'CALL7');   // case-insensitive N/A
});

test('fan-out legs of one transfer collapse to a single root id', function () {
  // One call CALL99 that rang 3 queue agents -> 3 legs, all share the parent.
  const legs = [row('L1', 'CALL99'), row('L2', 'CALL99'), row('L3', 'CALL99')];
  const distinct = new Set(legs.map(rootId));
  assert.equal(distinct.size, 1, 'three fan-out legs => one counted transfer');
});

test('genuinely separate transfers keep distinct root ids', function () {
  const calls = [row('A1', 'N/A'), row('B1', 'N/A'), row('C1', 'CALLX')];
  assert.equal(new Set(calls.map(rootId)).size, 3);
});

// csrTransferGuardFindings_ is the standing tripwire (C): it flags a likely
// fan-out RE-inflation at write time (Transferred >> Total Calls), without
// failing the import. Batch row: [month, week, date, agent, transPct,
// totalCalls, transferred, ...11 queues] -> agent=3, totalCalls=5, transferred=6.
function csrRow(agent, totalCalls, transferred) {
  const r = new Array(18).fill(0);
  r[3] = agent; r[5] = totalCalls; r[6] = transferred;
  return r;
}

test('guard flags gross fan-out inflation (Transferred >> Total Calls)', function () {
  // 22 transfers vs 4 answered talk-calls -> the exact 06/22 Camila/Field Ops shape.
  const found = guard([csrRow('Camila', 4, 22)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].agent, 'Camila');
  assert.equal(found[0].transferred, 22);
});

test('guard is quiet on a normal day (high but plausible Trans %)', function () {
  // Transferred can legitimately exceed Total Calls (different populations);
  // the guard only trips on GROSS inflation, so 9 vs 5 stays quiet.
  assert.equal(guard([csrRow('Ana', 5, 9)]).length, 0);
  // Below the absolute floor (10) never trips, even at a high ratio.
  assert.equal(guard([csrRow('Bob', 1, 7)]).length, 0);
  // Zero-transfer rows are quiet.
  assert.equal(guard([csrRow('Cy', 12, 0)]).length, 0);
});

test('guard returns every offending row and respects opts', function () {
  const batch = [csrRow('A', 2, 30), csrRow('B', 10, 12), csrRow('C', 1, 40)];
  // Default ratio 3 / floor 10: A (30>3*2) and C (40>3*1) trip; B (12 !> 30) doesn't.
  assert.equal(guard(batch).length, 2);
  // Tighter floor still excludes plausible B, includes the two gross rows.
  // join to a primitive -- the harness returns a vm-realm array whose
  // prototype differs from a host literal, which deepStrictEqual rejects.
  assert.equal(guard(batch, { ratio: 3, floor: 10 }).map(g => g.agent).sort().join(','), 'A,C');
});
