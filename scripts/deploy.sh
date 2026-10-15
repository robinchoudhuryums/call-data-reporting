#!/usr/bin/env bash
# Push an Apps Script project AND roll its web-app deployment to a new
# version in one step -- so the live /exec URL serves the pushed code
# without the manual "Deploy -> Manage deployments -> New version -> Deploy"
# click in the editor (the recurring stale-deploy footgun; Operator State #2).
#
# Usage:
#   scripts/deploy.sh <project-dir> [deployment-id]
#
#   <project-dir>    one of:
#                      .                       (repo root = Department Dashboard)
#                      apps-script/cdr-report  (CDR Report / DQE Pipeline)
#                      apps-script/cdr-import  (CDR Import)
#   [deployment-id]  the web-app deployment to roll forward — DASHBOARD ONLY.
#                    Find it once with `clasp deployments` run in that dir,
#                    and use the versioned web-app deployment's id (NOT the
#                    @HEAD one) -- or write it once to a gitignored
#                    `.deployment-id` file in the project dir and omit the
#                    argument forever. With neither, the script only
#                    `clasp push -f`s and you finish the version bump
#                    manually in the editor. The two SIBLING projects are
#                    not web apps (their triggers + menus always run the
#                    pushed code), so for them the push IS the deploy and
#                    no id exists to pass.
#
#   FORCE=1          bypass the redundant-run guard (see below), e.g. to
#                    re-roll a deployment after an editor-side change.
#   STRICT_DEPLOY=1  refuse a deploy from a dirty tree or a branch other than
#                    main (both only WARN by default; DEP-3).
#
# Notes:
#   - Each project keeps its own gitignored .clasp.json; pass the project dir
#     in any spelling (`.`, `./`, an absolute path -- DEP-2 normalizes it) and
#     the script cd's in for you.
#   - Requires the clasp CLI, logged in (`clasp login`).
set -euo pipefail

DIR="${1:?usage: scripts/deploy.sh <project-dir> [deployment-id]}"
DEP_ID="${2:-}"

# DEP-2 (broad-scan 2026-10-01): normalize <project-dir> to its REPO-RELATIVE
# form before anything matches on it. The stamp / sibling-project `case`
# blocks below compare literal strings, so `./`, `$PWD`, an absolute path or
# `apps-script/cdr-import/.` used to fall through to "no stamp file" and ship
# the "unstamped" placeholder -- the Health page then reported a deploy.sh run
# as a bypass. One canonical spelling: `.` for the dashboard, otherwise
# `apps-script/<project>` with no trailing slash.
ROOT_ABS="$(cd "$(dirname "$0")/.." && pwd -P)"
if ! DIR_ABS="$(cd "$DIR" 2>/dev/null && pwd -P)"; then
  echo "error: no such project dir: '$DIR'" >&2
  exit 1
fi
case "$DIR_ABS" in
  "$ROOT_ABS")   DIR="." ;;
  "$ROOT_ABS"/*) DIR="${DIR_ABS#"$ROOT_ABS"/}" ;;
  *) echo "error: '$DIR' is outside this repo ($ROOT_ABS)" >&2; exit 1 ;;
esac
cd "$ROOT_ABS"   # every path below is repo-relative from here on

if ! command -v clasp >/dev/null 2>&1; then
  echo "error: clasp not found. Install with: npm install -g @google/clasp" >&2
  exit 1
fi
if [ ! -f "$DIR/.clasp.json" ]; then
  echo "error: no .clasp.json in '$DIR' (gitignored, per-developer). See README." >&2
  exit 1
fi

# Per-developer default deployment id (the .clasp.json pattern): with no id
# argument, fall back to a gitignored `.deployment-id` file in the project
# dir -- write the versioned web-app deployment's id there once (from
# `clasp deployments`; NOT the @HEAD one) and `scripts/deploy.sh .` rolls
# the live deployment with nothing to remember. The sibling projects are
# not web apps and simply won't have the file.
if [ -z "$DEP_ID" ] && [ -f "$DIR/.deployment-id" ]; then
  DEP_ID="$(head -n 1 "$DIR/.deployment-id" | tr -d '[:space:]')"
  [ -n "$DEP_ID" ] && echo "==> deployment id from $DIR/.deployment-id"
fi

# Redundant-run guard: re-deploying the exact same commit is harmless to the
# app but NOT free -- it mints a new deployment version and re-stamps the
# build, so every open tab shows the "new version -- refresh" notice for
# identical code. Skip when the current HEAD is CLEAN and matches this
# project's last recorded deploy from this checkout; FORCE=1 overrides. A
# dirty tree always proceeds (the stamp marks it +dirty, and the tree may
# hold the very change being shipped). `.last-deployed` is gitignored,
# per-developer, and written only after a COMPLETE deploy for the project
# type (dashboard: after the version roll -- a push-only run without an id
# does NOT record, so the finished deploy is never skipped later; siblings:
# after the push, which IS their deploy).
# DOC-14 (broad-scan 2026-09-23): a deploy from a DIRTY tree records
# "<sha>+dirty", never the bare sha -- what shipped was HEAD plus uncommitted
# edits, so a later run on that same HEAD, clean, must NOT be skipped as
# "already deployed" (it would leave the live project on code that is in no
# commit). Dirtiness is captured HERE, before the build-stamp write below
# dirties BuildStamp.gs on purpose.
LAST_FILE="$(cd "$DIR" && pwd)/.last-deployed"   # absolute: the script cd's later
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
# F41 (broad-scan 2026-10-14): "dirty" means dirty WHERE THE PUSH READS -- the
# project's clasp rootDir (`.clasp.json`, relative to its own dir; the
# dashboard's is apps-script/department-dashboard). It was repo-wide, so a
# `.cycle/STATE.md` or docs edit stamped +dirty, defeated the redundant-deploy
# guard and made STRICT_DEPLOY refuse a push that shipped only committed code.
# An unreadable .clasp.json falls back to the project dir.
# PUSH_SCOPE-BEGIN
PUSH_SCOPE="$(node -e 'const p=require("path"),f=require("fs");const[r,d]=process.argv.slice(1);let rd=".";try{rd=JSON.parse(f.readFileSync(p.join(r,d,".clasp.json"),"utf8")).rootDir||"."}catch(e){}process.stdout.write(p.relative(r,p.resolve(r,d,rd))||".")' "$ROOT_ABS" "$DIR" 2>/dev/null || true)"
[ -n "$PUSH_SCOPE" ] || PUSH_SCOPE="$DIR"
# PUSH_SCOPE-END
TREE_DIRTY=""
[ -n "$(git status --porcelain -- "$PUSH_SCOPE" 2>/dev/null)" ] && TREE_DIRTY="1"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

# DEP-3 (broad-scan 2026-10-01): say so, loudly, when this deploy ships code
# that is not on main or not in any commit. Both stay ALLOWED by default --
# a dirty deploy is a supported path (DOC-14 above records it as +dirty) and
# this repo ships from feature branches between reviews -- but they used to
# pass with no word at all. STRICT_DEPLOY=1 makes either one fatal (the
# STRICT_ORPHANS pattern). TREE_DIRTY is the ONE dirtiness definition: the
# build stamp below used `git diff` (tracked edits only) while this guard
# used `git status --porcelain` (untracked files too), so a new untracked .gs
# -- which `clasp push` DOES ship -- was "+dirty" here and clean in the stamp.
DEPLOY_WARN=""
if [ -n "$TREE_DIRTY" ]; then
  echo "warn: the working tree is DIRTY under $PUSH_SCOPE -- this deploy ships uncommitted edits (stamp: +dirty):" >&2
  git status --short -- "$PUSH_SCOPE" 2>/dev/null | head -n 10 >&2
  DEPLOY_WARN="1"
fi
if [ "$GIT_BRANCH" != "main" ]; then
  echo "warn: deploying from branch '$GIT_BRANCH', not main." >&2
  DEPLOY_WARN="1"
fi
if [ -n "$DEPLOY_WARN" ] && [ "${STRICT_DEPLOY:-}" = "1" ]; then
  echo "error: STRICT_DEPLOY=1 -- refusing a dirty or non-main deploy." >&2
  exit 1
fi
record_deploy() {
  if [ -n "$HEAD_SHA" ]; then
    local mark="$HEAD_SHA"
    [ -n "$TREE_DIRTY" ] && mark="${HEAD_SHA}+dirty"
    printf '%s' "$mark" > "$LAST_FILE" 2>/dev/null || true
  fi
}
if [ "${FORCE:-}" != "1" ] && [ -n "$HEAD_SHA" ] && [ -f "$LAST_FILE" ] \
   && [ -z "$TREE_DIRTY" ] \
   && [ "$(cat "$LAST_FILE")" = "$HEAD_SHA" ]; then
  echo "==> Already deployed: '$DIR' was last deployed from commit ${HEAD_SHA:0:9},"
  echo "    which is the current clean HEAD -- nothing new to ship."
  echo "    Re-run with FORCE=1 to deploy anyway."
  exit 0
fi

# TST-7: gate the LIVE push on the same checks CI runs (node --test + the
# INV-16 guard). The guard is only a non-blocking SessionStart hook locally,
# so without this a same-session drift could be pushed live even though the
# PR's CI would later go red. DEPLOY_SKIP_CI=1 skips (emergencies only).
#
# The gate reproduces CI, which means CI's TIMEZONE too. ci.yml pins
# TZ=America/Chicago to match the Apps Script manifest, because parts of the
# harness legitimately assume process TZ == script TZ (roadmap 1a made the
# SPREADSHEET-vs-script split the fixture default; the process-vs-script one
# is a separate assumption the suites still make by design). Without this
# pin the gate reflects the developer's locale instead: a UTC box (Cloud
# Shell, most CI images) or any zone far from Chicago fails pins for a reason
# that has nothing to do with the code being shipped, and a red gate means NO
# push happens at all (set -euo pipefail). Both commands get it -- the
# rendered-UI gate runs the same server code to build its payloads, so it
# must agree with the unit suite -- and it is scoped to them rather than
# exported, so nothing downstream picks it up by accident (the build stamp
# is `date -u` and stays UTC either way). CI_TZ overrides it.
CI_TZ="${CI_TZ:-America/Chicago}"
if [ "${DEPLOY_SKIP_CI:-}" != "1" ]; then
  echo "==> npm run ci   (tests + INV-16 guard + module-deps --check; TZ=$CI_TZ, matching ci.yml; DEPLOY_SKIP_CI=1 to skip)"
  TZ="$CI_TZ" npm run ci
  # T-5 (2026-09-18): the LIVE push runs the SAME THREE jobs ci.yml runs, and
  # a missing tool FAILS the gate instead of skipping it. lint:gas and ci:ui
  # both exit 0 when eslint / playwright are absent so they are safe to run
  # anywhere -- EXCEPT under CI=true, where absence FAILS (the F-9 rule). A
  # developer box without either tool could therefore push live through this
  # "gated" path while the PR's blocking `lint` and `ui-harness` jobs would
  # have gone red. CI=1 here makes the gate mean what CI means; the one
  # escape hatch stays DEPLOY_SKIP_CI=1 (emergencies only). Install the tools
  # with `npm ci` and `cd tools/ui-harness && npm i playwright@1.62.1`.
  echo "==> npm run lint:gas   (undeclared-identifier net, H3; eslint REQUIRED -- CI=1)"
  CI=1 TZ="$CI_TZ" npm run lint:gas
  # F-10: the rendered-UI gate -- the only automated coverage of ~20K lines
  # of script.html; both production bugs it has caught shipped through paths
  # `node --test` structurally cannot see.
  echo "==> npm run ci:ui   (rendered-UI gate, F-10; playwright REQUIRED -- CI=1)"
  CI=1 TZ="$CI_TZ" npm run ci:ui
fi

# Batch 4 (Operator State #29): `clasp push -f` never DELETES remote files
# (INV-17), so a file removed from the repo stays live and callable in the Apps
# Script project until someone deletes it by hand in the web editor. Nothing
# detected that -- PerformanceReport.gs / CompareRangesReport.gs sat orphaned
# across cycles. This reports them at deploy time, when the operator is already
# in the right context to go delete them. WARNS by default (an orphan is not a
# reason to refuse to ship an urgent fix); STRICT_ORPHANS=1 makes it fatal.
# Runs BEFORE the push so its "remote vs local" comparison isn't confused by
# the files this push is about to add.
echo "==> remote-orphan check   (STRICT_ORPHANS=1 to make it fatal)"
node "$ROOT_ABS/scripts/check-remote-orphans.mjs" "$DIR" || exit 1

# E3: stamp the DASHBOARD build before pushing. BuildStamp.gs is committed
# with a placeholder ("unstamped -- last push bypassed scripts/deploy.sh");
# this overwrites it with the real stamp for the push and the trap restores
# the placeholder afterwards -- success OR failure -- so the working tree
# never stays dirty and the stamp exists only in the pushed project. The
# Health page's 'build-stamp' row renders whatever got pushed, which makes a
# bare `clasp push -f` self-reporting: it ships the placeholder.
# F40: the INV-16 pair's content hash (8 hex) for one project dir; '' if unreadable.
inv16_hash_() {
  local d="$1" h
  if command -v sha256sum >/dev/null 2>&1; then
    h="$(cat "$d/neonWrite.js" "$d/buildDQEHistoricalData.js" 2>/dev/null | sha256sum | cut -c1-8)"
  else
    h="$(cat "$d/neonWrite.js" "$d/buildDQEHistoricalData.js" 2>/dev/null | shasum -a 256 | cut -c1-8)"
  fi
  [ -f "$d/neonWrite.js" ] && [ -f "$d/buildDQEHistoricalData.js" ] && printf '%s' "$h"
}
# G4 (broad-scan 259, E3): the content hash (8 hex) of one project's PUSHED
# code -- every .gs / .js / .html / appsscript.json in its (flat) folder,
# sorted, name + bytes, EXCLUDING its build-stamp file (rewritten per push).
# '' if the folder is missing. Every stamp carries all three projects' hashes
# as this checkout has them, so the Health page's deploy-currency row can tell
# a project whose deployed code differs from what the NEWEST deploy saw.
project_tree_hash_() {
  local d="$1"
  [ -d "$d" ] || return 0
  ( cd "$d" && find . -maxdepth 1 -type f \( -name '*.gs' -o -name '*.js' -o -name '*.html' -o -name 'appsscript.json' \) \
      ! -name 'BuildStamp.gs' ! -name 'buildStamp.js' | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s\n' "$f"; cat "$f"; done ) \
    | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -c1-8
}
# F40: deploying ONE sibling while the other's last deploy shipped a
# different copy of the INV-16 pair leaves that project's DQE build on the
# old rules. Say so before the push (the Health page's inv16-skew row shows
# it after). Only the other project's .last-deployed from THIS checkout is
# known; without one, there is nothing to compare.
case "$DIR" in
  apps-script/cdr-import|apps-script/cdr-report)
    if [ "$DIR" = "apps-script/cdr-import" ]; then OTHER_DIR="apps-script/cdr-report"; else OTHER_DIR="apps-script/cdr-import"; fi
    OTHER_LAST="$(head -n 1 "$OTHER_DIR/.last-deployed" 2>/dev/null | cut -d+ -f1)"
    if [ -n "$OTHER_LAST" ]; then
      OTHER_PAIR="$(git show "$OTHER_LAST:$OTHER_DIR/neonWrite.js" 2>/dev/null; git show "$OTHER_LAST:$OTHER_DIR/buildDQEHistoricalData.js" 2>/dev/null)"
      THIS_PAIR="$(cat "$DIR/neonWrite.js" "$DIR/buildDQEHistoricalData.js" 2>/dev/null)"
      if [ -n "$OTHER_PAIR" ] && [ "$OTHER_PAIR" != "$THIS_PAIR" ]; then
        echo "warn: $OTHER_DIR was last deployed (from this checkout) at ${OTHER_LAST:0:7} with a DIFFERENT copy of the INV-16 pair" >&2
        echo "      (neonWrite.js / buildDQEHistoricalData.js) -- deploy it too, or its DQE build keeps the old rules." >&2
      fi
    fi
    ;;
esac

# S6: the stamp now covers the SIBLING projects too -- they hold half the
# INV-16 duplicated files and a bare `clasp push -f` from their directories
# previously left no trace of having bypassed the CI gates. Per-project
# stamp file + variable name (the dashboard keeps its E3 names).
# DIR is normalized above (DEP-2), so these literals are the ONLY spellings.
case "$DIR" in
  .)                       STAMP_FILE="$ROOT_ABS/apps-script/department-dashboard/BuildStamp.gs"; STAMP_VAR="BUILD_STAMP_" ;;
  apps-script/cdr-import)  STAMP_FILE="$ROOT_ABS/apps-script/cdr-import/buildStamp.js"; STAMP_VAR="PROJECT_BUILD_STAMP_" ;;
  apps-script/cdr-report)  STAMP_FILE="$ROOT_ABS/apps-script/cdr-report/buildStamp.js"; STAMP_VAR="PROJECT_BUILD_STAMP_" ;;
  *)                       STAMP_FILE=""; STAMP_VAR="" ;;
esac
if [ -n "$STAMP_FILE" ] && [ -f "$STAMP_FILE" ]; then
  GIT_DESC="$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')"
  [ -n "$TREE_DIRTY" ] && GIT_DESC="${GIT_DESC}+dirty"   # DEP-3: the one definition
  # DEP-2 (broad-scan 2026-10-12): the stamp lands inside a single-quoted JS
  # string, so a branch name holding ' or \ would write an unparseable file
  # AFTER every gate had passed. Keep the branch to a safe character set.
  STAMP_BRANCH="$(printf '%s' "$GIT_BRANCH" | tr -c 'A-Za-z0-9._/@+-' '_')"
  STAMP="deploy.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) | git ${GIT_DESC} | ${STAMP_BRANCH}"
  # F40 (broad-scan 2026-10-14): a SIBLING stamp also names its project and a
  # short hash of the INV-16 pair it ships (its own neonWrite.js +
  # buildDQEHistoricalData.js, as pushed). Both projects log their stamp on
  # Pipeline Health, so the Health page's inv16-skew row can see the two
  # running different copies of the shared DQE rules -- which a deploy of
  # only one of them after an INV-16 edit leaves behind with no other trace.
  case "$DIR" in
    apps-script/cdr-import|apps-script/cdr-report)
      INV16_HASH="$(inv16_hash_ "$DIR")"
      [ -n "$INV16_HASH" ] && STAMP="${STAMP} | ${DIR#apps-script/} inv16 ${INV16_HASH}"
      ;;
  esac
  # G4: every project's tree hash, as THIS checkout holds it (see project_tree_hash_).
  TREES_D="$(project_tree_hash_ "$ROOT_ABS/apps-script/department-dashboard")"
  TREES_I="$(project_tree_hash_ "$ROOT_ABS/apps-script/cdr-import")"
  TREES_R="$(project_tree_hash_ "$ROOT_ABS/apps-script/cdr-report")"
  if [ -n "$TREES_D" ] && [ -n "$TREES_I" ] && [ -n "$TREES_R" ]; then
    STAMP="${STAMP} | trees d=${TREES_D} i=${TREES_I} r=${TREES_R}"
  fi
  # Restore the file no matter how this script exits. DEP-2: from a COPY taken
  # just before the write, not `git checkout` -- that dropped an uncommitted
  # edit to the stamp file and could not restore an untracked one. If even the
  # copy fails, say where it is instead of staying silently stamped.
  STAMP_BAK="$(mktemp)"
  cp -p "$STAMP_FILE" "$STAMP_BAK"
  trap 'if cp -f "$STAMP_BAK" "$STAMP_FILE" 2>/dev/null; then rm -f "$STAMP_BAK"; else echo "warn: could not restore the build-stamp file (its pre-deploy copy is at $STAMP_BAK) -- check git status" >&2; fi' EXIT
  {
    echo "// Written by scripts/deploy.sh for THIS push only -- the committed file"
    echo "// holds a placeholder; see its header. Do not commit a real stamp."
    echo "var ${STAMP_VAR} = '${STAMP}';"
  } > "$STAMP_FILE"
  echo "==> build stamp: ${STAMP}"
fi

cd "$DIR"
echo "==> clasp push -f   ($DIR)"
clasp push -f

if [ -n "$DEP_ID" ]; then
  DESC="deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==> clasp deploy -i $DEP_ID -d \"$DESC\""
  clasp deploy -i "$DEP_ID" -d "$DESC"
  record_deploy
  echo "==> Done. Deployment $DEP_ID now serves the pushed code."
else
  case "$DIR" in
    apps-script/cdr-import|apps-script/cdr-report)
      # The sibling projects are NOT web apps: their triggers and menus always
      # execute the pushed code, so there is no deployment version to roll and
      # the old "finish in the editor" hint sent operators hunting for a step
      # that doesn't exist.
      record_deploy
      echo "==> Pushed. Done -- this project is not a web app (triggers/menus"
      echo "    run the pushed code directly), so no version bump is needed."
      ;;
    *)
      echo "==> Pushed. No deployment id given -- finish in the editor:"
      echo "    Deploy -> Manage deployments -> New version -> Deploy,"
      echo "    or re-run with the id from 'clasp deployments' to automate it."
      ;;
  esac
fi
