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
      called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary').length,
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

  // Batch F: prior-period chips -- the SAME INV-28 window the inbound E5 chips use.
  {
    const sum30 = require('./payloads/summary-30d.json');
    const pri = (require('./payloads/dept-outbound-windows.json'))[sum30.meta.priorFrom + '|' + sum30.meta.priorTo];
    const c = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]'));
      return {
        perRow: rows.map((r) => r.querySelectorAll('.wow-chip').length),
        notConnMuted: rows.every((r) => { const u = r.querySelector('.ob-u'); const ch = u && u.nextElementSibling; return !!ch && ch.classList.contains('wow-chip-muted'); }),
        first: rows[0] ? { agent: rows[0].getAttribute('data-agent'), conn: Number(rows[0].querySelector('.ob-c').textContent),
          chip: (rows[0].querySelector('.ob-c').nextElementSibling || {}).textContent || '' } : null,
        totals: document.querySelectorAll('#agents-ob-tfoot .wow-chip, #agents-ob-tbody tr.subq-subtotal .wow-chip').length,
      };
    });
    record('Batch F: the prior window is captured for this view', !!pri, sum30.meta.priorFrom + '|' + sum30.meta.priorTo);
    record('Batch F: every agent row carries three chips (connected, not connected, connect %)',
      c.perRow.length > 0 && c.perRow.every((n) => n === 3), c.perRow.join(','));
    record('Batch F: the not-connected chip is always neutral', c.notConnMuted);
    const pa = pri && c.first && pri.agents.filter((a) => a.agent === c.first.agent)[0];
    const want = pa ? c.first.conn - pa.obConnected : NaN;
    const got = c.first ? Number(c.first.chip.replace(/[^0-9+\u2212-]/g, '').replace('\u2212', '-')) : NaN;
    record('Batch F: the connected chip is current minus prior for that agent', pa && got === want,
      (c.first && c.first.chip) + ' want ' + want);
    record('Batch F: Total and subtotal rows carry no chips', c.totals === 0, 'chips=' + c.totals);
  }

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
  const bothChips = await page.evaluate(() => {
    const r = document.querySelector('#agents-ob-tbody tr[data-agent]');
    return r ? r.querySelectorAll('td.ob-dir-out .wow-chip').length : -1;
  });
  record('Batch F: Both rows carry the outbound chips too', bothChips === 3, 'chips=' + bothChips);

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
  // drive-smoke's UNMOCKED_OK: getInboundHeatmap is Neon-backed and must hide
  // silently on failure, so its "unmocked" report is part of the audit.
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('no unmocked server calls during the walk', !unmocked.length, unmocked.join(', '));
  // ---- Refresh never duplicates an in-flight outbound request -------------
  // An explicit Refresh refetches the view (OB_VIEW_.key = null), and render()
  // can run obViewSync_ again before the reply lands: the request for a window
  // still in flight must not be sent a second time. A fresh page, in the order
  // a user takes: land on Inbound, switch to Outbound, Refresh (twice).
  {
    const pr = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pr.on('pageerror', (e) => errors.push('refresh pageerror: ' + e.message));
    await skipTour(pr);
    await pr.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
    await pr.waitForTimeout(2500);
    await openDept(pr, meta);
    const beforeSwitch = await pr.evaluate(() => (window.__HARNESS__.calls || []).length);
    await pr.click('#dept-dir-switch [data-dir="out"]');
    await pr.waitForTimeout(2500);
    // FO-3: the table and the Insights Outbound fold share ONE client store,
    // so the switch asks for each window once between them, not once each.
    {
      const sent = await pr.evaluate((n) => (window.__HARNESS__.calls || []).slice(n)
        .filter((c) => c.fn === 'getDeptOutboundSummary')
        .map((c) => (c.args && c.args[0]) ? c.args[0].from + '|' + c.args[0].to : '?'), beforeSwitch);
      const per = {};
      sent.forEach((k) => { per[k] = (per[k] || 0) + 1; });
      const both = await pr.evaluate(() => ({
        table: document.querySelectorAll('#agents-ob-tbody tr[data-agent]').length,
        fold: document.querySelectorAll('#ins-ob-kpis .ds-kpi').length,
      }));
      record('switching to Outbound asks for each window ONCE between the table and the Insights fold, and both render',
        Object.keys(per).length === 2 && Object.keys(per).every((k) => per[k] === 1) && both.table > 0 && both.fold === 5,
        JSON.stringify({ per: per, both: both }));
    }
    for (let round = 1; round <= 2; round++) {
      const before = await pr.evaluate(() => (window.__HARNESS__.calls || []).length);
      await pr.click('#refresh-btn');
      await pr.waitForTimeout(3000);
      const sent = await pr.evaluate((n) => (window.__HARNESS__.calls || []).slice(n)
        .filter((c) => c.fn === 'getDeptOutboundSummary')
        .map((c) => (c.args && c.args[0]) ? c.args[0].from + '|' + c.args[0].to : '?'), before);
      const per = {};
      sent.forEach((k) => { per[k] = (per[k] || 0) + 1; });
      record('Refresh #' + round + ' sends each outbound window ONCE (current + prior), never a duplicate in flight',
        Object.keys(per).length === 2 && Object.keys(per).every((k) => per[k] === 1), JSON.stringify(per));
    }
    await pr.close();
  }

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
