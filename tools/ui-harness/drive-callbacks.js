'use strict';
/**
 * ASSERTING driver for Batch G1: the Callbacks fold in the My Department
 * Insights region -- the Outbound report's callback analysis moving onto the
 * page (G3 retired the modal). Admin-only while the report is (6c).
 *
 * What only a browser shows: the fold appearing ONLY on the Outbound / Both
 * direction, staying LAZY (no getOutboundReport until it is opened, one fetch
 * per window), the modal's own renderers actually painting into it (tiles,
 * both strips, a NON-blank chart -- including after a close/reopen, the C3
 * zero-height trap), the not-called-back drill reaching the call path, the
 * CSV / email actions reading the window on screen, a 360 px page that does
 * not scroll sideways, and -- the 6c half -- no surface for View-as or a
 * manager. G3: the retired modal's #/report/outbound deep link lands on the
 * fold for an admin and is a plain My Department landing for a manager.
 *
 * Run: node drive-callbacks.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

async function boot(page, file, dir) {
  await page.addInitScript((d) => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
    localStorage.setItem('cdr.dept.direction', d);
    window.__CSV__ = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { blob.text().then(function (t) { window.__CSV__.push(t); }); } catch (e) {}
      return realCreate(blob);
    };
  }, dir || 'in');
  await page.goto('file://' + path.join(__dirname, 'site', file));
  await page.waitForTimeout(2500);
}

async function openDept(page, meta) {
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(3500);
}

function calls(page, fn) {
  return page.evaluate((f) => (window.__HARNESS__.calls || []).filter((c) => c.fn === f)
    .map((c) => (c.args && c.args[0]) || null), fn);
}

function foldState() {
  const f = document.getElementById('ins-cb-fold');
  return { shown: !!f && getComputedStyle(f).display !== 'none', open: !!f && f.open,
    head: ((document.getElementById('ins-cb-fold-head') || {}).textContent || '').trim() };
}

// A canvas that is laid out AND drawn (varied pixels) -- drive-smoke's rule.
function chartDrawn() {
  const c = document.getElementById('ins-cb-chart');
  if (!c || !c.offsetParent) return { drawn: false, why: 'hidden' };
  const r = c.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return { drawn: false, why: 'size ' + r.width + 'x' + r.height };
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const first = [data[0], data[1], data[2], data[3]].join(',');
  for (let i = 0; i < data.length; i += 800) {
    if ([data[i], data[i + 1], data[i + 2], data[i + 3]].join(',') !== first) return { drawn: true };
  }
  return { drawn: false, why: 'uniform pixels' };
}

async function setDir(page, dir) {
  await page.click('#dept-dir-switch [data-dir="' + dir + '"]');
  await page.waitForTimeout(1200);
}

(async () => {
  const meta = require('./payloads/meta.json');
  const insMeta = require('./payloads/insights.json').meta;
  const browser = await chromium.launch(launchOptions());
  const errors = [];

  // ---- admin ----------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await boot(page, 'index-admin.html', 'in');
  await openDept(page, meta);

  let st = await page.evaluate(foldState);
  record('admin, Inbound: the Callbacks fold is hidden', !st.shown, JSON.stringify(st));

  await setDir(page, 'out');
  st = await page.evaluate(foldState);
  record('admin, Outbound: the Callbacks fold is shown, closed, and says it loads on open',
    st.shown && !st.open && /open to load/.test(st.head), JSON.stringify(st));
  record('LAZY: nothing is fetched while the fold is closed', (await calls(page, 'getOutboundReport')).length === 0);

  await page.click('#ins-cb-fold > summary');
  await page.waitForTimeout(2000);
  const fetched = await calls(page, 'getOutboundReport');
  record('opening it fetches the report ONCE, for the dept and the window on screen',
    fetched.length === 1 && fetched[0].department === insMeta.department
      && fetched[0].from === insMeta.from && fetched[0].to === insMeta.to, JSON.stringify(fetched));

  const r = await page.evaluate(() => ({
    head: (document.getElementById('ins-cb-fold-head') || {}).textContent || '',
    tiles: Array.from(document.querySelectorAll('#ins-cb-kpis .ds-kpi')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    deltas: document.querySelectorAll('#ins-cb-kpis .pr-delta').length,
    delaySegs: document.querySelectorAll('#ins-cb-delay-strip .ob-delay-seg').length,
    hourCells: document.querySelectorAll('#ins-cb-hour-strip .ob-hour-cell').length,
    windowDays: (document.getElementById('ins-cb-window') || {}).textContent,
  }));
  record('the headline answers the question closed: own-team rate, episodes, median (CE-1)',
    /55\.6% called back by the team/.test(r.head) && /18 contact episodes/.test(r.head) && /median/.test(r.head), r.head);
  record('the seven episode tiles render, own team and another team kept apart',
    r.tiles.length === 7 && /^Contact episodes/.test(r.tiles[0]) && r.tiles[0].indexOf('18') !== -1
      && /^Called back by own team/.test(r.tiles[1]) && r.tiles[1].indexOf('55.6%') !== -1
      && r.tiles.some((t) => /^Contacted by another team/.test(t) && /may be unrelated/.test(t))
      && r.tiles.some((t) => /^Caller got through/.test(t)), r.tiles.join(' | '));
  record('the two own-team rate tiles carry prior-window deltas', r.deltas === 2, 'deltas=' + r.deltas);
  record('the "how fast" strip and the by-hour strip both render',
    r.delaySegs === 4 && r.hourCells === 4, 'segs=' + r.delaySegs + ' cells=' + r.hourCells);
  record('the callback window in the caption comes from the payload', r.windowDays === '3', r.windowDays);
  await page.waitForTimeout(800);
  let ch = await page.evaluate(chartDrawn);
  record('the daily callback chart is drawn (non-blank)', ch.drawn, JSON.stringify(ch));

  // Close + reopen: no re-fetch, and the chart is redrawn at a real size.
  await page.click('#ins-cb-fold > summary');
  await page.waitForTimeout(400);
  await page.click('#ins-cb-fold > summary');
  await page.waitForTimeout(1200);
  ch = await page.evaluate(chartDrawn);
  record('reopening repaints from the held payload (no second fetch) with a drawn chart',
    (await calls(page, 'getOutboundReport')).length === 1 && ch.drawn, JSON.stringify(ch));

  // The not-called-back drill, then the call path from one of its rows.
  await page.click('#ins-cb-uncalled-btn');
  await page.waitForTimeout(1200);
  const unc = await calls(page, 'getOutboundUncalled');
  const rows = await page.evaluate(() => ({
    rows: document.querySelectorAll('#ins-cb-uncalled-list .heat-drill-row').length,
    paths: document.querySelectorAll('#ins-cb-uncalled-list .pid-journey').length,
    status: (document.getElementById('ins-cb-uncalled-status') || {}).textContent || '',
  }));
  record('the not-called-back drill asks for the same window and dept, and lists the calls',
    unc.length === 1 && unc[0].from === insMeta.from && unc[0].to === insMeta.to
      && unc[0].department === insMeta.department && rows.rows === 3 && rows.paths === 3,
    JSON.stringify({ unc: unc, rows: rows }));
  // CE-2: grouped by episode, each with its status and late tags; the call id
  // (+ copy, admin) and the dialed line on every attempt.
  const eps = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('#ins-cb-uncalled-list .ob-ep'));
    const list = document.getElementById('ins-cb-uncalled-list');
    return { n: blocks.length,
      heads: blocks.map((b) => (b.querySelector('.ob-ep-head') || {}).textContent || ''),
      rowsPer: blocks.map((b) => b.querySelectorAll('.heat-drill-row').length),
      ids: list.querySelectorAll('.pid-num').length, copies: list.querySelectorAll('.pid-copy').length,
      dialed: (list.textContent.match(/dialed Main CSR Line/g) || []).length };
  });
  record('CE-2: the list is grouped by episode -- status, attempts and the late tag on each',
    eps.n === 2 && /Still inside the window · 2 days left/.test(eps.heads[0]) && /1 attempt/.test(eps.heads[0])
      && /Missed/.test(eps.heads[1]) && /2 attempts/.test(eps.heads[1])
      && /Called back late · day 5 · own team/.test(eps.heads[1])
      && JSON.stringify(eps.rowsPer) === '[1,2]', JSON.stringify(eps));
  record('CE-2: every attempt shows its call id with a copy button (admin) and the dialed line',
    eps.ids === 3 && eps.copies === 3 && eps.dialed === 2, JSON.stringify(eps));
  await page.click('#ins-cb-uncalled-list .pid-journey');
  await page.waitForTimeout(1200);
  const jr = await page.evaluate(() => {
    const ov = document.getElementById('call-journey-overlay');
    return { open: !!ov && getComputedStyle(ov).display !== 'none',
      body: !!ov && !!ov.querySelector('.cj-body') && ov.querySelector('.cj-body').textContent.trim().length > 0 };
  });
  record('a row’s "↳ path" opens the call path', jr.open && jr.body, JSON.stringify(jr));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // CE-2: the called-back list, and the path into the OUTBOUND callback.
  await page.click('#ins-cb-calledback-btn');
  await page.waitForTimeout(1200);
  const cbk = await calls(page, 'getOutboundCalledBack');
  const cbr = await page.evaluate(() => {
    const list = document.getElementById('ins-cb-calledback-list');
    const rows = Array.from(list.querySelectorAll('.ob-cb-row'));
    return { n: rows.length, text: rows.map((r) => r.textContent.replace(/\s+/g, ' ')),
      cbPaths: list.querySelectorAll('.pid-journey[data-journey-kind="outbound"]').length,
      head: ((list.querySelector('.heat-drill-head') || {}).textContent || '') };
  });
  record('CE-2: the called-back list asks for the same window and dept, own and another team apart',
    cbk.length === 1 && cbk[0].from === insMeta.from && cbk[0].to === insMeta.to && cbk[0].department === insMeta.department
      && cbr.n === 2 && /Own team/.test(cbr.text[0]) && /Test Agent \(CSR\)/.test(cbr.text[0]) && /connected/.test(cbr.text[0])
      && /Another team/.test(cbr.text[1]) && /Bill Payer \(Billing\)/.test(cbr.text[1]) && /did not connect/.test(cbr.text[1])
      && /1 by own team · 1 by another team/.test(cbr.head) && cbr.cbPaths === 2,
    JSON.stringify({ cbk: cbk, cbr: cbr }));
  await page.click('#ins-cb-calledback-list .pid-journey[data-journey-kind="outbound"]');
  await page.waitForTimeout(1200);
  const jo = await page.evaluate(() => {
    const ov = document.getElementById('call-journey-overlay');
    const reqs = (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getCallJourney')
      .map((c) => (c.args && c.args[0]) || null);
    return { open: !!ov && getComputedStyle(ov).display !== 'none', last: reqs[reqs.length - 1] || null };
  });
  record('CE-2: "↳ callback path" opens the OUTBOUND call’s path',
    jo.open && jo.last && jo.last.kind === 'outbound' && jo.last.callId === 'OB-777', JSON.stringify(jo));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // CSV + email read the held payload's window.
  await page.click('#ins-cb-csv-btn');
  await page.waitForTimeout(800);
  const csv = await page.evaluate(() => (window.__CSV__ || []).slice(-1)[0] || '');
  const csvLines = csv.split('\n');
  record('Download CSV writes the callbacks + agents for the window on screen',
    csvLines[0] === 'Outbound report,' + insMeta.from + ' to ' + insMeta.to
      && csvLines[1] === 'Scope,' + insMeta.department && /^Abandoned,25,/.test(csvLines[2] || ''),
    csvLines.slice(0, 3).join(' / '));
  await page.click('#ins-cb-email-btn');
  await page.waitForTimeout(800);
  const mail = await calls(page, 'sendOutboundReportEmail');
  record('Email to me sends the same window and dept',
    mail.length === 1 && mail[0].from === insMeta.from && mail[0].to === insMeta.to
      && mail[0].department === insMeta.department, JSON.stringify(mail));

  await setDir(page, 'both');
  st = await page.evaluate(foldState);
  record('Both: the fold stays', st.shown, JSON.stringify(st));
  await setDir(page, 'in');
  st = await page.evaluate(foldState);
  record('back to Inbound: the fold hides again', !st.shown, JSON.stringify(st));
  record('...and switching direction never re-fetched the report', (await calls(page, 'getOutboundReport')).length === 1);

  // View-as: the fold disappears with the direction switch.
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#view-as-select option'))
    .map((o) => o.value).filter(Boolean));
  if (opts.length) {
    await page.selectOption('#view-as-select', opts[0]);
    await page.waitForTimeout(2500);
    const va = await page.evaluate(() => {
      const f = document.getElementById('ins-cb-fold');
      return { fold: !!f && getComputedStyle(f).display !== 'none', flag: document.body.getAttribute('data-view-as') };
    });
    record('View-as: the Callbacks fold is hidden', va.flag === 'manager' && !va.fold, JSON.stringify(va));
    await page.selectOption('#view-as-select', '');
    await page.waitForTimeout(2000);
  } else {
    record('View-as control is present', false, 'no #view-as-select options');
  }
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
  record('admin: no unmocked server calls', !unmocked.length, unmocked.join(', '));
  await page.close();

  // ---- G3: the retired modal's deep link lands on the fold -------------------
  {
    const pd = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pd.on('pageerror', (e) => errors.push('deeplink pageerror: ' + e.message));
    await pd.addInitScript(() => { window.__HARNESS_HASH__ = '/report/outbound'; });
    await boot(pd, 'index-admin.html', 'in');   // saved direction: Inbound
    await pd.waitForTimeout(4000);
    const dl = await pd.evaluate(() => {
      const f = document.getElementById('ins-cb-fold');
      const r = f ? f.getBoundingClientRect() : null;
      return { page: document.body.getAttribute('data-page'), dir: document.body.getAttribute('data-dir'),
        shown: !!f && getComputedStyle(f).display !== 'none', open: !!f && f.open,
        tiles: document.querySelectorAll('#ins-cb-kpis .ds-kpi').length,
        inView: !!r && r.top < window.innerHeight && r.bottom > 0,
        modal: !!document.getElementById('outbound-modal') };
    });
    record('G3: #/report/outbound lands on My Department, Outbound, the Callbacks fold open, loaded and scrolled into view',
      dl.page === 'dept' && dl.dir === 'out' && dl.shown && dl.open && dl.tiles === 7 && dl.inView && !dl.modal,
      JSON.stringify(dl));
    await pd.close();
  }
  {
    const pm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pm.on('pageerror', (e) => errors.push('manager deeplink pageerror: ' + e.message));
    await pm.addInitScript(() => { window.__HARNESS_HASH__ = '/report/outbound'; });
    await boot(pm, 'index-manager.html', 'in');
    await pm.waitForTimeout(3500);
    const md = await pm.evaluate(() => ({
      page: document.body.getAttribute('data-page'), dir: document.body.getAttribute('data-dir'),
      fold: (function () { const f = document.getElementById('ins-cb-fold'); return !!f && getComputedStyle(f).display !== 'none'; })(),
      called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getOutboundReport' || c.fn === 'getDeptOutboundSummary').length,
    }));
    record('G3: for a manager (pre-release) the same link is a plain My Department landing -- Inbound, no fold, no outbound request',
      md.page === 'dept' && md.dir !== 'out' && !md.fold && md.called === 0, JSON.stringify(md));
    await pm.close();
  }

  // ---- 360 px ---------------------------------------------------------------
  {
    const pn = await browser.newPage({ viewport: { width: 360, height: 800 } });
    pn.on('pageerror', (e) => errors.push('360 pageerror: ' + e.message));
    await boot(pn, 'index-admin.html', 'out');
    await openDept(pn, meta);
    await pn.evaluate(() => { const f = document.getElementById('ins-cb-fold'); if (f) f.open = true; });
    await pn.waitForTimeout(2000);
    const n = await pn.evaluate(() => ({
      tiles: document.querySelectorAll('#ins-cb-kpis .ds-kpi').length,
      sw: document.documentElement.scrollWidth, vw: window.innerWidth,
    }));
    record('360 px: the open fold renders without a sideways page scroll',
      n.tiles === 7 && n.sw <= n.vw + 1, JSON.stringify(n));
    await pn.close();
  }

  // ---- manager: no fold, no fetch, even with Outbound saved -----------------
  {
    const pm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pm.on('pageerror', (e) => errors.push('manager pageerror: ' + e.message));
    await boot(pm, 'index-manager.html', 'out');
    await openDept(pm, meta);
    const m = await pm.evaluate(() => {
      const f = document.getElementById('ins-cb-fold');
      return { fold: !!f && getComputedStyle(f).display !== 'none',
        called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getOutboundReport').length };
    });
    record('manager (Outbound saved): the Callbacks fold is hidden and never fetches', !m.fold && m.called === 0, JSON.stringify(m));
    await pm.close();
  }

  // The shared filter: a resource the sandbox cannot fetch (fonts, favicon) is
  // environment noise, not an app error.
  const realErrors = errors.filter((e) => !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e));
  record('no page errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter((x) => !x.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' callbacks-fold checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
