'use strict';

// Batch 7 of the 2026-10-01 broad scan: CLIENT CORRECTNESS -- places where the
// page showed wrong or missing information (an invisible line, a "+300%" that
// compared a 30-day total with a 7-day one, a save warning wiped before it
// could be read, a deep link that lost its window, a boot that hung on the
// skeleton, a failure that vanished in 3 s). The client lives in one assembled
// IIFE, so where a function can be lifted out and run on its own it is pinned
// BEHAVIOURALLY (extractFn + a small sandbox); the rest are SOURCE pins naming
// the guard. The rendered-UI gate (`npm run ci:ui`) still boots the real page.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
function src(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }

// The source of `function <name>(...) { ... }`, by brace matching (string- and
// comment-naive, which is enough for the small functions pinned here).
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
function between(s, startRe, endRe) {
  const a = s.search(startRe);
  assert.ok(a >= 0, 'start anchor missing: ' + startRe);
  const rest = s.slice(a);
  const b = rest.search(endRe);
  return b >= 0 ? rest.slice(0, b) : rest;
}
function clientFragments() {
  return fs.readdirSync(DIR).filter(function (f) { return /^script-\d+-.*\.html$/.test(f); });
}

test('CL-1: every THEME.<key> the client reads is a key THEME declares', function () {
  const core = src('script-1-core.html');
  const decl = between(core, /const THEME = \{/, /\};/);
  const keys = {};
  (decl.match(/\b([A-Za-z0-9_]+):/g) || []).forEach(function (k) { keys[k.slice(0, -1)] = true; });
  assert.ok(keys.ink && keys.paperCard, 'THEME declaration parsed');
  const bad = [];
  clientFragments().forEach(function (f) {
    (src(f).match(/\bTHEME\.[A-Za-z0-9_]+/g) || []).forEach(function (ref) {
      if (!keys[ref.slice(6)]) bad.push(f + ': ' + ref);
    });
  });
  assert.deepEqual(bad, [], 'an undeclared THEME key reads undefined and falls back to a hardcoded colour');
  const ov = src('script-3-overview.html');
  assert.match(ov, /borderColor: \(THEME && THEME\.ink\) \|\| '#1a1d21'/, 'the Company line wears THEME.ink');
});

test('CL-2: length-dependent Insights card deltas compare PER DAY when the windows differ', function () {
  const ins = src('script-8-insights.html');
  const sb = { isFinite: isFinite, Number: Number };
  vm.runInNewContext(extractFn(ins, 'insPerDayDeltaPct_'), sb);
  const f = sb.insPerDayDeltaPct_;
  const mm = { lengthMismatch: true, currentDays: 30, priorDays: 7 };
  // 300 answered in 30 days vs 70 in 7: +328% raw, but 10/day vs 10/day = flat.
  assert.equal(f({ val: 300, prev: 70 }, mm, 'volume'), 0);
  assert.ok(Math.abs(f({ val: 330, prev: 70 }, mm, 'time') - 10) < 1e-9, '11/day vs 10/day = +10%');
  assert.equal(f({ val: 30, prev: 0 }, mm, 'volume'), 100, "deltaBlock_'s zero-prior rule");
  assert.equal(f({ val: 300, prev: 70 }, { lengthMismatch: false, currentDays: 30, priorDays: 7 }, 'volume'), null,
    'equal-length windows keep the raw delta');
  assert.equal(f({ val: 90, prev: 80 }, mm, null), null, 'a rate (% Ans, ATT) is never re-based');

  const card = extractFn(ins, 'insBuildCard_');
  assert.equal((card.match(/insMetricPerDay_\(/g) || []).length, 2, 'the per-day subline renders on the bars AND the secondary metrics');
  assert.match(card, /meta, perDayKind\) \+ '<\/span>'/, 'the bar badges get meta + the per-day kind');
  assert.match(card, /insDeltaBadge_\(st, m\[2\], priorLbl, meta, m\[3\]\)/, 'so do the secondary badges');
  assert.match(card, /\['ATT', 'att', 'neu', null\]/, 'ATT (per call) is length-independent');
  assert.ok(!/same-length/.test(extractFn(ins, 'insDeltaBadge_')),
    'the badge no longer claims a same-length comparison');
});

test('CL-15: the Access Control and Dept Config write paths keep their result message across the reload', function () {
  const adm = src('script-7-admin.html');
  const acLoad = extractFn(adm, 'acLoadInit_');
  assert.match(acLoad, /if \(!preserveStatus\) acSetStatus_\(null\);/);
  assert.match(acLoad, /acClearForm_\(preserveStatus\)/, 'the post-load form clear honours it too');
  assert.match(extractFn(adm, 'acClearForm_'), /if \(!keepStatus\) acSetStatus_\(null\);/);
  assert.match(extractFn(adm, 'dcLoadInit_'), /if \(!preserveStatus\) dcSetStatus_\(null\);/);
  // Every reload that follows a write passes true; only the two modal OPENS
  // reload with a clean status.
  const ac = adm.match(/acLoadInit_\((true)?\);/g) || [];
  const dc = adm.match(/dcLoadInit_\((true)?\);/g) || [];
  assert.equal(ac.filter(function (c) { return c === 'acLoadInit_();'; }).length, 1, 'only the modal open clears');
  assert.equal(ac.filter(function (c) { return c === 'acLoadInit_(true);'; }).length, 4, 'manager + agent save/remove keep it');
  assert.equal(dc.filter(function (c) { return c === 'dcLoadInit_();'; }).length, 1, 'only the modal open clears');
  assert.equal(dc.filter(function (c) { return c === 'dcLoadInit_(true);'; }).length, 2, 'save + deactivate keep it');
});

function linkSandbox(from, to, page) {
  const els = { 'from-date': { value: from }, 'to-date': { value: to } };
  const sb = {
    $: function (id) { return els[id] || null; },
    document: { body: { getAttribute: function () { return page || 'dept'; } } },
    datesTouched_: false,
    refreshed: 0, cleared: 0,
  };
  sb.refresh = function () { sb.refreshed++; };
  sb.clearActivePreset_ = function () { sb.cleared++; };
  return { sb: sb, els: els };
}

test('CL-17: a share / digest Insights link carries its window into the dept controls', function () {
  const nav = src('script-4-nav.html');
  const fn = extractFn(nav, 'insCarryLinkWindowToDept_');
  let t = linkSandbox('2026-09-30', '2026-09-30');
  vm.runInNewContext(fn + '; insCarryLinkWindowToDept_({ from: "2026-09-01", to: "2026-09-15" });', t.sb);
  assert.equal(t.els['from-date'].value, '2026-09-01');
  assert.equal(t.els['to-date'].value, '2026-09-15');
  assert.equal(t.sb.datesTouched_, true, 'the init latest-date snap must not undo it (C1-2)');
  assert.equal(t.sb.cleared, 1);
  assert.equal(t.sb.refreshed, 1, 'the router already fetched the OLD window -- re-fetch for the linked one');

  t = linkSandbox('2026-09-01', '2026-09-15');
  vm.runInNewContext(fn + '; insCarryLinkWindowToDept_({ from: "2026-09-01", to: "2026-09-15" });', t.sb);
  assert.equal(t.sb.refreshed, 0, 'an unchanged window costs no second fetch');

  [{ from: '2026-09-15', to: '2026-09-01' }, { from: 'x', to: '2026-09-01' }, { from: '2026-09-01' }].forEach(function (p) {
    t = linkSandbox('2026-09-30', '2026-09-30');
    t.sb.p = p;
    vm.runInNewContext(fn + '; insCarryLinkWindowToDept_(p);', t.sb);
    assert.equal(t.els['from-date'].value, '2026-09-30', 'a malformed / inverted link leaves the window alone');
    assert.equal(t.sb.datesTouched_, false);
  });

  const wrap = between(nav, /const base = SHARE_STATE_\['\/report\/insights'\];/, /\}\)\(\);/);
  assert.match(wrap, /if \(!\(opts && opts\.keepDeptWindow\)\) insCarryLinkWindowToDept_\(params\);/);
  assert.match(src('script-8-insights.html'),
    /SHARE_STATE_\['\/report\/insights'\]\.apply\(state, \{ keepDeptWindow: true \}\)/,
    'a saved view applied in place runs the report itself');
});

test('CL-18: every boot step is guarded, and a throwing step is recorded and beaconed, never fatal', function () {
  const chrome = src('script-2-chrome.html');
  const init = extractFn(chrome, 'init');
  const steps = between(init, /initStep_\('initHelpModal'/, /bootFailureNotice_\(false\);/);
  assert.equal((steps.match(/initStep_\(/g) || []).length, 30, 'the 30 surface inits each run under the guard');
  assert.ok(!/^\s+init[A-Za-z_]*\(\);/m.test(steps) && !/^\s+(ovWireTrendCollapse_|loadEscBadge_)\(\);/m.test(steps),
    'no step in the guarded block is called bare');
  assert.match(src('script-11-qcd-boot.html'), /bootInit_\(\);\s*\n\s*devInstallToggle_\(\);/, 'boot enters through bootInit_');
  assert.ok(!/\binit\(\);/.test(src('script-11-qcd-boot.html').replace(/\/\/[^\n]*/g, '')), 'never the bare init()');

  const beacons = [];
  const sb = { bootFailures_: [], console: { error: function () {} },
    reportClientIssue_: function (k, m) { beacons.push([k, m]); } };
  vm.runInNewContext(extractFn(chrome, 'initStep_')
    + '; initStep_("initA", function () {}); initStep_("initB", function () { throw new Error("boom"); });'
    + ' var after = 0; initStep_("initC", function () { after++; });', sb);
  assert.deepEqual(sb.bootFailures_, ['initB']);
  assert.deepEqual(beacons, [['boot-failure', 'initB: boom']]);
  assert.equal(sb.after, 1, 'the steps after a throw still run');
  const notice = extractFn(chrome, 'bootFailureNotice_');
  assert.match(notice, /setAttribute\('role', 'alert'\)/);
  assert.match(notice, /if \(!fatal && !bootFailures_\.length\) return;/, 'silent on a clean boot');
  assert.match(extractFn(chrome, 'bootInit_'), /bootFailureNotice_\(true\)/, 'an init() throw outside a step is shown too');
});

// A tiny DOM: enough for showToast.
function toastSandbox() {
  const timers = [];
  function el(tag) {
    const e = { tagName: tag, children: [], attrs: {}, listeners: {}, className: '', textContent: '', parentNode: null,
      classList: {
        _s: {}, add: function (c) { this._s[c] = true; }, remove: function (c) { delete this._s[c]; },
        contains: function (c) { return !!this._s[c]; } },
      setAttribute: function (k, v) { this.attrs[k] = v; },
      addEventListener: function (k, fn) { this.listeners[k] = fn; },
      appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild: function (c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; },
      querySelectorAll: function (sel) {
        const cls = sel.replace(/^\./, '');
        return this.children.filter(function (c) { return c.classList.contains(cls); });
      },
    };
    return e;
  }
  const container = el('div');
  return {
    container: container, timers: timers,
    sb: {
      $: function (id) { return id === 'toast-container' ? container : null; },
      document: { createElement: el },
      requestAnimationFrame: function (fn) { fn(); },
      setTimeout: function (fn, ms) { timers.push([fn, ms]); },
    },
  };
}

test('CL-4: an error toast with no duration is sticky, dismissible and announced; others stay transient', function () {
  const core = src('script-1-core.html');
  const code = 'var TOAST_STICKY_MAX_ = 3;\n' + extractFn(core, 'showToast');
  const t = toastSandbox();
  vm.runInNewContext(code + '; showToast("Send failed: quota", "error");', t.sb);
  assert.equal(t.container.children.length, 1);
  const toast = t.container.children[0];
  assert.ok(toast.classList.contains('toast-sticky'));
  assert.equal(toast.attrs.role, 'alert');
  assert.equal(t.timers.length, 0, 'no auto-dismiss timer');
  assert.equal(toast.children[0].textContent, 'Send failed: quota', 'the message is its own (selectable) text node');
  toast.children[1].listeners.click();
  t.timers.forEach(function (x) { x[0](); });
  assert.equal(t.container.children.length, 0, 'the close button dismisses it');

  const t2 = toastSandbox();
  vm.runInNewContext(code + '; showToast("Pick a date", "error", 4000); showToast("Saved", "success");', t2.sb);
  assert.deepEqual(t2.timers.map(function (x) { return x[1]; }), [4000, 3000], 'a validation error and a success both expire');

  const t3 = toastSandbox();
  vm.runInNewContext(code + '; for (var i = 0; i < 5; i++) showToast("e" + i, "error");', t3.sb);
  assert.equal(t3.container.children.length, 3, 'at most TOAST_STICKY_MAX_ stack');
  assert.equal(t3.container.children[0].children[0].textContent, 'e2', 'the oldest go first');

  // The named toast-only failures now also land inline.
  const esc = extractFn(src('script-10-escalations.html'), 'escRestoreDept_');
  assert.match(esc, /escRowError_\(id, 'Restore failed: ' \+ msg\)/);
  const qcd = src('script-11-qcd-boot.html');
  assert.ok((qcd.match(/qadSetStatus_\('error'/g) || []).length >= 4,
    'the queue report email + blast failures write its own status line');
});

test('CL-6: a failed heatmap load shows an error with Retry instead of disappearing', function () {
  const fn = extractFn(src('script-9-inbound-direct.html'), 'loadAbandonHeatmap_');
  const fail = between(fn, /\.withFailureHandler\(function \(err\) \{/, /\.getInboundHeatmap\(/);
  assert.ok(!/el\.style\.display = 'none'/.test(fail), 'the failure path no longer hides the panel');
  assert.match(fail, /role="alert"/);
  assert.match(fail, /loadAbandonHeatmap_\(containerId, dept, from, to\)/, 'Retry re-issues the same load');
});

test('CL-16: an admin previewing a manager is that manager for every data-breadth gate', function () {
  const chrome = src('script-2-chrome.html');
  const code = [extractFn(chrome, 'isAllDeptRole_'), extractFn(chrome, 'isAllDeptViewer_'),
    extractFn(chrome, 'canPickDept_')].join('\n');
  const run = function (user, viewAs) {
    const sb = { USER: user, viewAsDept_: viewAs };
    vm.runInNewContext(code + '; r = JSON.stringify([isAllDeptViewer_(), canPickDept_()]);', sb);
    return JSON.parse(sb.r);   // cross-realm arrays never deepEqual
  };
  assert.deepEqual(run({ role: 'admin' }, null), [true, true]);
  assert.deepEqual(run({ role: 'admin' }, 'Sales'), [false, true],
    'previewing: no cross-dept routing, but the pinned selector still drives getRequestedDept');
  assert.deepEqual(run({ role: 'manager', allDepts: true }, null), [true, true]);
  assert.deepEqual(run({ role: 'manager', departments: ['A'] }, null), [false, false]);
  assert.deepEqual(run({ role: 'manager', departments: ['A', 'B'] }, null), [false, true]);
});

test('CL-14: the agent app never anchors a preset on today', function () {
  const app = src('agentApp.html');
  const yIso = extractFn(app, 'yesterdayIso_');
  const ap = extractFn(app, 'applyPreset');
  assert.match(ap, /var anchor = latestIso \|\| yesterdayIso_\(\);/);
  const sb = { latestIso: null, win: {}, isoShift: function (iso) { return iso; } };
  vm.runInNewContext(yIso + '\n' + ap + '; y = yesterdayIso_(); applyPreset("yday");', sb);
  const today = new Date();
  const pad = function (x) { return x < 10 ? '0' + x : String(x); };
  const todayIso = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
  assert.notEqual(sb.win.to, todayIso, '"Yesterday" with no latest date is not today');
  assert.equal(sb.win.to, sb.y);
  const boot = between(app, /var noteUnknownFreshness_ = function/, /\.getLatestDataDate\(\);/);
  assert.equal((boot.match(/noteUnknownFreshness_\(\);/g) || []).length, 2,
    'both a null reply and a failed lookup say the date is unknown');
});

test('CL-7: a Generate request superseded by the edit popover gives the button back', function () {
  const ir = src('script-6-ir.html');
  const run = extractFn(ir, 'runIrReport');
  assert.match(run, /irGenerateTok_ = __rtok;/);
  assert.match(run, /if \(__rtok === irGenerateTok_\) \{ btn\.disabled = false; btn\.textContent = originalLabel; \}/,
    'released only when no newer GENERATE run owns the button (P29)');
  assert.equal((run.match(/if \(releaseIfSuperseded\(\)\) return;/g) || []).length, 2, 'both handlers');
  assert.equal((ir.match(/irGenerateTok_ = __rtok/g) || []).length, 1, 'only Generate sets the token');
});

test('CL-5: the share-link copy believes execCommand, and a refusal ends in a copyable dialog', function () {
  const fn = extractFn(src('script-8-insights.html'), 'insCopyShareLink_');
  assert.match(fn, /copied = document\.execCommand\('copy'\) === true;/);
  assert.match(fn, /if \(copied\) ok\(\); else fail\(\);/);
  assert.match(fn, /writeText\(url\)\.then\(ok, legacyCopy\)/, 'a clipboard-API rejection tries the legacy path');
  assert.match(fn, /dsPrompt_\(\{[\s\S]*value: url,/, 'the fallback hands the URL over in a selectable field');
  assert.ok(!/showToast\([^)]*link: ' \+ url/.test(fn), 'no URL in a toast');
});

test('CL-22: a subscriber save that half-succeeds says which half, and reloads to show it', function () {
  const fn = extractFn(src('script-7-admin.html'), 'alRsSave_');
  assert.match(fn, /if \(saved\.length\) \{/);
  assert.match(fn, /'Partly saved: the ' \+ saved\.join/);
  const partial = between(fn, /if \(saved\.length\) \{/, /\} else \{/);
  assert.match(partial, /alLoadInit_\(\);/);
  assert.match(fn, /if \(i > 0\) saved\.push\(labels\[i - 1\]\);/);
});
