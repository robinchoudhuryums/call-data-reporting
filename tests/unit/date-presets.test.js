'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// SHARED date-range preset resolver (`datePresetRange_`, script-1-core.html).
//
// THE RULE: an open-ended preset ends YESTERDAY, never today. Today's ingest
// has not landed while a manager is looking (the pipeline builds the PREVIOUS
// day), so including today tacks an empty day onto every window -- dragging
// rates and averages toward zero and making the last chart point dive.
//
// This rule was hand-mirrored in SIX resolvers (IR, Insights, Inbound,
// Direct, Outbound, the all-dept Queue report) and had already drifted:
// `last30` was fixed to end yesterday in all six while `thisMonth` /
// `thisWeek` / `last7` / `last3Months` / `last12Months` still ended TODAY in
// every copy. They now all delegate here, and this suite is what keeps the
// rule honest -- plus a source tripwire that fails if a resolver goes back to
// computing its own dates (the drift class the extraction exists to end).
//
// The function is pure and clock-injectable, so it lifts straight out of the
// fragment (the call-grouping.test.js technique -- zero-dep, no jsdom).

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function extractFn(file, name) {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = text.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' is missing from ' + file);
  const open = text.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, name + ': unbalanced braces');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + text.slice(start, end) + ');')();
}

const datePresetRange_ = extractFn('script-1-core.html', 'datePresetRange_');

// Wednesday 2026-08-12, mid-month, mid-week -- the ordinary case.
const WED = new Date(2026, 7, 12);

test('THE RULE: no open-ended preset includes today', function () {
  const openEnded = ['yesterday', 'last7', 'thisWeek', 'thisMonth',
                     'last30', 'last3Months', 'last12Months'];
  openEnded.forEach(function (v) {
    const r = datePresetRange_(v, WED);
    assert.equal(r.to, '2026-08-11', v + ' must end YESTERDAY, not today');
  });
});

test('ordinary windows resolve correctly off a mid-week, mid-month day', function () {
  assert.deepEqual(datePresetRange_('yesterday', WED), { from: '2026-08-11', to: '2026-08-11' });
  assert.deepEqual(datePresetRange_('last7', WED), { from: '2026-08-05', to: '2026-08-11' });
  // Wednesday -> Monday the 10th.
  assert.deepEqual(datePresetRange_('thisWeek', WED), { from: '2026-08-10', to: '2026-08-11' });
  assert.deepEqual(datePresetRange_('thisMonth', WED), { from: '2026-08-01', to: '2026-08-11' });
  assert.deepEqual(datePresetRange_('last30', WED), { from: '2026-07-13', to: '2026-08-11' });
  assert.deepEqual(datePresetRange_('last3Months', WED), { from: '2026-05-12', to: '2026-08-11' });
  assert.deepEqual(datePresetRange_('last12Months', WED), { from: '2025-08-12', to: '2026-08-11' });
});

test('fixed historical windows are unchanged (they never included today)', function () {
  assert.deepEqual(datePresetRange_('lastWeek', WED), { from: '2026-08-03', to: '2026-08-09' });
  assert.deepEqual(datePresetRange_('lastMonth', WED), { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(datePresetRange_('lastYear', WED), { from: '2025-01-01', to: '2025-12-31' });
});

test("'today' is the ONE preset that still means today (the Queue report's explicit pick)", function () {
  // A preset the user chose BY NAME must not silently return yesterday.
  assert.deepEqual(datePresetRange_('today', WED), { from: '2026-08-12', to: '2026-08-12' });
});

test('degenerate edges clamp instead of inverting (start > end would be rejected)', function () {
  // "This month" on the 1st: yesterday is in the PREVIOUS month.
  const first = new Date(2026, 7, 1);
  assert.deepEqual(datePresetRange_('thisMonth', first), { from: '2026-08-01', to: '2026-08-01' });
  // "This week" on a Monday: yesterday is Sunday, before the week started.
  const mon = new Date(2026, 7, 10);
  assert.deepEqual(datePresetRange_('thisWeek', mon), { from: '2026-08-10', to: '2026-08-10' });
});

test('month/year arithmetic survives boundaries', function () {
  // Jan 1 -> "last month" is all of December, "last year" is the prior year.
  const jan1 = new Date(2026, 0, 1);
  assert.deepEqual(datePresetRange_('lastMonth', jan1), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(datePresetRange_('lastYear', jan1), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(datePresetRange_('yesterday', jan1), { from: '2025-12-31', to: '2025-12-31' });
  // Leap day is reachable and does not roll.
  assert.deepEqual(datePresetRange_('yesterday', new Date(2028, 2, 1)),
    { from: '2028-02-29', to: '2028-02-29' });
});

test("'custom' and unknown keys resolve to null (the caller leaves the fields alone)", function () {
  assert.equal(datePresetRange_('custom', WED), null);
  assert.equal(datePresetRange_('', WED), null);
  assert.equal(datePresetRange_('nonsense', WED), null);
});

test('tripwire: every preset resolver delegates -- none computes its own dates', function () {
  // The six resolvers drifted BECAUSE each owned a copy of the rule. If a new
  // one appears (or an old one is "fixed" locally), this fails: a preset
  // handler that mentions a preset key must reach the shared resolver.
  const FRAGMENTS = ['script-6-ir.html', 'script-8-insights.html',
                     'script-9-inbound-direct.html', 'script-11-qcd-boot.html'];
  FRAGMENTS.forEach(function (f) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const offenders = [];
    text.split('\n').forEach(function (ln, i) {
      if (/=== 'thisMonth'|=== 'last30'|=== 'last3Months'|=== 'thisWeek'|=== 'last12Months'/.test(ln)) {
        offenders.push(f + ':' + (i + 1));
      }
    });
    assert.deepEqual(offenders, [],
      f + ' computes preset dates locally again -- route it through '
      + 'datePresetRange_ (script-1-core) so the "never include today" rule '
      + 'cannot drift: ' + offenders.join(', '));
  });
});
