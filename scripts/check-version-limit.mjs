#!/usr/bin/env node
/**
 * DEP-5 (owner 2026-11-02): count an Apps Script project's VERSIONS before a
 * deploy rolls another one.
 *
 * Apps Script keeps at most 200 versions per project. Every web-app deploy
 * mints one (scripts/deploy.sh's `clasp deploy -i`, and the editor's
 * Deploy -> Manage deployments -> New version), so a project deployed often
 * fills up in a few months -- and the 201st deploy fails AFTER the push, with
 * "Cannot create more versions", leaving the live deployment on the old code.
 * Neither clasp nor the Apps Script API can delete a version, so the cleanup is
 * a manual step in the editor (Operator State #2), and this check exists to say
 * so EARLY: it warns from VERSION_WARN_AT on, and refuses at VERSION_LIMIT,
 * before the CI gates or the push run.
 *
 * Usage:  node scripts/check-version-limit.mjs <project-dir>
 *   <project-dir>   the directory holding .clasp.json ('.' for the dashboard)
 *   VERSION_WARN_AT (env, default 180)  warn from this many versions on
 *   VERSION_LIMIT   (env, default 200)  Apps Script's cap; refuse at it
 *
 * Exit codes: 0 = room left, a warning, or the count could not be read
 * (clasp missing, not logged in, an unrecognised output -- all reported,
 * never fatal: a diagnostic must not block a deploy). 2 = the project is at
 * the limit, so the deploy would fail.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2] || '.';
const WARN_AT = Number(process.env.VERSION_WARN_AT) || 180;
const LIMIT = Number(process.env.VERSION_LIMIT) || 200;

function say(msg) { console.log(msg); }
function skip(why) {
  say('==> version-limit check SKIPPED: ' + why);
  say('    (a diagnostic must not block a deploy -- check Project History in the editor if unsure)');
  process.exit(0);
}

/**
 * PURE. The number of versions in `clasp versions` / `clasp list-versions`
 * output, or null when the output says nothing recognisable. clasp 2 prints a
 * "~ N Versions ~" header and one "N - description" line per version; other
 * releases print "Found N versions." or the lines alone; "No deployed
 * versions" means 0.
 */
export function countVersions(out) {
  const text = String(out || '');
  let m = /~\s*(\d+)\s+Versions?\s*~/i.exec(text) || /Found\s+(\d+)\s+versions?/i.exec(text);
  if (m) return Number(m[1]);
  const lines = text.split(/\r?\n/).filter(function (l) { return /^\s*\d+\s+-\s/.test(l); });
  if (lines.length) return lines.length;
  if (/no (deployed )?versions/i.test(text)) return 0;
  return null;
}

function listVersions() {
  let lastErr = '';
  for (const args of [['versions'], ['list-versions']]) {
    const r = spawnSync('clasp', args, { cwd: dir, encoding: 'utf8' });
    if (r.error) return { err: r.error.code === 'ENOENT' ? 'clasp not found' : String(r.error.message || r.error) };
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0) return { out: out };
    lastErr = out.trim().split(/\r?\n/)[0] || ('clasp ' + args[0] + ' exited ' + r.status);
  }
  return { err: lastErr };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!existsSync(path.join(dir, '.clasp.json'))) skip('no .clasp.json in ' + dir);
  const res = listVersions();
  if (res.err) skip('could not list versions (' + res.err + ')');
  const n = countVersions(res.out);
  if (n === null) skip('could not read a version count from clasp\'s output');
  if (n >= LIMIT) {
    console.error('error: this project has ' + n + ' versions -- Apps Script\'s limit is ' + LIMIT + ',');
    console.error('       so this deploy could not create a new one (nothing has been pushed).');
    console.error('       Delete old versions first (neither clasp nor the API can):');
    console.error('         1. Deploy -> Manage deployments: note the live deployment\'s version and keep it.');
    console.error('         2. Project History (clock icon, left sidebar): delete the oldest versions,');
    console.error('            e.g. all but the last ~20 ("Bulk delete versions" if your editor has it).');
    console.error('         3. Re-run this deploy.');
    process.exit(2);
  }
  if (n >= WARN_AT) {
    say('==> WARNING: ' + n + ' of ' + LIMIT + ' versions used -- ' + (LIMIT - n) + ' deploy(s) left.');
    say('    Delete old versions in the editor (Project History) before the limit stops a deploy;');
    say('    keep the live deployment\'s version and the last ~20.');
  } else {
    say('==> versions: ' + n + ' of ' + LIMIT + ' used');
  }
}
