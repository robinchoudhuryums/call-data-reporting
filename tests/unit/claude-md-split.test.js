'use strict';

// F8 split guard. CLAUDE.md hit ~372 KB and is injected into EVERY session's
// context, so four reference sections were moved into docs/ with a one-line
// index left behind:
//
//   Invariant Library       -> docs/invariants.md
//   Regression Scenarios    -> docs/regression-scenarios.md
//   Operator State items    -> docs/operator-state.md
//   client/UI gotchas       -> docs/client-ui-conventions.md
//
// That split creates ONE new failure mode that did not exist before: the index
// and the full text can drift. A new INV added to docs/invariants.md but not to
// the index is invisible to anyone reading CLAUDE.md; an index line for an INV
// that no longer exists sends a reader looking for nothing. Both are silent.
// This test makes either a CI failure.
//
// It checks IDs and subsystem/title strings, NOT prose -- the index line is
// deliberately a summary of the entry, so their bodies must be allowed to differ.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const CLAUDE = read('CLAUDE.md');

// Everything under a heading, up to the next heading at the SAME level or
// shallower (so a `##` section keeps its `###` subsections -- "Read first" has
// them). Scopes an index lookup to its own section, so an `INV-` reference
// elsewhere in CLAUDE.md can't stand in for a missing index line.
function section(text, heading) {
  const start = text.indexOf('\n' + heading + '\n');
  assert.notEqual(start, -1, 'CLAUDE.md is missing the "' + heading + '" heading');
  const depth = /^#+/.exec(heading)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp('\\n#{1,' + depth + '} '));
  return end === -1 ? rest : rest.slice(0, end);
}

// `... | Subsystem: X` -- take the LAST occurrence and drop a trailing pipe,
// because several entries contain `|` inside the body (INV-54 lists sheet
// columns pipe-separated) and two end with a stray trailing `|`.
function subsystemOf(line) {
  const i = line.lastIndexOf('| Subsystem:');
  if (i === -1) return null;
  return line.slice(i + '| Subsystem:'.length).replace(/\s*\|\s*$/, '').trim();
}

function idMap(text, re) {
  const out = {};
  text.split('\n').forEach(function (line) {
    const m = re.exec(line);
    if (m) out[m[1]] = line;
  });
  return out;
}

test('F8 split: CLAUDE.md points at every split file', function () {
  ['docs/invariants.md', 'docs/regression-scenarios.md', 'docs/operator-state.md',
   'docs/client-ui-conventions.md'].forEach(function (rel) {
    assert.ok(CLAUDE.indexOf(rel) !== -1,
      'CLAUDE.md no longer links ' + rel + ' -- the split content is unreachable '
      + 'for anyone reading CLAUDE.md. Restore the pointer.');
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' is missing');
    // The "Read first" nav block is the entry point a fresh session uses.
    assert.ok(section(CLAUDE, '## Read first').indexOf(rel) !== -1,
      rel + ' is linked somewhere in CLAUDE.md but not from "Read first" -- add it '
      + 'there so a fresh session can find it.');
  });
});

test('F8 split: the Invariant Library index matches docs/invariants.md', function () {
  const idx = idMap(section(CLAUDE, '### Invariant Library'), /^(INV-\d+) \| /);
  const doc = idMap(read('docs/invariants.md'), /^(INV-\d+) \| /);

  const idxIds = Object.keys(idx).sort();
  const docIds = Object.keys(doc).sort();
  assert.deepEqual(idxIds, docIds,
    'invariant IDs differ.\n  only in CLAUDE.md index: '
    + idxIds.filter(function (k) { return !doc[k]; }).join(', ')
    + '\n  only in docs/invariants.md: '
    + docIds.filter(function (k) { return !idx[k]; }).join(', ')
    + '\n  A new invariant must be added to BOTH (full text in the doc, one-line'
    + ' summary in the CLAUDE.md index).');

  idxIds.forEach(function (id) {
    assert.equal(subsystemOf(idx[id]), subsystemOf(doc[id]),
      id + ': the index Subsystem disagrees with docs/invariants.md '
      + '(index="' + subsystemOf(idx[id]) + '", doc="' + subsystemOf(doc[id]) + '")');
  });
});

test('F8 split: the Regression Scenarios index matches docs/regression-scenarios.md', function () {
  const re = /^(S\d+) \| (.*?) \| Subsystem: (.*)$/;
  function parse(text) {
    const out = {};
    text.split('\n').forEach(function (line) {
      const m = re.exec(line);
      if (m) out[m[1]] = { title: m[2].trim(), sub: m[3].trim() };
    });
    return out;
  }
  const idx = parse(section(CLAUDE, '### Regression Scenarios'));
  const doc = parse(read('docs/regression-scenarios.md'));

  const idxIds = Object.keys(idx).sort();
  const docIds = Object.keys(doc).sort();
  assert.deepEqual(idxIds, docIds,
    'scenario IDs differ.\n  only in CLAUDE.md index: '
    + idxIds.filter(function (k) { return !doc[k]; }).join(', ')
    + '\n  only in docs/regression-scenarios.md: '
    + docIds.filter(function (k) { return !idx[k]; }).join(', '));

  idxIds.forEach(function (id) {
    // Scenario titles are copied verbatim into the index (unlike invariants,
    // whose index line is a summary), so these must match exactly.
    assert.equal(idx[id].title, doc[id].title,
      id + ': index title "' + idx[id].title + '" != doc title "' + doc[id].title + '"');
    assert.equal(idx[id].sub, doc[id].sub, id + ': Subsystem differs');
  });
});

test('F8 split: the Operator State index matches docs/operator-state.md', function () {
  const idxNums = section(CLAUDE, '## Operator State Checklist')
    .split('\n').map(function (l) { return /^(\d+)\. /.exec(l); })
    .filter(Boolean).map(function (m) { return Number(m[1]); });
  const docNums = read('docs/operator-state.md')
    .split('\n').map(function (l) { return /^(\d+)\. /.exec(l); })
    .filter(Boolean).map(function (m) { return Number(m[1]); });

  assert.deepEqual(idxNums, docNums,
    'operator-state item numbers differ between the CLAUDE.md index and '
    + 'docs/operator-state.md -- index=[' + idxNums.join(',') + '] doc=['
    + docNums.join(',') + ']');
  // Items are cited BY NUMBER across the repo ("Operator State #38"), so a gap
  // or reorder silently redirects those citations.
  idxNums.forEach(function (n, i) {
    assert.equal(n, i + 1,
      'operator-state numbering must stay contiguous from 1 (found ' + n
      + ' at position ' + (i + 1) + '). Items are cited by number -- retire one '
      + 'in place rather than renumbering.');
  });
});

// The tripwire F8 actually needs. CLAUDE.md regrew from 357 KB to 372 KB over a
// single cycle, one reasonable-looking paragraph at a time, and nothing noticed.
// The cap is generous (current ~152 KB) so ordinary rule additions never trip
// it; crossing it means it is time to split again, not to raise the number
// reflexively.
test('F8 split: CLAUDE.md stays under the size budget', function () {
  const MAX = 200 * 1024;
  const bytes = Buffer.byteLength(CLAUDE, 'utf8');
  assert.ok(bytes <= MAX,
    'CLAUDE.md is ' + Math.round(bytes / 1024) + ' KB, over the ' + (MAX / 1024)
    + ' KB budget. It is injected into EVERY session\'s context, so size is a '
    + 'real cost. Move a reference section into docs/ with an index (the F8 '
    + 'pattern: docs/invariants.md, docs/operator-state.md, '
    + 'docs/regression-scenarios.md, docs/client-ui-conventions.md) rather than '
    + 'raising this number.');
});
