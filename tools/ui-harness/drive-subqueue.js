'use strict';
/**
 * ASSERTING driver for the sub-queue scope switcher + the combined-view CSV.
 *
 * Why this exists: four sub-queue phases added a switcher, grouped rows,
 * per-dept subtotals, picker groups, a CSV rewrite and a scope note -- all of it
 * in script.html, which the zero-dep .gs harness structurally cannot load. Until
 * this driver, none of it had assertion-level coverage and a regression would
 * have been found by a manager, not CI.
 *
 * It also carries the FIRST automated coverage of any CSV writer in this repo.
 * The exporter builds a Blob and clicks an anchor, so the download is captured
 * by stubbing URL.createObjectURL and reading the Blob's text -- which asserts
 * the real bytes a manager would open, not a re-implementation of the builder.
 *
 * The fixture roster nests Spanish under CSR (the OVERVIEW_PARENT_OF constant),
 * so the default CSR payload IS the combined view; `summary-30d-own` /
 * `-subs` cover the other two scopes so the switcher round-trip is real.
 *
 * Run: node drive-subqueue.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

// The 30-day preset is the window with all three scopes captured.
async function openDeptThirtyDays(page) {
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  const meta = require('./payloads/meta.json');
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2200);
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
    localStorage.removeItem('cdr.dept.subscope');   // start from the server default
    // Capture CSV downloads: the exporter Blob-and-clicks, so intercepting
    // createObjectURL gives us the exact bytes a manager would open.
    window.__CSV__ = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { blob.text().then(function (t) { window.__CSV__.push(t); }); } catch (e) {}
      return realCreate(blob);
    };
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout
    ? await page.waitForTimeout(2500) : null;

  await openDeptThirtyDays(page);

  // ---- the combined view + collapsible groups -----------------------------
  // The three-way scope switcher is RETIRED: every view it offered is reachable
  // by collapsing a group, instantly and without the server round trip each tab
  // cost. These assertions replace the tab assertions rather than sitting
  // alongside them -- a driver that still passed with the tabs present would
  // not be testing what shipped.
  const bar = await page.evaluate(() => {
    const el = document.getElementById('dept-subq-bar');
    if (!el) return null;
    return {
      visible: el.offsetParent !== null,
      tabs: el.querySelectorAll('.subq-seg-btn').length,
      note: (el.querySelector('.subq-note') || {}).textContent || '',
      chip: !!el.querySelector('.subq-split-chip'),
    };
  });
  // Round-16 (owner): the relationship bar is HIDDEN entirely -- no
  // "Combined view..." banner and no "all queues" split chip. The grouped
  // table's subheaders + subtotals carry the relationship now.
  record('the relationship bar is hidden for a parent dept (owner removal)',
    !!bar && !bar.visible, bar ? 'visible=' + bar.visible : 'missing');
  record('and carries no split chip', !!bar && !bar.chip);

  const groups = await page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll('#agents-tbody tr.subq-group-head'));
    return heads.map((h) => ({
      dept: h.getAttribute('data-subq-group'),
      expanded: h.getAttribute('aria-expanded'),
      clickable: getComputedStyle(h).cursor,
      hasMissedBtn: !!h.querySelector('.subq-missed-btn'),
    }));
  });
  record('both departments render as groups', groups.length === 2,
    JSON.stringify(groups.map((g) => g.dept)));
  record('groups start EXPANDED (the combined view is unchanged on open)',
    groups.every((g) => g.expanded === 'true'));
  record('the group header looks clickable',
    groups.every((g) => g.clickable === 'pointer'));
  // Round-16 (owner): the heading-row "View X's missed calls" button is gone.
  record('no group header carries a missed-calls button (owner removal)',
    groups.filter((g) => g.hasMissedBtn).length === 0,
    JSON.stringify(groups.map((g) => g.dept + ':' + g.hasMissedBtn)));

  // Collapsing must hide the agent rows and KEEP the subtotal -- that is the
  // whole point of the disclosure, and the property the retired "own" tab used
  // to provide via a server round trip.
  const beforeRows = await page.evaluate(() =>
    document.querySelectorAll('#agents-tbody tr[data-agent]').length);
  await page.evaluate(() => {
    const h = document.querySelector('#agents-tbody tr.subq-group-head[data-subq-group="Spanish"]')
           || document.querySelectorAll('#agents-tbody tr.subq-group-head')[1];
    if (h) h.click();
  });
  await page.waitForTimeout(400);
  const afterCollapse = await page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll('#agents-tbody tr.subq-group-head'));
    return {
      rows: document.querySelectorAll('#agents-tbody tr[data-agent]').length,
      subtotals: document.querySelectorAll('#agents-tbody tr.subq-subtotal').length,
      collapsedCount: heads.filter((h) => h.getAttribute('aria-expanded') === 'false').length,
    };
  });
  record('collapsing a group hides its agent rows',
    afterCollapse.rows < beforeRows,
    beforeRows + ' -> ' + afterCollapse.rows);
  record('but KEEPS both subtotals on screen (the point of the disclosure)',
    afterCollapse.subtotals === 2, 'subtotals=' + afterCollapse.subtotals);
  record('and the collapse is instant -- no server round trip',
    afterCollapse.collapsedCount === 1, 'collapsed=' + afterCollapse.collapsedCount);

  await page.evaluate(() => {
    const h = document.querySelector('#agents-tbody tr.subq-group-head[aria-expanded="false"]');
    if (h) h.click();
  });
  await page.waitForTimeout(400);
  const reExpanded = await page.evaluate(() =>
    document.querySelectorAll('#agents-tbody tr[data-agent]').length);
  record('re-expanding restores every agent row', reExpanded === beforeRows,
    beforeRows + ' -> ' + reExpanded);

  // ---- aggregate rows must be visually DISTINCT from agent rows -----------
  // Owner round: the totals and per-dept subtotals read like another agent row.
  // Asserting the rendered font-size/bar-height rather than a class, because a
  // class with no rule behind it is exactly how the active scope tab shipped
  // with no visual state at all.
  const weight = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const px = (el, prop) => el ? parseFloat(getComputedStyle(el)[prop]) : null;
    // Measure a NUMERIC cell, not td:first-child. The label cell is uppercase
    // letter-spaced type by design and is legitimately SMALLER in px while
    // reading as heavier -- comparing it would test the wrong thing and fail
    // an intentional treatment.
    const lastTd = (sel) => {
      const tds = document.querySelectorAll(sel + ' td');
      return tds.length ? tds[tds.length - 1] : null;
    };
    const agentRow = lastTd('#agents-tbody tr[data-agent]');
    const subTd = lastTd('#agents-tbody tr.subq-subtotal');
    const totTd = lastTd('#agents-tfoot tr');
    return {
      agent: px(agentRow, 'fontSize'),
      subtotal: px(subTd, 'fontSize'),
      total: px(totTd, 'fontSize'),
      // Round-16: AGENT rows carry the volume-proportional TALLY; subtotal +
      // totals rows keep the classic proportional .ans-track bar. Measure the
      // rendered reality of both, not a class name.
      agentTallyBlocks: (q('#agents-tbody tr[data-agent] .ans-tally') || { children: [] }).children.length,
      agentTrack: !!q('#agents-tbody tr[data-agent] .ans-track'),
      subBar: px(q('#agents-tbody tr.subq-subtotal .ans-track'), 'height'),
    };
  });
  record('per-dept subtotal rows render LARGER than agent rows',
    !!weight.subtotal && !!weight.agent && weight.subtotal > weight.agent,
    JSON.stringify(weight));
  record('the grand total row renders larger than agent rows',
    !!weight.total && !!weight.agent && weight.total > weight.agent,
    'total=' + weight.total + ' agent=' + weight.agent);
  record('agent rows render the volume tally; subtotal rows keep the proportional bar',
    weight.agentTallyBlocks > 0 && !weight.agentTrack && !!weight.subBar,
    'tallyBlocks=' + weight.agentTallyBlocks + ' agentTrack=' + weight.agentTrack
    + ' subBar=' + weight.subBar);

  // ---- the parity property: parent subtotal == its own-scope total --------
  // Previously this switched to the "own" tab and compared the rendered totals
  // row. With the tabs retired there is no own-scope RENDER to compare against,
  // so it now compares the rendered subtotal directly against the SERVER's
  // own-scope payload -- which is the property itself (a dept's subtotal is
  // what its own view shows) rather than a UI proxy for it, and it no longer
  // depends on a round trip the product doesn't make any more.
  const ownPayload = require('./payloads/summary-30d-own.json');
  const parentSubtotal = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('#agents-tbody tr.subq-subtotal'))
      .find((row) => /^CSR subtotal/.test(row.cells[0].textContent.trim()));
    if (!r) return null;
    // Read the numeric columns by header name so a column re-order cannot make
    // this silently compare the wrong cells.
    const heads = Array.from(document.querySelectorAll('#agents-table thead th'))
      .map((th) => th.textContent.trim().toLowerCase());
    const out = {};
    Array.from(r.cells).forEach((c, i) => { out[heads[i] || ('c' + i)] = c.textContent.trim(); });
    return out;
  });
  const ot = (ownPayload && ownPayload.totals) || {};
  const cellHas = function (obj, frag) {
    if (!obj) return '';
    const k = Object.keys(obj).find((x) => x.indexOf(frag) !== -1);
    return k ? obj[k] : '';
  };
  const uniqCell = cellHas(parentSubtotal, 'unique');
  record('the parent subtotal equals the SERVER own-scope totals (S35 addendum)',
    !!parentSubtotal && String(ot.totalUnique) === uniqCell.replace(/[^0-9]/g, ''),
    'rendered unique=' + uniqCell + '  payload totalUnique=' + ot.totalUnique);
  record('and its answered/missed match that payload too',
    !!parentSubtotal
      && cellHas(parentSubtotal, 'answered').indexOf(String(ot.totalAnswered)) !== -1
      && cellHas(parentSubtotal, 'answered').indexOf(String(ot.totalMissed)) !== -1,
    'bar cell=' + cellHas(parentSubtotal, 'answered')
      + '  payload a=' + ot.totalAnswered + ' m=' + ot.totalMissed);

  // ---- CSV -----------------------------------------------------------------
  async function exportCsv() {
    await page.evaluate(() => { window.__CSV__.length = 0; });
    const menuBtn = page.locator('#csv-export-btn');
    if (await menuBtn.count()) { await menuBtn.click(); await page.waitForTimeout(300); }
    await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button, a, .menu-item, .header-menu-item'));
      const hit = cands.find((e) => /download csv/i.test((e.textContent || '').trim()));
      if (hit) hit.click();
    });
    await page.waitForTimeout(600);
    return page.evaluate(() => (window.__CSV__ || [])[0] || '');
  }
  const csvAll = await exportCsv();
  const allLines = csvAll.split('\n');
  record('combined CSV leads with a Department column',
    /^Department,/.test(allLines[0] || ''), (allLines[0] || '').slice(0, 60));
  record('combined CSV carries a per-dept subtotal row',
    allLines.some((l) => /CSR subtotal/.test(l)) && allLines.some((l) => /Spanish subtotal/.test(l)));
  record('combined CSV ends with a labelled grand total',
    allLines.some((l) => /All shown/.test(l)));
  record('combined CSV has NO group-header banner rows (deliberate)',
    !allLines.some((l) => /^(CSR|Spanish),?$/.test(l.trim())));

  // ---- the SWR store keeps more than one window, so going back is instant --
  // Reported by the owner as slow scope switching. The last-good store was ONE
  // slot per report, so each A/B flip overwrote the other side's entry and the
  // return trip always missed and re-fetched. Correctness was never at risk
  // (signature-matched), only speed -- exactly the kind of thing no assertion
  // was watching.
  //
  // The scope tabs that first exposed it are retired, so this now exercises the
  // same store through DATE RANGES, which is the remaining A/B a manager flips
  // between. The property under test is unchanged: distinct requests must stop
  // evicting each other.
  const meta2 = require('./payloads/meta.json');
  await page.fill('#from-date', meta2.latest);
  await page.fill('#to-date', meta2.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2000);
  await page.fill('#from-date', meta2.from30);
  await page.fill('#to-date', meta2.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2000);
  const swr = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => /lastgood/i.test(k) && /summary/i.test(k));
    if (!keys.length) return { keys: 0 };
    let entries;
    try { entries = JSON.parse(localStorage.getItem(keys[0])); } catch (e) { return { bad: true }; }
    const list = Array.isArray(entries) ? entries : [entries];
    return {
      keys: keys.length,
      slots: list.length,
      sigs: list.map((e) => (e && e.sig) || ''),
    };
  });
  record('the summary SWR store keeps MORE THAN ONE window (instant back-and-forth)',
    !!swr && swr.slots >= 2, JSON.stringify(swr.slots));
  record('stored signatures are DISTINCT (the single-slot collapse is gone)',
    !!swr && !!swr.sigs && new Set(swr.sigs).size === swr.slots,
    swr ? swr.slots + ' slots' : '');

  // ---- the SINGLE-dept paths, via a dept with no sub-queues ---------------
  // 11 of 14 real departments have no sub-queue, so this is the COMMON shape,
  // and the promise made to it is byte-compatibility: nothing about the
  // sub-queue work may change what those departments render or export. The
  // assertion lapsed when the scope switcher was retired (the `own` tab was the
  // only way to get a one-dept payload); `summary-30d-sales` restores it
  // without touching fixture data -- Sales's seeded child `PAP` is absent from
  // this roster, and subQueueChildMap_ drops an edge naming a dept that does
  // not exist.
  // The switch itself is now an assertion. It threw a ReferenceError until
  // 2026-07 -- the handler still cleared two roster caches belonging to the
  // long-retired Performance and Compare Ranges reports, and under 'use strict'
  // that threw BEFORE the refresh() on the next line, so the selector silently
  // did nothing for every admin. No automated check had ever switched
  // departments, which is exactly why it survived so long.
  const errsBefore = errors.length;
  await page.selectOption('#dept-selector', 'Sales');
  await page.waitForTimeout(2500);
  record('switching department does not throw',
    errors.length === errsBefore,
    errors.slice(errsBefore).join(' | ').slice(0, 140));
  const single = await page.evaluate(() => {
    const bar = document.getElementById('dept-subq-bar');
    return {
      barHidden: !bar || bar.offsetParent === null,
      groupHeads: document.querySelectorAll('#agents-tbody tr.subq-group-head').length,
      subtotals: document.querySelectorAll('#agents-tbody tr.subq-subtotal').length,
      rows: document.querySelectorAll('#agents-tbody tr[data-agent]').length,
      totalsRow: !!document.querySelector('#agents-tfoot tr'),
    };
  });
  record('a dept with NO sub-queues renders no relationship bar', single.barHidden,
    JSON.stringify(single));
  record('and no group headers or per-dept subtotals',
    single.groupHeads === 0 && single.subtotals === 0);
  record('but still renders its agents and a totals row',
    single.rows > 0 && single.totalsRow, 'rows=' + single.rows);
  record('and the table actually CHANGED dept (the switch took effect)',
    single.rows !== beforeRows, 'CSR had ' + beforeRows + ', Sales has ' + single.rows);

  const csvSingle = await exportCsv();
  const singleHeader = (csvSingle.split('\n')[0] || '');
  record('single-dept CSV has NO Department column (byte-compatible)',
    csvSingle.length > 0 && !/^Department,/.test(singleHeader), singleHeader.slice(0, 60));
  record('and carries no per-dept subtotal or All-shown rows',
    csvSingle.length > 0 && !/ subtotal/.test(csvSingle) && !/All shown/.test(csvSingle));

  await page.selectOption('#dept-selector', 'CSR');
  await page.waitForTimeout(2500);

  // ---- the missed section's scope note (Round-16: RETIRED) -----------------
  const missedNote = await page.evaluate(() => {
    const el = document.getElementById('dept-missed-scope-note');
    return el ? { visible: el.offsetParent !== null,
                  text: (el.textContent || '').replace(/\s+/g, ' ').trim() } : null;
  });
  record('the missed-section scope banner is hidden (owner removal)',
    !!missedNote && !missedNote.visible,
    missedNote ? ('visible=' + missedNote.visible) : 'missing');

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
