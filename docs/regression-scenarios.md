# Regression Scenarios

<!-- Split out of CLAUDE.md (finding F8). CLAUDE.md was ~372 KB and is loaded
into EVERY session's context; this file holds the full text of one reference
section so the working document stays readable. CLAUDE.md keeps a one-line
index and a pointer here. The text below is the AUTHORITATIVE version --
the index is a finding aid, never a substitute. Keep them in sync;
tests/unit/claude-md-split.test.js fails the build if they drift. -->

The **Regression Scenarios** referenced by CLAUDE.md's Cycle Workflow Config.
Walk every scenario whose Subsystem overlaps a file you changed; the unit suite
(`node --test`) and the rendered-UI gate (`npm run ci:ui`) cover what they can,
and these cover what they structurally cannot (live auth, deployed wiring,
Script Properties, real Neon, anything a person must see).

Format: `S# | title | Subsystem: ...`, then `Steps:` and `Expected:`.

S1 | Manager loads own-dept dashboard | Subsystem: Department Dashboard
  Steps:
    - Manager opens the deployed web app URL.
    - Confirm the page lands on Overview ("Departments Snapshot" kicker + h1); the email + blue "manager" tag appear in the header.
    - Click "My Department" in the header nav.
    - Confirm header h1 swaps to the manager's dept name; From/To both default to the latest ISO date in DQE Historical Data; agent table populates within 3 seconds.
    - Confirm the My Department controls row shows the dept selector, date inputs, Quick select presets, and the horizontal Refresh + Export ▾ pair (R9-2; Export hidden until data loads) -- no scope toggle (retired in the redesign cleanup, commit 53d0560). Scroll the table: the controls row itself pins to the top on an opaque strip (R9-1) with no overlap of the QCD side card.
  Expected: that manager's dept roster agents appear, plus any queue-only floaters tagged with QUEUE chips in the Source column; info-line shows "fresh read" first load, "cache hit" on immediate refresh.

S2 | Admin switches departments | Subsystem: Department Dashboard
  Steps:
    - Admin opens deployed URL.
    - Confirm dept dropdown lists all departments.
    - Switch from default to a different dept.
  Expected: agent table re-fetches and re-renders within 3s; info-line shows "fresh read".

S3 | Unmapped user gets access-denied | Subsystem: Department Dashboard
  Steps:
    - User not in Access Control and not in ADMIN_EMAILS opens the URL.
  Expected: red access-denied card with their email + admin contact + mailto button.

S4 | Missed Calls report (My Department inline section) renders for a known date | Subsystem: Department Dashboard
  Steps:
    - Open the My Department page for a dept with known missed calls in the page's From/To range (the standalone Missed Calls modal is RETIRED -- this section is the report).
    - Scroll below the agent table to the "Missed Calls" section (renders automatically with the page refresh).
    - Also verify the two retained entry points: the quick-start chip "When did we miss calls?" (in the HELP modal since R10-1; sets the page dates to the latest DQE date, closes Help, opens the dept page, and auto-scrolls to the section) and a `#/report/missed` deep link (same behavior).
  Expected: headline + summary strip render; 18-bucket hour-of-day chart (8 AM-5 PM CST) with per-bucket drill-in (the Bars/Radar toggle is ADMIN-only since R11-B7 -- managers always get bars); each agent card's "■ chart" button scopes the chart to that agent with a toolbar chip to clear (R11-C4); queue-only abandons section when present; per-agent cards with timestamps, abandoned ones red + 🚨 with the "↳ path" journey drill. Changing the page From/To + Refresh re-renders the section for the custom range.

S5 | Daily DQE aggregation completes for a typical day | Subsystem: CDR DQE Pipeline
  Steps:
    - In CDR Report Apps Script, manually run buildDQEHistoricalData for a day's Raw Data.
  Expected: new rows in DQE Historical Data; Neon mirror succeeds; no failure email; per-agent TTT ≈ ATT × Answered (±1s rounding).

S6 | Source column + roster-only totals (post-Phase D) | Subsystem: Department Dashboard
  Steps:
    - Open dashboard for a dept with known floaters. Scope is locked to "roster" server-side (Phase 14, commit 80e17da); the legacy scope toggle is gone from the UI. NOTE: with roster scope, queue-only floaters no longer appear as rows in the My-Dept table (the QUEUE chip never renders here in practice) -- verify the floater machinery via the IR picker's Floaters group + Diagnostics instead.
    - Inspect the agent table: every row should carry a chip in the Source column (between Agent and the Answered/Missed bar). Roster agents render ROSTER (accent) or BOTH (good) chips; queue-only floaters render QUEUE (warn) chips suffixed with their other-dept home list (e.g. `QUEUE · Sales, Power`). Floaters on no dept's roster render bare `QUEUE`.
    - Confirm the totals row (pinned ABOVE the data rows; element id `agents-tfoot`) reads "Total (roster only · N floaters excluded)" in its first cell, with N matching the count of QUEUE-chipped rows, and the totals values themselves exclude those rows' contributions.
    - To verify the floater-exclusion contract still produces correct roster-only numbers (legacy `scope=roster` behavior), filter the response client-side to `matchedViaRoster=true` rows -- the totals shown in the tfoot match what summing those rows produces. The contract is independent of scope so the historical roster-only view is reproducible without the toggle.
  Expected: chip rendering matches matchedViaRoster/matchedViaQueue flags per row; sourceHomes array suffix lists every other dept's roster the floater appears on; totals match the roster-only sum; Diagnostics panel still lists queue-only matched agents (now visible directly via the Source chip on each row).

S7 | Source pipeline numbers match dashboard | Subsystem: CDR DQE Pipeline → Department Dashboard
  Steps:
    - Verify Sonia 2026-03-09: source TTT/ATT vs dashboard TTT/ATT.
  Expected: 0:15:03 / 0:03:01 on both sides.

S8 | New manager visible within 60s of being added to Access Control | Subsystem: Department Dashboard
  Steps:
    - Add a row (Email | Department | Notes) to Access Control sheet.
    - Have that user open the URL.
  Expected: dashboard loads as manager within 60s (AUTH_CACHE_TTL_SECONDS).

S9 | clasp push from sibling subdir deploys only that project | Subsystem: operational
  Steps:
    - `cd apps-script/cdr-report` → trivial change → `clasp push -f`.
  Expected: only that project receives the change; Department Dashboard unaffected.

S10 | setup() is safely re-runnable | Subsystem: Department Dashboard
  Steps:
    - Run setup() in editor.
    - Run again.
  Expected: first run creates Access Control if missing; second logs "already exists, skipping" — no data overwrite.

S11 | Individual Report renders for one agent with monthly trend | Subsystem: Department Dashboard
  Steps:
    - Open dashboard. Click Individual Report.
    - Pick a single agent + a date range that includes activity.
    - Generate.
  Expected: KPI tiles per agent (with sparklines), insights callout (if rules trigger), three trend charts in tabs (Volume / Efficiency / Duration). 1 agent = "Individual Performance Report" title. Edit-selection popover in the results header re-runs without going back to the form.

S12 | Individual Report peer comparison with shared legend | Subsystem: Department Dashboard
  Steps:
    - Open Individual Report. Pick 2+ agents in the picker.
    - Generate.
  Expected: title flips to "Peer Comparison Report"; shared chip legend renders above the chart tabs; clicking a chip ISOLATES that agent (pins a spotlight, dimming the others across all three charts; click the pinned chip again or another to release/switch), Shift+click HIDES/shows that agent's series (the legacy toggle), and hovering previews the spotlight when nothing is pinned.

S13 | Individual Report agent picker active/inactive grouping | Subsystem: Department Dashboard
  Steps:
    - Open Individual Report; pick a date range with known no-data agents.
    - Wait for active set to load (350ms debounce after last date edit).
  Expected: picker splits into "Active in range (N)" and "No activity in range (N)"; inactive items are muted but still pickable; search box filters live across both groups.

S14 | Insights team rollup: current vs prior deltas + PR-absorbed views | Subsystem: Department Dashboard
  Steps:
    - (The standalone Performance Report is RETIRED -- Insights is the replacement.) Open Insights -- it AUTO-GENERATES the whole-department report on first entry (no setup form). Use "Edit dates & agents" to pick "Last month" and Apply with no agents checked (whole department).
    - Check the KPI tiles' deltas vs the immediately-preceding same-length window (INV-28); the "Comparing against..." line shows the explicit prior dates.
    - Scroll to the share-of-answered donut (below the trend chart) -- one slice per agent, small slices unlabeled.
    - Switch the per-agent comparison to Chart view and flip the new sub-toggle to "Absolute": one stacked bar per agent (green Answered + red Missed, stack = rung) with a % Answered dot per agent on the right axis -- PR's Volume & Efficiency view. The metric selector hides in Absolute mode; clicking a bar drills into IR.
    - Deep-link check: open `<dashboard-url>#/report/performance` -- it lands on the Insights page (legacy links repoint).
  Expected: all of the above; Missed keeps its warn valence on deltas; rates stay length-independent.

S15 | Pipeline canonicalizes paren-variant agent names | Subsystem: CDR DQE Pipeline
  Steps:
    - In Raw Data, ensure a leg exists with calleeName "Roman Paulose" (parenthetical dropped) on a date where the roster has "Roman (Robin) Paulose" (and no bare "Roman Paulose" roster entry, so the match is unambiguous).
    - Run buildDQEHistoricalData for that day.
  Expected: the resulting DQE Historical Data row's Agent Name (col C) is "Roman (Robin) Paulose" -- consolidated under the canonical form (both names normalize to a single roster match). No duplicate rows for the same person on the same day. NOTE: an incoming "Roman Robin Paulose" (nickname un-parenthesized) NOW canonicalizes too via the FLATTEN key (INV-24) -- it matches the roster's flatten form "Roman Robin Paulose"; only a name with a genuinely EXTRA word not in the roster's parenthetical stays as-is.

S16 | Export menu captures all chart tabs | Subsystem: Department Dashboard
  Steps:
    - Generate any Individual Report (multi-chart export reference case).
    - Without clicking through every chart tab, click Export -> Email image.
  Expected: emailed PNG contains all three chart panels rendered (not blank slots). Same expectation for Copy image and Print.

S17 | RETIRED (Compare Ranges deleted -- CR->Insights consolidation). Per-dept gating for the replacement is covered by S37's console negative test; the custom-prior round-trip by S19. | Subsystem: Department Dashboard

S18 | Insights length-mismatch surfaces per-day (ex-Compare Ranges, INV-35) | Subsystem: Department Dashboard
  Steps:
    - Open Insights (auto-generates on first entry). Via "Edit dates & agents", set Compare = Custom prior range with a prior window >= 1.2x longer (in working days) than the selected range; Apply.
    - Generate.
  Expected: the results compare-line carries the inline "Different window lengths" caveat; raw-volume team insights are dropped (rates kept); agent cards show per-day sublines on volume/time metrics; the CSV gains /day columns (team rollup + per-agent).

S19 | Insights custom prior range round-trip (ex-Compare Ranges) | Subsystem: Department Dashboard
  Steps:
    - Open Insights; set Compare against = Custom prior range with the same month last year as the prior window and this month-to-date as the range.
    - Then click "Edit dates & agents" in the results header, swap one agent out, leave Compare at "Keep current comparison", Apply.
  Expected: report re-runs in place against the same custom prior (the 'keep' sentinel preserves it); editing-line updates; the popover dismisses; the new agent's card appears. Hover a card delta badge for the prior window's exact value (the standalone "vs Prior" chart basis was retired by owner note; the badge tooltips are the prior-value surface).

S20 | Alerts preview + send flow | Subsystem: Department Dashboard
  Steps:
    - Open Alerts (admin only). Pick a date with known low-answer-rate activity.
    - Click Preview; review the table; click Send alerts; confirm the prompt.
  Expected: preview shows "Will alert" badges (red rows) and "Healthy" (green) per dept; Send disabled until preview matches the date; after Send, status flips to "Sent" and the Alert Log table refreshes with new entries.

S21 | Alerts daily trigger install/uninstall | Subsystem: Department Dashboard
  Steps:
    - In the Alerts modal "Daily trigger" section, click "Install daily trigger (8 AM)".
    - Refresh via the Apps Script editor's Triggers panel.
    - Back in the modal, click "Uninstall trigger".
  Expected: status line updates to "Daily trigger is installed... runs at 8:00 CST. Weekends are skipped."; Apps Script editor shows a `runDailyAlerts_` trigger; after uninstall, status line reverts to "No daily trigger installed."

S22 | setup() creates all dashboard-managed sheets idempotently | Subsystem: Department Dashboard
  Steps:
    - In a fresh spreadsheet without any of those sheets, run setup() once.
    - Run setup() again.
  Expected: first run creates Access Control + Alert Config + Alert Log + Pipeline Health + Digest Config + Agent Alias Overrides + Orphan Fix Log + Dept Config + Report Usage + Queue Report Subscribers (each with their header row + frozen first row); second run logs "already exists, skipping" for all ten -- no data overwritten on either run. New columns added in a later code change to an existing sheet are NOT applied by setup() -- the sheet's existence short-circuits ensureSheet_.

S23 | Overview is the default landing + tile click solos the trend line | Subsystem: Department Dashboard
  Steps:
    - Open the deployed URL (admin or manager).
    - Confirm Overview page loads first; header h1 is "Departments Snapshot"; the Overview button has the inverted (active) styling.
    - Click any dept tile in the grid (#1).
    - Shift-click (or Cmd/Ctrl-click) a second dept tile.
    - Click the sole-pinned tile again (after releasing the others).
    - As admin (or a manager on their own dept's line): click a POINT on a dept's trend line.
  Expected: a plain tile click SOLOS that dept's line on the 30-day trend chart (the other lines dim; the tile gains the `.ov-tile-soloed` inset ring) -- it does NOT navigate. Shift/Cmd/Ctrl-click ADDS the second dept to the pinned set (both lines highlighted). A plain click on the lone pinned tile releases the solo (all lines back to normal). A chart POINT click routes to My Department for that dept + date (header h1 becomes the dept name, dept-selector swaps, agent table renders for the clicked ISO date); the dept-selector dropdown is the other navigation path.

S24 | Sub-queue nests under parent hero on Overview | Subsystem: Department Dashboard
  Steps:
    - As admin: pick Sales from the dept-selector and return to Overview (or open Overview with Sales already selected).
    - Inspect the user-hero block.
  Expected: Sales renders as the big hero tile; PAP appears as an indented child tile directly underneath (accent-tinted background + ↳ glyph + "sub-queue · Sales" tag). PAP does NOT additionally appear as a standalone tile in the grid below. Same expectation for CSR (with Spanish nested) and Power (with PAK nested).

S25 | Company aggregate visibility is admin-only | Subsystem: Department Dashboard
  Steps:
    - Open Overview as a manager (non-admin).
    - Open Overview as an admin.
  Expected: manager sees the dept grid + 30-day trend chart but no "Company snapshot · admin only" hero; admin sees that hero at the top with rung/answered/missed/ATT/active counts + a 30-day company-wide sparkline.

S26 | Big-roster reports complete without cache-key error | Subsystem: Department Dashboard
  Steps:
    - As admin: open Individual Report for Sales (or any dept with > 12 agents).
    - Select all active agents; pick a 30-day range; Generate.
    - Repeat for Insights with the same selection.
  Expected: all three reports return data without "Argument too large" or similar cache errors. The MD5 hash in the cache key (`hashAgents_`) keeps the compound key bounded regardless of roster size; second Generate of the same selection comes back as a cache hit.

S27 | RETIRED (duplicate of S17; Compare Ranges deleted -- CR->Insights consolidation). | Subsystem: Department Dashboard

S28 | Pipeline Health logs autoImport + integrated DQE outcomes | Subsystem: Department Dashboard + CDR Import + CDR DQE Pipeline
  Steps:
    - Trigger a successful daily import (or run processNewImport manually).
    - Open the dashboard as admin -> Alerts modal -> Pipeline Health section.
    - (Optional, only if testing the cdr-report safety-net trigger) Run `testDQEBuild` or `runDailyDQEBuild_` from the cdr-report editor.
  Expected: most recent rows show a `success` entry for `autoImport` (with the imported sheet name in Notes and a row count) plus per-output rows from the integrated path -- `processIntegratedHistory:CDR` / `:QPath` / `:QCD` / `:CSR` / `:DQE`. If the optional safety-net trigger is also run, a separate `buildDQE` row appears (with `callDate=YYYY-MM-DD` in Notes). For a forced failure (rename "Raw Data" sheet temporarily), the entry shows status `failure` with the exception message in Notes. Logging is best-effort -- a missing Pipeline Health sheet must not break the pipeline. S33 + S34 cover the per-output and integrated-DQE specifics; this scenario is the smoke test that telemetry plumbing is alive.

S29 | Manager Digest install + preview flow | Subsystem: Department Dashboard
  Steps:
    - As admin: open Alerts modal -> Report Subscribers section (the unified Digest + Queue Report subscriber table).
    - Confirm Digest Config rows render (or "no subscribers yet" empty state).
    - Click Install digest triggers; trigger status caption switches to "Daily + weekly + monthly digest triggers are installed."
    - In the Apps Script editor's Triggers panel, confirm `runDailyDigests_`, `runWeeklyDigests_`, and `runMonthlyDigests_` are all present.
    - From the browser console: `google.script.run.withSuccessHandler(console.log).sendPreviewDigest({ department: 'CSR', cadence: 'daily', email: 'someone@universalmedsupply.com' })`. Repeat with `cadence: 'monthly', format: 'insights'` -- the preview arrives with the Insights-format body (team rollup deltas + per-agent delta table for the prior calendar month).
    - Click Uninstall digest triggers; confirm both triggers removed.
  Expected: install/uninstall succeed; preview digest arrives in the admin's inbox (not the supplied `email`, which is shown only as "what would the subscriber see"); preview email body has a yellow "Preview only" banner. Since #11, when the dept has a notable week-over-week answer-rate shift (`|deltaPct| >= 1.5` pts over the 7 days ending the digest window vs the prior 7), the email also renders a "What changed · WoW" callout below the KPI tiles naming the driving agent (sage for a gain, amber for a drop); a quiet dept renders no callout (best-effort, INV-48).

S30 | Header freshness pill renders and goes stale | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard fresh (any role). The freshness pill in `.header-meta` is hidden initially.
    - After `getLatestDataDates` (plural, multi-source) returns, the pill renders "Data through <weekday short> · <Nh ago>" using the MAX across DQE + QCD.
    - If the latest date is more than 36h old (e.g. nothing ingested Friday + today is Sunday), the pill picks up the `.is-stale` class and tints warm orange.
    - Hover the pill; the title attribute explains what it represents.
  Expected: pill is hidden on fetch failure or empty data; visible and color-coded otherwise. Updates only on page load -- not live.

S31 | Orphan Fix end-to-end (admin) | Subsystem: Department Dashboard + CDR DQE Pipeline
  Steps:
    - As admin, open the dashboard. Open the "Admin" dropdown in the header nav (admin-only group) and click "Outlier Fix".
    - Confirm the modal lists orphan agent names from DQE Historical Data (or "no orphans" if everyone canonicalizes cleanly).
    - For one orphan, pick a canonical roster name from the dropdown; click Apply; confirm the prompt.
    - Server returns the rename count; the orphan row disappears from the list on refresh; "Current aliases" gains a new row with Active=Yes; "Recent fix log" gains a `rename+alias` entry.
    - Open the CDR Report spreadsheet -> DQE Historical Data; confirm the Agent Name column for the affected rows now shows the canonical name.
    - As a non-admin manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).applyOrphanRename({fromName:'X', toName:'Y'})`.
    - Expected: non-admin call throws "Alerts are admin-only." (the assertAdmin_ guard); admin Apply succeeds; renamed rows appear in subsequent dashboard reports after the 5-min cache TTL; the next daily DQE build does not re-introduce the orphan because the alias is honored by loadRosterCanonicalNames_.
    - Negative test: try renaming to a name not on any dept's roster (e.g. "Garbage Name"); expected: "X is not on any dept roster..." error.
    - Negative test: try renaming a queue-sentinel ("A_Q_CSR") as fromName or toName; expected: "Queue-sentinel names cannot be renamed..." error.

S32 | Queue data end-to-end (Insights Queue health + retained QCD surfaces) | Subsystem: Department Dashboard + CDR Import
  Steps:
    - (The standalone QCD Report modal is RETIRED -- QCD->Insights consolidation. Queue data is now verified via Insights Queue health + the three retained QCD surfaces below.)
    - Open the dashboard as a manager. Click the "Insights" tab -- it AUTO-GENERATES the agent-free whole-dept report (last 30 days ending yesterday) on first entry; use "Edit dates & agents" to move to a range with known QCD activity if needed.
    - Confirm the Queue health section renders: tiles (Queue calls / Abandoned % / Violations MTD -- warn-tinted per the 5% standard) + the muted secondary line (Answered / Longest wait / Avg answer); one row per queue in the dept's effective queue list, sub-queue rows tagged + excluded from the dept total; every row expands into the secondary-metric strip, the per-call-source subtable (Overall + CSR / Ad-campaign / New Call Menu / Non-CSR, Overall-first then by volume), and violation dates. The collapsed Daily breakdown table shows the per-day rows with the answered/abandoned split bar.
    - Switch the consolidated trend chart's Metric dropdown (`#ins-trend-metric`, the R11-C3 single selector) to "Queue: Abandoned %": one line per queue + a dashed "Dept total" line + the dashed 5% threshold; days/months at or over 5% render enlarged warn-colored points (violation markers). The legend shares the Overview chart's spotlight (hover to dim others; click to pin/isolate) via the `chartSpotlight*` helpers. The same dropdown's "Queue: Total calls" / "Queue: Violations" entries switch the queue metric; the Monthly/Daily toggle switches the axis.
    - As an admin, pick a dept with NO mapped queues and Generate: Queue health renders the "No queues are mapped" hint with an "Open Dept Config" button (managers get the ask-an-admin wording).
    - Deep-link check: open `<dashboard-url>#/report/qcd` -- it lands on the Insights page (legacy links repoint).
    - Quick-start chip (Help modal since R10-1): click "Are callers giving up before we answer?" -- Help closes, Insights opens and auto-runs over the last 30 days.
    - Re-open the dashboard fresh and check the Overview tile for a dept with multiple queues; per-queue QCD rows appear showing each queue's abandoned %, abandoned count (if >0), and violations (if >0) with color-coding. "X viol MTD" chip renders when month-to-date violations > 0.
    - All-departments daily report (4b, open to all managers): as EITHER an admin OR a manager on the Overview page, confirm a "Daily Call Queue Report" button (`#ov-qcd-alldept-btn`) is visible (no longer `data-admin-only`). Click it; the `#qcd-alldept-modal` opens and **pre-loads the latest queue day** immediately (no Generate click; falls back to the previous workday -- never a bare weekend/holiday "yesterday"). Confirm a flat company-wide table with one section per mapped dept (own queues only -- a sub-queue lists under its own dept exactly once, never under the parent), a per-dept subtotal row, and a "Company total" grand-total footer; **Answered / Abandoned / Abandoned % render as a split bar**; abandoned %>=5% and violation counts are warn-tinted. Change the date via the in-modal date toolbar (preset or from/to + Update) -- it re-generates in place (no back-to-form step). Click a queue row -> it expands into the per-call-source breakdown (data-driven per queue) + violation dates. Via the Export ▾ menu (R11-B3): Download CSV (scope line + per-dept rows + subtotals + grand total, all numeric columns), Print (plain-table print window), and "Email me this report"; the admin-only "Send to subscribers…" stays a separate button. Console check: `google.script.run.withSuccessHandler(console.log).getQcdAllDepartments({from:'2026-05-01', to:'2026-05-19'})` RESOLVES for a manager; only a `role==='none'` visitor is refused ("Not authorized.").
    - As a manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).getInsightsReport({ department: 'SomeOtherDept', from: '2026-05-01', to: '2026-05-19', agents: [] })`.
  Expected: own-dept Generate succeeds; cross-dept console call throws "Not authorized for this department.". Admin users can request any dept that exists in the dept list. My Department page renders a "Queue Call Data — [date]" tile row (showing the actual data date) beside the agent table.

S33 | Pipeline Health per-output rows | Subsystem: CDR Import + Department Dashboard
  Steps:
    - Trigger a successful daily import via `processNewImport` (manual run or onChange).
    - Open the dashboard as admin → Alerts modal → Pipeline Health section.
  Expected: most recent rows include separate entries for `processIntegratedHistory:CDR`, `:QPath`, `:QCD`, `:CSR`, `:DQE`, `:Inbound` (one per output type that produced > 0 rows; `:Inbound` additionally logs a `failure` row on Neon-unreachable/error since inbound_calls has no sheet fallback -- F9), each with status `success`, a row count, and the dateObj.toDateString() in Notes. If any output block fails mid-`processIntegratedHistory`, the outer `autoImport` row will still log a `failure` (and the per-output rows for steps that already succeeded remain). Best-effort: a missing Pipeline Health sheet does not block any output.

S34 | Integrated DQE build runs inside autoImport | Subsystem: CDR Import + CDR DQE Pipeline + Department Dashboard
  Steps:
    - Trigger a daily import via `runManualExport` (or onChange) for a date NOT already present in DQE Historical Data.
    - Wait for the run to complete; the success toast should report `CDR: +X | QPath: +Y | QCD: +Z | CSR: +W | DQE: +N | Neon ✓` (the trailing Neon segment is `✓` / `⚠ unreachable` / `⚠ error` reflecting the CDR+QCD mirror reachability for the run).
    - Open the CDR Report spreadsheet → DQE Historical Data; confirm new rows for the imported date.
    - Open the dashboard; the header freshness pill should refresh to that date within 5 min (or after cache TTL).
    - Open the dashboard as admin → Alerts modal → Pipeline Health; confirm the most recent rows include `processIntegratedHistory:DQE` `success` for that date alongside CDR / QPath / QCD / CSR entries.
    - Re-run `runManualExport` for the SAME date (without force-mode); the dedup guard should short-circuit and the toast says `ALREADY IN HISTORY`.
    - Force-re-run for the same date; DQE rows for that date are cleared (deleteHistoricalRowsForDate with col 2), rebuilt, and Pipeline Health gets a fresh `:DQE` row.
  Expected: integrated DQE writes succeed alongside the four legacy sheets; Pipeline Health `:DQE` row appears; dashboard freshness pill updates from the integrated path (no separate `runDailyDQEBuild_` trigger required). If the DQE block itself throws, the outer `autoImport` row still logs `success` for the 4-sheet write -- the DQE failure surfaces as a `:DQE` `failure` row AND emails `NEON_WRITE_CONFIG.alertEmail` via `notifyDqeBuildFailure_` (so a failed daily rebuild isn't only visible in Pipeline Health / the 36h banner; the bulk-backfill path logs `bulkBackfill:DQE` `failure` but intentionally does NOT email, to avoid per-date spam). Bulk-archive path (`bulkHistoricalUpdate`) ALSO builds DQE per-date now -- in bulk mode the Raw Data sheet write is gated on `willBuildDQE` (=!existsInDQE) so the DQE build still has fresh source data on each iteration; the per-date outcome is logged to Pipeline Health as `bulkBackfill:DQE`. The 4 legacy sheets still flow through Pending Archive → `processBatchArchive` unchanged.

S35 | Phase D totals parity (roster-only floater exclusion) | Subsystem: Department Dashboard
  Steps:
    - BEFORE deploying Phase D: open the dashboard for a known dept with floater activity. Set scope=Roster (the pre-Phase-D default). Pick a recent date range. Screenshot the tfoot totals row (totalUnique / totalRung / totalMissed / totalAnswered / TTT / ATT / Avg Abd Wait / CSR Avg Abd Wait).
    - Deploy Phase D (commit d631719 or later); see Deploy Command.
    - AFTER deploy: open the same dept + date range with default settings (scope=Both — the new default). The agent table will now include queue-only floaters with `QUEUE` chips; the tfoot caption will read "Total (roster only · N floaters excluded)".
    - Compare the post-deploy totals values to the pre-deploy screenshot.
  Expected: every totals cell matches the pre-deploy `scope=Roster` numbers to the digit. Rationale: the new totals filter to `matchedViaRoster=true` only, which is precisely the set the pre-Phase-D `scope=Roster` view summed. Floaters render as new rows but contribute zero to the totals. If the totals DON'T match, the rosterRows filter has regressed -- roll back the Phase D commit and investigate before re-shipping. This is a one-time validation but the scenario stays as a permanent reference for the floater-exclusion contract (see INV-53).
  ADDENDUM (sub-queue Phase 1) -- the COMBINED-view parity check. A parent dept (Sales / CSR / Power) always renders the combined view, which adds a second totals concept, so this scenario now also covers:
    - Open the parent. Each dept gets its own `<dept> subtotal` row plus a labelled combined grand total.
    - The scope switcher that used to produce a one-dept view is RETIRED. To get the parent's own figure for comparison, either read its subtotal row directly, or open a CHILD dept (which renders only its own numbers) and compare that against the child's subtotal in the parent's combined view. Collapsing a group is display-only and does NOT change any number -- that is the property to confirm, not a way to re-scope the request.
    - Confirm each dept's subtotal row equals, to the digit, that dept's own view.
    - Confirm the combined grand total's COUNT cells (Unique / Rung / Missed / Answered / TTT) equal the sum of the per-dept subtotals -- EXCEPT where `totals.crossoverAgentCount > 0`, in which case the grand total is deliberately LESS (Phase 0 de-duplicates an agent on two rosters; the totals-row caption says so).
    - Confirm the three DURATION cells (ATT / Avg Abd Wait / CSR Avg Abd Wait) are the agent-count-WEIGHTED mean of the per-dept values, NOT their simple average -- a mean of means would over-weight a one-agent sub-queue.
  Expected: each dept's subtotal is identical to its own view (it is produced by the same `computeSummary_` call), counts sum exactly modulo the crossover de-dup, and durations are weighted. A mismatch on the first point means `combineSummaries_` is mutating a part rather than merging copies; a mismatch on the last means the weighted-mean accumulator regressed (pinned by tests/unit/subqueue-access.test.js; `drive-subqueue.js` asserts the rendered parent subtotal against the server's own-scope payload, and the live walk covers what neither can).

S36 | Dept Config modal: auto-discovery, validation, override round-trip | Subsystem: Department Dashboard
  Steps:
    - PREREQ: deploy the Dept Config commit (`clasp push -f` + new deployment version) AND re-run `setup()` as an admin so the `Dept Config` sheet exists (INV-54). Until both are done the feature is dormant and accessors fall through to the constants (so behavior is unchanged -- this is the regression-safety guarantee).
    - As an admin, open the dashboard. Confirm "Dept Config" appears under the header nav's "Admin" dropdown (admin-only group; hidden for managers). As a non-admin manager, confirm the Admin dropdown is NOT visible, and in the browser console `google.script.run.withFailureHandler(console.error).getDeptConfigInit()` throws "Alerts are admin-only." (the assertAdmin_ guard, shared message).
    - Click the tab. The modal loads: a "Discovered queues" table lists distinct `Call Queue` values from QCD Historical Data (last 180 days), unmapped queues sorted first with an "unmapped" chip + an "N unmapped" badge on the section title; a "Per-department config" table shows every dept's EFFECTIVE qcdQueues / overviewParent / teamAvgExcludes / queueExtOverrides with a Source chip ("sheet" if an Active row exists, "default" if from the constant).
    - Click Edit on a dept. The edit form pre-fills from the effective values. Negative tests (each should fail server-side with a clear message, status flips to error, no row written):
        (a) QCD queue typo (a name not in QCD col D and not in the dept's constant) -> "Unknown QCD queue name(s): ... Queues seen in the last 180 days: ...".
        (b) Overview parent = a non-dept string -> "... is not a department ...".
        (c) Overview parent that forms a cycle (e.g. set A's parent to B when B's parent is already A) -> "... would create a nesting cycle.".
        (d) Team-avg exclude not on the dept roster -> "... not on the <dept> roster ...".
        (e) Queue ext override with a non-digit token -> "... must be digits only ...".
    - Positive: set a valid QCD queue (one shown in the discovered list), Save. Status flips to success; toast appears; the modal reloads; the dept's Source chip flips to "sheet"; the discovered queue's "Mapped to" now shows the dept; the unmapped count drops by one.
    - Re-open Insights Queue health for that dept -> the newly-mapped queue's rows now appear (after the insights cache TTLs out). Re-open Overview -> a sub-queue mapping change is reflected immediately (the COMPANY_OVERVIEW_CACHE_KEY is busted on save).
    - Click Edit on the same dept, click "Deactivate override". Confirm prompt; the row's Active flips to FALSE; on reload the dept reverts to the "default" Source (constant behavior). The Deactivate button is hidden for depts with no existing sheet row.
  Expected: all five negative tests reject with the documented messages and write nothing; the positive save + deactivate round-trips through the `Dept Config` sheet; effective table + discovery reflect changes on reload; no redeploy required for any edit; cross-dept/non-admin access is refused at the server boundary. The four accessors (getDeptQcdQueues_ / getOverviewParentMap_ / getTeamAvgExcludes_ / getDeptQueueExtsOverride_) layer the sheet over the constants with "non-empty overrides, empty falls back" semantics (INV-54).

S37 | Insights report end-to-end (comparison modes + CR-ported analytics) | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager; click the "Insights" tab (visible to all; per-dept gated server-side like IR/CR).
    - First entry AUTO-GENERATES (default compare = "Immediately-preceding period"; no setup-form step -- "Edit dates & agents" is the editing surface). Adjust to a range with activity + 2+ agents via the popover. Confirm: 6 KPI tiles with delta badges AND 12-month sparklines; the 12-Month Team Trend chart with its single Metric dropdown (R11-C3; admin sees the ATT + Queue entries); per-agent cards each carrying 6 metrics with their OWN delta badges; floaters get the QUEUE chip + warn border and are excluded from the rollup caption's roster-only totals (INV-53).
    - Cards carry a left-border classification tint (improved=accent / regressed=warn / mixed=muted) + a "vs Team" badge; the Sort control re-orders (Most answered default / Name / Biggest improvers / Biggest regressors); agents with no notable movement collapse into "Show N quiet agents".
    - Switch Compare against to "Same window one year prior" -> hint previews the resolved YoY window; Generate -> "Comparing against the selected prior window" line + per-agent prevs from the YoY window.
    - Switch to "Custom prior range" (via the popover's Prior from/to inputs) with a window >= 1.2x longer -> after Apply, the results show the different-window-lengths caveat and per-day sublines on volume/time metrics (INV-35 contract).
    - Queue health (when the dept is QCD-mapped): the per-queue detail table renders one row per queue with abandoned % / abandoned / violations. For a queue whose abandons are driven by a non-Overall call source (4c), the queue-name cell shows a muted "↳ most abandons: <source> (N)" annotation; queues with no sub-source abandons show no annotation. As ADMIN, an `#ins-heatmap` weekday×hour abandon heatmap renders below Queue health (the same shared panel the QCD report shows); managers don't see it.
    - Agent-free run (Phase 2 parity): leave ALL agents unchecked and Generate -> the report runs over the whole dept roster (the digest pattern, INV-45; floaters excluded), rendering the team rollup + Queue health + every roster agent's card -- the QCD-replacement queue/dept quick-look. Generate stays enabled with nothing checked (only a truly empty roster disables it).
    - Export -> Email report sends a SERVER-RENDERED HTML report (department rollup tiles + per-agent delta table) via sendInsightsReportEmail, recomputed from the same params -- no charts in the email (Copy image / Print keep the charts); Print does the same as before.
    - Console negative test: getInsightsReport for another dept throws "Not authorized for this department."
  Expected: all of the above; teamStats keeps the retired Performance Report's semantics to the digit (the consolidation-freeze test in insights-report.test.js pins the INV-25/28/29 literals -- if S37 and S14 ever disagree, that test should already be red).

S38 | Inbound capture -> Inbound report -> insurer labeling end-to-end | Subsystem: Department Dashboard + CDR Import + CDR Reporting Tools
  Steps:
    - PREREQ: HMAC_SECRET + NEON_* props set in cdr-import (capture) and cdr-report (sync/export); NEON_* + script.external_request on the dashboard (report).
    - Run a daily import; the execution log shows `writeInboundCallsToNeon: wrote N inbound-call records`. In Neon, `SELECT count(*) FROM inbound_calls WHERE call_date = '<date>'` matches.
    - Populate an insurer column in DO NOT EDIT! cols X-AG (header = insurer name, rows = +1XXXXXXXXXX numbers); run `syncInsuranceNumbersToNeon` (cdr-report editor); log reports the distinct-number count.
    - As ADMIN, open the "Inbound" tab with Department = "All departments". Pick a range; confirm KPI tiles (total / answered / abandoned / on-hold / IVR-abandons / anonymous / avg wait+hold, each with a delta badge vs the prior window) and the By-insurer / By-dial-in / By-entry-queue / Dial-in x insurer tables; the labeled insurer appears in By insurer. Click an insurer row: it expands with a Volume / Abandon % daily trend chart (fetched on demand via getInboundInsurerDaily); clicking again collapses it.
    - As ADMIN, pick a specific dept: totals shrink to that dept's slice (entry-queue attribution via the dept's effective queue list; an answered call abandoned ON HOLD attributes by final_dept instead); the "Abandoned in IVR" tile disappears (unattributable, company view only). A dept with no mapped queues shows the "No queues mapped ... Dept Config" hint.
    - As a MANAGER, open the Inbound tab (now visible): the Department selector is pinned to their own dept; the report loads their slice with insurer labels. Console negative test: `getInboundReport({from, to, department: 'SomeOtherDept'})` throws "Not authorized for this department."
    - Kill Neon reachability (or unset NEON_HOST on a dev copy): the modal renders the "unavailable" state; restore and re-run within the same 30 min -> data returns immediately (unavailable payloads are not cached).
    - For history: run `backfillInboundCalls` (cdr-import editor) and re-run until "complete"; run `exportInboundCalls` (cdr-report editor) and confirm the "Inbound Calls" tab matches Neon for the window (re-running refreshes rather than duplicates).
  Expected: capture is idempotent (force re-import refreshes rows, no dupes); anonymous callers carry null hashes and only count in the headline KPIs; no raw phone number appears anywhere in Neon or the export tab (hashes only); dept slices + the company view sum consistently apart from the IVR bucket and any answered-on-hold calls whose raw final_dept label doesn't match a dashboard dept header (the documented soft coupling); Download CSV includes the scope line, all four breakdowns, and the daily series.

S39 | Keyboard-only walk of the primary drill paths (F13) | Subsystem: Department Dashboard
  Steps:
    - Load the dashboard and use ONLY Tab / Shift-Tab / Enter / Space (no mouse).
    - On Overview: Tab to a dept tile and press Enter -- it should SOLO that dept's line in the trend chart (Shift/Cmd/Ctrl+Enter adds a second dept to the comparison).
    - Go to My Department; Tab to an agent row and press Enter -- the Individual Report should open. Press Space on a row: it must activate WITHOUT scrolling the page.
    - Open the all-departments Daily Call Queue Report; Tab to a queue row and press Enter -- the per-call-source breakdown should expand, and Enter again collapse it.
    - Same on the Insights Queue health per-queue rows.
    - In the My Department QCD side card (a multi-queue dept), Tab to a carousel dot and press Enter -- the carousel should change page.
  Expected: every one of the above is reachable and activatable by keyboard, each focused element shows a visible accent focus ring, and `aria-expanded` flips on the expandable rows. AUTOMATED COUNTERPART: `tools/ui-harness/drive-f13.js` asserts all of this in headless Chromium (13 checks) -- run it after any change to the agent table, the Overview dept grid, or either qcd-expandable table. Table rows carry `tabindex` but deliberately NO `role="button"` (that would override the implicit row role and break table semantics), so a screen reader still announces them as grid rows.

S40 | Escalation overdue count agrees with the flagged cards (F3) | Subsystem: Department Dashboard
  Steps:
    - Ensure at least one OPEN (pending / in_progress) escalation has `occurred_at` between 68 and 76 hours ago -- the window where a 72-hour test and a calendar-day test disagree.
    - Open the Escalations page with the Pending filter.
    - Compare the sidebar "Overdue >3d" tile number against the count of cards showing the red ⚑ age badge.
    - Also check the Escalations nav-tab badge tooltip ("N open (M overdue)") against the same cards.
  Expected: the tile, the nav badge, and the ⚑ cards all agree. A card flagged ⚑ that the tile doesn't count (or vice versa) means the server's `ESC_OVERDUE_SQL_` and the client's `escDaysOpen_` have drifted apart again -- they must BOTH be calendar-day comparisons. Note the counts are viewer-scoped and status-independent, so compare against ALL open cards (Pending + In progress), not just the active filter.

S41 | Theme × mode sweep (perceptual) | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard in LIGHT theme, then switch to DARK (Settings toggle), on each page: Overview, My Department, Insights, Escalations.
    - On each, confirm every chart's lines/bars/labels remain legible and no text drops to invisible (the INV-42 OKLCH/datalabels class -- a token that fails to resolve renders an empty fill, which looks like a missing label rather than an error).
    - Repeat with "Show data labels" ON (IR / Insights), and with reduced-motion enabled at the OS level.
  Expected: no invisible text, no chart element that changes meaning between themes, no animation that ignores reduced-motion. Proposed in increment 54 as a perceptual check no code can verify; promoted here so it stops being an un-numbered TODO.

S42 | Narrow-viewport trend band (perceptual) | Subsystem: Department Dashboard
  Steps:
    - Narrow the browser to ~900px, then ~700px, then ~400px.
    - On Overview confirm the stacked sticky trend chart collapses without clipping its legend or overflowing horizontally; on My Department confirm the QCD side-card stacks ABOVE the table (`order:-1`) and the sub-queue scope bar wraps to its own line rather than squeezing the note.
    - Confirm no page scrolls sideways at any width (the drive-smoke gate asserts this at 1440px only).
  Expected: every page reflows without horizontal overflow or clipped controls. Proposed in increment 54; promoted here for the same reason as S41.

S43 | Combined-view CSV export | Subsystem: Department Dashboard
  Steps:
    - On a parent dept (Sales / CSR / Power) -- the combined view is now the only view -- use Export -> Download CSV.
    - Open the file. Confirm a leading `Department` column, each dept's rows grouped together, a `<dept> subtotal` row after each group, and a final `All shown` grand-total row.
    - Confirm NO group-header banner rows (deliberate: a spreadsheet reader needs a column to pivot/filter on -- see docs/client-ui-conventions.md).
    - Now the SINGLE-dept case. Open a dept with NO sub-queues -- 11 of 14 qualify -- and export. Confirm the `Department` column is ABSENT and the file is otherwise the pre-sub-queue shape. This is the byte-compatibility guarantee for every dept that never had a sub-queue. (Re-automated in `drive-subqueue.js` via the `summary-30d-sales` fixture, so this step is now a double-check rather than the only cover.)
    - Collapse a group, then export again. Confirm the CSV is UNCHANGED: collapsing is a display affordance and must not narrow the export.
    - Spot-check an agent whose name begins with `=`, `+`, `-` or `@` if one exists: the cell must be quote-prefixed (the `csvSafeCell_` formula-injection rule).
  Expected: as described. NOTE `drive-subqueue.js` now covers BOTH the combined and single-dept CSV shapes; what stays manual is the formula-injection spot-check and the filename-collision case, which a headless download cannot observe.
