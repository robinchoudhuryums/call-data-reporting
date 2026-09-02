---CYCLE SUMMARY BLOCK---
Scope: Department Dashboard (+ CDR Reporting Tools) | Cycle: 161-166 / 2026-09-02
Production fixes: 3 — severity: 1 Major (R26b bounded DQE read: 108s My Department loads, observed in a live execution log), 2 Moderate (R30 window clamp across 7 unclamped date surfaces; IR default window ending today, inflating every per-workday divisor)
New capabilities/features: 2 — cdr-report Neon egress metering (closed a ~96% blind spot in the budget gauge); queueOverlapAudit() (measured the ~8.6x Spanish/CSR inflation and cleared the 418+18=436 question)
Defensive/structural: 5 — R26c bounds split-timing; R29 sync-docs (the bounded-span rule, written for the first time after two implementations); the ui-harness month-boundary fix; R31 tone probe + first IR generate coverage; window-clamp.test.js
New failure modes: 1 — severity: 1 Low (R30 shipped an error-toned clamp note in PR #273, live until #274. MEASURED, not assumed: the note is set with status-error but sits inside #individual-form, which the results replace, so it renders 0x0 and is invisible on the normal path; it surfaces only on returning to the form)
Net score: 3 − 1 = 2
Invariant candidates:
  INV-56 | Every report window is clamped to its OWN source's latest data date at that report's RUN chokepoint (DQE -> latestDqeIso_, QCD -> latestQcdIso_; per-call surfaces stay unclamped, no latest exists for them) | Dashboard client date entry | Verify: window-clamp.test.js source tripwires on runInsReport/runIrReport/runQcdAllDept_ + the dept pair
  INV-57 | A correction is never rendered in the error tone; a status element shared between tones must restore its own | Dashboard client messaging | Verify: window-clamp.test.js tone pins; drive-smoke.js::visibleErrorTones
  INV-58 | A windowed read over a dated historical sheet is bounded by a min/max SPAN with the per-row date filter retained; a tail scan only where the sheet is date-ordered AND widens until the date's block is provably complete | Dashboard readers / CDR Import writers | Verify: dal-cutover.test.js out-of-order + full-scan-equivalence; csr-transfer.test.js
Most structurally significant change: R26b's bounded-span DQE read — it changed the cost model of the whole sheet path (~2.2M cells to ~37k for a one-day question), which is what turns a Neon outage from an incident into a supported operating mode.
Should-have-been-deferred: the R31 tone probe. One DOM probe run BEFORE claiming a red banner existed would have shown the note was 0x0 and invisible, avoiding a three-version detour and two mutation runs I misread as broken tests rather than as a wrong premise.
---END CYCLE SUMMARY BLOCK---
