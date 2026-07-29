#!/usr/bin/env node
/**
 * Batch 4 / Operator State #29: detect ORPHANED REMOTE FILES in an Apps Script
 * project -- files that exist in the deployed project but have no local
 * counterpart.
 *
 * Why this needs to exist: `clasp push -f` NEVER deletes remote files (INV-17).
 * Deleting a file from the repo therefore leaves it live and callable in the
 * Apps Script project until a human remembers to delete it in the web editor.
 * That is not hypothetical -- PerformanceReport.gs and CompareRangesReport.gs
 * were removed from the repo in the report-consolidation commits and their
 * endpoints stayed reachable, which is why Operator State #29 exists and has
 * been open across cycles. Nothing detected it; now something does.
 *
 * How: clasp has no "list remote files" command, so this PULLS the project into
 * a THROWAWAY temp directory (never the working tree) and compares. It is
 * read-only with respect to the repo.
 *
 * Usage:  node scripts/check-remote-orphans.mjs <project-dir>
 *   <project-dir>  the directory holding .clasp.json ('.' for the dashboard)
 *
 * Exit codes: 0 = no orphans, or the check could not run (unauthenticated,
 * clasp missing, pull failed -- all reported, never fatal, because a
 * diagnostic must not block a deploy). 1 = orphans found AND STRICT_ORPHANS=1.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = process.argv[2] || '.';
const STRICT = process.env.STRICT_ORPHANS === '1';

function say(msg) { console.log(msg); }
function skip(why) {
  say('==> remote-orphan check SKIPPED: ' + why);
  say('    (a diagnostic must not block a deploy -- re-run when it can work)');
  process.exit(0);
}

const claspPath = path.join(dir, '.clasp.json');
if (!existsSync(claspPath)) skip('no .clasp.json in ' + dir);

let cfg;
try { cfg = JSON.parse(readFileSync(claspPath, 'utf8')); }
catch (e) { skip('.clasp.json is not valid JSON (' + e.message + ')'); }
if (!cfg.scriptId || /REPLACE/i.test(cfg.scriptId)) skip('.clasp.json has no real scriptId');

// Apps Script has three file kinds. clasp PULL writes server files as `.js`
// even when they live locally as `.gs`, so compare on (name, kind) -- otherwise
// every single .gs file would look orphaned.
function kindOf(file) {
  if (/\.(gs|js)$/i.test(file)) return 'script';
  if (/\.html$/i.test(file)) return 'html';
  if (/\.json$/i.test(file)) return 'json';
  return null;
}
function idOf(file) {
  const k = kindOf(file);
  return k ? path.basename(file).replace(/\.[^.]+$/, '') + '|' + k : null;
}

// clasp's own control files are not Apps Script project files. `.clasp.json`
// in particular lives OUTSIDE rootDir locally but INSIDE the temp pull dir
// (this script writes it there to drive the pull), so without this exclusion it
// reported itself as an orphan on every run -- caught by simulating a pull.
const NOT_PROJECT_FILES = new Set(['.clasp.json', '.claspignore']);

function collect(root) {
  const out = new Map();          // id -> the filename that produced it
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.git' || NOT_PROJECT_FILES.has(e)) continue;
      const full = path.join(d, e);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const id = idOf(e);
      if (id) out.set(id, path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

const localRoot = path.resolve(dir, cfg.rootDir || '.');
if (!existsSync(localRoot)) skip('rootDir does not exist: ' + localRoot);
const local = collect(localRoot);

// Pull into a temp dir with rootDir forced to '.', so the pull can never land
// in (or clobber) the real project directory.
const tmp = mkdtempSync(path.join(tmpdir(), 'clasp-orphan-'));
let remote;
try {
  writeFileSync(path.join(tmp, '.clasp.json'),
    JSON.stringify({ scriptId: cfg.scriptId, rootDir: '.' }));
  try {
    execFileSync('clasp', ['pull'], { cwd: tmp, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-3).join(' ');
    skip('clasp pull failed -- ' + (out || e.message));
  }
  remote = collect(tmp);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
}

const orphans = [];
for (const [id, file] of remote) {
  if (id === 'appsscript|json') continue;          // the manifest is always both sides
  if (!local.has(id)) orphans.push({ id: id, file: file });
}

if (!orphans.length) {
  say('==> remote-orphan check: clean (' + remote.size + ' remote file(s), all present locally)');
  process.exit(0);
}

say('');
say('!!  ' + orphans.length + ' ORPHANED REMOTE FILE(S) in the Apps Script project');
say('!!  These exist in the DEPLOYED project but not in this repo. `clasp push -f`');
say('!!  cannot remove them (INV-17), so their code is still LIVE and their');
say('!!  endpoints still callable. Delete each in the Apps Script web editor:');
for (const o of orphans) say('!!    - ' + o.file);
say('!!  (Operator State #29. Run again after deleting to confirm.)');
say('');
if (STRICT) {
  say('==> STRICT_ORPHANS=1 -- failing.');
  process.exit(1);
}
process.exit(0);
