'use strict';
/** Phase 3: Escalations page + admin modals audit drive. */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');
const SITE = path.join(__dirname, 'site');
const SHOTS = path.join(__dirname, 'shots');
const rep = { errors: [], overflow: [], notes: {}, modals: {} };

const srvP = new Promise((res) => {
  const s = http.createServer((rq, rs) => {
    const p = path.join(SITE, rq.url.replace(/^\//, '').split('?')[0] || 'index-admin.html');
    try { const b = fs.readFileSync(p); rs.writeHead(200, { 'content-type': 'text/html' }); rs.end(b); }
    catch (e) { rs.writeHead(404); rs.end('nf'); }
  }).listen(0, '127.0.0.1', () => res(s));
});

(async () => {
  const srv = await srvP;
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });

  async function boot(variant, width) {
    const ctx = await browser.newContext({ viewport: { width: width || 1440, height: 950 }, deviceScaleFactor: width === 390 ? 2 : 1.5 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') rep.errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => rep.errors.push('PAGEERROR: ' + String(e).slice(0, 250)));
    await page.addInitScript(() => { localStorage.setItem('cdr.tour.done', '1'); });
    await page.goto(base + 'index-' + variant + '.html', { waitUntil: 'load' });
    await page.waitForTimeout(1800);
    return { ctx, page };
  }
  const ovf = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ============ ESCALATIONS PAGE (admin, 1440) ============
  {
    const { ctx, page } = await boot('admin');
    await page.click('#escalations-btn');
    await page.waitForTimeout(2500);
    rep.notes.escAdmin = await page.evaluate(() => ({
      page: document.body.dataset.page,
      cards: document.querySelectorAll('#esc-list .esc-card, .esc-card').length,
      catRows: [...document.querySelectorAll('.esc-cat-row, .esc-cat-item')].map((r) => r.textContent.trim().replace(/\s+/g, ' ').slice(0, 30)),
      band: [...document.querySelectorAll('.esc-band-tile, .esc-sum-tile')].map((t) => t.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)),
      reviewChip: document.querySelector('[id*=review-chip], .esc-review-chip')?.textContent.trim() || null,
      createFormVisible: !!document.querySelector('#esc-create-form, #esc-new-form, [id*=esc-create]')?.offsetParent,
      filterBox: !!document.querySelector('#esc-filter, [id*=esc-filter]'),
    }));
    rep.overflow.push({ label: 'esc-admin-1440', px: await ovf(page) });
    await page.screenshot({ path: path.join(SHOTS, 'esc-admin-1440.png'), fullPage: true });
    // expand Activity on the first card if the affordance exists
    const act = await page.$('.esc-card [data-esc-activity], .esc-card button:has-text("Activity")');
    if (act) { await act.click(); await page.waitForTimeout(900); await page.screenshot({ path: path.join(SHOTS, 'esc-admin-activity.png'), fullPage: false }); }
    await ctx.close();
  }
  // Escalations manager + 390
  {
    const { ctx, page } = await boot('manager');
    await page.click('#escalations-btn');
    await page.waitForTimeout(2200);
    rep.notes.escManager = await page.evaluate(() => ({
      cards: document.querySelectorAll('.esc-card').length,
      deptControl: (document.querySelector('.esc-sidebar select, .esc-dept-name') || {}).tagName || null,
      createVisible: !!document.querySelector('[id*=esc-create], #esc-new-form')?.offsetParent,
      adminOnlyVisible: [...document.querySelectorAll('#escalations-page [data-admin-only]')].filter((el) => el.offsetParent).map((el) => el.id || el.className),
    }));
    await page.screenshot({ path: path.join(SHOTS, 'esc-manager-1440.png'), fullPage: true });
    await ctx.close();
  }
  {
    const { ctx, page } = await boot('admin', 390);
    await page.click('#escalations-btn');
    await page.waitForTimeout(2200);
    rep.overflow.push({ label: 'esc-admin-390', px: await ovf(page) });
    await page.screenshot({ path: path.join(SHOTS, 'esc-admin-390.png'), fullPage: true });
    await ctx.close();
  }

  // ============ ADMIN MODALS (1440) ============
  const MODALS = [
    { name: 'alerts', open: async (p) => { await p.click('#admin-menu-btn'); await p.click('#alerts-btn'); }, sel: '#alerts-modal' },
    { name: 'orphan', open: async (p) => { await p.click('#admin-menu-btn'); await p.click('#orphan-fix-btn'); }, sel: '#orphan-fix-modal' },
    { name: 'deptconfig', open: async (p) => { await p.click('#admin-menu-btn'); await p.click('#dept-config-btn'); }, sel: '#dept-config-modal' },
    { name: 'access', open: async (p) => { await p.click('#admin-menu-btn'); await p.click('#access-control-btn'); }, sel: '#access-control-modal' },
    { name: 'health', open: async (p) => { await p.click('#admin-menu-btn'); await p.click('#system-health-btn'); }, sel: '#system-health-modal' },
    { name: 'caller', open: async (p) => { await p.click('#caller-lookup-btn'); }, sel: '#caller-lookup-modal' },
  ];
  for (const m of MODALS) {
    const { ctx, page } = await boot('admin');
    try {
      await m.open(page);
      await page.waitForTimeout(2200);
      const info = await page.evaluate((sel) => {
        const modal = document.querySelector(sel) || document.querySelector('.modal[style*="display: flex"], .modal:not([style*="none"])');
        if (!modal) return { found: false };
        const panel = modal.querySelector('.modal-panel');
        const r = panel ? panel.getBoundingClientRect() : null;
        return {
          found: true, id: modal.id,
          ariaModal: modal.getAttribute('aria-modal'), role: modal.getAttribute('role'),
          labelled: modal.getAttribute('aria-labelledby'),
          panelW: r ? Math.round(r.width) : null,
          panelOverflowsViewport: r ? (r.bottom > document.documentElement.clientHeight + 1 || r.right > document.documentElement.clientWidth + 1) : null,
          bodyText: modal.textContent.replace(/\s+/g, ' ').slice(0, 120),
        };
      }, m.sel);
      // Focus containment: Tab x30, is activeElement still inside the modal?
      let escapes = 0;
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate((sel) => {
          const modal = document.querySelector(sel);
          return modal ? modal.contains(document.activeElement) : null;
        }, m.sel);
        if (inside === false) escapes++;
      }
      info.focusEscapes = escapes;
      // Escape closes?
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      info.escapeCloses = await page.evaluate((sel) => {
        const modal = document.querySelector(sel);
        return modal ? (modal.style.display === 'none' || !modal.offsetParent) : null;
      }, m.sel);
      rep.modals[m.name] = info;
      // reopen for the screenshot
      await m.open(page); await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(SHOTS, 'modal-' + m.name + '.png'), fullPage: false });
    } catch (e) { rep.modals[m.name] = { error: String(e).slice(0, 200) }; }
    await ctx.close();
  }

  await browser.close(); srv.close();
  fs.writeFileSync(path.join(__dirname, 'report-phase3.json'), JSON.stringify(rep, null, 2));
  console.log(JSON.stringify(rep, null, 1).slice(0, 4200));
})();
