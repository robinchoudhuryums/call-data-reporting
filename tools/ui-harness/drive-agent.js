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

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
