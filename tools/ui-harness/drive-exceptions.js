'use strict';
/**
 * ASSERTING driver for EXCEPTION DAYS (owner 2026-10-22, Operator State #81).
 *
 * The harness fixture carries one all-department exception day (meta.excDate,
 * "8x8 outage") inside the 30-day window, so every payload here was computed
 * by the REAL server with that day LEFT OUT. What only a browser can show:
 * that each report SAYS so, that the day bars draw the day striped and off the
 * scale, that the admin's include switch is an admin's alone and really asks
 * the server, and that the Overview's trend bridges and shades the day.
 *
 * Walk: admin My Department (30 days) -> the note names the day, the reason and
 * the calls left out -> one striped bar per card, untinted, its readout says
 * "Excluded" -> Insights' note -> the include switch re-asks with the flag and
 * the note says INCLUDED -> back out -> View-as hides the switch -> a manager
 * sees the note without the switch -> the Overview's note, the shaded band and
 * the bridged (tooltip-less) point -> 360 px: no sideways scroll.
 *
 * Run: node drive-exceptions.js   (after gen-payloads + build-harness)
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
    localStorage.setItem('cdr.dept.direction', 'in');
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
  await page.waitForTimeout(3500);
}

const vis = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null; };

(async () => {
  const meta = require('./payloads/meta.json');
  const sum30 = require('./payloads/summary-30d.json');
  const exc = (sum30.meta && sum30.meta.exceptionDays) || [];
  const excCalls = exc.reduce((t, e) => t + (Number(e.rung) || 0), 0);
  record('fixture: the 30-day summary left the exception day out and says so', exc.length === 1 && exc[0].date === meta.excDate && excCalls > 0,
    JSON.stringify(exc));

  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

  // ---- admin: My Department --------------------------------------------------
  const page = await boot(context, 'index-admin.html');
  await openDept(page, meta.from30, meta.latest);
  let note = await page.evaluate(() => {
    const el = document.getElementById('dept-exc-note');
    const b = el && el.querySelector('[data-exc-toggle]');
    return { shown: !!el && getComputedStyle(el).display !== 'none', text: el ? el.textContent : '',
             toggle: !!b && getComputedStyle(b).display !== 'none', toggleText: b ? b.textContent : '' };
  });
  record('My Department says which day is left out, why, and how many calls',
    note.shown && /8x8 outage/.test(note.text) && note.text.indexOf(excCalls.toLocaleString('en-US')) !== -1, note.text);
  record('the admin sees the "Include them" switch', note.toggle && /Include them/.test(note.toggleText), note.toggleText);

  // Day bars: the excluded day is ONE striped bar in each card, untinted, and
  // its readout says so.
  const db = await page.evaluate(() => Array.from(document.querySelectorAll('#dept-team-strip .dts-daybars')).map((b) => {
    const bars = Array.from(b.querySelectorAll('.dts-bar'));
    const ex = bars.filter((x) => x.classList.contains('is-excluded'));
    return { n: bars.length, ex: ex.length, tinted: ex.some((x) => /is-bad|is-watch/.test(x.className)),
             exIdx: bars.findIndex((x) => x.classList.contains('is-excluded')) };
  }));
  record('every day-bar card draws the exception day as one striped bar, never tinted',
    db.length > 0 && db.every((c) => c.ex === 1 && !c.tinted), JSON.stringify(db));
  if (db.length && db[0].exIdx >= 0) {
    const bx = await page.evaluate((i) => {
      const bars = document.querySelectorAll('#dept-team-strip .dts-daybars')[0].querySelectorAll('.dts-bar');
      const r = bars[i].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.bottom - 2 };
    }, db[0].exIdx);
    await page.mouse.move(bx.x, bx.y);
    await page.waitForTimeout(250);
    const ro = await page.evaluate(() => (document.querySelector('#dept-team-strip .dts-daybars .dts-readout') || {}).textContent || '');
    record('pointing at the striped bar says it is excluded, and why', /Excluded \(8x8 outage\)/.test(ro), ro);
    await page.mouse.move(5, 5);
  }

  // Insights (the region generates with the page).
  await page.waitForTimeout(2500);
  const ins = await page.evaluate(() => {
    const el = document.querySelector('#insights-results > .exc-note');
    return { shown: !!el && getComputedStyle(el).display !== 'none', text: el ? el.textContent : '' };
  });
  record('Insights says the day is left out', ins.shown && /8x8 outage/.test(ins.text), ins.text);

  // The admin's switch: re-asks WITH the flag; the note says INCLUDED; back out.
  await page.evaluate(() => { window.__HARNESS__.calls = []; });
  await page.click('#dept-exc-note [data-exc-toggle]');
  await page.waitForTimeout(3000);
  const asked = await page.evaluate(() => (window.__HARNESS__.calls || [])
    .filter((c) => c.fn === 'getDepartmentSummary' || c.fn === 'getMissedCallsReport')
    .map((c) => ({ fn: c.fn, inc: !!(c.args && c.args[0] && c.args[0].includeExceptionDays) })));
  note = await page.evaluate(() => (document.getElementById('dept-exc-note') || {}).textContent || '');
  record('"Include them" re-asks the summary and the missed calls WITH the flag',
    asked.some((a) => a.fn === 'getDepartmentSummary' && a.inc) && asked.some((a) => a.fn === 'getMissedCallsReport' && a.inc),
    JSON.stringify(asked));
  record('and the note says they are included, naming the day', /INCLUDED/.test(note) && /8x8 outage/.test(note), note);
  await page.evaluate(() => { window.__HARNESS__.calls = []; });
  await page.click('#dept-exc-note [data-exc-toggle]');
  await page.waitForTimeout(3000);
  const back = await page.evaluate(() => (window.__HARNESS__.calls || [])
    .filter((c) => c.fn === 'getDepartmentSummary').map((c) => !!(c.args && c.args[0] && c.args[0].includeExceptionDays)));
  note = await page.evaluate(() => (document.getElementById('dept-exc-note') || {}).textContent || '');
  record('"Leave them out" asks again without it, and the note is back',
    back.length > 0 && back.every((x) => !x) && /left out/.test(note) && !/INCLUDED/.test(note), JSON.stringify(back) + ' ' + note);

  // View-as a manager: the switch is an admin's alone.
  const vaOpts = await page.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option')).map((o) => o.value).filter(Boolean));
  if (vaOpts.length) {
    await page.selectOption('#view-as-select', vaOpts[0]);
    await page.waitForTimeout(1500);
    const va = await page.evaluate(() => { const b = document.querySelector('#dept-exc-note [data-exc-toggle]'); return !!b && b.offsetParent !== null; });
    record('View-as a manager hides the switch', !va);
    await page.selectOption('#view-as-select', '');
    await page.waitForTimeout(1500);
  }

  // ---- Overview: the note, the shaded band, the bridged point ---------------
  await page.click('#overview-btn').catch(() => {});
  await page.waitForTimeout(2500);
  const ov = await page.evaluate((ex) => {
    const el = document.getElementById('ov-exc-note');
    const ch = (window.Chart && Chart.getChart) ? Chart.getChart('ov-trend-chart') : null;
    const idx = ch ? ((ch.options.plugins.ovExceptionBand || {}).idx || []) : null;
    const iso = ch ? ch.data.labels : [];
    const bridged = ch ? ch.data.datasets.filter((d) => d._bridged && Object.keys(d._bridged).length).length : 0;
    return { note: el && getComputedStyle(el).display !== 'none' ? el.textContent : '', idx: idx, bridged: bridged,
             labels: iso.length };
  }, meta.excDate);
  record('the Overview says which day its chart leaves out', /8x8 outage/.test(ov.note), ov.note);
  record('the trend chart shades the day and bridges the lines across it', Array.isArray(ov.idx) && ov.idx.length === 1 && ov.bridged > 0,
    JSON.stringify(ov));

  // ---- 360 px -----------------------------------------------------------------
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(600);
  const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  record('at 360 px the note causes no sideways scroll', over.doc <= over.win + 1, JSON.stringify(over));
  record('no page / console errors (admin)', page.__errors.length === 0, page.__errors.join(' | ').slice(0, 200));

  // ---- manager: the note, no switch -------------------------------------------
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mp = await boot(mctx, 'index-manager.html');
  await openDept(mp, meta.from30, meta.latest);
  const mn = await mp.evaluate(() => {
    const el = document.getElementById('dept-exc-note');
    const b = el && el.querySelector('[data-exc-toggle]');
    return { shown: !!el && getComputedStyle(el).display !== 'none', text: el ? el.textContent : '', toggle: !!b };
  });
  record('a manager sees the note too', mn.shown && /8x8 outage/.test(mn.text), mn.text);
  record('but never the include switch', !mn.toggle);
  record('no page / console errors (manager)', mp.__errors.length === 0, mp.__errors.join(' | ').slice(0, 200));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
