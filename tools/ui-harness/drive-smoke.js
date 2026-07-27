'use strict';
/**
 * CI-grade smoke driver (F7). Deterministic PASS/FAIL — no screenshots to eyeball,
 * no human judgement — so it can gate `npm run ci:ui`. The sibling drivers
 * (drive.js / drive-insights.js / drive-phase3.js) stay exploratory: they emit
 * shots + reports for a person to read.
 *
 * It asserts the failure classes the .gs unit harness structurally CANNOT see:
 *   1. Page/console errors while booting every page as admin AND manager.
 *   2. Unmocked RPCs beyond a known allowlist (a renamed/new endpoint the
 *      fixtures don't cover shows up here instead of as a silent empty panel).
 *   3. BLANK chart canvases — a canvas that is laid out and visible but whose
 *      pixels are entirely uniform. This is the R12-1 class (blank missed
 *      chart) and the reason this driver exists.
 *   4. Horizontal document overflow (a layout that pushes the page sideways).
 *
 * Run: node drive-smoke.js   (after gen-payloads/gen-phase3 + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

// RPCs the fixtures deliberately do not mock. getInboundHeatmap is Neon-backed
// and its panel MUST hide silently on failure -- that behavior is part of the
// audit, so an "unmocked" report for it is expected, not a regression.
const UNMOCKED_OK = new Set(['getInboundHeatmap', 'getInboundReport',
  'getDirectCallReport', 'getCallerLookup', 'logReportUsage']);

// Chart canvases that are legitimately absent/empty in the fixture (no data),
// keyed by canvas id. Everything else must render actual pixels when visible.
const BLANK_OK = new Set(['ir-spark-canvas']);

async function bootPage(browser, role) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-' + role + '.html'));
  await page.waitForTimeout(2500);
  return { page, errors };
}

/**
 * A canvas is BLANK when every sampled pixel is identical. Reads the bitmap in
 * page context; skips canvases that aren't visible or have no layout box (those
 * are legitimately un-rendered, e.g. a chart on a hidden tab).
 */
async function blankCanvases(page) {
  return page.evaluate((blankOkIds) => {
    const out = [];
    document.querySelectorAll('canvas').forEach((c) => {
      if (blankOkIds.includes(c.id)) return;
      if (!c.offsetParent) return;                       // hidden
      const r = c.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;         // not laid out / sparkline-sized
      let ctx;
      try { ctx = c.getContext('2d'); } catch (e) { return; }
      if (!ctx) return;
      let data;
      try { data = ctx.getImageData(0, 0, c.width, c.height).data; } catch (e) { return; }
      if (!data || !data.length) return;
      const first = [data[0], data[1], data[2], data[3]].join(',');
      let varied = false;
      // Sample every ~200th pixel: enough to catch "entirely uniform" cheaply.
      for (let i = 0; i < data.length; i += 800) {
        if ([data[i], data[i + 1], data[i + 2], data[i + 3]].join(',') !== first) { varied = true; break; }
      }
      if (!varied) out.push(c.id || c.className || '(anonymous canvas)');
    });
    return out;
  }, Array.from(BLANK_OK));
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;   // >0 means the page scrolls sideways
  });
}

(async () => {
  const browser = await chromium.launch(launchOptions());

  for (const role of ['admin', 'manager']) {
    const { page, errors } = await bootPage(browser, role);

    // Visit every page the role can reach; each is a fresh render pass.
    const navs = [['overview', '#overview-btn'], ['dept', '#my-dept-btn'],
                  ['insights', '#insights-report-btn'], ['escalations', '#escalations-btn']];
    for (const [name, sel] of navs) {
      const btn = page.locator(sel);
      if (!(await btn.count())) { record(role + ': ' + name + ' tab present', false, sel + ' missing'); continue; }
      await btn.click();
      await page.waitForTimeout(name === 'insights' ? 4000 : 2200);

      const blanks = await blankCanvases(page);
      record(role + '/' + name + ': no blank chart canvases', blanks.length === 0, blanks.join(', '));

      const overflow = await horizontalOverflow(page);
      record(role + '/' + name + ': no horizontal page overflow', overflow <= 0, 'scrollWidth-clientWidth=' + overflow);
    }

    // The all-departments QCD report (its fixture payload is new in F7).
    const qcdBtn = page.locator('#ov-qcd-alldept-btn');
    if (await qcdBtn.count()) {
      await page.click('#overview-btn');
      await page.waitForTimeout(1200);
      await qcdBtn.click();
      await page.waitForTimeout(2500);
      const rows = await page.locator('tr.qcd-expandable').count();
      record(role + ': all-dept QCD report renders expandable rows', rows > 0, 'rows=' + rows);
    }

    const unmocked = await page.evaluate(() => (window.__HARNESS__ || {}).unmocked || []);
    const unexpected = unmocked.filter((n) => !UNMOCKED_OK.has(n));
    record(role + ': no unexpected unmocked RPCs', unexpected.length === 0,
      Array.from(new Set(unexpected)).join(', '));

    const realErrors = errors.filter((e) => !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e));
    record(role + ': no page/console errors', realErrors.length === 0,
      Array.from(new Set(realErrors)).slice(0, 4).join(' | '));

    await page.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
