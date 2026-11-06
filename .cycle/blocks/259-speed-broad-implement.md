---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (owner request 2026-11-06, not a scan finding)
New capabilities (G/ST): SPEED-1 parallel rendered-UI drivers; SPEED-2 drive-smoke role shards; SPEED-3 ci:ui skipped for sibling deploys; SPEED-4 once-per-commit gate marker
Files modified: tools/ui-harness/ci.mjs, tools/ui-harness/drive-smoke.js, scripts/deploy.sh, .gitignore, tests/unit/deploy-tooling.test.js, tests/unit/cross-file-pins.test.js, README.md, CLAUDE.md, tools/ui-harness/README.md, tests/README.md, docs/fix-history.md

CHANGES:
SPEED-1 | tools/ui-harness/ci.mjs | SETUP (gen + 3 site builds) runs first in order; the asserting drivers run UI_HARNESS_JOBS at a time (default 4, 1 = serial), output buffered per driver, every driver runs to the end, every failure named, non-zero exit on any
SPEED-2 | tools/ui-harness/drive-smoke.js, ci.mjs | optional role argument (unknown role exits 2, none = both); the gate runs admin + manager shards
SPEED-3 | scripts/deploy.sh | cdr-import / cdr-report deploys skip ci:ui (the harness loads only dashboard code -- pinned)
SPEED-4 | scripts/deploy.sh, .gitignore | a passed gate recorded in gitignored .last-gated as sha + gate + CI_TZ + node/eslint/playwright versions; skipped only at that same clean commit (porcelain incl. untracked); dirt, a new commit, other zone/tools or REGATE=1 re-runs; recorded only after the gate passes
tests | deploy-tooling.test.js, cross-file-pins.test.js | 5 new tests (SPEED-1/2 shape + every drive-*.js listed; SPEED-2 role arg; SPEED-3 harness-only-dashboard + the case arm; SPEED-4 behavioural marker in a scratch git repo + record-after-run order); the F1 driver parse now allows driver arguments

TEST RESULTS: node --test 2836 pass 0 fail; lint:gas, module-deps --check, INV-16 guard clean; ci:ui 18/18 driver runs PASS in 240 s wall (was 877 s serial); bites 5/5 (clean check removed, record before lint, manager shard dropped, harness loads cdr-import, sibling skip widened to the dashboard)
REGRESSION RISKS: concurrent drivers on a slower / 2-core box could time out (a false red, never a false green) -- UI_HARNESS_JOBS=1 restores serial; the gate marker trusts that a gate's outcome depends only on tracked files + the keyed zone/tool versions
INVARIANTS AT RISK: None (no app code changed)
NET SCORE: 0 production fixes − 1 new failure mode (contention flake, documented knob) = -1

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: N/A -- tooling only; no Apps Script project changes (the next scripts/deploy.sh run uses it)

FOLLOW-ON ITEMS:
- The drivers' fixed waitForTimeout pauses (~hundreds of seconds) are where the remaining time is; replacing them with condition waits would cut further but rewrites how 17 drivers check the page -- deliberately not done.
- CI's ui-harness job also runs the parallel ci.mjs; its install step (~1-2 min) is unchanged.

DOCUMENTATION UPDATES NEEDED:
- None (README deploy section, CLAUDE.md key commands, ui-harness README, tests/README, fix-history updated)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
