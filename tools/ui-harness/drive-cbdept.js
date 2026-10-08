'use strict';
/**
 * ASSERTING driver for Batch G2: Callbacks by department on the Overview --
 * the Outbound report's company-view table, moved out of the modal (G3
 * retires it). ADMIN-ONLY FOREVER and LAZY.
 *
 * What only a browser shows: the section revealed for an admin only (never a
 * manager, never View-as), nothing fetched on the Overview landing, ONE
 * company-view fetch when it is opened (for its own window, which the shared
 * preset resolver sets), the modal's renderers painting the tiles and the
 * grouped table into it (a sub-queue under its parent whatever the sort, the
 * unmapped row last, the total row), its sort independent of the modal's,
 * keyboard expand, a window switch re-fetching once, CSV bytes, and no
 * sideways page scroll at 360 px.
 *
 * Run: node drive-cbdept.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

async function boot(page, file) {
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
    window.__CSV__ = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { blob.text().then(function (t) { window.__CSV__.push(t); }); } catch (e) {}
      return realCreate(blob);
    };
  });
  await page.goto('file://' + path.join(__dirname, 'site', file));
  await page.waitForTimeout(3000);
}

function reports(page) {
  return page.evaluate(() => (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getOutboundReport')
    .map((c) => (c.args && c.args[0]) || null));
}

function section() {
  const f = document.getElementById('ov-cbdept-fold');
  const rows = Array.from(document.querySelectorAll('#ov-cbdept-tbody tr.ob-cbdept-row'));
  return {
    shown: !!f && getComputedStyle(f).display !== 'none', open: !!f && f.open,
    head: ((document.getElementById('ov-cbdept-head') || {}).textContent || '').trim(),
    dates: ((document.getElementById('ov-cbdept-dates') || {}).textContent || '').trim(),
    tiles: document.querySelectorAll('#ov-cbdept-kpis .ds-kpi').length,
    ths: document.querySelectorAll('#ov-cbdept-table thead th[data-cbsort]').length,
    order: rows.map((r) => r.querySelector('.qcd-expand-toggle').textContent.replace(/[↳▶]/g, '').trim()),
    child: rows.map((r) => r.classList.contains('ob-cbdept-child')),
    total: Array.from(document.querySelectorAll('#ov-cbdept-tfoot tr td')).map((td) => td.textContent.trim()),
  };
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  const errors = [];

  // ---- admin ----------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await boot(page, 'index-admin.html');

  let s = await page.evaluate(section);
  record('admin: the section is on the Overview, closed, and says it loads on open',
    s.shown && !s.open && /open to load/.test(s.head), JSON.stringify({ shown: s.shown, open: s.open, head: s.head }));
  record('LAZY: the Overview landing fetched nothing for it', (await reports(page)).length === 0);

  await page.click('#ov-cbdept-fold > summary');
  await page.waitForTimeout(1800);
  let calls = await reports(page);
  s = await page.evaluate(section);
  const m = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(s.dates);
  const span = m ? Math.round((new Date(m[2]) - new Date(m[1])) / 86400000) : -1;
  record('opening it fetches the COMPANY view once, for the window it shows (Last 30 days)',
    calls.length === 1 && calls[0].department === '' && !!m && calls[0].from === m[1] && calls[0].to === m[2]
      && span >= 28 && span <= 31, JSON.stringify({ calls: calls, dates: s.dates, span: span }));
  record('the five company callback tiles render', s.tiles === 5, 'tiles=' + s.tiles);
  record('the header comes from the shared column list (8 sortable columns)', s.ths === 8, 'ths=' + s.ths);
  record('default order: worst own-rate first, the sub-queue directly under its parent, unmapped last',
    JSON.stringify(s.order) === JSON.stringify(['CSR', 'Spanish', 'Sales', 'Not mapped to a department'])
      && JSON.stringify(s.child) === JSON.stringify([false, true, false, false]), JSON.stringify(s.order));
  record('the total row counts each abandon once and reconciles with the tiles (20 trackable)',
    /^All departments/.test(s.total[0] || '') && s.total[1] === '20', JSON.stringify(s.total));
  record('the headline answers the question closed',
    /50% called back by the owning department/.test(s.head) && /20 trackable abandons/.test(s.head), s.head);

  // Sort by Median time: Sales (40:00) before CSR, Spanish stays under CSR.
  await page.click('#ov-cbdept-table th[data-cbsort="medianCallbackSec"]');
  await page.waitForTimeout(400);
  s = await page.evaluate(section);
  const aria = await page.evaluate(() => document.querySelector('#ov-cbdept-table th[data-cbsort="medianCallbackSec"]').getAttribute('aria-sort'));
  record('sorting keeps the sub-queue under its parent and the unmapped row last',
    JSON.stringify(s.order) === JSON.stringify(['Sales', 'CSR', 'Spanish', 'Not mapped to a department']) && aria === 'descending',
    JSON.stringify({ order: s.order, aria: aria }));

  // Keyboard expand.
  await page.focus('#ov-cbdept-tbody tr.ob-cbdept-row .qcd-expand-toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const ex = await page.evaluate(() => {
    const btn = document.querySelector('#ov-cbdept-tbody tr.ob-cbdept-row .qcd-expand-toggle');
    const detail = btn.closest('tr').nextElementSibling;
    return { expanded: btn.getAttribute('aria-expanded'),
      visible: !!detail && getComputedStyle(detail).display !== 'none',
      text: detail ? detail.textContent : '' };
  });
  record('Enter on a department expands its "First callback by" detail',
    ex.expanded === 'true' && ex.visible && /First callback by/.test(ex.text), JSON.stringify({ e: ex.expanded, v: ex.visible }));

  // CSV.
  await page.click('#ov-cbdept-csv-btn');
  await page.waitForTimeout(800);
  const csv = await page.evaluate(() => (window.__CSV__ || []).slice(-1)[0] || '');
  const lines = csv.split('\n');
  const hdr = lines.indexOf(lines.filter((l) => /^Department,Parent,Trackable abandons/.test(l))[0]);
  const cbLines = hdr >= 0 ? lines.slice(hdr + 1, hdr + 6) : [];
  const bad = lines.filter((l) => l.split(',').some((c) => /^[=+\-@]/.test(c.replace(/^"/, ''))));
  record('Download CSV carries the per-dept block in the ON-SCREEN order and the once-counted total',
    hdr > 0 && lines[1] === 'Scope,All departments' && /^Sales,/.test(cbLines[0] || '') && /^Spanish,CSR,/.test(cbLines[2] || '')
      && /^All departments \(each abandon once\),/.test(cbLines[4] || '') && bad.length === 0,
    JSON.stringify({ scope: lines[1], block: cbLines, bad: bad.slice(0, 2) }));

  // Window switch: one fetch for the new window; reopening the same window: none.
  await page.click('#ov-cbdept-window [data-preset="last7"]');
  await page.waitForTimeout(1500);
  calls = await reports(page);
  s = await page.evaluate(section);
  const m7 = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(s.dates);
  record('Last 7 days fetches once more, for the new window',
    calls.length === 2 && !!m7 && calls[1].from === m7[1] && calls[1].to === m7[2] && calls[1].department === '',
    JSON.stringify(calls[1] || null));
  await page.click('#ov-cbdept-fold > summary');
  await page.waitForTimeout(300);
  await page.click('#ov-cbdept-fold > summary');
  await page.waitForTimeout(800);
  record('closing and reopening the same window does not re-fetch', (await reports(page)).length === 2);

  // The MODAL's company view keeps its OWN sort (the views are independent).
  await page.evaluate(() => { const b = document.getElementById('outbound-report-btn'); if (b) b.click(); });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const sel = document.getElementById('outbound-dept'); if (sel) sel.value = '';
    const b = document.getElementById('outbound-generate-btn'); if (b) b.click();
  });
  await page.waitForTimeout(1500);
  const modal = await page.evaluate(() => ({
    ths: document.querySelectorAll('#outbound-cbdept-table thead th[data-cbsort]').length,
    order: Array.from(document.querySelectorAll('#outbound-cbdept-tbody tr.ob-cbdept-row .qcd-expand-toggle'))
      .map((b) => b.textContent.replace(/[↳▶]/g, '').trim()),
    aria: (document.querySelector('#outbound-cbdept-table th[data-cbsort="ownPct"]') || { getAttribute: () => null }).getAttribute('aria-sort'),
  }));
  record('the modal still renders its table (shared header) in ITS default order, untouched by the Overview sort',
    modal.ths === 8 && JSON.stringify(modal.order) === JSON.stringify(['CSR', 'Spanish', 'Sales', 'Not mapped to a department'])
      && modal.aria === 'ascending', JSON.stringify(modal));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // View-as hides it.
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option'))
    .map((o) => o.value).filter(Boolean));
  if (opts.length) {
    await page.click('#overview-btn');
    await page.waitForTimeout(1000);
    await page.selectOption('#view-as-select', opts[0]);
    await page.waitForTimeout(2500);
    const va = await page.evaluate(() => {
      const f = document.getElementById('ov-cbdept-fold');
      return { fold: !!f && getComputedStyle(f).display !== 'none', flag: document.body.getAttribute('data-view-as') };
    });
    record('View-as: the section is hidden', va.flag === 'manager' && !va.fold, JSON.stringify(va));
    await page.selectOption('#view-as-select', '');
    await page.waitForTimeout(2000);
  } else {
    record('View-as control is present', false, 'no #view-as-select options');
  }
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('admin: no unmocked server calls', !unmocked.length, unmocked.join(', '));
  await page.close();

  // ---- 360 px ---------------------------------------------------------------
  {
    const pn = await browser.newPage({ viewport: { width: 360, height: 800 } });
    pn.on('pageerror', (e) => errors.push('360 pageerror: ' + e.message));
    await boot(pn, 'index-admin.html');
    await pn.evaluate(() => { const f = document.getElementById('ov-cbdept-fold'); if (f) f.open = true; });
    await pn.waitForTimeout(1800);
    const n = await pn.evaluate(() => ({
      rows: document.querySelectorAll('#ov-cbdept-tbody tr.ob-cbdept-row').length,
      sw: document.documentElement.scrollWidth, vw: window.innerWidth,
    }));
    record('360 px: the open section renders without a sideways page scroll (the table scrolls inside)',
      n.rows === 4 && n.sw <= n.vw + 1, JSON.stringify(n));
    await pn.close();
  }

  // ---- manager: never ---------------------------------------------------------
  {
    const pm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pm.on('pageerror', (e) => errors.push('manager pageerror: ' + e.message));
    await boot(pm, 'index-manager.html');
    const mg = await pm.evaluate(() => {
      const f = document.getElementById('ov-cbdept-fold');
      if (f) f.open = true;   // even forced open, the code refuses a non-admin
      return { shown: !!f && getComputedStyle(f).display !== 'none' };
    });
    await pm.waitForTimeout(1200);
    const mc = await reports(pm);
    record('manager: the section is hidden and never fetches, even forced open', !mg.shown && mc.length === 0,
      JSON.stringify({ shown: mg.shown, calls: mc.length }));
    await pm.close();
  }

  const realErrors = errors.filter((e) => !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e));
  record('no page errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter((x) => !x.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' callbacks-by-department checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
