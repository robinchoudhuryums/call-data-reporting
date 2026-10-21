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
 * QD-2 (owner 2026-10-20) rides along: the tiles' abandoned % / "N aban"
 * chips and the sub-queue strip's Abd follow the same card window (the
 * payload's qcd.periods; Yesterday = the latest QCD day), each with a tooltip.
 * QD-3: the "viol MTD" chip's tiers (0 green / 1-3 amber in --caution / 4+ red).
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

  // ---- QD-2 (owner 2026-10-20): the tiles' queue chips follow the card window --
  // Before, the abandoned % / "N aban" chips and the sub-queue strip's Abd
  // always showed the LATEST QCD day, so a quiet latest day read "Abd 0.0%" on a
  // 30-day view. Each window's figures come from the payload's qcd.periods.
  for (const winKey of ['yesterday', 'last30', 'ytd']) {
    const pq = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pq.on('pageerror', (e) => errors.push('qd2 pageerror: ' + e.message));
    await skipTour(pq);
    await pq.addInitScript((k) => { localStorage.setItem('cdr.ov.window', k); }, winKey);
    await pq.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
    await pq.waitForTimeout(3000);
    const seen = await pq.evaluate(() => {
      const out = {};
      document.querySelectorAll('.ov-dept-tile[data-dept]').forEach(function (t) {
        const pct = t.querySelector('[data-ov-qcd="pct"]'), cnt = t.querySelector('[data-ov-qcd="count"]');
        out[t.getAttribute('data-dept')] = { pct: pct ? pct.textContent.trim() : null, pctTip: pct ? pct.getAttribute('title') || '' : '',
          cntTip: cnt ? cnt.getAttribute('title') || '' : null };
      });
      document.querySelectorAll('.ov-subq-card[data-subq]').forEach(function (c) {
        const abd = c.querySelector('[data-ov-qcd="pct"]');
        out['subq:' + c.getAttribute('data-subq')] = { abd: abd ? abd.textContent.replace(/\s+/g, ' ').trim() : null, tip: abd ? abd.getAttribute('title') || '' : '' };
      });
      return out;
    });
    const block = (d) => winKey === 'yesterday' ? d.qcd : (d.qcd.periods || {})[winKey];
    const tops = ov.depts.filter((d) => d.qcd && !d.parent && block(d));
    const bad = tops.filter((d) => !seen[d.name] || seen[d.name].pct !== block(d).abandonedPctStr || !/Abandoned %/.test(seen[d.name].pctTip)
      || (block(d).abandoned > 0 && !(seen[d.name].cntTip || '').length));
    record('QD-2 ' + winKey + ': every tile\'s abandoned % is the window\'s own figure, and both abandoned chips explain themselves',
      tops.length > 0 && bad.length === 0, bad.map((d) => d.name + ' ' + JSON.stringify(seen[d.name]) + ' want ' + block(d).abandonedPctStr).join(' | ') || tops.length + ' tiles');
    const subs = ov.depts.filter((d) => d.qcd && d.parent && block(d));
    const badSub = subs.filter((d) => { const v = seen['subq:' + d.name]; return !v || v.abd !== 'Abd ' + block(d).abandonedPct.toFixed(1) + '%' || !v.tip; });
    record('QD-2 ' + winKey + ': the sub-queue strip\'s Abd is the window\'s figure, with a tooltip',
      subs.length > 0 && badSub.length === 0, badSub.map((d) => d.name + ' ' + JSON.stringify(seen['subq:' + d.name])).join(' | ') || subs.map((d) => d.name).join(','));
    await pq.close();
  }
  // The fixture must actually tell the windows apart, or the checks above prove nothing.
  const differs = ov.depts.some((d) => d.qcd && d.qcd.periods && d.qcd.periods.last30
    && d.qcd.periods.last30.abandonedPctStr !== d.qcd.abandonedPctStr);
  record('QD-2: the fixture\'s 30-day abandoned % differs from its latest day somewhere', differs);
  // QD-3 (owner 2026-10-20): "viol MTD" is 0 green / 1-3 amber / 4+ red, and the
  // amber is the --caution token (--warn reads as red, the --stale ruling).
  {
    const pv = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pv.on('pageerror', (e) => errors.push('qd3 pageerror: ' + e.message));
    await skipTour(pv);
    await pv.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
    await pv.waitForTimeout(3000);
    const vchips = await pv.evaluate(() => {
      const probe = function (token) {
        const el = document.createElement('span'); el.style.color = 'var(' + token + ')';
        document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c;
      };
      const out = { caution: probe('--caution'), bad: probe('--bad'), good: probe('--good'), tiles: {}, probeAmber: null };
      // Whether the fixture holds a 1-3 month today depends on the run date
      // (its MTD window moves), so the amber COLOUR is also measured on a
      // probe chip placed inside a real tile -- same CSS context, any date.
      const host = document.querySelector('.ov-dept-tile[data-dept] .ov-qcd-flag');
      if (host && host.parentNode) {
        const pc = document.createElement('span'); pc.className = 'ov-qcd-flag ov-qcd-viol-low'; pc.textContent = '2 viol MTD';
        host.parentNode.appendChild(pc); out.probeAmber = getComputedStyle(pc).color; pc.remove();
      }
      document.querySelectorAll('.ov-dept-tile[data-dept]').forEach(function (t) {
        const c = Array.from(t.querySelectorAll('.ov-qcd-flag')).filter(function (x) { return /viol MTD/.test(x.textContent); })[0];
        if (c) out.tiles[t.getAttribute('data-dept')] = { cls: c.className, color: getComputedStyle(c).color, text: c.textContent.trim() };
      });
      return out;
    });
    const tier = (n) => n > 3 ? 'ov-qcd-viol-high' : (n > 0 ? 'ov-qcd-viol-low' : 'ov-qcd-viol-none');
    const tops = ov.depts.filter((d) => d.qcd && !d.parent);
    const wrong = tops.filter((d) => { const v = vchips.tiles[d.name]; return !v || v.cls.indexOf(tier(Number(d.qcd.violationsMtd) || 0)) === -1; });
    record('QD-3: every "viol MTD" chip is tiered 0 green / 1-3 amber / 4+ red',
      tops.length > 0 && wrong.length === 0, wrong.map((d) => d.name + ' ' + d.qcd.violationsMtd + ' ' + JSON.stringify(vchips.tiles[d.name])).join(' | ') || tops.length + ' tiles');
    const amber = tops.filter((d) => { const n = Number(d.qcd.violationsMtd) || 0; return n > 0 && n <= 3; });
    record('QD-3: an amber "viol MTD" chip is drawn in --caution, not a red',
      vchips.probeAmber === vchips.caution && vchips.probeAmber !== vchips.bad
        && amber.every((d) => vchips.tiles[d.name] && vchips.tiles[d.name].color === vchips.caution),
      JSON.stringify({ probe: vchips.probeAmber, amber: amber.map((d) => d.name + ':' + d.qcd.violationsMtd), caution: vchips.caution, bad: vchips.bad,
        seen: amber.map((d) => vchips.tiles[d.name] && vchips.tiles[d.name].color) }));
    await pv.close();
  }
  record('QD-2: the per-queue day map the periods are summed from never ships',
    ov.depts.every((d) => !d.qcd || !Object.prototype.hasOwnProperty.call(d.qcd, 'queueDaily')));

  // ---- admin: Insights Outbound fold --------------------------------------
  const pg = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  pg.on('pageerror', (e) => errors.push('ins pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push('ins console: ' + m.text()); });
  await skipTour(pg);
  // Step 3 (owner 2026-10-16): the Outbound section is the brief's own row,
  // independent of the outbound COLUMNS -- so land with the columns OFF and
  // it must still be there, loaded.
  await pg.addInitScript(() => { localStorage.setItem('cdr.dept.direction', 'in'); });
  await pg.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await pg.waitForTimeout(2500);
  await openDept(pg, meta);
  await pg.waitForTimeout(1500);
  // UX-1: the summary reads the PAGE's window (the dept summary payload's
  // meta: window + INV-28 prior), not Insights'.
  const insMeta = require('./payloads/summary-30d.json').meta;
  // The mock's resolution order: the 30-day Batch D capture first, then the windows map.
  const ob30 = require('./payloads/dept-outbound-30d.json');
  const raw = (ob30.meta.from === insMeta.from && ob30.meta.to === insMeta.to) ? ob30 : win[insMeta.from + '|' + insMeta.to];
  // The summary is ONE department: the dept's own group, never its sub-queues'.
  const grp = raw && (raw.deptGroups || []).filter((g) => g.dept === insMeta.department)[0];
  const cur = raw && (grp ? { totals: grp.totals, agents: raw.agents.filter((a) => a.scopeDept === insMeta.department) } : raw);
  const ins = await pg.evaluate(() => {
    const f = document.getElementById('ins-ob-fold');
    return {
      shown: !!f && f.style.display !== 'none',
      head: (document.getElementById('ins-ob-fold-head') || {}).textContent || '',
      tiles: document.querySelectorAll('#ins-ob-kpis .ds-kpi').length,
      deltas: document.querySelectorAll('#ins-ob-kpis .pr-delta').length,
      agentTable: !!document.querySelector('#ins-ob-fold table'),
      note: ((document.getElementById('ins-ob-note') || {}).textContent || ''),
      dir: document.body.getAttribute('data-dir'),
      inBrief: (function () {
        var b = document.getElementById('ins-brief');
        var reg = document.getElementById('dept-insights-region');
        var row = b && b.querySelector('.ins-brief-row[data-brief-key="outbound"]');
        return !!b && !!f && !!row && b.contains(f) && !!reg && !reg.contains(f);
      })(),
      calls: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary')
        .map((c) => c.args && c.args[0] ? c.args[0].from + '|' + c.args[0].to : '?'),
    };
  });
  record('admin, columns OFF: the Outbound section is still on (its own brief row)', ins.shown && ins.dir === 'in',
    JSON.stringify({ shown: ins.shown, dir: ins.dir, head: ins.head }));
  record('Step 3: the summary sits in the brief\'s Outbound row, outside the Insights region', ins.inBrief);
  record('admin: its headline reads the current window’s totals',
    !!cur && ins.head.indexOf(fmt(cur.totals.obTotal) + ' placed') !== -1
      && ins.head.indexOf(cur.totals.obConnectRate.toFixed(1) + '% connected') !== -1, ins.head);
  record('admin: it asks for the current AND the prior window',
    ins.calls.indexOf(insMeta.from + '|' + insMeta.to) !== -1 && ins.calls.indexOf(insMeta.priorFrom + '|' + insMeta.priorTo) !== -1,
    ins.calls.join(', '));
  record('admin: five KPI tiles, each compared with the prior window', ins.tiles === 5 && ins.deltas === 5,
    'tiles=' + ins.tiles + ' deltas=' + ins.deltas);
  // UX-1: no agent table of its own (the outbound table above is it), and the
  // own-group count is LABELLED when the table also holds sub-queue agents.
  record('UX-1: the summary has no agent table of its own', !ins.agentTable);
  record('UX-1: the head and note say the count is the dept’s own group, naming the table’s total',
    !!grp && raw.deptGroups.length > 1 && ins.head.indexOf(insMeta.department + ' only · ') === 0
      && ins.note.indexOf(insMeta.department + '’s own group') !== -1
      && ins.note.indexOf(fmt(raw.totals.obTotal) + ' placed in all') !== -1,
    JSON.stringify({ head: ins.head, note: ins.note }));
  // UX-1: collapsing the Insights region leaves both sections on screen
  // (Step 3: once their brief rows are open -- every row starts collapsed).
  await pg.click('#ins-brief .ins-brief-row[data-brief-key="outbound"]');
  await pg.click('#ins-brief .ins-brief-row[data-brief-key="callbacks"]');
  await pg.waitForTimeout(800);
  const collapsed = await pg.evaluate(() => {
    var reg = document.getElementById('dept-insights-region');
    reg.open = false;
    var vis = function (id) { var e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
    var r = { ob: vis('ins-ob-fold'), cb: vis('ins-cb-fold') };
    reg.open = true;
    return r;
  });
  record('UX-1: with the Insights region collapsed, the Outbound summary and Callbacks stay visible',
    collapsed.ob && collapsed.cb, JSON.stringify(collapsed));
  // Turning the outbound columns ON asks for each window AT MOST once (FO-3's
  // one store) and leaves the section untouched. Not "zero": an explicit
  // Refresh clears the shared store by design, and when the driver's own
  // date-change load lands before its Refresh click the table re-asks once.
  const nBefore = (await pg.evaluate(() => (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary').length));
  await pg.click('#dept-dir-switch [data-ob-cols]');
  await pg.waitForTimeout(1500);
  const both = await pg.evaluate(() => ({
    dir: document.body.getAttribute('data-dir'),
    table: document.querySelectorAll('#agents-ob-tbody tr[data-agent]').length,
    shown: document.getElementById('ins-ob-fold').style.display !== 'none',
    tiles: document.querySelectorAll('#ins-ob-kpis .ds-kpi').length,
  }));
  const insCalls = (await pg.evaluate(() => (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary')
    .map((c) => c.args && c.args[0] ? c.args[0].from + '|' + c.args[0].to : '?'))).slice(nBefore)
    .filter((k) => k === insMeta.from + '|' + insMeta.to || k === insMeta.priorFrom + '|' + insMeta.priorTo);
  record('turning the columns on asks for each window at most once, and leaves the Outbound section as it was',
    both.dir === 'both' && both.table > 0 && both.shown && both.tiles === 5 && new Set(insCalls).size === insCalls.length,
    JSON.stringify({ both: both, refetch: insCalls }));

  // View-as hides the fold, and the Overview served to View-as has no line.
  const opts = await pg.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option'))
    .map((o) => o.value).filter(Boolean));
  if (opts.length) {
    await pg.selectOption('#view-as-select', opts[0]);
    await pg.waitForTimeout(2500);
    const va = await pg.evaluate(() => {
      const f = document.getElementById('ins-ob-fold');
      // Step 3: measured on the section ITSELF (the brief hides with it in View-as).
      return { fold: !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none', flag: document.body.getAttribute('data-view-as') };
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
