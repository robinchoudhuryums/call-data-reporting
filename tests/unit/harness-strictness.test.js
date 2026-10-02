'use strict';

// Batch 11 (broad-scan 2026-10-01): the harness fakes enforce the platform
// limits that become production failures. Each pin below is a property of the
// FAKE itself -- loosening one (to make a fixture fit) must fail here, not
// silently turn every writer test into a test of nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createShim } = require('../harness/shim');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { formatDate } = require('../harness/formatDate');

// ---- HT-2: Range.setValues is shape-strict and keeps displays current -----
test('HT-2: setValues throws on a row-count, column-count or ragged-row mismatch, like Sheets', function () {
  const ss = makeFakeSpreadsheet({ sheets: { S: [['h1', 'h2', 'h3']] } });
  const sh = ss.getSheetByName('S');
  assert.throws(function () { sh.getRange(2, 1, 2, 3).setValues([[1, 2, 3]]); },
    /number of rows in the data does not match.*data has 1 but the range has 2/);
  assert.throws(function () { sh.getRange(2, 1, 1, 3).setValues([[1, 2]]); },
    /number of columns in the data does not match.*data has 2 but the range has 3/);
  assert.throws(function () { sh.getRange(2, 1, 2, 2).setValues([[1, 2], [3]]); },
    /number of columns/, 'EVERY row is checked, not just the first');
  assert.throws(function () { sh.getRange(2, 1, 1, 1).setValues('x'); }, /number of rows/);
  assert.equal(sh.getLastRow(), 1, 'a refused write wrote nothing');
  sh.getRange(2, 1, 1, 3).setValues([[1, 2, 3]]);
  assert.deepEqual(sh.getRange(2, 1, 1, 3).getValues()[0], [1, 2, 3]);
});

test('HT-2: a write updates a fixture display grid; setValue fills the whole range; appendRow stays aligned', function () {
  const ss = makeFakeSpreadsheet({ sheets: { S: { values: [['h', 'dur'], ['a', 0.5]], displays: [['h', 'dur'], ['a', '12:00:00']] } } });
  const sh = ss.getSheetByName('S');
  sh.getRange(2, 2, 1, 1).setValues([['0:03:00']]);
  assert.equal(sh.getRange(2, 2).getDisplayValues()[0][0], '0:03:00', 'not the stale fixture text');
  sh.getRange(2, 1, 1, 2).setValue('z');
  assert.deepEqual(sh.getRange(2, 1, 1, 2).getValues()[0], ['z', 'z']);
  assert.deepEqual(sh.getRange(2, 1, 1, 2).getDisplayValues()[0], ['z', 'z']);
  sh.appendRow(['b', '0:01:00']);
  assert.deepEqual(sh.getRange(3, 1, 1, 2).getDisplayValues()[0], ['b', '0:01:00'], 'appended row renders');
  sh.getRange(3, 1, 1, 2).clearContent();
  assert.deepEqual(sh.getRange(3, 1, 1, 2).getDisplayValues()[0], ['', '']);
});

// ---- HT-3: CacheService key + value caps ----------------------------------
test('HT-3: a cache key over 250 chars throws on get/put/remove; a value over 100 KB throws on put', function () {
  const shim = createShim();
  const cache = shim.globals.CacheService.getScriptCache();
  const k250 = 'k'.repeat(250), k251 = 'k'.repeat(251);
  cache.put(k250, 'ok');
  assert.equal(cache.get(k250), 'ok', 'exactly 250 is allowed');
  ['get', 'remove'].forEach(function (m) {
    assert.throws(function () { cache[m](k251); }, /Argument too large: key/, m);
  });
  assert.throws(function () { cache.put(k251, 'v'); }, /Argument too large: key/);
  cache.put('v', 'x'.repeat(100 * 1024));
  assert.throws(function () { cache.put('v2', 'x'.repeat(100 * 1024 + 1)); }, /Argument too large: value/);
  assert.equal(cache.get('v2'), null, 'a refused put stores nothing');
  assert.deepEqual(shim.state.cacheLimitHits.map(function (x) { return x.kind; }), ['key', 'key', 'key', 'value']);
});

// ---- HT-4: formatDate models fields, honours quotes, refuses the rest -----
test('HT-4: formatDate models every field the code uses and THROWS on an unmodelled letter', function () {
  const d = new Date('2026-03-10T19:05:07Z'), tz = 'America/Chicago';
  assert.equal(formatDate(d, tz, 'yyyy-MM-dd HH:mm'), '2026-03-10 14:05');
  assert.equal(formatDate(d, tz, 'MMM d, yyyy  h:mm a'), 'Mar 10, 2026  2:05 PM');
  assert.equal(formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss"), '2026-03-10T14:05:07');
  assert.equal(formatDate(d, tz, 'MMMM, yy'), 'March, 26');
  assert.equal(formatDate(d, tz, "'o''clock' H"), "o'clock 14");
  assert.equal(formatDate(d, tz, 'u'), '2');
  ['EEE', 'Z', 'b', 'S', 'ddd'].forEach(function (p) {
    assert.throws(function () { formatDate(d, tz, p); }, /not modelled/, p);
  });
  assert.throws(function () { formatDate(d, tz, "'open"); }, /unterminated quote/);
});

// ---- HT-5: triggers, locks and property limits ----------------------------
test('HT-5: triggers are a live set -- create registers, getProjectTriggers lists, deleteTrigger removes; 20 is the cap', function () {
  const shim = createShim();
  const SA = shim.globals.ScriptApp;
  assert.equal(SA.getProjectTriggers().length, 0);
  const t = SA.newTrigger('runDaily_').timeBased().everyDays(1).atHour(6).create();
  assert.equal(SA.getProjectTriggers().length, 1);
  assert.equal(SA.getProjectTriggers()[0].getHandlerFunction(), 'runDaily_');
  assert.equal(t.getUniqueId(), SA.getProjectTriggers()[0].getUniqueId());
  SA.deleteTrigger(t);
  assert.equal(SA.getProjectTriggers().length, 0);
  assert.deepEqual(shim.state.createdTriggers, ['runDaily_'], 'the historical capture still records creation');
  assert.deepEqual(shim.state.deletedTriggers, ['runDaily_']);
  for (let i = 0; i < 20; i++) SA.newTrigger('h' + i).timeBased().everyDays(1).create();
  assert.throws(function () { SA.newTrigger('h20').timeBased().everyDays(1).create(); }, /too many triggers/);
});

test('HT-5: the script lock has real held state and hasLock(); lockBusy models another holder', function () {
  const shim = createShim();
  const lock = shim.globals.LockService.getScriptLock();
  assert.equal(lock.hasLock(), false);
  assert.equal(lock.tryLock(1000), true);
  assert.equal(lock.hasLock(), true);
  lock.releaseLock();
  assert.equal(lock.hasLock(), false);
  assert.equal(shim.state.lockReleases, 1);
  shim.state.lockBusy = true;
  assert.equal(lock.tryLock(1000), false);
  assert.throws(function () { lock.waitLock(1000); }, /Lock timeout/);
  assert.equal(lock.hasLock(), false);
});

test('HT-5: Script Properties refuse a value over 9 KB and a store over 500 KB', function () {
  const shim = createShim();
  const props = shim.globals.PropertiesService.getScriptProperties();
  props.setProperty('OK', 'x'.repeat(9 * 1024));
  assert.throws(function () { props.setProperty('BIG', 'x'.repeat(9 * 1024 + 1)); }, /Argument too large: value/);
  assert.equal(props.getProperty('BIG'), null);
  let n = 0;
  assert.throws(function () {
    for (;;) props.setProperty('K' + (n++), 'y'.repeat(9000));
  }, /exceeded the property storage quota/);
  assert.ok(n > 50 && n < 60, 'the quota trips near 500 KB (' + n + ' x 9 KB)');
  props.setProperty('K0', 'small');   // overwriting an existing key counts its NEW size, not both
  assert.deepEqual(shim.state.propLimitHits.map(function (x) { return x.kind; }), ['value', 'store']);
});
