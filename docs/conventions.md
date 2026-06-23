# Conventions

Naming, formatting, and semantic rules used across the call-data-reporting
projects. If you find yourself wondering "should X be done like Y or like
Z?" — check here first, and add an entry if the answer wasn't documented.

## Work window

The canonical work window for DQE metrics:

| | PST | CST | CDT |
|---|---|---|---|
| Start | 6:30 AM | 8:30 AM | 9:30 AM |
| End   | 3:00 PM | 5:00 PM | 6:00 PM |

In code (`buildDQEHistoricalData.gs`):

```js
const DQE_WINDOW_START = (6 * 60 + 30) * 60;  // 6:30 AM PST in seconds
const DQE_WINDOW_END   = 15 * 60 * 60;        // 3:00 PM PST in seconds
```

`Total Rung`, `Total Missed`, `Total Answered`, `TTT`, `ATT`, and the 19
missed-call time-slot columns (K-AC) all filter to this window. Calls
outside the window are dropped from those aggregates entirely.

Abandoned-call columns (AD, AE, AF, AG, AH) currently do **not** apply
the work window — they reflect all-day abandoned counts. If that turns
out to be wrong, fix it in the source pipeline and add an entry to
[known-issues.md](known-issues.md).

## Timezones

| Where | Value | Why |
|---|---|---|
| Raw Data timestamps | PST (UTC-8 or UTC-7 with DST) | Comes from the external CDR system this way |
| `DQE Historical Data` display | CST (via `pstToCSTStr` in `buildDQEHistoricalData.gs`) | Internal team's home timezone |
| Spreadsheet timezone (CDR Report) | "Central Time - Mexico City" (GMT-06:00, no DST) | Historical — see [known-issues.md](known-issues.md) |
| Script timezone (`appsscript.json`) | `America/Chicago` | Matches the team's home TZ |
| Dashboard date pickers | Browser-local | Phase 1 default. Phase 3 may add explicit TZ controls. |

The PST-to-CST offset is hardcoded: `DQE_PST_TO_CST = 7200` (2 hours).
This will silently be wrong if either side observes DST differently — the
US (both PST and CST) DSTs in sync, so this is currently fine.

## `DO NOT EDIT!` roster sheet format

The right block of the `DO NOT EDIT!` sheet (cols F onward, starting at
row 2 for agent data) holds the dept rosters.

### Column layout

- **Row 1**: department headers (`CSR`, `Sales`, `Power`, `Resupply`, ...)
- **Row 2+**: agent cells

### Cell format

Each agent cell is **`Name`** or **`Name, ext1, ext2, ...`** where:

- The agent's name is everything **before the first comma**.
- Subsequent comma-separated tokens are queue extensions. Only digit-only
  tokens are kept; other tokens (like a "Jr." suffix) are ignored.

Examples:

| Cell value | Parsed |
|---|---|
| `Dalia Nared` | name=`Dalia Nared`, extensions=`[]` |
| `Robin Choudhury, 139` | name=`Robin Choudhury`, extensions=`["139"]` |
| `Robin Choudhury, 139, 165` | name=`Robin Choudhury`, extensions=`["139","165"]` |

### Dept block boundary

The dept block ends at the **first blank cell** in row 1 starting from
column F. Anything past that gap (currently cols X-AG hold unrelated
reference data) is ignored. If you add a new dept, append a column at
the right edge of the dept block — don't insert a gap.

### Left block (queues)

Cols A-C of the same sheet hold queue metadata (`Call Queue | Extension
| Call Queue`). This is not currently read by the Department Dashboard
(extensions come from the roster cells), but `buildDQEHistoricalData.gs`
may reference it. Don't touch it without checking.

## Agent name matching

**Exact string match at the dashboard layer.** No normalization for
whitespace or case at read time. The pipeline canonicalizes
parenthesized-nickname variants against the roster before writing, so
the exact match stays reliable across CDR feed spelling variations.

- `DQE Historical Data` Col C (Agent Name) must match `DO NOT EDIT!`
  cell values byte-for-byte (after the cell is parsed via the rules
  above).
- A typo on either side that is *not* just a parens difference will
  still cause the agent to silently disappear from their dept's view.
- Paren-variant case: `buildDQEHistoricalData` reads the roster once
  per build; any incoming CDR row whose paren-stripped name matches
  exactly one roster entry is rewritten to the roster's canonical
  form. The strip removes the PARENTHETICAL (parens + contents), so
  roster `Roman (Robin) Paulose` consolidates an incoming
  `Roman Paulose` or `Roman (Bob) Paulose` — both strip to
  `Roman Paulose`, the roster entry's stripped form. A name with an
  EXTRA word, like `Roman Robin Paulose`, does NOT consolidate — it
  strips to itself, which matches no roster entry, and is written
  as-is (it surfaces as an orphan for the Orphan Fix modal). See
  `docs/known-issues.md` → "Roster-driven
  name canonicalization" for details + edge cases.
- The Department Dashboard surfaces orphans in its Diagnostics panel
  (and via the `whyNoMatches_` editor diagnostic) — check there first
  when an expected agent doesn't show up.

When an agent's display name changes (marriage, alias, etc.), update
both sides at once -- OR use the dashboard's **Admin → Orphan Fix**
modal to map the orphan to an existing roster name (writes to
`Agent Alias Overrides` so future builds keep the mapping, and
optionally backfill-renames past rows in DQE Historical Data).

### Canonicalization layers (priority order)

`buildDQEHistoricalData`'s `canonicalizeAgentName` checks three
layers in order, returning the first hit:

1. **Admin alias overrides** -- `Agent Alias Overrides` sheet (only
   `Active=TRUE` rows). Maintained via the Orphan Fix modal; the
   highest-priority lookup so admins can override anything below.
2. **Exact roster match** -- if `rawName` already appears in any
   dept's roster cell (after the `"Name, ext1, ext2"` parse), it
   passes through unchanged.
3. **Paren-strip ambiguity-free match** -- strip `\(.*?\)` from
   `rawName`, then check whether exactly one roster entry has the
   same stripped form. Match = rewrite to canonical; >1 match or 0
   match = pass through unchanged.

Implemented in `apps-script/cdr-report/buildDQEHistoricalData.js`
(`canonicalizeAgentName` + `loadRosterCanonicalNames_`). The alias
sheet read is best-effort: a missing or empty sheet leaves the
build's behavior byte-identical to pre-OrphanFix.

## Aggregation rules (Department Dashboard)

For a date range with one or more rows per agent:

| Column | Rule |
|---|---|
| Total Unique | Sum across rows |
| Total Rung | Sum across rows |
| Total Missed | Sum across rows |
| Total Answered | Sum across rows |
| TTT | Sum across rows |
| ATT | **Simple mean** of stored per-row ATT values. **Not** weighted (`TTT / Answered`). |
| Avg Abd Wait | Simple mean of stored per-row values |
| CSR Avg Abd Wait | Simple mean of stored per-row values |
| Days Active | Count of distinct dates the agent has a row in range |

### Why ATT is a simple mean and not `TTT / Answered`

For single-row date ranges, the dashboard must match the existing DQE
Report's stored ATT exactly — managers are used to those numbers and a
1:1 swap needs to look identical. The source's stored ATT is sometimes
computed with a denominator other than `Total Answered` (see
[known-issues.md](known-issues.md)), so a weighted dashboard formula
would silently disagree with the source.

For multi-row ranges, simple mean is also what the abd-wait columns do
— consistent across all "average" columns in the table.

If we ever fix the source ATT to truly equal `TTT / Answered`, we can
switch the dashboard to weighted without managers noticing a change.

### Why Individual / Performance Reports use weighted ATT

The Individual Report and Performance Report compute ATT as
`sum(att * answered) / sum(answered)` across days in range, NOT the
simple mean above. Two reasons:

1. **Matches the legacy reports each migrated from.** Both were
   weighted in the DQE Report spreadsheet — switching to simple mean
   would have visibly changed manager-facing numbers on the same data.
2. **Days with answered=0 contribute 0 to both numerator and
   denominator**, so unanswered/abandoned days don't drag the ATT
   down. Useful for agents who routinely have low-activity days
   (sick leave, training, etc.).

If you ever consolidate ATT semantics across all dashboard surfaces,
you'll need to either also fix the main table (and accept managers
seeing different numbers) or accept that the two surfaces serve
slightly different reading semantics. Document any change in
`known-issues.md` and bump every cache prefix
(`summary:`, `individual:`, `performance:`).

### Totals row

Per-row aggregates above; the totals row uses the same methods:

- Sum columns sum the rows in the table.
- Mean columns (ATT, Avg Abd Wait, CSR Avg Abd Wait) take a simple mean
  of the per-agent rows displayed.

## Dashboard scope semantics

Scope controls how rows are matched to a department. Three scopes
exist internally:

| Scope | Rule |
|---|---|
| **Roster** | Include rows where `Agent Name ∈ dept_roster_names` |
| **Queue** | Include rows where `row.queueExtensions ∩ dept_queue_extensions ≠ ∅` |
| **Both** (production) | Union of the two |

`dept_queue_extensions` is the effective queue-ext set for the dept
(`getDeptQueueExts_` in Data.gs: the Dept Config / constant override
when set, else derived from the dept's roster agents' col-D values
across all history).

**The user-facing scope toggle was retired in the redesign cleanup
(commit 53d0560)** after the Phase D parallel-run validation: the
public RPCs (`getDepartmentSummary`, `getMissedCallsReport`) lock
scope to `both`. Rows matched via Queue but not via Roster render a
`QUEUE` Source chip (with their other-dept roster homes) and are
excluded from dept totals and team averages (INV-53); they also
appear in the Diagnostics panel under "Agents matched only via
queue". The internal `scope` parameter on `computeSummary_` is
preserved because `Digest.gs` still passes `'roster'` for the
manager-digest path; historical roster-only numbers are reproducible
from a `both` response by summing only `matchedViaRoster=true` rows.

## Auth and access

- **Admins**: resolved at request time via `Config.gs::getAdminEmails_()`,
  which reads the `ADMIN_EMAILS` Script Property (comma-separated emails)
  and falls back to the `ADMIN_EMAILS_FALLBACK` constant in
  `apps-script/department-dashboard/Config.gs` if unset. Bypass the
  manager dept check; can pick any department from the admin dropdown.
  Adding an admin is a Script-Property edit, no redeploy.
- **Managers**: rows in the `Access Control` sheet (`Email | Department |
  Notes`). One row per manager. Pinned to a single department.
- **Everyone else**: gets the access-denied page.

Access-control lookups are cached for 60 seconds (`AUTH_CACHE_TTL_SECONDS`).
Adding a new manager to the sheet is reflected within 60 seconds without
a redeploy.

## File and function naming

- `.gs` files: PascalCase by concern (`Code.gs`, `Auth.gs`, `Data.gs`,
  `Setup.gs`, `Config.gs`, `Diagnostics.gs`). One file per concern.
- `.html` files in the dashboard: lowercase by role (`dashboard.html`,
  `styles.html`, `script.html`, `access_denied.html`).
- **Trailing-underscore convention**: any function meant to be private
  (i.e., not callable from `google.script.run`) ends in `_`. Apps Script
  enforces this. See [known-issues.md](known-issues.md) "Dashboard
  design rules".
- Constants: `UPPER_SNAKE_CASE` (`ADMIN_EMAILS`, `CACHE_TTL_SECONDS`,
  `ROSTER`, `HISTORICAL_COLS`).

## Dashboard chrome

### Header freshness pill

Small badge in `.header-meta` ("Data through Mon May 19 · 14h ago")
populated by `setFreshnessPill_` once `getLatestDataDates` (plural)
returns. The plural variant returns `{dqe, qcd, latest}` -- the
pill renders against `latest` (the MAX) so it doesn't go stale
when one source updates without the other. Computes age from
end-of-day on that date. Past 36h the pill picks up the
`.is-stale` class and tints warm orange. Hidden on fetch failure
/ empty data so the header doesn't show a misleading fallback.
Updates only on page load (not live). Tunable in
`setFreshnessPill_` if 36h becomes too noisy in practice. The
singular `getLatestDataDate` still drives the My Department
From/To default (which must snap to DQE specifically).

## Per-report semantics

### Individual / Peer Comparison Report

- **Mode** is chosen by the picker, not the user: 1 selected agent =
  Individual; 2+ = Peer Comparison.
- **Team avg denominator** = count of roster agents with *any* call
  activity in the selected range. Zero-call roster members are
  excluded so they don't dilute the per-agent baseline (INV-27).
- **`TEAM_AVG_EXCLUDES` config** (`Config.gs`) is a per-dept map of
  agent names removed from BOTH numerator and denominator of the team
  avg. Used for managers on the roster who take only a token number
  of calls. Current entry: `'CSR': ['Robin Choudhury']`. Match is
  exact on the roster name. To remove your own name from the team
  baseline for some dept, append it to this map. Does NOT apply to
  the Performance Report.
- **Trend window**: range itself when selected range > 366 days OR
  equals a full calendar year (Jan 1 - Dec 31); else
  `first-of-month(end - 12 months)` to `end`. Performance Report
  uses the same logic so the two reports' 12-mo trends align.
- **Insights** are objects `{ type, text }` where `type ∈
  {positive, negative, neutral}`. The UI renders a colored circular
  marker before the text (blue ↑ / orange ↓ / grey •). Direction
  encoding doubles up color + arrow shape for CVD users. ATT
  comparisons are always neutral by policy — longer can mean
  thorough service or slow handling, depends on context.

### Performance Report

- **Treats the user's selection AS the team** — the team total = sum
  over the SELECTED agents only, not the full roster. To get
  full-dept totals, select the full roster from the picker.
- **`TEAM_AVG_EXCLUDES` does NOT apply.** If you don't want a
  manager's calls in the totals, just don't select them.
- **Prior period = same duration ending one day before current
  start** (INV-28). A 31-day current window compares against the
  immediately-preceding 31 days, NOT against the previous calendar
  month. So "Last Month" preset for Dec (31 days) compares against
  Oct 31 - Nov 30 (31 days). Surfaced in the form's inline hint +
  the results header. A "Compare with..." form control lets the
  user override the auto-computed prior with a custom range.
- **Delta semantics**:
  - Volume metrics (Rung / Missed / Answered / TTT): relative
    percent change `((curr - prev) / prev) * 100`. `0 -> 0` returns
    `0`; `0 -> nonzero` returns `+100`.
  - % Answered: ABSOLUTE point difference `(curr_pct - prev_pct)`.
    Multiplying a percentage by a percentage reads as confusing.
  - ATT: relative percent change of the weighted average.
- **Delta valence (UI coloring)**:
  - Rung / Answered / % Answered: above = blue (positive)
  - Missed: above = orange (negative)
  - TTT / ATT: always neutral grey

### Compare Ranges

- **Per-dept authorization** (INV-32). Same model as the Individual
  and Performance Reports: managers can only request their own dept;
  admins can pick any dept. Previously admin-only; opened to managers
  for year-over-year and month-over-month comparisons within their
  own dept.
- **Agent-centric**: like Individual / Performance, the user's
  selection IS the team. No `TEAM_AVG_EXCLUDES` filter applies.
- **Two arbitrary periods**: P1 (baseline) and P2 (comparison).
  Periods may overlap, may be different lengths, do not have to be
  adjacent. Deltas computed as P2 vs P1.
- **Length-mismatch handling** (INV-35): if
  `max(p1Days,p2Days) / min(p1Days,p2Days) >= 1.2`, the server
  emits `meta.lengthMismatch=true`. The client renders a
  length-mismatch banner, per-tile "per day" captions on volume +
  time KPIs, and a `P1/day` + `P2/day` pair in the CSV export.
- **Agent classification** (left-border color on each card):
  votes across 4 valenced metrics (rung up = +1, missed up = -1,
  answered up = +1, % answered up = +1). Score >= 2 = improved
  (blue), <= -2 = regressed (orange), else mixed (grey).
- **Quiet agents** (no metric moved beyond a noise floor) collapse
  into a `<details>` below the main grid; image-export + print
  force them open so captures are complete.
- **Improvement score** (used for sorting + the per-card "vs Team"
  badge): `rungDeltaPct - missedDeltaPct + answeredDeltaPct + 5 *
  pctDeltaPts`. The 5x scaling for percentage points is a
  judgment call to align magnitude with relative volume changes.

### QCD Report

- **Per-dept authorization** (INV-32 model): managers see their own
  dept's QCD report; admins pick any from the dropdown. Same gate
  used by Individual / Performance / Compare Ranges.
- **Dept ↔ queue mapping** lives in `Config.gs::DEPT_QCD_QUEUES`.
  `QCD Historical Data` col D holds raw `A_Q_*` queue names; the
  dashboard's dept labels (`CSR` / `Sales` / `Power`) only resolve
  through this map. Unmapped depts render an empty modal with a
  hint; see [`known-issues.md`](known-issues.md) → "QCD Report
  engine" for onboarding details.
- **Source filter**: only rows where `Call Source === 'Total Calls'`
  are summed. Other sources (`CSR`, `Ad-campaign`, `New Call
  Menu`, `Non-CSR (internal)`) are sub-counts that would
  double-count if added alongside the daily roll-up.
- **Aggregation across dept queues**:
  - `Total Calls`, `Total Answered`, `Abandoned`, `Violations`: sum
    across the dept's mapped queues in range.
  - `Longest Wait`: **MAX** across all days in range (worst
    observed). Avg per-day would dilute the operationally useful
    "this was the worst" signal.
  - `Avg Answer`: simple mean across days with non-zero values
    (matches legacy `buildTable4` semantics).
- **Per-queue breakdown table**: one row per queue in
  `DEPT_QCD_QUEUES[dept]` (preserves config order), plus a bolded
  "Department total" tfoot row. Each row carries its own
  Total Calls / Answered / Abandoned / Abandoned % / Longest /
  Avg / Violations.
- **Trend chart**: 12-month monthly buckets rolled up across all
  dept queues. Trend-window resolution matches IR/PR (range
  itself when > 366 days OR a full calendar year, else
  first-of-month(end - 12 months) → end).
- **Overview tile chips**: when QCD data exists for a dept, an
  "Aban N (P%)" chip always renders; warn-tinted when P >= 5%
  (the pipeline's violation threshold). A "X viol MTD" chip
  renders only when month-to-date violations > 0. Visible to
  everyone -- managers see all depts' chips on Overview, same as
  the rest of the cross-dept landing.
- **My Department "Yesterday's QCD"**: tile row under the agent
  table showing the dept's most-recent QCD day. Auto-refreshes
  with the rest of the page. Hidden when the dept has no QCD
  mapping or no recent rows.

### Low Answer Rate Alerts (admin-only)

- **Admin-only at the server boundary** (INV-32). All public
  callables in `Alerts.gs` call `assertAdmin_` first.
- **Sheet-driven config** (INV-34): thresholds + extra recipients
  live in the `Alert Config` sheet; per-fire results live in
  `Alert Log`. Both idempotently created by `setup()`.
- **Recipients per dept** = dept managers from Access Control ∪
  Extra Recipients (from Alert Config), with `ADMIN_EMAILS`
  always cc'd. Deduped; managers first.
- **Status enum** (used in UI + log Sent column): `sent` /
  `would-send` (dry-run / preview) / `above-threshold` (healthy)
  / `no-data` / `no-recipients` / `skipped` (inactive) / `error`.
- **Daily trigger** (`runDailyAlerts_`) skips Saturdays + Sundays
  (INV-33). Holiday handling shipped in E8 (commit 319eca7): the
  `Skip Dates` column on `Alert Config` (col F) takes comma-separated
  ISO dates and `YYYY-MM-DD..YYYY-MM-DD` ranges, honored on the
  daily-trigger path only (manual sends bypass it). See INV-33 / INV-34.
- **DASHBOARD_URL Script Property** is consulted by
  `sendAlertEmail_` to build the "Open Dashboard" link. Unset =
  emails still send, just without the link button.

## Cache key versioning

Each report file uses its own versioned cache key prefix. Bump the
version any time the response shape or aggregation rules change so
stale caches invalidate on deploy.

CLAUDE.md INV-30 is the canonical current-version list. This table
mirrors it; if the two ever diverge, INV-30 wins.

| Source file | Cache prefix | Current version |
|---|---|---|
| `Data.gs` (main table) | `summary:vN:` | `v9` |
| `Data.gs` (latest-date snap for default From/To) | `latestDate:vN:` | `v1` |
| `Data.gs` (multi-source latest dates for freshness pill) | `latestDates:vN:` | `v1` |
| `IndividualReport.gs` | `individual:vN:` | `v8` |
| `IndividualReport.gs` (active-in-range subset, shared with all three pickers) | `individual_active:vN:` | `v2` |
| `PerformanceReport.gs` | `performance:vN:` | `v4` |
| `CompareRangesReport.gs` | `compareRanges:vN:` | `v5` |
| `MissedCallsReport.gs` | `missed:vN:` | `v11` |
| `CompanyOverview.gs` | `companyOverview:vN` | `v17` |
| `QCDReport.gs` | `qcd:vN:` | `v9` |
| `InboundReport.gs` | `inbound:vN:` | `v3` |
| `InsightsReport.gs` | `insights:vN:` | `v11` |

`Alerts.gs` holds no cached compute — preview / send always re-reads
the source sheet for the chosen date.

If you change ATT or % Answered semantics anywhere, bump every
downstream prefix — they share helpers (`formatSecondsHms_`,
`parseHmsDisplay_`) and a behavior change can leak across.
