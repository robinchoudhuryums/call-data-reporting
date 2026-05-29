#!/usr/bin/env bash
# INV-16 drift guard.
#
# Two Apps Script files are duplicated across the cdr-report and
# cdr-import projects and MUST stay byte-identical (Apps Script has no
# cross-project sharing). A one-sided edit silently diverges the two
# pipelines. This script diffs both pairs and exits non-zero on drift.
#
# Usage:
#   bash scripts/check-duplicated-files.sh
# Wired as a non-blocking SessionStart hook in .claude/settings.json so
# drift surfaces at the start of every Claude Code session; also usable
# in CI or a pre-commit hook.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 0

status=0

check_pair() {
  local a="$1" b="$2"
  if [ ! -f "$a" ] || [ ! -f "$b" ]; then
    echo "INV-16 check: missing file ($a or $b) — skipping."
    return 0
  fi
  if ! diff -q "$a" "$b" >/dev/null 2>&1; then
    echo "⚠️  INV-16 DRIFT: '$a' and '$b' differ — they must stay byte-identical."
    echo "    Reconcile both copies before editing either. Inspect with:"
    echo "      diff $a $b"
    status=1
  fi
}

check_pair apps-script/cdr-report/neonWrite.js            apps-script/cdr-import/neonWrite.js
check_pair apps-script/cdr-report/buildDQEHistoricalData.js apps-script/cdr-import/buildDQEHistoricalData.js

if [ "$status" -eq 0 ]; then
  echo "INV-16 check: duplicated files (neonWrite.js, buildDQEHistoricalData.js) are in sync."
fi

exit "$status"
