'use strict';

// Batch 11 (broad-scan 2026-10-01) -- the developer tooling around a deploy:
// scripts/deploy.sh, scripts/check-remote-orphans.mjs, scripts/bite.sh and
// the CI workflow. Behavioural where it can stay hermetic (no clasp, no
// network, no write to the working tree), source pins otherwise.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-tooling-')); };

// DEP-4: the placeholder check matches the repo's actual templates.
test('DEP-4: every placeholder scriptId SKIPS before clasp; a real-shaped id reaches the pull', function () {
  const script = path.join(ROOT, 'scripts', 'check-remote-orphans.mjs');
  const tmpl = JSON.parse(read('.clasp.example.json')).scriptId;   // the template a developer copies
  function run(id) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify({ scriptId: id }));
    // A PATH with no clasp: a placeholder must skip BEFORE ever needing it.
    const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    fs.rmSync(dir, { recursive: true, force: true });
    return (r.stdout || '') + (r.stderr || '');
  }
  [tmpl, '<paste-scriptId-here>', 'REPLACE_ME', '', 'YOUR_SCRIPT_ID'].forEach(function (id) {
    assert.match(run(id), /no real scriptId/, 'placeholder ' + JSON.stringify(id) + ' must skip cleanly');
  });
  // Random ids that merely CONTAIN a placeholder word are real (the list is anchored).
  ['1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefghijklmnopqr',
   '1yourPasteAbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefghij'].forEach(function (id) {
    const out = run(id);
    assert.doesNotMatch(out, /no real scriptId/, id);
    assert.match(out, /clasp pull failed/, 'a real-shaped id goes on to the pull');
  });
});

// DEP-2: deploy.sh normalizes <project-dir> before anything matches on it.
// The "no .clasp.json in '<DIR>'" error echoes the normalized form and fires
// before any write, so it is a hermetic probe (a stub clasp satisfies the
// earlier "clasp not found" check; it is never called).
test('DEP-2: deploy.sh resolves every spelling of a project dir to one canonical form', { skip: process.platform === 'win32' }, function () {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'clasp'), '#!/bin/sh\necho "STUB CALLED" >&2\nexit 9\n', { mode: 0o755 });
  const env = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, DEPLOY_SKIP_CI: '1' });
  function probe(arg, cwd) {
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'deploy.sh'), arg], { encoding: 'utf8', env: env, cwd: cwd || ROOT });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  }
  try {
    // Skip the probe for a project that has a real .clasp.json on this checkout
    // (a developer box) -- the script would go past the probe point.
    const has = function (d) { return fs.existsSync(path.join(ROOT, d, '.clasp.json')); };
    if (!has('apps-script/cdr-import')) {
      ['apps-script/cdr-import', './apps-script/cdr-import/', 'apps-script/cdr-import/.',
       path.join(ROOT, 'apps-script', 'cdr-import')].forEach(function (spelling) {
        const r = probe(spelling);
        assert.equal(r.code, 1, spelling);
        assert.match(r.out, /no \.clasp\.json in 'apps-script\/cdr-import'/, spelling + ' -> ' + r.out);
      });
      // `.` from INSIDE a sibling is that sibling, not the dashboard.
      assert.match(probe('.', path.join(ROOT, 'apps-script', 'cdr-import')).out, /in 'apps-script\/cdr-import'/);
    }
    if (!has('.')) {
      ['.', './', ROOT].forEach(function (spelling) {
        assert.match(probe(spelling).out, /no \.clasp\.json in '\.'/, spelling);
      });
    }
    assert.match(probe(os.tmpdir()).out, /outside this repo/);
    assert.match(probe('no/such/dir').out, /no such project dir/);
    // Same skip rule as above: on a developer box a project with a real
    // .clasp.json goes PAST the probe point and reaches the stub, by design --
    // asserting "never called" there failed the deploy gate itself.
    ['apps-script/cdr-import', '.'].filter(function (d) { return !has(d); })
      .forEach(function (d) { assert.doesNotMatch(probe(d).out, /STUB CALLED/); });
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('DEP-2/DEP-3: the stamp switch matches only canonical spellings and shares the one dirtiness flag', function () {
  const sh = read('scripts/deploy.sh');
  const norm = sh.indexOf('DEP-2 (broad-scan');
  assert.ok(norm > 0 && norm < sh.indexOf('.clasp.json" ]'), 'normalization runs before the first use of DIR');
  assert.doesNotMatch(sh, /apps-script\/cdr-(import|report)\/\)/, 'no trailing-slash spellings remain in a case arm');
  // DEP-3: the stamp's +dirty comes from TREE_DIRTY (porcelain: untracked files
  // count, and clasp DOES push an untracked .gs) -- not a second `git diff` check.
  assert.doesNotMatch(sh, /git diff --quiet/);
  assert.match(sh, /\[ -n "\$TREE_DIRTY" \] && GIT_DESC="\$\{GIT_DESC\}\+dirty"/);
  assert.match(sh, /TREE_DIRTY=""\n\[ -n "\$\(git status --porcelain -- "\$PUSH_SCOPE"/);
  // Dirty / non-main deploys warn, and STRICT_DEPLOY=1 refuses them.
  assert.match(sh, /warn: the working tree is DIRTY under \$PUSH_SCOPE/);
  assert.match(sh, /warn: deploying from branch '\$GIT_BRANCH', not main/);
  assert.match(sh, /"\$\{STRICT_DEPLOY:-\}" = "1"[\s\S]{0,120}exit 1/);
});

// DEP-1: bite.sh restores the mutated file on ANY exit, not only the normal one.
test('DEP-1: bite.sh arms an EXIT trap after the dirty guard and before the mutation', function () {
  const sh = read('scripts/bite.sh');
  const guard = sh.indexOf('git status --porcelain -- "$file"');
  const trap = sh.indexOf('trap restore EXIT');
  const mutate = sh.indexOf('python3 -c "\nimport');
  assert.ok(guard > 0 && trap > guard && mutate > trap, 'guard -> trap -> mutation');
  assert.match(sh, /restore\(\) \{ git checkout -- "\$file"/);
  assert.match(sh, /trap 'exit 130' INT/);
  assert.doesNotMatch(sh.slice(mutate), /^git checkout -- "\$file"$/m, 'no second, unconditional restore after the run');
});

// HT-6: CI runs the Node line development uses (20 is end-of-life).
test('HT-6: every CI job runs on Node 22', function () {
  const yml = read('.github/workflows/ci.yml');
  const versions = yml.match(/node-version:\s*'?(\d+)/g) || [];
  assert.ok(versions.length >= 3, 'all three jobs pin a version');
  versions.forEach(function (v) { assert.match(v, /'?22$/, v); });
});

// DEP-2 (broad-scan 2026-10-12): the build stamp is written into a
// single-quoted JS string, and the EXIT trap used `git checkout`. Both halves
// run here from the script's OWN lines (extracted, not re-typed), so a change
// to either is what gets tested.
test('DEP-2: a hostile branch name still yields a parseable stamp, and the trap restores the pre-deploy file', { skip: process.platform === 'win32' }, function () {
  const sh = read('scripts/deploy.sh');
  const branchLine = (sh.match(/^\s*STAMP_BRANCH=.*$/m) || [''])[0].trim();
  assert.ok(branchLine, 'the sanitizer line exists');
  const r = spawnSync('bash', ['-c', branchLine + '; printf %s "$STAMP_BRANCH"'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_BRANCH: "fix/it's-a\\\\b`c" }) });
  const branch = r.stdout;
  assert.match(branch, /^fix\/it_s-a__b_c$/, 'quote, backslash and backtick become _: ' + branch);
  // The emitted line parses as JS.
  assert.doesNotThrow(function () { new Function("var X = 'deploy.sh t | git abc | " + branch + "';"); });

  // The trap: an UNCOMMITTED edit to the stamp file survives the deploy.
  const start = sh.indexOf('STAMP_BAK="$(mktemp)"');
  const end = sh.indexOf(' EXIT\n', start);
  assert.ok(start > 0 && end > start, 'the backup + trap block exists');
  const block = sh.slice(start, end + ' EXIT'.length);
  const dir = tmp();
  const file = path.join(dir, 'BuildStamp.gs');
  fs.writeFileSync(file, "var BUILD_STAMP_ = 'a developer edit, not committed';\n");
  const script = 'STAMP_FILE="' + file + '"\n' + block + '\necho "var BUILD_STAMP_ = \'stamped\';" > "$STAMP_FILE"\nexit 3\n';
  const t = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(t.status, 3, 'the script exited (non-zero, like a failed push)');
  assert.equal(fs.readFileSync(file, 'utf8'), "var BUILD_STAMP_ = 'a developer edit, not committed';\n",
    'restored to exactly what was there before -- git checkout would have dropped the edit');
  assert.ok(!/git checkout --quiet -- "\$STAMP_FILE"/.test(sh), 'the stamp trap no longer uses git checkout');
  fs.rmSync(dir, { recursive: true, force: true });
});

// DEP-1 (broad-scan 2026-10-12): CI pins playwright (S7); every place that
// tells a developer how to install it names the SAME version, so the local
// deploy gate renders with what CI renders with.
test('DEP-1: every playwright install instruction pins the version ci.yml installs', function () {
  const ci = (read('.github/workflows/ci.yml').match(/npm i [^\n]*playwright@(\d+\.\d+\.\d+)/) || [])[1];
  assert.ok(ci, 'ci.yml pins a playwright version');
  ['README.md', 'CLAUDE.md', 'scripts/deploy.sh', 'tools/ui-harness/ci.mjs', 'tools/ui-harness/README.md'].forEach(function (f) {
    const src = read(f);
    assert.ok(!/npm i playwright(?!@)/.test(src), f + ' installs an unpinned playwright');
    (src.match(/npm i playwright@[\d.]+/g) || []).forEach(function (m) {
      assert.equal(m, 'npm i playwright@' + ci, f + ': ' + m);
    });
  });
});

// F41 (broad-scan 2026-10-14): "dirty" is scoped to what the push ships -- the
// project's clasp rootDir -- so a .cycle/ or docs edit no longer stamps +dirty,
// defeats the redundant-deploy guard or trips STRICT_DEPLOY.
test('F41: the dirtiness scope is the project\'s clasp rootDir, resolved from its .clasp.json', { skip: process.platform === 'win32' }, function () {
  const sh = read('scripts/deploy.sh');
  const a = sh.indexOf('# PUSH_SCOPE-BEGIN'), b = sh.indexOf('# PUSH_SCOPE-END');
  assert.ok(a > 0 && b > a, 'the scope block exists');
  const block = sh.slice(a, b);
  const root = tmp();
  fs.mkdirSync(path.join(root, 'apps-script', 'cdr-import'), { recursive: true });
  fs.writeFileSync(path.join(root, '.clasp.json'), JSON.stringify({ scriptId: 'x', rootDir: './apps-script/department-dashboard' }));
  fs.writeFileSync(path.join(root, 'apps-script', 'cdr-import', '.clasp.json'), JSON.stringify({ scriptId: 'y' }));
  const scope = function (dir) {
    const r = spawnSync('bash', ['-c', 'ROOT_ABS="$1"; DIR="$2"\n' + block + '\nprintf %s "$PUSH_SCOPE"', '_', root, dir], { encoding: 'utf8' });
    return r.stdout;
  };
  try {
    assert.equal(scope('.'), 'apps-script/department-dashboard', 'the dashboard ships its rootDir, not the repo');
    assert.equal(scope('apps-script/cdr-import'), 'apps-script/cdr-import', 'no rootDir = the project dir');
    assert.equal(scope('apps-script/cdr-report'), 'apps-script/cdr-report', 'an unreadable .clasp.json falls back to the dir');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // And the warn lists only that scope's changes.
  assert.match(sh, /git status --short -- "\$PUSH_SCOPE"/);
});

// DEP-5 (owner 2026-11-02): Apps Script's 200-version cap stopped a deploy
// ("Cannot create more versions") after the push. check-version-limit.mjs
// counts the versions first: warn from 180, refuse at 200, never block on an
// unreadable count. A stub clasp on PATH keeps it hermetic.
function versionStub(bin, mode) {
  // mode: 'v2' (clasp versions), 'v3' (versions fails, list-versions works), 'fail'
  const body = '#!/bin/sh\n'
    + 'if [ "$1" = "versions" ] && [ "' + mode + '" = "v2" ]; then\n'
    + '  echo "~ $STUB_N Versions ~"; i=$STUB_N; while [ $i -gt 0 ]; do echo "$i - deploy"; i=$((i-1)); done; exit 0; fi\n'
    + 'if [ "$1" = "list-versions" ] && [ "' + mode + '" = "v3" ]; then\n'
    + '  i=$STUB_N; while [ $i -gt 0 ]; do echo "$i - deploy"; i=$((i-1)); done; exit 0; fi\n'
    + 'echo "Unknown command or not logged in" >&2; exit 1\n';
  fs.writeFileSync(path.join(bin, 'clasp'), body, { mode: 0o755 });
}
function runVersionCheck(mode, n, extraEnv) {
  const bin = tmp(), proj = tmp();
  fs.writeFileSync(path.join(proj, '.clasp.json'), JSON.stringify({ scriptId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }));
  if (mode) versionStub(bin, mode);
  const env = Object.assign({}, process.env, { PATH: bin + ':/usr/bin:/bin', STUB_N: String(n) }, extraEnv || {});
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-version-limit.mjs'), proj], { encoding: 'utf8', env: env });
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('DEP-5: countVersions reads every clasp output shape, and says null rather than guess', async function () {
  const { countVersions } = await import(path.join(ROOT, 'scripts', 'check-version-limit.mjs'));
  assert.equal(countVersions('~ 198 Versions ~\n198 - deploy 2026\n197 - deploy'), 198, 'the header wins');
  assert.equal(countVersions('3 - a\n2 - b\n1 - No description\n'), 3);
  assert.equal(countVersions('Found 12 versions.'), 12);
  assert.equal(countVersions('No deployed versions of script.'), 0);
  assert.equal(countVersions('Something went wrong'), null);
  assert.equal(countVersions(''), null);
});

test('DEP-5: room left passes quietly, 180+ warns, 200 refuses (exit 2) with the cleanup steps', { skip: process.platform === 'win32' }, function () {
  let r = runVersionCheck('v2', 150);
  assert.equal(r.code, 0);
  assert.match(r.out, /versions: 150 of 200 used/);
  r = runVersionCheck('v2', 185);
  assert.equal(r.code, 0);
  assert.match(r.out, /WARNING: 185 of 200 versions used -- 15 deploy\(s\) left/);
  r = runVersionCheck('v2', 200);
  assert.equal(r.code, 2, 'at the cap the deploy is refused');
  assert.match(r.out, /200 versions -- Apps Script's limit is 200/);
  assert.match(r.out, /Project History/);
  r = runVersionCheck('v2', 170, { VERSION_WARN_AT: '160' });
  assert.match(r.out, /WARNING: 170 of 200/, 'VERSION_WARN_AT moves the warning');
});

test('DEP-5: a newer clasp (list-versions) is read too; clasp missing or failing never blocks', { skip: process.platform === 'win32' }, function () {
  let r = runVersionCheck('v3', 200);
  assert.equal(r.code, 2, 'list-versions output counts the same');
  r = runVersionCheck('fail', 0);
  assert.equal(r.code, 0);
  assert.match(r.out, /version-limit check SKIPPED: could not list versions/);
  r = runVersionCheck(null, 0);   // no clasp on PATH at all
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIPPED: could not list versions \(clasp not found\)/);
});

test('DEP-5: deploy.sh runs the version check only when it will roll a deployment, before the gates and the push', function () {
  const s = read('scripts/deploy.sh');
  const check = s.indexOf('scripts/check-version-limit.mjs" "$DIR"');
  assert.ok(check > 0, 'deploy.sh calls the check');
  assert.match(s.slice(check - 200, check), /if \[ -n "\$DEP_ID" \]; then\s*\n\s*node /, 'only with a deployment id');
  assert.ok(check < s.indexOf('TZ="$CI_TZ" npm run ci'), 'before the ten-minute gates');
  assert.ok(check < s.indexOf('clasp push -f\n'), 'before the push, so nothing is pushed without a version to serve it');
});

// ── SPEED-1..4 (owner 2026-11-06): a faster deploy gate that checks exactly as
// much as before. The rendered-UI drivers run concurrently, drive-smoke runs as
// two role shards, a sibling deploy skips the dashboard-only rendered gate, and
// a gate that passed at a clean commit is not re-run for that same commit.

// SPEED-1/2: the parallel runner still runs every driver, setup first.
test('SPEED-1/2: ci.mjs builds first, then runs every asserting driver concurrently, smoke in two role shards', function () {
  const ci = read('tools/ui-harness/ci.mjs');
  const setupAt = ci.indexOf('const SETUP = [');
  const stagesAt = ci.indexOf('const STAGES = [');
  assert.ok(setupAt > 0 && stagesAt > setupAt, 'SETUP is declared before the driver STAGES');
  const setup = ci.slice(setupAt, stagesAt);
  ['gen-payloads.js', 'gen-phase3.js', "'build-harness.js', 'admin'", "'build-harness.js', 'manager'", 'build-agent.js']
    .forEach(function (s) { assert.ok(setup.indexOf(s) > 0, s + ' is a SETUP stage (drivers read what it writes)'); });
  const stages = ci.slice(stagesAt, ci.indexOf('];', stagesAt));
  assert.doesNotMatch(stages, /gen-|build-/, 'no build step among the concurrent drivers');
  // Both smoke shards, and only the two real roles.
  assert.match(stages, /\['node', \['drive-smoke\.js', 'admin'\]/);
  assert.match(stages, /\['node', \['drive-smoke\.js', 'manager'\]/);
  assert.doesNotMatch(stages, /\['node', \['drive-smoke\.js'\]/, 'no unsharded smoke run beside the shards');
  // Every asserting driver on disk is in the gate (exploratory ones excluded).
  const EXPLORATORY = ['drive.js', 'drive-insights.js', 'drive-phase3.js'];
  const onDisk = fs.readdirSync(path.join(ROOT, 'tools', 'ui-harness'))
    .filter(function (f) { return /^drive-[a-z0-9-]+\.js$/.test(f) && EXPLORATORY.indexOf(f) < 0; });
  onDisk.forEach(function (f) { assert.ok(stages.indexOf("'" + f + "'") > 0, f + ' is an asserting driver missing from STAGES'); });
  // The runner: concurrency knob, every driver awaited, setup before drivers, a
  // failure anywhere exits non-zero.
  assert.match(ci, /process\.env\.UI_HARNESS_JOBS/);
  assert.match(ci, /runSetup\(\);\s*\nawait runDrivers\(\);/);
  assert.match(ci, /await Promise\.all\(Array\.from\(\{ length: jobs \}, worker\)\)/);
  assert.match(ci, /if \(failed\.length\) \{[\s\S]{0,200}process\.exit\(/);
});

test('SPEED-2: drive-smoke takes an optional role, refuses an unknown one, and defaults to both', function () {
  const src = read('tools/ui-harness/drive-smoke.js');
  assert.match(src, /const ALL_ROLES = \['admin', 'manager'\];/);
  assert.match(src, /const ROLES = ROLE_ARG \? \[ROLE_ARG\] : ALL_ROLES;/);
  assert.match(src, /for \(const role of ROLES\)/);
  assert.match(src, /ALL_ROLES\.indexOf\(ROLE_ARG\) < 0\) \{[\s\S]{0,200}process\.exit\(2\)/, 'a typo is refused, not run as zero roles');
  // The shards are only sound while nothing outlives one role's pass: the only
  // module-level mutable state is the shared results list.
  const mutables = src.match(/^(let|var) /mg) || [];
  assert.equal(mutables.length, 0, 'drive-smoke gained module-level mutable state -- check the role shards still share nothing');
});

// SPEED-3: the rendered gate drives ONLY the dashboard, which is the whole
// warrant for skipping it on a sibling deploy. If the harness ever loads a
// sibling project's code, this fails -- and the skip in deploy.sh must go.
test('SPEED-3: tools/ui-harness loads only dashboard server code, and deploy.sh skips ci:ui only for the siblings', function () {
  const dir = path.join(ROOT, 'tools', 'ui-harness');
  fs.readdirSync(dir).filter(function (f) { return /\.(js|mjs)$/.test(f); }).forEach(function (f) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /cdr-import|cdr-report|project:\s*['"]/,
      f + ' reaches a sibling project -- the SPEED-3 ci:ui skip for cdr-import / cdr-report deploys is no longer sound; remove it');
  });
  const sh = read('scripts/deploy.sh');
  const arm = /case "\$DIR" in\s*\n\s*apps-script\/cdr-import\|apps-script\/cdr-report\)\s*\n\s*echo "==> npm run ci:ui   SKIPPED[^\n]*\n\s*;;\s*\n\s*\*\)([\s\S]*?)\n\s*;;\s*\n\s*esac/.exec(sh);
  assert.ok(arm, 'the ci:ui skip is a case arm naming exactly the two siblings');
  assert.match(arm[1], /CI=1 TZ="\$CI_TZ" npm run ci:ui/, 'every other project (the dashboard) still runs ci:ui');
});

// SPEED-4: the once-per-commit gate marker, run for real in a scratch repo.
test('SPEED-4: a gate is skipped only at the same CLEAN commit, zone and tools; dirt, a new commit or REGATE=1 re-runs it', { skip: process.platform === 'win32' }, function () {
  const sh = read('scripts/deploy.sh');
  const a = sh.indexOf('# GATE-MARK-BEGIN'), b = sh.indexOf('# GATE-MARK-END');
  assert.ok(a > 0 && b > a, 'the marker block exists');
  const block = sh.slice(a, b);
  const root = tmp();
  const git = function () { return spawnSync('git', Array.prototype.slice.call(arguments), { cwd: root, encoding: 'utf8' }); };
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, '.gitignore'), '.last-gated\n.last-gated.tmp\n');
  fs.writeFileSync(path.join(root, 'a.txt'), '1');
  git('add', '-A'); git('commit', '-qm', 'one');
  // Run the block, then a script of gate calls; prints "done:<gate>" per hit.
  const run = function (script, env) {
    const r = spawnSync('bash', ['-c', 'set -euo pipefail\nROOT_ABS="$1"; CI_TZ="${CI_TZ:-America/Chicago}"\n' + block + '\n' + script, '_', root],
      { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const check = 'for g in unit ui; do if gate_done_ $g; then echo done:$g; fi; done';
  try {
    assert.equal(run(check), '', 'nothing recorded yet');
    run('gate_record_ unit');
    assert.equal(run(check), 'done:unit\n', 'unit recorded at this clean commit; ui still due');
    run('gate_record_ ui');
    assert.equal(run(check), 'done:unit\ndone:ui\n');
    assert.equal(run(check, { REGATE: '1' }), '', 'REGATE=1 re-runs everything');
    assert.equal(run(check, { CI_TZ: 'UTC' }), '', 'a different zone is a different gate');
    // An uncommitted change anywhere (untracked counts): nothing skipped, nothing recorded.
    fs.writeFileSync(path.join(root, 'new.test.js'), 'x');
    assert.equal(run(check), '', 'an untracked file is a dirty tree');
    run('gate_record_ unit');
    fs.rmSync(path.join(root, 'new.test.js'));
    assert.equal(run(check), 'done:unit\ndone:ui\n', 'the dirty run recorded nothing new and broke nothing');
    // A new commit: nothing carries over, and its first record drops the old sha.
    fs.writeFileSync(path.join(root, 'a.txt'), '2');
    git('commit', '-qam', 'two');
    assert.equal(run(check), '', 'a new commit runs every gate');
    run('gate_record_ ui');
    const lines = fs.readFileSync(path.join(root, '.last-gated'), 'utf8').trim().split('\n');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    assert.equal(lines.length, 1, 'only the current commit is kept');
    assert.ok(lines[0].indexOf(head + ' ui tz=America/Chicago node=') === 0, lines[0]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SPEED-4: each gate records only after its commands, inside the DEPLOY_SKIP_CI gate; .last-gated is gitignored', function () {
  const sh = read('scripts/deploy.sh');
  const gate = /if \[ "\$\{DEPLOY_SKIP_CI:-\}" != "1" \]; then([\s\S]*?)\nfi\n/.exec(sh)[1];
  const at = function (s) { const i = gate.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('TZ="$CI_TZ" npm run ci\n') < at('npm run lint:gas\n') && at('npm run lint:gas\n') < at('gate_record_ unit'),
    'unit is recorded after BOTH npm run ci and lint:gas');
  assert.ok(at('CI=1 TZ="$CI_TZ" npm run ci:ui\n') < at('gate_record_ ui'), 'ui is recorded after ci:ui');
  assert.ok(at('if gate_done_ unit') < at('TZ="$CI_TZ" npm run ci\n'), 'the skip check guards the run');
  assert.match(sh, /set -euo pipefail/, 'a failing gate exits before its record');
  const gi = read('.gitignore');
  assert.match(gi, /^\.last-gated$/m, 'the marker never dirties the tree it checks');
  assert.match(gi, /^\.last-gated\.tmp$/m);
});
