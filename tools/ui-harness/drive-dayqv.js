'use strict';
/**
 * ASSERTING driver for the DAY QUICK VIEW on My Department (QV-1, owner
 * 2026-10-29; admin-only while trialled, released with the day bars).
 *
 * A click on a day bar in any team card opens that day in a pop-up: the cards'
 * figures for the day (from the page payload, so they must equal the bar's own
 * readout) beside the range figure, a condensed agent table and the day's
 * missed calls (two single-day reads, plus outbound for an admin), with arrows
 * that step the bars' workdays. Only a browser shows that the click opens the
 * day it was on, that the reads ask for exactly that day, that the arrows skip
 * weekends and holidays, and that the keyboard, the agent-day drill and
 * "Open this day on the page" all land.
 *
 * Walk: admin, 30-day window -> click a day bar: the pop-up shows that day,
 * its cards match the bars' readouts, the reads are single-day -> agents
 * table (bars, total row, outbound column) -> missed: half-hour chart, ring
 * times, queue hang-ups with "↳ path" -> a name opens its day -> next / prev
 * step workdays, the ends disable -> the arrow keys step -> Escape closes and
 * focus returns -> keyboard Enter on a bar opens -> "Open this day on the page"
 * -> month (or week) bars do not open it -> a manager has no bars and no pop-up ->
 * 360 px: no sideways scroll.
 *
 * Run: node drive-dayqv.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

async function boot(context, file) {
  const page = await context.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push('pageerror: ' + (e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(m.text())) page.__errors.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });
  await page.goto('file://' + path.join(__dirname, 'site', file));
  await page.waitForTimeout(2500);
  return page;
}

async function openDept(page, from, to) {
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  await page.fill('#from-date', from);
  await page.fill('#to-date', to);
  await page.click('#refresh-btn');
  await page.waitForTimeout(3000);
}

// The workdays the bars draw, oldest first (weekends + company holidays out).
function workdays(w) {
  const out = [];
  const p = w.from.split('-'), q = w.to.split('-');
  for (let ms = Date.UTC(+p[0], p[1] - 1, +p[2], 12), end = Date.UTC(+q[0], q[1] - 1, +q[2], 12); ms <= end; ms += 86400000) {
    const iso = new Date(ms).toISOString().slice(0, 10), dow = new Date(ms).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if ((window.__COMPANY_HOLIDAYS__ || []).some(function (r) { return r && iso >= r.from && iso <= r.to; })) continue;
    out.push(iso);
  }
  return out;
}

function qvState() {
  const m = document.getElementById('day-qv-modal');
  const cards = Array.from(document.querySelectorAll('#day-qv-cards .dqv-card')).map(function (c) {
    return { key: c.getAttribute('data-dqv-card'), big: ((c.querySelector('.dqv-card-big') || {}).textContent || '').trim(),
             range: ((c.querySelector('.dqv-card-range') || {}).textContent || '').trim(), cls: c.className };
  });
  const tbl = document.querySelector('#day-qv-agents .dqv-table');
  return {
    open: !!m && getComputedStyle(m).display !== 'none',
    title: ((document.getElementById('day-qv-title') || {}).textContent || '').trim(),
    prevDisabled: !!(document.getElementById('day-qv-prev') || {}).disabled,
    nextDisabled: !!(document.getElementById('day-qv-next') || {}).disabled,
    cards: cards,
    rows: tbl ? tbl.querySelectorAll('tbody tr[data-dqv-row]').length : 0,
    rowBars: tbl ? tbl.querySelectorAll('tbody tr[data-dqv-row] .lb-cell').length : 0,
    total: !!(tbl && tbl.querySelector('tfoot tr.dqv-total')),
    heads: tbl ? Array.from(tbl.querySelectorAll('thead th')).map(function (th) { return th.textContent.trim(); }) : [],
    mcols: document.querySelectorAll('#day-qv-missed .dqv-mcol').length,
    rings: document.querySelectorAll('#day-qv-missed .dqv-ring').length,
    paths: document.querySelectorAll('#day-qv-missed .pid-journey').length,
    queueRows: document.querySelectorAll('#day-qv-missed .dqv-mlist').length,
    loading: !!document.querySelector('#day-qv-modal .ap-loading'),
  };
}

// The from..to of every call to each named RPC since the log was cleared.
function rpcDays(page, fns) {
  return page.evaluate((list) => {
    const o = {};
    list.forEach(function (fn) {
      o[fn] = (window.__HARNESS__.calls || []).filter(function (c) { return c.fn === fn; })
        .map(function (c) { const a = c.args[0] || {}; return a.from + '..' + a.to; });
    });
    return o;
  }, fns);
}

(async () => {
  const meta = require('./payloads/meta.json');
  const browser = await chromium.launch(launchOptions());

  // ---- admin, 30-day window -------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await boot(ctx, 'index-admin.html');
  await openDept(page, meta.from30, meta.latest);
  const days = await page.evaluate(workdays, { from: meta.from30, to: meta.latest });

  // Click bar 5 of the Queue calls card.
  const idx = 5;
  const bars = page.locator('#dept-team-strip [data-dts-metric="qcalls"] .dts-bars');
  const box = await bars.boundingBox();
  await page.mouse.move(box.x + box.width * (idx + 0.5) / days.length, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const readouts = await page.evaluate(() => {
    const o = {};
    document.querySelectorAll('#dept-team-strip .dts-daybars').forEach(function (b) {
      o[b.__metric] = ((b.querySelector('.dts-readout') || {}).textContent || '').trim();
    });
    return o;
  });
  await page.evaluate(() => { window.__HARNESS__.calls.length = 0; });
  await page.mouse.click(box.x + box.width * (idx + 0.5) / days.length, box.y + box.height / 2);
  await page.waitForTimeout(1200);
  let s = await page.evaluate(qvState);
  const iso = days[idx];
  const label = await page.evaluate((d) => {
    const p = d.split('-');
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(+p[0], p[1] - 1, +p[2], 12)).getUTCDay()];
    return wd + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0];
  }, iso);
  record('clicking a day bar opens the quick view on THAT day', s.open && s.title === label, JSON.stringify({ open: s.open, title: s.title, want: label }));
  record('the cards show every team card (with its range figure beside the day)',
    s.cards.length >= 4 && ['rate', 'qcalls', 'qabd', 'qavg'].every((k) => s.cards.some((c) => c.key === k))
      && s.cards.every((c) => /^Range \S/.test(c.range)),
    JSON.stringify(s.cards.map((c) => c.key + ':' + c.big + ' / ' + c.range)));
  const card = (k) => s.cards.filter((c) => c.key === k)[0] || { big: '?' };
  record('each card\'s day figure is the bar\'s own readout for that day',
    readouts.rate.indexOf(card('rate').big) !== -1 && readouts.qcalls.indexOf(card('qcalls').big) !== -1
      && readouts.qabd.indexOf(card('qabd').big) !== -1 && readouts.qavg.indexOf(card('qavg').big) !== -1,
    JSON.stringify({ cards: s.cards.map((c) => c.big), readouts }));
  const rc = await rpcDays(page, ['getDepartmentSummary', 'getMissedCallsReport', 'getDeptOutboundSummary']);
  const calls = { sum: rc.getDepartmentSummary, missed: rc.getMissedCallsReport, ob: rc.getDeptOutboundSummary };
  // QV-1b: the open day goes out FIRST, each read a single day; once it has
  // landed the workday either side follows -- and nothing else.
  const one = (d) => d + '..' + d;
  const wantSet = [one(days[idx - 1]), one(iso), one(days[idx + 1])].sort().join(',');
  const obDays = calls.ob.filter((x) => { const p = x.split('..'); return p[0] === p[1]; });
  record('it reads the open day first (summary, missed calls, admin outbound -- one day each), then only its two neighbours',
    calls.sum[0] === one(iso) && calls.missed[0] === one(iso)
      && calls.sum.slice().sort().join(',') === wantSet && calls.missed.slice().sort().join(',') === wantSet
      && obDays.slice().sort().join(',') === wantSet,
    JSON.stringify({ calls, want: wantSet }));
  record('the agent table: one line per agent with a bar, a total row, and the outbound column for an admin',
    s.rows > 0 && s.rowBars >= s.rows && s.total && s.heads.indexOf('Connected / not') !== -1 && s.heads.indexOf('Ans %') !== -1,
    JSON.stringify({ rows: s.rows, bars: s.rowBars, total: s.total, heads: s.heads }));
  record('missed calls: an 18-slot half-hour chart, ring times, and "↳ path" on the hang-ups',
    s.mcols === 18 && s.rings > 0 && s.paths > 0 && s.queueRows >= 1,
    JSON.stringify({ mcols: s.mcols, rings: s.rings, paths: s.paths, lists: s.queueRows }));
  record('nothing is still loading', !s.loading);

  // A name opens that agent's day beneath it.
  await page.evaluate(() => { window.__HARNESS__.calls.length = 0; });
  const firstAgent = page.locator('#day-qv-agents .dqv-agent').first();
  const agentName = (await firstAgent.textContent()).trim();
  await firstAgent.click();
  await page.waitForTimeout(800);
  const ad = await page.evaluate(() => {
    const row = document.querySelector('#day-qv-agents tr.dqv-ad-row');
    const c = (window.__HARNESS__.calls || []).filter(function (x) { return x.fn === 'getAgentDay'; }).map(function (x) { return x.args[0]; });
    return { row: !!row, kpis: !!(row && row.querySelector('.ap-kpis .pr-kpi-row')), expanded: (document.querySelector('#day-qv-agents .dqv-agent') || {}).getAttribute('aria-expanded'),
             call: c[0] || null, out: !!(row && /Outbound calls/.test(row.textContent)) };
  });
  record('a name opens that agent\'s day under the row (their KPIs and calls, for that date)',
    ad.row && ad.kpis && ad.expanded === 'true' && !!ad.call && ad.call.date === iso && ad.call.agentName === agentName && ad.out,
    JSON.stringify(ad));
  await firstAgent.click();
  await page.waitForTimeout(200);
  record('a second click closes it', await page.evaluate(() => !document.querySelector('#day-qv-agents tr.dqv-ad-row')));

  // QV-1b: the next day was prefetched, so stepping to it paints at once with
  // NO new request -- held back replies (2 s) would otherwise show a loader --
  // and the step queues the day after it.
  await page.evaluate(() => {
    window.__HARNESS__.calls.length = 0;
    window.__HARNESS__.delay = { getDepartmentSummary: 2000, getMissedCallsReport: 2000, getDeptOutboundSummary: 2000 };
  });
  await page.click('#day-qv-next');
  await page.waitForTimeout(250);
  const pf = await page.evaluate(qvState);
  const pfCalls = await rpcDays(page, ['getDepartmentSummary', 'getMissedCallsReport', 'getDeptOutboundSummary']);
  const allPf = [].concat(pfCalls.getDepartmentSummary, pfCalls.getMissedCallsReport, pfCalls.getDeptOutboundSummary);
  record('prefetch: stepping to the next day paints at once, with no new request for it',
    pf.open && !pf.loading && pf.rows > 0 && pf.mcols === 18 && allPf.indexOf(one(days[idx + 1])) === -1,
    JSON.stringify({ loading: pf.loading, rows: pf.rows, mcols: pf.mcols, calls: pfCalls }));
  record('prefetch: the step queues the day after it, and the day just left (already held) is not asked again',
    pfCalls.getDepartmentSummary.indexOf(one(days[idx + 2])) !== -1 && pfCalls.getMissedCallsReport.indexOf(one(days[idx + 2])) !== -1
      && pfCalls.getDeptOutboundSummary.indexOf(one(days[idx + 2])) !== -1 && allPf.indexOf(one(iso)) === -1,
    JSON.stringify(pfCalls));
  await page.waitForTimeout(2300);
  await page.evaluate(() => { window.__HARNESS__.delay = {}; });
  s = await page.evaluate(qvState);
  const nextLbl = await page.evaluate((d) => {
    const p = d.split('-');
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(+p[0], p[1] - 1, +p[2], 12)).getUTCDay()];
  }, days[idx + 1]);
  record('next steps to the next WORKDAY (weekends and holidays skipped)', s.title.indexOf(nextLbl) === 0 && /^(Mon|Tue|Wed|Thu|Fri) /.test(s.title)
    && s.title.indexOf(', ' + days[idx + 1].slice(0, 4)) !== -1 && new RegExp(' ' + (+days[idx + 1].slice(8)) + ',').test(s.title),
    s.title + ' want ' + days[idx + 1]);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  s = await page.evaluate(qvState);
  record('the arrow keys step too (back to the day it opened on)', s.title === label, s.title);
  // To the first day: prev disables there.
  for (let k = 0; k < idx; k++) { await page.click('#day-qv-prev'); await page.waitForTimeout(120); }
  await page.waitForTimeout(500);
  s = await page.evaluate(qvState);
  record('on the range\'s first day, "previous" is disabled', s.prevDisabled && !s.nextDisabled, JSON.stringify({ title: s.title, prev: s.prevDisabled }));

  // Escape closes; focus returns.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  s = await page.evaluate(qvState);
  record('Escape closes it', !s.open);

  // Keyboard: focus the bars, move, Enter opens the selected day.
  await page.locator('#dept-team-strip [data-dts-metric="rate"] .dts-bars').focus();
  await page.waitForTimeout(120);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  s = await page.evaluate(qvState);
  const kLbl = await page.evaluate((d) => {
    const p = d.split('-');
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + (+p[2]) + ', ';
  }, days[days.length - 2]);
  record('keyboard: Enter on a selected bar opens that day, and it is the last day but one', s.open && s.title.indexOf(kLbl) !== -1 && !s.nextDisabled,
    s.title + ' want ' + days[days.length - 2]);
  await page.click('#day-qv-next');
  await page.waitForTimeout(500);
  s = await page.evaluate(qvState);
  record('on the range\'s last day, "next" is disabled', s.nextDisabled, s.title);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const focusBack = await page.evaluate(() => !!(document.activeElement && document.activeElement.classList.contains('dts-bars')));
  record('closing hands focus back to the bars it was opened from', focusBack);

  // "Open this day on the page".
  await mouseOpen(page, 'rate', 3, days.length);
  await page.evaluate(() => { window.__HARNESS__.calls.length = 0; });
  await page.click('#day-qv-open');
  await page.waitForTimeout(2000);
  const op = await page.evaluate(() => ({ from: document.getElementById('from-date').value, to: document.getElementById('to-date').value,
    open: getComputedStyle(document.getElementById('day-qv-modal')).display !== 'none' }));
  op.sum = (await rpcDays(page, ['getDepartmentSummary'])).getDepartmentSummary;
  record('"Open this day on the page" closes the pop-up and loads that one day',
    !op.open && op.from === days[3] && op.to === days[3] && op.sum.indexOf(days[3] + '..' + days[3]) !== -1, JSON.stringify(op));

  // Week / month bars do not open it (the harness's year-to-date payload
  // draws monthly bars; a weekly one takes the same dqvDaily_ branch).
  const wFrom = meta.ytdStart;
  await openDept(page, wFrom, meta.latest);
  const wb = page.locator('#dept-team-strip [data-dts-metric="rate"] .dts-bars');
  if (await wb.count()) {
    const wbox = await wb.boundingBox();
    await page.mouse.click(wbox.x + wbox.width / 2, wbox.y + wbox.height / 2);
    await page.waitForTimeout(500);
    const wk = await page.evaluate(() => ({ open: getComputedStyle(document.getElementById('day-qv-modal')).display !== 'none',
      day: ((document.querySelector('#dept-team-strip .dts-readout-d') || {}).textContent || '') }));
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
    wk.idle = await page.evaluate(() => ((document.querySelector('#dept-team-strip .dts-readout') || {}).textContent || ''));
    record('week / month bars do not open the day view (and do not invite a click)',
      !wk.open && /^[A-Z][a-z]{2} \d{4} \(/.test(wk.day) && /^Monthly/.test(wk.idle) && !/click it/.test(wk.idle), JSON.stringify(wk));
  } else {
    record('week / month bars do not open the day view', false, 'no bars for the year-to-date window');
  }
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('no unmocked server calls', !unmocked.length, unmocked.join(', '));
  const errsAdmin = page.__errors.slice();
  await ctx.close();

  // ---- manager --------------------------------------------------------------
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const pm = await boot(mctx, 'index-manager.html');
  await openDept(pm, meta.from30, meta.latest);
  const mg = await pm.evaluate(() => ({ bars: document.querySelectorAll('#dept-team-strip .dts-bars').length,
    modalShown: getComputedStyle(document.getElementById('day-qv-modal')).display !== 'none' }));
  record('manager: no day bars, so no quick view (admin trial)', mg.bars === 0 && !mg.modalShown, JSON.stringify(mg));
  const errsMgr = pm.__errors.slice();
  await mctx.close();

  // ---- 360 px ---------------------------------------------------------------
  const nctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const pn = await boot(nctx, 'index-admin.html');
  await openDept(pn, meta.from30, meta.latest);
  await mouseOpen(pn, 'rate', 4, days.length);
  const n = await pn.evaluate(() => {
    const panel = document.querySelector('#day-qv-modal .modal-panel');
    return { open: getComputedStyle(document.getElementById('day-qv-modal')).display !== 'none',
             sw: panel ? panel.scrollWidth : 0, cw: panel ? panel.clientWidth : 0, vw: window.innerWidth,
             right: panel ? panel.getBoundingClientRect().right : 0 };
  });
  record('360 px: the pop-up fits the screen (no sideways scroll inside it)', n.open && n.right <= n.vw + 1 && n.sw <= n.cw + 1, JSON.stringify(n));
  const errsNarrow = pn.__errors.slice();
  await nctx.close();

  const errors = errsAdmin.concat(errsMgr, errsNarrow);
  record('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  await browser.close();
  const failed = results.filter((x) => !x.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function mouseOpen(page, metric, i, n) {
  const loc = page.locator('#dept-team-strip [data-dts-metric="' + metric + '"] .dts-bars');
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await page.mouse.click(b.x + b.width * (i + 0.5) / n, b.y + b.height / 2);
  await page.waitForTimeout(1000);
}
