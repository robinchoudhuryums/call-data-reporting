# Cycle State — resume note

## Latest session cont'd (batch 4: #10, #5, #12 + #2/#11b investigation)
Same branch. Commits ed74b3d (#10+#5), d9d3106 (#12). 193/193, balanced.
- **#10:** Reports dropdown → `data-admin-only`; managers (+ admins in view-as) get a solo `#insights-solo-btn` proxying to the dropdown's launcher. Wired in init (non-admin reveal) + applyViewAs_ (view-as toggle).
- **#5:** Overview "abandons" question chip repointed QCD → Insights.
- **#12:** heatmap already has rich native-title hover (abandoned/total per cell); added a subhead hint + margin-bottom gap. (Did NOT use `.gloss` — its ::after circled-i would clutter every cell.)
- **#2 INVESTIGATED (not fixed — needs UX decision):** cards show 0 metrics + a sparkline because the headline uses ONLY the global `latestDate` (`latestDay`, CompanyOverview.gs:385) while the sparkline uses the whole 30-day `trendByDate`. Depts with no activity ON the latest date (Manual Mobility / Eligibility MM&R / Field Ops Power / Denials) read 0 but show recent history. Correct-but-confusing. FIX OPTIONS to ask: show 0 / "quiet on <date>" note / each dept's own last-active day.
- **#7 DEFERRED (bigger):** YTD Overview chart tab needs a server trend expansion (~180+ days × 14 depts) + cache bump + tab UI.
- **STILL QUEUED:** #1 Overview card→solo/Shift-multi-select chart toggle (big, NOT started); #7 YTD; #2 fix (pending UX decision); #11b (what the 12-mo Answered chart measures for Power — likely DQE per-agent answered summed monthly, needs the actual numbers to confirm the mismatch); #9-Spanish (RE-VERIFY after redeploy of the #8 fix — if Power's queue-only section still shows Spanish, scope it to queuesForDept_).

## Latest session (broad-implement: big deploy-feedback batch — 4 commits)
Branch `claude/broad-scan-je9ga7` (restarted from merged main after PR #142). 193/193 tests, INV-16 in sync, braces/divs balanced. Commits: be9569a, f5b31fc, 01ee847, b22a837 (pushed, NOT PR'd).
- **#8 view-as/nav stale dept (be9569a):** `setPage('dept')` now reloads when the painted dept (`lastSummaryDept_`) != requested dept (guarded vs double-load via the disabled refresh btn); `ovRouteToDept_` simplified. Fixes My-Dept nav + view-as click showing a stale wrong-dept table/Missed/QCD until Refresh.
- **Insights categorization #11c/d/a (f5b31fc):** new `insClassifyAgent_` (STANDING-first: current %answered vs 92% target + 5-ring volume gate → strong/steady/attention) drives the card rail + triage tiers; `deltaClassify_` (trend) becomes the secondary trend pill. Tiers relabeled Strong/Steady/Needs attention. Positive Insights-banner mark ↑ green (`--good`) not blue. Client-only, no cache bump. deltaClassify_ unchanged for Compare Ranges.
- **Small tweaks (01ee847):** #6 removed the redundant Overview "Data through … Rung …" summary line (ovRenderSummaryLine_ hidden no-op); #9 "Queue-only abandoned" gloss tooltip (both surfaces); #11e delta-chip hover tooltip (insDeltaBadge_); #4 sticky `.agents thead th` given an opaque bg (was transparent → rows showed through = the all-dept "gap").
- **All-dept report #3 (b22a837):** nest sub-queues under parent banner (server `parent` per dept + raw longestWaitSec/avgAnswerSec; client groups + computes section total); "(dept) total" row only when section >1 queue; exclude A_Q_Intake + Backup CSR (`QCD_ALLDEPT_EXCLUDE_QUEUES`, owner-asserted roll-ups); abandon% >5% bold on the bar + source lines; CSV gains Sub-dept col. Cache qcdAll:v2→v3; INV-51 updated.
- **DECISIONS captured this session:** #11c standing-first, #11d Strong/Steady/Needs-attention, #5 repoint chips to kept reports, #6 remove line (done), #7 add YTD (queued).
- **STILL QUEUED (not built):** #1 Overview card→solo/Shift-multi-select chart toggle (big); #7 YTD tab on Overview chart; #10 managers get an Insights button instead of Reports dropdown; #12 heatmap↔chart gap + richer cell hover; #5 repoint question chips to Insights/Missed/Individual. **INVESTIGATIONS:** #2 dept cards with 0 metrics but a mini-chart (Manual Mobility/Eligibility MM&R/Field Ops Power/Denials — likely QCD data but no DQE agent rows); #9-Spanish (verify after the #8 fix loads correct dept; if Spanish still in Power's queue-only section, scope it to `queuesForDept_`); #11b what the 12-mo "Answered" chart measures for Power.
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions; qcdAll:v3 self-heals. Where I left off: 4 batches shipped on-branch (unmerged); awaiting redeploy + a PR/merge and/or "continue" for the queued items.


## Latest session (deploy feedback batch: diagnostics gate, total-to-top, missed-chart, view-as bugs, all-dept report overhaul)
Branch `claude/broad-scan-je9ga7` (restarted from merged main after PR #141). 193/193 tests, INV-16 in sync, braces/divs balanced. Commits `e858812` (fixes) + `7b1547a` (all-dept overhaul). NOT yet PR'd.
- **Diagnostics admin-gate:** `renderDiagnostics` early-returns for non-admins; `#diagnostics` got `data-admin-only` so view-as preview hides it too.
- **Totals row moved to TOP** of the My-Dept agent table + Overview mini-table: the `<tfoot>` became a `<tbody class="agents-totals">` above the data rows (tfoot always renders bottom); CSS retargeted `.agents .agents-totals td` (divider below). JS writes same id.
- **Missed bars width (root cause):** `#dept-missed-chart-row .chart-section {max-width:480px}` ID rule out-specificity'd the `.mode-bars` 760px rule -> scoped `:not(.mode-bars)`. Peak outline 3px->2px.
- **View-as click-through (#5):** `ovRouteToDept_` now forces `refresh()` when the selector was already on the clicked dept (pinned+disabled in view-as) -- `setPage('dept')` doesn't load the table itself, so stale data persisted. FIXED.
- **#6 Daily Call Queue Report -> open to all managers** (owner decision): `getQcdAllDepartments` `assertAdmin_` -> signed-in check; button no longer `data-admin-only`. INV-51 + S32 synced.
- **#1 all-dept report overhaul:** pre-loads yesterday on open; in-modal date changer (preset+from/to+Update, re-gen in place, form/Generate/Back retired); Answered/Abandoned/Abandoned% -> split bar (`qcdDailyBarCell_`); per-queue rows expand into data-driven `bySource` + violation dates (server adds bySource+violationDates; `qcdAll:v1->v2`).
- **OPEN -- #4c (Spanish in Power's missed report, view-as):** queue-only section includes a queue whose exts overlap the dept's ROSTER-derived ext set; Spanish appears in Power only if a Power roster agent (maybe the admin) bridges to Spanish. Likely a staleness artifact of the #5 bug OR a roster-overlap data issue -- OWNER TO RE-TEST after redeploy; if it persists, confirm whether a Power roster agent takes Spanish overflow / admin is on Power's roster before any code fix (don't break legitimate overlap).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions; qcdAll:v2 self-heals. Where I left off: batch shipped on-branch (unmerged); awaiting redeploy + #4c re-test + a PR/merge request.

## Latest session (broad-implement: QCD-parity #1 secondary metrics + #2 short-window presets)
Branch `claude/broad-scan-je9ga7`, commit `cf5f205`. 193/193 tests, INV-16 in sync, braces/divs balanced. NOT yet PR'd (stacks on the prior unmerged deploy-feedback commits).
- **#1 secondary queue metrics (Answered / Longest wait / Avg answer):** passed through `insightsQueueHealth_` (`totalAnswered` on totals; `totalAnswered`/`longestWait`/`avgAnswer` on each perQueue row -- all already on computeQcdReport_'s queueBreakdown, just dropped before). Surfaced WITHOUT new headline tiles/columns: a muted dept-total secondary line (`#ins-qh-secondary`) under the tiles + a stat strip atop each per-queue EXPAND (every queue row is now expandable, not only ones with sources/violations). Shared `insQhStatStrip_`. Cache insights:v15->v16 (INV-30 + docs + cache-version-sync synced). Test pinned.
- **#2 short-window presets:** added Yesterday / This week / Last week to the Insights Quick-select (`ins-preset` + `insApplyPreset` handler) for the agent-free queue/dept quick-look. **Single-day daily-chart hiding was ALREADY handled** -- the consolidated trend chart gates its Monthly/Daily toggle on `labels.length > 1`, so a single-day window already hides Daily + forces Monthly (no code change).
- **#3 all-departments report:** owner + I agreed NO porting -- it's a company-wide admin surface that survives QCD retirement (getQcdAllDepartments is already independent of getQcdReport; just keep the Overview `#ov-qcd-alldept-btn` wired when the QCD tab is removed).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions. Where I left off: #1+#2 shipped on-branch (unmerged). Remaining QCD-retirement prereqs now: only the QCD image-export + the standalone all-dept button rewire (both minor), then the retirement itself (repoint /report/qcd -> Insights, delete QCD tab/modal/getQcdReport). Awaiting redeploy + a PR/merge request.

## Latest session (deploy feedback: missed-chart polish + Insights daily bar + roster-only Insights)
Branch `claude/broad-scan-je9ga7` (restarted from merged main after PR #140). 193/193 tests, INV-16 in sync, braces/divs balanced. Commits `10d0fa2` (UI polish) + `2ee9bc1` (roster-only Insights). NOT yet PR'd.
Four items of live-deploy feedback from the owner:
- **Missed bar chart (item 1):** abandoned-aware color (buckets containing an abandoned ring = solid warn red, still volume-ramped; abandoned-free = faint semi-transparent) via a NEW server-side per-bucket `chart.abandoned` array (missed cache v11->v12); peak outline 1.5px->3px; wider bars (a `mode-bars` class lifts the 520px radar cap to 760px + aspect 1.05->1.4; radar keeps its cap). `missedSyncToggles_` now also tags each chart-row mode-bars/mode-radar (called from both render paths).
- **Call-path chip (item 2 layout):** long numeric parent-id truncates (ellipsis, max ~7ch) with full value in the hover title; 📋/↳ still use the full id. Stops overrun onto the agent name.
- **Insights Daily breakdown (item 3):** Answered/Abandoned/Abandoned% folded into one green/red split bar (reuses `.ans-bar`; 5% bench tint) via `qcdDailyRowsHtml_(rows,{bar:true})` (QCD modal's numeric table unchanged). Violation dates -> MM-DD-YY via shared `fmtViolDate_` (applied in Insights + the QCD modal detail).
- **Insights roster-only (item 4):** owner confirmed the cross-dept agents carried QUEUE chips (queue-only floaters, e.g. CSR transferring into Service). `computeInsights_` `visibleAgents` now roster-only (floaters dropped from agentData; teamStats/trend already roster-gated so unchanged; queueOnlyAgentCount always 0); the Insights picker no longer offers the floater group. IR/PR/CR still surface floaters (INV-53) -- same split as My Department. insights cache v14->v15.
- **Items 2-data (path button "no results") + 6 (empty heatmap):** BOTH scope by the dept's mapped queue names against `inbound_calls` (the INV-54 two-name-space bridge). Owner's call: "likely no inbound data" for Service -- LEFT AS-IS, revisit if a known-abandoned Service call still shows no path (then check inbound_calls entry_queue/final_queue vs `inboundQueuesForDept_('Service')` and add Inbound Queue Aliases in Dept Config).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions. Where I left off: all four feedback items shipped on-branch (unmerged); awaiting redeploy + a PR/merge request. Still-open follow-up = the deferred Phase 2 QCD RETIREMENT (repoint /report/qcd -> Insights + delete the QCD tab/modal/getQcdReport, after prod validation).

## Latest session (broad-implement: QCD->Insights consolidation Phase 2 PARITY — heatmap + agent-free run)
Branch `claude/broad-scan-je9ga7`, commit `c7b6b06`. 193/193 tests pass, INV-16 in sync, script.html braces balanced (0 diff), dashboard.html divs balanced (0 diff).
- **Scope decided WITH OWNER (AskUserQuestion):** "Parity only, keep QCD" + agent-free render = "Full roster (digest pattern)". So this session landed the additive parity (gaps 4 + 6) and KEPT the QCD tab/modal/getQcdReport for parallel-run prod validation (parity-first house style, INV-51). The `/report/qcd` repoint + retirement are explicitly DEFERRED to a post-validation follow-up.
- **Gap 5 (export) was already DONE** — `insCopyImage_`/`insEmailReport_`/`insPrint_`/`insDownloadCsv_` all wired (corrects the prior `.cycle` note that listed it as pending). No work.
- **Gap 4 — heatmap:** new `#ins-heatmap` container in dashboard.html (after the Queue health section) + a `loadAbandonHeatmap_('ins-heatmap', meta.department, meta.from, meta.to)` call in `insRenderReport_` (after `insRenderQueueHealth_`), reusing the shared `getInboundHeatmap`. Admin-gated `if (USER.role==='admin')` exactly like the QCD heatmap; else-branch hides the panel for managers. Insights meta already carries department/from/to (both the data + empty paths).
- **Gap 6 — agent-free run:** new shared `resolveInsightsAgents_(rawAgents, roster)` in InsightsReport.gs — dedups/trims a non-empty selection BYTE-EQUIVALENTLY to the loop it replaced, and defaults an EMPTY selection to `roster.names` (the digest pattern, INV-45; floaters excluded since only roster seeds the default). Both `getInsightsReport` AND `sendInsightsReportEmail` use it (the only remaining throw is a genuinely empty roster: "No agents on this department's roster."). Client: `insUpdateGenerate` now enables Generate whenever the roster has ≥1 agent (checked or not, via `.ir-agent-cb` count) instead of requiring a check; the empty-selection guard in `runInsReport` removed; the `2. Agents` picker hint advertises "leave all unchecked to see the whole department (queue / dept view)".
- **NO cache bump** — `meta.agents` already carried the resolved selection, so agent-free is byte-identical to explicitly selecting the full roster (deterministic per `hashAgents_` key). insights:v14 unchanged.
- **Tests:** the `sendInsightsReportEmail` empty-agents double (encoded the OLD throw) updated to assert it now SENDS over the full roster; new positive test pins agent-free `getInsightsReport` meta.agents == full roster == explicit full-roster teamStats.
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions. **Where I left off:** Phase 2 PARITY shipped + pushed (c7b6b06). REMAINING = Phase 2 RETIREMENT (owner deferred until prod-validated): repoint `/report/qcd` → Insights (ROUTES_ registry, one entry), delete the QCD tab (`#qcd-report-btn`)/modal (`#qcd-modal`, ~163 lines)/`getQcdReport` RPC/`qcdRenderReport_` (~450 lines) — KEEP `computeQcdReport_`, `getQcdAllDepartments`, `computeQcdSnapshots_`, `computeDeptQcdSnapshot_` (all independent of `getQcdReport`, confirmed). That step breaks S32 + needs a deep-link deprecation note.

---

## Latest session (broad-implement: QCD->Insights consolidation Phase 1 — gap 1, tri-metric by-queue chart)
Branch `claude/broad-scan-je9ga7`. 192/192 tests pass, INV-16 in sync, script.html/dashboard.html braces balanced.
- **Gap 1 (option ii — one "By Queue" tab + a metric sub-selector):** completes the data+chart superset. The Insights consolidated trend chart's queue tab (renamed "Abandoned % by Queue" -> "By Queue") now plots Abandoned % / Total Calls / Violations via a `#ins-queue-metric` `<select>` (shown only on that tab). Abandoned % stays the default (5% threshold line + % formatting); Total Calls / Violations are integer counts (no threshold line). Server `insightsQueueHealth_.trend` gained `metrics: { totalCalls, violations }` (monthly+daily, per queue + own dept total), parallel to the default abandoned-% series (refactored via generic per-field extractors; the abandoned-% fields are byte-identical, so the forecast + existing path are unchanged). Client: `insQueueMetric` state (persisted in prefs `cdr.ins.prefs.v2` as `queueMetric`), sub-selector handler + visibility toggle in `insRenderTrendChart_`, the `isQueues` branch parameterized by metric (% vs count formatting, conditional 5% line). Cache `insights:v13`->`v14` (+ all doc/comment refs synced; cache-version-sync green). Test extended (trend.metrics totalCalls/violations daily series; used `.join(',')` not deepEqual -- harness vm-realm arrays trip deepStrictEqual's prototype check).
- **Consolidation status:** Phase 1 COMPLETE (gaps 1+2+3) -- Insights Queue health is now a strict data+chart superset of the QCD modal's per-dept view. REMAINING = Phase 2: the UX-model change (render Queue health regardless of agent selection -- owner already approved) + gaps 4-7 (heatmap, image/email export, QCD date-defaults/agent-free run, `#/report/qcd` routing/nav), then retire the QCD tab/modal/getQcdReport (keeping computeQcdReport_, getQcdAllDepartments, computeQcdSnapshots_, computeDeptQcdSnapshot_ -- all independent).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions; insights:v14 cache self-heals. Where I left off: Phase 1 fully shipped; Phase 2 is the next consolidation step (start with the agent-free Queue health render + gap 4 heatmap).

---

## Latest session (broad-implement: QCD->Insights consolidation Phase 1 — gaps 2 & 3 + My-Dept QCD card tooltip)
Branch `claude/broad-scan-je9ga7`. 192/192 tests pass, INV-16 in sync, script.html/dashboard.html braces balanced.
- **My-Dept QCD card tooltip (decision C):** the "Queue Call Data" side-card always shows the latest QCD day (computeDeptQcdSnapshot_ is range-independent -- QCD can update on a different day than DQE, and the range defaults to latest DQE, so anchoring avoids an empty card). Added a native tooltip + help cursor on the card title clarifying it's the most recent queue day, independent of the range. Client-only, committed `eb1a8f3`.
- **QCD->Insights consolidation Phase 1 (gaps 2 & 3 of the 7-gap parity list):** make Insights Queue health a DATA-superset of the QCD modal's tables.
  - **Gap 3 (daily table):** `insightsQueueHealth_` now returns `dailySeries` (the per-day QCD rows, dept-OWN queues, range-scoped); client renders a collapsed "Daily breakdown" `<details>` table in the Queue health section (`#ins-qh-daily`/`#ins-qh-daily-tbody`) via the new shared `qcdDailyRowsHtml_`.
  - **Gap 2 (bySource subtable):** `insightsQueueHealth_` perQueue rows now carry the full `bySource` array; Insights queue rows became expandable (chevron + detail row) showing the same per-call-source subtable the QCD modal shows, via the new shared `qcdSourceSubtableHtml_` (extracted from the QCD modal's inline block; QCD modal refactored to use it -- byte-identical output). Violation dates moved off the inline cell `<details>` into the row expand (QCD-modal parity).
  - Cache bumped `insights:v12`->`v13` (+ all doc/comment refs synced: InsightsReport.gs, architecture.md, known-issues.md table, conventions.md table, CLAUDE.md x3 incl. INV-30; cache-version-sync test green). insights-report.test.js extended (dailySeries + bySource pass-through assertions).
- **DEFERRED -- Gap 1 (tri-metric queue chart):** STOPPED & flagged per broad-implement rules. The Insights consolidated trend chart's "Abandoned % by Queue" tab is abandoned-%-specialized (5% threshold line, %-formatting throughout). Adding Total Calls / Violations per-queue needs: (a) generalizing that shared chart branch by metric, (b) server `trend` series for the 2 new metrics, and (c) a UX decision -- 3 extra top-level tabs vs a metric sub-selector within the queue view. Higher regression risk to the existing working tabs + a UX call that's the owner's. NOT started; awaiting direction on the UX shape.
- **Consolidation remaining after Phase 1:** Gap 1 (above) finishes the data/chart superset. Phase 2 = the UX-model decision (render Queue health regardless of agent selection -- owner ALREADY approved) + gaps 4-7 (heatmap, export, date-defaults, `#/report/qcd` routing), then retire the QCD tab/modal/getQcdReport (keeping computeQcdReport_, the all-dept report, and both snapshot paths -- all independent).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions; insights:v13 cache self-heals. Where I left off: Phase 1 gaps 2&3 shipped; gap 1 awaiting the tabs-vs-subselector UX decision.

---

## Latest session (broad-implement: P3 — My-Dept QCD snapshot own-canonical total)
Branch `claude/broad-scan-je9ga7`. 192/192 tests pass, INV-16 in sync, script.html braces balanced (parens -1 pre-existing on HEAD).
- **P3 (from this cycle's /broad-scan):** the My Department "Queue Call Data" snapshot's all-queues total folded sub-queue children in, contradicting the QCD modal + Overview (own-queues-only) -> same parent dept (Sales/Power/CSR) showed different dept-level violations/abandoned% across surfaces. FIX: `Data.gs::computeDeptQcdSnapshot_` now decomposes own (main) vs sub-queues; the UNQUALIFIED dept total (`totalCalls`/`abandonedPct`/`violations`) is OWN-only (reconciles cross-surface), with new `subTotals`/`allTotals` (null when no sub-queues) + `mainQueueCount`/`subQueueCount`. Client `renderDeptQcdSnapshot_` renders GATED carousel pages: Main queues (only >1 own), Sub-queues (separate depts) (only >1 sub), All queues (incl. sub-queues) (only when sub exist) -- single-queue depts unchanged. Cache bumped `summary:v9`->`v10` (+ all doc/comment refs synced: OrphanFix.gs, known-issues.md x2, conventions.md, architecture.md, CLAUDE.md INV-30/INV-51; cache-version-sync test green). Test `insights-report.test.js` updated to the own-canonical shape (+ sub/all/count assertions).
- **DEFERRED (follow-on, owner-flagged):** the QCD MODAL still shows only the own "Department total (own queues)" + separated child rows -- NOT a pre-summed All-queues row. Adding consistent Sub/All rows there needs a `computeQcdReport_` extension (per-group MTD violations via `computeMtdViolations_` + volume-weighted avgAnswer + max longestWait) + a `qcd:v9`->`v10` bump, which touches the shared engine Insights depends on -- out of proportion to the P3 defect, so split out. My-Dept fix alone removes the silent mismatch.
- **Consolidation context (no code):** earlier this session examined QCD Report -> Insights consolidation feasibility (shared `computeQcdReport_` engine; ~70% already in Insights Queue health; 7 UI-porting gaps, one M [tri-metric chart] + six S; UX decision = render Queue health regardless of agent selection, owner-approved). Not started.
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions. Where I left off: P3 shipped on branch; awaiting the QCD-modal-symmetry follow-on decision + the broader consolidation go-ahead.

---

## Latest session (feature build: #3 call-path drill-through + #5 onboarding tour)
Branch `claude/brave-dijkstra-wuonrv`. 136/136 tests, INV-16 in sync, divs/braces balanced.
- **#3 Inbound-call path drill-through** (commit 081491b): `InboundReport.gs::getCallJourney({callId,date,department})` returns one call's journey by (call_date, call_id); per-dept gated + scoped by `inboundDeptPredicate_` (manager only sees own-dept calls). Client "↳ path" button on abandoned 🚨 rings (Missed report + My Dept missed section) -> `#call-journey-overlay`, rendered via the reused Caller Lookup renderers (clChainHtml_/clJourneyRowHtml_). Scoped to abandoned calls (which carry a parent id); Insights/QCD aggregates don't expose per-call ids.
- **#5 Onboarding tour** (this commit): client-only coachmark walkthrough (`initTour_`/`startTour_` + `.tour-*` styles). Spotlight via box-shadow dim; 7 steps anchored to stable IDs (missing/hidden targets skipped); reduced-motion aware. Auto-runs once for first-time visitors (localStorage `cdr.tour.done`, Overview only) + replayable from Help -> Guided tour.

DEFERRED still: workday-ALIGN the prior window (vs flag-only); Escalations Phase 2 (team-tools queue); inbound-journey drill for Insights/QCD (no per-call id there). DEPLOY: Department Dashboard only (#3 + #5). #3 needs a live Neon smoke test (abandoned ring -> ↳ path -> journey renders).

---

## Latest session (feature build: working-day mismatch flag + Escalations + View-as)
Branch `claude/brave-dijkstra-wuonrv`. 136/136 tests pass, INV-16 in sync, divs/braces balanced.
- **A — Working-day mismatch flag** (commit f5688b0): shared `Util.countWorkingDays_`; CR + Insights flag on Mon-Fri days not calendar days (no more false mismatch on equal-workday windows). Holidays deferred (no global source). Cache bumps compareRanges:v6 / insights:v12 + INV-30/INV-35 + tests.
- **B — Escalations module Phase 1** (commit 9ec3b62): Neon `escalations` table; `Escalations.gs` (getEscalationsInit/getEscalations read, createEscalation admin-only, resolveEscalation/updateEscalationComment = the FIRST per-dept non-admin write path, INV-55). Header tab + modal, admin-only create form, pending/completed filter, mandatory-resolution UX. Deploy-verified (JDBC; no unit harness). Needs dashboard NEON_* + script.external_request.
- **C — View-as-Manager** (this commit): admin "View as <dept>" header control; `getCompanyOverview(req.viewAsDept)` personalizes as a synthetic manager (admins only, safe — only hides); `body[data-view-as]` CSS hides admin chrome; dept selector pinned; SWR cache bypassed in preview. No INV-30 bump (post-cache personalization).

DEFERRED (decided but not built this session): inbound-journey drill-through for abandoned calls (#3, ready); onboarding tutorial (#5, ready); workday-ALIGN the prior window itself (vs just the flag); Escalations Phase 2 (team-tools pending_review queue). DEPLOY: Department Dashboard (all three) + cdr-report (none) -- A/C dashboard-only, B dashboard-only. Escalations + View-as need a live Neon/deploy smoke test.

---

## Latest session (broad-implement: Tier 2 — F25, F13, F12, F9, F11)
Branch `claude/brave-dijkstra-wuonrv`. 135/135 tests pass, INV-16 in sync.
- **F25** dashboardCDR.js: `idxOr` helper (fixes the `|| dflt` index-0 trap) + a warning logging any missing/renamed CDR Historical Data list-columns that would otherwise silently report a metric as zero. Detection only; aggregation unchanged.
- **F13** Auth.gs `getManagerDepartment_`: scans all Access Control rows and logs a warning when a manager matches >1 dept (only the first is honored — managers are pinned to one dept). Behavior unchanged for single-row managers; makes the truncation detectable.
- **F12** InsightsReport.gs + script.html: new `meta.priorOverlap` flags a CUSTOM prior window overlapping the current range (overlapping days count toward current only); client renders an inline "Windows overlap" caveat. Cache bumped `insights:v10`→`v11` (response shape change) + doc sync. New regression test.
- **F9** buildDQEHistoricalData.js (BOTH copies, byte-identical): counts queue legs whose START_TIME is present-but-unparseable (dropped from in-window counts) and surfaces the count in the final `buildDQE` Pipeline Health note — was silent shrinkage on a CDR format drift.
- **F11** OrphanFix.gs `renameAgentInNeon_`: wraps the rename in an explicit transaction (atomic, rollback on error) and computes the conflict-skip count EXACTLY (rows still under the orphan name after the rename) instead of a racy pre-count subtraction.
Deploy: Department Dashboard (F12/F13/F11) + cdr-report (F25/F9) + cdr-import (F9). No blocking operator actions.

---

## Latest session (broad-implement: Tier 1 observability — F5, F6, F8, F29; F7 deferred)
Branch `claude/brave-dijkstra-wuonrv`. 134/134 tests pass, INV-16 in sync.
- **F29** NeonRead.gs + NeonKeepWarm.gs: `getDashboardNeonConn_(opts)` gains `skipReadHealth`; keep-warm passes it so a warm-ping failure no longer writes the DQE read-back failure streak (was a sticky false "read-back FAILING" on the sheet path).
- **F5** autoImport.js + CompanyOverview.gs: the integrated `:DQE` block now logs a rows:0 `success` row on a no-op build (already-in-history / no new data / F2 refusal), so "ran-empty" is distinct from "didn't run"/"failed". `computeOverviewPipelineFreshness_` now requires `rows>0` so a no-op can't falsely reset the 36h staleness clock.
- **F6** Data.gs `getLatestDataDates`: only caches a result computed WITHOUT a thrown error (was pinning a null/partial freshness blob for the full TTL on a transient read error).
- **F8** InsightsReport.gs + script.html: `insightsQueueHealth_` returns `{error:true}` on a genuine compute error (vs `null` for unmapped / missing-QCD-sheet, both benign); client renders a "Queue health unavailable" note instead of silently hiding. Missing-sheet pre-check keeps fresh installs benign (pinned by the existing test).
- **F7 DEFERRED**: on close reading the admin-facing detection already exists (`recordNeonReadFailure_` fires on every Neon read-error path; surfaced by the read-back health line) and gross staleness is caught by the 36h pill. The only residual is a MANAGER-facing "served from sheet fallback" banner = M-scope product UX across all report headers; deferred, not forced.
Deploy: Department Dashboard (F5/F6/F8/F29) + cdr-import (F5). No blocking operator actions.

---

## Latest session (broad-implement: F1–F4, F10, F24)
Branch `claude/brave-dijkstra-wuonrv`. Implemented six broad-scan findings; 134/134 tests pass, INV-16 in sync.
- **F1** InsightsReport.gs: `meta.rosterAgentCount` now = roster members ACTIVE in the current window (INV-27), not all selected roster. `queueOnlyAgentCount` derived independently. Cache bumped `insights:v9`→`v10` (+ doc sync in CLAUDE.md/known-issues/conventions/architecture). New regression test added.
- **F2** buildDQEHistoricalData.js (BOTH copies, byte-identical) + autoImport.js: build refuses to write when `opts.expectedDate` (the importer's date) ≠ Raw-Data-derived date; daily + bulk call sites pass `expectedDate: dateObj`. Standalone trigger unaffected (no opts).
- **F3** NeonMirror.js: deferred DQE mirror now routes abandoned cols 29-31 through a local byte-identical `sanitizeAbandonedCellForNeon_` (+ `#REBUILD` sentinel) — matches neonbackfill.js.
- **F4** Alerts.gs + script.html: invalid-threshold dept rows no longer silently dropped — flagged `invalidThreshold`, logged as `error` Alert Log rows, drift-skipped, and shown as "⚠ invalid" in the modal config table.
- **F10** script.html: shared `reportReqSeq` stale-response guard on all 6 IR/PR/CR/Insights fetch sites (button always resets; render skipped if superseded).
- **F24** DQEdrilldown.js: drill-down canonicalizes Raw Data col-L names via `loadRosterCanonicalNames_` before matching the canonical DQE agent name.
Deploy: Department Dashboard (F1/F4/F10) + cdr-import (F2/F3) + cdr-report (F2/F24). No blocking operator actions; insights cache self-heals on deploy.

---


**Branch:** `claude/dazzling-heisenberg-2png1z` · working tree has uncommitted design Phase 1 changes
**Verify on resume:** `node --test` (132 pass) + `bash scripts/check-duplicated-files.sh` (INV-16 in sync)

> Prior session's F1–F6 bug-fix work was **merged via PR #83** (commit `06639f5`),
> so the earlier "not yet committed" note is superseded. This is a new work-stream:
> the Claude Design package redesign (`docs/design-package/`), planning + Phase 1.

## What shipped this session (NOT yet committed/pushed)
Design-package planning + **Phase 1 foundation** (additive, zero behavioral change):
- **Plan of record:** `docs/design-update-plan.md` — full conflict register (C1–C8),
  decisions, and the phased sequence. Decisions: keep `--r:2px` (C1-A), binary
  thresholds only (C2-A), keep `data-mode` dark (C3-A), chart factory yes / SRI-restore
  no (C4-A), wire to `getDepartmentSummary` not `computeSummary_` (C5), adopt SWR with
  per-viewer guardrails (C6-A), consolidation parked (C7), nav deferred (C8-A).

**Separate work-stream this session (NOT redesign):** added a DQE Historical Data TZ repair to
`cdr-report/sheetRepairs.js` — `previewDqeOldPstTimestampShift()` / `repairDqeOldPstTimestampShift()`.
Old rows (Date < 2026-03-09) stored slot/AF missed-times in PST; current pipeline stores CST (+2h).
Repair shifts K-AC (11-29) + AF (32) time-of-day strings +7200s, date-gated AND per-row PST-window
validated (re-run safe; skips already-CST/mixed/anomaly rows), AF follows the row's slot decision
(skips #REBUILD sentinel + non-time tokens), surgical per-row writes + plain-text lock. Fixes the
Missed Calls report (it buckets by parsing the stored time; old PST values mis-bucket / drop off the
8AM-5PM CST chart). Does NOT touch durations (TTT/ATT/AvgAbdWait) or counts. node --check clean;
core shift/window math sanity-checked. NEEDS: deploy cdr-report (`clasp push -f`), run preview ->
apply from the editor, then backfillDQEHistoryUpsert() if Neon mirror is consumed. NOT in the Node
suite (SpreadsheetApp-bound, like the existing two repairs).
  - **Follow-up (AF coercion ownership):** `repairDqeSlotTimestamps_` now recovers coerced
    time cells in BOTH K-AC (11-29) AND AF (32) — AF holds the same H:MM:SS strings and
    coerces to time serials identically; the slot repair previously skipped it. Correspondingly
    `repairDqeAbandonedIds_` narrowed to AD/AE (30-31): it was mis-marking coerced single AF
    times as "#REBUILD" (a fractional serial fails Number.isSafeInteger). CAVEAT: if anyone ran
    the OLD 3-col `repairDqeAbandonedIds()`, some single AF times may already be wrongly
    "#REBUILD" (serial overwritten → unrecoverable from the cell; needs a Raw Data rebuild).
    DOC: CLAUDE.md number-coercion gotcha still says repairDqeAbandonedIds handles "AD-AF" — /sync-docs.
- **Phase 1 / Part 1 — tokens** (`styles.html` `:root`): added `--r-sm/--r-lg/--r-pill`,
  `--shadow-1/2/modal`, `--ease/--dur-1..3/--stagger`. **`--r` LEFT at 2px** (decision C1).
- **Phase 1 / Part 2 — component layer** (`styles.html`, new block before `</style>`):
  `.is-good/.is-warn/.is-bad` status helpers + 8 `ds-*` components (kicker/section,
  chip/delta, KPI tile, status-rail card, table+bar, banner, toolbar/seg, modal shell).
  Net-new `ds-` namespace (verified collision-free); NOTHING references them yet, so
  the live app renders byte-identically. Static (no animation — that's Phase 2).

Tests: 132/132 pass; whole-file CSS brace balance 860/860; INV-16 untouched. No invariants at risk.

## OPEN / next steps
1. **Commit + push** the Phase 1 CSS + `docs/design-update-plan.md` to this branch (not yet done).
2. **Deploy (only when ready):** Department Dashboard `clasp push -f` + new deployment version.
   Inert until markup uses the classes, so deploy is non-urgent / non-blocking.
3. **Phase 1 / Part 3 — DONE (contained proof):** Insights team-rollup KPI tiles
   migrated onto `ds-*`. New Insights-only `insKpiTileDs_` (script.html) emits `.ds-kpi`
   markup; the four `prKpiTile_` calls in `insRenderReport_` swapped to it. Behavior
   identical (same valence→color map, same binary `benchValueCls_` 92%/5% tint, shared
   `irSparkline_`). Performance Report's `prKpiTile_` untouched; shared `reportHeadline_`
   (used by all reports) intentionally NOT migrated. `.ds-kpi__spark` height nudged
   20→22px so the 70×22 sparkline isn't clipped. **Live visual verify still pending**
   (manual S37 post-deploy — can't run Apps Script here).
   - **Increment 2 (DONE):** Insights queue-health per-queue table migrated to `.ds-table`
     inside a `.ds-card` (dashboard.html) — the card supplies the chrome ds-table omits.
     Contained to that one table; QCD's own `.qcd-source-table` instances untouched; no
     JS references it (`.num`/`.qcd-warn-*` classes stay harmless). Tbody row builder
     unchanged. Whole-file divs balanced 608/608.
   - **Increment 3 (DONE):** Insights length-mismatch warning → `.ds-banner is-warn`
     (badge + text). dashboard.html class swap (`cr-length-warning`→`ds-banner is-warn`,
     contained — CR's own `.cr-length-warning` untouched) + `insRenderLengthWarning_`
     restructured to emit `ds-banner__badge` ("Heads up") + a text `<div>`; warning copy
     verbatim. Demonstrates the banner component (a new one). NOTE: the at-a-glance
     headline still can't use ds-banner cleanly — it's the SHARED `reportHeadline_`.
   - **Agent cards → `ds-card--rail`: DEFERRED on purpose.** They ALREADY use a left-border
     classification rail (`.ins-card-improved/regressed/mixed` = accent/warn/muted), so a
     ds-card--rail migration is ~zero visual gain but high unverifiable risk (padding/layout
     preservation, drill-through, cards⇄chart toggle, collapsible details). Recommend doing
     it only alongside a live before/after, or skipping (the existing rail already matches
     the target look). Queue-health KPI tiles (inboundKpiTile_) remain a safe-but-quirky
     option (bench-tint-on-cap + pr-delta badges to preserve).
4. **/sync-docs:** add a CLAUDE.md note for the new `ds-*` component layer + radius scale
   under CSS conventions (currently only `docs/design-update-plan.md` documents it).
5. **Later phases (planned, not started):** Phase 2 (loaders + motion + `.ds-state` kit +
   SWR Overview, per-viewer keyed), Phase 3 (chart factory + graceful fallback +
   debounce/token on date edits). Held for sign-off: C7 consolidation, C8 nav restructure.

## Post-merge increments (Phase 1 + sheetRepairs merged to main via PR #84 + sync-docs PR)
- **Phase 1 eyeball-verified by the operator** (deployed; Insights ds-kpi tiles + ds-table +
  ds-banner confirmed). Phase 1 is DONE.
- **Increment 4 (DONE — first cross-report shared component):** promoted the Insights-only
  `insKpiTileDs_` to a SHARED `dsKpiTile_` and migrated the **Performance Report** rollup tiles
  onto it (6 `prKpiTile_` calls → `dsKpiTile_`); the dead `prKpiTile_` function was removed
  (two history breadcrumbs + two stale comments updated to `dsKpiTile_`). Now used by Insights (4)
  + PR (6) = 10 callsites, one definition. Behavior identical (same valence map, binary
  benchValueCls_ 92%/5% tint, shared irSparkline_). `.pr-kpi-tile`/`.pr-delta` CSS untouched
  (still used by `inboundKpiTile_` + a CR tile site). Live visual verify = scenario S14 (PR) +
  S37 (Insights) post-deploy. tests 132/132; INV-16 in sync; JS `node --check` clean.

- **Increment 5 (DONE):** Compare Ranges length-mismatch banner → `.ds-banner is-warn`
  (mirrors Insights Increment 3). dashboard.html class swap on `#cr-length-warning`
  (`cr-length-warning`→`ds-banner is-warn`, id kept); `crRenderLengthWarning_` restructured to
  `ds-banner__badge` ("Heads up") + text `<div>`, copy verbatim; the now-dead `.cr-length-warning`
  CSS removed (CR was its last user after Insights migrated). INV-35 logic (form hint / KPI
  captions / CSV) untouched. tests 132/132; CSS braces 858/858; JS clean. Live verify: S18 (CR
  length-mismatch) post-deploy.

- **Increment 6 (DONE — includes a prod-regression FIX):**
  (a) **FIX:** the `ds-kpi` migration silently dropped the binary benchmark tint (benchValueCls_
  → `bm-target`/`bm-over`, the 92%/5% company standard) on KPI VALUES. Cause: the ds-* layer
  sits at the END of styles.html, AFTER `.bm-target`/`.bm-over`, so `.ds-kpi__value`'s explicit
  `color:var(--ink)` won the cascade (legacy `.pr-kpi-value` sat BEFORE `.bm-target`, so it never
  needed this). Added two-class overrides `.ds-kpi__value.bm-target/.bm-over` (+ `__foot`) so the
  tint wins regardless of order. **This was already in prod** on the merged Insights KPI tiles
  (PR #84) — subtle (value not green/orange) so the eyeball pass missed it. Restores it there +
  on the PR tiles (this branch).
  (b) **Migrate:** `inboundKpiTile_` (label, value, cap, deltaHtml) → `.ds-kpi` markup — converts
  BOTH the Inbound report KPI row AND the Insights queue-health tiles. Value/cap/delta preserved;
  cap bench tint preserved via the (a) fix; dropped the literal "vs prior" (the delta pill conveys
  it). `.pr-kpi-tile`/`.pr-delta` CSS still used by the CR-team + QCD tile renderers (not migrated).
  tests 132/132; CSS braces 860/860; JS clean. Live verify: S38 (Inbound) + S37 (Insights qh) +
  re-check 92%/5% tint shows on IR/PR/Insights KPI values, post-deploy.

- **Increment 7 (DONE):** QCD KPI tiles (`qcdRenderKpiTiles_`) → `.ds-kpi`. label + value only
  (no delta/spark/caption); the two warn-coded tiles (Abandoned % ≥5, Violations MTD >0) now tint
  the VALUE via the ds-* status mechanism (`ds-kpi--status is-warn` → `.ds-kpi__value` reads
  `var(--status)`; specificity-safe). Minor visual refinement: legacy `pr-delta-neg` gave the value
  a warn-soft BACKGROUND block; ds tints the text only — which matches how abandon-%/bench tints
  render on every other report (consistency, not regression). tests 132/132; JS clean; INV-16 in
  sync. Remaining `.pr-kpi-tile` renderer: CR team tiles (script.html:7956) — bigger (per-day
  caption + "(P1)" badge), left for a focused next increment. IR tiles (`irKpiTile`) are the most
  complex (team-comparison + share + prior). Live verify: S32 (QCD) post-deploy.
- **Increment 8 (DONE — milestone: all simple KPI tiles on ds-kpi):** Compare Ranges team tiles
  (`crTeamTile_`) → `.ds-kpi`. Badge → `ds-kpi__top`; value keeps `benchValueCls_` (tint preserved
  by #85's override); the "vs <prev> (P1)" comparison → `ds-kpi__foot`; the conditional per-day
  caption stays as its nested `.pr-kpi-perday` line. NO more `pr-kpi-tile` emitters remain — every
  simple KPI-tile renderer (PR/Insights/Inbound/QCD/CR + Insights queue-health) is on ds-kpi. IR's
  richer `ir-kpi-tile` (team-avg marker + share + prior) is intentionally NOT migrated. The
  `.pr-kpi-tile`/`.pr-kpi-value`/etc. CSS is now likely dead but LEFT in place (separate cleanup
  sweep; `.pr-delta*` + `.pr-kpi-perday` are still used). tests 132/132; JS clean; INV-16 in sync.
  Live verify: S17/S18 (Compare Ranges) post-deploy. On branch `claude/ds-cr-team-tiles` off main
  (#85 merged).

- **Increment 9 (DONE — cleanup + 2 migration-regression fixes):** retired the dead `.pr-kpi-*`
  sub-class CSS (`.pr-kpi-tile`/`-row-top`/`-spark`/`-label`/`-value`/`-delta`) after every tile
  moved to `.ds-kpi`; kept `.pr-kpi-row` (grid container) + `.pr-delta*` badges + `.pr-kpi-perday`.
  PLUS two regressions the tile migration had silently introduced, surfaced by the cleanup audit:
  (1) metric-glossary applier targeted `.pr-kpi-label` → repointed to `.ds-kpi__label` so KPI-label
  hover definitions work again; (2) the 3 print page-break selectors targeted `.pr-kpi-tile` →
  repointed to `.ds-kpi` so tiles avoid page-breaks in print/export again. tests 132/132; CSS braces
  854/854; JS clean; INV-16 in sync. Live verify: hover a KPI label (tooltip) + Print/Export any
  report with tiles. Branch claude/ds-prkpi-cleanup off main (#86 merged).


- **Increment 10 (DONE — Phase 2 kickoff):** restyled the no-data empty-state to the ds-state
  "no-data" tone (soft rounded icon TILE + display headline + muted sentence), CSS-only. Class
  names kept (`.empty-state`/`-icon`/`-title`/`-hint`), so the shared `emptyStateHtml_` helper AND
  the 7 static empty/unavailable surfaces (dept / QCD x2 / Inbound-unavailable / Caller-Lookup x3)
  pick it up with ZERO markup/JS change. Chose this over renaming to `.ds-state` because the class
  is deeply embedded (helper + 7 static elements + the reportHeadline_ anchor check) and several
  states (Neon-down, Caller Lookup) are hard to trigger/verify. The `.status-*` inline banners +
  error/loading/permission tones stay as-is (a fuller ds-state unification is a larger future
  effort). tests 132/132; CSS braces 854/854; INV-16 in sync. Live verify: any empty-date-range
  report (Missed/Individual/QCD) shows the new icon-tile empty state. Branch claude/ds-empty-state.

- **Increments 11–17 (DONE — merged via PRs #87–#96, not individually logged here):**
  the operator-feedback + Phase 2 polish wave: at-a-glance headline TONED banner
  (`headlineTone_` + per-report `*Headline_` composers, 92%/5% good/warn/neutral);
  Insights length-mismatch demoted from a banner to a compact `.ds-note`; glossary
  circled-ⓘ indicator (`.gloss::after`) + styled `.ds-tooltip` replacing the
  unstyleable native `title=` on hover; symmetric `benchValueCls_` so KPI VALUES (not
  just chips) tint on both sides of the 92%/5% standard; date-range autocorrect
  (`linkDateRange_` — End snaps to Start when Start passes End); modal entrance motion
  (`ds-modal-rise`, keyed off `aria-hidden`); inline equalizer busy-indicator
  (`.ds-loader--eq`); Overview stale-while-revalidate cache (`OV_CACHE_KEY_`, per-viewer
  keyed). All behind the additive ds-* layer / CSS-only where possible; CLAUDE.md +
  README synced.

- **Increment 18 (DONE — Part 4 chart graceful fallback):** wrapped all 13 `new Chart(`
  callsites in `safeChart_(target, config)` (script.html). Common path is provably
  unchanged — when `Chart` is defined it's a transparent pass-through to
  `new Chart(target, config)`; ONLY when the global is missing (blocked/failed Chart.js
  CDN, SRI mismatch) does `chartUnavailable_` hide the canvas and insert an idempotent
  `.ds-note.ds-chart-unavailable` message ("Chart unavailable — … numbers above are
  unaffected"). Scoped strictly to the CDN-absent case; does NOT try/catch per-chart
  render errors (that would alter happy-path control flow). `chartUnavailable_` resolves
  the canvas from either a 2d-context target (`.canvas`) or a canvas element. tests
  132/132; JS `node --check` clean; INV-16 in sync. Live verify: block the Chart.js CDN
  in devtools → any report's chart slot shows the inline note, KPIs/tables still render.
  Branch `claude/ds-chart-fallback` off main (#96 merged).

- **Increment 19 (DONE — Part 5 #3 / C5: debounce + stale-token on My Dept date edits):**
  the two `from-date`/`to-date` `change` handlers fired `refresh()` synchronously, and the
  `linkDateRange_` autocorrect (registered LATER via `initDateRangeLinks_`) ran after that
  refresh on the same event — so a `from > to` edit fired one wasted `getDepartmentSummary`
  before the swap. Added a generic trailing-edge `debounce_(fn, ms)` and a monotonic
  `summaryReqSeq` token. Date edits now go through `refreshOnDateEdit_ = debounce_(refresh,
  350)` (rapid typing/arrow presses coalesce to one request; the 350ms trailing call reads
  the values AFTER autocorrect ran). `refresh()` captures `myToken = ++summaryReqSeq` and its
  success/failure handlers drop stale responses (`token !== summaryReqSeq`) so a slower earlier
  request can't clobber a newer one. Scoped to the date-edit path; refresh-btn / dept-switch /
  preset callers still fire `refresh()` directly (single deliberate fires), but they ALSO benefit
  from the stale-token guard. Wired to the PUBLIC `getDepartmentSummary` (C5 — not the private
  `computeSummary_` the design sample referenced). tests 132/132; JS `node --check` clean; INV-16
  in sync. Live verify: type a from-date past the to-date → no flash of empty data, ends on the
  corrected range; spam date edits → only the final range paints. Branch `claude/ds-summary-debounce`.

- **Increment 20 (DONE — verification-pass refinements A, #101):** (1) Insights
  "Different window lengths" caveat moved out of its standalone ds-note banner INLINE
  into the "Comparing against …" line as a warn glyph + bold label, explanation now in a
  hover tooltip (`insLengthFlagHtml_`, `.gloss` → styled ds-tooltip). (2) Insights headline
  status tone neutralized when the two comparison windows differ by > 7 days (apples-to-oranges
  → no false green/orange banner; sentences still render). (3) Glossary circled-ⓘ
  (`.gloss::after`) now hidden by default, fades in on hover/focus (opacity, space reserved so
  no layout shift). tests 132/132; CSS 895/895.

- **Increment 21 (DONE — verification-pass refinements B):** (4) Universal floating Help
  FAB (`#help-fab`, circled "?", fixed bottom-right, z-index 150 so it sits over report modals;
  `#help-modal` lifted to z-index 200 so Help opened from the FAB renders above an already-open
  report modal). Opens the same `#help-modal` as the header "?"; tucked away while Help itself is
  open; hide-able via a new Settings toggle (`#help-fab-toggle`, localStorage `cdr.help.fab`).
  (5) Modal entrance motion smoothed (rise/fade `--dur-2` 200ms → `--dur-3` 360ms, translateY
  10→14px). (6) Inline equalizer (`DS_EQ_HTML_`) now shows on report-fetch buttons — the
  IR/PR/CR "Loading…" and Ins/QCD "Generating…" busy states swap textContent for innerHTML with
  the `.ds-loader--eq` span; restore paths set textContent back (clears it). tests 132/132; CSS
  903/903; divs 608/608. Branch `claude/help-fab-motion`.

- **Increment 22 (DONE — rich tooltips, #103):** styled glossary tooltip gained a
  theme-matching accent border (`var(--accent)`), and high-value terms render a rich variant
  (`METRIC_GLOSSARY_RICH_`): bold title + def + benchmark chip surfacing the 92%/5% standards
  (% answered → green "≥92%"; Abandoned %/Violations → warn "≥5%"; ATT → per-call note).
  innerHTML from dev constants only; plain title kept for SR; `show()` prefers `data-gloss-rich`
  + toggles `.ds-tooltip--rich`. CSS 908/908; tests 132/132.

- **Increment 23 (DONE — Phase 4: IR KPI tile → ds-kpi, user chose "extend then migrate"):**
  extended the shared `ds-kpi` component with the three sub-features that had kept the Individual
  Report tile on its own `ir-kpi-*` dialect: `.ds-kpi__value-row` + `.ds-kpi__share` (inline
  share-of-dept tag), `.ds-kpi__compare` + `.ds-kpi__team` (the "Team X" average-comparison
  marker row), `.ds-kpi__prior` (the INV-49 vs-prior row), `.ds-kpi__spark--inline` (top-row
  spark), and a `.ds-kpi--ir` density modifier that preserves IR's 26px value sizing (5-up grid).
  `irKpiTile` + both `irPriorRow_` returns rewritten onto ds-kpi; the copy-TSV handler repointed
  to `.ds-kpi`/`__label`/`__value`/`.ds-kpi__compare .ds-kpi__team`/`__share`; glossary selector
  dropped the now-unused `.ir-kpi-label` (`.ds-kpi__label` already covered). Bonus: IR KPI labels
  now pick up the rich tooltips. `.ir-kpi-grid` (layout container) kept; the dead `.ir-kpi-*` tile
  CSS left for a cleanup follow-up (increment-9 pattern). Pure client UI — no cache/aggregation/
  invariant impact. tests 132/132; CSS 917/917; JS clean. Branch `claude/ir-tile-dskpi`. Per-agent
  rail-card migration is the remaining Phase 4 item. Live verify: S11/S12 (Individual Report) +
  the per-tile "Copy" TSV.

- **Increment 24 (DONE — verification-pass fixes):** (1) IR "All at once" chart toggle: the
  `.ir-tabs-allmode .ir-tab { pointer-events: none }` CSS (plus the JS `return` on tab clicks in
  all-mode) trapped the user in all-mode — the only exit was a second toggle click. Removed the
  pointer-events block (tabs stay dimmed 0.5 but clickable) and changed the click handler so a
  specific-tab click exits all-mode and jumps to that chart. Relabeled the button "All at once" →
  "ALL". (2) Insights "Team Insights": `buildTeamInsights_` gains an optional
  `opts.excludeVolume` that drops the raw cumulative-volume insights (answered/missed counts) —
  not comparable across windows of different lengths — while keeping the length-independent ones
  (answer rate %, avg talk time per-call). The Insights caller passes `{excludeVolume:
  lengthMismatch}` (INV-35). PR (never mismatches, INV-28) and CR callers pass nothing →
  unchanged; new unit test pins both modes. tests 133/133; CSS 917/917; JS clean. Branch
  `claude/ir-charttabs-insights-volume`. NOTE: CR also calls buildTeamInsights_ and CAN mismatch —
  a candidate same-fix follow-up (left out to stay scoped to the operator's Insights request).

- **Increment 25 (DONE — Phase 4: per-agent cards → ds-card--rail):** migrated BOTH per-agent card
  surfaces onto the shared `ds-card--rail` (4px left status rail colored via inline `--status`).
  Insights cards (`insBuildCard_`): improved=accent / regressed=warn / mixed=muted / floater=warn;
  retired `.ins-card-improved/regressed/mixed/floater` + the `.ins-card` border-left (`.ins-card`
  keeps padding as the print/layout hook). CR cards (`crBuildCard_`): improved/regressed/mixed →
  `--status`; retired `.cr-card-*` + the `.cr-agent-card` border chrome (kept padding). `.ds-card`
  now supplies border/radius(r-lg)/shadow-1/bg for both; print rules (`.ins-card`/`.cr-agent-card`
  page-break-inside) + `.cr-quiet-details .cr-agent-card` opacity hook unaffected (classes kept).
  Pure client UI — no cache/aggregation/invariant impact. tests 133/133; CSS 910/910; JS clean.
  Branch `claude/ds-rail-cards`. This was the last headline Phase 4 item. Remaining: `.ir-kpi-*` +
  the just-retired card dialect dead-CSS cleanup sweep; optional CR volume-insight gating;
  `/sync-docs` pass. Live verify: S12 (Insights peer cards) + S19 (CR agent cards) — rail colors
  match direction; floaters warn; print/quiet-collapse intact.

## Where I left off
Phase 1 confirmed in prod by the operator. Continued report-by-report migration with
`/broad-implement` rigor: Increment 4 promoted the KPI tile to a shared `dsKpiTile_` and moved the
Performance Report onto it (first ds-* component shared across two reports — the consolidation
thesis realized). Tests green, syntax clean. Next candidates: migrate another report surface (CR
length-warning → ds-banner is low-risk; remaining Insights/PR surfaces), or start Phase 2/3 quick
wins. Still deferred/decision-gated: per-agent cards → ds-card--rail (high risk), at-a-glance
headline → ds-banner (shared reportHeadline_ decision), C7 consolidation, C8 nav.
PRIOR CONTEXT (still valid):
Also confirmed access control: non-manager/non-admin domain users land on access-denied with zero
data (Code.gs doGet + per-RPC re-auth); out-of-domain users can't reach the app. Awaiting
commit/push/deploy direction.

- **Increment 26 (DONE — redesign closeout, part 1):** (a) CR volume-insight gating: applied the
  #105 `excludeVolume` fix to Compare Ranges — relocated its `buildTeamInsights_` call to AFTER
  `lengthMismatch` is computed and passed `{excludeVolume: lengthMismatch}`, so a different-length
  P1/P2 comparison drops the raw answered/missed-count insights (keeps answer rate % + ATT). (b)
  Dead-CSS sweep: removed the now-unused `.ir-kpi-tile/row-top/label/spark/value-row/value/share/
  row-bot/row-prior/team` rules left behind by the #104 ds-kpi migration (kept `.ir-kpi-grid`
  container + `.ir-spark-svg`). The `.ins-card-*` / `.cr-card-*` classification rules were already
  removed in #106. tests 133/133; CSS 900/900; JS clean. Branch `claude/cr-gating-irkpi-cleanup`.
  Remaining closeout: `/sync-docs` pass.

- **Increment 27 (NEW FEATURE — temporal abandon heatmap):** weekday × hour abandon-rate
  heatmap sourced from `inbound_calls`, in BOTH the Inbound report and the QCD report (companion).
  Server: `InboundReport.gs::getInboundHeatmap({department,from,to})` -- one json_agg round-trip
  aggregating abandon rate by `ISODOW × hour-slot`, reusing `inboundResolveRequest_` (admin-only
  vetting gate + per-dept scoping) + `inboundDeptPredicate_`; cache `inboundHeatmap:v1`. Client:
  shared `renderAbandonHeatmap_`/`loadAbandonHeatmap_` CSS-grid render (NO Chart.js dep), color
  pivots on the 5% standard (≤5% sage / >5% warm, `colorToCanvasRgb_` OKLCH-safe), low-volume
  (<3 calls) muted. Inbound: `#inbound-heatmap` always loads (report is admin-only). QCD:
  `#qcd-heatmap` companion, load gated by `USER.role==='admin'` (managers never hit the admin
  endpoint; opens to them when the inbound gate is later removed). **TZ:** `call_start` is raw PST;
  SQL shifts +2h (`INBOUND_HEATMAP_CST_SHIFT_HOURS`) to the dashboard CST frame -- single-constant
  knob, NEEDS LIVE SPOT-CHECK. tests 133/133; CSS 915/915; divs 610/610; JS clean; cache-version
  guard green. Branch `claude/abandon-heatmap`. No unit coverage (Neon SQL + client render, like
  the inbound report itself) -- verify via S38-style live check.

- **Increments 28–34 (DONE — My-Department polish + Pass-2 design update):** seven CI-green PRs,
  all client-only (no server compute / cache / metric / permission change).
  - #118 Missed Calls section on My Dept brought to full modal parity (shared
    `makeMissedBucketDetail_` factory; summary strip; radar drill-in; full-width stacked).
  - #119 Missed drill-in side-by-side (`.chart-row` grid + slide animation) + collapsible
    queue-only / per-agent `<details>` cards (shared builders → modal gets it too).
  - #120 Agent table: Answered/Missed stacked bar (folds Rung/Missed/Answered; E5 WoW chips
    inline; sorts by `answerRate`, idle agents sink) + foldable detail columns (`#dept-cols-toggle`,
    `cdr.dept.cols`). Default sort now answerRate asc.
  - #121 Queue Call Data card moved above the agent table (below date controls).
  - #122 `docs/design-update-pass2-review.md` — codebase validation of the Pass-2 proposal +
    owner decisions (A2 = ratify shipped green; C3 = honest single loader).
  - #123 **B1 change-flash**: `dsFlashChanged_` + `.ds-flash`; Overview SWR cache→live + My-Dept
    refresh flash only changed values (never first paint; reduced-motion aware).
  - #124 **A1 Insights triage**: "Needs attention" (regressed) → "On track" groups, regressed
    first; partitions a COPY (never `insLastData.agentData`), parity test green; A2 rail legend.
  - #125 **C1/C3 loaders**: signal-rings in Caller Lookup results; honest single cold-start bar on
    Overview boot (no faked stages). QCD kept its existing equalizer button.
  - #126 **D1a**: "Retry now" button on the Overview refresh-failing banner (Overview already kept
    cached data on error). **C2 dropped** (charts render synchronously — no real wait to fill).
  - #127 **E motion**: rail-card entrance fade+rise + status-rail grow-in (Insights/CR cards).
    Count-up / segment-slide / skeleton-crossfade deferred (touch value rendering / component
    re-arch / broad reveal rework).
  DEFERRED Pass-2 work-streams: D1b (reports keep-last-good on error), D2 (permission tone),
  F (digest redesign + onboarding/unmapped-queue), C2 (chart-slot spark). A3 heatmap +2h TZ is a
  LIVE SPOT-CHECK (not a code change). A1's optional "auto-collapse On-track past 4" trimmed.
  Where I left off: Pass-2 dashboard CSS/JS pass complete; awaiting user redeploy + the standing
  live verifications (heatmap colors/CST, Insights chip/rail, B1 flash, A1 triage).

- **Increments 35–39 (DONE — Phase 15 + deploy feedback + design packages + Tier 3):** all on
  branch `claude/brave-dijkstra-wuonrv`; merged via PRs #131, #132 (+ Tier 3 pushed, unmerged).
  - **Phase 15 (PR #131):** Missed Calls report per-agent timelines flipped to roster-only
    (`getMissedCallsReport` scope 'both'→'roster') to match the now-roster-only Agent Call Metrics
    table; queue-only abandoned section preserved (sentinels always included). Missed cards sort
    most-missed-first + cohort-relative severity tiers (`missedQuantile_`, gated <3 agents / max<3).
    Insights agent-card tier grouping made ALWAYS-ON (Needs attention / Mixed / Improving) instead
    of only-when-regressed. Docs synced (scope decision rewritten roster-only, conventions.md).
  - **My-Dept deploy-feedback polish (PR #132):** fixed the Missed radar render (was created while
    `#dept-missed-section` was display:none → zero-size canvas; now shown before chart build);
    QCD side card condensed + per-queue CAROUSEL (`renderDeptQcdSnapshot_`); container max-width
    1200→1440px.
  - **Escalations Pass 3b (PR #132):** §4 client filter (escLastResp_ copy), §5 append-only
    `escalation_activity` table with TRUE ATOMICITY (write paths refactored to
    `setAutoCommit(false)`+commit/rollback; activity row in same txn), §3 admin `updateEscalation`
    (pending-only), §2 `reopenEscalation` (reason required, retains resolved_*), §1 flag-gated
    `NOTIFY_ON_NEW_ESCALATION` full-detail email via `lookupDeptManagers_`. New endpoint
    `getEscalationActivity` (per-dept). INV-55 + Operator State #24 updated.
  - **Overview layout (PR #132):** STACKED layout — full-width sticky-top trend chart (CSS
    order:-1, position:sticky top:8px z-index:5; condense-on-scroll SKIPPED per user), 4-wide dept
    grid (responsive 4→2→1). P1 taken as HYBRID: sub-queue children stay as their own tiles (parent
    DQE metrics are independent — nesting would falsely imply aggregation). P2.4: chart defaults to
    top-level depts + `#ov-subq-toggle` ("+ sub-queues"). Spotlight preserved (name-based). Retired
    the documented #8 rail; comment + CLAUDE.md updated.
  - **Tier 3 (this /broad-implement, pushed `ddba6ba`, UNMERGED):** implemented ONLY the
    skeleton→content crossfade (Overview boot, `ovRevealBody_` + `.ov-body-in`, fires only when the
    loader was showing, reduced-motion no-op). DEFERRED the rest with rationale: D1b keep-last-good
    (doc's own separate larger item, 5 reports' distinct re-fetch models, IR already does it);
    holiday exclusion (needs holiday-source decision); condense-on-scroll (user explicitly skipped);
    count-up/segment-slide/chart-spark (fiddly/net-new/conflicts animation:false, low value);
    INV-42 THEME.bad (dead code, no consumer); D2 permission-tone (no real dead-ends per F11).
  STANDING OPERATOR ACTIONS (post-deploy): run `backfillEscalationActivity()` once; decide
  `NOTIFY_ON_NEW_ESCALATION` (PII); live spot-check a resolve/reopen (the §5 txn refactor) + the
  Overview sticky chart + QCD carousel. Tier-1 rollout levers still open (deferred Neon mirror,
  `DQE_READ_SOURCE=neon` cutover, uninstall `runDailyDQEBuild_` safety net, restore Inbound manager
  access). Where I left off: Tier 3 crossfade pushed to `claude/brave-dijkstra-wuonrv` (not yet
  PR'd); D1b (reports keep-last-good) is the recommended next focused task.

- **Increment 40 (DONE — D1b reports keep-last-good):** added a per-report last-good payload
  cache (localStorage) so a FAILED report fetch repaints the last good payload for the SAME
  request + a non-destructive `.status-warn` "couldn't refresh — showing the last loaded report"
  banner, instead of blanking to a hard error. Shared helpers in script.html (near `reportReqSeq`):
  `reportSig_` (agents-sorted JSON), `reportLastGoodWrite_`/`reportLastGoodRead_` (ONE entry per
  report, keyed per VIEWER via `reportLastGoodKey_`+USER.email per INV-39 spirit, matched by sig —
  department is in the sig so the per-dept entitlement boundary holds), `reportFailFallback_`,
  `reportSetStatus_`. Wired all 5 reports at every fetch call site: IR (generate + edit-apply),
  PR (generate), CR (generate + edit-apply), QCD (generate, wrapped repaint to clear the shared
  qcd-results-status), Inbound (generate, wrapped repaint to clear inbound-results-status). New
  `.status-warn` tone (warn-soft) in styles.html. Audit finding: the literal "blank on re-fetch"
  was ALREADY prevented (IR/CR edit-apply keep results; PR/QCD/Inbound only fetch from the form),
  so the real D1b value delivered is surviving a transient backend failure / reopen. SKIPPED the
  heavier paint-instantly-on-open SWR variant (follow-on). Pushed `claude/brave-dijkstra-wuonrv`,
  UNMERGED. node --test 136/136; JS + CSS balance checked. Where I left off: D1b pushed, awaiting
  PR/merge decision; remaining Tier-3 items still deferred (holidays/decision, count-up/segment/
  spark cosmetic, INV-42 dead-code, D2 low-value); Tier-1 operational rollouts still open.

- **Increment 41 (DONE — Direct-extension call metrics, Phase 1a):** NEW feature, owner-approved
  definitions in `docs/direct-extension-metrics-design.md`. Per-agent per-day metrics for
  direct/individual-extension calls (distinct from the queue DQE/QCD path) with the "missed while
  on another call" carve-out. NEW cdr-import-only file `directCallMetrics.js` (NOT INV-16
  duplicated): pure `computeDirectCallMetrics` two-pass engine (occupied/busy intervals from all
  talk legs incl. queue+outbound → classify each in-window inbound miss as missed_busy [overlaps
  another call's busy window + 5s wrap-up tail, ANY overlap] vs missed_free; hold counts as busy;
  internal/external split; answer-rate rings work-window-filtered 6:30-15:00 PST but busy
  detection isn't; outbound = activity only). 12 unit tests
  (`tests/unit/direct-call-metrics.test.js`). `Direct Call History` sheet + Neon
  `direct_call_history` mirror, both LAZILY created (no setup() change). Editor-run
  `runDirectCallBuild()` computes the current Raw Data day for spot-checking. **Phase 1b NOT done
  (deliberate):** the daily `processIntegratedHistory` is untouched — wire a best-effort block
  there only AFTER the operator validates the numbers. node --test 148/148 (12 new); INV-16 clean.
  Pushed `claude/brave-dijkstra-wuonrv`, UNMERGED. Where I left off: Phase 1a pushed; awaiting (a)
  PR/merge decision and (b) operator spot-check of `runDirectCallBuild()` output before Phase 1b
  (daily hook) + Phase 2 (dashboard modal). 5s tail = `DIRECT_BUSY_WRAPUP_SEC` (tunable).

- **Increment 42 (DONE — UI polish batch + Tracks A & B):** Deploy-testing feedback,
  multiple commits on `claude/brave-dijkstra-wuonrv` (UNMERGED past PR #137).
  CONCRETE FIXES (shipped): queue-only abandoned cards default-collapsed on a >2-day range;
  dept Missed radar deferred resize (CSR zero-size fix); Dept Config Save spinner; Overview
  viewer-dept folded into the grid as a highlighted first card (hero retired); sub-queue
  chips → expandable mini-card strips (Ans%/Abd/viol + WoW arrow, smooth height morph);
  Source column folded into "Show all columns"; WoW "what changed" agent callout removed
  from Overview cards (#4); inbound queue-name bridge (Dept Config `Inbound Queue Aliases`
  col + getInboundQueueAliases_ + inboundQueuesForDept_ union — per-dept Inbound report still
  admin-only/parked; un-gate later by populating aliases + removing the inboundResolveRequest_
  gate). **Track A (DONE):** Missed Calls bars/radar toggle (missedChartCfg_ dispatch, mode in
  localStorage cdr.missed.chartmode default bars), bar mode = horizontal + COLOR INTENSITY RAMP
  + peak outline + datalabels; toggle re-render guarded to visible charts. **Track B (DONE):**
  Escalations converted modal → full PAGE (body[data-page=escalations], setPage, route kind:'page';
  esc-* logic + Escalations.gs unchanged). node --test 162/162; INV-16 clean; script.html JS
  syntax-checked. PLAN doc `docs/ui-infra-roadmap.md` (Tracks A/B/C). **Track C NOT started**
  (config sheets → Neon; phased C2 Dept Config → C1 Access Control → C3 Alert/Digest; +15-min
  setup() hardening). Where I left off: Tracks A+B pushed UNMERGED; awaiting PR/merge decision;
  Track C deferred (owner approved the plan, build when ready); the transient setup() timeout the
  operator hit just needs a setup() re-run (creates Report Usage).

- **Increment 43 (DONE — setup() hardening + C2 Dept Config→Neon):** On
  `claude/brave-dijkstra-wuonrv` (UNMERGED). (1) `Setup.gs::setup()` now iterates
  the 9 managed-sheet specs in a try/catch + `SpreadsheetApp.flush()` loop, so a
  transient "Service Spreadsheets timed out" on one sheet logs + continues
  instead of aborting (the operator hit this — Dept Config created, Report Usage
  not). Idempotent re-run still completes. (2) **C2** (first config-sheet→Neon
  migration): `CONFIG_SOURCE` Script Property (default `sheet`) switches Dept
  Config read+write to the Neon `dept_config` table. `readDeptConfigRows_` split
  into `sheetReadDeptConfigRows_`/`neonReadDeptConfigRows_` (neon = one json_agg,
  sheet fallback on error); `upsertDeptConfigRow_`/`deactivateDeptConfig_` route
  to `neon*` variants when flagged; lazy `CREATE TABLE`; editor-run
  `backfillDeptConfigToNeon()` + `compareDeptConfigSources()` parity gate. List
  cols stored as comma-joined text → dcParseList_ parity exact. 4 new tests
  (`dept-config-neon.test.js`); node --test 166/166; INV-16 clean. Docs:
  Operator State #25, INV-54 note, roadmap C2 marked SHIPPED. Where I left off:
  pushed UNMERGED; C2 ships default-`sheet` (no behavior change until an admin
  backfills + parity-checks + flips CONFIG_SOURCE=neon). REMAINING Track C: C1
  Access Control (needs a NEW admin editor UI — hand-edited today, fail-closed
  on neon error), C3 Alert/Digest (need edit surfaces), C4 Agent Alias
  (cross-project). Branch carries the whole increment-42+43 batch, awaiting
  PR/merge decision.

- **Increment 44 (DONE — C1 Access Control editor + C3 Alert/Digest data layer):**
  On `claude/brave-dijkstra-wuonrv` (UNMERGED). **C1 (decision + editor):** Access
  Control is NOT moved to Neon -- auth is the hot path and the sheet (dashboard's
  own ss) is the most always-available store, so moving it would trade reliability
  for nothing. Instead shipped a sheet-backed admin editor (`Auth.gs`
  getAccessControlInit / saveAccessControlRow [upsert-by-email] /
  removeAccessControlRow [delete-by-email], all assertAdmin_ + validation +
  LockService + auth-cache bust; managers only -- admins are in ADMIN_EMAILS).
  Client Access modal + nav tab + route /admin/access-control. fakeSheet gained
  deleteRow. Tests access-control-editor.test.js (+7). **C3 (data layer only):**
  readAlertConfig_/readDigestConfig_ now read rows from the active source via
  alertConfigRawValues_/digestConfigRawValues_ (Neon alert_config/digest_config
  when CONFIG_SOURCE=neon, same flag as C2, sheet fallback on error, identical
  parse). Lazy tables + backfill{Alert,Digest}ConfigToNeon + compare*Sources
  parity. Tests config-neon-c3.test.js (+3). node --test 176/176; INV-16 clean.
  Docs: INV-01 (AC RPCs), Operator State #25 (C3 + C1 decision), roadmap C1/C3.
  Where I left off: pushed UNMERGED. **C3 NOT flippable yet** -- Alert/Digest are
  hand-edited, so CONFIG_SOURCE=neon needs admin EDIT UIs in the Alerts modal
  (the per-dept threshold/recipients table + the digest subscribers list) first;
  those UIs are the remaining C3 work. C4 (Agent Alias, cross-project) still open.
  Branch carries increments 42-44; awaiting PR/merge decision.

- **Increment 45 (DONE — C3 edit UIs; C3 now flippable):** On
  `claude/brave-dijkstra-wuonrv` (UNMERGED). Admin CRUD for Alert Config +
  Digest Config in the Alerts modal, writing the ACTIVE source (sheet, or Neon
  when CONFIG_SOURCE=neon -- same dispatch as C2). Server: Alerts.gs
  saveAlertConfigRow/removeAlertConfigRow (key=department) + Digest.gs
  saveDigestConfigRow/removeDigestConfigRow (key=email+dept), all assertAdmin_
  + validation + LockService + audit log + sheet/neon writers. Client: Actions
  (Edit/Remove) columns on both Alerts-modal config tables + add/edit forms
  (dashboard.html) wired in initAlerts, reload via alLoadInit_. Tests
  config-editor-c3.test.js (+7); node --test 183/183; INV-16 clean. Docs INV-01
  (4 new RPCs), Operator State #25 + roadmap (C3 SHIPPED + flippable). Where I
  left off: C3 fully shipped + flippable (backfill{Alert,Digest}ConfigToNeon ->
  compare{Alert,Digest}ConfigSources clean -> CONFIG_SOURCE=neon, one flag for
  Dept+Alert+Digest). REMAINING Track C: C4 Agent Alias Overrides (cross-project
  pipeline read -- optional). Branch carries increments 42-45; awaiting PR/merge.

- **Increment 46 (DONE — C4 evaluated, recommended AGAINST; Track C closed):**
  Doc-only. Agent Alias Overrides is read CROSS-PROJECT by the pipeline
  (loadRosterCanonicalNames_, line 938) in BOTH buildDQEHistoricalData.js copies
  (INV-16 byte-identical pair) + cdr-report/DQEdrilldown.js, on the daily-build
  canonicalization hot path; written only by the dashboard Orphan Fix modal
  (already UI-managed). Moving it to Neon would add a JDBC read + Neon-availability
  dependency to the daily build via a delicate two-file byte-identical edit, to
  retire ONE small rarely-edited sheet with no hand-edit pain to solve. Same call
  as C1: keep it on the sheet (the sheet is the right store for a pipeline-hot-path
  always-available read). Recorded the decision in docs/ui-infra-roadmap.md; NO
  code change. node --test 183/183 (unchanged). Where I left off: Track C closed
  -- C2 + C1 + C3 shipped (Dept/Alert/Digest Neon-flippable; Access Control +
  Agent Alias + logs stay sheet by design). Branch claude/brave-dijkstra-wuonrv
  carries increments 42-46, UNMERGED, awaiting PR/merge decision.

- **Increment 47 (DONE — Direct-call metrics Phase 1b + Phase 2):**
  Phase 1b: extracted the shared core `buildDirectCallFromRaw_(ss, rawDisp,
  configSheet, opts)` in cdr-import/directCallMetrics.js (sheet write +
  refresh-in-window + inline best-effort Neon mirror); refactored
  `runDirectCallBuild()` to call it; wired a 6th best-effort block into
  `processIntegratedHistory` (autoImport.js, after the DQE block) gated on
  rawDataSheet present, logging `processIntegratedHistory:Direct` Pipeline
  Health rows (agents/missedBusy/missedFree/neon in notes). cdr-import-only
  (NOT INV-16 duplicated). Phase 2: new DirectCallReport.gs
  (`getDirectCallReport`, ONE json_build_object Neon read; per-agent answer
  rate EXCLUDING the busy carve-out, inbound ATT, outbound activity+ATT,
  int/ext split; admin-only-while-vetted with the per-dept manager path kept
  intact like Inbound; cached directCall:v1, unavailable not cached). Client:
  Direct report tab (admin-only) + #direct-call-modal + route #/report/direct
  + CSV (dashboard.html + script.html, initDirectCallReport). Tests
  direct-call-report.test.js (+5; gate, derived rates, null-rate, unavailable).
  node --test 188/188; INV-16 clean. Docs: direct-extension-metrics-design.md
  (Phase 1b+2 SHIPPED). Where I left off: Phases 1b+2 done; report is sparse
  until history accrues. Operator: deploy dashboard + cdr-import; the import
  starts writing Direct Call History + direct_call_history automatically. INV-44
  step list + an INV for the Direct report are a sync-docs follow-up. Branch
  claude/brave-dijkstra-wuonrv carries increments 42-47, UNMERGED.

- **Increment 48 (DONE — Direct-call metrics Phase 3: bulk-backfill history):**
  Bulk path now builds Direct history for past dates (DQE skipNeon + end-pass
  upsert pattern). autoImport.js: histDateCache.direct (col B) + existsInDirect
  + willBuildDirect (its OWN gate, NOT willBuildDQE -- old dates with DQE but no
  Direct must still write Raw Data) + needsRawDataWrite widened; bulk branch
  builds the sheet per date via buildDirectCallFromRaw_({skipNeon:true}),
  unconditional (Option A, gated on willBuildDirect), logs bulkBackfill:Direct
  Pipeline Health; force-path clears the direct cache flag; bulk-complete
  reminder added. directCallMetrics.js: extracted shared dcUpsertRows_(conn,rows)
  (INSERT...ON CONFLICT template + per-row bind) used by BOTH writeDirectCall-
  RowsToNeon_ (single-date) and the new editor-run backfillDirectCallToNeon_
  (one connection, batched, resumable via DIRECT_UPSERT_RESUME, DIRECT_UPSERT_
  SINCE date floor) -- cdr-import-local (no cross-project move). Tests
  direct-call-backfill.test.js (+4: one-conn/per-row dates/ON CONFLICT, date
  floor, missing-sheet+unreachable no-op, single-date refactor parity). node
  --test 192/192; INV-16 clean (directCallMetrics.js + autoImport.js are
  cdr-import-only). Docs: direct-extension-metrics-design.md (Phase 3 SHIPPED +
  runbook). Operator: after a bulk rebuild run backfillDirectCallToNeon() in the
  CDR Import editor (DIRECT_UPSERT_SINCE to scope); recommended only after the
  carve-out numbers are vetted. INV-44 step list (bulkBackfill:Direct) is a
  sync-docs follow-up. Branch claude/brave-dijkstra-wuonrv carries 42-48, UNMERGED.
