---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 5 -- "Escalations integrity", dashboard only):
- ESC-D1 every escalation_activity row records the copy's department AT WRITE TIME (new `department` column, filled in the same INSERT), so a Move no longer relabels earlier comments / starts / resolves as the new department's -- on the live thread AND the offline snapshot; pre-column rows are backfilled from the move history ("<from> → <to>" of the earliest later `reassigned` entry, else the copy's current dept)
- ESC-D3 the linked-group Edit is refused while any other not-removed copy is no longer pending (it rewrote a started / resolved sibling)
- AC-3 (incl. PC-11) the 8 escalation entry points + getDeptDayAbandons gate on the `assertManagerOrAdmin_` allowlist, never a bare `role === 'none'` denylist
- ESC-D4 a single-copy delete of the LAST active copy of a group that still holds removed copies is refused (use delete-all); the delete-all audit row names every copy's dept, removed ones included
- ESC-D5 the offline Activity path returns the SAME shape for "another department's row" as for "no such id" (L9) -- it leaked existence via available:true vs false
- ESC-D6 snapshot chunks are measured in UTF-8 BYTES (the ~9KB cap's unit; a multi-byte chunk of 8000 chars could be ~24KB), never split a surrogate pair, and a failed property write is logged instead of swallowed
- ESC-D7 a Dept Config read that errored no longer sends a spurious "Access changed" sign-in email (fail-closed resolveUser_ drops sub-queue depts); denied attempts still report

Files modified:
apps-script/department-dashboard/Escalations.gs, apps-script/department-dashboard/InboundReport.gs, apps-script/department-dashboard/Auth.gs, tests/unit/escalations-hardening.test.js, tests/unit/escalations-snapshot.test.js, tests/unit/login-notify.test.js, docs/invariants.md (INV-55), docs/module-dependencies.md (regenerated)

CHANGES:
ESC-D1 | Escalations.gs (escAppendActivity_ INSERT + `(SELECT department FROM escalations WHERE id = ?)`; escEnsureTable_ ADD COLUMN + idempotent move-history backfill in its own try; both thread SELECTs read COALESCE(a.department, e.department); backfillEscalationActivity seeds carry e.department; ESC_REQUIRED_ACTIVITY_COLUMNS_; escSchemaRead_ reads the activity columns; escSchemaVerdict_ warns on a missing one; schema memo key escSchema:v1 -> v2 carrying both lists) | the column the writes now depend on is created at once after deploy and checked by Health
ESC-D3 | Escalations.gs (escGroupNotPendingDepts_, updateEscalation guard) | refuses naming the sibling + its status
AC-3 | Escalations.gs x8, InboundReport.gs (getDeptDayAbandons) | assertManagerOrAdmin_(user)
ESC-D4 | Escalations.gs (deleteEscalation guard; escGroupDepts_ gains includeRemoved) | last-active refusal + full audit
ESC-D5 | Escalations.gs (escSnapshotActServe_) | denial -> {available:false, rows:[]}
ESC-D6 | Escalations.gs (escUtf8Len_, escChunkUtf8_, ESC_SNAPSHOT_CHUNK_CHARS -> ESC_SNAPSHOT_CHUNK_BYTES, byte-budget packer, logged catches) | byte-correct chunks
ESC-D7 | Auth.gs (notifyLoginEvent_) | skips the comparison for a non-denied outcome when deptConfigReadFailed_(); store untouched so the next request re-decides

TEST RESULTS: passed -- `npm run ci` 2053/2053 (12 new tests), INV-16 guard clean, module-deps regenerated + up to date; bare `TZ=UTC node --test` 2053/2053; `CI=true npm run lint:gas` clean (75 files). Every new pin was mutation-checked against the pre-batch file (git stash). Test doubles updated as part of the fixes (each encoded the old behavior): the reviewConn fake answers the new sibling-status query; the ESC-L2 single-delete fixture now models two ACTIVE siblings (unset read as "all removed" under ESC-D4); the ESC-S1 offline test pinned the leaky {available:true} denial shape (ESC-D5); the snapshot pack test reads the renamed byte constant; the ESC-DDL read test and the ESC-DDL2 sweep cover the activity table. One mid-run failure was this session's own (cache-version-sync: INV-55 still named escSchema:v1) -- fixed. ci:ui not run -- no client file touched.
REGRESSION RISKS:
- ESC-D1: every escalation write now names the `department` activity column. The v2 memo key makes the ADD COLUMN run on the first escalation call after deploy; if that DDL failed (it runs as the same owner as the five escalations ADD COLUMNs that already succeed), writes would fail with "column ... does not exist" -- the esc-schema Health row now names it. The backfill UPDATE scans unfilled rows at most hourly (none after the first run). Entries on a copy that was moved TWICE before this deploy get the earliest later move's `from`, which is the right dept for that interval; detail-parsing assumes moveEscalation's "<from> → <to>" format (the only writer of `reassigned`).
- ESC-D3: an admin can no longer fix a typo in the shared fields once any linked copy has moved past pending -- by design; the refusal names the copy.
- ESC-D4: deleting the last active copy alone now needs "delete all linked copies".
- ESC-D5: a manager whose own row is missing from the snapshot and one probing another dept's id now see the same "unavailable" -- intended.
- ESC-D6: an ASCII-heavy thread snapshot holds 18 bytes less per 6 chunks than before (the per-boundary headroom); multi-byte content holds fewer chars -- correctly.
- ESC-D7: a granted user's FIRST sighting during a config-read failure is reported on their next healthy request instead.
INVARIANTS AT RISK: INV-55 (write paths and the activity schema changed -- gates unchanged or narrower; entry updated); INV-01 (no new write path); INV-38 (unchanged -- ESC-D7 only stops comparing its degraded output); INV-30 (escSchema is a registered non-report exception prefix; its version moved with its key). None violated.
NET SCORE: 1 − 1 = 0 (production fixes this month: ESC-D1 -- Move shipped 2026-09-30 and relabels the thread on every move. ESC-D3/D4/D5/D6/D7 and AC-3 are real but with no evidence of firing this month. New failure mode, documented above: ESC-D1 makes every escalation write depend on the new activity column existing.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (every change is in the dashboard project) | BLOCKS DEPLOY: Y
- After deploy, open the Escalations page once (runs the schema check + backfill), then read the Health page's esc-schema row: it should read ok; a warn naming escalation_activity.department means the column could not be added -- run `ALTER TABLE escalation_activity ADD COLUMN IF NOT EXISTS department text` in the Neon console (Operator State #24) | BLOCKS DEPLOY: N
- Walk S50 + S52 once on the live app: move a copy, open its Activity -- earlier entries keep the old department; a linked Edit with a resolved sibling is refused | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Other bare `role === 'none'` preambles remain outside this batch's nine (DeptSummaryEmail, IndividualReport x2, InsightsReport x2, MissedCallsReport x2, Data.gs getDepartmentSummary); each is followed by the assertDeptAccess_ allowlist, so they are style, not exposure -- a one-line sweep pin could retire the pattern repo-wide. Data.gs getLatestDataDate(s) and SystemHealth's reportClientIssue / recordPresence deliberately admit agents.
- ESC-D3's refusal is server-side only: the client still shows the Edit control on a pending copy whose sibling moved on (the save then explains).
- A `reassigned` entry carries the NEW department; if the owner prefers it under the old one, write it before the UPDATE.
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (INV-55). /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
