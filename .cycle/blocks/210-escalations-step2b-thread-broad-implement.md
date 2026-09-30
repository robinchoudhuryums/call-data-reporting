---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: ESC-L2 (Step 2b) -- linked escalations on ONE chain: shared thread tagged by department, admin edit sync across copies, "Link another department", soft REMOVE (kept in the thread, read-only for the removed dept), delete-all-linked
Files modified: apps-script/department-dashboard/Escalations.gs, script-10-escalations.html, dashboard.html, styles.html; tools/ui-harness/gen-phase3.js, build-harness.js, drive-admin.js; tests/unit/escalations-hardening.test.js, escalations-snapshot.test.js; docs/invariants.md (INV-55), docs/operator-state.md (#24), docs/fix-history.md, docs/regression-scenarios.md (S52), docs/module-dependencies.md (regenerated), CLAUDE.md (S52 index line), tests/README.md, .cycle/STATE.md

CHANGES:
ESC-L2 | Escalations.gs | status 'removed' + nullable removed_by/removed_at/removed_reason (ADD COLUMN IF NOT EXISTS); escRowMeta_ returns groupId; escAssertNotRemoved_ in resolve / reopen / start / comment / edit / move / link; getEscalationActivity returns the group thread (department + removed tags, `linked:true`) behind the unchanged row gate on the requested copy; updateEscalation writes shared fields WHERE group_id (one 'edited' entry noting the copy count); new admin-only linkEscalationDepartment (INSERT ... SELECT copy, group minted + stamped on a standalone source, 'linked' entry, new-dept email naming the others) and removeEscalationDepartment (soft status, required reason as a 'removed' entry, refuses standalone / last active copy / already removed); deleteEscalation({allLinked}) deletes every copy + trails in one txn, audit names every dept; list filter + n_removed count; init statuses
ESC-L2 | script-10-escalations.html / dashboard.html / styles.html | Removed status option + conditional sidebar row; removed card (pill, who/when/why note, no write controls); admin Link panel (excludes own + linked depts), Remove (dsPrompt_ with required reason), Delete all linked (danger confirm naming every dept); shared-thread department chips (removed marked); linked-line 'removed' label
ESC-L2 | harness | fixture: removed Power copy in grp-101; thread mock for 101; link/remove mocks; drive-admin 9 ESC-L2 checks
ESC-L2 | tests | 9 ESC-L2 tests; the fake conn answers the group queries; 9 bite mutations, each red; snapshot pin list + snapshot counts shape updated

TEST RESULTS: passed -- node --test 1963/1963, INV-16 guard OK, module-deps up to date (regenerated), lint:gas clean, ci:ui all stages passed (drive-admin 120/120 incl. 9 ESC-L2)
REGRESSION RISKS: updateEscalation on a linked copy now also rewrites the siblings' shared fields (intended, owner decision 2); the activity read for a linked copy joins escalations (indexed on group_id)
INVARIANTS AT RISK: INV-55 -- one deliberate read widening (the group thread, owner-approved); every write remains per-copy gated, the new verbs admin-only
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature work)

OPERATOR ACTIONS / DEPLOY:
- None; the removal columns are added on the first escalation write after deploy | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- No email to a REMOVED department's managers (not requested); they see it under the Removed filter
- Re-adding a removed department is refused ("already has a linked copy"); a restore verb would be new work
- The shared thread is not in the Neon-outage snapshot (Activity is live-only, as before)

DOCUMENTATION UPDATES NEEDED:
- None (INV-55, OS #24, fix-history ESC-L2, S52 + index, tests/README done)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
