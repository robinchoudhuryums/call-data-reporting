'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// SHARED window clamp (`clampWindowToLatest_`, script-2-chrome.html).
//
// THE RULE: a report never runs over a window extending past the data. Every
// per-workday figure divides by the INV-35 working-day count of the SELECTED
// window, so days the data does not cover silently deflate every rate and
// average -- the R18 incident had Insights' queue pace at 273.8/day where the
// side panel said 365/day, same data, because one counted days that were not
// there.
//
// The R18 clamp was wired to the dept TO-date and nothing else. Seven other
// date-entry surfaces accepted an over-long window: the dept FROM field,
// Insights (typed / popover / preset / trend drill), the Individual Report,
// and the all-departments Daily Queue Report. The owner hit it as a SPLIT
// window -- the dept controls corrected while the open Insights region kept
// reporting the uncorrected one -- but the silent half is the dangerous one.
//
// The rule now lives in one pure function that each surface applies at its
// RUN chokepoint (so every entry path is covered by one hook), and this suite
// plus the source tripwire at the bottom is what keeps that true.
//
// The function is pure, so it lifts straight out of the fragment (the
// date-presets.test.js technique -- zero-dep, no jsdom).

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

const clamp = extractFn('script-2-chrome.html', 'clampWindowToLatest_');
const LATEST = '2026-08-31';

test('THE RULE: no clamped window ends past the latest data date', function () {
  [['2026-08-01', '2026-09-30'], ['2026-08-31', '2026-09-02'],
   ['2026-09-01', '2026-09-02'], ['2026-08-31', '2026-08-31']].forEach(function (w) {
    const r = clamp(w[0], w[1], LATEST);
    assert.ok(r.to <= LATEST, w.join('..') + ' -> to must not exceed the latest date');
    assert.ok(r.from <= LATEST, w.join('..') + ' -> from must not exceed the latest date');
  });
});

test('the owner-reported case: 08/31–09/02 collapses to the one day with data', function () {
  const r = clamp('2026-08-31', '2026-09-02', LATEST);
  assert.deepEqual({ from: r.from, to: r.to, moved: r.moved },
    { from: '2026-08-31', to: '2026-08-31', moved: true });
});

test('a wholly FUTURE window collapses to latest..latest, never inverts', function () {
  // This is the shape that made the split visible: the dept controls corrected
  // while Insights kept Sep 1 – Sep 2, a window entirely past the data.
  const r = clamp('2026-09-01', '2026-09-02', LATEST);
  assert.deepEqual({ from: r.from, to: r.to, moved: r.moved },
    { from: LATEST, to: LATEST, moved: true });
  assert.ok(r.from <= r.to, 'clamping must never invert a range');
});

test('a window already inside the data is returned untouched and unflagged', function () {
  const r = clamp('2026-08-01', '2026-08-31', LATEST);
  assert.deepEqual({ from: r.from, to: r.to, moved: r.moved },
    { from: '2026-08-01', to: '2026-08-31', moved: false });
});

test('clamping never INVERTS: from <= to is preserved for every window', function () {
  const days = ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'];
  days.forEach(function (f) {
    days.forEach(function (t) {
      if (f > t) return;                      // not a valid input window
      const r = clamp(f, t, LATEST);
      assert.ok(r.from <= r.to, f + '..' + t + ' inverted to ' + r.from + '..' + r.to);
    });
  });
});

test('a null latest (init fetch not landed) returns the window UNTOUCHED', function () {
  // Never clamp against a null and land everyone on today -- the R18 rule.
  const r = clamp('2026-08-01', '2026-09-30', null);
  assert.deepEqual({ from: r.from, to: r.to, moved: r.moved },
    { from: '2026-08-01', to: '2026-09-30', moved: false });
});

test('`moved` reports whether a correction happened, so callers can announce it', function () {
  assert.equal(clamp('2026-08-01', '2026-08-31', LATEST).moved, false, 'in-range must be silent');
  assert.equal(clamp('2026-08-01', '2026-09-01', LATEST).moved, true, 'a correction must be announced');
});

// ── Source tripwire (C2: what enforces this?) ────────────────────────────────
//
// The clamp is SOURCE-AWARE by parameter: DQE-backed surfaces pass
// latestDqeIso_, the QCD-backed Daily Queue Report passes latestQcdIso_.
// Clamping to the wrong source would HIDE data that exists -- worse than the
// bug being fixed -- so the wiring is pinned, not just the arithmetic.

function read(f) { return fs.readFileSync(path.join(DIR, f), 'utf8'); }

test('every report RUN chokepoint clamps, and to its OWN source', function () {
  const SITES = [
    ['script-8-insights.html',  'runInsReport',   'ins-from',           'latestDqeIso_'],
    ['script-6-ir.html',        'runIrReport',    'ir-from',            'latestDqeIso_'],
    ['script-11-qcd-boot.html', 'runQcdAllDept_', 'qcd-alldept-from',   'latestQcdIso_'],
  ];
  SITES.forEach(function (s) {
    const file = s[0], fn = s[1], input = s[2], source = s[3];
    const text = read(file);
    const start = text.indexOf('function ' + fn + '(');
    assert.notEqual(start, -1, fn + ' is missing from ' + file);
    // The clamp must sit in the first ~40 lines of the body: BEFORE the
    // window is read into locals, or it corrects nothing.
    const head = text.slice(start, start + 2600);
    // Match the WHOLE call including its source argument. Searching the head
    // for the source name alone is not enough: the explanatory comment above
    // each call names it too, so a call wired to the WRONG source would still
    // find the string and pass (caught by mutation -- the first version of
    // this test asserted against a comment).
    const call = new RegExp("clampInputsToLatest_\\(\\s*'" + input + "'\\s*,\\s*'[a-z0-9-]+'\\s*,\\s*"
      + source + "\\s*\\)");
    assert.ok(call.test(head),
      fn + ' must clamp ' + input + ' against ' + source + ' at its run '
      + 'chokepoint. Every entry path for that report funnels through here, so '
      + 'dropping the hook silently restores over-long windows on all of them; '
      + "clamping to the other source's latest date would hide data that exists.");
  });
});

test('the dept controls clamp BOTH ends, not just To', function () {
  const text = read('script-2-chrome.html');
  assert.ok(/clampInputsToLatest_\('from-date',\s*'to-date',\s*latestDqeIso_\)/.test(text),
    'clampDeptToDate_ must clamp the pair -- a From past the data used to be '
    + 'corrected only incidentally, when a later To edit happened to invert it.');
  // Scope to the from-date listener's OWN body: a fixed-width window bleeds
  // into the NEXT listener, and the to-date one legitimately clamps -- so the
  // assertion passed even with the from-date hook deleted (caught by mutation).
  const at = text.indexOf("$('from-date').addEventListener");
  assert.notEqual(at, -1, 'the from-date change listener is missing');
  const body = text.slice(at, text.indexOf('});', at));
  assert.ok(body.indexOf('clampDeptToDate_') !== -1,
    "the from-date change listener must clamp, like to-date's does -- without "
    + 'it a From past the data is corrected only incidentally.');
  assert.ok(body.indexOf("$('to-date')") === -1,
    'this assertion must read the from-date listener alone; it is now spanning '
    + 'into the to-date listener and would pass on its clamp instead.');
});

test('the per-call surfaces are deliberately NOT clamped (no latest date exists)', function () {
  // Inbound / Outbound / Direct / Caller Lookup read the per-call tables, and
  // the client holds no latest date for those. Wiring them to latestDqeIso_
  // would clamp away real rows. If a per-call latest is ever added, delete
  // this test in the same commit that wires them up.
  ['inbound-from', 'outbound-from', 'direct-call-from', 'cl-from'].forEach(function (id) {
    const hit = ['script-9-inbound-direct.html', 'script-4-nav.html', 'script-2-chrome.html']
      .some(function (f) {
        try { return read(f).indexOf("clampInputsToLatest_('" + id + "'") !== -1; }
        catch (e) { return false; }
      });
    assert.equal(hit, false, id + ' is now clamped -- if that is intentional, it '
      + 'must clamp to a per-call latest date, not a DQE/QCD one, and this '
      + 'test should be removed in that commit.');
  });
});
