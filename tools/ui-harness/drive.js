'use strict';
/**
 * Playwright driver for the UI harness. Serves ./site over http, loads the
 * admin + manager variants, walks Overview + My Department in light/dark and
 * across viewports, captures screenshots, and runs programmatic checks:
 * console errors, horizontal overflow, focus traversal, contrast sampling.
 * Output: ./shots/*.png + ./report.json
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const HERE = __dirname;
const SITE = path.join(HERE, 'site');
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index-admin.html');
      try {
        const buf = fs.readFileSync(p);
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(buf);
      } catch (e) { res.writeHead(404); res.end('nf'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const report = { consoleErrors: [], unmocked: {}, overflow: [], focusWalks: {}, contrast: [], notes: [] };

async function newPage(ctx, url, { dark } = {}) {
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push({ url: url.split('/').pop(), text: m.text().slice(0, 300) });
  });
  page.on('pageerror', (e) => report.consoleErrors.push({ url: url.split('/').pop(), text: 'pageerror: ' + String(e).slice(0, 300) }));
  await page.addInitScript(([darkMode]) => {
    // Suppress first-run overlays so screenshots show the pages themselves.
    localStorage.setItem('cdr.tour.done', '1');
    localStorage.setItem('cdr.ins.intro.v1', '1');
    if (darkMode) localStorage.setItem('dash-mode', 'dark');
    else localStorage.removeItem('dash-mode');
  }, [!!dark]);
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

async function settle(page, ms = 1600) { await page.waitForTimeout(ms); }

async function checkOverflow(page, label) {
  const o = await page.evaluate(() => {
    const doc = document.documentElement;
    const pageOverflow = doc.scrollWidth - doc.clientWidth;
    // Find the widest offenders if the page overflows.
    const offenders = [];
    if (pageOverflow > 1) {
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.right > doc.clientWidth + 1 && r.width > 40 && el.children.length < 30) {
          offenders.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')), right: Math.round(r.right), vw: doc.clientWidth });
        }
      });
    }
    return { pageOverflow, offenders: offenders.slice(0, 6) };
  });
  if (o.pageOverflow > 1) report.overflow.push({ label, px: o.pageOverflow, offenders: o.offenders });
}

async function contrastSample(page, label) {
  const rows = await page.evaluate(() => {
    function lum(c) {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return null;
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
    }
    function bg(el) {
      let e = el;
      while (e && e !== document.documentElement) {
        const c = getComputedStyle(e).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        e = e.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    }
    const sels = ['.muted', '.dept-qcd-hint', '.ov-chart-hint', '.dash-kicker', '.freshness-pill',
      '.info-line', '.ds-zone-label', '.tag', '.wow-chip-muted', '.ov-period-lbl', '.header-menu-btn',
      '.dept-qcd-date', '.empty-state-hint', '.agents th', '.source-chip', '.ov-tile-caption'];
    const out = [];
    sels.forEach((s) => {
      const el = document.querySelector(s);
      if (!el || !el.offsetParent) return;
      const cs = getComputedStyle(el);
      const l1 = lum(cs.color), l2 = lum(bg(el));
      if (l1 == null || l2 == null) return;
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({ sel: s, ratio: Math.round(ratio * 100) / 100, size: cs.fontSize, weight: cs.fontWeight });
    });
    return out;
  });
  rows.forEach((r) => report.contrast.push({ label, ...r }));
}

async function focusWalk(page, label, n = 18) {
  const seq = [];
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return 'null';
      const vis = getComputedStyle(a).outlineStyle !== 'none' || a.matches(':focus-visible');
      return (a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.className && typeof a.className === 'string' ? '.' + a.className.split(' ')[0] : '')) + (vis ? '' : ' [no-outline]');
    });
    seq.push(d);
  }
  report.focusWalks[label] = seq;
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });

  // ---------------- admin, desktop 1440 ----------------
  for (const dark of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
    const page = await newPage(ctx, base + 'index-admin.html', { dark });
    await settle(page, 2200);
    const suffix = dark ? '-dark' : '';
    await page.screenshot({ path: path.join(SHOTS, `ov-admin-1440${suffix}.png`), fullPage: true });
    if (!dark) { await checkOverflow(page, 'ov-admin-1440'); await contrastSample(page, 'ov-1440-light'); await focusWalk(page, 'overview'); }
    else { await contrastSample(page, 'ov-1440-dark'); }

    // My Department
    await page.click('#my-dept-btn');
    await settle(page, 2400);
    await page.screenshot({ path: path.join(SHOTS, `dept-admin-1440${suffix}.png`), fullPage: true });
    if (!dark) {
      await checkOverflow(page, 'dept-admin-1440');
      await contrastSample(page, 'dept-1440-light');
      // Show-all-columns view
      await page.click('#dept-cols-toggle');
      await settle(page, 500);
      await page.screenshot({ path: path.join(SHOTS, 'dept-admin-1440-allcols.png'), fullPage: false });
      await checkOverflow(page, 'dept-admin-1440-allcols');
      // Missed bucket drill (click the tallest bar region center)
      const canvas = await page.$('#dept-missed-chart');
      if (canvas) {
        const bb = await canvas.boundingBox();
        if (bb) { await page.mouse.click(bb.x + bb.width * 0.45, bb.y + bb.height * 0.6); await settle(page, 900); }
        await page.screenshot({ path: path.join(SHOTS, 'dept-missed-drill-1440.png'), fullPage: false });
      }
    } else {
      await contrastSample(page, 'dept-1440-dark');
    }
    await ctx.close();
  }

  // ---------------- manager, desktop 1440 (light) ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
    const page = await newPage(ctx, base + 'index-manager.html', {});
    await settle(page, 2200);
    await page.screenshot({ path: path.join(SHOTS, 'ov-manager-1440.png'), fullPage: true });
    // Admin-leak check: any [data-admin-only] visible? Any admin data present?
    const leak = await page.evaluate(() => {
      const vis = [];
      document.querySelectorAll('[data-admin-only]').forEach((el) => {
        if (el.offsetParent !== null && getComputedStyle(el).display !== 'none') vis.push(el.id || el.className);
      });
      return { visibleAdminEls: vis, hasCompanyAgg: !!document.querySelector('#ov-company-aggregate')?.offsetParent };
    });
    report.notes.push({ managerLeakCheck: leak });
    await page.click('#my-dept-btn');
    await settle(page, 2200);
    await page.screenshot({ path: path.join(SHOTS, 'dept-manager-1440.png'), fullPage: true });
    await ctx.close();
  }

  // ---------------- narrow viewports (admin, light) ----------------
  for (const w of [1024, 768, 390]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: w < 500 ? 2 : 1.5 });
    const page = await newPage(ctx, base + 'index-admin.html', {});
    await settle(page, 2200);
    await page.screenshot({ path: path.join(SHOTS, `ov-admin-${w}.png`), fullPage: true });
    await checkOverflow(page, `ov-admin-${w}`);
    await page.click('#my-dept-btn');
    await settle(page, 2200);
    await page.screenshot({ path: path.join(SHOTS, `dept-admin-${w}.png`), fullPage: true });
    await checkOverflow(page, `dept-admin-${w}`);
    if (w === 390) {
      // Show-all-columns at phone width: does the wrap scroll or the page?
      await page.click('#dept-cols-toggle').catch(() => {});
      await settle(page, 500);
      await checkOverflow(page, 'dept-admin-390-allcols');
      await page.screenshot({ path: path.join(SHOTS, 'dept-admin-390-allcols.png'), fullPage: false });
    }
    await ctx.close();
  }

  // Collect unmocked RPC tallies from one last load.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await newPage(ctx, base + 'index-admin.html', {});
    await settle(page, 2000);
    report.unmocked = await page.evaluate(() => {
      const t = {}; (window.__HARNESS__.unmocked || []).forEach((n) => { t[n] = (t[n] || 0) + 1; });
      return t;
    });
    await ctx.close();
  }

  await browser.close();
  srv.close();
  fs.writeFileSync(path.join(HERE, 'report.json'), JSON.stringify(report, null, 2));
  console.log('shots:', fs.readdirSync(SHOTS).length, 'report written');
  console.log('console errors:', report.consoleErrors.length, '| overflow findings:', report.overflow.length);
})();
