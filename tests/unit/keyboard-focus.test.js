'use strict';

// Broad-scan 2026-11-10, Batch 9 -- keyboard and focus (F70, F71, F74, F75,
// F77, F79). Six client defects with one shape: something a mouse could do or
// see that a keyboard could not, or focus left on <body> after a layer closed.
//
// The client is one browser IIFE, so each rule is pinned two ways: the small
// pure helpers run here against fake elements (the behaviour), the call sites
// are swept in source (nothing forgot to use them), and the rendered proof is
// in `npm run ci:ui` (drive-admin.js, drive-f13.js, drive-agent.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
function src(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }
const FRAGMENTS = fs.readdirSync(DIR).filter(function (f) { return /^script-\d+-.*\.html$/.test(f); }).sort();

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

// A tiny element: tag, attributes, a parent chain for closest(), focus count.
function el(tag, opts) {
  const e = Object.assign({
    tagName: String(tag).toUpperCase(), id: '', attrs: {}, parentElement: null, children: [],
    isConnected: true, hidden: false, focused: 0, style: { display: '' }, open: true,
    classes: {},
    hasAttribute: function (k) { return k in this.attrs; },
    getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    focus: function () { this.focused++; ACTIVE.el = this; },
    getClientRects: function () { return this.hidden ? [] : [1]; },
    matches: function (fn) { return fn(this); },
    contains: function (other) {
      for (let n = other; n; n = n.parentElement) { if (n === this) return true; }
      return false;
    },
  }, opts || {});
  e.classList = { contains: function (c) { return !!e.classes[c]; } };
  return e;
}
const ACTIVE = { el: null };

const core = src('script-1-core.html');

// ── F71: a closing layer returns focus to something the user can see ────────

function focusSandbox(nodes) {
  const body = el('body');
  const doc = {
    body: body,
    get activeElement() { return ACTIVE.el || body; },
    querySelector: function (sel) {
      const m = /^\[aria-controls="([^"]+)"\]$/.exec(sel);
      return m ? (nodes.triggers[m[1]] || null) : null;
    },
    getElementById: function (id) { return nodes.byId[id] || null; },
  };
  const sb = { document: doc, setTimeout: function (fn) { fn(); },
    getComputedStyle: function (x) { return { display: x.style.display }; } };
  vm.runInNewContext(extractFn(core, 'focusShown_') + extractFn(core, 'returnFocusTo_')
    + extractFn(core, 'popoverClose_'), sb);
  return sb;
}
// An opener inside a role=menu list: closest('[role="menu"]') walks its parents.
function menuItem(list, opts) {
  const item = el('button', opts);
  item.parentElement = list;
  item.closest = function (sel) { return sel === '[role="menu"]' ? list : null; };
  return item;
}

test('F71: focus goes back to the opener, else its menu\'s trigger, else the page title', function () {
  const list = el('div', { id: 'admin-menu-list' });
  const trigger = el('button', { id: 'admin-menu-btn' });
  const title = el('h1', { id: 'page-title' });
  const sb = focusSandbox({ triggers: { 'admin-menu-list': trigger }, byId: { 'page-title': title } });

  // The production case: the menu closed when the item was picked, so the item is hidden.
  const hiddenItem = menuItem(list, { id: 'alerts-btn', hidden: true });
  assert.equal(sb.returnFocusTo_(hiddenItem), trigger);
  assert.equal(hiddenItem.focused, 0, 'a hidden opener is never focused (a no-op that leaves focus on <body>)');
  assert.equal(trigger.focused, 1, 'the menu trigger -- the control the user pressed first -- gets it');

  // A visible opener (the header ?, the Overview's Queue report button) is unchanged.
  const shown = el('button', { id: 'help-btn', closest: function () { return null; } });
  assert.equal(sb.returnFocusTo_(shown), shown);
  assert.equal(shown.focused, 1);

  // A manager who arrived by a link has neither the item nor the (admin-only) menu.
  trigger.hidden = true;
  assert.equal(sb.returnFocusTo_(hiddenItem), title);
  assert.equal(title.focused, 1, 'the page title is the last resort');

  // Nothing at all to focus: no throw, null.
  title.hidden = true;
  assert.equal(sb.returnFocusTo_(hiddenItem), null);
  assert.equal(sb.returnFocusTo_(null), null);
});

test('F71: no modal\'s closeModal hands focus straight to its opener any more', function () {
  let closers = 0, routed = 0;
  FRAGMENTS.forEach(function (f) {
    const s = src(f);
    const re = /function closeModal\(\) \{/g;
    let m;
    while ((m = re.exec(s))) {
      const body = extractFn(s.slice(m.index), 'closeModal');
      closers++;
      assert.ok(!/\bbtn\.focus\(\)/.test(body), f + ': closeModal still calls btn.focus() -- use returnFocusTo_(btn)');
      if (/returnFocusTo_\(btn\)/.test(body)) routed++;
    }
  });
  assert.ok(closers >= 16, 'every modal closer was swept (' + closers + ')');
  // The eleven menu-opened modals, plus Help / Settings / Queue report / Caller Lookup.
  assert.equal(routed, 15, 'fifteen closers return focus through the shared helper');
});

// ── F75: a popover takes focus and gives it back ────────────────────────────

test('F75: closing a popover returns focus to its opener only while focus is still inside it', function () {
  const opener = el('button', { id: 'ins-edit-selection-btn', closest: function () { return null; } });
  const sb = focusSandbox({ triggers: {}, byId: {} });
  const pop = el('div');
  const inside = el('button'); inside.parentElement = pop;
  const elsewhere = el('input');

  ACTIVE.el = inside;                              // the Close button / Apply was just pressed
  sb.popoverClose_(pop, opener);
  assert.equal(pop.style.display, 'none');
  assert.equal(opener.focused, 1, 'focus returns to the button that opened it');

  pop.style.display = ''; ACTIVE.el = elsewhere;   // a click on another control already moved focus
  sb.popoverClose_(pop, opener);
  assert.equal(pop.style.display, 'none');
  assert.equal(opener.focused, 1, 'focus the user has since moved is never taken back');

  pop.style.display = ''; ACTIVE.el = null;        // a click on plain page: focus is on <body>
  sb.popoverClose_(pop, opener);
  assert.equal(pop.style.display, 'none');
  assert.equal(opener.focused, 1, 'nor is the page scrolled back to the opener after a click outside');

  ACTIVE.el = inside;                              // already closed: a re-render's close call is a no-op
  sb.popoverClose_(pop, opener);
  assert.equal(opener.focused, 1, 'closing a closed popover moves nothing');
  ACTIVE.el = null;
});

test('F75: both edit popovers open and close through the shared helpers', function () {
  const ins = src('script-8-insights.html'), ir = src('script-6-ir.html');
  assert.match(extractFn(ins, 'insOpenEditPopover_'), /popoverFocusIn_\(pop, search\);/);
  assert.match(extractFn(ins, 'insCloseEditPopover_'), /popoverClose_\(\$\('ins-edit-popover'\), \$\('ins-edit-selection-btn'\)\);/);
  assert.match(extractFn(ir, 'irOpenEditPopover_'), /popoverFocusIn_\(pop, search\);/);
  assert.match(extractFn(ir, 'irCloseEditPopover_'), /popoverClose_\(\$\('ir-edit-popover'\), \$\('ir-edit-selection-btn'\)\);/);
  // The old open focused the search box even when it sat in a closed fold (a no-op).
  assert.ok(!/search\.focus\(\)/.test(extractFn(ins, 'insOpenEditPopover_')));
  // Focus-in prefers the asked control only when Tab could reach it, and skips the Close button.
  const fin = extractFn(core, 'popoverFocusIn_');
  assert.match(fin, /var els = focusablesIn_\(pop\);/);
  assert.match(fin, /\(preferred && els\.indexOf\(preferred\) !== -1\) \? preferred : null/);
  assert.match(fin, /classList\.contains\('ir-edit-popover-close'\)/);
});

// ── F70: the focus trap knows what Tab really stops on ──────────────────────

test('F70: a fold\'s summary is tabbable and a closed fold\'s contents are not', function () {
  assert.match(core, /var FOCUSABLE = '[^']*details > summary:first-of-type[^']*';/);
  assert.match(extractFn(core, 'focusablesIn_'), /el\.offsetParent !== null && !inClosedFold\(el\)/);
  assert.match(extractFn(core, 'trapFocus_'), /function focusables\(\) \{ return focusablesIn_\(modal\); \}/);

  const sb = {};
  vm.runInNewContext(extractFn(core, 'inClosedFold'), sb);
  // closest('details:not([open])') over a parent chain of fake nodes.
  const node = function (tag, parent, open) {
    const n = el(tag, { open: open !== false });
    n.parentElement = parent || null;
    n.closest = function () {
      for (let x = n; x; x = x.parentElement) { if (x.tagName === 'DETAILS' && !x.open) return x; }
      return null;
    };
    return n;
  };
  const closed = node('details', null, false);
  const itsSummary = node('summary', closed);
  const button = node('button', closed);
  assert.equal(sb.inClosedFold(button), true, 'a control inside a closed fold is skipped by Tab');
  assert.equal(sb.inClosedFold(itsSummary), false, 'the fold\'s own summary is still a tab stop');

  const open = node('details', null, true);
  assert.equal(sb.inClosedFold(node('button', open)), false);
  assert.equal(sb.inClosedFold(node('button', null)), false);

  // A fold nested in a closed fold: even its summary is unreachable.
  const inner = node('details', closed, false);
  assert.equal(sb.inClosedFold(node('summary', inner)), true);
});

// ── F74: the half-hour drill has a Tab path ─────────────────────────────────

test('F74: one picker opens the half-hour drill; the ring-time links stay out of the tab order', function () {
  const s5 = src('script-5-dept.html');
  const mk = extractFn(s5, 'makeMissedBucketDetail_');
  assert.match(mk, /return \{ toggle: toggle, hide: hide, show: show, fillPick: fillPick \};/);
  // The options are the half-hours that HAVE rings, counted the way the panel collects them.
  assert.match(mk, /\(\(data && data\.agents\) \|\| \[\]\)\.forEach\(function \(a\) \{ \(a\.missedTimes \|\| \[\]\)\.forEach\(add\); \}\);/);
  assert.match(mk, /\(\(data && data\.queueOnly\) \|\| \[\]\)\.forEach\(function \(q\) \{ \(q\.entries \|\| \[\]\)\.forEach\(add\); \}\);/);
  assert.match(mk, /if \(!n\[i\]\) continue;/);
  assert.match(mk, /pk\.hidden = !opts;/, 'no rings: no tab stop');
  assert.match(mk, /if \(pk\.value === ''\) hide\(\); else show\(Number\(pk\.value\)\);/);
  // Closing from inside the panel hands focus to the picker, not <body>.
  assert.match(mk, /var held = wrap\.contains\(document\.activeElement\);/);
  assert.match(mk, /if \(held && pk && focusShown_\(pk\)\) \{ try \{ pk\.focus\(\); \}/);
  assert.match(s5, /pick: 'dept-missed-bucket-pick' \}\);/);
  assert.match(extractFn(s5, 'deptMissedRender_'), /deptMissedBucketDetail_\.hide\(\);[^\n]*\n\s*deptMissedBucketDetail_\.fillPick\(\);/);

  const dash = src('dashboard.html');
  assert.match(dash, /<select id="dept-missed-bucket-pick" class="ms-bucket-pick" aria-label="Open one half-hour's missed calls" hidden><\/select>/);
  // Clipped until it has KEYBOARD focus -- the toolbar is unchanged for a mouse user.
  assert.match(src('styles.html'), /\.ms-bucket-pick:not\(:focus-visible\) \{\s*position: absolute; width: 1px; height: 1px;/);
  // UD-4 stands: hundreds of ring times are not tab stops.
  assert.match(s5, /<button type="button" class="ms-bucket-link" tabindex="-1"/);
});

// ── F77: a selected chip is announced, not only coloured ────────────────────

test('F77: the four chip groups write aria-pressed wherever they write the selected class', function () {
  const chrome = src('script-2-chrome.html');
  // Date presets: created unpressed, pressed on pick, cleared with the class.
  assert.match(chrome, /chip\.className = 'date-preset-chip';[\s\S]{0,300}chip\.setAttribute\('aria-pressed', 'false'\);/);
  assert.match(chrome, /c\.classList\.remove\('active'\); c\.setAttribute\('aria-pressed', 'false'\); \}\);\s*\n\s*chip\.classList\.add\('active'\);\s*\n\s*chip\.setAttribute\('aria-pressed', 'true'\);/);
  assert.match(extractFn(chrome, 'clearActivePreset_'), /c\.classList\.remove\('active'\); c\.setAttribute\('aria-pressed', 'false'\);/);
  // Help topics and theme chips.
  assert.match(extractFn(chrome, 'initHelpNav_'), /l\.classList\.toggle\('active', on\);\s*\n\s*l\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/);
  assert.match(extractFn(chrome, 'initHelpNav_'), /l\.classList\.toggle\('active', i === 0\);\s*\n\s*l\.setAttribute\('aria-pressed', i === 0 \? 'true' : 'false'\);/);
  assert.match(extractFn(chrome, 'initSettingsModal'), /chip\.classList\.toggle\('active', on\);\s*\n\s*chip\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/);
  // No write of the selected class on these groups is left without one.
  ['date-preset-chip', 'help-link', 'theme-chip'].forEach(function (cls) {
    chrome.split('\n').forEach(function (line, i) {
      if (line.indexOf(cls) === -1 || !/classList\.(add|remove|toggle)\('active'/.test(line)) return;
      assert.ok(/aria-pressed/.test(line), 'script-2-chrome.html:' + (i + 1) + ' writes .active on ' + cls + ' without aria-pressed');
    });
  });
  // The agent app's window chips.
  assert.match(extractFn(src('agentApp.html'), 'paintControls'),
    /c\.classList\.toggle\('on', on\);\s*\n\s*c\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/);
});

// ── F79: a hover explanation is reachable by keyboard ───────────────────────

test('F79: a glossary label becomes a tab stop unless it is one, holds one, or sits inside one', function () {
  const nav = src('script-4-nav.html');
  assert.match(extractFn(nav, 'applyGlossaryTooltips_'), /el\.classList\.add\('gloss'\);[\s\S]{0,200}glossMakeFocusable_\(el\);/);
  const sb = {};
  vm.runInNewContext(extractFn(nav, 'glossMakeFocusable_'), sb);
  const label = function (tag, o) {
    o = o || {};
    const e = el(tag, { attrs: o.attrs || {} });
    e.querySelector = function () { return o.inner ? {} : null; };
    // `inside` names the nearest ancestor kind; closest() answers per selector.
    e.parentElement = { closest: function (sel) {
      if (o.inside === 'control') return {};
      if (o.inside === 'panel') return /\[tabindex\]/.test(sel) ? {} : null;   // a modal panel: tabindex, not a control
      return null;
    } };
    return e;
  };
  const plain = label('th');
  sb.glossMakeFocusable_(plain);
  assert.equal(plain.attrs.tabindex, '0', 'a plain header label can take focus, so its tooltip can open');

  const kpi = label('span');
  sb.glossMakeFocusable_(kpi);
  assert.equal(kpi.attrs.tabindex, '0');

  // A sort header gets the same tab stop the sorter would give it -- which it
  // only does once the table has rows, so an empty table's headers need this.
  const sortable = label('th', { attrs: { 'data-sort': 'rung' } });
  const already = label('span', { attrs: { tabindex: '-1' } });
  const holdsButton = label('th', { inner: true });
  const inTile = label('span', { inside: 'control' });                // an Overview tile is a button
  // Every modal panel carries a tabindex of its own; that is not a control,
  // and it must not switch the labels off inside a report (the Inbound 20).
  const inModal = label('th', { inside: 'panel' });
  sb.glossMakeFocusable_(inModal);
  assert.equal(inModal.attrs.tabindex, '0', 'a label inside a modal panel is still made focusable');
  const native = label('button');
  [sortable, already, holdsButton, inTile, native].forEach(function (e) { sb.glossMakeFocusable_(e); });
  assert.equal(sortable.attrs.tabindex, '0');
  assert.equal(already.attrs.tabindex, '-1', 'an explicit tabindex is left as written');
  assert.equal(holdsButton.attrs.tabindex, undefined, 'never a tab stop around a control');
  assert.equal(inTile.attrs.tabindex, undefined, 'never a tab stop inside a control');
  assert.equal(native.attrs.tabindex, undefined);
});

test('F79: the hand-written tooltip labels are focusable AND carry the class the tooltip listens for', function () {
  // The styled tooltip opens for `.gloss` on focus; a focusable title-only span showed nothing.
  assert.match(src('script-9-inbound-direct.html'), /<span class="side-hint-i gloss" tabindex="0" title="' \+ escapeHtml\(meta\.reconcileNote\)/);
  assert.match(src('dashboard.html'), /<strong class="gloss" tabindex="0" title="Calls that abandoned in the queue before ringing ANY agent/);
  // Every hint icon in the client is both.
  FRAGMENTS.concat(['dashboard.html']).forEach(function (f) {
    src(f).split('\n').forEach(function (line, i) {
      const m = /<span class="side-hint-i([^"]*)"([^>]*)>/.exec(line);
      if (!m || /^\s*\/\//.test(line)) return;
      assert.ok(/\bgloss\b/.test(m[1]) && /tabindex="0"/.test(m[2]), f + ':' + (i + 1) + ' a .side-hint-i without .gloss + tabindex="0"');
    });
  });
});
