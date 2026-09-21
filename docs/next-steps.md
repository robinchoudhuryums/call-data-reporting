# Next steps — the sequenced roadmap (as of 2026-09-11; Batches 1–2 SHIPPED the same day)

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
| 1 | **Safety nets** — SHIPPED 2026-09-11 (block 186) | 1a harness runs under the live TZ split · 1b snapshot before any bulk repair | 1a none · 1b cdr-report (DEPLOYED 2026-09-14) | done |
| 2 | **Dashboard round** — SHIPPED 2026-09-11 (block 186) | 2a Escalations: admin delete · 2b notes #2+#1 (help chip + tour) | dashboard (DEPLOYED 2026-09-14) | done |
| 3 | **After-hours capture** (note #5) | two additive DQE cols, own PR | cdr-report + cdr-import | **SHIPPED 2026-09-11** (deploy + backfill: Operator State #60) |
| 4 | **Phase 2 nightly check-and-sort** | + Health page row · + TZ-SPLIT predicate (memoized) · + bulk-path sort failures → Pipeline Health | cdr-report + cdr-import + dashboard | **SHIPPED 2026-09-11** (install + flag: Operator State #61) |
| ∥ | **Neon storage decision** | operator decision; Health row "Neon storage by table" **SHIPPED 2026-09-11** (block 189) | dashboard (DEPLOYED 2026-09-14) | any time |
| 6 | **Owner testing round** — decisions taken, not started | 6a queue worst-first (own dept pinned) · 6b Overview answered volume · 6c Outbound RELEASE not build · 6d agent-day view (90d exact, then degrade) | dashboard | any time; 6a/6b are S |
| 5 | **End the timezone split** (gated) | design spike → migration | all three + the spreadsheet setting | Phase 2 live ≥ 2 weeks AND 1b shipped |
| — | **Phase 3 binary-search span** | deferred | — | after 5 has held |
| — | **Follow-ons** | ride along with whichever batch touches the file | — | — |

**Deploy status (2026-09-14).** All three projects are deployed through commit
005a7b1, so Batches 1–4 and the Neon-storage Health row are LIVE. Two things
are NOT covered by that: **R47** (the workbook cell-space tooling, block 190)
still needs a cdr-report + dashboard push, and the Batch 4 nightly sort check
still needs its one-time **install** from CDR Tools — a deploy ships the code,
the flag and trigger are a separate operator step (Operator State #61), and
Batch 5's two-week gate clock starts at that install, not at the deploy.

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

## Batch 1 — safety nets (SHIPPED 2026-09-11; `.cycle/blocks/186-*`)

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
default now carries it). **As built:** all 1,300 tests passed on the flip with
every explicit Chicago argument removed — no fixture had relied on the two
midnights coinciding; the two tripwires live in `cross-file-pins`.

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
self-populates; Operator State #59 carries the restore procedure. **As built:**
`sheet-repairs-backup.test.js` (8 tests, 5 mutations caught); the fake gained
`copyTo` / `setName` and the shim `SpreadsheetApp.create` + a strict
`openById`.

---

## Batch 2 — dashboard round (SHIPPED 2026-09-11; DEPLOYED 2026-09-14)

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

**Size.** S–M. **Deploy.** dashboard. **As built:** exactly as designed; the
usage row carries department only (not even the id). drive-admin.js walks
open → Cancel → Confirm; drive-smoke.js pins the manager sees no control.

### 2b. Notes #2 + #1 — help chip + tour (owner decisions of 2026-09-10)

- Relabel the chip "How is my team doing?"; DROP its last-30-days override so
  it runs over whatever window is set (it defeated the cache and contradicted
  M4's single-date authority); guard rapid clicks with a `launchSeq_` counter.
- Gate the onboarding tour on `ovLoad_` completing instead of the fixed
  1200 ms timer — no artificial delay, no sample pages.
- Client-only. Pins: `html-include-structure` source pins for the label, the
  absent override and the gate. **Size.** S. **Deploy.** dashboard (shared
  with 2a). **As built:** the chip copies the dept controls' window (the M4
  authority) rather than merely dropping the override; `onOverviewSettled_`
  fires on the first cache paint, success or failure of `ovLoad_`, and the
  tour starts 250 ms after it. No driver clicks a chip or lets the tour
  auto-run (they all set `cdr.tour.done`), so both rest on source pins + the
  manual walk (S23 for the tour; the chip is a Help-modal click).

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

**Status (2026-09-11): SHIPPED**, merged to main in PR #308 (block 187). What landed
beyond the design: AK is integer seconds; NULL-vs-0 is a documented
distinction (nullable Neon ints, `NULLIF` binds, COALESCE upserts); the
duplicate-merge repair clears AI..AK together; every full-width DQE reader's
ceiling is pinned to Config.gs (`cross-file-pins` R8-D1 Batch 3). Operator
State #60 has the deploy verification and the backfill. Display surfaces
remain a later note.

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

**Status (2026-09-11): SHIPPED**, merged to main in PR #308 (block 188). As built: the
engine is `runHistoricalSortCheck_` in `sheetRepairs.js` (flag
`HISTORICAL_SORT_ENABLED`, CDR Tools install/uninstall/preview/run-now); it
reuses the census scan (`hdScanOneSheet_`, now with the per-instant TZ memo
and a `skipFormats` option), sorts only a single-typed out-of-order column,
re-checks, and REFUSES mixed / TZ-split / unparsed columns with a failure row;
it defers while any `*_RESUME` pointer is set. The Health page's
`historical-sort` row reads the latest `historicalSort:<sheet>` row per sheet.
The bulk path's sort failure is a Pipeline Health failure row under the same
name. Two follow-ons rode along: `parseDateForNeon` refuses a bare number
(all ~30 callers), and the smoke driver now clicks the Queue Call Data card's
period toggle. The harness models `Range.sort` since this batch.
**Operator:** install from CDR Tools after the cdr-report push (Operator
State #61); Batch 5's gate clock starts at that install.

---

## Batch 6 — owner testing round (2026-09-14; 6a + 6b DONE, 6c/6d queued)

Four items the owner raised after the R47 trim. Each carries the design
decision already made, so nobody re-opens it. Ordered cheapest-first; they are
independent and can ship separately.

**Status 2026-09-15: all four items are IMPLEMENTED** (blocks
`*-batch6a6b-*` and `*-batch6c6d-*`). All are dashboard-only and need a
dashboard deploy. **6c is code-complete but NOT released** — its last step is
an operator gate (`runOutboundVettingCheck` must come back CLEAN) and that
cannot be done from a dev session; the runbook is now Operator State #63.

### 6a. Queue report: worst-first in the app, own dept still pinned — DONE

**Owner decision (2026-09-14) — this REVERSES a prior ruling.** The
`QueueReportEmail.gs` header states "Worst-first ordering is EMAIL-ONLY (the
web report keeps its viewer-float + parent-grouping order; owner ruling)".
The owner has now chosen worst-first in the app too, with the viewer float
KEPT: **own dept pinned first, every other section below it worst-first.**
Update that header comment in the same commit — a stale ruling is worse than
no ruling.

- "Worst" copies the email's comparator exactly: section abandoned % DESC,
  tie-broken by range violations DESC (`QueueReportEmail.gs:700-703`). A
  section = parent + its nested children, summed by `secTotals`.
- Implement CLIENT-side in `qcdAllDeptRender_`
  (`script-11-qcd-boot.html:553-560`), replacing the viewer-float comparator
  with float-then-worst. Server order stays alphabetical, so **no `qcdAll:v6`
  cache bump** — the order is not baked into the payload if the client does
  the sorting. (Moving it server-side WOULD need v7, and would also make the
  email's own sort dead code; don't.)
- **Reconcile the CSV** (`script-11-qcd-boot.html:812-821`): it rebuilds from
  `data.depts` and today ignores the float, so screen and CSV already differ.
  Bring it to the same order.
- Rows WITHIN a section stay in configured queue order, both sides. Don't sort
  them.
- Ride-along worth fixing while in there: the email's alert/preheader offender
  list sorts violations-then-pct (`QueueReportEmail.gs:603`), the REVERSE
  priority of its own table. One of the two is wrong; make them agree.
- Pins: `queue-report.test.js:194` pins the email's worst-first; add the app's.

**Size.** S. **Deploy.** dashboard.

### 6b. Overview chart: answered call volume — DONE

**Owner decision: plain per-dept counts overlay**, consistent with the
existing `abandonedCalls` metric. The busiest queue dominating is the true
picture, not a defect.

The work is small because the number is already computed: `ovDeptChartSeries_`
(`CompanyOverview.gs:163`) reads a per-day `{rung, answered}` map and emits
only the RATE. Four pieces: one series line in that shared builder (feeds the
90-day chart AND the YTD fetch), one payload field beside
`trendChartAbandoned`, one `OV_CHART_METRICS_` entry
(`script-3-overview.html:1422`), one tab button (`dashboard.html:235-239`).

**Cache:** bump `companyOverview:v21` → v22 (INV-30) — the payload shape
changes and the 6 h TTL makes a stale blob sticky.

**Size.** S. **Deploy.** dashboard.

### 6c. Outbound report — RELEASE, not build — CODE DONE, RELEASE PENDING

The report is fully shipped (server, client, sheet fallback, tests, vetting
instrument) and **admin-only behind a hard-coded gate** with the menu item
hidden. Of the original five phases, only **phase 4, the manager un-gate, was
never done**. So "enhancing Outbound" is a release runbook:

1. `backfillOutboundCalls` (recommended first).
2. `runOutboundVettingCheck` — live two-path parity of the abandon population
   vs the Inbound report + per-sample verdict re-verification.
3. On a CLEAN `ok parity` only: remove the admin throw
   (`OutboundReport.gs:85-86`) and un-hide `#outbound-report-btn`
   (`dashboard.html:89-91`). **Never un-gate on INCONCLUSIVE / FAILED /
   MISMATCH** — a zero-abandon window is inconclusive by construction.
4. Add the ci:ui driver visit + a regression scenario in the same change.

~~**This runbook currently lives only in `.cycle/STATE.md`**~~ **DONE: it is
Operator State #63**, with the verdict contract spelled out (INCONCLUSIVE is
not a pass) and the two-file release named as one commit.
**Also done (2026-09-15), so the release is a flag flip over tested ground:**
the gate is a named switch `OUTBOUND_VETTING_GATE_` whose two halves
cross-file-pins keeps together; the latent per-dept manager path is now
BEHAVIOURALLY pinned with the switch flipped (it had been unreachable dead
code since it was written); and the modal joined `drive-admin.js`, so it is
rendered-gate covered BEFORE the release rather than after.

**Do NOT revive:** per-dept company cards for Outbound were considered,
deferred, then RULED OUT (crossover agents hold multiple roster homes); the
rejection is a contract in three places incl. the render site. Needs a fresh
ruling.
**Per-dept CALLBACK table — PLANNED, not built.** A different question from
per-dept AGENT cards: an abandoned call has an unambiguous dept (its entry
queue), a crossover agent does not, so the ruling above does not reach it.
The owner approved planning it on 2026-09-15 — full design in
[`docs/outbound-callback-dept-plan.md`](outbound-callback-dept-plan.md),
together with the OUTBOUND ANSWER-QUALITY work it depends on.
**Do the answer-quality half first -- but it is BLOCKED as of 2026-09-18,
not merely queued.** Both probes ran live and both returned INCONCLUSIVE, for
two different reasons recorded in full under "Step 1 RESULTS" in
[`docs/outbound-callback-dept-plan.md`](outbound-callback-dept-plan.md):
(1) `probeOutboundAnswerQuality` missed the 8% share gate at 7.7% on a real
31 s timeout (ratio 9.16), and the mass is MULTI-MODAL across 20-32 s (~22%
of connects in total), so **no re-run clears it -- it needs a band-summing
probe rather than a one-peak one**; the min-talk half DID measure at 20 s.
(2) `probeOutboundInstantConnects` could not verdict at all -- zero usable
external legs in 600 sampled rows. **FIXED 2026-09-18, and the fix came with
the answer.** `probeOutboundJourneyShape()` measured the cause and overturned
the P-11/CNAM hypothesis: no masked name shape is present at ALL
(`extNumber: 0`, `extCaller: 0`, `initials: 0`), because `icBuildJourney_`
names from CALLEE_NAME, which an outbound dial leaves blank, so every
external leg is named by an ERA-dependent rule: masked initials since P-11
(2026-09-17), `(unknown)` before it. `obInstantDerivedRing_` prefers the
masked leg and keeps the first-`unknown` rule as the pre-P-11 fallback -- the
one-arm version read the wrong leg on post-P-11 rows and flipped the verdict
for a day. CONFIRMED `carrier-instant` on the 2026-09-21 run: the masked
marker reads a median 1 s at a **0%** real-ring share on the instant group
against 27 s at 100% on the rung control, so **the instant connects are
genuine and the classifier must exclude and disclose them**. That also means
the talk-profile hypothesis was right and the derived ring does NOT overrule
it. Only the band-gate half of (1) still
blocks the parameter work below. `connected` counts a voicemail pickup
as a reached caller (the far end genuinely answers, so every condition the
flag tests is met), which the six-point round promoted into the "Actually
reached" tile. A single scope-level rate carries that over-count as a
constant; a dept COMPARISON turns it into a ranking that is wrong by
different amounts per dept. **Owner rulings 2026-09-15 (all three closed), plus the OPERATING MODEL that
settles the design:** rank by called-back; sub-queues follow
`queuesForDept_`; separate by the dept's agents. The clarification that made
the third one buildable -- **depts are RESPONSIBLE for their own callbacks,
and an agent from another dept who takes the customer's call EMAILS the
owning dept to make it** -- means the own-dept rate is a strict subset of its
own denominator, so the ">100% is not a rate" objection an earlier draft
raised is WITHDRAWN. Row shape is own / another dept / not called back
(summing to trackable abandons), ranked on the own-dept column; the full
per-dialing-dept matrix is a row EXPAND, since the operating model predicts
the off-diagonal is rare and therefore a SIGNAL (a skipped handoff, or a
queue mapped to the wrong dept). Ranked on the own-dept column (confirmed), and
**time-to-callback is measured from the ABANDON by ruling** -- the customer's
clock, where internal handoff time counts as part of the company's response
rather than an exemption from it. Do not try to net the handoff out.

~~**Observed gap, uncommitted:** Outbound has CSV but no `sendOutboundReportEmail`~~
**SHIPPED 2026-09-15** in the owner's six-point round (block 193), along with
four data cuts: the connected-callback rate promoted to a tile, the
time-to-callback distribution, the unconnected ring split, and callback rate
by abandon hour. `outboundReport:v2` -> `v3`. **Point 1 of that list ("release
it") is the operator gate above and is still pending**; the per-dept CALLBACK
table raised alongside it is parked awaiting an owner ruling (see below).

**Size.** S (code) + operator vetting. **Deploy.** dashboard.

### 6d. Agent-day interaction view ("what did agent X do on day Y") — DONE

**The 14-day assumption is WRONG and should not shape the design.** 14 days is
the `Call_Legs_*` day-sheet prune — the REBUILD horizon (Operator State #43),
not the read horizon. Per-call rows are captured out of Raw Data daily into
Neon tables that nothing prunes for 400 days.

**Owner decision (2026-09-14): 90 days exact, then degrade. No capture-column
schema change.** Accepted cost: past 90 days the view shows who the call RANG
FIRST rather than every agent who touched it, and that window can never be
recovered later.

Three tiers, disclose the boundary the way the codebase already does
(`meta.coverageStart` + `coverageNoteUpsert_`, and the
`before-capture`/`date-gap`/`not-captured` reason codes):

| Horizon | Source | Fidelity |
|---|---|---|
| 0–90 days | `inbound_calls.journey` + `outbound_calls` | full leg-by-leg, every agent who touched the call |
| 90–400 days | same rows, `journey` NULLed by the prune | scalars + `first_agent`; outbound stays exact (`agent_name` is a real column) |
| 400 days – 13 months | DQE `K-AC` / `AF` slot timestamps | MISSED rings only |

- **Backbone:** `outbound_calls` (easy half — `agent_name`/`agent_ext` are
  first-class columns) + `inbound_calls` (hard half — no `answered_by`; the
  agent set lives in `journey`). Query one day at a time on the
  `(call_date, …)` PK, one `json_agg` round trip per section.
- **Reuse is high:** `callerLookupShapeCall_` / `...Outbound_` are
  hash-agnostic row shapers, and the `cl*` card renderers
  (`script-10-escalations.html:1322-1500`) are already reused by the dept
  call-path overlay. `getCallJourney` is the row-level drill.
  **Closest precedent is not Caller Lookup but `AgentHome.gs::ahWaitJoin_`**,
  which already matches journey legs by agent name for a window.
- **Auth:** resolve the agent to a dept SERVER-side from the roster
  (`buildDeptsByAgent_`), then run the existing dept gate. Never trust a
  client dept. Use the ROSTER dept, never `outbound_calls.department` (the
  raw CDR org label matches no dashboard header here). Crossover agents have
  two homes — a manager sees the agent only if on THEIR roster; unrostered
  names stay admin-only. This surface exposes ANSWERED calls, which the
  existing `callIdInDeptMissedReport_` entitlement does not cover, so it needs
  its own server-derived gate rather than reusing that one.
- **PHI:** never store/log/cache/return a raw number (hash in memory, bind as
  a param, responses NOT cached — the Caller Lookup model); phone-shaped names
  are already dropped at capture; `ib_list_*`/`ob_list_*` external names are
  initials-only for post-IMP-12 dates and RAW before, so don't render them
  unmasked; cache keys hash the agent name (INV-36); log
  `logReportUsage_` + a LABELLED `neonNoteEgress_`.
- Day header totals come from `direct_call_history` / `call_history_dept`
  (agent-day aggregates, unpruned, always reconcile) — never as the per-call
  list.

**Size.** L. **Deploy.** dashboard.
**SHIPPED 2026-09-15** as `AgentDay.gs` + the `#/report/agent-day` modal (client
beside the `cl*` renderers in script-10). Built as designed above, with two
deliberate departures worth knowing: the day HEADER reads the DQE agent-day row
through the DAL rather than `direct_call_history` / `call_history_dept` — same
"an aggregate that does not degrade" intent, and it additionally reconciles
with My Department by construction; and the tier is decided by WHAT CAME BACK
rather than by the calendar, since the prune is flag-gated and tunable. Full
design notes now live in `docs/per-call-capture.md`; walk S47.

## Parallel track — the Neon storage decision (operator)

The free tier has been near its cap twice in a month (89% → reclaim → 84%).
The retention prune and the phones-write gate buy time; the per-call tables
grow with call volume. Decide once: **budget for the paid tier**, or **set
`NEON_RETENTION_*` horizons to what the free tier holds** and accept the
shorter history. Inputs: the per-table size query and the Health page's
retention row (Operator State #57 step 6).

~~Optional code (S, dashboard): a Health page **"Neon storage by table"** row
running `pg_total_relation_size` per table — one round trip, and the gauge
stops being a surprise.~~ **SHIPPED 2026-09-11 (block 189):** the `neon-storage`
row (`neonStorageByTable_` + the pure `neonStorageVerdict_`, NeonRetention.gs)
reads `pg_database_size` + every public table's total size in one round trip
on the Health page's shared connection, names the top 5, and is informational
until `NEON_STORAGE_CAP_MB` is set (warn at 80%). The hint carries the two
readings the operator needs: the Neon console figure includes history
retention the query cannot see (a FLOOR), and a DELETE never moves it (disk
returns only on TRUNCATE / VACUUM FULL). Operator State #57 (d). **Deploy:**
dashboard. The DECISION itself is still the operator's.

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

- ~~`parseDateForNeon` reads a bare serial ("45726") as the year 45726; the
  census guards it, the resolver does not.~~ DONE in Batch 4 (the resolver
  refuses it; the census's own guard is gone).
- `IndividualReport.gs` keeps its own `activeDays` beside `daysActive`. →
  next IR change.
- ~~`drive-smoke.js` never clicks the QCD period toggle, so Range renders on
  source pins only.~~ DONE with Batch 4 (four rendered checks per role).
- The three REPORT modals (inbound / direct / outbound) have no rendered
  coverage (`DRIVER_MODAL_EXEMPT`). → needs gen-phase3.js fixtures; unbatched.
- ~~The census's per-instant memo.~~ DONE in Batch 4 (`hdScanOneSheet_`).
- Carried: the qcd-report `delete` leak; `getDeptQueueExts_` reading A–D
  instead of C+D; the all-dept QCD budget being per-run.
- ~~`obInstantDerivedRing_` is mis-keyed (2026-09-18, BLOCKS Part 2).~~ FIXED
  2026-09-18 by measurement, not by the guessed cause: no masked name shape
  exists in the blobs at all, because `icBuildJourney_` names from CALLEE_NAME
  and an outbound dial leaves it blank. The reader now falls back to the first
  `unknown`-CLASS event, validated on the rung answer key. Operator State #65
  carries the run and the `carrier-instant` reading.
- **Overview trend chart: the Company line is % ONLY (2026-09-18).** Delivered
  for `pct` and `abandonedPct`; the two COUNT metrics deliberately have no
  `companyField`, because a company "answered calls" line just restates the
  visual sum of the dept lines. If one is ever wanted anyway, the server side
  is already there (`ovDeptChartSeries_` over the company daily maps) -- it is
  a registry entry plus the count-unit tooltip formatting.
- **The Company line is ADMIN-ONLY (INV-39), by owner-ruled precedent, not by
  request.** The ask did not say who should see it, and every other
  company-aggregate surface is admin-only, so it inherited that. Widening it
  to managers is one line in each of the two payloads (stop nesting it under
  `companyAggregate`; drop the `ovStripChartTrend_` gate) plus flipping the
  `drive-smoke.js` manager assertion -- but it is a data-visibility decision,
  so it needs an owner ruling first.
- **The journey does not carry the external leg's identity (2026-09-18).** The
  capture stores `t / name / kind / secs / talk / hold` and not DIRECTION or
  CALLEE, so the reader recovers the leg by proxy. Labelling a CALLEE-external
  leg `(external number)` when it has no CNAM would retire the proxy, but it
  is a WRITER change in a function INBOUND shares (the call-path drill and
  Caller Lookup render its journeys) and is forward-only, so history keeps the
  fallback regardless. → deliberate, with its own regression walk; unbatched.
- **The answer-quality probe needs a BAND gate, not a peak gate (2026-09-18).**
  Voicemail pickup here is multi-modal (21 / 26-27 / 30-31 s), so the 8%
  single-peak share gate refuses a real signal; the 20-32 s band is ~22% of
  connects. Keep the floor + bimodality gates. → same change as above;
  measurements in the plan's "Step 1 RESULTS".
- Escalations Phase 2's EXTERNAL WRITER is designed, unbuilt (H3, 2026-09):
  the review queue, the INSERT contract and the pending-review ping exist on
  this side; team-tools has no Neon connection and no writer. Building it is
  a team-tools change (its first PHI write outside its own stores + a Neon
  dependency + the `external_request` scope) -- an owner decision, not a
  ride-along. Until then `pending_review` rows come only from a hand INSERT.

## Process note

PRs opened from a commit by hand arrive with the title truncated at 70
characters and the commit body as the description. "Create PR" gets a written
title and description (verification, mutation results, operator steps) and
leaves the merge to the owner.
