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
  // The orphan scan reads through the per-execution DQE memos (DATA-6); a new
  // fixture must reset the WHOLE family (the R40 test-side trap).
  h.ctx.DQE_DATE_BOUNDS_MEMO_ = null; h.ctx.DQE_SHEET_ROWS_MEMO_ = null;
  h.ctx.DQE_DATE_COL_MEMO_ = null; h.ctx.DQE_EXT_GRID_MEMO_ = null;
  h.state.spreadsheet = makeFakeSpreadsheet({
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

// S2B-7 (broad-scan 2026-09-23): the rename writes the WHOLE agent column back
// in one setValues. A formula-leading toName was written raw, and an unchanged
// cell stored as apostrophe-neutralized text (read back WITHOUT the apostrophe)
// was re-armed as a live formula by the round trip. Every cell is now
// sheet-safed; the value a reader sees is unchanged (INV-04).
test('S2B-7: the column write-back neutralizes formula-leading names, renamed and untouched alike', function () {
  const sheet = install([
    dqeRowFor('03/09/2026', 'Roman Paulose'),
    dqeRowFor('03/09/2026', '=HYPERLINK("http://evil","x")'),   // stored as text, read back bare
    dqeRowFor('03/09/2026', 'Anna'),
  ]);
  const affected = h.call('renameHistoricalAgent_', 'Roman Paulose', '+Roman (Robin) Paulose');
  assert.equal(affected, 1);
  assert.equal(sheet._data[1][2], "'+Roman (Robin) Paulose", 'a formula-leading destination is neutralized');
  assert.equal(sheet._data[2][2], "'=HYPERLINK(\"http://evil\",\"x\")", 'an untouched formula-shaped cell is not re-armed');
  assert.equal(sheet._data[3][2], 'Anna', 'an ordinary name is written back byte-identical');
});

// DATA-6 (broad-scan 2026-09-23, Batch 9): computeOrphans_ ran on every
// Overview cache miss (the orphan nag) and read cols A..D of ALL history, then
// re-read every dept's roster the Overview had just loaded. The sheet read is
// now a min/max SPAN over the lookback; the roster names can be passed in.
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
test('DATA-6: the orphan scan reads only the lookback SPAN, and still finds an out-of-order row inside it', function () {
  const old = isoDaysAgo(400), recent = isoDaysAgo(3), recent2 = isoDaysAgo(5);
  const sheet = install([
    dqeRowFor(old, 'Ancient Orphan'),        // outside the lookback
    dqeRowFor(old, 'Ancient Orphan'),
    dqeRowFor(recent, 'New Orphan'),
    dqeRowFor(old, 'Ancient Orphan'),        // out of order: old date AFTER a recent one
    dqeRowFor(recent2, 'Late Backfill'),     // recent date appended last
  ]);
  const real = sheet.getRange.bind(sheet);
  const wide = [];
  sheet.getRange = function (r, c, nr, nc) { if (nc > 1) wide.push({ r: r, nr: nr }); return real(r, c, nr, nc); };
  try {
    const out = JSON.parse(JSON.stringify(h.call('computeOrphans_', { rosterNames: ['Anna'] })));
    const names = out.map(function (o) { return o.name; });
    assert.deepEqual(names, ['Late Backfill', 'New Orphan'], 'both recent orphans, nothing outside the lookback');
    assert.equal(wide.length, 1);
    assert.deepEqual(wide[0], { r: 4, nr: 3 }, 'rows 4..6 only -- the span of the in-window dates, not all of history');
  } finally { sheet.getRange = real; }
});

test('DATA-6: passed roster names are used instead of re-reading every roster', function () {
  install([dqeRowFor(isoDaysAgo(2), 'Anna'), dqeRowFor(isoDaysAgo(2), 'Stranger')]);
  let rosterReads = 0;
  const realGet = h.ctx.getRosterForDepartment_;
  h.ctx.getRosterForDepartment_ = function (d) { rosterReads++; return realGet(d); };
  try {
    const out = h.call('computeOrphans_', { rosterNames: ['Anna'] });
    assert.deepEqual(JSON.parse(JSON.stringify(out)).map(function (o) { return o.name; }), ['Stranger']);
    assert.equal(rosterReads, 0, 'no roster sheet reads when the caller supplies the names');
  } finally { h.ctx.getRosterForDepartment_ = realGet; }
});
