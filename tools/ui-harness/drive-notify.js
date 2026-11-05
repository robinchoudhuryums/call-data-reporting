'use strict';
/**
 * ASSERTING driver for the NOTIFICATIONS page (owner plan Step 5a; admin trial).
 *
 * The Alerts modal became "Notifications": each low-answer-rate rule renders
 * as the sentence it enforces, with History ("would it have fired?" over the
 * last 20 workdays, beside what actually happened) and Test send (the real
 * email, to the requesting admin only). The MANAGER LAYER -- a manager making
 * their own department's alert stricter, never looser -- is built but off:
 * its switch lives in the modal, and a manager's surface is a section of their
 * Settings that renders only once released. All of it is server-pinned
 * (tests/unit/notifications.test.js); only a browser shows that the sentences,
 * the history table, the confirm, the switch and the manager's refusal message
 * actually render, and that a manager sees nothing while the layer is off.
 *
 * Walk: admin opens Notifications -> one sentence card per rule, the invalid
 * one says "not monitored" with no History/Test -> History opens a table of
 * workdays, folds on a second click -> Test send asks first, Cancel sends
 * nothing, Confirm sends ONE sendAlertTest -> the manager-layer switch calls
 * setNotifyManagerEdit -> manager (layer off): Settings has no alert section
 * and no notify RPC fires -> manager (layer on): the section renders the rule,
 * a looser value shows the server's refusal, a stricter one saves -> 360 px.
 *
 * Run: node drive-notify.js   (after gen-payloads + gen-phase3 + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

async function boot(context, file, notifyEdit) {
  const page = await context.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push('pageerror: ' + (e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(m.text())) page.__errors.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });
  await page.goto('file://' + path.join(__dirname, 'site', file));
  await page.waitForTimeout(2500);
  // The release flag rides the user envelope; USER is the same object, so
  // flipping it here is what a page served after release would carry.
  if (notifyEdit) await page.evaluate(() => { window.__USER__.notifyEdit = true; });
  return page;
}

const calls = (page, fn) => page.evaluate((f) => window.__HARNESS__.calls.filter((c) => c.fn === f).length, fn);

async function openNotifications(page) {
  await page.evaluate(() => { document.getElementById('admin-menu-btn').click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById('alerts-btn').click(); });
  await page.waitForTimeout(2000);
}

(async () => {
  const browser = await chromium.launch(launchOptions());

  // ---- admin -----------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await boot(ctx, 'index-admin.html');
  await openNotifications(page);

  const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#al-rules .al-rule')).map((c) => ({
    dept: c.getAttribute('data-dept'),
    text: c.querySelector('.al-rule-sentence').textContent.trim(),
    history: !!c.querySelector('.al-rule-history-btn'),
    test: !!c.querySelector('.al-rule-test-btn'),
  })));
  const title = await page.evaluate(() => document.getElementById('alerts-modal-title').textContent.trim());
  record('the modal is titled Notifications', title === 'Notifications', title);
  const csr = cards.filter((c) => c.dept === 'CSR')[0];
  record('each rule is a sentence naming its dept, threshold and who is emailed',
    cards.length >= 2 && !!csr && /^When CSR’s answer rate on a workday falls below 85%, email its managers/.test(csr.text),
    JSON.stringify(cards.map((c) => c.text)));
  const bad = cards.filter((c) => /not monitored/.test(c.text))[0];
  record('an invalid rule says it is not monitored and offers no History / Test send',
    !!bad && !bad.history && !bad.test, JSON.stringify(bad || null));
  const noTable = await page.evaluate(() => !document.getElementById('al-config-tbody'));
  record('the old config table is gone', noTable);

  // History
  await page.click('#al-rules .al-rule[data-dept="CSR"] .al-rule-history-btn');
  await page.waitForTimeout(800);
  const hist = await page.evaluate(() => {
    const card = document.querySelector('#al-rules .al-rule[data-dept="CSR"]');
    const box = card.querySelector('.al-rule-history');
    return { hidden: box.hidden, rows: box.querySelectorAll('tbody tr').length,
      fire: box.querySelectorAll('tr.is-fire').length,
      lead: (box.querySelector('.al-hint') || {}).textContent || '',
      expanded: card.querySelector('.al-rule-history-btn').getAttribute('aria-expanded') };
  });
  record('History opens a row per workday, the would-fire days marked',
    !hist.hidden && hist.rows === 5 && hist.fire === 3 && hist.expanded === 'true'
      && /would have fired on 3 of 4 workdays/.test(hist.lead), JSON.stringify(hist));
  await page.click('#al-rules .al-rule[data-dept="CSR"] .al-rule-history-btn');
  await page.waitForTimeout(200);
  const folded = await page.evaluate(() => document.querySelector('#al-rules .al-rule[data-dept="CSR"] .al-rule-history').hidden);
  record('a second click folds it', folded);

  // Test send: asks first; Cancel sends nothing.
  await page.fill('#al-date', '2026-08-19');
  await page.click('#al-rules .al-rule[data-dept="CSR"] .al-rule-test-btn');
  await page.waitForTimeout(300);
  const ask = await page.evaluate(() => {
    const d = document.querySelector('.ds-confirm');
    return d ? d.textContent : '';
  });
  record('Test send asks first and says only you receive it', /you only/.test(ask) && /CSR/.test(ask), ask.slice(0, 160));
  await page.click('.ds-confirm-cancel');
  await page.waitForTimeout(400);
  record('Cancel sends nothing', (await calls(page, 'sendAlertTest')) === 0);
  await page.click('#al-rules .al-rule[data-dept="CSR"] .al-rule-test-btn');
  await page.waitForTimeout(300);
  await page.click('.ds-confirm-ok');
  await page.waitForTimeout(600);
  const sentStatus = await page.evaluate(() => document.getElementById('al-cfg-status').textContent);
  record('Confirm sends ONE test and reports who got it',
    (await calls(page, 'sendAlertTest')) === 1 && /Test sent to admin@ums\.com/.test(sentStatus), sentStatus);

  // Step 5c: more alert reasons
  await page.selectOption('#al-reason-dept', 'CSR');
  await page.fill('#al-reason-agent-threshold', '40');
  await page.fill('#al-reason-agent-days', '1');
  await page.fill('#al-reason-cb-min', '2');
  await page.click('#al-reason-save');
  await page.waitForTimeout(500);
  const rErr = await page.evaluate(() => document.getElementById('al-reason-status').textContent);
  record('reasons: a 1-workday window is refused with the reason', /from 2 to 20/.test(rErr), rErr);
  await page.fill('#al-reason-agent-days', '5');
  await page.click('#al-reason-save');
  await page.waitForTimeout(500);
  const reasons = await page.evaluate(() => Array.from(document.querySelectorAll('#al-reasons .al-rule-sentence')).map((p) => p.textContent.trim()));
  record('reasons: each reads as a sentence that emails the ADMINS',
    reasons.length === 2 && /^When an agent in CSR answers under 40% on each of the last 5 workdays, email the admins\.$/.test(reasons[0])
      && /^When 2 or more callers who could not get through to CSR are not called back within a business day, email the admins\.$/.test(reasons[1]),
    JSON.stringify(reasons));
  await page.click('#al-preview-btn');
  await page.waitForTimeout(800);
  const prev = await page.evaluate(() => Array.from(document.querySelectorAll('#al-results-tbody tr')).map((tr) => Array.from(tr.cells).map((c) => c.textContent.trim())));
  record('reasons: Preview names each reason row and its own kind of threshold',
    prev.length === 3 && /agents below/.test(prev[1][0]) && prev[1][2] === '40%' && /callbacks/.test(prev[2][0])
      && prev[2][2] === '2+ callers' && prev[2][4] === 'Did not fire', JSON.stringify(prev));

  // Manager-layer switch
  const sw = await page.evaluate(() => ({ checked: document.getElementById('al-mgr-enabled').checked,
    pill: document.getElementById('al-mgr-pill').textContent }));
  record('the manager layer starts OFF', !sw.checked && sw.pill === 'OFF', JSON.stringify(sw));
  await page.click('#al-mgr-enabled');
  await page.waitForTimeout(600);
  const toggled = await page.evaluate(() => window.__HARNESS__.calls.filter((c) => c.fn === 'setNotifyManagerEdit').map((c) => c.args[0]));
  record('the switch asks the server (admin-only verb)', toggled.length === 1 && toggled[0].enabled === true, JSON.stringify(toggled));
  // ---- Step 5b: the Coaching worklist ------------------------------------
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.getElementById('admin-menu-btn').click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById('coaching-btn').click(); });
  await page.waitForTimeout(1500);
  const cw = await page.evaluate(() => ({
    actions: Array.from(document.querySelectorAll('#coaching-tbody [data-coaching-action]')).map((b) => b.textContent.trim()),
    gates: Array.from(document.querySelectorAll('#coaching-gates .al-rule')).map((c) => ({
      dept: c.getAttribute('data-dept'),
      text: c.querySelector('.al-rule-sentence').textContent.trim(),
      chip: ((c.querySelector('.al-rule-meta') || {}).textContent || '').trim(),
      inputs: c.querySelectorAll('input[data-gate]').length,
    })),
  }));
  record('coaching: an open flag closes as Met / Rotated / Dismissed',
    JSON.stringify(cw.actions) === JSON.stringify(['Met', 'Rotated', 'Dismissed']), JSON.stringify(cw.actions));
  const cg = cw.gates.filter((g) => g.dept === 'CSR')[0];
  record('coaching: each dept\'s gates read as a sentence naming the APPLIED values, a manager\'s stricter value chipped',
    cw.gates.length === 3 && !!cg && /less than 60% as often as the team, at least 3 points behind, with 20\+ missed rings/.test(cg.text)
      && /Manager stricter: 3 pts/.test(cg.chip) && cg.inputs === 4, JSON.stringify(cw.gates));
  // CO-1: a flat answer-% department reads as its own sentence, with only the
  // inputs its mode uses showing; switching the mode swaps them and marks the card unsaved.
  const flat = await page.evaluate(() => {
    const c = document.querySelector('#coaching-gates .al-rule[data-dept="Power"]');
    const vis = (g) => { const i = c.querySelector('input[data-gate="' + g + '"]'); return !!i && i.offsetParent !== null; };
    return { text: c.querySelector('.al-rule-sentence').textContent, mode: c.querySelector('select[data-gate-mode]').value,
      flatShown: vis('flatRatePct'), ratioShown: vis('maxTeamRatioPct'), saveAll: document.getElementById('coaching-gates-save-all').disabled };
  });
  record('CO-1: a flat answer-% gate reads as its own sentence and shows only its own inputs; Save all starts disabled',
    /less than 40% of their rings \(a flat gate/.test(flat.text) && flat.mode === 'flat' && flat.flatShown && !flat.ratioShown && flat.saveAll === true,
    JSON.stringify(flat));
  // CO-2: the worklist row -- agent with department, the rate drawn against the team, the status pill.
  const crow = await page.evaluate(() => {
    const tr = document.querySelector('#coaching-tbody tr');
    return { agent: (tr.querySelector('.coach-agent') || {}).textContent, dept: (tr.querySelector('.coach-dept') || {}).textContent,
      fill: (tr.querySelector('.coach-rate-fill') || { style: {} }).style.width, team: (tr.querySelector('.coach-rate-team') || { style: {} }).style.left,
      pill: (tr.querySelector('.coach-pill') || {}).textContent, times: (tr.querySelector('.coach-times') || {}).textContent,
      cols: document.querySelectorAll('#coaching-table thead th').length };
  });
  record('CO-2: a flag row names the agent and department, draws their rate against the team\'s, and shows an Open pill',
    crow.agent === 'Test Agent' && crow.dept === 'CSR' && crow.fill === '21.4%' && crow.team === '78.9%' && crow.pill === 'Open'
      && /flagged 2×/.test(crow.times || '') && crow.cols === 6, JSON.stringify(crow));
  await page.fill('#coaching-gates .al-rule[data-dept="Sales"] input[data-gate="maxTeamRatioPct"]', '55');
  await page.click('#coaching-gates .al-rule[data-dept="Sales"] .coaching-gate-save');
  await page.waitForTimeout(600);
  const gsave = await page.evaluate(() => window.__HARNESS__.calls.filter((c) => c.fn === 'saveCoachingDeptRule').map((c) => c.args[0]));
  const savedCard = await page.evaluate(() => {
    const c = document.querySelector('#coaching-gates .al-rule[data-dept="Sales"]');
    return { status: c.querySelector('.coaching-gate-status').textContent, dirty: c.classList.contains('is-dirty'),
      text: c.querySelector('.al-rule-sentence').textContent };
  });
  record('coaching: Save sends that dept\'s gates and says it saved, beside the button', gsave.length === 1 && gsave[0].department === 'Sales'
    && gsave[0].maxTeamRatioPct === '55' && gsave[0].behindPts === '5' && gsave[0].mode === 'team' && gsave[0].flatRatePct === ''
    && /^Saved/.test(savedCard.status) && !savedCard.dirty && /less than 55% as often/.test(savedCard.text),
    JSON.stringify({ gsave: gsave, card: savedCard }));
  // CO-1: Save all -- two edited departments in ONE call, the button saying what it does.
  await page.fill('#coaching-gates .al-rule[data-dept="CSR"] input[data-gate="minMissed"]', '18');
  await page.selectOption('#coaching-gates .al-rule[data-dept="Sales"] select[data-gate-mode]', 'flat');
  await page.fill('#coaching-gates .al-rule[data-dept="Sales"] input[data-gate="flatRatePct"]', '30');
  const allLabel = await page.evaluate(() => { const b = document.getElementById('coaching-gates-save-all'); return { t: b.textContent, d: b.disabled }; });
  await page.click('#coaching-gates-save-all');
  await page.waitForTimeout(600);
  const all = await page.evaluate(() => ({
    calls: window.__HARNESS__.calls.filter((c) => c.fn === 'saveCoachingDeptRules').map((c) => c.args[0].rules.map((r) => r.department + ':' + r.mode)),
    status: document.getElementById('coaching-gates-status').textContent,
    dirty: document.querySelectorAll('#coaching-gates .is-dirty').length,
    sales: document.querySelector('#coaching-gates .al-rule[data-dept="Sales"] .al-rule-sentence').textContent,
  }));
  record('CO-1: Save all sends every edited department in one call and says so; the cards are clean after',
    allLabel.t === 'Save all changes (2)' && !allLabel.d && all.calls.length === 1 && JSON.stringify(all.calls[0]) === '["CSR:team","Sales:flat"]'
      && /Saved the gates for 2 departments/.test(all.status) && all.dirty === 0 && /less than 30% of their rings/.test(all.sales),
    JSON.stringify({ allLabel: allLabel, all: all }));
  // ...and a bad value saves nothing, naming the department.
  await page.fill('#coaching-gates .al-rule[data-dept="CSR"] input[data-gate="behindPts"]', '99');
  await page.click('#coaching-gates-save-all');
  await page.waitForTimeout(600);
  const badAll = await page.evaluate(() => ({ status: document.getElementById('coaching-gates-status').textContent,
    card: document.querySelector('#coaching-gates .al-rule[data-dept="CSR"] .coaching-gate-status').textContent }));
  record('CO-1: a bad value in Save all saves nothing and names the department', /^Nothing was saved: CSR: behindPts/.test(badAll.status)
    && badAll.card === 'Not saved', JSON.stringify(badAll));
  // The manager-email preview reports on its own card, while it sends and after.
  const prevBusy = await page.evaluate(() => new Promise((res) => {
    const c = document.querySelector('#coaching-gates .al-rule[data-dept="CSR"]');
    c.querySelector('.coaching-gate-preview').click();
    res({ btn: c.querySelector('.coaching-gate-preview').textContent, st: c.querySelector('.coaching-gate-status').className });
  }));
  await page.waitForTimeout(600);
  const prevStatus = await page.evaluate(() => document.querySelector('#coaching-gates .al-rule[data-dept="CSR"] .coaching-gate-status').textContent);
  record('coaching: "Email me the manager version" says Sending on its card, then that it reached the admin and no manager got it',
    (await calls(page, 'previewCoachingManagerEmail')) === 1 && prevBusy.btn === 'Sending…' && /is-busy/.test(prevBusy.st)
      && /No manager received it/.test(prevStatus), JSON.stringify({ prevBusy: prevBusy, prevStatus: prevStatus }));
  await page.click('#coaching-tbody [data-coaching-action="rotated"]');
  await page.waitForTimeout(300);
  const rotAsk = await page.evaluate(() => (document.querySelector('.ds-confirm') || {}).textContent || '');
  await page.click('.ds-confirm-ok');
  await page.waitForTimeout(600);
  const rot = await page.evaluate(() => window.__HARNESS__.calls.filter((c) => c.fn === 'updateCoachingFlagStatus').map((c) => c.args[0].action));
  record('coaching: Rotated confirms in its own words and closes as rotated',
    /queue assignment was changed/.test(rotAsk) && JSON.stringify(rot) === '["rotated"]', rotAsk.slice(0, 120) + ' ' + JSON.stringify(rot));

  const errsAdmin = page.__errors.slice();
  const unmockedA = await page.evaluate(() => window.__HARNESS__.unmocked.slice());
  await ctx.close();

  // ---- manager, layer OFF --------------------------------------------------
  const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pm = await boot(mctx, 'index-manager.html', false);
  await pm.click('#settings-btn');
  await pm.waitForTimeout(500);
  const off = await pm.evaluate(() => ({ hidden: document.getElementById('settings-notify').hidden,
    shown: document.getElementById('settings-notify').getClientRects().length > 0 }));
  record('manager, layer off: Settings shows no alert section and asks for nothing',
    off.hidden && !off.shown && (await calls(pm, 'getNotifyRules')) === 0, JSON.stringify(off));
  const errsMgrOff = pm.__errors.slice();
  await mctx.close();

  // ---- manager, layer ON ---------------------------------------------------
  const m2 = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const pn = await boot(m2, 'index-manager.html', true);
  await pn.click('#settings-btn');
  await pn.waitForTimeout(700);
  const on = await pn.evaluate(() => ({
    shown: document.getElementById('settings-notify').getClientRects().length > 0,
    text: (document.querySelector('#settings-notify-list .al-rule-sentence') || {}).textContent || '',
  }));
  record('manager, layer on: Settings renders their rule as a sentence',
    on.shown && /CSR’s answer rate on a workday falls below 85%/.test(on.text), JSON.stringify(on));
  await pn.fill('#settings-notify-list input', '80');
  await pn.click('.settings-notify-save');
  await pn.waitForTimeout(500);
  const refused = await pn.evaluate(() => {
    const st = document.getElementById('settings-notify-status');
    return { text: st.textContent, err: st.classList.contains('is-error') };
  });
  record('a looser value is refused with the server\'s reason',
    refused.err && /only make this rule stricter/.test(refused.text), JSON.stringify(refused));
  await pn.fill('#settings-notify-list input', '90');
  await pn.click('.settings-notify-save');
  await pn.waitForTimeout(500);
  const saved = await pn.evaluate(() => ({
    status: document.getElementById('settings-notify-status').textContent,
    text: (document.querySelector('#settings-notify-list .al-rule-sentence') || {}).textContent || '',
  }));
  record('a stricter value saves and the sentence names the applied 90%',
    /Saved/.test(saved.status) && /below 90%/.test(saved.text), JSON.stringify(saved));
  // Step 5b: the coaching row in the same section.
  const coachText = await pn.evaluate(() => {
    const p = Array.from(document.querySelectorAll('#settings-notify-list .al-rule-sentence')).filter((x) => /^Coaching:/.test(x.textContent))[0];
    return p ? p.textContent : '';
  });
  record('manager, layer on: the coaching gates render as a sentence too', /less than 50% as often as the team/.test(coachText), coachText);
  const coachRow = '#settings-notify-list .settings-notify-row[data-kind="coaching"]';
  await pn.fill(coachRow + ' input[data-field="coachBehindPts"]', '8');
  await pn.click(coachRow + ' .settings-notify-save');
  await pn.waitForTimeout(500);
  const cRef = await pn.evaluate(() => document.getElementById('settings-notify-status').textContent);
  record('a looser coaching gate is refused with the server\'s reason', /5 pts or lower/.test(cRef), cRef);
  await pn.fill(coachRow + ' input[data-field="coachBehindPts"]', '3');
  await pn.click(coachRow + ' .settings-notify-save');
  await pn.waitForTimeout(500);
  const cSaved = await pn.evaluate(() => {
    const p = Array.from(document.querySelectorAll('#settings-notify-list .al-rule-sentence')).filter((x) => /^Coaching:/.test(x.textContent))[0];
    return { status: document.getElementById('settings-notify-status').textContent, text: p ? p.textContent : '' };
  });
  record('a stricter coaching gate saves and the sentence names it', /Saved/.test(cSaved.status) && /at least 3 points behind/.test(cSaved.text),
    JSON.stringify(cSaved));
  const narrow = await pn.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }));
  record('360 px: no sideways scroll with the section open', narrow.sw <= narrow.vw + 1, JSON.stringify(narrow));
  const errsMgrOn = pn.__errors.slice();
  const unmockedM = await pn.evaluate(() => window.__HARNESS__.unmocked.slice());
  await m2.close();

  const errors = errsAdmin.concat(errsMgrOff, errsMgrOn);
  record('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  // The modal's keep-warm / cache-warm panels are unmocked on purpose (their
  // own error states render); only this page's verbs must all be mocked.
  const NOTIFY_RPCS = ['getAlertHistory', 'sendAlertTest', 'setNotifyManagerEdit', 'getNotifyRules', 'saveNotifyManagerRule',
    'saveCoachingDeptRule', 'saveCoachingDeptRules', 'previewCoachingManagerEmail', 'updateCoachingFlagStatus', 'getCoachingWorklist',
    'saveAlertReasonRule', 'previewAlerts'];
  const unmocked = unmockedA.concat(unmockedM).filter((n) => NOTIFY_RPCS.indexOf(n) !== -1);
  record('no Notifications RPC is unmocked', unmocked.length === 0, unmocked.join(', '));
  await browser.close();
  const failed = results.filter((x) => !x.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
