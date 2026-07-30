'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Why this exists (2026-07, shipped to production before anyone noticed).
//
// styles.html and script.html are Apps Script INCLUDES: their whole body is
// injected into dashboard.html inside a single <style> / <script> element. The
// sub-queue Phase 1 CSS was appended to styles.html *after* its closing
// </style> tag, so ~40 lines of raw CSS -- comment banner first -- rendered as
// visible text at the top of the page for every user.
//
// Nothing caught it. The rendered-UI gate boots the real client and asserts
// console errors, blank canvases and horizontal overflow; stray text produces
// none of those, because the browser is doing exactly what the markup says.
// The failure is structural, so this is a structural check: the tag that wraps
// the file must actually wrap ALL of it.
//
// The rule for anyone appending to these files: content goes BEFORE the closing
// tag, which lives on the last line. Appending to the end of the file is the
// natural motion and is exactly what breaks it.

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

const INCLUDES = [
  { file: 'styles.html', tag: 'style' },
  { file: 'script.html', tag: 'script' },
];

INCLUDES.forEach(function (spec) {
  test(spec.file + ': the wrapping <' + spec.tag + '> encloses the ENTIRE file', function () {
    const text = fs.readFileSync(path.join(DIR, spec.file), 'utf8');
    const open = '<' + spec.tag + '>';
    const close = '</' + spec.tag + '>';

    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    assert.equal(opens, 1, spec.file + ' must contain exactly one ' + open);
    assert.equal(closes, 1, spec.file + ' must contain exactly one ' + close);

    const before = text.slice(0, text.indexOf(open)).trim();
    assert.equal(before, '',
      'nothing may precede ' + open + ' -- it would render as literal text');

    const after = text.slice(text.indexOf(close) + close.length).trim();
    assert.equal(after, '',
      'NOTHING may follow ' + close + '. Found ' + after.length + ' chars, starting: '
      + JSON.stringify(after.slice(0, 120))
      + '\nThis is the exact bug that shipped: content appended to the end of the '
      + 'file lands OUTSIDE the tag and renders as visible text on the page. '
      + 'Move it above the closing tag.');
  });
});

test('styles.html: the sub-queue CSS is inside the style element', function () {
  // A named regression pin for the block that actually escaped, so a future
  // refactor that re-appends it is caught by name rather than by byte offset.
  const text = fs.readFileSync(path.join(DIR, 'styles.html'), 'utf8');
  const marker = text.indexOf('Sub-queue scope bar + grouped agent table');
  assert.notEqual(marker, -1, 'the Phase 1 sub-queue CSS block is missing entirely');
  assert.ok(marker < text.indexOf('</style>'),
    'the sub-queue CSS must sit ABOVE </style> -- it shipped below it once');
});
