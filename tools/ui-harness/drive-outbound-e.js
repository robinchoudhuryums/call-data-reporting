'use strict';
/**
 * ASSERTING driver for Batch E: the Overview dept tiles' OUTBOUND line (E2)
 * and the Outbound fold in the Insights region (E1). Both are admin-only
 * while the Outbound report is (6c).
 *
 * What only a browser shows: the line actually rendering on the tiles with the
 * payload's figures for the selected card window, the "since" disclosure on a
 * window that predates capture, the Insights fold filling from TWO windows
 * (current + prior) with its deltas, and -- the 6c half -- neither surface
 * reaching a manager or surviving View-as.
 *
 * Run: node drive-outbound-e.js   (after gen-payloads + build-harness)
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
  await page.waitForTimeout(3500);
}

function tileLines() {
  return Array.from(document.querySelectorAll('.ov-dept-tile')).map((t) => {
    const ob = t.querySelector('.ov-dept-ob');
    return { dept: t.getAttribute('data-dept'), text: ob ? ob.textContent.replace(/\s+/g, ' ').trim() : null,
      shown: !!ob && getComputedStyle(ob).display !== 'none' };
  });
}

(async () => {
  const meta = require('./payloads/meta.json');
  const ov = require('./payloads/ov-admin.json');
  const win = require('./payloads/dept-outbound-windows.json');
  const browser = await chromium.launch(launchOptions());
  const errors = [];
  const fmt = (n) => Number(n).toLocaleString('en-US');

  // ---- admin: Overview tiles (default window = yesterday) -----------------
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await skipTour(page);
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout(3000);

  const lines = await page.evaluate(tileLines);
  const withOb = ov.depts.filter((d) => d.outbound && !d.parent).map((d) => d.name);
  const rendered = lines.filter((l) => l.shown).map((l) => l.dept);
  record('admin: every top-level tile the payload gives outbound renders the line',
    withOb.length > 0 && withOb.every((d) => rendered.indexOf(d) !== -1), 'payload=' + withOb.join(',') + ' rendered=' + rendered.join(','));
  const first = ov.depts.filter((d) => d.outbound && !d.parent && d.outbound.yesterday.placed > 0)[0];
  const firstLine = lines.filter((l) => l.dept === first.name)[0];
  record('admin: the line carries the payload’s Yesterday figures',
    !!firstLine && firstLine.text.indexOf('Placed ' + fmt(first.outbound.yesterday.placed)) !== -1
      && firstLine.text.indexOf(first.outbound.yesterday.pct.toFixed(1) + '%') !== -1,
    first.name + ': ' + (firstLine && firstLine.text));
  // Batch F1: the tile line's prior-period chips (Yesterday vs the business day before).
  {
    const pr = first.outbound.yesterday.prior;
    const chips = await page.evaluate((name) => {
      const t = document.querySelector('.ov-dept-tile[data-dept="' + name + '"] .ov-dept-ob');
      return t ? Array.from(t.querySelectorAll('.wow-chip')).map((c) => c.textContent) : [];
    }, first.name);
    const want = pr ? first.outbound.yesterday.placed - pr.placed : null;
    record('Batch F1: the line carries a Placed chip and a connect-rate chip vs the prior window',
      !!pr && chips.length === 2 && Number(chips[0].replace('\u2212', '-').replace(/[^0-9+-]/g, '')) === want && / pts$/.test(chips[1]),
      JSON.stringify({ chips: chips, want: want }));
  }
  record('admin: a capture-covered window has no "since" disclosure',
    !!firstLine && firstLine.text.indexOf('since') === -1, firstLine && firstLine.text);
  const pill = await page.evaluate(() => {
    const p = document.querySelector('.ov-dept-ob .ov-dir-pill');
    if (!p) return null;
    const cs = getComputedStyle(p);
    const probe = document.createElement('span'); probe.style.color = 'var(--dir-out)'; document.body.appendChild(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    return { color: cs.color, want: want };
  });
  record('admin: the line is labelled in the outbound hue', !!pill && pill.color === pill.want, JSON.stringify(pill));
  await page.close();

  // ---- admin: YTD window predates capture -> "since" -----------------------
  {
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    p2.on('pageerror', (e) => errors.push('ytd pageerror: ' + e.message));
    await skipTour(p2);
    await p2.addInitScript(() => { localStorage.setItem('cdr.ov.window', 'ytd'); });
    await p2.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
    await p2.waitForTimeout(3000);
    const l2 = (await p2.evaluate(tileLines)).filter((l) => l.dept === first.name)[0];
    const ytdChips = await p2.evaluate((name) => {
      const t = document.querySelector('.ov-dept-tile[data-dept="' + name + '"] .ov-dept-ob');
      return t ? t.querySelectorAll('.wow-chip').length : -1;
    }, first.name);
    record('Batch F1: no chips on YTD, whose prior window predates capture', ytdChips === 0 && first.outbound.ytd.prior === null,
      'chips=' + ytdChips);
    record('admin: the YTD window shows its own figures and says "since" the capture start',
      !!l2 && l2.text.indexOf('Placed ' + fmt(first.outbound.ytd.placed)) !== -1 && /since Jul 10/.test(l2.text),
      l2 && l2.text);
    await p2.close();
  }

  // ---- admin: Insights Outbound fold --------------------------------------
  const pg = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  pg.on('pageerror', (e) => errors.push('ins pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push('ins console: ' + m.text()); });
  await skipTour(pg);
  await pg.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await pg.waitForTimeout(2500);
  await openDept(pg, meta);
  // Owner 2026-10-08: the fold follows the direction switch -- hidden on
  // Inbound (the default), shown on Outbound / Both.
  const onInbound = await pg.evaluate(() => {
    const f = document.getElementById('ins-ob-fold');
    return { shown: !!f && getComputedStyle(f).display !== 'none',
      called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary').length };
  });
  record('admin, Inbound: the Insights Outbound fold is hidden and has not fetched',
    !onInbound.shown && onInbound.called === 0, JSON.stringify(onInbound));
  await pg.click('#dept-dir-switch [data-dir="out"]');
  await pg.waitForTimeout(2500);
  const insMeta = require('./payloads/insights.json').meta;
  // The mock's resolution order: the 30-day Batch D capture first, then the windows map.
  const ob30 = require('./payloads/dept-outbound-30d.json');
  const raw = (ob30.meta.from === insMeta.from && ob30.meta.to === insMeta.to) ? ob30 : win[insMeta.from + '|' + insMeta.to];
  // Insights is ONE department: the dept's own group, never its sub-queues'.
  const grp = raw && (raw.deptGroups || []).filter((g) => g.dept === insMeta.department)[0];
  const cur = raw && (grp ? { totals: grp.totals, agents: raw.agents.filter((a) => a.scopeDept === insMeta.department) } : raw);
  const ins = await pg.evaluate(() => {
    const f = document.getElementById('ins-ob-fold');
    return {
      shown: !!f && getComputedStyle(f).display !== 'none',
      head: (document.getElementById('ins-ob-fold-head') || {}).textContent || '',
      tiles: document.querySelectorAll('#ins-ob-kpis .ds-kpi').length,
      deltas: document.querySelectorAll('#ins-ob-kpis .pr-delta').length,
      rows: document.querySelectorAll('#ins-ob-agents tbody tr').length,
      calls: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary')
        .map((c) => c.args && c.args[0] ? c.args[0].from + '|' + c.args[0].to : '?'),
    };
  });
  record('admin: the Insights Outbound fold is shown', ins.shown, JSON.stringify(ins.head));
  record('admin: its headline reads the current window’s totals',
    !!cur && ins.head.indexOf(fmt(cur.totals.obTotal) + ' placed') !== -1
      && ins.head.indexOf(cur.totals.obConnectRate.toFixed(1) + '% connected') !== -1, ins.head);
  record('admin: it asks for the current AND the prior window',
    ins.calls.indexOf(insMeta.from + '|' + insMeta.to) !== -1 && ins.calls.indexOf(insMeta.priorFrom + '|' + insMeta.priorTo) !== -1,
    ins.calls.join(', '));
  record('admin: five KPI tiles, each compared with the prior window', ins.tiles === 5 && ins.deltas === 5,
    'tiles=' + ins.tiles + ' deltas=' + ins.deltas);
  record('admin: one agent row per agent of the dept’s OWN roster (no sub-queue agents)',
    !!cur && !!grp && ins.rows === cur.agents.length && cur.agents.length < raw.agents.length,
    'rows=' + ins.rows + ' agents=' + (cur && cur.agents.length));
  // "Same windows never re-fetch" is asserted on a DIRECTION change below, not
  // on Refresh: on Outbound an explicit Refresh refetches the Batch D table by
  // design (OB_VIEW_.key = null) with the SAME arguments, so a call count can
  // no longer tell an Insights re-fetch from the table's.
  // Inbound hides it again; Both brings it back from the held result.
  await pg.click('#dept-dir-switch [data-dir="in"]');
  await pg.waitForTimeout(1000);
  const hidIn = await pg.evaluate(() => getComputedStyle(document.getElementById('ins-ob-fold')).display === 'none');
  const nBefore = (await pg.evaluate(() => (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary').length));
  await pg.click('#dept-dir-switch [data-dir="both"]');
  await pg.waitForTimeout(1500);
  const both = await pg.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('ins-ob-fold')).display !== 'none',
    tiles: document.querySelectorAll('#ins-ob-kpis .ds-kpi').length,
  }));
  const insCalls = (await pg.evaluate(() => (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary')
    .map((c) => c.args && c.args[0] ? c.args[0].from + '|' + c.args[0].to : '?'))).slice(nBefore)
    .filter((k) => k === insMeta.from + '|' + insMeta.to || k === insMeta.priorFrom + '|' + insMeta.priorTo);
  record('re-rendering the same windows does not re-fetch them: Inbound hides the fold, Both shows it from the held result',
    hidIn && both.shown && both.tiles === 5 && insCalls.length === 0, JSON.stringify({ hidIn: hidIn, both: both, refetch: insCalls }));

  // View-as hides the fold, and the Overview served to View-as has no line.
  const opts = await pg.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option'))
    .map((o) => o.value).filter(Boolean));
  if (opts.length) {
    await pg.selectOption('#view-as-select', opts[0]);
    await pg.waitForTimeout(2500);
    const va = await pg.evaluate(() => {
      const f = document.getElementById('ins-ob-fold');
      return { fold: !!f && getComputedStyle(f).display !== 'none', flag: document.body.getAttribute('data-view-as') };
    });
    record('View-as: the Insights Outbound fold is hidden', va.flag === 'manager' && !va.fold, JSON.stringify(va));
    await pg.click('#overview-btn');
    await pg.waitForTimeout(2500);
    const vaLines = (await pg.evaluate(tileLines)).filter((l) => l.shown);
    record('View-as: no Overview tile shows the outbound line', vaLines.length === 0, vaLines.map((l) => l.dept).join(','));
    await pg.selectOption('#view-as-select', '');
    await pg.waitForTimeout(2500);
    const back = (await pg.evaluate(tileLines)).filter((l) => l.shown).length;
    record('leaving View-as brings the line back', back > 0, 'tiles with the line=' + back);
  } else {
    record('View-as control is present', false, 'no #view-as-select options');
  }
  // drive-smoke's UNMOCKED_OK: getInboundHeatmap is Neon-backed and must hide
  // silently on failure, so its "unmocked" report is part of the audit.
  const unmocked = await pg.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('admin: no unmocked server calls', !unmocked.length, unmocked.join(', '));
  await pg.close();

  // ---- manager: neither surface -------------------------------------------
  {
    const pm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pm.on('pageerror', (e) => errors.push('manager pageerror: ' + e.message));
    await skipTour(pm);
    await pm.goto('file://' + path.join(__dirname, 'site', 'index-manager.html'));
    await pm.waitForTimeout(3000);
    const mLines = (await pm.evaluate(tileLines)).filter((l) => l.shown);
    record('manager: no Overview tile shows the outbound line', mLines.length === 0, mLines.map((l) => l.dept).join(','));
    await openDept(pm, meta);
    const m = await pm.evaluate(() => {
      const f = document.getElementById('ins-ob-fold');
      return { fold: !!f && getComputedStyle(f).display !== 'none',
        called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary').length };
    });
    record('manager: the Insights Outbound fold is hidden and never fetches', !m.fold && m.called === 0, JSON.stringify(m));
    await pm.close();
  }

  const realErrors = errors.filter((e) => !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e));
  record('no page/console errors', realErrors.length === 0, Array.from(new Set(realErrors)).slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
