---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Batch 3 (testing note #5) | After-hours capture: two ADDITIVE DQE columns, AJ `After-Hrs Answered` (36) + AK `After-Hrs TTT (sec)` (37), over the 3:00-3:30 PM PST half hour after the work window (`startPST ∈ [DQE_WINDOW_END, DQE_AFTER_HOURS_END)`), computed with the same INV-08 own-talk rule as TTT; mirrored to `dqe_history.after_hours_answered` / `after_hours_ttt` (nullable ints, idempotent ADD COLUMN, COALESCE upserts, NULLIF-cast binds); cols A-AI byte-identical; capture only, no display surface

Files modified:
- apps-script/cdr-report/buildDQEHistoricalData.js + apps-script/cdr-import/buildDQEHistoricalData.js (INV-16 pair)
- apps-script/cdr-report/neonWrite.js + apps-script/cdr-import/neonWrite.js (INV-16 pair)
- apps-script/cdr-report/neonbackfill.js, apps-script/cdr-report/sheetRepairs.js, apps-script/cdr-import/NeonMirror.js
- apps-script/department-dashboard/Config.gs (constants only)
- tests/unit/pipeline-build.test.js, neon-write-mapping.test.js, neon-backfill-resume.test.js, queue-split.test.js, sheet-repairs-merge.test.js, cross-file-pins.test.js
- CLAUDE.md (new AJ/AK bullet; Operator State index #60), docs/invariants.md (INV-06, INV-10), docs/operator-state.md (#60), docs/conventions.md (after-hours window), docs/next-steps.md (Batch 3 SHIPPED)

CHANGES:
Batch 3 | buildDQEHistoricalData.js (both copies) | `DQE_AFTER_HOURS_END = (15*60+30)*60`; `afterHoursLegs` (half-open, disjoint from `windowLegs`); the per-parent own-talk loop became `talkForLegs(legList)` and runs over both windows (returns `{tttSec, talkTimes, perParent}`; `agentTalkPerParent = talk.perParent` stays bound for the queue-split call); agent rows append `afterHoursAnswered, afterHoursTttSec`, sentinel rows `0, 0`; `DQE_WRITE_WIDTH` 35 -> 37 (widen-before-write, REP-10); headers `After-Hrs Answered` / `After-Hrs TTT (sec)` written once, only while AJ's header is blank; daily mirror payload + `remirrorExistingDqeDate_` (read ceiling 37; blank -> null) carry the pair
Batch 3 | neonWrite.js (both copies) | HEAD column list + `after_hours_answered, after_hours_ttt`; TAIL COALESCEs both; bound placeholder row `35 × ? + NULLIF(?, '')::int × 2`; `neonSqlIntOrNull_` / `neonBindIntOrNull_` (NULL for null/''/undefined, parseInt otherwise); inline tuples + bound fallback bind them; `DQE_AFTER_HOURS_COLUMNS_READY_` memoized `ALTER TABLE dqe_history ADD COLUMN IF NOT EXISTS after_hours_answered integer` / `after_hours_ttt integer`
Batch 3 | neonbackfill.js | both row-batched DQE reads clamp to `Math.min(37, getMaxColumns())`; mappings, column lists, NULLIF placeholders, COALESCE, `neonBindIntOrNull_` binds in `backfillDQEHistory` + `backfillDQEHistoryUpsert`
Batch 3 | NeonMirror.js | deferred DQE read ceiling 37; payload mapping carries the pair
Batch 3 | sheetRepairs.js | `mergeDqeDuplicateRows_` clears AI..AK together (`Math.min(37, getMaxColumns()) - 34` cells) -- blank = never captured; summing would double a double-append
Batch 3 | Config.gs | `HISTORICAL_COLS.AFTER_HOURS_ANSWERED: 36`, `AFTER_HOURS_TTT_SEC: 37`; `DASHBOARD_AFTER_HOURS_WINDOW` (pst/cst display mirror)
Batch 3 | tests | pipeline-build: 6-test Batch 3 block (answered leg -> AJ=1/AK=240 with F/H/I/J/E untouched; 15:30 boundary in neither window; missed after-hours leg counts nowhere; 0/0 not blanks; widen-to-37 + headers once + custom header kept; mirror payload) + sentinel 0/0 + remirror 35-wide -> null / 37-wide -> values; neon-write-mapping: 37-tuple, DDL, COALESCE, parity incl. bare-row NULL, memo reset; neon-backfill-resume: binds/37 + a 37-wide bind test (2/500, 0/0, NULL); queue-split: A..AH pin extended with AJ/AK=0 + widen 37; sheet-repairs-merge: AI..AK cleared, non-duplicate kept; cross-file-pins: DQE_COLS derived from `AFTER_HOURS_TTT_SEC`, after-hours window pin (+1800 s, display mirror parses), R8-D1 merge-clear regex, NEW "every full-width DQE reader clamps to the schema width" (neonbackfill ×2, remirror both copies, DQE_WRITE_WIDTH)

TEST RESULTS: passed -- `node --test` 1327/1327 (1324 + 3 new suites' worth of tests: +9 tests net); INV-16 guard in sync. Mutations 17/17 killed: boundary `<=`; AJ counts all legs; header write dropped; DQE_WRITE_WIDTH 35; COALESCE dropped; DDL dropped; NeonMirror ceiling 35; sentinel blanks; mirror payload omits AJ; remirror ceiling 35; DQE_AFTER_HOURS_END 15:45; dashboard display mirror drifts; bound insert skips AK; inline NULL rendered as 0; merge clear dropped; neonbackfill upsert ceiling 35; plus the real one found on the way in (the queue-split call reading an unbound `agentTalkPerParent` inside its try/catch -> blank AI; queue-split.test.js failed 4 tests, fixed). `npm run ci:ui` NOT run: no client file changed (Config.gs carries constants only). Regression Scenarios overlapping modified files: S5 (daily DQE aggregation) / S7 (pipeline numbers match dashboard) / S34 (integrated build) -- NOT APPLICABLE here: live-pipeline walks after the cdr-report + cdr-import push; Operator State #60 is the post-deploy verification.

REGRESSION RISKS:
- The first post-deploy build widens the live sheet 35 -> 37 and writes two header cells (row 1, AJ/AK). A sheet whose AJ header an operator already filled is left alone. A build running on a project WITHOUT the push (only one of the INV-16 pair deployed) writes 35-wide rows with the pair blank -> NULL in Neon, which the next captured build heals per date only if re-imported (#60).
- Every full-width DQE reader that was `Math.min(35, …)` is now 37; a reader missed by the pin would mirror NULL silently -- the new R8-D1 (Batch 3) pin enumerates neonbackfill ×2 + remirror ×2 + the writer; NeonMirror is under the existing R8-D1 pin.
- `mergeDqeDuplicateRows_` now clears AJ/AK on a merged row (was: first row's values survived silently). A merged captured date must be re-imported inside the window to re-capture (#60).
- The `talkForLegs` refactor is behaviour-preserving for TTT/ATT (INV-07/08 pins + the frozen-literal A..AH pin are green) and the per-parent map still feeds the split.
- neonbackfill's bound placeholders changed shape (35 `?` + 2 NULLIF casts): the resume suite's row counting was a test double encoding the old count (35) and was updated; no production consumer parses the placeholder row.

INVARIANTS AT RISK: INV-06 (a fourth pipeline constant + its display mirror -- entry updated, pinned); INV-10 (two appended columns -- entry updated, pinned); INV-16 (both pairs byte-identical, guard clean); INV-07/INV-08 (the after-hours window is disjoint and the own-talk rule is shared -- pinned by the Batch 3 block + the existing INV-07/08 tests); INV-02 (AK is integer seconds, deliberately not a duration cell); INV-30 (no dashboard reader changed -- no cache bump needed); INV-23 (sentinel rows write 0/0 -- pinned). None violated.
NET SCORE: 1 (the capture window closes daily; every day before deploy is a day AJ/AK can never be filled) − 0 = 1

OPERATOR ACTIONS / DEPLOY:
- Push cdr-report AND cdr-import (INV-16 pair) the same day; verify the 37-wide sheet + headers, numeric AJ/AK on the next build, and the Neon columns (Operator State #60 a-c) | BLOCKS DEPLOY: N (verification after)
- ONE-TIME backfill: Manual Export (force re-import, #56) per date whose `Call_Legs_*` tab still exists -- the ~14-day prune (#43) is the horizon; dates outside it stay NULL forever | BLOCKS DEPLOY: N (but time-boxed: do it the week of the deploy)
- Dashboard push is optional for this batch (constants only; no surface reads the pair) -- it rides with the next dashboard deploy | BLOCKS DEPLOY: N
Deploy: CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-report`); CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`); Department Dashboard (constants only, optional now): `clasp push -f` from repo root + new version.

FOLLOW-ON ITEMS:
- Display surface for the pair (a later testing note): a My Department / IR column or tile reading `HISTORICAL_COLS.AFTER_HOURS_*`, which must honour NULL-vs-0 and join the INV-30 cache versioning; the Neon DAL (`neonFetchDqeRows_`) does not select the pair yet -- add it in the same commit as the first reader (the B-2 rule).
- `DQEdrilldown.js` (the fourth hand-mirror) has no after-hours arm; if the drill is ever asked to explain AJ/AK it needs its own copy of `DQE_AFTER_HOURS_END` under the INV-06 pin.
- The queue-split JSON (AI) stays work-window only by design; a per-queue after-hours split was not asked for.

DOCUMENTATION UPDATES NEEDED:
- None outstanding -- CLAUDE.md bullet + index #60, INV-06 / INV-10, Operator State #60, conventions.md, next-steps.md all updated in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
