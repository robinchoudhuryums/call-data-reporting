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
  { name: 'Outlier Fix',    btn: '#orphan-fix-btn',      sel: '#orphan-fix-modal',     adminMenu: true,
    // DCA-6: a new hire on a former employee's extension takes no queue calls,
    // so she is in no DQE row -- the list must still carry her (the init is
    // the REAL getOrphanFixInit's, fed by the Direct build's Pipeline Health
    // note in gen-phase3), say whose extension it is, and offer HER extension.
    probe: async function (page, record) {
      const d = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#of-orphans-tbody tr[data-orphan-idx]'));
        const tr = rows.filter((r) => /Nina New/.test(r.textContent))[0];
        if (!tr) return { found: false, names: rows.map((r) => r.children[1] ? r.children[1].textContent : '') };
        const idx = tr.getAttribute('data-orphan-idx');
        const note = tr.querySelector('.of-direct-note');
        const exts = document.querySelector('.of-add-exts[data-idx="' + idx + '"]');
        return { found: true, note: note ? note.textContent : '', exts: exts ? exts.value : null,
                 queueOrphan: rows.some((r) => /Jon Smyth/.test(r.textContent)) };
      });
      record('DCA-6: a new hire on a former employee\'s extension is on the Outlier Fix list',
        d.found === true && d.queueOrphan === true, JSON.stringify(d));
      record('DCA-6: the row says whose extension it is and how many direct calls went uncredited',
        d.found && /Direct line 101/.test(d.note) && /Anna Reyes/.test(d.note) && /7 direct calls not credited/.test(d.note), JSON.stringify(d));
      record('DCA-6: New Assignment is pre-filled with HER extension', d.found && d.exts === '101', JSON.stringify(d));
      // DCA-7: people on an extension NO roster lists are listed too, after
      // everyone else, each with a "Not an agent" button nobody else gets.
      const u = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#of-orphans-tbody tr[data-orphan-idx]'));
        const nameOf = (r) => (r.children[1] && r.children[1].firstChild ? r.children[1].firstChild.textContent : '');
        const row = (re) => rows.filter((r) => re.test(r.textContent))[0];
        const omar = row(/Omar Unlisted/);
        const bar = document.getElementById('of-unlisted-bar');
        return {
          order: rows.map(nameOf),
          omarNote: omar && omar.querySelector('.of-direct-note') ? omar.querySelector('.of-direct-note').textContent : '',
          omarBtn: !!(omar && omar.querySelector('.of-row-ignore')),
          otherBtns: rows.filter((r) => /Nina New|Jon Smyth/.test(r.textContent) && r.querySelector('.of-row-ignore')).length,
          bar: bar && getComputedStyle(bar).display !== 'none' ? bar.textContent : '',
          ignoredShown: getComputedStyle(document.getElementById('of-ignored')).display !== 'none',
        };
      });
      record('DCA-7: a person on an extension no roster lists is on the list, after the others',
        u.order.indexOf('Omar Unlisted') > u.order.indexOf('Nina New') && u.order.indexOf('Pat Porter') > u.order.indexOf('Jon Smyth')
          && u.order.indexOf('Omar Unlisted') !== -1 && /no roster lists this extension/.test(u.omarNote) && /4 direct calls/.test(u.omarNote),
        JSON.stringify(u));
      record('DCA-7: only those rows offer "Not an agent"; the bar counts them',
        u.omarBtn === true && u.otherBtns === 0 && /2 people are on an extension no roster lists/.test(u.bar) && u.ignoredShown === false,
        JSON.stringify(u));
      await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#of-orphans-tbody tr[data-orphan-idx]'));
        rows.filter((r) => /Omar Unlisted/.test(r.textContent))[0].querySelector('.of-row-ignore').click();
      });
      await page.waitForFunction(() => /Not an agent \(1\)/.test((document.getElementById('of-ignored-summary') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const a = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#of-orphans-tbody tr[data-orphan-idx]'));
        const calls = (window.__HARNESS__.calls || []).filter((c) => c.fn === 'setOrphanIgnored');
        return {
          omarGone: !rows.some((r) => /Omar Unlisted/.test(r.textContent)),
          othersKept: /Pat Porter/.test(document.getElementById('of-orphans-tbody').textContent) && /Nina New/.test(document.getElementById('of-orphans-tbody').textContent),
          ignored: document.getElementById('of-ignored-list').textContent,
          ignoredShown: getComputedStyle(document.getElementById('of-ignored')).display !== 'none',
          bar: document.getElementById('of-unlisted-bar').textContent,
          calls: calls.map((c) => c.args),
        };
      });
      record('DCA-7: "Not an agent" sends that one name, drops the row, and keeps it restorable',
        a.omarGone && a.othersKept && a.ignoredShown && /Omar Unlisted/.test(a.ignored) && /Restore/.test(a.ignored)
          && /1 person is on an extension no roster lists/.test(a.bar)
          && a.calls.length === 1 && JSON.stringify(a.calls[0]) === JSON.stringify([{ names: ['Omar Unlisted'], ignored: true }]),
        JSON.stringify(a));
      // P1 (owner 2026-11-13): "Apply selected" handles Not an agent. A person
      // on an unlisted extension can be ticked with nothing mapped; an
      // ordinary outlier still cannot. Applying sends ONE setOrphanIgnored.
      const tick = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#of-orphans-tbody tr[data-orphan-idx]'));
        const box = (re) => { const r = rows.filter((x) => re.test(x.textContent))[0]; return r ? r.querySelector('.of-row-check') : null; };
        const pat = box(/Pat Porter/), other = box(/Jon Smyth/);
        const out = { patEnabled: !!pat && !pat.disabled, otherDisabled: !!other && other.disabled };
        if (pat && !pat.disabled) pat.click();
        out.label = (document.getElementById('of-batch-apply') || {}).textContent || '';
        return out;
      });
      await page.click('#of-batch-apply');
      await page.waitForSelector('.ds-confirm-ok', { timeout: 3000 }).catch(() => {});
      const bdlg = await page.evaluate(() => { const ok = document.querySelector('.ds-confirm-ok');
        return { open: !!ok, danger: !!(ok && ok.classList.contains('ds-confirm--danger')),
          body: ((document.querySelector('.ds-confirm-body') || {}).textContent) || '' }; });
      if (bdlg.open) await page.click('.ds-confirm-ok');
      await page.waitForFunction(() => /Not an agent \(2\)/.test((document.getElementById('of-ignored-summary') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const b = await page.evaluate(() => {
        const calls = (window.__HARNESS__.calls || []).filter((c) => c.fn === 'setOrphanIgnored');
        return { patGone: !/Pat Porter/.test(document.getElementById('of-orphans-tbody').textContent),
          kept: /Nina New/.test(document.getElementById('of-orphans-tbody').textContent),
          last: calls.length ? calls[calls.length - 1].args : null, n: calls.length,
          status: (document.getElementById('of-status') || {}).textContent || '' };
      });
      record('P1: a person on an unlisted extension can be ticked with nothing mapped; an ordinary outlier cannot',
        tick.patEnabled && tick.otherDisabled && /^Apply 1 selected$/.test(tick.label.trim()), JSON.stringify(tick));
      record('P1: "Apply selected" marks the ticked people Not an agent in one request, after asking (not as a destructive action)',
        bdlg.open && !bdlg.danger && /1 person marked as not an agent/.test(bdlg.body)
          && b.n === 2 && JSON.stringify(b.last) === JSON.stringify([{ names: ['Pat Porter'], ignored: true }]) && b.patGone && b.kept,
        JSON.stringify({ dlg: bdlg, after: b }));
    } },
  // DCD-1 (owner 2026-11-09): "Save all defaults as sheet rows". The init is the
  // REAL getDeptConfigInit's (gen-phase3), so the bar names the departments the
  // server would write; the click asks first, then sends ONE request (no list
  // from the client -- the server re-derives it).
  { name: 'Dept Config',    btn: '#dept-config-btn',     sel: '#dept-config-modal',    adminMenu: true,
    probe: async function (page, record) {
      const bar = await page.evaluate(() => {
        const b = document.getElementById('dc-defaults-bar');
        return { shown: !!b && getComputedStyle(b).display !== 'none', text: ((document.getElementById('dc-defaults-text') || {}).textContent) || '',
          note: !!document.getElementById('dc-source-note') };
      });
      record('Dept Config (DCD-1): the bar names the departments still on built-in defaults, under the CLN-6 note',
        bar.shown && bar.note && /run on built-in defaults only: \S/.test(bar.text), JSON.stringify(bar));
      await page.evaluate(() => { window.__HARNESS__.calls = []; });
      await page.click('#dc-save-defaults-btn');
      await page.waitForTimeout(400);
      const dlg = await page.evaluate(() => ({ open: !!document.querySelector('.ds-confirm-ok'),
        body: ((document.querySelector('.ds-confirm-body') || {}).textContent) || '' }));
      record('Dept Config (DCD-1): Save all asks first, naming the departments', dlg.open && /Writes a Dept Config row for/.test(dlg.body), JSON.stringify(dlg));
      await page.click('.ds-confirm-ok');
      await page.waitForTimeout(1200);
      const after = await page.evaluate(() => ({
        sent: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'saveDeptConfigDefaults').map((c) => c.args),
        status: ((document.getElementById('dc-run-status') || {}).textContent) || '' }));
      record('Dept Config (DCD-1): one saveDeptConfigDefaults request with no arguments, and the result says what was saved',
        after.sent.length === 1 && after.sent[0].length === 0 && /^Saved \d+ row/.test(after.status), JSON.stringify(after));
    } },
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
  // #81 (owner 2026-10-22): the Exception Days editor -- an INV-01 admin
  // write. The stateful mocks in build-harness.js round-trip save / remove, so
  // the probe walks the whole loop: the fixture day is listed, a missing
  // reason is refused in place, a save lists the new day, Remove asks in
  // DANGER tone and the day leaves the list.
  // TR-1 (owner 2026-11-02): Transfer retries -- the REAL getTransferRetries
  // over gen-phase3's fake journeys (3 retried calls, Elena Park tried first
  // each time, 2 of them quick declines; one call with no retry).
  { name: 'Transfer Retries', btn: '#transfer-retries-btn', sel: '#transfer-retries-modal', adminMenu: true,
    probe: async function (page, record) {
      await page.waitForTimeout(600);
      // P3 (owner 2026-11-13): the modal opens on "Answered, then redirected"
      // -- the first person tried ANSWERED and talked, then the call went to a
      // colleague of theirs. Each row says who answered the caller and when,
      // how long each talked, and who ended up taking the call.
      const p3 = await page.evaluate(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
        const rows = Array.from(document.querySelectorAll('#tr-rtbody tr')).map((r) => Array.from(r.cells).map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
        return { redirectShown: vis('tr-view-redirect'), missedShown: vis('tr-view-missed'),
          pressed: Array.from(document.querySelectorAll('#tr-views [data-tr-view]')).map((b) => b.getAttribute('data-tr-view') + ':' + b.getAttribute('aria-pressed') + ':' + b.textContent.replace(/\s+/g, ' ').trim()),
          summary: (document.getElementById('tr-rsummary') || {}).textContent || '',
          firsts: Array.from(document.querySelectorAll('#tr-rfirsts tr')).map((r) => Array.from(r.cells).map((c) => c.textContent.trim()).join(' | ')),
          rows: rows, chipsNeutral: Array.from(document.querySelectorAll('#tr-rtbody .parent-id')).every((c) => c.classList.contains('parent-id--neutral')),
          digits: /\d{10}/.test((document.getElementById('tr-view-redirect') || {}).textContent.replace(/#\d+/g, '')) };
      });
      record('P3: Transfer retries opens on "Answered, then redirected", with both lists counted on the switch',
        p3.redirectShown && !p3.missedShown
          && JSON.stringify(p3.pressed) === JSON.stringify(['redirect:true:Answered, then redirected (2)', 'missed:false:Not answered first (3)']),
        JSON.stringify({ shown: [p3.redirectShown, p3.missedShown], pressed: p3.pressed }));
      record('P3: the summary counts the calls and how many a colleague then took; the person who answered first is ranked',
        /^2 calls where the first person tried in another department answered and talked, and the call then went to a colleague of theirs\. In 1 of them a colleague took the call\.$/.test(p3.summary.trim())
          && p3.firsts.length === 1 && p3.firsts[0] === 'Elena Park | Sales | 2 | 0:00:58 | 1', JSON.stringify({ summary: p3.summary, firsts: p3.firsts }));
      record('P3: a row says who answered the caller and when, how long each talked, and who took the call',
        p3.rows.length === 2 && /^Anna Reyes CSR\s*answered 13:00:10 · A_Q_CSR · 0:01:50 on the call first$/.test(p3.rows[0][2])
          && /^Elena Park Sales\s*talked 0:01:35$/.test(p3.rows[0][3]) && /^Frank Wu\s*0:03:00 later$/.test(p3.rows[0][4])
          && /Answered.*talked 0:00:30/.test(p3.rows[0][5]) && p3.rows[0][6] === 'Frank Wu'
          && /^No one in Sales$/.test(p3.rows[1][6]) && p3.chipsNeutral && !p3.digits, JSON.stringify(p3.rows));
      await page.click('#tr-views [data-tr-view="missed"]');
      await page.waitForTimeout(250);
      const st = await page.evaluate(() => ({
        summary: (document.getElementById('tr-summary') || {}).textContent || '',
        callees: Array.from(document.querySelectorAll('#tr-callees tr')).map((r) => Array.from(r.cells).map((c) => c.textContent.trim()).join(' ')),
        rows: document.querySelectorAll('#tr-tbody tr').length,
        paths: document.querySelectorAll('#tr-tbody .pid-journey').length,
        outbound: document.querySelectorAll('#tr-tbody .ov-dir-pill').length,
        decline: document.querySelectorAll('#tr-tbody .tr-out--decline').length,
        from: (document.getElementById('tr-from') || {}).value || '', to: (document.getElementById('tr-to') || {}).value || '',
        depts: document.querySelectorAll('#tr-dept option').length,
      }));
      record('Transfer Retries: opens on a window and lists the three retried calls with their summary',
        /^3 calls where a transfer was tried again in the same department\. The first attempt: 2 declined quickly, 1 rang out, 0 went to voicemail\.$/.test(st.summary.trim())
          && st.rows === 3 && !!st.from && !!st.to, JSON.stringify(st));
      record('Transfer Retries: the person tried first is tallied, with the quick declines', st.callees.length === 1
        && /^Elena Park Sales 3 2$/.test(st.callees[0]), JSON.stringify(st.callees));
      record('Transfer Retries: every row has its call-path chip; the outbound call is marked; declines are flagged',
        st.paths === 3 && st.outbound === 1 && st.decline === 2, JSON.stringify(st));
      record('Transfer Retries: the department picker lists every department', st.depts > 3, 'options=' + st.depts);
      // P1 (owner 2026-11-13): the case table's header row stays in view while
      // its rows scroll, and its call-id chips are neutral (not abandoned calls).
      const hdr = await page.evaluate(() => {
        const wrap = document.querySelector('#tr-view-missed .tr-cases-wrap'), th = wrap && wrap.querySelector('thead th');
        if (!wrap || !th) return null;
        const cs = getComputedStyle(th);
        wrap.style.maxHeight = '90px';            // force a scroll in the 3-row fixture
        wrap.scrollTop = 60;
        const off = Math.round(th.getBoundingClientRect().top - wrap.getBoundingClientRect().top);
        const out = { position: cs.position, offset: off, scrolled: wrap.scrollTop > 0,
          chips: document.querySelectorAll('#tr-tbody .parent-id').length,
          neutral: Array.from(document.querySelectorAll('#tr-tbody .parent-id')).every((c) => c.classList.contains('parent-id--neutral')) };
        wrap.scrollTop = 0; wrap.style.maxHeight = '';
        return out;
      });
      record('P1: the Transfer retries header row stays pinned while the cases scroll; its call-id chips are neutral',
        !!hdr && hdr.position === 'sticky' && hdr.scrolled && Math.abs(hdr.offset) <= 2 && hdr.chips === 3 && hdr.neutral, JSON.stringify(hdr));
      await page.selectOption('#tr-dept', 'Power'); await page.waitForTimeout(500);
      const none = await page.evaluate(() => ({ summary: (document.getElementById('tr-summary') || {}).textContent || '',
        rows: document.querySelectorAll('#tr-tbody tr').length,
        call: (window.__HARNESS__.calls || []).filter((c) => c.fn === 'getTransferRetries').slice(-1)[0] }));
      record('Transfer Retries: picking a department re-asks for it and says when there is nothing',
        /^No transfer was tried again/.test(none.summary.trim()) && none.rows === 0 && none.call && none.call.args[0].dept === 'Power',
        JSON.stringify(none));
      await page.selectOption('#tr-dept', ''); await page.waitForTimeout(400);
    } },
  { name: 'Exception Days', btn: '#exception-days-btn', sel: '#exception-days-modal', adminMenu: true,
    probe: async function (page, record) {
      const meta = require('./payloads/meta.json');
      const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#exc-tbody tr')).map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
      const r0 = await rows();
      record('Exception Days: the fixture day is listed with its reason',
        r0.length === 1 && /8x8 outage/.test(r0[0]) && /All departments/i.test(r0[0]), JSON.stringify(r0));
      await page.fill('#exc-date', meta.latest);
      await page.fill('#exc-reason', '');
      await page.click('#exc-save-btn'); await page.waitForTimeout(300);
      const err = await page.evaluate(() => { const s = document.getElementById('exc-status'); return s && s.style.display !== 'none' ? s.textContent : ''; });
      record('Exception Days: a missing reason is refused in place',
        /why/i.test(err), err);
      await page.evaluate(() => { window.__HARNESS__.calls = []; });
      await page.fill('#exc-reason', 'Harness: carrier fault');
      await page.click('#exc-save-btn'); await page.waitForTimeout(800);
      const saved = await page.evaluate(() => (window.__HARNESS__.calls || []).filter((c) => c.fn === 'saveExceptionDay').map((c) => c.args[0]));
      const r1 = await rows();
      record('Exception Days: Save sends the day for all departments and lists it',
        saved.length === 1 && saved[0].date === meta.latest && Array.isArray(saved[0].departments) && saved[0].departments.length === 0
          && r1.length === 2 && r1.some((t) => /carrier fault/.test(t)), JSON.stringify({ saved: saved, rows: r1 }));
      await page.click('#exc-tbody button[data-exc-remove="' + meta.latest + '"]'); await page.waitForTimeout(300);
      const dlg = await page.evaluate(() => { const ok = document.querySelector('.ds-confirm-ok'); return { open: !!ok, danger: !!(ok && ok.classList.contains('ds-confirm--danger')) }; });
      record('Exception Days: Remove asks first, in DANGER tone', dlg.open && dlg.danger, JSON.stringify(dlg));
      await page.click('.ds-confirm-ok'); await page.waitForTimeout(800);
      const r2 = await rows();
      record('Exception Days: confirming removes the day from the list', r2.length === 1 && !r2.some((t) => /carrier fault/.test(t)), JSON.stringify(r2));
    } },
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
      ['#ad-day-kpis .ob-split--out .ob-obar-seg[data-seg="good"]', 'the outbound split bar (SB-1)'],
      ['#ad-inbound-list .cl-call-card', 'inbound call cards'],
      ['#ad-outbound-list .cl-call-card', 'outbound call cards'],
      ['#ad-tier-note[style*="none"]', 'NO tier banner on a full-fidelity day'],
    ] } },
  // SB-5 (owner 2026-10-28): the Inbound report's figures as one split --
  // total = answered + rang out / voicemail + hung up, the part the tiles
  // never showed -- and, company-wide, where the hang-ups happened.
  { name: 'Inbound',        btn: '#inbound-report-btn',    sel: '#inbound-modal',
    menu: '#reports-menu-btn',
    run: { click: '#inbound-generate-btn', wait: 1500, expect: [
      ['#inbound-kpi-row .ob-split .ob-obar-seg[data-seg="soft"]', 'the split summary with the rang-out / voicemail part (SB-5)'],
    ], probe: async function (page, record) {
      const v = await page.evaluate(() => {
        const sm = document.querySelector('#inbound-kpi-row .ob-split');
        const seg = (bar) => bar ? Array.from(bar.querySelectorAll('.ob-obar-seg')).map((x) => x.getAttribute('data-seg') + ':'
          + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0])) : [];
        return { num: ((sm && sm.querySelector('.ob-sum-num')) || {}).textContent || '',
          bar: seg(sm && sm.querySelector(':scope > .ob-obar')),
          where: seg(sm && sm.querySelector('.ob-split-sub .ob-obar')),
          quality: ((sm && sm.querySelector('.ob-sum-quality')) || {}).textContent || '',
          deltas: document.querySelectorAll('#inbound-kpi-row .pr-delta').length };
      });
      record('Inbound (SB-5): one bar of answered / rang out or voicemail / hung up that adds up to the calls',
        v.num === '4,120' && JSON.stringify(v.bar) === JSON.stringify(['good:3410', 'soft:308', 'bad:402']), JSON.stringify(v.bar));
      record('Inbound (SB-5): company-wide, where the 402 hung up (queue / phone menu / person\u2019s line) adds up to them',
        JSON.stringify(v.where) === JSON.stringify(['bad:244', 'bad2:120', 'soft:38']), JSON.stringify(v.where));
      record('Inbound (SB-5): on hold and unanswered transfers are labelled under the bar, not in it; every figure keeps its vs-prior chip',
        /61 hung up while on hold — after an agent answered, so counted inside Answered/.test(v.quality) && /14 transfers nobody picked up/.test(v.quality)
          && v.deltas >= 10, JSON.stringify({ q: v.quality.slice(0, 160), deltas: v.deltas }));
      // F79: every label that explains itself on hover can take focus, and
      // focusing one opens the same tooltip (20 here were mouse-only).
      const g = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('#inbound-modal .gloss')).filter((e) => e.getClientRects().length > 0);
        const reach = (e) => e.tabIndex >= 0 || !!e.querySelector('button,a[href],[tabindex]')
          || !!e.parentElement.closest('button,a[href],summary,[role="button"],[role="tab"],[role="menuitem"]');
        const first = all.filter((e) => e.tagName === 'TH')[0];
        if (first) first.focus();
        const tip = document.getElementById('ds-gloss-tip');
        return { total: all.length, unreachable: all.filter((e) => !reach(e)).length, focused: !!first && document.activeElement === first,
                 tip: !!tip && tip.style.display !== 'none' ? tip.textContent.slice(0, 60) : '' };
      });
      record('Inbound (F79): every hover-explained label is reachable by keyboard, and focus opens its tooltip',
        g.total >= 20 && g.unreachable === 0 && g.focused && g.tip.length > 10, JSON.stringify(g));
    } } },
  // D1 (owner 2026-10-21): the Direct Calls report. The company run is clean
  // (full coverage); the probe then runs CSR, whose fixture data stops a
  // workday before the asked end and skips one workday mid-window.
  { name: 'Direct Calls',   btn: '#direct-call-report-btn', sel: '#direct-call-modal',
    menu: '#reports-menu-btn',
    run: { click: '#direct-call-generate-btn', wait: 1500, expect: [
      ['#direct-call-kpi-row .ob-split .ob-obar-seg[data-seg="good"]', 'the split summary (SB-2)'],
      ['#direct-call-dept-cards .al-section-title', 'per-department cards (company view)'],
    ], probe: async function (page, record) {
      const meta = require('./payloads/direct-meta.json');
      const P30 = require('./payloads/direct-30d.json');
      const clean = await page.evaluate(() => { const n = document.getElementById('direct-call-coverage-note');
        return { none: !n || n.style.display === 'none', chips: document.querySelectorAll('#direct-call-kpi-row .pr-delta').length }; });
      record('Direct: a fully covered window carries no coverage note and keeps its vs-prior chips', clean.none && clean.chips > 0, JSON.stringify(clean));
      // SB-2: the calls that rang a person's line are ONE bar that adds up to
      // its headline (answered + missed while free + missed while busy), with
      // the colleague / outside-caller rows under it; dialed calls are a second.
      const sb = await page.evaluate(() => {
        const sums = Array.from(document.querySelectorAll('#direct-call-kpi-row .ob-split')).map((sm) => {
          const bar = sm.querySelector(':scope > .ob-obar');
          return { num: Number(((sm.querySelector('.ob-sum-num') || {}).textContent || '').replace(/,/g, '')),
            sum: bar ? Array.from(bar.querySelectorAll('.ob-obar-seg')).reduce((a, x) => a + parseFloat(x.style.flexGrow || (x.style.flex || '').split(' ')[0]), 0) : -1,
            legend: sm.querySelectorAll(':scope > .ob-legend .ob-leg').length };
        });
        return { sums: sums, rows: document.querySelectorAll('#direct-call-kpi-row .dc-split-rows .ob-obar').length };
      });
      record('Direct (SB-2): two split bars that add up to their headlines, the inbound one with its three parts and the int / ext rows',
        sb.sums.length === 2 && sb.sums.every((x) => x.num > 0 && x.num === x.sum) && sb.sums[0].legend === 3 && sb.sums[1].legend === 2 && sb.rows === 2,
        JSON.stringify(sb));
      await page.click('#direct-call-back-btn'); await page.waitForTimeout(300);
      await page.selectOption('#direct-call-dept', 'CSR');
      await page.fill('#direct-call-to', meta.asked.to);
      await page.click('#direct-call-generate-btn'); await page.waitForTimeout(1500);
      const c = await page.evaluate((who) => {
        const n = document.getElementById('direct-call-coverage-note');
        const tr = Array.from(document.querySelectorAll('#direct-call-agent-tbody tr')).find((r) => r.cells[0] && r.cells[0].textContent.trim() === who);
        return { note: n && n.style.display !== 'none' ? n.textContent : '', to: document.getElementById('direct-call-to').value,
                 preset: document.getElementById('direct-call-preset').value, date: (document.getElementById('direct-call-results-date') || {}).textContent || '',
                 split: tr ? Array.from(tr.querySelectorAll('.dc-split')).map((x) => x.textContent) : [],
                 ext: tr ? Array.from(tr.querySelectorAll('.dc-ext-line:not(.dc-via-line)')).map((x) => x.textContent) : [],
                 via: tr ? Array.from(tr.querySelectorAll('.dc-via-line')).map((x) => x.textContent) : [],
                 viaSum: (document.querySelector('#direct-call-kpi-row .ob-split-sub .dc-via-line') || {}).textContent || '',
                 chips: document.querySelectorAll('#direct-call-kpi-row .pr-delta').length };
      }, P30.agents[0].agent);
      record('Direct: an end past the last imported day is corrected -- the note says so and the End date moves back',
        /data runs through/.test(c.note) && /not been imported/.test(c.note) && c.to === meta.dataThrough && c.preset === 'custom'
          && c.date.indexOf(meta.dataThrough) !== -1, JSON.stringify({ note: c.note.slice(0, 140), to: c.to, want: meta.dataThrough, date: c.date }));
      record('Direct: a workday with no data is named, and the vs-prior chips are withheld',
        /No data for 1 workday/.test(c.note) && /No vs-prior chips/.test(c.note) && c.chips === 0, JSON.stringify({ chips: c.chips, note: c.note.slice(-160) }));
      const s0 = P30.agents[0].split;
      // DO-1 (owner 2026-11-05): the inbound counts keep their int / ext split;
      // outbound is calls to colleagues, the outside calls one small line each.
      const a0 = P30.agents[0], ox = a0.obExt || {};
      record('Direct: each inbound count shows its internal / external split; outbound shows the calls to outside numbers as a line',
        c.split.length === 3 && c.split[0] === s0.ibAnswered.int + ' int · ' + s0.ibAnswered.ext + ' ext'
          && (ox.total ? (c.ext.length === 2 && c.ext[0] === '+' + ox.total + ' to outside numbers' && c.ext[1] === '+' + ox.connected + ' outside')
                       : c.ext.length === 0),
        JSON.stringify({ split: c.split, ext: c.ext, obExt: ox }));
      // DID-2 (owner 2026-11-06): outside callers split by how they reached the person.
      const v0 = a0.via || {};
      const vl = (v0.line || {}).answered, vm = (v0.main || {}).answered;
      record('Direct (DID-2): each agent\'s outside answered calls show their direct line vs a main line, and the summary says how outside callers arrived with each rate',
        c.via.length === 1 && c.via[0] === 'Outside answered: ' + vl + ' their line · ' + vm + ' main line'
          && /^Outside callers: \d+ on their direct line \(\d+% answered\) · \d+ from a main line \(\d+% answered\)$/.test(c.viaSum),
        JSON.stringify({ via: c.via, viaSum: c.viaSum, want: [vl, vm] }));
    } } },
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
      else if (m.probe) await m.probe(page, record);

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
        // G2 (broad-scan 259, E1): the editor names the depts riding the
        // company default target. The fixture sets no per-dept override, so
        // every dept but the CSR seed must be listed under the default.
        const cov = await page.evaluate(() => {
          const el = document.getElementById('al-dept-targets-coverage');
          return el ? el.textContent : null;
        });
        record('Alerts: the answer-target editor lists the depts on the company default',
          !!cov && /On the company default \(80%, amber within 10 pts\): .*Sales/.test(cov) && /Own target: CSR 92%/.test(cov),
          'text=' + JSON.stringify(cov));
      }
      // G3 (broad-scan 259, E1): a staged agent (the fixture's pending list,
      // agent sign-in OFF) shows the pending bar with its send button
      // DISABLED, and the agent's row carries the "welcome pending" chip.
      if (m.name === 'Access Control' && info.found && info.visible) {
        const pend = await page.evaluate(() => {
          const box = document.getElementById('ac-agent-pending');
          const btn = document.getElementById('ac-welcome-send');
          const chip = document.querySelector('#ac-agent-tbody .ds-chip');
          return { shown: !!box && box.style.display !== 'none', text: box ? box.textContent : '',
                   disabled: !!btn && btn.disabled, chip: chip ? chip.textContent : '' };
        });
        record('Access Control: the staged-agent welcome bar renders, send disabled while sign-in is off',
          pend.shown && /1 staged agent has no welcome email yet/.test(pend.text) && pend.disabled,
          JSON.stringify(pend));
        record('Access Control: the staged agent row carries the "welcome pending" chip',
          pend.chip === 'welcome pending', 'chip=' + JSON.stringify(pend.chip));
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
        // F71: the opener is usually an item in a header MENU that closed when
        // it was picked. Handing focus back to that hidden item was a no-op,
        // focus sat on <body>, and the next Tab began at the end of the page.
        // Focus must land on the control the user can see: the opener itself,
        // or the trigger of the menu it lives in.
        const back = await page.evaluate(() => {
          const a = document.activeElement;
          return { id: a ? a.id : '', onBody: !a || a === document.body,
                   shown: !!(a && a.getClientRects && a.getClientRects().length) };
        });
        const wantId = (menuBtn || m.btn).slice(1);
        record(m.name + ': closing returns focus to a visible control (F71)',
          closed === true && !back.onBody && back.shown && back.id === wantId,
          JSON.stringify(back) + ' want #' + wantId);
      }
    } catch (e) {
      // phase3 recorded this shape and moved on; here it is a failure.
      record(m.name + ': opens without throwing', false, String(e).slice(0, 160));
    }
    record(m.name + ': no page/console errors while open', errors.length === before,
      Array.from(new Set(errors.slice(before))).slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── F70 / F71 / F77: Help and Settings, opened from their header buttons ──
  // Help is a column of FOLDS (the topic categories) -- the shape the focus
  // trap leaked on: a fold's summary is a tab stop it did not know, and the
  // links inside a closed fold are ones it wrongly counted.
  {
    const { ctx, page, errors } = await boot();
    const before = errors.length;
    await page.click('#help-btn'); await page.waitForTimeout(700);
    const helpOpen = await page.evaluate(() => getComputedStyle(document.getElementById('help-modal')).display !== 'none');
    record('Help: opens from the header button', helpOpen);
    // Close every category but one, so closed folds sit in the middle AND at the end.
    await page.evaluate(() => { document.querySelectorAll('#help-modal .help-cat').forEach((c, i) => { c.open = (i === 0); }); });
    let out = 0; const seen = {};
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const w = await page.evaluate(() => { const a = document.activeElement; const m = document.getElementById('help-modal');
        return { inside: m.contains(a), tag: a.tagName, inClosed: !!(a.closest('details:not([open])') && a.tagName !== 'SUMMARY') }; });
      if (!w.inside || w.inClosed) out++;
      seen[w.tag] = (seen[w.tag] || 0) + 1;
    }
    record('Help (F70): 40 Tabs stay inside the dialog, and stop on the fold headers', out === 0 && (seen.SUMMARY || 0) >= 2,
      JSON.stringify({ out: out, seen: seen }));
    const topics = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('#help-modal .help-link'));
      const state = () => links.map((l) => (l.classList.contains('active') ? 'A' : '-') + (l.getAttribute('aria-pressed') === 'true' ? 'P' : '-')).join(' ');
      const start = state();
      links[1].click();
      return { start: start, after: state(), n: links.length };
    });
    const agree = (st) => st.split(' ').every((x) => x === 'AP' || x === '--') && st.split(' ').filter((x) => x === 'AP').length === 1;
    record('Help (F77): the shown topic is the one pressed link, before and after a pick',
      topics.n > 3 && agree(topics.start) && agree(topics.after) && topics.start !== topics.after, JSON.stringify(topics));
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    const hb = await page.evaluate(() => document.activeElement && document.activeElement.id);
    record('Help (F71): Escape returns focus to the header button', hb === 'help-btn', 'active=#' + hb);

    await page.click('#settings-btn'); await page.waitForTimeout(500);
    const themes = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('#settings-modal .theme-chip'));
      const state = () => chips.map((c) => (c.classList.contains('active') ? 'A' : '-') + (c.getAttribute('aria-pressed') === 'true' ? 'P' : '-')).join(' ');
      const start = state();
      const other = chips.filter((c) => !c.classList.contains('active'))[0];
      if (other) other.click();
      return { start: start, after: state(), n: chips.length };
    });
    record('Settings (F77): the chosen theme is the one pressed chip, before and after a pick',
      themes.n > 1 && agree(themes.start) && agree(themes.after) && themes.start !== themes.after, JSON.stringify(themes));
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    const sbk = await page.evaluate(() => document.activeElement && document.activeElement.id);
    record('Settings (F71): Escape returns focus to the header button', sbk === 'settings-btn', 'active=#' + sbk);
    record('Help / Settings: no page/console errors', errors.length === before, errors.slice(before, before + 2).join(' | '));
    await ctx.close();
  }

  // ── Batch 10 (NPS): print, narrow screens, names, live regions, tier text ──
  {
    // NPS-1 (F73): the browser's own print with a report open. Paper used to
    // get the page behind the overlay plus the slice of the panel on screen.
    const { ctx, page, errors } = await boot();
    const before = errors.length;
    await page.click('#reports-menu-btn'); await page.waitForTimeout(200);
    await page.click('#inbound-report-btn'); await page.waitForTimeout(1200);
    await page.click('#inbound-generate-btn'); await page.waitForTimeout(2200);
    const measure = () => page.evaluate(() => {
      const m = document.getElementById('inbound-modal'), bd = m.querySelector('.modal-panel-body');
      return { pos: getComputedStyle(m).position, clipped: bd.scrollHeight - bd.clientHeight,
        behind: getComputedStyle(document.querySelector('body > .container')).display,
        close: getComputedStyle(m.querySelector('.modal-close')).display, cls: document.body.className };
    });
    const scr = await measure();
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    const prt = await measure();
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    const aft = await measure();
    record('NPS-1: on screen the Inbound report is a clipped, scrolling overlay (the thing print must undo)',
      scr.pos === 'fixed' && scr.clipped > 100, JSON.stringify(scr));
    record('NPS-1: printing with the report open prints the whole report and nothing behind it',
      prt.pos === 'static' && prt.clipped <= 1 && prt.behind === 'none' && prt.close === 'none', JSON.stringify(prt));
    record('NPS-1: the screen is back as it was after the print',
      aft.pos === 'fixed' && aft.behind !== 'none' && aft.close !== 'none' && aft.cls.indexOf('modal-printing') === -1, JSON.stringify(aft));

    // NPS-5 / NPS-3 / NPS-4 / NPS-6 on the open report and the page.
    const names = await page.evaluate(() => {
      const tinted = Array.from(document.querySelectorAll('.bm-watch, .bm-bad, .bm-over')).filter((e) => e.getClientRects().length);
      const canv = Array.from(document.querySelectorAll('canvas'));
      const seg = (cls) => { const d = document.createElement('div'); d.className = 'ob-obar-seg ' + cls; d.textContent = '12';
        document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
      const light = { cat1: seg('ob-seg-cat1'), cat2: seg('ob-seg-cat2'), cat4: seg('ob-seg-cat4') };
      document.body.dataset.mode = 'dark';
      const dark = { cat1: seg('ob-seg-cat1'), cat2: seg('ob-seg-cat2'), cat4: seg('ob-seg-cat4'), good: seg('ob-seg-good') };
      delete document.body.dataset.mode;
      return {
        tinted: tinted.length,
        // The spoken words are CSS-generated (::after), the hover words a title;
        // the element's own text must stay just its number.
        silent: tinted.filter((e) => !/, (just below target|below target|outside the standard)/.test(getComputedStyle(e, '::after').content) || !e.title).length,
        sample: tinted.length ? (tinted[0].textContent + ' | ' + getComputedStyle(tinted[0], '::after').content + ' | ' + tinted[0].title) : '',
        textClean: tinted.every((e) => !/target|standard/.test(e.textContent)),
        greenSaid: Array.from(document.querySelectorAll('.bm-target')).filter((e) => { const c = getComputedStyle(e, '::after').content; return c && c !== 'none' && /target|standard/.test(c); }).length,
        canvases: canv.length, unnamed: canv.filter((c) => c.getAttribute('role') !== 'img' || !(c.getAttribute('aria-label') || '').trim()).map((c) => c.id),
        loader: (document.getElementById('ov-loading') || { getAttribute: () => null }).getAttribute('role'),
        light: light, dark: dark,
      };
    });
    record('NPS-5: every amber or red benchmark value says its tier in words (a title + generated read-aloud text, its own text untouched); green stays silent',
      names.tinted > 0 && names.silent === 0 && names.greenSaid === 0 && names.textClean === true,
      JSON.stringify({ tinted: names.tinted, silent: names.silent, sample: names.sample, green: names.greenSaid, textClean: names.textClean }));
    record('NPS-3: every chart canvas on the page is a named image', names.canvases >= 8 && names.unnamed.length === 0,
      JSON.stringify({ n: names.canvases, unnamed: names.unnamed }));
    record('NPS-6: text on the three filled category segments is white in light mode and dark ink in dark mode, like the green one',
      names.light.cat1 === 'rgb(255, 255, 255)' && names.light.cat2 === 'rgb(255, 255, 255)' && names.light.cat4 === 'rgb(255, 255, 255)'
        && names.dark.cat1 === names.dark.good && names.dark.cat2 === names.dark.good && names.dark.cat4 === names.dark.good
        && names.dark.good === 'rgb(16, 20, 24)', JSON.stringify({ light: names.light, dark: names.dark }));
    record('NPS (print / names): no page/console errors', errors.length === before, errors.slice(before, before + 2).join(' | '));
    await ctx.close();
  }
  // NPS-2 (F81): at phone and tablet widths a wide table used to make the
  // WHOLE modal body scroll sideways. Each table now scrolls by itself: the
  // body is exactly as wide as the panel, the page is no wider than the
  // screen, and Close stays on it.
  for (const vw of [390, 768]) {
    for (const m of [['#alerts-btn', '#alerts-modal', '#admin-menu-btn'], ['#orphan-fix-btn', '#orphan-fix-modal', '#admin-menu-btn'],
      ['#dept-config-btn', '#dept-config-modal', '#admin-menu-btn'], ['#coaching-btn', '#coaching-modal', '#admin-menu-btn'],
      ['#system-health-btn', '#health-modal', '#admin-menu-btn']]) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vw === 390 ? 844 : 1024 } });
      const page = await ctx.newPage();
      await page.addInitScript(() => { try { localStorage.setItem('cdr.tour.done', '1'); } catch (e) {} });
      await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
      await page.waitForTimeout(1500);
      // Opened by script: at phone width the header's own menu is off-screen, which is not what this measures.
      await page.evaluate((x) => { document.querySelector(x[2]).click(); document.querySelector(x[0]).click(); }, m);
      await page.waitForTimeout(1500);
      const r = await page.evaluate((sel) => {
        const md = document.querySelector(sel), bd = md.querySelector('.modal-panel-body'), cl = md.querySelector('.modal-close').getBoundingClientRect();
        const wide = Array.from(bd.querySelectorAll('table')).filter((t) => t.scrollWidth > t.clientWidth + 1).length;
        return { shown: getComputedStyle(md).display !== 'none', body: bd.scrollWidth - bd.clientWidth, page: document.documentElement.scrollWidth - innerWidth,
                 close: cl.left >= 0 && cl.right <= innerWidth && cl.top >= 0, ownScroll: wide };
      }, m[1]);
      record('NPS-2: ' + m[1] + ' at ' + vw + 'px -- the modal body does not scroll sideways, the page is no wider, Close is on screen',
        r.shown && r.body <= 1 && r.page <= 1 && r.close && (vw !== 390 || r.ownScroll >= 1), JSON.stringify(r));
      await ctx.close();
    }
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
        // Owner 2026-10-21: an admin's outbound cards carry the call id, a copy
        // button and an OUTBOUND path drill -- and the drill really opens.
        const obIds = await page.evaluate(() => Array.from(document.querySelectorAll('#ad-outbound-list .cl-call-card')).map((c) => ({
          num: ((c.querySelector('.pid-num') || {}).textContent || ''), copy: !!c.querySelector('.pid-copy'),
          kind: (c.querySelector('.pid-journey') || { getAttribute: () => '' }).getAttribute('data-journey-kind') || '' })));
        record('admin: Agent Day outbound cards show the call id, copy button and an outbound path drill',
          obIds.length > 0 && obIds.every((r) => /^#\S/.test(r.num) && r.copy && r.kind === 'outbound'), JSON.stringify(obIds));
        await page.evaluate(() => { window.__HARNESS__.calls.length = 0; });
        const obPath = page.locator('#ad-outbound-list .cl-call-card .pid-journey').first();
        if (await obPath.count()) {
          await obPath.click(); await page.waitForTimeout(700);
          const asked = await page.evaluate(() => window.__HARNESS__.calls.filter((c) => c.fn === 'getCallJourney').map((c) => (c.args[0] || {}).kind));
          const ovOpen = await shown('#call-journey-overlay');
          record('admin: the outbound path drill asks for an OUTBOUND journey and opens the overlay',
            ovOpen && asked.indexOf('outbound') !== -1, JSON.stringify({ open: ovOpen, asked: asked }));
          if (ovOpen) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
        }
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

    // QF-2 (owner 2026-10-28): one action row on a pending card -- Start,
    // the admin edits and the admin verbs together -- quiet outline buttons
    // (the old btn-ghost had no rule and rendered solid black), a hover label
    // on every action button, and no ellipsis on Move.
    {
      const qf = await page.evaluate(() => {
        const card = [...document.querySelectorAll('.esc-card')].find((c) => c.querySelector('.esc-start'));
        if (!card) return null;
        const row = card.querySelector('.esc-start').closest('.esc-actions');
        const ink = getComputedStyle(card.querySelector('.esc-start')).backgroundColor;
        const move = card.querySelector('.esc-move-toggle');
        const edit = card.querySelector('.esc-edit');
        const btns = [...card.querySelectorAll('.esc-actions button')];
        return {
          oneRow: !!row && !!row.querySelector('.esc-move-toggle') && !!row.querySelector('.esc-delete')
            && card.querySelectorAll('.esc-actions').length === 1,
          quiet: !!edit && getComputedStyle(edit).backgroundColor !== ink,
          titled: btns.length > 0 && btns.every((b) => (b.getAttribute('title') || '').trim().length > 8),
          moveText: move ? move.textContent.trim() : null,
          resolveAfterRow: !!row && !!card.querySelector('.esc-resolve-disc')
            && !!(row.compareDocumentPosition(card.querySelector('.esc-resolve-disc')) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      record('QF-2: a pending card has ONE action row with Start, Move and Delete', !!qf && qf.oneRow, JSON.stringify(qf));
      record('QF-2: the admin edit buttons are quiet, not solid like Start', !!qf && qf.quiet);
      record('QF-2: every action button has a hover label', !!qf && qf.titled);
      record('QF-2: Move carries no ellipsis', !!qf && qf.moveText != null && !/…|\.\.\./.test(qf.moveText), qf && qf.moveText);
      record('QF-2: the resolve form follows the row', !!qf && qf.resolveAfterRow);
      // The quiet style is GLOBAL (the coaching Dismissed button and the
      // tour's Skip / Back use it too): a bare `btn btn-ghost` anywhere on the
      // page is not the solid default.
      const ghost = await page.evaluate(() => {
        const solid = document.createElement('button'); solid.className = 'btn';
        const quiet = document.createElement('button'); quiet.className = 'btn btn-ghost';
        document.body.appendChild(solid); document.body.appendChild(quiet);
        const out = { solid: getComputedStyle(solid).backgroundColor, quiet: getComputedStyle(quiet).backgroundColor,
          border: getComputedStyle(quiet).borderTopStyle };
        solid.remove(); quiet.remove();
        return out;
      });
      record('QF-2: a btn-ghost anywhere on the page is quiet, not the solid default',
        ghost.quiet !== ghost.solid && ghost.border === 'solid', JSON.stringify(ghost));
    }

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

    // CCX-1 (broad-scan 2026-11-09): every mutation reloads and re-renders
    // the cards. Text being typed must survive it -- on the card acted on AND
    // on the others -- while the field that was just SAVED comes back empty.
    {
      const ids = await page.evaluate(() => Array.prototype.map.call(
        document.querySelectorAll('#esc-list textarea.esc-resolve-text'), (t) => t.getAttribute('data-id')));
      if (ids.length >= 2) {
        const a = ids[0], b = ids[1];
        await page.evaluate((x) => {
          const set = (sel, v) => {
            const t = document.querySelector(sel);
            t.closest('details').open = true;
            t.value = v;
            t.dispatchEvent(new Event('input', { bubbles: true }));
          };
          set('textarea.esc-resolve-text[data-id="' + x.a + '"]', 'half-typed resolution');
          set('textarea.esc-comments-text[data-id="' + x.a + '"]', 'a progress note');
          set('textarea.esc-resolve-text[data-id="' + x.b + '"]', 'another card draft');
        }, { a: a, b: b });
        const loadsBefore = await page.evaluate(() => window.__HARNESS__.calls.filter((c) => c.fn === 'getEscalations').length);
        await page.click('.esc-comment-save[data-id="' + a + '"]');
        await page.waitForTimeout(1500);
        const loadsAfter = await page.evaluate(() => window.__HARNESS__.calls.filter((c) => c.fn === 'getEscalations').length);
        record('CCX-1: the save reloaded the list (the cards were rebuilt)', loadsAfter === loadsBefore + 1,
          'getEscalations ' + loadsBefore + ' -> ' + loadsAfter);
        const d = await page.evaluate((x) => {
          const q = (sel) => document.querySelector(sel);
          const ra = q('textarea.esc-resolve-text[data-id="' + x.a + '"]');
          const ca = q('textarea.esc-comments-text[data-id="' + x.a + '"]');
          const rb = q('textarea.esc-resolve-text[data-id="' + x.b + '"]');
          const save = q('.esc-resolve-save[data-id="' + x.a + '"]');
          return { res: ra ? ra.value : null, com: ca ? ca.value : null, other: rb ? rb.value : null,
                   open: !!(ra && ra.closest('details') && ra.closest('details').open),
                   saveEnabled: !!(save && !save.disabled) };
        }, { a: a, b: b });
        record('CCX-1: "Save comment only" keeps the half-typed resolution on the same card, shown and savable',
          d.res === 'half-typed resolution' && d.open && d.saveEnabled, JSON.stringify(d));
        record('CCX-1: the comment that was saved comes back empty', d.com === '', JSON.stringify(d));
        record('CCX-1: a draft on another card survives the reload', d.other === 'another card draft', JSON.stringify(d));
      } else {
        record('CCX-1: the fixture has two cards with a resolve form', false, 'found ' + ids.length);
      }
    }

    // ESC-C3: the latest comments sit on the card face (author + time, a
    // dept tag on a linked copy), "View all" opens Activity; a row with no
    // thread comments falls back to its own comments field.
    {
      const cc = await page.evaluate(() => {
        const c101 = document.querySelector('.esc-card[data-id="101"]');
        const box = c101 ? c101.querySelector('.esc-card-comments') : null;
        const c100 = document.querySelector('.esc-card[data-id="100"]');
        return { n: box ? box.querySelectorAll('.esc-card-comment').length : -1,
                 meta: box ? [...box.querySelectorAll('.esc-card-comment-meta')].map((m) => m.textContent.replace(/\s+/g, ' ').trim()) : [],
                 all: box && box.querySelector('.esc-comments-all') ? box.querySelector('.esc-comments-all').textContent.trim() : '',
                 fallback: c100 && c100.querySelector('.esc-comments') ? c100.querySelector('.esc-comments').textContent.trim() : '' };
      });
      record('ESC-C3: a card shows its latest comments with author, time and (linked) department',
        cc.n === 2 && /^manager@ums\.com · \d{2}\/\d{2}\/\d{4} 09:15 CSR$/.test(cc.meta[1] || ''), JSON.stringify(cc));
      record('ESC-C3: "View all N in Activity" appears when the thread holds more', cc.all === 'View all 4 in Activity', cc.all);
      record('ESC-C3: a card with no thread comments shows its own comments field', /Vendor ETA requested/.test(cc.fallback), cc.fallback);
      const btn = await page.$('.esc-card[data-id="101"] .esc-comments-all');
      if (btn) {
        await btn.click();
        await page.waitForTimeout(700);
        const opened = await page.evaluate(() => {
          const d = document.querySelector('.esc-activity[data-id="101"]');
          const b = document.querySelector('.esc-activity-body[data-id="101"]');
          return { open: !!(d && d.open), loaded: b ? b.getAttribute('data-loaded') : null };
        });
        record('ESC-C3: "View all" opens and loads the Activity thread', opened.open && opened.loaded === '1', JSON.stringify(opened));
        await page.evaluate(() => { const d = document.querySelector('.esc-activity[data-id="101"]'); if (d) d.open = false; });
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
