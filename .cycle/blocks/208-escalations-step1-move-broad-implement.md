---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ESC-R1 (Step 1): admin-only "Move to department" for pending and in-progress escalations
Files modified: apps-script/department-dashboard/Escalations.gs, script-10-escalations.html; tools/ui-harness/build-harness.js, drive-admin.js; tests/unit/escalations-hardening.test.js, escalations-snapshot.test.js; docs/invariants.md (INV-55), docs/operator-state.md (#24), docs/regression-scenarios.md (S50), docs/fix-history.md, docs/module-dependencies.md (regenerated), tests/README.md, CLAUDE.md (S50 index line), .cycle/STATE.md

CHANGES:
ESC-R1 | Escalations.gs | new public moveEscalation({id, department, note}): assertAdmin_; target must be a known dept and differ from the current one; pending/in_progress only (resolved/rejected -> "reopen it first"; pending_review -> "approve or reject it first"); one transaction: UPDATE department (status untouched) + a 'reassigned' activity row "<from> → <to>[: note]"; snapshot refresh after commit; after the lock, the NEW dept's managers get the new-escalation email (NOTIFY_ON_NEW_ESCALATION + the EML-1 ALL opt-in), worded "Escalation moved to <to> ... from <from>" via a movedFrom option on escNotifyNewEscalation_/escNotifyHtml_; returns {id, from, to}
ESC-R1 | Escalations.gs | updateEscalation no longer reads req.department or writes the department column (a move is always its own recorded action)
ESC-R1 | script-10-escalations.html | admin-only (data-admin-only) "Move…" on pending AND in-progress cards opening an inline panel (department select excluding the card's own dept, optional note, its own error line); escMove_ calls moveEscalation and reloads; the Edit form locks the Department select (re-enabled on reset); Activity labels 'reassigned' as "Moved"
Harness | build-harness.js, drive-admin.js | moveEscalation mock; asserting driver steps: Move visible for admin, panel lists only OTHER depts, Move calls the verb and the list reloads clean

TEST RESULTS: node --test 1946/1946 pass; INV-16 guard clean; module-deps --check clean (regenerated); lint:gas clean; ci:ui all stages passed incl. the 4 new ESC-R1 driver checks. Bite-checked: admin gate removed, any status movable, same-dept allowed, wrong activity action, no notification, no snapshot refresh, Edit writing the dept -- each turns a test red. Regression Scenario S50 (new) is live-only: walk after deploy; S20/S29/S45 unaffected in code paths beyond the shared card render (S45's Delete control still asserted by drive-admin).
REGRESSION RISKS: (1) an admin who used Edit to change a pending escalation's department now uses Move (the Edit select is locked with a tooltip); (2) the moved escalation disappears from the old dept managers' view immediately -- by design.
INVARIANTS AT RISK: None (INV-55 row gate unchanged -- move is admin-only and the row's stored dept stays the access key; INV-01 unaffected -- Neon write path, admin-gated).
NET SCORE: 1 production fix (owner-requested capability; the old in-Edit dept change left no readable trail and no notice) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- None (no new property; NOTIFY_ON_NEW_ESCALATION already governs the email) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- Steps 2a / 2b (linked department copies, shared thread, "removed" copies readable by their dept) -- approved, not started; plan in .cycle/STATE.md. The Move guard "refuse a dept already in the group" lands with 2a (there are no groups yet).
DOCUMENTATION UPDATES NEEDED:
- None (INV-55, OS #24, S50 + CLAUDE.md index, fix-history ESC-R1, tests/README updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
