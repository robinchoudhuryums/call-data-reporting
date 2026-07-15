'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// buildDQEHistoricalData.js lives in the sibling pipeline projects and
// is byte-identical across cdr-report / cdr-import (INV-16). We test
// the discrete canonicalization-map builder (INV-24 / INV-46); the
// end-to-end build (INV-07/08/21) is a 628-line monolith deferred to
// Phase 4 (needs a full Raw Data leg-schema fixture).
function loadCanon(project) {
  return loadGas({ project: project, files: ['buildDQEHistoricalData.js'] });
}

const ALIAS_HEADERS = ['Old Name', 'Canonical Name', 'Active', 'Added By', 'Added At', 'Notes'];

function withSheets(h, opts) {
  const sheets = {};
  if (opts.roster) sheets['DO NOT EDIT!'] = opts.roster;
  if (opts.aliases) sheets['Agent Alias Overrides'] = [ALIAS_HEADERS].concat(opts.aliases);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
}

test('INV-24: canonicalSet = all roster names; strippedMap removes parentheticals', function () {
  const h = loadCanon('cdr-report');
  withSheets(h, {
    roster: rosterGrid({ Sales: ['Roman (Robin) Paulose, 401', 'Jane Doe, 402'] }),
  });
  const r = h.call('loadRosterCanonicalNames_', null);

  assert.equal(r.canonicalSet['Roman (Robin) Paulose'], true);
  assert.equal(r.canonicalSet['Jane Doe'], true);
  // The STRIP key removes the paren + its contents: "Roman (Robin) Paulose"
  // -> "Roman Paulose" (the nickname-omitted feed form).
  deepEqual(r.strippedMap['Roman Paulose'], ['Roman (Robin) Paulose']);
  deepEqual(r.strippedMap['Jane Doe'], ['Jane Doe']);
});

test('INV-24: strippedMap ALSO registers the flatten key (un-parenthesized nickname, ~90% orphan case)', function () {
  const h = loadCanon('cdr-report');
  withSheets(h, {
    roster: rosterGrid({ Sales: ['Roman (Robin) Paulose, 401', 'Jane Doe, 402'] }),
  });
  const r = h.call('loadRosterCanonicalNames_', null);
  // The FLATTEN key drops only the parens, keeping the words:
  // "Roman (Robin) Paulose" -> "Roman Robin Paulose" -- the un-parenthesized
  // nickname form the feed emits, which previously did NOT match. This is
  // the key that closes the 90% orphan case.
  deepEqual(r.strippedMap['Roman Robin Paulose'], ['Roman (Robin) Paulose']);
});

test('INV-24: a no-paren roster name registers ONE entry (strip === flatten dedup, no false ambiguity)', function () {
  const h = loadCanon('cdr-report');
  withSheets(h, { roster: rosterGrid({ Sales: ['Jane Doe, 401'] }) });
  const r = h.call('loadRosterCanonicalNames_', null);
  // strip('Jane Doe') === flatten('Jane Doe') === 'Jane Doe'. Per-key dedup
  // must keep it a SINGLE-entry list, else the name would look ambiguous
  // (>1) and never canonicalize.
  deepEqual(r.strippedMap['Jane Doe'], ['Jane Doe']);
});

test('INV-24: names that strip to the same form are recorded as ambiguous (>1 entry)', function () {
  const h = loadCanon('cdr-report');
  withSheets(h, {
    // Both strip to "Chris Lee" -> ambiguous, so the build writes such
    // incoming names as-is rather than guessing.
    roster: rosterGrid({ Sales: ['Chris (CJ) Lee, 401'], CSR: ['Chris Lee, 402'] }),
  });
  const r = h.call('loadRosterCanonicalNames_', null);
  deepEqual(r.strippedMap['Chris Lee'].sort(), ['Chris (CJ) Lee', 'Chris Lee']);
});

test('INV-46: aliasMap includes active rows, skips inactive, first-write-wins', function () {
  const h = loadCanon('cdr-report');
  withSheets(h, {
    roster: rosterGrid({ Sales: ['Roman (Robin) Paulose, 401'] }),
    aliases: [
      ['Roman Paulos', 'Roman (Robin) Paulose', 'TRUE', '', '', ''],   // active
      ['Old Inactive', 'Jane Doe', 'FALSE', '', '', ''],               // skipped
      ['Roman Paulos', 'Someone Else', 'TRUE', '', '', ''],            // dup -> first wins
    ],
  });
  const r = h.call('loadRosterCanonicalNames_', null);
  assert.equal(r.aliasMap['Roman Paulos'], 'Roman (Robin) Paulose'); // first write wins
  assert.equal(r.aliasMap['Old Inactive'], undefined);                // inactive skipped
});

test('best-effort: missing DO NOT EDIT! sheet yields empty maps (no throw)', function () {
  const h = loadCanon('cdr-report');
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  const r = h.call('loadRosterCanonicalNames_', null);
  deepEqual(r.canonicalSet, {});
  deepEqual(r.strippedMap, {});
  deepEqual(r.aliasMap, {});
});

test('best-effort: roster present but no Agent Alias Overrides sheet -> aliasMap {}', function () {
  const h = loadCanon('cdr-report');
  withSheets(h, { roster: rosterGrid({ Sales: ['Jane Doe, 401'] }) });
  const r = h.call('loadRosterCanonicalNames_', null);
  assert.equal(r.canonicalSet['Jane Doe'], true);
  deepEqual(r.aliasMap, {});
});

test('INV-16: the cdr-import copy produces identical canonicalization output', function () {
  // Functional confirmation (beyond the textual drift guard) that the
  // byte-identical duplicate behaves the same when loaded standalone.
  const roster = rosterGrid({ Sales: ['Roman (Robin) Paulose, 401'], CSR: ['Chris Lee, 402'] });

  const rep = loadCanon('cdr-report');
  withSheets(rep, { roster: roster });
  const repOut = rep.call('loadRosterCanonicalNames_', null);

  const imp = loadCanon('cdr-import');
  withSheets(imp, { roster: roster });
  const impOut = imp.call('loadRosterCanonicalNames_', null);

  deepEqual(impOut.strippedMap, repOut.strippedMap);
  deepEqual(Object.keys(impOut.canonicalSet).sort(), Object.keys(repOut.canonicalSet).sort());
});
