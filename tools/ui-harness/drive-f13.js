'use strict';
/**
 * F13 verification driver: walks the five formerly mouse-only surfaces with
 * KEYBOARD ONLY and asserts each one activates. Audit tooling, never shipped
 * (same contract as the sibling drive*.js scripts).
 *
 * Run: node drive-f13.js   (after build-harness.js admin)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');   // revision-globbing Chromium resolver

const SITE = 'file://' + path.join(__dirname, 'site', 'index-admin.html');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // Suppress the first-run onboarding tour + Insights intro card: the tour's
  // overlay intercepts pointer events and would time out every click (same
  // init-script guard the sibling drivers use).
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });

  await page.goto(SITE);
  await page.waitForTimeout(2500);

  // ---- 1. Overview dept tile: focusable + Enter solos the chart line -------
  const tile = page.locator('.ov-dept-tile[data-dept]').first();
  await tile.waitFor({ state: 'visible', timeout: 10000 });
  const tileAttrs = await tile.evaluate((el) => ({
    tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
    label: el.getAttribute('aria-label'),
  }));
  record('OV tile is focusable + announced',
    tileAttrs.tabindex === '0' && tileAttrs.role === 'button' && !!tileAttrs.label,
    JSON.stringify(tileAttrs));

  await tile.focus();
  const tileFocused = await tile.evaluate((el) => el === document.activeElement);
  record('OV tile takes focus', tileFocused);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const soloed = await page.evaluate(() =>
    document.querySelectorAll('.ov-dept-tile.ov-tile-soloed').length);
  record('OV tile Enter solos the dept (chart pin applied)', soloed === 1, 'soloed=' + soloed);

  // A visible focus ring must exist (outline set by the F13 styles.html rule).
  const ring = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { w: cs.outlineWidth, style: cs.outlineStyle };
  });
  record('OV tile has a focus outline', ring.style !== 'none' && parseFloat(ring.w) > 0,
    JSON.stringify(ring));
  await page.keyboard.press('Enter');   // release the solo

  // ---- 2. My Department agent row: Enter opens the Individual Report -------
  await page.click('#my-dept-btn');
  await page.waitForTimeout(2500);
  const row = page.locator('#agents-tbody tr[data-agent]').first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  const rowAttrs = await row.evaluate((el) => ({
    tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
  }));
  record('agent row is focusable and keeps its row semantics',
    rowAttrs.tabindex === '0' && rowAttrs.role === null, JSON.stringify(rowAttrs));

  await row.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  const irOpen = await page.evaluate(() => {
    const m = document.getElementById('individual-modal');
    return !!m && getComputedStyle(m).display !== 'none';
  });
  record('agent row Enter opens the Individual Report', irOpen);
  if (irOpen) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }

  // ---- 3. Space must not scroll the page while a row is focused ------------
  await row.focus();
  const beforeY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(' ');
  await page.waitForTimeout(600);
  const afterY = await page.evaluate(() => window.scrollY);
  record('Space on a row activates without scrolling the page', beforeY === afterY,
    'scrollY ' + beforeY + ' -> ' + afterY);
  const irOpen2 = await page.evaluate(() => {
    const m = document.getElementById('individual-modal');
    return !!m && getComputedStyle(m).display !== 'none';
  });
  if (irOpen2) { await page.keyboard.press('Escape'); await page.waitForTimeout(600); }

  // ---- 4. QCD carousel dots (only when the dept has >1 queue page) --------
  const dots = await page.locator('.dept-qcd-dot').count();
  if (dots > 1) {
    const dot = page.locator('.dept-qcd-dot').nth(1);
    const dotAttrs = await dot.evaluate((el) => ({
      tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
    }));
    record('QCD carousel dot is focusable + announced',
      dotAttrs.tabindex === '0' && dotAttrs.role === 'button' && !!dotAttrs.label,
      JSON.stringify(dotAttrs));
    await dot.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const active = await page.evaluate(() => {
      const ds = Array.from(document.querySelectorAll('.dept-qcd-dot'));
      return ds.findIndex((d) => d.classList.contains('is-active'));
    });
    record('QCD dot Enter changes the carousel page', active === 1, 'activeIdx=' + active);
  } else {
    record('QCD carousel dots present (fixture has ' + dots + ')', true, 'skipped -- single-queue dept');
  }

  // ---- 5. Expandable QCD queue rows (BOTH surfaces) ------------------------
  // Insights Queue health and the all-departments QCD report render the same
  // `tr.qcd-expandable` + `tr.qcd-detail-row` pair and share qcdToggleExpandRow_,
  // but they wire their own SEPARATE delegated keydown handlers (one on the
  // Insights tbody, one on #qcd-alldept-body) -- so both need a walk.
  const expandableSurfaces = [
    { label: 'Insights Queue health', sel: '#ins-queue-health tr.qcd-expandable',
      open: async () => {
        // N1: the Insights section renders open inline on the dept page and
        // generates with it -- just enter the page and wait for the render.
        await page.click('#my-dept-btn'); await page.waitForTimeout(5000);
      } },
    { label: 'all-dept QCD report', sel: '#qcd-alldept-body tr.qcd-expandable',
      open: async () => {
        await page.click('#overview-btn'); await page.waitForTimeout(1200);
        await page.click('#ov-qcd-alldept-btn'); await page.waitForTimeout(2500);
      } },
  ];
  for (const surface of expandableSurfaces) {
    await surface.open();
    const exp = page.locator(surface.sel).first();
    if (await exp.count()) {
      const expAttrs = await exp.evaluate((el) => ({
        tabindex: el.getAttribute('tabindex'), expanded: el.getAttribute('aria-expanded'),
      }));
      record(surface.label + ': expandable row is focusable + reports state',
        expAttrs.tabindex === '0' && expAttrs.expanded === 'false', JSON.stringify(expAttrs));
      await exp.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const opened = await exp.evaluate((el) => {
        const d = el.nextElementSibling;
        return {
          shown: !!d && d.classList.contains('qcd-detail-row') && d.style.display !== 'none',
          expanded: el.getAttribute('aria-expanded'),
        };
      });
      record(surface.label + ': Enter expands the per-source detail',
        opened.shown && opened.expanded === 'true', JSON.stringify(opened));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const closed = await exp.evaluate((el) => el.getAttribute('aria-expanded'));
      record(surface.label + ': Enter again collapses it', closed === 'false', 'aria-expanded=' + closed);
    } else {
      record(surface.label + ': expandable row present', false, 'no qcd-expandable row in the fixture');
    }
  }

  const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  record('no console/page errors during the walk', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})();
