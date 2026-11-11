'use strict';
/**
 * ASSERTING driver for the My Department outbound columns and the Team
 * Outbound side panel (Batch D). Step 3 (owner 2026-10-16): inbound and
 * outbound are TOGETHER by default for the admin -- the three-way Inbound |
 * Outbound | Both switch became one "Show outbound columns" toggle (on =
 * Both, off = the classic inbound table); the Outbound-only view is retired.
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
    await page.addInitScript(() => { localStorage.setItem('cdr.dept.direction', 'both'); });
    await page.goto('file://' + path.join(__dirname, 'site', 'index-manager.html'));
    await page.waitForTimeout(2500);
    await openDept(page, meta);
    const st = await page.evaluate(() => ({
      sw: getComputedStyle(document.getElementById('dept-dir-switch')).display,
      inShown: getComputedStyle(document.getElementById('agents-in-wrap')).display !== 'none',
      obShown: getComputedStyle(document.getElementById('agents-ob-wrap')).display !== 'none',
      called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDeptOutboundSummary').length,
    }));
    record('manager: the outbound columns toggle is hidden', st.sw === 'none', st.sw);
    const tdcM = await page.evaluate(() => { const el = document.getElementById('dept-team-direct');
      return { shown: !!el && getComputedStyle(el).display !== 'none',
               called: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDirectCallReport').length }; });
    record('manager: no Team Direct Calls card and no direct-call request (D3, admin-only)', !tdcM.shown && tdcM.called === 0, JSON.stringify(tdcM));
    record('manager: a stored "columns on" preference still shows the INBOUND table',
      st.inShown && !st.obShown, JSON.stringify(st));
    // Owner 2026-10-22: the CSR manager's table carries Transfer % -- the same
    // data the Transfer % tile already shows them -- and sorting by it sinks
    // an agent with no transfer row in BOTH directions.
    // CSR's own group: the combined view sorts WITHIN each department.
    const order = async () => page.evaluate(() => Array.from(document.querySelectorAll('#agents-tbody tr[data-agent][data-dept="CSR"]')).map((r) => r.getAttribute('data-agent')));
    const thShown = await page.evaluate(() => { const th = document.querySelector('#agents-table thead th[data-sort="transferPct"]');
      return !!th && getComputedStyle(th).display !== 'none'; });
    record('manager: the CSR table shows the Transfer % column', thShown);
    await page.click('#agents-table thead th[data-sort="transferPct"]'); await page.waitForTimeout(300);
    const o1 = await order();
    await page.click('#agents-table thead th[data-sort="transferPct"]'); await page.waitForTimeout(300);
    const o2 = await order();
    record('manager: sorting by Transfer % keeps an agent with no transfer row last, either way',
      o1.length > 2 && o1[o1.length - 1] === 'Robin Choudhury' && o2[o2.length - 1] === 'Robin Choudhury'
        && o1[0] !== o2[0], o1.join(',') + ' | ' + o2.join(','));
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
      heads: Array.from(document.querySelectorAll('#agents-ob-thead tr:not(.lb-groups) th')).map((t) => t.textContent.replace(/[▲▼▽]/g, '').trim()),
      total: (document.querySelector('#agents-ob-tfoot tr') || {}).textContent || '',
      note: (document.getElementById('agents-ob-note') || {}).textContent || '',
      noteShown: vis('agents-ob-note'),
      info: (document.getElementById('dqe-table-info') || { getAttribute: () => '' }).getAttribute('title') || '',
      infoShown: vis('dqe-table-info'),
      dcShown: vis('agents-dc-wrap'),
      dcRows: document.querySelectorAll('#agents-dc-tbody tr[data-agent]').length,
      tdc: vis('dept-team-direct'),
      tobRows: document.querySelectorAll('#tob-tbody tr.trp-row').length,
      tobTiles: (document.getElementById('tob-tiles') || {}).textContent || '',
      tobBar: Array.from(document.querySelectorAll('#tob-tiles .ob-obar-seg'))
        .reduce((a, x) => a + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]), 0),
    };
  });

  // DV-1: the segmented switch.
  const pick = async (d) => { await page.click('#dept-dir-switch [data-dir-pick="' + d + '"]'); await page.waitForTimeout(900); };
  const pressed = (d) => page.getAttribute('#dept-dir-switch [data-dir-pick="' + d + '"]', 'aria-pressed');

  let v = await view();
  record('admin: inbound AND outbound together is the default view (Step 3)',
    v.dir === 'both' && v.obShown && !v.inShown, JSON.stringify(v).slice(0, 120));
  record('DV-1: "Inbound + outbound" reads pressed, the other three not',
    (await pressed('both')) === 'true' && (await pressed('in')) === 'false' && (await pressed('out')) === 'false' && (await pressed('direct')) === 'false');
  // LB-2 (owner 2026-10-28): one header per column, each sorting by click.
  record('LB-2: the headers are Agent, Answered / missed, Ans %, Connected / not, Conn %, Talk · avg, Transfer %',
    JSON.stringify(v.heads) === JSON.stringify(['Agent', 'Answered / missed', 'Ans %', 'Connected / not', 'Conn %', 'Talk · avg', 'Transfer %']), v.heads.join(' | '));
  {
    // AC-2 (owner 2026-11-04): the Talk cell carries each direction's average.
    const tk = await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]'))
        .find((t) => t.querySelector('.lb-talk-in') && t.querySelector('.lb-talk-out .lb-att'));
      return r ? { inn: r.querySelector('.lb-talk-in').textContent.replace(/\s+/g, ' ').trim(),
        out: r.querySelector('.lb-talk-out').textContent.replace(/\s+/g, ' ').trim() } : null;
    });
    record('AC-2: the Talk cell shows total talk and the average per call, inbound and outbound',
      !!tk && /in · avg \d+:\d{2}:\d{2}$/.test(tk.inn) && /out · avg \d+:\d{2}:\d{2}$/.test(tk.out), JSON.stringify(tk));
    // AC-1: at desktop width the header row rides the page under the controls strip.
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await page.evaluate(() => document.querySelector('#agents-ob-thead tr:not(.lb-groups) th').getBoundingClientRect().top);
    await page.evaluate(() => { const t = document.getElementById('agents-ob-table'); window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY + 200); });
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => {
      const th = document.querySelector('#agents-ob-thead tr:not(.lb-groups) th');
      const strip = document.querySelector('#dept-page .controls');
      return { th: Math.round(th.getBoundingClientRect().top), strip: Math.round(strip.getBoundingClientRect().bottom),
        wrapOverflow: getComputedStyle(document.getElementById('agents-ob-wrap')).overflowX };
    });
    record('AC-1: scrolled past the table top, its header row sticks just under the dept controls strip',
      st.wrapOverflow === 'visible' && Math.abs(st.th - st.strip) <= 2 && before > st.th, JSON.stringify(Object.assign({ before: Math.round(before) }, st)));
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  {
    // Owner 2026-10-22: layout B carries Transfer % too (CSR), one value per
    // agent, the same figure the classic table shows.
    const sum30 = require('./payloads/summary-30d.json');
    const dev = ((sum30.csrTransfer || {}).agents || []).find((a) => a.agent === 'Dev Patel');
    const xb = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('#agents-ob-thead tr:not(.lb-groups) th'));
      const idx = heads.findIndex((th) => /^Transfer %/.test(th.textContent.trim()));
      const row = document.querySelector('#agents-ob-tbody tr[data-agent="Dev Patel"]');
      return { idx: idx, cell: (row && idx >= 0 && row.cells[idx]) ? row.cells[idx].textContent.trim() : null };
    });
    record('a Transfer % column shows each agent\'s rate', xb.idx > 0 && !!dev && xb.cell === dev.pct.toFixed(1) + '%',
      JSON.stringify(xb) + ' want ' + (dev ? dev.pct : '?'));
  }
  {
    const shown = await page.evaluate(() => Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]')).map((r) => r.getAttribute('data-agent')));
    const missing = ob.agents.map((a) => a.agent).filter((a) => shown.indexOf(a) === -1);
    record('every agent the outbound payload carries has a row', !missing.length, 'missing=' + missing.join(', '));
  }
  record('the total row shows the payload’s connected / not-connected totals',
    v.total.indexOf(ob.totals.obConnected + '/' + (ob.totals.obTotal - ob.totals.obConnected)) !== -1,
    v.total.slice(0, 120));
  record('the team per-day figure renders on the total row', v.total.indexOf(ob.totals.obPerDay + ' / day') !== -1,
    'want ' + ob.totals.obPerDay);
  record('AT-1: the table\'s ⓘ says what Connected means and that exports stay inbound; no standing note over the table',
    v.infoShown && /far end answered/.test(v.info) && /inbound table/.test(v.info) && !v.noteShown, JSON.stringify({ info: v.info.slice(0, 90), note: v.note }));
  record('the off-roster dialler is disclosed (in the ⓘ), not shown', /1 dialler/.test(v.info)
    && !(await page.locator('#agents-ob-tbody tr[data-agent="Off Roster Dialler"]').count()));
  record('Team Rings stays and Team Outbound shows beside it', v.rings && v.tob && v.tobRows === ob.agents.length,
    JSON.stringify({ tob: v.tob, rings: v.rings, rows: v.tobRows }));
  record('Team Outbound shows the payload total as a slim bar whose parts add up to it (SB-3)',
    v.tobTiles.indexOf(String(ob.totals.obTotal)) !== -1 && v.tobBar === ob.totals.obTotal, JSON.stringify({ text: v.tobTiles.slice(0, 60), bar: v.tobBar }));
  record('a parent view groups the rows with per-dept subtotals',
    (await page.locator('#agents-ob-tbody tr.subq-subtotal').count()) === (ob.deptGroups ? ob.deptGroups.length : 0));
  const overlap = await page.evaluate(() => {
    const a = document.getElementById('dept-team-rings').getBoundingClientRect();
    const b = document.getElementById('dept-team-outbound').getBoundingClientRect();
    return { aBottom: Math.round(a.bottom), bTop: Math.round(b.top) };
  });
  record('the two side panels never overlap', overlap.aBottom <= overlap.bTop + 1, JSON.stringify(overlap));
  // LB-2 (owner 2026-10-28, Option B): ONE line per agent -- an inbound bar
  // column and an outbound bar column, each on its own scale, each bar's
  // parts adding up to the counts beside it with the per-day pace under them.
  const lb = await page.evaluate(() => {
    const num = (x) => parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]);
    const rows = Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]'));
    const cell = (td) => {
      const bar = td && td.querySelector('.lb-track .ob-obar');
      const w = bar ? parseFloat(bar.parentElement.style.width) : 0;
      const n = td && td.querySelector('.lb-n');
      return { segs: bar ? Array.from(bar.querySelectorAll('.ob-obar-seg')).map((x) => x.getAttribute('data-seg') + ':' + num(x)) : [],
        sum: bar ? Array.from(bar.querySelectorAll('.ob-obar-seg')).reduce((a, x) => a + num(x), 0) : 0,
        nums: n ? n.textContent.split('/').map(Number) : [], per: ((td && td.querySelector('.lb-sub')) || {}).textContent || '',
        width: w, tip: ((td && td.querySelector('.lb-cell')) || { getAttribute: () => '' }).getAttribute('title') || '' };
    };
    return {
      cells: rows[0] ? rows[0].querySelectorAll(':scope > td').length : 0,
      lines: document.querySelectorAll('#agents-ob-table .ob-line').length,
      groups: Array.from(document.querySelectorAll('#agents-ob-thead tr.lb-groups th.lb-g')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      heads: Array.from(document.querySelectorAll('#agents-ob-thead tr:not(.lb-groups) th[data-ob-sort]')).map((t) => t.getAttribute('data-ob-sort')),
      rows: rows.map((r) => { const tds = r.querySelectorAll(':scope > td');
        return { agent: r.getAttribute('data-agent'), inb: cell(tds[1]), out: cell(tds[3]) }; }),
    };
  });
  const rowsIn = lb.rows.filter((r) => r.inb.segs.length);
  const rowsOut = lb.rows.filter((r) => r.out.segs.length);
  record('LB-2: one line per agent -- 7 cells on CSR (agent, inbound, Ans %, outbound, Conn %, Talk, Transfer %), no IN / OUT lines',
    lb.cells === 7 && lb.lines === 0 && JSON.stringify(lb.heads) === JSON.stringify(['agent', 'inRung', 'answerRate', 'obTotal', 'obConnectRate', 'talkAll', 'transferPct']),
    JSON.stringify({ cells: lb.cells, lines: lb.lines, heads: lb.heads }));
  record('LB-2: a group row names each direction with its colour key',
    lb.groups.length === 2 && /^Inbound · rings\s*answered\s*missed$/i.test(lb.groups[0])
      && /^Outbound · placed\s*connected\s*rang out\s*brief ring\s*not recorded$/i.test(lb.groups[1]),
    JSON.stringify(lb.groups));
  record('LB-2: every inbound bar adds up to its answered / missed, with ans/day under it',
    rowsIn.length > 0 && rowsIn.every((r) => r.inb.sum === r.inb.nums[0] + r.inb.nums[1] && /ans\/day$/.test(r.inb.per)),
    JSON.stringify(rowsIn.slice(0, 2).map((r) => r.inb)));
  record('LB-2: every outbound bar is connected / rang out / brief / unknown adding up to connected + not, with / day under it',
    rowsOut.length > 0 && rowsOut.every((r) => r.out.sum === r.out.nums[0] + r.out.nums[1] && / \/ day$/.test(r.out.per)
      && r.out.segs.every((x) => /^(oconn|oreal|obrief|unk):/.test(x)) && /^oconn:/.test(r.out.segs[0])),
    JSON.stringify(rowsOut.slice(0, 2).map((r) => r.out.segs)));
  const maxW = (list, k) => Math.max.apply(null, list.map((r) => r[k].width));
  record('LB-2: each direction on its OWN scale -- the largest inbound and the largest outbound bar both fill the column',
    maxW(rowsIn, 'inb') === 100 && maxW(rowsOut, 'out') === 100, JSON.stringify({ in: maxW(rowsIn, 'inb'), out: maxW(rowsOut, 'out') }));

  // Batch F / LB-2: the rates carry the chips; the count changes are in the
  // bar's hover text, from the SAME INV-28 window the inbound E5 chips use.
  {
    const sum30 = require('./payloads/summary-30d.json');
    const pri = (require('./payloads/dept-outbound-windows.json'))[sum30.meta.priorFrom + '|' + sum30.meta.priorTo];
    const c = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]')).filter((r) => r.querySelector('.ob-c'));
      return {
        perRow: rows.map((r) => r.querySelectorAll('.wow-chip').length),
        inBar: rows.map((r) => r.querySelectorAll('td.lb-bar-td .wow-chip').length).reduce((a, b) => a + b, 0),
        first: rows[0] ? { agent: rows[0].getAttribute('data-agent'), conn: Number(rows[0].querySelector('.ob-c').textContent),
          tip: rows[0].querySelector('.lb-cell--out').getAttribute('title') } : null,
        totals: document.querySelectorAll('#agents-ob-tfoot .wow-chip, #agents-ob-tbody tr.subq-subtotal .wow-chip').length,
      };
    });
    record('Batch F: the prior window is captured for this view', !!pri, sum30.meta.priorFrom + '|' + sum30.meta.priorTo);
    record('LB-2: each row chips its two rates (answered %, connected %) and no count', c.perRow.length > 0
      && c.perRow.every((n) => n === 2) && c.inBar === 0, JSON.stringify({ perRow: c.perRow, inBar: c.inBar }));
    const pa = pri && c.first && pri.agents.filter((a) => a.agent === c.first.agent)[0];
    const want = pa ? c.first.conn - pa.obConnected : NaN;
    const m = c.first && /vs the prior period: connected ([+−±])(\d+)/.exec(c.first.tip);
    const got = m ? (m[1] === '−' ? -Number(m[2]) : Number(m[2])) : NaN;
    record('LB-2: the outbound bar’s hover gives the connected change (current minus prior for that agent)',
      pa && got === want, (c.first && c.first.tip.slice(0, 160)) + ' want ' + want);
    record('Batch F: Total and subtotal rows carry no chips', c.totals === 0, 'chips=' + c.totals);
  }

  // LB-2: every header sorts by click and by keyboard.
  {
    const order = () => page.evaluate(() => {
      const out = [];
      for (const r of Array.from(document.querySelectorAll('#agents-ob-tbody tr'))) {
        if (r.classList.contains('subq-subtotal')) break;
        if (r.hasAttribute('data-agent')) out.push(r.getAttribute('data-agent'));
      }
      return out;
    });
    const mono = (vals) => vals.every((x, i) => i === 0 || (vals[i - 1] - x) * (vals[0] - vals[vals.length - 1] >= 0 ? 1 : -1) >= 0);
    const byAgent = {};
    ob.agents.forEach((a) => { byAgent[a.agent] = a.obTotal; });
    await page.click('#agents-ob-thead th[data-ob-sort="obTotal"]');
    await page.waitForTimeout(300);
    const o1 = await order();
    const placed = o1.map((a) => byAgent[a] || 0);
    const ariaOut = await page.getAttribute('#agents-ob-thead th[data-ob-sort="obTotal"]', 'aria-sort');
    record('LB-2: the outbound header sorts the group by placed, and says so',
      o1.length > 1 && mono(placed) && /ascending|descending/.test(ariaOut || ''), JSON.stringify({ order: o1, placed: placed, aria: ariaOut }));
    await page.focus('#agents-ob-thead th[data-ob-sort="inRung"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const kb = await page.evaluate(() => ({ aria: (document.querySelector('#agents-ob-thead th[data-ob-sort="inRung"]') || { getAttribute: () => null }).getAttribute('aria-sort'),
      focus: !!document.activeElement && document.activeElement.getAttribute('data-ob-sort') === 'inRung' }));
    record('LB-2: the inbound header sorts by keyboard too and keeps the focus', /ascending|descending/.test(kb.aria || '') && kb.focus, JSON.stringify(kb));
    await page.click('#agents-ob-thead th[data-ob-sort="talkAll"]');
    await page.waitForTimeout(300);
    const talk = await page.evaluate(() => {
      const hms = (t) => { const p = (t || '').trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0; };
      const out = [];
      for (const r of Array.from(document.querySelectorAll('#agents-ob-tbody tr'))) {
        if (r.classList.contains('subq-subtotal')) break;
        if (!r.hasAttribute('data-agent')) continue;
        const i = r.querySelector('.lb-talk-in'), o = r.querySelector('.lb-talk-out');
        out.push(hms(i ? i.firstChild.textContent : '') + hms(o ? o.firstChild.textContent : ''));
      }
      return out;
    });
    record('LB-2: Talk sorts by inbound + outbound talk together', talk.length > 1 && mono(talk), JSON.stringify(talk));
  }

  // Sorting by a column re-renders and keeps the rows.
  await page.click('#agents-ob-thead th[data-ob-sort="agent"]');
  await page.waitForTimeout(300);
  const firstGroup = await page.evaluate(() => {
    const out = [];
    for (const r of Array.from(document.querySelectorAll('#agents-ob-tbody tr'))) {
      if (r.classList.contains('subq-subtotal')) break;
      if (r.hasAttribute('data-agent')) out.push(r.getAttribute('data-agent'));
    }
    return out;
  });
  const sortedA = firstGroup.slice().sort((x, y) => x.localeCompare(y));
  const sortedD = sortedA.slice().reverse();
  record('sorting by Agent orders the rows within the group',
    firstGroup.length > 1 && (firstGroup.join('|') === sortedA.join('|') || firstGroup.join('|') === sortedD.join('|')),
    firstGroup.slice(0, 4).join(', '));

  // The inline agent panel opens from a row of the combined table too.
  await page.locator('#agents-ob-tbody tr[data-agent]').first().click();
  await page.waitForTimeout(900);
  const panel = await page.evaluate(() => {
    const p = document.getElementById('ap-panel');
    return { open: !!p, inOb: !!p && !!p.closest('#agents-ob-tbody') };
  });
  record('a combined-table row opens the inline agent panel beneath it', panel.open && panel.inOb, JSON.stringify(panel));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---- DV-1: the four views ------------------------------------------------
  await pick('in');
  v = await view();
  record('Inbound restores the original inbound table and Team Rings only, with no ⓘ',
    v.dir === 'in' && v.inShown && !v.obShown && !v.dcShown && v.rings && !v.tob && !v.infoShown,
    JSON.stringify({ dir: v.dir, i: v.inShown, o: v.obShown, rings: v.rings, tob: v.tob, info: v.infoShown }));
  record('the Inbound button reads pressed', (await pressed('in')) === 'true' && (await pressed('both')) === 'false');
  let stored = await page.evaluate(() => localStorage.getItem('cdr.dept.direction'));
  record('the view persists per browser', stored === 'in', String(stored));
  await pick('out');
  v = await view();
  record('DV-1: Outbound shows the outbound-only table (Agent, Connected / not, Conn %, Talk · avg) and Team Outbound, not Team Rings',
    v.dir === 'out' && v.obShown && !v.inShown && !v.dcShown && !v.rings && v.tob
      && JSON.stringify(v.heads) === JSON.stringify(['Agent', 'Connected / not', 'Conn %', 'Talk · avg']),
    JSON.stringify({ dir: v.dir, heads: v.heads, rings: v.rings, tob: v.tob }));
  {
    // AC-4 (owner 2026-11-04): the Outbound view lists only agents who placed a call.
    const empt = await page.evaluate(() => Array.from(document.querySelectorAll('#agents-ob-tbody tr[data-agent]'))
      .filter((t) => !t.querySelector('.lb-cell--out')).map((t) => t.getAttribute('data-agent')));
    record('AC-4: no agent row without outbound calls in the Outbound view', empt.length === 0, empt.join(', '));
  }
  {
    const out = await page.evaluate(() => ({
      groups: Array.from(document.querySelectorAll('#agents-ob-thead tr.lb-groups th.lb-g')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      cells: (document.querySelector('#agents-ob-tbody tr[data-agent]') || { querySelectorAll: () => [] }).querySelectorAll(':scope > td').length,
      xfer: !!document.querySelector('#agents-ob-thead [data-ob-sort="transferPct"]'),
    }));
    record('DV-1: the Outbound view has one direction group, four cells a row and no Transfer %',
      out.groups.length === 1 && /^Outbound · placed/.test(out.groups[0]) && out.cells === 4 && !out.xfer, JSON.stringify(out));
  }
  record('DV-1: Outbound keeps the ⓘ', v.infoShown && /far end answered/.test(v.info), v.info.slice(0, 60));
  await pick('both');
  stored = await page.evaluate(() => localStorage.getItem('cdr.dept.direction'));
  v = await view();
  record('back to Inbound + outbound', v.dir === 'both' && v.obShown && !v.inShown && v.rings && v.tob && stored === 'both'
    && v.heads.length === 7, JSON.stringify({ dir: v.dir, stored: stored, heads: v.heads }));

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
  // a user takes: land with the columns off, turn them on, Refresh (twice).
  {
    const pr = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pr.on('pageerror', (e) => errors.push('refresh pageerror: ' + e.message));
    await skipTour(pr);
    await pr.addInitScript(() => { localStorage.setItem('cdr.dept.direction', 'in'); });
    await pr.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
    await pr.waitForTimeout(2500);
    await openDept(pr, meta);
    const beforeSwitch = await pr.evaluate(() => (window.__HARNESS__.calls || []).length);
    await pr.click('#dept-dir-switch [data-dir-pick="both"]');   // DV-1
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
        fold: document.querySelectorAll('#ins-ob-kpis .ob-obar').length,   // SB-3: one split bar
      }));
      // Step 3: the brief's Outbound row loads both windows with the page, so
      // turning the columns on reads them from the same store -- at most one
      // ask per window (an explicit Refresh clears the store by design, and
      // the driver's own date-change load can land before its Refresh click).
      record('turning the columns on asks for each window at most once, and both render',
        Object.keys(per).every((k) => per[k] === 1) && both.table > 0 && both.fold === 1,
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
      // CCX-3: the button also re-reads the sections that hold their own
      // answer per window -- Team Direct Calls and Callbacks stayed on their
      // pre-Refresh figures -- each ONCE.
      const extra = await pr.evaluate((n) => {
        const out = {};
        (window.__HARNESS__.calls || []).slice(n).forEach((c) => {
          if (c.fn === 'getDirectCallReport' || c.fn === 'getOutboundReport') out[c.fn] = (out[c.fn] || 0) + 1;
        });
        return out;
      }, before);
      record('CCX-3: Refresh #' + round + ' re-reads Team Direct Calls and Callbacks once each',
        extra.getDirectCallReport === 1 && extra.getOutboundReport === 1, JSON.stringify(extra));
    }
    await pr.close();
  }

  // ---- D3 + TDC-1 (owner 2026-11-02): Team Direct Calls, the admin side panel
  // and DV-1's Direct view, ONE request between them ----------------------
  {
    const d30 = require('./payloads/direct-30d.json');
    const card = await page.evaluate(() => {
      const el = document.getElementById('dept-team-direct');
      const calls = (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDirectCallReport').map((c) => c.args[0]);
      const shown = (id) => { const x = document.getElementById(id); return !!x && getComputedStyle(x).display !== 'none'; };
      return { shown: !!el && getComputedStyle(el).display !== 'none', tag: el ? el.tagName : '',
               calls: calls, page: { from: document.getElementById('from-date').value, to: document.getElementById('to-date').value },
               date: (document.getElementById('tdc-date') || {}).textContent || '',
               note: (document.getElementById('tdc-note') || {}).textContent || '',
               skel: shown('tdc-loading'), err: shown('tdc-error'), busy: el ? el.getAttribute('aria-busy') : '',
               bars: Array.from(document.querySelectorAll('#tdc-tiles .ob-obar')).map((b) => Array.from(b.querySelectorAll('.ob-obar-seg'))
                 .reduce((a, x) => a + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]), 0)),
               rows: document.querySelectorAll('#tdc-tbody tr.trp-row').length,
               tally: document.querySelectorAll('#tdc-tbody .trp-tally .tly').length,
               legend: shown('tdc-legend') };
    });
    // It loads with the page now, so the landing window (before openDept set
    // the 30 days) was fetched too: count the requests for THIS window.
    const mine = card.calls.filter((c) => c.from === card.page.from && c.to === card.page.to);
    const c0 = mine[0] || {};
    record('TDC-1: Team Direct Calls is a panel (not a fold) that loaded with the page -- ONE request for this window, this dept',
      card.shown && card.tag === 'DIV' && mine.length === 1 && c0.department === 'CSR' && card.date.indexOf(card.page.from) === 0,
      JSON.stringify({ tag: card.tag, calls: card.calls, date: card.date }));
    record('TDC-1: loaded -- no skeleton, no error, not busy; both bars add up; a row per agent with a tally and its legend',
      !card.skel && !card.err && card.busy === 'false' && card.bars.length === 2
        && card.bars[0] === d30.kpis.ibAnswered + d30.kpis.ibMissedFree + d30.kpis.ibMissedBusy
        && card.bars[1] === d30.kpis.obTotal && card.rows === d30.agents.length && card.tally > 0 && card.legend,
      JSON.stringify({ skel: card.skel, err: card.err, busy: card.busy, bars: card.bars, rows: card.rows, tally: card.tally }));
    record('D3: the panel says when the data stops early and names the gap', /not imported/.test(card.note) && /1 workday/.test(card.note), card.note);

    // DV-1: the Direct view reads the SAME payload -- no second request.
    await pick('direct');
    const dv = await page.evaluate(() => {
      const shown = (id) => { const x = document.getElementById(id); return !!x && getComputedStyle(x).display !== 'none'; };
      const rows = Array.from(document.querySelectorAll('#agents-dc-tbody tr[data-agent]'));
      const num = (x) => parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]);
      const first = rows[0];
      const bar = first && first.querySelector('td.lb-bar-td .ob-obar');
      return { dir: document.body.getAttribute('data-dir'), dc: shown('agents-dc-wrap'), inb: shown('agents-in-wrap'), ob: shown('agents-ob-wrap'),
               rings: shown('dept-team-rings'), tob: shown('dept-team-outbound'), tdc: shown('dept-team-direct'),
               rows: rows.length, agent: first ? first.getAttribute('data-agent') : '',
               heads: Array.from(document.querySelectorAll('#agents-dc-thead tr:not(.lb-groups) th')).map((t) => t.textContent.replace(/[▲▼▽]/g, '').trim()),
               barSum: bar ? Array.from(bar.querySelectorAll('.ob-obar-seg')).reduce((a, x) => a + num(x), 0) : -1,
               nums: first && first.querySelector('.lb-n') ? first.querySelector('.lb-n').textContent : '',
               total: (document.querySelector('#agents-dc-tfoot tr') || {}).textContent || '',
               info: (document.getElementById('dqe-table-info') || { getAttribute: () => '' }).getAttribute('title') || '',
               note: (document.getElementById('agents-dc-note') || {}).textContent || '',
               calls: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getDirectCallReport').length };
    });
    const callsBefore = card.calls.length;
    const a0 = d30.agents.find((a) => a.agent === dv.agent) || {};
    record('DV-1: Direct shows the Direct table and the Team Direct Calls panel only, with no second request',
      dv.dir === 'direct' && dv.dc && !dv.inb && !dv.ob && !dv.rings && !dv.tob && dv.tdc && dv.calls === callsBefore,
      JSON.stringify(dv).slice(0, 200));
    record('DV-1: one row per agent the report carries, headed Agent / Answered / missed / Ans % / Connected / not / Conn % / Avg talk',
      dv.rows === d30.agents.length
        && JSON.stringify(dv.heads) === JSON.stringify(['Agent', 'Answered / missed', 'Ans %', 'Connected / not', 'Conn %', 'Avg talk']),
      JSON.stringify(dv.heads));
    record('DV-1: the most-rung agent leads, and their bar adds up to every call that rang their line',
      dv.barSum === (a0.ibAnswered || 0) + (a0.ibMissedFree || 0) + (a0.ibMissedBusy || 0)
        && dv.nums.replace(/\s/g, '') === (a0.ibAnswered || 0) + '/' + (a0.ibMissedFree || 0)
        && d30.agents.every((a) => (a.ibAnswered + a.ibMissedFree + a.ibMissedBusy) <= dv.barSum),
      JSON.stringify({ agent: dv.agent, sum: dv.barSum, nums: dv.nums }));
    record('DV-1: the total row carries the report\'s totals', dv.total.indexOf(d30.kpis.ibAnswered + '/' + d30.kpis.ibMissedFree) !== -1, dv.total.slice(0, 120));
    record('DV-1: the ⓘ says what Direct counts and that busy is left out; the data gap stays a visible note',
      /own extension/.test(dv.info) && /busy/.test(dv.info) && /not imported/.test(dv.note), JSON.stringify({ info: dv.info.slice(0, 80), note: dv.note }));
    // DO-1 (owner 2026-11-05): outbound here is calls to colleagues; the
    // calls to outside numbers are one small line under it, never in the bar.
    const dvo = await page.evaluate(() => {
      const r = document.querySelector('#agents-dc-tbody tr[data-agent]');
      const out = r.querySelectorAll('td.lb-bar-td')[1];
      const num = (x) => parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]);
      return { agent: r.getAttribute('data-agent'),
        barSum: Array.from(out.querySelectorAll('.ob-obar-seg')).reduce((a, x) => a + num(x), 0),
        ext: (out.querySelector('.dc-ext-line') || {}).textContent || '',
        group: (document.querySelector('#agents-dc-thead .lb-g--out') || {}).textContent || '',
        card: (document.querySelector('#dept-team-direct .tdc-split') || {}).textContent || '',
        info: (document.getElementById('dqe-table-info') || { getAttribute: () => '' }).getAttribute('title') || '' };
    });
    const ao = d30.agents.find((a) => a.agent === dvo.agent) || {};
    record('DO-1: the Direct view\'s outbound bar is calls to colleagues, the outside calls a small line under it; the card and the ⓘ say so',
      dvo.barSum === ao.obTotal && ao.obTotal === ao.obIntTotal && dvo.ext === '+' + ao.obExtTotal + ' to outside numbers'
        && /^Called colleagues/.test(dvo.group) && /calls to colleagues/.test(dvo.card) && /to outside numbers/.test(dvo.card)
        && /Outbound here is calls to colleagues/.test(dvo.info),
      JSON.stringify({ dvo: dvo, ob: [ao.obTotal, ao.obIntTotal, ao.obExtTotal] }));
    await page.click('#agents-dc-thead th[data-dc-sort="agent"]'); await page.waitForTimeout(300);
    const names = await page.evaluate(() => Array.from(document.querySelectorAll('#agents-dc-tbody tr[data-agent]')).map((r) => r.getAttribute('data-agent')));
    const asc = names.slice().sort((x, y) => x.localeCompare(y));
    record('DV-1: the Direct headers sort', names.length > 1 && (names.join('|') === asc.join('|') || names.join('|') === asc.slice().reverse().join('|')), names.join(', '));
    await page.locator('#agents-dc-tbody tr[data-agent]').first().click();
    await page.waitForTimeout(900);
    const dp = await page.evaluate(() => { const p = document.getElementById('ap-panel'); return { open: !!p, inDc: !!p && !!p.closest('#agents-dc-tbody') }; });
    record('DV-1: a Direct row opens the inline agent panel beneath it', dp.open && dp.inDc, JSON.stringify(dp));
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);

    // A panel row opens the Direct view at that agent (from another view too).
    await pick('both');
    const target = d30.agents[d30.agents.length - 1].agent;
    await page.click('#tdc-tbody tr.trp-row[data-tdc-agent="' + target + '"]');
    await page.waitForTimeout(900);
    const jumped = await page.evaluate((n) => ({ dir: document.body.getAttribute('data-dir'),
      hit: !!document.querySelector('#agents-dc-tbody tr.trp-jump-hit[data-agent="' + n + '"]') }), target);
    record('TDC-1: a panel row switches to the Direct view and marks that agent\'s row', jumped.dir === 'direct' && jumped.hit, JSON.stringify(jumped));
    await pick('both');

    // Retry + skeleton, on a fresh page: every load fails until the driver
    // lets it through; then Retry is held in flight (skeleton) and lands.
    {
      const pf = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      pf.on('pageerror', (e) => errors.push('tdc-retry pageerror: ' + e.message));
      await skipTour(pf);
      await pf.addInitScript(() => {
        localStorage.setItem('cdr.dept.direction', 'both');
        const set = () => { if (window.__HARNESS__) window.__HARNESS__.failOnce.getDirectCallReport = 99; else setTimeout(set, 0); };
        set();
      });
      await pf.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
      await pf.waitForTimeout(2500);
      await openDept(pf, meta);
      const shownIn = (p2) => p2.evaluate(() => {
        const shown = (id) => { const x = document.getElementById(id); return !!x && getComputedStyle(x).display !== 'none'; };
        return { skel: shown('tdc-loading'), err: shown('tdc-error'), table: shown('tdc-table-wrap'),
                 busy: (document.getElementById('dept-team-direct') || { getAttribute: () => '' }).getAttribute('aria-busy'),
                 msg: (document.getElementById('tdc-error-msg') || {}).textContent || '',
                 rows: document.querySelectorAll('#tdc-tbody tr.trp-row').length };
      });
      const failed = await shownIn(pf);
      record('TDC-1: a failed load shows the error and a Retry, not an empty table', failed.err && /injected failure/.test(failed.msg) && !failed.table && !failed.skel,
        JSON.stringify(failed));
      await pf.evaluate(() => { window.__HARNESS__.failOnce.getDirectCallReport = 0; window.__HARNESS__.delay = { getDirectCallReport: 1200 }; });
      await pf.click('#tdc-retry');
      await pf.waitForTimeout(250);
      const loading = await shownIn(pf);
      record('TDC-1: while it loads the panel shows a skeleton and says it is busy', loading.skel && loading.busy === 'true' && !loading.table && !loading.err,
        JSON.stringify(loading));
      await pf.waitForTimeout(1800);
      const after = await shownIn(pf);
      record('TDC-1: Retry loads the panel', !after.err && !after.skel && after.table && after.rows === d30.agents.length, JSON.stringify(after));
      await pf.close();
    }

    await page.click('#tdc-open-report');
    await page.waitForTimeout(1500);
    const modal = await page.evaluate(() => ({ open: getComputedStyle(document.getElementById('direct-call-modal')).display !== 'none',
      results: getComputedStyle(document.getElementById('direct-call-results')).display !== 'none',
      dept: (document.getElementById('direct-call-dept') || {}).value }));
    record('D3: "Open the Direct Calls report" opens the report on the same dept, run', modal.open && modal.results && modal.dept === 'CSR', JSON.stringify(modal));
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }

  // SB-6 (owner 2026-10-28): the CSR Transfer detail as two split bars --
  // where the transfers went (the destinations, the rest of the tracked list,
  // and the untracked part hatched) adds up to the transfers; each agent's bar
  // is their calls handled, the transferred part tier-coloured; sorted by
  // transfers (owner).
  {
    await page.evaluate(() => { const s = document.getElementById('dept-transfer-section'); if (s) s.open = true; });
    await page.waitForTimeout(300);
    const tf = await page.evaluate(() => {
      const num = (x) => parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]);
      const sub = (document.getElementById('dept-transfer-sub') || {}).textContent || '';
      const m = /^([\d,]+) transfers? of ([\d,]+) calls/.exec(sub);
      const dest = Array.from(document.querySelectorAll('#dept-transfer-queues .ob-obar-seg')).map((x) => x.getAttribute('data-seg') + ':' + num(x));
      const agents = Array.from(document.querySelectorAll('#dept-transfer-agents .dtf-track .ob-obar')).map((b) =>
        Array.from(b.querySelectorAll('.ob-obar-seg')).map((x) => x.getAttribute('data-seg') + ':' + num(x)));
      const nums = Array.from(document.querySelectorAll('#dept-transfer-agents .dtf-num strong')).map((x) => Number(x.textContent.replace(/,/g, '')));
      return { shown: getComputedStyle(document.getElementById('dept-transfer-section')).display !== 'none',
        transferred: m ? Number(m[1].replace(/,/g, '')) : -1, calls: m ? Number(m[2].replace(/,/g, '')) : -1,
        dest: dest, agents: agents, nums: nums,
        note: (document.getElementById('dept-transfer-note') || {}).textContent || '' };
    });
    const destSum = tf.dest.reduce((a, x) => a + Number(x.split(':')[1]), 0);
    const agentTr = tf.agents.reduce((a, segs) => a + segs.filter((x) => /^tf-|^unk/.test(x)).reduce((b, x) => b + Number(x.split(':')[1]), 0), 0);
    const agentCalls = tf.agents.reduce((a, segs) => a + segs.reduce((b, x) => b + Number(x.split(':')[1]), 0), 0);
    record('SB-6: where the transfers went is one bar that adds up to the transfers, the untracked part hatched and named',
      tf.shown && tf.transferred > 0 && destSum === tf.transferred && tf.dest.some((x) => /^hatch:/.test(x)) && /hatched part/.test(tf.note)
        && tf.dest.filter((x) => /^cat\d:/.test(x)).length === 5 && tf.dest.some((x) => /^unk:/.test(x)),
      JSON.stringify({ dest: tf.dest, transferred: tf.transferred, note: tf.note }));
    record('SB-6: each agent\'s bar is their calls handled with the transferred part coloured, adding up to the section totals; sorted by transfers',
      agentTr === tf.transferred && agentCalls === tf.calls && tf.agents.every((segs) => /^tf-(deep|light|amber|red):/.test(segs[0]))
        && tf.nums.every((n, i) => i === 0 || tf.nums[i - 1] >= n),
      JSON.stringify({ agents: tf.agents, nums: tf.nums, calls: tf.calls }));
  }

  // TD-1 / TD-2 (owner 2026-11-05): chips vs the prior window on the section
  // line, every named destination and every agent; the "other tracked queues"
  // key opens the list of those destinations, by click and by keyboard.
  {
    const td = await page.evaluate(() => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      return {
        sub: q('#dept-transfer-sub .dts-delta').length,
        legs: q('#dept-transfer-queues .ob-legend .ob-leg').map((l) => l.getAttribute('data-seg') + ':' + l.querySelectorAll('.dts-delta').length),
        agents: q('#dept-transfer-agents .dtf-num').length,
        agentChips: q('#dept-transfer-agents .dtf-num .dts-delta').length,
        restHidden: (document.getElementById('dept-transfer-rest') || {}).hidden,
        restRows: q('#dept-transfer-rest .dtf-rest-name').length,
      };
    });
    record('TD-1: the section line, every named destination and every agent carry a chip vs the prior period',
      td.sub === 1 && td.legs.filter((x) => /^(cat\d|unk):1$/.test(x)).length === td.legs.filter((x) => !/^hatch/.test(x)).length
        && td.agents > 0 && td.agentChips === td.agents,
      JSON.stringify(td));
    await page.click('#dept-transfer-queues .ob-leg[data-seg="unk"]');
    await page.waitForTimeout(150);
    const open1 = await page.evaluate(() => {
      const r = document.getElementById('dept-transfer-rest');
      const k = document.querySelector('#dept-transfer-queues .ob-leg[data-seg="unk"]');
      return { shown: !!r && !r.hidden && r.getBoundingClientRect().height > 0, exp: k && k.getAttribute('aria-expanded'),
        rows: Array.from(document.querySelectorAll('#dept-transfer-rest .dtf-rest-name')).map((x) => x.textContent),
        chips: document.querySelectorAll('#dept-transfer-rest .dts-delta').length };
    });
    await page.focus('#dept-transfer-queues .ob-leg[data-seg="unk"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const closed = await page.evaluate(() => document.getElementById('dept-transfer-rest').hidden);
    record('TD-2: clicking "other tracked queues" lists each of them with its count and chip; Enter closes it again',
      td.restHidden === true && open1.shown && open1.exp === 'true' && open1.rows.length === td.restRows && td.restRows >= 1
        && open1.chips === open1.rows.length && closed === true,
      JSON.stringify({ td: td, open1: open1, closed: closed }));
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
