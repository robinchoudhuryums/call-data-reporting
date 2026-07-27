'use strict';
/**
 * Resolves the Chromium executable for the harness drivers.
 *
 * Why this exists: every driver used to default to `/opt/pw-browsers/chromium`,
 * which is a DIRECTORY, not the binary -- so a run failed with "executable
 * doesn't exist" until you passed CHROMIUM_PATH by hand. The real path also
 * carries the Playwright browser REVISION (`chromium-1194/chrome-linux/chrome`),
 * so hardcoding today's revision would just go stale on the next image bump.
 * This globs the revision instead.
 *
 * Order: $CHROMIUM_PATH -> /opt/pw-browsers/chromium-<rev>/chrome-linux/chrome
 * -> the un-revisioned layout -> headless_shell -> null (let Playwright resolve
 * from its own registry, which works when the browser was npm-installed).
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['/opt/pw-browsers'];

function firstExisting(candidates) {
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (e) { /* keep looking */ }
  }
  return null;
}

function resolveChromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const candidates = [];
  for (const root of ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    // Prefer the full browser over headless_shell, and the highest revision.
    const dirs = entries
      .filter((e) => /^chromium(_headless_shell)?[-\d]*$/.test(e))
      .sort((a, b) => {
        const shellA = a.includes('headless_shell') ? 1 : 0;
        const shellB = b.includes('headless_shell') ? 1 : 0;
        if (shellA !== shellB) return shellA - shellB;
        const revA = Number((a.match(/(\d+)$/) || [])[1] || 0);
        const revB = Number((b.match(/(\d+)$/) || [])[1] || 0);
        return revB - revA;
      });
    for (const d of dirs) {
      candidates.push(path.join(root, d, 'chrome-linux', 'chrome'));
      candidates.push(path.join(root, d, 'chrome-linux', 'headless_shell'));
    }
  }
  return firstExisting(candidates);   // null => let Playwright pick
}

/** Launch options for chromium.launch(); omits executablePath when unresolved. */
function launchOptions(extra) {
  const exec = resolveChromiumPath();
  const opts = Object.assign({}, extra || {});
  if (exec) opts.executablePath = exec;
  return opts;
}

module.exports = { resolveChromiumPath, launchOptions };
