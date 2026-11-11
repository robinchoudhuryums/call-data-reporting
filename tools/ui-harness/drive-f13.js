'use strict';
/**
 * F13 verification driver: walks the five formerly mouse-only surfaces with
 * KEYBOARD ONLY and asserts each one activates. Audit tooling, never shipped
 * (same contract as the sibling drive*.js scripts).
 *
 * Run: node drive-f13.js   (after build-harness.js admin)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');   // revision-globbing Chromium resolver

const SITE = 'file://' + path.join(__dirname, 'site', 'index-admin.html');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // Suppress the first-run onboarding tour + Insights intro card: the tour's
  // overlay intercepts pointer events and would time out every click (same
  // init-script guard the sibling drivers use).
  await page.addInitScript(() => {
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
    // Step 3: an admin's default is inbound + outbound together, which shows
    // the combined table; this driver walks the INBOUND table (columns off).
    localStorage.setItem('cdr.dept.direction', 'in');
  });

  await page.goto(SITE);
  await page.waitForTimeout(2500);

  // ---- 1. Overview dept tile: focusable + Enter solos the chart line -------
  const tile = page.locator('.ov-dept-tile[data-dept]').first();
  await tile.waitFor({ state: 'visible', timeout: 10000 });
  // C1-14: the tile is DESCRIBED, never aria-labelled -- a label would
  // replace its accessible content (the KPIs) with the isolate action. The
  // name is the tile's own text; the description must resolve to real text.
  const tileAttrs = await tile.evaluate((el) => {
    const descId = el.getAttribute('aria-describedby');
    const desc = descId && document.getElementById(descId);
    return {
      tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
      described: !!(desc && desc.textContent.trim()),
      hasName: (el.textContent || '').trim().length > 0,
    };
  });
  record('OV tile is focusable + announced (content is the name, the action is a description)',
    tileAttrs.tabindex === '0' && tileAttrs.role === 'button' && !tileAttrs.label
      && tileAttrs.described && tileAttrs.hasName,
    JSON.stringify(tileAttrs));

  await tile.focus();
  const tileFocused = await tile.evaluate((el) => el === document.activeElement);
  record('OV tile takes focus', tileFocused);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const soloed = await page.evaluate(() =>
    document.querySelectorAll('.ov-dept-tile.ov-tile-soloed').length);
  record('OV tile Enter solos the dept (chart pin applied)', soloed === 1, 'soloed=' + soloed);

  // A visible focus ring must exist (outline set by the F13 styles.html rule).
  const ring = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { w: cs.outlineWidth, style: cs.outlineStyle };
  });
  record('OV tile has a focus outline', ring.style !== 'none' && parseFloat(ring.w) > 0,
    JSON.stringify(ring));
  await page.keyboard.press('Enter');   // release the solo

  // ---- 2. My Department agent row: Enter opens the inline agent panel, ------
  //         whose first button opens the Individual Report (Batch B)
  await page.click('#my-dept-btn');
  await page.waitForTimeout(2500);
  // F27 (broad-scan 2026-10-14): the control is the name cell's BUTTON, which
  // owns aria-expanded; the row keeps its row semantics and is no tab stop.
  const rowEl = page.locator('#agents-tbody tr[data-agent]').first();
  await rowEl.waitFor({ state: 'visible', timeout: 10000 });
  const rowAttrs = await rowEl.evaluate((el) => {
    const b = el.querySelector('button.ap-row-toggle');
    return { tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
             rowExpanded: el.getAttribute('aria-expanded'), button: !!b,
             expanded: b ? b.getAttribute('aria-expanded') : null };
  });
  record('agent row keeps its row semantics; its name-cell button is the control',
    rowAttrs.tabindex === null && rowAttrs.role === null && rowAttrs.rowExpanded === null
      && rowAttrs.button && rowAttrs.expanded === 'false', JSON.stringify(rowAttrs));
  const row = rowEl.locator('button.ap-row-toggle');

  await row.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const panelOpen = await page.evaluate(() => !!document.getElementById('ap-panel'));
  record('agent row Enter opens the inline agent panel', panelOpen);
  const expandedNow = await row.getAttribute('aria-expanded');
  record('the name button says the panel is expanded', expandedNow === 'true', 'aria-expanded=' + expandedNow);
  // Keyboard path from the row to the report: Tab reaches the panel's
  // "Individual report" button first (it leads the panel's header).
  await page.keyboard.press('Tab');
  const onIrBtn = await page.evaluate(() =>
    !!document.activeElement && document.activeElement.hasAttribute('data-ap-ir'));
  record('Tab from the open row reaches the panel\'s Individual report button', onIrBtn);
  if (!onIrBtn) await page.focus('#ap-panel [data-ap-ir]').catch(() => {});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  const irOpen = await page.evaluate(() => {
    const m = document.getElementById('individual-modal');
    return !!m && getComputedStyle(m).display !== 'none';
  });
  record('the panel\'s Individual report button opens the report on Enter', irOpen);
  if (irOpen) {
    // UI-1 follow-on: Escape on the report's Export MENU closes the menu
    // only. The menu's Escape used to bubble to the modal's own handler, so
    // one press closed the menu AND the report. Both entry shapes: focus on
    // the trigger (click-opened) and focus inside the menu (ArrowDown).
    const irShown = () => page.evaluate(() => {
      const m = document.getElementById('individual-modal');
      return !!m && getComputedStyle(m).display !== 'none';
    });
    const menuShown = () => page.evaluate(() => {
      const m = document.getElementById('ir-export-menu');
      return !!m && getComputedStyle(m).display !== 'none';
    });
    const exportVisible = await page.locator('#ir-export-btn').isVisible().catch(() => false);
    if (exportVisible) {
      await page.click('#ir-export-btn');
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      record('IR Export menu (click-opened): Escape closes the menu only',
        !(await menuShown()) && (await irShown()));
      await page.focus('#ir-export-btn');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      const inMenu = await page.evaluate(() =>
        document.getElementById('ir-export-menu').contains(document.activeElement));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      record('IR Export menu (keyboard-opened): Escape closes the menu only',
        inMenu && !(await menuShown()) && (await irShown()), 'focusInMenu=' + inMenu);
    } else {
      record('IR Export menu is reachable for the Escape check', false, '#ir-export-btn not visible');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }

  // Close the panel from the keyboard before the Space check, so Space below
  // OPENS it (a toggle) and the scroll assertion measures a real activation.
  await page.focus('#ap-panel [data-ap-ir]').catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closedToRow = await page.evaluate(() => ({
    open: !!document.getElementById('ap-panel'),
    onRow: !!document.activeElement && document.activeElement.classList.contains('ap-row-toggle'),
    expanded: document.activeElement ? document.activeElement.getAttribute('aria-expanded') : null,
  }));
  record('Escape in the panel closes it and returns focus to the row\'s button (aria-expanded=false, not removed)',
    !closedToRow.open && closedToRow.onRow && closedToRow.expanded === 'false', JSON.stringify(closedToRow));

  // ---- 3. Space must not scroll the page while a row is focused ------------
  await row.focus();
  const beforeY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(' ');
  await page.waitForTimeout(600);
  const afterY = await page.evaluate(() => window.scrollY);
  record('Space on a row activates without scrolling the page', beforeY === afterY,
    'scrollY ' + beforeY + ' -> ' + afterY);
  const spaceOpened = await page.evaluate(() => !!document.getElementById('ap-panel'));
  record('Space on a row opens the panel too', spaceOpened);
  if (spaceOpened) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }

  // ---- 4. QCD carousel dots (only when the dept has >1 queue page) --------
  const dots = await page.locator('.dept-qcd-dot').count();
  if (dots > 1) {
    const dot = page.locator('.dept-qcd-dot').nth(1);
    const dotAttrs = await dot.evaluate((el) => ({
      tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
    }));
    record('QCD carousel dot is focusable + announced',
      dotAttrs.tabindex === '0' && dotAttrs.role === 'button' && !!dotAttrs.label,
      JSON.stringify(dotAttrs));
    await dot.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const active = await page.evaluate(() => {
      const ds = Array.from(document.querySelectorAll('.dept-qcd-dot'));
      return ds.findIndex((d) => d.classList.contains('is-active'));
    });
    record('QCD dot Enter changes the carousel page', active === 1, 'activeIdx=' + active);
  } else {
    record('QCD carousel dots present (fixture has ' + dots + ')', true, 'skipped -- single-queue dept');
  }

  // ---- 5. Expandable QCD queue rows (BOTH surfaces) ------------------------
  // Insights Queue health and the all-departments QCD report render the same
  // `tr.qcd-expandable` + `tr.qcd-detail-row` pair and share qcdToggleExpandRow_,
  // but they wire their own SEPARATE delegated keydown handlers (one on the
  // Insights tbody, one on #qcd-alldept-body) -- so both need a walk.
  const expandableSurfaces = [
    { label: 'Insights Queue health', sel: '#ins-queue-health tr.qcd-expandable',
      open: async () => {
        // N1: the Insights section renders open inline on the dept page and
        // generates with it -- just enter the page and wait for the render.
        await page.click('#my-dept-btn'); await page.waitForTimeout(5000);
        // Step 3: for the admin, Queue health sits in a COLLAPSED brief row --
        // open it from the keyboard (the row is a real button: Enter toggles).
        const row = page.locator('#ins-brief .ins-brief-row[data-brief-key="queue"]');
        if (await row.count()) {
          await row.focus();
          await page.keyboard.press('Enter');
          await page.waitForTimeout(600);
          record('the brief\'s Queue health row opens from the keyboard',
            (await row.getAttribute('aria-expanded')) === 'true', '');
        }
      } },
    { label: 'all-dept QCD report', sel: '#qcd-alldept-body tr.qcd-expandable',
      open: async () => {
        await page.click('#overview-btn'); await page.waitForTimeout(1200);
        await page.click('#ov-qcd-alldept-btn'); await page.waitForTimeout(2500);
      } },
  ];
  for (const surface of expandableSurfaces) {
    await surface.open();
    const exp = page.locator(surface.sel).first();
    if (await exp.count()) {
      // A11y tidy-up (the E-8 contract): the disclosure is a real <button> in
      // the first cell that owns aria-expanded; the row is no tab stop. One
      // Enter must toggle ONCE -- a leftover row keydown would toggle twice.
      const expAttrs = await exp.evaluate((el) => {
        const b = el.querySelector('button.qcd-expand-toggle');
        return { rowTabindex: el.getAttribute('tabindex'), rowExpanded: el.getAttribute('aria-expanded'),
                 button: !!b, expanded: b ? b.getAttribute('aria-expanded') : null };
      });
      record(surface.label + ': the disclosure is a button that reports state (the row is not a tab stop)',
        expAttrs.button && expAttrs.expanded === 'false' && expAttrs.rowTabindex === null
          && expAttrs.rowExpanded === null, JSON.stringify(expAttrs));
      const toggle = exp.locator('button.qcd-expand-toggle');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const opened = await exp.evaluate((el) => {
        const d = el.nextElementSibling;
        const b = el.querySelector('button.qcd-expand-toggle');
        return {
          shown: !!d && d.classList.contains('qcd-detail-row') && d.style.display !== 'none',
          expanded: b ? b.getAttribute('aria-expanded') : null,
        };
      });
      record(surface.label + ': Enter expands the per-source detail',
        opened.shown && opened.expanded === 'true', JSON.stringify(opened));
      await page.keyboard.press(' ');
      await page.waitForTimeout(400);
      const closed = await exp.evaluate((el) => el.querySelector('button.qcd-expand-toggle').getAttribute('aria-expanded'));
      record(surface.label + ': Space collapses it again', closed === 'false', 'aria-expanded=' + closed);
    } else {
      record(surface.label + ': expandable row present', false, 'no qcd-expandable row in the fixture');
    }
  }

  // ---- Batch 9 (broad-scan 2026-11-10): keyboard paths on My Department ----
  {
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const onDept = await page.evaluate(() => document.body.getAttribute('data-page') === 'dept');
    if (!onDept) { await page.click('#my-dept-btn'); await page.waitForTimeout(4000); }
    const active = () => page.evaluate(() => { const a = document.activeElement; return a ? a.id : ''; });

    // F74: the half-hour drill. The bars are a canvas and the ring-time links
    // are out of the tab order (UD-4), so ONE picker is the keyboard path. It
    // is clipped until it has keyboard focus.
    const pick0 = await page.evaluate(() => {
      const p = document.getElementById('dept-missed-bucket-pick');
      if (!p) return null;
      p.scrollIntoView({ block: 'center' });
      return { hidden: p.hidden, w: p.getBoundingClientRect().width, opts: Array.from(p.options).map((o) => o.textContent),
               links: document.querySelectorAll('#dept-missed-detail .ms-bucket-link:not([tabindex="-1"])').length };
    });
    record('F74: the half-hour picker lists the half-hours that have missed rings, and is clipped for a mouse user',
      !!pick0 && !pick0.hidden && pick0.w <= 1 && pick0.opts.length >= 2 && pick0.opts[0] === 'Half-hour…'
        && pick0.opts.slice(1).every((o) => /^\d{1,2}:\d{2} [AP]M · \d+ missed$/.test(o)) && pick0.links === 0, JSON.stringify(pick0));
    if (pick0 && !pick0.hidden) {
      await page.focus('#dept-missed-bucket-pick');
      await page.keyboard.press('ArrowDown'); await page.waitForTimeout(800);
      const opened = await page.evaluate(() => {
        const p = document.getElementById('dept-missed-bucket-pick'), w = document.getElementById('dept-missed-bucket-detail');
        const label = p.options[p.selectedIndex].textContent;
        return { w: p.getBoundingClientRect().width, open: w.style.display !== 'none', label: label,
                 title: document.getElementById('dept-bucket-detail-title').textContent,
                 rows: w.querySelectorAll('.heat-drill-row').length, want: Number((/· (\d+) missed/.exec(label) || [])[1]) };
      });
      record('F74: an arrow key on the picker opens that half-hour, with the count the option promised',
        opened.w > 40 && opened.open && opened.title.indexOf(opened.label.split(' · ')[0]) === 0 && opened.rows === opened.want, JSON.stringify(opened));
      // Tab walks from the picker into the open panel; closing it there comes back.
      let reached = false;
      for (let i = 0; i < 4 && !reached; i++) { await page.keyboard.press('Tab'); reached = (await active()) === 'dept-bucket-detail-close'; }
      record('F74: Tab reaches the open panel from the picker', reached, 'active=#' + await active());
      await page.keyboard.press('Enter'); await page.waitForTimeout(400);
      const closedBack = await page.evaluate(() => ({ open: document.getElementById('dept-missed-bucket-detail').style.display !== 'none',
        val: document.getElementById('dept-missed-bucket-pick').value, active: document.activeElement.id }));
      record('F74: closing the panel from inside it returns focus to the picker, which resets',
        !closedBack.open && closedBack.val === '' && closedBack.active === 'dept-missed-bucket-pick', JSON.stringify(closedBack));
    }

    // F77: the date chips say which one is in force.
    const chipState = () => page.evaluate(() => Array.from(document.querySelectorAll('#date-presets .date-preset-chip'))
      .map((c) => (c.classList.contains('active') ? 'A' : '-') + (c.getAttribute('aria-pressed') === 'true' ? 'P' : (c.getAttribute('aria-pressed') === 'false' ? '-' : '?'))).join(' '));
    const c0 = await chipState();
    await page.locator('#date-presets .date-preset-chip', { hasText: 'Last 7 days' }).focus();
    await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    const c1 = await chipState();
    record('F77: a date chip is announced as pressed exactly when it is the selected one',
      c0.split(' ').every((x) => x === '--') && c1.split(' ').filter((x) => x === 'AP').length === 1
        && c1.split(' ').every((x) => x === 'AP' || x === '--'), JSON.stringify({ before: c0, after: c1 }));

    // F75: the Insights "Comparison & agents" popover takes focus and gives it back.
    const editShown = await page.evaluate(() => { const e = document.getElementById('ins-edit-selection-btn');
      if (e) e.scrollIntoView({ block: 'center' }); return !!e && e.getClientRects().length > 0; });
    if (editShown) {
      await page.focus('#ins-edit-selection-btn'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
      const inPop = await page.evaluate(() => { const p = document.getElementById('ins-edit-popover'); const a = document.activeElement;
        return { open: p.style.display !== 'none', inside: p.contains(a), isClose: a.id === 'ins-edit-popover-close', tag: a.tagName }; });
      record('F75: opening the popover moves focus into it (not onto its Close button)', inPop.open && inPop.inside && !inPop.isClose, JSON.stringify(inPop));
      await page.focus('#ins-edit-popover-close'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
      const afterClose = await page.evaluate(() => ({ open: document.getElementById('ins-edit-popover').style.display !== 'none', active: document.activeElement.id }));
      record('F75: its Close button returns focus to the button that opened it',
        !afterClose.open && afterClose.active === 'ins-edit-selection-btn', JSON.stringify(afterClose));
    } else {
      record('F75: the Insights edit button is on the page', false, '#ins-edit-selection-btn not visible');
    }

    // F79: no label on the page explains itself to a mouse only -- bar the two
    // per-agent-card chips, which repeat on every card (UD-4) and whose
    // wording is on the chip or in Help.
    const gl = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.gloss')).filter((e) => e.getClientRects().length > 0
        && !e.classList.contains('ins-trend-pill') && !e.classList.contains('cr-vs-team'));
      const reach = (e) => e.tabIndex >= 0 || !!e.querySelector('button,a[href],[tabindex]')
        || !!e.parentElement.closest('button,a[href],summary,[role="button"],[role="tab"],[role="menuitem"]');
      return { total: all.length, unreachable: all.filter((e) => !reach(e)).map((e) => e.textContent.trim().slice(0, 24)) };
    });
    record('F79: every hover-explained label on My Department is reachable by keyboard',
      gl.total > 0 && gl.unreachable.length === 0, JSON.stringify(gl));
  }

  const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  record('no console/page errors during the walk', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})();
