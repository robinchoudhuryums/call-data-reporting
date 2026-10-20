---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner round 2026-10-20 (not scan findings):
  - QD-1  My Department: the Queue calls and Abandoned % cards carry a vs-prior chip, like % Answered and Avg answer
  - QD-2  Overview: each card's abandoned % / "N aban" chips, per-queue rows and the sub-queue strip's Abd follow the card Window (they always showed the latest QCD day -- PAP read "Abd 0.0%" on a 30-day view), with tooltips naming the window
  - QD-3  Overview: the "viol MTD" chip is 0 green / 1-3 amber / 4+ red, the amber drawn in --caution (it was --warn, which reads red)
  - IDLE-2 (block 259-idle-insights, same PR): a whole-dept Insights run drops agents with no calls in the window
New capabilities (G/ST): None
Files modified:
  apps-script/department-dashboard/CompanyOverview.gs (computeQcdSnapshots_ opts.periodFromIso: per-queue day map back to the YTD start, wider read; ovQcdPeriods_; tile qcd.periods; queueDaily stripped; companyOverview:v29)
  apps-script/department-dashboard/script-3-overview.html (ovQcdForPeriod_; the caption chips + sub-queue strip read it, with tooltips; OV_VIOL_MTD_AMBER_MAX_)
  apps-script/department-dashboard/script-5-dept.html (Queue calls + Abandoned % chips from qcd.rangePrior; QD_ABD_NOISE_PTS_)
  apps-script/department-dashboard/styles.html (.ov-qcd-viol-low uses --caution)
  apps-script/department-dashboard/DeptConfig.gs, OrphanFix.gs (comments: the cache version)
  tests/unit/overview-qcd-snapshot.test.js (+4)
  tools/ui-harness: drive-daybars.js (+2 checks), drive-outbound-e.js (+9 checks), README.md
  docs: invariants.md (INV-30 v29), fix-history.md (QD-1, QD-2, QD-3), client-ui-conventions.md, conventions.md, known-issues.md, architecture.md, operator-state.md, regression-scenarios.md (S66), CLAUDE.md (S66); module-dependencies.md regenerated

CHANGES:
QD-1 | script-5-dept.html | Queue calls: chip on the total vs qcd.rangePrior.totalCalls (up = good, WOW_NOISE_THRESHOLD); Abandoned %: points chip (up = bad, under 0.25 pts muted); tooltip names the prior window. Client-only -- the prior block was already in the payload.
QD-2 | CompanyOverview.gs, script-3-overview.html | qcd.periods (last30/last60/last90/ytd: calls, abandoned, %, violations; perQueue only for a multi-queue dept) summed from a per-queue day map over the DQE card windows, capped at the latest DQE date; Yesterday keeps the latest-day snapshot; a null period shows no abandoned chip. Tooltips on the abandoned %, "N aban", per-queue and Viol chips name the window.
QD-3 | script-3-overview.html, styles.html | Tier boundary 3 -> amber (was red at 3); amber = --caution.

TEST RESULTS: passed -- node --test (see commit), lint:gas, INV-16, module-deps clean; unit bites 6/6 (QD-2 server); rendered bites 8/8 after one equivalent mutant was replaced (the fixture's +0.05 pts delta is muted under either floor, so the floor was bitten at 0 instead); ci:ui result recorded in the PR.
REGRESSION RISKS:
  - The Overview read of QCD Historical Data now starts at Jan 1 (it started at the 90-day chart window). Free on the sheet path (memoized whole sheet); a larger read on the Neon path.
  - The Overview payload grows ~0.5-1 KB per dept with queue data (est. ~45 KB at 14 depts, under the 80 KB warn).
  - A card on a multi-day window with no queue rows now shows no abandoned chip (it showed the latest day's).
INVARIANTS AT RISK: INV-30 (companyOverview bumped, documented). INV-39 unaffected (qcd is visible to every viewer).
NET SCORE: 2 production fixes (QD-2 wrong figure, QD-3 wrong colour; QD-1 is a missing chip) - 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- None

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
