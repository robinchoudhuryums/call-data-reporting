'use strict';

// The cdr-import "CDR Tools" menu (CDR Tools.js). A menu item names its
// function as a STRING, so a typo or a renamed function is invisible to lint
// and to every behavioural suite -- the item just throws "Script function not
// found" when an operator clicks it. Source pins only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'cdr-import');
const menu = fs.readFileSync(path.join(DIR, 'CDR Tools.js'), 'utf8');
const defined = new Set();
fs.readdirSync(DIR).filter(f => /\.(js|gs)$/.test(f)).forEach(function (f) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defined.add(m[1]);
});
// Live (uncommented) addItem calls only.
const live = menu.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const items = Array.from(live.matchAll(/\.addItem\(\s*(['"])(.*?)\1\s*,\s*(['"])([\w$]+)\3\s*\)/g))
  .map(m => ({ label: m[2], fn: m[4] }));

test('every CDR Tools menu item names a top-level function this project defines', function () {
  assert.ok(items.length >= 20, 'the parser found the menu (' + items.length + ' items)');
  const missing = items.filter(i => !defined.has(i.fn) || /_$/.test(i.fn));
  assert.deepEqual(missing, [], 'menu items whose function is missing or private (`_` suffix)');
});

test('the top level stays short: Manual Export plus submenus', function () {
  const main = live.slice(live.indexOf('ui.createMenu("CDR Tools")'), live.indexOf('.addToUi()'));
  const topItems = Array.from(main.matchAll(/\.addItem\(/g)).length;
  assert.equal(topItems, 1, 'only Manual Export sits directly on the menu; everything else is grouped');
  assert.ok(Array.from(main.matchAll(/\.addSubMenu\(/g)).length >= 5);
});

test('tools retired from the menu are still defined (editor-runnable, as the menu comment says)', function () {
  ['previewInternalTransferChainsForDate', 'previewInternalTransferPathsForDate',
   'previewCallLegShapesForDate', 'previewRow34Overlap',
   'installExecCeilingProbeTrigger', 'readExecCeilingProbe'].forEach(function (fn) {
    assert.ok(defined.has(fn), fn);
    assert.ok(menu.indexOf(fn) !== -1, fn + ' is named in the menu file\'s retired list');
    assert.ok(!items.some(i => i.fn === fn), fn + ' is no longer a menu item');
  });
});
