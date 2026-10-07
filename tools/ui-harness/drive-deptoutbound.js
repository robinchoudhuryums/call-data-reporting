'use strict';
/**
 * ASSERTING driver for the My Department INBOUND | OUTBOUND | BOTH switch
 * and the Team Outbound side panel (Batch D).
 *
 * The outbound view is a second table rendered over the same page state, so
 * the failures worth catching are the ones only a browser shows: the wrong
 * table visible, totals that do not match the payload, the inbound panel
 * painting back over the outbound view, the switch leaking to a manager or
 * surviving view-as-manager, and the inline agent panel (Batch B) not
 * opening from the new rows.
 *
 * Run: node drive-deptoutbound.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

async function skipTour(page) {
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });
}

async function openDept(page, meta) {
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2500);
}

(async () => {
  const meta = require('./payloads/meta.json');
  const ob = require('./payloads/dept-outbound-30d.json');
  const browser = await chromium.launch(launchOptions());
  const errors = [];

  // ---- manager: no switch, inbound only -----------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (e) => errors.push('manager pageerror: ' + e.message));
    await skipTour(page);
    await page.addInitScript(() => { localStorage.setItem('cdr.dept.direction', 'out'); });
    await page.goto('file://' + path.join(__dirname, 'site', 'index-manager.html'));
    await page.waitForTimeout(2500);
    await openDept(page, meta);
    const st = await page.evaluate(() => ({
      sw: getComputedStyle(document.getElementById('dept-dir-switch')).display,
      inShown: getComputedStyle(document.getElementById('agents-in-wrap')).display !== 'none',
      obShown: getComputedStyle(document.getElementById('agents-ob-wrap')).display !== 'none',
      called: (window.__HARNESS__.calls || []).filter((c) => (c.name || c) === 'getDeptOutboundSummary').length,
    }));
    record('manager: the direction switch is hidden', st.sw === 'none', st.sw);
    record('manager: a stored "outbound" preference still shows the INBOUND table',
      st.inShown && !st.obShown, JSON.stringify(st));
    await page.close();
  }

  // ---- admin ------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await skipTour(page);
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout(2500);
  await openDept(page, meta);

  const view = () => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    return {
      dir: document.body.getAttribute('data-dir'),
      inShown: vis('agents-in-wrap'), obShown: vis('agents-ob-wrap'),
      rings: vis('dept-team-rings'), tob: vis('dept-team-outbound'),
      rows: document.querySelectorAll('#agents-ob-tbody tr[data-agent]').length,
      heads: Array.from(document.querySelectorAll('#agents-ob-thead th')).map((t) => t.textContent.replace(/[▲▼▽]/g, '').trim()),
      total: (document.querySelector('#agents-ob-tfoot tr') || {}).textContent || '',
      note: (document.getElementById('agents-ob-note') || {}).textContent || '',
      tobRows: document.querySelectorAll('#tob-tbody tr.trp-row').length,
      tobTiles: (document.getElementById('tob-tiles') || {}).textContent || '',
    };
  });

  let v = await view();
  record('admin: Inbound is the default view', v.dir === 'in' && v.inShown && !v.obShown, JSON.stringify(v).slice(0, 120));

  // ---- Outbound ----------------------------------------------------------
  await page.click('#dept-dir-switch [data-dir="out"]');
  await page.waitForTimeout(900);
  v = await view();
  record('Outbound shows the outbound table and hides the inbound one', v.obShown && !v.inShown, JSON.stringify({ i: v.inShown, o: v.obShown }));
  record('Outbound lists every agent the payload carries', v.rows === ob.agents.length,
    'rows=' + v.rows + ' payload=' + ob.agents.length);
  record('the total row shows the payload’s placed / connected totals',
    v.total.indexOf('(' + ob.totals.obTotal + ')') !== -1 && v.total.indexOf(String(ob.totals.obConnected)) !== -1,
    v.total.slice(0, 80));
  record('the team per-day figure renders on the total row', v.total.indexOf(ob.totals.obPerDay + ' / day') !== -1,
    'want ' + ob.totals.obPerDay);
  record('the note says what Connected means and that exports stay inbound',
    /far end answered/.test(v.note) && /inbound table/.test(v.note), v.note.slice(0, 90));
  record('the off-roster dialler is disclosed, not shown', /1 dialler/.test(v.note)
    && !(await page.locator('#agents-ob-tbody tr[data-agent="Off Roster Dialler"]').count()));
  record('Team Outbound replaces Team Rings in the Outbound view', v.tob && !v.rings && v.tobRows === ob.agents.length,
    JSON.stringify({ tob: v.tob, rings: v.rings, rows: v.tobRows }));
  record('Team Outbound tiles show the payload totals', v.tobTiles.indexOf(String(ob.totals.obTotal)) !== -1, v.tobTiles.slice(0, 60));
  record('a parent view groups the rows with per-dept subtotals',
    (await page.locator('#agents-ob-tbody tr.subq-subtotal').count()) === (ob.deptGroups ? ob.deptGroups.length : 0));

  // Sorting by a column re-renders and keeps the rows.
  await page.click('#agents-ob-thead th[data-ob-sort="agent"]');
  await page.waitForTimeout(300);
  const firstAfterSort = await page.locator('#agents-ob-tbody tr[data-agent]').first().getAttribute('data-agent');
  const expectFirst = ob.agents.filter((a) => a.scopeDept === ob.meta.scopeDepts[0])
    .map((a) => a.agent).sort((x, y) => x.localeCompare(y))[0];
  record('sorting by Agent orders the rows A-Z within the group', firstAfterSort === expectFirst,
    firstAfterSort + ' vs ' + expectFirst);

  // The inline agent panel opens from an outbound row too.
  await page.locator('#agents-ob-tbody tr[data-agent]').first().click();
  await page.waitForTimeout(900);
  const panel = await page.evaluate(() => {
    const p = document.getElementById('ap-panel');
    return { open: !!p, inOb: !!p && !!p.closest('#agents-ob-tbody') };
  });
  record('an outbound row opens the inline agent panel beneath it', panel.open && panel.inOb, JSON.stringify(panel));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---- Both --------------------------------------------------------------
  await page.click('#dept-dir-switch [data-dir="both"]');
  await page.waitForTimeout(700);
  v = await view();
  record('Both shows inbound AND outbound columns side by side',
    v.heads.some((h) => /Inbound/.test(h)) && v.heads.some((h) => /Outbound/.test(h)) && v.obShown && !v.inShown,
    v.heads.join(' | '));
  record('Both keeps Team Rings AND shows Team Outbound', v.rings && v.tob);
  const overlap = await page.evaluate(() => {
    const a = document.getElementById('dept-team-rings').getBoundingClientRect();
    const b = document.getElementById('dept-team-outbound').getBoundingClientRect();
    return { aBottom: Math.round(a.bottom), bTop: Math.round(b.top) };
  });
  record('the two side panels never overlap', overlap.aBottom <= overlap.bTop + 1, JSON.stringify(overlap));
  const bothRow = await page.evaluate(() => {
    const r = document.querySelector('#agents-ob-tbody tr[data-agent]');
    return r ? r.querySelectorAll('td').length : 0;
  });
  record('each Both row carries both directions’ cells', bothRow === 6, 'cells=' + bothRow);

  // ---- back to Inbound, and the view-as guard -------------------------------
  await page.click('#dept-dir-switch [data-dir="in"]');
  await page.waitForTimeout(500);
  v = await view();
  record('Inbound restores the original table and Team Rings', v.inShown && !v.obShown && v.rings && !v.tob);

  await page.click('#dept-dir-switch [data-dir="out"]');
  await page.waitForTimeout(600);
  const stored = await page.evaluate(() => localStorage.getItem('cdr.dept.direction'));
  record('the choice persists per browser', stored === 'out', String(stored));

  // ---- narrow viewport --------------------------------------------------
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(500);
  const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  record('at 360 px the outbound view causes no horizontal page overflow', over.doc <= over.win + 1, JSON.stringify(over));

  // ---- hygiene ------------------------------------------------------------
  const unmocked = await page.evaluate(() => (window.__UNMOCKED__ || []).slice());
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
