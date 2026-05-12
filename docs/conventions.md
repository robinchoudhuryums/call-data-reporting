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

**Exact string match.** No normalization for whitespace, case, or
parenthetical aliases.

- `DQE Historical Data` Col C (Agent Name) must match `DO NOT EDIT!`
  cell values byte-for-byte (after the cell is parsed via the rules
  above).
- A typo on either side causes the agent to silently disappear from
  their dept's view.
- The Department Dashboard surfaces orphans in its Diagnostics panel
  (and via the `whyNoMatches` editor diagnostic) — check there first
  when an expected agent doesn't show up.

When an agent's display name changes (marriage, alias, etc.), update
both sides at once.

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

### Totals row

Per-row aggregates above; the totals row uses the same methods:

- Sum columns sum the rows in the table.
- Mean columns (ATT, Avg Abd Wait, CSR Avg Abd Wait) take a simple mean
  of the per-agent rows displayed.

## Dashboard scope semantics

The scope toggle in the dashboard controls how rows are matched to a
department:

| Scope | Rule |
|---|---|
| **Roster** (default) | Include rows where `Agent Name ∈ dept_roster_names` |
| **Queue** | Include rows where `row.queueExtensions ∩ dept_queue_extensions ≠ ∅` |
| **Both** | Union of the two |

`dept_queue_extensions` is the union of all queue extensions appearing
in the dept's roster cells (parsed via the format above).

Rows matched via Queue but not via Roster get a `(queue-only)` tag next
to the agent name in the table. They also appear in the Diagnostics
panel under "Agents matched only via queue".

Default scope is **Roster** — strict match to the dept roster, mirroring
how the legacy DQE Report worked.

## Auth and access

- **Admins**: hardcoded in `ADMIN_EMAILS` in `apps-script/department-dashboard/Config.gs`. Bypass the
  manager dept check; can pick any department from the admin dropdown.
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

## Cache key versioning

`Data.gs` uses a versioned cache key (`'summary:v3:...'`). Bump the
version any time the response shape or aggregation rules change so
stale caches invalidate on deploy. Currently `v3`.
