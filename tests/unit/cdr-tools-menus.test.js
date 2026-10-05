'use strict';

// The "CDR Tools" spreadsheet menus of the two pipeline projects --
// cdr-import (CDR Tools.js) and cdr-report (CDR Tools menu.js). A menu item
// names its function as a STRING, so a typo or a renamed function is
// invisible to lint and to every behavioural suite -- the item just throws
// "Script function not found" when an operator clicks it. Source pins only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'apps-script');

function load(project, menuFile) {
  const dir = path.join(ROOT, project);
  const menu = fs.readFileSync(path.join(dir, menuFile), 'utf8');
  const defined = new Set();
  fs.readdirSync(dir).filter(f => /\.(js|gs)$/.test(f)).forEach(function (f) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defined.add(m[1]);
  });
  // Live (uncommented) code only.
  const live = menu.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const items = Array.from(live.matchAll(/\.addItem\(\s*(['"])(.*?)\1\s*,\s*(['"])([\w$]+)\3\s*\)/g))
    .map(m => ({ label: m[2], fn: m[4] }));
  const main = live.slice(live.search(/ui\.createMenu\((['"])CDR Tools\1\)/), live.indexOf('.addToUi()'));
  return { menu, live, defined, items, main };
}

const MENUS = [
  { project: 'cdr-import', file: 'CDR Tools.js', minItems: 20, topItems: 1 },
  { project: 'cdr-report', file: 'CDR Tools menu.js', minItems: 25, topItems: 0 },
];

MENUS.forEach(function (spec) {
  const m = load(spec.project, spec.file);

  test(spec.project + ': every CDR Tools menu item names a defined, public function', function () {
    assert.ok(m.items.length >= spec.minItems, 'the parser found the menu (' + m.items.length + ' items)');
    const missing = m.items.filter(i => !m.defined.has(i.fn) || /_$/.test(i.fn));
    assert.deepEqual(missing, [], 'menu items whose function is missing or private (`_` suffix)');
  });

  test(spec.project + ': the top level stays short -- jobs are grouped into submenus', function () {
    assert.ok(m.main.length > 0, 'found the CDR Tools menu chain');
    assert.equal(Array.from(m.main.matchAll(/\.addItem\(/g)).length, spec.topItems,
      'items directly on the top level');
    assert.ok(Array.from(m.main.matchAll(/\.addSubMenu\(/g)).length >= 6);
  });

  test(spec.project + ': one menu only -- no second createMenu(...).addToUi() chain', function () {
    assert.equal(Array.from(m.live.matchAll(/\.addToUi\(\)/g)).length, 1);
  });
});

test('cdr-import: tools retired from the menu are still defined (editor-runnable, as the menu comment says)', function () {
  const m = load('cdr-import', 'CDR Tools.js');
  ['previewInternalTransferChainsForDate', 'previewInternalTransferPathsForDate',
   'previewCallLegShapesForDate', 'previewRow34Overlap',
   'installExecCeilingProbeTrigger', 'readExecCeilingProbe'].forEach(function (fn) {
    assert.ok(m.defined.has(fn), fn);
    assert.ok(m.menu.indexOf(fn) !== -1, fn + ' is named in the menu file\'s retired list');
    assert.ok(!m.items.some(i => i.fn === fn), fn + ' is no longer a menu item');
  });
});

test('cdr-report: labels another surface quotes stay as quoted', function () {
  // The dashboard Health page's workbook-cells hint (pinned in the CH-4 golden)
  // and the sort check's not-installed message name these submenus.
  const m = load('cdr-report', 'CDR Tools menu.js');
  assert.ok(m.live.indexOf("'🧮 Workbook Cell Space'") !== -1);
  assert.ok(m.live.indexOf("'⏰ Nightly Historical Sort Check'") !== -1);
  const health = fs.readFileSync(path.join(ROOT, 'department-dashboard', 'SystemHealth.gs'), 'utf8');
  assert.match(health, /CDR Tools → Workbook Cell Space → Audit/);
  assert.ok(m.items.some(i => i.label === 'Audit (read-only)' && i.fn === 'auditSheetSpace'));
});
