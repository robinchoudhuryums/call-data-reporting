'use strict';

// Step 3 (owner 2026-10-16) on My Department, admin-only while trialled:
//   3 -- the Insights brief is an ACCORDION under the team cards, above the
//        agent table; every section starts collapsed and opens in place under
//        its row (the section's own element is moved into the row's slot).
//   5 -- inbound and outbound TOGETHER by default: the Inbound | Outbound |
//        Both switch became one "Show outbound columns" toggle, and Outbound +
//        Callbacks are their own accordion rows, independent of that toggle.
//   8 -- PRELOADING: Callbacks and Direct lines load in the background once
//        the page settles; the agent panel is prefetched on row hover / focus.
//
// The fetch rules are driven behaviourally in a vm (the client-lifecycle
// technique: a queued google.script.run, fake timers). The DOM moves are
// pinned at source here and RENDERED by drive-smoke / drive-crossstate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const src = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const S5 = src('script-5-dept.html');
const S4 = src('script-4-nav.html');
const S8 = src('script-8-insights.html');
const S9 = src('script-9-inbound-direct.html');
const S10 = src('script-10-escalations.html');
const HTML = src('dashboard.html');
const CSS = src('styles.html');

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

function fakeRun() {
  const calls = [];
  let pending = {};
  const run = new Proxy({}, {
    get: function (_t, prop) {
      if (prop === 'withSuccessHandler') return function (fn) { pending.ok = fn; return run; };
      if (prop === 'withFailureHandler') return function (fn) { pending.fail = fn; return run; };
      return function (arg) { calls.push(Object.assign({ method: prop, arg: arg }, pending)); pending = {}; };
    },
  });
  return { calls: calls, google: { script: { run: run } } };
}

function fakeTimers() {
  const t = { list: [], next: 1 };
  t.setTimeout = function (fn, ms) { const id = t.next++; t.list.push({ id: id, fn: fn, ms: ms }); return id; };
  t.clearTimeout = function (id) { t.list = t.list.filter(function (x) { return x.id !== id; }); };
  t.flush = function () { const due = t.list; t.list = []; due.forEach(function (x) { x.fn(); }); };
  return t;
}

function el(extra) {
  return Object.assign({ style: {}, textContent: '', open: false, innerHTML: '' }, extra || {});
}

// ---- 8: the Callbacks section preloads --------------------------------------

function cbSandbox(win) {
  const f = fakeRun();
  const t = fakeTimers();
  const els = { 'ins-cb-fold': el(), 'ins-cb-fold-head': el(), 'ins-cb-content': el() };
  const rendered = [];
  const sb = {
    google: f.google, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
    page: 'dept',
    document: { body: { getAttribute: function () { return sb.page; } } },
    $: function (id) { return els[id] || null; },
    insCbWindow_: function () { return win; },
    obAllowed_: function () { return sb.allowed; },
    allowed: true,
    INS_CB_: { key: null, data: null, error: null, seq: 0, uncSeq: 0, cbkSeq: 0, loadingKey: null },
    INS_CB_PREFETCH_MS_: 1500, INS_CB_PREFETCH_T_: null,
    insCbResetUncalled_: function () {}, insCbState_: function () {},
    insCbScrollIfPending_: function () {}, insBriefRowFromHead_: function () {},
    insCbRender_: function (d) { rendered.push(d); },
  };
  vm.runInNewContext(extractFn(S8, 'insCbSync_') + '\n' + extractFn(S8, 'insCbFetch_') + '\n' + extractFn(S8, 'insCbOnDeptPage_'), sb);
  return { sb: sb, f: f, t: t, els: els, rendered: rendered };
}

test('8: a CLOSED Callbacks section loads once the page settles, and only once', function () {
  const w = { department: 'CSR', from: '2026-10-01', to: '2026-10-15' };
  const c = cbSandbox(w);
  c.sb.insCbSync_();
  assert.equal(c.f.calls.length, 0, 'nothing is sent while the page is still settling');
  c.sb.insCbSync_();   // a second sync in the same burst re-arms, never doubles
  assert.equal(c.t.list.length, 1, 'one pending preload');
  assert.equal(c.t.list[0].ms, 1500);
  c.t.flush();
  assert.equal(c.f.calls.length, 1, 'the preload fires');
  assert.equal(c.f.calls[0].method, 'getOutboundReport');
  c.sb.insCbSync_();   // a sync while it is out joins it
  c.t.flush();
  assert.equal(c.f.calls.length, 1, 'a fetch already out for this window is never sent again');
  c.f.calls[0].ok({ callback: { abandonedTotal: 3 } });
  assert.equal(c.rendered.length, 1, 'the answer paints (head + row) while the section is still closed');
  c.els['ins-cb-fold'].open = true;
  c.sb.insCbSync_();
  assert.equal(c.f.calls.length, 1, 'opening it needs no fetch');
  assert.equal(c.rendered.length, 2, 'it renders the held payload');
});

test('8: the preload runs ONLY on My Department -- the Overview landing fetches nothing for it', function () {
  const c = cbSandbox({ department: 'CSR', from: '2026-10-15', to: '2026-10-15' });
  c.sb.page = 'overview';
  c.sb.insCbSync_();
  assert.equal(c.t.list.length + c.f.calls.length, 0, 'nothing scheduled while the dept page renders under the Overview');
  c.sb.page = 'dept';
  c.sb.insCbSync_();   // entering the page re-syncs
  assert.equal(c.t.list.length, 1);
  c.sb.page = 'overview';   // left again before it fired
  c.t.flush();
  assert.equal(c.f.calls.length, 0, 'a preload that fires after the user left sends nothing');
  assert.match(extractFn(S8, 'deptInsightsEnsureLive_'),
    /if \(document\.body\.getAttribute\('data-page'\) !== 'dept'\) return;\s*\/\/[^\n]*\n\s*if \(typeof insCbSync_ === 'function'\) insCbSync_\(\);/,
    'entering My Department re-syncs, which schedules the preload');
});

test('8: an OPEN section fetches at once; a superseded preload never paints', function () {
  const w = { department: 'CSR', from: '2026-10-01', to: '2026-10-15' };
  const c = cbSandbox(w);
  c.els['ins-cb-fold'].open = true;
  c.sb.insCbSync_();
  assert.equal(c.f.calls.length, 1, 'no settle delay when the user is looking at it');
  w.from = '2026-10-02';   // the window moves while that fetch is out
  c.sb.insCbSync_();
  assert.equal(c.f.calls.length, 2, 'the new window fetches');
  c.f.calls[0].ok({ callback: { abandonedTotal: 9 } });
  assert.equal(c.rendered.length, 0, 'the old window\'s answer is dropped');
  c.sb.insCbSync_();   // a repaint of the OPEN section while that fetch is out
  assert.equal(c.f.calls.length, 2, 'joins the fetch already out -- never a second one');
  c.f.calls[1].ok({ callback: { abandonedTotal: 1 } });
  assert.equal(c.rendered.length, 1);
});

test('5: the Callbacks section follows obAllowed_, not the outbound columns toggle', function () {
  const c = cbSandbox({ department: 'CSR', from: '2026-10-01', to: '2026-10-15' });
  c.sb.allowed = false;
  c.sb.insCbSync_();
  assert.equal(c.els['ins-cb-fold'].style.display, 'none', 'a manager / View-as never sees it');
  assert.equal(c.t.list.length, 0, 'and nothing is preloaded for them');
  assert.ok(!/obEffectiveDir_/.test(extractFn(S8, 'insCbSync_')), 'the columns toggle plays no part');
  assert.ok(!/obEffectiveDir_/.test(extractFn(S8, 'insObSync_')), 'nor in the Outbound section');
});

test('8: the Callbacks chart draws only while the section is open (C3: no zero-size canvas)', function () {
  const body = extractFn(S8, 'insCbRender_');
  assert.match(body, /if \(fold && fold\.open\) \{\s*outboundRenderCbChart_\(/);
});

// ---- 8: Direct lines preload with the Callbacks payload --------------------

function dlSandbox() {
  const f = fakeRun();
  const t = fakeTimers();
  const els = { 'x-fold': el(), 'x-head': el(), 'x-content': el() };
  const rendered = [];
  const sb = {
    google: f.google, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
    $: function (id) { return els[id] || null; },
    OB_DL_VIEWS_: {},
    obDlResetRepeats_: function () {}, obDlState_: function () {},
    obDlRender_: function (p, d) { rendered.push(d); },
  };
  vm.runInNewContext([extractFn(S9, 'obDlView_'), extractFn(S9, 'obDlSync_'), extractFn(S9, 'obDlFetch_')].join('\n'), sb);
  return { sb: sb, f: f, t: t, els: els, rendered: rendered };
}

test('8: Direct lines preloads only when asked to; the Overview\'s stays lazy', function () {
  const req = { department: 'CSR', from: '2026-10-01', to: '2026-10-15' };
  const lazy = dlSandbox();
  lazy.sb.obDlSync_('x', req);
  assert.equal(lazy.t.list.length + lazy.f.calls.length, 0, 'no option: a closed block waits for its open');
  const pre = dlSandbox();
  pre.sb.obDlSync_('x', req, { prefetchMs: 1500 });
  pre.sb.obDlSync_('x', req, { prefetchMs: 1500 });
  assert.equal(pre.t.list.length, 1);
  pre.t.flush();
  assert.equal(pre.f.calls.length, 1);
  assert.equal(pre.f.calls[0].method, 'getOutboundDirectCallbacks');
  pre.f.calls[0].ok({ meta: {} });
  pre.els['x-fold'].open = true;
  pre.sb.obDlSync_('x', req, { prefetchMs: 1500 });
  assert.equal(pre.f.calls.length, 1, 'opening it serves the preloaded payload');
  assert.equal(pre.rendered.length, 2);
  assert.match(S8, /obDlSync_\('ins-dl', insCbWindow_\(\), insCbOnDeptPage_\(\) \? \{ prefetchMs: INS_CB_PREFETCH_MS_ \} : null\)/,
    'and only on My Department');
  assert.match(src('script-3-overview.html'), /obDlSync_\('ov-dl', ovCbDeptWindow_\(\)\);/, 'the Overview block is unchanged');
});

// ---- 8: the agent panel prefetch store --------------------------------------

function preSandbox() {
  const f = fakeRun();
  const sb = { google: f.google, AP_PRE_: {}, AP_PRE_ORDER_: [], AP_PRE_MAX_: 3 };
  vm.runInNewContext([extractFn(S10, 'apPreFetch_'), extractFn(S10, 'apPreStrip_'), extractFn(S10, 'apPreDay_')].join('\n'), sb);
  return { sb: sb, f: f };
}

test('8: the panel store joins a request already out and serves a finished one at once', function () {
  const p = preSandbox();
  const got = [];
  p.sb.apPreDay_('Ann', '2026-10-15', 'CSR');   // the hover prefetch
  p.sb.apPreDay_('Ann', '2026-10-15', 'CSR', function (d) { got.push(d); });   // the click, before it lands
  assert.equal(p.f.calls.length, 1, 'the click joins the hover\'s request');
  assert.deepEqual(JSON.parse(JSON.stringify(p.f.calls[0].arg)), { agentName: 'Ann', date: '2026-10-15', department: 'CSR' });
  p.f.calls[0].ok({ date: '2026-10-15' });
  assert.equal(got.length, 1);
  p.sb.apPreDay_('Ann', '2026-10-15', 'CSR', function (d) { got.push(d); });
  assert.equal(got.length, 2, 'a finished answer is served synchronously');
  assert.equal(p.f.calls.length, 1);
  p.sb.apPreDay_('Ann', '2026-10-15', 'Sales');
  assert.equal(p.f.calls.length, 2, 'the dept is part of the key (F29)');
});

test('8: a failed prefetch is never kept -- the open retries', function () {
  const p = preSandbox();
  const errs = [];
  p.sb.apPreStrip_('Ann', '2026-10-01', '2026-10-15', 'CSR', null, function (e) { errs.push(e); });
  p.f.calls[0].fail(new Error('boom'));
  assert.equal(errs.length, 1);
  p.sb.apPreStrip_('Ann', '2026-10-01', '2026-10-15', 'CSR');
  assert.equal(p.f.calls.length, 2, 'the next ask sends again');
});

test('8: the store is capped, oldest out first', function () {
  const p = preSandbox();
  ['a', 'b', 'c', 'd'].forEach(function (n) { p.sb.apPreDay_(n, '2026-10-15', 'CSR'); });
  assert.equal(Object.keys(p.sb.AP_PRE_).length, 3);
  assert.ok(!('day|a|2026-10-15|CSR' in p.sb.AP_PRE_), 'the oldest entry went first');
});

test('8: the panel reads through the store; hover and focus on either agent table prefetch', function () {
  assert.match(extractFn(S10, 'apLoadStrip_'), /apPreStrip_\(AP_\.agent, AP_\.from, AP_\.to, AP_\.dept,/);
  assert.match(extractFn(S10, 'apSelectDay_'), /apPreDay_\(AP_\.agent, date, AP_\.dept,/);
  const wire = extractFn(S10, 'apPreWire_');
  assert.match(wire, /tr\.closest\('#agents-tbody, #agents-ob-tbody'\)/);
  assert.match(wire, /addEventListener\('mouseover'/);
  assert.match(wire, /addEventListener\('focusin'/);
  const row = extractFn(S10, 'apPrefetchRow_');
  assert.match(row, /if \(!agent \|\| agent === AP_\.agent\) return;/, 'the open agent is never re-fetched');
  assert.match(row, /if \(days\.length\) apPreDay_\(agent, days\[0\]\.date, dept\);/, 'the day the open selects');
});

// ---- 5: inbound + outbound together ----------------------------------------

test('5 / DV-1: together is the default; the four views are kept as saved; anything else lands on together', function () {
  const start = S5.indexOf('  var OB_DIRS_ = ');
  const iife = S5.slice(start, S5.indexOf('})();', start) + 5);
  const run = function (stored) {
    const sb = { localStorage: { getItem: function () { return stored; } }, OB_DIR_KEY_: 'cdr.dept.direction' };
    vm.runInNewContext(iife, sb);
    return sb.obDir_;
  };
  assert.equal(run(null), 'both', 'unset -> together');
  ['in', 'out', 'both', 'direct'].forEach(function (d) { assert.equal(run(d), d, d + ' is kept'); });
  assert.equal(run('sideways'), 'both', 'an unknown value -> together');
  assert.match(extractFn(S5, 'obWire_'), /closest\('\[data-dir-pick\]'\)/, 'the control is the segmented picker');
  const sw = HTML.match(/<div id="dept-dir-switch"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(sw, '#dept-dir-switch is missing');
  assert.match(sw[0], /data-admin-only/, 'still the admin-only permission container (obAllowed_)');
  const picks = (sw[0].match(/data-dir-pick="(\w+)"/g) || []).map(function (x) { return x.replace(/.*="(\w+)"/, '$1'); });
  assert.deepEqual(picks, ['in', 'out', 'both', 'direct'], 'Inbound, Outbound, Inbound + outbound, Direct -- in that order');
  assert.match(sw[0], /data-dir-pick="both" aria-pressed="true"/, 'together is pressed before the client runs');
  assert.ok(!/data-ob-cols/.test(sw[0]), 'the one-button toggle is gone');
});

test('DV-1: the agent panel finds its rows in whichever table the view shows', function () {
  const fn = extractFn(S10, 'apTbody_');
  assert.match(fn, /dir === 'both' \|\| dir === 'out'\) return \$\('agents-ob-tbody'\)/);
  assert.match(fn, /dir === 'direct'\) return \$\('agents-dc-tbody'\)/);
  assert.match(fn, /return \$\('agents-tbody'\);/);
});

test('AT-1: the Outbound / Both / Direct explainers are the table\'s ⓘ; a state note (Neon down, capture start) stays visible', function () {
  const r = extractFn(S5, 'obViewRender_');
  assert.ok(!/notes\.push\('Connected means/.test(r), 'the Connected definition is no longer a visible note');
  assert.match(r, /info = data\.meta\.offRosterAgents/, 'the off-roster count goes to the tooltip');
  assert.match(r, /notes\.push\('Neon is unreachable/, 'the fallback note stays visible');
  assert.match(r, /notes\.push\('Outbound capture began/, 'the capture-start note stays visible');
  assert.match(r, /note\.style\.display = notes\.length \? '' : 'none'/, 'no empty note box');
  const info = extractFn(S5, 'obInfoSync_');
  assert.match(info, /el\.style\.display = txt \? '' : 'none';/, 'no ⓘ on the plain inbound view');
  assert.match(HTML, /<span id="dqe-table-info" class="side-hint-i gloss" tabindex="0" role="note"/, 'the ⓘ is keyboard-reachable');
});

// ---- 3: the accordion -------------------------------------------------------

test('3: the brief sits under the team cards and above the agent table, admin-only', function () {
  const strip = HTML.indexOf('id="dept-team-strip"');
  const brief = HTML.indexOf('<div id="ins-brief"');
  const table = HTML.indexOf('id="dqe-table-title"');
  assert.ok(strip > 0 && brief > strip && table > brief, 'team cards -> brief -> agent table');
  assert.match(HTML.slice(brief, brief + 200), /data-admin-only/);
  assert.equal((HTML.match(/id="ins-brief"/g) || []).length, 1, 'one brief, not a copy left behind');
});

test('3: sections move into the rows and back home on every rebuild; the store is untouched', function () {
  const r = extractFn(S8, 'insRenderBrief_');
  assert.ok(r.indexOf('insBriefUnmountAll_();') < r.indexOf('var rows = ['), 'every section goes home before the rows are rebuilt');
  assert.ok(r.indexOf("box.style.display = 'none'") > r.indexOf('insBriefUnmountAll_();'), 'including when the brief hides');
  assert.ok(r.indexOf('insBriefMountAll_();') > r.indexOf('box.innerHTML = '), 'mounted after the rows exist');
  assert.match(r, /if \(!insBriefActive_\(\) \|\| !data \|\| !data\.teamStats\) \{\s*insBriefRestoreFolds_\(\);/,
    'a section going home for good takes the viewer\'s saved fold state again (Agents open for a manager)');
  assert.match(extractFn(S8, 'insBriefActive_'), /USER\.role === 'admin'\s*&& document\.body\.getAttribute\('data-view-as'\) !== 'manager'/,
    'View-as gets the manager layout');
  assert.match(r, /aria-expanded="false" aria-controls="' \+ slotId \+ '"/, 'each row is a disclosure button');
  assert.match(extractFn(S8, 'insFoldSet_'), /if \(live && insBriefMounted_\(live\)\) return;/, 'the accordion never writes the fold store');
  assert.match(extractFn(S8, 'insFoldsApply_'), /if \(el && insBriefMounted_\(el\)\) return;/);
  assert.match(extractFn(S8, 'insBriefApply_'), /if \(el && insBriefMounted_\(el\) && el\.open !== open\) el\.open = open;/,
    'opening a row opens the section, so its own draw-on-open listener runs');
  assert.match(extractFn(S8, 'deptInsightsEnsureLive_'), /if \(!insReportLive_\(\)\) return;/,
    'the brief needs the payload even with the region at the bottom collapsed');
  // ...and so does the window sync (it froze the brief on the old window).
  assert.match(extractFn(S8, 'insReportLive_'), /reg\.open \|\| insBriefActive_\(\)/);
  assert.match(extractFn(S8, 'insSyncToDeptWindow_'), /if \(!insReportLive_\(\) \|\| !insPageInited_\) return;/);
  assert.match(CSS, /\.ins-brief-slot > details\.ins-brief-mounted > summary \{ display: none; \}/, 'the row is the section\'s header');
});

test('3: a jump into a mounted section opens its row (a section inside a hidden slot would stay invisible)', function () {
  const open = extractFn(S8, 'insOpenSection_');
  assert.match(open, /if \(insBriefMounted_\(el\)\) \{[\s\S]*?insBriefToggle_\(key, true\); return; \}/);
  assert.match(extractFn(S8, 'insSpotlightAgentCard_'), /insOpenSection_\('ins-agents-fold', true\)/);
  assert.ok(!/qhFold\.open = true/.test(S8) && !/agentsFold\.open = true/.test(S8), 'no direct opens left');
});

test('3: the Outbound / Callbacks rows quote their heads, updated in place', function () {
  // eslint-disable-next-line no-new-func
  const rowText = new Function('return (' + extractFn(S8, 'insBriefRowText_') + ');')();
  assert.equal(rowText('412 placed · 61.0% connected', 'Outbound'), 'Outbound: 412 placed · 61.0% connected');
  assert.equal(rowText('loading…', 'Outbound'), 'Outbound calls for this window');
  assert.equal(rowText('loading shortly…', 'Callbacks'), 'Callbacks for abandoned callers');
  assert.equal(rowText('', 'Callbacks'), 'Callbacks for abandoned callers');
  assert.match(extractFn(S8, 'insObRender_'), /head\.textContent = insObHeadText_\(t, cur\.scope\);\s*insBriefRowFromHead_\('outbound'\);/,
    'the loaded head reaches its row');
  assert.match(extractFn(S8, 'insBriefRank_'), /outbound: 2, callbacks: 3/);
});

test('TDC-1 / DV-1: ONE getDirectCallReport per dept + window, shared by the Team Direct Calls panel and the Direct view', function () {
  const view = extractFn(S5, 'dcViewRender_');
  assert.ok(!/google\.script\.run/.test(view), 'the Direct view never sends its own request -- it reads TDC_');
  assert.match(view, /var d = TDC_\.data/);
  const n = (S5.match(/\.getDirectCallReport\(/g) || []).length;
  assert.equal(n, 1, 'script-5 calls getDirectCallReport exactly once (tdcFetch_)');
  const sync = extractFn(S5, 'tdcSync_');
  assert.ok(!/addEventListener\('toggle'/.test(sync), 'no longer a lazy fold: it loads with the page');
  assert.match(sync, /\$\('tdc-retry'\)/, 'a failed load offers Retry');
  const render = extractFn(S5, 'tdcRender_');
  assert.match(render, /skel\.style\.display = loading \? '' : 'none'/, 'a skeleton while it loads');
  assert.match(render, /dcViewRender_\(\);\n  \}$/, 'every paint of the panel repaints the Direct view from the same payload');
  assert.match(HTML, /<div id="dept-team-direct" class="dept-qcd-snapshot" data-admin-only/, 'a panel, admin-only, not a <details>');
});

test('DV-1: the Direct view stays admin-only on its OWN gate -- the 6c release of the switch does not release it', function () {
  const btn = HTML.match(/<button[^>]*data-dir-pick="direct"[^>]*>/);
  assert.ok(btn && /data-admin-only/.test(btn[0]), 'the Direct button carries its own data-admin-only');
  assert.match(extractFn(S5, 'obEffectiveDir_'), /obDir_ === 'direct' && !tdcActive_\(\)\) \? 'both'/, 'a viewer who cannot read the Direct report lands on the default view');
});

// ---- IC-1..IC-4 (owner 2026-11-02): explainers become ⓘ tooltips ------------
test('IC-1/2/4: every "How this is counted" is an ⓘ whose bullets live in a hidden source element -- no visible explainer, no fold', function () {
  const srcs = (HTML.match(/data-gloss-src="([\w-]+)"/g) || []).map(function (x) { return x.replace(/.*="([\w-]+)"/, '$1'); });
  assert.deepEqual(srcs.slice().sort(), ['ins-cb-howto', 'ins-dl-howto', 'ov-cbdept-howto', 'ov-dl-howto']);
  srcs.forEach(function (id) {
    assert.match(HTML, new RegExp('<div id="' + id + '" class="ob-howto-src" hidden>'), id + ' is a hidden source');
  });
  assert.ok(!/<details class="ob-howto"/.test(HTML), 'no "How this is counted" fold is left');
  assert.ok(!/<p class="al-hint">\s*Counted in <strong>contact episodes<\/strong>/.test(HTML), 'the Callbacks explainer is no longer on the page');
  // The live figures that were in the explainers stay addressable by id, inside their sources.
  [['ins-cb-howto', 'ins-cb-window'], ['ins-cb-howto', 'ins-cb-scope-note'], ['ins-dl-howto', 'ins-dl-counts'],
   ['ov-dl-howto', 'ov-dl-counts'], ['ov-cbdept-howto', 'ov-cbdept-notcounted']].forEach(function (p) {
    const box = HTML.slice(HTML.indexOf('<div id="' + p[0] + '"'), HTML.indexOf('</div>', HTML.indexOf('<div id="' + p[0] + '"')));
    assert.ok(box.indexOf('id="' + p[1] + '"') !== -1, p[1] + ' sits inside ' + p[0]);
  });
  const show = S4.slice(S4.indexOf('    function show(el) {'), S4.indexOf('    function hide() {'));
  assert.match(show, /const rich = src \? src\.innerHTML : el\.getAttribute\('data-gloss-rich'\);/, 'read at SHOW time, so the figures are current');
});

test('IC-1: the two Callbacks list buttons share one row; the sub-queue line moved into the tooltip, the Neon note stayed', function () {
  const at = HTML.lastIndexOf('<div class="esc-resolve-actions ob-list-actions">', HTML.indexOf('id="ins-cb-uncalled-btn"'));
  const row = HTML.slice(at, HTML.indexOf('</div>', at));
  assert.ok(row.indexOf('id="ins-cb-uncalled-btn"') !== -1 && row.indexOf('id="ins-cb-calledback-btn"') !== -1, 'side by side');
  const r = extractFn(S8, 'insCbRender_');
  assert.ok(!/notes\.push\('Includes the abandoned callers/.test(r), 'the scope line is not a visible note');
  assert.match(r, /scope\.textContent = subDepts\.length \?/);
  assert.match(r, /notes\.push\('Neon was unreachable/, 'the fallback note stays visible');
});

test('IC-2: Direct lines reads as a disclosure -- a chevron that turns when open', function () {
  assert.match(CSS, /\.ob-dl-summary::before \{\s*content: '\\25b8';/);
  assert.match(CSS, /\.ob-dl-fold\[open\] > \.ob-dl-summary::before \{ transform: rotate\(90deg\); \}/);
});

test('IC-3: a brief row slides open AND shut on a user toggle; a rebuild and reduced motion switch instantly', function () {
  assert.match(extractFn(S8, 'insBriefToggle_'), /insBriefApply_\(key, true\);/, 'a user toggle animates');
  const a = extractFn(S8, 'insBriefApply_');
  assert.match(a, /if \(!animate \|\| still \|\| typeof slot\.animate !== 'function' \|\| insBriefReducedMotion_\(\)\) \{/);
  assert.match(a, /if \(open\) \{ slot\.hidden = false; setSections\(\); \}/, 'open: content in before measuring');
  assert.match(a, /if \(!open\) \{ slot\.hidden = true; setSections\(\); \}/, 'close: sections shut only once the slide ends');
  assert.match(extractFn(S8, 'insBriefReducedMotion_'), /prefers-reduced-motion: reduce/);
  assert.ok(/insBriefApply_\(key\);/.test(S8), 'the rebuild path restores rows without animating');
});
