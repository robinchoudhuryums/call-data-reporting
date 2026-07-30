'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Apps Script's Logger.log substitutes %s but does NOT honour printf WIDTH
// forms (%-28s, %-5d). A width form prints literally AND swallows the argument
// list, so the line comes out with the specifier visible and the values gone.
//
// This shipped once: the first run of auditQueueSplitAttribution emitted
//   "     %-28s rung=%-5s answered=%-5s  -> A_Q_CSR"
// for every queue -- the padding literal, no numbers, and the one plain %s
// picking up the FIRST argument rather than the last. The reconciliation lines
// survived only because they used bare %s. Pad by hand instead.
//
// Comments are stripped before scanning: the audit's own comment quotes the
// broken format string to explain the bug, and a naive scan flags its own
// documentation. (That mistake was made twice in one session -- once here and
// once in the sticky-header guard -- which is why it is called out.)

const DIRS = [
  'apps-script/department-dashboard',
  'apps-script/cdr-import',
  'apps-script/cdr-report',
];

function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock.split('\n').map(function (line) {
    return line.replace(/(^|[^:'"])\/\/.*$/, '$1');
  }).join('\n');
}

test('no Logger.log format string uses printf WIDTH forms (Apps Script ignores them)', function () {
  const offenders = [];
  DIRS.forEach(function (dir) {
    const abs = path.join(__dirname, '..', '..', dir);
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs).forEach(function (f) {
      if (!/\.(gs|js)$/.test(f)) return;
      const src = stripComments(fs.readFileSync(path.join(abs, f), 'utf8'));
      // Both quote styles; the format string is Logger.log's first argument.
      [/Logger\.log\(\s*'([^']*)'/g, /Logger\.log\(\s*"([^"]*)"/g].forEach(function (re) {
        let m;
        while ((m = re.exec(src)) !== null) {
          if (/%[-+ 0]?\d+(\.\d+)?[sdfx]/.test(m[1])) {
            offenders.push(dir + '/' + f + ': ' + m[1].slice(0, 70));
          }
        }
      });
    });
  });
  assert.deepEqual(offenders, [],
    'Logger.log cannot pad -- these lines will print the specifier literally and '
    + 'drop their values. Pad the value before passing it and use a bare %s.');
});
