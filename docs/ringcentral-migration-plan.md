# RingCentral migration plan (8x8 → RingCentral RingEX)

**Status (2026-11-09):** Step 1 is done: this plan, plus a converter skeleton
(`apps-script/cdr-import/ringCentralAdapter.js`, pinned by
`tests/unit/ringcentral-adapter.test.js`). **The converter is NOT wired into
the import.** Nothing in production reads RingCentral data yet. The next
step needs staged test calls on the RingCentral account (§6), because no
multi-leg RingCentral sample exists yet.

**Why this matters.** Every number in this project comes from one input: 8x8's
per-leg call detail export (the `Call_Legs_*` tabs → Raw Data). About 13 files
read that grid by column POSITION, and their rules depend on 8x8's own
conventions: the leg tree, the `A_Q_` queue names, Pacific timestamps and the
`Missed` / `Abandoned` / `Answered` flags. RingCentral exports none of it in
the same shape.

---

## 1. The approach: convert at the front door

**Convert RingCentral rows into the 8x8 Raw Data layout at the one ingest
point.** That point is `processNewImport` (cdr-import/autoImport.js), right
after `getDisplayValues()` builds `cleanData`. Everything downstream then runs
unchanged. That covers the DQE build (both INV-16 copies), QCD, CSR transfer,
inbound / outbound / direct capture, the transfer + abandoned filters, the
DQE Drill-Down and the Extraction Sidebar, and their test suites.

Rejected alternative: teaching each reader a second format. That means ~13
two-format edits, four hand-mirrored rule sets (CLAUDE.md "third / fourth
duplication") each needing a RingCentral twin, and two formats to keep correct
forever, for a source that will be the only one after cutover.

**8x8 history stays as it is.** Dates before the cutover keep their
8x8-built rows. Nothing is re-derived, and the historical sheets and Neon
tables do not change shape.

---

## 2. RingCentral sources considered

| Source | What it is | Verdict |
|---|---|---|
| Analytics **Users** report (Performance) | One row per user per period with totals ("Total Calls", "Live Talk", ...), plus an aggregate ("Sum") row | **Unusable.** No per-call times, IDs, numbers or queues. Most of the project needs those. |
| Analytics **Call Records** table export | One row per HOP of a call: From/To name + number, Date-Time, Length, Direction, Call Type, Call Response, Result, segment durations, Origin, Call Id, Hop Id | **Primary candidate.** A manual export, like today's 8x8 flow, and no API needed. Open questions in §4. |
| **Call Log API**, Detailed view | Per-call records with legs (extension numbers, leg types, session IDs) | **Automation candidate.** Could remove the manual export. Needs (a) API access on our RingEX tier (ask the account rep), (b) a super-admin-authorized app with the ReadCallLog permission, and (c) a daily pull, since the API keeps ~90 days. |

The owner did not find a "Call Log, Detailed" view in the RingEX admin portal
(2026-11-09). It may need a super-admin role, or the portal layout has
changed. The Call Records table is enough to proceed.

**Timezone:** the export's Date-Time is **Central** (owner, 2026-11-09).
Still to check: does the Analytics timezone setting say "Central Time /
America/Chicago" (follows DST, which is what the converter assumes) or a fixed
"UTC-06:00"? A fixed offset would put every summer time an hour early.

---

## 3. The 8x8 layout the converter must produce

Positions are 0-based and the width is `MAX_COLS` = 44. The converter's
`RC_OUT_COL` is pinned against `IC_COL` and `DQE_C`.

| Col | 8x8 field | Read by | Call Records source | Confidence |
|---|---|---|---|---|
| 0 | Call ID | all | `Call Id` | sample |
| 1 | Leg ID | all; QCD keys on leg `"1"` | `Hop Id` + 1 | **A1** |
| 2 | Start Time (`MM/DD/YYYY HH:MM:SS`, **Pacific**) | all | `Date-Time` − 2 h | sample + owner |
| 3 | Connected Time | inbound / outbound capture | start + Setup + IVR + Forwarding + Ringing, if answered | **A4** |
| 4 | Stop Time | QCD, capture | start + `Length` | sample |
| 5 | Direction (`Incoming` / `Outgoing` / `Internal`) | QCD, capture | `Direction` + `Origin` | **A3** |
| 6 | Talk Time (`H:MM:SS`) | DQE TTT/ATT, QCD, capture | `Live Talk` | sample |
| 7 | Call Time | QCD wait, DQE abandoned wait | `Length` | **A9** |
| 8 / 9 | Caller / Caller Name | all | `From Number` (digits) / `From Name` | sample |
| 10 / 11 | Callee / Callee Name (queue name for a queue leg) | all | `To Number` (digits) / `To Name` | sample; queue hops unseen |
| 13 | Context | calculateMetricsInMemory | — | no equivalent found |
| 14 | Parent Call ID | DQE parentMap, capture's root folding | **must be synthesized** | **A2: open** |
| 15 | Transfer To Call ID | OBX-1, IXT-1 | — | no equivalent found |
| 16 | Dial-in number | Inbound main-line labels, QCD DNIS rows, the Sales IVR stats | `To Number` of the call's first incoming hop | **A10** |
| 22 | Caller ID (holds the QUEUE name on an agent ring leg) | DQE queue attribution, the queue split | **must be synthesized** | **A2: open** |
| 23 / 24 / 25 | Missed / Abandoned / Answered (`-` when not) | all | `Call Response` + `Result` | **A5–A7** |
| 26 | Cause (`Transfer`) | QCD transfers, capture, transfer filter | `Result` = Transferred | **A8** |
| 32 | Callee Hold Duration | capture (hold seconds) | `Hold` | sample (0) |
| 33 / 34 | Callee / Caller disconnected on hold | HOH-0, "hung up on hold" | — | **no equivalent**: flags stay off |
| 35 | SIP Call ID | capture | — | no equivalent |
| 36 | Departments | capture's final-dept label (`getFinalDeptLabels_`) | — | **no equivalent** (§5) |
| 43 | Path (IVR path) | Sales IVR-path stats in CDR Output | — | **no equivalent** (§5) |

What 8x8 has and the converter cannot produce yet:

- **The leg tree (A2).** 8x8 writes a main call (shared Call ID, legs
  1..n: IVR → queue → agent) PLUS, for each agent a queue rang, a separate
  "CallForking" row with its own Call ID, `Parent Call ID` = the main call,
  caller `CallQueue (103)` and the queue's name in col 22. The DQE build's
  per-agent rung / missed / answered counts are built from those fork rows.
  The Call Records table has no Parent Call ID. If every hop of a call shares
  one `Call Id` with an increasing `Hop Id`, the converter can synthesize the
  tree: the main call from the hops, and one fork row per agent ring hop. That
  is the core of Step 2, and it needs a sample with queue rings.

---

## 4. Assumptions to confirm with a sample

Each one is tagged with the same number in `ringCentralAdapter.js`, so a
sample that disproves one points at exactly one place to change.

| # | Assumption | How the test calls settle it |
|---|---|---|
| A1 | Leg ID = Hop Id + 1 (8x8 starts at 1) | multi-hop call: Hop Ids start at 0 and increase |
| A2 | Hops of one call share a `Call Id`, and the tree can be rebuilt from them | queue call rung to 2 agents (§6 call 1) |
| A3 | `Origin` Internal → 8x8 `Internal` | ext-to-ext call (§6 call 8) |
| A4 | Segments run Setup → IVR → Forwarding → Ringing → Live Talk, and Length is their sum | any call with IVR + ring + talk |
| A5 | Answered = Call Response `Answered` / `Connected` | answered inbound + outbound |
| A6 | Missed = an unanswered inbound/internal hop (`Not Answered`, `Missed …`, `Answered elsewhere`, `Abandoned`) | calls 1–3 |
| A7 | Abandoned = Result `Abandoned` | calls 2–3 |
| A8 | Cause `Transfer` = Result `Transferred` | calls 4a/4b |
| A9 | 8x8 Call Time ≈ the hop's `Length` | a queue abandon: compare its Length with the time it waited |
| A10 | Dial-in = the first incoming hop's `To Number` | an outside call to a main line |

Other open questions:

- **Queue-only abandons.** A RingCentral ideas-forum post says Call Records
  does not record an incoming call when no user's device rang. If that holds,
  a caller who hangs up in the queue before any agent rings is MISSING. Those
  calls feed QCD Abandoned, the Missed report's queue-only abandoned section
  (INV-23 sentinels) and the abandon heatmap. §6 call 3 tests it. If they are
  missing, that data has to come from the Call Log API or a queue report.
- **Where a queue's name appears**: To Name on a queue hop, Call Type, or
  nowhere.
- **Extensions.** To/From Number showed a full number, not an extension. The
  roster (`DO NOT EDIT!`) and the direct-call and floater logic use
  extensions. Fallback: a name → extension lookup from the roster or the Users
  report's `Ext` column.
- **Export size limits** on the Call Records table for a full business day.
- **Call Id is text** (`s-a786…`), not 8x8's number. The Neon `call_id`
  columns are already `text`. The DQE AD/AE id columns must not be
  plain-text-formatted as numbers, and `classifyAbandonedCell_`'s
  coerced-number recovery must not misread a text id. Check both in Step 2.

---

## 5. Hard-coded 8x8 names and config

These must have RingCentral equivalents, or be re-mapped, before cutover.

**Cheapest fix of all: ask whoever builds the RingCentral call queues to name
them exactly as in 8x8** (`A_Q_CSR`, `A_Q_Intake`, `Backup CSR`,
`A_Q_Spanish`, ...). Queue recognition is by NAME in many places:

| Where | What |
|---|---|
| `buildDQEHistoricalData.js` (both copies) | the IMP-8 queue regex `(A_Q_[\w&]+\|Backup CSR)`; `DQE_CSR_QUEUES`, `DQE_EARLY_QUEUES` (R49); `DQE_EXCLUDED_AGENTS` (queue / IVR / test pseudo-agents, incl. `8x8 Test Queue`) |
| `inboundCalls.js` | `icIsQueueName_` (`A_Q_` prefix), the IVR names, the `CallRecording` callee (NX-2), `CallQueue (…)` fork callers |
| `autoImport.js` | `calcQcdReport`'s `a_q_csr` / `a_q_intake`; `SALES_QUEUE_NUMBER` + `SALES_PATH_*` (needs col 43 Path) |
| CDR Report workbook | `QCDR Output` col A/B labels; the `csr_team` named range; roster extensions in `DO NOT EDIT!` |
| Dept Config sheet (INV-54) | QCD Queues, Inbound queue aliases, final-dept labels (8x8's Departments column, which has no RingCentral equivalent) |
| Config.gs | `DEPT_QCD_QUEUES` seeds; the `DIAL_IN_LABELS` property (new main-line numbers) |
| DQEdrilldown.js, dataFilters.js, qcdDqeDiagnostic.js, queueSplitSample.js | hand-mirrored rules: they read the converted Raw Data, so they need no edit unless a rule changes |

**Agent names** should be spelled in RingCentral exactly as on the roster
(INV-04 exact match). Paren variants canonicalize (INV-24) and the Orphan Fix
aliases cover the rest, but every mismatch is admin work after cutover.

**Features with no RingCentral source** (decide: rebuild from hops, find
another source, or retire): hung-up-on-hold flags (HOH-0), the final-dept
label (Departments), the Sales IVR-path stats (Path), Transfer To Call ID
(OBX-1 / IXT-1). Each is an owner decision once the sample shows what
RingCentral offers.

---

## 6. Staged test calls (unblocks Step 2)

Create a test call queue with 2–3 users. Note the time of each call, then
export the Call Records table for that day (and the Detailed Call Log too,
if it is found).

1. Call the queue from a cell phone. Agent A lets it ring, agent B answers. *(A1, A2, A6)*
2. Call the queue and hang up while the agents' phones ring. *(A6, A7)*
3. Call the queue and hang up during the greeting / hold music, before any phone rings. *(queue-only abandons)*
4. An agent answers, then transfers to another user: (a) blind, (b) warm. *(A8, Transfer To)*
5. An agent answers, puts the caller on hold, and the caller hangs up. *(hold flags)*
6. An agent calls a cell phone (answered), and calls once with no answer. *(A5, outbound)*
7. Call a user directly and let it go to voicemail. *(Missed with VM)*
8. One user calls another user's extension. *(A3)*
9. If there is an IVR menu: call the main line and pick an option. *(A4, A10)*

---

## 7. Steps

1. **Plan + converter skeleton.** DONE 2026-11-09. Header-driven lookup,
   Central → Pacific, 8x8 cell formats, dispositions A5–A8, dial-in A10, the
   summary row skipped, bad cells reported. Flat rows only.
2. **Tree synthesis + sample parity** (needs §6). Confirm or fix A1–A10.
   Synthesize the main-call / fork structure (col 14, col 22). Add the §6 day
   as a fixture, and assert the DQE build, the inbound capture and QCD give
   the hand-counted answers for each staged call.
3. **Wiring, gated.** `processNewImport` detects the format
   (`rcIsCallRecordsGrid_`) and converts. Behind a cdr-import Script Property
   (registered in propRegistry.js), so 8x8 days keep their path. The import
   refuses a day with converter `problems` rather than writing a partial
   day (the force-path rule, M2).
4. **Config cutover.** Queue names, roster extensions, Dept Config,
   `DIAL_IN_LABELS`, `csr_team`, QCDR Output labels, excluded pseudo-agents.
   Operator State item(s) for each.
5. **Cutover day.** First RingCentral day imported; walk S5 / S7 / S28 / S34 /
   S38 against hand counts; the Health page clean.
6. **Optional: API pull.** Replace the manual export with a scheduled Call
   Log API fetch, if our tier allows it.

### Before wiring (step 3) — checklist
- [ ] A1–A10 each confirmed or corrected by a real export
- [ ] Tree synthesis pinned by a multi-hop fixture through the REAL DQE build
- [ ] Queue-only abandon question answered (and a source chosen if missing)
- [ ] Timezone setting confirmed DST-following
- [ ] Text Call Ids checked against the DQE AD/AE readers
