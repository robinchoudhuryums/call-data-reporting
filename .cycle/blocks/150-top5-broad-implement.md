---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-08-27 broad-scan Top 5)
- P1 — Alert recipient lookup ignored the Access Control Role column: agent-role rows received manager alert emails naming teammates' per-agent numbers
- P2 — DQE-silence watchdog marked episodes `alerted` BEFORE the email sent (and claimed "alert emailed" with no recipients): one mail failure permanently silenced the episode
- P4 — Dup-guard re-mirror routed the AF times column through the abandoned-ID sanitizer instead of the SLOT sanitizer (M3), corrupting dqe_history AF cells on non-force re-imports of coercion-damaged dates (both INV-16 copies)
- P7 — Daily onChange import's lock-skip dropped the day silently (console-only): now logs an `autoImport` failure Pipeline Health row so the Health page + PipelineWatch see it
- L1 — computeSummary_/getDepartmentSummary cached the Neon-outage EMPTY payload for the 6h TTL (missing the R8-C1 `sourceUnavailable` discipline its 3 sibling readers have)
- L2 — getCompanyOverview cached the outage-empty all-zero blob (missing the B-3 guard its own sibling getOverviewChartTrend has)

Files modified:
- apps-script/department-dashboard/Alerts.gs
- apps-script/department-dashboard/DqeSilenceWatch.gs
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/cdr-report/buildDQEHistoricalData.js  (INV-16 pair, byte-identical)
- apps-script/cdr-import/buildDQEHistoricalData.js  (INV-16 pair, byte-identical)
- apps-script/cdr-import/autoImport.js
- tests/unit/alert-recipients.test.js (+2), tests/unit/dqe-silence-watch.test.js (+1), tests/unit/dal-cutover.test.js (+4), tests/unit/pipeline-build.test.js (+1)

CHANGES:
P1 | Alerts.gs | `lookupDeptManagers_` now does a width-bounded 4-col read (REP-10-safe on pre-agent 3-col sheets) and keeps ONLY manager rows: blank Role = legacy manager (Auth.gs's own default), Role=agent and unknown roles are excluded (fail closed, matching getAccessEntries_). ALL/'*' sentinel handling unchanged for managers.
P2 | DqeSilenceWatch.gs | `DQE_SILENCE_STREAKS` is now persisted AFTER the send; `dqeSilenceSendAlert_` returns true only on a CONFIRMED send (false on empty recipients or MailApp throw, caught locally); on a failed send the alerting depts' `alerted` flags are stripped before persisting so the next run retries, and LAST_RESULT says "ALERT EMAIL NOT SENT … will retry next run" instead of falsely claiming "alert emailed" (OPS-1 discipline).
P4 | cdr-report/buildDQEHistoricalData.js + cdr-import copy | `remirrorExistingDqeDate_` maps `abMissedTimes: saneSlot(r[31])` (was `saneAb`), routing AF through `sanitizeSlotCellForNeon_` per M3; F-16 comment corrected to name the per-column routing. Both copies edited identically; INV-16 guard green.
P7 | cdr-import/autoImport.js | The onChange lock-skip branch now best-effort logs an `autoImport` FAILURE Pipeline Health row (via logPipelineHealthWithFallback_, null-ss fallback to the target workbook) naming the skip, the likely lock holders, and the Manual Processing remediation. A benign concurrent-import double-fire self-heals via the most-recent-outcome rule (the real import's later success row supersedes).
L1 | Data.gs | `computeSummary_`'s F-35 branch (neon UNREACHABLE + no sheet) marks `meta.sourceUnavailable` (neonCapable-gated, mirroring IR/Insights/Missed); `getDepartmentSummary` propagates the marker from any part (combined views included) and SKIPS the cache put on it; stale "30-min TTL" wording in the adjacent comment corrected to the R24 6h reality.
L2 | CompanyOverview.gs | `getCompanyOverview` skips its cache put when `dqeRows.length === 0` at the put site (latestDate is non-null there by construction, so empty = the outage shape — the B-3 argument ported from getOverviewChartTrend). Payload still served uncached.

TEST RESULTS: 936/936 pass (`node --test`; was 928, +8 new tests pinning every fix behaviorally: P1 role filtering + legacy 3-col width-bounding, OPS-1 send-confirmation booleans, L1 marker + RPC put-skip, L2 put-skip with a seeded latestDate, P4/M3 sanitizer routing via distinguishable stubs). INV-16 duplicated-file guard green. Regression Scenarios: the live-environment walks (S1, S5, S20/S21, S23, S28/S33, S34) cannot run in this repo-only session — listed under deploy verification below.

REGRESSION RISKS:
- P1 narrows alert recipients: a manager row with a nonstandard Role value (anything other than blank/'manager', case-insensitive) no longer receives alerts — same fail-closed rule Auth.gs already applies to sign-in, so such a row was already broken for login; risk accepted.
- P7 can produce an alert-noise failure row when two INSERT_GRID events race and the losing one was benign — the winning import's later success row supersedes it (most-recent-outcome), and the row's note says exactly what to check; accepted trade vs. a silently lost day.
- L1/L2 put-skips make outage requests recompute per-request (uncached) for the outage's duration — intended; identical to the sibling readers' existing behavior.
- New `meta.sourceUnavailable` field on summary payloads: additive; the client already tolerates this field on the Missed/IR/Insights payloads.

INVARIANTS AT RISK: None violated. INV-16 (both copies identical, guard green), INV-30 (no aggregation change — no cache-version bump needed; put-skips only), INV-32 (lookupDeptManagers_ is internal; all Alerts gates unchanged), INV-44 (the new P7 row uses the existing `autoImport` step name + schema), INV-02 (remirror still getDisplayValues), REP-10 (new reads width-bounded).
NET SCORE: 6 − 0 = 6 (P1 and P4 would plausibly have fired this month; P2/P7 are coincidence-gated; L1/L2 are pre-cutover latent).

OPERATOR ACTIONS / DEPLOY:
- None — no new Script Properties, triggers, scopes, sheets, or migrations. | BLOCKS DEPLOY: N
- Post-deploy spot-checks (non-blocking): Alerts modal Preview for a dept that has an agent-role Access Control row (recipient list must exclude the agent); Health page after the next import (no unexpected `autoImport` failure rows).
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
- CDR Import: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- The wrapper-level P2 ordering (persist-after-send) is pinned only at the send-boolean level; runDqeSilenceWatch_ itself is untested because its weekday gate reads the real clock (clock-fragile in CI).
- P8 (bulk-force CSR guard bypass), P6 (digest marker), P5 (outbound_calls backup), P3 (inbound priorDr is_internal) and the rest of the 2026-08-27 scan remain unimplemented — see the prioritized batch plan in the session notes.
- The `autoImport` lock-skip row semantics could gain a dedicated step name (e.g. `autoImport:lockSkip`) if the noise trade proves annoying — deliberate reuse of `autoImport` for now so SystemHealth needs no change.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md number-coercion bullet (M3 sentence): the AF slot-sanitizer routing now has a THIRD call site — the dup-guard re-mirror in buildDQEHistoricalData.js (both copies) — the bullet currently names only neonbackfill.js + NeonMirror.js. (Mind the claude-md-split ratchet: net-shrink or equal the bullet while editing.)
- docs/fix-history.md: record P1/P2/P4/P7/L1/L2 under this scan's codes with pointers to the new tests.
- docs/invariants.md INV-44 (optional): note that an `autoImport` failure row can now also mean a lock-skip (note text self-describes).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
