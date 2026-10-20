'use strict';
/**
 * ASSERTING driver for the team cards' LINKED DAY BARS on My Department
 * (Step 4, owner 2026-10-16; admin-only while trialled).
 *
 * Each card under the page title gets a row of bars -- one per workday of the
 * loaded range (one per month past ~6 months) -- and pointing at a bar in ANY
 * card selects that day in EVERY card, each card's readout naming its own
 * value. Only a browser shows whether the selection is really shared, whether
 * the bar count honours weekends and holidays, whether the keyboard and touch
 * paths work, and whether the bars stay inside the card at phone width.
 *
 * Walk: admin, 30-day window -> one bar per workday in every card -> hover a
 * bar: same index selected in every card, readouts name the same day ->
 * leave: cleared -> keyboard: focus selects the newest, arrows move, Escape
 * clears -> touch: a tap holds, a tap elsewhere lets go -> a one-day window
 * has no bars -> year-to-date goes monthly -> View-as and a manager see none
 * -> 360 px: no sideways scroll.
 *
 * Run: node drive-daybars.js   (after gen-payloads + build-harness)
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

function bars() {
  return Array.from(document.querySelectorAll('#dept-team-strip .dts-daybars')).map(function (b) {
    const bs = b.querySelector('.dts-bars');
    return {
      metric: b.__metric || '',
      n: bs ? bs.children.length : 0,
      sel: bs ? Array.prototype.findIndex.call(bs.children, function (s) { return s.classList.contains('is-sel'); }) : -1,
      on: !!(bs && bs.classList.contains('is-on')),
      readout: ((b.querySelector('.dts-readout') || {}).textContent || '').trim(),
      day: ((b.querySelector('.dts-readout-d') || {}).textContent || '').trim(),
      shown: b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none',
    };
  });
}

(async () => {
  const meta = require('./payloads/meta.json');
  const browser = await chromium.launch(launchOptions());

  // ---- admin, 30-day window -------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const page = await boot(ctx, 'index-admin.html');
  await openDept(page, meta.from30, meta.latest);

  const want = await page.evaluate((w) => {
    let n = 0;
    const p = w.from.split('-'), q = w.to.split('-');
    for (let ms = Date.UTC(+p[0], p[1] - 1, +p[2], 12), end = Date.UTC(+q[0], q[1] - 1, +q[2], 12); ms <= end; ms += 86400000) {
      const iso = new Date(ms).toISOString().slice(0, 10), dow = new Date(ms).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      if ((window.__COMPANY_HOLIDAYS__ || []).some(function (r) { return r && iso >= r.from && iso <= r.to; })) continue;
      n++;
    }
    return n;
  }, { from: meta.from30, to: meta.latest });

  let b = await page.evaluate(bars);
  const metrics = b.map((x) => x.metric);
  record('every card with daily data carries bars (% answered, queue calls, abandoned %, avg answer)',
    ['rate', 'qcalls', 'qabd', 'qavg'].every((k) => metrics.indexOf(k) !== -1) && b.every((x) => x.shown),
    metrics.join(','));
  record('one bar per WORKDAY (weekends and company holidays get none)', b.length > 0 && b.every((x) => x.n === want),
    JSON.stringify(b.map((x) => x.n)) + ' want ' + want);
  record('idle: no selection, the readout invites a point', b.every((x) => x.sel === -1 && !x.on && /Point at a bar/.test(x.readout)),
    b.map((x) => x.readout).join(' | '));

  // QD-1 (owner 2026-10-20): Queue calls and Abandoned % carry the vs-prior
  // chip the Avg answer card already had, from the payload's prior block.
  const sum30 = require('./payloads/summary-30d.json');
  const qr = sum30.qcd.range, qp = sum30.qcd.rangePrior;
  const wantCalls = qr.totalCalls - qp.totalCalls;
  const wantAbd = Math.round((qr.abandonedPct - qp.abandonedPct) * 100) / 100;
  const chips = await page.evaluate(() => {
    const t = function (k) {
      const tile = document.querySelector('#dept-team-strip .dts-tile[data-dts-metric="' + k + '"]');
      const c = tile && tile.querySelector('.dts-delta');
      return c ? { text: c.textContent.trim(), title: c.getAttribute('title') || '', cls: c.className } : null;
    };
    return { qcalls: t('qcalls'), qabd: t('qabd'), qavg: t('qavg') };
  });
  const num = function (c) { return c ? Number(c.text.replace(/[^0-9.]/g, '')) * (/−/.test(c.text) ? -1 : 1) : NaN; };
  record('Queue calls and Abandoned % carry a vs-prior chip (like Avg answer), with the payload\'s deltas',
    !!(chips.qcalls && chips.qabd && chips.qavg)
      && num(chips.qcalls) === wantCalls && Math.abs(num(chips.qabd) - wantAbd) < 0.001
      && /Prior period/.test(chips.qcalls.title) && /Prior period/.test(chips.qabd.title),
    JSON.stringify(chips) + ' want calls ' + wantCalls + ' abd ' + wantAbd);
  record('a queue-calls rise reads good; an abandoned-% move under a quarter point stays muted',
    !!(chips.qcalls && chips.qabd)
      && (wantCalls >= 3 ? /wow-chip-good/.test(chips.qcalls.cls) : true)
      && (Math.abs(wantAbd) < 0.25 ? /wow-chip-muted/.test(chips.qabd.cls) : !/wow-chip-muted/.test(chips.qabd.cls)),
    JSON.stringify(chips));

  // Hover a bar in the QUEUE CALLS card: the same day lights up everywhere.
  const qBars = page.locator('#dept-team-strip [data-dts-metric="qcalls"] .dts-bars');
  const box = await qBars.boundingBox();
  const idx = 5;
  await page.mouse.move(box.x + box.width * (idx + 0.5) / want, box.y + box.height / 2);
  await page.waitForTimeout(250);
  b = await page.evaluate(bars);
  record('hovering a bar in one card selects the SAME day in every card',
    b.every((x) => x.sel === idx && x.on), JSON.stringify(b.map((x) => x.sel)));
  record('every card\'s readout names that day and its own value',
    b.every((x) => x.day && x.day === b[0].day && x.readout.length > x.day.length)
      && /answered/.test(b.filter((x) => x.metric === 'rate')[0].readout)
      && /calls/.test(b.filter((x) => x.metric === 'qcalls')[0].readout)
      && /abandoned/.test(b.filter((x) => x.metric === 'qabd')[0].readout)
      && /avg answer/.test(b.filter((x) => x.metric === 'qavg')[0].readout),
    b.map((x) => x.readout).join(' | '));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  b = await page.evaluate(bars);
  record('leaving the cards clears the selection', b.every((x) => x.sel === -1 && !x.on), JSON.stringify(b.map((x) => x.sel)));

  // Keyboard: focus selects the newest; arrows move; Escape clears.
  await page.locator('#dept-team-strip [data-dts-metric="rate"] .dts-bars').focus();
  await page.waitForTimeout(150);
  b = await page.evaluate(bars);
  record('keyboard: focusing a bar row selects the newest day', b.every((x) => x.sel === want - 1), JSON.stringify(b.map((x) => x.sel)));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const aria = await page.locator('#dept-team-strip [data-dts-metric="rate"] .dts-bars').getAttribute('aria-valuetext');
  b = await page.evaluate(bars);
  record('keyboard: arrows move every card together, and the slider says where it is',
    b.every((x) => x.sel === want - 3) && /answered/.test(aria || ''), JSON.stringify(b.map((x) => x.sel)) + ' ' + aria);
  await page.keyboard.press('Home');
  await page.waitForTimeout(100);
  record('keyboard: Home jumps to the first day', (await page.evaluate(bars)).every((x) => x.sel === 0));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  record('keyboard: Escape clears', (await page.evaluate(bars)).every((x) => x.sel === -1));

  // Touch: a tap HOLDS the day (no hover to lose it); a tap elsewhere lets go.
  await page.locator('body').click({ position: { x: 5, y: 5 } });   // blur
  const abBox = await page.locator('#dept-team-strip [data-dts-metric="qabd"] .dts-bars').boundingBox();
  await page.touchscreen.tap(abBox.x + abBox.width * (2.5 / want), abBox.y + abBox.height / 2);
  await page.waitForTimeout(250);
  b = await page.evaluate(bars);
  record('touch: a tap holds that day in every card', b.every((x) => x.sel === 2), JSON.stringify(b.map((x) => x.sel)));
  const tile = await page.locator('#dept-team-strip [data-dts-metric="qabd"] .dts-value').boundingBox();
  await page.touchscreen.tap(tile.x + 4, tile.y + 4);
  await page.waitForTimeout(250);
  record('touch: a tap elsewhere in the cards lets go', (await page.evaluate(bars)).every((x) => x.sel === -1));

  // A one-day window has nothing to choose between.
  await openDept(page, meta.latest, meta.latest);
  record('a one-day window has no bars', (await page.evaluate(bars)).length === 0);

  // Year to date: past ~6 months the bars go monthly.
  await openDept(page, meta.ytdStart, meta.latest);
  b = await page.evaluate(bars);
  const months = Number(meta.latest.slice(5, 7));
  record('year to date: one bar per MONTH', b.length > 0 && b.every((x) => x.n === months), JSON.stringify(b.map((x) => x.n)) + ' want ' + months);
  await page.locator('#dept-team-strip [data-dts-metric="rate"] .dts-bars').focus();
  await page.waitForTimeout(150);
  b = await page.evaluate(bars);
  record('a monthly bar names its month and workday count', /^[A-Z][a-z]{2} \d{4} \(\d+ workdays?\)$/.test(b[0].day), b[0].day);

  // View as a manager: the trial surface is hidden.
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option')).map((o) => o.value).filter(Boolean));
  if (opts.length) {
    await page.selectOption('#view-as-select', opts.indexOf('CSR') !== -1 ? 'CSR' : opts[0]);
    await page.waitForTimeout(2500);
    b = await page.evaluate(bars);
    record('View-as: no day bars on screen', b.every((x) => !x.shown), JSON.stringify(b.map((x) => x.shown)));
    await page.selectOption('#view-as-select', '');
    await page.waitForTimeout(1500);
  } else {
    record('View-as control is present', false, 'no options');
  }
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('no unmocked server calls (the bars need no new request)', !unmocked.length, unmocked.join(', '));
  const errsAdmin = page.__errors.slice();
  await ctx.close();

  // ---- manager --------------------------------------------------------------
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const pm = await boot(mctx, 'index-manager.html');
  await openDept(pm, meta.from30, meta.latest);
  record('manager: no day bars (admin trial)', (await pm.evaluate(bars)).length === 0);
  const errsMgr = pm.__errors.slice();
  await mctx.close();

  // ---- 360 px ---------------------------------------------------------------
  const nctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true });
  const pn = await boot(nctx, 'index-admin.html');
  await openDept(pn, meta.from30, meta.latest);
  const n = await pn.evaluate(() => ({
    bars: document.querySelectorAll('#dept-team-strip .dts-daybars').length,
    sw: document.documentElement.scrollWidth, vw: window.innerWidth,
    inside: Array.from(document.querySelectorAll('#dept-team-strip .dts-daybars')).every(function (b) {
      const t = b.closest('.dts-tile').getBoundingClientRect(), r = b.getBoundingClientRect();
      return r.left >= t.left - 1 && r.right <= t.right + 1;
    }),
  }));
  record('360 px: the bars stay inside their cards and the page does not scroll sideways',
    n.bars > 0 && n.inside && n.sw <= n.vw + 1, JSON.stringify(n));
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
