# Cycle State — resume note

**Branch:** `claude/amazing-dijkstra-t0ed5r` · **PR:** #80 (base `main`) · tip `ffb82a2`
**Status vs main:** 0 behind / 14 ahead · working tree clean · PR conflict-free
**Verify on resume:** `node --test` (128 pass) + `bash scripts/check-duplicated-files.sh` (INV-16 in sync)

## What shipped this session (all pushed)
- **Broad-scan audit fixes F1–F12** + the **F2 Neon mirror divergence detector** (Alerts modal) + a **`cache-version-sync` CI test** (fails on docs↔code cache-version drift, INV-30).
- **UX sequence #7/#5/#6/#1/#2/#3** (Overview WoW-driver ≥5-call floor; QCD always-separates sub-queues; QCD violation markers + MTD clarity; Insights trend+queue-health consolidated into one tabbed chart; data-labels toggle; Insights agent cards mini-bars + Cards/Chart toggle).
- **Merged `origin/main`** (deferred Neon mirror / NeonMirror.js, IngestWatchdog, Overview/QCD-attribution M1/M2, computeTrendStartDate_, latestDates source suffix) — conflicts reconciled; cache versions now companyOverview:v16, qcd:v8, insights:v7.
- **Insights UX round 2** (commit `7ebad34`, from post-deploy feedback):
  - Data-labels fix (plugin SRI was blocking load → no labels anywhere; pinned explicit `/dist` file, SRI omitted = Option A).
  - IR drill-through now hides Insights + shows **"Back to Insights"** (instant return, no reload).
  - Agent cards redesigned: % Ans/Answered/Missed bars **vs team average** + value labels; Rung/ATT/TTT in a `<details>`.
  - Chart view: each agent's **gap vs team average** (diverging bars, click→IR).
  - Tiles decluttered (dropped Total Rung/Total TTT/Longest wait).
  - `validateHistoricalDqeBackfill_` / `runHistoricalBackfillCheck` editor helper (NeonRead.gs) for the older-history backfill.

## Decisions locked (for #4 and beyond)
- Team metrics (Answered/%Ans/ATT) stay **DQE-sourced** (roster team); per-queue split stays **Abandoned %** (QCD). DQE≠QCD by scope/window/attribution — no equality check.
- QCD parent-dept view: sub-queues shown separately, **no merged parent+sub total**.
- Insights tiles: two labeled groups (Department rollup / Queue health), not physically merged (user may revisit).

## OPEN / next steps
1. **User is smoke-testing round-2** (commit `7ebad34`) — all chart/card-heavy, unverified client code. Pick up from their feedback. Things to eyeball: data labels now working, Insights team-avg card bars, gap Chart view + click→IR, Back-to-Insights flow.
2. **#4 (the anchor, not started):** QCD **call-source** breakdown (per-source rows under each queue — data already in QCD Historical Data col E) + an **all-departments daily report** reproducing the legacy emailed PDF (grouped by dept area; Overall + per-source rows; columns Total Calls / Answered / Abandoned % / Longest Wait / Avg Answer / Violations). Screenshot + 3-part plan (4a per-source rows → 4b company-wide daily table → 4c Insights summary) are in this session's history. Est. L (~3–5d). Dashboard-only (no pipeline change).
3. **Minor dead-code cleanup** (from the ⑤ card redesign): `insMetricPerDay_` (no callers) + `.ins-card-bars` / `.ins-bar-*` CSS (superseded by `.ins-card-bars2`). Harmless; remove next session.

## Operator reminders
- Deploy = Department Dashboard `clasp push -f` + new deployment version (Manage deployments → New version). Charts can't be verified from the agent side — deploy + eyeball is the loop.
- To restore SRI on the datalabels plugin: `curl -s https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js | openssl dgst -sha384 -binary | openssl base64 -A`, then add `integrity`+`crossorigin` to that tag in dashboard.html.

## Where I left off
Round-2 Insights UX + data-labels fix pushed; sync-docs done; PR #80 clean and current. Awaiting the user's smoke-test of round-2, then either iterate on that feedback or start **#4**.
