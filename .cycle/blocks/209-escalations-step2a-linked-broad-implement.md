---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: ESC-L1 (Step 2a) -- one escalation assigned to several departments as LINKED COPIES (group_id, multi-dept create, "Also assigned to" line, "(N linked)" count label, one email per manager set, Move guard)
Files modified: apps-script/department-dashboard/Escalations.gs, script-10-escalations.html, script-2-chrome.html, dashboard.html, styles.html; tools/ui-harness/gen-phase3.js, build-harness.js, drive-admin.js; tests/unit/escalations-hardening.test.js; docs/invariants.md (INV-55), docs/operator-state.md (#24), docs/fix-history.md, docs/regression-scenarios.md (S51), docs/module-dependencies.md (regenerated), CLAUDE.md (S51 index line), tests/README.md, .cycle/STATE.md

CHANGES:
ESC-L1 | Escalations.gs | nullable `group_id` + partial index (ADD COLUMN IF NOT EXISTS in escEnsureTable_); createEscalation takes `departments` (legacy `department` kept) via escRequestedDepts_, writes one row per dept sharing a group_id (NULL when single) + a `created` trail row each, one transaction; returns {id, ids, groupId}; list + snapshot select group_id and ESC_LINKED_SQL_ (siblings' department + status only); getEscalationsBadge adds `linked` with a fallback to the pre-2a query when the column is missing; escNotifyLinkedGroup_ + pure escLinkedRecipientGroups_ send one email per manager set naming the other depts; escNotifyHtml_ gains the "also assigned to" subtitle; moveEscalation refuses a dept already holding a copy (escGroupHasDept_); escRowFull_ reads group_id
ESC-L1 | dashboard.html / script-10-escalations.html | create-form dept select is `multiple` with a hint, cleared on every fresh create; client refuses an empty pick; payload sends `departments`; success toast names the copy count; card renders escLinkedLineHtml_ ("Also assigned to Sales · in progress"); Move options exclude linked depts
ESC-L1 | script-2-chrome.html / styles.html | escApplyBadge_ appends "(N linked)" on the Overview strip for all-dept viewers (not while previewing) and to the nav badge title; .esc-linked / .ov-esc-linked styles
ESC-L1 | harness | fixture row 101 is a linked copy; badge mock linked:1; createEscalation mock; drive-admin 5 ESC-L1 checks (line, Move exclusion, strip label, multi-select none pre-picked, two-dept create payload)
ESC-L1 | tests | 8 ESC-L1 tests (escRequestedDepts_, two-copy create, single-dept standalone + unknown-dept refusal, recipient grouping, grouped email, Move guard, SELECT pins, badge fallback); all bite-checked (6 mutations, each red)

TEST RESULTS: passed -- node --test 1954/1954 (incl. the 8 new ESC-L1 tests), INV-16 guard OK, module-deps --check OK after --write, lint:gas clean, ci:ui all stages passed (drive-admin incl. 5 ESC-L1 PASS)
REGRESSION RISKS: the badge now tries the n_linked query first and re-queries on failure (one extra round trip only before the first escalation write after deploy); a manager's Move-less view unchanged; single-dept creates are byte-identical except the extra `group_id` bind (NULL)
INVARIANTS AT RISK: INV-55 (extended, not relaxed -- every gate is per row; the linked summary exposes only sibling dept + status, owner-approved); INV-01 unchanged (createEscalation stays admin-only)
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature work)

OPERATOR ACTIONS / DEPLOY:
- None required; `group_id` is added on the first escalation write after deploy | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- Step 2b (approved): shared thread across copies, admin edit sync, "Link another department", soft-remove with reason (read-only for the removed dept), delete-all-linked
- Deleting one copy today (2a) leaves its siblings linked to each other; 2b's delete-all-linked adds the group delete

DOCUMENTATION UPDATES NEEDED:
- None (INV-55, OS #24, fix-history ESC-L1, S51 + index, tests/README done)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
