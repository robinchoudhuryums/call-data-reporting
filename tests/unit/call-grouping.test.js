'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// R17i: the FIRST unit coverage of a client-fragment pure function.
//
// `groupConsecutiveByCall_` (script-1-core.html) is the single definition of
// "these rings are one call", shared by the agent cards (missedAgentsHtml_)
// and the four drill lenses (missedSliceListHtml_). Before the extraction the
// rule was written twice with nothing making the copies agree -- change the
// key in one place and the two surfaces silently disagree about what one call
// IS, while both still render something plausible. The rendered-UI gate can
// only see THAT grouping happened, not that the rule is the same in both, so
// the rule needs a test of its own.
//
// The function is pure and dependency-free, so it can be lifted straight out
// of the fragment and exercised in isolation: read the file, brace-match the
// declaration, and evaluate just that. This mirrors the assembly technique in
// html-include-structure.test.js (which reads the same fragments as text) and
// keeps the suite zero-dep -- no jsdom, no browser.

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

/** Lift a top-level `function NAME(...) {...}` out of a script fragment. */
function extractFn(file, name) {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = text.indexOf('function ' + name + '(');
  assert.notEqual(start, -1,
    name + ' is missing from ' + file + ' -- if it moved, move this test with it.');
  const open = text.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, name + ': unbalanced braces while extracting from ' + file);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + text.slice(start, end) + ');')();
}

const groupConsecutiveByCall_ = extractFn('script-1-core.html', 'groupConsecutiveByCall_');

/** Compact fixture: 'id@date' per ring, or null for a ring with no parent id. */
function rings(spec) {
  return spec.map(function (s) {
    if (s === null) return { parentId: null, date: '2026-08-10' };
    const p = String(s).split('@');
    return { parentId: p[0], date: p[1] || '2026-08-10' };
  });
}
/** Runs as 'start-end:isRun' so an assertion reads like the fixture. */
function shape(runs) {
  return runs.map(function (r) { return r.start + '-' + r.end + ':' + (r.isRun ? 'run' : 'one'); });
}

test('groups CONSECUTIVE rings sharing a parentId on the same date', function () {
  const out = groupConsecutiveByCall_(rings(['A', 'A', 'A', 'B']));
  assert.deepEqual(shape(out), ['0-3:run', '3-4:one']);
  assert.equal(out[0].length, 3);
});

test('the runs COVER the input exactly, in order (nothing dropped or doubled)', function () {
  // The callers slice by [start, end) and concatenate, so a gap would silently
  // drop rings from the page and an overlap would render them twice.
  const list = rings(['A', 'A', null, 'B', 'C', 'C']);
  const out = groupConsecutiveByCall_(list);
  let cursor = 0;
  out.forEach(function (r) {
    assert.equal(r.start, cursor, 'runs must be contiguous');
    assert.ok(r.end > r.start, 'every run covers at least one ring');
    cursor = r.end;
  });
  assert.equal(cursor, list.length, 'the runs must reach the end of the list');
});

test('ADJACENCY is part of the rule -- a re-rung parent later is its own event', function () {
  // A,B,A is three events, not "two A rings plus a B". This is the behavior
  // both surfaces rely on: a call that rang again much later reads better as
  // a separate event than as one group spanning an unrelated ring.
  assert.deepEqual(shape(groupConsecutiveByCall_(rings(['A', 'B', 'A']))),
    ['0-1:one', '1-2:one', '2-3:one']);
});

test('a DATE change breaks the run even when the parentId repeats', function () {
  assert.deepEqual(
    shape(groupConsecutiveByCall_(rings(['A@2026-08-10', 'A@2026-08-11']))),
    ['0-1:one', '1-2:one']);
});

test('rings with NO parentId never group, even when adjacent', function () {
  // In DQE only abandoned rings carry an id -- a ring answered elsewhere has
  // none. Grouping on a null id would fuse unrelated rings into one "call".
  assert.deepEqual(shape(groupConsecutiveByCall_(rings([null, null, null]))),
    ['0-1:one', '1-2:one', '2-3:one']);
});

test('a lone ring with an id is NOT a run (length 1 stays ungrouped)', function () {
  const out = groupConsecutiveByCall_(rings(['A']));
  assert.deepEqual(shape(out), ['0-1:one']);
  assert.equal(out[0].length, 1);
});

test('empty and missing input yield no runs (both callers pass a payload list)', function () {
  assert.deepEqual(groupConsecutiveByCall_([]), []);
  assert.deepEqual(groupConsecutiveByCall_(null), []);
  assert.deepEqual(groupConsecutiveByCall_(undefined), []);
});

test('the rule is applied by BOTH callers -- neither kept a private copy', function () {
  // The point of the extraction. A future edit that re-inlines the loop in
  // either place would pass every test above while re-opening the drift this
  // closed, so pin the call sites themselves.
  const dept = fs.readFileSync(path.join(DIR, 'script-5-dept.html'), 'utf8');
  const lens = fs.readFileSync(path.join(DIR, 'script-9-inbound-direct.html'), 'utf8');
  assert.ok(/groupConsecutiveByCall_\(/.test(dept),
    'missedAgentsHtml_ (script-5-dept.html) no longer calls the shared rule');
  assert.ok(/groupConsecutiveByCall_\(/.test(lens),
    'missedSliceListHtml_ (script-9-inbound-direct.html) no longer calls the shared rule');
});
