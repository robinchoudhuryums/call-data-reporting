---CYCLE SUMMARY BLOCK---
Scope: Department Dashboard (Escalations + email) + cdr-report (EML-2 DCTR copy) | Cycle: 207-211 / 2026-09-30..10-01
Production fixes: 2 — severity: 1 Moderate (EML-1: PHI-bearing new-escalation + alert emails reached ALL-sentinel managers by default, against owner intent; NOTIFY_ON_NEW_ESCALATION was on), 1 Low (EML-2: the R28 admin BCC never reached the admin's inbox)
New capabilities/features: 5 (ESC-R1 move, ESC-L1 linked copies, ESC-L2 shared thread + link/remove/delete-all, ESC-L3 restore, ESC-S1 offline thread)
Defensive/structural: 1 (sync-docs pass; architecture.md had been missing deleteEscalation since 9/11)
New failure modes: 2 — severity: 2 Low (a) every escalation verb + the activity read now SELECTs group_id / status_before_removal, but escEnsureTable_'s ADD COLUMNs stay best-effort (try/catch swallowed) -- if that DDL ever fails, the whole Escalations write path and live Activity break where they used to be unaffected; (b) ESC-S1 adds up to ~48 KB to the dashboard's shared 500 KB Script Properties store (rows ~48 KB already), never measured against current usage -- a full store makes EVERY setProperty in the project throw, incl. the engines' *_LAST outcome writes
Net score: 2 − 2 = 0
Invariant candidates: INV-56 (removed copy is read-only to every write verb), INV-57 (one copy per department per linked group), INV-58 (group thread readable only through an accessible copy, live AND offline), INV-59 (ALL-row dept-manager email is opt-in; admin copy is a separate [Copy] message)
Most structurally significant change: escalation identity moved from the ROW to the GROUP (group_id + the shared thread) -- INV-55's first deliberate cross-copy read
Should-have-been-deferred: ESC-S1 offline thread -- widened PHI at rest and spent shared property-store headroom for an outage with no current occurrence, before measuring the store
CORRECTED vs implement self-reports: blocks summed 3 − 0; block 208 scored ESC-R1 as a production fix (it was a capability gap, nothing firing) and no block recorded either failure mode above.
---END CYCLE SUMMARY BLOCK---
