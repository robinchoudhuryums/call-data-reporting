'use strict';
/**
 * ASSERTING driver for Batch G1: the Callbacks fold in the My Department
 * Insights region -- the Outbound report's callback analysis moving onto the
 * page (G3 retired the modal). Admin-only while the report is (6c).
 *
 * Step 3 (owner 2026-10-16): the fold is the Insights brief's Callbacks ROW
 * (an accordion under the team cards), independent of the outbound columns
 * toggle, and it PRELOADS -- one fetch per window once the page settles, the
 * row and head answering before it is opened (Direct lines too).
 *
 * What only a browser shows: the section opening in place from its row,
 * one fetch per window, the modal's own renderers actually painting into it (tiles,
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
  const slot = document.getElementById('ins-brief-slot-callbacks');
  const row = document.querySelector('#ins-brief .ins-brief-row[data-brief-key="callbacks"] .ins-brief-text');
  return { shown: !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none', open: !!f && f.open,
    inRow: !!slot && !!f && slot.contains(f), slotShown: !!slot && !slot.hidden,
    row: row ? row.textContent : null,
    head: ((document.getElementById('ins-cb-fold-head') || {}).textContent || '').trim() };
}

// Step 3: the section opens and closes from its brief row (its own summary is
// hidden while it sits in the accordion).
async function toggleCb(page) {
  await page.click('#ins-brief .ins-brief-row[data-brief-key="callbacks"]');
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

async function toggleColumns(page) {
  await page.click('#dept-dir-switch [data-ob-cols]');
  await page.waitForTimeout(1200);
}

(async () => {
  const meta = require('./payloads/meta.json');
  // UX-1: Callbacks reads the PAGE's window (the dept summary payload's meta).
  const insMeta = require('./payloads/summary-30d.json').meta;
  const browser = await chromium.launch(launchOptions());
  const errors = [];

  // Step 3: the preload also fetches the window the page LANDED on (before
  // the driver sets its dates) -- a legitimate request -- so every count below
  // is for the window on screen.
  const onScreen = (arr) => arr.filter((a) => a && a.from === insMeta.from && a.to === insMeta.to);

  // ---- admin ----------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await boot(page, 'index-admin.html', 'in');
  await openDept(page, meta);

  await page.waitForTimeout(1500);   // the preload settles
  let st = await page.evaluate(foldState);
  record('admin, columns OFF: the Callbacks section is on, in its brief row, closed',
    st.shown && st.inRow && !st.open && !st.slotShown, JSON.stringify(st));
  const fetched = onScreen(await calls(page, 'getOutboundReport'));
  record('PRELOAD: it fetched the report ONCE while closed, for the dept and the window on screen',
    fetched.length === 1 && fetched[0].department === insMeta.department
      && fetched[0].from === insMeta.from && fetched[0].to === insMeta.to, JSON.stringify(fetched));
  record('PRELOAD: the row and the head already answer the question',
    /called back by the team/.test(st.head) && /^Callbacks: .*called back by the team/.test(st.row || ''), JSON.stringify({ head: st.head, row: st.row }));

  await toggleCb(page);
  await page.waitForTimeout(1500);
  st = await page.evaluate(foldState);
  record('its row opens it in place, with no second fetch',
    st.open && st.slotShown && onScreen(await calls(page, 'getOutboundReport')).length === 1, JSON.stringify(st));

  const r = await page.evaluate(() => ({
    head: (document.getElementById('ins-cb-fold-head') || {}).textContent || '',
    // CB-R1: the summary -- headline, one bar that adds up, its legend.
    num: (document.querySelector('#ins-cb-kpis .ob-sum-num') || {}).textContent || '',
    sub: (document.querySelector('#ins-cb-kpis .ob-sum-sub') || {}).textContent || '',
    segs: Array.from(document.querySelectorAll('#ins-cb-kpis .ob-obar-seg')).map((x) => ({ seg: x.getAttribute('data-seg'),
      n: parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]) })),
    legend: Array.from(document.querySelectorAll('#ins-cb-kpis .ob-leg')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    tiles: document.querySelectorAll('#ins-cb-kpis .ds-kpi').length,
    deltas: document.querySelectorAll('#ins-cb-kpis .pr-delta').length,
    delaySegs: document.querySelectorAll('#ins-cb-delay-strip .ob-delay-seg').length,
    hourCells: document.querySelectorAll('#ins-cb-hour-strip .ob-hour-cell').length,
    windowDays: (document.getElementById('ins-cb-window') || {}).textContent,
  }));
  record('the headline answers the question closed: own-team rate, episodes, median (CE-1)',
    /55\.6% called back by the team/.test(r.head) && /18 contact episodes/.test(r.head) && /median/.test(r.head), r.head);
  record('CB-R1: the headline is the callers NOT called back, out of every episode',
    r.num === '2' && /of 18 callers who hung up/.test(r.sub) && r.tiles === 0, JSON.stringify({ num: r.num, sub: r.sub, tiles: r.tiles }));
  record('CB-R1: ONE bar whose segments add up to the episodes, own team and another team kept apart',
    r.segs.map((x) => x.seg).join(',') === 'own,other,through,pending,none'
      && r.segs.reduce((a, x) => a + x.n, 0) === 18, JSON.stringify(r.segs));
  record('CB-R1: the legend carries every segment on the same base',
    r.legend.length === 5 && /^10 · 55\.6%/.test(r.legend[0]) && /may be unrelated/.test(r.legend[1])
      && /^2 · 11\.1%.*not called back/.test(r.legend[4]), r.legend.join(' | '));
  record('CB-R1: the own-team rate carries its prior-window delta', r.deltas === 1, 'deltas=' + r.deltas);
  record('the "how fast" strip and the by-hour strip both render',
    r.delaySegs === 4 && r.hourCells === 4, 'segs=' + r.delaySegs + ' cells=' + r.hourCells);
  record('the callback window in the caption comes from the payload', r.windowDays === '3', r.windowDays);
  await page.waitForTimeout(800);
  let ch = await page.evaluate(chartDrawn);
  record('the daily callback chart is drawn (non-blank)', ch.drawn, JSON.stringify(ch));

  // Close + reopen: no re-fetch, and the chart is redrawn at a real size.
  await toggleCb(page);
  await page.waitForTimeout(400);
  await toggleCb(page);
  await page.waitForTimeout(1200);
  ch = await page.evaluate(chartDrawn);
  record('reopening repaints from the held payload (no second fetch) with a drawn chart',
    onScreen(await calls(page, 'getOutboundReport')).length === 1 && ch.drawn, JSON.stringify(ch));

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

  // CE-3: Direct lines -- PRELOADED (Step 3) with the Callbacks payload,
  // still closed, then opened, then the repeat list.
  record('CE-3 / Step 3: the Direct lines block is closed and already loaded, once',
    onScreen(await calls(page, 'getOutboundDirectCallbacks')).length === 1
      && await page.evaluate(() => !document.getElementById('ins-dl-fold').open
        && /not called back/.test(document.getElementById('ins-dl-head').textContent)));
  await page.click('#ins-dl-fold > summary');
  await page.waitForTimeout(1200);
  const dlc = onScreen(await calls(page, 'getOutboundDirectCallbacks'));
  const dl = await page.evaluate(() => ({
    head: document.getElementById('ins-dl-head').textContent,
    counts: document.getElementById('ins-dl-counts').textContent,
    // DL-R2: the summary (headline, a bar per hours group, one legend) + the table.
    num: (document.querySelector('#ins-dl-sum .ob-sum-num') || {}).textContent || '',
    bars: Array.from(document.querySelectorAll('#ins-dl-sum .ob-obar')).map((b) => Array.from(b.querySelectorAll('.ob-obar-seg'))
      .reduce((a, x) => a + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]), 0)),
    legend: Array.from(document.querySelectorAll('#ins-dl-sum .ob-leg')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    quality: (document.querySelector('#ins-dl-sum .ob-sum-quality') || {}).textContent || '',
    depts: Array.from(document.querySelectorAll('#ins-dl-table tr.ob-dl-dept')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    tiles: document.querySelectorAll('#ins-dl-content .ds-kpi').length,
    note: (function () { const n = document.getElementById('ins-dl-note'); return n && getComputedStyle(n).display !== 'none' ? n.textContent : null; })(),
  }));
  record('CE-3: opening it sends nothing new -- the ONE fetch was for the fold’s window and dept',
    dlc.length === 1 && dlc[0].from === insMeta.from && dlc[0].to === insMeta.to && dlc[0].department === insMeta.department,
    JSON.stringify(dlc));
  record('DL-R2: the headline is the callers not called back; one bar per hours group, each adding up',
    dl.num === '10' && dl.tiles === 0 && dl.bars.length === 2 && dl.bars[0] === 20 && dl.bars[1] === 10
      && /10 of 30 callers not called back/.test(dl.head), JSON.stringify(dl));
  record('DL-R2: one legend carries work · after, "by the person" and "by a teammate" apart',
    dl.legend.length === 6 && /^7 · 2\s*called back by the person/.test(dl.legend[0]) && /^4 · 1\s*by a teammate/.test(dl.legend[1])
      && /^4 · 6\s*not called back/.test(dl.legend[5]), dl.legend.join(' | '));
  record('DL-R2: after hours is timed from the next work day (8:30 CST open)',
    /1:00:00.* work hours .*0:45:00.* after hours, counted from 8:30 the next work day/.test(dl.quality), dl.quality);
  record('DL-R2: the department table, most not called back first',
    dl.depts.length === 2 && /^Sales/.test(dl.depts[0]) && /^CSR/.test(dl.depts[1]), dl.depts.join(' | '));
  record('CE-3: the counting context is kept (in "How this is counted")',
    /6 to the Sales voicemail box/.test(dl.counts) && /38 rang out or went to voicemail/.test(dl.counts), dl.counts);
  record('FO-1: misdials are counted in the context line and named as left out of the rates; a Neon payload shows no copy note',
    /3 misdials \(rang under 8 s, left out of the rates\)/.test(dl.counts) && /49 unanswered calls/.test(dl.counts)
      && dl.note === null, JSON.stringify({ counts: dl.counts, note: dl.note }));
  await page.click('#ins-dl-rep-btn');
  await page.waitForTimeout(1200);
  const rep = await calls(page, 'getOutboundDirectRepeats');
  const rl = await page.evaluate(() => {
    const list = document.getElementById('ins-dl-rep-list');
    const ep = list.querySelector('.ob-ep');
    return { eps: list.querySelectorAll('.ob-ep').length,
      head: ep ? ep.querySelector('.ob-ep-head').textContent : '',
      rows: Array.from(list.querySelectorAll('.heat-drill-row')).map((r) => r.textContent.replace(/\s+/g, ' ')),
      ids: list.querySelectorAll('.pid-copy').length };
  });
  record('CE-3: the repeat-unreturned-callers list -- lines tried, voicemail, late tag, each attempt with owner + hours',
    rep.length === 1 && rep[0].from === insMeta.from && rep[0].department === insMeta.department
      && rl.eps === 1 && /Sam Seller, Sales Voicemails/.test(rl.head) && /Voicemail box/.test(rl.head)
      && /Called back late · day 7 · own team/.test(rl.head) && rl.rows.length === 2
      && /not answered/.test(rl.rows[0]) && /rang Sam Seller/.test(rl.rows[0])
      && /after hours/.test(rl.rows[1]) && rl.ids === 2, JSON.stringify({ rep: rep, rl: rl }));
  // DL-R2: a department opens its people; a person opens THEIR unreturned callers.
  await page.click('#ins-dl-table .ob-dl-toggle[data-dl-dept="0"]');
  await page.waitForTimeout(300);
  const ppl = await page.evaluate(() => Array.from(document.querySelectorAll('#ins-dl-table tr.ob-dl-person'))
    .filter((t) => getComputedStyle(t).display !== 'none').map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
  record('DL-R2: opening a department shows its line owners, the voicemail box named',
    ppl.length === 2 && /^Sam Seller/.test(ppl[0]) && /Sales Voicemails \(voicemail box\)/.test(ppl[1]), ppl.join(' | '));
  await page.click('#ins-dl-table .ob-dl-person-btn[data-owner="Sam Seller"]');
  await page.waitForTimeout(1200);
  const pr = (await calls(page, 'getOutboundDirectRepeats')).slice(-1)[0] || {};
  const pl = await page.evaluate(() => {
    const d = document.querySelector('#ins-dl-table tr.ob-dl-drill');
    return { shown: !!d && getComputedStyle(d).display !== 'none',
      head: ((d && d.querySelector('.heat-drill-head')) || {}).textContent || '' };
  });
  record('DL-R2: a person row lists THEIR unreturned callers (owner + 1+ attempts asked)',
    pr.owner === 'Sam Seller' && pr.minAttempts === 1 && pl.shown && /Not called back · Sam Seller’s line/.test(pl.head),
    JSON.stringify({ pr: pr, pl: pl }));
  await page.click('#ins-dl-fold > summary');
  await page.waitForTimeout(300);
  await page.click('#ins-dl-fold > summary');
  await page.waitForTimeout(800);
  record('CE-3: closing and reopening the block does not re-fetch',
    onScreen(await calls(page, 'getOutboundDirectCallbacks')).length === 1);

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

  // Step 3: the outbound COLUMNS toggle never touches the Callbacks section.
  await toggleColumns(page);
  st = await page.evaluate(foldState);
  const dirOn = await page.evaluate(() => document.body.getAttribute('data-dir'));
  record('columns ON: the section stays, open, in its row', dirOn === 'both' && st.shown && st.open && st.inRow, JSON.stringify(st));
  await toggleColumns(page);
  st = await page.evaluate(foldState);
  record('columns OFF again: still there', st.shown && st.inRow, JSON.stringify(st));
  record('...and the toggle never re-fetched the report', onScreen(await calls(page, 'getOutboundReport')).length === 1);

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
        sum: ((document.querySelector('#ins-cb-kpis .ob-sum-num') || {}).textContent || '').trim(),
        // At the TOP of the screen, not merely visible: the scroll holds while
        // the sections above it finish loading (FO-3).
        inView: !!r && r.top > -2 && r.top < 120,
        top: r ? Math.round(r.top) : null,
        modal: !!document.getElementById('outbound-modal') };
    });
    record('G3: #/report/outbound lands on My Department with the Callbacks row open, loaded and held at the top of the screen -- the saved columns choice untouched',
      dl.page === 'dept' && dl.dir === 'in' && dl.shown && dl.open && dl.sum === '2' && dl.inView && !dl.modal,
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
    await boot(pn, 'index-admin.html', 'both');
    await openDept(pn, meta);
    await toggleCb(pn);
    await pn.waitForTimeout(2000);
    const n = await pn.evaluate(() => ({
      sum: ((document.querySelector('#ins-cb-kpis .ob-sum-num') || {}).textContent || '').trim(),
      sw: document.documentElement.scrollWidth, vw: window.innerWidth,
    }));
    record('360 px: the open fold renders without a sideways page scroll',
      n.sum === '2' && n.sw <= n.vw + 1, JSON.stringify(n));
    await pn.close();
  }

  // ---- manager: no fold, no fetch, even with Outbound saved -----------------
  {
    const pm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pm.on('pageerror', (e) => errors.push('manager pageerror: ' + e.message));
    await boot(pm, 'index-manager.html', 'both');
    await openDept(pm, meta);
    const m = await pm.evaluate(() => {
      const f = document.getElementById('ins-cb-fold');
      return { fold: !!f && getComputedStyle(f).display !== 'none',
        called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getOutboundReport').length };
    });
    record('manager (outbound columns saved on): the Callbacks fold is hidden and never fetches', !m.fold && m.called === 0, JSON.stringify(m));
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
