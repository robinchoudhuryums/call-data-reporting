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
  assert.match(sh, /TREE_DIRTY=""\n\[ -n "\$\(git status --porcelain/);
  // Dirty / non-main deploys warn, and STRICT_DEPLOY=1 refuses them.
  assert.match(sh, /warn: the working tree is DIRTY/);
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
