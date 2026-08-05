---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
Batch 3 (harness teeth): F-5 (fakeSheet couldn't enforce REP-10), F-6 (the plain-text coercion protections had zero test enforcement), F-7 partial (Code.gs `userJson` escape unpinned; Setup.gs/INV-12 untested) + the Batch-2 follow-on guard-header note.
Batch 4 (client correctness): G-2 (strandable "Capturing…" export button), G-3 (hardcoded 95% goal line), G-4 (YTD revert clobbered newer range picks), G-5 (refetch painted the wrong dept's grouping), G-6 (digest install blanked the subscriber table), G-7 (roster failure had no retry), G-8 (silent popup-blocked print), E-3 (TSV writer bypassed csvSafeCell_ + silent clipboard failure), E-1 (hardcoded hex in the refresh-warn badge).

Files modified:
- tests/harness/fakeSheet.js (F-5 column-bounds throw; F-6 recording setNumberFormat; cosmetic no-ops for Setup.gs)
- tests/unit/pipeline-build.test.js (F-6 coverage pin), tests/unit/setup.test.js (NEW — 4 INV-12 pins), tests/unit/cross-file-pins.test.js (F-7 generic tmpl.*Json escape pin), tests/unit/cache-version-sync.test.js (header note)
- apps-script/department-dashboard/script.html (all nine Batch-4 fixes)

CHANGES:
F-5 | fakeSheet.js | getRange throws past getMaxColumns (columns only — rows effectively auto-grow in the paths under test and the documented incident class is columns). Zero fixture fallout; mutation-verified: deleting the build's widen now fails 7 tests (was 0).
F-6 | fakeSheet.js, pipeline-build.test.js | setNumberFormat records {range, format} onto sheet._numberFormats; the new pin asserts '@' coverage of cols 4/11-29/30-32/35 for the whole-column pass AND the exact write range (the spill-past-maxRows recurrence vector). Mutation-verified.
F-7 | setup.test.js, cross-file-pins.test.js, fakeSheet.js | INV-12 enforced (admin gate / ten sheets / idempotent no-overwrite / partial-run heal); the tmpl.*Json pin is GENERIC — a future unescaped injection fails without a list update. Mutation-verified.
G-2 | script.html | irBuildCanvas/insBuildCanvas_ guard html2canvas absence + catch sync throws; both copy paths guard null toBlob and ClipboardItem throws; every path restores the button.
G-3 | script.html | Goal line = answerTarget_('global') (falls back to 92 if the helper is absent).
G-4 | script.html | revertTo90_ only reverts/persists when the user is still on YTD.
G-5 | script.html | both refetch success handlers bail on a dept mismatch (the seq token can't catch a switch that scheduled no fetch).
G-6 | script.html | interim renders merge the stashed init (rows/lastResults kept, trigger status updated); refresh failure surfaces via alSetRunStatus_.
G-7 | script.html | inline Retry buttons (ir-roster-retry / ins-roster-retry) on the loader error.
G-8 | script.html | popup-blocked print shows an error toast.
E-3 | script.html | TSV cells through csvSafeCell_; clipboard rejection + missing-API both surfaced via toast.
E-1 | script.html | refresh-warn badge styled with var(--muted)/var(--paper-card)/var(--line)/var(--r).

TEST RESULTS: passed — node --test 628/628 (was 622; +6: 4 setup pins, F-6 pin, F-7 pin), INV-16 clean, full ci:ui gate green (all stages — the Batch-4 script.html changes ride under drive-smoke/f13/subqueue/devoverlay). Three pins were MUTATION-verified (F-5 widen removal, F-6 format-call removal, F-7 escape removal each fail their pin and were restored). Live-only scenarios (S11-S14 IR/Insights walk, S23 Overview, S16 export capture) NOT APPLICABLE in-container; the export guards + retry affordances warrant a quick manual click-through post-deploy.

REGRESSION RISKS:
- F-5 makes the fake stricter: any FUTURE test whose fixture is narrower than the range its code reads will now throw where it silently padded — that is the point; the error message names the fix (widen or set _maxColumns).
- dcWriteSheet_-style API changes: none this time; fakeSheet's new methods are additive no-ops.
- G-6's interim render passes the stashed init — if the modal was opened and the FIRST getDigestsInit failed (no stash), install still renders with current alDgRows_ (empty) + status, then the refetch corrects; no worse than before, and the failure is now voiced.
- G-7's retry buttons re-enter ensure*Roster; the seq token dedupes concurrent retries.

INVARIANTS AT RISK: None. INV-12 is now ENFORCED rather than asserted. INV-41/42 untouched (G-3 changes a data value, not color plumbing). The csvSafeCell_ rule now genuinely covers all six tabular writers.

NET SCORE: 1 − 0 = 1
(G-3 was live — any admin who tuned ANSWER_TARGETS this month had the IR chart preaching 95 against their tuned standard, and even untuned installs showed a goal matching no documented standard. The rest are conditional/latent UX hardening; F-5/F-6/F-7 are enforcement, not fixes.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard as a NEW VERSION (Operator State #2) | BLOCKS DEPLOY: Y
- No new Script Properties, scopes, sheets, or triggers. Test-only changes need no deploy.
Deploy: scripts/deploy.sh . <dashboard-deployment-id> (accumulates with the pending increments 74/76 dashboard deploy — one new version covers all three; cdr-import's pending deploy from 74/75 unchanged)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Remaining batches: 5 (a11y: E-6..E-10), 6 (alerts/server smalls: B-5, B-6, A-3, A-4, A-5, B-8), 7 (deploy/ops hygiene: C-3, F-10, F-9, F-11, F-8), 8 (cdr-report editor tools: D-1..D-6), 9 (C-7 performance), 10 (frozen-legacy prep: D-8, D-9), + strategic items.
- Noticed in scope but not fixed (E-5, not in these batches): exportCaptureFailed_ still lists the retired pr-export-btn / cr-export-btn ids — harmless dead entries, one-line cleanup for Batch 6-ish.
- The F-5 enforcement plus F-6 recording make fakeSheet meaningfully stricter; if a future suite needs lax behavior, set sheet._maxColumns explicitly rather than loosening the fake.

DOCUMENTATION UPDATES NEEDED:
- Optional: CLAUDE.md's harness description ("Zero deps ... mocked Apps Script globals") could mention that the fake now ENFORCES column bounds and RECORDS number formats — one clause each, next /sync-docs.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
