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
#                    @HEAD one). Omit to only `clasp push -f` and finish the
#                    version bump manually in the editor. The two SIBLING
#                    projects are not web apps (their triggers + menus always
#                    run the pushed code), so for them the push IS the deploy
#                    and no id exists to pass.
#
# Notes:
#   - Each project keeps its own gitignored .clasp.json, so run this from the
#     repo root and pass the dir (it cd's in for you).
#   - Requires the clasp CLI, logged in (`clasp login`).
set -euo pipefail

DIR="${1:?usage: scripts/deploy.sh <project-dir> [deployment-id]}"
DEP_ID="${2:-}"

if ! command -v clasp >/dev/null 2>&1; then
  echo "error: clasp not found. Install with: npm install -g @google/clasp" >&2
  exit 1
fi
if [ ! -f "$DIR/.clasp.json" ]; then
  echo "error: no .clasp.json in '$DIR' (gitignored, per-developer). See README." >&2
  exit 1
fi

# TST-7: gate the LIVE push on the same checks CI runs (node --test + the
# INV-16 guard). The guard is only a non-blocking SessionStart hook locally,
# so without this a same-session drift could be pushed live even though the
# PR's CI would later go red. DEPLOY_SKIP_CI=1 skips (emergencies only).
if [ "${DEPLOY_SKIP_CI:-}" != "1" ]; then
  echo "==> npm run ci   (tests + INV-16 guard; DEPLOY_SKIP_CI=1 to skip)"
  npm run ci
  # F-10: ALSO run the rendered-UI gate -- the only automated coverage of
  # ~20K lines of script.html, and both production bugs it has caught shipped
  # through paths `node --test` structurally cannot see. ci.mjs skips cleanly
  # (exit 0, with a message) when playwright isn't installed, so this is safe
  # on any machine; a machine WITH playwright gets the full gate before the
  # code goes live. Same DEPLOY_SKIP_CI escape hatch.
  echo "==> npm run ci:ui   (rendered-UI gate; skips if playwright absent)"
  npm run ci:ui
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
node "$(dirname "$0")/check-remote-orphans.mjs" "$DIR" || exit 1

# E3: stamp the DASHBOARD build before pushing. BuildStamp.gs is committed
# with a placeholder ("unstamped -- last push bypassed scripts/deploy.sh");
# this overwrites it with the real stamp for the push and the trap restores
# the placeholder afterwards -- success OR failure -- so the working tree
# never stays dirty and the stamp exists only in the pushed project. The
# Health page's 'build-stamp' row renders whatever got pushed, which makes a
# bare `clasp push -f` self-reporting: it ships the placeholder.
# S6: the stamp now covers the SIBLING projects too -- they hold half the
# INV-16 duplicated files and a bare `clasp push -f` from their directories
# previously left no trace of having bypassed the CI gates. Per-project
# stamp file + variable name (the dashboard keeps its E3 names).
ROOT_ABS="$(cd "$(dirname "$0")/.." && pwd)"
case "$DIR" in
  .)                       STAMP_FILE="$ROOT_ABS/apps-script/department-dashboard/BuildStamp.gs"; STAMP_VAR="BUILD_STAMP_" ;;
  apps-script/cdr-import|apps-script/cdr-import/)  STAMP_FILE="$ROOT_ABS/apps-script/cdr-import/buildStamp.js"; STAMP_VAR="PROJECT_BUILD_STAMP_" ;;
  apps-script/cdr-report|apps-script/cdr-report/)  STAMP_FILE="$ROOT_ABS/apps-script/cdr-report/buildStamp.js"; STAMP_VAR="PROJECT_BUILD_STAMP_" ;;
  *)                       STAMP_FILE=""; STAMP_VAR="" ;;
esac
if [ -n "$STAMP_FILE" ] && [ -f "$STAMP_FILE" ]; then
  GIT_DESC="$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')"
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    GIT_DESC="${GIT_DESC}+dirty"
  fi
  GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  STAMP="deploy.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) | git ${GIT_DESC} | ${GIT_BRANCH}"
  # Restore the committed placeholder no matter how this script exits. The
  # restore can only no-op if the file is somehow UNTRACKED (caught in the
  # simulation that validated this block) -- say so instead of staying
  # silently stamped, since a stamped working tree is exactly the churn this
  # design exists to avoid.
  trap 'git checkout --quiet -- "$STAMP_FILE" 2>/dev/null         || echo "warn: could not restore build-stamp placeholder -- check git status" >&2' EXIT
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
  echo "==> Done. Deployment $DEP_ID now serves the pushed code."
else
  case "$DIR" in
    apps-script/cdr-import|apps-script/cdr-import/|apps-script/cdr-report|apps-script/cdr-report/)
      # The sibling projects are NOT web apps: their triggers and menus always
      # execute the pushed code, so there is no deployment version to roll and
      # the old "finish in the editor" hint sent operators hunting for a step
      # that doesn't exist.
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
