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
  echo "==> Pushed. No deployment id given -- finish in the editor:"
  echo "    Deploy -> Manage deployments -> New version -> Deploy,"
  echo "    or re-run with the id from 'clasp deployments' to automate it."
fi
