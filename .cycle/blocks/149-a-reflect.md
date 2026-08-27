---CYCLE SUMMARY BLOCK---
Scope: Department Dashboard + CDR Import + CDR Reporting Tools (the Neon-resilience
+ internal-transfer-path arc) | Cycle: increments 139-149 (2026-08-19 -> 2026-08-26)
Production fixes: 9 — severity: 0 Critical / 6 Moderate (heatmap fallback; Round-17
  internal-record write; the Step-4 gate's missing arm; originator-scoped answered;
  queue-leg requester identity; path-drill sheet fallback) / 3 Low (Direct report
  fallback; freshness weekend credit; per-execution conn memo)
New capabilities/features: 4 (Step-4 outbound assist link; origin_agent/origin_dept
  display; previewOutboundAssistLinks validation instrument; per-surface egress ranking)
Defensive/structural: 4 (drive-journey ci:ui stage; two sync-docs passes;
  chain-diagnostic temporal hardening)
New failure modes: 2 — severity: 1 CRITICAL (HF-0, increment 139: JDBC timeout params
  cut all three projects off Neon for ~24h, masked as slowness by the very fallbacks
  shipped alongside; self-scored "+1, no failure modes" at the time; reverted PR #256)
  / 1 Moderate (increment 145: the Step-4 gate ran only the F-4 arm, falsely refusing
  entitled managers; closed in 146 before wide use)
Net score: 9 − 2 = +7 (net-positive AND carrying a Critical — the implement-phase
  blocks summed to +4 with zero failure modes: under-counted fixes, missed the
  cycle's worst event entirely)
Invariant candidates:
  INV-56 | Neon JDBC URLs carry NO connection properties (Apps Script rejects
    connectTimeout/socketTimeout/loginTimeout; setQueryTimeout on statements only)
    | all six builders, three projects | Verify: cross-file-pins.test.js forbid-pin
  INV-57 | A CDR root is a leg TREE: internal-origin answered/abandon-leg/originator
    derivations scope to the ORIGINATOR (icLegFromOriginator_, earliest queue leg);
    external-inbound keeps the whole-tree test | cdr-import capture
    | Verify: inbound-calls.test.js shared-root block
  INV-58 | A Neon-read surface with a sheet primary/copy degrades to it through the
    SAME shaper, re-derives auth server-side, discloses fallbackSource/-Through,
    never caches fallback payloads | Department Dashboard
    | Verify: heatmap-/direct-/journey-fallback parity suites
  INV-59 | getDashboardNeonConn_ memoizes a hard connect failure PER EXECUTION
    (plain var, never CacheService -- recovery never masked) | NeonRead.gs
    | Verify: neon-conn-memo.test.js
  INV-60 | Inbound Calls export columns are APPEND-ONLY (readers address by
    position); Journey windowed by INBOUND_EXPORT_JOURNEY_DAYS | cdr-report export
    <-> dashboard readers | Verify: inbound-export.test.js 22-header pin
Most structurally significant change: the leg-tree correction (148) — identity and
  disposition fixed at the capture layer everything downstream consumes.
Should-have-been-deferred: HF-0 (the JDBC params) — platform behavior no test can
  reach, shipped to all three projects at once; one project for one day would have
  caught it at a tenth the cost. The cycle's live rule: when correctness is outside
  the harness's reach, STAGE the rollout.
---END CYCLE SUMMARY BLOCK---
