'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// F-22: renameHistoricalAgent_'s re-verify-before-write guard. LockService
// is per-project, so the dashboard rename can race the cdr-import /
// cdr-report daily builds (other projects, same workbook). If the DQE
// sheet changed between the snapshot read and the write -- a force
// re-import deleting a date's rows shifts everything below up -- the
// stale column write-back would misalign agent names row-by-row. The
// guard aborts (no write) instead.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'OrphanFix.gs'],
});

const DQE_HEADER = new Array(34).fill('');

function dqeRowFor(date, agent) {
  const r = new Array(34).fill('');
  r[1] = date; r[2] = agent;
  return r;
}

function install(rows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DQE Historical Data': [DQE_HEADER].concat(rows) },
  });
  return h.state.spreadsheet._sheet('DQE Historical Data');
}

test('F-22: quiet sheet -> rename writes every matching row (happy path unchanged)', function () {
  const sheet = install([
    dqeRowFor('03/09/2026', 'Roman Paulose'),
    dqeRowFor('03/09/2026', 'Anna'),
    dqeRowFor('03/10/2026', 'Roman Paulose'),
  ]);
  const affected = h.call('renameHistoricalAgent_', 'Roman Paulose', 'Roman (Robin) Paulose');
  assert.equal(affected, 2);
  assert.equal(sheet._data[1][2], 'Roman (Robin) Paulose');
  assert.equal(sheet._data[2][2], 'Anna');
  assert.equal(sheet._data[3][2], 'Roman (Robin) Paulose');
});

test('F-22: a concurrent row DELETE between snapshot and write aborts with no write', function () {
  const sheet = install([
    dqeRowFor('03/09/2026', 'Roman Paulose'),
    dqeRowFor('03/09/2026', 'Anna'),
    dqeRowFor('03/10/2026', 'Roman Paulose'),
  ]);
  // Simulate the cross-project build: after the FIRST column read, a
  // force re-import deletes the 03/09 rows (rows below shift up).
  const realGetRange = sheet.getRange.bind(sheet);
  let reads = 0;
  sheet.getRange = function (r, c, nr, nc) {
    const range = realGetRange(r, c, nr, nc);
    const realGetValues = range.getValues.bind(range);
    range.getValues = function () {
      const out = realGetValues();
      if (++reads === 1) { sheet.deleteRow(2); sheet.deleteRow(2); }  // both 03/09 rows
      return out;
    };
    return range;
  };
  assert.throws(function () {
    h.call('renameHistoricalAgent_', 'Roman Paulose', 'Roman (Robin) Paulose');
  }, /changed while preparing the rename/);
  // Nothing was written: the surviving row still carries the OLD name.
  assert.equal(sheet._data[1][2], 'Roman Paulose');
});

test('F-22: a concurrent cell change (same row count) is also caught', function () {
  const sheet = install([
    dqeRowFor('03/09/2026', 'Roman Paulose'),
    dqeRowFor('03/09/2026', 'Anna'),
  ]);
  const realGetRange = sheet.getRange.bind(sheet);
  let reads = 0;
  sheet.getRange = function (r, c, nr, nc) {
    const range = realGetRange(r, c, nr, nc);
    const realGetValues = range.getValues.bind(range);
    range.getValues = function () {
      const out = realGetValues();
      // A rebuild rewrote Anna's row under a canonicalized name -- same
      // row count, different content.
      if (++reads === 1) sheet._data[2][2] = 'Anna (A) Lee';
      return out;
    };
    return range;
  };
  assert.throws(function () {
    h.call('renameHistoricalAgent_', 'Roman Paulose', 'Roman (Robin) Paulose');
  }, /changed while preparing the rename/);
  assert.equal(sheet._data[1][2], 'Roman Paulose', 'no partial write');
});

test('F-22: zero matches returns 0 without touching the sheet', function () {
  install([dqeRowFor('03/09/2026', 'Anna')]);
  assert.equal(h.call('renameHistoricalAgent_', 'Nobody', 'Anyone'), 0);
});
