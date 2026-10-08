'use strict';
/**
 * ASSERTING driver for the INLINE AGENT PANEL on My Department (Batch B).
 *
 * A click (or Enter / Space) on an agent row opens a panel in the row below:
 * a strip of the agent's days in the loaded window and the selected day's
 * Agent Day view. It replaced the row's direct drill to the Individual
 * Report, so this is the surface every manager now reaches first -- and it is
 * a DOM row living inside a table that re-renders on every sort, which is
 * exactly the shape that renders in review and breaks on a real click.
 *
 * Walk: open by click -> strip + day tiles + tabs render -> switch day ->
 * switch tab -> re-sort keeps it open under the same agent -> Individual
 * report button opens the modal -> Escape / Collapse close it and return
 * focus -> keyboard open -> a second agent replaces the first -> the panel
 * never widens the page at 360 px -> the CSV export never carries it.
 *
 * Run: node drive-agentpanel.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout(2500);
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  const meta = require('./payloads/meta.json');
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2500);

  const rows = page.locator('#agents-tbody tr[data-agent]');
  await rows.first().waitFor({ state: 'visible', timeout: 10000 });
  const first = await rows.nth(0).getAttribute('data-agent');
  const second = (await rows.count()) > 1 ? await rows.nth(1).getAttribute('data-agent') : null;

  const panelState = () => page.evaluate(() => {
    const p = document.getElementById('ap-panel');
    if (!p) return { open: false };
    const prev = p.previousElementSibling;
    return {
      open: true,
      under: prev ? prev.getAttribute('data-agent') : null,
      expanded: prev ? prev.getAttribute('aria-expanded') : null,
      title: (p.querySelector('.ap-title') || {}).textContent || '',
      days: p.querySelectorAll('.ap-day').length,
      onDays: p.querySelectorAll('.ap-day.is-on').length,
      onDate: (p.querySelector('.ap-day.is-on') || { getAttribute: () => null }).getAttribute('data-ap-date'),
      tiles: p.querySelectorAll('.ap-kpis .ds-kpi').length,
      tabs: Array.from(p.querySelectorAll('.ap-tab')).map((t) => t.getAttribute('data-ap-tab')),
      onTab: (p.querySelector('.ap-tab.is-on') || { getAttribute: () => null }).getAttribute('data-ap-tab'),
      callRows: p.querySelectorAll('.ap-calls tbody tr').length,
      note: (p.querySelector('.ap-note') || {}).textContent || '',
      loading: !!p.querySelector('.ap-loading'),
      panels: document.querySelectorAll('#ap-panel').length,
    };
  });

  // ---- 1. click opens it under the clicked row ----------------------------
  await rows.nth(0).click();
  await page.waitForTimeout(900);
  let st = await panelState();
  record('row click opens the panel under that row', st.open && st.under === first,
    JSON.stringify({ under: st.under, want: first }));
  record('the open row says it is expanded', st.expanded === 'true');
  record('the strip renders days, newest first, one selected',
    st.days > 1 && st.onDays === 1, 'days=' + st.days + ' on=' + st.onDays);
  // Each day box carries its inbound answer rate top-right, computed exactly
  // as the Answer % column does (answered / (answered + missed), whole %).
  const rates = await page.evaluate(() => Array.from(document.querySelectorAll('#ap-panel .ap-day')).map((b) => {
    const a = Number((b.querySelector('.ap-day-f b') || {}).textContent || 0);
    const m = Number((b.querySelector('.ap-day-f i') || {}).textContent || 0);
    const r = b.querySelector('.ap-day-top .ap-day-rate');
    const tinted = !!r && /\bbm-(target|watch|bad)\b/.test(r.className);
    return { want: (a + m) ? Math.round(a / (a + m) * 100) + '%' : null, got: r ? r.textContent : null, tinted };
  }));
  const badRate = rates.find((x) => x.want !== x.got || (x.want && !x.tinted));
  record('every day box shows its answer rate (Answer % formula, tinted)', rates.length > 0 && !badRate,
    badRate ? JSON.stringify(badRate) : rates.length + ' boxes');
  record('the strip says what it shows', /days? with activity/.test(st.note), st.note.slice(0, 90));
  record('the selected day renders its tile rows', st.tiles >= 10, 'tiles=' + st.tiles);
  record('the day opens on the Inbound tab with its calls', st.onTab === 'in' && st.callRows > 0,
    'tab=' + st.onTab + ' rows=' + st.callRows);

  // ---- 2. switch day and tab ---------------------------------------------
  const firstDate = st.onDate;
  await page.locator('#ap-panel .ap-day').nth(1).click();
  await page.waitForTimeout(700);
  st = await panelState();
  record('picking another day selects it and reloads the day view',
    st.onDays === 1 && st.onDate !== firstDate && st.tiles >= 10 && !st.loading,
    firstDate + ' -> ' + st.onDate);
  await page.locator('#ap-panel .ap-tab[data-ap-tab="out"]').click();
  await page.waitForTimeout(300);
  st = await panelState();
  record('the Outbound tab shows the outbound calls', st.onTab === 'out' && st.callRows > 0,
    'rows=' + st.callRows);
  const tabFocused = await page.evaluate(() =>
    !!document.activeElement && document.activeElement.getAttribute('data-ap-tab') === 'out');
  record('the tab keeps focus after it re-renders', tabFocused);

  // ---- 3. a re-render keeps it under the same agent ------------------------
  await page.click('#agents-table thead th[data-sort]');
  await page.waitForTimeout(500);
  st = await panelState();
  record('a re-sort keeps the panel open under the same agent',
    st.open && st.under === first && st.panels === 1, JSON.stringify({ under: st.under }));

  // ---- 4. the Individual Report is one button away -----------------------
  await page.click('#ap-panel [data-ap-ir]');
  await page.waitForTimeout(2000);
  const irOpen = await page.evaluate(() => {
    const m = document.getElementById('individual-modal');
    return !!m && getComputedStyle(m).display !== 'none';
  });
  record('"Individual report" opens the Individual Report', irOpen);
  if (irOpen) { await page.keyboard.press('Escape'); await page.waitForTimeout(700); }

  // ---- 5. Escape and Collapse close it and hand focus back ---------------
  await page.locator('#ap-panel .ap-day').first().focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  st = await panelState();
  let focusOn = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-agent'));
  record('Escape inside the panel closes it and focuses the row', !st.open && focusOn === first,
    'focus=' + focusOn);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  st = await panelState();
  record('Enter on the focused row opens it again', st.open && st.under === first);
  await page.click('#ap-panel [data-ap-close]');
  await page.waitForTimeout(300);
  st = await panelState();
  focusOn = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-agent'));
  record('Collapse closes it and focuses the row', !st.open && focusOn === first);
  const expandedLeft = await page.evaluate(() =>
    document.querySelectorAll('#agents-tbody tr[data-agent][aria-expanded]').length);
  record('no row is left marked expanded', expandedLeft === 0, 'n=' + expandedLeft);

  // ---- 6. one agent at a time ---------------------------------------------
  if (second) {
    await rows.nth(0).click();
    await page.waitForTimeout(700);
    await page.locator('#agents-tbody tr[data-agent="' + second.replace(/"/g, '\\"') + '"]').first().click();
    await page.waitForTimeout(800);
    st = await panelState();
    record('a second agent replaces the first (one panel)', st.panels === 1 && st.under === second,
      JSON.stringify({ under: st.under, panels: st.panels }));
  } else {
    record('a second agent replaces the first (one panel)', true, 'skipped -- one-agent fixture');
  }

  // ---- 7. the panel never leaks into the export ---------------------------
  await page.evaluate(() => {
    window.__CSV__ = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { blob.text().then(function (t) { window.__CSV__.push(t); }); } catch (e) {}
      return realCreate(blob);
    };
  });
  const menuBtn = page.locator('#csv-export-btn');
  if (await menuBtn.count()) { await menuBtn.click(); await page.waitForTimeout(300); }
  // The My Department export menu's item specifically (the Overview's
  // Callbacks by department section has its own, EARLIER, "Download CSV").
  await page.evaluate(() => {
    const hit = document.querySelector('#dept-export-menu [data-action="csv"]');
    if (hit) hit.click();
  });
  await page.waitForTimeout(700);
  const csv = await page.evaluate(() => (window.__CSV__ || [])[0] || null);
  const stillOpen = (await panelState()).open;
  record('the panel is still open while exporting', stillOpen);
  if (csv == null) {
    record('CSV export ignores the open panel', false, 'no CSV writer reachable');
  } else {
    record('CSV export ignores the open panel',
      !/Days with activity|Individual report|Inbound calls/.test(csv), csv.split('\n').length + ' lines');
  }

  // ---- 8. narrow viewport: the panel never widens the page ----------------
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(600);
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: window.innerWidth,
    panel: (document.querySelector('#ap-panel .ap') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
  }));
  record('at 360 px the open panel causes no horizontal page overflow',
    over.doc <= over.win + 1 && over.panel > 0 && over.panel <= over.win, JSON.stringify(over));

  // ---- hygiene ------------------------------------------------------------
  // drive-smoke's UNMOCKED_OK: getInboundHeatmap is Neon-backed and must hide
  // silently on failure, so its "unmocked" report is part of the audit.
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('no unmocked server calls during the walk', !unmocked.length, unmocked.join(', '));
  const realErrors = errors.filter((e) => !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e));
  record('no page/console errors during the walk', realErrors.length === 0,
    Array.from(new Set(realErrors)).slice(0, 3).join(' | '));

  await page.close();
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
