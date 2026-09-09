---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- **R42** — consolidate `sheetFetchDqeRows_`'s inline span into the shared `Data.gs::dqeWindowRowSpan_` (the follow-on left open by Phase 1b / block 178).
- **R43** — Phase 2 of the Neon-outage plan: a whole-run time budget on the all-departments QCD compute, plus a per-caller failure policy for the PARTIAL payload it can now produce.

Files modified: apps-script/department-dashboard/NeonRead.gs, apps-script/department-dashboard/QCDReport.gs, apps-script/department-dashboard/QueueReportEmail.gs, apps-script/department-dashboard/SystemHealth.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/script-11-qcd-boot.html, tests/unit/qcd-report.test.js, tests/unit/queue-report.test.js, tests/unit/system-health.test.js, docs/module-dependencies.md, docs/operator-state.md, CLAUDE.md

CHANGES:
R42 | NeonRead.gs | The inline span (invented here as R26b, kept through R41) now calls `dqeWindowRowSpan_`. ONE implementation of the computation instead of two.
R43 | QCDReport.gs | `QCD_ALLDEPT_BUDGET_MS_DEFAULT` (4 min) + `qcdAllDeptBudgetMs_()` (Script-Property override, NeonMirror's exact shape). The dept loop checks the budget BEFORE each dept and stops on a DEPT BOUNDARY; payload gains `meta.partial` + `partialDeptsSkipped` / `partialDeptsMapped` / `partialBudgetMs`, and a `[qcdAll] PARTIAL:` log line naming the likely cause.
R43 | QCDReport.gs | `qcdAllDeptCachedData_` refuses to cache a partial (the D-1 empty guard's sibling).
R43 | QueueReportEmail.gs | The SUBSCRIBER path refuses a partial outright (`partialReport`), checked BEFORE the empty check; `runDailyQueueReport_` writes a `PARTIAL <iso> ...` status and does NOT claim the day. The SELF-SEND path discloses instead of refusing, with the bar rendered in the email HTML.
R43 | SystemHealth.gs | `/^PARTIAL\b/` added to the outcome classifier.
R43 | Config.gs | `QCD_ALLDEPT_BUDGET_MS` registered as `operator` (PROP_REGISTRY_ is enforced both ways).
R43 | script-11-qcd-boot.html | `qcdAllDeptPartialNote_` — idempotent "This report is incomplete" note on the results wrapper.

**Why the per-caller policy is the substance, not the budget.** The budget is ~10 lines. The risk it creates is that a PARTIAL payload has a NON-ZERO dept count, so the existing D-1 empty check could not catch it — the subscriber email would have gone out with departments silently missing (an absent dept reads as "no calls"), and the sent-marker would then have stopped the real report from ever going out that day. That is precisely the guarantee the owner asked to confirm two sessions ago. Four callers, four decisions: subscriber blast REFUSES; cache REFUSES; web view SHOWS + discloses; self-send SHOWS + discloses in the email body (refusing would block an admin from mailing themselves a snapshot during the very outage that causes a partial, and a forwarded copy loses the web note).

TEST RESULTS: passed. `npm run ci` 1261 pass / 0 fail; INV-16 guard clean. `npm run ci:ui` skips (playwright not installed locally). `node scripts/module-deps.mjs --check` in sync.

New pins, all mutation-tested — each fires on its own pin:
| mutation | pin that fired |
|---|---|
| span → tail scan (shared helper) | 6 pins across dal-cutover AND dqe-span-readers |
| budget never checked | dept-boundary/partial-marking |
| `meta.partial` never set | dept-boundary + no-false-partial |
| cache stops refusing a partial | partial-never-cached |
| budget accessor accepts 0/negative | 8 tests (a 0 budget skips every dept) |
| subscriber email stops refusing | all 3 email-refusal pins |
| self-send stops disclosing | self-send disclosure |

R42's mutation is the clearest argument for the consolidation: one bug in the shared span now fails SIX pins across two suites where it used to fail one.

REGRESSION RISKS:
- **Four consumers of the all-dept payload were enumerated and each given an explicit policy** (subscriber blast incl. the QV-5 manual blast, which inherits the refusal; cache; web; self-send). A fifth would need its own decision — CLAUDE.md says so.
- `CacheWarm.gs` warms this key: a partial simply isn't cached, so the warm no-ops during an outage. Correct (no bad blob pinned), and it already has its own budget.
- The Health classifier is a prefix ALLOWLIST — a new status renders GREEN unless added. Added and pinned; this is the same hole O-5 / D-1 / O-9 each had to patch by hand.
- The budget floor is guarded: junk or a negative falls back to the default rather than 0, because a 0 budget would skip every dept and make every report partial.
- Stopping mid-dept would corrupt the company grand totals (they accumulate per dept). The check is before each dept, and a test asserts every reported dept is whole.
- No cache-version bump: a complete payload is byte-identical to before (the partial fields are `undefined` and drop out of JSON).

INVARIANTS AT RISK: None.
- INV-30 — no aggregation rule changed; a complete payload serializes identically, so no prefix bump.
- INV-01 — `qcdAllDeptBudgetMs_` is `_`-suffixed (RPC-unreachable); no new write path.
- INV-31 — the send paths are unchanged except by refusal; still `sendAppEmail_`.
- INV-50/51 — QCD schema and the retained surfaces untouched.
- The PROP_REGISTRY_ rule (a new Script Property registered in the same commit) is satisfied and enforced.

NET SCORE: 2 production fixes − 0 new failure modes = 2
- R42 (a) NO — it was a latent drift risk, not a live bug; (b) NO.
- R43 (a) YES — the vanishing-run class already ate a Daily Queue Report day, and the sheet-fallback path that causes it is the default read source; (b) NO — the partial payload is a NEW state, but every consumer of it was given an explicit policy in the same commit, and the two that could mislead (subscriber email, cache) refuse it.

OPERATOR ACTIONS / DEPLOY:
- `QCD_ALLDEPT_BUDGET_MS` is OPTIONAL — unset uses the 4-minute default. Nothing to set. | BLOCKS DEPLOY: N
- If a `PARTIAL <iso> ...` appears on the Health page, diagnose in the documented order: Neon reachability first (the usual cause), then dept-count growth, and only then the budget — raising it past ~5 min restores the vanishing-run failure. | BLOCKS DEPLOY: N
- After deploying, run `runLiveSmoke`. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`).

REGRESSION SCENARIOS: NOT RUN — manual, needs a live deploy. Walk **S32** (queue data end-to-end) and **S20** (Alerts preview + send) as the direct overlap; **S4 / S1** cover the DQE span consolidation's read path. The partial branch itself cannot be reached on a healthy install without temporarily setting `QCD_ALLDEPT_BUDGET_MS=1` — worth doing once to see the web note and confirm no email goes out.

FOLLOW-ON ITEMS:
- `tests/unit/qcd-report.test.js`'s D-1 cache tests stub `computeQcdAllDepartments_` and then `delete` it, removing the REAL function from the shared vm context rather than restoring it. Pre-existing; worked around here by capturing the function at file load (`REAL_ALLDEPT_`). Worth fixing properly so later tests in that file don't have to know.
- The budget is per-RUN, not per-dept: one pathologically slow department can still consume most of it before the check catches up. A per-dept guard would be the next refinement if that shape ever shows up in the `[qcdAll] dept=` timing lines.
- Phase 2 covered the all-dept QCD run, the one measured at 730s+. The ~20 other cut-over readers still have no whole-run budget; none of them loops over departments, so none has the same N× shape, but that is an argument from structure, not measurement.

DOCUMENTATION UPDATES NEEDED: None outstanding — CLAUDE.md's span bullet (R42 note) and Neon-outage bullet (R43 policy), `docs/operator-state.md` item 31 (the budget, the PARTIAL outcome, and the diagnose-in-this-order runbook), and `docs/module-dependencies.md` (regenerated) were all updated in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
