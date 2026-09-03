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

/**
 * R31: VISIBLE ERROR TONE on a healthy render.
 *
 * The gate's blind spot, found the expensive way. It asserts page/console
 * ERRORS, blank canvases and horizontal overflow -- none of which can see a
 * correctly-rendered element carrying the WRONG TONE. R30 wired a routine
 * window correction through irSetFormError, whose element is
 * `class="status status-error"`, so every ordinary Individual Report open
 * rendered a RED banner; the report ran fine, the page threw nothing, every
 * canvas drew, and the gate passed it straight through to main.
 *
 * The property: on a healthy render with nothing induced to fail, NO
 * error-toned status element is visible. `.status-error` is the app's one
 * explicit error tone (styles.html: --bad background/foreground/border), so a
 * visible one is either a real failure the driver should be reporting anyway,
 * or a non-error wearing the error's clothes. Both are findings.
 *
 * Returns the offenders' text so a failure names WHAT is red, not just that
 * something is.
 */
async function visibleErrorTones(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.status-error').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const shown = r.width > 0 && r.height > 0
        && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      if (!shown) return;
      out.push((el.id || el.className || 'unknown') + ': '
        + (el.textContent || '').trim().slice(0, 80));
    });
    return out;
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

      // R31: nothing on a healthy page should be wearing the error tone.
      const reds = await visibleErrorTones(page);
      record(role + '/' + name + ': no error-toned status is visible',
        reds.length === 0, reds.join(' | '));
    }

    // R31: the INDIVIDUAL REPORT modal, opened solely so the error-tone probe
    // can see it. No driver opened it before -- drive-admin covers the six
    // ADMIN modals and IR is not one of them -- which is exactly why the red
    // banner R30 put on every ordinary IR open reached main unseen. A tone
    // check that never visits the surface it was written for is theatre, so
    // the visit is part of the fix.
    //
    // ADMIN ONLY, and that is a property of the markup, not a shortcut: the
    // button lives in #reports-menu-list, whose enclosing .header-menu carries
    // data-admin-only and is display:none for everyone else (the attribute is
    // cleared at init for admins). A manager reaches IR by other routes; there
    // is no header path to assert for them, so this skips rather than invent
    // one.
    //
    // It is MENU-GATED, which the first cut of this block got wrong: it
    // guarded on locator.count() -- existence -- then clicked, and Playwright
    // retried a hidden button for 30s and killed the driver. Existence is not
    // visibility. Open the menu first, and gate on isVisible().
    //
    // Button + modal ids come from the ROUTER TABLE in script-4-nav.html
    // ('/report/individual'), which is the authority -- drive-phase3.js
    // guessing an id is how it spent months probing a modal that does not
    // exist.
    if (role === 'admin') {
      const menuBtn = page.locator('#reports-menu-btn');
      if (await menuBtn.count() && await menuBtn.isVisible()) {
        await menuBtn.click();
        await page.waitForTimeout(400);
        const irBtn = page.locator('#individual-report-btn');
        if (await irBtn.count() && await irBtn.isVisible()) {
          await irBtn.click();
          await page.waitForTimeout(3500);
          const irOpen = await page.evaluate(() => {
            const m = document.querySelector('#individual-modal');
            return !!m && getComputedStyle(m).display !== 'none';
          });
          record(role + ': the Individual Report modal opens', irOpen, 'open=' + irOpen);

          // GENERATE, don't just open. A direct open shows the SETUP FORM --
          // `if (irPendingAutoRun_) showIrDrillLoading_(); else showIrForm()`
          // -- and runIrReport(), where the R30 clamp lives, fires on Generate.
          //
          // HONEST SCOPE, measured rather than assumed: this does NOT pin the
          // R30 red-note regression, because that note is not VISIBLE. Probing
          // the real page with the bug restored shows the clamp firing
          // correctly (to 2026-09-02 -> 2026-09-01) and the note set with
          // `status status-error` -- but the element sits inside
          // #individual-form, which the results replace, so it measures 0x0.
          // Both mutation runs passed for that reason, and passing was CORRECT.
          // What this asserts is the real property -- nothing red is visible on
          // a healthy render -- plus the first automated coverage of the IR
          // generate path, which no driver had. Do not read a green here as
          // proof that IR's tones are right; read it as proof that nothing red
          // reaches the screen.
          await page.waitForTimeout(2500);              // roster load
          const picked = await page.evaluate(() => {
            const box = document.querySelector('#ir-agent-list input[type=checkbox]');
            if (!box) return false;
            box.click();                                 // enables #ir-generate-btn
            return true;
          });
          if (picked) {
            const gen = page.locator('#ir-generate-btn');
            const genOn = await gen.count() && await gen.isVisible() && await gen.isEnabled();
            if (genOn) {
              await gen.click();
              await page.waitForTimeout(4000);
              // THE REGRESSION PIN: a generated report must not paint an
              // error. IR's window is clamped here (R30); a correction is not
              // a failure and must not wear the error tone.
              const irReds = await visibleErrorTones(page);
              record(role + ': generating an Individual Report shows no error tone',
                irReds.length === 0, irReds.join(' | '));
            } else {
              record(role + ': the IR Generate button enables after picking an agent',
                false, 'still disabled/hidden -- the tone check cannot run');
            }
          } else {
            record(role + ': the IR agent picker offers a selectable agent',
              false, 'no checkbox in #ir-agent-list -- the tone check cannot run');
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(600);
        } else {
          record(role + ': the Individual Report item is reachable from Reports',
            false, '#individual-report-btn not visible after opening the menu');
        }
      } else {
        record(role + ': the Reports menu is present for an admin', false,
          '#reports-menu-btn not visible');
      }
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

      // R18 (item 1): the panel's Range / Yesterday / MTD toggle. Range is the
      // page's own window and must stay the default -- it is the only period
      // whose figures reconcile with the agent table. MTD fetches a DIFFERENT
      // window through the same endpoint, so the assertion is that the numbers
      // actually move AND that the date chip names the period: an unlabelled
      // span beside a table built from another window reads as a bug.
      const trpRead = () => page.evaluate(() => {
        const tiles = document.querySelector('#trp-tiles .ds-kpi__foot');
        return {
          date: (document.getElementById('trp-date') || {}).textContent || '',
          active: Array.from(document.querySelectorAll('#trp-period .dept-qcd-period-btn'))
            .filter((b) => b.classList.contains('active'))
            .map((b) => b.getAttribute('data-trp-period')).join(','),
          rings: tiles ? tiles.textContent : '',
          rows: document.querySelectorAll('#trp-tbody tr.trp-row').length,
        };
      });
      // In-page clicks, not page.click: the panel rides a sticky aside and
      // can sit under the frost overlay, so Playwright's actionability wait
      // times out where a dispatched click is exactly what a user's is.
      const trpPick = (p) => page.evaluate((sel) => {
        const b = document.querySelector('#trp-period [data-trp-period="' + sel + '"]');
        if (b) b.click();
      }, p);
      const trpRange = await trpRead();
      await trpPick('mtd');
      await page.waitForTimeout(1800);
      const trpMtd = await trpRead();
      await trpPick('range');
      await page.waitForTimeout(1500);
      const trpBack = await trpRead();
      record(role + ': the Team Rings panel defaults to Range (reconciles with the table)',
        trpRange.active === 'range' && !/MTD|latest day/.test(trpRange.date),
        JSON.stringify(trpRange));
      // The MTD window is `latest.slice(0,8) + '01' .. latest`, and gen-payloads
      // derives `latest` from the wall clock, so what MTD ADDS to the page's
      // default single-day window (INV-43) depends on the calendar: nothing on
      // the 1st (the windows coincide -- failed CI 2026-09-02), only weekend days
      // when the month opens on one, and the fixture has rows on WEEKDAYS only.
      // So the property that actually holds is: the figures move exactly when the
      // MTD span adds a fixture weekday the Range span lacks. Read both spans off
      // the chip and count those days, rather than asserting "different" blindly
      // (the 2026-09-03 failure -- the mock was serving the wrong fixture too;
      // see build-harness's exact-window route).
      const trpSpan = (d) => String(d || '').replace(/\s*·.*$/, '').trim();
      const trpBounds = (span) => {
        const m = span.match(/\d{4}-\d{2}-\d{2}/g) || [];
        return { from: m[0] || '', to: m[m.length - 1] || m[0] || '' };
      };
      const trpAddedWeekdays = (mtdSpan, rangeSpan) => {
        const a = trpBounds(mtdSpan), b = trpBounds(rangeSpan);
        if (!a.from || !b.from) return -1;
        let n = 0;
        for (let d = new Date(a.from + 'T12:00:00'); d.toISOString().slice(0, 10) < b.from;
             d.setDate(d.getDate() + 1)) {
          if (d.getDay() !== 0 && d.getDay() !== 6) n++;
        }
        return n;
      };
      const rangeSpan = trpSpan(trpRange.date), mtdSpan = trpSpan(trpMtd.date);
      const sameWindow = mtdSpan === rangeSpan;
      const addedWeekdays = sameWindow ? 0 : trpAddedWeekdays(mtdSpan, rangeSpan);
      record(role + ': switching to MTD loads a DIFFERENT window and says so',
        trpMtd.active === 'mtd' && /MTD/.test(trpMtd.date) && addedWeekdays >= 0
          && (addedWeekdays > 0 ? trpMtd.rings !== trpRange.rings
                                : trpMtd.rings === trpRange.rings),
        JSON.stringify(Object.assign({ sameWindow: sameWindow, addedWeekdays: addedWeekdays,
          rangeSpan: rangeSpan, mtdSpan: mtdSpan }, trpMtd)));
      record(role + ': switching back to Range restores the page-window figures',
        trpBack.active === 'range' && trpBack.rings === trpRange.rings
          && trpBack.rows === trpRange.rows,
        JSON.stringify(trpBack));
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

    // R18d: the DQE-silence queue-lens badge. The fixture turns out to ship a
    // LIVE specimen of the incident shape -- Billing has QCD rows but no DQE
    // agents at all -- so the REAL server code computes dqeSilence for it and
    // the positive case is asserted permanently, no planted payload needed.
    // Both directions matter: the silent dept gets the labeled queue-lens
    // block, and every dept WITH ring activity gets none (a badge on a
    // healthy tile means ovBuildDqeSilenceNote_'s gate broke). Data-driven
    // off each tile's own Rung stat so fixture count drift can't break it.
    {
      await page.click('#overview-btn');
      await page.waitForTimeout(2000);
      const silence = await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll('.ov-dept-tile'));
        return tiles.map((t) => {
          const rungLbl = Array.from(t.querySelectorAll('.ov-dept-stat-label'))
            .find((l) => l.textContent.trim() === 'Rung');
          const rung = rungLbl
            ? Number((rungLbl.parentElement.textContent.replace(/[^0-9]/g, '')) || 0) : null;
          const badge = t.querySelector('.ov-dqe-silence');
          return { dept: t.getAttribute('data-dept'), rung: rung,
                   badge: !!badge,
                   badgeText: badge ? badge.textContent.replace(/\s+/g, ' ').trim() : '' };
        });
      });
      const silent = silence.filter((t) => t.badge);
      const wrong = silence.filter((t) => t.badge && t.rung > 0);
      record(role + ': the queue-only fixture dept gets the DQE-silence queue-lens badge',
        silent.length >= 1 && /queue calls/.test(silent[0].badgeText)
          && /Agent data dark/.test(silent[0].badgeText),
        JSON.stringify(silent));
      record(role + ': no silence badge on any dept WITH ring activity',
        wrong.length === 0, JSON.stringify(wrong));
      // Return to the dept page -- the blocks below assume it (the queue
      // calendar's metric select lives in the Insights region there).
      await page.click('#my-dept-btn');
      await page.waitForTimeout(3500);
    }

    // R18b (owner): the all-departments report shares ONE tally scale, the
    // same fix the email got in R18 -- a per-section unit made bar length
    // incomparable between departments, which is the same misread whether the
    // rows sit in an inbox or on a page. Asserted as the PROPERTY (monotonic
    // in volume) plus the two structural consequences: exactly one legend,
    // and no per-dept block-size note left behind.
    if (role === 'admin') {
      await page.evaluate(() => {
        const b = document.getElementById('ov-qcd-alldept-btn');
        if (b) b.click();
      });
      await page.waitForTimeout(2600);
      const qcd = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.qcd-alldept-table tbody tr'))
          .filter((tr) => tr.querySelector('.ans-tally'));
        return {
          legends: document.querySelectorAll('.qcd-tally-legend').length,
          perDeptNotes: document.querySelectorAll('.qcd-deptrow-unit').length,
          pairs: rows.map((tr) => ({
            calls: Number(((tr.querySelectorAll('td.num')[0] || {}).textContent || '0').replace(/[^0-9]/g, '')),
            blocks: tr.querySelectorAll('.ans-tally .tly').length,
            clip: !!tr.querySelector('.tly-clip'),
          })),
        };
      });
      const sorted = qcd.pairs.slice().sort((a, b) => a.calls - b.calls);
      const inversion = sorted.find((r, i) => i > 0 && r.blocks < sorted[i - 1].blocks && !sorted[i - 1].clip);
      record(role + ': the all-dept report tally is monotonic in call volume',
        qcd.pairs.length >= 3 && !inversion,
        inversion ? JSON.stringify(inversion) : JSON.stringify(qcd.pairs.slice(0, 4)));
      record(role + ': its block size is disclosed ONCE, with no per-dept note left over',
        qcd.legends === 1 && qcd.perDeptNotes === 0,
        'legends=' + qcd.legends + ' perDeptNotes=' + qcd.perDeptNotes);
      await page.evaluate(() => {
        const m = document.getElementById('qcd-alldept-modal');
        const c = m && m.querySelector('.modal-close');
        if (c) c.click();
      });
      await page.waitForTimeout(600);
    }

    // R18 (item 8): the QUEUE metric reaches the calendar too. R17d left it
    // span-gated because queueHealth.dailySeries covers the selected window
    // only and no year-scoped queue series existed; QCDReport now emits
    // ytdDailySeries from the 12-month trend pass it already runs. The
    // assertion is the same three-part one as the team metrics -- enabled,
    // drawn, and CAPTIONED -- because an uncaptioned year of abandon rates
    // reads as the selected day's.
    if (role === 'admin') {
      await page.selectOption('#ins-trend-metric', 'queues:abandonedPct');
      await page.waitForTimeout(1500);
      const qcal = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('#ins-trend-render-toggle .seg-btn'))
          .find((x) => (x.textContent || '').trim() === 'Calendar');
        if (btn && !btn.disabled) btn.click();
        return btn ? { enabled: !btn.disabled, title: (btn.closest('#ins-trend-render-toggle') || {}).title } : null;
      });
      await page.waitForTimeout(1200);
      const qdrawn = await page.evaluate(() => {
        const host = document.getElementById('ins-trend-calendar');
        return {
          shown: !!host && host.style.display !== 'none',
          cells: host ? host.querySelectorAll('.ins-cal-drill').length : 0,
          note: host ? ((host.querySelector('.ins-cal-ytd-note') || {}).textContent || '') : '',
          header: (document.getElementById('ins-trend-header') || {}).textContent || '',
        };
      });
      record(role + ': the queue abandon-% metric offers the calendar at any window length',
        !!qcal && qcal.enabled, JSON.stringify(qcal));
      record(role + ': the queue calendar draws from the year-to-date queue series, captioned',
        qdrawn.shown && qdrawn.cells > 0
          && /year to date/i.test(qdrawn.note + ' ' + qdrawn.header),
        JSON.stringify(qdrawn));
      await page.selectOption('#ins-trend-metric', 'answered');
      await page.waitForTimeout(900);
    }

    // R18 (item 4a): flipping light -> dark REPAINTS the charts that are on
    // screen, not just the Overview one. Chart.js bakes THEME.* at
    // construction, so a chart built under the light palette keeps drawing
    // near-black gridlines on a near-black canvas after the flip -- the zero
    // baseline vanished. Asserted on the palette each chart was BUILT with
    // (baked in at construction, not readable from any DOM attribute) via the
    // raw per-chart config -- both that the chart was rebuilt at all and that
    // it came back carrying dark tokens.
    {
      const snap = () => page.evaluate(() => {
        const out = { mode: document.body.getAttribute('data-mode'),
                      line: getComputedStyle(document.body).getPropertyValue('--line').trim(),
                      charts: {} };
        ['dept-missed-chart', 'ins-trend-chart', 'ins-cards-chart'].forEach((id) => {
          const c = document.getElementById(id);
          if (!c || c.offsetParent === null) return;
          const ch = (window.Chart && window.Chart.getChart) ? window.Chart.getChart(c) : null;
          if (!ch) return;
          const raw = ((ch.config && ch.config._config && ch.config._config.options) || {});
          const y = ((raw.scales || {}).y) || ((raw.scales || {}).y1) || {};
          out.charts[id] = { cid: ch.id, tick: (y.ticks || {}).color || '' };
        });
        return out;
      });
      const before = await snap();
      await page.click('#mode-btn');
      await page.waitForTimeout(1600);
      const after = await snap();
      const ids = Object.keys(before.charts);
      const rebuilt = ids.filter((id) => after.charts[id] && after.charts[id].cid !== before.charts[id].cid);
      const retinted = ids.filter((id) => after.charts[id]
        && after.charts[id].tick && after.charts[id].tick !== before.charts[id].tick);
      record(role + ': dark-mode flip rebuilds every on-screen dept chart (not just Overview)',
        ids.length >= 2 && rebuilt.length === ids.length && after.mode === 'dark',
        'mode=' + after.mode + ' charts=' + ids.join(',') + ' rebuilt=' + rebuilt.join(','));
      record(role + ': the rebuilt dept charts carry the DARK palette, not stale light tokens',
        ids.length >= 2 && retinted.length === ids.length && after.line !== before.line,
        'line ' + before.line + '->' + after.line + ' retinted=' + retinted.join(','));
      await page.click('#mode-btn');           // leave the page as we found it
      await page.waitForTimeout(1200);
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
          // The scroll is smooth; wait past it before measuring where it landed.
          await new Promise((r) => setTimeout(r, 1600));
          const lit = document.querySelector('#dept-missed-detail [data-agent-card].qs-spotlight')
            || document.querySelector('#dept-missed-detail [data-agent-card="' + want + '"]');
          const out = { want: want, got: lit ? lit.getAttribute('data-agent-card') : null,
                        open: lit ? lit.open : false };
          if (lit) {
            // R18b: how much of the sticky chrome covers the top of the page.
            let inset = 0;
            document.querySelectorAll('#dept-page .controls, #insights-results > .ir-results-header')
              .forEach((el) => {
                if (!el || !el.offsetHeight) return;
                const cs = getComputedStyle(el);
                if (cs.position !== 'sticky') return;
                inset = Math.max(inset, (parseFloat(cs.top) || 0) + el.getBoundingClientRect().height);
              });
            const r = lit.getBoundingClientRect();
            out.top = Math.round(r.top);
            out.bottom = Math.round(r.bottom);
            out.inset = Math.round(inset);
            out.vh = window.innerHeight;
            out.fits = r.height <= (window.innerHeight - inset);
          }
          return out;
        });
        record(role + ': a drill row\'s agent name jumps to that agent\'s card',
          !!landed.got && landed.got === landed.want && landed.open, JSON.stringify(landed));
        // R18b (owner): the spotlight must land the card FULLY visible. The old
        // scrollIntoView({block:'start'}) put its top at the viewport top --
        // i.e. underneath the pinned controls strip -- so the card it was
        // drawing attention to was the part that got covered.
        record(role + ': the spotlighted card clears the sticky chrome',
          landed.top == null || landed.top >= landed.inset - 1, JSON.stringify(landed));
        record(role + ': and its bottom is on screen when it can be',
          landed.top == null || !landed.fits || landed.bottom <= landed.vh + 1,
          JSON.stringify(landed));
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
