'use strict';
/**
 * Agent role Phase B: ASSERTING driver for the agent app (site/index-agent.html).
 * The agent client is a NEW page no other gate sees -- this is its rendered
 * check: boots with the real styles + real agentApp.js against a payload from
 * the real getAgentHome, then asserts the surfaces render, the rank line
 * stays HIDDEN (owner: built but not shown), no console/page errors, no
 * unmocked RPCs, and no beacon fired (the app reporting itself is a failure).
 *
 * Run: node build-agent.js && node drive-agent.js
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const SITE = 'file://' + path.join(__dirname, 'site', 'index-agent.html');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(SITE);
  await page.waitForTimeout(1200);

  // ---- boot ---------------------------------------------------------------
  record('boot: header carries the agent identity',
    (await page.locator('#agent-name').textContent()) === 'Maria Lopez'
    && (await page.locator('#agent-dept').textContent()) === 'CSR');

  const bodyVisible = await page.locator('#agent-body').isVisible();
  record('boot: payload rendered (loading pane replaced by the body)', bodyVisible);

  // ---- KPIs ---------------------------------------------------------------
  const kpiText = await page.locator('#agent-kpis').textContent();
  record('kpis: own answered/missed/rate/ATT render with team-average context',
    /142/.test(kpiText) && /94%|94\.0%/.test(kpiText) && /vs team avg/.test(kpiText),
    (kpiText || '').slice(0, 120));

  // ---- rank stays hidden (owner: build, hide) -----------------------------
  const rankVisible = await page.locator('#agent-rank').isVisible().catch(() => false);
  const excNote = await page.evaluate(() => { const el = document.getElementById('agent-exc-note'); return el && getComputedStyle(el).display !== 'none' ? el.textContent : ''; });
  record('#81: the exception-day note names the day and the reason', /Not counted: Wed Aug 5: 8x8 outage/.test(excNote), excNote);
  record('rank: computed by the server but NOT rendered (AGENT_RANK_SHOW_ off)', !rankVisible);

  // ---- team strip: aggregates only ---------------------------------------
  const teamText = await page.locator('#agent-team').textContent();
  record('team: aggregate strip renders with the no-teammates caption',
    /Team · CSR/.test(teamText) && /individual teammates/.test(teamText));
  const pageText = await page.locator('body').textContent();
  record('privacy: no teammate name reaches the page',
    pageText.indexOf('Devon Park') === -1 && pageText.indexOf('Sam Reed') === -1);

  // ---- trend + missed -----------------------------------------------------
  record('trend: SVG polyline drawn', (await page.locator('#agent-trend svg polyline').count()) >= 1);
  record('missed: timestamp chips render', (await page.locator('#agent-missed .agent-tchip').count()) >= 1);

  // ---- window presets -----------------------------------------------------
  await page.locator('.agent-chip[data-preset="7d"]').click();
  await page.waitForTimeout(600);
  record('presets: switching to Last 7 days re-renders without error',
    await page.locator('#agent-body').isVisible());

  // ---- Phase C: My History tab -------------------------------------------
  await page.locator('#agent-tab-history').click();
  await page.waitForTimeout(700);
  record('history: tab switch shows the history page and hides home',
    (await page.locator('#agent-hist-body').isVisible())
    && !(await page.locator('#agent-home-page').isVisible()));
  record('history: dual-line monthly SVG drawn',
    (await page.locator('#agent-hist-trend svg polyline').count()) >= 2,
    String(await page.locator('#agent-hist-trend svg polyline').count()) + ' polylines');
  const monthCards = await page.locator('#agent-hist-months .agent-m').count();
  record('history: month cards render', monthCards >= 6, monthCards + ' cards');
  record('history: a best-month card is highlighted',
    (await page.locator('#agent-hist-months .agent-m.best').count()) === 1);
  const histText = await page.locator('#agent-history-page').textContent();
  record('history: weighted-ATT disclosure present', /weighted by answered calls/.test(histText));
  await page.locator('#agent-tab-home').click();
  await page.waitForTimeout(300);
  record('history: tab switch back restores My Performance',
    await page.locator('#agent-home-page').isVisible());

  // ---- CL-13: the tabs keyboard pattern ----------------------------------
  // Arrow keys move selection AND focus (roving tabindex), both panels are
  // role=tabpanel, and the history panel was already loaded above so the
  // keyboard switch must not refetch it.
  await page.locator('#agent-tab-home').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const kb = await page.evaluate(() => ({
    focused: document.activeElement && document.activeElement.id,
    selected: document.getElementById('agent-tab-history').getAttribute('aria-selected'),
    histTab: document.getElementById('agent-tab-history').getAttribute('tabindex'),
    homeTab: document.getElementById('agent-tab-home').getAttribute('tabindex'),
    panels: [...document.querySelectorAll('[role="tabpanel"]')].map((p) => p.id).join(','),
    histVisible: document.getElementById('agent-history-page').style.display !== 'none',
  }));
  record('CL-13: ArrowRight selects and focuses My History (roving tabindex)',
    kb.focused === 'agent-tab-history' && kb.selected === 'true' && kb.histTab === '0' && kb.homeTab === '-1'
      && kb.histVisible, JSON.stringify(kb));
  record('CL-13: both pages are role=tabpanel', kb.panels === 'agent-home-page,agent-history-page', kb.panels);
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  record('CL-13: Home returns to My Performance',
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'agent-tab-home'
      && document.getElementById('agent-home-page').style.display !== 'none'));

  // ---- CL-8: the work window comes from the pinned constants ---------------
  const ww = await page.locator('#agent-ww').textContent();
  record('CL-8: the footer states the window from the constants, incl. the CSR family\'s 8:00 start',
    /8:30 AM – 5:00 PM CST/.test(ww) && /from 8:00 AM/.test(ww) && /A_Q_CSR/.test(ww), ww);

  // ---- Phase C: glossary --------------------------------------------------
  record('glossary: fold present with the wait-coverage explanation',
    /before call-capture coverage|call-capture system has/.test(await page.locator('#agent-gloss').textContent()));

  // ---- CL-9: phone width ----------------------------------------------------
  // The agent app is the surface most likely to be opened on a phone, and the
  // 1100 px run below never saw one. Resize the SAME page and re-enter both
  // tabs so each lays out at the narrow width; this runs BEFORE the
  // cleanliness checks so an error raised at phone width fails them too.
  // The html/body clip check keeps the overflow assertion from passing
  // vacuously (see drive-smoke.js, the same helper's rationale).
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(500);
  record('phone@360: overflow is measurable (html/body do not clip it)', await page.evaluate(() =>
    !/hidden|clip/.test(getComputedStyle(document.documentElement).overflowX)
    && !/hidden|clip/.test(getComputedStyle(document.body).overflowX)));
  const phoneOverflow = async () => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const [tab, pane] of [['#agent-tab-history', '#agent-history-page'], ['#agent-tab-home', '#agent-home-page']]) {
    await page.locator(tab).click();
    await page.waitForTimeout(500);
    const over = await phoneOverflow();
    record('phone@360: ' + pane + ' renders with no horizontal overflow',
      (await page.locator(pane).isVisible()) && over <= 1, 'scrollWidth-clientWidth=' + over);
  }
  // Back to the desktop size, so the layout check at the end still measures it.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(300);

  // ---- cleanliness --------------------------------------------------------
  const unmocked = await page.evaluate(() => window.__MOCK_UNMOCKED__ || []);
  record('rpc: no unmocked server calls', unmocked.length === 0, unmocked.join(','));
  const beacons = await page.evaluate(() => window.__MOCK_BEACONS__ || []);
  record('beacon: the app did not report itself broken', beacons.length === 0,
    beacons.map((b) => b && b.message).join(' | ').slice(0, 200));
  record('console: no page or console errors', errors.length === 0, errors.join(' | ').slice(0, 300));

  // ---- horizontal overflow (the drive-smoke discipline) -------------------
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record('layout: no horizontal page overflow', !overflow);

  // ---- Batch 9: the failure paths, on a SECOND page --------------------------
  // They make the app report itself (a load failure beacons by design), so they
  // run where the main page's "did not report itself broken" check can't see.
  const p2 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(String(e)));
  await p2.addInitScript(() => {
    window.__MOCK_FAIL_HIST__ = 1;
    window.__MOCK_HOME_META__ = { waitsTruncated: true, waitsCoverFrom: '2026-08-06' };
  });
  await p2.goto(SITE);
  await p2.waitForTimeout(1200);
  const cut = await p2.locator('#agent-missed .agent-waits-cut').textContent().catch(() => '');
  record('SEC-4: a capped wait lookup says where wait times stop', /Wait times cover your most recent calls \(from Thu 8\/6 on\)/.test(cut || ''), cut);

  // CL-6: a rejected range keeps the numbers AND puts the controls back on them.
  const before = await p2.locator('#agent-dates').textContent();
  await p2.evaluate(() => { window.__MOCK_FAIL_HOME__ = 'That range is longer than the allowed 366 days.'; });
  await p2.locator('.agent-chip[data-preset="7d"]').click();
  await p2.waitForTimeout(600);
  const cl6 = await p2.evaluate(() => ({
    body: document.getElementById('agent-body').style.display !== 'none',
    kpis: document.getElementById('agent-kpis').textContent,
    err: document.getElementById('agent-error').style.display !== 'none' ? document.getElementById('agent-error').textContent : '',
    dates: document.getElementById('agent-dates').textContent,
    on: (document.querySelector('.agent-chip.on[data-preset]') || {}).getAttribute ? document.querySelector('.agent-chip.on[data-preset]').getAttribute('data-preset') : null,
  }));
  record('CL-6: a rejected range keeps the numbers on screen', cl6.body && /142/.test(cl6.kpis), JSON.stringify({ body: cl6.body }));
  record('CL-6: the controls go back to the window being shown, and the refusal is said',
    cl6.dates === before && cl6.on === 'mtd' && /Couldn’t load/.test(cl6.err) && /366 days/.test(cl6.err)
      && cl6.err.indexOf('Still showing ' + before) !== -1, JSON.stringify(cl6));
  await p2.evaluate(() => { window.__MOCK_FAIL_HOME__ = null; });

  // CL-6: a custom range ends at the latest data date.
  await p2.locator('.agent-chip[data-preset="custom"]').click();
  await p2.fill('#agent-from', '2026-08-10');
  await p2.fill('#agent-to', '2026-08-20');
  await p2.locator('#agent-apply').click();
  await p2.waitForTimeout(500);
  const clamp = await p2.evaluate(() => ({ to: document.getElementById('agent-to').value,
    max: document.getElementById('agent-to').getAttribute('max'), dates: document.getElementById('agent-dates').textContent }));
  record('CL-6: a custom range past the latest date ends there', clamp.to === '2026-08-13' && clamp.max === '2026-08-13'
    && clamp.dates === '2026-08-10 – 2026-08-13', JSON.stringify(clamp));

  // CL-6: a failed history load offers Retry, and Retry loads it.
  await p2.locator('#agent-tab-history').click();
  await p2.waitForTimeout(500);
  const retryShown = await p2.locator('#agent-hist-retry').isVisible().catch(() => false);
  record('CL-6: a failed history load shows a Retry button', retryShown);
  if (retryShown) {
    await p2.locator('#agent-hist-retry').click();
    await p2.waitForTimeout(600);
  }
  record('CL-6: Retry loads the history', await p2.locator('#agent-hist-body').isVisible());

  // UI-2: both error regions are alerts, both loading lines are polite status.
  const live = await p2.evaluate(() => ['agent-error', 'agent-hist-error', 'agent-loading', 'agent-hist-loading']
    .map((id) => document.getElementById(id).getAttribute('role')).join(','));
  record('UI-2: errors announce as alerts, loading as status', live === 'alert,alert,status,status', live);
  record('second page: no page errors on the failure paths', errors2.length === 0, errors2.join(' | ').slice(0, 300));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
