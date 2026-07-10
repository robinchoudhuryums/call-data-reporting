'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Batch-2 pure helpers (cdr-report tooling): the F-51 slot sanitizer, the
// F-10 inbound-export date normalizer, and the F-12 batch-PDF date anchor.

const bf = loadGas({ project: 'cdr-report', files: ['neonbackfill.js'] });
const ic = loadGas({ project: 'cdr-report', files: ['inboundCallsExport.js'] });
const em = loadGas({ project: 'cdr-report', files: ['emailDailyReport.js'] });

test('F-51: sanitizeSlotCellForNeon_ passes clean cells, recovers date-render coercion, nulls garbage', function () {
  const f = bf.fn('sanitizeSlotCellForNeon_');
  // Clean comma-joined times pass through (trimmed).
  assert.equal(f('10:23:33,10:08:41'), '10:23:33,10:08:41');
  assert.equal(f(' 9:05:00 , 9:10:00 '), '9:05:00,9:10:00');
  assert.equal(f('9:05:00'), '9:05:00');
  // Genuinely empty stays empty (0 missed in that slot).
  assert.equal(f(''), '');
  assert.equal(f(null), '');
  // Lossless single-value recovery: the coerced cell's date render keeps
  // its time-of-day part.
  assert.equal(f('12/30/1899 10:23:33'), '10:23:33');
  // Unrecoverable coercion shapes are EXCLUDED, not mirrored: a bare
  // serial decimal (post-'@'-flip render) and a thousands-mangled number.
  assert.equal(f('0.433020833333'), null);
  assert.equal(f('17,622,419,789,481,700,000'), null);
});

test('F-10: ic_cellDateIso_ normalizes pre- and post-coercion col-A displays to ISO', function () {
  const f = ic.fn('ic_cellDateIso_');
  assert.equal(f('2026-06-22'), '2026-06-22');   // pre-coercion string
  assert.equal(f('6/22/2026'), '2026-06-22');    // coerced cell's display
  assert.equal(f('06/22/2026'), '2026-06-22');
  assert.equal(f(''), '');
  assert.equal(f('not a date'), '');
});

test('F-12: the batch-PDF date cell anchor is NOON of the same calendar day (no +1)', function () {
  const f = em.fn('compensateForSpreadsheetTimezone');
  // Winter date (Chicago on CST, -6 == the sheet's fixed offset): the old
  // +1-day shift dated every batch PDF one day LATE November-March. Noon
  // of the SAME day is correct year-round for any sheet tz within +-11h.
  const winter = f(new Date(2026, 0, 15));       // Jan 15 2026 midnight
  assert.equal(winter.getFullYear(), 2026);
  assert.equal(winter.getMonth(), 0);
  assert.equal(winter.getDate(), 15);            // old code: 16
  assert.equal(winter.getHours(), 12);
  // Summer date (CDT, -5): same day, noon.
  const summer = f(new Date(2026, 6, 9));        // Jul 9 2026
  assert.equal(summer.getDate(), 9);
  assert.equal(summer.getHours(), 12);
});
