'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// T-1: the duplicate-row merge (mergeDqeDuplicateRows_, sheetRepairs.js) must
// preserve the F-2 AD/AE/AF positional-pairing contract: one merged,
// chronologically-sorted paired list + unpaired parent ids appended to AD
// only. The old per-row concatenation mispaired every AF timestamp after the
// first row's unpaired AD append -- the "↳ path" journey drill then opened a
// DIFFERENT caller's journey on merged rows.
// sheetRepairs.js needs parseDateForNeon (neonWrite.js, same project).
const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'sheetRepairs.js'] });

function dqeRow(date, agent, over) {
  // 34 cols: A month, B date, C agent, D exts, E-J numerics, K-AC slots (19),
  // AD/AE/AF (30-32 -> idx 29-31), AG/AH.
  const r = new Array(34).fill('');
  r[0] = 'June, 26'; r[1] = date; r[2] = agent; r[3] = '103';
  r[4] = '1'; r[5] = '2'; r[6] = '1'; r[7] = '1'; r[8] = '0:10:00'; r[9] = '0:05:00';
  r[32] = '0:01:00'; r[33] = '';
  return Object.assign(r, over || {});
}

test('T-1: merged AD/AE/AF stay positionally paired (sorted pairs + trailing unpaired ids)', function () {
  // Row 1: one paired leg (P1 @ 10:30) + one UNPAIRED parent (U1) appended to AD.
  // Row 2: one paired leg (P2 @ 9:15).
  // Old concatenation: AD = P1,U1,P2 / AF = 10:30:00,09:15:00 -> AF[1] (P2's
  // time) paired against U1. Correct merge: pairs sorted by time ->
  // AD = P2,P1,U1 / AE = M2,M1 / AF = 09:15:00,10:30:00.
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'DQE Historical Data': [
        new Array(34).fill('h'),   // header
        dqeRow('06/22/2026', 'Anna Smith', { 29: 'P1,U1', 30: 'M1', 31: '10:30:00' }),
        dqeRow('06/22/2026', 'Anna (Annie) Smith', {}),   // placeholder distinct agent
        dqeRow('06/22/2026', 'Anna Smith', { 29: 'P2', 30: 'M2', 31: '9:15:00' }),
      ],
    },
  });
  const res = h.call('repairDqeDuplicateMerge');
  assert.equal(res.merged, 1);
  assert.equal(res.deleted, 1);
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const last = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, last - 1, 34).getDisplayValues();
  const merged = rows.filter(function (r) { return r[2] === 'Anna Smith'; })[0];
  assert.ok(merged, 'merged row exists');
  assert.equal(merged[29], 'P2,P1,U1', 'AD: time-sorted paired ids, then the unpaired parent');
  assert.equal(merged[30], 'M2,M1',    'AE: paired missed ids in the same order');
  assert.equal(merged[31], '9:15:00,10:30:00', 'AF: times sorted chronologically');
  // Lockstep: AF[i] pairs with AD[i]; AD may run longer (unpaired tail only).
  assert.equal(merged[31].split(',').length, merged[30].split(',').length);
  assert.ok(merged[29].split(',').length >= merged[31].split(',').length);
  // Headline sums survive the merge.
  assert.equal(String(merged[5]), '4', 'rung summed');
  assert.equal(String(merged[7]), '2', 'answered summed');
});

test('T-1: an all-#REBUILD group keeps the sentinel on all three columns', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'DQE Historical Data': [
        new Array(34).fill('h'),
        dqeRow('06/22/2026', 'Bob Jones', { 29: '#REBUILD', 30: '#REBUILD', 31: '#REBUILD' }),
        dqeRow('06/22/2026', 'Bob Jones', { 29: '#REBUILD', 30: '#REBUILD', 31: '#REBUILD' }),
      ],
    },
  });
  const res = h.call('repairDqeDuplicateMerge');
  assert.equal(res.merged, 1);
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 34).getDisplayValues();
  const merged = rows.filter(function (r) { return r[2] === 'Bob Jones'; })[0];
  assert.equal(merged[29], '#REBUILD');
  assert.equal(merged[30], '#REBUILD');
  assert.equal(merged[31], '#REBUILD');
});
