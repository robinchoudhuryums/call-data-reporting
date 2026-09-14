'use strict';

// 6a: SECTION ORDER for the in-app Daily Call Queue Report
// (`qcdAllDeptSections_`, script-11-qcd-boot.html).
//
// THE RULE: the viewer's own section is pinned first; every other section
// follows WORST-FIRST, by the emailed report's comparator -- section abandoned
// % DESC, tie-broken by RANGE violations DESC -- where a section is a parent
// dept plus its nested children, summed. Rows WITHIN a section never move.
//
// The owner reversed the earlier "worst-first is email-only" ruling on
// 2026-09-14. Two things this suite exists to keep true:
//   (1) the TABLE and the CSV order sections IDENTICALLY -- the export used to
//       rebuild its own grouping and ignore even the pre-6a viewer float, so a
//       downloaded file disagreed with the screen it came from; both now call
//       this one helper, and the tripwire at the bottom fails if either grows
//       its own grouping loop again;
//   (2) the comparator matches QueueReportEmail.gs's, so the two renderings of
//       the same day rank departments the same way.
//
// The helper is pure, so it lifts straight out of the fragment (the
// date-presets.test.js / window-clamp.test.js technique -- zero-dep, no jsdom).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const FRAG = 'script-11-qcd-boot.html';
const fragText = fs.readFileSync(path.join(DIR, FRAG), 'utf8');

function fnSource(text, name, file) {
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
  return text.slice(start, end);
}

// qcdAllDeptSections_ leans on the section-total helper (and that on the
// violations + duration formatters), so all four load into one scope.
const NAMES = ['qcdSecToHms_', 'qcdViolShow_', 'qcdAllDeptSectionTotal_', 'qcdAllDeptSections_'];
const sections = (function () {
  const src = NAMES.map(function (n) { return fnSource(fragText, n, FRAG); }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn qcdAllDeptSections_;')();
})();

// A queue row carrying only the fields the section total reads.
function q(calls, abandoned, viol) {
  return {
    queue: 'A_Q_x', totalCalls: calls, totalAnswered: calls - abandoned,
    abandoned: abandoned, violations: viol || 0, violationsMtd: viol || 0,
    longestWaitSec: 0, avgAnswerSec: 0,
  };
}
function dept(name, queues, parent) {
  return { dept: name, parent: parent || null, queues: queues };
}
function names(res) { return res.topLevel.map(function (d) { return d.dept; }); }

// Alphabetical, the shape the server actually ships.
//   Alpha   2/100 = 2.00%,          0 violations
//   Bravo  10/100 = 10.00%,         1 violation
//   Delta   5/100 = 5.00%,          9 violations
//   Charlie 5/100 = 5.00%,          2 violations
function fixture() {
  return [dept('Alpha', [q(100, 2, 0)]), dept('Bravo', [q(100, 10, 1)]),
          dept('Charlie', [q(100, 5, 2)]), dept('Delta', [q(100, 5, 9)])];
}

test('THE RULE: sections sort worst-first by abandoned %', function () {
  assert.deepEqual(names(sections(fixture(), '')), ['Bravo', 'Delta', 'Charlie', 'Alpha']);
});

test('a tie on abandoned % breaks on RANGE violations, descending', function () {
  // Charlie and Delta are both 5.00%; Delta's 9 violations put it first.
  const order = names(sections(fixture(), ''));
  assert.ok(order.indexOf('Delta') < order.indexOf('Charlie'),
    'the more-violating of two equally-abandoning depts sorts first');
});

test('a tie on BOTH keys breaks on dept name, so order never depends on the payload order', function () {
  const rows = [dept('Zulu', [q(100, 5, 1)]), dept('Mike', [q(100, 5, 1)])];
  assert.deepEqual(names(sections(rows, '')), ['Mike', 'Zulu']);
  assert.deepEqual(names(sections(rows.slice().reverse(), '')), ['Mike', 'Zulu'],
    'reversing the input must not change the output');
});

test('the viewer’s own dept is pinned first whatever its numbers', function () {
  // Alpha is the HEALTHIEST section -- the pin still outranks the comparator.
  assert.deepEqual(names(sections(fixture(), 'Alpha')),
    ['Alpha', 'Bravo', 'Delta', 'Charlie']);
});

test('a viewer on a CHILD dept pins the PARENT section', function () {
  const rows = fixture().concat([dept('AlphaKids', [q(100, 1, 0)], 'Alpha')]);
  const res = sections(rows, 'AlphaKids');
  assert.equal(res.mySection, 'Alpha', 'the child floats its parent section');
  assert.equal(names(res)[0], 'Alpha');
  assert.equal(names(res).indexOf('AlphaKids'), -1, 'a child is never a top-level section');
});

test('an unknown / absent viewer dept is a clean no-op', function () {
  assert.deepEqual(names(sections(fixture(), 'NotHere')), names(sections(fixture(), '')));
  assert.equal(sections(fixture(), 'NotHere').mySection, '');
});

test('a section is the parent PLUS its children, summed -- not the parent alone', function () {
  // Parent alone is 1% (healthiest); with its child it is 20/200 = 10%, which
  // ties Bravo on pct and wins on violations. Summing is what moves it.
  const rows = fixture().concat([dept('AlphaKids', [q(100, 18, 4)], 'Alpha')]);
  const order = names(sections(rows, ''));
  assert.equal(order[0], 'Alpha',
    'a healthy parent carrying a bad child ranks by the SECTION, like the email');
});

test('rows within a section are untouched -- only sections move', function () {
  const rows = [dept('Bravo', [q(10, 0, 0), q(100, 90, 5), q(10, 1, 0)]),
                dept('Alpha', [q(100, 1, 0)])];
  const res = sections(rows, '');
  assert.deepEqual(res.topLevel[0].queues.map(function (x) { return x.abandoned; }), [0, 90, 1],
    'configured queue order inside a section is preserved');
});

test('childrenOf nests each child under its parent; an ORPHANED child stays top-level', function () {
  const rows = fixture().concat([dept('AlphaKids', [q(10, 0, 0)], 'Alpha'),
                                 dept('Ghost', [q(10, 0, 0)], 'NoSuchParent')]);
  const res = sections(rows, '');
  assert.deepEqual((res.childrenOf['Alpha'] || []).map(function (d) { return d.dept; }), ['AlphaKids']);
  assert.ok(names(res).indexOf('Ghost') !== -1,
    'a child naming a dept absent from this window falls back to its own section');
});

test('empty / missing input does not throw', function () {
  assert.deepEqual(names(sections([], 'Alpha')), []);
  assert.deepEqual(names(sections(null, '')), []);
});

// --- Cross-file: the comparator must match the email's ----------------------

test('the email ranks the same fixture the same way (both are pct DESC, then violations DESC)', function () {
  const emailText = fs.readFileSync(path.join(DIR, 'QueueReportEmail.gs'), 'utf8');
  // The email's own table comparator, lifted verbatim from its source so a
  // one-sided edit fails here rather than drifting silently.
  assert.match(emailText,
    /return \(sb\.pct - sa\.pct\) \|\| \(sb\.viol - sa\.viol\);/,
    'QueueReportEmail.gs section comparator changed -- re-check 6a parity');
  // 6a ride-along: the alert/preheader offender list had the two priorities
  // REVERSED, so it could name a different "worst" queue than the table.
  assert.match(emailText,
    /offenders\.sort\(function \(a, b\) \{ return \(b\.pct - a\.pct\) \|\| \(b\.viol - a\.viol\); \}\);/,
    'the offender list must rank pct-then-violations, like the table');
  assert.doesNotMatch(emailText, /Worst-first ordering is EMAIL-ONLY/,
    'the email-only ruling was reversed on 2026-09-14 -- the header comment must say so');
});

// --- Tripwire: neither caller may rebuild its own grouping ------------------

test('TRIPWIRE: the table AND the CSV both order through the shared helper', function () {
  const calls = fragText.match(/qcdAllDeptSections_\(/g) || [];
  assert.equal(calls.length, 3,
    'expected the definition + exactly two call sites (render + CSV); found ' + calls.length);
  ['qcdAllDeptRender_', 'qcdAllDeptCsv_'].forEach(function (fn) {
    const body = fnSource(fragText, fn, FRAG);
    assert.match(body, /qcdAllDeptSections_\(/, fn + ' must order through the shared helper');
    assert.doesNotMatch(body, /childrenOf\[d\.parent\] = childrenOf\[d\.parent\]/,
      fn + ' rebuilt its own parent/child grouping -- use qcdAllDeptSections_');
  });
});
