'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// summary v24 (owner 2026-10-20, idle rows): the answered/missed bar cell
// (`answeredBarHtml_`, script-1-core.html). A row with no calls drew an EMPTY
// full-width gray track, which beside the agents' volume tallies read as a
// broken row. It now draws a muted dash; a row with calls is unchanged. The
// function lifts out of the fragment with its few helpers stubbed (the
// date-presets.test.js technique -- zero-dep, no jsdom).

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function extractFnText(file, name) {
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
  return text.slice(start, end);
}

// eslint-disable-next-line no-new-func
const answeredBarHtml_ = new Function(
  'wowChipHtml_', 'getRequestedDept', 'answerStdFor_', 'escapeHtml', 'zeroCell_',
  'ansTallyBlocks_', 'ansPerDayHtml_',
  'return (' + extractFnText('script-1-core.html', 'answeredBarHtml_') + ');'
)(
  function () { return ''; },
  function () { return 'Alpha'; },
  function () { return { target: 90 }; },
  function (s) { return String(s); },
  function (s) { return '<span class="cell-zero">' + s + '</span>'; },
  function (n, unit, cls) { let out = ''; for (let i = 0; i < Math.round(n / unit); i++) out += '<i class="tly ' + cls + '"></i>'; return out; },
  function () { return ''; }
);

test('v24: a row with no calls draws a muted dash, not an empty full-width track', function () {
  [0, 5].forEach(function (unit) {   // agent row (tally) and totals row (classic)
    const html = answeredBarHtml_({ totalAnswered: 0, totalMissed: 0, totalRung: 0 }, unit);
    assert.ok(html.indexOf('ans-idle') !== -1, 'unit ' + unit + ': the idle dash renders');
    assert.ok(html.indexOf('ans-track') === -1 && html.indexOf('ans-seg') === -1,
      'unit ' + unit + ': no empty gray track');
    assert.ok(html.indexOf('(0)') !== -1, 'the counts still read 0 / 0 (0)');
  });
});

test('v24: a row with calls is unchanged -- tally on agent rows, proportional track on totals', function () {
  const row = { totalAnswered: 15, totalMissed: 5, totalRung: 20 };
  const tally = answeredBarHtml_(row, 5);
  assert.ok(tally.indexOf('ans-tally') !== -1 && tally.indexOf('ans-idle') === -1);
  assert.equal((tally.match(/tly a/g) || []).length, 3);
  const classic = answeredBarHtml_(row, 0);
  assert.ok(classic.indexOf('class="ans-track"') !== -1);
  assert.ok(classic.indexOf('width:75%') !== -1 && classic.indexOf('width:25%') !== -1);
  assert.ok(classic.indexOf('ans-idle') === -1);
});
