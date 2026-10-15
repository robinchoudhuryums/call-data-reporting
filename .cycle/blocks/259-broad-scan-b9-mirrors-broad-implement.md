---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F11 The DQE Drill-Down's Found-N disagreed with the build on col E (dedupeByParent folded every no-parent leg into one phantom 'N/A' parent) and on AD/AE/AF (the abandoned filter kept answered legs and ignored AD's appended unpaired ids); the parity suite never drove those columns
- F12 Drilling a queue-sentinel row (INV-23) said "No source rows match"
- F13 queueOverlapAudit's "build parity" premise predated P-7 (it counted stray other-day legs) and it matched raw, un-canonicalized names; its test pinned the stale reason
- F59 One stray leg turned off queueSplitSample's col-AI self-check, and its closing message named the stray's date
- F60 qcdDqeDiagnostic's Raw Data fallback took its date from row 2 (the ING-7 carry-over shape)
- F63 The CSR Transfer per-queue counts were written in QCDR Output N1:X1 order with no check against the history sheet's header, so a reorder silently mislabeled them
- F64 The daily CSR engine counted stray other-day legs that the CSR repair drops
New capabilities (G/ST): None
Files modified:
- apps-script/cdr-report/DQEdrilldown.js, apps-script/cdr-report/queueOverlapAudit.js
- apps-script/cdr-import/queueSplitSample.js, apps-script/cdr-import/qcdDqeDiagnostic.js, apps-script/cdr-import/autoImport.js
- tests/unit/dqe-drilldown-parity.test.js, tests/unit/queue-overlap-audit.test.js, tests/unit/queue-split-sample.test.js, tests/unit/qcd-dqe-diagnostic.test.js, tests/unit/csr-transfer.test.js
- .cycle/STATE.md, .cycle/blocks/259-broad-scan-b9-mirrors-broad-implement.md

CHANGES:
F11 | DQEdrilldown.js | Unique: legs with an empty / 'N/A' parent are rejected with a reason before dedupe (the build's REP-4 rule); abandoned: AE/AF (cols 31/32) keep only MISSED legs on abandoned parents with a parseable start, AD (col 30) keeps those plus each abandoned parent the agent touched without one, once -- exactly the entries the build writes
F12 | DQEdrilldown.js | a queue-sentinel agent name (`A_Q_*` / `Backup CSR`) returns an explanation (what the row is, where its calls are in Raw Data) instead of "no source rows"; deliberately NOT a re-derivation of the build's queue-only rule (a fifth hand mirror)
F13 | queueOverlapAudit.js | unpinned runs analyse only the build's date (first valid START_TIME; rows with no start kept, as the build keeps them) and report the stray count; agent names go through the build's own canonicalizeAgentNameWith_ / loadRosterCanonicalNames_ (same project, no copy); header comment, labels and the pinned-date note corrected
F59 | queueSplitSample.js | the run is dated like the build (first valid START_TIME); legs on any other date are dropped and counted (P-7), so the self-check and the closing message use the build's date
F60 | qcdDqeDiagnostic.js | the Raw Data fallback reads col C and takes the MAJORITY date through the ING-7 helper csrRepairDayRows_
F63 | autoImport.js | calcCsrReport returns its N1:X1 `headers`; new PURE csrQueueHeaderReorder_ (fires only on a provable reorder -- a source queue name at a different position in the history header; differently-spelled labels never fire) + csrHistoryHeaderProblem_; the daily write refuses + logs a `processIntegratedHistory:CSR` failure row, the bulk enqueue refuses + logs `bulkBackfill:CSR`, the ING-7 repair throws
F64 | autoImport.js | processNewImport feeds calcCsrReport `csrRepairDayRows_(cleanData).rows` -- the day-only grid the repair recomputes from (CDR and QCD inputs unchanged: no repair to disagree with, and QCD is dashboard-read)

TEST RESULTS: passed -- 2489 tests (2488 pass, 0 fail, 1 pre-existing skip; +9). Two pins encoding the OLD behaviour were updated as part of their fixes: queue-overlap-audit's BUILD PARITY + REGRESSION tests (the pre-P-7 premise, F13) and csr-transfer's I-6 order pin (the CSR compute call, F64); qcd-dqe-diagnostic's fake tab now answers col C as a column (it encoded the row-2 read, F60) and loads neonWrite.js for parseDateForNeon. lint:gas clean, module-deps up to date, INV-16 guard in sync. No dashboard client change, so ci:ui was not re-run. Bites: 11/11.
REGRESSION RISKS:
- F63: on a FORCE re-import with a reordered header, the date's CSR rows are deleted (the delete precedes the write) and not rewritten -- the failure row names it and the PipelineWatch email carries it; re-align the headers and re-import. Chosen over writing every count under the wrong queue.
- F64: CSR numbers move only on a day whose source holds daytime legs from another date (midnight carry-overs already fail the engine's 6:00-15:30 filter).
- F11: the drill's Found-N for cols 5 / 30-32 changes to match the stored cells -- the point; any operator note that relied on the old over-count is now wrong in the right direction.
INVARIANTS AT RISK: None (INV-16 untouched -- no duplicated file changed; INV-23 sentinel semantics unchanged, the drill only explains them; INV-24 is now applied by the overlap audit through the build's own function; INV-44 -- only existing step names used).
NET SCORE: 0 − 0 = 0 (all seven are verification-tool or latent fixes; none would have changed a production number this month)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: CDR DQE Pipeline + CDR Reporting Tools -- `cd apps-script/cdr-report && clasp push -f` (or scripts/deploy.sh apps-script/cdr-report)
Deploy: CDR Import -- `cd apps-script/cdr-import && clasp push -f` (or scripts/deploy.sh apps-script/cdr-import)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F63's refusal runs after the force-delete; moving the header check into processNewImport's pre-delete validation (the P-3 rule) would keep the date's CSR rows on a refused force re-import -- a larger change to the shared ordering, not taken here.
- Batch 10 (deploy / docs / tooling) remains; F62 is still deferred for an owner ruling.

DOCUMENTATION UPDATES NEEDED:
- None (each tool's own header comment carries the corrected rule; CLAUDE.md's drill-down bullet still states the parity-suite guarantee correctly)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
