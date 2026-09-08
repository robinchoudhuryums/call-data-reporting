---CYCLE SUMMARY BLOCK---
Scope: cdr-import + cdr-report + dashboard (Neon write path, digest engine, email family) | Cycle: 169-173 / 2026-09-08
Production fixes: 6 — severity: 4 Moderate (R27 date-memo, R31 digest gate, R35 inline parent upsert, R38 inline daily writers + block delete), 2 Low (R32 weekly/monthly gate, R39 Direct step)
New capabilities/features: 8
Defensive/structural: 3
New failure modes: 2 — severity: 1 Moderate (R34's first cut threw "Argument too large: sql" mid-run in production at index 14400; caught by the operator, not the suite; fixed same-cycle by #291/R35), 1 Low-Moderate (R39 changed the Direct writer's persistence format with NO parity gate for direct_call_history and no post-deploy observation yet; its only reader is admin-only and explicitly still being vetted, so a coercion defect would be silent)
Net score: 6 − 2 = 4
Invariant candidates:
[INV-56] | Every daily Neon writer emits inline dollar-quoted literals size-packed under the JDBC SQL cap, keeps the bound-param insert as the per-row oversize fallback, and pins inline == bound value-for-value | cdr-import+cdr-report neonWrite.js, cdr-import directCallMetrics.js | Verify: neon-write-mapping / neon-write-chunking / direct-call-backfill parity tests; assert no daily writer binds a metric column.
[INV-57] | A Neon retention floor must exceed the longest dashboard read window over that table (history floor 13mo vs INV-29's 12-month trend leaves ~1 month of margin, and nothing pins the relationship) | NeonRetention.gs floors vs INV-29 / NeonRead.gs | Verify: a test reading the floor constants and asserting each exceeds the corresponding max read-window constant. UNPINNED TODAY.
[INV-58] | A digest send is gated on the window's data existing on the ACTIVE read source for all three cadences, with a one-shot retry that replaces rather than stacks | Digest.gs | Verify: digest-freshness-gate.test.js (exists) PLUS a missing assertion that pending retry triggers never exceed one per cadence (Apps Script caps triggers per script).
[INV-59] | The force-path date delete reads only the date column and removes contiguous blocks, never rewriting a whole historical sheet | cdr-import autoImport.js + directCallMetrics.js | Verify: force-delete-rows.test.js and the R39 block-delete pin (both exist); extend to any future dated-sheet delete.
Most structurally significant change: R38 replaced bound-param inserts with inline size-packed literals across every daily Neon writer in two projects, and established bound-fallback + inline==bound parity pinning as the standing rule for that seam.
Should-have-been-deferred: R29/R30, the 16-sender email restyle — zero net by its own scoring, landed mid-way through a live data-recovery runbook while Neon sat at its storage ceiling and August data was missing, and the immediately preceding reflect had just recorded a presentation-layer change shipping an unnoticed user-visible defect in this same surface.
---END CYCLE SUMMARY BLOCK---
