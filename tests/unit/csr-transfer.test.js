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
