---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: DCA-1 (owner 2026-10-27) -- the Direct Call Report credited a direct call to whoever the roster lists on that EXTENSION, never checking the name; former employees stay on DO NOT EDIT! with their old extension (owner-confirmed), so a reassigned extension credited the new person's calls to the one who left. Step 0: read-only `diagnoseDirectCallAttribution(date|'all')`. Step 1: credit by extension AND the leg's own name; somebody else -> no one; blank / non-person name -> extension rule unchanged (owner decides after step 0).
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/directCallMetrics.js, tests/unit/direct-call-metrics.test.js, tests/README.md, CLAUDE.md, docs/operator-state.md, docs/per-call-capture.md, docs/fix-history.md, docs/regression-scenarios.md

CHANGES:
DCA-1 step 1 | directCallMetrics.js | `dcBuildExtMaps_` also returns `extCands` (EVERY roster cell per extension, first and later extensions) and `canon` (`dcRosterCanonicalizer_`: the DQE `canonicalizeAgentNameWith_` over `loadRosterCanonicalNames_`, identity when unavailable); `extToAgent` is unchanged. New PURE `dcPersonName_` (blank / N/A / queue / voicemail / recording / anything with a digit -> '') and `dcResolveAgent_(ext, legName, maps)` -> match / otherCell / blank / mismatch / none. `computeDirectCallMetrics` resolves the caller from CALLER_NAME and the callee from CALLEE_NAME at the one place both agents were looked up, so the inbound / outbound buckets AND the busy intervals follow the person; `opts.extOnly` is the pre-DCA-1 rule for the diagnostic; `meta.attribution` tallies one entry per leg side (counts, mismatches and moves with extension / roster name / 8x8 name / count / sample call ids, blank legs per extension). `buildDirectCallFromRaw_` logs when legs were credited to no one or moved.
DCA-1 step 0 | directCallMetrics.js | `diagnoseDirectCallAttribution(dateIso)` over the held Call_Legs_* tabs (blank = latest, 'all' = every date), PURE fold `dcAttributionAcrossDays_` (the build's day rule per tab, the build run twice -- now and extOnly -- and folded: per-date and total counts, mismatches, moves, extensions on more than one roster cell, blank-name legs on contested extensions, Direct report rows that change) and `dcLogAttribution_` (whole numbers, number-shaped text masked). Writes nothing.
DCA-1 | direct-call-metrics.test.js, tests/README.md | +9 tests (53 in the suite): no one credited for a reassigned extension (inbound + outbound), the roster cell that names the new owner, blank / N/A / voicemail / number names unchanged, nickname variant via canon, busy follows the person, extOnly = old rule, extCands from the roster, the diagnostic's fold, the log format.
DCA-1 | operator-state.md #83, CLAUDE.md, per-call-capture.md, fix-history.md, regression-scenarios.md S67 | The rule, the pending blank-name decision, not retroactive + the rebuild path, the diagnostic and how to read it (a CURRENT employee under "somebody else" = a missing alias: Outlier Fix, then rebuild).

TEST RESULTS: `node --test` 2689 pass / 0 fail (TZ=America/Chicago); lint:gas clean (78 files); INV-16 guard clean; module-deps --check up to date. ci:ui not run (no dashboard / client file changed; CI runs it). Bite-checks 8/8 bite: mismatch credits no one, other roster cell, blank keeps the extension rule, canonicalizer used, busy follows the person, extCands lists every cell, the diagnostic's contested-blank list, its day filter.
REGRESSION RISKS: (1) A CURRENT agent whose 8x8 display name does not canonicalize to their roster name (an orphan spelling with no alias override) now has those direct legs credited to no one instead of to them -- the diagnostic lists them under "somebody else"; the fix is an Outlier Fix alias + rebuild. (2) A system label on the agent's side that dcPersonName_ does not recognise (a word not in DC_NON_PERSON_RE_) is treated as a person and drops the leg -- the diagnostic shows each such name. (3) Busy time now follows the named person, so a missed ring on a shared extension may move from missed_busy to missed_free (correct, but a visible change). (4) Not retroactive: stored dates keep the old attribution until rebuilt. (5) The build opens the roster workbook's canonical names once more per run (one extra sheet read).
INVARIANTS AT RISK: INV-03 (roster cell format read, not changed), INV-04 / INV-24 (names compared through the existing canonicalizer, no new normalization), INV-16 (directCallMetrics.js is not a duplicated file -- guard clean). None violated.
NET SCORE: 1 production fix (owner saw former employees credited this month) − 1 new failure mode (an unaliased spelling variant now drops a current agent's direct legs) = 0

OPERATOR ACTIONS / DEPLOY:
- After the push: run `diagnoseDirectCallAttribution('all')` in the cdr-import editor and send the log -- it decides the blank-name rule | BLOCKS DEPLOY: N
- Add an Outlier Fix alias for any CURRENT employee the diagnostic lists under "somebody else" | BLOCKS DEPLOY: N
- Rebuild the held dates (re-import or `runDirectCallBuild`) and re-import older dates of the window being read (Operator State #56) | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The blank-name rule (owner decision after step 0's numbers).
- Step 2: the CDR Historical per-agent build (`calculateMetricsInMemory`, autoImport.js) has the same extension-only lookup -- out of scope this round.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
