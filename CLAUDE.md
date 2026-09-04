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
  Checklist** in full (Script Properties, triggers, sheets, migrations).
  Cited across the repo BY NUMBER, e.g. "Operator State #38", so
  the numbering is stable — retire an item in place rather than renumbering.
- [`docs/regression-scenarios.md`](docs/regression-scenarios.md) — the
  **Regression Scenarios** (numbered `S#`) with steps + expected results. Walk
  every one whose Subsystem overlaps a file you changed.
- [`docs/client-ui-conventions.md`](docs/client-ui-conventions.md) — how the
  Insights + Overview pages, the density/prefs layer, the `ds-*` components and
  the design tokens are built. **Read before touching `script.html` /
  `styles.html` / `dashboard.html`**, then re-run `npm run ci:ui`. The client
  traps that bite unrelated work stayed in Common Gotchas below.
- [`docs/per-call-capture.md`](docs/per-call-capture.md) — the **per-call
  capture subsystem**: the `inbound_calls` / `outbound_calls` /
  `direct_call_history` writers, the reports over them, the journey drill,
  Caller Lookup, the abandon heatmap, the CSR transfer detail. **Read before
  touching any of those writers or readers.** Indexed in Common Gotchas.

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
# it as abandoned-only, R8-E6), plus simulateSplitCol2 /
# parseDurationDecimal across dataFilters.js / autoImport.js (compared
# on CODE -- one copy is nested, so indentation/blank lines are
# normalized away). Non-zero exit on drift.
# Also runs automatically as a non-blocking SessionStart hook
# (.claude/settings.json).
bash scripts/check-duplicated-files.sh

# Unit tests (regression harness). Zero deps -- Node's built-in test
# runner loads the real .gs/.js files into a vm with mocked Apps Script
# globals (dashboard + the sibling cdr-report / cdr-import projects).
# Non-zero exit on failure. ~90 suites pin the invariants, the report
# builders, the pipeline build, the Neon writers/readers, and every
# flag-gated engine -- THE SUITE-BY-SUITE COVERAGE MAP LIVES IN
# tests/README.md (its designated home; this block stopped enumerating
# suites in the 2026-08-20 trim pass -- keep it that way. Map completeness
# is ENFORCED: claude-md-split.test.js fails on an unlisted suite).
# Two rules that bite here:
# - HARNESS STRICTNESS (F-5/F-6): the fake sheet ENFORCES getMaxColumns (a
#   getRange past it THROWS, the REP-10 class -- set `_maxColumns` when a
#   test needs a narrow sheet on purpose) and RECORDS setNumberFormat calls
#   (sheet._numberFormats), so the widen-before-write and plain-text
#   coercion protections are test-enforceable; never loosen the fake to
#   make a fixture fit.
# - html-include-structure: styles.html / script.html are Apps Script
#   INCLUDES whose wrapping <style>/<script> must enclose the WHOLE file --
#   content appended to the END lands OUTSIDE the tag and renders as
#   visible page text (shipped once; the rendered-UI gate structurally
#   cannot see it). The suite also pins the ASSEMBLED client (script.html
#   splices the script-N-*.html fragments into ONE IIFE): per-fragment
#   purity, include-list<->disk parity, node --check of the assembled
#   body -- see docs/client-ui-conventions.md "The assembled client".
node --test          # from repo root (or: npm test)

# CI: .github/workflows/ci.yml runs TWO jobs on push-to-main + every PR --
# `test` (`node --test` + the INV-16 guard; = `npm run ci` locally) and
# `ui-harness` (the rendered-UI gate; = `npm run ci:ui`, see below).

# Deploy helper: push AND roll a project's web-app deployment to a new
# version in one step (avoids the manual "Manage deployments -> New
# version" stale-deploy footgun, Operator State #2). The deployment id
# comes from `clasp deployments` in that dir (one-time lookup).
# TST-7: it GATES the push on `npm run ci` (tests + the INV-16 guard) AND
# `npm run ci:ui` (the rendered-UI gate, F-10; skips cleanly when playwright
# isn't installed); DEPLOY_SKIP_CI=1 skips both (emergencies only).
# Batch 4: it also runs the REMOTE-ORPHAN check first -- `clasp push -f` never
# deletes remote files (INV-17), so a file removed from the repo stays live and
# callable until deleted by hand in the web editor. The check pulls the project
# into a temp dir and lists remote files with no local counterpart. It WARNS by
# default (an orphan is no reason to block an urgent fix) and skips cleanly when
# clasp can't authenticate; STRICT_ORPHANS=1 makes it fatal. E3: a dashboard
# push also STAMPS BuildStamp.gs (UTC + git sha + branch; the committed
# placeholder is trap-restored after) -- the Health page's build-stamp row
# renders it, and a bare `clasp push -f` ships "unstamped", which is itself
# the finding. Standalone:
#   node scripts/check-remote-orphans.mjs <project-dir>
scripts/deploy.sh .                      <dashboard-deployment-id>
scripts/deploy.sh apps-script/cdr-report     # no id -- not a web app; the push IS the deploy
scripts/deploy.sh apps-script/cdr-import     # no id -- ditto (triggers/menus run pushed code)
# (dashboard: write the id ONCE to a gitignored `.deployment-id` at repo root and
# omit the argument; with neither, it just `clasp push -f`s + manual version bump.
# Re-running on an already-deployed clean HEAD is a fast no-op via the gitignored
# `.last-deployed` marker -- a redundant deploy would re-stamp and false-fire the
# update notice -- FORCE=1 overrides.)

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
# tests/unit/ui-harness-vendor.test.js, incl. an F-11 sha256 byte pin).
# With playwright absent it SKIPS
# with a message and exits 0, so it is safe to run anywhere -- EXCEPT under
# CI=true, where absence FAILS (F-9: a workflow refactor that loses the
# install step must not turn the gate silently green); chromium-path.js
# globs the Playwright browser revision, so CHROMIUM_PATH is rarely needed.
# EIGHT ASSERTING stages gate it -- drive-smoke.js (page/console errors,
# unmocked RPCs, BLANK chart canvases, horizontal overflow, both roles, plus
# VIEW-AS-MANAGER: it enters preview, actually hides the admin-only surfaces
# -- measured as rendered visibility, not a class -- reverses cleanly, and
# throws nothing),
# drive-f13.js (the S39 keyboard walk), drive-devoverlay.js (the O-11 dev
# overlay AND its `google.script.run` probe -- the probe redefines the single
# object every one of the ~91 server calls passes through, so a wrong wrapper
# breaks the whole app at once; the driver asserts the app still WORKS with it
# installed before asserting anything about the panel, and its handler-isolation
# check is BEHAVIOURAL because comparing two reads for identity does not catch a
# shared runner -- plus that a manager gets no overlay even with the localStorage
# flag hand-set), drive-journey.js (the "↳ path" call-path
# drill -- the origin line, the OUTBOUND call reached through the related-call
# link, and the not-entitled refusal; all three were unit-pinned but had never
# RENDERED until this driver clicked one, the dept-selector class of bug; the
# drill was unreachable by any driver until getCallJourney was mocked, since
# drive-smoke's unmocked-RPC check would have flagged the call),
# drive-admin.js (the six ADMIN MODALS + the Escalations worklist: each modal
# opens, renders, traps focus and closes on Escape, with no page errors, plus
# the F10 no-duplicate-badge property -- these had thorough server-side pins
# and no assertion that any of them RENDERED, the dept-selector class of bug.
# Its MODALS list is hand-copied from the router table in script-4-nav.html --
# the Coaching modal (`/admin/coaching`) is NOT in it yet, so that surface has
# no rendered-gate coverage; a new admin route must be added to the list),
# and drive-subqueue.js (the collapsible
# sub-queue groups, the S35 parent-subtotal parity property, the combined AND
# single-dept CSV shapes -- the ONLY automated coverage of any CSV writer in
# this repo, asserted by stubbing URL.createObjectURL and reading the real Blob
# bytes, S43 -- and the header DEPARTMENT SWITCH, which threw a ReferenceError
# in production until a driver first tried it), plus the AGENT-APP pair
# build-agent.js + drive-agent.js (the fourth role's separate page: boot,
# hidden rank line, rendered teammate-name PRIVACY, the History tab, no
# errors/unmocked RPCs/self-beacons). The other drivers (drive.js /
# drive-insights.js / drive-phase3.js) emit screenshots + reports for a human
# and are deliberately NOT in the gate. Runs in CI as the `ui-harness` job, and is
# BLOCKING since 2026-07: it has now caught two bugs that reached production and
# that nothing else could see -- CSS appended after `</style>` rendering as
# visible text, and the header dept selector throwing so no admin could switch
# departments. Neither is reachable from `node --test` (one is markup structure,
# the other needs a real click). Re-run it after touching
# script.html or any script-*.html fragment, styles.html, dashboard.html,
# agent.html / agentApp.html, or any payload shape.
```

## Common Gotchas

A few things that have bitten us repeatedly. See `docs/known-issues.md` for full detail.

> The bullets below are **live rules**. Where a bullet cites a fix code
> (`F-2`, `IMP-7`, `CORE-3`, `RPT-1`, `OPS-7`, `NEO-1`, bare `F#`, …), that
> code's backstory + a family index live in [`docs/fix-history.md`](docs/fix-history.md)
> — follow a rule from here, look up a code's history there.
>
> **How to write one (this section is the file's main growth surface).**
> CLAUDE.md is injected into EVERY session's context, so size is a real and
> recurring cost: it hit 372 KB once and was split to 150 KB, then grew back to
> 178 KB in a week — and ~77% of that regrowth was EXISTING bullets accreting
> prose, not new subjects. Three habits keep it flat:
>
> 1. **One bullet states a RULE and the trap it prevents. The incident that
>    taught it goes to `docs/fix-history.md` under its fix code**, with a
>    pointer left behind. The test for a sentence is: *does a developer need
>    this in context to avoid breaking something, or does it explain how we
>    learned it?* Measurements, eliminated hypotheses, "before the fix it
>    did X", and commit archaeology are all the second kind.
> 2. **Write the bullet ONCE, at the END of a phased rollout.** Amending the
>    same bullet per phase is what produced the biggest ones here — the
>    sub-queue and queue-split work alone added ~12 KB across six commits,
>    each a reasonable-looking paragraph.
> 3. **A rule enforced by a test needs one line, not three paragraphs** —
>    name the test and let it carry the detail. A rule that CAN be enforced
>    by a test usually should be: prose could not keep the "all DQE readers
>    are cut over" claim true (B-2), and a tripwire could. **Corollary (C2):
>    when a new convention is WRITTEN, answer "what enforces this?" in the
>    same commit and name the enforcement in the bullet.** Three holes found
>    in one audit were each a convention missing exactly that step: a third
>    duplication pair outside the INV-16 guard (F2), two cache prefixes in
>    the INV-30 docs but not in cache-version-sync's SPECS (F3b), and a
>    second read-source dimension with no B-2-style tripwire (F11). "None —
>    prose only" is an acceptable answer; an unanswered question is not.
>
> `tests/unit/claude-md-split.test.js` enforces this with a per-bullet
> ratchet: every bullet stays under 4 KB (the once-grandfathered oversize five
> have all been trimmed under it -- keep them there).

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
  `neonbackfill.js` + `NeonMirror.js` (`sanitizeSlotCellForNeon_(r[31]) || null`)
  and the dup-guard re-mirror (`remirrorExistingDqeDate_`, both INV-16 copies).
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
- **A dated sheet read is bounded by a min/max SPAN, not a tail scan -- and the
  discriminator is whether that sheet is date-ORDERED.** Two dashboard readers
  answer a windowed question against a years-deep sheet, and both do it the same
  way: scan the DATE COLUMN alone, find the FIRST and LAST row in the window,
  then read only that row span at full width -- `computeCsrTransferRange_`
  (Data.gs, R25b) and `sheetFetchDqeRows_` (NeonRead.gs, R26b, which had been
  reading ~2.2M cells TWICE to answer a one-day question). A span is correct
  whatever the row order is: an out-of-order row merely WIDENS it and can never
  fall outside it, which is why **the per-row date filter always stays** -- the
  span bounds the read, it does not replace the filter. A TAIL scan is the trap:
  `DQE Historical Data` and `CSR Transfer Historical Data` are NOT reliably
  date-ordered: the daily path appends at `getLastRow()+1`, and although the DQE
  build re-sorts col B after each write (and the bulk archive sorts too), a col B
  holding mixed Date-typed and text cells does not sort chronologically -- so a
  backfill of older dates can still sit after newer rows and a tail scan stops
  early and silently drops them -- quietly wrong numbers, strictly worse than
  being slow. **The one legitimate tail scan is
  `nmReadDateRowsTail_` (F-20, NeonMirror.js)**, and it is safe for two reasons
  that do NOT hold here: its sheet is kept date-sorted by its own exporter, AND
  it WIDENS until the date's block is provably complete. So: date-ordered plus a
  completeness check -> a tail scan is fine; anything else -> span it. New
  windowed readers over a dated sheet must not add a third rediscovery.
  ENFORCED by out-of-order + full-scan-equivalence tests in
  `dal-cutover.test.js` (R26b) and `csr-transfer-detail.test.js` (R25b); R26c's
  `[dqe-read] dqeDateBounds ... openMs=N scanMs=N` line is what tells you
  whether a slow read is the scan or the workbook open.
- **`clasp push -f` does NOT delete remote files** that are absent locally.
  Removing files from an Apps Script project requires manual deletion in
  the web editor -- `scripts/check-remote-orphans.mjs` (wired into
  `deploy.sh`, Operator State #29) DETECTS the leftovers but cannot remove
  them.
- **Public write paths are admin-only — INV-01 carries the AUTHORITATIVE
  carve-out list** (OrphanFix.gs incl. the `addOrphanToRoster` New-hire flow /
  `setup()` / DeptConfig.gs / the Access Control editor in Auth.gs / the
  Alert+Digest config editors / the append-only `logReportUsage_` telemetry
  carve-out; Escalations, INV-55, is the per-dept NEON write path). All start
  with `assertAdmin_()` except the telemetry append and the row-dept-gated
  Escalations verbs. Every other
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
  paths need at least the admin gate.** The dashboard's NON-spreadsheet
  (Neon) write paths are: Escalations (INV-55, per-dept-gated), the
  admin-gated Coaching worklist (`Coaching.gs` -- delivery upsert +
  `updateCoachingFlagStatus`, the full data-mutation set), and
  `applyOrphanRename`'s best-effort `dqe_history` rename mirror
  (`renameAgentInNeon_`).
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
  **Scope (owner ruling, R18): the exclusion applies to PER-AGENT AVERAGES
  AND BENCHMARKS only -- manager volume stays in dept TOTALS and RATES.**
  Consumers are the IR team-average and, since R18, Insights via
  `meta.teamAvgBasis` (the gap-vs-team baseline, the call-share equal-share
  benchmark, the behind-team classification); Insights' `teamStats`,
  `rosterAgentCount`, trends and dept rates deliberately keep every agent.
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
  Its semantics live on in Insights: the INV-28 comparison window is the
  immediately-preceding same-workday-count window (R24; NOT "previous
  calendar month") -- since R17b carried by the agent-card delta badges + the
  emails (the rollup KPI tile row is hidden); the share-of-answered
  breakdown sits in Team detail; the **Absolute** chart basis
  (`insRenderCardsChartAbs_`) is HIDDEN since R16g (the agent table on
  the same page carries it; renderer inert, A/B remote still reaches it). `PerformanceReport.gs` was
  DELETED (`deltaBlock_` moved to Util.gs -- Insights consumes it);
  legacy `#/report/performance` deep links land on the Insights region
  (router repoint); the `performance:` cache prefix and the
  `cdr.pr.prefs.v1` localStorage key are orphans. The frozen-literal
  test in insights-report.test.js pins the inherited semantics
  (ex-parity gate). NOTE (INV-17): `clasp push -f` does not delete
  remote files -- PerformanceReport.gs must be removed in the Apps
  Script web editor.
- **Per-row prior-period chips (E5, commit bb77168).** The My
  Department agent table renders an inline delta chip after the
  Rung / Missed / Answered values comparing the selected window
  to the INV-28 prior window immediately preceding it (R24:
  same working-day count). Three pieces of behavior worth knowing:
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
- **DQE col AI (`Queue Split`) is the per-queue breakdown -- ADDITIVE, and it
  cannot be backfilled.** Sub-queue Phase 1 appended col 35
  (`HISTORICAL_COLS.QUEUE_SPLIT`): JSON keyed by RAW queue name,
  `{"A_Q_CSR":{u,r,m,a,t,n,mt}}`, produced by the pure `dqeQueueSplitForAgent_`.
  Cols A-AH keep their ALL-QUEUE meaning as the rollup, so nothing that existed
  before reads differently -- `tests/unit/queue-split.test.js` pins A..AH
  byte-identical, and the split's computation is try/catch-wrapped so a defect
  in it can never cost a day of history (it just leaves AI blank). Three states,
  NOT interchangeable: `''` = never computed (pre-Phase-1 row, INV-23 sentinel,
  or a throw), `'{}'` = computed with nothing in the work window, JSON = the
  split -- so ask "is this DATE split-aware?" (any agent row with a non-empty
  AI), never row-by-row, or every sentinel reads as pre-Phase-1. It SUMS BACK to
  the rollup: leg-level figures partition by each leg's own queue, parent-level
  ones (unique, talk) go to the queue of that parent's EARLIEST leg, so an
  overflow call that rang the agent through two queues is not counted twice.
  **`Call_Legs` is pruned at 14 days and the per-leg queue identity exists
  nowhere else, so history before the deploy is permanently unsplittable** --
  every day this is not deployed is another one. Two traps: it embeds
  comma-joined times, so col 35 is plain-texted like AD-AF / K-AC; and Sheets
  does NOT auto-expand columns, so the writer WIDENS a 34-col sheet before
  touching col 35 (a getRange past `getMaxColumns` throws -- REP-10). Mirrored
  to `dqe_history.queue_split` via an idempotent ADD COLUMN, and every upsert
  COALESCEs so a sheet-sourced NULL can't erase a stored split.
  **The pipeline always WRITES this column; whether any dashboard surface USES
  it is a separate switch** -- `QUEUE_SPLIT_SCOPE`, default `off` (Operator
  State #42). So keep deploying and backfilling the split on its own urgency
  (the 14-day window closes regardless); the reader gate does not slow that
  down, and turning the gate on later costs nothing extra.
- **The Extraction Sidebar mirrors the pipeline's QCD rules BY HAND -- a THIRD
  duplication, and it has already drifted.** `cdr-report/dataFilters.js`
  (CDR Tools -> Open Extraction Sidebar: "which raw CDR rows produced this
  cell?") re-implements `cdr-import/autoImport.js`'s raw-CSV time decoding
  (`simulateSplitCol2` / `parseDurationDecimal`, now guarded by
  `check-duplicated-files.sh` -- compared on CODE, since dataFilters' copies are
  nested) AND ~50 of its per-row QCD rules, which are structurally different
  code and cannot be diffed. **A pipeline rule change is a TWO-file edit here
  too.** The R20 row-40 threshold landed in the pipeline only, so the sidebar
  listed rows the pipeline no longer counts -- the tool an operator reaches for
  when they already suspect the numbers told them the pipeline was
  under-counting. That threshold is pinned by
  `cross-file-pins.test.js` ("R20 row-40"), and since Batch C the row rules
  are pinned BEHAVIORALLY by `qcd-sidebar-parity.test.js` (one shared fixture
  drives both implementations; sidebar row count must equal the pipeline's
  cell value) -- with two honest exclusions: cols F and G (a MAX and a MEAN,
  which no row set can equal -- and where the row-36/row-40 col-G predicates
  have since drifted, T-1) and window-edge shapes beyond the fixed row-35 one. Row 34 was RULED (2026-08-20) the "CSR Total Calls" SUM
  row: the sidebar now refuses it like every total row (parity-pinned), and
  the read-only `previewRow34Overlap` (cdr-import, CDR Tools menu) measures
  the latent 35+37 double-count -- see docs/known-issues.md "QCDR Output
  row 34". Still diff
  both files when you touch either; the suite tells you WHICH cell drifted.
  (`DQEdrilldown.js` is a FOURTH such mirror -- next bullet.)
- **The DQE Drill-Down sidebar is a FOURTH hand-mirrored rule set, and it has
  drifted three times.** `cdr-report/DQEdrilldown.js` ("which Raw Data rows
  produced this DQE cell?") does NOT call the build: it re-implements the
  parent-leg tree, INV-08 own-talk attribution (its own
  `findAgentTalkOnParent`), INV-24 canonicalization (its own `canonicalize_`),
  the INV-06 window, and a TTT/ATT summary. Structurally different code, so
  `check-duplicated-files.sh` cannot diff it and `cross-file-pins` cannot
  tokenize it. Every drift so far has been the same shape -- the verification
  tool contradicting the build during exactly the investigation it exists to
  serve (F24, R8-D4, F-13 -- backstories in fix-history). **A change to the
  build's per-agent rules is a two-file edit here.** Pinned BEHAVIORALLY by
  `tests/unit/dqe-drilldown-parity.test.js`: one fixture drives the real build
  AND the real drill, and the drill's Found-N must reconcile with the DQE cell.
- **`hashPhone` (cdr-report) and `cdrHashPhone_` (cdr-import) must agree, and
  they are in different PROJECTS** -- so the INV-16 guard, which pairs
  same-named files, does not cover them. They hash the insurer reference table
  and the mirrored call rows respectively; if they diverge, nothing joins and
  every insurer silently renders "(unlabeled)" -- no error, no count gap, the
  label just never appears. Pinned by `tests/unit/insurance-numbers.test.js`
  (same input, same 64-char hex, same null handling).
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
- **Per-call capture -- the inbound / outbound / direct / journey subsystem --
  lives in [`docs/per-call-capture.md`](docs/per-call-capture.md). READ IT
  before touching `cdr-import/inboundCalls.js` / `outboundCalls.js` /
  `directCallMetrics.js`, the dashboard's `InboundReport.gs` /
  `OutboundReport.gs` / `DirectCallReport.gs` / `CallerLookup.gs`, or the
  `Inbound Calls` / `Outbound Calls` / `Direct Call History` export tabs.**
  Thirteen bullets (31.9 KB) moved there in the F8c split because they describe
  how ONE subsystem is built rather than a trap that bites unrelated work; the
  file is authoritative, this is the index:
  Inbound-call capture · Internal-transfer journey enrichment (R11-N) ·
  A CDR root is a leg tree · Caller Lookup · Per-call journey drill-through ·
  Insurer labels and the Inbound report gate · QCD vs inbound abandons ·
  Dept attribution contract · Outbound-call capture · Outbound report ·
  Temporal abandon heatmap · Direct-extension call metrics ·
  CSR transfer detail.
  **Three rules stayed HERE, because each bites from OUTSIDE that subsystem:**
  (1) **⚠ The DQE and INBOUND queue-name recognizers diverge ON PURPOSE -- do
  not "harmonize" them.** The DQE regex
  (`(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)`, IMP-8) deliberately does NOT capture
  a brand-prefixed token, because an INV-23 sentinel name must START with
  `A_Q_`; the inbound capture MUST capture it verbatim, because `entry_queue`
  is matched by EXACT name against the Dept Config lists. Widening DQE gives
  you phantom `A_Q_Main` sentinels; re-anchoring inbound makes brand-prefixed
  queues invisible (and the blindness is self-concealing -- Operator State #38
  is the runbook). Two subsystems, two rules.
  (2) **⚠ The QCD-vs-inbound abandon gap is SETTLED** -- read
  `docs/known-issues.md` "QCD Abandoned vs inbound_calls abandons" BEFORE
  re-investigating; the eliminated explanations all look plausible again from a
  standing start. QCD's Abandoned applies a minimum QUEUE-WAIT threshold and
  the inbound capture applies none, and QCD is work-window-scoped where the
  capture is not, so the two are several-fold apart and must never be shown
  side by side without saying so.
  (3) **`wait_seconds` is WHOLE-CALL elapsed time from IVR pickup, NOT queue
  wait** -- the IVR runs on nearly every call here, so a near-instant queue
  abandon still stores tens of seconds. Never compare it to a queue threshold
  or read it as "time waiting for an agent"; the per-leg `secs` inside
  `journey` is where a real queue wait is derivable.
- **Date-range presets NEVER include today, and the rule lives in ONE place.**
  `datePresetRange_` (script-1-core) is the single resolver behind every
  "Quick select" dropdown (IR, Insights, Inbound, Direct, Outbound, the
  all-dept Queue report). Every OPEN-ENDED preset (`yesterday` / `last7` /
  `thisWeek` / `thisMonth` / `last30` / `last3Months` / `last12Months`) ends
  YESTERDAY: today's ingest has not landed while a manager is looking (the
  pipeline builds the PREVIOUS day), so including today tacks an empty day
  onto the window -- dragging every rate and average toward zero and making
  the last chart point dive. Fixed windows (`lastWeek`/`lastMonth`/`lastYear`)
  already excluded it. The ONE exception is the Queue report's explicit
  `today`, which the user picked by name. Degenerate edges CLAMP rather than
  invert (a "This month" on the 1st, "This week" on a Monday -> that single
  day), since the server rejects from > to. The rule was hand-mirrored in SIX
  resolvers and had already drifted (`last30` fixed everywhere, the rest not);
  ENFORCED by `tests/unit/date-presets.test.js`, whose tripwire fails if any
  fragment computes preset dates locally again.
- **Emailing an Individual Report TO the agent it is about (owner ruling
  2026-09).** The IR Export menu's "Email to agent…" sends the rendered
  report to its subject instead of the manager mailing it to themselves and
  forwarding. Enabled only when exactly ONE agent is on screen. **The client
  supplies an agent NAME, never a trusted destination** -- every gate is
  re-derived server-side in `irResolveAgentRecipient_`: (1) `assertDeptAccess_`
  on the agent's dept PLUS exact-INV-04 roster membership, so a crafted name
  reaches nobody; (2) the agent's REGISTERED `Access Control` address wins
  whenever one exists (a differing typed address is refused, not ignored) --
  `irRegisteredAgentEmail_`, also surfaced as `meta.agentEmail` so the client
  can skip asking; (3) a typed address (only for an agent with no row) must be
  on the SENDER's own domain or one listed in the optional
  `AGENT_EMAIL_DOMAINS` Script Property. The client's job is CONSENT -- a
  `dsConfirm_` naming agent and recipient before the send (or, for an agent
  with no row, a single `dsPrompt_` that collects AND confirms with inline
  validation), which is what catches a typo the domain gate cannot. Sends are Logger-audited plus a
  `individual:to-agent` usage row (the INV-01 append-only carve-out); the
  agent's copy names the sender. Pinned by `tests/unit/ir-send-to-agent.test.js`.
- **Client / presentation-layer conventions live in
  [`docs/client-ui-conventions.md`](docs/client-ui-conventions.md) — READ IT
  before touching `script.html`, `styles.html`, or `dashboard.html`**, and
  re-run `npm run ci:ui` afterwards. Fifteen bullets moved there in the F8/F8b
  splits because they describe how a SURFACE IS BUILT rather than a trap that
  bites unrelated work; the full text is authoritative there, this is the index:
  Insights absorbed the Performance Report AND Compare Ranges (both retired,
  incl. the consolidated trend chart + per-agent cards/chart bases + IR
  drill-through) · Insights header dates (DELETED in M4 -- the dept
  controls row is the page's single date authority; `insSyncToDeptWindow_`),
  trend-at-bottom, the INSIGHTS REGION (the M1 merge + N1: the whole ex-page
  renders open-inline on My Department, generating with it) · Insights per-section FOLDS (replaced the
  Simple/Detailed density mode; incl. the C3 draw-on-open chart trap) ·
  Insights Phase 2 (saved views, share link, calendar trend,
  summary email) · the guided onboarding tour · the Insights floating admin A/B
  remote · the anti-intimidation layer (answer-first headlines, quick-start
  chips, the metric glossary, benchmark tints) · per-report client prefs in
  localStorage (every `cdr.*` key) · CSS design-token conventions (`--bad` vs
  `--warn`, `--r: 2px`, mono letter-spacing) · the `ds-*` shared component
  layer and its conflict register · the Pass-2 design additions · report SWR
  and the D1b keep-last-good store · the Overview stacked-sticky layout · the
  Overview trend-chart conventions (hues, sub-queue dashing, the holiday-aware
  axis, spotlight/pin -- P28: pins/Alt-hides survive rebuilds incl. the 5-min
  auto-refresh -- trend arrows, axis zoom) · the top-tab ROUTER (Phase C:
  every tab/menu item's `data-route`+id pair, `__DASHBOARD_URL__` -- NEVER
  `window.location` inside the Apps Script iframe -- deep links + state-in-URL
  via `SHARE_STATE_`, the F11 non-admin no-op).
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
  Any new chart callsite must route through `safeChart_` -- ENFORCED (S8):
  `html-include-structure.test.js` pins it as the ONLY `new Chart(` callsite.
- **App-styled confirm dialog (`dsConfirm_`), not `window.confirm`.**
  `dsConfirm_(opts)` (script.html) is a Promise-based, token-themed
  confirmation dialog that replaces the browser-native `window.confirm`
  (which renders in the Sheets/browser chrome style, incongruent with the
  app). It's layered above every modal + toast (z-index in styles.html),
  supports Enter/Escape/backdrop, a `danger` tone for destructive actions,
  and either `message` (plain, auto-escaped) or `messageHtml` (caller MUST
  escape dynamic values). Wired in the **Outlier Fix** modal
  (rename / add-to-roster / deactivate-alias) and the **Daily Call Queue
  Report subscriber blast** (QV-5/R18c -- which also shows the tone-varying
  pattern: neutral normally, `danger` when re-sending an already-sent day);
  the remaining legacy `window.confirm` callsites can adopt it incrementally.
  New confirmation
  UI should use `dsConfirm_` rather than adding another `window.confirm`.
  **`dsPrompt_` is its sibling for dialogs that need a VALUE** (same shell,
  same focus-return + Enter-follows-focus + Tab-trap rules, resolves the
  trimmed string or null): it takes a `validate(v)` callback that runs on
  submit and clears as the user types, so a bad value is corrected IN PLACE
  -- the thing `window.prompt` structurally cannot do, since it discards what
  was typed and leaves the caller to reject it afterwards with a toast.
  Native `prompt()` is now ENFORCED out of the client
  (`html-include-structure.test.js`); the ~12 legacy `window.confirm`
  callsites remain the documented incremental backlog, which is why that pin
  covers the prompt family only.
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
  separators (so server-computed numerics aren't mangled).
  Any new TABULAR cell writer must call `csvSafeCell_` before the RFC-4180
  quote-escaping -- CSV or not: the IR copy-as-TSV button (E-3) feeds the
  same spreadsheet paste target. ENFORCED (S8):
  `tests/unit/html-include-structure.test.js` pins the routing for all
  seven current writers (`exportTableCsv_`/`csvEscape`, `insDownloadCsv_`,
  `inboundDownloadCsv_`, `directCallDownloadCsv_`, `outboundDownloadCsv_`,
  `qcdAllDeptCsv_`, the E-3 TSV handler).
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
- **Every dashboard email is sent through `sendAppEmail_` (Config.gs), never
  `MailApp.sendEmail` directly -- it BCCs the first admin by default (R28,
  owner ruling: a wrong recipient or a silent non-send must be seen the day
  it happens), dedups an address already in to/cc, and honors `EMAIL_BCC`
  (override list; `none` disables). A new send site that calls MailApp
  directly fails `app-email.test.js`'s sweep. **A plain-text admin notice
  passes a `notice:` spec (R29)** -- sendAppEmail_ renders it through
  `EmailKit.gs::ekNoticeHtml_` (banded shell, tiles, steps, callout, mono)
  as the HTML alternative, keeping `body` as the fallback; senders never
  call the kit directly (the suites load files selectively -- use
  `appEsc_` / `appDashUrl_` from Config.gs inside a spec). **The family is
  UNIFORM (R30, owner ruling): every `ekShellHtml_` caller passes `band`**
  (the dark header) -- only the Daily Call Queue Report keeps its own pinned
  local shell. ENFORCED: `email-kit-v2.test.js` sweeps every `body:` sender
  for a spec and every shell caller for `band`. Operator State #58.
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
- **Script Properties are REGISTERED — adding one means registering it in
  `Config.gs::PROP_REGISTRY_` in the same commit.** The dashboard store holds
  ~90 keys, past the settings page's 50-row display cap, so the Health page's
  folded "All Script Properties (inventory)" section is the complete view: it
  classifies the LIVE store against the registry (operator config / engine
  state / diagnostic tool params) and warn-flags UNRECOGNIZED keys — retired
  leftovers, manual one-offs, or an operator TYPO of a real key (deliberate:
  a misspelled `DQE_READ_SOURCE` surfaces instead of silently defaulting).
  Property VALUES never reach the payload (the store holds
  `NEON_PASS`/`HMAC_SECRET`). The parity/vetting tools SELF-CLEAR their
  window params (`DQE_PARITY_*`, `QCD_PARITY_*`, `INBOUND_QCD_PARITY_*`,
  `OUTBOUND_VETTING_*`) via `clearToolParamsAfterCleanRun_` on a CLEAN
  verdict only — MISMATCH/INCONCLUSIVE keeps them so the fix-and-re-run loop
  re-compares the same window. ENFORCED both ways by
  `tests/unit/prop-registry.test.js`: every code-referenced key (literal,
  resolvable constant, or composed prefix) must be registered and every registry
  entry must still be referenced; `system-health.test.js` pins that the Health
  payload stays value-free.
- **Role model + the all-departments manager (`allDepts`).** Four roles
  (`admin`|`manager`|`agent`|`none`; `Auth.gs::resolveUser_` -- `agent`
  has its OWN bullet below). A manager is
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
  single-dept manager (least privilege). **A missed widening is the recurring
  defect here** (four found and closed -- R-3 / R8-4, fix-history). Pinned by
  `tests/unit/escalations-hardening.test.js`. **Grant it** by setting an Access
  Control row's Department cell to `ALL` (Access Control admin modal or the
  sheet; `saveAccessControlRow` accepts + canonicalizes the sentinel) --
  no Script Property / scope. Pinned by
  `tests/unit/access-control-editor.test.js`. **If you add a new
  `role==='admin'` check, decide: is it an admin SURFACE (keep it) or DATA
  BREADTH (use `isAllDeptViewer_()` / `user.allDepts`)?**
- **MULTI-DEPARTMENT manager (Tier C).** A manager may hold MORE THAN ONE
  `Access Control` row (same email, different dept). `resolveUser_` now
  UNIONS them into `departments` (F13); `department` is the first
  (default landing), `allDepts`
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
- **Multi-row access vs. an `Overview Parent` edge -- pick by whether the two
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
  config rows), so shared-manager email needs a row per dept there too --
  though an ALL-sentinel row IS an alert recipient for every dept (B-5).
- **ALIAS EMAILS (Tier C).** The optional `EMAIL_ALIASES` Script Property
  (comma/newline-separated `alias@x = canonical@x` pairs, tolerant grammar
  like `DIAL_IN_LABELS`) lets several sign-in addresses resolve to ONE
  identity: `resolveUser_` canonicalizes the address (via
  `canonicalizeEmail_`, memoized on the raw property, ≤5 hops to break a
  mis-entered loop) BEFORE the admin/manager lookup, so an alias inherits
  the canonical user's role + departments, and the returned `email` is the
  canonical identity. Unset = pre-Tier-C behavior. Note Gmail dot-normalization
  does NOT cover `john.doe`→`john` (different local parts), so the map is
  explicit + admin-curated (Operator State #36).
- **AGENT role (the FOURTH role) — own numbers + team aggregates, in a
  SEPARATE app.** An `Access Control` row with Role=`agent` + Agent Name
  (exact roster spelling, INV-04; the modal's picker enforces it) resolves —
  ONLY when `AGENT_ROLE_ENABLED='true'`, Operator State #46 — to a
  FAIL-CLOSED shape: `department:null`, `departments:[]`, identity solely in
  `agentDept`/`agentName`, which no pre-agent gate reads. The deny wall is
  ALLOWLISTS, not role-none denylists: `assertDeptAccess_` +
  `escAssertRowAccess_` admit exactly admin|manager (the old checks passed
  unrecognized roles UNPINNED), and `assertManagerOrAdmin_` (Util.gs) guards
  the no-dept-argument surfaces (Overview, YTD trend, all-dept QCD + its
  email, escalations init/badge, getCallJourney). **A new public endpoint
  must pick its gate from that set — never a bare `role === 'none'` check.**
  Agents deliberately CAN reach `getLatestDataDate(s)` + `reportClientIssue`.
  `doGet` routes agents to `agent.html`/`agentApp.html` (small separate
  template sharing styles.html — NOT the manager client with surfaces
  hidden; `agentApp.html` is named to stay OUT of the `script-*.html`
  fragment glob). Server: `AgentHome.gs` — `getAgentHome` (window KPIs
  reconcile with the manager table via the SAME computeSummary_, INV-05 ATT;
  ordinal-only rank, client-hidden via `AGENT_RANK_SHOW_`; missed
  timestamps + capture-bounded ring/wait via the inbound_calls journey join,
  never guessed) and `getAgentHistory` (12-month INV-29 window, monthly
  INV-25 WEIGHTED ATT — the labeled exception to the reconciliation rule).
  Payloads NEVER carry a teammate identity — pinned in agent-home.test.js
  AND at the rendered page by drive-agent.js (with build-agent.js, blocking
  ci:ui stages). Admin view-as: `?agentPreview=<dept>||<name>` (the Access
  modal's Preview link). Full design + phase history:
  [`docs/agent-role-plan.md`](docs/agent-role-plan.md).
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
  Past 36h adds the `.is-stale` class and tints warm orange -- measured
  with a **WEEKEND/HOLIDAY CREDIT** (24h per non-business day in the gap,
  `freshnessNonBusinessCredit_`), or Friday's data reads as stale every
  Monday morning at ~57h while being the most recent WORKDAY. The Overview
  pipeline banner applies the same credit to the same threshold (it reuses
  `ingestWatchdogNonBusinessCredit_`, which had this from the start --
  OPS-7; the two display surfaces never adopted it). Change one, change
  both: freshness-weekend.test.js pins the banner behaviorally and the
  pill by source tripwire (its staleness lives in the assembled-client
  IIFE, where the rendered gate cannot tell right from wrong-on-Mondays).
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
  two (F9; the cold-cache backstory + R12-26's dqeEarliest MIN live in
  fix-history):** `Data.gs::sheetScanDqeDateBounds_()` yields
  `{min, max, rows}` from one read, memoized per EXECUTION in
  `DQE_DATE_BOUNDS_MEMO_` (the `DEPT_CONFIG_ROWS_MEMO_` discipline) --
  deliberately NOT cached across requests, so each caller keeps its own
  R8-C2 negative-cache semantics. **Date cells resolve through `rowDateIso_`,
  which memoizes its Date branch per execution (R27)** -- the per-row
  `Utilities.formatDate` was the whole cost of that scan (~0.5 ms x 31.7k rows;
  33 s on a cache-HIT queue report), so a new dated-sheet reader must route
  through it rather than format per row (data-parsing.test.js pins the memo).
  **Test-side trap:** a suite that swaps
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
  **NEVER put `connectTimeout` / `socketTimeout` / `loginTimeout` on a Neon
  JDBC URL.** Apps Script's JDBC service REJECTS them ("The following
  connection properties are unsupported: …"), so instead of bounding a hang
  they make EVERY connection fail instantly, in every project at once
  (incident: docs/known-issues.md). `cross-file-pins.test.js` pins their ABSENCE across
  all six builders and sweeps for unlisted `Jdbc.getConnection` callsites.
  Bound STATEMENTS with `stmt.setQueryTimeout(seconds)` (what
  `getReachableNeonConn_`'s 5 s probe already does) — the platform supports
  that. Dashboard-side, `getDashboardNeonConn_` memoizes a hard connect
  failure PER EXECUTION (`NEON_CONN_DOWN_MEMO_` -- ~54 callsites each paid
  their own 15-25s failed handshake in one Neon-down request; a fresh
  execution probes again, so recovery is never masked;
  neon-conn-memo.test.js). **The hanging-connect problem is therefore still OPEN**: a connect
  that hangs can still burn the 6-min ceiling, whose kill SKIPS catch blocks,
  so none of the designed "fall back on error" paths run (the class that
  silently ate a Daily Queue Report day). Any future attempt needs a
  platform-supported mechanism, not URL properties.
- **Neon write discipline (don't regress this — it caused a daily-import
  timeout).** The Neon mirror is the dominant cost of the daily import,
  and three rules in `neonWrite.js` (duplicated, INV-16) keep it from
  blowing the Apps Script execution ceiling AND from corrupting the
  mirror on a timeout. (1) **Hash phone numbers through the per-run memo
  `CDR_HMAC_CACHE_`, never raw per-occurrence** — `Utilities.computeHmacSha256Signature`
  is slow and the same outbound numbers recur thousands of times per day;
  the cache is reset at the top of `writeCDRRowsToNeon`. (2) **Batch
  inserts and commit ONCE** — `call_history_phones` writes inline-literal
  VALUES in 200-row chunks (zero bound params — the JDBC bridge rejects
  oversized SQL strings) with a
  single `conn.commit()` after the loop. Per-row/small-chunk
  commits mean extra round-trips AND leave partially-committed rows
  on a mid-loop timeout. (3) **One probed connection per
  writer** via `getReachableNeonConn_()` (above), not a separate probe +
  write connection. (4) **Authoritative per-date replace (IMP-5)** --
  upsert-only mirrors leave PHANTOM rows when a force re-import's rebuilt
  set SHRINKS (with `DQE_READ_SOURCE=neon` that shows a split agent +
  double-counted totals). Callers whose payload is provably the COMPLETE
  set for its date(s) pass `{ authoritative: true }` (an in-transaction
  DELETE of those dates before the insert): the daily DQE build + dup-guard
  re-mirror (both INV-16 copies), the daily QCD mirror, the deferred
  per-date mirrors (NeonMirror.js), the daily Direct writer;
  **`writeCDRRowsToNeon({authoritative:true})` (P-6)** deletes the dates'
  `call_history_phones` CHILDREN first (parent-id subselect; deleted
  parents would strand their children), then the `call_history_dept`
  parents, same txn; and **`writeInboundCallsToNeon({authoritative:true,
  expectedDateIso})` (L2 + P-1)** so a shrinking re-import can't leave a
  phantom in `inbound_calls` (NO sheet primary). **P-1 -- every caller MUST
  pass `expectedDateIso`**: records are dated from their OWN first leg, so
  a stray D-1 carry-over leg would otherwise put D-1 in the payload's date
  set and the authoritative DELETE would wipe ALL of D-1 (stray-dated
  records are dropped with a log line; the DELETE can only touch the
  expected date). **F2 -- an empty record set still runs a delete-only
  pass** (`icDeleteDateOnly_`) so a legitimately-zero date sheds its
  phantoms -- GATED on a NON-EMPTY source grid (the P-3 validate-before-
  delete discipline) AND on zero stray-dated/date-less records (C-1
  all-stray = wrong-day grid; C-6 all-unparsed = format drift; refused with
  `allStray`/`allUnparsed` + a failure row + email). It reports
  `unreachable` when Neon is down so a deferred-mirror date stays queued.
  Pinned by the inbound-/outbound-calls suites.
  **PHI healing note (P-2):** pre-P-2 `ib_list_*` JSONB rows heal on a
  force re-import; past the Call_Legs retention, `backfillCDRHistory`
  re-hashes phone-shaped entries but raw NAME strings need a re-import or
  one-off SQL cleanup.
  Partial-set callers -- the bulk archive after `dedupeAlreadyArchived_`,
  the row-batched backfills (`backfillDQEHistory*`,
  `backfillDirectCallToNeon`) -- must NOT pass authoritative. Duplicate
  conflict-key rows are deduped last-write-wins first (IMP-6; since P10
  `backfillCDRHistory`'s batches too). The
  `call_history_phones` children are per-parent DELETE-then-insert (IMP-4:
  each payload row carries its parent's COMPLETE entry set, so per-parent
  replace is safe even on partial-date bulk batches; `DO NOTHING` survives
  only as an intra-payload dup guard; `backfillCDRHistory`'s child path
  deliberately stays fill-only per its docstring).
  (5) **`call_history_phones` children are GATED OFF (R27)** -- written only
  when `CDR_PHONES_MIRROR` is `on` (both copies), and the weekly
  `NeonRetention.gs` prune bounds storage (`NEON_RETENTION_ENABLED`).
  Operator State #57 has the why, the runbook and the tests.
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
  Pipeline Health panel both surface. **QCD and CSR Transfer are both
  guarded** (S2-2: CSR joined when R10-5 made `computeCsrTransferRange_`
  dashboard-read -- the story is in fix-history), on BOTH paths: the daily
  writes (`processIntegratedHistory:QCD`/`:CSR`) and, since P8, the bulk
  queue (`bulkBackfill:QCD`/`:CSR`, counted at `queueToPendingArchive`).
  **P26: every guard -- `refuseIfForce_`'s `opts.force` included -- fires
  only when force AND that sheet's date rows were ACTUALLY deleted** (the
  caller's per-sheet `forceDeleted` capture), so an always-force Manual
  Export of a first-time light day is a legitimate rows:0, never a false
  "data may be lost" alarm. CDR / QPath are NOT dashboard-read (INV-52 --
  legacy DQE Report only) so they're intentionally left unguarded.
  **When a historical sheet gains its
  first dashboard reader, add its force-path guard in the same commit** --
  the guard list is keyed on "is this dashboard-read", and that property
  changes over time. A NON-force empty rebuild is a legitimate no-op (F5) and
  is never flagged. New force-path writers that delete-then-rebuild must call
  one of these. **P-3 (ordering):** `processNewImport` reads + validates the SOURCE
  sheet ("Source sheet empty." throw) BEFORE the force-delete block -- a force
  re-run against an existing-but-empty/corrupt `Call_Legs` sheet used to
  destroy the date across all five historical sheets and THEN throw; it is now
  a clean no-op -- and since I-6 (Batch 2) the three compute stages
  (`calculateMetricsInMemory` / `calcQcdReport` / `calcCsrReport`) run before
  the delete too, so a compute throw is likewise a no-op (`csr-transfer.test.js`
  pins the order). New force-path writers must keep source validation ahead of
  any delete. Pinned by `csr-transfer.test.js` (the helper) + `pipeline-build.test.js` (M2).
- **System Health "Recent pipeline step failures" is the single trustworthy
  pipeline signal.** `SystemHealth.gs::getSystemHealth` scans the last
  `HEALTH_PIPELINE_SCAN_ROWS`=250 Pipeline Health rows -- never NARROWER
  than the Overview banner's window (LM1), and its OK text states the window
  measured. It flags a step ONLY when its MOST RECENT outcome is `failure`
  (failed-then-recovered is not flagged -- the OPS-8/M1 rule). The
  FAILURE-ONLY names (INV-44 lists them; `HEALTH_FAILURE_ONLY_STEPS_`) never
  log a success row, so a failure older than `HEALTH_FAILURE_ONLY_MAX_AGE_MS_`
  (4 days) is named in the hint, not flagged (O-3/C2-5; a recurring one stays
  red). The engine outcome rows (`*_LAST`) also warn STALE when an ARMED engine
  has not recorded past its allowance (O-4) -- a run killed at the 6-min
  ceiling records nothing. Catches every INV-44 step in one place (sheet
  writes, inline + deferred mirrors, the force-loss guards, the
  `dqeUpsert`/`dqeBackfill` tally rows). Pinned by `system-health.test.js`.
  This page is the PULL view; the optional **Pipeline-failure watchdog**
  (`PipelineWatch.gs`, Operator State #32) PUSHES the same new failure rows to
  admins by email. Three other sections share the page, each read-only and
  each documented at its own operator item: **"Report usage (last 30 days)"**
  (`computeReportUsageSummary_`; a bounded tail read, `REPORT_USAGE_SCAN_CAP_`=5000);
  **`SmokeCheck.gs::runLiveSmoke`** -- an editor-run, admin-gated, READ-ONLY
  sweep of the live read paths that complements the unit harness by exercising
  live WIRING (properties, scopes, sheets, Neon). **Run it after every
  deploy**; client-side surfaces still need the manual Regression Scenarios;
  and **`runNeonCoverageCheck`** (NeonCoverage.gs, Op State #35) -- per-date
  sheet-vs-Neon row-count reconciliation plus zero-row-weekday gaps on the two
  no-sheet-primary tables (`inbound_calls`, `outbound_calls`; a not-yet-created table is a clean SKIP
  via `ncMissingTableError_`, not a probe error); and
  **`runSheetCoverageCheck`** (SheetCoverage.gs, Op State #52) -- the SHEET-side
  twin: business days with ZERO rows in a dashboard-read historical sheet --
  the interior gap every other signal misses. Opens NO Neon connection, so it
  works mid-outage.
  All four store
  an OPS-8 prefix-coded outcome in their `*_LAST(_RESULT)` properties, which is
  what the page's classifier reads. Pinned by `system-health.test.js` /
  `smoke-check.test.js` / `neon-coverage.test.js` / `sheet-coverage.test.js`. **Two CAPACITY rows sit
  alongside them** -- Neon read volume MTD (`NEON_EGRESS_BUDGET_MB`, #47) and
  email quota remaining -- because both fail SILENTLY and look healthy to every
  other probe here. Read the Neon figure as a FLOOR (it counts our payloads,
  not the wire). The row also RANKS the top consumers -- every
  `neonNoteEgress_` callsite passes a surface label (unlabeled folds into
  `other`; system-health.test.js EA-1 pins it). Also on the page: `build-stamp` ("unstamped" = a push
  bypassing deploy.sh's CI gates, #2), `legs-horizon` (surviving
  Call_Legs_* dates; sheet-only) and
  `retention-risk` (surviving dates the per-call tables are missing;
  #40/#43).
  **Install readiness: a trigger being
  installed does NOT mean its engine runs.** Eight engines gate their handler
  BODY on an `*_ENABLED` Script Property (`NEON_KEEPWARM`, `INGEST_WATCHDOG`,
  `PIPELINE_WATCH`, `QUEUE_REPORT`, `DQE_SILENCE_WATCH`, `COACHING_DELIVERY`,
  `SHEET_COVERAGE`, `NEON_RETENTION`), so a trigger installed with the flag off
  fires on schedule and returns immediately. `svc()` takes an optional
  `flagProp` and flags
  BOTH mismatch directions ("installed but DISABLED -- every run is a no-op" /
  "NO trigger installed but flag=true -- it never runs"), plus a single
  `trg-readiness` verdict row ("N armed, K need attention"). A new
  flag-gated engine must pass its `flagProp` to `svc()` or it inherits the
  old blind spot.
- **Client-error beacon + usage-telemetry scope (R19).** Uncaught client
  errors (`window` error/unhandledrejection listeners in script-1-core,
  installed for EVERY signed-in user — the dev overlay's capture is
  admin-only and page-local) and the four top-level load failures
  (Overview / My Department / Insights / Escalations) report to
  `SystemHealth.gs::reportClientIssue`, which emails the admins
  immediately. Bounded at BOTH ends — client: once per error signature per
  session, max 6/session, and `reportClientIssue_` must never throw;
  server: one email per signature per 30 min + `CLIENT_ISSUE_WINDOW_CAP_`
  (=15) emails per rolling 6h CacheService window, with throttled reports
  still Logger.logged. Public but INV-01-clean (email + cache only, no
  sheet write). **A new top-level page loader's failure handler should call
  `reportClientIssue_('load-failure', ...)`** — drill/panel fetches with
  their own visible error states should not (noise). Usage-telemetry scope
  rules: `overview` rows mean DELIBERATE landings (the 5-min auto-refresh
  and the banner Retry pass `auto:true` and are not logged); `escalations`
  rows mean page ENTRY (only setPage's `escLoad_(true)` passes the
  `pageView` flag — filter/refresh/post-mutation reloads don't). The Health
  page's usage section carries a collapsed "User activity (last 30 days)"
  per-user rollup (`REPORT_USAGE_USER_CAP_`=40, busiest-first, top-3 report
  digest, role as of last-seen row). **Live presence (rollout timing):**
  both clients (script-1-core + agentApp) heartbeat
  `SystemHealth.gs::recordPresence` on load and every ~2.5 min while the
  tab is VISIBLE; the map lives ONLY in CacheService (`presence:v1`, prune
  15 min, "active" ≤ ~6 min, cap 100 -- lossy no-lock read-modify-write,
  next beat heals) and renders as the Health page's FIRST section, "Active
  now", so the admin can time a redeploy around live sessions. Any
  signed-in role beats (agents included; role `none` rejected -- the
  reportClientIssue gate class). A new client surface needs no wiring --
  the beat reads `data-page`; harness mocks live in build-harness.js AND
  build-agent.js. Pinned by system-health.test.js. **The beat's return also
  carries the serving deployment's E3 build stamp**: both clients compare it
  to the load-time `window.__BUILD_STAMP__` and on mismatch show a one-time
  dismissible `.update-notice` ("new version -- refresh when convenient") --
  a redeploy under an open tab surfaces within one beat, never a forced
  reload. Suppressed when either side is empty, so it detects only
  deploy.sh-stamped deploys (consecutive bare `clasp push` deploys are
  indistinguishable -- both ship the placeholder). ENFORCED:
  html-include-structure.test.js pins the 4-piece wiring (both template
  injections + both success handlers); system-health.test.js pins the stamp
  return.
- **Neon read-back (F1) is flag-gated and defaults OFF.** The dashboard
  still reads DQE from the `DQE Historical Data` sheet by default; the
  read-back lives in `NeonRead.gs` behind the `DQE_READ_SOURCE` Script
  Property (`getDqeReadSource_()` returns `'neon'` only when explicitly
  set, else `'sheet'`). With it unset, behavior is byte-identical to
  pre-read-back. Pieces: `neonFetchDqeRows_` / `sheetFetchDqeRows_`
  (symmetric DAL primitives returning the same normalized per-(date,agent)
  shape -- durations parsed to seconds, so the Neon path sidesteps the
  INV-02 TZ gotcha); `neonGetMaxDqeDate_`; and `compareDqeSources_` -- the
  **parity GATE** (editor-run wrapper `runDqeParityCheck`; range from the
  `DQE_PARITY_FROM`/`DQE_PARITY_TO` Script Properties; it ALSO compares the
  slot/abandoned detail columns via `includeMissedDetail`, so a
  parity-CLEAN result certifies the Missed Calls reader's inputs too).
  **Cut over a reader only after the gate is parity-clean over a
  representative range.** Rules that hold for every reader:
  (1) **`neonFetchDqeRows_` aggregates the whole result set into ONE json
  string server-side (`json_agg`) fetched with one `rs.getString` -- do NOT
  regress to per-row `rs.getXXX` iteration: Apps Script JDBC is ~0.5s/row,
  which turned a 12-month trend read into 20+ minutes.**
  (2) Every reader is `getDqeReadSource_()`-gated and falls back to the
  sheet on ERROR only -- LM2: a REACHABLE-but-empty read (the
  `out._neonReachable` marker, gated via the shared `neonDqeRowsUsable_`)
  is TRUSTED and served empty; pinned by `dal-cutover.test.js`, which also
  pins sheet-vs-neon payload parity byte-identical (incl. Missed Calls'
  `includeMissedDetail` grid adapter `missedGridsFromDal_` and
  `computeActiveAgentsInRange_`). Flipping the flag is reversible with no
  redeploy.
  (3) **ALL DQE readers are cut over, and a NEW DQE reader must be cut over
  in the SAME commit** -- an uncut one is invisible until the sheet ages
  out from under it, and prose could not keep this claim true (B-2, the
  silently-dead alerts -- fix-history): `tests/unit/cross-file-pins.test.js`
  fails CI if a dashboard `.gs` references `SHEETS.HISTORICAL` without
  `neonFetchDqeRows_`, unless it is on the documented
  `DQE_SHEET_ONLY_ALLOWED` list.
  (4) Even on the Neon path, `getDeptQueueExts_`'s all-history ext
  derivation comes from `deptQueueExtsForNeonReader_` /
  `neonGetAgentExtPairs_` (cached DISTINCT pairs fetch), sheet-scan
  fallback.
  Every cutover reader emits a `[dqe-read] <label> source=<neon|sheet>
  rows=<n> ms=<elapsed>` line (`logDqeReadTiming_`) for cost comparison.
  Reuses the dashboard `NEON_*` props + `script.external_request` scope
  (Operator State #18-19). **Index prerequisite (F1), created in prod:**
  `idx_dqe_history_call_date` + `idx_dqe_history_date_agent` on
  `dqe_history` -- Postgres has no stored row order; `ORDER BY call_date`
  at query time and the indexes keep it fast.
- **A Neon OUTAGE is a supported operating mode -- know what degrades and
  what does not.** Flip `DQE_READ_SOURCE` (and `QCD_READ_SOURCE`) to `sheet`
  for any outage lasting more than a few hours: the per-execution memo
  (`NEON_CONN_DOWN_MEMO_`) bounds the failed handshakes to one, but each of
  the ~20 cut-over readers still falls back with its OWN whole-sheet scan,
  which measured 730s+ on the all-departments queue report (vs ~54s when the
  same function was merely paying handshakes) -- and a run that hits the
  6-min ceiling is KILLED PAST its catch blocks, so the designed fallbacks
  never run (the class that once ate a Daily Queue Report day). Three tiers
  when Neon is down: (1) **sheet-primary, no loss** -- DQE + QCD (the sheet
  IS the authority; Neon mirrors it), so the flag flip is pre-cutover
  behavior, not a degraded one; (2) **sheet FALLBACK, disclosed** -- Direct
  Call (`Direct Call History` is the primary), Inbound report + heatmap +
  call-path drill (the `Inbound Calls` tab, Op State #49), Escalations (the
  E2 `ESC_SNAPSHOT_*` property snapshot, open rows only, read-only); (3)
  **NEON-ONLY, unavailable** -- the Coaching worklist, Caller Lookup's
  day-level "Earlier outbound activity" (`call_history_phones` aggregates),
  and every Neon WRITE (escalation create/update, coaching close). The flags
  do not change tier 2 or 3 either way. The Outbound report, the journey
  drill's outbound arm and Caller Lookup's per-call outbound section LEFT
  tier 3 when the `Outbound Calls` export landed (Op State #50). **Coming back is NOT just flipping back:**
  every import during the outage skipped its mirror writes, so
  `dqe_history` / `qcd_history` have a hole -- `runNeonCoverageCheck` (#35) to
  size it, `backfillDQEHistoryUpsert()` / a force re-import to fill it, THEN
  the parity gates over a window spanning the gap, and only flip on CLEAN
  (a clean run now self-clears its window props, so set them per run).
- **Neon keep-warm is an optional, admin-toggled trigger (`NeonKeepWarm.gs`).**
  Neon's free tier scale-to-zero suspends the compute after ~5 min idle, so
  the FIRST DQE read of a lull (when `DQE_READ_SOURCE=neon`) pays a
  cold-start penalty. `keepNeonWarm_` pings Neon (`SELECT 1`) every
  `NEON_KEEPWARM_EVERY_MINUTES` (=5) but ONLY inside a weekday business-hours
  window (`NEON_KEEPWARM_START_HOUR`=7 .. `NEON_KEEPWARM_END_HOUR`=13 Central,
  Script-Property-tunable), no-opping cheaply (property + clock check, NO Neon
  connection) outside the window / on weekends / when
  `NEON_KEEPWARM_ENABLED!='true'`. Default window ≈ 6h × ~22 weekdays ≈
  ~132 compute-hrs/mo. NB Neon's free tier is now 100 compute-hrs (it was
  ~190h when this window was sized), so the DEFAULT window no longer fits
  inside it -- narrow the hours or expect to pay (the Alerts modal
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
  'error', folding the CDR + QCD + Inbound + Outbound writer results --
  reachability is per-run binary against one instance) and the success toast appends
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
  `getDisplayValues`, INV-02-safe) and upserting via the SAME local writers
  (`writeCDRRowsToNeon` / `writeQCDRowsToNeon` / `writeDQERowsToNeon` /
  `backfillInboundCalls`). Three properties to preserve when editing it:
  the per-date reads are a BOUNDED TAIL-SCAN (`nmReadDateRowsTail_`, window
  `NEON_MIRROR_TAIL_ROWS`=3000, widening until the date's block is provably
  complete, so a drained date costs O(recent) but stays row-identical to a
  full scan -- F-20, pinned by tests/unit/neon-mirror-tail.test.js); the
  coercion-prone AD/AE/AF columns route through NeonMirror.js's copies of
  `sanitizeAbandonedCellForNeon_` / `sanitizeSlotCellForNeon_`, which **must
  stay byte-identical to the cdr-report/neonbackfill.js copies** (F3/F-24,
  enforced by `scripts/check-duplicated-files.sh`'s function-level check); and
  a date is LEFT QUEUED on any unreachable/failed step rather than dequeued --
  `mirrorInboundForDate_` honors `backfillInboundCalls`'s status object for
  exactly this reason, since `inbound_calls` has no sheet primary and a silent
  dequeue lost the rows for good. Only affects the daily/manual
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
  them). Resumable via `DQE_UPSERT_RESUME` (fingerprinted since T-8: a sheet
  change restarts from 0, logged); one connection per invocation; the T-7
  sanitizer-loss tally lands in `DQE_UPSERT_LAST` and a `dqeUpsert` Pipeline
  Health row (`failure` on loss = run the sheetRepairs). The bulk-complete
  alert reminds the operator.

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
- **CacheService tiers**: 6 h (`REPORT_CACHE_TTL_SECONDS` -- R24: raised
  from 30 min when the Neon monthly TRANSFER cap blew; every cached serve is
  a Neon fetch avoided) on the heavy per-(dept,range) aggregations (My
  Department `summary`, `companyOverview`, `individual`, `individual_active`,
  `insights`, `missed`, `direct`, `inbound`). Safe at 6 h because every one
  of those keys now carries `reportFreshnessTag_()` (Util.gs -- the latest
  DQE date, itself on the 5-min tier), so the morning ingest MINTS NEW KEYS
  within minutes instead of waiting out the TTL; a new heavy report key MUST
  join that tag or it inherits the stale-morning bug the tag exists to
  prevent -- every 6 h key carries an anchor
  (the tag, `neonAgentExts:v1` included, or a documented equivalent like
  `agentHist:v1`'s embedded latest date; the B1-B5 late-joiner story is in fix-history), ENFORCED (S3):
  cache-version-sync's ANCHOR_SPECS classifies every prefix and fails when
  a tag-anchored file stops calling `reportFreshnessTag_()`. **6 h (`QCD_ALLDEPT_CACHE_TTL_SECONDS`,
  CacheService's max) on the all-departments Daily Queue Report
  (`qcdAll:`)** -- keyed on the latest QCD date (`qcdAllFreshnessAnchor_`,
  D-1) and never caching an EMPTY payload, so a pre-ingest request cannot pin
  a blank report; a mid-day force re-import's corrections can still lag up to
  6h (the anchor moves only when the latest date does; the CacheWarm warm is
  freshness-guarded); 5 min (`CACHE_TTL_SECONDS`) on the freshness-sensitive
  `latestDate` / `latestDates` lookups so the morning ingest surfaces
  promptly; 60 sec on auth lookups (`AUTH_CACHE_TTL_SECONDS`). The tradeoff
  of the 6 h tier: ad-hoc admin corrections (orphan renames, DQE rebuilds,
  a mid-day force re-import) can lag up to 6 h in cached views not
  explicitly busted on write (Orphan Fix + Dept Config save bust their own
  init blobs and the Overview key ONLY -- `summary`/`missed`/`insights`/
  `individual`/`qcdAll` carry no config dimension, so a queue-mapping edit
  reaches those surfaces when the freshness tag moves or the TTL expires;
  the freshness tag busts only when the LATEST date moves). Each report file owns its own versioned
  cache prefix; bump the relevant version on any aggregation-rule change
  (cache-version-sync's S2 sweep fails on an unregistered prefix). See INV-30 for current versions. **Admin-modal init blobs are
  cached too (Batch 1):** the Outlier Fix + Dept Config init payloads
  (`orphanFix:init:v1` in OrphanFix.gs, `deptConfig:init:v1` in DeptConfig.gs)
  each scan sheets / Neon on every open, so they cache under
  `REPORT_CACHE_TTL_SECONDS` and are busted on EVERY write via
  `bustOrphanFixCache_()` / `dcBustCaches_()` -- admin-only surfaces, so the
  shared script cache is safe (no per-viewer personalization).
- **Sub-queue combined view on My Department (Phase 1).** A parent dept
  (Sales / CSR / Power) always renders the COMBINED table, grouped per dept,
  with each group's heading row as its collapse toggle; the three-way scope
  switcher it replaced is retired (control, collapse state and per-sub-queue
  missed-calls button: `docs/client-ui-conventions.md`). Depts with no
  sub-queues get no control and no behavior change. **The client no longer sends `subScope`, but the SERVER
  still honors it** -- it drives the CSV's Department column and the combined
  default -- so don't "restore" the parameter thinking it was dropped, and
  don't hardcode that default in a second place. `subScope` is a cache-key
  dimension (`summary:v21`); `cdr.dept.subscope` is now an orphan key.
  **Combined means grouped, never merged:**
  rows carry `dept`, each dept gets a `subq-group-head` subheader and its OWN
  subtotal row from `deptGroups`, and the grand total is labelled -- so the
  familiar own-dept figure stays on screen and every number reconciles against
  that dept's own view. Team averages / benchmark tints stay PER-DEPT
  (two teams' call profiles differ; one blended average is a worse number).
  **CROSSOVER AGENTS are the one exception to "every number reconciles"
  (sub-queue Phase 0).** A DQE row is keyed on (date, agent) with NO queue
  dimension, so an agent on TWO depts' rosters is returned by BOTH depts'
  `computeSummary_` calls carrying the SAME whole-day figures -- they show as
  two rows and their calls were counted TWICE in the grand total.
  `combineSummaries_` now SUBTRACTS each repeat appearance whose figures
  MATCH the first (a correction pass over the untouched accumulation, so a
  no-crossover combine is byte-identical BY CONSTRUCTION; L7: a
  changeover-mixed repeat with DIFFERENT figures is left summed -- fail
  open) and ships `totals.crossoverAgentCount`. Per-dept subtotals
  stay UN-deduped on purpose -- each must still equal that dept's own view --
  so **the grand total can now be LESS than the sum of the subtotals**, and
  both the totals-row caption and the CSV total row say why (an unexplained
  shortfall would read as a bug). The three DURATION means are deliberately NOT
  deduped (a mean weighting one agent twice stays in range; recomputing
  would move every combined view's number).
  Server side is `combineSummaries_` calling `computeSummary_` once per
  dept: every INV-02/04/05/23/53 + S35 + E5 rule inside that function is
  untouched, and its duration means are agent-count-WEIGHTED (never a mean
  of means). **`qcd` is the PRIMARY dept's only** -- `queuesForDept_`
  already rolls sub-queue queues into a parent's QCD snapshot, so merging
  it would double-count. **Phase 3:** the missed section shows ONE
  dept and does NOT merge (a parent's queue-only abandoned section already
  covers its sub-queues' queues -- merging would double-count, the
  QCD-snapshot trap); Escalations needed no change (`getEscalations` scopes
  by the Phase-0-widened `user.departments`).
  **The CLIENT side -- the relationship bar, grouped rows and subtotals,
  the IR/Insights picker groups, the combined CSV, the missed section's
  scope -- is in
  [`docs/client-ui-conventions.md`](docs/client-ui-conventions.md); read it
  before touching `script.html`.** Three of its rules are load-bearing
  server-side: a CHILD dept gets an upward pointer only (one level);
  **one report run is ONE department** (`subqPickerScope_` REFUSES a
  selection spanning depts -- the team average is per-dept, INV-25/27; fed
  by `computeSubQueuePickerGroups_`, deliberately separate from
  `computeActiveAgentsInRange_` so its pinned `{agents, floaters}` shape
  and INV-53 gate stay untouched); and the combined CSV's leading
  `Department` column appears ONLY when more than one dept is shown, so a
  single-dept export stays byte-identical. Insights' report body is NOT
  scope-switched (`.cycle/blocks/61-*`). See also
  [`docs/sub-queue-split-plan.md`](docs/sub-queue-split-plan.md).
- **Queue-split narrowing (Phase 2) is GATED OFF by default (S2-0).**
  `applyQueueSplitToRows_` (Data.gs) narrows each source row to the dept's
  OWN queues -- matched case-insensitively against `inboundQueuesForDept_`,
  the raw-name union -- BEFORE `computeSummary_`'s aggregation loop, so E5,
  INV-53, diagnostics and the totals inherit it unchanged. **Read the gate
  before reasoning about any dept's numbers:** the narrowing runs only when
  the `QUEUE_SPLIT_SCOPE` Script Property is `dept` (unset/anything else =
  `off`, the default). Every DQE reader narrows through this ONE helper --
  Missed (counts + the K..AC timeline via per-queue `mt`), IR, Insights,
  Overview (tiles/trends; the company HERO stays all-queue on purpose),
  Alerts, digests, the agent app -- so the flip is one property per
  Operator State #42's checklist (audit first); the gate lives INSIDE the
  function so adopters inherit it, and the scope joins every narrowed
  surface's cache key as a suffix (the CORE-3 pattern) so a flip can't
  serve the other mode's payload for the TTL. It **FAILS OPEN four ways**
  (showing a dept ZERO calls is worse than too many): no mapped queues, a
  row with no split, unparseable JSON -- and (B-1, assessed per WINDOW,
  never per row) a whole window whose mapped queues match NONE of the
  splits' RAW queue names, which is a CONFIGURATION fault (the
  canonical-vs-raw name bridge is the admin-populated "Inbound queue
  aliases" column, and nothing verifies it is complete -- fix-history B-1
  has the mechanism). A PARTIAL mismatch keeps its narrowing and reports
  the dropped queue (`meta.queueSplitUnmatched`); each row carries
  `queueScoped`. `avgAbdWait`/`csrAvgAbdWait` are NOT narrowed (the
  pipeline stamps one per-DAY value on every row), nor are the AD-derived
  abandoned-call counts (ids carry no queue identity; L6 drops only the
  ambiguous AF↔AD pairings so a narrowed ring never drills a wrong call). **Phase 2 INVERTS the
  Phase 0 rule:** a `queueScoped` row is never de-duplicated -- two
  narrowed rows PARTITION the agent's day, so summing is correct and
  subtracting would under-count. The relationship bar + `subqSplitChip_`
  are HIDDEN (Round-16 owner; `SUBQ_BAR_HIDDEN_`); the B-1 mismatch signal
  is `auditQueueSplitAttribution()` (Operator State #41).
- **Scope is locked to `roster` (Phase 14/15 roster-only flip).** Both public
  RPCs hardcode `scope = 'roster'` -- `Data.gs::getDepartmentSummary` (the My
  Department agent table) and `MissedCallsReport.gs::getMissedCallsReport` (the
  per-agent missed-call timelines) -- so both list ONLY the dept's
  `DO NOT EDIT!` roster agents and QUEUE-chipped floaters never appear there.
  **The reason matters if you are tempted to widen it back:** in production the
  shared-queue-overlap match proved to be mostly FALSE POSITIVES (agents who
  never actually handled the dept's calls), and genuine cross-dept assist is
  rare. The `roster | queue | both` segmented control that once exposed this
  was retired in the redesign cleanup. **The Missed
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
- **Multi-page architecture: Overview + My Department + Escalations.**
  The dashboard is one HTML doc with top-level `<section>` pages toggled
  by `body[data-page="overview|dept|escalations"]` (the `.page`
  CSS shows only the active one). **Overview is the default landing** for
  every page load; **My Department** is the per-dept agent table;
  **Escalations** (`#/escalations`) is an interactive worklist; **Insights**
  (`#/report/insights`) is an open-inline REGION at the bottom of My
  Department (`#dept-insights-region`, M1 merge + N1 -- renders and
  GENERATES with the dept page via `deptInsightsEnsureLive_`, never on the
  Overview landing; `setPage('insights')` maps there; since R17b it sits
  INSIDE `.dept-layout`'s main column so the two sticky side panels (Queue
  Call Data + Team Rings Data) ride the whole page;
  see docs/insights-merge-plan.md). `setPage(name)` swaps the page, the header kicker/title, and triggers
  that page's load (Overview -> `ovLoad_`; Escalations ->
  `escEnsureInit_`+`escLoad_`). Modals (Help,
  Settings, Individual, Alerts, Orphan Fix, Dept Config) overlay any page;
  there is no standalone Missed Calls modal -- **the My Department page's
  inline missed section IS the Missed Calls report.**
  **Insights has no setup-form step:** it generates WITH the dept page --
  an agent-free whole-dept run (INV-45) over the dept controls' window (the
  page's single date authority -- `insSyncToDeptWindow_` converges the open
  region on date/dept changes; date prefs are gone) -- and editing is the
  dept controls + the "Comparison & agents" popover. The form survives
  HIDDEN as the failure / empty-roster fallback only (`insShowForm`) --
  see docs/insights-merge-plan.md.
  Overview auto-refreshes silently every 5 minutes while active, re-fetching
  from the server cache. **A dept-TILE click SOLOS that dept's line on the
  30-day trend chart; it does NOT navigate** --
  `chartSpotlightTogglePin_(ovChartInstance, dept, additive)`, the same pin-set
  model the chart legend uses (Shift/Cmd/Ctrl-click ADDS to the pinned set; a
  plain click on the lone pinned tile releases it). Pinned tiles carry
  `.ov-tile-soloed`, synced by `ovSyncTilePins_` **guarded to
  `chart === ovChartInstance`** so the QCD chart that reuses these helpers
  isn't cross-contaminated. Navigation to My Department is via a chart POINT
  click (`ovHandlePointClick_` -> `ovRouteToDept_(dept, iso)`; admins, or a
  manager on their own dept's line) or the dept-selector dropdown.
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
- **Overview admin-only banners (Phase B).** Three banners sit above the
  Overview summary line, all sharing one shape: **two layers of gating** --
  the div's `data-admin-only` attribute is cleared at init for admins (the
  `querySelectorAll('[data-admin-only]')` loop in script.html), AND each
  renderer further hides itself when there's nothing to say -- plus a
  **best-effort server helper that returns null on failure**, so a broken
  helper costs the banner, never the Overview.
  (1) **Pipeline Health** (`#ov-pipeline-banner` / `ovRenderPipelineBanner_` /
  `computeOverviewPipelineFreshness_`) fires when no DQE-freshness success row
  (`buildDQE` / `processIntegratedHistory:DQE` / `bulkBackfill:DQE`, per
  INV-44) appears in the last `OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS` (=250 --
  **do not shrink it**: at 40 a deferred-mirror retry storm evicted the DQE row
  and false-warned, LM1) Pipeline Health entries, OR the latest is older than
  `OVERVIEW_PIPELINE_STALE_HOURS` (=36h, matching the header freshness pill).
  A `rows:0` DQE-step `success` (a no-op build of an already-in-history date)
  does NOT count as freshness -- the helper requires `rows>0` (F5).
  (2) **Orphan Fix nag** (`#ov-orphan-nag` / `ovRenderOrphanNag_` /
  `computeOverviewOrphanNag_`) counts orphans with `lastSeen` inside
  `OVERVIEW_ORPHAN_NAG_DAYS` (=7d), samples up to 3 names by row-count desc,
  and its Open button clicks `#orphan-fix-btn`.
  (3) **Unmapped-queue nag** (`#ov-unmapped-nag` / `ovRenderUnmappedNag_` /
  `computeOverviewUnmappedQcd_`) fires when QCD queues seen in the data map to
  no department; it reuses the Dept Config discovery (`discoverQueues_`, the
  180-day QCD scan + the effective per-dept map, **so it invents no mapping**),
  samples up to 3 queue names busiest-first, and its Open button clicks
  `#dept-config-btn`. Its `unmappedQcd` payload field is admin-only and
  stripped by `personalizeOverview_` (`companyOverview:v21`).
- **Agent table column model (My Department).** The table is rendered
  from the client `COLUMNS` array (script.html) against a matching static
  `<thead>` in `dashboard.html` (1:1 by position; the Overview mini-table
  `ov-user-table` shares `COLUMNS` and must keep its own thead in sync).
  Columns: Agent · Source · **Answered / Missed** (`type:'bar'`; since
  Round-16 AGENT rows render a VOLUME-PROPORTIONAL TALLY — sage answered +
  red missed blocks, one block per cohort-adaptive unit via
  `ansTallyUnitFor_` (≤36 blocks for the busiest row; a >1 unit is disclosed
  in tooltips + a totals-row legend) — while totals/subtotal rows keep the
  classic proportional bar; there is no separate Rung / Missed / Answered /
  **Total calls** column; built by
  `answeredBarHtml_`, carries the E5 WoW chips inline on the answered/missed
  counts and the rung total as a muted "(N)", answer-rate gets the R23
  three-tier dept-standard tint, sorts by computed `answerRate` via a special
  case in `sortRows`. **The CSV still emits a numeric Total calls column** spliced
  after the bar in `exportTableCsv_`) · **Answer %** (a `type:'pct'`
  cell = answered/(answered+missed), the R23 dept-standard tint, always visible so the
  rate the bar folds in is readable without decoding it; shares the bar's
  `answerRate` sort key) · Unique ·
  TTT · ATT · Avg Abd Wait · CSR Avg Abd Wait. The five `hideable:true`
  columns (Source / Unique / TTT / Avg Abd Wait / CSR Avg Abd Wait) FOLD
  AWAY by default behind the **"Show all columns"** toggle
  (`#dept-cols-toggle`, persisted in `cdr.dept.cols`, applied via the
  `hide-extra` class + `.col-extra` cells through the shared `cellClass_`
  helper); the Overview mini-table carries `hide-extra` permanently
  (glance view). Default sort is `answerRate` ascending (worst answer rate
  first; idle/no-activity agents always sink to the bottom regardless of
  direction). **The Overview mini-table is header-sortable too**, with its OWN
  sort state (`ovUserSort_`, same worst-first default,
  `ovRenderUserRows_`/`ovOnUserSort_`); `sortRows` is parametrized
  `(rows, sortKey, sortDir)` so both tables share it, and each table's Total
  row renders from `totals` (never part of the sort).
  CSV export (`exportTableCsv_`) emits ALL columns regardless of the toggle
  and renders the bar as `answered / missed (rate%)` text + the Answer %
  column via `pctCsv`. **In a sub-queue COMBINED view it also prepends a
  `Department` column and emits per-dept subtotals + an `All shown` grand
  total** (single-dept exports are byte-identical to before) -- see the
  sub-queue combined-view decision above, and S43. `drive-subqueue.js` is the
  ONLY automated coverage of any CSV writer in this repo (both shapes, asserted
  from real Blob bytes); S43 remains the manual walk over the rest.
- **Source column + roster-only totals (Phase D).** The agent table's
  Source column (between Agent and the Answered/Missed bar) renders one of
  three chips per row: **ROSTER** (accent-soft), **BOTH** (good-soft, rostered
  AND matched via shared-queue extensions), **QUEUE** (warn-soft, queue-only
  floaters) -- the QUEUE chip suffixing the floater's `sourceHomes` as a dept
  list, e.g. `QUEUE · Sales, Power`, or bare `QUEUE` when on no roster.
  **In practice the QUEUE chip never renders HERE**, because
  `getDepartmentSummary` locks scope to `roster` (see the decision above), so
  `queueOnlyAgentCount` is 0 and the "N floaters excluded" caption stays
  hidden. The chip helpers and the `sourceHomes` machinery are NOT dead
  code -- they serve the IR picker's floater group (INV-53) and Diagnostics,
  which is why the whole path is still documented.
  `sourceHomes` is built lazily server-side by `Data.gs::buildDeptsByAgent_`
  (only when at least one queue-only row exists) and iterates every dept
  including `OVERVIEW_HIDDEN_DEPTS` in `getAllDepartments_` alphabetical
  order, so the array is stable; client `sourceChipHtml_` / `sourceChipCsv_`
  array-check defensively and fall back to bare `QUEUE` if it's missing.
  **The totals row sums only `matchedViaRoster=true` rows** -- queue-only
  floaters never factor into dept averages -- and the totals object carries
  `rosterAgentCount` + `queueOnlyAgentCount`, driving a
  'Total (roster only · N floaters excluded)' caption when the latter is
  non-zero ('Total (roster only)' in the CSV). **The totals row is a pinned
  `<tbody class="agents-totals">` ABOVE the data rows, not a `<tfoot>`** -- a
  real tfoot always renders at the bottom; the element ids `agents-tfoot` /
  `ov-user-tfoot` were kept so the JS is unchanged. INV-04 (exact agent-name
  match) and INV-23 (queue-sentinel `A_Q_*` rows skipped) both hold. See
  INV-53 for the floater-exclusion contract across all dept-level aggregations.
- **Phase E UI surfaces** (the `E#` codes appear in code comments across
  script.html / styles.html / Code.gs / IndividualReport.gs / Data.gs, so
  they stay attached to their affordance). Four client surfaces, each with a
  data dependency worth knowing: (**E2**) the **work-window pill**
  (`#work-window-pill`) reads `window.__WORK_WINDOW__`, injected by
  `renderDashboard_` from `Config.gs::DASHBOARD_WORK_WINDOW` -- the dashboard's
  read-only mirror of cdr-import's pipeline constants, so **changing those
  constants requires syncing this one** (INV-06). (**E3**) the `.diagnostics`
  block's severity chip: `.diag-severity-warn` for 1-5 issues,
  `.diag-severity-bad` for >5, off the same
  `rosterWithNoData.length + queueOnlyMatched.length` total the collapsible
  reads. (**E4**) the **EXCLUDED FROM TEAM AVG pill** (`.ir-excluded-pill`) on
  IR agent cards, from the `excludedFromTeamAvg` field on each `summaryData`
  row (INV-26). (**E9**) the **QCD days-to-violation forecast**
  (`#qcd-forecast`): a 7-day linear regression on `dailySeries.abandonedPct`
  (INV-51) projecting when the 4% threshold crosses, hidden in three healthy
  states -- currentY >= 4 (already over), slope <= 0.01 (flat / improving), or
  a projected crossing more than 7 days out. The three later Phase E items
  each have their own home: **E5** per-row WoW chips (the "Per-row
  prior-period chips" gotcha), **E8** alert Skip Dates (INV-33 / INV-34),
  **E10** threshold drift (its own gotcha bullet).
- **Floater-awareness in the agent reports (INV-53 expansion, Phase D+1).**
  The agent-level reports extend the Phase D My Department contract (the
  Performance and Compare Ranges reports carried it too, until both were
  retired; IR and Insights are what remain).
  `Util.gs::computeActiveAgentsInRange_` returns `{agents, floaters}` -- NOT
  the bare `string[]` its name suggests -- with floaters carrying `sourceHomes`
  (the agent's other-dept roster homes, via `buildDeptsByAgent_`); each report's
  init endpoint surfaces `activeFloaters` alongside `activeAgents`. The shared
  picker builder `irBuildAgentListHtml_` renders a third collapsed `<details>`
  group, "Floaters (queue-only)", under Active / No-activity, entries tagged
  with `.ir-agent-floater-chip`. The per-card chip reuses `sourceChipHtml_` (the
  My Dept Source-column helper) but renders **only** when
  `matchedViaQueue && !matchedViaRoster` -- roster agents stay implicit.
  **Security: dropping the roster-only input gate does NOT relax data access.**
  An off-dept name renders only if its rows had queue-overlap with the dept's
  queue extensions (the same path My Dept uses to surface floaters); a crafted
  name with no queue connection produces no rows and falls out of the
  `visibleAgents` filter. **Two implementation details that look like bugs if
  you don't know them:** each report pre-populates `agentMatchedViaRoster` for
  selected roster members BEFORE the row scan, so a zero-call roster pick still
  renders its card; and `sourceHomes` is built lazily, only when the selection
  contains at least one floater. INV-53 is the underlying contract; INV-26 is
  the separate `TEAM_AVG_EXCLUDES` path, which composes with the floater gate
  in IR.
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
> undocumented operator state. The COMPLETE classified view of the live store
> (the settings page caps at 50 rows) is the Health page's folded "All Script
> Properties (inventory)" section, backed by `Config.gs::PROP_REGISTRY_` —
> see the registry bullet in Common Gotchas.

The numbered items now live in full in
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
4. Is the cache stale? (per-report prefix, INV-30; 6 h reports w/ freshness tag / 5 min freshness)
5. Were the source-pipeline bugs re-introduced? (spot-check Sonia 2026-03-09: TTT `0:15:03`, ATT `0:03:01`)
6. Was `setup()` re-run after a pull that adds sheets? (admin-gated, idempotent, ten sheets)
7. Is `DASHBOARD_URL` set? (alert-email links + every report's "Open in new tab")
8. Are all three trigger families installed? (daily alerts / the integrated DQE build / daily+weekly+monthly digests)
9. Did the latest push add an OAuth SCOPE? (Run any function once in the editor to consent)
10. Does a new `OVERVIEW_PARENT_OF` key match the roster column header byte-for-byte?
11. Pipeline Health sheet -- a long quiet stretch on `autoImport` or any DQE-freshness step
12. Manager digest not delivered -- the seven things to check
13. `ADMIN_EMAILS` Script Property (a new admin who sees no admin features)
14. A dept shows "No queues mapped" / no QCD chips -- map its queues (Dept Config, no redeploy); the SAME list narrows My Department's per-agent numbers WHEN `QUEUE_SPLIT_SCOPE=dept` (#42), so a partially-mapped dept under-reports only in that mode
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
37. `ANSWER_TARGETS` + `DEPT_ANSWER_TARGETS` + `TRANSFER_TIERS` -- the admin-tunable DISPLAY standards (R23: global answer target seed 80 + 10-pt amber band; CSR seed 92/2; CSR transfer tiers 25/30/35)
38. Diagnosing "a queue's inbound calls are missing" -- the F1/F1b runbook, incl. the ANTI-pattern probe
39. Sub-queue ACCESS widening -- who gains what on deploy, with no admin edit (INV-38)
40. Per-queue split backfill -- a ONE-TIME step whose 14-day window CLOSES; miss it and those dates can never be split
41. A dept's totals changed after a re-import -- `auditQueueSplitAttribution()` separates "the de-dup worked" from "a queue is mapped to no dept and its calls were dropped"
42. `QUEUE_SPLIT_SCOPE` -- the per-dept queue-narrowing switch (default `off`); the ship list is COMPLETE -- the flip checklist, and what each mode makes the numbers mean
43. The `Call_Legs_*` retention prune -- install `runRetentionPrune_` (CDR Tools menu; logs `retentionPrune` Pipeline Health rows) and remove any hand-made `deleteOldCDRSheets` trigger; the ~14-day window everything assumes rests on it
44. DQE-silence watchdog -- the queue-active-agents-dark cross-check born from the Field Ops Power blind spot; enable it (`installDqeSilenceWatchTrigger()`), thresholds + episode semantics in the item
45. Sign-in notifications -- first-sighting + outcome-change emails to admins (incl. DENIED attempts); ON by default, `LOGIN_NOTIFY_ENABLED=false` silences
46. `AGENT_ROLE_ENABLED` -- the agent-role resolution switch (default OFF; Phase A ships dark -- agents get access-denied until Phase B's pages exist)
47. `NEON_EGRESS_BUDGET_MB` -- arms the Health page's Neon read-volume gauge with a threshold; unset leaves it informational (and the figure is a FLOOR, so under-budget is not proof of headroom)
48. `COACHING_DELIVERY_ENABLED` -- the weekly coaching delivery engine (F-e); install/arm from Admin ▾ → Coaching, first armed run emails one larger NEW-flag batch
49. Inbound Calls tab export trigger -- keeps the heatmap's SHEET FALLBACK fresh (CDR Tools menu), plus the one-time historical re-export after deploying cols 16-17
50. Outbound Calls tab export trigger -- the keystone that moved the Outbound report, the journey drill's outbound arm and Caller Lookup's per-call outbound section OUT of Neon-only (CDR Tools menu); seed it while Neon is reachable
51. `AGENT_EMAIL_DOMAINS` (optional) -- extra domains a TYPED agent address may use when emailing an Individual Report to its subject; prefer adding the agent's Access Control row instead (no typing, no mis-delivery risk)
52. Sheet coverage check -- flags business days with ZERO rows in a dashboard-read historical sheet (the interior gap every other signal misses); no Neon needed, so it works mid-outage; arm the weekly trigger (`installSheetCoverageTrigger()`) -- a clean week is silent
53. Script Properties past the settings page's 50-row display cap -- set or clear one from a TEMPORARY editor-run function, then delete the function; the Health page inventory is the complete read view
54. Caller Lookup's one-time Neon index (`idx_inbound_calls_caller_hash`) -- create it in the Neon console; nothing auto-creates it
55. The `DO NOT EDIT!` insurance block (cols X-AG) is read by ONE fixed-column reader -- moving it means two constants in `insuranceNumbers.js`, a cdr-report push, and re-running `syncInsuranceNumbersToNeon`; keep a blank header column between the dept block and it
56. Reprocessing historical dates -- Manual Export per date (mirrors Neon inline) over the bulk path; clear `DQE_UPSERT_RESUME` before any backfill; the zero-talk scan (answered > 0 with TTT 0:00:00) is the post-rebuild check, and `repairDqeDuplicateMerge` is the remedy for same-day (date, agent) duplicates
57. Neon storage cap -- the `CDR_PHONES_MIRROR` phones-write gate (OFF by default since R27), the weekly `NEON_RETENTION_ENABLED` prune (`installNeonRetentionTrigger()`), `CDR_BACKFILL_BEFORE`, and the one-time reclaim runbook (drop dead indexes, delete post-capture phone rows, TRUNCATE + refill the pre-capture block, VACUUM FULL)
58. `EMAIL_BCC` / `ACCESS_WELCOME_EMAIL` -- the default-BCC rule on every dashboard email (first admin unless overridden; `none` disables) and the welcome email a brand-new Access Control grant sends (needs `DASHBOARD_URL`; `false` disables)

## Cycle Workflow Config

### Test Command
node --test

(Zero-dep Node `node:test` suites under `tests/unit/`, run from the
repo root -- `tests/README.md` is the suite-by-suite coverage map.
NOT yet covered: the deferred mirror's sheet-derived payload
re-derivation (NeonMirror.js) and anything UI/live -- the manual
Regression Scenarios remain the verification of record there, so walk
the scenarios that overlap a change in addition to running
`node --test`.)

### Health Dimensions
Data Accuracy (DQE), Access Control Integrity, Source Pipeline Reliability, Migration Progress, Cross-Project Consistency, Documentation Freshness, Performance & Cache Effectiveness, Error Surfacing & Observability, Manager-Facing UI Polish, Deployment Hygiene, Code Health

### Subsystems
Department Dashboard:
  apps-script/department-dashboard/Auth.gs, apps-script/department-dashboard/Code.gs, apps-script/department-dashboard/Coaching.gs, apps-script/department-dashboard/AgentHome.gs, apps-script/department-dashboard/agent.html, apps-script/department-dashboard/agentApp.html, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/BuildStamp.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/Diagnostics.gs, apps-script/department-dashboard/Setup.gs, apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/NeonRead.gs, apps-script/department-dashboard/NeonKeepWarm.gs, apps-script/department-dashboard/CacheWarm.gs, apps-script/department-dashboard/IngestWatchdog.gs, apps-script/department-dashboard/PipelineWatch.gs, apps-script/department-dashboard/DqeSilenceWatch.gs, apps-script/department-dashboard/NeonBackup.gs, apps-script/department-dashboard/NeonCoverage.gs, apps-script/department-dashboard/NeonRetention.gs, apps-script/department-dashboard/SheetCoverage.gs, apps-script/department-dashboard/SystemHealth.gs, apps-script/department-dashboard/SmokeCheck.gs, apps-script/department-dashboard/MissedCallsReport.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/InsightsReport.gs, apps-script/department-dashboard/InboundReport.gs, apps-script/department-dashboard/DirectCallReport.gs, apps-script/department-dashboard/OutboundReport.gs, apps-script/department-dashboard/CallerLookup.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/CompanyOverview.gs, apps-script/department-dashboard/Digest.gs, apps-script/department-dashboard/EmailKit.gs, apps-script/department-dashboard/DeptSummaryEmail.gs, apps-script/department-dashboard/QueueReportEmail.gs, apps-script/department-dashboard/OrphanFix.gs, apps-script/department-dashboard/QCDReport.gs, apps-script/department-dashboard/DeptConfig.gs, apps-script/department-dashboard/Escalations.gs, apps-script/department-dashboard/access_denied.html, apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script.html, apps-script/department-dashboard/script-1-core.html, apps-script/department-dashboard/script-2-chrome.html, apps-script/department-dashboard/script-3-overview.html, apps-script/department-dashboard/script-4-nav.html, apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-6-ir.html, apps-script/department-dashboard/script-7-admin.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/script-9-inbound-direct.html, apps-script/department-dashboard/script-10-escalations.html, apps-script/department-dashboard/script-11-qcd-boot.html, apps-script/department-dashboard/styles.html, apps-script/department-dashboard/appsscript.json

CDR DQE Pipeline:
  apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-report/DQEdrilldown.js, apps-script/cdr-report/DQEDrilldownSidebar.html, apps-script/cdr-report/dataFilters.js, apps-script/cdr-report/CDR Tools menu.js, apps-script/cdr-report/appsscript.json

CDR Reporting Tools:
  apps-script/cdr-report/dashboardCDR.js, apps-script/cdr-report/dbHistorical.js, apps-script/cdr-report/dbReporting.js, apps-script/cdr-report/emailDailyReport.js, apps-script/cdr-report/neonbackfill.js, apps-script/cdr-report/neonEgress.js, apps-script/cdr-report/queueOverlapAudit.js, apps-script/cdr-report/neonWrite.js, apps-script/cdr-report/buildStamp.js, apps-script/cdr-report/inboundCallsExport.js, apps-script/cdr-report/outboundCallsExport.js, apps-script/cdr-report/insuranceNumbers.js, apps-script/cdr-report/sheetRepairs.js

CDR Import:
  apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/CDR Tools.js, apps-script/cdr-import/DeleteOldSheets.js, apps-script/cdr-import/autoImport.js, apps-script/cdr-import/buildDQEHistoricalData.js, apps-script/cdr-import/importBulkCSVsFromDrive.js, apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/outboundCalls.js, apps-script/cdr-import/NeonMirror.js, apps-script/cdr-import/directCallMetrics.js, apps-script/cdr-import/queueSplitSample.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-import/buildStamp.js, apps-script/cdr-import/appsscript.json

DQE Report Legacy:
  apps-script/dqe-report/DQEdashboard.js, apps-script/dqe-report/FAQGuide.html, apps-script/dqe-report/IndividualReport.js, apps-script/dqe-report/IndividualReportModal.html, apps-script/dqe-report/MissedCallsReport.js, apps-script/dqe-report/MissedReportModal.html, apps-script/dqe-report/MultiCompModal.html, apps-script/dqe-report/MultiComparisonTool.js, apps-script/dqe-report/SingleRangeReport.js, apps-script/dqe-report/SingleReportModal.html, apps-script/dqe-report/menu DQE Tools.js, apps-script/dqe-report/sendManualAlert.js, apps-script/dqe-report/showFAQ.js, apps-script/dqe-report/appsscript.json

### Invariant Library
Full text: [`docs/invariants.md`](docs/invariants.md) (F8 split) — one entry per
line, `INV-NN | rule | Subsystem: ...`. **The entry is authoritative; the index
below is a finding aid.** Several invariants carry exceptions and version
history that a one-line summary cannot hold, so open the entry before relying
on one (INV-30's cache-version table above all).

INV-01 | Public (RPC-callable) functions never write a spreadsheet except the admin-gated carve-outs (OrphanFix / setup / DeptConfig / Access Control / Alert+Digest config / the Coaching worklist close, a Neon write) plus the append-only Report Usage telemetry; `_`-suffixed helpers are RPC-unreachable | Subsystem: Department Dashboard
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
INV-28 | The auto-adjacent prior period is the immediately-preceding window of the same WORKING-DAY count (R24; a Monday compares to Friday, never Sunday), NOT the previous calendar month; one shared `computePriorWindow_` / `resolveComparisonWindow_` | Subsystem: Department Dashboard
INV-29 | The 12-month trend window rule, with one shared `computeTrendStartDate_` so IR / Insights / QCD trends align | Subsystem: Department Dashboard
INV-30 | Every report owns a VERSIONED cache prefix -- bump on any aggregation-rule change. Current versions, their bump history, and the read-source key suffixes are all in the entry | Subsystem: Department Dashboard
INV-31 | The `script.send_mail` scope backs every export / alert / digest / queue-report / failure-notify path | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the notify-failure paths)
INV-32 | Alerts is admin-only at the SERVER boundary -- `assertAdmin_` on every callable in Alerts.gs | Subsystem: Department Dashboard
INV-33 | Daily alerts skip weekend + company-holiday RUNS and assess the previous BUSINESS day; per-dept Skip Dates are trigger-only | Subsystem: Department Dashboard
INV-34 | `Alert Config` / `Alert Log` schemas, plus the invalid-threshold / unknown-dept / duplicate-row flag contract | Subsystem: Department Dashboard
INV-35 | The length-mismatch flag trips at 1.2x counted in WORKING days (weekends AND company holidays excluded) | Subsystem: Department Dashboard
INV-36 | Cache keys that embed an agent selection MUST hash through `hashAgents_` -- CacheService silently rejects keys over 250 chars | Subsystem: Department Dashboard
INV-37 | Multi-PAGE app toggled by `body[data-page=...]`; `setPage()` owns the swap; `refresh()` writes the header title only on the dept page | Subsystem: Department Dashboard
INV-38 | `OVERVIEW_PARENT_OF` (+ the Dept Config `Overview Parent` override) is NO LONGER Overview-only: since sub-queue Phase 0 it ALSO expands a manager's dept ACCESS one level (`resolveUser_` widening, fail-closed) and shapes rollups; keys must match roster column headers byte-for-byte | Subsystem: Department Dashboard
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
S44 | CSR transfer detail renders and reconciles | Subsystem: Department Dashboard

### Frozen Subsystems
- DQE Report Legacy — manager-facing reports in `apps-script/dqe-report/`. Frozen because migration to Department Dashboard is complete: Individual Report, Performance Report, Compare Ranges, Missed Calls Report, and Low Answer Rate Alerts all live in the dashboard. Replacement: Department Dashboard. Awaiting decommission of the legacy spreadsheet. Unfreeze only if a bug is found in legacy that affects production decisions before the spreadsheet is retired.

### Deploy Command
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`
CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (same Apps Script project as CDR DQE Pipeline)
CDR Import: `cd apps-script/cdr-import && clasp push -f`
DQE Report Legacy: `cd apps-script/dqe-report && clasp push -f` (frozen — cleanup deploys only)
