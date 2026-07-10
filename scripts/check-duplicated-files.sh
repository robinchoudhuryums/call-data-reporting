#!/usr/bin/env bash
# INV-16 drift guard.
#
# Two Apps Script files are duplicated across the cdr-report and
# cdr-import projects and MUST stay byte-identical (Apps Script has no
# cross-project sharing). A one-sided edit silently diverges the two
# pipelines. This script diffs both pairs and exits non-zero on drift.
#
# Also guards the FUNCTION-level duplication of
# sanitizeAbandonedCellForNeon_ (cdr-report/neonbackfill.js vs
# cdr-import/NeonMirror.js) -- the same INV-16 discipline at function
# granularity (F-24; previously only kept in sync by hand).
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
  # F-56: a MISSING file in a pair that must exist in both projects is a
  # failure, not a skip -- an accidental delete/rename must not pass CI.
  if [ ! -f "$a" ] || [ ! -f "$b" ]; then
    echo "⚠️  INV-16 FAILURE: missing file ('$a' or '$b') — both copies must exist."
    status=1
    return
  fi
  if ! diff -q "$a" "$b" >/dev/null 2>&1; then
    echo "⚠️  INV-16 DRIFT: '$a' and '$b' differ — they must stay byte-identical."
    echo "    Reconcile both copies before editing either. Inspect with:"
    echo "      diff $a $b"
    status=1
  fi
}

# Extract one top-level function body (from its `function name(` line to the
# first column-0 `}`) so a function-level duplicate can be diffed.
extract_fn() {
  local file="$1" name="$2"
  awk -v fn="$name" '
    index($0, "function " fn "(") == 1 { f = 1 }
    f { print }
    f && /^}/ { exit }
  ' "$file"
}

check_fn_pair() {
  local a="$1" b="$2" name="$3"
  if [ ! -f "$a" ] || [ ! -f "$b" ]; then
    echo "⚠️  INV-16 FAILURE: missing file ('$a' or '$b') for the $name check."
    status=1
    return
  fi
  local fa fb
  fa="$(extract_fn "$a" "$name")"
  fb="$(extract_fn "$b" "$name")"
  if [ -z "$fa" ] || [ -z "$fb" ]; then
    echo "⚠️  INV-16 FAILURE: could not extract function $name from '$a' or '$b'"
    echo "    (renamed or re-indented? update scripts/check-duplicated-files.sh)."
    status=1
    return
  fi
  if [ "$fa" != "$fb" ]; then
    echo "⚠️  INV-16 DRIFT: $name differs between '$a' and '$b' — the two copies"
    echo "    must stay identical (F-24). Reconcile before editing either."
    status=1
  fi
}

check_pair apps-script/cdr-report/neonWrite.js            apps-script/cdr-import/neonWrite.js
check_pair apps-script/cdr-report/buildDQEHistoricalData.js apps-script/cdr-import/buildDQEHistoricalData.js
check_fn_pair apps-script/cdr-report/neonbackfill.js apps-script/cdr-import/NeonMirror.js sanitizeAbandonedCellForNeon_
check_fn_pair apps-script/cdr-report/neonbackfill.js apps-script/cdr-import/NeonMirror.js sanitizeSlotCellForNeon_

if [ "$status" -eq 0 ]; then
  echo "INV-16 check: duplicated files (neonWrite.js, buildDQEHistoricalData.js) and the sanitize*ForNeon_ function copies are in sync."
fi

exit "$status"
