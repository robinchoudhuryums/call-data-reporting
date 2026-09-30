---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: ESC-L3 -- restore a removed department (back to its prior status); ESC-S1 -- offline copy of the Activity threads served when Neon is down
Files modified: apps-script/department-dashboard/Escalations.gs, script-10-escalations.html, styles.html; tools/ui-harness/build-harness.js, drive-admin.js; tests/unit/escalations-hardening.test.js, escalations-snapshot.test.js; docs/invariants.md (INV-55), docs/operator-state.md (#24 + #24(c) SEC-6), docs/fix-history.md, docs/regression-scenarios.md (S53), docs/module-dependencies.md (regenerated), CLAUDE.md (S53 index line), tests/README.md, .cycle/STATE.md

CHANGES:
ESC-L3 | Escalations.gs | status_before_removal column (ADD COLUMN IF NOT EXISTS), written by removeEscalationDepartment; new admin-only restoreEscalationDepartment (removed copies only; back to the recorded status via pure escRestoreStatus_, 'pending' fallback; clears removed_* on the row; 'restored' thread entry with optional note; re-sends the email -- "Escalation returned to X" -- only when it comes back open); escGroupHasDept_ returns the sibling's status so Link AND Move onto a removed dept say "use Restore"; escRowFull_ reads status_before_removal
ESC-L3 | script-10-escalations.html / styles.html | admin "Restore <dept>…" on removed cards (dsPrompt_, optional note); 'Department restored' thread label
ESC-S1 | Escalations.gs | escSnapshotMaybeRefresh_ also refreshes the threads (own try): escSnapshotActRefresh_ (one query, standalone ids + group ids bound, detail left(…,600) + cut flag) -> pure escSnapshotActPack_ (thread key = group_id or id, whole threads only, ceiling 6×8000, truncated flag) -> escSnapshotActStore_/Load_ (ESC_SNAPSHOT_ACT_*, META last); getEscalationActivity serves escSnapshotActServe_ on no-conn AND mid-query failure, authorized against the row in the rows snapshot (L9 shape on denial), snapshotAsOf + shortened flags; misses keep {available:false} (+ snapshotMissing)
ESC-S1 | script-10-escalations.html / styles.html | Activity shows "Offline copy from <local time>" + "(shortened in the offline copy)"; an offline render re-fetches live on the next open; a missing thread says so
tests / harness | 3 ESC-L3 + 4 ESC-S1 unit tests; REMOVE + PCR-8 doubles updated (prior-status bind, second refresh query); restore added to the snapshot-refresh pin list; drive-admin 3 checks; 9 bite mutations, each red

TEST RESULTS: passed -- node --test 1970/1970, INV-16 guard OK, module-deps regenerated, lint:gas clean, ci:ui all stages passed (incl. ESC-L3 ×2, ESC-S1 ×1)
REGRESSION RISKS: every snapshot refresh now makes a second (bounded) Neon read -- metered under 'escalations'; the Script Properties store can hold up to ~48KB more
INVARIANTS AT RISK: INV-55 (extended: one more admin verb; the offline read reuses the live row gate); SEC-6 scope widened to thread text, at the owner's request (OS #24(c) updated)
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature work)

OPERATOR ACTIONS / DEPLOY:
- None; the new column is added on the first escalation write, and the offline threads fill on the next list refresh | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- Closed / removed copies' threads are not in the offline copy (the rows snapshot holds open rows only)
- A copy removed before this change has no recorded prior status and restores to pending (none exist in production -- 2b is not deployed yet)

DOCUMENTATION UPDATES NEEDED:
- None
---END BROAD SCAN IMPLEMENTATION SUMMARY---
