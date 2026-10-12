---CYCLE SUMMARY BLOCK---
Scope: Department Dashboard (outbound callbacks) + CDR Import + CDR Reporting Tools | Cycle: 241-245 / 2026-10-09 (reflected 2026-10-12; merged as #364, e73574d, NOT yet deployed)
Production fixes: 2 — severity: 1 Medium (CE-1: the deployed callback headline divided by abandons no team could own -- "0.6% called back ... 709 trackable", 653 of them unmapped phone-menu / person's-line hang-ups -- and counted every repeat attempt as a failure; the owner read it live), 1 Low (FO-3: the deployed #/report/outbound deep link could land the Callbacks fold off screen, ~1 in 9-12 harness loads)
New capabilities/features: 4 (CE-2 drill lists + called-back list; CE-3 direct-line callbacks + repeat-unreturned-callers list; FO-1 the misdial filter, a refinement of the undeployed CE-3; BF-1 the journey ring backfill tool)
Defensive/structural: 3 (FO-2 the direct-line sheet backup -- resilience for an undeployed admin-only surface; FO-4 tie order; BF-2 trimmed agent grouping -- the capture already trims, only an 80-char cut after a space could split)
New failure modes: 3 — severity: 3 Low. (1) CE-3's dept view matches `trim(first_agent) IN (<roster names>)` exactly, so rows captured before PC-1 still holding a RAW feed name fall out of that dept's direct-line figures silently (they surface only as "lines on no roster" in the company view) unless Operator State #72's rewrite has run -- recorded nowhere. (2) FO-2 widens the Inbound Calls tab 22 -> 24 columns; the tab's row count and the workbook's cell headroom (#62, a hard cap that has failed once) were not measured. (3) CE-1 moves the callback fetch from aggregates to row-level events (~100-200 KB per 30-day window, block 241's own estimate) and CE-3 adds two more lazy reads, against a Neon transfer allowance that has blown twice; unmeasured live (the #47 recheck is a week after deploy).
Net score: 2 − 3 = −1
Invariant candidates: INV-61 (both callback sources feed ONE engine; each sheet adapter mirrors the SQL clause by clause), INV-62 (no caller hash or number leaves the database on any callback / direct-line path -- per-request dense_rank keys only), INV-63 (a reader of a column another project adds reads it through to_jsonb; missing = NULL = unknown, and unknown is never 0 or a misdial), INV-64 (misdial = first ring strictly under OUTBOUND_BRIEF_RING_SEC_; counted, out of every episode and rate; the cdr-import log mirror equals it)
Most structurally significant change: CE-1 replaced the aggregate callback SQL and its separate sheet-side aggregation with event rows from either source feeding one pure episode engine -- every later callback rule (CE-2, CE-3, FO-1, FO-2) became a change in one place, parity-pinned.
Should-have-been-deferred: FO-2, the direct-line sheet backup -- it widened a capped workbook tab and created a three-project deploy order for an admin-only surface nobody had yet seen live once.
---END CYCLE SUMMARY BLOCK---

DETAIL

Per action (Q1 = fired in production this month? / Q2 = new failure mode?):
- CE-1 episodes + own-team headline | Q1 YES, Medium -- deployed (#363), the owner reported the misleading headline | Q2 YES, Low -- larger Neon read volume, unmeasured (failure mode 3)
- CE-2 drill lists | Q1 NO -- capability (status, late tags, call ids, called-back list); the CE-1 list it extends shipped the same day | Q2 NO
- CE-3 direct-line callbacks | Q1 NO -- a new population, not a defect firing | Q2 YES, Low -- the silent #72 dependency (failure mode 1)
- FO-1 misdial filter | Q1 NO -- refines CE-3, never deployed | Q2 NO (unknown ring stays in by design; to_jsonb keeps deploy order safe, Postgres-checked)
- FO-2 direct-line sheet backup | Q1 NO -- resilience for an undeployed surface | Q2 YES, Low -- tab width / cell cap (failure mode 2)
- FO-3 deep-link scroll hold | Q1 YES, Low -- G3's deep link is deployed; the fold landed off the top in ~1/9-1/12 harness loads | Q2 NO (released on any input, capped at 6 s)
- FO-4 agent tie order | Q1 NO | Q2 NO
- BF-1 journey ring backfill | Q1 NO -- operator tool for an undeployed filter | Q2 NO (NULL-only writes, preview + backup first; a wrong-leg match needs the owner's name on an earlier no-Departments leg -- not observed, not counted)
- BF-2 trimmed agent grouping | Q1 NO | Q2 NO

CORRECTED vs the implement self-reports: blocks 241-245 summed 1 + 1 + 1 + 3 + 1 = 7 production fixes with ZERO new failure modes. Here: 2 fixes. Blocks 242 and 243 counted capabilities (the drill lists, direct-line callbacks) as fixes; block 244 counted FO-1 and FO-2, which refine a surface that has never been deployed; block 245 counted BF-1, a tool for that same undeployed filter. Three Low failure modes no block recorded.

Honest impact summary:
- For a user right now: nothing -- merged, not deployed. On deploy (admin-only until 6c): the callback rate becomes a per-team, per-episode figure that excludes calls no team could own; direct-line callbacks appear for the first time; the deep link lands correctly.
- For the next developer: one engine and two clause-mirrored adapters, with Neon-vs-sheet parity tests and a local-Postgres check behind every new query; a callback rule change is one edit plus its parity fixture. The direct-line half now spans three projects (capture column, export columns, dashboard reader) with a written deploy order (#49).
- Safer under load: nothing material; reads stay lazy and on the 6 h tier, and fallback payloads are never cached.
- Effort on future-proofing: FO-2 and BF-1 are both investment in a surface not yet live; FO-4 and BF-2 fixed parity gaps with no user-visible effect today.

Verify-next (for the next Verification Pass): run S48 / S59 / S60 after the deploy; check the #47 Neon read volume a week after; confirm #72 has run (or measure how many direct-line rows hold a non-roster first_agent); read the Inbound Calls tab's row count against #62.

Note on numbering: blocks 149 and 207-211 both proposed INV-56..60 (a collision already in the record); this block starts at INV-61.
