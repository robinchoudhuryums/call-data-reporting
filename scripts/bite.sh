#!/usr/bin/env bash
# ── bite.sh — mutate a file, run the harness, restore the file ────────────────
#
# A "bite-check" (ported from team-tools, where it has caught pins that never
# bit): break the thing a pin is supposed to catch and confirm the pin goes
# red. This repo has ~1,000 lines of regex pins in cross-file-pins.test.js and
# its siblings, and a pin that has never been shown to bite is a pin that has
# never been shown to work.
#
#   scripts/bite.sh "<label>" <file> "<python mutation on the string s>" "<test-name substring>"
#
# e.g.  scripts/bite.sh "dup-name pin" apps-script/department-dashboard/Util.gs \
#         "s += '\nfunction assertAdmin_() {}\n'" "declared in two files"
#
# It ends in `git checkout -- <file>`, which is why the FIRST thing it does is
# refuse a file with uncommitted changes: that restore reverts the file to HEAD
# and takes any unsaved work in it with you (team-tools paid for that lesson
# four times before the guard).
set -uo pipefail

if [ $# -lt 4 ]; then
  echo "usage: scripts/bite.sh <label> <file> <python-mutation-on-s> <test-name-substring>" >&2
  exit 2
fi
label="$1"; file="$2"; mutation="$3"; needle="$4"
cd "$(git rev-parse --show-toplevel)" || exit 2

[ -f "$file" ] || { echo "  NO SUCH FILE: $file" >&2; exit 2; }

# bash reads a script INCREMENTALLY, so mutating this file while it runs makes
# the shell resume mid-token and die -- the restore never happens.
case "$file" in
  */bite.sh|bite.sh)
    echo "  REFUSING: bite.sh cannot bite itself (bash reads it as it runs)." >&2
    exit 2 ;;
esac

# The guard: `git status --porcelain <file>` prints nothing for a clean,
# tracked file -- anything at all means the restore below would destroy work.
if [ -n "$(git status --porcelain -- "$file")" ]; then
  echo "  REFUSING: $file has uncommitted changes -- bite-checks end in \`git checkout -- $file\`," >&2
  echo "            which would discard them. Commit first, then bite." >&2
  exit 2
fi

# The mutation is embedded in a double-quoted `python3 -c "..."`, so a double
# quote INSIDE it closes that string early and hands python a mangled program
# that often still edits the file -- a bite-check that proved nothing.
case "$mutation" in
  *'"'*)
    echo "  REFUSING: the mutation contains a double quote. Use single quotes (or chr(34))." >&2
    exit 2 ;;
esac

python3 -c "
import io, sys
p = '$file'
s = io.open(p, encoding='utf-8').read()
before = s
$mutation
if s == before:
    sys.exit('the mutation changed nothing -- it cannot prove anything (wrong target?)')
io.open(p, 'w', encoding='utf-8').write(s)
" || { echo "  MUTATION FAILED: $label" >&2; exit 1; }

# node --test's TAP output: a failing test prints `not ok N - <name>`. Captured
# to a variable and grepped via HERESTRING -- never `cmd | grep -q`, which under
# pipefail can report a bite as NO BITE when the output outgrows the pipe buffer
# (grep exits on first match, the writer dies of SIGPIPE, the pipeline says 141).
out="$(TZ=America/Chicago node --test 2>&1)"
if grep -q "not ok.*$needle" <<<"$out"; then
  echo "  BITES: $label"
  rc=0
else
  echo "  NO BITE: $label"
  grep -E "^# (pass|fail)" <<<"$out"
  rc=1
fi
git checkout -- "$file"
exit $rc
