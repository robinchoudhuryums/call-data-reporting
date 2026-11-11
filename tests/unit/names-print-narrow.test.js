'use strict';

// Broad-scan 2026-11-10, Batch 10 -- names, announcements, print, small screens
// (F73, F81, F78, F76, F80, F43; fix codes NPS-1..6). Six client defects about
// what a page says to someone who is not looking at a wide screen in light
// mode with a mouse: paper, a phone, a screen reader, dark mode.
//
// The two small functions run here against fake elements; the rest is markup
// and CSS, pinned by SWEEPS (every canvas, every status line, every filled
// segment) so the next one added cannot be the exception. The rendered proof
// is in `npm run ci:ui` (drive-admin.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
function src(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }
const FRAGMENTS = fs.readdirSync(DIR).filter(function (f) { return /^script-\d+-.*\.html$/.test(f); }).sort();
const css = src('styles.html');
const dash = src('dashboard.html');
const core = src('script-1-core.html');

function extractFn(text, name) {
  const at = text.search(new RegExp('function ' + name + '\\('));
  assert.ok(at >= 0, 'function ' + name + ' not found');
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unbalanced function ' + name);
}
// The text of one top-level `@media ... { ... }` block that starts at `at`.
function block(text, at) {
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unbalanced block');
}
function classSet(list) {
  const set = {};
  (list || []).forEach(function (c) { set[c] = true; });
  return { add: function (c) { set[c] = true; }, remove: function (c) { delete set[c]; },
           contains: function (c) { return !!set[c]; }, _set: set };
}

// ── NPS-1 (F73): Ctrl+P with a modal open prints the modal ──────────────────

function printSandbox(modals, bodyClasses, trapModal) {
  const body = { classList: classSet(bodyClasses) };
  const doc = { body: body, querySelectorAll: function (sel) {
    if (sel === 'body > .modal') return modals;
    if (sel === '.modal.is-printing') return modals.filter(function (m) { return m.classList.contains('is-printing'); });
    return [];
  } };
  const sb = { document: doc, activeFocusTrap_: trapModal ? { modal: trapModal } : null,
    layerIsShown_: function (el) { return !!(el && el.shown); },
    window: { addEventListener: function () {} } };
  vm.runInNewContext(extractFn(core, 'printModalTarget_') + extractFn(core, 'printModalBegin_') + extractFn(core, 'printModalEnd_'), sb);
  return { sb: sb, body: body };
}
function modal(id, shown) { return { id: id, shown: shown, classList: classSet(['modal']) }; }

test('NPS-1: the browser\'s own print marks the top open modal, and unmarks it after', function () {
  const help = modal('help', false), inbound = modal('inbound', true), alerts = modal('alerts', false);
  let p = printSandbox([help, inbound, alerts], [], null);
  p.sb.printModalBegin_();
  assert.ok(p.body.classList.contains('modal-printing'));
  assert.ok(inbound.classList.contains('is-printing'), 'the one open modal is the document');
  assert.ok(!help.classList.contains('is-printing') && !alerts.classList.contains('is-printing'));
  p.sb.printModalEnd_();
  assert.ok(!p.body.classList.contains('modal-printing') && !inbound.classList.contains('is-printing'), 'the screen is as it was');

  // Help open OVER a report: Help holds the focus trap, so Help is what prints.
  help.shown = true;
  p = printSandbox([help, inbound, alerts], [], help);
  assert.equal(p.sb.printModalTarget_(), help);

  // No modal open: an ordinary page print, untouched.
  p = printSandbox([modal('a', false)], [], null);
  p.sb.printModalBegin_();
  assert.ok(!p.body.classList.contains('modal-printing'));

  // The scripted Individual / Insights prints set their own class first and are left alone.
  ['ir-printing', 'ins-printing'].forEach(function (c) {
    p = printSandbox([inbound], [c], inbound);
    assert.equal(p.sb.printModalTarget_(), null, c + ' owns the page');
  });
  assert.match(core, /window\.addEventListener\('beforeprint', printModalBegin_\);\s*\n\s*window\.addEventListener\('afterprint', printModalEnd_\);/);
});

test('NPS-1: the print rules hide the page behind, and un-cap and un-scroll the panel', function () {
  const print = block(css, css.indexOf('@media print {'));
  assert.match(print, /body\.modal-printing > \*:not\(\.modal\) \{ display: none !important; \}/, 'the page behind is off the paper');
  assert.match(print, /body\.modal-printing \.modal:not\(\.is-printing\) \{ display: none !important; \}/);
  assert.match(print, /body\.modal-printing \.modal\.is-printing \{\s*position: static !important;/);
  const panel = /body\.modal-printing \.modal\.is-printing \.modal-panel \{([^}]*)\}/.exec(print);
  assert.ok(panel, 'a panel rule');
  ['max-height: none !important', 'overflow: visible !important', 'position: static !important', 'transform: none !important']
    .forEach(function (d) { assert.ok(panel[1].indexOf(d) !== -1, 'panel: ' + d); });
  assert.match(print, /body\.modal-printing \.modal\.is-printing \.modal-panel-body \{\s*overflow: visible !important;/);
  // NPS-2 turns a narrow modal's tables into scrollers; paper gets real tables back.
  assert.match(print, /body\.modal-printing \.modal\.is-printing table\.al-config-table,[\s\S]{0,300}\{ display: table !important; \}/);
  assert.match(print, /body\.modal-printing \.modal-close,/);
});

// ── NPS-2 (F81): modals at tablet and phone widths ──────────────────────────

test('NPS-2: at narrow widths a wide table scrolls by itself, not the whole modal body', function () {
  const at = css.indexOf('@media (max-width: 820px) {\n    .modal-panel-body table.al-config-table');
  assert.ok(at !== -1, 'the 820px table rule');
  const rule = block(css, at);
  ['table.al-config-table', 'table.al-log-table', 'table.al-results-table', 'table.qcd-source-table'].forEach(function (t) {
    assert.ok(rule.indexOf('.modal-panel-body ' + t) !== -1, t + ' is covered');
  });
  assert.match(rule, /display: block; max-width: 100%; overflow-x: auto;/);

  // The phone padding must come AFTER the wide-variant rules it overrides
  // (same specificity: the later rule wins -- it shipped above them once, and did nothing).
  const wide = css.indexOf('.modal-panel-wide .modal-panel-body   { padding: 14px 28px 22px; }');
  const phone = css.indexOf('@media (max-width: 600px) {\n    .modal, .modal.modal-wide { padding: 8px; }');
  assert.ok(wide !== -1 && phone !== -1 && phone > wide, 'the phone rule follows the wide-variant padding');
  assert.ok(css.indexOf('.modal.modal-wide { padding: 16px; }') < phone);
  assert.match(block(css, phone), /\.modal-panel-body, \.modal-panel-wide \.modal-panel-body \{ padding: 14px 16px 20px; \}/);
});

// ── NPS-3 (F78): charts and tables have names ───────────────────────────────

test('NPS-3: every chart canvas is an image with a name; the My Department tables are named and their headers scoped', function () {
  let canvases = 0;
  FRAGMENTS.concat(['dashboard.html', 'agent.html', 'agentApp.html']).forEach(function (f) {
    const re = /<canvas\b[^>]*>/g;
    const text = src(f);
    let m;
    while ((m = re.exec(text))) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (/^\s*\/\//.test(text.slice(lineStart, m.index))) continue;   // a comment that mentions the tag
      canvases++;
      assert.ok(/\brole="img"/.test(m[0]) && /\baria-label="[^"]{8,}"/.test(m[0]), f + ': ' + m[0] + ' needs role="img" and an aria-label');
    }
  });
  assert.ok(canvases >= 10, 'all the chart canvases were swept (' + canvases + ')');

  [['agents-table', 'Agents: inbound calls'], ['agents-ob-table', 'Agents: outbound calls'], ['agents-dc-table', 'Agents: direct calls']]
    .forEach(function (t) {
      assert.ok(new RegExp('<table id="' + t[0] + '" class="[^"]*" aria-label="' + t[1] + '">').test(dash), t[0] + ' is named');
    });
  const head = dash.slice(dash.indexOf('<table id="agents-table"'), dash.indexOf('</thead>', dash.indexOf('<table id="agents-table"')));
  const ths = head.match(/<th\b[^>]*>/g) || [];
  assert.ok(ths.length >= 9 && ths.every(function (t) { return /scope="col"/.test(t); }), 'every inbound header cell is a column header');
  const s5 = src('script-5-dept.html');
  assert.match(s5, /return '<th scope="col" data-ob-sort="' \+ key \+ '" tabindex="0"'/);
  assert.match(s5, /return '<th scope="col" data-dc-sort="' \+ key \+ '" tabindex="0"'/);
});

// ── NPS-4 (F76): status, loading and error lines are live regions ───────────

test('NPS-4: every status, loading and error line in the page markup is announced', function () {
  const re = /<(div|span|p)\b([^>]*\bid="([a-z0-9-]*(?:-status|-error|-loading|-loader)|status)"[^>]*)>/g;
  let m, n = 0;
  const alerts = [];
  while ((m = re.exec(dash))) {
    if (/aria-hidden="true"/.test(m[2])) continue;          // a skeleton, not a message
    n++;
    assert.ok(/\brole="(status|alert)"/.test(m[2]), '#' + m[3] + ' is not a live region');
    if (/role="alert"/.test(m[2])) alerts.push(m[3]);
  }
  assert.ok(n >= 55, 'the sweep saw the page\'s status lines (' + n + ')');
  // An error that appears on its own (not a form field's hint) interrupts.
  ['dept-missed-error', 'qcd-alldept-form-error', 'esc-c-error', 'tdc-error'].forEach(function (id) {
    assert.ok(alerts.indexOf(id) !== -1, '#' + id + ' is an alert');
  });
  // A loading container says so politely.
  ['ov-loading', 'ir-drill-loader', 'al-loading', 'of-loading', 'ac-loading', 'dc-loading', 'cl-loading', 'ad-loading', 'esc-loading']
    .forEach(function (id) {
      assert.ok(new RegExp('id="' + id + '" role="status" aria-live="polite"').test(dash), '#' + id);
    });
});

// ── NPS-5 (F80): a benchmark tint says its tier in words ────────────────────

function tierSandbox() {
  const nav = src('script-4-nav.html');
  const sb = {};
  const decl = /var BENCH_TIER_TEXT_ = \{[^}]*\};/.exec(nav);
  assert.ok(decl, 'the tier words');
  vm.runInNewContext(decl[0] + '; this.WORDS = BENCH_TIER_TEXT_;' + extractFn(nav, 'benchTierWord_') + extractFn(nav, 'applyBenchTierTitle_'), sb);
  return sb;
}
function tinted(classes, opts) {
  return Object.assign({ title: '', attrs: {}, classList: classSet(classes),
    hasAttribute: function (k) { return k in this.attrs; },
    getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute: function (k, v) { this.attrs[k] = String(v); } }, opts || {});
}
function rootOf(els) { return { querySelectorAll: function () { return els; } }; }

test('NPS-5: the tier is spoken by CSS-generated text, in the same words the hover title uses', function () {
  const sb = tierSandbox();
  // The stylesheet's words and the script's are one vocabulary.
  [['bm-watch', 'just below target'], ['bm-bad', 'below target'], ['bm-over', 'outside the standard']].forEach(function (t) {
    assert.equal(sb.WORDS[t[0]], t[1]);
    const rule = new RegExp('\\.' + t[0] + '::after\\s*\\{ content: \', ' + t[1] + '\'; \\}').exec(css);
    assert.ok(rule, 'the stylesheet says "' + t[1] + '" after a .' + t[0] + ' value');
  });
  // Green is the unmarked case: nothing is said for it.
  assert.ok(!/\.bm-target::(after|before)/.test(css));

  // GENERATED text, not a child node: page code that reads a tinted cell's
  // text (the day quick view's Range line does) must not get the words.
  const nav = src('script-4-nav.html');
  const pass = extractFn(nav, 'applyBenchTierTitle_');
  assert.ok(!/createElement|appendChild|textContent|innerHTML/.test(pass), 'the pass never adds text to the page');

  const shared = /\.bm-watch::after, \.bm-bad::after, \.bm-over::after \{([^}]*)\}/.exec(css);
  assert.ok(shared, 'the shared clip rule');
  // position:absolute (the .sr-only recipe) escapes a sideways-scrolling table and widens the page.
  assert.ok(!/position:\s*absolute/.test(shared[1]), 'not absolutely positioned');
  assert.match(shared[1], /display: inline-block; width: 1px; height: 1px;/);
  assert.match(shared[1], /clip-path: inset\(50%\)/);
  assert.match(shared[1], /color: transparent;/, 'no stray pixel on screen or in an exported image');
});

test('NPS-5: an amber or red value gets its tier as a hover title; a title someone else wrote is kept', function () {
  const sb = tierSandbox();
  const watch = tinted(['ans-rate', 'bm-watch']), bad = tinted(['num', 'bm-bad']), over = tinted(['bm-over']);
  const ownTitle = tinted(['ap-day-rate', 'bm-bad'], { title: 'Inbound answer rate: 80%' });
  const glossed = tinted(['bm-bad'], { attrs: { 'data-gloss': 'held by the styled tooltip' } });
  const root = rootOf([watch, bad, over, ownTitle, glossed]);
  sb.applyBenchTierTitle_(root);
  assert.equal(watch.title, 'Just below target');
  assert.equal(bad.title, 'Below target');
  assert.equal(over.title, 'Outside the standard');
  assert.equal(ownTitle.title, 'Inbound answer rate: 80%', 'a title the builder wrote is kept');
  assert.equal(glossed.title, '', 'a title the glossary tooltip is holding is not doubled');

  // The pass runs on every DOM change: a second run changes nothing.
  sb.applyBenchTierTitle_(root);
  assert.equal(watch.title, 'Just below target');

  // A node whose tier changed in place gets the new words -- but only over a title this pass wrote.
  watch.classList.remove('bm-watch'); watch.classList.add('bm-bad');
  sb.applyBenchTierTitle_(root);
  assert.equal(watch.title, 'Below target');
  bad.title = 'someone edited this';
  bad.classList.remove('bm-bad'); bad.classList.add('bm-watch');
  sb.applyBenchTierTitle_(root);
  assert.equal(bad.title, 'someone edited this');

  sb.applyBenchTierTitle_(null);   // no root: no throw
  const nav = src('script-4-nav.html');
  assert.match(extractFn(nav, 'applyBenchTierTitle_'), /root\.querySelectorAll\('\.bm-watch, \.bm-bad, \.bm-over'\)/);
  // It rides the glossary's observer, first paint included.
  assert.match(extractFn(nav, 'initMetricGlossary_'), /applyGlossaryTooltips_\(document\);\s*\n\s*applyBenchTierTitle_\(document\);/);
  assert.match(extractFn(nav, 'initMetricGlossary_'), /applyGlossaryTooltips_\(document\); applyBenchTierTitle_\(document\); \}, 250\);/);
});

// ── NPS-6 (F43): text on a filled segment reads an on-fill token ────────────

test('NPS-6: the filled category segments read on-fill tokens that flip in dark mode', function () {
  assert.match(css, /--on-accent:\s+#ffffff;/);
  assert.match(css, /--on-dir-out:\s+#ffffff;/);
  assert.match(css, /--on-accent: #101418;/);
  assert.match(css, /--on-dir-out: #101418;/);
  // Paper re-asserts the light fills, so it re-asserts the light ink on them.
  const print = block(css, css.indexOf('@media print {'));
  assert.match(print, /--on-accent:\s+#ffffff !important;/);
  assert.match(print, /--on-dir-out:\s+#ffffff !important;/);
  assert.match(css, /\.ob-seg-cat1 \{ background: color-mix\(in oklab, var\(--accent\) 80%, black\); color: var\(--on-accent, #fff\); \}/);
  assert.match(css, /\.ob-seg-cat2 \{ background: var\(--accent\); color: var\(--on-accent, #fff\); \}/);
  assert.match(css, /\.ob-seg-cat4 \{ background: var\(--dir-out\); color: var\(--on-dir-out, #fff\); \}/);
  // No segment hardcodes its text colour: every one is a token or the page ink.
  const segs = css.match(/\.ob-seg-[a-z0-9-]+ \{[^}]*\}/g) || [];
  assert.ok(segs.length >= 15, 'the segment rules were swept (' + segs.length + ')');
  segs.forEach(function (r) {
    const c = /(?:^|[;{\s])color:\s*([^;}]+)/.exec(r);
    if (!c) return;                                            // a fill-only segment (no text inside it)
    assert.ok(/^var\(--(on-[a-z-]+|ink)\b/.test(c[1].trim()), r.slice(0, 60) + ' hardcodes its text colour: ' + c[1]);
  });
});
