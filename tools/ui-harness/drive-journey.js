'use strict';
/**
 * ASSERTING driver for the per-call JOURNEY DRILL -- the "↳ path" overlay.
 *
 * Why this exists: Steps 3 and 4 added three client renderers that had never
 * executed in a browser -- the "Internal request from …" origin line, the
 * OUTBOUND call renderer reached through the related-call link, and the
 * not-entitled refusal copy. All three were unit-pinned server-side and
 * structurally invisible to the .gs harness. That is exactly the gap that let
 * the header dept selector throw in production until a driver first clicked
 * it: markup that renders fine in review and dies on a real click.
 *
 * The drill was unreachable by any driver because `getCallJourney` was
 * unmocked (drive-smoke would have flagged the call). build-harness now mocks
 * it, keyed off the request so ONE walk covers all three renderers.
 *
 * Run: node drive-journey.js   (after gen-payloads + build-harness)
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
  });
  await page.goto('file://' + path.join(__dirname, 'site', 'index-admin.html'));
  await page.waitForTimeout(2500);

  // The missed section carries the "↳ path" buttons (parentIdBadge renders one
  // per abandoned ring). Open My Department over the 30-day window, where the
  // fixture has abandoned parent ids.
  await page.click('#my-dept-btn');
  await page.waitForTimeout(1500);
  const meta = require('./payloads/meta.json');
  await page.fill('#from-date', meta.from30);
  await page.fill('#to-date', meta.latest);
  await page.click('#refresh-btn');
  await page.waitForTimeout(2500);

  // The per-agent cards + the queue-only abandoned block land in
  // #dept-missed-detail, a SEPARATE lazy fetch from the section's own summary
  // -- so wait for the buttons themselves rather than a fixed sleep.
  await page.waitForFunction(
    () => document.querySelectorAll('.pid-journey').length > 0,
    null, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('#dept-missed-detail details').forEach((d) => { d.open = true; });
  });
  await page.waitForTimeout(600);

  const btnCount = await page.evaluate(() =>
    document.querySelectorAll('.pid-journey').length);
  record('the missed section renders "↳ path" buttons to drill', btnCount > 0,
    'buttons=' + btnCount);
  if (!btnCount) {
    console.log('\nno drill buttons -- cannot continue');
    await browser.close();
    process.exit(1);
  }

  // ---- 1. the INBOUND (internal assist) render ----------------------------
  await page.evaluate(() => { document.querySelector('.pid-journey').click(); });
  await page.waitForTimeout(1200);

  const inbound = await page.evaluate(() => {
    const ov = document.getElementById('call-journey-overlay');
    if (!ov || ov.style.display === 'none') return null;
    const body = ov.querySelector('.cj-body');
    return {
      text: (body.textContent || '').replace(/\s+/g, ' ').trim(),
      hasOrigin: !!body.querySelector('.cj-origin'),
      hasInternalTag: !!body.querySelector('.cj-internal-tag'),
      relatedKind: (body.querySelector('.cj-related-btn') || {}).getAttribute
        ? body.querySelector('.cj-related-btn').getAttribute('data-cj-kind') : null,
      chainToks: body.querySelectorAll('.cl-tok').length,
    };
  });
  record('the drill overlay opens and renders the call', !!inbound,
    inbound ? ('chain tokens=' + inbound.chainToks) : 'overlay never appeared');
  record('Step 3: the "Internal request from …" origin line renders',
    !!inbound && inbound.hasOrigin && /Internal request from Marie/.test(inbound.text),
    inbound ? inbound.text.slice(0, 90) : '');
  record('the internal-call tag renders', !!inbound && inbound.hasInternalTag);
  record('Step 4: the related-call button is flagged OUTBOUND',
    !!inbound && inbound.relatedKind === 'outbound',
    inbound ? ('data-cj-kind=' + inbound.relatedKind) : '');
  record('and the wording says OUTBOUND, not inbound',
    !!inbound && /active OUTBOUND call/.test(inbound.text));

  // ---- 2. follow the link -> the OUTBOUND renderer ------------------------
  await page.evaluate(() => { document.querySelector('.cj-related-btn').click(); });
  await page.waitForTimeout(1200);

  const outbound = await page.evaluate(() => {
    const body = document.querySelector('#call-journey-overlay .cj-body');
    return {
      text: (body.textContent || '').replace(/\s+/g, ' ').trim(),
      chainToks: body.querySelectorAll('.cl-tok').length,
      evRows: body.querySelectorAll('.cl-ev').length,
    };
  });
  // outboundJourneyHtml_ is the renderer that had never run in a browser.
  record('Step 4: the OUTBOUND call renders through the link',
    /outbound call/i.test(outbound.text) && /Marie \(Muskaan\) Jindal/.test(outbound.text),
    outbound.text.slice(0, 110));
  record('it states the connected/talk outcome (not a queue disposition)',
    /connected/.test(outbound.text) && /talked/.test(outbound.text));
  record('it reuses the shared journey renderers (chain + event rows)',
    outbound.chainToks > 0 && outbound.evRows > 0,
    'toks=' + outbound.chainToks + ' rows=' + outbound.evRows);
  record('no caller identity is shown -- the callee is masked',
    /\(external number\)/.test(outbound.text) && !/\+?1?\d{10}/.test(outbound.text));

  // ---- 3. the NOT-ENTITLED refusal ---------------------------------------
  // Drive the client's own entry point with an id the mock refuses, so the
  // refusal branch renders through the real handler rather than a stub.
  await page.evaluate(() => {
    document.querySelector('#call-journey-overlay .cj-close, #call-journey-overlay .modal-close')?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = document.querySelector('.pid-journey');
    b.setAttribute('data-journey-pid', 'REFUSE-000');
    b.click();
  });
  await page.waitForTimeout(1200);

  const refused = await page.evaluate(() => {
    const body = document.querySelector('#call-journey-overlay .cj-body');
    return (body.textContent || '').replace(/\s+/g, ' ').trim();
  });
  record('the not-entitled refusal renders its own message',
    /another department/.test(refused) && /only reaches calls your department/.test(refused),
    refused.slice(0, 110));
  record('the refusal shows no call payload', !/outbound call/i.test(refused));

  // ---- hygiene ------------------------------------------------------------
  const unmocked = await page.evaluate(() => (window.__UNMOCKED__ || []).slice());
  record('no unmocked server calls during the walk',
    !unmocked.length, unmocked.join(', '));

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
