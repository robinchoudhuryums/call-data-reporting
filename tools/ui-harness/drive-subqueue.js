'use strict';
/**
 * ASSERTING driver for the sub-queue scope switcher + the combined-view CSV.
 *
 * Why this exists: four sub-queue phases added a switcher, grouped rows,
 * per-dept subtotals, picker groups, a CSV rewrite and a scope note -- all of it
 * in script.html, which the zero-dep .gs harness structurally cannot load. Until
 * this driver, none of it had assertion-level coverage and a regression would
 * have been found by a manager, not CI.
 *
 * It also carries the FIRST automated coverage of any CSV writer in this repo.
 * The exporter builds a Blob and clicks an anchor, so the download is captured
 * by stubbing URL.createObjectURL and reading the Blob's text -- which asserts
 * the real bytes a manager would open, not a re-implementation of the builder.
 *
 * The fixture roster nests Spanish under CSR (the OVERVIEW_PARENT_OF constant),
 * so the default CSR payload IS the combined view; `summary-30d-own` /
 * `-subs` cover the other two scopes so the switcher round-trip is real.
 *
 * Run: node drive-subqueue.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

// The 30-day preset is the window with all three scopes captured.
async function openDeptThirtyDays(page) {
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  const meta = require('./payloads/meta.json');
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2200);
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
    localStorage.removeItem('cdr.dept.subscope');   // start from the server default
    // Capture CSV downloads: the exporter Blob-and-clicks, so intercepting
    // createObjectURL gives us the exact bytes a manager would open.
    window.__CSV__ = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { blob.text().then(function (t) { window.__CSV__.push(t); }); } catch (e) {}
      return realCreate(blob);
    };
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout
    ? await page.waitForTimeout(2500) : null;

  await openDeptThirtyDays(page);

  // ---- the scope bar ------------------------------------------------------
  const bar = await page.evaluate(() => {
    const el = document.getElementById('dept-subq-bar');
    if (!el) return null;
    return {
      visible: el.offsetParent !== null,
      buttons: Array.from(el.querySelectorAll('.subq-seg-btn')).map((b) => ({
        label: b.textContent.trim(), scope: b.getAttribute('data-subscope'),
        active: b.classList.contains('is-active'),
      })),
      note: (el.querySelector('.subq-note') || {}).textContent || '',
    };
  });
  record('scope bar renders for a parent dept', !!(bar && bar.visible),
    bar ? JSON.stringify(bar.buttons.map((b) => b.scope)) : 'missing');
  record('scope bar offers own/subs/all',
    !!bar && bar.buttons.length === 3
      && bar.buttons.map((b) => b.scope).join(',') === 'own,subs,all');
  record('combined is the DEFAULT for a parent (owner decision)',
    !!bar && (bar.buttons.find((b) => b.active) || {}).scope === 'all',
    bar ? 'active=' + (bar.buttons.find((b) => b.active) || {}).scope : '');
  record('the note names the sub-queue', !!bar && /Spanish/.test(bar.note),
    bar ? bar.note.slice(0, 90) : '');

  // ---- grouped rows + per-dept subtotals ----------------------------------
  const grouped = await page.evaluate(() => {
    const tb = document.getElementById('agents-tbody');
    if (!tb) return null;
    const heads = Array.from(tb.querySelectorAll('tr.subq-group-head'))
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const subs = Array.from(tb.querySelectorAll('tr.subq-subtotal'))
      .map((r) => Array.from(r.cells).map((c) => c.textContent.trim()));
    return { heads: heads, subs: subs, dataRows: tb.querySelectorAll('tr[data-agent]').length };
  });
  record('combined table groups by department', !!grouped && grouped.heads.length === 2,
    grouped ? grouped.heads.join(' | ') : 'missing');
  record('the child group is tagged as a sub-queue',
    !!grouped && grouped.heads.some((h) => /Spanish/.test(h) && /sub-queue/i.test(h)));
  record('each department gets its OWN subtotal row',
    !!grouped && grouped.subs.length === 2,
    grouped ? grouped.subs.map((c) => c[0]).join(' | ') : '');
  record('all agents from both departments render',
    !!grouped && grouped.dataRows === 7, grouped ? 'rows=' + grouped.dataRows : '');

  // ---- the parity property: parent subtotal == its own-scope total --------
  const parentSubtotal = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('#agents-tbody tr.subq-subtotal'))
      .find((row) => /^CSR subtotal/.test(row.cells[0].textContent.trim()));
    return r ? Array.from(r.cells).map((c) => c.textContent.trim()) : null;
  });
  await page.evaluate(() => {
    const b = document.querySelector('.subq-seg-btn[data-subscope="own"]');
    if (b) b.click();
  });
  await page.waitForTimeout(2200);
  const ownTotals = await page.evaluate(() => {
    const r = document.querySelector('#agents-tfoot tr');
    return r ? Array.from(r.cells).map((c) => c.textContent.trim()) : null;
  });
  // Compare the NUMERIC cells only: cell 0 is a label ("CSR subtotal" vs
  // "Total"), and the Source column carries no aggregate.
  const parity = (function () {
    if (!parentSubtotal || !ownTotals || parentSubtotal.length !== ownTotals.length) return false;
    for (let i = 1; i < parentSubtotal.length; i++) {
      if (parentSubtotal[i] !== ownTotals[i]) return false;
    }
    return true;
  })();
  record('parent subtotal in COMBINED equals its own-scope total (S35 addendum)',
    parity, parity ? '' : 'sub=' + JSON.stringify(parentSubtotal) + ' own=' + JSON.stringify(ownTotals));

  // ---- the switch actually re-fetched a different scope --------------------
  const ownBar = await page.evaluate(() => {
    const el = document.getElementById('dept-subq-bar');
    const act = el && el.querySelector('.subq-seg-btn.is-active');
    return { scope: act ? act.getAttribute('data-subscope') : null,
             note: (el && el.querySelector('.subq-note') || {}).textContent || '',
             heads: document.querySelectorAll('#agents-tbody tr.subq-group-head').length };
  });
  record('switching to own-scope drops the grouping',
    ownBar.scope === 'own' && ownBar.heads === 0,
    'scope=' + ownBar.scope + ' heads=' + ownBar.heads);
  record('own-scope note still discloses the excluded sub-queue',
    /Spanish/.test(ownBar.note) && /not included/i.test(ownBar.note),
    ownBar.note.slice(0, 100));

  // ---- CSV: single-dept export has NO Department column -------------------
  async function exportCsv() {
    await page.evaluate(() => { window.__CSV__.length = 0; });
    const menuBtn = page.locator('#csv-export-btn');
    if (await menuBtn.count()) { await menuBtn.click(); await page.waitForTimeout(300); }
    // The Download CSV item lives in the Export dropdown (R9-2).
    const item = page.locator('#csv-export-btn, [id*="csv"]').first();
    await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button, a, .menu-item, .header-menu-item'));
      const hit = cands.find((e) => /download csv/i.test((e.textContent || '').trim()));
      if (hit) hit.click();
    });
    await page.waitForTimeout(600);
    return page.evaluate(() => (window.__CSV__ || [])[0] || '');
  }
  const csvOwn = await exportCsv();
  record('CSV export produces a file at all', csvOwn.length > 0, 'bytes=' + csvOwn.length);
  const ownHeader = (csvOwn.split('\n')[0] || '');
  record('single-dept CSV has NO Department column (byte-compatible)',
    csvOwn.length > 0 && !/^Department,/.test(ownHeader), ownHeader.slice(0, 60));

  // ---- CSV: combined export HAS the column, subtotals and grand total -----
  await page.evaluate(() => {
    const b = document.querySelector('.subq-seg-btn[data-subscope="all"]');
    if (b) b.click();
  });
  await page.waitForTimeout(2200);
  const csvAll = await exportCsv();
  const allLines = csvAll.split('\n');
  record('combined CSV leads with a Department column',
    /^Department,/.test(allLines[0] || ''), (allLines[0] || '').slice(0, 60));
  record('combined CSV carries a per-dept subtotal row',
    allLines.some((l) => /CSR subtotal/.test(l)) && allLines.some((l) => /Spanish subtotal/.test(l)));
  record('combined CSV ends with a labelled grand total',
    allLines.some((l) => /All shown/.test(l)));
  record('combined CSV has NO group-header banner rows (deliberate)',
    !allLines.some((l) => /^(CSR|Spanish),?$/.test(l.trim())));

  // ---- the missed section's scope note ------------------------------------
  const missedNote = await page.evaluate(() => {
    const el = document.getElementById('dept-missed-scope-note');
    return el ? { visible: el.offsetParent !== null,
                  text: (el.textContent || '').replace(/\s+/g, ' ').trim() } : null;
  });
  record('missed section discloses its scope in the combined view',
    !!missedNote && missedNote.visible && /not added twice/i.test(missedNote.text),
    missedNote ? missedNote.text.slice(0, 110) : 'missing');

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
