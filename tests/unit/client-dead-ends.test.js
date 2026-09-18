'use strict';

// Batch 4 of the 2026-09-17 broad scan: the client DEAD-END / STALE-STATE
// fixes. Each was a place where the page stopped telling the truth -- a
// loader that never cleared, an error with no way out, a stale panel under a
// new dept's title, a store fed a payload that was not good, a second click
// that dispatched a second mutation. None of them is reachable from
// `node --test` behaviourally (they live in the assembled client IIFE and
// need a click), so these are SOURCE pins: each names the guard that closes
// the dead end and fails if a refactor removes it. The rendered-UI gate
// (`npm run ci:ui`) is where the behaviour is exercised.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
function src(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }
function between(s, startRe, endRe) {
  const a = s.search(startRe);
  assert.ok(a >= 0, 'start anchor missing: ' + startRe);
  const rest = s.slice(a);
  const b = rest.search(endRe);
  return b >= 0 ? rest.slice(0, b) : rest;
}

test('C2-1 / C2-4: Insights and IR validation refusals go through ONE refuse helper that clears the loader', function () {
  const ins = src('script-8-insights.html');
  const run = between(ins, /function runInsReport\(/, /\n  function (?!runInsReport)/);
  assert.ok(/function insRefuse_\(/.test(ins), 'insRefuse_ exists');
  assert.ok(/launcherHideLoading_\('ins-launcher-loading'\)/.test(between(ins, /function insRefuse_\(/, /\n  function /)),
    'the refuse helper clears the launcher loader (the "Refreshing… forever" dead end)');
  assert.ok(!/\{ insSetFormError\(/.test(run), 'no early-return in runInsReport sets the form error directly -- each routes through insRefuse_ (the clear + the RPC failure handler may still call it)');
  assert.ok((run.match(/insRefuse_\(/g) || []).length >= 5, 'no-dept, both date checks, prior.error and the mixed-dept refusal all route through it');

  const ir = src('script-6-ir.html');
  const irRun = between(ir, /function runIrReport\(/, /\n  function (?!runIrReport)/);
  assert.ok(/function irRefuse_\(/.test(ir), 'irRefuse_ exists');
  assert.ok(!/\{ irSetFormError\(/.test(irRun), 'no early-return in runIrReport sets the form error directly');
  assert.ok((irRun.match(/irRefuse_\(/g) || []).length >= 5, 'dates, agents, mixed-dept and prior.error refusals all route through it');
  assert.ok(/hideIrDrillLoading_\(\);/.test(between(ir, /function irRefuse_\(/, /\n  function (?!irRefuse_)/)),
    'the refuse helper clears the drill loader unconditionally (C2-4)');
});

test('C2-2: the IR edit popover applies the checked agents and refuses a mixed-dept pick', function () {
  const ir = src('script-6-ir.html');
  const pop = between(ir, /function irApplyEditPopover_\(/, /\n  function (?!irApplyEditPopover_)/);
  assert.ok(/irApplyCheckedAgents_\(/.test(pop), 'the popover commits the checkbox state before scoping');
  assert.ok(/subqPickerScope_\(\$\('ir-agent-list'\)\)/.test(pop), 'the popover runs the same one-dept scope gate as the form');
  assert.ok(/\.mixed\)/.test(pop) && /irSetResultsStatus\('error'/.test(pop), 'a mixed pick is REFUSED with a visible error, not silently narrowed');
});

test('C1-1: the Overview hard error is a Retry block beside the skeleton, never the loader\'s text', function () {
  const s3 = src('script-3-overview.html');
  assert.ok(/function ovShowLoadError_\(/.test(s3) && /function ovClearLoadError_\(/.test(s3));
  assert.ok(!/\$\('ov-loading'\)\.textContent\s*=/.test(s3), 'nothing overwrites the loader markup with error text');
  const load = between(s3, /function ovLoad_\(/, /\n  function (?!ovLoad_)/);
  assert.ok(/ovShowLoadError_\(/.test(load), 'the failure handler uses the block');
  assert.ok(/ovClearLoadError_\(\)/.test(load), 'a fresh non-silent load resets it');
  const show = between(s3, /function ovShowLoadError_\(/, /\n  function ovClearLoadError_/);
  assert.ok(/id="ov-load-retry"/.test(show) && /ovLoad_\(false\)/.test(show), 'the block carries a Retry that re-runs the load');
  assert.ok(/escapeHtml\(msg/.test(show), 'the server message is escaped before innerHTML');
});

test('C1-2: the async init latest-date snap yields to a window the user already picked', function () {
  const s2 = src('script-2-chrome.html');
  assert.ok(/var datesTouched_ = false;/.test(s2), 'the flag is declared');
  const init = between(s2, /\.getLatestDataDates\(\);/.source ? /withSuccessHandler\(function \(dates\) \{/ : null, /\.getLatestDataDates\(\);/);
  assert.ok(/if \(!datesTouched_\) \{\s*\$\('from-date'\)\.value = dqe;\s*\$\('to-date'\)\.value = dqe;/.test(init),
    'the snap writes From/To only while untouched');
  // Every user-driven window write sets the flag: typed dates, preset chips, the chart deep link.
  const fromL = between(s2, /\$\('from-date'\)\.addEventListener\('change'/, /\}\);/);
  const toL = between(s2, /\$\('to-date'\)\.addEventListener\('change'/, /\}\);/);
  assert.ok(/datesTouched_ = true/.test(fromL) && /datesTouched_ = true/.test(toL));
  const presets = between(s2, /function initDatePresets_\(/, /\n  function /);
  assert.ok(/datesTouched_ = true/.test(presets), 'a preset chip is a user pick');
  const s3 = src('script-3-overview.html');
  const route = between(s3, /function ovRouteToDept_\(/, /\n  function /);
  assert.ok(/datesTouched_ = true/.test(route), 'the chart-point deep link is a user pick');
});

test('C1-9: a getLatestDataDates failure is SAID, not swallowed', function () {
  const s2 = src('script-2-chrome.html');
  const fail = between(s2, /withFailureHandler\(function \(err\) \{\s*\/\/ C1-9/, /\.getLatestDataDates\(\);/);
  assert.ok(/showToast\(/.test(fail), 'the user sees a toast');
  assert.ok(/reportClientIssue_\('load-failure'/.test(fail), 'the admin hears about it (R19 beacon)');
  assert.ok(/refresh\(\);/.test(fail), 'the range fallback is unchanged');
});

test('C1-4: entering/exiting view-as re-fetches the escalation badge so the strip re-scopes', function () {
  const s3 = src('script-3-overview.html');
  const va = between(s3, /function applyViewAs_\(/, /\n  function (?!applyViewAs_)/);
  assert.ok(/loadEscBadge_\(\)/.test(va));
});

test('C1-6: a dept switch hides the previous dept\'s Transfer detail with the other side panels', function () {
  const s5 = src('script-5-dept.html');
  const sw = between(s5, /if \(lastSummaryDept_ !== null && lastSummaryDept_ !== dept\) \{/, /\n    \}\n/);
  assert.ok(/dept-transfer-section/.test(sw) && /dept-missed-section/.test(sw) && /dept-qcd-snapshot/.test(sw),
    'the transfer section joins the QCD snapshot + missed section in the switch-time hide');
});

test('C1-5: the SWR pre-paint does NOT re-enable Refresh -- only the live paint does', function () {
  const s5 = src('script-5-dept.html');
  const onData = between(s5, /function onData\(data, opts\) \{/, /\n  function (?!onData)/);
  assert.ok(/if \(!\(opts && opts\.swr\)\) \$\('refresh-btn'\)\.disabled = false;/.test(onData));
  assert.ok(!/^\s*\$\('refresh-btn'\)\.disabled = false;/m.test(onData), 'no unconditional re-enable remains in onData');
  const onError = between(s5, /function onError\(err, hadSwrPaint\) \{/, /\n  function (?!onError)/);
  assert.ok(/\$\('refresh-btn'\)\.disabled = false;/.test(onError), 'a failure still re-enables it (no stuck-disabled dead end)');
});

test('C1-7 / C1-8: every tile render re-syncs the solo markers, and an empty dept list says so', function () {
  const s3 = src('script-3-overview.html');
  const tiles = between(s3, /function ovRenderTiles_\(/, /\n  function (?!ovRenderTiles_)/);
  assert.ok(/ovSyncTilePins_\(ovChartInstance\)/.test(tiles), 'pins re-applied inside the renderer itself, so every caller inherits it');
  assert.ok(/depts\.length \? html : ovEmptyStateHtml_\(\)/.test(tiles), 'the empty state replaces a blank grid');
  assert.ok(/function ovEmptyStateHtml_\(/.test(s3) && /role="status"/.test(between(s3, /function ovEmptyStateHtml_\(/, /\n  \}/)));
});

test('C1-10: the chart-point deep link sets the window BEFORE the selector change, and fetches once', function () {
  const s3 = src('script-3-overview.html');
  const route = between(s3, /function ovRouteToDept_\(/, /\n  function (?!ovRouteToDept_)/);
  const iDates = route.search(/\$\('from-date'\)\.value = isoDate;/);
  const iDispatch = route.search(/sel\.dispatchEvent\(new Event\('change'\)\)/);
  assert.ok(iDates >= 0 && iDispatch >= 0 && iDates < iDispatch, 'dates first, so the change handler\'s refresh() carries the clicked day');
  assert.ok(/\} else if \(datesSet\) \{\s*refresh\(\);/.test(route), 'a same-dept click refreshes exactly once; a dept switch relies on the change handler');
  assert.equal((route.match(/refresh\(\);/g) || []).length, 1, 'no second unconditional refresh() after the dispatch');
});

test('C2-3: the last-good store refuses an UNAVAILABLE Inbound payload and an errored Insights queue-health', function () {
  const s9 = src('script-9-inbound-direct.html');
  assert.ok(/if \(!\(data && data\.meta && data\.meta\.available === false\)\) \{\s*reportLastGoodWrite_\('inbound'/.test(s9));
  const s8 = src('script-8-insights.html');
  assert.ok(/if \(!\(data && data\.queueHealth && data\.queueHealth\.error\)\) \{\s*reportLastGoodWrite_\('ins'/.test(s8));
});

test('C2-6: the row-invoked mutation verbs carry an in-flight guard, released on BOTH handlers', function () {
  const s7 = src('script-7-admin.html');
  const s10 = src('script-10-escalations.html');
  assert.ok(/function mutationBusy_\(key\)/.test(s7) && /function mutationDone_\(key\)/.test(s7));
  [['script-7-admin.html', 'alCfgRemove_', 'alCfgRemove'],
   ['script-7-admin.html', 'alDgRemove_', 'alDgRemove'],
   ['script-7-admin.html', 'alQrRemove_', 'alQrRemove'],
   ['script-7-admin.html', 'acAgentRemove_', 'acRemove'],
   ['script-7-admin.html', 'acRemoveRow_', 'acRemove'],
   ['script-10-escalations.html', 'escSaveComment_', 'busyKey']].forEach(function (t) {
    const s = t[0] === 'script-7-admin.html' ? s7 : s10;
    const fn = between(s, new RegExp('function ' + t[1] + '\\('), /\n  function (?!$)/);
    const key = t[2] === 'busyKey' ? 'busyKey' : "'" + t[2] + "'";
    assert.ok(fn.indexOf('mutationBusy_(' + key + ')') >= 0, t[1] + ' guards dispatch');
    assert.equal((fn.match(/mutationDone_\(/g) || []).length, 2, t[1] + ' releases on success AND failure');
  });
});

test('C2-7: the four admin modal init failures render a Retry, not a dead "Error:" loader', function () {
  const s7 = src('script-7-admin.html');
  assert.ok(/function adminInitError_\(elId, err, retryFn\)/.test(s7));
  ['al-loading', 'of-loading', 'ac-loading', 'dc-loading'].forEach(function (id) {
    assert.ok(new RegExp("adminInitError_\\('" + id + "'").test(s7), id + ' routes through the helper');
    assert.ok(!new RegExp("\\$\\('" + id + "'\\)\\.textContent = 'Error").test(s7), id + ' no longer overwrites the loader text');
  });
  const helper = between(s7, /function adminInitError_\(/, /\n  \}\n/);
  assert.ok(/origHtml/.test(helper) && /retryFn\(\)/.test(helper), 'Retry restores the loader markup and re-runs the init');
  assert.ok(/escapeHtml\(msg\)/.test(helper), 'the server message is escaped before innerHTML');
});

// ---------------------------------------------------------------------------
// Batch 9 (interface structural): the keyboard / ARIA / theme rules. Same
// reasoning as above -- each lives in the assembled client and needs a key
// press or a screen reader to observe, so these pin the SOURCE of the rule;
// drive-subqueue.js exercises the C1-13 keypress for real.
// ---------------------------------------------------------------------------

test('C1-13: Enter/Space on the sub-queue group header re-dispatches the click toggle', function () {
  const s2 = src('script-2-chrome.html');
  const kd = between(s2, /agentsTbody\.addEventListener\('keydown'/, /\n      \}\);/);
  assert.ok(/closest\('tr\.subq-group-head'\)/.test(kd) && /ghead\.click\(\)/.test(kd),
    'the tbody keydown handler knows the group-head row and fires its one toggle path');
});

test('C2-10: srtApply_ wires Enter/Space + tabIndex + aria-sort on every report sort header', function () {
  const s9 = src('script-9-inbound-direct.html');
  const fn = between(s9, /function srtApply_\(/, /\n  function (?!srtApply_)/);
  assert.ok(/thead\.addEventListener\('keydown'/.test(fn), 'a keydown delegate sits beside the click delegate');
  assert.ok(/th\.tabIndex = 0/.test(fn), 'headers are focusable');
  assert.ok(/setAttribute\('aria-sort', st\.dir === 'asc' \? 'ascending' : 'descending'\)/.test(fn)
    && /removeAttribute\('aria-sort'\)/.test(fn), 'aria-sort follows the active key and is cleared elsewhere');
});

test('C2-9 (the E-8 house rule): no fragment puts role="button" on a <tr>', function () {
  const frags = fs.readdirSync(DIR).filter(function (f) { return /^script-\d+-.*\.html$/.test(f); });
  frags.forEach(function (f) {
    const s = src(f);
    // A row opener and a role=button on the same rendered line (the two
    // shapes that shipped: the Insights day row and the Health fold head).
    const bad = s.split('\n').filter(function (l) { return !/^\s*\/\//.test(l) && /<tr\b/.test(l) && /role="button"/.test(l); });
    assert.deepEqual(bad, [], f + ': role=button belongs on an inner control, never the <tr>');
  });
  const s8 = src('script-8-insights.html');
  assert.ok(/class="ins-daily-toggle" aria-expanded=/.test(s8), 'the Insights day row carries its disclosure as an inner <button>');
  const s9 = src('script-9-inbound-direct.html');
  assert.ok(/class="sh-fold-btn" aria-expanded=/.test(s9), 'the Health fold head carries its disclosure as an inner <button>');
  assert.ok(!/head\.addEventListener\('keydown'/.test(between(s9, /function healthRender_\(/, /\n  function (?!healthRender_)/)),
    'no row keydown beside the native button (it would toggle twice per keypress)');
});

test('C2-11: the guided tour traps focus, returns it, and scopes the document-level Enter', function () {
  const s10 = src('script-10-escalations.html');
  assert.ok(/trapFocus_\(\$\('tour-tip'\)\)/.test(s10), 'startTour_ traps Tab inside the tip');
  const finish = between(s10, /function tourFinish_\(/, /\n  function (?!tourFinish_)/);
  assert.ok(/releaseFocus_\(\)/.test(finish) && /tourOpener_/.test(finish), 'finishing releases the trap and returns focus to the opener');
  const key = between(s10, /function tourKey_\(/, /\n  function (?!tourKey_)/);
  assert.ok(/onTipButton/.test(key) && /e\.key === 'Enter' && !onTipButton/.test(key),
    'Enter is the document shortcut only when focus is NOT on a tip button (a focused button fires natively)');
});

test('C1-14 / C1-15 / C1-16: tiles are described (not labelled), the dialogs are named, the notices are live', function () {
  const s3 = src('script-3-overview.html');
  assert.ok(!/tile\.setAttribute\('aria-label'/.test(s3), 'no aria-label on the tile -- it would replace every KPI in it');
  assert.ok(/tile\.setAttribute\('aria-describedby', 'ov-tile-action-desc'\)/.test(s3), 'the isolate action is a description');
  assert.ok(/setAttribute\('role', 'status'\)/.test(between(s3, /function ovSetCachedIndicator_\(/, /\n  function /)), 'the cached pill is a live region');
  assert.ok(/setAttribute\('role', 'status'\)/.test(between(s3, /function ovSetRefreshWarn_\(/, /\n  function /)), 'the refresh warning is a live region');
  const s1 = src('script-1-core.html');
  assert.ok(/role="alertdialog" aria-modal="true"'\s*\+\s*' aria-labelledby="ds-confirm-title" aria-describedby="ds-confirm-body"/.test(s1), 'dsConfirm_ is named + described');
  assert.ok(/role="dialog" aria-modal="true" aria-labelledby="ds-prompt-title"/.test(s1), 'dsPrompt_ is named');
  const dash = src('dashboard.html');
  assert.ok(/id="dept-clamp-note" role="status"/.test(dash), 'the clamp note is a live region');
});

test('C1-18: the chart-tips dialog traps focus and restores the modal\'s trap on close', function () {
  const s4 = src('script-4-nav.html');
  const fn = between(s4, /function initChartHelp_\(/, /\n  \/\/ -- R10-3/);
  assert.ok(/trapFocus_\(pop\)/.test(fn), 'the popover is trapped');
  assert.ok(/class="btn btn-secondary chp-close"/.test(fn), 'it carries a real control for Tab to cycle on');
  assert.ok(/outerTrap/.test(fn) && /activeFocusTrap_ = outerTrap/.test(fn), 'the opener modal\'s trap is re-armed on close');
});

test('C2-12: the Views menu has the shared key wiring; Escape closes an open edit popover before the modal', function () {
  const s8 = src('script-8-insights.html');
  assert.ok(/wireMenuKeys_\(viewsBtn, viewsMenu, setViewsOpen\)/.test(s8), 'Views menu');
  assert.ok(/insCloseEditPopover_\(\);\s*\n\s*if \(editBtn\) editBtn\.focus\(\);/.test(s8), 'Insights popover Escape returns focus');
  const s6 = src('script-6-ir.html');
  const kd = between(s6, /function onKeyDown\(e\) \{/, /\n    \}\n/);
  assert.ok(/ir-edit-popover/.test(kd) && /irCloseEditPopover_\(\)/.test(kd) && /closeModal\(\)/.test(kd),
    'IR: the popover closes first, the modal on the next Escape');
  const s1 = src('script-1-core.html');
  assert.ok(/INPUT\|TEXTAREA\|SELECT/.test(between(s1, /function wireMenuKeys_\(/, /\n  function (?!wireMenuKeys_)/)),
    'a text field inside a menu keeps its caret keys');
});

test('UD-3 / C1-17: one global :focus-visible ring, no outline:none on a :focus rule, on-fill text tokens', function () {
  const css = src('styles.html');
  assert.ok(/\n\s*:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/.test(css), 'the global ring exists');
  const offenders = css.split('\n').map(function (l, i) { return { l: l, n: i + 1 }; })
    .filter(function (x) { return /outline:\s*none\s*[;}]/.test(x.l); });   // a declaration, not the prose about it
  assert.deepEqual(offenders.map(function (x) { return x.n + ': ' + x.l.trim(); }), [],
    'no `outline: none` anywhere in styles.html (a :focus rule dropping the ring with no replacement)');
  assert.ok(/--on-good:\s*#ffffff/.test(css) && /--on-warn:\s*#ffffff/.test(css), 'light on-fill tokens');
  assert.ok(/--on-good: #101418/.test(css) && /--on-warn: #101418/.test(css), 'dark on-fill tokens');
  assert.ok(/\.toast-success \{ background: var\(--good\); color: var\(--on-good, #fff\); \}/.test(css), 'toast-success reads the token');
  assert.ok(/\.toast-error\s+\{ background: var\(--warn\); color: var\(--on-warn, #fff\); \}/.test(css), 'toast-error reads the token');
  assert.ok(/\.ds-confirm--danger \{ background: var\(--warn\); color: var\(--on-warn, #fff\); \}/.test(css), 'the danger confirm reads the token');
  assert.ok(!/color:\s*#fff;?\s*\}/.test(between(css, /\.toast-success/, /\n\n/)), 'no hardcoded white left on the toasts');
});

test('UD-1 / UD-2 / UD-7 / UD-8: the phone breakpoints, the retired print CSS gone, the global print hides', function () {
  const css = src('styles.html');
  assert.ok(/@media \(max-width: 700px\) \{ \.ir-row \{ grid-template-columns: 1fr; \} \}/.test(css), 'UD-1');
  assert.ok(/#ins-heatmap \{\s*flex: 1 1 420px; min-width: min\(360px, 100%\)/.test(css), 'UD-2 heatmap floor');
  assert.ok(/\.ins-qh-table-card \{ flex: 1 1 420px; min-width: min\(340px, 100%\)/.test(css), 'UD-2 table-card floor');
  assert.ok(!/body\.(pr|cr)-printing/.test(css) && !/\.pr-th-sortable\s*[{:]/.test(css), 'UD-7: the retired Performance / Compare Ranges print + sort rules are gone');
  const print = between(css, /@media print \{/, /\n  \}\n/);
  ['#help-fab', '#ins-ab-panel', '#dev-overlay', '.toast-container', '.tour-overlay', '.ds-confirm-overlay', '.modal-backdrop']
    .forEach(function (sel) { assert.ok(print.indexOf(sel) >= 0, 'UD-8 print hides ' + sel); });
});

test('UD-4 / UD-5 / UD-6 / UD-9 / UD-10 / C2-13: the markup-level fixes', function () {
  const s5 = src('script-5-dept.html');
  assert.ok(/<button type="button" class="ms-bucket-link" tabindex="-1"/.test(s5), 'UD-4: the ring-time cross-link is a button (out of the tab order)');
  const s9 = src('script-9-inbound-direct.html');
  assert.ok(/<button type="button" class="ms-agent-link" tabindex="-1"/.test(s9), 'UD-4: the agent-name cross-link is a button');
  const card = between(s5, /return '<details class="agent-card'/, /\}\)\.join\(''\);/);
  const summaryEnd = card.indexOf("'</summary>'");
  assert.ok(summaryEnd > 0 && card.indexOf('agent-scope-btn') > summaryEnd, 'UD-5: the scope button renders AFTER </summary>, not inside it');
  const dash = src('dashboard.html');
  assert.equal((dash.match(/class="side-hint-i gloss" tabindex="0" role="note"/g) || []).length, 2, 'UD-6: both side hints are notes on the styled tooltip layer');
  assert.ok(/<h1 id="page-title" tabindex="-1">/.test(dash), 'UD-9: the page h1 can take focus');
  const s6 = src('script-6-ir.html');
  assert.ok(/const h1 = \$\('page-title'\);\s*\n\s*if \(h1\) \{ try \{ h1\.focus\(\); \}/.test(s6), 'UD-9: the from-Insights close focuses the h1');
  assert.ok(!/<div class="al-section-title"/.test(dash) && (dash.match(/<h3 class="al-section-title"/g) || []).length >= 30, 'UD-10: section titles are h3');
  assert.ok(!/<div class="al-section-title"/.test(s9), 'UD-10: the Direct per-dept title is an h3 too');
  assert.ok(!/<label>&nbsp;<\/label>/.test(dash) && !/<label>Quick select<\/label>/.test(dash), 'C2-13: no label element that labels nothing');
  assert.ok(/<legend class="ctl-label">Report type<\/legend>/.test(dash), 'C2-13: the checkbox group is a fieldset');
  const agent = src('agent.html');
  assert.ok(/id="agent-from" aria-label="From date"/.test(agent) && /id="agent-to" aria-label="To date"/.test(agent), 'C2-13: agent date inputs are labelled');
  assert.ok(/role="tablist" aria-label="Pages"/.test(agent) && /role="tab" aria-selected="true"/.test(agent), 'C2-13: the agent tabs are a tablist');
  assert.ok(/setAttribute\('aria-selected', home \? 'true' : 'false'\)/.test(src('agentApp.html')), 'C2-13: aria-selected follows the tab switch');
  assert.ok(/role="tab" aria-selected="' \+ \(inboundDrillMetric === 'calls'\)/.test(s9), 'C2-13: the inbound drill tabs carry aria-selected');
});

// The Alerts modal's config section (reported from production 2026-09-18).
// Two defects, both client-side, so only source pins can hold them:
// (1) the dept picker was filled from the USER envelope and rendered EMPTY,
//     leaving no way to create an alert; (2) a save re-ran the whole modal
//     init, blanking every section to show one changed row.
test('Alerts config section: server-fed picker, in-place re-render, loud empty payload', function () {
  const s7 = src('script-7-admin.html');

  // (1) The server list WINS; the envelope is only a fallback.
  assert.ok(/const depts = \(alDepts_ && alDepts_\.length\) \? alDepts_ : \(\(USER && USER\.departments\) \|\| \[\]\);/.test(s7),
    'the dept picker prefers the served list over the USER envelope');
  assert.ok(/alRenderConfigTable_\(data\.config \|\| \[\], data\.drift \|\| \{\}, data\.departments \|\| \[\]\)/.test(s7),
    'the served dept list is threaded into the config renderer');

  // (2) Neither write path may reach for the whole-modal init directly; both
  // go through the section applier, which falls back to it only on
  // `sectionStale`. Guard against a future edit quietly restoring the reload.
  const save = s7.slice(s7.indexOf('function alCfgSave_()'), s7.indexOf('function alCfgRemove_('));
  assert.ok(!/alLoadInit_\(\)/.test(save), 'alCfgSave_ does not re-run the modal init');
  assert.ok(/alCfgApplySection_\(res\)/.test(save), 'alCfgSave_ re-renders the section from the save result');
  const remove = s7.slice(s7.indexOf('function alCfgRemove_('), s7.indexOf('// ---- Report Subscribers'));
  assert.ok(!/alLoadInit_\(\)/.test(remove), 'alCfgRemove_ does not re-run the modal init');
  assert.ok(/alCfgApplySection_\(res\)/.test(remove), 'alCfgRemove_ re-renders the section from the remove result');
  assert.ok(/if \(!res \|\| res\.sectionStale \|\| !res\.config\) \{ alLoadInit_\(\); return; \}/.test(s7),
    'a stale section is the ONE path back to the full reload');
  assert.ok(/\.al-config-table\.is-busy/.test(src('styles.html')),
    'the busy cue is on the config table, not the modal-wide loader');

  // (3) A falsy payload must reach the retry path BEFORE the body is shown.
  // It used to be swallowed after reveal, which is what made the blank modal
  // look loaded -- every field showing a placeholder reads like real config.
  const guard = s7.slice(s7.indexOf('function alLoadInit_()'), s7.indexOf('function alRenderDigestInit_'));
  // Assert the CONDITION, not just the order: an earlier draft of this pin
  // checked only that the bail-out preceded the reveal, and stayed green when
  // `if (!data)` was mutated to `if (false)`.
  assert.ok(/if \(!data\) \{\s*adminInitError_\('al-loading', new Error\([^)]*\), alLoadInit_\);\s*return;\s*\}/.test(guard),
    'a falsy payload routes to the retry path');
  const bail = guard.indexOf('if (!data) {');
  const reveal = guard.indexOf("$('al-body').style.display = ''");
  assert.ok(bail > 0 && reveal > 0 && bail < reveal,
    'the no-payload bail-out comes before the body is revealed');
});
