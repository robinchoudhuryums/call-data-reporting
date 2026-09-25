'use strict';
/**
 * ASSERTING driver for the ADMIN MODALS + the Escalations worklist.
 *
 * Why this exists: the admin surfaces (Alerts, Outlier Fix, Dept Config,
 * Access Control, System Health, Caller Lookup) and the Escalations page have
 * thorough SERVER-side pins -- assertAdmin_, the INV-01 write-path gates,
 * escalations-hardening -- and, until this driver, no assertion that any of
 * them RENDERS. That is the gap that shipped the header dept-selector
 * ReferenceError: server-correct, structurally unreachable from `node --test`,
 * and found by an admin rather than by CI.
 *
 * drive-phase3.js already opens these modals, but it is an exploratory
 * driver: it swallows every failure into a report for a human to read
 * (`rep.modals[name] = { error }`) and exits 0. It emits screenshots, and it
 * matches on loose selectors. This driver keeps the interaction shapes phase3
 * proved out and turns the observations into pass/fail.
 *
 * What it asserts, per modal:
 *   - it opens, and the expected panel is actually on screen
 *   - opening it produced no page/console error
 *   - focus stays trapped inside it (the F-42 discipline)
 *   - Escape closes it
 *   - the panel does not overflow the viewport
 * Plus, on Escalations: the page loads with its list, the dept filter is
 * present for an admin, and the nav count badge never duplicates (F10 --
 * badges must update in place, not append).
 *
 * Run: node drive-admin.js   (after gen-payloads + gen-phase3 + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

// Noise the file:// harness always produces; not app errors.
const IGNORABLE = /favicon|Failed to load resource|ERR_FILE_NOT_FOUND/i;

const MODALS = [
  { name: 'Alerts',         btn: '#alerts-btn',          sel: '#alerts-modal',         adminMenu: true },
  { name: 'Outlier Fix',    btn: '#orphan-fix-btn',      sel: '#orphan-fix-modal',     adminMenu: true },
  { name: 'Dept Config',    btn: '#dept-config-btn',     sel: '#dept-config-modal',    adminMenu: true },
  { name: 'Access Control', btn: '#access-control-btn',  sel: '#access-control-modal', adminMenu: true },
  // NB: the id is `health-modal`, NOT `system-health-modal`. It is taken from
  // the ROUTER TABLE in script-4-nav.html ('/admin/health' -> modalId), which
  // is the authority. drive-phase3.js guessed `#system-health-modal` and has
  // been reporting `{ found: false }` for this modal ever since -- invisibly,
  // because that driver never asserts. Read selectors off the router.
  { name: 'System Health',  btn: '#system-health-btn',   sel: '#health-modal',         adminMenu: true },
  { name: 'Caller Lookup',  btn: '#caller-lookup-btn',   sel: '#caller-lookup-modal',  adminMenu: false },
  // F1 (broad-scan 2026-09-09): the coaching worklist. It was the one admin
  // route in the router table with no rendered coverage -- thorough server
  // pins, and no assertion that the modal had ever OPENED, which is the
  // dept-selector class of bug this driver exists to catch. Its RPCs
  // (getCoachingWorklist / getCoachingDeliveryStatus) are already mocked in
  // build-harness.js. cross-file-pins.test.js now fails if a NEW modal route
  // joins the router without joining this list or the documented exemptions.
  { name: 'Coaching',       btn: '#coaching-btn',        sel: '#coaching-modal',       adminMenu: true },
  // 6c: the Outbound report modal. It lives under the REPORTS dropdown, not
  // the Admin one, hence `menu`. It was on cross-file-pins' documented
  // exemption list for "no harness fixture yet" -- stale, since
  // build-harness.js already mocks getOutboundReport + getOutboundUncalled.
  // The driver goes in BEFORE the manager release (Operator State #63), not
  // after: a surface reaching managers with zero rendered coverage is the
  // dept-selector class of bug, and a release runbook is exactly when
  // "we'll add the driver later" gets skipped. `run` drives the report past
  // its setup form -- a form-only visit would assert nothing about the
  // renderer, which is the half that can break.
  { name: 'Outbound',       btn: '#outbound-report-btn',  sel: '#outbound-modal',
    menu: '#reports-menu-btn',
    run: { click: '#outbound-generate-btn', wait: 2200, expect: [
      ['#outbound-kpi-row .ds-kpi', 'activity KPI tiles'],
      ['#outbound-callback-kpis .ds-kpi', 'callback KPI tiles'],
      ['#outbound-agent-tbody tr', 'per-agent rows'],
      // The six-point round's two new strips. Both hide themselves when
      // there is nothing to show, so asserting they RENDER on a populated
      // fixture is what catches a strip that silently never appears.
      ['#outbound-delay-strip .ob-delay-seg', 'time-to-callback distribution'],
      ['#outbound-hour-strip .ob-hour-cell', 'callback-by-abandon-hour strip'],
      ['#outbound-email-btn', 'the Email-to-me control'],
    ] } },
  // 6d: the agent-day view. Its RPCs (getAgentDay + getIndividualReportInit
  // for the picker) are mocked in build-harness.js. Like Outbound it opens on
  // a setup form, so `run` drives it through to the rendered day -- the
  // fixture is a FULL-tier day, so the tier banner must stay HIDDEN, which is
  // the assertion that catches an over-eager "we apologise on every day"
  // regression.
  //
  // R48: this entry's FOCUS check is also the live pin on trapFocus_'s
  // focus-lost-to-<body> recovery arm, and Agent Day is the only modal here
  // that exercises it -- its run button is the LAST focusable control, so
  // disabling it during the RPC blurs focus out with nothing after it to
  // catch the Tab. Every other modal has a control after its Generate
  // button and stays inside by DOM-order luck. Do not "simplify" this entry
  // by dropping `run`: without it the modal never reaches that state and
  // the arm goes untested.
  { name: 'Agent Day',      btn: '#agent-day-btn',        sel: '#agent-day-modal',
    menu: '#reports-menu-btn',
    run: { click: '#ad-run-btn', wait: 2000, expect: [
      ['#ad-day-kpis .ds-kpi', 'daily-total KPI tiles'],
      ['#ad-inbound-list .cl-call-card', 'inbound call cards'],
      ['#ad-outbound-list .cl-call-card', 'outbound call cards'],
      ['#ad-tier-note[style*="none"]', 'NO tier banner on a full-fidelity day'],
    ] } },
];

(async () => {
  const browser = await chromium.launch(launchOptions());

  async function boot() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORABLE.test(m.text())) errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 250)));
    await page.addInitScript(() => { try { localStorage.setItem('cdr.tour.done', '1'); } catch (e) {} });
    await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
    await page.waitForTimeout(1800);
    return { ctx, page, errors };
  }

  // ── Admin modals ────────────────────────────────────────────────────────
  for (const m of MODALS) {
    const { ctx, page, errors } = await boot();
    const before = errors.length;
    try {
      const menuBtn = m.menu || (m.adminMenu ? '#admin-menu-btn' : null);
      if (menuBtn) { await page.click(menuBtn); await page.waitForTimeout(300); }
      await page.click(m.btn);
      await page.waitForTimeout(2200);

      // Optional second step for a modal that opens on a SETUP FORM: run it
      // and assert the results actually rendered. Done before the focus /
      // Escape checks so those exercise the results view, which is the state
      // a user spends their time in.
      if (m.run) {
        await page.click(m.run.click);
        await page.waitForTimeout(m.run.wait || 2000);
        for (const [sel, label] of m.run.expect) {
          const n = await page.locator(m.sel + ' ' + sel).count();
          record(m.name + ': renders ' + label, n > 0, 'count=' + n);
        }
      }

      const info = await page.evaluate((sel) => {
        const modal = document.querySelector(sel);
        if (!modal) return { found: false };
        const panel = modal.querySelector('.modal-panel');
        const r = panel ? panel.getBoundingClientRect() : null;
        return {
          found: true,
          // Rendered visibility, not a class: a modal left display:none by a
          // throw mid-open still exists in the DOM.
          visible: modal.offsetParent !== null || getComputedStyle(modal).display !== 'none',
          hasContent: (modal.textContent || '').replace(/\s+/g, ' ').trim().length > 40,
          overflows: r ? (r.right > document.documentElement.clientWidth + 1) : null,
        };
      }, m.sel);

      record(m.name + ': the modal opens', !!info.found && info.visible,
        info.found ? ('visible=' + info.visible) : 'panel ' + m.sel + ' not in the DOM');
      record(m.name + ': the modal renders content', !!info.hasContent);

      // A PICKER WITH NOTHING TO PICK. Reported from production 2026-09-18:
      // the Alerts modal opened, rendered, trapped focus and closed -- every
      // check above passed -- while its dept <select> held no options, so no
      // alert could be created at all. `hasContent` cannot see it (the static
      // prose is plenty) and no server pin can (the list was a CLIENT-side
      // read of the USER envelope). So assert the control an admin has to use.
      if (m.name === 'Alerts' && info.found && info.visible) {
        const picker = await page.evaluate(() => {
          const sel = document.getElementById('al-cfg-dept');
          if (!sel) return { present: false };
          const vals = Array.from(sel.options).map((o) => o.value).filter(Boolean);
          const served = (window.__HARNESS_PAYLOADS__
            && window.__HARNESS_PAYLOADS__['alerts-init']
            && window.__HARNESS_PAYLOADS__['alerts-init'].departments) || null;
          return { present: true, vals: vals, served: served };
        });
        record('Alerts: the dept picker offers departments',
          !!picker.present && picker.vals.length > 0,
          picker.present ? 'options=' + JSON.stringify(picker.vals) : 'no #al-cfg-dept');
        // ...and they are the SERVER's list, which is what saveAlertConfigRow
        // validates against. A picker filled from a different source can offer
        // a dept the save then rejects.
        if (picker.served) {
          record('Alerts: the picker matches the served dept list',
            JSON.stringify(picker.vals) === JSON.stringify(picker.served),
            'picker=' + JSON.stringify(picker.vals) + ' served=' + JSON.stringify(picker.served));
        }
      }
      record(m.name + ': the panel does not overflow the viewport', info.overflows === false,
        'overflows=' + info.overflows);

      // Focus containment. A modal that leaks focus lets a keyboard user
      // operate the page behind it while it is still up.
      //
      // Both checks below are GATED on the modal actually being open. Their
      // first draft was not, and both reported PASS against a selector that
      // matched nothing (`inside` came back null, which is never === false,
      // so the escape counter stayed 0). A check that goes green when its
      // subject is absent is worse than no check -- it is the failure this
      // whole driver exists to stop.
      if (!info.found || !info.visible) {
        record(m.name + ': focus stays inside the modal (25 tabs)', false,
          'not asserted -- the modal never opened');
        record(m.name + ': Escape closes it', false,
          'not asserted -- the modal never opened');
      } else {
        let escapes = 0;
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press('Tab');
          const inside = await page.evaluate((sel) => {
            const modal = document.querySelector(sel);
            return modal ? modal.contains(document.activeElement) : null;
          }, m.sel);
          if (inside !== true) escapes++;
        }
        record(m.name + ': focus stays inside the modal (25 tabs)', escapes === 0,
          escapes ? escapes + ' escapes' : '');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        const closed = await page.evaluate((sel) => {
          const modal = document.querySelector(sel);
          if (!modal) return false;   // vanished entirely != closed cleanly
          return modal.offsetParent === null || getComputedStyle(modal).display === 'none';
        }, m.sel);
        record(m.name + ': Escape closes it', closed === true);
      }
    } catch (e) {
      // phase3 recorded this shape and moved on; here it is a failure.
      record(m.name + ': opens without throwing', false, String(e).slice(0, 160));
    }
    record(m.name + ': no page/console errors while open', errors.length === before,
      Array.from(new Set(errors.slice(before))).slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── UI-1 / UI-2: layers stacked OVER a report modal ─────────────────────
  // Help (via the FAB), the chart tips and the "↳ path" overlay can each
  // open on top of a report. Escape must close ONLY the top layer -- all
  // three used to listen in the bubble phase, as the report does, so one
  // Escape closed both and the report reopened on its empty form -- and
  // closing the layer must hand the report back its focus trap and scroll
  // lock. Agent Day is the host: it is a real report modal with a results
  // view, and its run button is the trap's hardest case (R48, above).
  {
    const { ctx, page, errors } = await boot();
    const before = errors.length;
    const HOST = '#agent-day-modal';
    const shown = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && getComputedStyle(el).display !== 'none';
    }, sel);
    const trapHolds = async (n) => {
      let out = 0;
      for (let i = 0; i < n; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate((s) => {
          const m = document.querySelector(s);
          return !!m && m.contains(document.activeElement);
        }, HOST);
        if (!inside) out++;
      }
      return out;
    };
    try {
      await page.click('#reports-menu-btn'); await page.waitForTimeout(300);
      await page.click('#agent-day-btn'); await page.waitForTimeout(1500);
      await page.click('#ad-run-btn'); await page.waitForTimeout(2000);
      const hostOpen = await shown(HOST);
      record('UI-1: the host report (Agent Day) is open', hostOpen);
      if (hostOpen) {
        // (1) Help over the report.
        await page.click('#help-fab'); await page.waitForTimeout(500);
        record('UI-1: Help opens over the report', await shown('#help-modal'));
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        record('UI-1: Escape closes Help', !(await shown('#help-modal')));
        record('UI-1: ...and leaves the report open', await shown(HOST));
        const ovf = await page.evaluate(() => document.body.style.overflow);
        record('UI-2: the report keeps its scroll lock after Help closes', ovf === 'hidden', 'overflow=' + JSON.stringify(ovf));
        const helpOut = await trapHolds(12);
        record('UI-2: the report\'s focus trap is re-armed after Help closes (12 tabs)', helpOut === 0,
          helpOut ? helpOut + ' escapes' : '');

        // (2) Chart tips opened from inside the report.
        await page.evaluate((s) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'chart-help-btn'; b.id = 'ui1-tips';
          b.setAttribute('data-charthelp', 'overview'); b.textContent = '?';
          document.querySelector(s + ' .modal-panel').appendChild(b);
        }, HOST);
        await page.click('#ui1-tips'); await page.waitForTimeout(300);
        record('UI-1: chart tips open over the report', await page.locator('.chart-help-pop').count() === 1);
        await page.keyboard.press('Escape'); await page.waitForTimeout(300);
        record('UI-1: Escape closes the chart tips', await page.locator('.chart-help-pop').count() === 0);
        record('UI-1: ...and leaves the report open', await shown(HOST));

        // (3) The "↳ path" overlay opened from inside the report.
        await page.evaluate((s) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'pid-journey'; b.id = 'ui1-path';
          b.setAttribute('data-journey-pid', 'IN-UI1'); b.setAttribute('data-journey-date', '2026-08-21');
          b.textContent = '↳ path';
          document.querySelector(s + ' .modal-panel').appendChild(b);
        }, HOST);
        await page.click('#ui1-path'); await page.waitForTimeout(700);
        const cjOpen = await shown('#call-journey-overlay');
        record('UI-1: the call-path overlay opens over the report', cjOpen);
        if (cjOpen) {
          await page.keyboard.press('Escape'); await page.waitForTimeout(400);
          record('UI-1: Escape closes the call-path overlay', !(await shown('#call-journey-overlay')));
          record('UI-1: ...and leaves the report open', await shown(HOST));
          const cjOut = await trapHolds(12);
          record('UI-2: the report\'s focus trap is re-armed after the overlay closes (12 tabs)', cjOut === 0,
            cjOut ? cjOut + ' escapes' : '');
        }

        // The base layer still answers Escape once nothing is stacked on it.
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        record('UI-1: with no layer above it, Escape still closes the report', !(await shown(HOST)));
      }
    } catch (e) {
      record('UI-1: stacked-layer walk runs without throwing', false, String(e).slice(0, 160));
    }
    record('UI-1: no page/console errors during the stacked-layer walk', errors.length === before,
      Array.from(new Set(errors.slice(before))).slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── UI-4: Escalations INIT failure ──────────────────────────────────────
  // A failed getEscalationsInit left the loader spinning beside the error,
  // offered no Retry, and never beaconed. The harness injects the failure.
  {
    const { ctx, page, errors } = await boot();
    const before = errors.length;
    try {
      await page.evaluate(() => { window.__HARNESS__.failOnce.getEscalationsInit = 1; });
      await page.click('#escalations-btn');
      await page.waitForTimeout(1200);
      const st = await page.evaluate(() => {
        const ld = document.getElementById('esc-loading');
        const er = document.getElementById('esc-error');
        return {
          loaderShown: !!ld && getComputedStyle(ld).display !== 'none' && ld.innerHTML.trim() !== '',
          errorShown: !!er && getComputedStyle(er).display !== 'none',
          retry: !!document.getElementById('esc-init-retry'),
          beacon: window.__HARNESS__.calls.some((c) => c.fn === 'reportClientIssue'
            && JSON.stringify(c.args).indexOf('Escalations init failed') !== -1),
        };
      });
      record('UI-4: a failed Escalations init clears the loader', st.loaderShown === false);
      record('UI-4: ...shows the error with a Retry control', st.errorShown && st.retry, JSON.stringify(st));
      record('UI-4: ...and reports the load failure', st.beacon === true);
      if (st.retry) {
        await page.click('#esc-init-retry');
        await page.waitForTimeout(2400);
        const cards = await page.evaluate(() => document.querySelectorAll('.esc-card').length);
        record('UI-4: Retry recovers the worklist', cards > 0, 'cards=' + cards);
      }
    } catch (e) {
      record('UI-4: init-failure walk runs without throwing', false, String(e).slice(0, 160));
    }
    record('UI-4: no page/console errors during the init-failure walk', errors.length === before,
      Array.from(new Set(errors.slice(before))).slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── Escalations worklist ────────────────────────────────────────────────
  {
    const { ctx, page, errors } = await boot();
    const before = errors.length;
    await page.click('#escalations-btn');
    await page.waitForTimeout(2600);

    const esc = await page.evaluate(() => ({
      page: document.body.dataset.page,
      cards: document.querySelectorAll('.esc-card').length,
      deptFilter: !!document.querySelector('#esc-dept-filter, [id*="esc-dept"]'),
      badges: document.querySelectorAll('.nav-count-badge').length,
    }));

    record('Escalations: the page becomes active', esc.page === 'escalations', 'data-page=' + esc.page);
    record('Escalations: the worklist renders cards', esc.cards > 0, 'cards=' + esc.cards);
    record('Escalations: an admin gets the dept filter', esc.deptFilter === true);

    // 2a: the admin Delete control -- rendered (visibly) on the cards, opens
    // the DANGER-tone confirm, Cancel keeps the card, Confirm calls the
    // (mocked) verb and reloads without a page error. Rendered VISIBILITY,
    // not class presence: view-as-manager hides it via [data-admin-only].
    {
      const del = page.locator('.esc-delete').first();
      const delCount = await page.locator('.esc-delete').count();
      record('2a: an admin sees a Delete control on the cards', delCount > 0, 'controls=' + delCount);
      if (delCount > 0) {
        const visible = await del.isVisible();
        record('2a: the Delete control is rendered visible for an admin', visible === true);
        await del.click();
        await page.waitForTimeout(300);
        const dlg = await page.evaluate(() => {
          const ok = document.querySelector('.ds-confirm-ok');
          return { open: !!ok, danger: !!(ok && ok.classList.contains('ds-confirm--danger')),
                   cancel: !!document.querySelector('.ds-confirm-cancel') };
        });
        record('2a: Delete opens the confirm dialog in DANGER tone', dlg.open && dlg.danger && dlg.cancel, JSON.stringify(dlg));
        const cardsBefore = esc.cards;
        await page.click('.ds-confirm-cancel');
        await page.waitForTimeout(300);
        const afterCancel = await page.evaluate(() => ({
          dlg: !!document.querySelector('.ds-confirm-ok'),
          cards: document.querySelectorAll('.esc-card').length,
        }));
        record('2a: Cancel closes the dialog and keeps every card', !afterCancel.dlg && afterCancel.cards === cardsBefore, JSON.stringify(afterCancel));
        await del.click();
        await page.waitForTimeout(300);
        await page.click('.ds-confirm-ok');
        await page.waitForTimeout(1500);
        const afterOk = await page.evaluate(() => ({
          dlg: !!document.querySelector('.ds-confirm-ok'),
          cards: document.querySelectorAll('.esc-card').length,
        }));
        record('2a: Confirm calls the verb and the list reloads cleanly', !afterOk.dlg && afterOk.cards > 0, JSON.stringify(afterOk));
      }
    }

    // F10: the nav badge must update IN PLACE. The original bug rendered it
    // behind an "if it does not already exist" guard and fetched once, so it
    // could neither update nor disappear -- and a second render appended a
    // duplicate. Re-entering the page is what exposes that.
    await page.click('#my-dept-btn');
    await page.waitForTimeout(900);
    await page.click('#escalations-btn');
    await page.waitForTimeout(2200);
    const after = await page.evaluate(() => document.querySelectorAll('.nav-count-badge').length);
    record('F10: the escalations badge does not duplicate across re-entry',
      after <= 1, 'badges=' + after);

    record('Escalations: no page/console errors during the walk',
      errors.length === before,
      Array.from(new Set(errors.slice(before))).slice(0, 2).join(' | '));
    await ctx.close();
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
