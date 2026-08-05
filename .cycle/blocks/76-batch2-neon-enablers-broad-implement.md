---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- B-2 | The sheet-retirement end state broke its own health tools — SmokeCheck check 1 hard-asserted DQE sheet rows and NeonCoverage classified every trimmed date as "phantom rows / force re-import", regardless of `DQE_READ_SOURCE`
- A-2 | `getDeptConfigInit` cached its init blob unconditionally — a transient config-read error or Neon-discovery blip pinned a wrong picture (rows:[], constants-only, discovery unavailable) for the 30-min TTL
- B-4 | Inbound entry-queue matching was byte-exact in SQL while the Missed report and queue split match the same names case-insensitively — a case-mismatched Dept Config alias attributed calls in one subsystem but silently not the other, and the parity check couldn't see it (the name LOOKS mapped)

Files modified:
- apps-script/department-dashboard/SmokeCheck.gs (B-2: source-aware check 1 + roster-tab verification)
- apps-script/department-dashboard/NeonCoverage.gs (B-2: sourceFn on dqe/qcd table specs, pure ncReclassifyTrimmed_, informational email line)
- apps-script/department-dashboard/DeptConfig.gs (A-2: degraded-init cache-put guard)
- apps-script/department-dashboard/InboundReport.gs (B-4: both predicates lower/trim both sides; inbound:v8, inboundHeatmap:v3)
- CLAUDE.md, docs/invariants.md, docs/architecture.md, docs/known-issues.md, docs/conventions.md (version-table + INV-30 sync; historical citations rephrased off the prefix pattern so the every-mention guard tracks only live constants)
- tests/unit/smoke-check.test.js, neon-coverage.test.js, dept-config.test.js, inbound-window-scope.test.js (new pins) + heatmap-cell-drill.test.js, inbound-qcd-parity.test.js (old exact-case pins updated)

CHANGES:
B-2 | SmokeCheck.gs | check 1 verifies the workbook + `DO NOT EDIT!` roster tab under EITHER source; an empty/absent DQE sheet under `DQE_READ_SOURCE=neon` is a pass-with-note ("trimmed/retired — read source is neon"), still a FAIL under the sheet source
B-2 | NeonCoverage.gs | `ncReclassifyTrimmed_(cmp, source)` (pure, pinned): under a 'neon' read source, extra-in-neon dates move to informational `sheetTrimmed` (not counted in findings, rendered as "(info) … expected" in the email); missing-in-neon + count-mismatch stay findings in both modes; dqe_history keys on `getDqeReadSource_`, qcd_history on `getQcdReadSource_` (explicit typeof-guarded dispatch, not this[name])
A-2 | DeptConfig.gs | skip the cache put when `deptConfigReadFailed_()` OR (discovery `available:false` AND `NEON_HOST` set — a blip; the stable unconfigured state still caches since it can't heal within a TTL)
B-4 | InboundReport.gs | `lower(trim(coalesce(c.entry_queue,'')))` IN (lowercased literals) in `inboundDeptPredicate_`; same for entry+final queue in `callJourneyDeptPredicate_`; NULL-vs-''-coalesce semantics equivalent to before for unmatched rows; `inbound:v7→v8`, `inboundHeatmap:v2→v3` (shares the predicate — the v2-bump precedent)

TEST RESULTS: passed — node --test 622/622 (was 618; +4 new pins, 3 updated), INV-16 guard clean, full ci:ui gate green (all stages; InboundReport feeds gen-payloads). Live-only scenarios (S38 inbound end-to-end; the post-flip SmokeCheck/NeonCoverage behavior) NOT APPLICABLE in this container — after deploy, run runLiveSmoke + runNeonCoverageCheck once under the current sheet source (outputs should be unchanged) and note the new behavior only manifests after a future `DQE_READ_SOURCE=neon` flip.

REGRESSION RISKS:
- B-4 changes which calls attribute to a dept ONLY where casing differed (previously: silently unattributed in inbound surfaces while the Missed report counted them). Cache bumps prevent mixed-version serving. `getInboundHeatmapCell` inherits the same predicate, so cell lists still reconcile with cell counts (same-bump discipline).
- B-2's SmokeCheck check now also requires the roster tab — a genuinely missing `DO NOT EDIT!` fails check 1 with a precise message (it previously failed downstream checks confusingly); fixture updated.
- A-2 means a degraded Dept Config open recomputes on every open until healthy — bounded cost, admin-only surface.
- The invariants/known-issues historical version citations were REPHRASED ("the inbound v7 bump") rather than deleted — history intact, guard scope now clean by construction.

INVARIANTS AT RISK: None violated. INV-30 followed (two bumps, all tables + entry synced, guards green). INV-18 untouched (heatmap window unchanged — B-4 touches queue matching, not the time band; the window-scope suite's exemption pins still pass). INV-54 semantics unchanged (aliases now just match regardless of case).

NET SCORE: 1 − 0 = 1
(B-4 fires now IF any Dept Config alias casing differs from the stored raw names — plausible-to-likely given hand-entered aliases and the self-concealing failure; counted as 1. B-2/A-2 are latent until the retirement flip / a transient blip.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard as a NEW VERSION (Operator State #2) | BLOCKS DEPLOY: Y
- After deploy: heatmap/inbound counts may shift for depts whose alias casing differed — that delta is the fix working; runInboundQcdParityCheck's unattributed list is the before/after evidence | BLOCKS DEPLOY: N
- No new Script Properties, scopes, sheets, or triggers.
Deploy: scripts/deploy.sh . <dashboard-deployment-id> (cdr-import's pending deploy from increments 74-75 is separate and unchanged by this batch)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Batch 3 next (F-5/F-6 harness enforcement, F-7 Code.gs/Setup.gs pins), then Batches 4-10 + strategic per the increment-74 list.
- The cache-version-sync guard's "every mention" rule effectively forbids `prefix:vN` HISTORICAL citations in the checked docs — worth a one-line note in that test's header comment so the next bump author rephrases up front instead of chasing four failures (S-effort, fold into Batch 3).

DOCUMENTATION UPDATES NEEDED:
- None — version tables, INV-30, and the two CLAUDE.md inline mentions were synced in this commit; historical citations rephrased in place.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
