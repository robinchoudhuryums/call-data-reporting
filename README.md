# call-data-reporting

Source of truth for the call-data reporting stack:

- **Department Dashboard** — a Google Apps Script web app that serves
  per-department managers a polished view of their team's DQE call metrics.
  Replaces the legacy `DQE Report` spreadsheet. Two-page UI: the
  **Overview** page (cross-department snapshot, the default landing) and
  the **My Department** page (per-agent detail table with date-range
  controls), toggled via header buttons.
- **Reference copies** of related Apps Script code from sibling projects
  (CDR Report, CDR Import) that the dashboard depends on. Pulled in
  gradually so changes across projects can be reviewed in one place.
- **Architecture docs** describing how data flows from the upstream CDR
  system through Raw Data, DQE Historical Data, and Neon Postgres, into
  the dashboard.

## Read first

If you're new to this codebase or chasing a bug, start with the docs:

- [`docs/architecture.md`](docs/architecture.md) — data flow across all
  the moving pieces. Look here first to figure out which layer a problem
  belongs to.
- [`docs/known-issues.md`](docs/known-issues.md) — institutional memory.
  Bugs we've fixed, quirks to respect, design rules to preserve. Read
  before changing anything in the source pipeline or the dashboard's
  data layer.
- [`docs/conventions.md`](docs/conventions.md) — naming, time windows,
  aggregation rules, scope semantics. The "why are TTT and ATT computed
  this way?" reference.

## Repository layout

```
call-data-reporting/
├── README.md                       ← this file
├── docs/                           ← architecture / known issues / conventions
├── apps-script/                    ← all Apps Script project sources
│   ├── department-dashboard/       ← the web app this repo deploys (top-level clasp pushes from here)
│   ├── cdr-report/                 ← the CDR Report project (data hub spreadsheet)
│   │   └── (cd in, then `clasp push -f` to deploy that project)
│   └── cdr-import/                 ← the CDR Import project (CSV ingester)
│       └── (cd in, then `clasp push -f` to deploy that project)
├── tests/                          ← zero-dep Node regression harness (`node --test`); see tests/README.md
├── scripts/                        ← repo tooling (e.g. check-duplicated-files.sh, the INV-16 drift guard)
├── package.json                    ← `npm test` → `node --test`; not a deployable package
├── .clasp.example.json             ← template; copy to .clasp.json on first checkout
├── .clasp.json                     ← per-developer, gitignored (scriptId varies per checkout)
├── .claspignore
└── .gitignore
```

Each subdirectory under `apps-script/` has its own gitignored
`.clasp.json` so per-project deploys are independent. The legacy DQE
Report spreadsheet is being retired and isn't pulled in.

## Running tests

A zero-dependency regression harness loads the real `.gs`/`.js` files
into a Node `vm` with mocked Apps Script globals (no `npm install`,
Node ≥ 18):

```bash
node --test          # from the repo root — runs every tests/unit/*.test.js
npm test             # same thing
```

Non-zero exit on failure. Coverage spans the date/duration parsing,
cache-key hashing, the Dept Config override accessors, the
`computeSummary_` aggregator, the Individual / Performance / Compare
Ranges report builders, and the pipeline's name canonicalization. See
[`tests/README.md`](tests/README.md) for the design, how to add a test,
and the current coverage map. (The end-to-end `buildDQEHistoricalData`
build is not yet unit-covered; the manual Regression Scenarios in
CLAUDE.md remain the verification of record there.) A
`cache-version-sync` test also fails the suite if the docs / inline
comments drift from the code's cache-key versions (INV-30).

## Deploying the Department Dashboard

The web app is deployed from the standalone "Department Dashboard" Apps
Script project (not container-bound to any spreadsheet). Source is pushed
via clasp from this repo.

**One-time setup (from Cloud Shell or any machine with Node):**

```bash
npm install -g @google/clasp
clasp login --no-localhost   # --no-localhost if you're in Cloud Shell

# Create your local .clasp.json from the template. It's gitignored so
# your scriptId stays per-checkout and doesn't conflict on pulls.
cp .clasp.example.json .clasp.json
# Edit .clasp.json -> set scriptId to your Apps Script project's ID
# (Project Settings -> IDs -> Script ID)
```

**Each push:**

```bash
git pull
clasp push -f
# Then in the Apps Script editor: Deploy -> Manage deployments
# -> pencil -> Version: New version -> Deploy
```

To skip the manual "New version" step (a recurring stale-deploy footgun —
`clasp push` alone does NOT update what the live `/exec` URL serves), use
the helper, which pushes *and* rolls the deployment forward in one shot:

```bash
# deployment id comes from `clasp deployments` in that project dir (one-time lookup)
scripts/deploy.sh .                      <dashboard-deployment-id>   # repo root = dashboard
scripts/deploy.sh apps-script/cdr-report <cdr-report-deployment-id>
scripts/deploy.sh apps-script/cdr-import <cdr-import-deployment-id>
# omit the id to just `clasp push -f` and finish the version bump manually
```

**One-time, in the Apps Script project:**

- Project Settings -> Script Properties -> add `SPREADSHEET_ID`
  pointing at the CDR Report spreadsheet's ID (from its URL).
- Run the `setup` function once to create the dashboard-managed
  sheets: `Access Control`, `Alert Config`, `Alert Log`,
  `Pipeline Health`, `Digest Config`, `Agent Alias Overrides`,
  `Orphan Fix Log`, `Dept Config`, and `Report Usage` (nine total;
  created only if missing).
  Requires admin auth — run from the Apps Script editor while
  logged in as an admin listed in `ADMIN_EMAILS` Script Property
  (or `ADMIN_EMAILS_FALLBACK`).
  Safe to re-run later (idempotent; existing data untouched) —
  re-run after pulling new code that introduces additional
  sheets so downstream writers (Pipeline Health appends, Digest
  reads, Orphan Fix log) don't silently no-op against missing
  sheets.
- Populate the `Access Control` sheet with one row per manager
  (Email | Department | Notes).
- Add yourself to the admin list. Two options:
  - **Preferred:** Project Settings → Script Properties → add
    `ADMIN_EMAILS` set to a comma-separated list of admin emails.
    Read at request time via `Config.gs::getAdminEmails_()`; adding
    a new admin is a one-click edit, no redeploy.
  - **Fallback:** edit `ADMIN_EMAILS_FALLBACK` in
    `apps-script/department-dashboard/Config.gs` and redeploy.
    Used only when the Script Property is unset.
- Deploy as Web app: **Execute as: Me**, **Who has access: Anyone within
  [your domain]**.
- After any push that adds a new OAuth scope to `appsscript.json` (e.g.
  `script.scriptapp` for the alerts trigger, `script.send_mail` for
  email exports, `script.external_request` for the orphan-rename-to-Neon
  mirror), open the Apps Script editor and Run → any function
  once to trigger the re-auth consent prompt. Scope-gated calls
  otherwise throw permission errors at runtime even though the
  dashboard page loads fine.

**Optional (manager digest emails):**

- Populate the `Digest Config` sheet (created by `setup()`) with one
  row per subscriber:
  Email | Department | Cadence (`daily`, `weekly`, or `monthly`) |
  Active (TRUE/FALSE) | Notes | Format (`summary` default, or
  `insights` for the Insights-report digest: team rollup deltas + a
  per-agent delta table vs the cadence-appropriate prior window).
- In the deployed dashboard, open Alerts (admin-only) → **Manager
  Digest Subscribers** → **Install digest triggers**. Daily fires
  weekday mornings for the previous day; weekly fires Monday morning
  for the prior Mon&ndash;Fri window; monthly fires on the 1st for
  the prior calendar month.
- When `DASHBOARD_URL` is set, every digest's button deep-links into
  the **Insights report pre-primed to that digest's exact view**
  (window, full roster, and — for weekly/monthly — the matching
  custom prior window, via the state-in-URL share format), so the
  recipient lands one Generate click from the full breakdown.

**Optional (orphan fix):**

- When the CDR feed produces an agent name that doesn't match any
  roster entry (typos, marriages, hyphenations, exotic spellings),
  the row appears in `DQE Historical Data` but doesn't show up
  under any dept. Surface these via the dashboard's
  **Outlier Fix** tab in the top header nav (admin-only).
- For each orphan, pick a canonical name from the roster dropdown
  and click Apply. The action: (1) bulk-renames every row in
  `DQE Historical Data` where Agent Name == orphan, (2) adds the
  mapping to the `Agent Alias Overrides` sheet so the next CDR
  build keeps the mapping, (3) appends a row to `Orphan Fix Log`,
  and (4) best-effort mirrors the rename into Neon's `dqe_history`
  so it isn't lost once aged rows drop from the sheet.
- The modal requires the `Agent Alias Overrides` and `Orphan Fix
  Log` sheets to exist — created by `setup()`. Run `setup()` after
  pulling this code if those sheets are missing in your
  spreadsheet.
- **For the Neon mirror (step 4) to do anything**, set
  `NEON_HOST` / `NEON_DB` / `NEON_USER` / `NEON_PASS` Script
  Properties on the **Department Dashboard** project (same values
  as the import/report projects) and consent the
  `script.external_request` scope (Run → any function once after
  deploy). Without them, the rename still updates the sheet and
  just logs "NEON_HOST not set" for the Neon step. Conflicts (a
  row already under the canonical name on the same day) are skipped
  and reported, not destroyed.
- Admin-only at the server boundary. See CLAUDE.md INV-01 for the
  full security model around the carve-out.

**Optional (Dept Config):**

- The **Dept Config** tab in the header nav (admin-only) edits the
  per-dept maps that used to require a code change + redeploy:
  QCD queues, Overview sub-queue nesting (parent), team-average
  exclusions, and queue-extension overrides. Saved rows live in the
  `Dept Config` sheet (created by `setup()`) and take effect on the
  next request — caches refresh within ~5 min, no redeploy.
- Blank fields fall back to the built-in `Config.gs` defaults
  (`DEPT_QCD_QUEUES`, `OVERVIEW_PARENT_OF`, `TEAM_AVG_EXCLUDES`,
  `DEPT_QUEUE_EXT_OVERRIDES`); a non-empty field overrides that
  dept's default. See CLAUDE.md INV-54 for the full override
  semantics + accessor contract.
- The modal auto-discovers queue names from `QCD Historical Data`
  col D (last 180 days) and surfaces **unmapped** queues first so
  you can see what still needs a dept. Saves are validated: queue
  names must exist in the data, Overview parents must be real depts
  with no nesting cycle, team-avg excludes must be on the dept
  roster, and queue-ext overrides must be digits.
- Requires `setup()` to have created the `Dept Config` sheet; until
  then the accessors fall through to the constants (so behavior is
  unchanged) and the modal's Save throws "Dept Config sheet missing
  — run setup()".

**Optional (QCD Report):**

- The **QCD Report** modal (click the **QCD** tab in the header nav) reads from
  `QCD Historical Data`, written daily by the import pipeline.
  Visible to all managers + admins; per-dept gated.
- **The dept ↔ queue mapping is admin-editable without a redeploy.**
  Each dashboard dept maps to one or more raw queue names
  (e.g. `A_Q_CustomerSuccess`, `A_Q_Sales`) — the values in
  `QCD Historical Data` col D. Canonical spellings vary per
  install (this one's CSR queue is `A_Q_CustomerSuccess`).
  **Preferred:** open the **Dept Config** tab (admin-only), which
  auto-discovers the queue names from col D and flags unmapped ones;
  pick the dept and add its queues — takes effect on the next
  request, no redeploy (see "Optional (Dept Config)" below and
  CLAUDE.md INV-54). The `Config.gs::DEPT_QCD_QUEUES` constant
  remains the seed default beneath the sheet.
- A dept with no mapped queues (neither a `Dept Config` row nor a
  `DEPT_QCD_QUEUES` entry) renders an empty modal with a "No queues
  mapped" hint and no Overview QCD chips. New depts producing QCD
  rows won't show up until mapped one of those two ways.
- **Sub-queue rollup** is automatic via `OVERVIEW_PARENT_OF`
  (CompanyOverview.gs): viewing a parent dept's QCD report
  auto-includes its children's queues. Current parents are
  Sales (rolls up PAP), Power (rolls up PAK), and CSR (rolls
  up Spanish). Each child dept still has its own
  `DEPT_QCD_QUEUES` entry so the child's own modal works.
- After QCD data flows, the Overview page's per-dept tiles gain
  an "Aban N (P%)" chip (warn-tinted when ≥ 5%) and a
  "X viol MTD" badge when month-to-date violations are > 0. The
  My Department page shows a "Yesterday's QCD" tile row below
  the agent table.

**Optional (Inbound report + insurer labeling):**

- The daily import captures ONE record per distinct inbound call
  (disposition, abandon stage, abandoned-on-hold, wait/hold seconds,
  dial-in line, queue journey) into Neon's `inbound_calls` table
  (`cdr-import/inboundCalls.js`; phone numbers HMAC-hashed, Anonymous
  callers carry a null hash). Requires `HMAC_SECRET` + `NEON_*` Script
  Properties in the **CDR Import** project; skipped cleanly when
  unset.
- The **Inbound** tab (`#/report/inbound`) reads that table directly
  from the dashboard project (needs the dashboard's `NEON_*` props +
  `script.external_request` scope, same as the F1 read-back). It is
  per-dept gated like the other reports: managers see their own
  department's slice (calls attributed by entry queue through the same
  dept → queue map QCD uses; an answered call abandoned on hold
  belongs to the answering department), while admins can also pick
  "All departments" — the only view that includes the unattributable
  "Abandoned in IVR" bucket. Clicking an insurer row expands its
  daily volume / abandon-rate trend. It renders an "unavailable"
  state when Neon is unreachable — there is no sheet fallback for
  this report.
- **Insurer labels:** maintain the insurance block in `DO NOT EDIT!`
  cols X–AG (header row = insurer name, rows below = that insurer's
  published numbers incl. country code), then run
  `syncInsuranceNumbersToNeon` from the **CDR Report** editor. Re-run
  it after every edit to the block — unsynced numbers show as
  "(unlabeled)" in the report. Only the HMAC hash + label reach Neon.
- **History:** run `backfillInboundCalls` from the **CDR Import**
  editor (repeat until the log says "complete") to fill
  `inbound_calls` from the per-day `Call_Legs_*` sheets that still
  exist. Optionally run `exportInboundCalls` from the **CDR Report**
  editor (schedulable) to keep the "Inbound Calls" tab as a durable,
  pivot-friendly copy of the Neon table.

**Optional (alerts):**

- Populate the `Alert Config` sheet with one row per dept that should
  receive low-answer-rate alerts:
  Department | Threshold % | Extra Recipients (comma-separated) |
  Active (TRUE/FALSE) | Notes | Skip Dates.
- **Skip Dates (col F, optional)** accepts comma-separated
  `YYYY-MM-DD` dates and inclusive ranges via `..` (e.g.
  `2026-12-25, 2026-12-31..2026-01-01`). Honored by the daily
  trigger only -- manual sends from the dashboard's Alerts modal
  always fire, so an admin can still force-send after a holiday
  review. Malformed tokens are silently dropped (parser is
  intentionally tolerant). Pre-E8 sheets keep their 5-col header
  row; data still flows because the reader indexes col F by
  position. To add the header label `Skip Dates` to F1 on an
  existing sheet, paste it in manually -- `setup()` won't add
  columns to existing sheets (per CLAUDE.md INV-22).
- Project Settings -> Script Properties -> add `DASHBOARD_URL`
  pointing at the deployed web app's URL. **Strongly recommended
  since Phase C** — two consumers depend on it: (a) the "Open
  Dashboard" link in alert emails (without it, emails still send
  but omit the link), and (b) the `↗ Open in new tab` buttons on
  every report modal (without it, the buttons silently hide and
  the side-by-side-comparison flow doesn't work). The deep-link
  hash routes (see below) only work when this is set.
- Install the daily trigger: open the dashboard as an admin, click
  Alerts → Install daily trigger (8 AM). The trigger calls
  `runDailyAlerts_` for the previous day, skipping Saturdays and
  Sundays automatically.
- Once the trigger has been running for ~10 weekdays, the Alerts
  modal's config table gains a **Last 30 days** chip per dept
  summarizing recent trigger outcomes (E10). Warn-tinted chip =
  threshold firing chronically (alert fatigue likely); muted =
  threshold sits well below actual performance and may be too
  loose; sage = healthy mix. Hover for the specific fired-count +
  mean answer rate. Tunable in `Alerts.gs` (`DRIFT_*` constants).

**Optional (Neon read-back + keep-warm):**

- The dashboard reads DQE from the `DQE Historical Data` sheet by
  default. To read from Neon's `dqe_history` instead, set the
  `DQE_READ_SOURCE` Script Property to `neon` (anything else / unset =
  `sheet`). Cut-over readers (`getLatestDataDate`, `getCompanyOverview`,
  `computeSummary_`, and the Individual / Performance / Compare builders)
  fall back to the sheet on any Neon null/error, so the flip is reversible
  with no redeploy. Needs the `NEON_*` props + `script.external_request`
  scope (same as the orphan-rename mirror).
- The Alerts modal (admin) shows a **Neon mirror health** line comparing the
  DQE sheet's latest date against `dqe_history`'s `MAX(call_date)`, so a stale
  mirror (e.g. a transient Neon outage that left a date un-mirrored) is
  visible at a glance. Such a gap self-heals on the next import of that date
  — the dup-guard re-mirrors the existing sheet rows. (Hidden when `NEON_*`
  isn't configured.)
- **Before flipping**, run the parity gate from the Apps Script editor:
  open `NeonRead.gs`, edit `COMPARE_FROM` / `COMPARE_TO` in
  `compareDqeSources_` to a range fully inside the mirrored history, then
  Run **`runDqeParityCheck`** (the editor's Run picker hides `_`-suffixed
  functions, so use this non-underscore wrapper). A "PARITY CLEAN" log =
  safe to cut over. Create the two indexes first so the Neon reads stay
  fast:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_dqe_history_call_date ON dqe_history (call_date);
  CREATE INDEX IF NOT EXISTS idx_dqe_history_date_agent ON dqe_history (call_date, agent_name);
  ```
  Each cut-over reader logs `[dqe-read] <label> source=<neon|sheet>
  rows=<n> ms=<elapsed>` so you can compare read cost in the Executions
  panel.
- **Keep-warm (optional):** Neon's free tier suspends the compute after
  ~5 min idle, so the first DQE read of a lull pays a cold-start penalty.
  In the dashboard, open Alerts (admin) → **Neon keep-warm** → **Enable**
  to install a trigger that pings Neon every 5 min during a weekday
  business-hours window (default 7 AM–1 PM Central, ~132 compute-hrs/mo —
  under the ~190h free allowance). Tune via the `NEON_KEEPWARM_START_HOUR`
  / `NEON_KEEPWARM_END_HOUR` Script Properties; the modal surfaces the
  estimated monthly hours + last-ping outcome. Needs the
  `script.scriptapp` + `script.external_request` scopes. Reversible —
  Disable removes the trigger and clears the flag. Only matters once
  `DQE_READ_SOURCE=neon`.

**Optional (deferred Neon mirror):**

- By default the daily import mirrors CDR / QCD / DQE / Inbound to Neon
  **inline** inside `processIntegratedHistory` — the Neon write is the
  dominant cost of the run. To move it off the synchronous import path
  (so a slow or cold Neon can't push the import toward the Apps Script
  execution ceiling), set the **CDR Import** project's
  `NEON_MIRROR_MODE` Script Property to `deferred` (unset / `inline` =
  the original behavior, unchanged).
- First install the trigger: in the CDR Import project, **CDR Tools →
  Install Neon Mirror Trigger** (installs `runNeonMirror_`, every 15
  min; needs the `script.scriptapp` scope — grant on first run). In
  `deferred` mode the import writes only the sheets and enqueues each
  date to a `Neon Mirror Queue` tab in the CDR Report spreadsheet; the
  trigger drains the queue minutes later by re-deriving each payload
  from the Historical Data sheets and upserting via the same writers
  (`ON CONFLICT`, so retries are safe). The daily toast shows
  `Neon ⏳ queued`; per-type outcomes land as `neonMirror:*` Pipeline
  Health rows.
- Validate on one import before relying on it: confirm the queue drains,
  `neonMirror:*` rows show `success`, and the dashboard data is current.
  Reversible with no redeploy — set `NEON_MIRROR_MODE=inline` (or clear
  it). Once trusted, uninstall the CDR Report `runDailyDQEBuild_`
  safety-net trigger so DQE isn't mirrored both inline and via the
  queue (harmless but redundant). Needs the same `NEON_*` props the
  inline mirror uses. See CLAUDE.md Operator State #22 + the
  "Deferred Neon mirror" gotcha for the full contract.

## Deep links

Phase C (commit ce4220a) added URL hash routing so any report
modal can be linked to directly. Append one of these fragments to
the deployed web-app URL to land on that view:

- `#/overview` — Overview page (default landing)
- `#/dept` — My Department page
- `#/report/missed` — Missed Calls report
- `#/report/individual` — Individual Report
- `#/report/performance` — Performance Report
- `#/report/compare` — Compare Ranges
- `#/report/qcd` — QCD Report
- `#/report/insights` — Insights (period comparison: team rollup + per-agent delta cards)
- `#/report/inbound` — Inbound Report (per-dept gated; Neon-backed)
- `#/admin/alerts` — Low Answer Rate Alerts (admin-only)
- `#/admin/orphan-fix` — Outlier Fix (admin-only)
- `#/admin/dept-config` — Dept Config (admin-only)
- `#/admin/caller-lookup` — Caller Lookup (admin-only): trace every
  inbound call from one phone number — outcome, wait/hold, and the
  leg-by-leg journey for calls captured since the journey extension.
  Requires `HMAC_SECRET` on the dashboard project (same value as CDR
  Import / CDR Report) plus the `NEON_*` properties.

Each report modal also carries a small `↗` button next to its
close X — clicking it opens the same view in a new browser tab so
you can OS-tile two windows side-by-side for comparison. Requires
the `DASHBOARD_URL` Script Property to be set (see Alerts setup
above); the button silently hides when unset.

For the four agent-comparison reports (Individual / Performance /
Compare Ranges / Insights), the `↗` button also serializes the
modal's **current form state** — dates, compare mode, custom prior
window, and agent selection — into the link as `#/route?from=...&
agents=a|b`, so the new tab (or a pasted link) restores the exact
form primed for a one-click Generate. Generation is intentionally
not auto-triggered (the agent roster loads asynchronously). The
simpler forms (QCD / Missed / Inbound) still deep-link to the modal
with their localStorage-restored state.

## Plain-English layer (anti-intimidation)

Three client-only affordances lower the barrier for managers who find
the reports intimidating; none add server endpoints or cache bumps:

- **Question launcher** — the Overview page opens with four
  plain-English question chips ("How is my team doing lately?",
  "Why did we miss calls recently?", "Is one of my agents struggling
  or improving?", "Are callers giving up before we answer?") that
  route into Insights / Missed Calls / Individual / QCD pre-primed
  with a sensible window. Insights, Missed, and QCD auto-generate;
  the Individual Report stops at the primed form because "which
  agent?" is the user's question to answer.
- **Metric glossary** — one central dictionary in `script.html`
  (`METRIC_GLOSSARY_`) applies hover/tap definitions to table headers
  and KPI labels everywhere (dotted underline = definition available).
  Add new metric terms to the dictionary, not as inline `title=`
  attributes, so definitions stay consistent across reports.
- **Benchmark tints** — the two real company-wide standards (the 92%
  answer-rate target from the Overview baseline, and the 5%
  abandoned-% violation threshold from the QCD rule) tint KPI values
  and abandon-% cells consistently across reports
  (`script.html::benchValueCls_`). Dept-specific alert thresholds
  intentionally stay with the Alerts engine.

Every report's results also open with an "At a glance" block of 2–3
plain sentences (`reportHeadline_` + per-report composers).

## DQE Historical Data freshness

The dashboard reads from `DQE Historical Data`; three paths
keep it fresh, in order of preference:

1. **Integrated daily path (primary)** — cdr-import's
   `processIntegratedHistory` now builds DQE inline as the 5th
   historical sheet write, alongside CDR / Q Path / QCD / CSR.
   Every successful daily import (whether triggered by onChange
   or `runManualExport`) refreshes DQE in one run. Telemetry
   row: `processIntegratedHistory:DQE` in Pipeline Health. If a
   date is already in the sheet but its Neon mirror previously
   failed (transient outage), a later non-force re-import
   re-mirrors the existing rows so `dqe_history` self-heals.
2. **Bulk historical backfill path** — `bulkHistoricalUpdate`
   in cdr-import builds DQE per-date for the requested range,
   writing Raw Data per-date only when DQE actually needs
   rebuilding. Telemetry row: `bulkBackfill:DQE`. The bulk path
   **defers the per-date DQE→Neon mirror** (`skipNeon`) so the
   sheet rebuild isn't slowed by Neon's JDBC latency — after a
   bulk run, run **`backfillDQEHistoryUpsert()`** (CDR Report
   project; resumable via `DQE_UPSERT_RESUME`) once to mirror the
   rebuilt dates into `dqe_history` with `DO UPDATE` (so
   re-calculated values overwrite stale rows). The bulk-complete
   alert reminds you. Tip: rebuild in ~10-date ranges so the final
   batch-archive step stays well under the 30-min ceiling.
3. **Standalone safety-net trigger (transitional)** — the
   cdr-report project's `runDailyDQEBuild_` time trigger
   (originally the only DQE refresh mechanism) is preserved
   while the integrated path stabilizes. Telemetry row:
   `buildDQE`. Install via CDR Report spreadsheet's **CDR
   Tools** menu → **⏰ Daily DQE Build Trigger** →
   **Install (runs at 7 AM)**, or run `installDQEBuildTrigger`
   from the editor. The Run dropdown will prompt for the
   `script.scriptapp` and `script.send_mail` permissions if
   they haven't been granted yet. Skips Saturdays/Sundays;
   emails `NEON_WRITE_CONFIG.alertEmail` on failure. Uninstall
   via the same menu (or `uninstallDQEBuildTrigger`) once a
   week's worth of `processIntegratedHistory:DQE` rows appear
   consistently in Pipeline Health.

INV-16 keeps the two `buildDQEHistoricalData.js` copies
(cdr-import + cdr-report) byte-identical -- any edit to one is
a two-file edit.

**Extending history backwards (older pre-pipeline data).** The trend
charts only reach as far back as `DQE Historical Data` does. To extend
them with older rows you already have in another spreadsheet (same
columns), **copy-paste those rows directly into `DQE Historical Data`** —
do NOT run a build for those dates (`buildDQEHistoricalData` recomputes
from `Raw Data`, which no longer exists that far back). Before relying on
the older numbers, run **`runHistoricalBackfillCheck`** from the
Department Dashboard editor (edit `OLD_SS_ID` / `OLD_SHEET` inside it) —
it diffs the old sheet against the current one over the overlapping
`(date, agent)` rows and logs what % match exactly, so you can quantify
any calculation drift first. Pasting is sufficient on the default
sheet read source; only if `DQE_READ_SOURCE=neon` do you also run
`backfillDQEHistoryUpsert()` once to mirror the pasted rows into Neon.

## Working on sibling Apps Script projects

`apps-script/cdr-report/` and `apps-script/cdr-import/` are full clasp
projects pulled from their live Apps Script counterparts (Phase R3
complete). Each has its own gitignored `.clasp.json`. To deploy a fix
to one of them:

```bash
cd apps-script/cdr-report          # or cdr-import
clasp pull                          # if you suspect the live project drifted
# ... edit files ...
clasp push -f
```

The `cd` matters: clasp looks at the nearest `.clasp.json` walking up
from the current directory. Running `clasp push` from the repo root
pushes the dashboard project, not the sibling.

**First-time setup for a sibling project** (e.g., after a fresh clone of
this repo): each subfolder needs a `.clasp.json` with the project's
scriptId. The file is gitignored on purpose. Either ask the maintainer
for the scriptId, or look it up in the live project's Apps Script
**Project Settings → IDs → Script ID** and write your own:

```bash
cd apps-script/cdr-report
cat > .clasp.json <<'EOF'
{ "scriptId": "<paste-scriptId-here>" }
EOF
clasp pull
```
