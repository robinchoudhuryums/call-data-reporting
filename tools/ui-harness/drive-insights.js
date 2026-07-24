'use strict';
/** Phase 2: Insights page audit drive. */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');
const SITE = path.join(__dirname, 'site');
const SHOTS = path.join(__dirname, 'shots');
const rep = { errors: [], overflow: [], unmocked: {}, notes: {} };

const srvP = new Promise((res) => {
  const s = http.createServer((rq, rs) => {
    const p = path.join(SITE, rq.url.replace(/^\//, '').split('?')[0] || 'index-admin.html');
    try { const b = fs.readFileSync(p); rs.writeHead(200, { 'content-type': 'text/html' }); rs.end(b); }
    catch (e) { rs.writeHead(404); rs.end('nf'); }
  }).listen(0, '127.0.0.1', () => res(s));
});

async function overflowPx(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

(async () => {
  const srv = await srvP;
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });

  async function open(variant, { dark, width } = {}) {
    const ctx = await browser.newContext({ viewport: { width: width || 1440, height: 950 }, deviceScaleFactor: width === 390 ? 2 : 1.5 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') rep.errors.push(m.text().slice(0, 250)); });
    page.on('pageerror', (e) => rep.errors.push('PAGEERROR: ' + String(e).slice(0, 250)));
    await page.addInitScript(([d]) => {
      localStorage.setItem('cdr.tour.done', '1');
      localStorage.setItem('cdr.ins.intro.v1', '1');   // (page keys off its own seen-flag)
      if (d) localStorage.setItem('dash-mode', 'dark');
    }, [!!dark]);
    await page.goto(base + 'index-' + variant + '.html', { waitUntil: 'load' });
    await page.waitForTimeout(1800);
    await page.click('#insights-report-btn');
    await page.waitForTimeout(3500);   // auto-run + render + deferred charts
    return { ctx, page };
  }

  // ---- admin light: full walkthrough ----
  {
    const { ctx, page } = await open('admin', {});
    await page.screenshot({ path: path.join(SHOTS, 'ins-admin-1440.png'), fullPage: true });
    rep.notes.adminLight = await page.evaluate(() => ({
      results: !!document.querySelector('#insights-results')?.offsetParent,
      headline: document.querySelector('#ins-headline')?.textContent.trim().slice(0, 140) || null,
      kpiTiles: document.querySelectorAll('#insights-results .ds-kpi').length,
      agentCards: document.querySelectorAll('.ins-agent-card, .ds-card--rail').length,
      densityClass: document.getElementById('insights-results')?.className,
      periodBar: !!document.getElementById('ins-period-bar')?.offsetParent,
      heatmap: !!document.getElementById('ins-heatmap')?.offsetParent,
      queueHealth: !!document.querySelector('#insights-results [id*=qh], .ins-qh-table, .ds-table')?.offsetParent,
      trendChart: !!(window.Chart && Chart.getChart(document.getElementById('ins-trend-chart'))),
      calls: window.__HARNESS__.calls.map((c) => c.fn),
    }));
    rep.overflow.push({ label: 'ins-admin-1440', px: await overflowPx(page) });

    // Density toggle: Simple
    const seg = await page.$('#ins-density-toggle button[data-density="simple"], .ins-density-seg button');
    if (seg) { await seg.click(); await page.waitForTimeout(1200); }
    await page.screenshot({ path: path.join(SHOTS, 'ins-admin-1440-simple.png'), fullPage: true });
    rep.notes.simple = await page.evaluate(() => ({
      cls: document.getElementById('insights-results')?.className,
      trendHidden: !document.getElementById('ins-trend-wrap')?.offsetParent,
      cardsChart: !!document.getElementById('ins-cards-chart')?.offsetParent,
      cardsChartInstantiated: !!(window.Chart && Chart.getChart(document.getElementById('ins-cards-chart'))),
    }));
    // back to Detailed
    const seg2 = await page.$('#ins-density-toggle button[data-density="detailed"]');
    if (seg2) { await seg2.click(); await page.waitForTimeout(1200); }

    // Edit popover
    const edit = await page.$('#ins-edit-btn, [id*=ins-edit]');
    if (edit) { await edit.click(); await page.waitForTimeout(600); }
    await page.screenshot({ path: path.join(SHOTS, 'ins-admin-popover.png'), fullPage: false });
    rep.notes.popover = await page.evaluate(() => ({
      open: !!document.getElementById('ins-edit-popover')?.offsetParent,
      advanced: !!document.getElementById('ins-edit-advanced'),
    }));
    // close popover (Escape)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Trend metric dropdown + calendar toggle
    const metricSel = await page.$('#ins-trend-metric');
    if (metricSel) {
      rep.notes.metricOptions = await page.evaluate(() => [...document.querySelectorAll('#ins-trend-metric option')].map((o) => o.value + (o.disabled ? '(dis)' : '')));
    }
    const calBtn = await page.$('#ins-trend-render-toggle button[data-render="calendar"], .ins-trend-render-seg button:last-child');
    if (calBtn) {
      const dis = await calBtn.evaluate((b) => b.disabled);
      rep.notes.calendarBtnDisabled = dis;
      if (!dis) {
        await calBtn.click(); await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(SHOTS, 'ins-admin-calendar.png'), fullPage: false });
      }
    }
    // focus walk within results header
    const fw = [];
    await page.evaluate(() => document.getElementById('insights-page').scrollIntoView());
    await ctx.close();
  }

  // ---- admin dark ----
  {
    const { ctx, page } = await open('admin', { dark: true });
    await page.screenshot({ path: path.join(SHOTS, 'ins-admin-1440-dark.png'), fullPage: true });
    await ctx.close();
  }

  // ---- manager light (gating) ----
  {
    const { ctx, page } = await open('manager', {});
    await page.screenshot({ path: path.join(SHOTS, 'ins-manager-1440.png'), fullPage: true });
    rep.notes.manager = await page.evaluate(() => ({
      heatmapVisible: !!document.getElementById('ins-heatmap')?.offsetParent,
      abPanelVisible: !!document.getElementById('ins-ab-panel')?.offsetParent,
      adminMetricOption: [...document.querySelectorAll('#ins-trend-metric option')].some((o) => o.dataset && o.dataset.adminMetric !== undefined),
      attOption: [...document.querySelectorAll('#ins-trend-metric option')].map((o) => o.value).join(','),
      densityDefault: (function () { try { return JSON.parse(localStorage.getItem('cdr.ins.prefs.v2:manager@ums.com') || '{}').density || '(role default)'; } catch (e) { return '?'; } })(),
      simpleApplied: /ds-density-simple/.test(document.getElementById('insights-results')?.className || ''),
    }));
    rep.overflow.push({ label: 'ins-manager-1440', px: await overflowPx(page) });
    await ctx.close();
  }

  // ---- 390 mobile ----
  {
    const { ctx, page } = await open('admin', { width: 390 });
    await page.screenshot({ path: path.join(SHOTS, 'ins-admin-390.png'), fullPage: true });
    rep.overflow.push({ label: 'ins-admin-390', px: await overflowPx(page) });
    await ctx.close();
  }

  // unmocked tally
  {
    const { ctx, page } = await open('admin', {});
    rep.unmocked = await page.evaluate(() => {
      const t = {}; (window.__HARNESS__.unmocked || []).forEach((n) => { t[n] = (t[n] || 0) + 1; });
      return t;
    });
    await ctx.close();
  }

  await browser.close(); srv.close();
  fs.writeFileSync(path.join(__dirname, 'report-insights.json'), JSON.stringify(rep, null, 2));
  console.log(JSON.stringify(rep, null, 1).slice(0, 3500));
})();
