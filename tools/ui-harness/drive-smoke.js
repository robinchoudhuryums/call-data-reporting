'use strict';
/**
 * CI-grade smoke driver (F7). Deterministic PASS/FAIL — no screenshots to eyeball,
 * no human judgement — so it can gate `npm run ci:ui`. The sibling drivers
 * (drive.js / drive-insights.js / drive-phase3.js) stay exploratory: they emit
 * shots + reports for a person to read.
 *
 * It asserts the failure classes the .gs unit harness structurally CANNOT see:
 *   1. Page/console errors while booting every page as admin AND manager.
 *   2. Unmocked RPCs beyond a known allowlist (a renamed/new endpoint the
 *      fixtures don't cover shows up here instead of as a silent empty panel).
 *   3. BLANK chart canvases — a canvas that is laid out and visible but whose
 *      pixels are entirely uniform. This is the R12-1 class (blank missed
 *      chart) and the reason this driver exists.
 *   4. Horizontal document overflow (a layout that pushes the page sideways).
 *
 * Run: node drive-smoke.js   (after gen-payloads/gen-phase3 + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

// RPCs the fixtures deliberately do not mock. getInboundHeatmap is Neon-backed
// and its panel MUST hide silently on failure -- that behavior is part of the
// audit, so an "unmocked" report for it is expected, not a regression.
const UNMOCKED_OK = new Set(['getInboundHeatmap', 'getInboundReport',
  'getDirectCallReport', 'getCallerLookup', 'logReportUsage']);

// Chart canvases that are legitimately absent/empty in the fixture (no data),
// keyed by canvas id. Everything else must render actual pixels when visible.
const BLANK_OK = new Set(['ir-spark-canvas']);

async function bootPage(browser, role) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-' + role + '.html'));
  await page.waitForTimeout(2500);
  return { page, errors };
}

/**
 * A canvas is BLANK when every sampled pixel is identical. Reads the bitmap in
 * page context; skips canvases that aren't visible or have no layout box (those
 * are legitimately un-rendered, e.g. a chart on a hidden tab).
 */
async function blankCanvases(page) {
  return page.evaluate((blankOkIds) => {
    const out = [];
    document.querySelectorAll('canvas').forEach((c) => {
      if (blankOkIds.includes(c.id)) return;
      if (!c.offsetParent) return;                       // hidden
      // Closed-<details> content is skipped rendering (content-visibility)
      // but newer Chromium still answers offsetParent/gBCR for it via forced
      // layout -- a chart inside a collapsed fold is legitimately undrawn.
      if (c.closest('details:not([open])')) return;
      const r = c.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;         // not laid out / sparkline-sized
      let ctx;
      try { ctx = c.getContext('2d'); } catch (e) { return; }
      if (!ctx) return;
      let data;
      try { data = ctx.getImageData(0, 0, c.width, c.height).data; } catch (e) { return; }
      if (!data || !data.length) return;
      const first = [data[0], data[1], data[2], data[3]].join(',');
      let varied = false;
      // Sample every ~200th pixel: enough to catch "entirely uniform" cheaply.
      for (let i = 0; i < data.length; i += 800) {
        if ([data[i], data[i + 1], data[i + 2], data[i + 3]].join(',') !== first) { varied = true; break; }
      }
      if (!varied) out.push(c.id || c.className || '(anonymous canvas)');
    });
    return out;
  }, Array.from(BLANK_OK));
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;   // >0 means the page scrolls sideways
  });
}

(async () => {
  const browser = await chromium.launch(launchOptions());

  for (const role of ['admin', 'manager']) {
    const { page, errors } = await bootPage(browser, role);

    // Visit every page the role can reach; each is a fresh render pass.
    // N1: the lens switcher is REMOVED -- the Insights section renders OPEN
    // inline on the dept page and generates with it, so the dept step's
    // longer wait covers the Insights render too (its canvases sit inside
    // the open <details> and are checked by blankCanvases below).
    const navs = [['overview', '#overview-btn'], ['dept', '#my-dept-btn'],
                  ['escalations', '#escalations-btn']];
    for (const [name, sel] of navs) {
      const btn = page.locator(sel);
      if (!(await btn.count())) { record(role + ': ' + name + ' tab present', false, sel + ' missing'); continue; }
      await btn.click();
      await page.waitForTimeout(name === 'dept' ? 5000 : 2200);

      const blanks = await blankCanvases(page);
      record(role + '/' + name + ': no blank chart canvases', blanks.length === 0, blanks.join(', '));

      const overflow = await horizontalOverflow(page);
      record(role + '/' + name + ': no horizontal page overflow', overflow <= 0, 'scrollWidth-clientWidth=' + overflow);
    }

    // R16e (owner round): the My Department totals label and the Insights
    // header/queue-health surfaces. All read-only assertions on the dept page.
    {
      await page.click('#my-dept-btn');
      await page.waitForTimeout(5000);
      // 1. The roster/crossover caption moved OUT of the visible label into a
      //    tooltip -- but it must NOT be lost (an unexplained shortfall between
      //    the subtotals and the grand total reads as a bug), so assert BOTH:
      //    the label is bare AND the explanation is still on the cell.
      const totalCell = page.locator('#agents-tfoot td').first();
      if (await totalCell.count()) {
        const txt = (await totalCell.textContent() || '').trim();
        const title = await totalCell.getAttribute('title');
        record(role + ': totals label is bare "Total"', txt === 'Total', 'text=' + txt);
        record(role + ': totals caption survives as a tooltip',
          !!title && /roster only/i.test(title), 'title=' + title);
      }
      // 2. Views is hidden for everyone; the edit trigger moved into the
      //    title line (and must still be reachable there).
      const viewsShown = await page.locator('#ins-views-btn').isVisible().catch(() => false);
      record(role + ': Insights Views button is hidden', !viewsShown, 'visible=' + viewsShown);
      const editInTitle = await page.locator('.ir-results-title-line #ins-edit-selection-btn').count();
      const editShown = await page.locator('#ins-edit-selection-btn').isVisible().catch(() => false);
      record(role + ': "Comparison & agents" sits in the Insights title line',
        editInTitle === 1 && editShown, 'inTitleLine=' + editInTitle + ' visible=' + editShown);
      // 3. Queue health: Avg answer + Longest wait are CARDS now, and the
      //    muted secondary strip they came from is empty for the dept total.
      const qhFold = page.locator('#ins-qh-fold');
      if (await qhFold.count() && await qhFold.isVisible().catch(() => false)) {
        await page.evaluate(() => { const f = document.getElementById('ins-qh-fold'); if (f) f.open = true; });
        await page.waitForTimeout(400);
        const labels = await page.$$eval('#ins-qh-tiles .ds-kpi__label',
          function (ns) { return ns.map(function (n) { return n.textContent.trim(); }); });
        record(role + ': queue-health promotes Avg answer + Longest wait to cards',
          labels.indexOf('Avg answer') >= 0 && labels.indexOf('Longest wait') >= 0, labels.join(' | '));
        const secTxt = await page.locator('#ins-qh-secondary').textContent().catch(() => '');
        record(role + ': the dept-total secondary strip is retired',
          (secTxt || '').trim() === '', 'strip="' + (secTxt || '').trim() + '"');
      }
    }

    // R17b: the second sticky side panel (Team Rings Data) + the layout move
    // that lets it ride the whole page. Four load-bearing properties: the
    // panel renders (KPI pair + condensed rows with tallies + full-name
    // hover), the Insights region now lives INSIDE the dept-layout main
    // column (the aside's sticky context), and the two Insights card sets it
    // replaces are hidden.
    {
      await page.click('#my-dept-btn');
      await page.waitForTimeout(4000);
      const trp = await page.evaluate(function () {
        const panel = document.getElementById('dept-team-rings');
        const first = panel ? panel.querySelector('tr.trp-row') : null;
        return {
          visible: !!panel && panel.style.display !== 'none',
          tiles: panel ? panel.querySelectorAll('.ds-kpi').length : 0,
          rows: panel ? panel.querySelectorAll('tr.trp-row').length : 0,
          tallies: panel ? panel.querySelectorAll('.trp-tally').length : 0,
          fullNameHover: first ? /—/.test(first.getAttribute('title') || '') : false,
          regionInMain: !!document.querySelector('.dept-main #dept-insights-region'),
          kpiRowHidden: getComputedStyle(document.getElementById('ins-kpi-row')).display === 'none',
          qhCardsHidden: getComputedStyle(document.querySelector('.ins-qh-left')).display === 'none',
        };
      });
      record(role + ': Team Rings panel renders (tiles + rows + tallies + hover names)',
        trp.visible && trp.tiles >= 1 && trp.rows >= 3 && trp.tallies >= 1 && trp.fullNameHover,
        JSON.stringify(trp));
      record(role + ': Insights region rides the dept-layout main column',
        trp.regionInMain, 'regionInMain=' + trp.regionInMain);
      record(role + ': the replaced Insights card sets are hidden',
        trp.kpiRowHidden && trp.qhCardsHidden,
        'kpiRow=' + trp.kpiRowHidden + ' qhCards=' + trp.qhCardsHidden);
    }

    // R17d: the trend Calendar is available at ANY window length. On the dept
    // page's default single-day window (INV-43) the selected range cannot fill
    // a calendar, so the renderer falls back to the server's year-to-date
    // series -- which must (a) leave the toggle enabled, (b) draw a grid with
    // more months than the window has, and (c) CAPTION itself, since an
    // uncaptioned grid of the year reads as the selected day's data.
    {
      await page.click('#my-dept-btn');
      await page.waitForTimeout(4000);
      await page.evaluate(() => {
        const f = document.getElementById('ins-trend-fold');
        if (f && !f.open) f.querySelector('summary').click();
      });
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('#ins-trend-render-toggle .seg-btn'))
          .find((x) => (x.textContent || '').trim() === 'Calendar');
        if (b) b.click();
      });
      await page.waitForTimeout(1200);
      const cal = await page.evaluate(() => {
        const host = document.getElementById('ins-trend-calendar');
        const btn = Array.from(document.querySelectorAll('#ins-trend-render-toggle .seg-btn'))
          .find((x) => (x.textContent || '').trim() === 'Calendar');
        return {
          span: (document.getElementById('from-date') || {}).value + '..'
                + (document.getElementById('to-date') || {}).value,
          enabled: !!btn && !btn.disabled,
          active: !!btn && /\bactive\b/.test(btn.className),
          shown: !!host && host.style.display !== 'none',
          cells: host ? host.querySelectorAll('.ins-cal-drill').length : 0,
          months: host ? ((host.querySelector('.ins-cal-month-pos') || {}).textContent || '') : '',
          note: host ? ((host.querySelector('.ins-cal-ytd-note') || {}).textContent || '') : '',
        };
      });
      record(role + ': calendar is offered on a window too short to fill one',
        cal.enabled && cal.active && cal.shown && cal.cells > 0, JSON.stringify(cal));
      record(role + ': the short-window calendar draws the YEAR, captioned as such',
        /of \d+/.test(cal.months) && /year to date/i.test(cal.note),
        'months="' + cal.months + '" note="' + cal.note.trim() + '"');
    }

    // R18: a To-date past the last day WITH DATA is clamped, and the
    // correction is stated. This is a numbers bug, not a cosmetic one: every
    // per-workday figure divides by the INV-35 working-day count of the
    // SELECTED window, so trailing empty days silently deflated the pace
    // (two surfaces disagreed -- 273.8/day vs 365/day on the same data).
    // Asserted on the HAND-TYPED path, which is the one with no preset to
    // fall back on.
    {
      await page.click('#my-dept-btn');
      await page.waitForTimeout(3800);
      const clamp = await page.evaluate(async () => {
        const t = document.getElementById('to-date');
        const latest = t.value;                       // default == latest data
        t.value = '2026-12-31';
        t.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1200));
        const note = document.getElementById('dept-clamp-note');
        return {
          latest: latest,
          to: t.value,
          from: (document.getElementById('from-date') || {}).value,
          noteShown: !!note && note.style.display !== 'none' && !!note.textContent,
        };
      });
      record(role + ': a To-date past the data is clamped back to it',
        clamp.to === clamp.latest && clamp.to <= clamp.latest, JSON.stringify(clamp));
      record(role + ': the clamp states the correction rather than moving dates silently',
        clamp.noteShown, JSON.stringify(clamp));
      // Never invert the range: a fully-future window pulls From back too.
      record(role + ': clamping never leaves From after To',
        !clamp.from || !clamp.to || clamp.from <= clamp.to, JSON.stringify(clamp));
    }

    // R17h (Options A+B): the missed-call slices share ONE renderer and
    // cross-link to each other. Three load-bearing properties: an agent
    // card's ring time opens the DEPT-WIDE hour-bucket drill; that drill
    // renders through the shared lens (not its retired private markup); and
    // a row's agent name jumps back to that agent's card. The round trip is
    // the assertion -- each half is useless if the other end is missing.
    {
      await page.click('#my-dept-btn');
      await page.waitForTimeout(4000);
      const bucketOpened = await page.evaluate(() => {
        const link = document.querySelector('#dept-missed-detail .ms-bucket-link');
        if (!link) return null;
        link.click();
        return true;
      });
      await page.waitForTimeout(900);
      const drill = await page.evaluate(() => {
        const body = document.getElementById('dept-bucket-detail-body');
        const wrap = document.getElementById('dept-missed-bucket-detail');
        if (!body || !wrap) return null;
        return {
          open: wrap.style.display !== 'none',
          shared: !!body.querySelector('.heat-drill-list'),
          legacy: !!body.querySelector('.bucket-detail-list'),
          rows: body.querySelectorAll('.heat-drill-row').length,
          agentLinks: body.querySelectorAll('.ms-agent-link').length,
          // the retired grid's trap: content wider than the narrow panel
          overflowX: body.scrollWidth - body.clientWidth,
        };
      });
      record(role + ': an agent card ring opens the dept-wide bucket drill',
        !!bucketOpened && !!drill && drill.open && drill.rows > 0, JSON.stringify(drill));
      record(role + ': the bucket drill renders through the SHARED missed lens',
        !!drill && drill.shared && !drill.legacy && drill.overflowX <= 0, JSON.stringify(drill));
      if (drill && drill.agentLinks > 0) {
        const landed = await page.evaluate(async () => {
          const link = document.querySelector('#dept-bucket-detail-body .ms-agent-link');
          const want = link.getAttribute('data-ms-agent');
          link.click();
          await new Promise((r) => setTimeout(r, 700));
          const lit = document.querySelector('#dept-missed-detail [data-agent-card].qs-spotlight');
          return { want: want, got: lit ? lit.getAttribute('data-agent-card') : null,
                   open: lit ? lit.open : false };
        });
        record(role + ': a drill row\'s agent name jumps to that agent\'s card',
          !!landed.got && landed.got === landed.want && landed.open, JSON.stringify(landed));
      }
    }

    // R17a: rings of one abandoned call group on the agent cards -- the
    // fixture seeds a re-rung parent (same id twice), so at least one group
    // must render, with the id badge ONCE inside it (deduping the repeat)
    // and the explainer as a hover title, not visible text.
    {
      await page.click('#my-dept-btn');
      await page.waitForTimeout(4000);
      const groups = await page.$$eval('#dept-missed-detail .ms-callgroup', function (ns) {
        return ns.map(function (n) {
          return { rings: n.querySelectorAll('li').length,
                   badges: n.querySelectorAll('.parent-id').length,
                   title: n.getAttribute('title') || '',
                   captionText: (n.textContent.match(/same call/i) || []).length };
        });
      }).catch(function () { return []; });
      record(role + ': re-rung abandoned call renders as ONE group', groups.length >= 1,
        'groups=' + groups.length);
      if (groups.length) {
        const g = groups[0];
        record(role + ': group carries one id badge + a hover explainer, no visible caption',
          g.rings >= 2 && g.badges === 1 && /rang \d+×/.test(g.title) && g.captionText === 0,
          JSON.stringify(g));
      }
    }

    // F10: the escalations nav badge used to be append-only, so every render
    // path that re-ran it could stack a second count onto the tab. Reload the
    // list (each mutation reloads it too) and assert the badge stays singular.
    {
      await page.click('#escalations-btn');
      await page.waitForTimeout(1800);
      const refresh = page.locator('#esc-refresh-btn');
      if (await refresh.count()) { await refresh.click(); await page.waitForTimeout(1800); }
      const badges = await page.locator('#escalations-btn .nav-count-badge').count();
      record(role + ': escalation badge never duplicates on reload', badges <= 1,
        'badge spans=' + badges);
    }

    // The all-departments QCD report (its fixture payload is new in F7).
    const qcdBtn = page.locator('#ov-qcd-alldept-btn');
    if (await qcdBtn.count()) {
      await page.click('#overview-btn');
      await page.waitForTimeout(1200);
      await qcdBtn.click();
      await page.waitForTimeout(2500);
      const rows = await page.locator('tr.qcd-expandable').count();
      record(role + ': all-dept QCD report renders expandable rows', rows > 0, 'rows=' + rows);
    }

    // View-as-manager (admin only). Added after the department selector was
    // found throwing a ReferenceError in production -- no automated check had
    // ever OPERATED a header control, so any of them could have been broken the
    // same way and nobody would have known. This is the other admin control
    // with real behavior behind it: it must not throw, it must hide the
    // admin-only surfaces, and it must be reversible.
    const viewAs = page.locator('#view-as-select');
    if (role === 'admin' && await viewAs.count()) {
      const errsBefore = errors.length;
      const opts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#view-as-select option'))
          .map((o) => o.value).filter(Boolean));
      if (opts.length) {
        await page.selectOption('#view-as-select', opts[0]);
        await page.waitForTimeout(1500);
        const inPreview = await page.evaluate(() => ({
          flag: document.body.getAttribute('data-view-as'),
          // An admin-only surface that should now be hidden. Measured as
          // RENDERED visibility, not a class -- a class with no rule behind it
          // is how the sub-queue scope tab shipped with no visual state at all.
          adminTabVisible: (function () {
            const el = document.querySelector('.header-menu[data-admin-only], [data-admin-only]');
            return !!(el && el.offsetParent !== null);
          })(),
        }));
        record('admin: view-as enters manager preview', inPreview.flag === 'manager',
          'data-view-as=' + inPreview.flag);
        record('admin: view-as hides the admin-only surfaces',
          !inPreview.adminTabVisible);
        await page.selectOption('#view-as-select', '');
        await page.waitForTimeout(1500);
        const exited = await page.evaluate(() => document.body.getAttribute('data-view-as'));
        record('admin: leaving view-as restores the admin view', !exited,
          'data-view-as=' + exited);
        record('admin: view-as does not throw', errors.length === errsBefore,
          errors.slice(errsBefore).join(' | ').slice(0, 140));
      }
    }

    const unmocked = await page.evaluate(() => (window.__HARNESS__ || {}).unmocked || []);
    const unexpected = unmocked.filter((n) => !UNMOCKED_OK.has(n));
    record(role + ': no unexpected unmocked RPCs', unexpected.length === 0,
      Array.from(new Set(unexpected)).join(', '));

    const realErrors = errors.filter((e) => !/favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e));
    record(role + ': no page/console errors', realErrors.length === 0,
      Array.from(new Set(realErrors)).slice(0, 4).join(' | '));

    await page.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
