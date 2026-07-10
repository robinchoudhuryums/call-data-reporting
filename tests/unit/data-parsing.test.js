'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');

// Data.gs::getDeptQueueExts_ now routes through DeptConfig.gs's
// getDeptQueueExtsOverride_ (INV-54), so load it too.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs', 'DeptConfig.gs'] });

test('parseExtensions_ keeps digit-only tokens, trims, drops the rest (INV-03)', function () {
  deepEqual(h.call('parseExtensions_', '108, 165'), ['108', '165']);
  deepEqual(h.call('parseExtensions_', '108,abc,1003'), ['108', '1003']);
  deepEqual(h.call('parseExtensions_', ''), []);
  deepEqual(h.call('parseExtensions_', null), []);
  deepEqual(h.call('parseExtensions_', '  139  '), ['139']);
});

test('parseHmsDisplay_ parses H:MM:SS, MM:SS, raw seconds', function () {
  assert.equal(h.call('parseHmsDisplay_', '0:15:03'), 903);
  assert.equal(h.call('parseHmsDisplay_', '0:03:01'), 181);
  assert.equal(h.call('parseHmsDisplay_', '6:04:50'), 21890);
  assert.equal(h.call('parseHmsDisplay_', '03:01'), 181);
  assert.equal(h.call('parseHmsDisplay_', '45'), 45);
  assert.equal(h.call('parseHmsDisplay_', ''), 0);
  assert.equal(h.call('parseHmsDisplay_', null), 0);
});

test('pad2_ zero-pads single digits only', function () {
  assert.equal(h.call('pad2_', 3), '03');
  assert.equal(h.call('pad2_', 12), '12');
  assert.equal(h.call('pad2_', 0), '00');
});

test('rowDateIso_ handles Date objects honoring the passed TZ (INV-02 root cause)', function () {
  // Noon UTC is the same calendar day in Chicago, so unambiguous.
  const noonUtc = new Date(Date.UTC(2026, 2, 9, 12, 0, 0));
  assert.equal(h.call('rowDateIso_', noonUtc, 'America/Chicago'), '2026-03-09');
  assert.equal(h.call('rowDateIso_', noonUtc, 'America/Mexico_City'), '2026-03-09');
});

test('rowDateIso_ converts Sheets serial dates (F-8: right calendar day in ANY tz)', function () {
  // Serial 45726 = 2025-03-10 (days since 1899-12-30). This test previously
  // pinned 2025-03-09 -- the OLD off-by-one: the serial converts to UTC
  // MIDNIGHT of the date, and formatting that instant in a west-of-UTC zone
  // rendered 18:00 the PREVIOUS day. Fixed by formatting in UTC.
  assert.equal(h.call('rowDateIso_', 45726, 'America/Chicago'), '2025-03-10');
  // Small ints aren't dates.
  assert.equal(h.call('rowDateIso_', 5, 'America/Chicago'), '');
});

test('rowDateIso_ parses string formats incl. the 2-digit-year pivot', function () {
  assert.equal(h.call('rowDateIso_', '03/09/2026', 'America/Chicago'), '2026-03-09');
  assert.equal(h.call('rowDateIso_', '3/9/2026', 'America/Chicago'), '2026-03-09');
  assert.equal(h.call('rowDateIso_', '2025-12-31', 'America/Chicago'), '2025-12-31');
  // pivot: 00-69 -> 2000s, 70-99 -> 1900s
  assert.equal(h.call('rowDateIso_', '3/9/69', 'America/Chicago'), '2069-03-09');
  assert.equal(h.call('rowDateIso_', '3/9/70', 'America/Chicago'), '1970-03-09');
  // junk
  assert.equal(h.call('rowDateIso_', 'not a date', 'America/Chicago'), '');
  assert.equal(h.call('rowDateIso_', '', 'America/Chicago'), '');
});

test('getDeptQueueExts_ override replaces the data-derived set', function () {
  // With no Dept Config sheet present, getDeptQueueExtsOverride_ falls
  // back to the DEPT_QUEUE_EXT_OVERRIDES constant: CSR -> 103/108/1003.
  // (Needs a fake spreadsheet because the accessor reads Dept Config.)
  const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });   // no Dept Config sheet
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;

  const res = h.call('getDeptQueueExts_', 'CSR', {}, []);
  assert.equal(res.source, 'override');
  deepEqual(Object.keys(res.exts).sort(), ['1003', '103', '108']);
});

test('getDeptQueueExts_ derives from roster col D when no override exists', function () {
  const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;

  // A dept with no override constant entry -> derived from values.
  // values rows are [Month, Date, Agent, QueueExt, ...]; only need cols
  // up to QUEUE_EXT (4). Agent must be in rosterSet to contribute.
  const rosterSet = { 'Jane Doe': true };
  const values = [
    ['', '', 'Jane Doe', '201, 202'],
    ['', '', 'Other Person', '999'],  // not on roster -> ignored
  ];
  const res = h.call('getDeptQueueExts_', 'Sales', rosterSet, values);
  assert.equal(res.source, 'derived');
  deepEqual(Object.keys(res.exts).sort(), ['201', '202']);
});

test('F-8: the serial branch is tz-independent (spreadsheet tz cannot shift the day)', function () {
  assert.equal(h.call('rowDateIso_', 45726, 'America/Mexico_City'), '2025-03-10');
});
