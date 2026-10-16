'use strict';
/**
 * ASSERTING driver for CROSS-STATE changes on My Department -- E5 / ST4
 * (broad-scan 259): manager-release readiness for UX-2 (the Insights brief)
 * and 6c (the Outbound view) before their admin-only gates come off.
 *
 * Every other driver checks a surface in ONE state. The bugs Batches 5-6
 * fixed (F20 a stale Callbacks row, F21 view-as shading, F24 a saved
 * direction overwritten, F51 a refresh blanking rows) were all SEQUENCE
 * bugs: right in each state, wrong after moving between two. This driver
 * walks the sequences a manager will walk once the gates open:
 *   1. dept switch with the brief open -- the brief follows the new dept's
 *      payload (answer rate, tier, the G2 default-target label);
 *   2. dept switch with the outbound columns on (Step 3: the three-way
 *      switch became one toggle) -- it holds and no row of the previous dept
 *      survives;
 *   3. the brief's Callbacks row never quotes another dept's callbacks;
 *   4. view-as in and out -- the brief and the toggle hide, the table falls
 *      back to Inbound and comes back, the brief follows the dept shown;
 *   5. the brief's Callbacks row opens its section in place, with the outbound
 *      columns on OR off, and never changes them (F24 / Step 3).
 * The Insights mock routes by department (build-harness.js) and serves REAL
 * server payloads for CSR and Sales (gen-payloads.js), so a brief left on the
 * previous dept is visible.
 *
 * Run: node drive-crossstate.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}
const UNMOCKED_OK = new Set(['getInboundHeatmap', 'getInboundReport',
  'getDirectCallReport', 'getCallerLookup', 'logReportUsage']);

(async () => {
  const meta = require('./payloads/meta.json');
  const insCsr = require('./payloads/insights.json');
  const insSales = require('./payloads/insights-sales.json');
  const ob = require('./payloads/dept-outbound-30d.json');
  const rateOf = (p) => 'Answer rate ' + Number(p.teamStats.pct.val).toFixed(1) + '%';
  const RATE = { CSR: rateOf(insCsr), Sales: rateOf(insSales) };

  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
    localStorage.setItem('cdr.dept.direction', 'in');
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout(2500);
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(3500);

  const state = () => page.evaluate(() => {
    const disp = (el) => !!el && getComputedStyle(el).display !== 'none';
    const brief = document.getElementById('ins-brief');
    const top = brief && brief.querySelector('.ins-brief-top');
    const tier = top && top.querySelector('.ins-brief-top-tier');
    const cb = brief && brief.querySelector('.ins-brief-row[data-brief-key="callbacks"] .ins-brief-text');
    const sel = document.getElementById('dept-selector');
    return {
      dept: sel ? sel.value : '',
      viewAs: document.body.getAttribute('data-view-as'),
      dir: document.body.getAttribute('data-dir'),
      switchShown: disp(document.getElementById('dept-dir-switch')),
      inShown: disp(document.getElementById('agents-in-wrap')),
      obShown: disp(document.getElementById('agents-ob-wrap')),
      obAgents: Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]')).map((r) => r.getAttribute('data-agent')),
      briefShown: disp(brief),
      top: top ? top.textContent : '',
      tier: tier ? ((tier.className.match(/ins-brief--(red|amber|green|grey)/) || [])[1] || '') : '',
      defaultLabel: ((top && top.querySelector('.ins-brief-default')) || {}).textContent || '',
      cbText: cb ? cb.textContent : null,
      obCalls: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getOutboundReport').map((c) => (c.args && c.args[0] && c.args[0].department) || ''),
    };
  });
  const switchDept = async (d) => { await page.selectOption('#dept-selector', d); await page.waitForTimeout(3500); };
  // Step 3: the switch is one "Show outbound columns" toggle -- 'both' (on) or
  // 'in' (off). Click it only when the page is not already in the state asked.
  const setDir = async (d) => {
    const cur = await page.evaluate(() => document.body.getAttribute('data-dir'));
    if (cur !== d) { await page.click('#dept-dir-switch [data-ob-cols]'); await page.waitForTimeout(1200); }
  };

  // ---- 1. dept switch with the brief open -------------------------------
  let s = await state();
  record('setup: CSR loads with the brief on its own payload', s.dept === 'CSR' && s.briefShown && s.top.indexOf(RATE.CSR) !== -1,
    JSON.stringify({ dept: s.dept, top: s.top.slice(0, 70) }));
  record('CSR has its own answer target: no default-target label', s.defaultLabel === '', s.defaultLabel);
  await switchDept('Sales');
  s = await state();
  record('dept switch: the brief follows the new dept\'s payload (no previous-dept rate left)',
    s.dept === 'Sales' && s.top.indexOf(RATE.Sales) !== -1 && s.top.indexOf(RATE.CSR) === -1,
    JSON.stringify({ dept: s.dept, top: s.top.slice(0, 70), want: RATE.Sales }));
  record('dept switch: Sales has no target of its own, so the brief says it is judged on the default (G2)',
    /^Default \d+% target$/.test(s.defaultLabel), JSON.stringify(s.defaultLabel));
  record('dept switch: the top-line tier is the new dept\'s verdict (green at 80, not CSR\'s 92/2 amber)',
    s.tier === 'green', s.tier);

  // ---- 2. dept switch with the outbound columns on ----------------------
  await switchDept('CSR');
  await setDir('both');
  s = await state();
  record('outbound columns on CSR list the payload\'s agents', s.dir === 'both' && s.obShown && !s.inShown && s.obAgents.length === ob.agents.length,
    JSON.stringify({ dir: s.dir, rows: s.obAgents.length, want: ob.agents.length }));
  const csrAgents = s.obAgents.slice();
  const csrCb = s.cbText;
  await switchDept('Sales');
  s = await state();
  record('dept switch with outbound columns: the toggle holds and the tables never overlap',
    s.dir === 'both' && s.obShown && !s.inShown, JSON.stringify({ dir: s.dir, i: s.inShown, o: s.obShown }));
  record('dept switch with outbound columns: no row of the previous dept survives',
    !s.obAgents.some((a) => csrAgents.indexOf(a) !== -1), JSON.stringify(s.obAgents));

  // ---- 3. the brief's Callbacks row (F20) --------------------------------
  const salesCalls = s.obCalls.filter((d) => d === 'Sales').length;
  record('Callbacks row: it quotes callbacks only for the dept on screen',
    s.cbText !== null && (!/^Callbacks: /.test(s.cbText) || salesCalls > 0),
    JSON.stringify({ csr: csrCb, sales: s.cbText, salesFetches: salesCalls }));

  // ---- 4. view-as in and out --------------------------------------------
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option')).map((o) => o.value).filter(Boolean));
  const target = opts.indexOf('CSR') !== -1 ? 'CSR' : opts[0];
  await page.selectOption('#view-as-select', target);
  await page.waitForTimeout(3000);
  s = await state();
  record('view-as: the brief and the direction switch hide; the view falls back to Inbound',
    s.viewAs === 'manager' && !s.briefShown && !s.switchShown && s.dir === 'in' && s.inShown && !s.obShown,
    JSON.stringify({ viewAs: s.viewAs, brief: s.briefShown, sw: s.switchShown, dir: s.dir, i: s.inShown, o: s.obShown }));
  record('view-as: the page shows the previewed dept', s.dept === target, s.dept + ' vs ' + target);
  await page.selectOption('#view-as-select', '');
  await page.waitForTimeout(3500);
  s = await state();
  record('leaving view-as: the outbound columns come back and the toggle returns',
    !s.viewAs && s.switchShown && s.dir === 'both' && s.obShown && !s.inShown,
    JSON.stringify({ viewAs: s.viewAs, sw: s.switchShown, dir: s.dir, i: s.inShown, o: s.obShown }));
  record('leaving view-as: the brief has its Callbacks row back (it was rendered during the preview, without one)',
    s.cbText !== null, JSON.stringify(s.cbText));
  record('leaving view-as: the brief returns on the payload of the dept on screen',
    s.briefShown && !!RATE[s.dept] && s.top.indexOf(RATE[s.dept]) !== -1,
    JSON.stringify({ dept: s.dept, top: s.top.slice(0, 70) }));

  // ---- 5. the Callbacks row (F24 / Step 3) -------------------------------
  // The row opens the Callbacks section IN PLACE and never touches the outbound
  // columns: Outbound and Callbacks are their own rows, independent of them.
  const cbRow = page.locator('#ins-brief .ins-brief-row[data-brief-key="callbacks"]');
  const cbOpen = () => page.evaluate(() => {
    const f = document.getElementById('ins-cb-fold');
    const slot = document.getElementById('ins-brief-slot-callbacks');
    return { open: !!(f && f.open), inSlot: !!(slot && f && slot.contains(f)), shown: !!(slot && !slot.hidden),
             dir: document.body.getAttribute('data-dir') };
  });
  if (await cbRow.count()) {
    await setDir('both');
    await cbRow.click();
    await page.waitForTimeout(900);
    let o = await cbOpen();
    record('Callbacks row opens its section in place; the columns stay on', o.open && o.inSlot && o.shown && o.dir === 'both', JSON.stringify(o));
    await cbRow.click();
    await page.waitForTimeout(400);
    await setDir('in');
    await page.locator('#ins-brief .ins-brief-row[data-brief-key="callbacks"]').click();
    await page.waitForTimeout(900);
    o = await cbOpen();
    record('Callbacks row with the columns OFF: it opens, and the columns stay off', o.open && o.inSlot && o.shown && o.dir === 'in', JSON.stringify(o));
    const obRow = page.locator('#ins-brief .ins-brief-row[data-brief-key="outbound"]');
    record('Outbound row is there with the columns off', (await obRow.count()) === 1, 'rows=' + (await obRow.count()));
  } else {
    record('Callbacks row: the brief carries a Callbacks row for the admin', false, 'no row');
  }

  const unmocked = await page.evaluate(() => (window.__HARNESS__ || {}).unmocked || []);
  const unexpected = unmocked.filter((n) => !UNMOCKED_OK.has(n));
  record('no unexpected unmocked RPCs', unexpected.length === 0, Array.from(new Set(unexpected)).join(', '));
  record('no page/console errors across the sequences', errors.length === 0, Array.from(new Set(errors)).slice(0, 4).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
