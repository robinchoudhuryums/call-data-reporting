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
#   [deployment-id]  the web-app deployment to roll forward. Find it once
#                    with `clasp deployments` run in that dir, and use the
#                    versioned web-app deployment's id (NOT the @HEAD one).
#                    Omit to only `clasp push -f` and finish the version
#                    bump manually in the editor.
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

cd "$DIR"
echo "==> clasp push -f   ($DIR)"
clasp push -f

if [ -n "$DEP_ID" ]; then
  DESC="deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==> clasp deploy -i $DEP_ID -d \"$DESC\""
  clasp deploy -i "$DEP_ID" -d "$DESC"
  echo "==> Done. Deployment $DEP_ID now serves the pushed code."
else
  echo "==> Pushed. No deployment id given -- finish in the editor:"
  echo "    Deploy -> Manage deployments -> New version -> Deploy,"
  echo "    or re-run with the id from 'clasp deployments' to automate it."
fi
