# CLAUDE.md

Project-level guidance for Claude (and any new engineer) working in this repo.
Pair with the longer docs in [`docs/`](docs/) for full context.

## What this project is

A multi-spreadsheet Google Apps Script stack that ingests call detail records
(CDR) from a telephony provider, aggregates them into per-agent per-day
metrics ("DQE"), and serves them to ~14 department managers via a web app.
The **Department Dashboard** web app has replaced the legacy DQE Report
spreadsheet (migration complete: 4 reports + low-answer-rate alerts ported);
legacy `apps-script/dqe-report/` is kept frozen for reference until the
spreadsheet is decommissioned.

- **Owner / admin**: Robin Choudhury (`robin.choudhury@universalmedsupply.com`)
- **Domain**: Universal Med Supply (Google Workspace)
- **Lifecycle**: active development; small internal user base (<20)

## Read first

### This file's split-out sections — LIVE TRUTH, not archive

CLAUDE.md reached ~372 KB and is injected into **every** session's context, so
four reference sections were moved into `docs/` (finding F8). Each still has a
one-line index here; **the file is authoritative, the index is a finding aid.**
Open the entry before you rely on it — a summary cannot carry the exceptions.
`tests/unit/claude-md-split.test.js` fails the build if an index and its file
drift apart, and caps this file's size.

- [`docs/invariants.md`](docs/invariants.md) — the **Invariant Library** in full
  (`INV-01`…`INV-55`). Indexed under Cycle Workflow Config → Invariant Library.
  This is what the INVARIANT CHECK step reads.
- [`docs/operator-state.md`](docs/operator-state.md) — the **Operator State
  Checklist** in full (38 items: Script Properties, triggers, sheets,
  migrations). Cited across the repo BY NUMBER, e.g. "Operator State #38", so
  the numbering is stable — retire an item in place rather than renumbering.
- [`docs/regression-scenarios.md`](docs/regression-scenarios.md) — the 40
  **Regression Scenarios** (`S1`…`S40`) with steps + expected results. Walk
  every one whose Subsystem overlaps a file you changed.
- [`docs/client-ui-conventions.md`](docs/client-ui-conventions.md) — how the
  Insights + Overview pages, the density/prefs layer, the `ds-*` components and
  the design tokens are built. **Read before touching `script.html` /
  `styles.html` / `dashboard.html`**, then re-run `npm run ci:ui`. The client
  traps that bite unrelated work stayed in Common Gotchas below.

### For deeper context, in priority order

- [`docs/architecture.md`](docs/architecture.md) — data flow across CDR
  Import, CDR Report, Department Dashboard, Neon Postgres. Read this first
  when chasing a bug to figure out which layer is involved.
- [`docs/known-issues.md`](docs/known-issues.md) — institutional memory.
  Fixed bugs, design rules, drift risks. Read before changing the source
  pipeline or the dashboard's data layer.
- [`docs/conventions.md`](docs/conventions.md) — time windows, aggregation
  rules, naming conventions, scope semantics.
- [`docs/fix-history.md`](docs/fix-history.md) — the **historical fix log**:
  what each short fix code (`F-2`, `IMP-7`, `CORE-3`, `RPT-1`, `OPS-7`,
  `NEO-1`, the bare-`F#` Neon family, …) fixed, with a pointer to the live
  rule it produced. **CLAUDE.md plus its four split files above are the
  current-invariants / live truth; fix-history is the "why" archive.** Read
  fix-history when you hit a
  code in a comment and want the backstory — not to learn a current rule. It
  also flags the two code-family collisions that trip everyone up (dashed
  `F-#` vs bare `F#`; `S#` = Regression Scenario vs inline batch-step) and
  lists codes that live in the code but never made it into CLAUDE.md
  (`CORE-7`, `OPS-8`, `NEO-5`, `NEO-6`).
- [`README.md`](README.md) — clasp setup + deploy flow.

## Key commands

```bash
# Department Dashboard (web app) deploy
clasp push -f                                # from repo root
# Then in the Apps Script editor:
# Deploy → Manage deployments → pencil → Version: New version → Deploy

# Sibling project deploys
cd apps-script/cdr-report  && clasp push -f
cd apps-script/cdr-import  && clasp push -f
cd apps-script/dqe-report  && clasp push -f   # frozen — cleanup deploys only

# INV-16 guard: verify the duplicated files (neonWrite.js,
# buildDQEHistoricalData.js) are byte-identical across cdr-report/
# and cdr-import/, that both copies of each pair EXIST (F-56), and
# that the sanitizeAbandonedCellForNeon_ AND sanitizeSlotCellForNeon_
# functions are each identical across neonbackfill.js / NeonMirror.js
# (F-24 / F-51 -- the guard checks BOTH; earlier doc text understated
# it as abandoned-only, R8-E6). Non-zero exit on drift.
# Also runs automatically as a non-blocking SessionStart hook
# (.claude/settings.json).
bash scripts/check-duplicated-files.sh

# Unit tests (regression harness, Phases 1-4). Zero deps -- Node's
# built-in test runner loads the real .gs/.js files into a vm with
# mocked Apps Script globals (dashboard + the sibling cdr-report /
# cdr-import projects). Non-zero exit on failure. Covers: pure logic
# (date/duration parsing INV-02/03, hashAgents_ INV-36, Util, the
# INV-54 Dept Config accessors); the aggregator computeSummary_
# (INV-02/04/05/23/53, S35, E5); the report builders (IR weighted ATT
# INV-25, the Insights consolidation freeze INV-25/28/29, CR
# length-mismatch INV-35, INV-53);
# pipeline canonicalization (loadRosterCanonicalNames_ INV-24/46,
# INV-16 cross-project); the INV-29 trend window
# (computeTrendStartDate_, trend-window.test.js); the end-to-end
# buildDQEHistoricalData build (INV-07/08/20/21 + the Pass-4 INV-23
# queue-sentinel producer); the QCD report's F-15 daily axis /
# F-36 all-dept grand-total dedup (qcd-report.test.js); the Missed
# report's RPT-1/2 abandoned-count + pairing pins
# (missed-report.test.js); and the ingest watchdog's OPS-1/OPS-7
# episode/holiday logic (ingest-watchdog.test.js). The ops/report
# surfaces added since each pin under a same-named suite:
# system-health + smoke-check, queue-report, pipeline-watch,
# missed-slice, dal-cutover (sheet-vs-neon parity), heatmap-cell-drill,
# inbound-qcd-parity, inbound-calls (capture incl. the R5
# direct-stage/first_agent pins), outbound-calls (the Option B per-call
# outbound capture: builder gates + writer authoritative/P-1/hash
# pins), sheet-repairs-merge, dept-config-neon
# / config-neon-c3, escalations-hardening, caller-lookup,
# answer-targets (the R12-25 tunable display-standards parser + save
# canonicalizer), access-control-editor, neon-coverage (the R7 sheet-vs-Neon
# reconciliation's pure pieces), cache-version-sync (doc↔code cache-pin
# drift), subqueue-access (Phase 0 access widening + the Phase 1 merge layer +
# the Phase 2 picker groups), claude-md-split (the F8 index↔file guard: an invariant / scenario /
# operator item that exists in docs/ but not in CLAUDE.md's index -- or vice
# versa -- fails the build, plus a size cap on CLAUDE.md itself).
# See tests/README.md for design + how to add tests. The neonWrite JDBC
# writers are pinned end-to-end (chunking/commit discipline +
# field mappings, neon-write-mapping.test.js).
node --test          # from repo root (or: npm test)

# CI: .github/workflows/ci.yml runs TWO jobs on push-to-main + every PR --
# `test` (`node --test` + the INV-16 guard; = `npm run ci` locally) and
# `ui-harness` (the rendered-UI gate; = `npm run ci:ui`, see below).

# Deploy helper: push AND roll a project's web-app deployment to a new
# version in one step (avoids the manual "Manage deployments -> New
# version" stale-deploy footgun, Operator State #2). The deployment id
# comes from `clasp deployments` in that dir (one-time lookup).
# TST-7: it GATES the push on `npm run ci` (tests + the INV-16 guard);
# DEPLOY_SKIP_CI=1 skips the gate (emergencies only).
# Batch 4: it also runs the REMOTE-ORPHAN check first -- `clasp push -f` never
# deletes remote files (INV-17), so a file removed from the repo stays live and
# callable until deleted by hand in the web editor. The check pulls the project
# into a temp dir and lists remote files with no local counterpart. It WARNS by
# default (an orphan is no reason to block an urgent fix) and skips cleanly when
# clasp can't authenticate; STRICT_ORPHANS=1 makes it fatal. Standalone:
#   node scripts/check-remote-orphans.mjs <project-dir>
scripts/deploy.sh .                      <dashboard-deployment-id>
scripts/deploy.sh apps-script/cdr-report <cdr-report-deployment-id>
scripts/deploy.sh apps-script/cdr-import <cdr-import-deployment-id>
# (omit the id to just `clasp push -f` and finish the version bump manually)

# Still manual (NOT unit-covered): the deferred mirror's sheet-derived
# payload re-derivation (NeonMirror.js) and anything UI/live -- verify
# via deploy + smoke-test against the Regression Scenarios in the
# Cycle Workflow Config below. The neonWrite writers themselves are
# unit-pinned (chunking + field mappings).

# Rendered-UI gate (F7). Boots the REAL client (dashboard.html + script.html
# + styles.html) in headless Chromium against payloads computed by the REAL
# server code -- the only automated check on ~20K lines of script.html, and
# it has caught render bugs the .gs harness structurally cannot see (R12-1
# blank missed-chart, R12-2 gray trend arrows). SEPARATE from `npm run ci`
# on purpose: that suite is zero-dep, this needs playwright.
npm run ci:ui                # gen payloads -> build admin+manager -> assert
# One-time: cd tools/ui-harness && npm init -y && npm i playwright
# (the Chart.js / datalabels / html2canvas-pro bundles are COMMITTED under
# tools/ui-harness/vendor/, version-pinned to dashboard.html's CDN tags by
# tests/unit/ui-harness-vendor.test.js). With playwright absent it SKIPS
# with a message and exits 0, so it is safe to run anywhere; chromium-path.js
# globs the Playwright browser revision, so CHROMIUM_PATH is rarely needed.
# THREE ASSERTING drivers gate it -- drive-smoke.js (page/console errors,
# unmocked RPCs, BLANK chart canvases, horizontal overflow, both roles),
# drive-f13.js (the S39 keyboard walk), and drive-subqueue.js (the sub-queue
# scope switcher, the S35 parent-subtotal parity property, and the
# combined-view CSV -- the ONLY automated coverage of any CSV writer in this
# repo, asserted by stubbing URL.createObjectURL and reading the real Blob
# bytes, S43). The other drivers (drive.js /
# drive-insights.js / drive-phase3.js) emit screenshots + reports for a human
# and are deliberately NOT in the gate. Runs in CI as the `ui-harness` job
# (currently `continue-on-error: true` while the gate proves itself -- drop
# that line once it's been green across a few PRs). Re-run it after touching
# script.html, styles.html, dashboard.html, or any payload shape.
```

## Common Gotchas

A few things that have bitten us repeatedly. See `docs/known-issues.md` for full detail.

> The bullets below are **live rules**. Where a bullet cites a fix code
> (`F-2`, `IMP-7`, `CORE-3`, `RPT-1`, `OPS-7`, `NEO-1`, bare `F#`, …), that
> code's backstory + a family index live in [`docs/fix-history.md`](docs/fix-history.md)
> — follow a rule from here, look up a code's history there.

- **Spreadsheet TZ ≠ script TZ**. The CDR Report spreadsheet is on
  `America/Mexico_City`; the script is on `America/Chicago`. Duration cells
  (TTT, ATT, AvgAbdWait, CSRAvgAbdWait) get a phantom +36:36 offset if you
  read them via `getValue()`. **Always use `getDisplayValues()`** for those
  columns and parse the H:MM:SS string directly.
- **Comma-joined ID/time cells coerce to Numbers unless plain-text
  formatted.** Three column groups in `DQE Historical Data` store
  comma-joined values: **K-AC** (half-hour slot missed-times, e.g.
  `"10:23:33,10:08:41"`) and **AD/AE/AF** (cols 30-32 -- abandoned parent
  IDs / missed-leg IDs / missed-leg times, e.g.
  `"1762242202191,1762242165529"`). Without plain-text (`@`) format, Sheets
  coerces these on write/paste: a SLOT cell with a single timestamp becomes a
  1899-epoch time serial; a multi-value AD/AF cell becomes a single Number
  (the comma read as a thousands group) that loses precision past 2^53 and
  re-renders as `"17,622,419,789,481,700,000,000,000"`, which downstream then
  mis-splits on the separator commas. **Single-value AD/AF cells survive**
  (< 2^53); **multi-value cells are genuinely lost.** Protections + recovery:
  (1) `buildDQEHistoricalData.js` plain-texts cols 4 / 11-29 / 30-32 before
  every write AND re-formats the EXACT write range, so rows that spill past the
  prior `getMaxRows()` when the sheet auto-expands are protected too (the lone
  remaining recurrence vector before commit a350042; INV-16, both copies).
  (2) Old corrupted rows: `repairDqeSlotTimestamps()` (K-AC **+ AF**, TZ-safe
  serial recovery -- AF holds the same comma-joined H:MM:SS time strings as the
  slots and coerces identically, so it's recovered HERE, not by the ID repair)
  and `repairDqeAbandonedIds()` (**AD-AE only** -- abandoned parent/leg IDs) in
  `cdr-report/sheetRepairs.js` -- each has a `preview*` dry-run; both recover
  the lossless single-value cells. `repairDqeAbandonedIds` marks UNRECOVERABLE
  multi-value cells with the **`#REBUILD` sentinel**
  (`Config.gs::DQE_ABANDONED_LOST_SENTINEL`) so "corrupted -- rebuild" is never
  mistaken for a genuinely-empty "0 abandoned". (3) Read side:
  `neonbackfill.js::sanitizeAbandonedCellForNeon_` (write to Neon, **AD/AE
  only** -- the numeric ID columns) and `Util.gs::classifyAbandonedCell_`
  (Missed report + Diagnostics) recognize the
  sentinel + the coerced shapes, recover lossless single values, and EXCLUDE
  lost cells from counts (never split into fake IDs). **AF (write to Neon) goes
  through `sanitizeSlotCellForNeon_` instead** (M3): AF is a comma-joined
  H:MM:SS TIMES column that coerces like the K-AC slots, so the slot sanitizer
  recovers a `"12/30/1899 10:23:33"` date-render to `"10:23:33"` where the ID
  sanitizer would mirror it verbatim; routed at the call sites in
  `neonbackfill.js` + `NeonMirror.js` (`sanitizeSlotCellForNeon_(r[31]) || null`).
  The Missed report flags
  them via `meta.abandonedDetailLost` / `abandonedDetailLostDates` and the
  headline shows an "abandoned detail unavailable -- rebuild" note.
  **Accuracy scope:** AD/AE/AF feed ONLY the Missed Calls report's
  abandoned-call detail (+ its Neon mirror), NOT the per-agent
  Rung/Missed/Answered/TTT/ATT or AvgAbdWait columns. **Runbook when a row
  shows `#REBUILD` / "abandoned detail unavailable":** `preview...` ->
  `repair...` (recovers lossless, marks lost) -> rebuild those dates from Raw
  Data via `buildDQEHistoricalData` where it still exists ->
  `backfillDQEHistoryUpsert()` (`ON CONFLICT DO UPDATE`) to re-mirror.
  **Copy-paste of old rows re-introduces this** -- see README "Extending
  history backwards". **The same coercion class hits DATE-shaped strings
  written via setValues**: Sheets coerces an "M/D/YYYY" string cell to a
  Date value, so a later `getValues()` + `String()` comparison never
  matches the original string -- this made `Direct Call History`'s
  refresh-in-window delete a silent no-op (duplicate row sets per
  re-import; FIXED via `dcDateIso_` + `getDisplayValues`, F-3) and broke
  `inboundCallsExport.js`'s refresh-in-window semantics (FIXED via
  `ic_cellDateIso_`, F-10). New writer-side date comparisons must compare
  ISO-NORMALIZED DISPLAY values, never `String(getValues())`.
- **DQE cols AD/AE/AF are POSITIONALLY PAIRED (lockstep contract).**
  The Missed Calls report pairs `AF[i]` (abandoned missed-ring time) with
  `AD[i]` (its parent call id) to hang a parent id on each 🚨 timestamp --
  the pairing behind the "↳ path" journey drill. Since the F-2 fix,
  `buildDQEHistoricalData` (both INV-16 copies) emits all three columns
  from ONE chronologically-sorted missed-leg list (one entry per missed
  leg on an abandoned parent; a re-rung parent appears once per ring);
  abandoned parents with no pairable missed leg are APPENDED to AD after
  the paired section with no AE/AF partner, so AD's id SET -- which feeds
  the dept-wide unique-abandoned counts -- is unchanged. Read side dedups
  ids, so AD duplicates are safe. **Historical rows built before the fix
  keep the old (potentially mispaired) values until rebuilt** -- see
  docs/known-issues.md "AD/AE/AF positional pairing" for the rebuild
  runbook. Don't re-introduce Set-dedup or differently-sourced lists on
  any of the three columns; `tests/unit/pipeline-build.test.js` pins the
  lockstep.
- **PST→CST stored-timestamp era split (separate from coercion).** Rows BEFORE
  2026-03-09 came from the old pipeline, which stored the slot (K-AC) and
  abandoned-time (AF) H:MM:SS strings in **PST** -- 2h behind the CST column
  headers and the current pipeline (which adds `DQE_PST_TO_CST`=7200s via
  `pstToCSTStr`). The bucket COLUMN was already correct in old rows; only the
  stored time-of-day value is 2h behind. `repairDqeOldPstTimestampShift()`
  (+ `previewDqeOldPstTimestampShift()`, `cdr-report/sheetRepairs.js`) shifts
  those cells +2h -- **date-gated (Date < 2026-03-09) AND per-row
  PST-window-validated** (only shifts cells whose times sit in the PST window
  for their column; skips rows already in CST), so it's re-run safe and won't
  double-shift a pre-cutoff row that was already rebuilt in CST. Run it AFTER
  the coercion repairs above (so cells are clean text first), then
  `backfillDQEHistoryUpsert()` if the Neon mirror is consumed. Until run, the
  Missed Calls report mis-buckets / drops old-date missed calls -- it buckets
  by PARSING the stored time against the 8 AM-5 PM CST range
  (`MissedCallsReport.gs`), so a PST value reads ~2h early. Durations
  (TTT/ATT/AvgAbdWait), counts, and the Date are TZ-independent and untouched.
- **`clasp push -f` does NOT delete remote files** that are absent locally.
  Removing files from an Apps Script project requires manual deletion in
  the web editor.
- **Public write paths are admin-only.** Three public surfaces write
  to the spreadsheet: `OrphanFix.gs` (alias + rename + roster-add
  writes -- `addOrphanToRoster` is the New-hire flow that appends a
  roster cell to a dept's DO NOT EDIT! column),
  `setup()` in `Setup.gs` (sheet creation), and `DeptConfig.gs`
  (`saveDeptConfig` / `removeDeptConfig` -- config-sheet writes,
  INV-54). All are admin-gated via `assertAdmin_()`. Every other
  public-callable function is read-only; helpers that touch
  spreadsheet state end in `_` so Apps Script blocks them from RPC.
  Belt-and-suspenders against the "Execute as: Me" model letting any
  visitor reach through Robin's permissions. The `OrphanFix.gs`
  carve-out (a data-mutation path) additionally has input-validation
  (no queue-sentinel names, length cap, must-be-on-some-roster for
  the canonical destination, and -- R8-B2 -- must-NOT-be-on-any-roster
  for the alias/rename SOURCE name, since the pipeline's aliasMap wins
  over the exact-roster match and would silently reroute a live
  agent's future builds; de-roster first for deliberate merges),
  `LockService` serialization (NB:
  LockService is PER-SCRIPT-PROJECT -- it serializes concurrent
  dashboard requests but canNOT serialize against the cdr-import /
  cdr-report daily builds, which run in other projects; F-22
  mitigation: `renameHistoricalAgent_` RE-VERIFIES the agent column +
  row count immediately before writing and aborts with a retry
  message if either changed since its snapshot, so a concurrent
  build can no longer be overwritten with a stale column -- a
  mitigation, not a serialization), and
  `Orphan Fix Log` audit trail. `DeptConfig.gs` is a config (not
  data-mutation) path: `assertAdmin_()` + save-time validation +
  `LockService` + an Updated By/At stamp on the row. **Do not add
  new public write functions without `assertAdmin_()` at minimum;
  data-mutation paths need all four mitigations; config/creation
  paths need at least the admin gate.** Separately, `applyOrphanRename`
  also best-effort mirrors the rename into Neon's `dqe_history`
  (`renameAgentInNeon_`) -- the dashboard's ONLY non-spreadsheet write.
  It's admin-gated (rides inside `applyOrphanRename`), conflict-safe
  (skips `(call_date, toName)` collisions rather than violating
  `uq_dqe_history`), and never throws (a Neon failure leaves the
  authoritative sheet rename intact). Needs the dashboard-project
  `NEON_*` Script Properties + `script.external_request` scope
  (Operator State #18); no-ops cleanly when unset.
- **Roster cells embed extensions**: `DO NOT EDIT!` cells follow
  `"Name, ext1, ext2"`. Take everything before the first comma as the name;
  digit-only tokens after are queue extensions.
- **Agent-name match at the dashboard layer is exact** — no case folding,
  no whitespace normalization. The pipeline canonicalizes paren variants
  to roster names before writing, so downstream code can rely on exact
  match against the roster.
- **Pipeline canonicalizes paren variants via the roster.**
  `buildDQEHistoricalData` reads `DO NOT EDIT!` at the start of every
  build; if an incoming CDR row's agent name matches exactly one roster
  entry under EITHER of two paren normalizations, the pipeline rewrites
  it to the canonical roster form. Roster canonical: `Roman (Robin)
  Paulose`. **Two feed variants both canonicalize** (each roster name is
  registered in `strippedMap` under BOTH keys):
  (1) the **STRIP** key drops the whole parenthetical (`stripParens_`)
  -> `Roman Paulose`, so a nickname-OMITTED incoming `Roman Paulose` (or
  a different parenthetical `Roman (Bob) Paulose`) matches; (2) the
  **FLATTEN** key drops only the parens and keeps the words
  (`flattenParens_`) -> `Roman Robin Paulose`, so a nickname-
  UN-PARENTHESIZED incoming `Roman Robin Paulose` matches too -- **this
  is the ~90% orphan case, and it now canonicalizes** (it previously did
  NOT, because stripping the whole parenthetical left the extra word in
  place). `canonicalizeAgentName` unions the candidates from both the
  incoming name's strip + flatten forms and rewrites ONLY on a UNIQUE
  roster match. A no-paren roster name yields strip === flatten (one
  key; per-key dedup stops a false >1). Ambiguous (>1 match) and unknown
  (0 matches) names are written as-is. Soft coupling: the pipeline now
  depends on the dashboard's roster sheet schema — see
  `loadRosterCanonicalNames_` in the pipeline. Admin-curated
  overrides in the `Agent Alias Overrides` sheet (see INV-46) take
  precedence over both the paren-strip and the exact-roster match;
  the dashboard's Orphan Fix modal writes there. Aliases with
  `Active=FALSE` are skipped by the pipeline.
- **ATT semantics differ between the main dashboard and the per-agent
  reports.** Main dashboard table uses the SIMPLE MEAN of stored per-row
  ATT values (INV-05); the Individual and Insights
  reports (and the retired Performance + Compare Ranges reports before
  them) use a
  WEIGHTED average (`sum(att * answered) / sum(answered)`)
  so days where the agent didn't answer any calls don't drag the ATT
  down. Intentional — matches the legacy reports they migrated from.
  **The OVERVIEW tile's ATT is ALSO weighted** (`attAvg * answered`
  accumulation in CompanyOverview.gs), so the Overview tile and the
  My-Dept table can disagree slightly on the same dept/day — documented
  as intended (RPT-6, owner ruling): the tile is a rollup (reports
  family), the table is the row-level view (INV-05 family).
- **`TEAM_AVG_EXCLUDES` in `Config.gs`** lists per-dept agent names to
  subtract from BOTH numerator and denominator of the Individual
  Report's team-average. Used for managers who are on the roster but
  take only a token number of calls (default seed
  `'CSR': ['Robin Choudhury']`). Match is exact on the roster name.
  Read the effective list via `getTeamAvgExcludes_(dept)`
  (DeptConfig.gs) -- the constant is now the seed default beneath the
  admin-authored `Dept Config` sheet (INV-54), which can override it
  per dept without a redeploy. Since Phase E (commit 94bbca9), the Individual Report renders an
  "EXCLUDED FROM TEAM AVG" pill (`.ir-excluded-pill`) next to the
  agent's name on cards where the new `excludedFromTeamAvg` field is
  true, so the exclusion is visible to managers reading the report.
- **Per-dept config maps are sheet-overridable — read them via
  accessors, never the constants.** `DEPT_QCD_QUEUES`,
  `OVERVIEW_PARENT_OF`, `TEAM_AVG_EXCLUDES`, and
  `DEPT_QUEUE_EXT_OVERRIDES` are now SEED DEFAULTS layered under the
  admin-authored `Dept Config` sheet (INV-54). Always read through
  `getDeptQcdQueues_` / `getOverviewParentMap_` / `getTeamAvgExcludes_`
  / `getDeptQueueExtsOverride_` (DeptConfig.gs -- plus
  `getInboundQueueAliases_` and `getFinalDeptLabels_`, the two
  raw-upstream-name bridges that have no constant behind them, plus
  `getAllFinalDeptLabels_`, the UNION of every dept's final-dept labels
  that gates the on-hold arm's entry-queue fallback -- it must keep
  failing OPEN, since an empty union degrades attribution to the entry
  queue while a partial one would double-count) so a sheet override
  takes effect; never index the frozen constant directly in new code.
  The accessors fall through to the constant when no Active sheet row
  exists, so behavior is unchanged on installs that haven't re-run
  `setup()`. Override semantics: for a dept with an Active row, each
  NON-EMPTY field overrides that dept's constant; an EMPTY field falls
  back. Consumers already rewired: `queuesForDept_` (QCDReport.gs),
  `computeQcdSnapshots_` + the Overview parent map (CompanyOverview.gs),
  the IR team-avg reads (IndividualReport.gs), `getDeptQueueExts_`
  (Data.gs).
- **The Performance Report is RETIRED (PR->Insights consolidation).**
  Its semantics live on in Insights: the KPI tiles compare against the
  immediately-preceding same-length window (INV-28 -- NOT "previous
  calendar month"), the share-of-answered donut renders below the trend
  chart, and the per-agent Chart view's **Absolute** sub-toggle is PR's
  Volume & Efficiency view (stacked Answered+Missed per agent + %
  Answered dots, `insRenderCardsChartAbs_`). `PerformanceReport.gs` was
  DELETED (`deltaBlock_` moved to Util.gs -- Insights consumes it);
  legacy `#/report/performance` deep links land on the Insights page
  (router page repoint); the `performance:` cache prefix and the
  `cdr.pr.prefs.v1` localStorage key are orphans. The frozen-literal
  test in insights-report.test.js pins the inherited semantics
  (ex-parity gate). NOTE (INV-17): `clasp push -f` does not delete
  remote files -- PerformanceReport.gs must be removed in the Apps
  Script web editor.
- **Per-row prior-period chips (E5, commit bb77168).** The My
  Department agent table renders an inline delta chip after the
  Rung / Missed / Answered values comparing the selected window
  to a same-length window immediately preceding it (mirrors PR's
  INV-28 semantics). Three pieces of behavior worth knowing:
  (1) **Valence map** lives in `script.html::WOW_PRIOR_KEYS`:
  rung↑ / answered↑ render `wow-chip-good` (sage); missed↑
  renders `wow-chip-warn` (orange); decreases flip the color so
  a missed-call drop is green and an answered-call drop is
  orange. (2) **Noise threshold** `WOW_NOISE_THRESHOLD = 3`
  applies the muted variant to any |delta| under 3 calls (and to
  zero deltas) regardless of valence -- day-to-day noise stays
  visually quiet. Hover title carries the prior window dates +
  raw prior value + numeric delta from `state.meta.priorFrom` /
  `state.meta.priorTo` (server-populated). (3) **Server side**
  `Data.gs::computeSummary_` widens its single Raw Data scan
  range to `[priorFrom, to]` and uses a sibling `priorAcc`
  dictionary keyed by agent so the existing user-window
  accumulator stays untouched; each row carries `priorRung` /
  `priorMissed` / `priorAnswered` / `priorHasData`. Agents with
  prior-only activity (no rows in the user window) are silently
  dropped -- no card exists to render a chip on. CSV export
  bypasses `fmtCell` via `exportTableCsv_` (using `csvEscape` /
  `sourceChipCsv_`) so the chip markup is
  intentionally NOT in CSVs; raw current-window values only.
  Floaters get chips too -- the chip is a per-agent comparison,
  independent of the INV-53 team-avg floater-exclusion gate.
- **Missed-card ordering + severity tiers (Phase 15, commit
  77441a7).** `missedAgentsHtml_` (the builder for the per-agent
  missed-call cards in the My Department missed section -- the
  standalone Missed Calls modal it also served is RETIRED; the
  inline section is the Missed Calls report now) sorts agents
  **most-missed first** (stable tiebreak by name) and tags each
  card with a cohort-RELATIVE severity tier: **Most missed** (warn
  left-rail + chip), **Moderate** (neutral), **Fewest** (sage).
  Cutoffs are tertiles of the missed totals among the agents shown
  (`missedQuantile_`), NOT an absolute standard -- there is no
  company benchmark for per-agent missed counts. Tiering is GATED
  OFF for low-signal cohorts (fewer than 3 agents, or a max total
  under 3 missed) so a 1-missed agent is never branded worst; in
  that case cards render sorted but untiered. Styles
  (`.agent-tier`, `.agent-card--tier-*`) live in `styles.html`.
  **Agent-scoped chart (R11-C4):** each card's summary carries a
  "■ chart" button (`.agent-scope-btn`) that rebuckets the 18-slot
  hour-of-day chart above from THAT agent's own timeline entries
  (pure client rebucket via `missedTimeBucketIdx_` -- the times are
  already in the payload, no fetch); a toolbar chip
  (`#dept-missed-scope-chip`) names the active scope with an ✕
  clear. Clicks are intercepted in the delegated document handler
  with preventDefault so the button never toggles the card's
  `<details>`. The bucket drill panel stays DEPT-WIDE by design;
  scope resets on every fresh fetch (`deptMissedRender_`).
- **Threshold-drift surface (E10, commit b3a5a51).** The Alerts
  modal config table renders a "Last 30 days" chip per dept
  summarizing the most-recent daily-trigger entries from the
  Alert Log. Five tunable constants near the top of `Alerts.gs`:
  `DRIFT_LOOKBACK_ENTRIES` (=30; per-dept window size),
  `DRIFT_MIN_TOTAL_TO_ASSESS` (=10; below this the chip renders
  the muted 'cold' / dash variant -- not enough signal),
  `DRIFT_CHRONIC_FIRE_RATIO` (=0.80; `fired/total` at or above
  flags 'chronic' = warn-tinted), `DRIFT_LENIENT_HEADROOM_PTS`
  (=10; `fired === 0` AND `meanRate >= threshold + 10pts` flags
  'lenient' = muted, informational), `DRIFT_LOG_SCAN_CAP` (=2000;
  caps the Alert Log read so a runaway log can't blow the script
  budget -- ~143 days of history at 14 depts × 1 trigger/day).
  Server-side `computeThresholdDrift_` filters to `triggeredBy
  === 'daily-trigger'` rows AND drops anything whose Triggered
  By starts with `preview:`, so manual sends from the UI +
  previews don't pollute the signal. It also counts only
  ASSESSED days (status `sent` / `above-threshold`) toward
  `total` -- `no-data` / `skipped` / `no-recipients` / `error`
  days aren't fire-vs-not decisions, so they don't dilute the
  `fired/total` chronic ratio or the `DRIFT_MIN_TOTAL_TO_ASSESS`
  gate (F5). **Self-warming:** a fresh
  install renders every chip as `cold` until each dept has
  >= `DRIFT_MIN_TOTAL_TO_ASSESS` daily-trigger entries logged
  (~10 weekdays after the trigger goes live). **Best-effort:**
  the helper is wrapped in a try/catch inside `getAlertsInit`
  so a missing or corrupt Alert Log returns an empty drift map
  and the modal table still renders the rest of the payload --
  the column just shows dashes for every row. Admin-only via the
  existing modal gating (`assertAdmin_` in `getAlertsInit`);
  no separate gate needed.
- **`neonWrite.js` is duplicated** between `apps-script/cdr-report/` and
  `apps-script/cdr-import/`. Currently byte-identical. Any change to one
  is a two-file edit; `diff` before editing. `neonWrite.js` self-contains
  `parseDateForNeon`, `normalizeDuration`, and `writeCDRRowsToNeon` with
  its CDR field-parsing helpers (`cdrTimeToSeconds_`, `cdrHashPhone_`,
  `cdrLooksLikePhone_`, `cdrParseNameFieldJson_`, `cdrParsePhoneField_`)
  so they travel with the duplication.
- **`buildDQEHistoricalData.js` is also duplicated** between
  `apps-script/cdr-report/` and `apps-script/cdr-import/`. Same INV-16
  byte-identical discipline as `neonWrite.js`. cdr-import calls it
  inline as the 5th sheet write inside `processIntegratedHistory` so
  DQE Historical Data refreshes alongside CDR / Q Path / QCD / CSR in
  one run; cdr-report keeps its standalone `runDailyDQEBuild_` trigger
  as a safety net while the integrated path stabilizes. `diff` the two
  copies before editing either. Side note:
  `logPipelineHealthWithFallback_` in `cdr-import/autoImport.js` has
  an `openById` fallback when `ss` is null;
  `logPipelineHealth_` in `cdr-import/buildDQEHistoricalData.js`
  silently returns when `ss` is null. The rename avoids the prior
  shadowing conflict so each function's behavior is preserved.
- **Inbound-call capture is Neon-only and rides the daily import.**
  `cdr-import/inboundCalls.js::writeInboundCallsToNeon` runs at the end
  of `processIntegratedHistory`, building ONE record per distinct
  inbound call from Raw Data (caller HMAC hash via `cdrHashPhone_` --
  null for Anonymous; dial-in line; disposition + abandon stage;
  abandoned-on-hold + hold/wait seconds; queue journey) and upserting
  to Neon `inbound_calls` (`ON CONFLICT (call_date, call_id) DO
  UPDATE` -- re-imports refresh). Since the JOURNEY EXTENSION, each
  record also carries `call_start` ('HH:MM:SS', CDR-native TZ -- raw PST;
  client renderers shift +2h to CST for display via `clCstTime_`, the
  INV-18 heatmap convention, and journey timelines append a synthetic
  "Call ended" terminal row at last-leg start+duration so a long
  abandoned wait doesn't read as an early disconnect -- owner note) and
  `journey` (a JSON text column: the ordered leg-by-leg path --
  IVR/queue/agent legs with timestamps, durations, talk/hold seconds,
  missed/abandoned flags; capped at `IC_JOURNEY_MAX_EVENTS`=40; callee
  names that look like phone numbers are MASKED so no raw number lands
  in Neon). **Queue-name recognition is config-fed AND brand-prefix aware
  (F1/F1b) -- do NOT re-hardcode it.** `icIsQueueName_` decides what counts as
  a queue leg, and it feeds `entry_queue` / `final_queue` / `num_queues` /
  `abandon_stage`. A name it fails to recognize yields `entry_queue = NULL`,
  which makes the call attributable to NO dept (`inboundDeptPredicate_` matches
  on `entry_queue`) -- invisible in every dept's Inbound report and heatmap.
  The blindness is SELF-CONCEALING: `scanInboundQueueNames_` (the Dept Config
  "Discovered inbound queues" panel) and `runInboundQcdParityCheck`'s
  unattributed list BOTH filter `COALESCE(entry_queue,'') <> ''`, so an
  unrecognized queue has no row to discover. Two sources now feed it, and the
  pattern arm alone still matches (strictly additive, never fewer names):
  (1) the PATTERN -- `A_Q_` at string start **or after an underscore**, plus an
  exact `Backup CSR`. The `_` alternative is F1b and is load-bearing: this
  install runs BRAND-PREFIXED queues (`UDC_A_Q_Main` = Universal Dialysis
  Center, `UUC_A_Q_Main` = Universal Urgent Care) that the old `^A_Q_` anchor
  missed entirely -- a journey-leg histogram over abandoned NULL-`entry_queue`
  calls found `UDC_A_Q_Main` on 38 abandons in one ~8-week window, still
  accruing, while the DQE pipeline had listed BOTH in `DQE_EXCLUDED_AGENTS` all
  along (the two pipelines disagreed about what a queue is). Keep the
  `Backup CSR` arm EXACT -- widening it the way the DQE pipeline's boundary
  regex does would make "Jane Backup CSR" a queue (IMP-1 pins it false).
  (2) the `Dept Config` SHEET -- `icLoadConfiguredQueueNames_` reads the QCD
  Queues + Inbound Queue Aliases columns (incl. the RAW side of a
  `raw=canonical` pair) once per write run, so a new queue is an admin edit
  rather than a code change. Digit-only tokens are rejected (extensions, not
  queue names) and inactive rows contribute nothing. Both writers load it
  BEFORE the record builder (`icIsQueueName_` runs inside it); one
  `icResetConfigMemos_()` clears every Dept-Config memo (the row cache feeds
  both the F1 set and the canonical-name map, so clearing one alone would
  serve a stale read). `buildInboundCallRecords_` stays PURE --
  `IC_KNOWN_QUEUE_NAMES_` is a module global, `null` = pattern-only.
  **⚠ The DQE and INBOUND recognizers diverge ON PURPOSE -- do not
  "harmonize" them.** The DQE pipeline's queue regex
  (`(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)`, IMP-8) deliberately does NOT capture a
  brand-prefixed token: an INV-23 sentinel name must START with `A_Q_`, so
  `UDC_A_Q_Main` correctly yields no match there. The inbound capture MUST
  capture it verbatim, because `entry_queue` is matched by EXACT name against
  the Dept Config lists and nothing there requires an `A_Q_` prefix. Widening
  DQE to match gives you phantom `A_Q_Main` sentinels; re-anchoring inbound
  makes brand-prefixed queues invisible again. Two subsystems, two rules.
  **Diagnosing a suspected miss:** `entry_queue IS NULL` is NOT by itself a
  signal (see Operator State #38). **Internal-transfer path enrichment (R11-N):** when an agent
  ANSWERS an inbound call and TRANSFERS the caller to a queue where the
  caller then abandons, that transfer is a SEPARATE internal-only leg
  group (no Incoming leg) which the record builder drops -- so the
  caller's journey used to just end at the transfer. `buildInboundCallRecords_`
  now cross-references each such internal queue-abandon to the answering
  agent's concurrent captured inbound call and, ONLY on a UNIQUE match
  (that agent's Answered + Talk>0 leg overlapping the abandon within
  +/-5s), APPENDS one synthetic `{kind:queue, abandoned:true, transfer:true}`
  event to that call's journey. Strictly JOURNEY-ONLY -- disposition /
  counts / entryQueue / finalQueue / numQueues / numTransfers are NEVER
  touched (zero metric impact), and 0-or->1 matches are left as-is (it
  never guesses). Pure + deterministic over Raw Data, so a re-import
  within the ~14-day Call_Legs window re-enriches old journeys
  idempotently. Surfaces in Caller Lookup + the Inbound per-call journey
  drills (which read `inbound_calls` by the caller's OWN call); whether
  the Missed report's abandon-🚨 "↳ path" resolves depends on which
  parent id the DQE pipeline stamps into col AD (unverified -- the
  DQE build was intentionally not touched). Two read-only editor
  diagnostics scoped the fix and its ceiling: `previewInternalTransferPaths`
  (unique/ambiguous/unresolved tally + an unresolved breakdown --
  ironclad-Talk=0-recoverable / time-window near-miss / chained-uncaptured)
  and `previewInternalTransferChains` (both date-selectable via the CDR
  Tools menu prompts / `*ForDate` wrappers -- editor runs read the
  `TRANSFER_PREVIEW_DATE` cdr-import Script Property, blank = latest
  sheet; R11-N4) (PHI-masked deep-dive on the
  chained bucket + a bounded 1-hop trace -- multi-date review closed the
  loop (R11-N5): zero externally-rooted chained cases found, the
  conservative enrichment is COMPLETE, no widening warranted; since
  R11-N3 also a 2-HOP
  trace -- when the agent was reached via a queue ring INSIDE an
  internal source group, the same captured-overlap check runs on that
  group's own originator exts -- and an INTERNAL-ORIGIN classification:
  a chain internal at every hop with no concurrent captured inbound has
  NO external caller, so there is no journey to enrich and the base
  build's no-op is correct); both write nothing and are
  safe to delete. Pinned by `tests/unit/inbound-calls.test.js`. The
  writer's idempotent `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` upgrades pre-extension tables in place; the inline insert
  chunks SIZE-AWARE via `icChunkTuplesByChars_` (30K-char budget per
  statement, `IC_SQL_CHUNK_BUDGET_CHARS`) because journey rows vary
  ~0.2-6KB -- a fixed row count overran Apps Script's JDBC cap
  ("Argument too large: sql") on a heavy-journey day. Consumed by
  the dashboard's admin-only **Caller Lookup** (`CallerLookup.gs`,
  route `#/admin/caller-lookup`): phone + date range -> the number is
  normalized to `+<digits>`, HMAC-hashed with the dashboard's
  `HMAC_SECRET` (must match cdr-import's -- the cross-project hash
  parity is pinned by `tests/unit/caller-lookup.test.js`), bound as a
  prepared-statement param, NEVER stored/logged/cached -- and the
  response renders one timeline card per call (journey when present,
  entry->final summary for pre-extension rows). **Caller Lookup is a
  FULL communication history since Option B (see the outbound-capture
  bullet below):** the SAME candidate hashes also query
  `outbound_calls.callee_hash` (per-call outbound cards, direction
  chips, one interleaved newest-first timeline) and
  `call_history_phones.phone_hash` (day-level outbound aggregates
  rendered as an "Earlier outbound activity" section ONLY for dates
  the per-call capture doesn't cover -- per-call detail was never
  stored for those, so day-level is the ceiling there). Each section
  is independently best-effort: a missing `outbound_calls` table
  (dashboard deployed ahead of cdr-import) flags
  `meta.outboundAvailable=false` + a client note without touching the
  inbound results. **Per-call drill-through
  (#3):** `InboundReport.gs::getCallJourney({callId, date, department})`
  returns ONE call's journey by `(call_date, call_id)` for the "↳ path"
  affordance on ABANDONED rings in the Missed Calls report + My Department
  missed section (those 🚨 timestamps already carry the parent call id +
  date). Unlike the full Inbound report (admin-only while vetted), this is
  manager-reachable for the manager's OWN dept: managers are pinned to
  their dept AND the query is scoped by the SAME `inboundDeptPredicate_`,
  so a crafted call_id for another dept returns `found:false` -- enforced
  SERVER-side since F-4: the exact-(call_date,call_id) fallback (needed
  because inbound_calls stores RAW queue names that can miss the scoped
  predicate) is gated for managers by `callIdInDeptMissedReport_`, which
  requires the id to appear as an abandoned parent id in the manager's
  OWN dept's Missed report for that date (admins ungated; fail-closed on
  any error). Since R7 (M-2) a MISS carries a `reason` -- `'before-capture'`
  (+`minDate`) / `'date-gap'` (zero inbound rows for the date -- see the
  Neon coverage check, Op State #35) / `'not-captured'` (date has rows;
  this call wasn't a captured inbound call) -- probed via one cheap
  MIN/EXISTS query ONLY when the unscoped lookup was entitled to run, so a
  gate-closed manager learns nothing; the client renders the matching
  actionable note. The journey carries no caller identity. Client reuses the Caller Lookup renderers
  (`clChainHtml_`/`clJourneyRowHtml_`) in a lightweight `#call-journey-overlay`.
  There is NO sheet primary for this data: the "Inbound Calls" tab
  (`cdr-report/inboundCallsExport.js::exportInboundCalls`,
  refresh-in-window semantics) is a fallback COPY of Neon, not a
  source. History: editor-run `backfillInboundCalls` (cdr-import)
  fills from surviving `Call_Legs_*` sheets only -- days pruned by
  DeleteOldSheets are unrecoverable, and journey backfill reaches at
  most the ~14-day Call_Legs retention window (run it right after
  deploying the extension to capture what's still there). Insurer labels come
  from `insurance_numbers`, synced by the editor-run
  `syncInsuranceNumbersToNeon` (`cdr-report/insuranceNumbers.js`) from
  the insurance block in `DO NOT EDIT!` cols X-AG -- re-run it after
  editing that block, or new numbers stay "(unlabeled)" in the
  Inbound report (`InboundReport.gs`, route `#/report/inbound`), which
  reads Neon directly (one json_build_object round-trip) and renders an
  "unavailable" state -- intentionally NOT cached -- when Neon is
  unreachable. **TEMPORARILY re-scoped to admin-only** while the report is vetted
  (the QCD-vs-inbound abandonment discrepancies -- different source +
  definitions -- are parked until then); the per-dept manager path is
  kept intact in `inboundResolveRequest_`, so restoring manager access
  is a one-line gate removal + un-hiding the `data-admin-only` tab.
  **Vetting tool (Batch 8): `runInboundQcdParityCheck`** (editor-run,
  admin-gated, read-only; optional `INBOUND_QCD_PARITY_FROM/_TO/_DEPT`
  Script Properties, default last 14 days / all mapped depts) joins the two
  lenses per dept per day -- QCD Abandoned (canonical queues, source-aware
  grid) vs inbound_calls abandons via the SAME `inboundDeptPredicate_`,
  reporting strict abandons AND the answered-on-hold carve-out separately so
  the definitional gap is quantifiable -- and lists the window's
  UNATTRIBUTED raw entry-queues (fix: the Dept Config "Inbound queue
  aliases" column). Pinned by tests/unit/inbound-qcd-parity.test.js. Run it
  (+ populate aliases, re-run) BEFORE any un-gating decision.
  **The gap it measures is now SETTLED (2026-07) -- read
  `docs/known-issues.md` "QCD Abandoned vs inbound_calls abandons" before
  re-investigating; four plausible explanations were eliminated and they all
  look plausible again from a standing start.** The three live rules that came
  out of it: (1) **QCD's Abandoned applies a minimum QUEUE-WAIT threshold
  (>48s observed; 60s fits) and the inbound capture applies NONE** -- inbound
  answers "did this caller hang up without reaching a human?", QCD answers
  "did this caller wait past the threshold and give up?". Both are correct;
  they are ~4x apart on CSR and must never be shown side by side without
  saying so (that caption is the prerequisite for un-gating). (2)
  **`wait_seconds` is WHOLE-CALL elapsed time from IVR pickup
  (`abandonLeg.stop - firstLeg.start`), NOT queue wait** -- the IVR runs
  54-65s on nearly every call here, so a 1-second queue abandon stores as
  `wait_seconds` 55. Never compare it to a queue threshold or read it as
  "time spent waiting for an agent"; the per-leg `secs` inside `journey` is
  where a real queue wait is derivable. It feeds the heatmap cell drill's
  "wait/hold" label, which is misleading for the same reason (open
  follow-on). (3) **QCD is work-window-scoped and the inbound capture
  is NOT** -- `buildInboundCallRecords_` captures around the clock while QCD's
  Abandoned only counts 6:30 AM-3:00 PM PST, so any comparison must scope the
  inbound side to `INBOUND_WORK_WINDOW_PST` (Config.gs -- the THIRD copy of the
  window, INV-06 sync obligation; text `HH:MM:SS` in raw PST so it compares to
  `call_start` with no conversion, NULL `call_start` counting as in-window).
  Measured at ~10% of the CSR gap (11 of 113), so it is a correctness fix, not
  the explanation. **Out-of-window calls are RESEARCH data, never a dept metric
  (owner ruling)** -- report them separately, never in a dept total; the
  after-hours abandon rate is ~47% vs ~4% in-window, which is what an unstaffed
  queue looks like. Scoped surfaces: `compareInboundVsQcdAbandons_`,
  the whole `computeInboundReport_` payload (KPIs + all five breakdowns + daily,
  via one `inboundWindowClause_(true)` appended to the shared `dr`/`priorDr` --
  `inbound:v7`), and `getInboundInsurerDaily` (so the drill reconciles with the
  byInsurer row it hangs off). Two deliberate NON-scopings: `coverageStart`
  (answers "when did capture begin", not a dept metric) and **the abandon
  HEATMAP, which is already bounded by its own 8 AM-5 PM CST band -- the INV-18
  convention, 30 min wider at the start on purpose. Do NOT add the work-window
  clause on top of it**; `tests/unit/inbound-window-scope.test.js` pins both
  exemptions plus a count-based guard that every `FROM inbound_calls c`
  sub-select carries the window, so a new one can't be added off an unscoped
  predicate. The client renders the research block as an "Outside business
  hours" section below the heatmap, muted and captioned as not-a-dept-metric,
  hidden entirely when the window is clean.
  Also found by that run and FIXED: **the answered-on-hold carve-out
  had never fired in this install** -- `final_dept` holds raw CDR org-chart
  labels (`Customer Success`, `Inside Sales`, `Patient Care`, ...) and not one
  matches a dashboard dept header, so every such call attributed to no dept
  (146 in a 2-week window). `inboundDeptPredicate_`'s on-hold arm now matches
  `lower(trim(final_dept))` against `getFinalDeptLabels_(dept)` -- the Dept
  Config **`Final Dept Labels`** column (INV-54, col 11) -- which ALWAYS
  prepends the dept's own name. **Adding a label is a Dept Config edit, no
  redeploy.** **A label mapped to NO dept falls back to the ENTRY QUEUE
  (`inbound:v7` / `inboundHeatmap:v2`)** -- the two arms are exclusive on the
  on-hold flag, so before the fallback an unmapped label made the call attribute
  to NOBODY (the entry-queue arm was skipped for it). The fallback gates on
  `getAllFinalDeptLabels_()`, the UNION across every dept, NOT this dept's list:
  a label mapped to dept A must not ALSO fall back to entry-queue dept B, or both
  count the call. It fails OPEN (unreadable config ⇒ empty union ⇒ everything
  falls back to the entry queue -- degraded attribution, never lost calls, never
  double-counted). **This is what makes an AMBIGUOUS label safe to leave
  unmapped, which is the only correct handling for one:** `Field Ops` and `Field
  Ops Power` carry both `Field Operations (Market Activity)` and `Field
  Operations (Markets)` INTERCHANGEABLY, so no label→dept entry is right for
  either -- save validation already refuses a label claimed by another dept, and
  mapping it to one would silently steal the other's calls. Those two depts have
  no crossover agents, so the entry queue attributes their on-hold abandons
  correctly with nothing mapped. Leave a shared label out of BOTH rows.
  Once released: managers see their own dept's slice; admins can also pick "All
  departments" (the only view that includes the "Abandoned in IVR"
  bucket -- IVR abandons never reached a queue so they're
  unattributable). **Dept attribution contract:** a call belongs to the
  dept whose effective queue list (`queuesForDept_`, same map as QCD)
  contains its ENTRY queue (one call = one dept; overflow stays with
  the entry queue's dept) -- EXCEPT an answered call abandoned ON HOLD,
  which attributes by `final_dept` (the answering agent owned it). Soft
  coupling: `final_dept` is the raw CDR "Departments" label and must
  match the dashboard dept header (case-insensitive, trimmed) for that
  carve-out to hit. The per-insurer daily drill-down
  (`getInboundInsurerDaily`, click an insurer row) binds the insurer
  label as a prepared-statement parameter -- it's admin-entered free
  text, never inline it into SQL.
- **Outbound-call capture is Neon-only and rides the daily import (Option
  B -- the per-call outbound twin of the inbound capture).**
  `cdr-import/outboundCalls.js::writeOutboundCallsToNeon` runs right after
  the inbound block in `processIntegratedHistory` (reusing the same Raw
  Data display rows), building ONE record per distinct OUTBOUND external
  call and upserting to Neon `outbound_calls` (`ON CONFLICT (call_date,
  call_id) DO UPDATE`; authoritative per-date replace + the P-1
  `expectedDateIso` stray-record guard, since -- like inbound_calls --
  there is NO sheet primary). A leg group is outbound when it has NO
  Incoming leg (an answered inbound queue call carries the agent's own
  'Outgoing' talk leg, so direction alone would misfile it) AND at least
  one Direction='Outgoing' leg to an external (>=10-digit) number.
  Captures: `callee_hash` (HMAC of the canonical `+<digits>` form via
  `cdrHashPhone_` -- the SAME hash space as `inbound_calls.caller_hash` /
  `call_history_phones` / `insurance_numbers`), the dialing agent (name +
  ext + raw CDR Departments label), `connected` (Talk>0 Answered external
  leg -- the CDR can't distinguish no-answer / voicemail / busy on the
  unconnected side, matching the Direct report's activity-only outbound
  semantics), talk/ring seconds, attempts, `call_start` (raw PST
  'HH:MM:SS'; clients shift +2h to CST via `clCstTime_`, the INV-18
  convention), and the masked leg-by-leg journey (a phone-shaped callee
  name renders '(external number)' -- no raw number in Neon). The writer
  auto-creates the table AND `idx_outbound_calls_callee_hash` (no operator
  console step). Best-effort + isolated: failures log a
  `processIntegratedHistory:Outbound` Pipeline Health row + email (the F9
  no-sheet-primary rationale) and never affect the import. Deferred mode
  (`NEON_MIRROR_MODE=deferred`) drains it as `neonMirror:Outbound` via
  `mirrorOutboundForDate_` (same unreachable-stays-queued / pruned-sheet-
  throws rules as inbound). History: editor-run `backfillOutboundCalls`
  (cdr-import) fills from surviving `Call_Legs_*` sheets -- **run it once
  right after deploying this capture** to grab the ~14-day retention
  window; earlier dates are covered only by the day-level
  `call_history_phones` aggregates. Without `HMAC_SECRET`, rows write
  with NULL `callee_hash` and heal on re-import. Sole consumer: the
  Caller Lookup communication history (above). Pinned by
  `tests/unit/outbound-calls.test.js`.
- **Temporal abandon heatmap (weekday × hour), sourced from
  `inbound_calls`.** **NOT work-window-scoped, deliberately** -- it is already
  bounded by its own `INBOUND_HEATMAP_WINDOW_START_HOUR`/`_END_HOUR` band
  (8 AM-5 PM CST, the INV-18 convention, 30 min WIDER at the start than the
  6:30 AM-3:00 PM PST work window on purpose), so nothing out-of-hours reaches
  it. Do NOT add `inboundWindowClause_` here the way the report's dept slices
  carry it -- that would silently narrow the grid's first column;
  `tests/unit/inbound-window-scope.test.js` pins the exemption. `InboundReport.gs::getInboundHeatmap({department,
  from, to})` aggregates abandon rate by `ISODOW × hour-slot` in ONE
  json_agg round-trip, reusing `inboundResolveRequest_` (so it inherits
  the inbound report's **admin-only vetting gate** + per-dept scoping) and
  `inboundDeptPredicate_`. Cached `inboundHeatmap:v2`. Rendered by the
  SHARED client `renderAbandonHeatmap_` / `loadAbandonHeatmap_` as a
  CSS-grid heatmap (no Chart.js dep) in the **Inbound report**
  (`#inbound-heatmap`, always, since that report is admin-only), AND the **Insights report**
  (`#ins-heatmap`, a Queue-health companion gated by the SAME
  `USER.role==='admin'` check in `insRenderReport_` -- part of the
  QCD->Insights consolidation parity; managers get the else-branch hide).
  Cell color pivots on the 5%
  company standard (C2): ≤5% calm sage, >5% ramps warm; cells under
  `HEAT_MIN_VOLUME_`=3 calls render muted ("low signal"), colors resolve
  through `colorToCanvasRgb_` so they're OKLCH/theme-safe (INV-42).
  **TZ (the one thing to verify live):** `inbound_calls.call_start` is
  stored as raw **PST** 'HH:MM:SS' (the inbound capture does NOT apply the
  +2h PST→CST shift the DQE slot pipeline does -- `icIsoTime_` in
  cdr-import preserves the raw wall-clock), so the heatmap SQL shifts
  `+INBOUND_HEATMAP_CST_SHIFT_HOURS`=2 to align the slot axis with the
  dashboard's 8 AM-5 PM CST work-window convention (INV-18). If a
  spot-check shows the columns are off, that single constant is the knob.
  Pre-extension rows (null `call_start`) carry no time-of-day and are
  excluded; the panel hides itself silently on unavailable/unmapped/empty.
  **Cell drill:** any cell with at least one abandon is click-to-drill --
  `getInboundHeatmapCell({department, from, to, dow, slot})` (InboundReport.gs)
  lists that cell's individual abandoned calls (date, CST time, entry->final
  queue, stage, wait/hold) into a panel below the legend, each row carrying
  the existing "↳ path" journey drill (`.pid-journey` -> `getCallJourney`).
  Same auth (the admin-only vetting gate via `inboundResolveRequest_`) +
  dept predicate + TZ-shift/window/slot math as the heatmap SQL, so the list
  always reconciles with the cell's count; `disposition='abandoned'` only;
  capped at `INBOUND_HEATMAP_CELL_MAX`=200 newest (meta.truncated);
  intentionally UNCACHED (per-cell, cheap; unavailable payloads must not
  pin). Pinned by tests/unit/heatmap-cell-drill.test.js. No caller identity
  in the response.
- **Direct-extension call metrics are a separate population from the
  DQE/QCD queue metrics, with a "busy" carve-out.** `cdr-import/directCallMetrics.js`
  (cdr-import-only -- NOT an INV-16 byte-identical duplicated file) computes
  per-agent-per-day metrics for DIRECT / individual-extension calls (inbound +
  outbound to/from an employee's own extension), as a population DISTINCT from
  the department call-queue calls DQE Historical Data / QCD already cover. The
  defining rule: an INBOUND direct ring missed BECAUSE the agent was already on
  another call (any overlapping leg + a `DIRECT_BUSY_WRAPUP_SEC`=5s tail) lands
  in its own `missed_busy` bucket and is EXCLUDED from the answer rate (but
  still counted + surfaced); outbound is activity-only. The pure engine
  `computeDirectCallMetrics` is unit-tested (`tests/unit/direct-call-metrics.test.js`).
  Persistence: the `Direct Call History` sheet (CDR Report ss, refresh-in-window
  -> idempotent) + the Neon `direct_call_history` mirror (PK
  `(call_date, department, agent_name)`, `ON CONFLICT DO UPDATE`), both lazily
  created -- **no setup() change.** Build paths share one core
  `buildDirectCallFromRaw_(ss, rawDisp, configSheet, opts)` (`opts.skipNeon`
  defers the Neon mirror; **`opts.expectedDate` (P-4, the F2 class)** makes the
  build REFUSE -- throw into the caller's Pipeline-Health-logging catch --
  when the grid's first-row-derived date disagrees, since a stray carry-over
  first row would otherwise stamp the whole day as D-1 and the
  delete-then-rewrite writers would wipe D-1's correct sheet + Neon rows;
  both the daily and bulk callers pass the importer's `dateObj`; the
  editor-run Phase-1a build self-derives and passes nothing, unchanged.
  **P-5:** `writeDirectCallRowsToNeon_` runs its authoritative date-DELETE
  even for an EMPTY row set -- `dcWriteSheet_` clears the sheet's rows for
  the date regardless, so a force re-import of a date whose direct activity
  drops to zero no longer leaves the stale row set in `direct_call_history`;
  it skips only when there's no date at all): the editor-run `runDirectCallBuild()` (Phase 1a,
  spot-checking), the daily `processIntegratedHistory` 6th block (Phase 1b,
  inline Neon mirror, best-effort -- a failure never affects the import), and
  the bulk-backfill path (Phase 3, builds the sheet per date with `skipNeon`,
  gated on its OWN `willBuildDirect`; NOTE the bulk path runs FORCE-mode (`processBulkQueue` passes force=true), so `willBuildDQE`/`willBuildDirect` are always true in practice -- the gates matter only for a hypothetical non-force bulk caller). The deferred bulk mirror is flushed by
  the editor-run **`backfillDirectCallToNeon()`** (cdr-import; one connection,
  batched `ON CONFLICT DO UPDATE`, resumable via `DIRECT_UPSERT_RESUME`, optional
  `DIRECT_UPSERT_SINCE` date floor) -- the DQE `skipNeon` +
  `backfillDQEHistoryUpsert` pattern, but cdr-import-local (the writer + table
  DDL live here). The shared `dcUpsertRows_(conn, rows)` holds the upsert SQL
  for BOTH the single-date writer and the multi-date backfill. Dashboard read
  surface: `DirectCallReport.gs::getDirectCallReport({from,to,department?})`
  (ONE json_build_object Neon round-trip; per-agent answer rate EXCLUDING the
  busy carve-out, inbound ATT, outbound activity + ATT, int/ext split; cached
  `directCall:v2`). **R11-M: the SAME query also computes `kpisPrior` (scope-level,
  over the INV-28 immediately-preceding same-length window) + `deptsPrior`
  (per-dept prior aggregates); the client renders delta chips (`inboundDelta_`)
  on the IB Answered / IB Answer Rate / OB Calls KPI cards and on each company-view
  dept header row (answered/OB up=good, missed up=bad, answer% up=good), plus a
  92%-standard tone rail on the dept card.** **TEMPORARILY admin-only while the carve-out numbers are
  vetted** (the Inbound-report model: the per-dept manager path is written +
  kept intact, so release is a one-line gate removal in
  `directCallResolveRequest_` + un-hiding the `data-admin-only` Direct tab).
  Route `#/report/direct`. **Company view renders per-DEPT cards (R11-C5):**
  when an admin runs "All departments", the flat all-agents table is
  replaced by `<details>` cards grouped client-side from the same per-agent
  rows via `r.dept` -- aggregate headline stats on the summary (agents / IB
  answered / missed free+busy / busy-excluded answer % with the 92% tint /
  answered-weighted IB ATT / OB calls), each expanding into that dept's own
  sortable agent table (shared `directAgentRowHtml_` / `directImpact_`;
  dynamic `direct-dept-tbody-*` sort wiring is dropped + re-armed per
  render). Card order = the R11-B11 impact score on the dept aggregate.
  Single-dept view keeps the flat table; the CSV stays flat with its Dept
  column. See `docs/direct-extension-metrics-design.md`.
- **Client / presentation-layer conventions live in
  [`docs/client-ui-conventions.md`](docs/client-ui-conventions.md) — READ IT
  before touching `script.html`, `styles.html`, or `dashboard.html`**, and
  re-run `npm run ci:ui` afterwards. Fourteen bullets moved there in the F8
  split because they describe how a SURFACE IS BUILT rather than a trap that
  bites unrelated work; the full text is authoritative there, this is the index:
  Insights absorbed the Performance Report AND Compare Ranges (both retired,
  incl. the consolidated trend chart + per-agent cards/chart bases + IR
  drill-through) · Insights period slider, trend-at-bottom and the
  Insights↔My-Department hand-off (incl. the R9-3 shared date window) ·
  Insights Simple/Detailed density toggle (and the C3 render-then-hide chart
  trap) · Insights density Phase 2 (saved views, share link, calendar trend,
  summary email) · the guided onboarding tour · the Insights floating admin A/B
  remote · the anti-intimidation layer (answer-first headlines, quick-start
  chips, the metric glossary, benchmark tints) · per-report client prefs in
  localStorage (every `cdr.*` key) · CSS design-token conventions (`--bad` vs
  `--warn`, `--r: 2px`, mono letter-spacing) · the `ds-*` shared component
  layer and its conflict register · the Pass-2 design additions · report SWR
  and the D1b keep-last-good store · the Overview stacked-sticky layout · the
  Overview trend-chart conventions (hues, sub-queue dashing, the holiday-aware
  axis, spotlight/pin, trend arrows, axis zoom).
  **The client traps that CAN bite you without warning stayed HERE** and are
  not repeated there: `safeChart_`, `dsConfirm_`, `csvSafeCell_`, the
  datalabels registration, the OKLCH/datalabels fillStyle rule, and the
  `</script>`-in-scriptlet escape.
- **Team-Insights volume gating on a length mismatch.**
  `Util.gs::buildTeamInsights_` takes an optional `opts.excludeVolume`;
  Insights (`computeInsights_`) passes (and the retired Compare Ranges
  passed) `{ excludeVolume: lengthMismatch }` so a different-length comparison
  DROPS the raw cumulative-volume insights (answered / missed COUNTS --
  apples-to-oranges across unequal windows) while keeping the
  length-independent ones (answer rate %, avg talk time per-call). The
  Performance Report never mismatches (INV-28 same-length prior) so it
  passes nothing -- unchanged. Separately, the Insights at-a-glance HEADLINE
  tone is neutralized (no green/orange "On track"/"Watch" banner -- falls
  back to neutral) when the two windows differ by more than 7 days, so a
  shaky comparison doesn't read as a false alarm (the sentences still
  render). NOTE: these change `teamInsights` output without an INV-30 cache
  bump -- the cache key already encodes the prior window (so the result is
  deterministic per key); the only effect is a ≤30-min stale callout on
  mismatched windows right after deploy.
- **Chart.js CDN-failure fallback (`safeChart_`).** Every chart is created
  through `safeChart_(target, config)` (script.html), NOT `new Chart(...)`
  directly. It's a transparent pass-through when `Chart` is defined (common
  path provably unchanged); only when the global is missing (blocked/failed
  CDN, SRI mismatch) does `chartUnavailable_` hide the canvas and insert an
  idempotent inline `.ds-note.ds-chart-unavailable` note -- so KPIs/tables
  still render and the failure is explained, not a silent throw. Scoped to
  the CDN-absent case only (it does NOT try/catch per-chart render errors).
  Any new chart callsite must route through `safeChart_`.
- **App-styled confirm dialog (`dsConfirm_`), not `window.confirm`.**
  `dsConfirm_(opts)` (script.html) is a Promise-based, token-themed
  confirmation dialog that replaces the browser-native `window.confirm`
  (which renders in the Sheets/browser chrome style, incongruent with the
  app). It's layered above every modal + toast (z-index in styles.html),
  supports Enter/Escape/backdrop, a `danger` tone for destructive actions,
  and either `message` (plain, auto-escaped) or `messageHtml` (caller MUST
  escape dynamic values). Currently wired in the **Outlier Fix** modal
  (rename / add-to-roster / deactivate-alias); the ~12 other legacy
  `window.confirm` callsites can adopt it incrementally. New confirmation
  UI should use `dsConfirm_` rather than adding another `window.confirm`.
- **CacheService key length cap (250 chars).** Apps Script silently
  rejects cache keys longer than 250 characters, surfacing as an
  error on `cache.get`. The Individual / Performance / Compare
  Ranges reports include the selected agent list in their cache
  key, which overflows on big rosters (Sales is the canonical
  trigger). `Data.gs::hashAgents_` MD5-hashes the sorted agent
  list to a 32-char hex digest so the compound key stays bounded
  regardless of selection size. Never concatenate raw agent names
  into a cache key — always go through `hashAgents_`. **The other
  CacheService limit is the ~100 KB PER-VALUE cap, and the Overview
  blob is the only payload near it (F6).** `CompanyOverview.gs` logs
  the serialized length on every put, warns past
  `OVERVIEW_CACHE_WARN_BYTES` (80 KB) and, on a failed put, says
  explicitly that the Overview is now UNCACHED so every request pays
  the full compute (`OVERVIEW_CACHE_MAX_BYTES` = 100 KB documents the
  cap; it is not enforced). MEASURED at ~27 KB for 14 depts (~1.9
  KB/dept) -- roughly 50+ depts away, so this is instrumentation, not
  a live risk, and it is LOG-only: nothing surfaces on the Health
  page.
- **CSV exports must neutralize formula injection.** Agent names
  originate from the external CDR feed and flow into client-side
  CSV downloads, so they're untrusted input to a spreadsheet app
  (Excel / Sheets treat a cell starting with `= + - @` / tab / CR
  as a formula). `script.html::csvSafeCell_` prefixes a single
  quote on such cells while preserving legitimate signed numbers,
  percentages, `pts`, durations (`H:MM:SS`), and thousands
  separators (so server-computed numerics aren't mangled). All
  FIVE CSV escapers route through it: My Department
  (`exportTableCsv_`'s `csvEscape`), the Insights CSV (`insDownloadCsv_`),
  the Inbound CSV (`inboundDownloadCsv_`), the Direct CSV
  (`directCallDownloadCsv_`), and the all-dept QCD CSV (`qcdAllDeptCsv_`).
  Any new CSV cell writer must call `csvSafeCell_`
  before the RFC-4180 quote-escaping.
- **Chart.js v4 + chartjs-plugin-datalabels needs explicit
  registration.** v4 dropped the auto-register-on-script-tag
  behavior the plugin relied on, and the plugin itself defaults
  to `display: false` since v1.0.0. Both `Chart.register(ChartDataLabels)`
  AND `Chart.defaults.plugins.datalabels.display = true` must run at
  module load (see the `registerChartDataLabels_` IIFE in
  script.html). Per-chart `display: false` (Missed Calls radar,
  Overview multi-line trend) still wins via the normal options
  override. Use the boolean form for `display`; the function form
  (`display: function (ctx) {...}`) returned false unpredictably on
  mixed bar+line charts in this plugin version. **A per-report "Show
  data labels" toggle** (checkbox `<report>-show-datalabels`, off by
  default, the `datalabels.display` read straight from `.checked`) is
  wired on IR / Insights; each persists it in its prefs blob
  (the retired QCD modal's standalone `cdr.qcd.datalabels` key is now
  an orphan).
  The Overview multi-dept overlay + the Missed Calls radar intentionally
  have NO toggle (10+ overlaid lines / dense buckets make labels
  unreadable) and keep `display: false`.
- **OKLCH colors break datalabels silently.** Modern browsers
  resolve `var(--paper)` etc. to `oklch(...)` strings, which
  chartjs-plugin-datalabels can't parse for `fillStyle` — labels
  render with an empty fill (invisible). `refreshChartTheme()` in
  script.html paints each CSS custom property onto a 1×1 canvas via
  `colorToCanvasRgb_()` and reads back the canonical `rgba(...)` form
  so the plugin always receives a parseable color. Don't pass raw
  `getComputedStyle(...).getPropertyValue('--foo')` strings to chart
  options — always go through `THEME.*`. **R12-2 caveat: the fillStyle
  READBACK alone does NOT canonicalize non-legacy colors** — modern
  browsers serialize an oklch/oklab/color() fillStyle back VERBATIM,
  which silently defeated the whole mechanism for the oklch tokens
  (accent/good/warn/bad + softs) and rendered every R11-L trend arrow
  gray via `parseColorRgb_`'s fallback. `colorToCanvasRgb_` now detects
  a non-`#hex`/`rgb()` readback and resolves it via a painted-pixel
  `getImageData` (which always yields a real RGB triple). Any future
  color plumbing must not regress to bare fillStyle readback.
- **Recently-active denominator.** The Overview tile caption "X of Y
  agents" uses `recentlyActiveCount` (any rung / answered / missed
  activity in the last `OVERVIEW_RECENT_ACTIVE_DAYS` = 30 days), NOT
  full roster size. Ex-employees who are kept on the `DO NOT EDIT!`
  sheet for historical-data preservation fall out of this count
  naturally. The hover tooltip on the caption shows all three
  numbers (today's active, recent active, full roster) so the
  denominator choice is transparent.
- **Apps Script projects share one global scope across all .gs
  files.** Multiple top-level `function onOpen()` (or any other
  same-named global) declarations silently override each other --
  the last-loaded file's definition wins. If a project needs more
  than one menu, build them all from one `onOpen` (see
  `cdr-report/CDR Tools menu.js` calling `installDQEDrilldownMenu_`).
- **`<?!= JSON.stringify(x) ?>` is not script-tag safe.** Apps
  Script's force-print scriptlet doesn't HTML-escape, and
  `JSON.stringify` does not escape `</script>` inside string
  values. Do the escape SERVER-SIDE in `.gs` so the troublesome
  pattern never appears in the `.html` template file -- not even
  in comments. The HTML parser closes a `<script>` block on the
  literal end-of-script-tag pattern wherever it appears
  (including inside JS line comments inside the same script
  block, which is how an earlier inline-replace bug bit us).
  Canonical pattern: `tmpl.userJson = JSON.stringify(obj).replace(/</g, '\\u003c')`
  in `Code.gs::renderDashboard_`, then `window.__USER__ = <?!= userJson ?>;`
  in `dashboard.html`.
- **Admin emails are resolved at request time.** Membership checks
  and admin recipient lookups go through `Config.gs::getAdminEmails_()`,
  which reads the `ADMIN_EMAILS` Script Property (comma-separated
  emails) on every call and falls back to the `ADMIN_EMAILS_FALLBACK`
  constant if unset. Adding an admin is a Script Property edit; no
  redeploy. The `access_denied` template's mailto contact is
  `getAdminEmails_()[0]` (resolved at request time, so the Script
  Property's value wins there too). The old `ADMIN_EMAILS_DISPLAY`
  constant was dead code and was REMOVED (F-30). **Never read a
  constant for membership checks**; always go through
  `getAdminEmails_()`.
- **Role model + the all-departments manager (`allDepts`).** Three roles
  (`admin` | `manager` | `none`; `Auth.gs::resolveUser_`). A manager is
  looked up in the `Access Control` sheet and pinned to ONE department --
  **EXCEPT** when the Department cell is the sentinel `ALL` (or `*`,
  case-insensitive, `isAllDeptsSentinel_`): that grants an
  **all-departments manager** -- `role:'manager'` with a new
  `allDepts:true` flag, `department:null`, `departments:getAllDepartments_()`.
  It sees EVERY department's non-admin data (like an admin for data breadth)
  but NOT admin surfaces. **Design invariant (fail-safe):** it stays
  `role:'manager'`, so every admin-SURFACE check (`assertAdmin_`,
  `data-admin-only`, `personalizeOverview_`'s admin-field strip) keeps
  excluding it automatically; only DATA-BREADTH gates opt it in. Server:
  `assertDeptAccess_` lets `allDepts` managers (like admins) reach any
  existing dept while single-dept managers stay pinned (`!user.allDepts`);
  `personalizeOverview_` keeps all WoW drivers for them (they see every
  dept) but still strips the 4 admin-only fields; `getEscalations` /
  `getEscalationsInit` give them all-dept escalation scope (create stays
  `assertAdmin_`); `Code.gs` ships `allDepts` + the full dept list in the
  client user envelope. Client: `isAllDeptViewer_()` (=
  `role==='admin' || USER.allDepts`) gates DATA-BREADTH only -- the header
  dept selector, `getRequestedDept`, `ovViewerDept_`, Overview point/tile
  routing + spotlight, the escalations dept picker. Admin-surface checks
  stay `role==='admin'`. Crucially each widened check evaluates identically
  for admin (true) and a normal manager (false), so existing roles have
  ZERO behavior change and a missed widening degrades the new role to a
  single-dept manager (least privilege). (R-3 closed the three known missed
  widenings: `getCallJourney` -- incl. its F-4 fallback entitlement, which
  now passes `user.allDepts` like admins -- plus `inboundResolveRequest_`
  and `directCallResolveRequest_`, whose pinning is now
  `manager && !allDepts`; the latter two stay latent behind their vetting
  gates but won't break the role the day those gates are removed. R8-4
  closed a fourth: `escAssertRowAccess_` -- the escalations per-ROW gate --
  now passes `allDepts` managers like admins; pre-fix `rowDept !== null`
  threw on every row, so the role could LIST all-dept escalations but not
  act on any (all six worklist verbs failed) and `getEscalationActivity`'s
  not-found shape rendered every activity timeline silently blank. Pinned
  by `tests/unit/escalations-hardening.test.js`.) **Grant it** by setting an Access
  Control row's Department cell to `ALL` (Access Control admin modal or the
  sheet; `saveAccessControlRow` accepts + canonicalizes the sentinel) --
  no Script Property / scope. Pinned by
  `tests/unit/access-control-editor.test.js`. **If you add a new
  `role==='admin'` check, decide: is it an admin SURFACE (keep it) or DATA
  BREADTH (use `isAllDeptViewer_()` / `user.allDepts`)?**
  **MULTI-DEPARTMENT manager (Tier C).** A manager may hold MORE THAN ONE
  `Access Control` row (same email, different dept). `resolveUser_` now
  UNIONS them into `departments` (was: only the first honored, F13 --
  now removed); `department` is the first (default landing), `allDepts`
  stays FALSE (they see only their assigned depts, not every dept). The
  security gates accept a list: `assertDeptAccess_` + `escAssertRowAccess_`
  + the (latent, admin-only) `inbound`/`direct`/`getCallJourney` pins check
  `dept ∈ user.departments`; a single-dept manager's `departments` is a
  one-element list, so those are byte-equivalent to the old `!== department`
  check (least privilege preserved). `getEscalations` scopes a multi-dept
  manager to `department IN (...)` (all their depts by default, or a chosen
  one); `personalizeOverview_` keeps WoW drivers for all their depts. Client:
  a NEW `canPickDept_()` (= `isAllDeptViewer_() || manager with
  departments.length>1`) gates ONLY the dept-SWITCH surfaces (header selector
  population, `getRequestedDept`, `ovViewerDept_`); the Overview cross-dept
  routing/spotlight stay `isAllDeptViewer_()`-gated (a multi-dept manager
  switches via the selector; the server rejects any non-assigned dept
  regardless). `Code.gs` ships `departments` when `length>1`. The editor's
  `saveAccessControlRow` is a REPLACE-ALL by email (accepts `departments[]`
  OR the legacy single `department`; ALL/* is exclusive), and
  `getAccessControlInit` returns a grouped `managers` list; the modal's dept
  picker is a multi-select. Multiple managers per dept already worked
  (different emails, one row each). Pinned by
  `tests/unit/access-control-editor.test.js` +
  `escalations-hardening.test.js`.
  **Multi-row rows vs. an `Overview Parent` edge -- pick by whether the two
  depts are actually related (owner ruling 2026-07).** Both give a manager a
  second dept's data, and they are NOT interchangeable. **Multiple Access
  Control rows** confer per-dept data access and nothing else: the depts stay
  independent top-level tiles, no sub-queue switcher, no combined view, no
  rollup. **An `Overview Parent` cell** declares a genuine parent/child
  sub-queue -- it nests the tile, turns on the combined view + per-dept
  subtotals, folds the child's queues into the parent's QCD rollup
  (`queuesForDept_`), AND confers access (INV-38). So for two INDEPENDENT
  queues that merely share a manager, use the rows; reaching for the parent
  map would misrepresent the relationship in every rollup. `Field Ops` /
  `Field Ops Power` is exactly this case and is deliberately NOT in the parent
  map -- the owner ruled they are separate queues whose managers should see
  both. NB Alerts + Digests follow neither mechanism (their own per-dept
  config rows), so shared-manager email needs a row per dept there too.
  **ALIAS EMAILS (Tier C).** The optional `EMAIL_ALIASES` Script Property
  (comma/newline-separated `alias@x = canonical@x` pairs, tolerant grammar
  like `DIAL_IN_LABELS`) lets several sign-in addresses resolve to ONE
  identity: `resolveUser_` canonicalizes the address (via
  `canonicalizeEmail_`, memoized on the raw property, ≤5 hops to break a
  mis-entered loop) BEFORE the admin/manager lookup, so an alias inherits
  the canonical user's role + departments, and the returned `email` is the
  canonical identity. Unset = pre-Tier-C behavior. Note Gmail dot-normalization
  does NOT cover `john.doe`→`john` (different local parts), so the map is
  explicit + admin-curated (Operator State #36).
- **Alert Log captures every outcome of every run** -- `sent`,
  `would-send`, `above-threshold`, `no-data`, `no-recipients`,
  `skipped`, `error`. Preview rows (from the modal's **Preview**
  button) are marked by a `preview:` prefix on the Triggered By
  column and use the `would-send` status (real fires use `sent`).
  Filter on `triggeredBy NOT LIKE 'preview:%'` to scope to real
  runs. The `Sent` boolean is `TRUE` only for `sent` outcomes.
- **Header freshness pill goes orange past 36h.** The "Data through
  Mon May 19 · 14h ago" badge in `.header-meta` computes hours
  since end-of-day on the most recent date returned by
  `getLatestDataDates` (plural) -- which scans both DQE Historical
  Data and QCD Historical Data and returns the MAX, so the pill
  stays fresh during periods where one source updates without
  the other (e.g. integrated import refreshes QCD before the
  cdr-report safety-net trigger refreshes DQE, or vice versa).
  Past 36h adds the `.is-stale` class and tints warm orange.
  Tunable in `setFreshnessPill_` if 36h becomes too noisy. Pill
  is hidden until the server returns the latest date so the
  header doesn't show a stale fallback. **Role-tiered prominence
  (owner note):** non-admins get `.freshness-pill--subtle` (quiet
  inline text, no box) -- the loud boxed chip is admin-only; the
  `.is-stale` warn tint still wins for BOTH roles, since stale
  data changes how anyone reads the numbers. The single-source
  `getLatestDataDate` is kept for the My Department From/To
  default (which must snap to DQE specifically -- the agent
  table draws from DQE). **Both read ONE date-column scan, not
  two (F9).** `getLatestDataDate` (MAX) and `getLatestDataDates`'
  `dqeEarliest` (MIN, R12-26) each ran their own whole-column
  `getValues()` on `DQE Historical Data`, so a COLD cache read a
  multi-year column TWICE per 5-min expiry.
  `Data.gs::sheetScanDqeDateBounds_()` yields `{min, max, rows}`
  from one read, memoized per EXECUTION in `DQE_DATE_BOUNDS_MEMO_`
  (the `DEPT_CONFIG_ROWS_MEMO_` discipline) -- deliberately NOT
  cached across requests, so each caller keeps its own R8-C2
  negative-cache semantics. **Test-side trap:** a suite that swaps
  the DQE fixture must reset `DQE_DATE_BOUNDS_MEMO_` in its
  `install()` or it serves the previous test's bounds (dal-cutover
  + missed-report already do).
- **Count badges must be idempotent, not append-only (F10).** The
  escalations nav badge was rendered behind an
  `if (!tab.querySelector('.nav-count-badge'))` guard and fetched
  ONCE at init, so it could neither update nor disappear: a manager
  who resolved their last escalation kept a stale non-zero badge for
  the whole session and the Overview strip never hid.
  `escApplyBadge_(counts)` (script.html) updates the span IN PLACE,
  REMOVES it at zero, and hides + empties the Overview strip;
  `escLoad_` calls `loadEscBadge_()` on every list load, and since
  every mutation reloads the list the badge follows every change.
  **It fetches `getEscalationsBadge()` fresh rather than deriving
  from the list's `meta.statusCounts`** -- the list can be filtered
  to one dept (admin pick / view-as) while the badge is viewer-FULL
  scope, so deriving it would undercount. Any new count badge should
  follow this shape; `drive-smoke.js` pins that the badge never
  duplicates across reloads.
- **QCD Historical Data col D holds raw queue names, NOT dept
  names.** Real values are queue identifiers like
  `A_Q_CustomerSuccess` (CSR's queue in this install) /
  `A_Q_Sales` / `Backup CSR` / etc. -- the canonical spellings
  vary per install, so always check col D in recent rows to see
  what the import pipeline actually wrote.
  The legacy `dqe-report/DQEdashboard.js::buildTable4`
  filters with `r.callQueue === ctx.deptName` and looks like a
  reference -- it's misleading; live values don't match dashboard
  dept headers. To filter QCD rows for a dashboard dept, read the
  effective queue list via `getDeptQcdQueues_(dept)` (DeptConfig.gs)
  -- NOT the raw `Config.gs::DEPT_QCD_QUEUES[dept]` constant, which
  is now only the seed default beneath the admin-authored `Dept
  Config` sheet (INV-54). A dept with no effective queues renders the
  "No queues mapped" hint in Insights Queue health and no Overview QCD
  chips. New depts producing QCD data require either a `Dept Config`
  row (no redeploy, via the admin Dept Config modal) or a
  `DEPT_QCD_QUEUES` constant entry before the dashboard surfaces them.
- **`uniqueParentCalls` (DQE col E) is window-scoped.** Computed from
  `windowLegs` (same 6:30 AM – 3:00 PM PST work window as
  Rung/Missed/Answered). Changed from all-day scope to maintain
  consistency across all agent-level counts.
- **Shared utility functions live in `Util.gs`.** `assertAdmin_`,
  `formatSecondsHms_`, `generateMonthList_`, `round1_`,
  `escapeHtmlServer_`, `buildTeamInsights_`,
  `computeActiveAgentsInRange_`, `assertDeptAccess_` (the shared
  none/manager/admin per-dept report authorization gate, used by the
  8 report endpoints), `computeTrendStartDate_` (the INV-29 shared
  trend-window helper), `logReportUsage_` (the INV-01 telemetry
  carve-out), and -- since S5 -- the holiday layer
  (`parseSkipDateRanges_` / `isDateInSkipRanges_` moved here from
  Alerts.gs, plus `getCompanyHolidayRanges_` / `isCompanyHoliday_` /
  `prevBusinessDayIso_` reading the `COMPANY_HOLIDAYS` Script
  Property) were consolidated from their
  original host files (Alerts.gs, IndividualReport.gs,
  PerformanceReport.gs). `classifyAbandonedCell_` (the read-side guard
  that excludes coerced/lost abandoned AD/AF cells from the Missed Calls
  report's counts -- see the number-coercion gotcha above) also lives
  here. `readSourceCacheTag_` (the combined DQE+QCD read-source cache-key
  suffix -- `getDqeReadSource_()` + `getQcdReadSource_()` joined as
  `<dqe>-<qcd>`; consumed by the QCD-embedding caches per INV-30's CORE-3
  note) lives here too. Put new shared helpers here; the implicit
  cross-file dependencies via Apps Script's global scope are now
  explicit in one file.
- **CDN scripts carry SRI integrity hashes.** `dashboard.html`
  loads Chart.js, chartjs-plugin-datalabels, and html2canvas-pro
  (the maintained fork -- plain html2canvas 1.4.1 can't parse the
  oklch() tokens the Phase A redesign serves, which silently broke
  every copy/email/print export; the fork keeps the `html2canvas`
  global) with
  `integrity="sha384-..."` + `crossorigin="anonymous"`. When
  upgrading a library version, recompute the hash:
  `curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A`.
  A mismatched hash blocks the script from loading entirely.
  **EXCEPTION (intentional):** the `chartjs-plugin-datalabels` tag
  currently has **NO** `integrity` -- its prior bare-package-URL +
  hash combo was failing the SRI check, so the browser silently
  blocked the plugin and data labels didn't work on ANY chart. It's
  now pinned to the explicit `/dist/chartjs-plugin-datalabels.min.js`
  with SRI omitted (Option A). To restore SRI, recompute the hash for
  that exact file and add `integrity` + `crossorigin` back.
- **`TARGET_SS_ID` in CDR Import is read from Script Properties**,
  not hardcoded. `getTargetSsId_()` reads it on every call and
  falls back to a hardcoded ID if unset. Set `TARGET_SS_ID` in
  the CDR Import project's Script Properties to point at the CDR
  Report spreadsheet.
- **Neon writes are guarded by `getReachableNeonConn_()`** which opens
  one write connection and probes it with `SELECT 1` (5-second timeout),
  returning that SAME connection for the insert (or null). If Neon is
  down (free-tier suspend, exhausted compute) or unconfigured, the write
  is skipped with a clean log — no failure email, no exception. (Replaced
  the old `isNeonReachable_()`, which opened a throwaway probe connection
  AND a second write connection per writer — six handshakes per import
  run; see "Neon write discipline" below.) `NEON_HOST`, `NEON_DB`,
  `NEON_USER`, `NEON_PASS` must be set in BOTH the CDR Report AND CDR
  Import project's Script Properties for Neon mirroring to work.
- **Neon write discipline (don't regress this — it caused a daily-import
  timeout).** The Neon mirror is the dominant cost of the daily import,
  and three rules in `neonWrite.js` (duplicated, INV-16) keep it from
  blowing the Apps Script execution ceiling AND from corrupting the
  mirror on a timeout. (1) **Hash phone numbers through the per-run memo
  `CDR_HMAC_CACHE_`, never raw per-occurrence** — `Utilities.computeHmacSha256Signature`
  is slow and the same outbound numbers recur thousands of times per day;
  the cache is reset at the top of `writeCDRRowsToNeon`. (2) **Batch
  inserts and commit ONCE** — `call_history_phones` writes in 10000-row
  chunks (5 params/row, under Postgres's 65535 bind-param cap) with a
  single `conn.commit()` after the loop. A per-row or per-small-chunk
  commit means dozens of round-trips AND leaves partially-committed rows
  in Neon if the run times out mid-loop. The DQE/QCD writers already do
  one multi-row insert + one commit. (3) **One probed connection per
  writer** via `getReachableNeonConn_()` (above), not a separate probe +
  write connection. (4) **Authoritative per-date replace (IMP-5)** -- the
  mirrors were upsert-only, so a force re-import whose rebuilt set is a
  SUBSET (agent consolidated under an alias, a corrected row removed) left
  PHANTOM rows in Neon forever; with `DQE_READ_SOURCE=neon` that shows a
  split agent + double-counted totals. Callers whose payload is provably
  the COMPLETE set for its date(s) pass `{ authoritative: true }` to
  `writeDQERowsToNeon`/`writeQCDRowsToNeon` (DELETEs those dates inside
  the same transaction before inserting): the daily DQE build + dup-guard
  re-mirror (both INV-16 copies), the daily QCD mirror, the deferred
  per-date mirrors (NeonMirror.js); the daily Direct writer deletes its
  date likewise; **`writeCDRRowsToNeon({authoritative:true})` (P-6)** --
  the daily inline CDR mirror + the deferred `mirrorCdrForDate_` each pass
  the COMPLETE per-date CDR set, and the writer deletes the dates'
  `call_history_phones` CHILDREN first (via the parent-id subselect --
  deleted parents would otherwise strand their children, or an FK would
  refuse the delete), then the `call_history_dept` parents, in the same
  txn as the insert (the bulk post-`dedupeAlreadyArchived_` CDR mirror is
  a partial set and stays NON-authoritative, like its QCD sibling; pinned
  by neon-write-mapping.test.js); and **`writeInboundCallsToNeon({authoritative:true,
  expectedDateIso})` (L2 + P-1)** -- the daily import + the per-date
  backfill/deferred path each pass
  the COMPLETE inbound set for their date(s), so a shrinking re-import that
  DROPS a call_id no longer leaves a phantom in the dashboard-read
  `inbound_calls` (which has NO sheet primary). **P-1 (the F2 class):**
  records are dated from their OWN first leg, so a stray carry-over leg from
  D-1 in day-D's source used to put D-1 into the payload's date set -- and
  the authoritative DELETE then wiped ALL of D-1's rows (permanent after the
  ~14-day Call_Legs retention), replacing them with the lone fragment. Every
  caller now passes `expectedDateIso` (the importer's / sheet's own date):
  stray-dated records are DROPPED with a log line (their home date's own
  import already wrote the complete set) and the in-txn DELETE can only ever
  touch the expected date. **F2 closed the zero-record corner** (the P-5 rule,
  applied to the two tables with no sheet primary): a date whose LEGITIMATE
  record count is zero used to keep its phantoms forever, because the writer
  returned before the authoritative DELETE. The stated reason -- "an empty
  payload carries no date to delete" -- was already stale, since P-1 made every
  caller pass `expectedDateIso`. Both writers now run a delete-only pass via
  `icDeleteDateOnly_` when the record set is empty, GATED on the source grid
  being NON-EMPTY: an empty/unreadable `Call_Legs` grid keeps the old
  early-return, because that is the one case where deleting would destroy good
  data (the P-3 discipline -- validate the source before you delete). It
  reports `unreachable` when Neon is down so a deferred-mirror date stays
  queued instead of being dequeued with its phantoms intact (both backfill
  loops honor that flag). Pinned by inbound-calls.test.js /
  outbound-calls.test.js. **PHI healing note (P-2):** `ib_list_*` JSONB rows written
  before the P-2 masking fix (external-only NOP cells parsed as internal,
  storing raw CNAM names/numbers) heal on a force re-import of their date;
  for dates past the Call_Legs retention, `backfillCDRHistory` re-hashes
  phone-shaped entries but raw NAME strings in old external-only cells heal
  only via re-import or a one-off SQL cleanup. Partial-set callers -- the bulk archive after
  `dedupeAlreadyArchived_`, the row-batched backfills
  (`backfillDQEHistory*`, `backfillDirectCallToNeon`) -- must NOT pass it.
  Duplicate conflict-key rows are deduped last-write-wins first (IMP-6). The `call_history_phones` children are per-parent DELETE-then-insert (IMP-4: each payload row carries its parent's COMPLETE entry set, so per-parent replace is safe on every caller incl. partial-date bulk batches; the old `DO NOTHING` never propagated corrected durations/occurrences and kept removed entries as phantoms -- it survives only as an intra-payload dup guard; `neonbackfill.js::backfillCDRHistory`'s child path deliberately stays fill-only per its docstring). History: these were original gaps (never present),
  not a regression — the phone-child write shipped in commit 771f227 with
  a 200-row per-chunk commit, double connection, and un-memoized HMAC, and
  a ~4k-phone day took ~17 minutes. A future "move the mirror off the
  synchronous import path" (its own trigger) is the next lever if the
  budget is still tight after these.
- **Force-path data-loss guard convention (M2 generalized).** A FORCE
  re-import DELETES a date's rows for EVERY historical sheet (CDR / QPath /
  QCD / CSR / DQE) before rebuilding (`processNewImport`'s `if (force)`
  block). If a rebuild then produces ZERO rows for a sheet, that date's data
  for it is GONE silently -- the `if (count > 0)` write blocks have no else.
  **The rule: a force-path writer that produces fewer rows than it deleted
  must SURFACE it, never silently return.** Two implementations: (a) the
  authoritative DQE source THROWS -- `buildDQEHistoricalData`'s
  `refuseIfForce_` (M2), gated on `opts.force`, routing into the daily
  caller's `:DQE` failure row + `notifyDqeBuildFailure_` email; (b) the other
  dashboard-read force-path writer, QCD, uses the lighter shared
  `guardForceRebuildLoss_(targetSS, step, dateObj, force, wroteCount)`
  (autoImport.js): on `force && wroteCount===0` it logs a `<step>` FAILURE
  Pipeline Health row (no throw, so the already-written sheets stand), which
  the System Health **"Recent pipeline step failures"** row + the Alerts
  Pipeline Health panel both surface. CDR / QPath / CSR are NOT
  dashboard-read (INV-52 -- legacy DQE Report only), so they're intentionally
  not guarded. A NON-force empty rebuild is a legitimate no-op (F5) and is
  never flagged. New force-path writers that delete-then-rebuild must call one
  of these. **P-3 (ordering):** `processNewImport` reads + validates the SOURCE
  sheet ("Source sheet empty." throw) BEFORE the force-delete block -- a force
  re-run against an existing-but-empty/corrupt `Call_Legs` sheet used to
  destroy the date across all five historical sheets and THEN throw; it is now
  a clean no-op. New force-path writers must keep source validation ahead of
  any delete. Pinned by `csr-transfer.test.js` (the helper) + `pipeline-build.test.js` (M2).
- **System Health "Recent pipeline step failures" is the single trustworthy
  pipeline signal.** `SystemHealth.gs::getSystemHealth` scans the last 80
  Pipeline Health rows and flags a step ONLY when its MOST RECENT outcome is
  `failure` (a step that failed then RECOVERED -- latest row `success` -- is
  NOT flagged, so it never cries wolf about a fixed blip, the OPS-8/M1 lesson).
  Catches every step in one place: the CDR/QCD/DQE/Inbound sheet writes, the
  `:CDR:neon`/`:QCD:neon` inline-mirror failures (L7), `buildDQE:neon` (F4) /
  `:Inbound` (F9), the deferred `neonMirror:*` drains, and the
  `guardForceRebuildLoss_` QCD signal above. Pinned by `system-health.test.js`.
  This page is the PULL view; the optional **Pipeline-failure watchdog**
  (`PipelineWatch.gs`, Operator State #32) PUSHES the same new failure rows to
  admins by email. Two Batch-10 additions on the same page: (a) a **"Report
  usage (last 30 days)"** section (`computeReportUsageSummary_` -- per-report
  runs / unique users / MANAGER runs / cache-hit rate / last-used from the
  Report Usage telemetry sheet, bounded tail read `REPORT_USAGE_SCAN_CAP_`
  =5000 with an explicit "window clipped" note; all rows muted -- it's the
  consolidation/un-gating EVIDENCE, not a health state), and (b) a **"Live
  smoke — last run"** outcome row fed by `SmokeCheck.gs::runLiveSmoke` -- an
  editor-run, admin-gated, READ-ONLY sweep of the live read paths (sheet
  open, latest DQE date, dept summary, missed, agent-free Insights, all-dept
  QCD, Neon `SELECT 1`), each check independently try/caught + timed, result
  emailed to `getAdminEmails_()` and stored OPS-8 prefix-coded in
  `SMOKE_LAST`/`SMOKE_LAST_RESULT`. It complements the unit harness (live
  wiring: properties, scopes, sheets, Neon) -- client-side surfaces (deep
  links, tour, modals) still need the manual Regression Scenarios. Run it
  after every deploy. And (c) **Neon coverage — `runNeonCoverageCheck`**
  (NeonCoverage.gs, R7/G-2; editor-run, admin-gated, READ-ONLY): per-date
  sheet-vs-Neon row-count reconciliation over `NEON_COVERAGE_DAYS` (=30,
  ending yesterday) for dqe/qcd/cdr/direct history (findings classified
  missing-in-neon / count-mismatch / extra-in-neon, each emailed with its
  runbook fix) plus zero-row-WEEKDAY gaps on BOTH no-sheet-primary
  per-call tables, `inbound_calls` AND `outbound_calls` (holiday-aware,
  each floored at its own capture-start MIN(call_date); a not-yet-created
  outbound_calls -- capture not deployed -- is a clean skip via
  `ncMissingTableError_`, not a probe error); outcome OPS-8-coded in
  `NEON_COVERAGE_LAST(_RESULT)` and surfaced as the "Neon coverage — last
  check" row (Op State #35; the outcome classifier also flags a `GAPS`
  prefix). All pinned by `system-health.test.js` / `smoke-check.test.js` /
  `neon-coverage.test.js`. **Install readiness (Batch 3.4): a trigger being
  installed does NOT mean its engine runs.** Four engines gate their handler
  BODY on an `*_ENABLED` Script Property (`NEON_KEEPWARM`, `INGEST_WATCHDOG`,
  `PIPELINE_WATCH`, `QUEUE_REPORT`), so a trigger installed with the flag off
  fires on schedule and returns immediately -- and the page used to report it
  as simply "installed". `svc()` takes an optional `flagProp` and now flags
  BOTH mismatch directions ("installed but DISABLED -- every run is a no-op" /
  "NO trigger installed but flag=true -- it never runs"), plus a single
  `trg-readiness` verdict row ("N armed, K need attention"). A new
  flag-gated engine must pass its `flagProp` to `svc()` or it inherits the
  old blind spot.
- **Neon read-back (F1) is flag-gated and defaults OFF.** The dashboard
  still reads DQE from the `DQE Historical Data` sheet by default; the
  read-back lives in `NeonRead.gs` behind the `DQE_READ_SOURCE` Script
  Property (`getDqeReadSource_()` returns `'neon'` only when explicitly
  set, else `'sheet'`). With it unset, behavior is byte-identical to
  pre-read-back. Pieces: `neonFetchDqeRows_` / `sheetFetchDqeRows_`
  (symmetric DAL primitives returning the same normalized per-(date,agent)
  shape -- durations parsed to seconds, so the Neon path sidesteps the
  INV-02 TZ gotcha). **`neonFetchDqeRows_` aggregates the whole result set
  into a SINGLE json string server-side (`json_agg`) and fetches it with
  one `rs.getString` (commit 0403b2c) -- do NOT regress to per-row
  `rs.getXXX` iteration: Apps Script JDBC is ~0.5s/row, so the IR/PR
  12-month trend window (and CR's year-over-year window) took 20+ minutes
  the old way.** `neonGetMaxDqeDate_` (`SELECT MAX(call_date)`); and
  `compareDqeSources_` -- the **parity GATE** (editor-run; reports
  missing-in-Neon / value mismatches over a date range). **Cut over a
  reader only after `compareDqeSources_` is parity-clean over a
  representative range** (and `dqe_history` is fully backfilled). Cutover
  so far: **#1 `getLatestDataDate`** (`MAX(call_date)`), **#2
  `getCompanyOverview`**, **#3 `computeSummary_`** (My Department table),
  and **#4 the IR / Insights builders** (the retired PR / CR builders were the others). Each reads the windowed rows from
  Neon when flagged and STILL reads a cheap cols-A..D slice for
  `getDeptQueueExts_`'s all-history derivation. Each cutover is
  `getDqeReadSource_()`-gated and falls back to the sheet on any
  error/unreachable read, so flipping the flag is reversible with no redeploy.
  **LM2 refined "null/empty":** `neonFetchDqeRows_` now marks a REACHABLE
  result (`out._neonReachable`), and consumers gate on the shared
  `neonDqeRowsUsable_(rows)` -- a reachable-but-EMPTY read is TRUSTED (serve
  empty, skip the redundant whole-sheet scan) while only an unreachable/errored
  `[]` (no marker) falls back. Aligns with the cutover contract (trust a
  reachable Neon; the sheet is the ERROR fallback, not a second guess of an
  empty window). Applies to all 6 cutover readers; pinned by `dal-cutover.test.js`.
  every cutover reader emits a `[dqe-read] <label> source=<neon|sheet>
  rows=<n> ms=<elapsed>` line (`logDqeReadTiming_`, NeonRead.gs) so
  sheet-vs-neon read cost is directly comparable in the Executions panel.
  Reuses the dashboard `NEON_*` props + `script.external_request`
  scope (Operator State #18-19). ALL DQE readers are now cut over: the final
  two -- **Missed Calls** (via `neonFetchDqeRows_(from, to,
  { includeMissedDetail: true })`, which adds the 19 slot_* columns +
  abandoned_parent_ids/_missed_times; a grid adapter
  (`missedGridsFromDal_`) feeds the UNCHANGED compute loop) and
  **`computeActiveAgentsInRange_`** (the IR/Insights agent-picker
  subset in Util.gs) -- landed in the DAL-cutover phase. Both fall back
  to the legacy sheet scan on any Neon error/empty result, and their
  sheet-vs-neon payload parity is pinned byte-identical by
  `tests/unit/dal-cutover.test.js` (fake JDBC conn serving the same
  fixture rows, date-param filtering honored). NOTE: the editor-run
  `compareDqeSources_` gate now ALSO compares the slot/abandoned detail
  columns (via the `includeMissedDetail` opt on `sheetFetchDqeRows_` /
  `neonFetchDqeRows_`), so a parity-CLEAN result certifies the Missed Calls
  reader's inputs too; its range reads the `DQE_PARITY_FROM` / `DQE_PARITY_TO`
  Script Properties (falling back to in-source defaults) so it can run
  unattended. The `getDeptQueueExts_` DERIVED all-history scan
  is now ALSO off the sheet on the Neon path -- `deptQueueExtsForNeonReader_`
  (Data.gs) builds the dept ext set from `neonGetAgentExtPairs_` (a cached
  `SELECT DISTINCT agent_name, queue_extensions` json_agg fetch) instead of
  a whole-sheet cols-A..D scan, falling back to the sheet read if Neon pairs
  are unavailable. The two `call_date` indexes below are
  now created in prod. NOTE: `latestDate:`/`latestDates:` stay on the 5-min
  `CACHE_TTL_SECONDS`; the heavy report aggregations cache 30 min
  (`REPORT_CACHE_TTL_SECONDS`) -- both levers reduce how often a cutover
  reader hits a cold free-tier Neon (see the Neon keep-warm bullet).
  **Index prerequisite (F1):** before cutting over the date/agent-filtered
  readers, make sure `dqe_history` is indexed for those queries --
  `CREATE INDEX IF NOT EXISTS idx_dqe_history_call_date ON dqe_history (call_date);`
  and `CREATE INDEX IF NOT EXISTS idx_dqe_history_date_agent ON dqe_history (call_date, agent_name);`.
  Postgres has no stored row order (unlike the sheet), so there's nothing to
  "re-sort" routinely -- you `ORDER BY call_date` at query time and the index
  keeps it fast; the index is maintained automatically on insert/update.
- **Neon keep-warm is an optional, admin-toggled trigger (`NeonKeepWarm.gs`).**
  Neon's free tier scale-to-zero suspends the compute after ~5 min idle, so
  the FIRST DQE read of a lull (when `DQE_READ_SOURCE=neon`) pays a
  cold-start penalty. `keepNeonWarm_` pings Neon (`SELECT 1`) every
  `NEON_KEEPWARM_EVERY_MINUTES` (=5) but ONLY inside a weekday business-hours
  window (`NEON_KEEPWARM_START_HOUR`=7 .. `NEON_KEEPWARM_END_HOUR`=13 Central,
  Script-Property-tunable), no-opping cheaply (property + clock check, NO Neon
  connection) outside the window / on weekends / when
  `NEON_KEEPWARM_ENABLED!='true'`. Default window ≈ 6h × ~22 weekdays ≈
  ~132 compute-hrs/mo, under the ~190h free allowance (the Alerts modal
  surfaces the estimate + last-ping outcome). Enable/disable from the Alerts
  modal's **Neon keep-warm** section (`installNeonKeepWarmTrigger` /
  `uninstallNeonKeepWarmTrigger`, both `assertAdmin_`-gated); reversible
  (disable removes the trigger + clears the flag). Reuses the dashboard
  `NEON_*` props + `script.external_request` + `script.scriptapp` scopes;
  independent of `DQE_READ_SOURCE` (it only MATTERS once reads are on neon).
  To run the editor-only parity gate, use the non-underscore wrapper
  `runDqeParityCheck` -- the Apps Script Run picker hides `_`-suffixed
  functions like `compareDqeSources_`.
- **Daily import toast carries a Neon-mirror status segment.**
  `processIntegratedHistory` tracks `counts.neon` ('ok' | 'unreachable' |
  'error', derived from the CDR + QCD writer results -- reachability is
  per-run binary against one instance) and the success toast appends
  `| Neon ✓` / `| Neon ⚠ unreachable` / `| Neon ⚠ error` after the
  CDR/QPath/QCD/CSR/DQE counts. DQE-specific Neon failures still surface
  separately, so they're intentionally NOT folded into this single flag: a
  DQE *build* failure emails `notifyDqeBuildFailure_` + logs a `:DQE failure`
  row, while a DQE->Neon *mirror* skip/error (sheet build OK) logs a
  `buildDQE:neon` `failure` row (F4) and shows on the Alerts modal's Neon
  mirror-health line (`computeNeonMirrorHealth_`). When the deferred mirror
  is enabled (`NEON_MIRROR_MODE=deferred`, see next bullet) the inline
  writers don't run, so `counts.neon` is `'queued'` and the toast shows
  `| Neon ⏳ queued` -- the real mirror outcome lands later as `neonMirror:*`
  Pipeline Health rows from `runNeonMirror_`.
- **Deferred Neon mirror is flag-gated and defaults OFF (`NeonMirror.js`,
  cdr-import).** By default (`NEON_MIRROR_MODE` unset or `inline`) the daily
  import mirrors CDR/QCD/DQE/Inbound to Neon inline inside
  `processIntegratedHistory`, byte-identical to before. Set the cdr-import
  Script Property `NEON_MIRROR_MODE=deferred` to move the mirror OFF the
  synchronous import path: the import writes only the sheets and appends the
  processed date to a `Neon Mirror Queue` tab in the CDR Report spreadsheet
  (the cross-project shared channel -- cdr-import / cdr-report have separate
  Script Properties but share the workbook), and the `runNeonMirror_`
  time-driven trigger (install via the cdr-import **CDR Tools** menu ->
  "Install Neon Mirror Trigger", every 15 min) drains the queue, re-deriving
  each payload from the Historical Data sheets (durations via
  `getDisplayValues`, INV-02-safe; since F-20 the per-date reads are a
  BOUNDED TAIL-SCAN -- `nmReadDateRowsTail_` reads the bottom
  `NEON_MIRROR_TAIL_ROWS` (=3000, Script-Property-tunable) rows and widens
  x4 up to the full sheet when the date is absent from the window or its
  block is clipped at the window top, so a drained date costs O(recent)
  instead of O(full history) while staying row-identical to a full scan
  (pinned by tests/unit/neon-mirror-tail.test.js); field mappings faithful to
  neonbackfill.js + the inline shapes -- incl. routing the coercion-prone
  abandoned ID/time columns AD/AE/AF through a byte-identical copy of
  `sanitizeAbandonedCellForNeon_` in NeonMirror.js so the deferred mirror
  writes the `#REBUILD` sentinel / recovered value rather than coerced
  garbage, exactly like the backfill, F3 -- keep that helper in sync with
  the cdr-report/neonbackfill.js copy -- enforced by
  `scripts/check-duplicated-files.sh`'s function-level check since F-24) and upserting via the SAME local
  writers (`writeCDRRowsToNeon` / `writeQCDRowsToNeon` / `writeDQERowsToNeon`
  / `backfillInboundCalls`). All writers are idempotent (`ON CONFLICT`), so a
  Neon-unreachable or partially-failed date is LEFT in the queue and retried
  next run (reachability is per-instance binary, so the CDR/QCD/DQE
  unreachable detection keeps the whole date queued). `backfillInboundCalls`
  now returns a status object (`{inserted, unreachable, failures}`) that
  `mirrorInboundForDate_` honors: an inbound Neon outage keeps the date
  queued, and a hard inbound write error throws (logged as a
  `neonMirror:Inbound` failure, date stays queued) -- so the deferred mirror
  no longer silently dequeues a date whose `inbound_calls` rows never landed
  (`inbound_calls` has no sheet primary, so that loss was unrecoverable). Only affects the daily/manual
  path (`!isHistoricalBackfill`); the bulk backfill already defers DQE via
  `skipNeon` + `backfillDQEHistoryUpsert`. In deferred mode the cdr-report
  `runDailyDQEBuild_` safety-net trigger (if still installed) re-mirrors DQE
  inline -- harmless (idempotent), but uninstall it once the integrated path
  is trusted. Reversible with no redeploy: set `NEON_MIRROR_MODE=inline`
  (or clear it). PHASE 1 -- shipped flag-gated/default-off; validate
  `deferred` against live Neon on one import before flipping it on.
- **Bulk DQE rebuild skips the per-date Neon mirror (`skipNeon`).**
  `buildDQEHistoricalData(rawSheet, dqeSheet, opts)` takes an optional
  `opts.skipNeon`; the cdr-import BULK path (`bulkHistoricalUpdate`) passes
  `true` so the per-date DQE->Neon mirror (the slow part) is deferred. The
  daily integrated path and the cdr-report standalone trigger omit `opts`
  for `skipNeon` (real-time mirror unchanged), but the cdr-import daily
  AND bulk callers BOTH pass `opts.expectedDate` (the importer's date) so
  the build refuses to write when its Raw-Data-derived date disagrees --
  see INV-16 / F2. **After a bulk rebuild, run
  `backfillDQEHistoryUpsert()` (cdr-report) once** to mirror those dates to
  `dqe_history` with `ON CONFLICT DO UPDATE` (so re-calculated values
  OVERWRITE stale rows -- `backfillDQEHistory`'s `DO NOTHING` would skip
  them). Resumable via `DQE_UPSERT_RESUME`; opens one connection per
  invocation. The bulk-complete alert reminds the operator.

## Key Design Decisions

- **Web app deploys as "Execute as: Me"** with **"Access: Anyone within
  domain"**. The script runs with the deployer's spreadsheet permissions,
  so managers never get direct access to CDR Report. Read-only safety
  relies on the trailing-underscore convention plus auth re-resolution
  inside every public function (`getLatestDataDate`/`getLatestDataDates` carry a signed-in gate since CORE-1/DEEP-1 -- the F-28 commit message had claimed that gate without implementing it).
- **`SPREADSHEET_ID` lives in Script Properties**, not in code. Lets dev
  and prod copies of the dashboard run from the same source without
  edits.
- **Per-project gitignored `.clasp.json`**. Each developer keeps their own
  `scriptId` locally; pulls never conflict on it. Template at
  `.clasp.example.json`.
- **CacheService tiers**: 30 min (`REPORT_CACHE_TTL_SECONDS`) on the heavy
  per-(dept,range) aggregations (My Department `summary`, `companyOverview`,
  `individual`, `individual_active`, `performance`, `compareRanges`,
  `insights`, `missed`); **6 h (`QCD_ALLDEPT_CACHE_TTL_SECONDS`,
  CacheService's max) on the all-departments Daily Queue Report
  (`qcdAll:`)** -- QCD lands once daily, so a warmed yesterday-blob can
  serve all day; trade-off: a rare mid-day force re-import's corrections
  can lag there up to 6h (paired with the CacheWarm qcdAll warm, which is
  freshness-guarded); 5 min (`CACHE_TTL_SECONDS`) on the freshness-sensitive
  `latestDate` / `latestDates` lookups so the morning ingest surfaces
  promptly; 60 sec on auth lookups (`AUTH_CACHE_TTL_SECONDS`). The 30-min
  tier is safe because DQE data updates once daily; the tradeoff is that
  ad-hoc admin corrections (orphan renames, DQE rebuilds) can lag up to
  30 min in cached views not explicitly busted on write (Orphan Fix +
  Dept Config save bust theirs). Each report file owns its own versioned
  cache prefix (`summary:`, `latestDate:`, `individual:`,
  `individual_active:`, `performance:`, `compareRanges:`, `missed:`,
  `companyOverview:`); bump the relevant version on any aggregation-rule
  change. See INV-30 for current versions. **Admin-modal init blobs are
  cached too (Batch 1):** the Outlier Fix + Dept Config init payloads
  (`orphanFix:init:v1` in OrphanFix.gs, `deptConfig:init:v1` in DeptConfig.gs)
  each scan sheets / Neon on every open, so they cache under
  `REPORT_CACHE_TTL_SECONDS` and are busted on EVERY write via
  `bustOrphanFixCache_()` / `dcBustCaches_()` -- admin-only surfaces, so the
  shared script cache is safe (no per-viewer personalization).
- **Sub-queue scope switcher on My Department (Phase 1).** A parent dept
  (Sales / CSR / Power) renders a three-way segmented control -- `<dept> only`
  / `<subs> only` / `<dept> + <subs>` -- persisted per dept in
  `cdr.dept.subscope` and **defaulting to COMBINED** (owner decision). Depts
  with no sub-queues get no control and no behavior change. `subScope` is a
  cache-key dimension (`summary:v16`). **Combined means grouped, never merged:**
  rows carry `dept`, each dept gets a `subq-group-head` subheader and its OWN
  subtotal row from `deptGroups`, and the grand total is labelled -- so the
  familiar own-dept figure stays on screen and every number reconciles against
  that dept's own view. Team averages / benchmark tints stay PER-DEPT (one
  average across two teams with different call profiles is a worse number).
  The relationship line renders in EVERY scope, including `own`, where it says
  the sub-queue is excluded -- that exclusion was previously invisible. A CHILD
  dept gets an upward pointer only, no switcher (the combined view belongs to
  the parent, matching the server's one-level rule).
  **Phase 2 (IR + Insights pickers):** both pickers gain one collapsed group per
  sub-queue, from `getIndividualReportInit`'s new `subQueueGroups` field
  (Insights delegates to the same init, so it inherits it). Built by
  `computeSubQueuePickerGroups_` (Util.gs), which calls
  `computeActiveAgentsInRange_` once per child with THAT child's roster -- a
  deliberately SEPARATE helper so the pinned `{agents, floaters}` shape and its
  INV-53 gate stay untouched and no `individual_active` bump is needed. The
  group is NOT muted like the inactive/floater groups: a sub-queue is a
  first-class choice, not something you rarely want. **One report run is ONE
  department** -- `subqPickerScope_` reads the checked boxes and either runs
  against the sub-queue dept (selection confined to one group) or REFUSES a
  selection that spans depts with a reason, because the team average / rollup is
  per-dept (INV-25/27) and averaging two teams with different call profiles is
  the wrong number. Insights' report body is NOT scope-switched -- see the
  follow-on note in `.cycle/blocks/61-*`.
  **CSV (Phase 1 follow-up):** `exportTableCsv_` adds a leading **Department**
  column ONLY when more than one dept is shown (a single-dept export stays
  byte-identical), emits each dept's rows followed by that dept's OWN subtotal
  from `deptGroups`, then a grand total labelled `All shown`. **No group-header
  pseudo-rows** -- a spreadsheet reader wants a column it can pivot and filter
  on, not banners that break sorting. The filename gains a `_subs` / `_all`
  scope tag so two scopes don't overwrite each other. Every cell still routes
  through `csvSafeCell_` (formula injection).
  **Phase 3 (Missed + Escalations):** the missed section follows the switcher
  ONLY when the scope resolves to a SINGLE dept (`subs` with one child runs on
  that child, via `subqMissedDept_`). It deliberately does **NOT merge for
  `all`** -- the queue-only abandoned section already covers a parent's
  sub-queue queues (`queuesForDept_` rolls them up), so summing a child's report
  into the parent's would double-count every queue abandon and every
  abandoned-ring bucket in the hour-of-day chart, the same trap as the QCD
  snapshot. `subqMissedScopeNote_` states what is and isn't included instead of
  leaving the reader to infer it. **Escalations needed NO code change** --
  `getEscalations` already scopes by `user.departments`, so Phase 0's widening
  gave a parent manager their sub-queue's escalations automatically, and
  `metaDept` already reports the joined list. Server side is
  `combineSummaries_` calling `computeSummary_` once per dept: it leaves every
  INV-02/04/05/23/53 + S35 + E5 rule inside that function untouched, and its
  duration means are agent-count-WEIGHTED (never a mean of means). **`qcd` is
  the PRIMARY dept's only** -- `queuesForDept_` already rolls sub-queue queues
  into a parent's QCD snapshot, so merging it would double-count.
- **Scope is locked to `roster` (Phase D → redesign cleanup →
  Phase 14/15 roster-only flip).** Pre-Phase-D the dashboard
  shipped a `roster | queue | both` segmented control with
  `roster` default (matching the legacy DQE Report's behavior);
  Phase D flipped the default to `both` and Source-chip-tagged
  queue-only floaters so managers could see who handled their
  queue without polluting totals (INV-53). The toggle was
  retained for parallel-run validation through Phases D / D+1
  / E, then retired in the redesign cleanup. **In production the
  shared-queue-overlap match proved to be mostly false positives**
  (agents who never actually handled the dept's calls), and
  genuine cross-dept assist is rare, so both public RPCs were
  flipped back to roster-only: `Data.gs::getDepartmentSummary`
  (commit 80e17da, the My Department agent table) and
  `MissedCallsReport.gs::getMissedCallsReport` (commit 77441a7,
  the per-agent missed-call timelines) now hardcode
  `scope = 'roster'`. So the My-Dept table + Missed report
  timelines list ONLY the dept's `DO NOT EDIT!` roster agents;
  QUEUE-chipped floaters no longer appear there. **The Missed
  report's queue-only ABANDONED section is scope-independent** --
  queue-sentinel rows bypass roster matching entirely (INV-23), so
  genuinely-abandoned no-ring queue calls still surface; since R6
  a sentinel is included when its queue NAME is in the dept's queue
  set (case-insensitive) -- NOT via shared-extension overlap, which
  leaked other depts' queues onto the card. Since the R8-1 name-space
  fix (missed:v17) that set is the INBOUND union
  (`inboundQueuesForDept_` = `queuesForDept_` + the Dept Config
  "Inbound queue aliases" column): sentinel names are RAW
  phone-system queue names (e.g. `A_Q_CSR`), not QCD-canonical ones
  (`A_Q_CustomerSuccess`), so matching `queuesForDept_` alone
  silently dropped every sentinel whose raw name differs from its
  canonical name -- CSR's main queue. A dept with no mapped queues
  (or no queue-only abandons on its own queues in range) renders no
  card; if a queue that used to appear goes missing, map its RAW
  name in Dept Config's "Inbound queue aliases" field (Operator
  State #14 -- the QCD Queues field only accepts canonical names
  seen in QCD col D). **The internal
  `computeSummary_(dept, from, to, scope)` arg is preserved** --
  `Digest.gs::renderDeptDigestEmail_` also passes `'roster'`, and
  a caller wanting the legacy floater-inclusive view can still
  pass `'both'`. `scope` is in every cache key, so the flip can't
  serve stale rows.
- **DQE Report Legacy is FROZEN and the migration is COMPLETE.** All four
  legacy reports (Individual / Performance / Compare Ranges / Missed
  Calls) plus the Low Answer Rate Alerts engine are in the dashboard.
  Awaiting decommission of the spreadsheet; meanwhile accepts only
  cleanup deletions.
- **Multi-page architecture: Overview + My Department + Escalations +
  Insights.**
  The dashboard is one HTML doc with top-level `<section>` pages toggled
  by `body[data-page="overview|dept|escalations|insights"]` (the `.page`
  CSS shows only the active one; generalized from the original two-page
  pair when Escalations became a full page, #6). **Overview is the default
  landing** for every page load; "My Department" is the per-dept
  agent table view that used to be the landing; **Escalations** is a
  full page (route `#/escalations`) — an interactive worklist, not a
  modal (it was converted from one); **Insights** is a full page too
  (route `#/report/insights`, converted from a modal --
  docs/insights-page-plan.md; first entry via `insEnsurePage_`
  AUTO-GENERATES the report -- restored prefs or the launcher-window
  default with an agent-free whole-dept run, INV-45; the SETUP-FORM STEP
  and its "« Back" button are RETIRED (owner) with the form kept hidden
  as the failure/empty-roster fallback only (`insShowForm`), all editing
  via the results-header "Edit dates & agents" popover; RE-ENTRY keeps
  the rendered report; its top-level
  header tab is visible to ALL roles, replacing the old manager-only
  solo-button proxy). `setPage(name)` swaps the page,
  the header kicker/title, and triggers that page's load (Overview ->
  `ovLoad_`; Escalations -> `escEnsureInit_`+`escLoad_`; Insights ->
  `insEnsurePage_`). Modals (Help, Settings, Individual,
  Alerts, Orphan Fix, Dept Config) overlay any page (the standalone
  Missed Calls modal is RETIRED -- the My Department page's inline
  missed section is the Missed Calls report -- and the Insights modal
  became the Insights page).
  Overview auto-refreshes silently every 5 minutes when the
  page is active, re-fetching from the server cache. **Overview dept-tile
  click SOLOS that dept's line on the 30-day trend chart** (#1) --
  `chartSpotlightTogglePin_(ovChartInstance, dept, additive)`, the same
  pin-set model the chart legend uses; Shift/Cmd/Ctrl-click ADDS a dept
  to the pinned set (compare 2+), a plain click on the lone pinned tile
  releases it. Pinned tiles carry `.ov-tile-soloed` (synced by
  `ovSyncTilePins_`, guarded to `chart === ovChartInstance` so the QCD
  chart that reuses the helpers isn't cross-contaminated). **Navigation to
  My Department is now via a chart POINT click** (`ovHandlePointClick_` ->
  `ovRouteToDept_(dept, iso)`; admins, or a manager on their own dept's
  line) **or the dept-selector dropdown** -- the tile no longer navigates.
  **`refresh()` only writes the header title when `data-page === 'dept'`**
  so it can't clobber the Overview / Escalations / Insights titles.
- **Sub-queue nesting (NO LONGER Overview-only — see INV-38).**
  `OVERVIEW_PARENT_OF` + the Dept Config `Overview Parent` override shape the
  Overview tile grid AND, since sub-queue Phase 0, manager ACCESS:
  `resolveUser_` expands a manager's assigned depts with their **one-level**
  sub-queues, so a `Sales` manager reaches `PAP` without an Access Control row.
  `user.departments` is the EFFECTIVE list (assigned ∪ children) that every gate
  reads — `assertDeptAccess_`, `escAssertRowAccess_`, `getEscalations` scoping,
  `personalizeOverview_`, and the client selector via `canPickDept_`;
  `user.assignedDepartments` keeps the raw assignment and `user.department` (the
  landing dept) is still the assigned one. **The read side re-validates
  independently of `saveDeptConfig`** — the sheet is hand-editable, Neon is
  backfillable, and the constant is code — dropping self-parent edges, edges
  naming a non-existent dept, and any cyclic edge; it FAILS CLOSED (an
  unreadable map returns the assigned list unchanged). A dept with no children
  is untouched, which is 11 of 14 here. **Owner ruling (2026-07): the widening
  is intended** — a parent dept's managers get their child queues' data,
  agent-level included (Operator State #39), so don't treat the seeded
  `PAP`/`Spanish`/`PAK` edges as an accidental grant. **Alerts and Digests are deliberately
  NOT expanded** — they're per-dept subscriptions an admin configured on
  purpose. `OVERVIEW_HIDDEN_DEPTS` is still Overview-only. Adding a sub-queue means: (1) it
  already appears as its own dept everywhere else (it's a real
  column in `DO NOT EDIT!`), and (2) add a row to
  `OVERVIEW_PARENT_OF` keyed on the column-header text
  byte-for-byte. The hero block shows parent + all its children
  together when the viewer is a parent, so the relationship stays
  visible even when the parent is spotlighted.
- **Admin-only Overview surfaces.** `getCompanyOverview()` always
  computes the company-wide aggregate plus admin-only operational
  fields (`pipelineFreshness`, `orphanNag`, `unmappedQcd`) and caches
  them in the shared blob, but `personalizeOverview_` strips all four
  (`companyAggregate`, `pipelineFreshness`, `orphanNag`, `unmappedQcd`)
  on serve for non-admins. Viewer-personalized fields (`viewerRole`,
  `viewerDept`) are injected per-request so a payload warmed by
  user A still personalizes correctly for user B. Adding a new
  admin-only Overview field means adding it to the strip list
  inside `personalizeOverview_`.
- **View-as-Manager (admin preview).** Admins get a "View as"
  control in the header (`initViewAs_`, built only for admins; it
  carries NO `data-admin-only` so it stays visible to switch back).
  Selecting a dept enters a manager preview: `getCompanyOverview(req)`
  honors `req.viewAsDept` — when the caller is an admin and the dept
  is real, it personalizes the payload as a SYNTHETIC manager of that
  dept (reusing `personalizeOverview_`, so `companyAggregate` /
  `pipelineFreshness` / `orphanNag` / `unmappedQcd` are genuinely
  stripped and `viewerRole='manager'`). SAFE — admins are entitled to
  all data, so this only HIDES; non-admin callers + unknown depts are
  ignored (no escalation). Client-side, `body[data-view-as="manager"]`
  drives a single CSS rule that hides every `[data-admin-only]`
  surface (nav tabs, buttons, the three Overview banners), pins +
  disables the dept selector, and tints the control warn so the admin
  knows they're previewing. Since R9-5 the ESCALATIONS page is scoped
  too: `escLoad_` pins the request dept to `viewAsDept_` and hides the
  dept filter while previewing (exiting view-as restores the filter +
  reloads) -- real managers were always pinned SERVER-side in
  `getEscalations`, so this closes the admin-preview parity gap only. The per-viewer Overview SWR cache
  (`cdr.ov.cache.v1`) is BYPASSED while previewing so a manager
  payload never lands under the admin's cache key. No INV-30 bump —
  personalization is post-cache (same as the existing per-viewer
  strip). It's a VISUAL preview: report endpoints still authorize the
  real admin (entitled), so the admin isn't locked out of clicking
  through; the point is to see the manager's layout/content.
- **Overview admin-only banners (Phase B).** Pipeline Health
  banner (`#ov-pipeline-banner`) and Orphan Fix nag
  (`#ov-orphan-nag`) sit above the summary line on the Overview
  page and are admin-only. Two layers of gating: (1) the
  `data-admin-only` attribute on the div is cleared at init for
  admins (the existing convention -- see the
  `document.querySelectorAll('[data-admin-only]')` loop in
  `script.html`); (2) `ovRenderPipelineBanner_` /
  `ovRenderOrphanNag_` further hide the banner when health is good
  / no active orphans. Pipeline banner fires when no DQE-freshness
  success row (`buildDQE` / `processIntegratedHistory:DQE` /
  `bulkBackfill:DQE`, per INV-44) appears in the last
  `OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS` (=250, widened from 40 in LM1 so a
  deferred-mirror retry storm can't evict the DQE row and false-warn) Pipeline
  Health entries, OR the latest one is older than
  `OVERVIEW_PIPELINE_STALE_HOURS` (=36h, matching the header
  freshness pill threshold). A `rows:0` DQE-step `success` (a no-op
  build of an already-in-history date) does NOT count as a freshness
  success -- `computeOverviewPipelineFreshness_` requires `rows>0` (F5).
  Orphan nag counts orphans whose
  `lastSeen` is within `OVERVIEW_ORPHAN_NAG_DAYS` (=7d) and
  surfaces up to 3 sample names by row-count desc; its Open
  button programmatically clicks `#orphan-fix-btn` to open the
  Outlier Fix modal. Both server helpers
  (`computeOverviewPipelineFreshness_`,
  `computeOverviewOrphanNag_`) are best-effort -- failures return
  null and the Overview still renders without the banner.
  **Unmapped-queue nag (F onboarding):** a third admin-only banner
  (`#ov-unmapped-nag` / `ovRenderUnmappedNag_`) fires when QCD
  queues seen in the data map to no department -- it reuses the
  Dept Config discovery (`discoverQueues_`, the 180-day QCD scan +
  the effective per-dept map, so it invents no mapping), surfaces up
  to 3 sample queue names (busiest first), and its Open button clicks
  `#dept-config-btn` to open the Dept Config modal. Server helper
  `computeOverviewUnmappedQcd_` (best-effort, null on error) feeds the
  admin-only `unmappedQcd` payload field (stripped by
  `personalizeOverview_`; `companyOverview:v20`).
- **Top-tab router (Phase C).** The header nav was flattened from
  Reports + Admin dropdowns into a single row of top-level tab
  buttons (commit ce4220a). Each tab carries a `data-route`
  attribute and a stable button `id`, so the existing per-modal
  init functions still wire up modal-open behavior unchanged; the
  new `initRouter` in `script.html` just tracks `currentRoute` and
  paints the active-tab indicator via `updateTabActiveState_`.
  Two groups have since RE-collapsed into `.header-menu` dropdowns
  (`initHeaderMenus_` wires open/close via `aria-controls`;
  `updateTabActiveState_` lights any dropdown trigger whose item
  route is active, generically): the **Reports** group (Individual +
  the admin-vetted Inbound / Direct) and — post-deploy round 4,
  owner request — the **Admin** group (`#admin-menu-btn`: Alerts,
  Outlier Fix, Dept Config, Access, Health; Caller Lookup stays a
  top-level admin tab). Menu items keep their stable ids +
  `data-route` + `data-admin-only`, so deep links, the F11 non-admin
  no-op guard, and the Overview nags' programmatic
  `#orphan-fix-btn` / `#dept-config-btn` clicks all work unchanged;
  the wrapper carries `data-admin-only` so view-as-manager hides the
  whole group. Two
  click handlers fire per tab — the existing modal-open and the
  router's data-route tracker — but they don't conflict because
  each modal's `openModal` is idempotent. **No
  `google.script.history.push` is used** (spotty browser behavior
  inside Apps Script web apps); URL hashes are read at init via
  `google.script.url.getLocation` and written only when a new tab
  opens. The `↗ Open in new tab` button on report modals
  (`.modal-open-tab-btn`, positioned at `right: 54px` to the left
  of the close X) builds `window.__DASHBOARD_URL__ + '#' +
  currentRoute` and `window.open`s it; `.is-disabled` hides the
  button when `DASHBOARD_URL` is unset. **State-in-URL:** for the
  agent reports (IR / Insights) the button also
  appends the current form state as a `?from=...&agents=a|b` query
  on the hash (the `SHARE_STATE_` provider registry in script.html
  collects/applies it); the deep-link reader splits the query off
  before the `ROUTES_` lookup and applies it AFTER the modal's
  open-time defaults + prefs restore, with agents landing via each
  report's pending-selection hook. Generation is deliberately not
  auto-triggered (async roster load) -- the restored form is one
  Generate click away. Escape-key modal close
  doesn't revert the active-tab state in this phase — cosmetic
  only; clicking any tab refreshes it. **`window.__DASHBOARD_URL__`
  is injected by `renderDashboard_` (Code.gs) from the
  `DASHBOARD_URL` Script Property** with the same `<` escape
  trick as `userJson`; empty string when unset. Don't try to read
  the deployed URL from `window.location` inside the Apps Script
  iframe — that resolves to the `n-<hash>-script.googleusercontent.com`
  wrapper, not the user-facing `/exec` URL. Deep links work for
  the report routes (`#/report/individual`, `#/admin/alerts`,
  `#/admin/orphan-fix`; `#/report/insights` AND its three legacy
  repoints `#/report/performance` / `#/report/compare` / `#/report/qcd`
  are `kind: 'page'` routes onto the Insights PAGE since the modal->page
  conversion (docs/insights-page-plan.md) -- the deep-link page branch
  ALSO applies the route's SHARE_STATE_ ?query form-state after
  `setPage`, which keeps the Digest.gs email deep links
  (`#/report/insights?from=...&agents=...`) working even when no header
  tab carries the route; legacy `#/report/missed`
  links are a `kind: 'page'` route with `scrollTo: 'dept-missed-section'`
  since the Missed-modal retirement -- the deep-link reader dispatches
  page routes with no header tab directly via `setPage` + `refresh()`
  and arms the one-shot `deptMissedScrollPending_` scroll) plus the
  three original PAGE routes
  (`#/overview`, `#/dept`, `#/escalations` — `#/escalations` is now a
  `kind: 'page'` route, not a modal); unknown / malformed hashes quietly
  no-op and land on Overview. A deep link to an admin-only route
  (the `data-admin-only` tabs: alerts / orphan-fix / dept-config)
  by a non-admin also quietly no-ops -- `initRouter` skips the
  trigger rather than opening a modal that would only surface an
  "admin-only" server error (F11).
- **Agent table column model (My Department).** The table is rendered
  from the client `COLUMNS` array (script.html) against a matching static
  `<thead>` in `dashboard.html` (1:1 by position; the Overview mini-table
  `ov-user-table` shares `COLUMNS` and must keep its own thead in sync).
  Columns: Agent · Source · **Answered / Missed** (a `type:'bar'` stacked
  bar — green answered + red missed, total = rung — that FOLDED the former
  Rung/Missed/Answered numeric columns; built by `answeredBarHtml_`, carries
  the E5 WoW chips inline on the answered/missed counts, answer-rate gets
  the 92% benchmark tint, sorts by computed `answerRate` via a special case
  in `sortRows`; since owner round 4 the bar ALSO carries the rung total
  inline as a muted "(N)" — the dedicated **Total calls** column was
  REMOVED from `COLUMNS` + both theads, though the CSV still emits a
  numeric Total calls column spliced after the bar in `exportTableCsv_`)
  · **Answer %** (a `type:'pct'`
  cell = answered/(answered+missed), 92% benchmark tint; added in
  Batch B (#8) as an always-visible column surfacing what the bar folds;
  the Answer % column shares the bar's `answerRate` sort key) · Unique ·
  TTT · ATT · Avg Abd Wait · CSR Avg Abd Wait. The five `hideable:true`
  columns (Source / Unique / TTT / Avg Abd Wait / CSR Avg Abd Wait) FOLD
  AWAY by default behind the **"Show all columns"** toggle
  (`#dept-cols-toggle`, persisted in `cdr.dept.cols`, applied via the
  `hide-extra` class + `.col-extra` cells through the shared `cellClass_`
  helper); the Overview mini-table carries `hide-extra` permanently
  (glance view). Default sort is `answerRate` ascending (worst answer rate
  first; idle/no-activity agents always sink to the bottom regardless of
  direction). **The Overview mini-table (`ov-user-table`) is now
  header-sortable too (Batch B)** with its OWN sort state (`ovUserSort_`,
  same worst-first default, `ovRenderUserRows_`/`ovOnUserSort_`); `sortRows`
  is parametrized `(rows, sortKey, sortDir)` so both tables share it, and
  each table's Total row renders from `totals` (never part of the sort).
  CSV export (`exportTableCsv_`) emits ALL columns regardless of the toggle
  and renders the bar as `answered / missed (rate%)` text + the Answer %
  column via `pctCsv`. **In a sub-queue COMBINED view it also prepends a
  `Department` column and emits per-dept subtotals + an `All shown` grand
  total** (single-dept exports are byte-identical to before) -- see the
  sub-queue scope-switcher decision above, and S43. There is **no automated
  coverage for any CSV writer**, so S43 is the only guard.
- **Source column + roster-only totals (Phase D).** The agent table's
  Source column (between Agent and the Answered/Missed bar) renders one of
  three chips per row: **ROSTER** (accent-soft) for agents on this
  dept's roster only, **BOTH** (good-soft) for agents rostered AND
  matched via shared-queue extensions, **QUEUE** (warn-soft) for
  queue-only floaters. The QUEUE chip suffixes the floater's
  `sourceHomes` array as a comma-separated dept list -- e.g.
  `QUEUE · Sales, Power` for a multi-rostered floater, or bare
  `QUEUE` for a floater on no dept's roster. `sourceHomes` is
  built lazily server-side by `Data.gs::buildDeptsByAgent_` (only
  when at least one queue-only row exists) and iterates every dept
  including `OVERVIEW_HIDDEN_DEPTS` in `getAllDepartments_`
  alphabetical order, so the array is stable. Client
  `sourceChipHtml_` / `sourceChipCsv_` (script.html) array-check
  defensively and fall back to bare `QUEUE` if the field is missing.
  **Totals row sums only `matchedViaRoster=true` rows** -- queue-only
  floaters never factor into dept averages.
  Totals object carries `rosterAgentCount` + `queueOnlyAgentCount`;
  the totals row -- rendered as a pinned `<tbody class="agents-totals">`
  ABOVE the data rows since PR #142 (a real `<tfoot>` always renders at
  the bottom; the element ids `agents-tfoot` / `ov-user-tfoot` were kept
  so the JS is unchanged) -- renders 'Total (roster only · N floaters
  excluded)' in its first cell when `queueOnlyAgentCount > 0`. CSV export uses the
  same semantics: 'Total (roster only)' for the totals row label.
  INV-04 (exact agent-name match) and INV-23 (queue-sentinel `A_Q_*`
  rows skipped) are both preserved. See INV-53 for the
  floater-exclusion contract spanning all dept-level aggregations.
  **NOTE (Phase 14, commit 80e17da):** `getDepartmentSummary` now
  scopes to `roster` (see the "Scope is locked to `roster`" decision
  above), so queue-only floaters no longer appear as rows in the
  My-Dept table at all and the QUEUE Source chip never renders here
  in practice -- `queueOnlyAgentCount` is 0 and the "N floaters
  excluded" caption stays hidden. The Source column still renders
  ROSTER / BOTH chips, and the chip helpers + `sourceHomes`
  machinery survive for the IR picker (which DOES still surface
  floaters in a separate picker group, INV-53) and Diagnostics.
- **Phase E UI surfaces.** Four small affordances landed in commit
  94bbca9, each with a documented data dependency: (1) **work-window
  pill** on My Department (`#work-window-pill`) reads
  `window.__WORK_WINDOW__` injected by `renderDashboard_` from
  `Config.gs::DASHBOARD_WORK_WINDOW` -- the dashboard's read-only
  mirror of cdr-import's pipeline constants (INV-06; sync required
  if those change). (2) **Diagnostics severity chip** -- the
  existing `.diagnostics` block gains `.diag-severity-warn` (warn-soft
  tint) for 1-5 issues and `.diag-severity-bad` (using the Phase A
  `--bad` token) for >5 issues, driven by the same
  `rosterWithNoData.length + queueOnlyMatched.length` total the
  existing collapsible reads. (3) **EXCLUDED FROM TEAM AVG pill**
  (`.ir-excluded-pill`) on Individual Report agent cards, surfaced
  via the new `excludedFromTeamAvg` field on each `summaryData` row
  (INV-26). (4) **QCD days-to-violation forecast** (`#qcd-forecast`)
  runs a 7-day linear regression on `dailySeries.abandonedPct` (INV-51)
  and projects when the 5% threshold will cross -- hidden in three
  healthy states: currentY >= 5 (already over), slope <= 0.01
  (flat / improving), or projected crossing > 7 days out. None of
  these add server endpoints -- E2 is a one-time template inject,
  E4 adds one flag to the existing IR response (bumping
  `individual:v6` -> `v7`), and E3 / E9 are pure client. Of the
  three items originally deferred from Phase E, **E5 (per-row WoW
  chip) shipped in commit bb77168** -- agent table gains an inline
  delta chip on Rung / Missed / Answered comparing to a
  same-length window immediately preceding the selected range
  (see the "Per-row prior-period chips" gotcha below). **E8 (alert
  skip-dates) shipped in commit 319eca7** -- new Skip Dates column
  on the Alert Config sheet honored by the daily trigger only
  (see INV-33 / INV-34). **E10 (threshold drift) shipped in
  commit b3a5a51** -- new "Last 30 days" column on the Alerts
  modal config table summarizing the most-recent ~30
  daily-trigger entries per dept; classifier flags chronic
  (>=80% fire ratio = alert fatigue likely) and lenient (0
  fires + dept averages >= threshold + 10pts = threshold too
  loose to catch a real degradation) cases (see the E10
  Common Gotchas bullet).
- **INV-53 expansion to IR/PR/CR (Phase D+1).** The three
  agent-level reports gained floater-awareness in commit ba26d48,
  extending the Phase D My Department contract. Six pieces worth
  knowing: (1) `Util.gs::computeActiveAgentsInRange_` return shape
  changed from `string[]` to `{agents, floaters}` -- floaters carry
  `sourceHomes` (the agent's other-dept roster homes, via
  `buildDeptsByAgent_`). Cache key bumped `individual_active:v1`
  -> `v2`. (2) Each report's init endpoint surfaces `activeFloaters`
  alongside `activeAgents`. (3) The shared client picker builder
  `irBuildAgentListHtml_` (used by all 3 report pickers) renders a
  third collapsed `<details>` group titled "Floaters (queue-only)"
  beneath the existing Active / No-activity groups; entries carry a
  compact `.ir-agent-floater-chip` showing the floater's other-dept
  home list. (4) Per-card chip on IR summary cards / PR table rows
  / CR agent cards reuses `sourceChipHtml_` (the My Dept Source
  column helper) but only renders when
  `matchedViaQueue && !matchedViaRoster` -- roster agents stay
  implicit. (5) **Security:** dropping the roster-only input gate
  doesn't relax data access. Off-dept names only render if their
  rows had queue-overlap with the dept's queue extensions (same
  path My Dept uses to surface floaters). Crafted names with no
  queue connection produce no rows and fall out of the
  `visibleAgents` filter. (6) **Implementation detail:** each
  report pre-populates `agentMatchedViaRoster` for selected roster
  members upfront (before the row scan) so zero-call roster picks
  still render their card; `sourceHomes` is built lazily via
  `buildDeptsByAgent_` only when at least one floater is in the
  selection. Cache key bumps: `individual:v7` -> `v8`,
  `performance:v3` -> `v4`, `compareRanges:v3` -> `v4`. INV-53
  describes the underlying contract; INV-26 describes the separate
  TEAM_AVG_EXCLUDES path which composes with the floater gate in IR.
- **My Department CSV export.** The agent table has an "Export ▾" menu
  (R9-2: the Insights-toolbar dropdown convention replaced the old
  one-click download icon; the wrap keeps the `#csv-export-btn` id so
  the hidden-until-data gating is unchanged, and it sits horizontally
  beside Refresh in `.control-btn-row`) whose "Download CSV" item
  exports the current view (respecting scope, date range, and sort
  order) as a client-side CSV download. No server round-trip.
- **Draggable / resizable modals.** All modals can be
  repositioned via header drag and resized via a bottom-right
  corner handle. Position and size reset on close so the next
  open starts centered at default size. Disabled below 768px
  viewport width (mobile). (Insights left this set when it became
  a page -- docs/insights-page-plan.md.)
- **Universal Help FAB.** A floating circled-`?` button (`#help-fab`,
  `z-index:150`) stays above report modals so Help is always one click
  away; it opens the SAME `#help-modal` as the header `?`. Because all
  modals share `z-index:100` and stack by DOM order, `#help-modal` is
  lifted to `z-index:200` so Help opened from the FAB while a report
  modal is already open renders ABOVE it (and the FAB tucks itself away
  while Help is open). Hide-able via the Settings toggle
  `#help-fab-toggle` (localStorage `cdr.help.fab` = `off`); the header
  `?` stays as the always-present fallback. Per-report client prefs +
  this key live in localStorage (see the per-report prefs note above).
  The modal content is a **two-pane reference** (`.help-layout`): a
  folder-tree nav (`<details>` categories of `.help-link` topics) + a
  single-topic content panel (`.help-topic` sections), wired by
  `initHelpNav_` with a title+body search box. Since R10-1 a
  `.help-quickstart` strip sits between the modal header and the
  two-pane layout: the four quick-start question chips
  (`#help-launcher`, injected by `initOverviewLauncher_`) + the
  `#help-tour-btn` tour replay -- both close Help via its own close
  button before acting (the F-42 focus-trap discipline). Add a topic = a nav
  `.help-link[data-topic=KEY]` + a `<section id="help-topic-KEY">`; all
  static markup in `dashboard.html`, no server endpoint.

## Operator State Checklist

> **Scope note:** this checklist covers OPERATOR INPUTS — Script Properties you
> set, triggers you install, sheets you create, migrations you run. The code
> also reads back a family of properties it WRITES ITSELF as outcome state
> (`*_LAST`, `*_LAST_RESULT`, `INGEST_WATCHDOG_ALERTED`, `PIPELINE_WATCH_*_MARK`,
> `DIGEST_RUN_MARKER_*`, `QUEUE_REPORT_LAST_SENT`, `CRB_DIAG_COL`, …). Those are
> deliberately NOT listed as items: you never set them, the Health page reads
> them, and clearing one just re-arms its engine. Don't file them as
> undocumented operator state.

The 39 numbered items now live in full in
[`docs/operator-state.md`](docs/operator-state.md) (F8 split). Cited elsewhere
BY NUMBER ("Operator State #38"), so the numbering is stable — retire an item in
place rather than renumbering. **Read the full item before acting on it**; the
index below only tells you which one to open.

When something looks wrong, before assuming a code bug, check:
(**Start at the admin Health view** — Admin ▾ dropdown → Health, route `#/admin/health`,
`SystemHealth.gs` — which renders most of the items below as a live
status table with remediation hints; fall through to the numbered
items for anything it flags or doesn't cover.)

1. Did the daily ingest run? (+ `probeOverviewChartDates()` when a date gap shows despite parity-clean data)
2. Does the deployed VERSION include the latest push? (Manage deployments -> timestamp)
3. Did the user actually have access? (`Access Control` rows are case-sensitive on email)
4. Is the cache stale? (per-report prefix, INV-30; 30 min reports / 5 min freshness)
5. Were the source-pipeline bugs re-introduced? (spot-check Sonia 2026-03-09: TTT `0:15:03`, ATT `0:03:01`)
6. Was `setup()` re-run after a pull that adds sheets? (admin-gated, idempotent, ten sheets)
7. Is `DASHBOARD_URL` set? (alert-email links + every report's "Open in new tab")
8. Are all three trigger families installed? (daily alerts / the integrated DQE build / daily+weekly+monthly digests)
9. Did the latest push add an OAuth SCOPE? (Run any function once in the editor to consent)
10. Does a new `OVERVIEW_PARENT_OF` key match the roster column header byte-for-byte?
11. Pipeline Health sheet -- a long quiet stretch on `autoImport` or any DQE-freshness step
12. Manager digest not delivered -- the seven things to check
13. `ADMIN_EMAILS` Script Property (a new admin who sees no admin features)
14. A dept shows "No queues mapped" / no QCD chips -- map its queues (Dept Config, no redeploy)
15. `TARGET_SS_ID` in CDR Import must point at the CDR Report spreadsheet
16. `NEON_*` Script Properties in CDR Import (without them, mirror writes silently skip)
17. `HMAC_SECRET` must match across cdr-import, cdr-report AND the dashboard
18. `NEON_*` + `script.external_request` on the DASHBOARD project (orphan-rename-to-Neon)
19. `DQE_READ_SOURCE` -- the DQE read-back switch, its parity GATE, and the gate contract (never flip on `error` or `compared: 0`)
20. Neon keep-warm (optional; only matters once DQE reads are on neon)
21. Report cache warming (optional; `CacheWarm.gs`, must run in the dashboard project)
22. Deferred Neon mirror (optional; `NEON_MIRROR_MODE=deferred` + the mirror trigger, retry cap, step order)
23. Ingest-failure watchdog (optional; PUSHES the staleness signal the banner shows passively)
24. Escalations notification flag + the one-time `backfillEscalationActivity()`
25. `CONFIG_SOURCE` -- Dept + Alert + Digest config source switch (backfill -> compare -> flip)
26. Direct-call history backfill after a bulk rebuild (`backfillDirectCallToNeon`)
27. `COMPANY_HOLIDAYS` -- the global holiday list; maintain it yearly
28. Neon backup (optional but recommended; needs the new `drive` scope)
29. Retired server files must be deleted in the WEB EDITOR (INV-17) -- now DETECTED by `check-remote-orphans.mjs`
30. `QCD_READ_SOURCE` -- the QCD read-back switch; set `QCD_PARITY_FROM/_TO` before running the gate
31. Automated Daily Call Queue Report email (optional; polls a morning window for readiness)
32. Pipeline-failure watchdog (optional; PUSHES Pipeline Health failures, + the pending-review ping and two aux signals)
33. `DIAL_IN_LABELS` -- names the main dial-in lines in the Inbound report
34. `UI_FLAGS` -- admin toggles that HIDE a UI surface for all viewers
35. Neon coverage check -- per-date sheet-vs-Neon reconciliation + zero-row weekday gaps
36. `EMAIL_ALIASES` -- alias sign-in addresses resolving to one identity (+ the multi-dept manager note)
37. `ANSWER_TARGETS` -- the admin-tunable answer-rate DISPLAY standards (seed 92%)
38. Diagnosing "a queue's inbound calls are missing" -- the F1/F1b runbook, incl. the ANTI-pattern probe
39. Sub-queue ACCESS widening -- who gains what on deploy, with no admin edit (INV-38)

## Cycle Workflow Config

### Test Command
node --test

(Regression harness, Phases 1-4 -- zero-dep Node `node:test` suites
under `tests/unit/`, run from the repo root; see `tests/README.md`.
Covers pure logic (parsing, `hashAgents_`, Util, the INV-54 Dept
Config accessors), the `computeSummary_` aggregator
(INV-02/04/05/23/53, S35, E5), the IR report builder + the Insights consolidation freeze (INV-25
weighted ATT, INV-28 prior-period, INV-35 length-mismatch, INV-53),
pipeline canonicalization (INV-24/46 + INV-16 cross-project), the
INV-29 trend window (`computeTrendStartDate_`, trend-window.test.js),
the end-to-end `buildDQEHistoricalData` build (INV-07/08/20/21 +
dup guard + the Pass-4 INV-23 queue-sentinel producer), and the QCD
report's F-15 daily axis / F-36 all-dept grand-total dedup
(qcd-report.test.js). The neonWrite JDBC writers are pinned end-to-end
(chunking/commit discipline by neon-write-chunking.test.js; field
mappings by neon-write-mapping.test.js). NOT yet covered: the deferred
mirror's sheet-derived payload re-derivation (NeonMirror.js) -- the
manual Regression Scenarios remain the verification of record there,
so walk the scenarios that overlap a change in addition to running
`node --test`.)

### Health Dimensions
Data Accuracy (DQE), Access Control Integrity, Source Pipeline Reliability, Migration Progress, Cross-Project Consistency, Documentation Freshness, Performance & Cache Effectiveness, Error Surfacing & Observability, Manager-Facing UI Polish, Deployment Hygiene, Code Health

### Subsystems
Department Dashboard:
  apps-script/department-dashboard/Auth.gs, apps-script/department-dashboard/Code.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/Diagnostics.gs, apps-script/department-dashboard/Setup.gs, apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/NeonRead.gs, apps-script/department-dashboard/NeonKeepWarm.gs, apps-script/department-dashboard/CacheWarm.gs, apps-script/department-dashboard/IngestWatchdog.gs, apps-script/department-dashboard/PipelineWatch.gs, apps-script/department-dashboard/NeonBackup.gs, apps-script/department-dashboard/NeonCoverage.gs, apps-script/department-dashboard/SystemHealth.gs, apps-script/department-dashboard/SmokeCheck.gs, apps-script/department-dashboard/MissedCallsReport.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/InsightsReport.gs, apps-script/department-dashboard/InboundReport.gs, apps-script/department-dashboard/DirectCallReport.gs, apps-script/department-dashboard/CallerLookup.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/CompanyOverview.gs, apps-script/department-dashboard/Digest.gs, apps-script/department-dashboard/QueueReportEmail.gs, apps-script/department-dashboard/OrphanFix.gs, apps-script/department-dashboard/QCDReport.gs, apps-script/department-dashboard/DeptConfig.gs, apps-script/department-dashboard/Escalations.gs, apps-script/department-dashboard/access_denied.html, apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script.html, apps-script/department-dashboard/styles.html, apps-script/department-dashboard/appsscript.json

CDR DQE Pipeline:
  apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-report/DQEdrilldown.js, apps-script/cdr-report/DQEDrilldownSidebar.html, apps-script/cdr-report/dataFilters.js, apps-script/cdr-report/CDR Tools menu.js, apps-script/cdr-report/appsscript.json

CDR Reporting Tools:
  apps-script/cdr-report/dashboardCDR.js, apps-script/cdr-report/dbHistorical.js, apps-script/cdr-report/dbReporting.js, apps-script/cdr-report/emailDailyReport.js, apps-script/cdr-report/neonbackfill.js, apps-script/cdr-report/neonWrite.js, apps-script/cdr-report/inboundCallsExport.js, apps-script/cdr-report/insuranceNumbers.js, apps-script/cdr-report/sheetRepairs.js

CDR Import:
  apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/CDR Tools.js, apps-script/cdr-import/DeleteOldSheets.js, apps-script/cdr-import/autoImport.js, apps-script/cdr-import/buildDQEHistoricalData.js, apps-script/cdr-import/importBulkCSVsFromDrive.js, apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/outboundCalls.js, apps-script/cdr-import/NeonMirror.js, apps-script/cdr-import/directCallMetrics.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-import/appsscript.json

DQE Report Legacy:
  apps-script/dqe-report/DQEdashboard.js, apps-script/dqe-report/FAQGuide.html, apps-script/dqe-report/IndividualReport.js, apps-script/dqe-report/IndividualReportModal.html, apps-script/dqe-report/MissedCallsReport.js, apps-script/dqe-report/MissedReportModal.html, apps-script/dqe-report/MultiCompModal.html, apps-script/dqe-report/MultiComparisonTool.js, apps-script/dqe-report/SingleRangeReport.js, apps-script/dqe-report/SingleReportModal.html, apps-script/dqe-report/menu DQE Tools.js, apps-script/dqe-report/sendManualAlert.js, apps-script/dqe-report/showFAQ.js, apps-script/dqe-report/appsscript.json

### Invariant Library
Full text: [`docs/invariants.md`](docs/invariants.md) (F8 split) — one entry per
line, `INV-NN | rule | Subsystem: ...`. **The entry is authoritative; the index
below is a finding aid.** Several invariants carry exceptions and version
history that a one-line summary cannot hold, so open the entry before relying
on one (INV-30's cache-version table above all).

INV-01 | Public (RPC-callable) functions never write a spreadsheet except the admin-gated carve-outs (OrphanFix / setup / DeptConfig / Access Control / Alert+Digest config) plus the append-only Report Usage telemetry; `_`-suffixed helpers are RPC-unreachable | Subsystem: Department Dashboard
INV-02 | Duration columns (TTT/ATT/AvgAbdWait/CSRAvgAbdWait) are read via `getDisplayValues()`, never `getValue()` -- spreadsheet-vs-script TZ | Subsystem: Department Dashboard
INV-03 | `DO NOT EDIT!` roster cell format `"Name, ext1, ext2"` -- name is everything before the first comma; digit-only tokens after are extensions | Subsystem: Department Dashboard
INV-04 | Agent-name match (DQE col C <-> roster) is EXACT: case- and whitespace-sensitive, no alias normalization at the dashboard layer | Subsystem: Department Dashboard
INV-05 | Dashboard per-agent ATT is the SIMPLE MEAN of stored ATT values, not TTT/Answered weighted | Subsystem: Department Dashboard
INV-06 | Work window is 6:30 AM-3:00 PM PST (8:30 AM-5:00 PM CST); the dashboard's `DASHBOARD_WORK_WINDOW` mirrors the pipeline constants and must stay in sync | Subsystem: CDR DQE Pipeline + Department Dashboard
INV-07 | The TTT/ATT loop iterates `windowLegs`, not all-day `legs`, so it shares Answered's denominator | Subsystem: CDR DQE Pipeline
INV-08 | TTT attribution uses each agent's OWN `leg.talkSec` via `findAgentTalkOnParent`, never `parent.talkSec` | Subsystem: CDR DQE Pipeline
INV-09 | The Data.gs cache key is versioned (`summary:vN:`); bump on any aggregation-rule change | Subsystem: Department Dashboard
INV-10 | `HISTORICAL_COLS` must match the real DQE Historical Data column positions (full map in the entry) | Subsystem: Department Dashboard
INV-11 | ROSTER layout pins: HEADER_ROW=1, DATA_START_ROW=2, DEPT_FIRST_COL=6 | Subsystem: Department Dashboard
INV-12 | `setup()` is idempotent and admin-gated; it creates the ten dashboard-managed sheets if missing and never overwrites rows | Subsystem: Department Dashboard
INV-13 | Deployed as "Execute as: Me" + "Anyone within domain" -- the deployer's permissions back the script | Subsystem: Department Dashboard
INV-14 | `SPREADSHEET_ID` comes from Script Properties, never hardcoded | Subsystem: Department Dashboard
INV-15 | Per-project `.clasp.json` files are gitignored at any depth; scriptIds stay out of the repo | Subsystem: operational/cross-cutting
INV-16 | `neonWrite.js` AND `buildDQEHistoricalData.js` are duplicated cdr-report<->cdr-import and must stay BYTE-IDENTICAL; also the `opts.skipNeon` / `opts.expectedDate` contract. Enforced by `scripts/check-duplicated-files.sh` | Subsystem: CDR Reporting Tools / CDR Import / CDR DQE Pipeline
INV-17 | `clasp push -f` never deletes remote files absent locally -- removal is a manual web-editor step | Subsystem: operational/cross-cutting
INV-18 | The missed-calls chart range is 8:00 AM-5:00 PM CST in 18 half-hour buckets | Subsystem: Department Dashboard
INV-19 | `DQE_EXCLUDED_AGENTS` is the canonical pseudo-agent exclusion list -- additions go upstream | Subsystem: CDR DQE Pipeline
INV-20 | Slot columns K-AC already hold CST (PST->CST applied at write) -- downstream must NOT re-convert | Subsystem: CDR DQE Pipeline / Department Dashboard
INV-21 | `parentMap` builds from rows with parentId `'N/A'`/`''`; each parent leg's `calleeName` must be captured | Subsystem: CDR DQE Pipeline
INV-22 | DQE Report Legacy is FROZEN -- deletions and minimal menu cleanups only | Subsystem: DQE Report Legacy
INV-23 | Queue-sentinel rows (agent name holds a queue id) carry queue-only abandoned data; per-agent consumers must filter them out, the Missed report reads them deliberately | Subsystem: CDR DQE Pipeline / Department Dashboard
INV-24 | The pipeline canonicalizes agent names against the roster under TWO paren normalizations (strip + flatten), rewriting only on a UNIQUE match; admin alias overrides win | Subsystem: CDR DQE Pipeline
INV-25 | IR + Insights compute ATT WEIGHTED by answered; the main dashboard table does not (INV-05) | Subsystem: Department Dashboard
INV-26 | `TEAM_AVG_EXCLUDES` removes named agents from BOTH sides of the IR team average; composes with the INV-53 floater gate | Subsystem: Department Dashboard
INV-27 | The IR team-avg denominator counts only roster members with ANY activity in range | Subsystem: Department Dashboard
INV-28 | The auto-adjacent prior period is the immediately-preceding SAME-LENGTH window, NOT the previous calendar month; one shared `computePriorWindow_` / `resolveComparisonWindow_` | Subsystem: Department Dashboard
INV-29 | The 12-month trend window rule, with one shared `computeTrendStartDate_` so IR / Insights / QCD trends align | Subsystem: Department Dashboard
INV-30 | Every report owns a VERSIONED cache prefix -- bump on any aggregation-rule change. Current versions, their bump history, and the read-source key suffixes are all in the entry | Subsystem: Department Dashboard
INV-31 | The `script.send_mail` scope backs every export / alert / digest / queue-report / failure-notify path | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the notify-failure paths)
INV-32 | Alerts is admin-only at the SERVER boundary -- `assertAdmin_` on every callable in Alerts.gs | Subsystem: Department Dashboard
INV-33 | Daily alerts skip weekend + company-holiday RUNS and assess the previous BUSINESS day; per-dept Skip Dates are trigger-only | Subsystem: Department Dashboard
INV-34 | `Alert Config` / `Alert Log` schemas, plus the invalid-threshold / unknown-dept / duplicate-row flag contract | Subsystem: Department Dashboard
INV-35 | The length-mismatch flag trips at 1.2x counted in WORKING days (weekends AND company holidays excluded) | Subsystem: Department Dashboard
INV-36 | Cache keys that embed an agent selection MUST hash through `hashAgents_` -- CacheService silently rejects keys over 250 chars | Subsystem: Department Dashboard
INV-37 | Multi-PAGE app toggled by `body[data-page=...]`; `setPage()` owns the swap; `refresh()` writes the header title only on the dept page | Subsystem: Department Dashboard
INV-38 | `OVERVIEW_PARENT_OF` shapes the Overview tile grid ONLY; keys must match roster column headers byte-for-byte | Subsystem: Department Dashboard
INV-39 | Admin-only Overview fields are STRIPPED on serve by `personalizeOverview_` (deep-clone, fail-closed); a new admin-only field must join the strip list | Subsystem: Department Dashboard
INV-40 | The "X of Y agents" denominator is `recentlyActiveCount` (30-day activity), not roster size | Subsystem: Department Dashboard
INV-41 | datalabels needs explicit `Chart.register` + `display=true` at load; use the boolean `display` form. Also the missed-chart Bars/Radar contract and the animation-defaults rule | Subsystem: Department Dashboard
INV-42 | Chart colors resolve through `THEME.*` / `colorToCanvasRgb_` -- raw OKLCH tokens make datalabels render invisible | Subsystem: Department Dashboard
INV-43 | The My Department From/To default snaps to the most-recent DQE date | Subsystem: Department Dashboard
INV-44 | `Pipeline Health` schema + the full Step-name vocabulary; a `rows:0` DQE success is a NO-OP, not freshness | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the writers)
INV-45 | `Digest Config` schema, the three cadences, the run-claim marker + failure semantics, and the two formats | Subsystem: Department Dashboard
INV-46 | `Agent Alias Overrides` schema -- the dashboard writes it, the pipeline reads it (cross-project soft coupling) | Subsystem: Department Dashboard + CDR DQE Pipeline
INV-47 | `Orphan Fix Log` schema + its action vocabulary | Subsystem: Department Dashboard
INV-48 | `dept.wow.driver` attaches only past 1.5 pts, narrates by dominance, and is stripped per-dept for non-admins | Subsystem: Department Dashboard
INV-49 | IR accepts explicit `priorFrom`/`priorTo` or `priorMode:'prevPeriod'` (resolved SERVER-side); the prior window joins the cache key | Subsystem: Department Dashboard
INV-50 | `QCD Historical Data` schema -- col D is a raw QUEUE name, not a dept; only the `Total Calls` source is summed | Subsystem: Department Dashboard + CDR Import
INV-51 | The QCD modal is RETIRED; still live are the `queuesForDept_` rollup, the Overview chips, My-Dept's snapshot, and the all-departments report | Subsystem: Department Dashboard
INV-52 | `CDR` / `Q Path` / `CSR Transfer` historical schemas -- written by cdr-import, read by legacy, mirrored to Neon | Subsystem: CDR Import (writer) / DQE Report Legacy (reader)
INV-53 | Queue-only FLOATERS are excluded from every dept-level total and team average across all reports | Subsystem: Department Dashboard
INV-54 | `Dept Config` schema + the sheet-overrides-constant accessor semantics; THREE cross-project consumers, one of them capture-time queue recognition | Subsystem: Department Dashboard
INV-55 | Escalations is the FIRST public PER-DEPT (non-admin) write path -- INV-01's four mitigations with the admin gate swapped for a row-level dept gate | Subsystem: Department Dashboard

### Policy Configuration
Policy threshold: 6/10
Consecutive cycles: 2

### Regression Scenarios
Full steps + expected results: [`docs/regression-scenarios.md`](docs/regression-scenarios.md)
(F8 split). Walk every scenario whose Subsystem overlaps a file you changed.
The index below is titles only.

S1 | Manager loads own-dept dashboard | Subsystem: Department Dashboard
S2 | Admin switches departments | Subsystem: Department Dashboard
S3 | Unmapped user gets access-denied | Subsystem: Department Dashboard
S4 | Missed Calls report (My Department inline section) renders for a known date | Subsystem: Department Dashboard
S5 | Daily DQE aggregation completes for a typical day | Subsystem: CDR DQE Pipeline
S6 | Source column + roster-only totals (post-Phase D) | Subsystem: Department Dashboard
S7 | Source pipeline numbers match dashboard | Subsystem: CDR DQE Pipeline → Department Dashboard
S8 | New manager visible within 60s of being added to Access Control | Subsystem: Department Dashboard
S9 | clasp push from sibling subdir deploys only that project | Subsystem: operational
S10 | setup() is safely re-runnable | Subsystem: Department Dashboard
S11 | Individual Report renders for one agent with monthly trend | Subsystem: Department Dashboard
S12 | Individual Report peer comparison with shared legend | Subsystem: Department Dashboard
S13 | Individual Report agent picker active/inactive grouping | Subsystem: Department Dashboard
S14 | Insights team rollup: current vs prior deltas + PR-absorbed views | Subsystem: Department Dashboard
S15 | Pipeline canonicalizes paren-variant agent names | Subsystem: CDR DQE Pipeline
S16 | Export menu captures all chart tabs | Subsystem: Department Dashboard
S17 | RETIRED (Compare Ranges deleted -- CR->Insights consolidation). Per-dept gating for the replacement is covered by S37's console negative test; the custom-prior round-trip by S19. | Subsystem: Department Dashboard
S18 | Insights length-mismatch surfaces per-day (ex-Compare Ranges, INV-35) | Subsystem: Department Dashboard
S19 | Insights custom prior range round-trip (ex-Compare Ranges) | Subsystem: Department Dashboard
S20 | Alerts preview + send flow | Subsystem: Department Dashboard
S21 | Alerts daily trigger install/uninstall | Subsystem: Department Dashboard
S22 | setup() creates all dashboard-managed sheets idempotently | Subsystem: Department Dashboard
S23 | Overview is the default landing + tile click solos the trend line | Subsystem: Department Dashboard
S24 | Sub-queue nests under parent hero on Overview | Subsystem: Department Dashboard
S25 | Company aggregate visibility is admin-only | Subsystem: Department Dashboard
S26 | Big-roster reports complete without cache-key error | Subsystem: Department Dashboard
S27 | RETIRED (duplicate of S17; Compare Ranges deleted -- CR->Insights consolidation). | Subsystem: Department Dashboard
S28 | Pipeline Health logs autoImport + integrated DQE outcomes | Subsystem: Department Dashboard + CDR Import + CDR DQE Pipeline
S29 | Manager Digest install + preview flow | Subsystem: Department Dashboard
S30 | Header freshness pill renders and goes stale | Subsystem: Department Dashboard
S31 | Orphan Fix end-to-end (admin) | Subsystem: Department Dashboard + CDR DQE Pipeline
S32 | Queue data end-to-end (Insights Queue health + retained QCD surfaces) | Subsystem: Department Dashboard + CDR Import
S33 | Pipeline Health per-output rows | Subsystem: CDR Import + Department Dashboard
S34 | Integrated DQE build runs inside autoImport | Subsystem: CDR Import + CDR DQE Pipeline + Department Dashboard
S35 | Phase D totals parity (roster-only floater exclusion) | Subsystem: Department Dashboard
S36 | Dept Config modal: auto-discovery, validation, override round-trip | Subsystem: Department Dashboard
S37 | Insights report end-to-end (comparison modes + CR-ported analytics) | Subsystem: Department Dashboard
S38 | Inbound capture -> Inbound report -> insurer labeling end-to-end | Subsystem: Department Dashboard + CDR Import + CDR Reporting Tools
S39 | Keyboard-only walk of the primary drill paths (F13) | Subsystem: Department Dashboard
S40 | Escalation overdue count agrees with the flagged cards (F3) | Subsystem: Department Dashboard
S41 | Theme × mode sweep (perceptual) | Subsystem: Department Dashboard
S42 | Narrow-viewport trend band (perceptual) | Subsystem: Department Dashboard
S43 | Combined-view CSV export | Subsystem: Department Dashboard

### Frozen Subsystems
- DQE Report Legacy — manager-facing reports in `apps-script/dqe-report/`. Frozen because migration to Department Dashboard is complete: Individual Report, Performance Report, Compare Ranges, Missed Calls Report, and Low Answer Rate Alerts all live in the dashboard. Replacement: Department Dashboard. Awaiting decommission of the legacy spreadsheet. Unfreeze only if a bug is found in legacy that affects production decisions before the spreadsheet is retired.

### Deploy Command
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`
CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (same Apps Script project as CDR DQE Pipeline)
CDR Import: `cd apps-script/cdr-import && clasp push -f`
DQE Report Legacy: `cd apps-script/dqe-report && clasp push -f` (frozen — cleanup deploys only)
