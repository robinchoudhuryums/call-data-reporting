'use strict';
/**
 * Dev-overlay driver (O-11). Asserting; part of `npm run ci:ui`.
 *
 * WHY THIS IS ITS OWN DRIVER. The overlay ships an RPC PROBE that redefines
 * `google.script.run` for admins. That object is the single point every one of
 * the ~91 server calls in script.html passes through, so a wrong wrapper does
 * not degrade a feature -- it breaks the entire app, for everyone, silently
 * enough that a page still paints. Nothing in `node --test` can see it. The
 * probe therefore gets its own coverage, and the first assertion below is not
 * "the overlay renders" but "the app still works with the probe installed".
 *
 * It also pins the security shape: the overlay is a PRESENTATION layer whose
 * `role === 'admin'` check is cosmetic, so the one thing that must be true is
 * that a manager never gets the panel, and that flipping the localStorage flag
 * by hand does not conjure one.
 *
 * Run: node drive-devoverlay.js   (after gen-payloads + build-harness)
 */
const path = require('path');
const { chromium } = require('playwright');
const { launchOptions } = require('./chromium-path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

// The harness runs with no outbound network, so dashboard.html's Google Fonts
// <link> always fails. That is an environment fact, not an app error, and it
// is present with or without the overlay -- verified by booting the same build
// without it. Filtering it here keeps the assertion about APP errors.
const ENV_NOISE = /Failed to load resource|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/;

async function boot(browser, role, prep) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String((e && e.message) || e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.addInitScript(() => { localStorage.setItem('cdr.tour.done', '1'); });
  if (prep) await page.addInitScript(prep);
  await page.goto('file://' + path.join(__dirname, 'site', 'index-' + role + '.html'));
  await page.waitForTimeout(2600);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    // ── The probe must not break the app ────────────────────────────────
    const { page, errors } = await boot(browser, 'admin');

    // If the wrapper mangled google.script.run, the dept table -- which is
    // populated exclusively by an RPC -- is the first thing to go empty. The
    // app lands on Overview, so navigate first: asserting on #agents-tbody
    // from the landing page measures the router, not the probe.
    await page.click('#nav-dept, [data-route="/dept"]').catch(() => {});
    await page.waitForTimeout(2200);
    const rows = await page.evaluate(() =>
      document.querySelectorAll('#agents-tbody tr').length);
    record('probe: RPC-populated content still renders', rows > 0, 'agent rows=' + rows);
    record('probe: no page/console errors with the probe installed',
      errors.length === 0, errors.slice(0, 2).join(' | '));

    // The stateful-runner trap, and the reason this check is written the hard
    // way. `run` is a getter handing back a FRESH runner per access, and a
    // runner HOLDS the handlers set on it. A probe that captured one runner at
    // install time and reused it would leak chain A's handlers into chain B.
    //
    // Comparing two reads for identity does NOT catch that -- the wrapper mints
    // a new Proxy either way, so `a !== b` is true even when both proxy the
    // same shared runner. The only assertion with teeth is behavioural: build
    // two chains, then dispatch both, and require each to invoke ITS OWN
    // handler. With a shared runner the second chain's handler wins and both
    // callbacks report 'B'.
    const leak = await page.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const chainA = google.script.run.withSuccessHandler(() => seen.push('A'));
      const chainB = google.script.run.withSuccessHandler(() => seen.push('B'));
      chainA.getLatestDataDates();
      chainB.getLatestDataDates();
      setTimeout(() => resolve(seen.slice().sort().join('')), 2200);
    }));
    record('probe: concurrent chains keep their OWN handlers (no runner reuse)',
      leak === 'AB', 'handlers invoked=' + leak);

    // Chaining must survive the wrapper in both orders, and still dispatch.
    const chain = await page.evaluate(() => new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => done('timeout'), 3000);
      try {
        google.script.run
          .withFailureHandler(() => done('failure-handler'))
          .withSuccessHandler(() => done('ok'))
          .getLatestDataDates();
      } catch (e) { done('threw: ' + e.message); }
    }));
    record('probe: chained withFailureHandler/withSuccessHandler still dispatches',
      chain === 'ok', 'result=' + chain);

    // ── The overlay itself ──────────────────────────────────────────────
    let open = await page.evaluate(() => {
      const el = document.getElementById('dev-overlay');
      return !!(el && el.classList.contains('is-open'));
    });
    record('overlay: closed by default', !open);

    await page.keyboard.press('Control+Alt+d');
    await page.waitForTimeout(400);
    const shown = await page.evaluate(() => {
      const el = document.getElementById('dev-overlay');
      if (!el) return null;
      // Rendered visibility, not a class -- a class with no rule behind it is
      // how the sub-queue scope tab shipped with no visual state at all.
      // NOT offsetParent: it is null for a position:fixed element even when
      // the element is plainly on screen, which is how this check first
      // reported a visible panel as hidden.
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      // Slice generously: the panel lists captured server calls ABOVE the
      // App-state block, and that list grew when R17e opened the Insights
      // team-detail fold by default (its heatmap fetch is one more RPC) --
      // a 400-char slice pushed "App state" out of the sample and failed
      // the assertion on a probe artifact.
      return { open: el.classList.contains('is-open'),
               visible: cs.display !== 'none' && box.width > 0 && box.height > 0,
               text: (el.textContent || '').slice(0, 2000) };
    });
    record('overlay: the chord opens it', !!(shown && shown.open && shown.visible));
    record('overlay: it lists captured server calls',
      !!(shown && /Server calls/.test(shown.text)), (shown && shown.text.slice(0, 60)) || '');
    record('overlay: it reports app state (role)',
      !!(shown && /App state/.test(shown.text)));

    // The probe records real traffic -- the boot sequence alone makes many
    // calls, so an empty list means the tap never fired.
    const rpcCount = await page.evaluate(() => {
      const el = document.getElementById('dev-overlay');
      const m = el && el.textContent.match(/Server calls\s*(\d+)/);
      return m ? Number(m[1]) : 0;
    });
    record('probe: real RPC traffic was captured', rpcCount > 0, 'calls=' + rpcCount);

    // Registry rows are the whole point: a new diagnostic must cost one entry.
    const diagBtns = await page.evaluate(() =>
      document.querySelectorAll('#dev-overlay .dev-run').length);
    record('overlay: the diagnostics registry renders a Run row per entry',
      diagBtns >= 4, 'rows=' + diagBtns);

    // A captured client error must surface -- this is the prLastRoster class,
    // the entire reason the capture half exists.
    await page.evaluate(() => { setTimeout(() => { throw new Error('synthetic-probe-error'); }, 0); });
    await page.waitForTimeout(600);
    const caught = await page.evaluate(() => {
      const el = document.getElementById('dev-overlay');
      return !!(el && el.textContent.indexOf('synthetic-probe-error') !== -1);
    });
    record('overlay: a thrown client error is captured and shown', caught);

    await page.keyboard.press('Control+Alt+d');
    await page.waitForTimeout(300);
    open = await page.evaluate(() => {
      const el = document.getElementById('dev-overlay');
      return !!(el && el.classList.contains('is-open'));
    });
    record('overlay: the chord closes it again', !open);
    await page.close();

    // ── A manager never gets it, even with the flag forced on ───────────
    const mgr = await boot(browser, 'manager', () => {
      localStorage.setItem('cdr.dev.overlay', 'on');   // hand-set: not authorization
    });
    await mgr.page.keyboard.press('Control+Alt+d');
    await mgr.page.waitForTimeout(400);
    const mgrOverlay = await mgr.page.evaluate(() => {
      const el = document.getElementById('dev-overlay');
      return { exists: !!el, open: !!(el && el.classList.contains('is-open')) };
    });
    record('security: a manager gets no overlay even with the flag set on',
      !mgrOverlay.open, JSON.stringify(mgrOverlay));
    record('security: the manager page still has no errors',
      mgr.errors.length === 0, mgr.errors.slice(0, 2).join(' | '));
    await mgr.page.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
