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
  Expected: headline + summary strip render; 18-bucket hour-of-day chart (8 AM-5 PM CST) with per-bucket drill-in (the Bars/Radar toggle is HIDDEN for everyone since Round-16 -- always bars); each agent card's "■ chart" button scopes the chart to that agent with a toolbar chip to clear (R11-C4); queue-only abandons section when present; per-agent cards with timestamps, abandoned ones red + 🚨 with the "↳ path" journey drill. Changing the page From/To + Refresh re-renders the section for the custom range.

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
    - (The standalone Performance Report is RETIRED -- Insights is the replacement.) Go to My Department and scroll to the Insights section (open by default, bottom of the page -- it GENERATES automatically with the page, no setup form). Set the DEPT controls' From/To to last month (M2: the dept row is the single date authority; the open region re-runs on the change) with no agents checked (whole department).
    - Check the agent cards' delta badges vs the immediately-preceding same-length window (INV-28; the rollup KPI tile row is hidden since R17b -- the sticky Team Rings Data panel carries the dept-level % Ans (rings) + its prior delta); the "Comparing against..." line shows the explicit prior dates.
    - Scroll to the share-of-answered donut (below the trend chart) -- one slice per agent, small slices unlabeled.
    - (R16g: the "Absolute" chart basis is HIDDEN -- the agent table on the same page carries those volumes; the renderer stays inert and the admin A/B remote can still reach it.) In Chart view confirm the visible bases are Gap vs team / Trend, and that the Metric selector offers Answered / Missed / % Answered (Rung removed, R16g).
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
    - Go to My Department and scroll to the Insights section (generates with the page). Via "Comparison & agents", set Compare = Custom prior range with a prior window >= 1.2x longer (in working days) than the selected range; Apply.
    - Generate.
  Expected: the results compare-line carries the inline "Different window lengths" caveat; raw-volume team insights are dropped (rates kept); agent cards show per-day sublines on volume/time metrics; the CSV gains /day columns (team rollup + per-agent).

S19 | Insights custom prior range round-trip (ex-Compare Ranges) | Subsystem: Department Dashboard
  Steps:
    - Open Insights; set Compare against = Custom prior range with the same month last year as the prior window and this month-to-date as the range.
    - Then click "Comparison & agents" in the results header, swap one agent out, leave Compare at "Keep current comparison", Apply.
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
  Expected: first run creates Access Control + Alert Config + Alert Log + Pipeline Health + Digest Config + Agent Alias Overrides + Orphan Fix Log + Dept Config + Report Usage + Queue Report Subscribers + Company Holidays + Dashboard Standards + Exception Days (each with their header row + frozen first row; Company Holidays col A, Dashboard Standards col D and Exception Days col A plain-text formatted; Dashboard Standards is also POPULATED -- one row per roster dept plus a `*` row, CSR reading 92 / 2 on a seed install); second run logs "already exists, skipping" for all thirteen and rewrites the Dashboard Standards rows in place -- no data overwritten on either run. New columns added in a later code change to an existing sheet are NOT applied by setup() -- the sheet's existence short-circuits ensureSheet_.

S23 | Overview is the default landing + tile click solos the trend line | Subsystem: Department Dashboard
  Steps:
    - Open the deployed URL (admin or manager).
    - Confirm Overview page loads first; header h1 is "Departments Snapshot"; the Overview button has the inverted (active) styling.
    - Click any dept tile in the grid (#1).
    - Shift-click (or Cmd/Ctrl-click) a second dept tile.
    - Click the sole-pinned tile again (after releasing the others).
    - As admin (or a manager on their own dept's line): click a POINT on a dept's trend line.
    - (Step 2 #6) Sign in as a single-dept MANAGER and reload: the chart opens with the black Company line and their own dept's line in colour and every other line grey, the y-axis NOT zoomed. Hover another dept's tile: its line previews, then the default comes back. Click any tile: it solos (and zooms) as before; release it, wait for the 5-minute refresh -- the default does not come back until the next page load. As an ALL-departments manager: only the Company line is in colour. As admin: every line, as before.
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
    - Server returns the rename count; the orphan row disappears from the list on refresh (unless some days collided with an existing row for the target name: those stay under the old name and the message names them, PC-4); "Current aliases" gains a new row with Active=Yes; "Recent fix log" gains a `rename+alias` entry.
    - Open the CDR Report spreadsheet -> DQE Historical Data; confirm the Agent Name column for the affected rows now shows the canonical name.
    - As a non-admin manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).applyOrphanRename({fromName:'X', toName:'Y'})`.
    - Expected: non-admin call throws "Alerts are admin-only." (the assertAdmin_ guard); admin Apply succeeds; renamed rows appear in subsequent dashboard reports after the 5-min cache TTL; the next daily DQE build does not re-introduce the orphan because the alias is honored by loadRosterCanonicalNames_.
    - Negative test: try renaming to a name not on any dept's roster (e.g. "Garbage Name"); expected: "X is not on any dept roster..." error.
    - Negative test: try renaming a queue-sentinel ("A_Q_CSR") as fromName or toName; expected: "Queue-sentinel names cannot be renamed..." error.

S32 | Queue data end-to-end (Insights Queue health + retained QCD surfaces) | Subsystem: Department Dashboard + CDR Import
  Steps:
    - (The standalone QCD Report modal is RETIRED -- QCD->Insights consolidation. Queue data is now verified via Insights Queue health + the three retained QCD surfaces below.)
    - Open the dashboard as a manager. Go to My Department and scroll to the Insights section (N1: open by default at the bottom of the page, the lens switcher is removed; it GENERATES the agent-free whole-dept report automatically with the page); move the DEPT From/To to a range with known QCD activity if needed (M2: the dept controls are the single date authority; the open region re-runs on the change).
    - Confirm the Queue health section renders: tiles (Queue calls / Abandoned % / Violations MTD -- warn-tinted per the 4% abandon standard) + the muted secondary line (Answered / Longest wait / Avg answer); one row per queue in the dept's effective queue list, sub-queue rows tagged + excluded from the dept total; every row expands into the secondary-metric strip, the per-call-source subtable (Overall + CSR / Ad-campaign / New Call Menu / Non-CSR, Overall-first then by volume), and violation dates. The collapsed Daily breakdown table shows the per-day rows with the answered/abandoned tally (abandoned count red, zero counts muted); for a parent dept with sub-queues each DATE renders one clickable "All queues" row whose per-queue rows are collapsed beneath it (R16c -- click or Enter/Space expands; a violation-date chip auto-expands its day and flashes that queue's row).
    - Switch the consolidated trend chart's Metric dropdown (`#ins-trend-metric`, the R11-C3 single selector) to "Queue: Abandoned %": one line per queue + a dashed "Dept total" line + the dashed 4% threshold; days/months at or over 4% render enlarged warn-colored points (violation markers). The legend shares the Overview chart's spotlight (hover to dim others; click to pin/isolate) via the `chartSpotlight*` helpers. The same dropdown's "Queue: Total calls" / "Queue: Violations" entries switch the queue metric; the Monthly/Daily toggle switches the axis.
    - As an admin, pick a dept with NO mapped queues and Generate: Queue health renders the "No queues are mapped" hint with an "Open Dept Config" button (managers get the ask-an-admin wording).
    - Deep-link check: open `<dashboard-url>#/report/qcd` -- it lands on the Insights page (legacy links repoint).
    - Quick-start chip (Help modal since R10-1): click "Are callers giving up before we answer?" -- Help closes, Insights opens and auto-runs over the last 30 days.
    - Re-open the dashboard fresh and check the Overview tile for a dept with multiple queues; per-queue QCD rows appear showing each queue's abandoned %, abandoned count (if >0), and violations (if >0) with color-coding. "X viol MTD" chip renders when month-to-date violations > 0.
    - All-departments daily report (4b, open to all managers): as EITHER an admin OR a manager on the Overview page, confirm a "Daily Call Queue Report" button (`#ov-qcd-alldept-btn`) is visible (no longer `data-admin-only`). Click it; the `#qcd-alldept-modal` opens and **pre-loads the latest queue day** immediately (no Generate click; falls back to the previous workday -- never a bare weekend/holiday "yesterday"). Confirm a flat company-wide table with one section per mapped dept (own queues only -- a sub-queue lists under its own dept exactly once, never under the parent), a per-dept subtotal row, and a "Company total" grand-total footer; **Answered / Abandoned / Abandoned % render as a split bar**; abandoned %>=4% (the company standard since 2026-08) and violation counts are warn-tinted. Change the date via the in-modal date toolbar (preset or from/to + Update) -- it re-generates in place (no back-to-form step). Click a queue row -> it expands into the per-call-source breakdown (data-driven per queue) + violation dates. Via the Export ▾ menu (R11-B3): Download CSV (scope line + per-dept rows + subtotals + grand total, all numeric columns), Print (plain-table print window), and "Email me this report"; the admin-only "Send to subscribers…" stays a separate button. Console check: `google.script.run.withSuccessHandler(console.log).getQcdAllDepartments({from:'2026-05-01', to:'2026-05-19'})` RESOLVES for a manager; only a `role==='none'` visitor is refused ("Not authorized.").
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
    - Confirm the combined grand total's COUNT cells (Unique / Rung / Missed / Answered / TTT) equal the sum of the per-dept subtotals -- EXCEPT where `totals.crossoverAgentCount > 0`, in which case the grand total is deliberately LESS (Phase 0 de-duplicates an agent on two rosters; the totals-row caption says so). NB this de-dup applies to ALL-QUEUE rows, i.e. the default `QUEUE_SPLIT_SCOPE=off` state. With the scope set to `dept` (Operator State #42) a narrowed row is NOT de-duplicated -- the two appearances then carry different figures that partition the agent's day, so summing is correct and subtracting would under-count. Check which mode you are in before calling a mismatch a bug.
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
    - Open the dashboard as a manager; go to My Department and scroll to the Insights section (N1: open by default at the bottom of the page, generated automatically with it; the lens switcher is removed; per-dept gated server-side like IR/CR). The dept page stays active (data-page='dept'); the My Department tab keeps the header highlight.
    - It GENERATES with the page (default compare = "Immediately-preceding period"; no setup-form step -- since M2 the DEPT controls row edits the window (the region's own header date row was removed in M4) and the "Comparison & agents" popover edits the rest). Adjust to a range with activity via the dept From/To (the open region re-runs on the change) and pick 2+ agents via the popover. Confirm (R17b: the rollup KPI tile row is HIDDEN -- the department-level rollup is the sticky Team Rings Data side panel, which stays on screen here): the 12-Month Team Trend chart with its single Metric dropdown (R11-C3; admin sees the ATT + Queue entries); per-agent cards each carrying 6 metrics with their OWN delta badges; floaters get the QUEUE chip + warn border and are excluded from the rollup caption's roster-only totals (INV-53).
    - Cards carry a left-border classification tint (improved=accent / regressed=warn / mixed=muted) + a "vs Team" badge; the Sort control re-orders (Most answered default / Name / Biggest improvers / Biggest regressors); agents with no notable movement collapse into "Show N quiet agents".
    - Switch Compare against to "Same window one year prior" -> hint previews the resolved YoY window; Generate -> "Comparing against the selected prior window" line + per-agent prevs from the YoY window.
    - Switch to "Custom prior range" (via the popover's Prior from/to inputs) with a window >= 1.2x longer -> after Apply, the results show the different-window-lengths caveat and per-day sublines on volume/time metrics (INV-35 contract).
    - Queue health (when the dept is QCD-mapped): the per-queue detail table renders one row per queue with abandoned % / abandoned / violations. For a queue whose abandons are driven by a non-Overall call source (4c), the queue-name cell shows a muted "↳ most abandons: <source> (N)" annotation; queues with no sub-source abandons show no annotation. As ADMIN, an `#ins-heatmap` weekday×hour abandon heatmap renders below Queue health (the same shared panel the QCD report shows); managers don't see it.
    - Agent-free run (Phase 2 parity): leave ALL agents unchecked and Generate -> the report runs over the whole dept roster (the digest pattern, INV-45; floaters excluded), rendering Queue health (the per-queue table; its card column is hidden per R17b) + every roster agent's card -- the QCD-replacement queue/dept quick-look. Generate stays enabled with nothing checked (only a truly empty roster disables it).
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
    - (IXT-1, after the cdr-import + dashboard deploys and `backfillInboundCalls(from, to, true)` over a held date) Caller Lookup on a call an agent transferred to a colleague -- one of `diagnosePersonTransfers`' "linked" samples, e.g. 1783985478661 on 10/26: after the agent's answer the path shows the colleague they tried first with "no answer · went to voicemail", the consult ("consult with the agent"), then the colleague "took the caller" with that talk; the chain reads ... → agent ✓ → colleague ✗ → colleague ✓; "Call ended" is when the colleague hung up; no "(unknown)" recording row. The call's answered / department / wait figures are the same as before.
    - (QF-1, after the dashboard deploy; no rebuild needed) Caller Lookup on a call whose queue rang its first agent in the same second, e.g. a 10/26 Sales call: the path lists A_Q_Sales BEFORE the first agent it rang, in both the chain and the rows.
    - (OXT-1, after `backfillOutboundCalls(from, to, true)` over a held date) Caller Lookup on an OUTBOUND call from one of `diagnosePersonTransfers`' "outbound linked" samples: the outbound card's path shows the consult and the colleague taking over the call after the agent's own leg; Connected / Talked / Rang / attempts read as before. A timing-only sample shows the colleague attempt with "no answer". Agent Day for the dialling agent: the call's To label is still the outside party, never the colleague consulted.
  Expected: capture is idempotent (force re-import refreshes rows, no dupes); anonymous callers carry null hashes and only count in the headline KPIs; no raw phone number appears anywhere in Neon or the export tab (hashes only); dept slices + the company view sum consistently apart from the IVR bucket and any answered-on-hold calls whose raw final_dept label doesn't match a dashboard dept header (the documented soft coupling); Download CSV includes the scope line, all four breakdowns, and the daily series.

S39 | Keyboard-only walk of the primary drill paths (F13) | Subsystem: Department Dashboard
  Steps:
    - Load the dashboard and use ONLY Tab / Shift-Tab / Enter / Space (no mouse).
    - On Overview: Tab to a dept tile and press Enter -- it should SOLO that dept's line in the trend chart (Shift/Cmd/Ctrl+Enter adds a second dept to the comparison).
    - Go to My Department; Tab to an agent's NAME (a button in the first cell -- the row itself is not a tab stop, F27) and press Enter -- the inline agent panel opens below the row and a screen reader announces the name as expanded. Tab once: focus lands on its "Individual report" button; Enter opens the report. Escape inside the panel closes it and puts focus back on the agent's name, announced collapsed. Press Space on the name: it must open the panel WITHOUT scrolling the page.
    - Open the all-departments Daily Call Queue Report; Tab to a queue row and press Enter -- the per-call-source breakdown should expand, and Enter again collapse it.
    - Same on the Insights Queue health per-queue rows.
    - (Batch 9) Tab to a sub-queue group header on a parent dept's My Department table and press Enter -- the group collapses (drive-subqueue.js asserts this); Tab to any Inbound / Direct / Outbound report column header and press Enter -- the table re-sorts and `aria-sort` follows; open Chart tips from a `?` and Tab -- focus stays inside the popover until Close / Escape; in the guided tour, Enter on a focused button fires it ONCE.
    - In the My Department QCD side card (a multi-queue dept), Tab to a carousel dot and press Enter -- the carousel should change page.
  Expected: every one of the above is reachable and activatable by keyboard, each focused element shows a visible accent focus ring, and `aria-expanded` flips on the expandable rows. AUTOMATED COUNTERPART: `tools/ui-harness/drive-f13.js` asserts all of this in headless Chromium (13 checks) -- run it after any change to the agent table, the Overview dept grid, or either qcd-expandable table. Table rows carry `tabindex` but deliberately NO `role="button"` (that would override the implicit row role and break table semantics), so a screen reader still announces them as grid rows.

S40 | Escalation overdue count agrees with the flagged cards (F3) | Subsystem: Department Dashboard
  Steps:
    - Ensure at least one OPEN (pending / in_progress) escalation has `occurred_at` between 68 and 76 hours ago -- the window where a 72-hour test and a calendar-day test disagree.
    - Open the Escalations page with the Pending filter.
    - Compare the sidebar "Overdue >3d" tile number against the count of cards showing the red ⚑ age badge.
    - Also check the Escalations nav-tab badge tooltip ("N open (M overdue)") against the same cards.
  Expected: the tile, the nav badge, and the ⚑ cards all agree. A card flagged ⚑ that the tile doesn't count (or vice versa) means the server's `escOverdueSql_` and the client's `escDaysOpen_` have drifted apart again -- they must BOTH be calendar-day comparisons. Note the counts are viewer-scoped and status-independent, so compare against ALL open cards (Pending + In progress), not just the active filter.

S41 | Theme × mode sweep (perceptual) | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard in LIGHT theme, then switch to DARK (Settings toggle), on each page: Overview, My Department, Insights, Escalations.
    - On each, confirm every chart's lines/bars/labels remain legible and no text drops to invisible (the INV-42 OKLCH/datalabels class -- a token that fails to resolve renders an empty fill, which looks like a missing label rather than an error).
    - Repeat with "Show data labels" ON (IR / Insights), and with reduced-motion enabled at the OS level.
    - (C1-17) In DARK mode, trigger a success toast (save any admin config) and an error toast (submit an invalid date range), and open a destructive confirm (an Outlier Fix rename) -- the text ON those filled surfaces must be legible. They read `--on-good` / `--on-warn`, which flip to dark ink in dark mode because the fills lighten; a regression to hardcoded white lands at ~2.3:1 and no test can see it.
  Expected: no invisible text, no chart element that changes meaning between themes, no animation that ignores reduced-motion. Proposed in increment 54 as a perceptual check no code can verify; promoted here so it stops being an un-numbered TODO.

S42 | Narrow-viewport trend band (perceptual) | Subsystem: Department Dashboard
  Steps:
    - Narrow the browser to ~900px, then ~700px, then ~400px.
    - On Overview confirm the stacked sticky trend chart collapses without clipping its legend or overflowing horizontally; on My Department confirm the QCD side-card stacks ABOVE the table (`order:-1`) and the sub-queue scope bar wraps to its own line rather than squeezing the note.
    - Confirm no page scrolls sideways at any width (the drive-smoke gate asserts this at 1440px only).
    - (UD-1 / UD-2) At ~400px: open a report setup form (IR / Inbound / Direct / Outbound) and confirm its date row STACKS rather than overflowing the modal body sideways, and confirm My Department's Insights region (the abandon heatmap and the Queue-health table card) fits the content box instead of forcing the page sideways.
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

S44 | CSR transfer detail renders and reconciles | Subsystem: Department Dashboard
  Steps:
    - Open My Department as an admin (or a CSR manager) with department = CSR and a range covering at least a full week. Note the team strip's Transfer % tile (value + its "N of M calls" sub-line).
    - Expand the folded `Transfer detail` section below the agent table.
    - Switch to any NON-CSR department and confirm the section disappears entirely (the server ships `csrTransfer` for CSR alone).
    - Back on CSR, check `Where transfers go`: one bar row per destination queue carrying a real queue NAME read from the sheet header -- never a `Queue 1/2/3` placeholder -- biggest first, with no zero-transfer rows.
    - Check `Who transfers`: one row per agent, busiest transferrer first, each rate tinted on the SAME tier scale as the headline tile (at/below the deep tier reads green; past the amber tier reads red).
    - Add up the per-agent `transferred` numbers and compare against the tile.
    - (Owner 2026-10-22) The agent table's **Transfer %** column: each CSR agent's rate equals their `Who transfers` row; the totals row equals the tile; an agent with no transfer row shows a dash and stays last when you sort the column either way; with the outbound columns on (admin) the IN / OUT table shows the same figure. Switch to a non-CSR department: no Transfer % column, and its CSV has none.
    - Collapse and re-expand the section.
  Expected: the per-agent transferred values SUM to the tile's transferred figure. Rows are deliberately NOT roster-filtered, so a departed agent may appear with historical volume -- correct, not a bug. When the 11 destination columns do not cover every transfer a note above the lists says so and gives both numbers; when they do, no note appears. Collapsing does not refetch or change any figure.
  Fails if: the section renders for a non-CSR dept; queue labels are placeholders; the per-agent rows do not sum to the tile; or a range whose data was BACKFILLED (imported out of chronological order) shows fewer transfers than the tile -- that last one is the append-only/never-sorted trap the bounded-span read exists to prevent.

S45 | Admin deletes a mistaken escalation (2a) | Subsystem: Department Dashboard
  Steps:
    - As an ADMIN, log a throwaway escalation via "+ New escalation" (any dept, reason "test -- delete me").
    - On its card, find the muted "Delete…" control below the card body (right-aligned). Click it. Confirm the dialog is the DANGER tone, names the escalation by id / dept / date and NOT by patient, and offers "Keep it" / "Delete permanently". Click "Keep it": the card stays.
    - Click "Delete…" again and confirm. Expect the toast "Escalation deleted", the card gone, and the nav badge / sidebar counts updated (the F10 reload).
    - Open Admin -> Health -> "Report usage": a fresh `escalations:delete` row for your email and the dept, carrying no id and no patient text.
    - Enter View-as-Manager (any dept): no "Delete…" control on any card. Sign in as (or view the page as) a real manager: none either.
    - Optional: with Neon reachable, run `SELECT count(*) FROM escalation_activity WHERE escalation_id = '<the id>'` in the Neon console -> 0 (the trail went with the row).
    - (QF-2) On a pending card the buttons sit in ONE row: Start (solid), then Edit and Move as outline buttons, then Link department and Delete… on the right. Hover each: every one names what it does (Start: "Mark this escalation as In progress"). Move and Link department carry no "…". Clicking Move or Link department opens its form right under the row, above "Resolve / comment…". In View-as-Manager only Start remains.
  Expected: as described. Clicking Delete twice quickly, or on a card another admin already deleted, shows "That escalation was already gone" and reloads -- never an error.
  Fails if: a manager sees or can invoke the control; the dialog is not danger-toned or names the patient; the trail survives the row; the usage row carries an id or PHI; or an outage-snapshot read (Neon down) still shows the deleted card.

S46 | Outbound reaches a manager on My Department (the 6c release) | Subsystem: Department Dashboard
  Steps:
    - PRE-RELEASE (run this half FIRST, while `OUTBOUND_VETTING_GATE_` is still true). As a non-admin MANAGER, open My Department: there is no "Show outbound columns" toggle (`#dept-dir-switch`), and neither the Outbound summary nor the Callbacks section appears under the outbound table (UX-1); the Overview tiles show no outbound line. Paste the deep link `#/report/outbound` into the address bar and reload: a plain My Department landing on Inbound -- no fold, no error toast. In the browser console, call `google.script.run.withFailureHandler(function (e) { console.log(e.message); }).getOutboundReport({ from: '<any>', to: '<any>' })`: expect "admin-only while it is being vetted". A manager who CAN see any outbound surface here means the pieces drifted.
    - RELEASE GATE. As the admin, run `backfillOutboundCalls` (cdr-import), then `runOutboundVettingCheck` (dashboard editor) over a window with real abandons. Read the verdict: release ONLY on `ok parity`. INCONCLUSIVE (a zero-abandon window -- true by construction, not a pass), FAILED or MISMATCH all STOP here. Operator State #63 is the full runbook.
    - POST-RELEASE. Flip `OUTBOUND_VETTING_GATE_` to false AND drop `data-admin-only` + `style="display:none;"` from `#dept-dir-switch`, `#ins-ob-fold` and `#ins-cb-fold`, in the SAME commit (cross-file-pins fails on any half alone). Deploy.
    - As a single-dept MANAGER on My Department: the switch now appears. On Outbound the agent table lists ONLY agents on that manager's roster (plus a parent's sub-queue groups), and the note quantifies any off-roster diallers rather than hiding them. The Overview tile for their dept shows the outbound line.
    - On Outbound, under the outbound agent table, open "Outbound Callbacks": `Abandoned` names how many were anonymous; `Called back` divides by the TRACKABLE count, not the total; `Callback rate` and `Median time to callback` render; the caption names the 3-day window. `Callbacks connected` (never "Actually reached") shares the trackable denominator, its foot says "incl. voicemail", and the caption calls it an upper bound on callers reached. Hovering `Connected` shows the definition (a person, a voicemail greeting or a phone menu) -- and no surface shows an audit-derived voicemail figure.
    - Paste `#/report/outbound` and reload: My Department on Outbound with the Callbacks fold open and scrolled into view.
    - In the console, call `getOutboundReport` with a department the manager does NOT own: expect "Not authorized for this department." A multi-dept manager may pass any of their own; an `ALL`-sentinel manager takes the admin-style branch. The Overview's "Callbacks by department" section stays ABSENT for every manager.
    - Click "List not-called-back calls": rows carry a time, queue and abandon stage and NEVER a caller number or name.
  Expected: as described. A crossover agent (two roster homes) appears in BOTH depts' views with their whole-day outbound figures -- correct per the Option C ruling, not a double-count bug.
  Fails if: a manager sees any outbound surface while the gate is true (or does not see them once released); a view opens for a dept they do not own; the callback rate divides by the TOTAL abandons instead of the trackable ones; the agent table shows off-roster names without the disclosure; a manager ever sees Callbacks by department; or any surface renders a caller number.

S47 | Agent-day view: fidelity degrades honestly across the three horizons | Subsystem: Department Dashboard
  Steps:
    - As a MANAGER, open Reports -> Agent day. Confirm the Department select is pinned + disabled when you own one dept, and that the Agent list holds exactly your roster's names (they must match the DQE spelling byte-for-byte -- INV-04; a name that renders differently here than in My Department is the bug).
    - Pick an agent and a date INSIDE the journey horizon (the last ~90 days, anything the daily import has processed). Confirm: NO fidelity banner; in the INBOUND tile row, Rung / Answered / Missed / Talk time equal that agent's row in My Department for the same single day, and Transferred / Hold show figures; the OUTBOUND tile row shows Placed / Connected / Talk time / Unconnected / Attempts, with Placed = the outbound list's length; the inbound list shows a mix of Answered / Missed / Rang chips; the outbound list shows Connected / Not connected.
    - Read the reconciliation line under the tiles. On a full day it either says nothing (the per-call list matched the daily total) or explains the work-window gap. It must NEVER be absent while the two numbers differ.
    - Now pick a date roughly 4-6 months back (past the journey horizon, inside the ~400-day row horizon). Expect the amber banner "Partial detail -- leg-by-leg history has aged out", an inbound list holding ONLY calls this agent rang first, an outbound list that is still complete, Transferred / Hold reading "–" ("needs the call journey") while the outbound tiles still show figures, and a reconciliation line saying the list is a SUBSET. The header tiles must still be correct -- they come from DQE, not from the list.
    - Pick a date beyond the row horizon (over ~13 months back, still inside DQE history). Expect the "Before per-call capture" banner, "Outbound not captured for this day" in place of the outbound tiles (never a row of zeros; also on any date before 2026-07-10, when outbound capture began), empty inbound/outbound lists, and the "Missed rings (from the daily totals)" section carrying timestamps. Confirm the section explains that answered calls leave no per-ring trace there.
    - CROSSOVER agent: pick one on two rosters. A manager of EITHER dept must reach them; the title names the dept that granted access.
    - NEGATIVE, in the browser console: `google.script.run.withFailureHandler(function (e) { console.log(e.message); }).getAgentDay({ agentName: '<an agent on a dept you do NOT own>', date: '<any>' })` -> "Not authorized for this department." Then try a name on no roster at all -> "Admin only." as a manager; an ADMIN gets the day with "(not on any roster)" in the title.
    - Spot-check PHI: nothing in the page or the payload carries a caller number, a caller name, or a hash.
  Expected: as described. The three banners are the point of the scenario -- a short list with NO banner is the failure this surface was designed around, because it reads as "the agent did nothing" when it means "we no longer hold the detail".
  Fails if: any tier renders a short list with no disclosure; the header tiles disagree with My Department for the same agent-day; a manager reaches an agent on neither of their depts; an unrostered name resolves for a non-admin; or the reconciliation line claims an exact match on a degraded day.

S48 | Outbound callbacks by department (CB-1, on the Overview since G2) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, land on the Overview and scroll to the bottom: a closed "Outbound Callbacks by department" section reads "open to load". Nothing loads until you open it, and the 5-minute auto-refresh never loads it.
    - Open it: the window defaults to Last 30 days (ending yesterday, dates shown). The header reads "N of M callers not called back · P% called back by their own team". Above the table (CB-R1): the big number is the callers NOBODY called back, "of M callers who hung up on a department's queue · X% of them", then ONE bar of five segments -- own team, another team, got through, still in the callback window, not called back -- with a legend "n · pct%" under it, and a quality line (own callbacks connected, median time, change vs the prior window). Default order (CB-R2) is most "Not called back" first; a sub-queue (e.g. Spanish) sits indented directly under its parent (CSR) whatever the sort; "Not mapped to a department" (if present) is always last.
    - Arithmetic: the five legend counts sum to M; on any row, own team + another team + got through + not called back + still in window = Contact episodes. Same on the "All departments" total row, which equals M.
    - Open "How this is counted": the phone-menu / person's-line hang-ups and the episodes on unmapped queues are named there (never in the bar). Summing the dept rows does NOT give the total (a parent includes its sub-queues; a queue shared by two depts is in both) -- the note says so.
    - Expand a department with callers not called back: "List the N callers nobody called back" loads that department's list for the section's window; each block matches a not-called-back episode. Click again: it closes.
    - Pick one department with a "Not called back" count and spot-check it in Caller Lookup against the not-called-back list's call ids: no dial from that team inside the window.
    - Hover each header: the definitions name the contact episode, "may be unrelated" for another team, "upper bound" for Connected, and a Median clock from the FIRST attempt that includes internal handoff.
    - Keyboard only: Tab to a row's department button, press Enter -> the row expands (aria-expanded true) showing "Called by (roster)" rows counted as "own team" or "another team", naming departments / "Unrostered" / "No agent recorded", the multi-roster / unrostered / no-agent tallies and the repeat-attempt line; the unmapped row's expand lists the unmapped queue names. Tab to a header, Enter sorts; Enter again flips.
    - Download CSV: a "Department / Parent / Contact episodes / ..." block in the order on screen, with the total row labelled "All departments (each episode once)". No cell begins with = + - @.
    - Switch the window to Last 7 days: it loads once for the new window. Close and reopen: no reload.
    - View as a manager: the section is gone. As a real MANAGER (also after the 6c release): no section and no request.
  Expected: as described. A parent's agents count as own team for its sub-queues' episodes and vice versa; a crossover agent counts as own team for any dept they are rostered on; phone-menu hang-ups never appear in a row.
  Fails if: a row's five outcome columns do not sum to its contact episodes; the bar's segments do not sum to the callers who hung up, or the total row disagrees with the summary; a child row detaches from its parent on sort; the unmapped row is missing while unmapped abandons exist; the section loads before it is opened or on the auto-refresh; a manager or View-as sees it; or any cell shows a caller number.

S49 | Transfer abandons land on the target dept (S2C-2, S2C-6) | Subsystem: Department Dashboard
  Steps:
    - In the dashboard Apps Script editor, run `sampleTransferAbandons` (optionally set `XFER_SAMPLE_FROM` / `XFER_SAMPLE_TO` first; the default is the last 10 days). Read the log: MOVED count by route (answering label -> target queue -> dept), the not-moved counts, and up to 25 moved calls.
    - Pick 3-5 moved calls. In the CDR Import spreadsheet open `Call_Legs_<date>` and search each CUSTOMER call id and its TRANSFER call id: the customer leg was answered and the caller disconnected on hold; the transfer group was placed by that same agent, to the named queue, and nobody on it answered.
    - Read the `(stayed)` lines too: each is a transfer the target never answered where the CALLER's call ended well AFTER the attempt (the agent gave up and went back) -- check one: the customer's legs continue past the transfer group's end. Those are correctly NOT counted.
    - If the log lists any `[in target queue]` calls, check one the same way: the customer leg was answered (it may show hold time -- the phone system just did not flag the hang-up as on hold); the transfer group was placed by that agent to the named queue, nobody answered, and the caller ABANDONED in that queue.
    - Open Reports -> Inbound for the answering dept over the same window: the "Abandoned on hold" tile foot says "N moved to the transfer target". Open it for the target dept: "N while being transferred here". Total and Answered for the answering dept are unchanged from before the change. The "All departments" view's foot says "N hung up in a transfer target queue" when any exist, and its on-hold count equals the depts' parts (a double-mapped or parent queue aside).
    - S2C-6: read the log's last section, TRANSFERS NOT ANSWERED. Pick 2-3 counted attempts, including one NOT tied to a customer call, and search each transfer call id in `Call_Legs_<date>`: an internal call (placed by an employee, no outside caller) to the named queue, nobody answered, abandoned after MORE than a minute in the queue. Then open Reports -> Inbound for that dept: the "Transfers not answered" tile equals the log's count for its queues over the same window (work-window days only), and its foot says how many were tied to a customer call. "Abandoned on hold" does not change because of these.
  Expected: every sampled call reads as "answered, then transferred to a dept that never picked up, and the caller hung up" -- on hold, or in the target queue.
  Fails if: a sampled transfer group was ANSWERED; the transfer was placed by a different agent or long after the answer; an `[in target queue]` sample was not abandoned in the target queue; the answering dept's Total or Answered changed; or a move appears with no explanation in the tile foot.

S50 | Admin moves an escalation to another department (ESC-R1) | Subsystem: Department Dashboard
  Steps:
    - As an ADMIN, log a throwaway escalation for CSR ("test -- move me"). On its card click "Move…": an inline panel lists every OTHER department (not CSR) and an optional note box.
    - Pick Sales, type a note, click "Move escalation". Expect the toast "Moved to Sales", and the card to show the Sales tag (or leave a CSR-filtered list).
    - Open its Activity: a "Moved" entry "CSR → Sales: <your note>" with your email.
    - With `NOTIFY_ON_NEW_ESCALATION=true`: the Sales managers (not CSR's) receive "Escalation moved to Sales", saying it came from CSR; you get the `[Copy]`.
    - Click Start on it, then Move it again (e.g. to Power): it moves and stays IN PROGRESS.
    - Resolve it, then look for Move: none on a resolved card (reopen first). Open "Edit" on a pending card: the Department field is locked (use Move).
    - As a CSR manager (or View-as-Manager for CSR): the moved escalation is gone from their list; as a Sales manager it is there with its whole trail. No manager sees "Move…".
  Expected: as described; the escalation keeps its status and its activity trail across the move.
  Fails if: a manager sees or can invoke Move; the old dept can still open the moved escalation; the move is missing from Activity; the status changes; or the email goes to the OLD dept.

S51 | One escalation assigned to several departments -- linked copies (ESC-L1) | Subsystem: Department Dashboard
  Steps:
    - As an ADMIN, click "+ New escalation": the Department list is a multi-select with nothing pre-picked. Ctrl/Cmd-click CSR and Sales, enter a reason ("test -- linked"), save. Expect the toast "Logged for 2 departments (linked copies)".
    - On the list (All departments): two cards, one CSR and one Sales, each saying "Also assigned to <the other> · pending".
    - Click Start on the CSR copy only: the Sales card now says "Also assigned to CSR · in progress" and stays PENDING itself.
    - Overview: the escalations strip counts both copies and says "(2 linked)".
    - On the CSR copy click "Move…": Sales is NOT offered. Move it to Power: both cards now name each other (Power and Sales).
    - With `NOTIFY_ON_NEW_ESCALATION=true`, log another linked one for CSR + Sales: each dept's managers get ONE email naming the other dept; a manager of both gets exactly one naming both; you get the `[Copy]`s.
    - As a CSR manager: only the CSR copy is listed, with the "Also assigned to" line; no Sales thread or fields are visible. Log a single-dept escalation as admin: no "Also assigned" line, no linked label.
  Expected: as described; resolving, commenting or editing one copy never changes another.
  Fails if: one create yields a single row; a copy's action changes its sibling; Move offers a dept already holding a copy; a manager sees another dept's thread or fields; or a manager of both depts gets two emails.

S52 | Linked escalation: shared thread, edit sync, link, remove, delete-all (ESC-L2) | Subsystem: Department Dashboard
  Steps:
    - As an ADMIN, log a linked escalation for CSR + Sales ("test -- thread"). As a CSR manager, comment on the CSR copy; as a Sales manager, comment on the Sales copy.
    - Open Activity on EITHER copy: both comments appear in one timeline, each tagged CSR or Sales, with the author's email.
    - As the admin, Edit the pending CSR copy (change the reason): the Sales card shows the new reason too; the thread has ONE "Edited" entry saying "applied to all 2 linked copies". Each copy keeps its own status.
    - On a copy click "Link department…", pick Power: a pending Power card appears, both others list Power, and the thread shows "Department added". With `NOTIFY_ON_NEW_ESCALATION=true`, Power's managers get the email naming CSR and Sales.
    - Click "Remove Sales…": the dialog will not accept an empty reason. Enter "Dispute upheld: billing matter". The Sales card turns "Removed" (read-only, the reason shown), leaves the Pending list and the Overview count, and the thread keeps the Sales comment tagged "Sales · removed" plus a "Department removed" entry with the reason.
    - As the Sales manager: the escalation is under Status -> Removed, opens read-only with the whole thread, and no Resolve / Comment / Start controls. A crafted resolve on it is refused ("was removed from this escalation").
    - Try removing CSR, then Power, as admin: the last active department is refused ("last department still on this escalation").
    - "Delete all linked…": a red confirm naming every department; confirming deletes every copy. A plain "Delete…" on a linked copy deletes only that copy.
  Expected: as described.
  Fails if: the thread misses another department's entries or its tags; an edit changes only one copy or changes a status; a removed dept can still write, or loses read access; the removal deletes comments; the last department can be removed; or Delete removes more (or fewer) copies than it says.

S53 | Restore a removed department; the thread while Neon is down (ESC-L3, ESC-S1) | Subsystem: Department Dashboard
  Steps:
    - As an ADMIN, on a linked escalation, Start the Sales copy, then "Remove Sales…" with a reason. On the Removed card click "Restore Sales…", add a note, confirm: Sales is back IN PROGRESS (the state it was removed in), back in its worklist and the Overview count; the thread shows "Department removed" then "Department restored" with the note. With `NOTIFY_ON_NEW_ESCALATION=true`, Sales managers get "Escalation returned to Sales".
    - Remove a RESOLVED copy and restore it: it comes back Resolved, with no email.
    - With a department removed, try "Link department…" or "Move…" to that department: refused, pointing at Restore.
    - Neon-down check (only when an outage happens, or on a dev copy with NEON_HOST pointed nowhere): open the Escalations page -- the read-only snapshot banner shows; open Activity on an open linked card: the thread renders with "Offline copy from <time>", department tags intact, long entries marked "(shortened in the offline copy)". A card the snapshot does not hold says Activity is unavailable.
  Expected: as described.
  Fails if: a restore lands in a different status than the one removed; the removal disappears from the thread; a removed department gets a second copy via Link/Move; or, offline, a manager sees another department's thread, or a thread shows only part of its entries without saying so.

S54 | Browser Back / Forward walk the dashboard's views (CL-23) | Subsystem: Department Dashboard
  Steps:
    - In TWO real browsers (e.g. Chrome and Safari or Firefox), open the deployed /exec URL fresh. Click My Department, then Escalations.
    - Press the browser's Back button: My Department shows, with its tab lit. Back again: the Overview. Forward: My Department.
    - As an ADMIN, open Reports -> Individual Report; press Back: the modal closes and the page under it stays. Forward: the modal reopens. Close it with X, then press Back: the modal reopens (closing was a step).
    - Open a deep link (.../exec#/report/insights) in a new tab, then press Back: the browser leaves the dashboard (no extra entry was added for the landing view).
    - As a MANAGER, paste .../exec#/admin/health, then click My Department and press Back: nothing admin-only opens.
    - Watch the address bar: each step shows the route after `#`, and any `?` query the URL was opened with is kept.
  Expected: Back / Forward step through views in the order visited; no step needs two presses; no console errors; the "Open in new tab" button still opens the current view.
  Fails if: Back leaves the dashboard while views remain in history; a step needs two presses (a duplicate entry); a modal stays open after Back to a page; the wrong tab is lit; anything differs between the two browsers (record which -- this API was once noted as spotty).

S55 | Abandoned-filter dialog matches the per-queue menu items (AF-1) | Subsystem: CDR Import
  Steps:
    - Deploy cdr-import, open the CDR Import workbook, reload it, and open a recent Call_Legs_<date> tab.
    - Run CDR Tools -> Abandoned Filters -> "Check the dialog against the old items (this tab)…" and confirm. It applies each of the 14 old filters and the dialog's filter for the same department in turn, reads which rows SHEETS hides, and ends with a VERDICT (it changes no data; it leaves the tab unfiltered). Repeat on a second, busy date.
    - Then by hand: Clear Filters, run "A_Q_CSR & Intake (59s)" and note the visible row count; Clear, open "Filter abandoned calls…", choose CSR, Apply, and compare with both the old count and the dialog's "expect N of M rows" line.
    - In the dialog: tick CSR AND Sales together (a 0:00:20 Sales leg shows, a 0:00:20 CSR leg does not); tick "Include the backup queue" (Backup CSR legs over 59 s appear); set a custom threshold of 120 s (only legs over 2 minutes stay); tick "Work window only" (legs before 6:00 AM PST for CSR / 6:30 AM for others, and from 3:00 PM, disappear).
  Expected: the check's VERDICT is CLEAN on both dates; the hand counts match the old item AND the dialog's expected count. Legs with NO queue name are included, as the old items include them (the report counts them per filter); unticking "Include legs with no queue name" removes exactly those.
  Fails if: the VERDICT is MISMATCH (send the report -- it names each differing row: queue, call time, row number, and which side shows it); a mixed selection applies one threshold to both queues; the backup queue appears without the box ticked; the dialog's expected count disagrees with what the tab shows.

S56 | Inline agent panel on My Department (Batch B) | Subsystem: Department Dashboard
  Steps:
    - As a MANAGER, open My Department over a window of a month or more. Click anywhere on an agent's row (not just the name): a panel opens directly below it, the row tinted with an accent rail. Click the same row again: it closes.
    - (QF-3) The open panel reads as part of its row: the row's accent rail runs on down the panel's left edge, a thin accent line marks its right edge (visible without scrolling the table), and the panel carries a faint tint. Check light and dark mode.
    - In the open panel: the strip shows that agent's days WITH ACTIVITY, oldest first left to right, opened on the newest day at the right-hand end (scrolled into view); each box shows answered / missed, the outbound count ("outbound –" on a day before 2026-07-10), and in its top-right corner the day's inbound answer rate -- answered / (answered + missed), whole percent, tinted green / amber / red against the dept standard exactly like the Answer % column (a box with no rings shows no rate). A day with no rings and no outbound calls is absent. The newest day is selected and its view renders below: the Inbound and Outbound tile rows, the same as Reports -> Agent day for that agent and date.
    - Widen the window past ~6 weeks: the note reads "Showing the 31 most recent of N days with activity ... Narrow the dates above to reach earlier days." and the strip holds 31 boxes. Use the ‹ › arrows to scroll it.
    - Pick an older day: the view below changes to it. Switch the tabs (Inbound calls / Outbound calls; Missed rings only on a day past the journey horizon) -- each shows its own list.
    - Sort the table by another column: the panel stays open under the same agent. Open a second agent: the first closes (one panel at a time). Collapse the sub-queue group holding the open agent: the panel closes.
    - (Step 2 1b) Inbound calls show a From column: a colleague by name and dept for an internal call, "Outside caller · <line name>" for an outside one (as ADMIN, the insurer's name when the number is a known insurer line). Outbound calls show a To column (a colleague, or "Outside number" / the insurer for an admin) and, under it, "↩ callback to HH:MM inbound (answered|abandoned...)" when that number called in earlier the same day. Check one callback against Caller Lookup. No phone number appears anywhere.
    - Click "Individual report ↗": the Individual Report opens for that agent over the same window.
    - Export CSV / Copy for spreadsheet with the panel open: the output is the table only, unchanged.
    - Set the window to ONE day and open a row: no strip, the day view directly.
    - (Step 3 #8, prefetch) With the browser's network panel open, rest the pointer on an agent row for a moment WITHOUT clicking: one strip request and one day request go out. Click it: the panel opens on the data with no "Loading days…" and no new request. Tab to a row's name button: the same prefetch.
    - On a phone-width window: the panel fits the screen, the strip scrolls sideways inside it, the page itself does not scroll sideways.
    - Opening and closing slide smoothly (about a fifth of a second); with the OS "reduce motion" setting on, they snap. While open, scroll the table sideways: the panel stays put on the left.
    - As the ADMIN, on the Outbound tab each call shows its id (#…), a 📋 copy button and "↳ path"; the path opens that OUTBOUND call's legs (a coworker who took it shows by name). As a manager: no id column.
    - NEGATIVE, in the console: `google.script.run.withFailureHandler(function (e) { console.log(e.message); }).getAgentDayStrip({ agentName: '<an agent on a dept you do NOT own>', from: '2026-09-01', to: '2026-09-30' })` -> "Not authorized for this department."
    - (OBX-1, after the cdr-import deploy and `backfillOutboundCalls(from, to, true)` over a held date) Open the agent who received a warm transfer -- one of `diagnoseOutboundTransfers`' "left out" samples, e.g. Julienne Inaanuran on 10/22: the Outbound tab no longer lists the transferred customer as a call she placed, while the agent who handed an OUTBOUND call to a colleague still shows it. Calls the diagnostic sorted as redials stay listed.
  Expected: as described; the selected day's tiles equal that agent's single-day row in My Department.
  Fails if: a click on a group head / subtotal / total row opens a panel; the strip shows a zero-activity day or more than 31 boxes without the note; an uncaptured day reads "0 outbound"; the panel widens the table or the page; a re-sort leaves two panels or an orphaned one; or the export carries any panel text.

S57 | My Department inbound + outbound together (Batch D; one toggle since Step 3) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN (admin-only until the Outbound report is released), on a browser that never chose otherwise, open My Department for a parent dept (e.g. CSR) over a month. The table shows inbound AND outbound together by default: one row per agent with the inbound bar + Answer % and the outbound bar (violet tallies, placed total in brackets, "N / day" on the Total row) + Connect % + Out talk, grouped per dept with subtotals. Next to the table title a "Show outbound columns" toggle reads ON. Team Rings and Team Outbound stack in the side column without overlapping.
    - Reconcile: the brief's Outbound row, opened, carries the same placed / connected totals as the dept's OWN subtotal row (S58).
    - Click the toggle OFF: the usual inbound table and Team Rings only. Reload: it stays off. Click it ON again: the combined table returns, and no outbound request is sent for a window already loaded.
    - Click any row (either table): the inline agent panel opens under it (S56).
    - Export / Copy with the columns on: the file is the INBOUND table (the note above the table says so).
    - View as a manager: the toggle disappears and the page shows the Inbound table. As a real MANAGER: no toggle, Inbound only, even with the columns turned on earlier on that browser.
    - NEGATIVE, as a manager in the console: `google.script.run.withFailureHandler(function (e) { console.log(e.message); }).getDeptOutboundSummary({ department: '<your dept>', from: '2026-09-01', to: '2026-09-30' })` -> "The Outbound report is admin-only while it is being vetted."
  Expected: as described; a dialler on no roster of the dept is left out and counted in the note.
    - (Layout B, owner 2026-10-21) Each agent's row shows an IN line over an OUT line -- Calls (handled / not), Rate (answer % / connect %), Talk -- with one bar scale, so a longer OUT bar means more outbound than inbound calls. The IN line has a faint blue wash and the OUT line a faint purple one, in light and dark mode. Under Calls, Rate and Talk, "in" and "out" each sort the table by that line; the header shows which.
  Fails if: an agent's outbound figures differ from the Outbound report's; the inbound table shows alongside the combined one; the panels overlap; a manager sees the toggle or the outbound columns; or anything adds inbound and outbound together.

S58 | Outbound on the Overview tiles and under the outbound table (Batches E/F, UX-1) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN (admin-only until the Outbound report is released), land on the Overview. Every dept tile shows a violet "Outbound" line under ATT: Placed N · Conn M P%. Expand a sub-queue card: the same line shows in it.
    - Switch the card Window to Last 30 days, then YTD: the line's figures change with the window. On YTD the line adds "since Jul 10" (capture start).
    - Reconcile one dept: My Department on Outbound for that dept, dates = the card window. Placed and Connected equal the tile's line against the dept's OWN subtotal -- the table's grand total also counts the one-level sub-queue rosters (PC-12) while the tile counts the dept's own roster, like the inbound tile.
    - Wait for the 5-minute auto-refresh (or reload): the line is still there and no slower (it rides the cached Overview).
    - Open My Department over a month (Step 3: with the outbound columns on OR off -- the section no longer follows them). In the brief under the team cards, the "Outbound" row reads "Outbound: N placed · P% connected". Click it: the section opens in place under the row with five tiles (Placed, Connected, Connect rate, Per agent-day, Avg talk), each with a ▲/▼ vs the prior window, and NO agent table (the table above is it). Placed and Connected equal the dept's OWN subtotal in the table (S57) for the same dates. For a parent dept (e.g. CSR) the head reads "CSR only · N placed …" and a note names the sub-queues the table also includes and the table's total.
    - Collapse the Insights region, then change the dates and Refresh: the Outbound and Callbacks rows still load for the new window (they follow the page's dates, not Insights').
    - Pick dates whose prior window starts before 2026-07-10: the summary shows no comparison and says the prior window predates capture.
    - View as a manager: no tile shows the outbound line and the Outbound summary is gone. As a real MANAGER: the same.
    - On a phone-width window: the summary's tiles wrap; the page does not scroll sideways.
    - Prior-period chips (Batch F). On the tiles, with the Window on Yesterday or Last 30 days: a chip after Placed (green up, red down, gray under 3 calls) and one after the connect % in points (gray under 2 pts, or when either window placed under 10 calls). Hover a chip: it names the prior window and its figures. On YTD (and 60/90 days while capture is younger than the comparison needs): no chips.
    - In My Department's combined (outbound columns on) table, each agent row with outbound calls carries a chip after Connected, a GRAY chip after Not connected, and a chip after Connect %, against the same prior window the inbound chips use. Total and subtotal rows carry none; an agent with no calls in the prior window carries none.
  Expected: as described; with Neon unreachable the tiles show no line (no error) and the fold reads from the Outbound Calls tab with a note saying so.
  Fails if: a manager or a View-as preview sees either surface or a chip; the Not connected chip is ever colored; a chip appears on a pre-capture comparison; a tile's line does not change with the card window; the summary's totals differ from the dept's own S57 subtotal for the same dates, a parent dept's summary counts its sub-queues without the "only" label and note, or it is missing from the brief's Outbound row for the admin; or the page scrolls sideways at phone width.

S59 | Callbacks under the outbound table on My Department (Batch G1, UX-1) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN (admin-only until the Outbound report is released), open My Department over a month -- with the outbound columns on OR off (Step 3: Callbacks is the brief's own row). A second or two after the page settles the brief's "Callbacks" row fills in ("Callbacks: P% called back by the team · N contact episodes · median …") WITHOUT being opened -- it preloads, one request per window.
    - Click the row: it opens in place under the row, with no new request: seven contact-episode tiles (Contact episodes, Called back by own team, Own callbacks connected, Contacted by another team, Caller got through, Not called back, Median time to callback), the two own-team rate tiles with a ▲/▼ vs the prior window, the "How fast did the team call back (from the first attempt)?" strip, the daily chart, and the by-hour strip. Click the row again: it closes.
    - Find a caller who abandoned several times in a row (Caller Lookup on a not-called-back call id): the attempts count as ONE episode, and its time runs from the first attempt.
    - Paste `#/report/outbound` and reload: My Department with the brief's Callbacks row open and scrolled into view, the outbound columns left as they were (G3 -- the modal it replaced is gone).
    - "List not-called-back calls": the status reads "N call(s) in M episodes"; the list is grouped by episode, each headed by its first date, its attempt count and a chip -- "Still inside the window · N days left" or "Missed" -- plus "Called back late · day N · own/another team" or "Got through later · day N" where that happened after the window. Every attempt row carries a time, queue, abandon stage, the line the caller dialed, the call id with a copy button (admin) and "↳ path". It never lists an episode the team called back or another team contacted. Copy one call id and find it in the phone provider's portal.
    - "List called-back calls": one row per episode a dial decided, with an "Own team" or "Another team" chip, the dialer and their roster team, the time from the first attempt, connected or not, and two chips: "↳ path" (the abandoned call) and "↳ callback path" (the OUTBOUND call -- its path opens with the agent and the dialed leg). The head's own / another-team counts match the tiles.
    - Download CSV and Email to me both carry the window on screen, with own team / another team / got through as separate figures.
    - Turn the outbound columns on and off: the Callbacks row and its open section stay, and nothing is re-fetched. Change the dates: it loads the new window once.
    - View as a manager: the fold is gone. As a real MANAGER, even with Outbound last chosen: no fold and no outbound request.
    - On a phone-width window with the fold open: the page does not scroll sideways (the by-hour strip may scroll inside itself).
  Expected: as described; with Neon unreachable the fold reads from the Outbound Calls tab with a note saying so, and if nothing can be read it says the data is unavailable.
  Fails if: it shows to a manager or in View-as; it fetches more than once per window (including the preload), or again on a reopen of the same window; the deep link does not land on it or changes the columns toggle; the chart is blank after a close and reopen; or the page scrolls sideways at phone width.

S60 | Direct-line callbacks and repeat unreturned callers (CE-3) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, open My Department (a dept with direct-line callers, e.g. Sales) over the last month and open the brief's Callbacks row: a closed "Direct lines — this department's people" block sits at the bottom, its head already filled in (Step 3: it preloads with the Callbacks payload, one request). Opening it sends nothing new.
    - Open it (DL-R2): the big number is the callers to a person's line nobody called back, "W during work hours · A after hours · of N callers". Then a WORK HOURS bar and an AFTER HOURS (incl. weekends & holidays) bar, each of six segments -- by the person, by their team, another team, got through, still in window, not called back -- one legend reading "work · after" per segment, and a quality line: "Called back by the person or their team X% work hours · Y% after hours" and the medians, the after-hours one "counted from 8:30 the next work day".
    - Arithmetic on either bar: its six counts sum to that bar's callers. Under "How this is counted": the counts line ("N unanswered calls to a person's line ... anonymous · to the Sales voicemail box · to lines on no roster").
    - Below the bars, a table by department (most not called back first; an "Every department" footer). Click a department: its people open beneath it (the Sales voicemail box marked as such; a person on two rosters under both). Click a person with callers not called back: the callers who tried THEIR line first and got no callback load beneath them, one attempt or more. Check one in Caller Lookup.
    - "List repeat unreturned callers": one block per caller episode with 2+ unanswered attempts and no callback -- first → last date, the lines tried (people), the team, "Voicemail box" when the Sales voicemail box was rung, and a late tag where a callback came after the window. Each attempt row says "not answered" or "abandoned direct", "rang <person>", the line dialed, "after hours" where it applies, and the call id (copy) + "↳ path".
    - Pick one repeat caller and check it in Caller Lookup: the attempts are there, and no outbound call to that number inside the window.
    - On the Overview, open Callbacks by department and its "Direct lines — every department" block: the same summary and department table for the company, and the repeat list across every department.
    - Close and reopen either block: no reload. Change the window: it loads once more.
    - Misdials (FO-1): the counts line ends "· N misdials (rang under 8 s, left out of the rates)" when any call rang the person for under 8 seconds. Pick one in Caller Lookup or the call path: its ring to the person is under 8 s, and it appears in no repeat-caller block. (Calls captured before the FO-1 cdr-import deploy have no ring length and stay in.)
    - Sheet backup (FO-2), only if you can safely make Neon unreachable (or wait for an outage): the block still loads, with a note "Neon was unreachable: these figures come from the Inbound Calls and Outbound Calls tabs (through D)", plus "The copy names the line each call rang only from D" when the window starts earlier than the re-export.
    - View as a manager: neither block is visible (they sit inside admin-only surfaces until the 6c release).
  Expected: as described. A call to a person's line is never counted as a queue abandon, and the Callbacks tiles above do not change when the block is opened.
  Fails if: the block fetches before it is opened or on a reopen; a bar's segments do not sum to its callers; a person's list holds a caller who first tried someone else's line; a repeat caller is listed whom someone called back inside the window; the Sales voicemail box is listed under no team; a call id or number of a CALLER appears anywhere; a misdial is counted in a rate or listed as a repeat attempt; a spreadsheet-served block carries no note; or the page scrolls sideways at phone width.

S61 | Insights ranked brief as an accordion, and one-line sections (UX-2, Step 3) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, open My Department for a dept with queues (e.g. CSR) over a recent month. Directly UNDER the team cards and ABOVE the Agent Call Metrics table (Step 3): a top line ("Answer rate N%, up/down X pts vs the prior period. K things need a look.") with a tier icon (red flag = Needs attention / amber exclamation mark = Watch / green thumbs-up = On track / grey circle-with-dash = No signal; hover shows the word), then one row per section -- Queue health, Agents, Outbound, Callbacks, Team detail, Trend (Outbound and Callbacks while outbound is available to you). The old headline banner is gone for the admin. Every row starts COLLAPSED.
    - Rows run Red, then Amber, then Green, then No signal; within a colour Queue health, Agents, Outbound, Callbacks, Team detail, Trend. "K things need a look" equals the number of Red + Amber rows (+1 when the top line itself is Red or Amber).
    - Queue health: a queue at 4.00% abandoned or more for the window makes the row Red and names it; otherwise a violation day, or a queue answering 1.5x or more slower than its own last-3-month norm (at 5+ calls a day), makes it Amber. Check one figure against the Queue health table it opens.
    - Agents: an agent behind the team AND slipping makes it Red; behind, or slipping while on par, makes it Amber. Check a named agent against their card's rail (behind) and trend pill (slipping).
    - Trend: compare the named month's rate with the 12-month chart. 12+ points below the previous 3 months' average is Red, 8-12 Amber, 8+ above Green. On the chart's % Answered monthly view, points well off their prior-3-month average are shaded toward green or orange, and the tooltip says by how much.
    - Click each row: its section opens IN PLACE beneath the row (the chevron flips; charts draw at full size); click again: it closes. Keyboard: Tab to a row, Enter / Space toggles it. Nothing scrolls and the outbound columns toggle never changes.
    - Reload: every row is collapsed again (open/closed lasts one page load). Click an agent chip in the Agents section or a day in the Trend calendar: the section it needs opens through its row.
    - Collapse the Insights region at the bottom of the page and reload: the brief still fills in. With it still collapsed, pick another Quick select window: the brief re-runs for the new window (it used to keep the old one until the region was reopened). Press the page's Refresh: the brief refreshes too.
    - Export -> Insights "Copy image" and "Print": the image / print shows Queue health, Agents, Team detail and Trend (as they are open or closed in the brief), not just the header; the brief on the page is unchanged afterwards.
    - Hover the ⓘ beside "Queue Call Data" and "Team Rings Data": one circled i, never two.
    - Switch View as to a manager of the same dept: no brief, the headline banner is back, every section back in the Insights region in the manager's order (Agents open first), no trend-point shading. Exit View as: the brief returns with its rows collapsed.
    - Sign in as a MANAGER: the same as View as -- no brief, headline present, sections in the Insights region with their one-line heads.
  Expected: as described; every coloured row agrees with the section it opens.
  Fails if: a manager or View-as sees the brief or the shading, or loses a section; the admin sees both the brief and the headline; a row's colour contradicts its section (e.g. Red queue with every queue under 4%); a row does not open its section in place, or opens it with a blank chart; a row starts open after a reload; Share of answered, Outbound, Callbacks or Team detail ever shows a colour other than No signal.

S62 | Team cards: linked day bars (Step 4) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, open My Department for a dept with queues (e.g. CSR) over the last month. Under the figure in each card -- % Answered, Queue calls, Abandoned %, Avg answer -- a row of bars, one per WORKDAY (no bar for a Saturday, Sunday or company holiday; a workday with no calls is a flat line). The CSR Transfer % card has none (there is no per-day transfer figure).
    - Point at a bar in any card: the SAME day lights up in all four, and each card's bottom line names the day and its own value ("Mon Sep 28 · 90.5% answered (105 of 116)", "97 calls (88 / 9)", "9.28% abandoned (9)", "0:00:40 avg answer"). Move off the cards: the selection clears.
    - Reconcile one day against the Queue health daily table (Insights) and one agent-day total against the agent table for a one-day window on that date: the figures match.
    - Keyboard: Tab to a bar row -- the newest day is selected; Left / Right move every card together; Home / End jump; Escape clears. A screen reader announces the day and value.
    - On a phone (or with touch): tap a bar to hold its day, tap elsewhere in the cards to let go.
    - Widen to year to date: one bar per MONTH, labelled "Oct 2026 (11 workdays)"; count cards show the per-workday average. Between about 7 weeks and 6 months: one bar per week ("Week of Sep 8 (4 workdays)").
    - Set a one-day window: no bars.
    - (Option 2, owner 2026-10-21) % Answered and Abandoned % carry a dashed TARGET line (the dept's answer target; 4% abandoned): days below the answer target sit under it, days over 4% abandoned poke above it. A dept far below its target (e.g. 27% vs 80%) shows "target 80% ↑" in the date line instead of a line. Queue calls and Avg answer have no line.
    - View as a manager, and sign in as a MANAGER: no bars.
    - On a phone-width window: the cards go two-up, the bars stay inside them and the page does not scroll sideways.
  Expected: as described; for a parent dept (CSR, Sales, Power) the % Answered bars cover the combined view, crossover agents counted once, so they add up to the card. Weekend or holiday calls stay in the card total but get no bar.
  Fails if: the cards disagree on the selected day; a bar appears for a weekend or holiday; a card's bars do not add up to its figure for a weekday-only window; a manager or View-as sees bars; or the page scrolls sideways at phone width.

S63 | Notifications: sentence rules, history, test send, the manager layer (Step 5a) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, open Admin > Alerts. The modal is titled Notifications and each rule is one sentence: "When CSR's answer rate on a workday falls below 85%, email its managers and a@x.com." A paused rule starts "Paused --"; a rule with no valid threshold says it is not monitored and offers no History or Test send.
    - Click History on a rule: a table of the last 20 workdays -- that day's answer rate, whether the rule AS IT STANDS would have fired, and what the Alert Log says happened (a preview or test send is never "what happened"). Change the threshold and reopen it: the verdicts follow the new value. Click History again to fold it.
    - Set "Date to check", click Test send: a confirm says only you receive it; Cancel sends nothing; Send test emails the real alert to you alone, "[Test]" in the subject, saying whether the rule would have fired. The Alert Log gains a `test-sent` row with Triggered By `test:<you>`; no manager receives anything and the fire-rate chip does not move.
    - Manager layer: the switch starts OFF. Set a manager value for a dept (e.g. 90 against your 85): its card says "Manager: 90% · not applied: the manager layer is off", and Preview still judges the dept against 85. A value below yours is refused with "Managers can only make this rule stricter".
    - Sign in as that dept's MANAGER with the switch off: Settings has no alert section.
    - Turn the switch ON. The card now reads "below 90%" and "applies: stricter than your 85%"; Preview judges against 90 and its note names the manager's value. Raise your own threshold to 92: yours applies again.
    - As the manager (reload after the switch): Settings shows the rule as a sentence and a "Your threshold %" box. 80 is refused with the reason; 90 saves and the sentence reads 90%. They cannot pick another department.
    - Turn the switch OFF again: the manager's section disappears on their next load and their value stops applying.
  Expected: as described. Nothing changes for any manager until the switch is on; the stricter of the two values always applies.
  Fails if: a manager sees the section, saves, or has their value applied while the switch is off; a looser manager value is accepted; a test send reaches anyone but the admin; or History's verdicts do not follow the rule as it stands.

S64 | Coaching release prep: per-dept gates, Met / Rotated / Dismissed, the held manager email (Step 5b) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, open Admin > Coaching. Under the worklist, "Gates by department" lists every department as a sentence: "Flag an agent who answers less than 50% as often as the team, at least 5 points behind, with 20+ missed rings over 10 workdays."
    - Set CSR's ratio to 60 and save. CSR's sentence reads 60%; every other department keeps 50%. Clear the box and save: CSR returns to 50%. A ratio of 2 is refused.
    - Click "Email me the manager version" for a department with flags: you receive "[Preview] [Held for admins] Coaching for <dept>: N agents to talk with", naming the managers it will reach on release and the What to do steps. No manager receives it. A department with no flags says there is nothing to preview.
    - On an open flag: three buttons, Met / Rotated / Dismissed, each confirming in its own words. Close one as Rotated: under Closed it reads "Rotated by <you>". An older flag closed as resolved reads "Met".
    - Run now (or wait for Monday) with a NEW flag: the admins get the usual summary AND one held manager email per department with new flags; the delivery status line says "N manager email(s) held for admins".
    - With the manager layer on (S63), as a manager: Settings shows the coaching gates as a sentence and three boxes; 8 points behind (looser than 5) is refused, 3 saves and the sentence reads 3; the admin's Gates card shows "Manager stricter: 3 pts · applies".
  Expected: as described; no manager receives any coaching email.
  Fails if: a manager is emailed; a looser manager gate is accepted or applied; a department's gates change another's; or a close lands under the wrong status.

S65 | Alert reasons: an agent below a threshold over N workdays; callers not called back (Step 5c) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, open Admin > Alerts > "More alert reasons". Set CSR: agent below 40% for 5 workdays, callers not called back >= 2. Two sentences appear: "When an agent in CSR answers under 40% on each of the last 5 workdays, email the admins." and "When 2 or more callers who could not get through to CSR are not called back within a business day, email the admins." A 1-workday window is refused.
    - Run Preview for yesterday: besides CSR's answer-rate row, two rows labelled "· agents below" and "· callbacks", the callbacks threshold reading "2+ callers", each Will alert / Did not fire / Inactive with a note naming the agents or the caller counts and dates.
    - Cross-check one named agent against the agent table for each of the 5 workdays (one-day windows): every day below 40%.
    - With Neon unreachable (or before yesterday's calls are loaded) the callbacks row reads Inactive (skipped) with the reason -- never "fired".
    - Send alerts (or wait for the 8 AM run): reason emails arrive "[Dashboard Alert · admin trial] CSR: ..." addressed to the ADMINS only; no manager receives them. They carry no caller number. The Alert Log rows read `reason:agent-low:...` / `reason:callbacks:...`; CSR's fire-rate chip and History do not move; the Health alerts outcome ends "reasons: N checked, M fired".
    - Clear the boxes and save: the sentences disappear and the next run checks nothing extra.
  Expected: as described.
  Fails if: a manager receives a reason email; a reason row changes the drift chip, History or the dept counts; an unloaded day counts as "not called back"; or an agent who missed a day, or had one day at or above the threshold, is named.


S66 | Queue figures follow their period: My Department queue chips, Overview abandoned chips, Insights idle agents (QD-1, QD-2, IDLE-2) | Subsystem: Department Dashboard
  Steps:
    - My Department, a dept with mapped queues (e.g. CSR), last 30 days: the Queue calls card and the Abandoned % card each carry a "vs prior" chip, like Avg answer. Hover each: "Prior period <from> – <to>: ..." naming the prior figure. Compare with the Queue Call Data panel's Range tab: the same prior totals.
    - Overview, Window = Yesterday: every card's abandoned % chip, its "N aban" chip and the sub-queue strip's Abd carry a tooltip naming the latest queue day ("on 10/19").
    - Switch Window to Last 30 days: the abandoned % changes to the 30-day figure and the tooltips name the 30-day window. PAP (or any sub-queue whose latest day had no abandons) no longer reads "Abd 0.0%" when its 30 days had abandons. Spot-check one card against the all-departments Queue report for the same 30 days.
    - YTD: the same, over the year.
    - My Department > Insights (agents not picked): no card for an agent with no calls in the window -- an ex-employee still on the roster, or an agent on two rosters who worked only the other dept's queues. Pick that agent explicitly: their (zero) card appears.
  Expected: as described.
  Fails if: an Overview abandoned chip shows a different day's figure than the window says; a chip has no tooltip; or a whole-dept Insights run shows a 0 / 0 / 0 card.


S67 | Direct Calls report covers only days that exist: the clamp, missing workdays, the int / ext split (D1) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, the morning BEFORE yesterday's raw data is uploaded: Reports -> Direct Calls, Last 30 days, a department, Generate. A note reads "The data runs through <the last imported day>, so the report ends there, not on <yesterday> (later days have not been imported yet)"; the End date in the form has moved back to that day and Quick select reads Custom range; the results header names the shorter window.
    - Upload the day and Generate again (no wait for a cache): the note is gone and the window ends yesterday.
    - Pick a window that spans a workday the import missed (or a date before direct-call capture began): the note names the workday(s) with no data and says the vs-prior chips are withheld; no KPI tile shows a vs-prior chip. Weekends and company holidays are never listed.
    - A clean window: no note, and the IB answered / IB answer rate / OB calls tiles carry vs-prior chips.
    - Every count in the agent table (IB answered, IB missed free, IB missed busy, OB calls, OB connected) shows "N int · M ext" under it; the IB answered and OB calls tiles show the totals' split. The int + ext of a cell add up to its count.
    - Download CSV: the header carries every split column (IB int/ext answered, missed free, missed busy; OB int/ext calls, connected), and, when clamped or gappy, a line naming the last data day or the missing workdays.
    - All departments: the per-department cards render; the same note rules apply company-wide.
    - (D2, after the cdr-import deploy, on a date built since) A coworker-to-coworker dial shows as the caller's OB int call AND the callee's IB int call, while an agent's OB int stays in the tens a day, not the hundreds (the CDR's Call Recording / Voicemail legs are Internal too and never count, DC-D2b); a call that rang an agent twice (one parent, two legs) counts once; an anonymous ring to an agent's extension counts as IB ext; a ring on an agent's second roster extension counts for that agent; a dial to a short unrostered extension counts as OB int. Check two of these by call id in Raw Data (`diagnoseDirectCallCounting`'s samples, Operator State #80).
    - (DCA-1, after the cdr-import deploy and a rebuild of a held date) A former employee still on the roster whose extension 8x8 gave to someone else -- one of `diagnoseDirectCallAttribution`'s "somebody else" lines -- no longer appears for that date in the department's Direct Calls table; if the new owner is on the roster with that extension, the calls appear under them.
    - (D3) My Department, as the ADMIN: under Team Outbound, a collapsed "Team Direct Calls" card reads "open to load" and has sent no request. Open it: its figures equal the report's for that dept and dates (answered / missed / busy, answer %, out calls, the int / ext split, the per-agent rows) and it repeats the coverage note. "Open the Direct Calls report" opens the report on that dept and dates. View as a manager, or as a MANAGER: no card.
  Expected: as described.
  Fails if: a window ending on a not-yet-imported day shows lower totals with no note; a missing workday is not named, or a weekend / holiday is; vs-prior chips show while a window has a gap; or an int / ext pair does not add up to its count.

S68 | Exception days: one outage day left out everywhere, said everywhere, and an admin can put it back (#81) | Subsystem: Department Dashboard
  Steps:
    - As the ADMIN, Admin ▾ → Exception days: Save with no reason -- refused in place. Add a recent weekday, All departments, reason "8x8 outage". It lists with your address. Re-run `setup()` beforehand on a fresh install (the sheet is also created on save).
    - Refresh My Department on a 30-day window spanning it: a note under the controls names the day, the reason and the calls left out. Each team card's day bars show that day striped gray at its real height, never tinted; the other bars keep their scale and the target line ignores it; pointing at it reads "Excluded (8x8 outage)". The agent table's numbers for that window are lower by exactly the note's count (spot-check one agent against the window minus that day).
    - The Insights region and the Individual Report each carry the same note; the Missed Calls section (under the page note) has no missed calls on that day; the comparison's prior window skips the day like a holiday.
    - Click "Include them": the table, the cards and the missed section re-ask WITH the day; the note says the days are INCLUDED. "Leave them out" returns. View as a manager: no switch. As a real MANAGER: the note, no switch.
    - Overview: the trend lines bridge the day under a hatched band, its point has no tooltip, and a note under the chart names it. The tiles' figures exclude it.
    - Agent app (an agent whose window spans it): "Not counted: <day>: 8x8 outage ..." under the header.
    - The next morning's daily alert run (or Preview on that date) logs the dept rows as `skipped` -- "Exception day (...): 8x8 outage -- not assessed".
    - Change the day to one department only: that department's figures and its own queue chips drop it; another department's, and the company hero, keep it.
    - Remove the day (it asks first, in danger tone): within a page refresh every figure is back to including it.
  Expected: as described.
  Fails if: any report's numbers drop the day without a note, or show the note while still counting it; the striped bar sets the card's scale; a manager sees or can use the include switch; an alert fires or logs "no data" for the day; removing the day leaves any report excluding it after a refresh.
