---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- D-8 | [FROZEN: DQE Report Legacy] two top-level onOpen() declarations collided (last-loaded-wins; when DQEdashboard.js's won, the whole DQE Tools menu collapsed to one item) — resolved by DELETING the redundant one (the menu file's onOpen is a strict superset), the freeze-sanctioned cleanup-deletion class
- D-9 | [FROZEN: DQE Report Legacy] decommission unknowns recorded — a 5-item DECOMMISSION CHECKLIST comment now sits where the deleted onOpen was (installable onEditTrigger to check, the hardcoded cross-workbook read, the *_Restricted / self-emails, the neutralized sendManualAlert stub, and "delete after archive is the whole decommission")

Files modified:
- apps-script/dqe-report/DQEdashboard.js (onOpen deleted; D-8 rationale + D-9 checklist comment in its place)

CHANGES:
D-8 | DQEdashboard.js | onOpen() removed; "menu DQE Tools.js" now holds the project's ONLY onOpen (single-onOpen discipline). INV-17 note: a removed FUNCTION inside a kept file needs no web-editor deletion — clasp push updates the file in place.
D-9 | DQEdashboard.js | the checklist comment (informational; no behavior change)

TEST RESULTS: passed — node --test 631/631, INV-16 clean, node --check clean on the edited file. The legacy project has no unit coverage by design (frozen); the change is a deletion of a provably-redundant function plus comments.

REGRESSION RISKS: If DQEdashboard.js's onOpen was the one WINNING in the live project, users gain the full menu back (the fix); if the menu file's was winning, nothing changes. No path gets worse.

INVARIANTS AT RISK: None — INV-22 explicitly permits cleanup deletions in the frozen subsystem; INV-17's push semantics noted in the comment.

NET SCORE: 0 − 0 = 0 (which onOpen was winning in production is unknowable from the repo; scored as latent).

OPERATOR ACTIONS / DEPLOY:
- Deploy dqe-report (`cd apps-script/dqe-report && clasp push -f` — frozen, cleanup deploys only) | BLOCKS DEPLOY: Y (for this fix only; nothing else depends on it)
- At decommission time: walk the 5-item checklist comment in DQEdashboard.js | BLOCKS DEPLOY: N
Deploy: cd apps-script/cdr-report… N/A for others this batch; dqe-report per the frozen-subsystem Deploy Command.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Round-15 remaining: Batch 9 (C-7 — deferred by owner decision until the Neon soak completes; sheet retirement erases most of that cost), the strategic tracks (queue-split reader phases, Inbound/Direct un-gating, G-1-class payload-contract assertion), F-12 (accepted limitation).
- Owner decisions recorded this session: staying on Neon FREE tier; cutover to proceed with a multi-week soak spanning at least one force re-import before any sheet trim.

DOCUMENTATION UPDATES NEEDED: None — the D-8/D-9 knowledge lives in the code comment (the right home for a frozen project); fix-history's Round-15 map already lists D-8/D-9 as the Batch-10 residue, now closed.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
