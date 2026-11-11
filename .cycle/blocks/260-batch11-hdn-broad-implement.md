---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F49 (HDN-1): six doc passages still said data past the 14-day window is unrecoverable
- F32 (HDN-2): the per-user email throttle and the client-issue caps were read-then-write on CacheService with no lock
- F50 (HDN-3): stale cache versions in per-call-capture.md; the sync test omitted two docs
- F51 (HDN-4): STATE's outstanding list carried items later entries recorded as done
- F53 (HDN-5): the doc bundle (journey window, exception days in architecture.md, README deep links, stale counts, INV-30's missing prefixes, the Data.gs header)
- F54 (HDN-6): the insurance-number sync ran CREATE TABLE inside its transaction
- F55 (HDN-7): two unreferenced definitions and an orphan comment
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/Config.gs, SystemHealth.gs, OutboundReport.gs, Diagnostics.gs, Data.gs (header comment), InboundReport.gs (comment)
- apps-script/cdr-report/insuranceNumbers.js, inboundCallsExport.js (comments), queueOverlapAudit.js (comment)
- tests/unit/app-email.test.js, system-health.test.js, insurance-numbers.test.js, cache-version-sync.test.js
- CLAUDE.md, README.md, docs/operator-state.md, docs/known-issues.md, docs/next-steps.md, docs/per-call-capture.md, docs/neon-layer.md, docs/architecture.md, docs/invariants.md, docs/fix-history.md, docs/module-dependencies.md, tests/README.md, .cycle/STATE.md

CHANGES:
F49 / HDN-1 | docs/operator-state.md (#38, #66), docs/known-issues.md (two passages), README.md, docs/next-steps.md | Each "unrecoverable" / "cannot be backfilled" / "can never be filled" now says what the owner's 2026-09-16 correction says: a date past the Call_Legs window needs its source re-imported first (Operator State #56) -- operator time, not lost data.
F32 / HDN-2 | Config.gs, SystemHealth.gs | New withQuotaGuardLock_ runs a short check-and-record under the script lock (4 s wait; it leaves a lock this execution already holds alone, and runs unlocked if the lock cannot be had). assertReportEmailThrottle_ reads, checks and writes inside it. reportClientIssue now decides and RESERVES (signature, window count, per-user count, cap marker) inside it and sends the email afterwards -- it used to write the counts only after the send.
F50 / HDN-3 | docs/per-call-capture.md, tests/unit/cache-version-sync.test.js | DOC_FILES gained per-call-capture.md and neon-layer.md; the widened test then named the stale mentions itself: companyOverview:v28 (twice; code is v31) and inbound:v15 (code v16). All three corrected.
F51 / HDN-4 | .cycle/STATE.md | The consolidated outstanding list marks #88, the retry census and the EXC-2 follow-on as done, each with the entry that closed it; what is still open is labelled.
F53 / HDN-5 | docs/operator-state.md (#49, #50), docs/per-call-capture.md, inboundCallsExport.js + InboundReport.gs comments, docs/architecture.md, README.md, docs/invariants.md (INV-30), Data.gs header, CLAUDE.md | The journey window is an EXPORT-time rule: a row keeps its journey once written, so only a seed or a re-export of old dates leaves it blank. architecture.md has an exception-days section. The README deep-link list follows the router (two admin routes added, retired reports grouped as legacy, Inbound marked admin-only). INV-30 names the six non-report prefixes the sync test already tracked. The Data.gs header describes the 6 h keyed cache and the span-bounded read. CLAUDE.md: ~170 suites, "every per-dept report endpoint", cols C..D, ~64k cells.
F54 / HDN-6 | apps-script/cdr-report/insuranceNumbers.js | CREATE TABLE IF NOT EXISTS runs in autocommit; the transaction opens after it (inside the try) and holds the DELETE + inserts.
F55 / HDN-7 | OutboundReport.gs, Diagnostics.gs, queueOverlapAudit.js | Removed OB_EP_OUTCOMES_ and typeOfCell_ (no references anywhere) and the orphan JSDoc line; the Diagnostics header no longer names the removed helper.

TEST RESULTS: passed -- 3033 pass, 0 fail, 1 skipped (pre-existing) under TZ=America/Chicago; lint:gas clean; module-deps --check clean (regenerated); INV-16 guard in sync; ci:ui all stages passed. 4 new unit tests (two for the throttle's lock, one for the beacon's reserve-then-send order, one for the DDL order) plus the widened sync test; 6 mutation (bite) checks, all red on mutation.

REGRESSION RISKS:
- F32: the report-email throttle and the beacon now take the script lock, which the dashboard's write paths and engines also use. A report email requested while an engine holds the lock waits up to 4 s, then proceeds unchecked (fail open). That residual window is deliberate and documented.
- F32: a client-issue email that fails to send has still used its slot (signature, window and per-user counts). That bounds a loop of failing sends; it also means one failed send is not retried for that signature for 30 minutes.
- F54: none expected -- the same statements in a different order; a failed CREATE now throws before the transaction opens and still reaches the close().
- F53: corrects a claim I restated in Batch 7 (OFB-5 said the journey window "limits stored bytes"). It does not, in steady state.

INVARIANTS AT RISK: None. INV-01 is untouched (no new write; the lock guards cache counters). INV-16: queueOverlapAudit.js lost a comment line outside the guarded function, and the guard passes. INV-30: the entry gained text only; no version changed. INV-31 unaffected.

NET SCORE: 0 − 0 = 0
(a) Fired in production this month: F49 NO, F32 NO (reasoned, never reproduced; needs a signed-in user firing parallel requests on purpose), F50 NO, F51 NO, F53 NO, F54 NO, F55 NO.
(b) New failure mode: NO for all seven.

OPERATOR ACTIONS / DEPLOY:
- None beyond the deploys | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)
Deploy: CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (the insurance sync's DDL order; comments otherwise)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The export tabs keep every row's journey for the whole 400-day retention in steady state (the finding F53 corrected in the docs). That is more stored bytes than the old wording implied. Whether the daily export should blank journeys as rows age past the window is a behaviour change for the owner to decide; nothing was changed.
- Whether the Inbound report's server gate matches its admin-only menu item was not re-verified here; the README now says "admin-only menu item", which is what the markup shows.
- Two code comments in Data.gs (near dqeExtGrid_ and deptQueueExtsFromSheet_) still say "~128k cells"; CLN-1 halved that read. The scan named only the file header.
- CLAUDE.md's "~100 keys" for the live Script Properties store could not be checked from the repo (the registry lists 151 names; the live store is the owner's to read on the Health page).
- With all 11 fix batches done, what remains of the scan is the deferred owner rulings (F35, F36, F34, F28, F52) and the expansion batches E1-E5.

DOCUMENTATION UPDATES NEEDED:
- None outstanding. This batch was largely documentation; everything it named is updated, plus docs/fix-history.md (HDN-1..7), docs/next-steps.md, docs/neon-layer.md (rule 6), tests/README.md.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
