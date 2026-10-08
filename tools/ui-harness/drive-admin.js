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
  // (G3: the Outbound report modal is retired. Its content is driven on My
  // Department by drive-callbacks.js / drive-deptoutbound.js and its
  // company-view table on the Overview by drive-cbdept.js.)
  // 6d: the agent-day view. Its RPCs (getAgentDay + getIndividualReportInit
  // for the picker) are mocked in build-harness.js. It opens on
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
        if (m.run.probe) await m.run.probe(page, record);
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
        // CL-3: the reload rebuilds every card; keyboard focus must land back
        // on the acted-on control (or its card), never fall to <body>.
        const focusAfter = await page.evaluate(() => {
          const ae = document.activeElement;
          const list = document.getElementById('esc-list');
          return { tag: ae ? ae.tagName : null, cls: ae ? String(ae.className || '') : '',
                   inList: !!(ae && list && list.contains(ae)) };
        });
        record('CL-3: after the reload, focus returns inside the worklist (not <body>)',
          focusAfter.inList === true, JSON.stringify(focusAfter));
      }
    }

    // ESC-L1: a LINKED copy names the other departments holding a copy, the
    // Move list never offers a dept that already holds one, the Overview strip
    // labels the linked count, and a two-department create sends both depts.
    {
      const lk = await page.evaluate(() => {
        const card = [...document.querySelectorAll('.esc-card')].find((c) => c.querySelector('.esc-linked'));
        const cid = card ? card.getAttribute('data-id') : '';
        const p = cid ? document.querySelector('.esc-move[data-id="' + CSS.escape(cid) + '"]') : null;
        const strip = document.getElementById('ov-esc-strip');
        return { line: card ? card.querySelector('.esc-linked').textContent.replace(/\s+/g, ' ').trim() : '',
                 opts: p ? [...p.querySelectorAll('.esc-move-dept option')].map((o) => o.value) : null,
                 strip: strip ? strip.textContent : '' };
      });
      record('ESC-L1: a linked copy renders the other department and its status',
        /Also assigned to/.test(lk.line) && /Sales/.test(lk.line) && /in progress/.test(lk.line), JSON.stringify(lk));
      record('ESC-L1: Move never offers a department that already holds a linked copy',
        Array.isArray(lk.opts) && lk.opts.length > 0 && lk.opts.indexOf('Sales') === -1, JSON.stringify(lk.opts));
      record('ESC-L1: the Overview escalations strip labels the linked copies', /\(1 linked\)/.test(lk.strip), lk.strip);

      await page.click('#esc-new-btn');
      await page.waitForTimeout(200);
      const multi = await page.evaluate(() => {
        const sel = document.getElementById('esc-c-dept');
        return { multiple: !!(sel && sel.multiple), picked: sel ? [...sel.options].filter((o) => o.selected).length : -1 };
      });
      record('ESC-L1: the create form offers a multi-department pick, none pre-selected',
        multi.multiple && multi.picked === 0, JSON.stringify(multi));
      await page.selectOption('#esc-c-dept', ['CSR', 'Sales']);
      await page.fill('#esc-c-reason', 'Harness: linked two-department escalation');
      await page.click('#esc-c-save');
      await page.waitForTimeout(1500);
      const sent = await page.evaluate(() => {
        const c = window.__HARNESS__.calls.filter((x) => x.fn === 'createEscalation').pop();
        return c ? c.args[0] : null;
      });
      record('ESC-L1: a two-department create sends both departments in one call',
        !!sent && Array.isArray(sent.departments) && sent.departments.join('|') === 'CSR|Sales', JSON.stringify(sent));
    }

    // ESC-L2 (Step 2b): the removed copy renders read-only; a linked copy
    // offers Link / Remove / Delete-all-linked; the shared thread tags each
    // entry with its department; Remove REQUIRES a reason (validated in place).
    {
      const st = await page.evaluate(() => {
        const card = (id) => [...document.querySelectorAll('.esc-card')].find((c) => c.getAttribute('data-id') === id);
        const rm = card('96'), lk = card('101');
        const has = (c, sel) => !!(c && c.querySelector(sel));
        const lp = document.querySelector('.esc-link[data-id="101"]');
        return {
          rmPill: rm ? (rm.querySelector('.esc-pill') || {}).textContent : null,
          rmNote: rm ? ((rm.querySelector('.esc-removed-note') || {}).textContent || '') : '',
          rmWrite: rm ? ['.esc-resolve-disc', '.esc-start', '.esc-move-toggle', '.esc-link-toggle', '.esc-remove-dept', '.esc-reopen-toggle']
            .filter((q) => has(rm, q)) : null,
          lkBtns: lk ? ['.esc-link-toggle', '.esc-remove-dept', '.esc-delete-all'].map((q) => has(lk, q)) : null,
          linkOpts: lp ? [...lp.querySelectorAll('.esc-link-dept option')].map((o) => o.value) : null,
          removedOpt: !!document.querySelector('#esc-status option[value="removed"]'),
        };
      });
      record('ESC-L2: a removed copy renders read-only (Removed pill, the reason, no write controls)',
        st.rmPill === 'Removed' && /was removed from this escalation/.test(st.rmNote) && /Dispute upheld/.test(st.rmNote)
          && Array.isArray(st.rmWrite) && st.rmWrite.length === 0, JSON.stringify(st));
      record('ESC-L2: a linked copy offers Link, Remove and Delete all linked to an admin',
        Array.isArray(st.lkBtns) && st.lkBtns.every(Boolean), JSON.stringify(st.lkBtns));
      record('ESC-L2: Link never offers the card\'s own or an already-linked department',
        Array.isArray(st.linkOpts) && st.linkOpts.length > 0
          && ['CSR', 'Sales', 'Power'].every((d) => st.linkOpts.indexOf(d) === -1), JSON.stringify(st.linkOpts));
      record('ESC-L2: the status filter carries a Removed option', st.removedOpt);

      // Shared thread: open 101's Activity.
      await page.click('.esc-activity-summary[data-id="101"]');
      await page.waitForTimeout(700);
      const th = await page.evaluate(() => {
        const b = document.querySelector('.esc-activity-body[data-id="101"]');
        return b ? [...b.querySelectorAll('.esc-timeline-dept')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()) : null;
      });
      record('ESC-L2: the linked thread tags every entry with its department, a removed one marked',
        Array.isArray(th) && th.indexOf('CSR') !== -1 && th.some((t) => /^Power · removed$/.test(t)), JSON.stringify(th));

      // Link: open the panel + save.
      await page.click('.esc-link-toggle[data-id="101"]');
      await page.waitForTimeout(200);
      await page.click('.esc-link-save[data-id="101"]');
      await page.waitForTimeout(1500);
      const linkCall = await page.evaluate(() => {
        const c = window.__HARNESS__.calls.filter((x) => x.fn === 'linkEscalationDepartment').pop();
        return c ? c.args[0] : null;
      });
      record('ESC-L2: Link calls the verb with the picked department', !!linkCall && linkCall.id === '101' && !!linkCall.department,
        JSON.stringify(linkCall));

      // Remove: the prompt refuses an empty reason in place, then sends it.
      await page.click('.esc-remove-dept[data-id="101"]');
      await page.waitForTimeout(300);
      await page.click('.ds-confirm-ok');
      await page.waitForTimeout(200);
      const v = await page.evaluate(() => {
        const e = document.querySelector('.ds-prompt-error');
        return { open: !!document.querySelector('.ds-prompt-input'), err: e && !e.hidden ? e.textContent : '' };
      });
      record('ESC-L2: Remove requires a reason (validated in the dialog)', v.open && /reason/i.test(v.err), JSON.stringify(v));
      await page.fill('.ds-prompt-input', 'Harness: dispute upheld');
      await page.click('.ds-confirm-ok');
      await page.waitForTimeout(1500);
      const rmCall = await page.evaluate(() => {
        const c = window.__HARNESS__.calls.filter((x) => x.fn === 'removeEscalationDepartment').pop();
        return c ? c.args[0] : null;
      });
      record('ESC-L2: Remove sends the reason', !!rmCall && rmCall.id === '101' && rmCall.reason === 'Harness: dispute upheld',
        JSON.stringify(rmCall));

      // Delete all linked: a DANGER confirm naming every department; cancel.
      await page.click('.esc-delete-all[data-id="101"]');
      await page.waitForTimeout(300);
      const dd = await page.evaluate(() => {
        const t = document.querySelector('.ds-confirm-title');
        const ok = document.querySelector('.ds-confirm-ok');
        const body = document.querySelector('.ds-confirm-body');
        return { title: t ? t.textContent : '', danger: !!(ok && ok.classList.contains('ds-confirm--danger')),
                 body: body ? body.textContent : '' };
      });
      record('ESC-L2: Delete all linked confirms in DANGER tone, naming every linked department',
        /every linked copy/i.test(dd.title) && dd.danger && ['CSR', 'Sales', 'Power'].every((d) => dd.body.indexOf(d) !== -1), JSON.stringify(dd));
      await page.click('.ds-confirm-cancel');
      await page.waitForTimeout(300);
    }

    // ESC-L3: a removed copy offers Restore (admin), which sends an optional
    // note; ESC-S1: a thread served from the offline copy says so.
    {
      const has = await page.evaluate(() => !!document.querySelector('.esc-restore-dept[data-id="96"]')
        && !document.querySelector('.esc-restore-dept[data-id="101"]'));
      record('ESC-L3: only a REMOVED copy offers Restore', has);
      await page.click('.esc-restore-dept[data-id="96"]');
      await page.waitForTimeout(300);
      await page.click('.ds-confirm-ok');   // an empty note is allowed
      await page.waitForTimeout(1500);
      const rc = await page.evaluate(() => {
        const c = window.__HARNESS__.calls.filter((x) => x.fn === 'restoreEscalationDepartment').pop();
        return c ? c.args[0] : null;
      });
      record('ESC-L3: Restore calls the verb for that copy (the note is optional)', !!rc && rc.id === '96' && rc.note === '', JSON.stringify(rc));

      await page.click('.esc-activity-summary[data-id="100"]');
      await page.waitForTimeout(700);
      const off = await page.evaluate(() => {
        const b = document.querySelector('.esc-activity-body[data-id="100"]');
        return { note: b && b.querySelector('.esc-activity-offline') ? b.querySelector('.esc-activity-offline').textContent : '',
                 short: !!(b && b.querySelector('.esc-timeline-short')), entries: b ? b.querySelectorAll('.esc-timeline-item').length : 0 };
      });
      record('ESC-S1: an offline-copy thread renders with its banner and marks shortened entries',
        /Offline copy from/.test(off.note) && off.short && off.entries === 1, JSON.stringify(off));
    }

    // ESC-R1: the admin "Move…" control on an open card -- rendered visible,
    // toggles an inline panel whose department list EXCLUDES the card's own
    // dept, and "Move escalation" calls the (mocked) verb and reloads cleanly.
    {
      const tgl = page.locator('.esc-move-toggle').first();
      const n = await page.locator('.esc-move-toggle').count();
      record('ESC-R1: an admin sees a Move control on the open cards', n > 0, 'controls=' + n);
      if (n > 0) {
        record('ESC-R1: the Move control is rendered visible for an admin', (await tgl.isVisible()) === true);
        const id = await tgl.getAttribute('data-id');
        await tgl.click();
        await page.waitForTimeout(200);
        const panel = await page.evaluate((cid) => {
          const card = [...document.querySelectorAll('.esc-card')].find((c) => c.getAttribute('data-id') === cid);
          const p = document.querySelector('.esc-move[data-id="' + CSS.escape(cid) + '"]');
          const tag = card && card.querySelector('.esc-dept-tag');
          const opts = p ? [...p.querySelectorAll('.esc-move-dept option')].map((o) => o.value) : [];
          return { shown: !!(p && p.offsetParent !== null), opts: opts, own: tag ? tag.textContent.trim() : '' };
        }, id);
        record('ESC-R1: Move opens an inline panel listing the other departments',
          panel.shown && panel.opts.length > 0 && (!panel.own || panel.opts.indexOf(panel.own) === -1), JSON.stringify(panel));
        await page.click('.esc-move-save[data-id="' + id + '"]');
        await page.waitForTimeout(1500);
        const after = await page.evaluate(() => ({ cards: document.querySelectorAll('.esc-card').length,
          err: [...document.querySelectorAll('.esc-move-error')].some((e) => e.style.display !== 'none' && e.textContent) }));
        record('ESC-R1: Move calls the verb and the list reloads cleanly', after.cards > 0 && !after.err, JSON.stringify(after));
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
