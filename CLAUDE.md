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

For deeper context, in priority order:

- [`docs/architecture.md`](docs/architecture.md) — data flow across CDR
  Import, CDR Report, Department Dashboard, Neon Postgres. Read this first
  when chasing a bug to figure out which layer is involved.
- [`docs/known-issues.md`](docs/known-issues.md) — institutional memory.
  Fixed bugs, design rules, drift risks. Read before changing the source
  pipeline or the dashboard's data layer.
- [`docs/conventions.md`](docs/conventions.md) — time windows, aggregation
  rules, naming conventions, scope semantics.
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
# and cdr-import/. Non-zero exit on drift. Also runs automatically
# as a non-blocking SessionStart hook (.claude/settings.json).
bash scripts/check-duplicated-files.sh

# Unit tests (regression harness, Phases 1-4). Zero deps -- Node's
# built-in test runner loads the real .gs/.js files into a vm with
# mocked Apps Script globals (dashboard + the sibling cdr-report /
# cdr-import projects). Non-zero exit on failure. Covers: pure logic
# (date/duration parsing INV-02/03, hashAgents_ INV-36, Util, the
# INV-54 Dept Config accessors); the aggregator computeSummary_
# (INV-02/04/05/23/53, S35, E5); the report builders (IR weighted ATT
# INV-25, PR prior-period INV-28, CR length-mismatch INV-35, INV-53);
# pipeline canonicalization (loadRosterCanonicalNames_ INV-24/46,
# INV-16 cross-project); the INV-29 trend window
# (computeTrendStartDate_, trend-window.test.js); and the end-to-end
# buildDQEHistoricalData build (INV-07/08/20/21). See tests/README.md
# for design + how to add tests + the remaining gaps (Pass-4 sentinel
# rows, neonWrite JDBC).
node --test          # from repo root (or: npm test)

# CI: .github/workflows/ci.yml runs `node --test` + the INV-16 guard on
# push-to-main and every PR (also: `npm run ci` locally).

# Deploy helper: push AND roll a project's web-app deployment to a new
# version in one step (avoids the manual "Manage deployments -> New
# version" stale-deploy footgun, Operator State #2). The deployment id
# comes from `clasp deployments` in that dir (one-time lookup).
scripts/deploy.sh .                      <dashboard-deployment-id>
scripts/deploy.sh apps-script/cdr-report <cdr-report-deployment-id>
scripts/deploy.sh apps-script/cdr-import <cdr-import-deployment-id>
# (omit the id to just `clasp push -f` and finish the version bump manually)

# Still manual (NOT unit-covered): the Pass-4 queue-only sentinel rows
# and the Neon mirror writers -- verify those via deploy + smoke-test
# against the Regression Scenarios in the Cycle Workflow Config below.
```

## Common Gotchas

A few things that have bitten us repeatedly. See `docs/known-issues.md` for full detail.

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
  `neonbackfill.js::sanitizeAbandonedCellForNeon_` (write to Neon) and
  `Util.gs::classifyAbandonedCell_` (Missed report + Diagnostics) recognize the
  sentinel + the coerced shapes, recover lossless single values, and EXCLUDE
  lost cells from counts (never split into fake IDs); the Missed report flags
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
  history backwards".
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
  the canonical destination), `LockService` serialization, and
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
  build; if an incoming CDR row's agent name's paren-stripped form
  matches exactly one roster entry's paren-stripped form, the pipeline
  rewrites it to the canonical roster form. The comparison strips the
  PARENTHETICAL (parens + contents), so a name differing only in that
  parenthetical canonicalizes -- incoming "Roman Paulose" OR
  "Roman (Bob) Paulose" both strip to "Roman Paulose" and become
  "Roman (Robin) Paulose" (the roster form). A name with an EXTRA word
  like "Roman Robin Paulose" does NOT match -- it strips to itself, not
  "Roman Paulose". Ambiguous (>1 match) and unknown (0
  matches) names are written as-is. Soft coupling: the pipeline now
  depends on the dashboard's roster sheet schema — see
  `loadRosterCanonicalNames_` in the pipeline. Admin-curated
  overrides in the `Agent Alias Overrides` sheet (see INV-46) take
  precedence over both the paren-strip and the exact-roster match;
  the dashboard's Orphan Fix modal writes there. Aliases with
  `Active=FALSE` are skipped by the pipeline.
- **ATT semantics differ between the main dashboard and the per-agent
  reports.** Main dashboard table uses the SIMPLE MEAN of stored per-row
  ATT values (INV-05); the Individual, Performance, and Compare Ranges
  reports use a WEIGHTED average (`sum(att * answered) / sum(answered)`)
  so days where the agent didn't answer any calls don't drag the ATT
  down. Intentional — matches the legacy reports they migrated from.
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
  / `getDeptQueueExtsOverride_` (DeptConfig.gs) so a sheet override
  takes effect; never index the frozen constant directly in new code.
  The accessors fall through to the constant when no Active sheet row
  exists, so behavior is unchanged on installs that haven't re-run
  `setup()`. Override semantics: for a dept with an Active row, each
  NON-EMPTY field overrides that dept's constant; an EMPTY field falls
  back. Consumers already rewired: `queuesForDept_` (QCDReport.gs),
  `computeQcdSnapshots_` + the Overview parent map (CompanyOverview.gs),
  the IR team-avg reads (IndividualReport.gs), `getDeptQueueExts_`
  (Data.gs).
- **Performance Report prior period = same duration ending one day
  before current start**, NOT "previous calendar month". A 31-day
  current window compares against the immediately-preceding 31 days.
  Surfaced in the form's inline hint + the results header so the
  comparison basis is visible to users.
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
  77441a7).** `missedAgentsHtml_` (the SHARED builder for the
  per-agent missed-call cards, used by both the Missed Calls modal
  and the My Department inline missed section) sorts agents
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
  record also carries `call_start` ('HH:MM:SS', CDR-native TZ) and
  `journey` (a JSON text column: the ordered leg-by-leg path --
  IVR/queue/agent legs with timestamps, durations, talk/hold seconds,
  missed/abandoned flags; capped at `IC_JOURNEY_MAX_EVENTS`=40; callee
  names that look like phone numbers are MASKED so no raw number lands
  in Neon). The writer's idempotent `ALTER TABLE ... ADD COLUMN IF NOT
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
  entry->final summary for pre-extension rows). **Per-call drill-through
  (#3):** `InboundReport.gs::getCallJourney({callId, date, department})`
  returns ONE call's journey by `(call_date, call_id)` for the "↳ path"
  affordance on ABANDONED rings in the Missed Calls report + My Department
  missed section (those 🚨 timestamps already carry the parent call id +
  date). Unlike the full Inbound report (admin-only while vetted), this is
  manager-reachable for the manager's OWN dept: managers are pinned to
  their dept AND the query is scoped by the SAME `inboundDeptPredicate_`,
  so a crafted call_id for another dept returns `found:false`; the journey
  carries no caller identity. Client reuses the Caller Lookup renderers
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
- **Temporal abandon heatmap (weekday × hour), sourced from
  `inbound_calls`.** `InboundReport.gs::getInboundHeatmap({department,
  from, to})` aggregates abandon rate by `ISODOW × hour-slot` in ONE
  json_agg round-trip, reusing `inboundResolveRequest_` (so it inherits
  the inbound report's **admin-only vetting gate** + per-dept scoping) and
  `inboundDeptPredicate_`. Cached `inboundHeatmap:v1`. Rendered by the
  SHARED client `renderAbandonHeatmap_` / `loadAbandonHeatmap_` as a
  CSS-grid heatmap (no Chart.js dep) in the **Inbound report**
  (`#inbound-heatmap`, always, since that report is admin-only), the
  **QCD report** (`#qcd-heatmap`, companion -- the load call is gated by
  `USER.role==='admin'` in `qcdRenderReport_` so managers never hit the
  admin endpoint; opens to managers automatically when the inbound
  report's one-line gate is later removed), AND the **Insights report**
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
  defers the Neon mirror): the editor-run `runDirectCallBuild()` (Phase 1a,
  spot-checking), the daily `processIntegratedHistory` 6th block (Phase 1b,
  inline Neon mirror, best-effort -- a failure never affects the import), and
  the bulk-backfill path (Phase 3, builds the sheet per date with `skipNeon`,
  gated on its OWN `willBuildDirect` so old dates that already have DQE still
  get Raw Data written for the build). The deferred bulk mirror is flushed by
  the editor-run **`backfillDirectCallToNeon()`** (cdr-import; one connection,
  batched `ON CONFLICT DO UPDATE`, resumable via `DIRECT_UPSERT_RESUME`, optional
  `DIRECT_UPSERT_SINCE` date floor) -- the DQE `skipNeon` +
  `backfillDQEHistoryUpsert` pattern, but cdr-import-local (the writer + table
  DDL live here). The shared `dcUpsertRows_(conn, rows)` holds the upsert SQL
  for BOTH the single-date writer and the multi-date backfill. Dashboard read
  surface: `DirectCallReport.gs::getDirectCallReport({from,to,department?})`
  (ONE json_build_object Neon round-trip; per-agent answer rate EXCLUDING the
  busy carve-out, inbound ATT, outbound activity + ATT, int/ext split; cached
  `directCall:v1`). **TEMPORARILY admin-only while the carve-out numbers are
  vetted** (the Inbound-report model: the per-dept manager path is written +
  kept intact, so release is a one-line gate removal in
  `directCallResolveRequest_` + un-hiding the `data-admin-only` Direct tab).
  Route `#/report/direct`. See `docs/direct-extension-metrics-design.md`.
- **The Insights report is the consolidation candidate for PR (and
  eventually CR).** `InsightsReport.gs` = PR's team rollup + CR-style
  per-agent delta cards + the 12-mo trend, with comparison modes
  (auto-adjacent INV-28 / YoY / custom) resolved client-side to
  explicit priorFrom/priorTo. A unit parity test
  (insights-report.test.js) pins Insights' teamStats / prior window /
  trendData identical to PR's on the same inputs -- if it breaks, the
  two have diverged and PR can't be retired. Insights also carries a
  **Queue health** section (`queueHealth` in the response, rendered
  by `insRenderQueueHealth_`): queue-level tiles + per-queue rows with
  violation dates for the same window + prior window, computed by the
  SAME `computeQcdReport_` the QCD modal uses (null/hidden when
  unmapped or the QCD sheet is missing; `{error:true}` -> a small
  "unavailable" note on a genuine compute failure, F8) -- the consolidation path
  toward Insights replacing QCD for day-to-day use, with the QCD
  Report remaining the deep dive (per-queue charts, daily series).
  **Phase 2 parity (heatmap + agent-free run, commit c7b6b06):** Insights
  now also renders the temporal abandon **heatmap** (`#ins-heatmap`,
  admin-only, reusing `getInboundHeatmap`) as a Queue-health companion,
  and can be generated **agent-free** -- an EMPTY agent selection defaults
  to the full dept roster (the digest pattern, INV-45; floaters excluded)
  via the shared `resolveInsightsAgents_` used by BOTH `getInsightsReport`
  and `sendInsightsReportEmail`, so a manager can open Insights as a queue
  / dept dashboard without first picking agents. The non-empty path is
  byte-equivalent to the dedup loop it replaced; the only remaining throw
  is a genuinely empty roster. Client: Generate is enabled whenever the
  roster is non-empty (`insUpdateGenerate` counts `.ir-agent-cb`, not
  `:checked`), and the picker hint advertises the whole-department view.
  **No cache bump** -- `meta.agents` already carried the resolved selection,
  so agent-free is byte-identical to explicitly selecting the whole roster
  (deterministic per `hashAgents_` key; insights:v16 unchanged). The QCD
  tab/modal/`getQcdReport` are KEPT for parallel-run validation
  (parity-first house style, INV-51); the `/report/qcd` repoint + the QCD
  retirement (deleting the tab/modal/`getQcdReport`, keeping
  `computeQcdReport_` / `getQcdAllDepartments` / the two snapshot paths)
  are the deferred follow-up.
  **Chart consolidation (seq #1, insights:v16):** the 12-mo team-trend
  chart and the queue-health abandoned-% chart are ONE tabbed chart
  (`insRenderTrendChart_` on `ins-trend-chart`): metric tabs Answered /
  % Answered / ATT / **Abandoned % by Queue**, plus a **Monthly/Daily**
  toggle (`insTrendView`). Daily for the team metrics reads the new
  `trendDaily` response field (daily answered/%/ATT over the selected
  window); Daily for the queue tab reads `queueHealth.trend.daily*`.
  `queueHealth` now ALWAYS-separates sub-queues (children shown as
  their own lines/rows + tagged `subDept`, EXCLUDED from the own-only
  dept total) -- the old `ins-qh-include-sub` toggle + the
  `queueHealthOwnOnly` request flag are retired (mirrors the QCD
  report's seq-#5 separation). The Queue health section keeps its
  tiles + per-queue detail table. Per-agent classification
  / improvement score / quiet thresholds are the SHARED
  `deltaClassify_` / `deltaImprovementScore_` / `deltaIsQuiet_`
  helpers in script.html (CR delegates to the same ones).
  **Per-agent cards (seq #3, redesigned in the post-deploy pass):** each
  card leads with **% Ans / Answered / Missed** as CSS bars **vs the TEAM
  AVERAGE** (a marker on each track) + the agent's value in a right-aligned column beside each track (moved off the bar in #3 so it never overlaps the team marker)
  (`insBuildCard_` builds them; the team average per metric is computed in
  `insRenderAgentCards_` as team-total / `meta.rosterAgentCount`, except
  `pct` which is the team rate). Rung / ATT / TTT moved into a collapsible
  `<details>`. The toolbar has a **Cards⇄Chart** toggle (`insCardsView`):
  Chart view (`insRenderCardsChart_` on `ins-cards-chart`) renders each
  agent's **gap vs the team average** as diverging bars (colored by
  favourability -- Missed is inverse), value as a datalabel, **click a bar
  to drill into IR**. Both views persist in `cdr.ins.prefs`; single-agent
  reports force Cards view. **IR drill-through (`irDrillToAgent_`):** hides
  the Insights modal (its rendered report stays in the DOM), opens IR, and
  reveals a **"Back to Insights"** button (`ir-back-to-insights-btn`); IR's
  `closeModal` re-shows the intact Insights modal on any close when
  `irCameFromInsights_` is set -- instant, no re-generate (the server cache
  `insights:v16` already makes a fresh re-generate fast too). The team
  rollup tiles dropped Total Rung / Total TTT; Queue health dropped Longest
  wait (decluttered to two labeled groups: Department rollup + Queue health).
- **Guided onboarding tour is client-only (#5).** A self-built
  coachmark walkthrough (no dependency): `initTour_` / `startTour_`
  in script.html + `.tour-*` styles. Spotlight = a `#tour-highlight`
  box with a huge `box-shadow` that dims everything else (click-through;
  only the `#tour-tip` card is interactive); reduced-motion aware.
  Steps (`tourAllSteps_`) anchor to stable IDs (`#page-title`,
  `#ov-launcher`, `#freshness-pill`, `#my-dept-btn`, `#escalations-btn`,
  `#reports-menu-btn`, `#help-fab`) and `tourVisibleSteps_` drops any
  target that's missing or hidden (so admin-only/not-yet-rendered
  elements are skipped gracefully -- e.g. the freshness pill before
  data loads). Auto-runs ONCE for first-time visitors (localStorage
  `cdr.tour.done`, gated to the Overview landing, 1.2s after load) and
  is always replayable from **Help -> Guided tour** (`#tour-replay-btn`,
  which closes Help first). No server endpoint / cache bump -- part of
  the same client-only anti-intimidation layer below.
- **Anti-intimidation layer is client-only; keep it that way.** Four
  pieces, all in script.html/styles.html with no server endpoints or
  cache bumps: (1) **answer-first headlines** -- every report's results
  open with 2-3 plain sentences via `reportHeadline_` + per-report
  `*Headline_` composers (each guards its no-data case). The headline is
  a STATUS-TONED banner (redesign): a composer may return
  `{sentences, tone}` instead of a bare array, where `tone` comes from
  `headlineTone_` using ONLY the 92%/5% company standards (answer >=92%
  -> green "On track"; answer <92% OR abandon >=5% -> orange "Watch");
  absent metric / bare-array return -> neutral "At a glance". Wired for
  IR(single)/PR/CR/Insights (answer rate) + QCD/Inbound (abandon/answer);
  Missed + comparison-mode stay neutral. `.report-headline.is-good`/
  `.is-warn` tint the box + badge. (2) **Overview
  question launcher** (`initOverviewLauncher_`) -- four question chips
  on the Overview route into Insights / Missed / Individual / QCD
  pre-primed; Insights auto-runs via the one-shot `insLauncherAutoRun_`
  flag consumed in `insRenderAgentList` (the race-free post-roster
  point), Missed/QCD auto-run synchronously, Individual stops at the
  primed form. (3) **Metric glossary** -- `METRIC_GLOSSARY_` is the ONE
  place metric definitions live; `initMetricGlossary_`'s debounced
  MutationObserver applies them as `title=` to `th` + KPI-label
  elements + adds `.gloss` (which renders a circled-`i` `::after`
  indicator that FADES IN on hover/focus only -- not always-on -- via
  opacity so revealing it never shifts the label). A styled,
  ACCENT-BORDERED popover (`initGlossTooltip_` -> `.ds-tooltip`, border
  `var(--accent)`) replaces the unstyleable native `title=` tooltip on
  hover: one shared element, positioned via event delegation, reads the
  def from `title` and stashes it in `data-gloss` while shown to suppress
  the native popover (restored on leave -- the applier skips `data-gloss`
  elements so it can't re-add the title mid-hover). High-value terms
  (% answered / abandoned % / ATT / violations / TTT) get a RICH variant
  from `METRIC_GLOSSARY_RICH_` -- a bold title + def + an optional
  92%/5% benchmark chip -- stored on `data-gloss-rich` and rendered via
  innerHTML (dev constants only); `show()` prefers it + toggles
  `.ds-tooltip--rich`, else falls back to the plain-text `title`.
  Non-`.gloss` native `title=` tooltips (header buttons etc.) stay native.
  Add new terms to `METRIC_GLOSSARY_` (and a rich entry to
  `METRIC_GLOSSARY_RICH_` if it's a standards metric), NOT as inline
  `title=` in render code (the applier never clobbers an existing title,
  so per-callsite titles would shadow the dict). (4)
  **Benchmark tints** -- `benchValueCls_(label, formatted, symmetric)`
  applies the ONLY two company-wide standards (92% answer-rate target ->
  `.bm-target` sage; 5% abandon threshold -> `.bm-over` warn) to KPI tile
  values (IR/PR/CR/Insights/Inbound) + inbound abandon-% cells. Default
  is BINARY (highlight only the notable direction -- tables, IR tiles).
  The `symmetric` flag (passed `true` by the ds-kpi tiles -- `dsKpiTile_`,
  `crTeamTile_`, `inboundKpiTile_`) tints BOTH sides of the SAME 92%/5%
  standard, so a below-target answer rate reads orange "watch" and a
  healthy abandon rate reads green instead of plain black. Still no
  invented thresholds (only %-formatted answer/abandon values tint;
  counts/durations stay neutral); dept-specific alert thresholds stay
  with the Alerts engine. The bm-* tint wins on `.ds-kpi__value`/`__foot`
  via the two-class overrides in `styles.html` (the ds-* layer lands
  after `.bm-target`/`.bm-over`).
- **Per-report client prefs in localStorage.** Each report persists its
  own form state under `cdr.ir.prefs.v1`, `cdr.pr.prefs.v1`,
  `cdr.cr.prefs.v1`, and `cdr.ins.prefs.v2`. Bump the trailing version when the prefs schema
  changes; older saved blobs are silently dropped if JSON parsing
  fails. The chrome layer also writes `dash-mode` (light/dark toggle)
  and `dash-theme.v1` (warm / cool / clinical paper theme) — the
  theme picker re-reads these on every render so no cache bump is
  needed when palette tokens change. Default for first-time visitors
  (no `dash-theme.v1` value) is `cool` since the Phase A redesign
  rollout (commit 99e7253); explicit saved values, including `'warm'`,
  are preserved untouched. The `:root` tokens in `styles.html` remain
  the warm palette as the fallback for returning explicit-warm users
  (whose body carries no `data-theme` attribute). The Overview also
  stale-while-revalidate-caches its last successful payload under
  `cdr.ov.cache.v1:<email>:<role>` (Phase 5 / decision C6) — keyed per
  VIEWER so a cached blob never paints for a different user on a shared
  machine, and only the already-personalized payload the client received
  is stored (the server strips admin-only fields per-viewer first, INV-39).
  `ovLoad_` paints it instantly then revalidates; best-effort (any
  storage/parse error falls back to the normal fetch, and the live fetch
  always runs). Bump the `v1` if the Overview payload shape changes
  meaningfully.
- **CSS design-token conventions (post-redesign Phase A).** The
  dashboard's design system is centralized in `styles.html :root`;
  three conventions established by commit 99e7253 are worth respecting:
  (1) **`--bad` is for hard errors; `--warn` is for warnings.**
  `--bad` / `--bad-soft` are the deeper red for irrecoverable failure
  states (validation errors, fetch failures, access-denied UI). Only
  `.status-error` currently uses them. `--warn` / `--warn-soft` stay
  the default for negative-valence-but-not-fatal cases (low answer
  rate threshold, abandoned % warning, missed-delta orange,
  regression deltas). Reach for `--bad` deliberately when adding new
  error-state UI; don't blanket-replace existing `--warn` usage.
  (2) **`--r: 2px` is the canonical border-radius token.** New UI
  should use `var(--r)` for squared-off corners. Exceptions are
  intentional: `999px` pills/badges, `50%` avatars/dots, skeleton
  blocks (`.skeleton-line` 4px / `.skeleton-tile` 8px), and
  print-mode `border-radius: 0 !important` overrides. Five
  pre-Phase-A 6px / 8px callsites (alerts modal tables, QCD
  modal tables + view toggle, toast) were swept to `var(--r)`
  in the redesign cleanup commit (53d0560); bulk `2px`
  hardcodes (56 callsites) are visually identical to the token
  and intentionally left untouched. Email markup in `Alerts.gs`
  + `Digest.gs` keeps hardcoded radii because mail clients
  don't honor CSS custom properties.
  (3) **Uppercase mono kickers/eyebrows/labels use
  `letter-spacing: 0.18em`.** Mono numerics (blocks with
  `font-variant-numeric: tabular-nums`) use `letter-spacing: 0`.
  Swept across 47 selectors in commit 99e7253; new mono+uppercase
  selectors should match.
  *INV-42 follow-on:* `--bad` / `--bad-soft` are CSS-only — not yet
  mirrored into the JS `THEME` object or `refreshChartTheme()` in
  `script.html`. If a future phase surfaces error states in chart
  colors (Pipeline Health banner, etc.), extend `THEME` with
  `.bad` / `.badSoft` and resolve them via `colorToCanvasRgb_('--bad')`
  or chartjs-plugin-datalabels will silently render empty fills
  on the OKLCH path.
- **`ds-*` shared component layer (Phase 1 redesign — additive).** A
  canonical, token-driven component set lives at the END of
  `styles.html` (`.ds-kicker`, `.ds-section`, `.ds-chip`/`.ds-delta`,
  `.ds-kpi`, `.ds-card`/`.ds-card--rail`, `.ds-table`/`.ds-bar`,
  `.ds-banner`, `.ds-toolbar`/`.ds-seg`, `.ds-modal`) plus
  `.is-good`/`.is-warn`/`.is-bad` status helpers and additive tokens
  (`--r-sm`/`--r-lg`/`--r-pill`, `--shadow-1/2/modal`, `--ease`/`--dur-*`).
  It lands ALONGSIDE the legacy per-report dialects (`ir-`/`pr-`/`al-`/
  `ins-`/`cl-`/`of-`); reports migrate onto it one at a time. **Hard
  rules from the plan's conflict register (`docs/design-update-plan.md`):**
  (1) **`--r` STAYS 2px** — `ds-*` rounded corners use `--r-lg`/`--r-sm`/
  `--r-pill`, NEVER `var(--r)` (which is still the canonical 2px squared
  token); (2) status color is driven by the existing BINARY
  `benchValueCls_` (92% / 5%), NOT the design's invented 85%/8% bands;
  (3) dark mode is inherited via tokens — keep `body[data-mode="dark"]`,
  do NOT add the design's `[data-theme="dark"]` selector. Migrated so
  far: (a) the rollup KPI tile is the shared `dsKpiTile_` → `.ds-kpi`
  (Insights + Performance Report rollups — first cross-report `ds-*`
  component, the consolidation thesis; old `prKpiTile_` retired); (b) the
  **Individual Report** KPI tile (`irKpiTile`) → `.ds-kpi` via the
  `.ds-kpi--ir` density modifier + the extension sub-elements
  `.ds-kpi__value-row`/`__share`/`__compare`/`__team`/`__prior`/`__spark--inline`
  (the inline share tag + "Team X" average marker + vs-prior row the base
  tile lacked); (c) the **per-agent cards** in Insights (`insBuildCard_`)
  AND Compare Ranges (`crBuildCard_`) → `.ds-card--rail`, the classification
  stripe driven by an inline `--status` (improved=accent / regressed=warn /
  mixed=muted, floater=warn); (d) in Insights, the queue-health per-queue
  table (`.ds-table` inside a `.ds-card`). The Insights length-mismatch
  caveat is now an INLINE `.ins-length-flag` next to the compare line (warn
  glyph + hover tooltip, `insLengthFlagHtml_`), NOT a standalone banner;
  Compare Ranges still uses `.ds-banner is-warn`. The now-dead `.ir-kpi-*`
  tile / `.ins-card-*` / `.cr-card-*` dialect CSS was swept (kept
  `.ir-kpi-grid` container + `.ir-spark-svg`). The shared `reportHeadline_`
  is intentionally NOT migrated (every report uses it). Report consolidation
  (Part 3) and the nav restructure (Part 6) are parked product decisions,
  not built.
- **Pass-2 design additions (all client-only, additive, reduced-motion
  aware).** Five small `ds-*`/helper pieces from the Pass-2 review
  (`docs/design-update-pass2-review.md`) -- no server compute / cache /
  metric change: (1) **B1 change-flash** -- `dsFlashChanged_(root, scopeId)`
  + `DS_PREV_VALUES_` snapshot `[data-flash-key]` node text per scope and add
  a one-shot `.ds-flash` ONLY on a real change (`hasOwnProperty` guard -> never
  on first paint); wired at the end of `ovRender_` (scope `overview`, so the
  SWR cache->live swap pulses only what moved) and the My-Department
  `render()` (scope `dept:<dept>`, keyed on the answered/missed bar cell). (2)
  **A1 Insights triage** -- whenever more than one card is shown,
  `insRenderAgentCards_` stable-partitions a COPY of `sortedMain` (never
  `insLastData.agentData`, so the Cards<->Chart toggle is unaffected) by
  direction-of-change into "Needs attention" (regressed) / "Mixed" /
  "Improving" tier headers (`insTriageHeader_`, full-width grid items, tones
  warn/muted/good) -- a header renders before each NON-EMPTY tier + an A2 rail
  legend (`insTriageLegend_`); the existing quiet `<details>` stays the bottom
  tier. (Phase 15 made this ALWAYS-ON; it previously rendered the grouping
  only when at least one agent was regressed, so a healthy cohort showed a
  flat ungrouped grid.) (3) **Loaders** -- `dsRingsHtml_` (`.ds-loader--rings`) in
  Caller Lookup's `cl-loading` state; the honest single `.ds-loader--staged`
  bar (one label, no faked stages) on the Overview boot pane. (4) **Overview
  retry** -- a "Retry now" button on the `ovSetRefreshWarn_` banner re-runs
  `ovLoad_(true)`. (5) **Card-entrance motion** -- `.ds-card--rail` fade+rise
  (`ds-card-in`) + status-rail grow-in (`ds-rail-grow`). Deferred from Pass-2:
  count-up, segment-slide, skeleton crossfade, C2 chart-slot spark, D1b
  (reports keep-last-good), D2 (permission tone).
- **Team-Insights volume gating on a length mismatch.**
  `Util.gs::buildTeamInsights_` takes an optional `opts.excludeVolume`;
  Insights (`computeInsights_`) and Compare Ranges (`computeCompareRanges_`)
  pass `{ excludeVolume: lengthMismatch }` so a different-length comparison
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
- **CacheService key length cap (250 chars).** Apps Script silently
  rejects cache keys longer than 250 characters, surfacing as an
  error on `cache.get`. The Individual / Performance / Compare
  Ranges reports include the selected agent list in their cache
  key, which overflows on big rosters (Sales is the canonical
  trigger). `Data.gs::hashAgents_` MD5-hashes the sorted agent
  list to a 32-char hex digest so the compound key stays bounded
  regardless of selection size. Never concatenate raw agent names
  into a cache key — always go through `hashAgents_`.
- **CSV exports must neutralize formula injection.** Agent names
  originate from the external CDR feed and flow into client-side
  CSV downloads, so they're untrusted input to a spreadsheet app
  (Excel / Sheets treat a cell starting with `= + - @` / tab / CR
  as a formula). `script.html::csvSafeCell_` prefixes a single
  quote on such cells while preserving legitimate signed numbers,
  percentages, `pts`, durations (`H:MM:SS`), and thousands
  separators (so server-computed numerics aren't mangled). All
  three CSV escapers route through it: My Department
  (`exportTableCsv_`'s `csvEscape`), Compare Ranges (`crBuildCsv_`
  and `crCsvRow_`). Any new CSV cell writer must call `csvSafeCell_`
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
  wired on IR / PR / CR / QCD / Insights; IR/PR/CR/Insights persist it
  in their prefs blob, QCD in the standalone `cdr.qcd.datalabels` key.
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
  options — always go through `THEME.*`.
- **Overview layout: stacked full-width sticky chart + 4-wide grid
  (Pass 3b P2).** The Overview page was restructured from a
  side-by-side grid+rail into a STACK: the 30-day trend chart is a
  **full-width sticky-top band** (`.ov-trend-col`, `position:sticky;
  top:8px; z-index:5`, floated above the grid via CSS `order:-1` so
  the `dashboard.html` markup order is unchanged), and the dept-tile
  grid is **full-width below, 4-wide** (`.ov-dept-grid`
  `repeat(4,minmax(0,1fr))`, responsive 4→2→1). The retired side-rail
  was an intentional `#8` decision; it's safe to retire because the
  tile-hover→line-spotlight link works by **dept-name lookup**
  (`ovSpotlightDept_` matches `ds._deptName`), NOT DOM proximity, so
  the stack preserves it. Sub-queue **children render as dense chips**
  beneath the parent tile inside the `.ov-dept-group` cell
  (`ovBuildSubqChip_`: name + % answered + alert marker), each
  **expanding on click to the child's full tile** (`.ov-subq-tile-wrap`,
  hidden until expanded). The chips sit in the group cell, NOT inside the
  parent card — parent DQE metrics are independent, NOT a roll-up of
  children, so nesting them in would falsely imply aggregation. Chips
  carry `data-dept` so hovering one spotlights the child's chart line
  like a full tile; the expanded full tile keeps the admin route-to-dept
  click. (Superseded the earlier P1-hybrid "indented full child tiles".)
  The pinned band uses a moderate 340px height
  (`.ov-trend-col .ir-chart-wrap`) and un-sticks on short viewports
  (`@media (max-height:640px)`); the condense-on-scroll polish was
  intentionally skipped.
- **Overview trend chart conventions (Phase B).** Multi-dept overlay
  on the Overview page (`ov-trend-chart`): parent depts get solid
  2.2px lines with hue assigned from `IR_CHART_COLORS` in payload
  order; sub-queue children get dashed 1.4px lines (`borderDash:
  [4, 3]`) inheriting their parent's hue via the `colorByDept` map
  built up front in `ovRenderChart_` (so the parent → child color
  inheritance works even if children precede parents in the
  `depts` array). **The chart shows sub-queues BY DEFAULT now
  (`ovShowSubQueues_` defaults `true`) so they behave like other dept
  queues while staying visually linked (dashed + parent hue); the
  `sub-queues` checkbox (`#ov-subq-toggle`, `checked` by default) lets
  the user declutter to top-level depts only, re-rendering from
  `ovLastData`. Grid children are dense expand-to-tile chips (see the
  Overview layout bullet above).** A faint dashed 92% baseline (color
  `THEME.muted`) is drawn at `order: 99` so dept lines stay on
  top; the tooltip is filtered to hide the baseline from per-line
  hover. Fills are intentionally suppressed on this overlaid
  chart -- the soft-area gradient via `irGradientFill_` is
  reserved for single-series IR / PR trend tabs where it reads
  cleanly without 10+ overlapping fills competing. **The trend axis
  skips weekends** -- `trendIsoLabels` (built server-side in
  `CompanyOverview.gs`) drops Sat/Sun because the weekday-only work
  window makes them always-no-data, which otherwise rendered a
  sawtooth dip in every chart consuming the axis (per-dept card
  sparklines, the company sparkline, this chart). The Neon/sheet
  FETCH range stays the full calendar window so no weekday row is
  lost. **Interactivity (shared `chartSpotlight*` helpers in
  `script.html`):** hovering a legend item dims the others
  (transient preview); clicking one PINS/isolates it (persistent
  dim of the rest -- click again or another to release/switch);
  `skipLabel` keeps the 92% baseline out of the dimming. Hovering a
  dept TILE spotlights that dept's line (`ovSpotlightDept_`, no-ops
  while a pin is active); clicking a POINT deep-links into that
  dept + date's My Department view (`ovHandlePointClick_` ->
  `ovRouteToDept_(dept, iso)`; admins, or a manager clicking their
  own dept's line). An axis-zoom toggle button (`ov-axis-zoom-btn`)
  flips the y-axis between Full (0-100%) and Fit (auto-scale to the
  data range). The same `chartSpotlight*` legend spotlight is reused
  by the QCD multi-queue chart.
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
  redeploy. The display-only constant `ADMIN_EMAILS_DISPLAY` exists
  for the `access_denied` template's mailto link — **never read it
  for membership checks**; always go through `getAdminEmails_()` so
  the Script Property's value wins.
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
  header doesn't show a stale fallback. The single-source
  `getLatestDataDate` is kept for the My Department From/To
  default (which must snap to DQE specifically -- the agent
  table draws from DQE).
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
  Config` sheet (INV-54). A dept with no effective queues renders an
  empty QCD modal with a "No queues mapped" hint and no Overview QCD
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
  trend-window helper), and `logReportUsage_` (the INV-01 telemetry
  carve-out) were consolidated from their
  original host files (Alerts.gs, IndividualReport.gs,
  PerformanceReport.gs). `classifyAbandonedCell_` (the read-side guard
  that excludes coerced/lost abandoned AD/AF cells from the Missed Calls
  report's counts -- see the number-coercion gotcha above) also lives
  here. Put new shared helpers here; the implicit
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
  write connection. History: these were original gaps (never present),
  not a regression — the phone-child write shipped in commit 771f227 with
  a 200-row per-chunk commit, double connection, and un-memoized HMAC, and
  a ~4k-phone day took ~17 minutes. A future "move the mirror off the
  synchronous import path" (its own trigger) is the next lever if the
  budget is still tight after these.
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
  and **#4 the IR / PR / CR builders**. Each reads the windowed rows from
  Neon when flagged and STILL reads a cheap cols-A..D slice for
  `getDeptQueueExts_`'s all-history derivation. Each cutover is
  `getDqeReadSource_()`-gated and falls back to the sheet on any
  null/empty/error, so flipping the flag is reversible with no redeploy;
  every cutover reader emits a `[dqe-read] <label> source=<neon|sheet>
  rows=<n> ms=<elapsed>` line (`logDqeReadTiming_`, NeonRead.gs) so
  sheet-vs-neon read cost is directly comparable in the Executions panel.
  Reuses the dashboard `NEON_*` props + `script.external_request`
  scope (Operator State #18-19). ALL DQE readers are now cut over: the final
  two -- **Missed Calls** (via `neonFetchDqeRows_(from, to,
  { includeMissedDetail: true })`, which adds the 19 slot_* columns +
  abandoned_parent_ids/_missed_times; a grid adapter
  (`missedGridsFromDal_`) feeds the UNCHANGED compute loop) and
  **`computeActiveAgentsInRange_`** (the IR/PR/CR/Insights agent-picker
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
  `getDisplayValues`, INV-02-safe; field mappings faithful to
  neonbackfill.js + the inline shapes -- incl. routing the coercion-prone
  abandoned ID/time columns AD/AE/AF through a byte-identical copy of
  `sanitizeAbandonedCellForNeon_` in NeonMirror.js so the deferred mirror
  writes the `#REBUILD` sentinel / recovered value rather than coerced
  garbage, exactly like the backfill, F3 -- keep that helper in sync with
  the cdr-report/neonbackfill.js copy; it is NOT covered by
  `scripts/check-duplicated-files.sh`) and upserting via the SAME local
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
  inside every public function.
- **`SPREADSHEET_ID` lives in Script Properties**, not in code. Lets dev
  and prod copies of the dashboard run from the same source without
  edits.
- **Per-project gitignored `.clasp.json`**. Each developer keeps their own
  `scriptId` locally; pulls never conflict on it. Template at
  `.clasp.example.json`.
- **CacheService tiers**: 30 min (`REPORT_CACHE_TTL_SECONDS`) on the heavy
  per-(dept,range) aggregations (My Department `summary`, `companyOverview`,
  `individual`, `individual_active`, `performance`, `compareRanges`, `qcd`,
  `missed`); 5 min (`CACHE_TTL_SECONDS`) on the freshness-sensitive
  `latestDate` / `latestDates` lookups so the morning ingest surfaces
  promptly; 60 sec on auth lookups (`AUTH_CACHE_TTL_SECONDS`). The 30-min
  tier is safe because DQE data updates once daily; the tradeoff is that
  ad-hoc admin corrections (orphan renames, DQE rebuilds) can lag up to
  30 min in cached views not explicitly busted on write (Orphan Fix +
  Dept Config save bust theirs). Each report file owns its own versioned
  cache prefix (`summary:`, `latestDate:`, `individual:`,
  `individual_active:`, `performance:`, `compareRanges:`, `missed:`,
  `companyOverview:`); bump the relevant version on any aggregation-rule
  change. See INV-30 for current versions.
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
  report's queue-only ABANDONED section is unaffected** -- queue-
  sentinel rows are always included by `computeMissedCallsReport_`
  regardless of scope (INV-23), so genuinely-abandoned no-ring
  queue calls still surface. **The internal
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
- **Multi-page architecture: Overview + My Department + Escalations.**
  The dashboard is one HTML doc with top-level `<section>` pages toggled
  by `body[data-page="overview|dept|escalations"]` (the `.page` CSS shows
  only the active one; generalized from the original two-page pair when
  Escalations became a full page, #6). **Overview is the default
  landing** for every page load; "My Department" is the per-dept
  agent table view that used to be the landing; **Escalations** is a
  full page (route `#/escalations`) — an interactive worklist, not a
  modal (it was converted from one). `setPage(name)` swaps the page,
  the header kicker/title, and triggers that page's load (Overview ->
  `ovLoad_`; Escalations -> `escEnsureInit_`+`escLoad_`). Modals (Help,
  Settings, Missed Calls, Individual / Performance / Compare
  Ranges, QCD Report, Alerts, Orphan Fix, Dept Config) overlay any page.
  Overview auto-refreshes silently every 5 minutes when the
  page is active, re-fetching from the server cache. Admin
  clicks on Overview dept tiles route to the dept page via
  `setPage('dept')` + a dept-selector swap. **`refresh()` only writes
  the header title when `data-page === 'dept'`** so it can't clobber the
  Overview / Escalations titles.
- **Overview-only sub-queue nesting.** `OVERVIEW_PARENT_OF` and
  `OVERVIEW_HIDDEN_DEPTS` in CompanyOverview.gs shape the Overview
  page only — dept dropdowns, Reports modals, and Alerts treat
  every dept as independent. Adding a sub-queue means: (1) it
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
  knows they're previewing. The per-viewer Overview SWR cache
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
  `bulkBackfill:DQE`, per INV-44) appears in the last 40 Pipeline
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
  `personalizeOverview_`; `companyOverview:v17`).
- **Top-tab router (Phase C).** The header nav was flattened from
  Reports + Admin dropdowns into a single row of top-level tab
  buttons (commit ce4220a). Each tab carries a `data-route`
  attribute and a stable button `id`, so the existing per-modal
  init functions still wire up modal-open behavior unchanged; the
  new `initRouter` in `script.html` just tracks `currentRoute` and
  paints the active-tab indicator via `updateTabActiveState_`. Two
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
  four agent reports (IR / PR / CR / Insights) the button also
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
  the 7 report routes (`#/report/missed`, `#/report/individual`,
  `#/report/performance`, `#/report/compare`, `#/report/qcd`,
  `#/admin/alerts`, `#/admin/orphan-fix`) plus the three PAGE routes
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
  in `sortRows`) · Unique · TTT · ATT · Avg Abd Wait · CSR Avg Abd Wait. The
  four `hideable:true` columns (Unique / TTT / Avg Abd Wait / CSR Avg Abd
  Wait) FOLD AWAY by default behind the **"Show all columns"** toggle
  (`#dept-cols-toggle`, persisted in `cdr.dept.cols`, applied via the
  `hide-extra` class + `.col-extra` cells through the shared `cellClass_`
  helper); the Overview mini-table carries `hide-extra` permanently
  (glance view). Default sort is `answerRate` ascending (worst answer rate
  first; idle/no-activity agents always sink to the bottom regardless of
  direction). CSV export (`exportTableCsv_`) emits ALL columns regardless
  of the toggle and renders the bar as `answered / missed (rate%)` text.
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
  the tfoot first-cell renders 'Total (roster only · N floaters
  excluded)' when `queueOnlyAgentCount > 0`. CSV export uses the
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
  machinery survive for the IR/PR/CR pickers (which DO still surface
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
- **My Department CSV export.** The agent table has a "Download CSV"
  button (hidden until data loads) that exports the current view
  (respecting scope, date range, and sort order) as a client-side
  CSV download. No server round-trip.
- **Draggable / resizable modals.** All 9 modals can be
  repositioned via header drag and resized via a bottom-right
  corner handle. Position and size reset on close so the next
  open starts centered at default size. Disabled below 768px
  viewport width (mobile).
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
  `initHelpNav_` with a title+body search box. Add a topic = a nav
  `.help-link[data-topic=KEY]` + a `<section id="help-topic-KEY">`; all
  static markup in `dashboard.html`, no server endpoint.

## Operator State Checklist

When something looks wrong, before assuming a code bug, check:

1. Did the daily ingest run? Verify the latest date in `DQE Historical Data` (CDR Report sheet).
2. Did the dashboard's deployed version include the latest code? Apps
   Script editor → Deploy → Manage deployments → check the timestamp.
3. Did the user actually have access? `Access Control` sheet rows are
   case-sensitive on email.
4. Is the cache stale? Bump the relevant per-report prefix (see INV-30)
   or wait out the TTL -- up to 30 min for the heavy report aggregations
   (`REPORT_CACHE_TTL_SECONDS`), 5 min for the latest-date + freshness
   pill lookups (`CACHE_TTL_SECONDS`).
5. Did the source-pipeline bugs (window inclusion / ATT denominator / leg
   attribution — see `known-issues.md`) get re-introduced? Spot-check Sonia
   2026-03-09: TTT should be `0:15:03`, ATT should be `0:03:01`.
6. After pulling new code that adds sheets, was `setup()` re-run?
   `setup()` requires admin auth (`assertAdmin_()`) — run from the
   Apps Script editor while logged in as an admin listed in
   `ADMIN_EMAILS` Script Property (or `ADMIN_EMAILS_FALLBACK`). It
   creates `Access Control`, `Alert Config`, `Alert Log`,
   `Pipeline Health`, `Digest Config`, `Agent Alias Overrides`,
   `Orphan Fix Log`, `Dept Config`, and `Report Usage` -- whichever are missing. Idempotent on re-runs
   (existing data untouched). Without re-running setup() after a
   fresh pull, downstream writers (Pipeline Health appends, Digest
   config reads, Orphan Fix log appends) silently no-op against
   the missing sheet, and the Orphan Fix modal will throw "sheet
   missing -- run setup()" on first write.
7. For alerts AND report-modal new-tab buttons: is the
   `DASHBOARD_URL` Script Property set? Two consumers since Phase C
   (commit ce4220a): (a) the "Open Dashboard" link in alert emails
   — without the property, emails still send but omit the link;
   (b) the `↗ Open in new tab` buttons on every report modal —
   without the property, the buttons silently hide via
   `.is-disabled` and the side-by-side comparison flow doesn't
   work. Strongly recommended; set in the dashboard project's
   Script Properties to the deployed `/exec` URL.
8. Are all three trigger types installed? Three independent triggers
   now feed the dashboard's freshness, and each one missing is a
   silent failure:
   - **Daily alerts**: dashboard project → Triggers should list
     `runDailyAlerts_` (or install via the Alerts modal). Without
     it, alerts only fire when an admin clicks "Send alerts".
   - **Daily DQE build** is now integrated into cdr-import's
     `processIntegratedHistory` (5th block; INV-16 expanded). Each
     successful daily import now refreshes DQE Historical Data
     alongside CDR / Q Path / QCD / CSR. The bulk-backfill path
     (`bulkHistoricalUpdate`) also builds DQE per-date now, logged
     as `bulkBackfill:DQE`. The cdr-report project's standalone
     `runDailyDQEBuild_` trigger is preserved as a safety net
     during stabilization; uninstall after the integrated path
     proves reliable. Look for `processIntegratedHistory:DQE`
     (or `bulkBackfill:DQE` if a backfill ran) rows in Pipeline
     Health (INV-44) -- present = integrated path working.
     Absent only = either no import ran today OR the DQE block
     specifically failed (the autoImport row will still be
     `success`; check the cdr-import execution log).
   - **Daily + weekly digests**: dashboard project → Triggers should
     list `runDailyDigests_`, `runWeeklyDigests_`, and `runMonthlyDigests_` (or install
     via Alerts modal → Manager Digest Subscribers → Install). Without
     them, Digest Config rows have no effect.
9. Did the latest push add a new OAuth scope? Open the Apps Script
   editor → Run → any function → grant the new permission. Scope-
   gated calls (trigger install, mail send) otherwise throw
   permission errors at runtime even though the dashboard page
   loads fine.
10. After adding a sub-queue to `OVERVIEW_PARENT_OF`, verify the
    key matches the `DO NOT EDIT!` column header byte-for-byte
    (case, spaces, and any ` Q` suffix). Mismatches show up as a
    `Logger.log` warning in the project's Stackdriver / execution
    log on every `getCompanyOverview` call; the sub-queue still
    renders as an unrelated top-level dept until the key is
    fixed. Use both spellings as aliases if you're unsure.
11. Pipeline Health sheet: open the dashboard's Alerts modal →
    Pipeline Health section. A long quiet stretch on `autoImport`
    (or on any of the DQE-freshness step names -- `buildDQE`,
    `processIntegratedHistory:DQE`, `bulkBackfill:DQE`; see
    INV-44 for the full list) with rows from 2+ days ago and
    nothing since means the daily ingest or DQE rebuild hasn't
    run. Cross-check with Operator State #1 + #8. An empty sheet
    right after deploy means setup() hasn't been re-run on this
    project. Phase B (commit 9b1f263) adds a Pipeline Health
    banner above the Overview summary line that warns admins
    when no DQE-freshness success has landed in the last 36h --
    same staleness condition without opening the Alerts modal.
    If the banner fires, fall through to this checklist item to
    investigate.
12. Manager digest delivery: if a subscriber says they didn't get
    their digest, check (a) Digest Config row Active=TRUE,
    (b) Cadence is `daily`, `weekly`, or `monthly` (normalized -- other values
    are dropped), (c) digest triggers installed (#8), (d) admin
    inbox for a `notifyDigestFailure_` email if the run threw.
13. `ADMIN_EMAILS` Script Property: if a recently-added admin
    doesn't see admin-only features, verify Project Settings →
    Script Properties → `ADMIN_EMAILS` includes their email
    (comma-separated). Without the property, `getAdminEmails_()`
    falls back to `ADMIN_EMAILS_FALLBACK` in Config.gs (which
    requires a redeploy to change).
14. QCD modal empty for a dept, OR no Overview QCD chips, OR
    "Queue Call Data" tiles missing on My Department? Confirm the
    dept's effective queue list (`getDeptQcdQueues_(dept)`) lists the
    right `A_Q_*` queue names. Open `QCD Historical Data` col D for
    recent rows to see the canonical values written by the import
    pipeline (the admin **Dept Config** modal auto-discovers these
    and flags unmapped queues). Fastest fix: open the Dept Config
    modal (admin), pick the dept, and add the queue names -- takes
    effect on the next request, no redeploy (INV-54). Alternatively
    add/edit the `DEPT_QCD_QUEUES` constant + redeploy. New depts
    producing QCD data don't surface until they're mapped one of
    these two ways.
15. `TARGET_SS_ID` Script Property in CDR Import: must point at
    the CDR Report spreadsheet ID. Without it, `getTargetSsId_()`
    falls back to a hardcoded ID that may not match your install.
    Set in CDR Import project → Project Settings → Script Properties.
16. Neon Script Properties in CDR Import: `NEON_HOST`, `NEON_DB`,
    `NEON_USER`, `NEON_PASS` must be set in the CDR Import project's
    Script Properties (same values as the CDR Report project).
    Without them, Neon mirror writes from the import pipeline are
    silently skipped (logged as "Neon unreachable").
17. `HMAC_SECRET` Script Property: must be set in the CDR Import,
    CDR Report, AND (since Caller Lookup) the Department Dashboard
    project's Script Properties (same value in all three).
    Used by `writeCDRRowsToNeon` and `hashPhone` (dbHistorical.js,
    reused by the insurance-number sync) to
    HMAC-SHA256 hash phone numbers for PHI protection, and by the
    dashboard's `getCallerLookup` to hash the queried number so it
    matches `inbound_calls.caller_hash`. Without it, CDR Neon mirror
    rows still write (main metric columns) but JSONB name-list fields
    and `call_history_phones` child rows are skipped; the Caller
    Lookup modal renders an "HMAC_SECRET not set" hint
    (meta.configured=false) instead of failing.
18. Neon Script Properties + scope on the DASHBOARD project (for
    orphan-rename-to-Neon): `NEON_HOST`, `NEON_DB`, `NEON_USER`,
    `NEON_PASS` must also be set on the Department Dashboard project
    (same values), and the `script.external_request` OAuth scope
    (added to `appsscript.json`) must be consented -- after deploying,
    Run any function once in the editor (per #9). Until both are done,
    `applyOrphanRename`'s Neon mirror cleanly no-ops (logs "NEON_HOST
    not set") and the sheet rename still succeeds. This is the only
    place the dashboard WRITES to Neon.
19. `DQE_READ_SOURCE` Script Property (dashboard) -- the F1 Neon
    read-back switch read by `getDqeReadSource_()`. Unset / `sheet`
    (default) = dashboard reads the `DQE Historical Data` sheet as
    always; `neon` flips the cut-over readers (`getLatestDataDate`,
    `getCompanyOverview`, `computeSummary_`, and the IR / PR / CR /
    Insights builders; the `getDeptQueueExts_` derived scan also reads
    Neon via `neonGetAgentExtPairs_`; Missed Calls + the
    `computeActiveAgentsInRange_` picker subset are cut over too as of
    the DAL-cutover phase -- parity pinned by tests/unit/dal-cutover.test.js)
    to read `dqe_history`. **Only flip to `neon` after `compareDqeSources_`
    (NeonRead.gs, editor-run via the `runDqeParityCheck` wrapper -- the Run
    picker hides `_`-suffixed functions) shows parity-clean over a
    representative range AND `dqe_history` is fully backfilled** -- otherwise the read-back serves data that lags the
    sheet. Reversible with no redeploy (set back to `sheet`); cut-over
    readers also fall back to the sheet on any Neon error. After a bulk
    rebuild (which defers the DQE->Neon mirror via `skipNeon`), run
    `backfillDQEHistoryUpsert()` (cdr-report) to populate/refresh
    `dqe_history` before relying on the read-back. The Alerts modal
    shows a **Neon mirror health** line (`computeNeonMirrorHealth_`:
    sheet vs `dqe_history` `MAX(call_date)`) so a stale mirror is
    visible at a glance; a transient outage that left a date
    un-mirrored self-heals on the next import of that date -- the
    dup-guard re-mirrors the existing sheet rows to Neon (F2). The
    Alerts modal ALSO shows a **Neon read-back health** line
    (`computeNeonReadHealth_`, surfacing the durable `NEON_READ_LAST_ERROR`
    streak `recordNeonReadFailure_` writes): a failing Neon read-back
    -- which silently falls back to the sheet, so a sustained outage
    would serve stale data once the sheet ages -- is now visible to
    admins. The line renders only when Neon is configured AND (reads
    are on `neon` OR a failure is on record), warn-tinted with the
    last error + consecutive-failure count, cleared on the next
    successful read. The parity gate `compareDqeSources_` reads the
    optional `DQE_PARITY_FROM` / `DQE_PARITY_TO` Script Properties for
    its range (in-source defaults if unset).
20. Neon keep-warm (optional; only relevant once `DQE_READ_SOURCE=neon`).
    Toggle from the Alerts modal → **Neon keep-warm** section
    (`NeonKeepWarm.gs`). When enabled it sets `NEON_KEEPWARM_ENABLED=true`
    and installs the `keepNeonWarm_` trigger (every 5 min, gated to a
    weekday window). Tune the window via the `NEON_KEEPWARM_START_HOUR` /
    `NEON_KEEPWARM_END_HOUR` Script Properties (defaults 7 / 13 Central);
    the modal shows the estimated monthly compute-hours so you stay under
    the Neon free allowance (~190h). Needs the dashboard `NEON_*` props +
    `script.external_request` + `script.scriptapp` scopes (same as the
    read-back + alerts trigger). If keep-warm shows "unreachable" pings,
    check the `NEON_*` props; pings no-op cleanly when Neon is unconfigured.
    A keep-warm ping failure does NOT pollute the DQE read-back health line
    (it connects via `getDashboardNeonConn_({skipReadHealth:true})`), so a
    warm-ping blip can't show a sticky false "read-back FAILING" while reads
    are still on the sheet -- that signal reflects actual DQE reads only (F29).
21. Report cache warming (optional; `CacheWarm.gs`). Toggle from the Alerts
    modal → **Report cache warming** section (`installCacheWarmTrigger` /
    `uninstallCacheWarmTrigger`, both `assertAdmin_`-gated). When enabled it
    installs the `warmReportCaches_` daily trigger (default `CACHE_WARM_HOUR`
    = 9 Central, after the morning ingest), which pre-warms the Overview blob
    + each dept's My Department default-range summary so the first manager of
    the day gets a cache hit instead of a cold aggregation. **Must run in the
    dashboard project** -- CacheService is per-project, so the cdr-import
    ingest can't warm it. "Warm now" (`warmReportCachesNow`, admin) primes on
    demand. Reuses `script.scriptapp`; independent of `DQE_READ_SOURCE`
    (helps the sheet path too). Best-effort: per-dept failures are logged,
    last outcome shown in the modal.
22. Deferred Neon mirror (optional; `NeonMirror.js`, CDR Import). Defaults OFF
    -- the daily import mirrors to Neon inline as before until you opt in.
    To move the mirror off the synchronous import path: (a) run **CDR Tools →
    Install Neon Mirror Trigger** in the cdr-import project (installs
    `runNeonMirror_`, every 15 min; needs `script.scriptapp`), then (b) set the
    cdr-import Script Property `NEON_MIRROR_MODE=deferred`. The import then
    enqueues each date to the `Neon Mirror Queue` tab and the trigger mirrors
    it shortly after; the daily toast shows `Neon ⏳ queued` and per-type
    outcomes appear as `neonMirror:*` Pipeline Health rows. Verify on one
    import (queue drains, `neonMirror:*` success rows, dashboard data current)
    before relying on it. Reversible: set `NEON_MIRROR_MODE=inline` (or clear).
    Once trusted, uninstall the cdr-report `runDailyDQEBuild_` safety-net
    trigger so DQE isn't mirrored both inline and via the queue (harmless but
    redundant). Needs the same `NEON_*` props the inline mirror uses (#16).
23. Ingest-failure watchdog (optional; `IngestWatchdog.gs`, dashboard).
    Defaults OFF. PUSHES the same staleness signal the Overview Pipeline
    Health banner / freshness pill show passively: a weekday-morning
    time trigger (`runIngestWatchdog_`) checks DQE freshness via the
    SAME `computeOverviewPipelineFreshness_` (OVERVIEW_PIPELINE_STALE_HOURS
    = 36h) and emails `getAdminEmails_()` when no fresh DQE build has
    landed -- i.e. the daily import or DQE rebuild silently didn't run.
    Enable by running `installIngestWatchdogTrigger()` from the dashboard
    editor (admin; sets `INGEST_WATCHDOG_ENABLED=true` + installs the
    trigger); `uninstallIngestWatchdogTrigger()` reverses it. Emails ONCE
    per stale episode (re-arms on the next fresh build), skips weekends,
    and treats a null freshness read as inconclusive (no false alarm).
    Tunable Script Properties: `INGEST_WATCHDOG_HOUR` (0-23, default 10
    Central) and `INGEST_WATCHDOG_STALE_HOURS` (default 36). Reuses
    `script.scriptapp` + `script.send_mail` (no new scope); best-effort
    (never throws). Complements the passive banner (#11) -- the banner is
    pull, this is push.
24. Escalations notification + activity-trail migration (optional;
    `Escalations.gs`, dashboard; INV-55). (a) **`NOTIFY_ON_NEW_ESCALATION`
    Script Property** -- set to `'true'` to email the dept's managers
    (`lookupDeptManagers_`, Access Control rows) on every new escalation.
    Defaults OFF. The email carries FULL escalation detail (caller / patient /
    Trx / reason) -- a PII surface -- so leave it off until that's signed off.
    Best-effort (never blocks/fails the create); needs `script.send_mail`
    (already present) + `DASHBOARD_URL` for the deep link. (b) **§5 activity
    trail**: the `escalation_activity` table is auto-created on first write
    (no setup() change). After deploying, run the admin editor function
    `backfillEscalationActivity()` ONCE to seed `created`/`resolved` rows for
    escalations logged before the trail existed (idempotent, safe to re-run);
    otherwise their Activity timelines render only events that happen post-deploy.
25. `CONFIG_SOURCE` Script Property (dashboard) -- the C2 Dept Config
    read+write source switch read by `getConfigSource_()`. Unset / `sheet`
    (default) = Dept Config is read+written on the `Dept Config` SHEET as
    always (byte-identical to pre-C2). `neon` flips `readDeptConfigRows_` to
    read the Neon `dept_config` table (one `json_agg` fetch, falls back to the
    sheet on any error/unreachable) AND routes `saveDeptConfig`/`removeDeptConfig`
    writes to that table (`neonUpsertDeptConfigRow_` / `neonDeactivateDeptConfig_`;
    list cols stored as the same comma-joined text so `dcParseList_` parity is
    exact). **Only flip to `neon` after `backfillDeptConfigToNeon()` (editor-run,
    admin) copies the sheet rows AND `compareDeptConfigSources()` reports parity
    clean.** Reversible with no redeploy (set back to `sheet`); to revert
    cleanly after edits were made in Neon, copy them back to the sheet first.
    `dept_config` is created lazily (`CREATE TABLE IF NOT EXISTS`, no setup()
    change). Parity pinned by `tests/unit/dept-config-neon.test.js`. Needs the
    dashboard `NEON_*` props + `script.external_request` scope. (First of the
    config-sheets-to-Neon migration, `docs/ui-infra-roadmap.md` Track C.)
    **C3 extends the SAME flag to Alert Config + Digest Config readers**
    (`readAlertConfig_` / `readDigestConfig_` now pull rows from
    `alert_config` / `digest_config` when `CONFIG_SOURCE=neon`, identical
    parse, sheet fallback on error; backfills `backfillAlertConfigToNeon()` /
    `backfillDigestConfigToNeon()` + parity `compareAlertConfigSources()` /
    `compareDigestConfigSources()`; pinned by `tests/unit/config-neon-c3.test.js`).
    **C3 edit UIs SHIPPED:** the Alerts modal now has admin edit forms for both
    Alert Config (per-dept threshold/recipients/skip-dates, key=department) and
    Digest Config (subscribers, key=(email,department)) -- `saveAlertConfigRow` /
    `removeAlertConfigRow` (Alerts.gs) + `saveDigestConfigRow` /
    `removeDigestConfigRow` (Digest.gs), each writing the ACTIVE source. So C3
    is now flippable: backfill (`backfillAlertConfigToNeon` /
    `backfillDigestConfigToNeon`) -> compare (`compareAlertConfigSources` /
    `compareDigestConfigSources`) clean -> set `CONFIG_SOURCE=neon`. (One flag
    governs Dept + Alert + Digest config sources together.) Access Control is
    deliberately NOT in this flag -- it stays sheet-backed (auth availability),
    managed by the C1 editor.
26. Direct-call history backfill (cdr-import; only relevant if you want Direct
    history for past dates rather than going-forward-only). The bulk-backfill
    path (`bulkHistoricalUpdate`) now builds `Direct Call History` per date with
    the Neon mirror DEFERRED (`skipNeon`), exactly like DQE. **After a bulk
    rebuild, run `backfillDirectCallToNeon()` from the CDR Import editor** to
    mirror those dates to `direct_call_history` (`ON CONFLICT DO UPDATE`); the
    bulk-complete alert reminds you. Tunable Script Properties (cdr-import):
    `DIRECT_UPSERT_RESUME` (resume index; clear to re-run from the top) and
    `DIRECT_UPSERT_SINCE` (YYYY-MM-DD date floor, so you mirror only the
    recently-rebuilt dates). Idempotent (re-run safe); reuses the same `NEON_*`
    props the inline mirror uses (#16). The daily import already mirrors Direct
    inline, so this is ONLY for the bulk path. Recommended only after the busy
    carve-out numbers are spot-checked (the report stays admin-only while
    vetted, and this writes Direct history across all backfilled dates).

## Cycle Workflow Config

### Test Command
node --test

(Regression harness, Phases 1-4 -- zero-dep Node `node:test` suites
under `tests/unit/`, run from the repo root; see `tests/README.md`.
Covers pure logic (parsing, `hashAgents_`, Util, the INV-54 Dept
Config accessors), the `computeSummary_` aggregator
(INV-02/04/05/23/53, S35, E5), the IR/PR/CR report builders (INV-25
weighted ATT, INV-28 prior-period, INV-35 length-mismatch, INV-53),
pipeline canonicalization (INV-24/46 + INV-16 cross-project), the
INV-29 trend window (`computeTrendStartDate_`, trend-window.test.js),
and the end-to-end `buildDQEHistoricalData` build (INV-07/08/20/21 +
dup guard). NOT yet covered: the Pass-4 queue-only sentinel rows and
the Neon mirror writers -- the manual Regression Scenarios remain the
verification of record for those, so walk the scenarios that overlap a
change in addition to running `node --test`.)

### Health Dimensions
Data Accuracy (DQE), Access Control Integrity, Source Pipeline Reliability, Migration Progress, Cross-Project Consistency, Documentation Freshness, Performance & Cache Effectiveness, Error Surfacing & Observability, Manager-Facing UI Polish, Deployment Hygiene, Code Health

### Subsystems
Department Dashboard:
  apps-script/department-dashboard/Auth.gs, apps-script/department-dashboard/Code.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/Diagnostics.gs, apps-script/department-dashboard/Setup.gs, apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/NeonRead.gs, apps-script/department-dashboard/NeonKeepWarm.gs, apps-script/department-dashboard/CacheWarm.gs, apps-script/department-dashboard/IngestWatchdog.gs, apps-script/department-dashboard/MissedCallsReport.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/PerformanceReport.gs, apps-script/department-dashboard/CompareRangesReport.gs, apps-script/department-dashboard/InsightsReport.gs, apps-script/department-dashboard/InboundReport.gs, apps-script/department-dashboard/DirectCallReport.gs, apps-script/department-dashboard/CallerLookup.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/CompanyOverview.gs, apps-script/department-dashboard/Digest.gs, apps-script/department-dashboard/OrphanFix.gs, apps-script/department-dashboard/QCDReport.gs, apps-script/department-dashboard/DeptConfig.gs, apps-script/department-dashboard/Escalations.gs, apps-script/department-dashboard/access_denied.html, apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script.html, apps-script/department-dashboard/styles.html, apps-script/department-dashboard/appsscript.json

CDR DQE Pipeline:
  apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-report/DQEdrilldown.js, apps-script/cdr-report/DQEDrilldownSidebar.html, apps-script/cdr-report/dataFilters.js, apps-script/cdr-report/CDR Tools menu.js, apps-script/cdr-report/appsscript.json

CDR Reporting Tools:
  apps-script/cdr-report/dashboardCDR.js, apps-script/cdr-report/dbHistorical.js, apps-script/cdr-report/dbReporting.js, apps-script/cdr-report/emailDailyReport.js, apps-script/cdr-report/neonbackfill.js, apps-script/cdr-report/neonWrite.js, apps-script/cdr-report/inboundCallsExport.js, apps-script/cdr-report/insuranceNumbers.js, apps-script/cdr-report/sheetRepairs.js

CDR Import:
  apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/CDR Tools.js, apps-script/cdr-import/DeleteOldSheets.js, apps-script/cdr-import/autoImport.js, apps-script/cdr-import/buildDQEHistoricalData.js, apps-script/cdr-import/importBulkCSVsFromDrive.js, apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/NeonMirror.js, apps-script/cdr-import/directCallMetrics.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-import/appsscript.json

DQE Report Legacy:
  apps-script/dqe-report/DQEdashboard.js, apps-script/dqe-report/FAQGuide.html, apps-script/dqe-report/IndividualReport.js, apps-script/dqe-report/IndividualReportModal.html, apps-script/dqe-report/MissedCallsReport.js, apps-script/dqe-report/MissedReportModal.html, apps-script/dqe-report/MultiCompModal.html, apps-script/dqe-report/MultiComparisonTool.js, apps-script/dqe-report/SingleRangeReport.js, apps-script/dqe-report/SingleReportModal.html, apps-script/dqe-report/menu DQE Tools.js, apps-script/dqe-report/sendManualAlert.js, apps-script/dqe-report/showFAQ.js, apps-script/dqe-report/appsscript.json

### Invariant Library
INV-01 | No public function (callable via google.script.run) writes to any spreadsheet EXCEPT admin-gated paths: `OrphanFix.gs` (`addAgentAlias`, `removeAgentAlias`, `applyOrphanRename`, `addOrphanToRoster` -- the New-hire flow appends one "Name, ext1, ext2" cell to a dept's DO NOT EDIT! column; extensions REQUIRED, write structurally confined to the dept block by the first-blank-terminated header scan), `setup()` in `Setup.gs` (sheet creation), `DeptConfig.gs` (`saveDeptConfig`, `removeDeptConfig` -- config-sheet writes, INV-54), `Auth.gs` (`saveAccessControlRow`, `removeAccessControlRow` -- the C1 manager-access editor; writes the Access Control SHEET, upsert-by-email / delete-by-email, busts the per-email auth cache), and the C3 config editors `Alerts.gs` (`saveAlertConfigRow`, `removeAlertConfigRow` -- per-dept alert threshold/recipients, key=department) + `Digest.gs` (`saveDigestConfigRow`, `removeDigestConfigRow` -- digest subscribers, key=(email,department)); both write the ACTIVE config source (sheet, or Neon when `CONFIG_SOURCE=neon`). Every other write-capable helper ends in `_` so Apps Script blocks it from RPC. All carve-outs start with `assertAdmin_()`. The OrphanFix path (data-mutation) additionally has input-validation (queue-sentinel names rejected, length-capped, canonical destination must be on some roster), `LockService` serialization, and `Orphan Fix Log` audit trail. The DeptConfig path (config, not data-mutation) has `assertAdmin_()` + save-time validation + `LockService` + an Updated By/At row stamp. The Access Control editor path (config) has `assertAdmin_()` + input validation (email shape + a real dept) + `LockService` + a `Logger.log` audit line; it manages MANAGERS only (admins live in the `ADMIN_EMAILS` Script Property, so the editor can't lock an admin out). New data-mutation public functions need all four mitigations; new admin-only creation/config paths need at minimum `assertAdmin_()`. **One sanctioned non-admin exception: the TELEMETRY CARVE-OUT** -- `Util.gs::logReportUsage_` appends one fixed-schema row to the `Report Usage` sheet from the public report endpoints (both cache-hit and fresh paths) so report-consolidation decisions have usage evidence. It is safe by construction: append-only, no user-controlled free text (Report is a code constant per call site; Department has already passed the caller's dept validation), and best-effort (missing sheet / any failure silently no-ops -- telemetry never blocks a report). Do not extend it beyond pure telemetry, and do not route caller-supplied strings into it. | Subsystem: Department Dashboard
INV-02 | Duration columns (TTT, ATT, AvgAbdWait, CSRAvgAbdWait) are read via getDisplayValues(), not getValue(), to bypass spreadsheet-vs-script TZ mismatch. | Subsystem: Department Dashboard
INV-03 | DO NOT EDIT! roster cells follow the format "Name, ext1, ext2, …" — name is everything before the first comma; subsequent digit-only tokens are extensions. | Subsystem: Department Dashboard
INV-04 | Agent-name match between DQE Historical Data Col C and DO NOT EDIT! roster cells is exact (case + whitespace sensitive); no alias normalization. | Subsystem: Department Dashboard
INV-05 | Per-agent ATT in the dashboard is the simple mean of per-row stored ATT values, NOT TTT/Answered weighted. Source ATT denominator sometimes ≠ Answered. | Subsystem: Department Dashboard
INV-06 | Work window for TTT/ATT/Missed/Answered is 6:30 AM – 3:00 PM PST (8:30 AM – 5:00 PM CST), hardcoded as DQE_WINDOW_START/DQE_WINDOW_END. Phase E (commit 94bbca9) added a dashboard-side display mirror `DASHBOARD_WORK_WINDOW` in `apps-script/department-dashboard/Config.gs` so the My Department page can show a work-window pill without cross-project sheet reads. The two must stay in sync — comment in `Config.gs` documents the sync requirement; if the pipeline window ever changes, update both. | Subsystem: CDR DQE Pipeline + Department Dashboard
INV-07 | TTT/ATT loop in buildDQEHistoricalData iterates `windowLegs` (in-window subset), not all-day `legs`, to match Answered's denominator. | Subsystem: CDR DQE Pipeline
INV-08 | TTT attribution uses each agent's own leg.talkSec on the parent call via findAgentTalkOnParent, NOT parent.talkSec (max across all legs). | Subsystem: CDR DQE Pipeline
INV-09 | Cache key in Data.gs is versioned (`summary:vN:...`); bump N on any aggregation rule change to invalidate stale caches. | Subsystem: Department Dashboard
INV-10 | HISTORICAL_COLS in department-dashboard/Config.gs must match actual column positions in DQE Historical Data (MONTH_YEAR=1, DATE=2, AGENT=3, QUEUE_EXT=4, TOTAL_UNIQUE=5, TOTAL_RUNG=6, TOTAL_MISSED=7, TOTAL_ANSWERED=8, TTT=9, ATT=10, TIME_SLOTS_START=11, TIME_SLOTS_END=29, ABANDONED_PARENT_IDS=30, ABANDONED_MISSED_TIMES=32, AVG_ABD_WAIT=33, CSR_AVG_ABD_WAIT=34). | Subsystem: Department Dashboard
INV-11 | ROSTER constants pin DO NOT EDIT! layout: HEADER_ROW=1, DATA_START_ROW=2, DEPT_FIRST_COL=6. | Subsystem: Department Dashboard
INV-12 | setup() in Department Dashboard is idempotent and admin-gated (`assertAdmin_()`) — creates all nine dashboard-managed sheets if missing (incl. `Report Usage`), never overwrites existing rows. | Subsystem: Department Dashboard
INV-13 | Web app deployment is "Execute as: Me" + "Anyone within domain"; deployer's spreadsheet permissions back the script. | Subsystem: Department Dashboard
INV-14 | SPREADSHEET_ID is read from Script Properties, not hardcoded; missing property = clear error at request time. | Subsystem: Department Dashboard
INV-15 | Per-project .clasp.json files are gitignored at any depth; scriptIds stay out of the repo. | Subsystem: operational/cross-cutting
INV-16 | `neonWrite.js` AND `buildDQEHistoricalData.js` are duplicated between cdr-report/ and cdr-import/; both must stay byte-identical. Any change requires a two-file edit. `neonWrite.js` self-contains `parseDateForNeon`, `normalizeDuration`, and `writeCDRRowsToNeon` with its CDR field-parsing helpers (`cdrTimeToSeconds_`, `cdrHashPhone_`, `cdrLooksLikePhone_`, `cdrParseNameFieldJson_`, `cdrParsePhoneField_`) so they travel with the duplication. cdr-import calls `buildDQEHistoricalData` inline inside `processIntegratedHistory` (as the 5th historical sheet write) so DQE Historical Data refreshes alongside CDR / Q Path / QCD / CSR in a single autoImport run; cdr-report keeps its `runDailyDQEBuild_` trigger as a safety net. `buildDQEHistoricalData(rawSheet, dqeSheet, opts)` takes an optional `opts` (both copies); `opts.skipNeon=true` defers the per-date DQE->Neon mirror -- ONLY the cdr-import bulk-rebuild caller passes it (then runs `backfillDQEHistoryUpsert()` after); the daily integrated path + the cdr-report trigger omit `skipNeon` so the real-time mirror is unchanged. `opts.expectedDate` (a Date) is the F2 write-date guard: BOTH cdr-import callers (daily `processIntegratedHistory` + bulk `bulkHistoricalUpdate`) pass the importer's date so the build refuses to write (logging a `buildDQE` `failure` row, no rows written) when its own Raw-Data-first-row date disagrees -- preventing a force re-import from deleting one date's rows but writing a different date's. The cdr-report standalone `runDailyDQEBuild_`/`testDQEBuild` trigger omits `opts` and self-derives its date, so its behavior is unchanged. Pipeline Health writers: `logPipelineHealthWithFallback_` in autoImport.js (with `openById` fallback when `ss` is null); `logPipelineHealth_` in buildDQEHistoricalData.js (silently returns when `ss` is null). The distinct names avoid the prior shadowing conflict. **Enforced by `scripts/check-duplicated-files.sh`** -- diffs both duplicated pairs and exits non-zero on drift; wired as a non-blocking SessionStart hook in `.claude/settings.json`, so a drifted pair surfaces at the start of every session. | Subsystem: CDR Reporting Tools / CDR Import / CDR DQE Pipeline
INV-17 | `clasp push -f` does NOT delete remote files absent locally; removing files from a project requires manual web-editor deletion. | Subsystem: operational/cross-cutting
INV-18 | Missed Calls Report chart range is 8:00 AM – 5:00 PM CST in 30-minute buckets (18 total). | Subsystem: Department Dashboard
INV-19 | DQE_EXCLUDED_AGENTS allowlist in buildDQEHistoricalData.js is the canonical source for pseudo-agent exclusions; additions go upstream, not downstream. | Subsystem: CDR DQE Pipeline
INV-20 | Time-slot columns K-AC in DQE Historical Data store CST timestamps (already PST→CST converted); downstream code must NOT re-convert. | Subsystem: CDR DQE Pipeline / Department Dashboard
INV-21 | parentMap in buildDQEHistoricalData builds from rows with parentId='N/A' or ''; each parent leg's calleeName must be captured for findAgentTalkOnParent. | Subsystem: CDR DQE Pipeline
INV-22 | DQE Report Legacy is frozen — accepts only deletions and minimal menu cleanups during migration; no new features or improvements. | Subsystem: DQE Report Legacy
INV-23 | Queue-sentinel rows in DQE Historical Data carry queue-only abandoned data (no agent rang). Agent Name (col C) holds a queue identifier (`A_Q_*` or `Backup CSR`); col D holds the queue's extensions; K-AC, AD, AF are populated normally; cols E-J and AG/AH are 0/"0:00:00". Consumers must filter these out by agent-name pattern: the main per-agent dashboard (Data.gs) and Diagnostics (whyNoMatches_) skip them; MissedCallsReport.gs reads them specifically for the queue-only section. | Subsystem: CDR DQE Pipeline / Department Dashboard
INV-24 | buildDQEHistoricalData canonicalizes raw CDR agent names against the DO NOT EDIT! roster on every build: it compares the incoming name's paren-stripped form against each roster entry's paren-stripped form (the strip removes the parenthetical -- parens AND contents -- via `stripParens_`), and if exactly one roster entry matches, the row is written under that roster name. So a name differing only in its parenthetical canonicalizes ("Roman Paulose" / "Roman (Bob) Paulose" -> "Roman (Robin) Paulose") but a name with an extra word ("Roman Robin Paulose") does NOT (it strips to itself). Ambiguous (>1 match) or unknown (0 match) names are written as-is. Admin-curated alias overrides (INV-46) are loaded by the same `loadRosterCanonicalNames_` and take precedence over the paren-strip; the dashboard's Orphan Fix modal is the canonical writer. Soft coupling: pipeline depends on the dashboard's roster sheet schema. Edits to roster layout must keep `loadRosterCanonicalNames_` working. | Subsystem: CDR DQE Pipeline
INV-25 | The Individual Report and Performance Report compute ATT as weighted by Answered (`sum(att * answered) / sum(answered)`), NOT the simple-mean used by the main dashboard table (INV-05). Days with answered=0 contribute 0 to both numerator and denominator, so unanswered/abandoned days don't drag the ATT down. Intentional — matches each legacy report's source semantics. | Subsystem: Department Dashboard
INV-26 | TEAM_AVG_EXCLUDES in Config.gs lists per-dept agent names removed from BOTH numerator and denominator of the Individual Report's team-average. Used for managers on the roster who take only a token number of calls (default seed: 'CSR': ['Robin Choudhury']; overridable per dept via the Dept Config sheet, read through `getTeamAvgExcludes_` -- INV-54). Match is exact on the roster name. Does NOT apply to the Performance Report, which treats the user's selection AS the team. Since the INV-53 expansion (commit ba26d48), the IR team-avg ALSO excludes queue-only floaters (matchedViaRoster=false) via the independent `rosterSet[agent]` gate — the two exclusion mechanisms compose, so an agent excluded by EITHER doesn't factor in. INV-53 documents the floater path. | Subsystem: Department Dashboard
INV-27 | Individual Report's team-avg denominator counts only roster members with ANY call activity (rung/answered/missed > 0) in the selected range, NOT the full roster size. Zero-call roster members don't dilute the average. | Subsystem: Department Dashboard
INV-28 | Performance Report's prior period is the immediately-preceding window of the same duration (durationDays before currentStart, ending one day before currentStart) -- NOT "previous calendar month". Documented in the form's inline hint and the results-header "Comparing against..." line. Match legacy SingleRangeReport semantics. **One shared implementation**: `Data.gs::computePriorWindow_` is the canonical auto-adjacent-window math, consumed by `computeSummary_` (E5 per-row chips), `computePerformanceReport_`, and `computeInsights_`; client-side, `script.html::resolveComparisonWindow_` is the single resolver behind the IR + Insights "compare against" controls. New window-vs-window features should call these rather than re-deriving the math. | Subsystem: Department Dashboard
INV-29 | Individual Report's monthly trend window: range itself when selected range > 366 days OR equals a full calendar year (Jan 1 - Dec 31 of one year); else `first-of-month(end - 12 months)` to `end`. Performance Report uses identical logic so the 12-mo trends align across both reports for the same dept. **One shared implementation**: `Util.gs::computeTrendStartDate_(startDate, endDate)` is the single source of truth, consumed by the Individual / Performance / Insights / QCD reports (previously hand-copied into all four -- a silent-drift trap, since INV-29 *requires* IR and PR to align). Pinned by `tests/unit/trend-window.test.js`. New 12-mo-trend features should call it rather than re-deriving the math. | Subsystem: Department Dashboard
INV-30 | Each report has its own versioned cache key prefix; bump on any aggregation rule change so stale entries don't bleed in. Current: `summary:v10` (Data.gs -- v8 added the E5 per-row prior-period fields; v9 changed `qcdSnapshot` to per-queue separation: `perQueue` array with `subDept` tags, sub-queues never summed away; v10 (P3) made the My Department QCD snapshot's UNQUALIFIED dept total OWN-queues-only so it reconciles with the QCD modal / Overview / all-dept report -- a sub-queue is no longer folded into the parent headline -- and added `subTotals` / `allTotals` (null when no sub-queues) + `mainQueueCount` / `subQueueCount` for the gated Main / Sub-queues / All-queues summary lines), `latestDate:v1` (Data.gs -- most-recent DQE ISO date; drives the My Department From/To default so the agent table lands on a non-empty day; the F1 cutover suffixes this key with the active source -- `latestDate:v1:sheet` / `:neon` -- so a `DQE_READ_SOURCE` flip can't serve a value computed from the other source), `latestDates:v1` (Data.gs -- multi-source `{dqe, qcd, latest}` blob; drives the header freshness pill so it doesn't go stale when one source updates without the other; like `latestDate:v1` this key is suffixed with the active source -- `latestDates:v1:sheet` / `:neon` -- because its DQE component comes from the source-aware `getLatestDataDate`, so a `DQE_READ_SOURCE` flip can't serve a stale cross-source blob), `individual:v9` (IndividualReport.gs), `individual_active:v2` (active-agents-in-range subset used by Individual + Performance + Compare Ranges pickers; v2 return shape is `{agents, floaters}` after the INV-53 expansion), `performance:v4` (PerformanceReport.gs), `compareRanges:v6` (CompareRangesReport.gs -- v5 gates the Team-Insights raw-volume insights out on a length mismatch via `excludeVolume`; v6 computes the INV-35 length-mismatch flag on WORKING days (Mon-Fri) not calendar days), `missed:v12` (MissedCallsReport.gs -- v11 excludes coerced/lost abandoned AD/AF cells from the counts and flags them via `meta.abandonedDetailLost`/`abandonedDetailLostDates`, the read-side classifyAbandonedCell_ guard; v12 adds `chart.abandoned` -- a parallel per-bucket abandoned-ring count -- so the bar chart colors abandoned-containing buckets solid warn vs faint for abandoned-free ones), `companyOverview:v17` (CompanyOverview.gs -- v14 made the trend axis skip weekends; v15 switched per-dept QCD snapshots to DIRECT queues only -- sub-queue separation, children carry their own tiles; v16 scoped the company-aggregate hero volume/%/sparkline to the on-roster non-hidden population so it shares one population with the active-count caption (M1), and attributes a double-mapped QCD queue to EVERY dept that lists it instead of first-write-wins dropping it from later depts' Overview tiles (M2); v17 added the admin-only `unmappedQcd` field -- QCD queues seen in the data but mapped to no dept -- for the F onboarding nag, stripped for non-admins by `personalizeOverview_`), `qcd:v9` (QCDReport.gs -- v6 gave the empty shape `perQueue` parity (F5); v7 added the `includeSubQueues` request flag + cache dimension; v8 RETIRED that user-facing toggle -- sub-queues are always shown but tagged (`subDept`) and EXCLUDED from the dept total / dept-total trend / MTD violations, via a `separateSubQueues` opt that only the QCD report passes (Insights' Queue-health calls are unchanged); v9 added per-call-source rows (`bySource` on each queueBreakdown row -- Overall + the QCD Call Source sub-sources like CSR / Ad-campaign / New Call Menu / Non-CSR, expanded in the per-queue detail subtable, #4a)), `inbound:v3` (InboundReport.gs -- per (dept,from,to); v2 added kpisPrior + meta.priorFrom/priorTo via the shared computePriorWindow_, per-row avg_wait on the three breakdowns, and the byDialInInsurer cross-cut; v3 opened the report to managers with per-dept scoping (entry-queue attribution + the answered-on-hold final_dept carve-out) and added kpis.abandonedIvr + the getInboundInsurerDaily drill-down endpoint; unavailable payloads -- `meta.available=false` -- are intentionally NOT cached so a transient Neon failure isn't pinned for the TTL), `inboundHeatmap:v1` (InboundReport.gs -- `getInboundHeatmap`, the weekday×hour temporal abandon heatmap shared by the Inbound + QCD reports; per (dept,from,to), unavailable payloads not cached), `directCall:v1` (DirectCallReport.gs -- `getDirectCallReport`, per-agent direct-extension call metrics; per (dept,from,to); admin-only while vetted; unavailable payloads -- `meta.available=false` -- intentionally NOT cached, like the Inbound report), `insights:v16` (InsightsReport.gs -- per (dept,from,to,hashAgents,priorKey); v2 added explicit prior windows + `trendData`; v3 added the INV-35 length-mismatch contract; v4 added `queueHealth` (QCD-into-Insights: window totals + prior totals + per-queue rows with violation dates via the same computeQcdReport_ the QCD modal uses, null when unmapped or the QCD sheet is missing, `{error:true}` on a genuine compute failure so the client shows an "unavailable" note instead of silently hiding it -- F8); v5 added `queueHealth.trend` -- monthly abandoned-% per queue + dept total for the compact Queue health chart; v6 added the DAILY series to queueHealth.trend (Monthly/Daily toggle), the `queueHealthOwnOnly` request flag (sub-queue scope, joins the cache key), hasSubQueues/includeSubQueues on queueHealth, and the shared days-to-violation forecast -- `abandonForecastHtml_` is consumed by BOTH the QCD Report and Queue health); v7 CONSOLIDATED the 12-mo team trend + the queue-health chart into ONE tabbed chart (added `trendDaily` -- a daily team answered/%/ATT series for the selected window, powering the chart's Monthly/Daily toggle; the new `Abandoned % by Queue` tab reads `queueHealth.trend`), and `queueHealth` now ALWAYS-separates sub-queues (seq #5: own-only dept total, per-queue rows carry `subDept`), retiring the `queueHealthOwnOnly` request flag + its cache dimension); v8 added `queueHealth.perQueue[].topAbandonSource` (4c) -- the non-Overall call source driving the most abandons in each queue, from the bySource breakdown qcd:v9/4a added, surfaced as an annotation in the Queue health table); v9 gates the Team-Insights raw cumulative-volume insights (answered/missed counts) out on a length mismatch via `excludeVolume` and neutralizes the at-a-glance headline tone when the two windows differ by more than 7 days; v10 made `meta.rosterAgentCount` -- the client's per-agent team-average divisor -- the count of roster members with ANY activity in the current window (INV-27 semantics, matching the Individual Report), instead of all selected roster members; `queueOnlyAgentCount` is now derived independently from the floater count (F1); v11 added `meta.priorOverlap` -- true when a CUSTOM prior window overlaps the current range (the overlapping days count toward the current period only, so the prior baseline omits them), surfaced as the client's inline "Windows overlap" caveat; auto-adjacent priors are disjoint so it's always false there (F12)); v12 computes the INV-35 length-mismatch flag on WORKING days (Mon-Fri) not calendar days (shared `countWorkingDays_`); v13 (QCD->Insights consolidation Phase 1) adds `queueHealth.dailySeries` (the per-day numeric rows the QCD modal renders as its daily table) + `queueHealth.perQueue[].bySource` (the full per-call-source breakdown for the expandable subtable, not just the topAbandonSource annotation) so Insights Queue health is a data-superset of the QCD modal's tables; v14 (consolidation Phase 1, gap 1) adds `queueHealth.trend.metrics` (Total Calls + Violations monthly+daily series per queue + dept total, parallel to the default abandoned-% series) so the consolidated trend chart's by-queue tab switches metric via a sub-selector (`insQueueMetric`); v15 makes Insights ROSTER-ONLY -- queue-only floaters (shared-queue-overlap matches, mostly false positives in prod, e.g. CSR agents who only transfer INTO Service's queue) are dropped from `agentData` and the picker's floater group is hidden, matching the My Department table's Phase 14 roster-only flip (teamStats/trend unchanged -- already roster-gated; `queueOnlyAgentCount` always 0; IR/PR/CR still surface floaters per INV-53); v16 passes the secondary queue metrics through (`totalAnswered` on `queueHealth.totals` + `totalAnswered`/`longestWait`/`avgAnswer` on each `queueHealth.perQueue` row) so the Insights Queue health can show Answered / Longest wait / Avg answer -- surfaced only in the per-queue EXPAND detail + a muted dept-total secondary line, NOT the headline tiles/columns (QCD-parity #1). Alerts.gs holds no cached compute. CallerLookup.gs is intentionally UNCACHED (caller-keyed responses must not sit in the shared script cache, and the hash-PK query is cheap). | Subsystem: Department Dashboard
INV-31 | `script.send_mail` OAuth scope in appsscript.json is required for: (1) Individual / Performance / Compare Ranges / QCD "Email image" exports, (2) the Low Answer Rate Alerts engine, (3) the Manager Digest engine (Digest.gs), (4) the failure-notification paths (notifyImportFailure_ in autoImport.js, notifyDqeBuildFailure_ in autoImport.js [emails NEON_WRITE_CONFIG.alertEmail when the integrated daily DQE-block fails inside processIntegratedHistory; not fired on the bulk-backfill path], runDailyDQEBuild_ in buildDQEHistoricalData.js [present in BOTH cdr-import and cdr-report copies after INV-16 expansion], notifyDigestFailure_ in Digest.gs, notifyIngestStale_ in IngestWatchdog.gs [the optional ingest-failure watchdog, Operator State #23 -- emails getAdminEmails_() when no fresh DQE build has landed], plus the indirect path from cdr-import's integrated DQE block hitting notifyNeonWriteFailure on a Neon write failure). All paths use `MailApp.sendEmail`. Removing the scope breaks every one of them; adding new send-mail features here doesn't need a re-scope. | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the notify-failure paths)
INV-32 | Low Answer Rate Alerts is admin-only at the server boundary. Every public callable in Alerts.gs starts with `assertAdmin_`. The launcher button is also hidden client-side via `data-admin-only`, but the server check is the source of truth. Compare Ranges was previously admin-only too but was opened to managers (with the same `dept !== user.department` check the other reports use) so they can run year-over-year comparisons within their own dept. Adding a new admin = setting/editing the `ADMIN_EMAILS` Script Property (comma-separated emails); falls back to `ADMIN_EMAILS_FALLBACK` in Config.gs if unset. | Subsystem: Department Dashboard
INV-33 | `runDailyAlerts_` (time-triggered alerts) skips Saturdays and Sundays. Holiday handling is via the Alert Config `Skip Dates` column (E8, commit 319eca7): admins enter comma-separated ISO dates and/or inclusive ranges (`YYYY-MM-DD..YYYY-MM-DD`) per dept; `runAlertsCore_` checks each dept's parsed `skipDates` against today and logs status `skipped` with note `Skip date match (YYYY-MM-DD) in Alert Config` when it hits. **Trigger-only enforcement:** the gate is `triggeredBy === 'daily-trigger'` — manual sends from the UI, previews, and any other caller bypass the skip so admins can force-send after a holiday for post-hoc catch-up. `Alerts.gs::parseSkipDateRanges_` is intentionally tolerant (silently drops malformed tokens, swaps reversed ranges) because the cell is admin-curated free-text with no UI validator — never throws. ISO-string range checks are safe only because `YYYY-MM-DD` is zero-padded and lexicographically ordered. | Subsystem: Department Dashboard
INV-34 | `Alert Config` columns: Department \| Threshold % \| Extra Recipients \| Active \| Notes \| Skip Dates. `Skip Dates` (col F) was added in E8 (commit 319eca7) at the end of the row -- non-destructive on existing prod sheets, which keep their 5-col header row. `readAlertConfig_` widens its read to 6 cols and indexes by position, so pre-E8 sheets work without re-running `setup()` (col F just returns empty until an admin populates it; the col F header label `Skip Dates` only lands on fresh `setup()` runs because `ensureSheet_` short-circuits on existing sheets per INV-22). Format + parser tolerance: see INV-33. `Alert Log` columns: Timestamp \| Department \| Date Checked \| Threshold % \| Answer Rate % \| Sent \| Recipients \| Triggered By \| Notes \| Status. Both sheets idempotently created by setup(); never overwritten. Alerts.gs's `readAlertConfig_`, `appendAlertLog_`, and -- since E10 (commit b3a5a51) -- `computeThresholdDrift_` (reads the Alert Log to surface per-dept fire-rate + mean answer rate on the modal config table) all depend on these schemas. **F4:** a dept row with a present Department but an invalid Threshold % (blank / <=0 / non-numeric) is no longer silently dropped by `readAlertConfig_` -- it's returned flagged `invalidThreshold:true`, surfaced as an `error` Alert Log outcome on every run (note: "department NOT monitored") and rendered as a "⚠ invalid" chip in the modal config table, so a fat-fingered threshold can't silently un-monitor a dept. `computeThresholdDrift_` skips invalid entries. | Subsystem: Department Dashboard
INV-35 | Compare Ranges (and Insights) flag `meta.lengthMismatch=true` when the longer of the two periods is at least 1.2x the shorter, counted in **WORKING days (Mon-Fri)**, NOT calendar days, via the shared `Util.gs::countWorkingDays_` (`Math.max(wd1,wd2) / Math.min(...) >= 1.2`). Working-day counting means two windows with equal workdays but a different weekend count (e.g. 10 calendar days / 2 weekends vs 8 / 1 weekend) are NOT falsely flagged. The calendar-day counts (`p1Days`/`p2Days` in CR, `currentDays`/`priorDays` in Insights) are retained for the KPI per-day captions + CSV per-day columns. **Holidays are NOT yet excluded** (no global holiday source; the per-dept Alert Config `Skip Dates` is the candidate seed -- a follow-on). The flag drives the form's warning hint, the results-page banner, KPI per-day captions, and CSV per-day columns. Tunable threshold in `computeCompareRanges_` / `computeInsights_`. | Subsystem: Department Dashboard
INV-36 | Cache keys that embed agent selections must hash via `Data.gs::hashAgents_` (MD5 hex, 32 chars, order-insensitive). Apps Script CacheService silently rejects keys > 250 chars; raw-joined agent lists overflow on big rosters like Sales and surface as report-generation errors. IR / PR / CR all use the hash; future report code that caches per agent-selection must follow suit. | Subsystem: Department Dashboard
INV-37 | The dashboard is a two-page web app toggled via `body[data-page="overview"|"dept"]`. Default landing is `overview` (set inline on the body tag so the right page paints before JS runs). `setPage(name)` swaps the page, updates the header kicker+h1, and (for `overview`) triggers a fresh `getCompanyOverview()` fetch. `refresh()` only writes the dept name into `#page-title` when the dept page is active, so swapping dept on Overview doesn't clobber "Departments Snapshot". | Subsystem: Department Dashboard
INV-38 | `OVERVIEW_PARENT_OF` (CompanyOverview.gs) defines sub-queue parent-child relationships for the Overview tile grid ONLY. The dept dropdown, all Reports modals, and Alerts treat each dept as independent. Keys must match the `DO NOT EDIT!` column header byte-for-byte; aliases (e.g. both `PAP` and `PAP Q` mapping to Sales) are tolerated. The constant is the seed default; the Dept Config sheet can override a dept's parent per dept (read through `getOverviewParentMap_`, save-time validated against real dept headers + cycle check -- INV-54). `OVERVIEW_HIDDEN_DEPTS` excludes depts from the Overview only (e.g. `CSR Backup`). | Subsystem: Department Dashboard
INV-39 | Admin-only fields in the Overview payload are stripped on serve via `personalizeOverview_`: the full blob (including all admin-only fields) is cached for everyone, but the admin-only fields (`companyAggregate`, `pipelineFreshness`, `orphanNag`, `unmappedQcd`) are removed before serving non-admins. `personalizeOverview_` deep-clones via JSON round-trip so any future personalize step that mutates nested fields can't leak across viewers; if that clone ever fails it fails CLOSED (admins get a shallow copy since they see everything anyway, non-admins get a minimal driver-free view) rather than the old shallow-copy-then-mutate path that would have mutated the shared cached blob. Viewer-personalized fields `viewerRole` and `viewerDept` are injected per-request, never cached — so a payload warmed by user A still personalizes correctly for user B. Adding a new admin-only Overview field means adding its key to the strip list inside `personalizeOverview_`. | Subsystem: Department Dashboard
INV-40 | Overview "X of Y agents" caption denominator is `recentlyActiveCount` = any rung/answered/missed activity in the last `OVERVIEW_RECENT_ACTIVE_DAYS` (=30) days, NOT full roster size. Filters out ex-employees who are kept on the `DO NOT EDIT!` sheet for historical-data preservation. Hover tooltip exposes today-active / recent-active / full-roster numbers so the choice is transparent. Same logic powers the company aggregate's Active count. | Subsystem: Department Dashboard
INV-41 | chartjs-plugin-datalabels requires `Chart.register(ChartDataLabels)` AND `Chart.defaults.plugins.datalabels.display = true` at module load (the `registerChartDataLabels_` IIFE in script.html does both). Chart.js v4 dropped script-tag auto-registration; the plugin defaults to display=false since v1.0.0. Per-chart `display: false` overrides still suppress labels (Missed Calls **radar** mode, Overview multi-line trend). Use the boolean form of `display` per chart — the function form returns false unpredictably on mixed bar+line charts in this plugin version. **Missed Calls bars/radar toggle (Track A):** the missed-calls chart (modal + My Department section) has a shared Bars/Radar toggle (`missedChartCfg_` dispatches `missedBarCfg_` / `missedRadarCfg_`; mode persisted in `localStorage` `cdr.missed.chartmode`, default `bars`). The BAR mode (horizontal, one bar per 30-min bucket) turns datalabels ON (boolean display + empty-string formatter to hide zero buckets -- readable, unlike the radar) and spices up the work-day read with a color INTENSITY RAMP (per-bar fill alpha scales with count via `rgbaWithAlpha_(THEME.warn,...)`) + the peak bucket outlined. A toggle re-render is guarded to charts that are instantiated AND visible (`offsetParent`) so it never rebuilds a hidden chart at zero size. | Subsystem: Department Dashboard
INV-42 | `refreshChartTheme()` (script.html) resolves every CSS custom property via `colorToCanvasRgb_()` — paints onto a 1×1 canvas and reads back canonical `rgba(...)`. Required because chartjs-plugin-datalabels' `fillStyle` path can't parse `oklch(...)` strings → silently renders empty fills (invisible labels). Never pass raw `getComputedStyle(...).getPropertyValue('--token')` to chart options; always go through `THEME.*`. Hook is re-run on dark-mode toggle so newly-rendered charts pick up the inverted palette. | Subsystem: Department Dashboard
INV-43 | Default From/To on the My Department page snaps to the most-recent ISO date present in DQE Historical Data, via `Data.gs::getLatestDataDate()` (cached under `latestDate:v1`). Falls back to today on failure. Replaces the legacy "current-month-to-date" default so the table isn't empty when a manager opens the dashboard before today's ingest has run. | Subsystem: Department Dashboard
INV-44 | `Pipeline Health` sheet columns: `Timestamp \| Step \| Status \| Rows \| Duration (ms) \| Notes`. Schema pinned in `Config.gs::PIPELINE_HEALTH_HEADERS`; sheet is idempotently created by `setup()`. Append-only; never overwritten. Writers are `logPipelineHealthWithFallback_` in `apps-script/cdr-import/autoImport.js`, `logPipelineHealth_` in `apps-script/cdr-import/buildDQEHistoricalData.js`, and `logPipelineHealth_` in `apps-script/cdr-report/buildDQEHistoricalData.js` (cross-project; the two buildDQE copies are byte-identical per INV-16). All writes are best-effort -- a logging failure must never block or fail the pipeline. Reader is `Alerts.gs::readPipelineHealth_(maxRows)`; UI surfaces the last 20 entries in the Alerts modal. Step values are free-form (currently `autoImport`, `buildDQE`, `processIntegratedHistory:CDR`, `:QPath`, `:QCD`, `:CSR`, `:DQE`, `:Inbound` -- the inbound_calls Neon mirror's per-run outcome incl. unreachable/error failures, F9 -- `bulkBackfill:DQE`, `buildDQE:neon` -- the DQE->Neon mirror's skip/error outcome when the sheet build succeeded but the per-date mirror was unreachable/failed (F4), `inboundBackfill` -- one summary row per editor-run `backfillInboundCalls` invocation in cdr-import/inboundCalls.js -- and, when the deferred Neon mirror is enabled (`NEON_MIRROR_MODE=deferred`, NeonMirror.js), `neonMirror:CDR`/`:QCD`/`:DQE`/`:Inbound` -- one per type per date drained by the `runNeonMirror_` trigger, status `failure` on Neon-unreachable so the date stays queued for retry -- and, for the direct-extension call metrics (directCallMetrics.js, cdr-import-only), `directBuild` (editor-run `runDirectCallBuild`), `processIntegratedHistory:Direct` (the daily import's 6th block -- per-agent-day Direct Call History + inline `direct_call_history` Neon mirror), and `bulkBackfill:Direct` (the bulk path's per-date Direct build, Neon DEFERRED via `skipNeon` -> mirrored later by the editor-run `backfillDirectCallToNeon`)); Status is `success` or `failure`. Looking up a recent fresh-DQE-write involves either `buildDQE` (cdr-report standalone trigger), `processIntegratedHistory:DQE` (cdr-import integrated daily path), OR `bulkBackfill:DQE` (cdr-import historical backfill path) -- all three share the freshness role. **A `processIntegratedHistory:DQE` `success` can carry `rows:0`** on a NO-OP build (date already in history via the dup-guard / empty Raw Data / the F2 expected-date refusal), so "ran-empty" is distinguishable from "block never ran" (no row) and "build threw" (`failure` row); `computeOverviewPipelineFreshness_` requires `rows>0`, so a no-op re-import does NOT count as fresh or reset the staleness clock (F5). | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the writers)
INV-45 | `Digest Config` sheet columns: `Email \| Department \| Cadence \| Active \| Notes \| Format`. Schema pinned in `Config.gs::DIGEST_CONFIG_HEADERS`; sheet is idempotently created by `setup()`. `Format` (col F) was appended at the end of the row, the Alert Config Skip Dates precedent -- pre-existing prod sheets keep their 5-col header, `readDigestConfig_` reads 6 cols positionally, and an empty col F normalizes to `summary`, so behavior is unchanged until an admin sets a value. Cadence is `daily` (sends each weekday morning for the previous BUSINESS day's data -- Monday's digest covers Friday; weekend runs skipped, F-6), `weekly` (sends Monday 8 AM for the prior Mon-Fri window), or `monthly` (sends on the 1st, 8 AM, for the prior calendar month -- ScriptApp `onMonthDay(1)` trigger). Format is `summary` (an answer-first answer-rate HERO -- big % + an On track/Watch verdict pill keyed on the 92% standard + an email-safe target bar built from filled `<td>` cells, `digestHeroHtml_` -- followed by Rung/Answered/Missed tiles + the WoW driver callout; the Answer-rate tile was folded into the hero, so 3 tiles not 4; default) or `insights` (the digest-Insights bridge: `digestInsightsHtml_` runs the SAME `computeInsights_` the Insights modal uses, full roster as the selection so floaters stay excluded, vs a cadence-appropriate prior window -- daily = INV-28 auto-adjacent day, weekly = previous Mon-Fri via shift-7, monthly = previous calendar month -- via `digestInsightsPrior_`). `Digest.gs` is the engine; every public callable (`getDigestsInit`, `sendPreviewDigest`, `installDigestTriggers`, `uninstallDigestTriggers`) starts with `assertAdmin_`. Trigger entry points (`runDailyDigests_`, `runWeeklyDigests_`, `runMonthlyDigests_`) end in `_` so `google.script.run` can't reach them but ScriptApp dispatch still calls them by name. Trigger lifecycle is managed via the Alerts modal's "Manager Digest Subscribers" section. | Subsystem: Department Dashboard
INV-46 | `Agent Alias Overrides` sheet columns: `Old Name \| Canonical Name \| Active \| Added By \| Added At \| Notes`. Schema pinned in `Config.gs::AGENT_ALIAS_OVERRIDES_HEADERS`; sheet is idempotently created by `setup()`. Soft-coupling across two Apps Script projects: the dashboard's `OrphanFix.gs` writes rows here; the CDR Report project's `buildDQEHistoricalData.js::loadRosterCanonicalNames_` reads them on every build and folds them into the canonicalization map. The pipeline-side check is best-effort (missing/empty sheet leaves the build's behavior unchanged) so an unsynced cdr-report deploy doesn't break the dashboard's UI. Aliases with `Active=FALSE` are skipped by the pipeline. | Subsystem: Department Dashboard + CDR DQE Pipeline
INV-47 | `Orphan Fix Log` sheet columns: `Timestamp \| Admin \| Action \| From Name \| To Name \| Affected Rows \| Notes`. Schema pinned in `Config.gs::ORPHAN_FIX_LOG_HEADERS`; sheet is idempotently created by `setup()`. Append-only; never overwritten. `OrphanFix.gs::appendOrphanFixLog_` writes one row per action. Action values: `alias-add`, `alias-remove`, `rename`, `rename+alias`, `roster-add` (the New-hire flow: From Name = the agent, To Name = the dept column written, extensions recorded in Notes). Affected Rows is the count of DQE Historical Data rows modified by a `rename` (0 for alias-only and roster-add actions). | Subsystem: Department Dashboard
INV-48 | `dept.wow.driver` on the Overview payload ("what changed" insight) is attached only when `|dept.wow.deltaPct| >= WOW_DRIVER_THRESHOLD` (= 1.5 pts). The driver is the per-agent net answered/missed change that most explains the dept's WoW shift, picked by `computeWowDriver_` in CompanyOverview.gs. Requires at least 3 events in either week-window to avoid one-call outliers; positive WoW surfaces the biggest answered-delta, negative WoW surfaces the biggest missed-delta. `dept.wow.driver` may be null for low-activity / quiet-week depts; the client (`ovBuildWowDriver_`) renders nothing in that case. Per-dept (not admin-only) -- managers see drivers for their own dept; admins see them for all depts. Enforced server-side in `personalizeOverview_` (since commit b89d061): for non-admins, `dept.wow.driver` is deleted on every tile where `dept.name !== user.department`. The strip runs post-cache on a JSON-cloned payload, so the shared cache blob isn't mutated and no `companyOverview:` version bump is needed. **Also surfaced in the manager digest (#11):** `Digest.gs::computeDigestWowDriver_(dept, anchorIso)` builds the same `{trendByDate, agentTrendByDate}` stats over a 14-day window ending on the digest window's end date and reuses `computeWowDelta_` / `computeWowDriver_` verbatim (same threshold + scoring), so the digest email renders a "What changed · WoW" callout (`digestWowNarrative_`) below the KPI tiles. The digest path is roster-scoped (INV-53) + sentinel-skipping (INV-23) and best-effort (null on a quiet dept / any error -> no callout). | Subsystem: Department Dashboard
INV-49 | `getIndividualReport` accepts optional `priorFrom`/`priorTo` for same-agent vs-self comparison. When supplied, every `summaryData[i]` carries `priorStats` (formatted) + `priorRaw` (numeric); `priorDateLabel` is set at the top level. Absence = legacy shape (`priorStats: null`). The cache key (`individual:v9`) adds a `priorKey` segment (`priorFrom..priorTo` or `none`) so the prior window is part of the cache identity. Client form (`ir-compare-mode` select) supports None / Same window one year prior / Immediately-preceding period / Custom prior range; resolved via `irResolvePriorRange_`. The same prior dates are re-applied automatically when the user re-runs from the edit-popover. | Subsystem: Department Dashboard
INV-50 | `QCD Historical Data` columns (1-indexed): `Month Year \| Week \| Date \| Call Queue \| Call Source \| Total Calls \| Total Answered \| Abandoned \| Longest Wait \| Avg Answer \| Abandoned % \| Violations`. Pinned in `Config.gs::QCD_HISTORICAL_COLS`. Writer: `apps-script/cdr-import/autoImport.js::processIntegratedHistory` QCD block. Reader: `apps-script/department-dashboard/QCDReport.gs` (dept-scoped report) + `CompanyOverview.gs::computeQcdSnapshots_` (per-dept latest-day snapshot on the Overview tile grid) + `Data.gs::computeDeptQcdSnapshot_` (per-dept latest-day snapshot for My Department's "Queue Call Data" tiles). **`Call Queue` carries raw queue names like `A_Q_CustomerSuccess` / `A_Q_Sales` / `Backup CSR` -- NOT dashboard dept names; canonical spellings vary per install.** To map a dept to its set of queue names, use `Config.gs::DEPT_QCD_QUEUES` (admin-curated). `Call Source` is one of `Total Calls` (daily roll-up; the only source the dashboard sums to avoid double-counting) plus sub-source breakdowns like `CSR` / `Ad-campaign` / `New Call Menu` / `Non-CSR (internal)` that the dashboard skips. `Violations` is the count of (source, day) tuples where Abandoned % > 5%. | Subsystem: Department Dashboard + CDR Import
INV-51 | `QCD Report` is per-dept gated like Individual / Performance / Compare Ranges -- managers see their own dept, admins pick any. **Parent depts auto-include sub-queue queues** via `queuesForDept_` (Sales+PAP, Power+PAK, CSR+Spanish per `OVERVIEW_PARENT_OF`); all three QCD readers (modal, Overview snapshot, My Department snapshot) use the same helper so rollups stay consistent. `getQcdReport({ department, from, to })` returns `meta` (with `queues` + `unmapped` flags), `dateLabel`, `totals` (sum across expanded queue list; `totals.violations` is MONTH-TO-DATE across the dept's queues, not selected-range sum), `queueBreakdown` (per-queue rows with `violationDates` array for expandable detail), `trendData` (12-month monthly buckets with `perQueue` keyed by queue name), `dailySeries` (per-day rollup across the dept's OWN queues), and `perQueue` (per-queue daily + monthly arrays for multi-line charts). Cache prefix `qcd:v9`. **Sub-queue separation:** the QCD Report's "Include sub-queues" toggle was RETIRED in the qcd v8 bump -- children are ALWAYS shown but tagged with `subDept`, rendered in a separated "Sub-queues — not in dept total" group, and EXCLUDED from the `totals` row / dept-total trend+daily line / MTD violation count (the dept aggregate is the parent's OWN queues only; `separateSubQueues` opt in `computeQcdReport_`, QCD-report-only so Insights Queue-health is unchanged). The OVERVIEW per-dept QCD chips also use DIRECT queues only (children render their own nested tiles -- the parent-expansion overwrite pass in `computeQcdSnapshots_` was removed in the companyOverview v15 bump). My Department's QCD snapshot lists every queue SEPARATELY (`computeDeptQcdSnapshot_` returns a `perQueue` array with `subDept` tags for child-owned queues; for multi-queue depts the client renders a per-queue CAROUSEL -- one queue page at a time with ‹ › nav + a dot indicator, plus a trailing all-queues total page (`renderDeptQcdSnapshot_`) -- so the sticky side column stays compact instead of stacking every queue vertically; single-queue depts keep a flat tile row. Sub-queues can behave very differently from the parent, so they're never summed away; summary:v10). **P3 (summary:v10):** `computeDeptQcdSnapshot_`'s UNQUALIFIED dept total (`totalCalls`/`abandonedPct`/`violations`) is OWN-queues-only -- it reconciles with the QCD modal's "Department total (own queues)", the Overview tile, and the all-departments report (a sub-queue is never folded into the parent headline, which would double-count it against the child's own dept total). The all-inclusive figure is surfaced separately via `allTotals` (and the sub-queue rollup via `subTotals`; both null when the dept has no sub-queues), rendered by `renderDeptQcdSnapshot_` as GATED carousel pages: **Main queues** (only when >1 own queue, else "Department total"), **Sub-queues (separate depts)** (only when >1 sub-queue), and **All queues (incl. sub-queues)** (only when sub-queues exist) -- so most depts (1 queue, no sub) show just the single row, 1-main+1-sub depts add only the labeled All-queues page, and Sales (1 main + N sub) gets the Sub-queues + All-queues pages. The QCD MODAL still shows only the own-queues "Department total" + separated child rows (it does not yet render a pre-summed All-queues row -- that needs a `computeQcdReport_` extension for per-group MTD violations + weighted avgAnswer, a follow-on). The QCD Report form defaults to "Yesterday" preset. For depts with 2+ queues, the chart renders one line per queue (color-coded) plus a dashed "Dept total" line. Single-day ranges hide the Daily chart view. Per-queue breakdown rows are clickable to expand into a per-call-source detail subtable (Overall + the QCD Call Source sub-sources, #4a/qcd:v9) plus the queue's violation dates. Color-coding: violations cells use light-warn (1-3) / strong-warn (>3); abandoned % >= 5% is warn-tinted in both breakdown and daily tables. On the Abandoned % chart view, violation days (>= 5%) are marked with a warn-colored, enlarged point and a dashed "5% threshold" reference line is drawn (skipped by the legend spotlight + tooltip). The breakdown tfoot carries a note that per-queue violation counts are selected-range while the department total is MONTH-TO-DATE (MTD), and the KPI tile reads "Violations (MTD)". **The Overview page's per-dept tile shows per-queue QCD data for multi-queue depts** (each queue gets abandoned %, abandoned count if >0, violations if >0 with color-coding); single-queue depts show dept-level chips. "X viol MTD" chip renders when month-to-date violations > 0. My Department page renders the "Queue Call Data — [date]" snapshot (showing the actual data date, not "yesterday") sourced from `Data.gs::computeDeptQcdSnapshot_` in `#dept-qcd-snapshot`. Since #5 the dept page is a two-column `.dept-layout` grid (`.dept-main` + `<aside class="dept-side">`): at >=1100px the QCD snapshot is a STICKY right side-card (`.dept-side`, scrolls alongside the table); below 1100px the layout collapses to one column with the QCD card stacked ABOVE the table (`order:-1`). The container max-width is 1440px (data-dense, wider than the legacy 1200px). BELOW the agent table sits a FULL-WIDTH-STACKED `.dept-context-row` (`flex-direction: column`) holding the **Missed Calls section** at full parity with the Missed Calls report modal -- shared headline composer (`missedHeadline_`), a summary strip (`#dept-missed-summary`: Range / Total missed / Abandoned calls / No-ring abandons / Agents), the same 18-bucket hour-of-day radar (`missedRadarCfg_`) sharing a `.chart-row` grid with a side-by-side per-bucket detail panel (`#dept-missed-bucket-detail`, driven by the shared `makeMissedBucketDetail_` factory -- the modal uses `missedBucketDetail_`, My Dept uses `deptMissedBucketDetail_`), and the per-agent missed timelines in `#dept-missed-detail`. Parity-first: the Missed Calls report tab/button is intentionally kept (retire later once the in-page section is validated in prod). All QCD UI surfaces are visible to everyone (no admin gate); per-dept gating is on the dropdown only. **All-departments daily report (4b):** a company-wide flat queue table (`getQcdAllDepartments({from,to})`, cached under `qcdAll:v2`) reproduces the legacy emailed "Daily Call Queue Report" PDF -- one section per mapped dept (own queues only, `includeChildren=false`, so a sub-queue lists under its own dept exactly once and is never double-counted) with a per-dept subtotal + a company grand-total, everything RANGE-scoped (no MTD violations mixing). **Open to ALL MANAGERS (owner decision):** the endpoint's `assertAdmin_` gate was replaced with a signed-in (`role!=='none'`) check -- it's a read-only company snapshot with no per-dept scoping, so every manager sees every dept; the Overview launch button (`#ov-qcd-alldept-btn`) is NO LONGER `data-admin-only`. Rendered in `#qcd-alldept-modal`: **pre-loads yesterday on open** (no separate form step), an **in-modal date changer** in the results header (preset + from/to + Update -- re-generates in place), **Answered / Abandoned / Abandoned % shown as a split bar** (shared `qcdDailyBarCell_`, like the My Department agent table -- folds those 3 columns into one), and **per-queue rows expand** into their data-driven per-call-source breakdown (`bySource`, shared `qcdSourceSubtableHtml_`) + violation dates (`qcdAll:v2` added `bySource` + `violationDates` to each queue row). Download CSV (emits all numeric columns regardless of the split-bar fold) + Print (plain-table print, no html2canvas). | Subsystem: Department Dashboard
INV-52 | `CDR Historical Data` columns (1-indexed): `Month Year \| Week \| Date \| Dept \| Name \| C..W` (22 metric cols). `Q Path Historical Data` columns: `Month Year \| Week \| Date \| Dept \| Path \| Total \| VM \| NonVM \| Opt1 \| NonOpt1 \| Pct`. `CSR Transfer Historical Data` columns: `Month Year \| Week \| Date \| Agent \| Trans % \| Total Calls \| Transferred \| + 11 per-queue cols`. Writers: `apps-script/cdr-import/autoImport.js::processIntegratedHistory`; each block emits a separate `processIntegratedHistory:CDR` / `:QPath` / `:CSR` row to Pipeline Health (INV-44). NOT consumed by the dashboard today -- the read path lives in the legacy DQE Report Apps Script. CDR rows are now **mirrored to Neon** (`call_history_dept` + `call_history_phones`) inline during `processIntegratedHistory`, following the same best-effort pattern as DQE and QCD. Requires `HMAC_SECRET` for phone-hash JSONB fields; degrades gracefully without it (main metric columns still write). | Subsystem: CDR Import (writer) / DQE Report Legacy (reader) |
INV-53 | **Queue-only floaters are excluded from dept-level totals and team-averages across all dashboard reports.** A "floater" is an agent matched into a dept's view via shared-queue extension overlap (`matchedViaQueue=true`) but NOT on the dept's roster (`matchedViaRoster=false`). Established by Phase D (commit d631719) for `Data.gs::computeSummary_` (My Department agent table) -- totals are computed by filtering `rows` to `matchedViaRoster=true` before summing/averaging; the response carries `rosterAgentCount` + `queueOnlyAgentCount` so the client can render a "Total (roster only · N floaters excluded)" tfoot caption when floaters are visible. Each row carries a `sourceHomes` array listing every other dept's roster the floater appears on (built lazily by `buildDeptsByAgent_`); the client Source column chip renders `QUEUE · <homes>` or bare `QUEUE` when the floater is on no roster. **Floater-aware aggregation extended to the three agent-level reports in commit ba26d48** (Phase D+1): Individual Report's team-avg accumulator is naturally floater-free via its existing `rosterSet[agent] && !excludedAgents[agent]` gate; Performance Report's `teamCurr`/`teamPrev`/`monthlyTeam` and Compare Ranges' `teamP1`/`teamP2` gained explicit `matchedViaRoster` gating. Per-row response on all three reports now carries `matchedViaRoster` / `matchedViaQueue` / `sourceHomes` (mirrors the Phase D My Department shape). Floaters render with the QUEUE chip on their summary cards but contribute zero to team-avg denominators. See the "INV-53 expansion to IR/PR/CR" Common Gotchas bullet for picker behavior + security model. The legacy scope toggle (`roster | queue | both`) was retired in the redesign cleanup (commit 53d0560); both public RPCs now lock scope to `both`, but the floater-exclusion contract is independent of scope so historical scope=`roster` behavior is reproducible by reading only `matchedViaRoster=true` rows from the response. | Subsystem: Department Dashboard
INV-54 | `Dept Config` sheet columns: `Department | QCD Queues | Overview Parent | Team Avg Excludes | Queue Ext Overrides | Active | Updated By | Updated At | Notes | Inbound Queue Aliases`. Pinned in `Config.gs::DEPT_CONFIG_HEADERS`; idempotently created by `setup()`. `Inbound Queue Aliases` (col 10) was APPENDED at the end (non-destructive, the Skip Dates / Format precedent -- pre-existing 9-col prod sheets keep working; `readDeptConfigRows_` reads it positionally, empty until filled). It holds the RAW inbound queue names (e.g. `A_Q_CSR`, `Backup CSR`) the phone system writes into `inbound_calls.entry_queue`/`final_queue` that belong to the dept but differ from its QCD-canonical names; read via the SHEET-ONLY accessor `getInboundQueueAliases_` (no seed constant -- absent ⇒ `[]`) and consumed ONLY by `InboundReport.gs::inboundQueuesForDept_` (UNIONs it with `queuesForDept_` for the per-dept Inbound report + per-call journey attribution -- the two-name-space bridge; no QCD/DQE reader consults it). Admin-authored, no-redeploy overrides for the per-dept maps `DEPT_QCD_QUEUES`, `OVERVIEW_PARENT_OF`, `TEAM_AVG_EXCLUDES`, and `DEPT_QUEUE_EXT_OVERRIDES`. Read via the accessors `getDeptQcdQueues_` / `getOverviewParentMap_` / `getTeamAvgExcludes_` / `getDeptQueueExtsOverride_` in `DeptConfig.gs`, which layer the sheet OVER the frozen constants: for a dept with an Active row, each NON-EMPTY field overrides that dept's constant; an EMPTY field falls back to the constant; an absent/missing sheet ⇒ pure constant behavior (so pre-`setup()` installs are byte-identical to pre-feature -- the regression-safety guarantee). A per-execution memo (`DEPT_CONFIG_ROWS_MEMO_`) keeps it to one sheet read per request. Written ONLY by `saveDeptConfig` / `removeDeptConfig` (both `assertAdmin_`-gated -- a config write path per INV-01, not a DQE data-mutation path; each adds `LockService` + save-time validation + an Updated By/At row stamp; `removeDeptConfig` soft-deactivates via Active=FALSE). Save validation rejects: unknown QCD queue names (must appear in QCD Historical Data col D within the 180-day scan OR in the dept's constant), non-dept / cyclic Overview parents, off-roster team-avg excludes, non-digit queue-ext overrides, and DIGIT-ONLY inbound aliases (those are raw queue NAMES, not extensions -- a digit token is a mis-entry; the names themselves can't be list-validated since they live only in `inbound_calls`/Raw Data, so they're just normalized). `getDeptConfigInit` also auto-discovers queue names from QCD col D and flags unmapped ones (unmapped-first, busiest-first). Consumers rewired to the accessors: `queuesForDept_` (QCDReport.gs), `computeQcdSnapshots_` + the Overview parent map (CompanyOverview.gs), the IR team-avg reads (IndividualReport.gs), `getDeptQueueExts_` (Data.gs). No INV-30 cache-version bump was needed -- the no-sheet output is byte-identical; a save busts `COMPANY_OVERVIEW_CACHE_KEY` and the per-(dept,range) report caches TTL out within 30 min (`REPORT_CACHE_TTL_SECONDS`). Admin-only client surface: the `Dept Config` header tab (`data-admin-only`) + modal, route `#/admin/dept-config`. | Subsystem: Department Dashboard
INV-55 | **Escalations (`Escalations.gs`) is the FIRST public PER-DEPT (non-admin) write path -- it extends INV-01.** Backed by the Neon `escalations` table (NOT a sheet; Phase 2 will let the external team-tools app INSERT `pending_review` rows into the same table, so Neon is the shared substrate). NO sheet fallback (like inbound_calls / Caller Lookup): unconfigured/unreachable Neon -> list renders an "unavailable" state, writes throw. Public callables: `getEscalationsInit` / `getEscalations` / `getEscalationActivity` (read; manager pinned to own dept, admin may pass a dept or `'ALL'`; `getEscalationActivity` is per-dept-gated on the row's own dept; none cached -- a transient outage shouldn't pin an empty list), `createEscalation` + `updateEscalation` (**admin-only**, `assertAdmin_`; create = the "admin manually logs escalations" flow, validates known-dept + required reason; `updateEscalation` = the §3 admin edit of a PENDING row's data columns only -- never status/resolved_*/id, pending-only), `resolveEscalation` + `updateEscalationComment` + `reopenEscalation` (**the per-dept write path** -- re-resolve caller + `assertDeptAccess_(user, <the row's OWN department, read from Neon, never trusted from the request>)`, so a manager touches only their own dept's rows; `reopenEscalation` flips a resolved row back to `pending` with a REQUIRED reason, retaining resolved_* as history). Four mitigations like the OrphanFix carve-out, admin gate swapped for the per-dept gate on the manager-reachable mutation paths: (1) authorization (above), (2) input validation (required fields, `ESC_MAX_TEXT`=4000 caps, `NULLIF(?, '')` for nullable cols so a blank optional field stores NULL without JDBC `setObject(null)`, the business rule that **a resolution REQUIRES non-empty resolution text** -- mirrored client-side by disabling the Resolved checkbox + Save until text is entered -- and the same required-reason rule on reopen), (3) `LockService` on every write, (4) audit via the row's own created_by/created_at + resolved_by/resolved_at/updated_at columns PLUS the **append-only `escalation_activity` trail** (§5: `id, escalation_id, action, actor, at, detail`; one immutable row per create/resolve/comment/edit/reopen) + a Logger.log per action. **True atomicity (§5):** the write paths run with `setAutoCommit(false)` -- the primary write + its activity row commit together (or roll back together), so a primary write can never land without its audit entry. The idempotent editor-run admin function `backfillEscalationActivity()` seeds `created`/`resolved` rows for pre-trail escalations. All params are bound prepared-statement params (no SQL injection); BOTH tables are created lazily (`CREATE TABLE IF NOT EXISTS` + indexes) on first write, so no `setup()` change. Requires the dashboard `NEON_*` props + `script.external_request` scope. **New-escalation notification (§1, flag-gated OFF):** when the `NOTIFY_ON_NEW_ESCALATION` Script Property is `'true'`, a successful `createEscalation` fires a best-effort email (full detail) to the dept's managers via `lookupDeptManagers_` (the Digest recipient resolver) -- AFTER the lock releases, never blocking the write, and never throwing (mirrors `notifyDigestFailure_`). Off by default; it's a PII surface (caller/patient/Trx in email) so it stays off until explicitly enabled. Client: an `Escalations` header tab (visible to managers + admins, route `#/escalations`) opens a **full PAGE** (`#escalations-page`, `body[data-page="escalations"]` via `setPage`), NOT a modal (#6 -- it's an interactive worklist, converted in place from the old modal: `initEscalations` wires the tab to `setPage('escalations')`; no modal open/close/drag/focus-trap; the page lives outside the main page container so `.esc-page-body` gives it the bounded centered width); the `+ New escalation` create form + the per-card `Edit` affordance are `data-admin-only` / admin-gated. A toolbar **Filter** narrows the already-loaded rows client-side (§4, patient/caller/Trx/reason substring, "N of M shown"); each card has a collapsible **Activity** timeline (lazy-loaded) and resolved cards a `↻ Reopen` action. Fields: Date & Time, Caller/Relation, Patient Name, Trx #, Area (optional), Reason; manager response = a Resolved checkbox (gated on a required resolution note) + optional Comments. New public write functions beyond escalations still need INV-01's mitigations; per-dept (non-admin) writes are sanctioned ONLY through this gate pattern. | Subsystem: Department Dashboard

### Policy Configuration
Policy threshold: 6/10
Consecutive cycles: 2

### Regression Scenarios
S1 | Manager loads own-dept dashboard | Subsystem: Department Dashboard
  Steps:
    - Manager opens the deployed web app URL.
    - Confirm the page lands on Overview ("Departments Snapshot" kicker + h1); the email + blue "manager" tag appear in the header.
    - Click "My Department" in the header nav.
    - Confirm header h1 swaps to the manager's dept name; From/To both default to the latest ISO date in DQE Historical Data; agent table populates within 3 seconds.
    - Confirm the My Department controls row shows only the dept selector, date inputs, and the Refresh button -- no scope toggle (retired in the redesign cleanup, commit 53d0560).
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

S4 | Missed Calls Report renders for a known date | Subsystem: Department Dashboard
  Steps:
    - Open dashboard for a dept with known missed calls in range.
    - Click "Missed Calls" button.
  Expected: modal opens; 18-bucket bar chart (8 AM-5 PM CST); per-agent cards with timestamps; abandoned ones red + 🚨.

S5 | Daily DQE aggregation completes for a typical day | Subsystem: CDR DQE Pipeline
  Steps:
    - In CDR Report Apps Script, manually run buildDQEHistoricalData for a day's Raw Data.
  Expected: new rows in DQE Historical Data; Neon mirror succeeds; no failure email; per-agent TTT ≈ ATT × Answered (±1s rounding).

S6 | Source column + roster-only totals (post-Phase D) | Subsystem: Department Dashboard
  Steps:
    - Open dashboard for a dept with known floaters. Scope is locked to "both" server-side since the redesign cleanup (commit 53d0560); the legacy scope toggle is gone from the UI.
    - Inspect the agent table: every row should carry a chip in the Source column (between Agent and the Answered/Missed bar). Roster agents render ROSTER (accent) or BOTH (good) chips; queue-only floaters render QUEUE (warn) chips suffixed with their other-dept home list (e.g. `QUEUE · Sales, Power`). Floaters on no dept's roster render bare `QUEUE`.
    - Confirm the tfoot first-cell reads "Total (roster only · N floaters excluded)" with N matching the count of QUEUE-chipped rows, and the totals values themselves exclude those rows' contributions.
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

S14 | Performance Report current vs prior deltas | Subsystem: Department Dashboard
  Steps:
    - Open Performance Report. Pick the full dept roster + "Last month".
    - Generate.
  Expected: 6 KPI tiles with delta vs the immediately-preceding 30 days; Missed delta colored as orange when above; Rung/Answered/% Answered colored blue when above; TTT/ATT always neutral. "Comparing against..." line + form hint both show the explicit prior dates.

S15 | Pipeline canonicalizes paren-variant agent names | Subsystem: CDR DQE Pipeline
  Steps:
    - In Raw Data, ensure a leg exists with calleeName "Roman Paulose" (parenthetical dropped) on a date where the roster has "Roman (Robin) Paulose" (and no bare "Roman Paulose" roster entry, so the match is unambiguous).
    - Run buildDQEHistoricalData for that day.
  Expected: the resulting DQE Historical Data row's Agent Name (col C) is "Roman (Robin) Paulose" -- consolidated under the canonical form (both names strip to "Roman Paulose", a single roster match). No duplicate rows for the same person on the same day. NOTE: an incoming "Roman Robin Paulose" (extra word) would NOT canonicalize -- it strips to itself, not "Roman Paulose" -- and is written as-is.

S16 | Export menu captures all chart tabs | Subsystem: Department Dashboard
  Steps:
    - Generate any Individual or Performance Report.
    - Without clicking through every chart tab, click Export -> Email image.
  Expected: emailed PNG contains all three chart panels rendered (not blank slots). Same expectation for Copy image and Print.

S17 | Compare Ranges is per-dept gated | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager (non-admin).
    - Confirm the "Compare" tab is visible in the top header nav (flattened from the prior Reports dropdown in Phase C).
    - Run a Compare Ranges report for the manager's own dept; confirm it loads.
    - Attempt to call `getCompareRanges` with a different dept name via the browser console.
  Expected: own-dept call succeeds; cross-dept call throws "Not authorized for this department." on the server. Admins can pick any dept that exists in the dept list.

S18 | Compare Ranges length-mismatch surfaces per-day | Subsystem: Department Dashboard
  Steps:
    - Open Compare Ranges. Pick P1 = 7 days, P2 = 30 days (or any pair with >= 1.2x ratio).
    - Generate.
  Expected: form shows a "(period 2 is N.Nx longer)" warning hint; results show an orange length-mismatch banner; KPI volume tiles gain a "Per day: X vs Y (P1)" caption; agent cards' P1/P2 cells show "X/day" sublines.

S19 | Compare Ranges custom prior range round-trip | Subsystem: Department Dashboard
  Steps:
    - Open Compare Ranges; set P1 = same month last year and P2 = this month-to-date.
    - Generate, then click "change" in the results header, swap one agent out, Apply.
  Expected: report re-runs in place against the same P1/P2; editing-line updates; the edit-selection popover dismisses; the new agent's card appears.

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
  Expected: first run creates Access Control + Alert Config + Alert Log + Pipeline Health + Digest Config + Agent Alias Overrides + Orphan Fix Log + Dept Config + Report Usage (each with their header row + frozen first row); second run logs "already exists, skipping" for all nine -- no data overwritten on either run. New columns added in a later code change to an existing sheet are NOT applied by setup() -- the sheet's existence short-circuits ensureSheet_.

S23 | Overview is the default landing + tile click routes admins | Subsystem: Department Dashboard
  Steps:
    - Open the deployed URL (admin or manager).
    - Confirm Overview page loads first; header h1 is "Departments Snapshot"; the Overview button has the inverted (active) styling.
    - As admin: click any dept tile in the grid.
  Expected: page swaps to My Department; header h1 becomes that dept's name; dept-selector reflects the clicked dept; agent table renders for the latest ISO date.

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
    - Repeat for Performance Report and Compare Ranges with the same selection.
  Expected: all three reports return data without "Argument too large" or similar cache errors. The MD5 hash in the cache key (`hashAgents_`) keeps the compound key bounded regardless of roster size; second Generate of the same selection comes back as a cache hit.

S27 | Compare Ranges is per-dept gated for managers | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager (non-admin).
    - Confirm the "Compare" tab is visible in the top header nav (no longer admin-only after INV-32 update; flattened from the prior Reports dropdown in Phase C).
    - Generate a Compare Ranges report for the manager's own dept; confirm it loads.
    - In the browser console, attempt `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).getCompareRanges({ department: 'SomeOtherDept', ...})`.
  Expected: own-dept Generate succeeds; cross-dept console call throws "Not authorized for this department.". Admin users can request any dept that exists in the dept list (same gate as Individual / Performance).

S28 | Pipeline Health logs autoImport + integrated DQE outcomes | Subsystem: Department Dashboard + CDR Import + CDR DQE Pipeline
  Steps:
    - Trigger a successful daily import (or run processNewImport manually).
    - Open the dashboard as admin -> Alerts modal -> Pipeline Health section.
    - (Optional, only if testing the cdr-report safety-net trigger) Run `testDQEBuild` or `runDailyDQEBuild_` from the cdr-report editor.
  Expected: most recent rows show a `success` entry for `autoImport` (with the imported sheet name in Notes and a row count) plus per-output rows from the integrated path -- `processIntegratedHistory:CDR` / `:QPath` / `:QCD` / `:CSR` / `:DQE`. If the optional safety-net trigger is also run, a separate `buildDQE` row appears (with `callDate=YYYY-MM-DD` in Notes). For a forced failure (rename "Raw Data" sheet temporarily), the entry shows status `failure` with the exception message in Notes. Logging is best-effort -- a missing Pipeline Health sheet must not break the pipeline. S33 + S34 cover the per-output and integrated-DQE specifics; this scenario is the smoke test that telemetry plumbing is alive.

S29 | Manager Digest install + preview flow | Subsystem: Department Dashboard
  Steps:
    - As admin: open Alerts modal -> Manager Digest Subscribers section.
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
    - As admin, open the dashboard. Click the "Outlier Fix" tab in the header nav (admin-only tab; flattened from the prior Admin dropdown in Phase C).
    - Confirm the modal lists orphan agent names from DQE Historical Data (or "no orphans" if everyone canonicalizes cleanly).
    - For one orphan, pick a canonical roster name from the dropdown; click Apply; confirm the prompt.
    - Server returns the rename count; the orphan row disappears from the list on refresh; "Current aliases" gains a new row with Active=Yes; "Recent fix log" gains a `rename+alias` entry.
    - Open the CDR Report spreadsheet -> DQE Historical Data; confirm the Agent Name column for the affected rows now shows the canonical name.
    - As a non-admin manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).applyOrphanRename({fromName:'X', toName:'Y'})`.
    - Expected: non-admin call throws "Alerts are admin-only." (the assertAdmin_ guard); admin Apply succeeds; renamed rows appear in subsequent dashboard reports after the 5-min cache TTL; the next daily DQE build does not re-introduce the orphan because the alias is honored by loadRosterCanonicalNames_.
    - Negative test: try renaming to a name not on any dept's roster (e.g. "Garbage Name"); expected: "X is not on any dept roster..." error.
    - Negative test: try renaming a queue-sentinel ("A_Q_CSR") as fromName or toName; expected: "Queue-sentinel names cannot be renamed..." error.

S32 | QCD Report end-to-end | Subsystem: Department Dashboard + CDR Import
  Steps:
    - Open dashboard as a manager. Click the "QCD" tab in the top header nav (flattened from the prior Reports dropdown in Phase C).
    - Confirm the Quick Select defaults to "Yesterday" and both date inputs show yesterday's date.
    - Pick a date range with known QCD activity for the manager's dept; Generate.
    - Confirm KPI tiles render Total Calls / Answered / Abandoned / Abandoned % / Longest Wait / Avg Answer / Violations (Violations tile is warn-soft when >0).
    - Confirm per-queue breakdown table shows one row per queue in `DEPT_QCD_QUEUES[dept]` with a "Department total" row in the tfoot. Violations cells are color-coded (light-warn 1-3, strong-warn >3). Abandoned % >= 5% is warn-tinted. Rows show a clickable chevron whenever the queue has any call source (4a) or any violation; clicking expands into a per-call-source detail subtable (Overall + the QCD Call Source sub-sources like CSR / Ad-campaign / New Call Menu / Non-CSR, sorted Overall-first then by volume) plus the queue's violation dates.
    - Switch the chart-tab metric (Total Calls / Abandoned % / Violations); chart re-renders. For depts with 2+ queues, the chart shows one line per queue (color-coded) plus a dashed "Dept total" line with a legend. The legend shares the Overview chart's spotlight (hover a queue to dim the others; click to pin/isolate, click again to release) via the `chartSpotlight*` helpers.
    - Select "Yesterday" from Quick Select (single-day range); confirm the Daily chart view toggle is hidden (single point not useful as a line).
    - Re-open the dashboard fresh and check the Overview tile for a dept with multiple queues; per-queue QCD rows appear showing each queue's abandoned %, abandoned count (if >0), and violations (if >0) with color-coding. "X viol MTD" chip renders when month-to-date violations > 0.
    - All-departments daily report (4b, open to all managers): as EITHER an admin OR a manager on the Overview page, confirm a "Daily Call Queue Report" button (`#ov-qcd-alldept-btn`) is visible (no longer `data-admin-only`). Click it; the `#qcd-alldept-modal` opens and **pre-loads yesterday** immediately (no Generate click). Confirm a flat company-wide table with one section per mapped dept (own queues only -- a sub-queue lists under its own dept exactly once, never under the parent), a per-dept subtotal row, and a "Company total" grand-total footer; **Answered / Abandoned / Abandoned % render as a split bar**; abandoned %>=5% and violation counts are warn-tinted. Change the date via the in-modal date toolbar (preset or from/to + Update) -- it re-generates in place (no back-to-form step). Click a queue row -> it expands into the per-call-source breakdown (data-driven per queue) + violation dates. Click Download CSV (scope line + per-dept rows + subtotals + grand total, all numeric columns) and Print (plain-table print window). Console check: `google.script.run.withSuccessHandler(console.log).getQcdAllDepartments({from:'2026-05-01', to:'2026-05-19'})` now RESOLVES for a manager (was `assertAdmin_`-gated); only a `role==='none'` visitor is refused ("Not authorized.").
    - As a manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).getQcdReport({ department: 'SomeOtherDept', from: '2026-05-01', to: '2026-05-19' })`.
  Expected: own-dept Generate succeeds; cross-dept console call throws "Not authorized for this department.". Admin users can request any dept that exists in the dept list. Cache prefix `qcd:v9` keys are bounded (no agent-list dimension, so no MD5 hashing needed). My Department page renders a "Queue Call Data — [date]" tile row (showing the actual data date) below the agent table.

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

S36 | Dept Config modal: auto-discovery, validation, override round-trip | Subsystem: Department Dashboard
  Steps:
    - PREREQ: deploy the Dept Config commit (`clasp push -f` + new deployment version) AND re-run `setup()` as an admin so the `Dept Config` sheet exists (INV-54). Until both are done the feature is dormant and accessors fall through to the constants (so behavior is unchanged -- this is the regression-safety guarantee).
    - As an admin, open the dashboard. Confirm the "Dept Config" tab appears in the header nav (admin-only; hidden for managers). As a non-admin manager, confirm the tab is NOT visible, and in the browser console `google.script.run.withFailureHandler(console.error).getDeptConfigInit()` throws "Alerts are admin-only." (the assertAdmin_ guard, shared message).
    - Click the tab. The modal loads: a "Discovered queues" table lists distinct `Call Queue` values from QCD Historical Data (last 180 days), unmapped queues sorted first with an "unmapped" chip + an "N unmapped" badge on the section title; a "Per-department config" table shows every dept's EFFECTIVE qcdQueues / overviewParent / teamAvgExcludes / queueExtOverrides with a Source chip ("sheet" if an Active row exists, "default" if from the constant).
    - Click Edit on a dept. The edit form pre-fills from the effective values. Negative tests (each should fail server-side with a clear message, status flips to error, no row written):
        (a) QCD queue typo (a name not in QCD col D and not in the dept's constant) -> "Unknown QCD queue name(s): ... Queues seen in the last 180 days: ...".
        (b) Overview parent = a non-dept string -> "... is not a department ...".
        (c) Overview parent that forms a cycle (e.g. set A's parent to B when B's parent is already A) -> "... would create a nesting cycle.".
        (d) Team-avg exclude not on the dept roster -> "... not on the <dept> roster ...".
        (e) Queue ext override with a non-digit token -> "... must be digits only ...".
    - Positive: set a valid QCD queue (one shown in the discovered list), Save. Status flips to success; toast appears; the modal reloads; the dept's Source chip flips to "sheet"; the discovered queue's "Mapped to" now shows the dept; the unmapped count drops by one.
    - Re-open the QCD report for that dept -> the newly-mapped queue's rows now appear (after the qcd:v9 cache TTLs out). Re-open Overview -> a sub-queue mapping change is reflected immediately (the COMPANY_OVERVIEW_CACHE_KEY is busted on save).
    - Click Edit on the same dept, click "Deactivate override". Confirm prompt; the row's Active flips to FALSE; on reload the dept reverts to the "default" Source (constant behavior). The Deactivate button is hidden for depts with no existing sheet row.
  Expected: all five negative tests reject with the documented messages and write nothing; the positive save + deactivate round-trips through the `Dept Config` sheet; effective table + discovery reflect changes on reload; no redeploy required for any edit; cross-dept/non-admin access is refused at the server boundary. The four accessors (getDeptQcdQueues_ / getOverviewParentMap_ / getTeamAvgExcludes_ / getDeptQueueExtsOverride_) layer the sheet over the constants with "non-empty overrides, empty falls back" semantics (INV-54).

S37 | Insights report end-to-end (comparison modes + CR-ported analytics) | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager; click the "Insights" tab (visible to all; per-dept gated server-side like IR/PR/CR).
    - Default compare mode is "Immediately-preceding period". Pick a range with activity + 2+ agents; Generate. Confirm: 6 KPI tiles with delta badges AND 12-month sparklines; the metric-tabbed 12-Month Team Trend chart; per-agent cards each carrying 6 metrics with their OWN delta badges; floaters get the QUEUE chip + warn border and are excluded from the rollup caption's roster-only totals (INV-53).
    - Cards carry a left-border classification tint (improved=accent / regressed=warn / mixed=muted) + a "vs Team" badge; the Sort control re-orders (Most answered default / Name / Biggest improvers / Biggest regressors); agents with no notable movement collapse into "Show N quiet agents".
    - Switch Compare against to "Same window one year prior" -> hint previews the resolved YoY window; Generate -> "Comparing against the selected prior window" line + per-agent prevs from the YoY window.
    - Switch to "Custom prior range" with a window >= 1.2x longer -> form hint warns about the length difference; after Generate, the results show the different-window-lengths banner and per-day sublines on volume/time metrics (INV-35 contract).
    - Queue health (when the dept is QCD-mapped): the per-queue detail table renders one row per queue with abandoned % / abandoned / violations. For a queue whose abandons are driven by a non-Overall call source (4c), the queue-name cell shows a muted "↳ most abandons: <source> (N)" annotation; queues with no sub-source abandons show no annotation. As ADMIN, an `#ins-heatmap` weekday×hour abandon heatmap renders below Queue health (the same shared panel the QCD report shows); managers don't see it.
    - Agent-free run (Phase 2 parity): leave ALL agents unchecked and Generate -> the report runs over the whole dept roster (the digest pattern, INV-45; floaters excluded), rendering the team rollup + Queue health + every roster agent's card -- the QCD-replacement queue/dept quick-look. Generate stays enabled with nothing checked (only a truly empty roster disables it).
    - Export -> Email report sends a SERVER-RENDERED HTML report (department rollup tiles + per-agent delta table) via sendInsightsReportEmail, recomputed from the same params -- no charts in the email (Copy image / Print keep the charts); Print does the same as before.
    - Console negative test: getInsightsReport for another dept throws "Not authorized for this department."
  Expected: all of the above; teamStats matches a Performance Report run with identical inputs to the digit (the unit parity test in insights-report.test.js pins this -- if S37 and S14 ever disagree, the parity test should already be red).

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

### Frozen Subsystems
- DQE Report Legacy — manager-facing reports in `apps-script/dqe-report/`. Frozen because migration to Department Dashboard is complete: Individual Report, Performance Report, Compare Ranges, Missed Calls Report, and Low Answer Rate Alerts all live in the dashboard. Replacement: Department Dashboard. Awaiting decommission of the legacy spreadsheet. Unfreeze only if a bug is found in legacy that affects production decisions before the spreadsheet is retired.

### Deploy Command
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`
CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (same Apps Script project as CDR DQE Pipeline)
CDR Import: `cd apps-script/cdr-import && clasp push -f`
DQE Report Legacy: `cd apps-script/dqe-report && clasp push -f` (frozen — cleanup deploys only)
