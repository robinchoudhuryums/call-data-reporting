'use strict';
/**
 * ASSERTING driver for the INLINE AGENT PANEL on My Department (Batch B).
 *
 * A click (or Enter / Space) on an agent row opens a panel in the row below:
 * a strip of the agent's days in the loaded window and the selected day's
 * Agent Day view. It replaced the row's direct drill to the Individual
 * Report, so this is the surface every manager now reaches first -- and it is
 * a DOM row living inside a table that re-renders on every sort, which is
 * exactly the shape that renders in review and breaks on a real click.
 *
 * Walk: open by click -> strip + day tiles / outbound bar + tabs render -> switch day ->
 * switch tab -> re-sort keeps it open under the same agent -> Individual
 * report button opens the modal -> Escape / Collapse close it and return
 * focus -> keyboard open -> a second agent replaces the first -> the panel
 * never widens the page at 360 px -> the CSV export never carries it.
 *
 * Run: node drive-agentpanel.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
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
    // Step 3: an admin's default is inbound + outbound together, which shows
    // the combined table; this driver walks the INBOUND table (columns off).
    localStorage.setItem('cdr.dept.direction', 'in');
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout(2500);
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  const meta = require('./payloads/meta.json');
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2500);

  const rows = page.locator('#agents-tbody tr[data-agent]');
  await rows.first().waitFor({ state: 'visible', timeout: 10000 });
  const first = await rows.nth(0).getAttribute('data-agent');
  const second = (await rows.count()) > 1 ? await rows.nth(1).getAttribute('data-agent') : null;

  const panelState = () => page.evaluate(() => {
    const p = document.getElementById('ap-panel');
    if (!p) return { open: false };
    const prev = p.previousElementSibling;
    return {
      open: true,
      under: prev ? prev.getAttribute('data-agent') : null,
      // F27: the name cell's button owns aria-expanded, not the row.
      expanded: (prev && prev.querySelector('button.ap-row-toggle'))
        ? prev.querySelector('button.ap-row-toggle').getAttribute('aria-expanded') : null,
      title: (p.querySelector('.ap-title') || {}).textContent || '',
      days: p.querySelectorAll('.ap-day').length,
      onDays: p.querySelectorAll('.ap-day.is-on').length,
      onDate: (p.querySelector('.ap-day.is-on') || { getAttribute: () => null }).getAttribute('data-ap-date'),
      dates: Array.from(p.querySelectorAll('.ap-day')).map((d) => d.getAttribute('data-ap-date')),
      // Step 1: the selected box is inside the strip's visible scroll area.
      onVisible: (function () {
        const box = p.querySelector('[data-ap-stripbox]'), on = p.querySelector('.ap-day.is-on');
        if (!box || !on) return false;
        const b = box.getBoundingClientRect(), r = on.getBoundingClientRect();
        return r.left >= b.left - 1 && r.right <= b.right + 1;
      })(),
      tiles: p.querySelectorAll('.ap-kpis .ds-kpi').length,
      // SB-1: outbound is one split bar (placed = connected + rang out + brief + unknown).
      obNum: ((p.querySelector('.ap-kpis .ob-split--out .ob-sum-num') || {}).textContent || '').trim(),
      obSum: Array.from(p.querySelectorAll('.ap-kpis .ob-split--out .ob-obar-seg'))
        .reduce((a, x) => a + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]), 0),
      obSegs: Array.from(p.querySelectorAll('.ap-kpis .ob-split--out .ob-obar-seg')).map((x) => x.getAttribute('data-seg') + ':'
        + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0])),
      tabs: Array.from(p.querySelectorAll('.ap-tab')).map((t) => t.getAttribute('data-ap-tab')),
      onTab: (p.querySelector('.ap-tab.is-on') || { getAttribute: () => null }).getAttribute('data-ap-tab'),
      callRows: p.querySelectorAll('.ap-calls tbody tr').length,
      // Step 2 1b: the From / To column and the callback cue.
      heads: Array.from(p.querySelectorAll('.ap-calls thead th')).map((t) => t.textContent.trim()),
      parties: Array.from(p.querySelectorAll('.ap-calls td.ap-party')).map((t) => t.textContent.trim()),
      note: (p.querySelector('.ap-note') || {}).textContent || '',
      loading: !!p.querySelector('.ap-loading'),
      panels: document.querySelectorAll('#ap-panel').length,
      // QF-3: the tray frame -- the panel's side edges carry the row's accent.
      frame: (function () {
        const ap = p.querySelector('.ap');
        if (!ap) return null;
        const cs = getComputedStyle(ap);
        return { left: cs.borderLeftWidth, right: cs.borderRightWidth,
          same: cs.borderLeftColor === cs.borderRightColor && cs.borderLeftStyle === 'solid',
          fitsWrap: (function () {
            const w = p.closest('.agents-table-wrap');
            return !w || ap.getBoundingClientRect().right <= w.getBoundingClientRect().right + 1;
          })() };
      })(),
    };
  });

  // ---- 0. Step 3 #8: resting the pointer on a row PREFETCHES its panel -----
  const apCalls = () => page.evaluate((a) => (window.__HARNESS__.calls || [])
    .filter((c) => (c.fn === 'getAgentDayStrip' || c.fn === 'getAgentDay') && c.args && c.args[0] && c.args[0].agentName === a)
    .map((c) => c.fn), first);
  const coldCalls = (await apCalls()).length;
  await rows.nth(0).hover();
  await page.waitForTimeout(1200);
  const warm = await apCalls();
  record('hovering a row prefetches its strip and newest day', coldCalls === 0
    && warm.filter((f) => f === 'getAgentDayStrip').length === 1 && warm.filter((f) => f === 'getAgentDay').length === 1,
    JSON.stringify({ before: coldCalls, after: warm }));

  // ---- 1. click opens it under the clicked row ----------------------------
  await rows.nth(0).click();
  await page.waitForTimeout(900);
  record('opening the hovered row sends nothing new -- it reads the prefetch', (await apCalls()).length === warm.length,
    JSON.stringify(await apCalls()));
  let st = await panelState();
  record('row click opens the panel under that row', st.open && st.under === first,
    JSON.stringify({ under: st.under, want: first }));
  record('the open row says it is expanded', st.expanded === 'true');
  record('QF-3: the panel is framed as a tray of its row (accent side edges, inside the visible table)',
    !!st.frame && st.frame.left === '3px' && st.frame.right === '1px' && st.frame.same && st.frame.fitsWrap,
    JSON.stringify(st.frame));
  record('the strip renders days, one selected',
    st.days > 1 && st.onDays === 1, 'days=' + st.days + ' on=' + st.onDays);
  // Step 1 (owner 2026-10-16): oldest-first left to right; the panel opens on
  // the NEWEST day, which is the right-hand end and scrolled into view.
  const ascending = st.dates.every((d, i) => i === 0 || st.dates[i - 1] < d);
  record('the strip runs oldest to newest, left to right', ascending, st.dates.join(','));
  record('it opens on the newest day, scrolled into view',
    st.onDate === st.dates[st.dates.length - 1] && st.onVisible,
    JSON.stringify({ on: st.onDate, last: st.dates[st.dates.length - 1], visible: st.onVisible }));
  // Each day box carries its inbound answer rate top-right, computed exactly
  // as the Answer % column does (answered / (answered + missed), whole %).
  const rates = await page.evaluate(() => Array.from(document.querySelectorAll('#ap-panel .ap-day')).map((b) => {
    const a = Number((b.querySelector('.ap-day-f b') || {}).textContent || 0);
    const m = Number((b.querySelector('.ap-day-f i') || {}).textContent || 0);
    const r = b.querySelector('.ap-day-top .ap-day-rate');
    const tinted = !!r && /\bbm-(target|watch|bad)\b/.test(r.className);
    return { want: (a + m) ? Math.round(a / (a + m) * 100) + '%' : null, got: r ? r.textContent : null, tinted };
  }));
  const badRate = rates.find((x) => x.want !== x.got || (x.want && !x.tinted));
  record('every day box shows its answer rate (Answer % formula, tinted)', rates.length > 0 && !badRate,
    badRate ? JSON.stringify(badRate) : rates.length + ' boxes');
  record('the strip says what it shows', /days? with activity/.test(st.note), st.note.slice(0, 90));
  record('the selected day renders its inbound tiles and the outbound split bar (SB-1: its parts add up to Placed)',
    // The fixture's day: 1 connected, 1 rang out (no brief, no unknown).
    st.tiles === 6 && st.obNum === '2' && st.obSum === 2 && JSON.stringify(st.obSegs) === JSON.stringify(['good:1', 'bad:1']),
    JSON.stringify({ tiles: st.tiles, obNum: st.obNum, obSum: st.obSum, obSegs: st.obSegs }));
  // Step 2 1b (owner 2026-10-16): who was on the other end, as labels.
  record('inbound calls name the caller: insurer + line, an outside caller, a colleague',
    st.heads[1] === 'From'
      && st.parties.indexOf('Acme Health · Main CSR Line') !== -1
      && st.parties.indexOf('Outside caller') !== -1
      && st.parties.indexOf('Bea Buddy (Sales)') !== -1,
    JSON.stringify({ heads: st.heads, parties: st.parties }));
  record('the day opens on the Inbound tab with its calls', st.onTab === 'in' && st.callRows > 0,
    'tab=' + st.onTab + ' rows=' + st.callRows);
  {
    const off = await page.evaluate(() => {
      const list = document.querySelector('#ap-panel .ap-list');
      const th = list && list.querySelector('thead th');
      return (list && th) ? Math.round(th.getBoundingClientRect().top - list.getBoundingClientRect().top) : null;
    });
    record('ADT-1: the Inbound list\'s header row sits at the top of the list', off !== null && Math.abs(off) <= 2, 'offset=' + off);
  }

  // ---- 2. switch day and tab ---------------------------------------------
  const firstDate = st.onDate;
  await page.locator('#ap-panel .ap-day').nth(1).click();
  await page.waitForTimeout(700);
  st = await panelState();
  record('picking another day selects it and reloads the day view',
    st.onDays === 1 && st.onDate !== firstDate && st.tiles === 6 && st.obNum === '2' && !st.loading,
    firstDate + ' -> ' + st.onDate);
  await page.locator('#ap-panel .ap-tab[data-ap-tab="out"]').click();
  await page.waitForTimeout(300);
  st = await panelState();
  record('outbound calls name the callee and carry the callback cue',
    st.heads[1] === 'To'
      && st.parties.some((t) => /^Outside number\s*↩ callback to \d{1,2}:\d{2}/.test(t))
      && st.parties.indexOf('Cal Colleague (CSR)') !== -1,
    JSON.stringify({ heads: st.heads, parties: st.parties }));
  record('the Outbound tab shows the outbound calls', st.onTab === 'out' && st.callRows > 0,
    'rows=' + st.callRows);
  const tabFocused = await page.evaluate(() =>
    !!document.activeElement && document.activeElement.getAttribute('data-ap-tab') === 'out');
  record('the tab keeps focus after it re-renders', tabFocused);
  // Admin audit aid (owner 2026-10-21): each outbound call carries its id,
  // a copy button and an OUTBOUND path drill; a manager sees none of them.
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll('#ap-panel .ap-calls tbody tr')).map((tr) => ({
    num: ((tr.querySelector('.pid-num') || {}).textContent || ''),
    copy: !!tr.querySelector('.pid-copy'),
    kind: ((tr.querySelector('.pid-journey') || { getAttribute: () => '' }).getAttribute('data-journey-kind') || ''),
  })));
  record('admin: each outbound call shows its call id, a copy button and an outbound path drill',
    ids.length > 0 && ids.every((r) => /^#oc-\d/.test(r.num) && r.copy && r.kind === 'outbound'), JSON.stringify(ids));
  // P1 (owner 2026-11-13): the chip's warn tint means ABANDONED, so an
  // outbound call's chip is neutral; and a connected call that rang 0 s reads
  // "instant" while an unanswered one keeps its ring time.
  const p1 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#ap-panel .ap-calls tbody tr'));
    const chips = rows.map((tr) => tr.querySelector('.parent-id')).filter(Boolean);
    const ringOf = (id) => {
      const tr = rows.find((x) => /^#/.test(((x.querySelector('.pid-num') || {}).textContent || '')) && x.querySelector('.pid-num').textContent === '#' + id);
      return tr ? tr.children[4].textContent.trim() : null;
    };
    const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn-soft').trim();
    return { n: chips.length, neutral: chips.every((c) => c.classList.contains('parent-id--neutral')),
      bg: chips.length ? getComputedStyle(chips[0]).backgroundColor : '', warn: warn,
      instant: ringOf('oc-3'), rang: ringOf('oc-2'), normal: ringOf('oc-1') };
  });
  record('P1: an outbound call\'s id chip is neutral, not the abandoned-call red',
    p1.n >= 3 && p1.neutral, JSON.stringify({ n: p1.n, neutral: p1.neutral, bg: p1.bg }));
  record('P1: a connected call that rang 0 s reads "instant"; other rows keep their ring time',
    p1.instant === 'instant' && p1.rang === '0:00:26' && p1.normal === '0:00:08', JSON.stringify(p1));
  const mgrIds = await page.evaluate(() => {
    const prev = window.__USER__.role;
    window.__USER__.role = 'manager';
    document.querySelector('#ap-panel .ap-tab[data-ap-tab="in"]').click();
    document.querySelector('#ap-panel .ap-tab[data-ap-tab="out"]').click();
    const n = document.querySelectorAll('#ap-panel .ap-calls .pid-num, #ap-panel .ap-calls .pid-journey').length;
    const head = Array.from(document.querySelectorAll('#ap-panel .ap-calls thead th')).map((th) => th.textContent);
    window.__USER__.role = prev;
    document.querySelector('#ap-panel .ap-tab[data-ap-tab="in"]').click();
    document.querySelector('#ap-panel .ap-tab[data-ap-tab="out"]').click();
    document.querySelector('#ap-panel .ap-tab[data-ap-tab="out"]').focus();
    return { n: n, head: head };
  });
  await page.waitForTimeout(300);
  record('manager: no call id column on the outbound calls', mgrIds.n === 0 && mgrIds.head.indexOf('Call') === -1, JSON.stringify(mgrIds));
  // AC-6 (owner 2026-11-04): the Direct tab -- calls to / from the agent's own
  // line, colleagues by name, an outside party never by number; admin-only.
  {
    await page.locator('#ap-panel .ap-tab[data-ap-tab="direct"]').click();
    await page.waitForTimeout(300);
    const dc = await page.evaluate(() => ({
      tab: (document.querySelector('#ap-panel .ap-tab[data-ap-tab="direct"]') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
      heads: Array.from(document.querySelectorAll('#ap-panel .ap-direct thead th')).map((th) => th.textContent),
      rows: Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent.replace(/\s+/g, ' ').trim())),
    }));
    // ADT-1 (owner 2026-11-06): the list's header row sits at the TOP of its
    // list -- AC-1's page-sticky offset once reached these nested tables and
    // parked the header partway down the rows. Checked here and on Inbound.
    const hdrOffset = await page.evaluate(() => {
      const list = document.querySelector('#ap-panel .ap-list');
      const th = list && list.querySelector('thead th');
      return (list && th) ? Math.round(th.getBoundingClientRect().top - list.getBoundingClientRect().top) : null;
    });
    record('ADT-1: the Direct list\'s header row sits at the top of the list, not partway down it',
      hdrOffset !== null && Math.abs(hdrOffset) <= 2, 'offset=' + hdrOffset);
    // P2 (owner 2026-11-13): the column is "Direction" (Incoming / Outgoing),
    // the headers sort, and an admin gets each call's id in a NEUTRAL chip.
    record('AC-6: the Direct tab lists the agent\'s direct calls -- direction, who, outcome, rang, talk, call id',
      /^Direct calls\s*8$/.test(dc.tab) && JSON.stringify(dc.heads) === JSON.stringify(['Time▲', 'Direction', 'With', 'Outcome', 'Rang', 'Talk', 'Call'])
        && dc.rows.length === 8 && dc.rows[0][1] === 'Outgoing' && /^Cal Colleague · internal$/.test(dc.rows[0][2]) && dc.rows[0][3] === 'Connected'
        && /^Bea Buddy · internal$/.test(dc.rows[1][2]) && /^#dc-1/.test(dc.rows[0][6])
        && dc.rows[2][2] === 'Outside caller · their direct line' && dc.rows[2][1] === 'Incoming'
        && /after hours/.test(dc.rows[3][0]) && !dc.rows.some((r) => /\d{7,}/.test(r.join(' '))), JSON.stringify(dc));
    // ADT-2 (owner 2026-11-06): a ring missed while on another call names who
    // that call was with; the summary above the list counts the rows below it.
    record('ADT-2: a call missed while on another call names who that call was with',
      dc.rows[1][3] === 'Missed (on a call with an outside caller)' && dc.rows[7][3] === 'Missed (on a call with Cal Colleague)',
      JSON.stringify([dc.rows[1][3], dc.rows[7][3]]));
    const sum = await page.evaluate(() => {
      const box = document.querySelector('#ap-panel .ap-dsum');
      const hs = box ? Array.from(box.querySelectorAll('.ap-dsum-h strong')).map((x) => Number(x.textContent.replace(/,/g, ''))) : [];
      const rowsIn = Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr')).filter((tr) => tr.children[1].textContent.trim() === 'Incoming').length;
      const rowsOut = Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr')).filter((tr) => tr.children[1].textContent.trim() === 'Outgoing').length;
      const listTop = (document.querySelector('#ap-panel .ap-list') || { getBoundingClientRect: () => ({ top: 0 }) }).getBoundingClientRect().top;
      return { has: !!box, heads: hs, rowsIn: rowsIn, rowsOut: rowsOut,
        busy: ((box && box.querySelector('.ap-dsum-busy')) || {}).textContent || '',
        text: box ? box.textContent.replace(/\s+/g, ' ') : '',
        cols: box ? box.querySelectorAll('.ap-dsum-tbl tbody tr').length : 0,
        more: ((box && box.querySelector('[data-ap-dsum-all]')) || {}).textContent || '',
        above: box ? box.getBoundingClientRect().bottom <= listTop + 1 : false };
    });
    record('ADT-2: the Direct summary sits above the list and its totals equal the rows below (calls to and from their line)',
      sum.has && sum.above && sum.heads.length === 2 && sum.heads[0] === sum.rowsIn && sum.heads[1] === sum.rowsOut,
      JSON.stringify({ heads: sum.heads, rowsIn: sum.rowsIn, rowsOut: sum.rowsOut, above: sum.above }));
    record('ADT-2: the summary names who the busy calls were with, the outside callers by how they arrived, and work vs after hours',
      /Cal Colleague/.test(sum.busy) && /an outside caller/.test(sum.busy)
        && /1 their direct line · 1 a main line/.test(sum.text) && /3 in work hours, 5 after hours/.test(sum.text)
        && /67% answered when free/.test(sum.text) && !/\d{7,}/.test(sum.text),
      JSON.stringify({ busy: sum.busy, text: sum.text.slice(0, 400) }));
    await page.locator('#ap-panel [data-ap-dsum-all]').click();
    await page.waitForTimeout(250);
    const all = await page.evaluate(() => ({
      cols: document.querySelectorAll('#ap-panel .ap-dsum-tbl tbody tr').length,
      more: ((document.querySelector('#ap-panel [data-ap-dsum-all]')) || {}).textContent || '',
      focus: document.activeElement && document.activeElement.hasAttribute('data-ap-dsum-all'),
      tabOn: ((document.querySelector('#ap-panel .ap-tab.is-on')) || { getAttribute: () => '' }).getAttribute('data-ap-tab') }));
    record('ADT-2: the colleagues list shows the top 5 and "Show all" lists every colleague, keeping focus and the tab',
      sum.cols === 5 && sum.more === 'Show all 6' && all.cols === 6 && all.more === 'Show the top 5' && all.focus && all.tabOn === 'direct',
      JSON.stringify({ before: [sum.cols, sum.more], after: all }));
    // P2 (owner 2026-11-13): outside-number calls the agent PLACED are on the
    // Outbound tab -- one "+N" line here, never a list row or the headline.
    const p2 = await page.evaluate(() => {
      const box = document.querySelector('#ap-panel .ap-dsum');
      const rows = Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr'));
      const cols = box && box.querySelector('.ap-dsum-cols');
      return { ext: ((box && box.querySelector('.ap-dsum-ext')) || {}).textContent || '',
        heads: box ? Array.from(box.querySelectorAll('.ap-dsum-h')).map((x) => x.textContent.replace(/\s+/g, ' ').trim()) : [],
        outsideOut: rows.filter((tr) => tr.children[1].textContent.trim() === 'Outgoing' && !/internal/.test(tr.children[2].textContent)).length,
        colHeads: box ? Array.from(box.querySelectorAll('.ap-dsum-tbl thead th')).map((x) => x.textContent) : [],
        overrun: cols ? cols.scrollWidth - cols.clientWidth : -1,
        chipsNeutral: Array.from(document.querySelectorAll('#ap-panel .ap-direct .parent-id')).every((c) => c.classList.contains('parent-id--neutral')),
        busySeg: !!document.querySelector('#ap-panel .ap-dsum .ob-seg-busy'), softSeg: !!document.querySelector('#ap-panel .ap-dsum .ob-seg-soft') };
    });
    record('P2: a call placed to an outside number is one "+N" line, not a list row or the headline',
      /^\+1 to outside numbers \(1 connected\) — listed under Outbound calls$/.test(p2.ext) && p2.outsideOut === 0
        && /^3 calls to colleagues$/.test(p2.heads[1] || ''), JSON.stringify(p2));
    record('P2: the colleague table says Outgoing / Incoming and stays inside its card',
      JSON.stringify(p2.colHeads) === JSON.stringify(['Colleague', 'Outgoing', 'Incoming']) && p2.overrun <= 1 && p2.chipsNeutral,
      JSON.stringify({ colHeads: p2.colHeads, overrun: p2.overrun, chipsNeutral: p2.chipsNeutral }));
    record('P1: "missed while on another call" has its own (yellow) segment, not the soft red',
      p2.busySeg && !p2.softSeg, JSON.stringify({ busy: p2.busySeg, soft: p2.softSeg }));
    // Filter, then sort: the count line says what is showing, focus stays put.
    await page.locator('#ap-panel [data-ap-dfilter="way"]').selectOption('out');
    await page.waitForTimeout(250);
    const flt = await page.evaluate(() => ({
      rows: Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr')).map((tr) => tr.children[1].textContent.trim()),
      n: (document.querySelector('#ap-panel .ap-dfilter-n') || {}).textContent || '',
      focus: !!document.activeElement && document.activeElement.getAttribute('data-ap-dfilter') === 'way',
      tab: (document.querySelector('#ap-panel .ap-tab[data-ap-tab="direct"]') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim() }));
    record('P2: filtering by direction keeps only those rows, says "showing 3 of 8", and keeps focus on the filter',
      flt.rows.length === 3 && flt.rows.every((x) => x === 'Outgoing') && flt.n === 'showing 3 of 8' && flt.focus && /^Direct calls\s*8$/.test(flt.tab),
      JSON.stringify(flt));
    await page.locator('#ap-panel [data-ap-dfilter="way"]').selectOption('all');
    await page.waitForTimeout(200);
    await page.locator('#ap-panel [data-ap-dsort="talk"]').click();
    await page.waitForTimeout(200);
    await page.locator('#ap-panel [data-ap-dsort="talk"]').click();
    await page.waitForTimeout(250);
    const srt = await page.evaluate(() => ({
      first: Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr')).slice(0, 2).map((tr) => tr.children[5].textContent.trim()),
      last: (Array.from(document.querySelectorAll('#ap-panel .ap-direct tbody tr')).pop() || { children: [] }).children[5].textContent.trim(),
      aria: (document.querySelector('#ap-panel [data-ap-dsort="talk"]') || { parentElement: { getAttribute: () => '' } }).parentElement.getAttribute('aria-sort'),
      focus: !!document.activeElement && document.activeElement.getAttribute('data-ap-dsort') === 'talk' }));
    record('P2: a second click on Talk sorts longest first, blanks last, with aria-sort and focus kept',
      srt.first[0] === '0:03:30' && srt.first[1] === '0:01:35' && srt.last === '–' && srt.aria === 'descending' && srt.focus,
      JSON.stringify(srt));
    await page.locator('#ap-panel .ap-tab[data-ap-tab="out"]').click();
    await page.waitForTimeout(300);
    await page.locator('#ap-panel .ap-tab[data-ap-tab="out"]').focus();
  }
  // UI-1 (broad-scan 2026-10-12): the tabs keyboard model -- arrows move
  // selection AND focus, only the selected tab is in the Tab order.
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const kb = await page.evaluate(() => {
    const a = document.activeElement;
    const tabs = Array.from(document.querySelectorAll('#ap-panel .ap-tab'));
    return { focused: a && a.getAttribute('data-ap-tab'),
             on: (document.querySelector('#ap-panel .ap-tab.is-on') || { getAttribute: () => null }).getAttribute('data-ap-tab'),
             tabindex: tabs.map((t) => t.getAttribute('data-ap-tab') + ':' + t.getAttribute('tabindex')).join(','),
             labelled: (document.querySelector('#ap-panel .ap-list') || { getAttribute: () => null }).getAttribute('aria-labelledby') };
  });
  record('UI-1: ArrowLeft from Outbound selects and focuses Inbound (roving tabindex)',
    kb.focused === 'in' && kb.on === 'in' && /^in:0,out:-1/.test(kb.tabindex) && kb.labelled === 'ap-tab-in', JSON.stringify(kb));
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  const endTab = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('#ap-panel .ap-tab'));
    const a = document.activeElement;
    return (a && a.getAttribute('data-ap-tab')) === tabs[tabs.length - 1].getAttribute('data-ap-tab');
  });
  record('UI-1: End jumps to the last tab', endTab);

  // ---- 3. a re-render keeps it under the same agent ------------------------
  await page.click('#agents-table thead th[data-sort]');
  await page.waitForTimeout(500);
  st = await panelState();
  record('a re-sort keeps the panel open under the same agent',
    st.open && st.under === first && st.panels === 1, JSON.stringify({ under: st.under }));

  // ---- 4. the Individual Report is one button away -----------------------
  await page.click('#ap-panel [data-ap-ir]');
  await page.waitForTimeout(2000);
  const irOpen = await page.evaluate(() => {
    const m = document.getElementById('individual-modal');
    return !!m && getComputedStyle(m).display !== 'none';
  });
  record('"Individual report" opens the Individual Report', irOpen);
  if (irOpen) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(700);
    // B3/CL-14: focus returns to the panel's button, never the Reports menu's
    // launcher (hidden for a manager) or <body>.
    const back = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? (a.hasAttribute('data-ap-ir') ? 'ap-ir' : (a.id || a.tagName)) : 'none';
    });
    record('closing the Individual Report returns focus to the panel\'s button', back === 'ap-ir', 'focus=' + back);
  }

  // ---- 5. Escape and Collapse close it and hand focus back ---------------
  await page.locator('#ap-panel .ap-day').first().focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  st = await panelState();
  let focusOn = await page.evaluate(() => (document.activeElement && document.activeElement.classList.contains('ap-row-toggle')) ? document.activeElement.closest('tr').getAttribute('data-agent') : null);
  record('Escape inside the panel closes it and focuses the row\'s name button', !st.open && focusOn === first,
    'focus=' + focusOn);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  st = await panelState();
  record('Enter on the focused name button opens it again', st.open && st.under === first);
  // Owner 2026-10-21: the panel slides open and shut. Settled = unclipped
  // (the inner panel's sticky-left needs it); a closing panel loses its id
  // at once and leaves the DOM when its slide ends.
  const settled = await page.evaluate(() => {
    const r = document.getElementById('ap-panel');
    const inner = r && r.querySelector('.ap-clip-in');
    return { shown: !!(r && r.classList.contains('ap-shown')), settled: !!(r && r.classList.contains('ap-settled')),
             overflow: inner ? getComputedStyle(inner).overflow : null,
             rows: getComputedStyle(r.querySelector('.ap-clip')).gridTemplateRows };
  });
  record('the open panel has slid fully open and is unclipped', settled.shown && settled.settled && settled.overflow === 'visible',
    JSON.stringify(settled));
  const closing = await page.evaluate(() => {
    document.querySelector('#ap-panel [data-ap-close]').click();
    const ghost = document.querySelector('#agents-tbody tr.ap-row, #agents-ob-tbody tr.ap-row');
    return { idGone: !document.getElementById('ap-panel'), ghost: !!ghost, inert: !!(ghost && ghost.hasAttribute('inert')),
             sliding: !!(ghost && !ghost.classList.contains('ap-shown')) };
  });
  await page.waitForTimeout(400);
  const gone = await page.evaluate(() => document.querySelectorAll('tr.ap-row').length);
  record('Collapse slides the panel shut: detached at once (no id, inert), removed when the slide ends',
    closing.idGone && closing.ghost && closing.inert && closing.sliding && gone === 0, JSON.stringify({ closing: closing, left: gone }));
  st = await panelState();
  focusOn = await page.evaluate(() => (document.activeElement && document.activeElement.classList.contains('ap-row-toggle')) ? document.activeElement.closest('tr').getAttribute('data-agent') : null);
  record('Collapse closes it and focuses the row\'s name button', !st.open && focusOn === first);
  const expandedLeft = await page.evaluate(() =>
    document.querySelectorAll('#agents-tbody tr[data-agent][aria-expanded], #agents-tbody button.ap-row-toggle[aria-expanded="true"]').length);
  record('no row is left marked expanded', expandedLeft === 0, 'n=' + expandedLeft);
  const collapsedSays = await page.evaluate((a) => {
    const tr = Array.from(document.querySelectorAll('#agents-tbody tr[data-agent]')).find((r) => r.getAttribute('data-agent') === a);
    const b = tr && tr.querySelector('button.ap-row-toggle');
    return b ? b.getAttribute('aria-expanded') : null;
  }, first);
  record('F27: the closed row\'s button says aria-expanded=false (never removed)', collapsedSays === 'false',
    'aria-expanded=' + collapsedSays);

  // ---- 6. one agent at a time ---------------------------------------------
  if (second) {
    await rows.nth(0).click();
    await page.waitForTimeout(700);
    await page.locator('#agents-tbody tr[data-agent="' + second.replace(/"/g, '\\"') + '"]').first().click();
    await page.waitForTimeout(800);
    st = await panelState();
    record('a second agent replaces the first (one panel)', st.panels === 1 && st.under === second,
      JSON.stringify({ under: st.under, panels: st.panels }));
  } else {
    record('a second agent replaces the first (one panel)', true, 'skipped -- one-agent fixture');
  }

  // ---- 7. the panel never leaks into the export ---------------------------
  await page.evaluate(() => {
    window.__CSV__ = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { blob.text().then(function (t) { window.__CSV__.push(t); }); } catch (e) {}
      return realCreate(blob);
    };
  });
  const menuBtn = page.locator('#csv-export-btn');
  if (await menuBtn.count()) { await menuBtn.click(); await page.waitForTimeout(300); }
  // The My Department export menu's item specifically (the Overview's
  // Callbacks by department section has its own, EARLIER, "Download CSV").
  await page.evaluate(() => {
    const hit = document.querySelector('#dept-export-menu [data-action="csv"]');
    if (hit) hit.click();
  });
  await page.waitForTimeout(700);
  const csv = await page.evaluate(() => (window.__CSV__ || [])[0] || null);
  const stillOpen = (await panelState()).open;
  record('the panel is still open while exporting', stillOpen);
  if (csv == null) {
    record('CSV export ignores the open panel', false, 'no CSV writer reachable');
  } else {
    record('CSV export ignores the open panel',
      !/Days with activity|Individual report|Inbound calls/.test(csv), csv.split('\n').length + ' lines');
  }

  // ---- 8. narrow viewport: the panel never widens the page ----------------
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(600);
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: window.innerWidth,
    panel: (document.querySelector('#ap-panel .ap') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
  }));
  record('at 360 px the open panel causes no horizontal page overflow',
    over.doc <= over.win + 1 && over.panel > 0 && over.panel <= over.win, JSON.stringify(over));

  // ---- hygiene ------------------------------------------------------------
  // drive-smoke's UNMOCKED_OK: getInboundHeatmap is Neon-backed and must hide
  // silently on failure, so its "unmocked" report is part of the audit.
  const unmocked = await page.evaluate(() => ((window.__HARNESS__ || {}).unmocked || [])
    .filter((n) => ['getInboundHeatmap', 'logReportUsage'].indexOf(n) === -1));
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
