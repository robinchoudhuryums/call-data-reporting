# Next steps — the sequenced roadmap (as of 2026-09-11)

**What this is.** The one place that says what is queued, in which batch, and
why in that order. Detailed designs stay in their own plan docs (linked); the
per-session state stays in `.cycle/STATE.md`. Update this file when a batch
ships or the order changes — a stale sequence is worse than none.

**How a batch works.** One batch = one cohesive set of PRs + one deploy per
project it touches. Batches are ordered by (1) what protects the next batch,
(2) what has a clock running, (3) what groups into a single deploy. Within a
batch, items are independent unless marked.

## The sequence at a glance

| # | Batch | Items | Projects / deploy | Start when |
|---|---|---|---|---|
| 1 | **Safety nets** | 1a harness runs under the live TZ split · 1b snapshot before any bulk repair | 1a none · 1b cdr-report | now |
| 2 | **Dashboard round** | 2a Escalations: admin delete · 2b notes #2+#1 (help chip + tour) | dashboard (one deploy) | after 1a |
| 3 | **After-hours capture** (note #5) | two additive DQE cols, own PR | cdr-report + cdr-import | after 2 (owner's order; the 14-day clock argues for swapping 2 and 3 — owner's call) |
| 4 | **Phase 2 nightly check-and-sort** | + Health page row · + TZ-SPLIT predicate (memoized) · + bulk-path sort failures → Pipeline Health | cdr-report + cdr-import + dashboard | after 3 |
| ∥ | **Neon storage decision** | operator decision; optional Health row "Neon storage by table" | none, or dashboard | any time |
| 5 | **End the timezone split** (gated) | design spike → migration | all three + the spreadsheet setting | Phase 2 live ≥ 2 weeks AND 1b shipped |
| — | **Phase 3 binary-search span** | deferred | — | after 5 has held |
| — | **Follow-ons** | ride along with whichever batch touches the file | — | — |

**Why this order.** 1a is hours of work and is the only item that would have
stopped R46 before it reached the sheet; every later batch writes or reads
dates. 1b must exist before the next bulk cell rewrite — that is Batch 5, and
any future coercion repair. Batch 2 groups the dashboard-only work into one
deploy. Batch 3 has a clock: `Call_Legs` is pruned at 14 days, so every day
before it deploys is a day the after-hours columns can never be filled. Phase 2
fixes an ordering problem the span readers already tolerate, so it waits.
Batch 5 rewrites ~90k date cells across five sheets and needs both the
nightly census (Phase 2) as its gate and the snapshot (1b) as its rollback.

---

## Batch 1 — safety nets

### 1a. Run the unit suite under the live timezone split

**Goal.** Make script-midnight ≠ sheet-midnight the DEFAULT in every fixture,
so a TZ-blind writer or reader fails in CI instead of on the sheet. R46
shipped green because CI pins the process to `America/Chicago` and the fake
spreadsheet also defaults to Chicago — the two midnights coincided in every
fixture that existed.

**Design.**
- `tests/harness/fakeSheet.js`: `makeFakeSpreadsheet` default `timeZone` →
  `'America/Mexico_City'` (the live value). The shim's
  `Session.getScriptTimeZone()` stays `'America/Chicago'`, so the pair is the
  production pair by default.
- Sweep the 28 suites that pass `timeZone: 'America/Chicago'` explicitly:
  drop the argument unless the suite deliberately tests script==sheet parity,
  in which case keep it with a `// same-tz:` reason on the line.
- Fix fixtures that write bare-constructor Dates (`new Date(y, m-1, d)`) into
  a date column: build them through `dateAtSheetMidnight_` or as explicit
  instants. Each such failure is a fixture modelling the wrong thing.
- NOT a CI matrix leg with `TZ=UTC`: the suites legitimately assume process
  TZ == script TZ (the `localIso_` helpers), so a UTC leg fails pins for the
  wrong reason. The fake's default is the right lever.

**Enforcement (C2).** `cross-file-pins.test.js`: (1) the fake's default TZ ≠
the shim's script TZ — nobody may set both to the same zone again; (2) any
`timeZone: 'America/Chicago'` in a suite carries a `same-tz:` comment.

**Acceptance.** Suite green; the R46 mutation "helper → script midnight" fires
from `pipeline-build.test.js` with its local `SS_TZ` constant removed (the
default now carries it).

**Size.** M (the fixture sweep). **Deploy.** None.

### 1b. Snapshot before any bulk repair

**Goal.** A repair that rewrites many cells gets a rollback that is not
"Sheets version history on a 32,000-row tab". R46 was recoverable only because
each shifted instant still encoded the true date; the next repair may not be
that lucky.

**Design.**
- `sheetRepairs.js`: `hrBackupBeforeApply_(ss, sheet, label, cellCount)` —
  when `cellCount >= HR_BACKUP_MIN_CELLS_` (500), copy the sheet
  (`sheet.copyTo(backupSs)`) as a tab named `<sheet>|<yyyyMMdd-HHmm>|<label>`
  into ONE standing backup spreadsheet, created on first use via
  `SpreadsheetApp.create` and remembered in the cdr-report Script Property
  `HR_BACKUP_SS_ID` (new Operator State item). Log the backup spreadsheet URL
  + tab name in the apply log with a one-line restore hint.
- Why a separate workbook, not a hidden tab: a DQE copy is ~1.1M cells and
  the CDR Report workbook is already large; three backups in-workbook could
  approach the 10M-cell cap. The backup workbook holds its own cap.
- Prune: keep the newest `HR_BACKUP_KEEP_` (3) tabs per source sheet via
  `deleteSheet` — no Drive scope needed, so no new OAuth consent.
- Wire into the five apply paths: date normalize, slot timestamps, abandoned
  ids, PST shift, duplicate merge. Previews never back up.
- Harness: model `copyTo`, `SpreadsheetApp.create`, `hideSheet` in the fake
  (modelled, not stubbed — the `clearContent` discipline).

**Enforcement (C2).** `sheet-repairs-merge.test.js` (or a new
`sheet-repairs-backup.test.js`): each apply above the threshold calls the
backup exactly ONCE, BEFORE its first `setValues` (order pin); never on
preview; never below the threshold; prune keeps exactly N.

**Acceptance.** Run `previewDqeSlotTimestampRepair()` live (0 cells → no
backup), then any apply over 500 cells → the backup workbook appears with one
dated tab and the log names it.

**Size.** M. **Deploy.** cdr-report. **Operator.** `HR_BACKUP_SS_ID`
self-populates; add as Operator State #59 with the restore procedure.

---

## Batch 2 — dashboard round (one deploy)

### 2a. Escalations: admin delete (owner ask, 2026-09-11)

**Goal.** An admin can delete an escalation that was logged by mistake or for
testing. Managers cannot; a delete is an admin SURFACE, not data breadth, so
the all-departments manager cannot either.

**Design.**
- Server, `Escalations.gs`: `deleteEscalation(req)` — `assertAdmin_()`;
  ONE transaction: `DELETE FROM escalation_activity WHERE escalation_id = ?`
  then `DELETE FROM escalations WHERE id = ?`; commit once; returns
  `{ deleted: 0|1 }` (an unknown id is a no-op, not a throw — idempotent under
  a double click). HARD delete, not `deleted_at`: a soft delete would add a
  predicate to six readers, the badge, the outage snapshot and the digests, to
  preserve rows that by definition have no value.
- Audit that survives the deletion: the activity trail goes with the row, so
  the delete writes a `logReportUsage_('escalations:delete', …)` row (the
  INV-01 append-only carve-out) carrying id, department, status and the
  actor — **never** caller / patient / trx (PHI stays out of the usage sheet)
  — plus a `Logger` line.
- Refresh the E2 outage snapshot (`escSnapshotStore_` from a fresh read) in the
  same call, so a Neon-down read cannot resurrect the row; the badge follows
  the F10 rule (`escLoad_` → `loadEscBadge_`).
- Client, `script-10-escalations.html`: a "Delete…" control on the card's
  action area, rendered only for `USER.role === 'admin'` and carrying
  `data-admin-only` so View-as-Manager hides it. `dsConfirm_` in `danger` tone
  naming the escalation (id, department, occurred date — not the patient), then
  `deleteEscalation({ id })` → toast → `escLoad_()`.

**Enforcement (C2).** `escalations-hardening.test.js`: manager on own dept →
throws; `allDepts` manager → throws; admin → both DELETEs in one transaction,
activity first, one commit; unknown id → `{deleted:0}` without throwing;
the usage row carries no patient field. `drive-admin.js` Escalations stage:
admin build shows the control, manager build does not (rendered visibility),
click opens the confirm and Cancel leaves the card.

**Docs.** INV-01 carve-out list + INV-55 entry gain the admin-gated delete
verb; the CLAUDE.md "Public write paths" bullet gains one clause; new
regression scenario S45 "Admin deletes a mistaken escalation"; Operator State
#24 gets a line.

**Size.** S–M. **Deploy.** dashboard.

### 2b. Notes #2 + #1 — help chip + tour (owner decisions of 2026-09-10)

- Relabel the chip "How is my team doing?"; DROP its last-30-days override so
  it runs over whatever window is set (it defeated the cache and contradicted
  M4's single-date authority); guard rapid clicks with a `launchSeq_` counter.
- Gate the onboarding tour on `ovLoad_` completing instead of the fixed
  1200 ms timer — no artificial delay, no sample pages.
- Client-only. Pins: `html-include-structure` source pins for the label, the
  absent override and the gate; `drive-smoke.js` / `drive-f13.js` for the
  rendered tour trigger. **Size.** S. **Deploy.** dashboard (shared with 2a).

---

## Batch 3 — after-hours capture (note #5), its own PR

Two ADDITIVE DQE columns, `AJ AFTER_HOURS_ANSWERED` + `AK AFTER_HOURS_TTT`,
over `startPST ∈ [15:00, 15:30)` (a hard 5:30 PM CST cutoff); cols A–AI
untouched (the `queue-split.test.js` byte-identical pin extends to A..AI);
the new constant joins the INV-06 cross-file pin; the writer WIDENS the sheet
before touching col 36+ (REP-10); Neon `ADD COLUMN IF NOT EXISTS` + COALESCE
on every upsert; both INV-16 copies. Display surfaces are a later note — this
batch is capture only, because the capture window closes daily.

**Size.** M. **Deploy.** cdr-report + cdr-import (+ the one-time
`backfill` over whatever `Call_Legs_*` tabs survive on deploy day).

---

## Batch 4 — Phase 2 nightly check-and-sort

Full design: [`date-column-normalization-plan.md`](date-column-normalization-plan.md)
Phase 2. Three additions from the 2026-09-11 work:

- **Health page row.** cdr-report's Script Properties are NOT the dashboard's,
  so the nightly outcome cannot travel as a `*_LAST` property. It travels as
  `historicalSort:<sheet>` Pipeline Health rows (the shared workbook), and the
  Health page renders a `historical-sort` row from the latest one per sheet —
  "five sheets clean", or names the sheet that needed sorting, or a TZ-SPLIT.
  A sort that fires every night is a writer regressing; that belongs where the
  operator already looks.
- **The TZ-SPLIT predicate joins the nightly check, memoized per distinct
  instant.** A sheet has ~600 distinct date instants, not 32k rows; the
  per-row form costs ~49 s on DQE alone (measured 2026-09-11) and must not
  run nightly.
- **The bulk path's swallowed sort failures** (`autoImport.js` `console.warn`)
  become Pipeline Health failure rows under the same step name.

**Size.** M–L. **Deploy.** cdr-report + cdr-import + dashboard.

---

## Parallel track — the Neon storage decision (operator)

The free tier has been near its cap twice in a month (89% → reclaim → 84%).
The retention prune and the phones-write gate buy time; the per-call tables
grow with call volume. Decide once: **budget for the paid tier**, or **set
`NEON_RETENTION_*` horizons to what the free tier holds** and accept the
shorter history. Inputs: the per-table size query and the Health page's
retention row (Operator State #57 step 6).

Optional code (S, dashboard): a Health page **"Neon storage by table"** row
running `pg_total_relation_size` per table — one round trip, and the gauge
stops being a surprise. Note the Neon console figure includes history
retention the query cannot see.

---

## Batch 5 — end the timezone split (gated; evaluate first)

The spreadsheet on `America/Mexico_City` and the scripts on `America/Chicago`
have produced four distinct incidents (INV-02 durations, F-8 serials, I2-9
ISO parse, R46 writes), and every new reader or writer must know two rules.
Moving the spreadsheet to Chicago removes the class instead of guarding it.

**Design spike first (no code): the inventory.** Every TZ-dependent site —
`Config.gs::TZ`, the `getSpreadsheetTimeZone()` callers (Data.gs ×5,
NeonRead.gs, Util.gs, MissedCallsReport.gs), `DASHBOARD_WORK_WINDOW` /
`pstToCSTStr` (PST-based, independent of this), INV-02 duration reads (the
phantom +36:36 is an LMT-epoch artifact of the two zones differing; it
disappears when they match, but `getDisplayValues` stays the discipline),
`parseDateForNeon`'s `new Date(s)` fallback, and every `formatDate` with an
explicit zone.

**Migration, if approved.** (1) 1b backups of all five sheets. (2) Change the
spreadsheet setting. Every date cell now DISPLAYS 01:00 of the same day in
summer (Mexico-midnight instants formatted in Chicago) — same calendar day in
both zones, so readers keep working through the window. (3) A generalized
re-anchor (nearest sheet midnight within ±3 h) over the five sheets makes
them whole serials again. (4) Census: CLEAN, no TZ-SPLIT (trivially, one
zone). (5) Duration spot-check: `getValue()` now agrees with the display.

**Gate.** Phase 2 live ≥ 2 weeks with quiet nightly rows, AND 1b shipped.
**Size.** L (spike S). **Deploy.** all three projects + the spreadsheet
setting, in one maintenance window outside the import.

---

## Deferred — Phase 3 binary-search span

Unchanged: needs a sorted-ness stamp every writer maintains plus a B-2-style
tripwire. Revisit only after Batch 5 has held.

---

## Follow-ons (ride along with the batch that touches the file)

- `parseDateForNeon` reads a bare serial ("45726") as the year 45726; the
  census guards it, the resolver does not. → Batch 4 (same file family).
- `IndividualReport.gs` keeps its own `activeDays` beside `daysActive`. →
  next IR change.
- `drive-smoke.js` never clicks the QCD period toggle, so Range renders on
  source pins only. → Batch 2 (dashboard deploy anyway).
- The three REPORT modals (inbound / direct / outbound) have no rendered
  coverage (`DRIVER_MODAL_EXEMPT`). → needs gen-phase3.js fixtures; unbatched.
- The census's per-instant memo (see Batch 4).
- Carried: the qcd-report `delete` leak; `getDeptQueueExts_` reading A–D
  instead of C+D; the all-dept QCD budget being per-run.

## Process note

PRs opened from a commit by hand arrive with the title truncated at 70
characters and the commit body as the description. "Create PR" gets a written
title and description (verification, mutation results, operator steps) and
leaves the merge to the owner.
