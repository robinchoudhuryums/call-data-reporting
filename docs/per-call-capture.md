# Per-call capture — inbound, outbound, direct and journeys

The F8c split of CLAUDE.md's Common Gotchas. Thirteen bullets describing ONE
subsystem moved here: the Neon per-call tables (`inbound_calls`,
`outbound_calls`, `direct_call_history`), the reports over them, the call-path
journey drill, Caller Lookup, the abandon heatmap, and the CSR transfer detail.
They are grouped rather than kept in CLAUDE.md because none of them bites work
outside this subsystem — the three that DO stayed behind, in the index bullet
that points here.

**This file is authoritative; the CLAUDE.md index is a finding aid.** Open the
entry before you rely on it — a summary cannot carry the exceptions.
`tests/unit/claude-md-split.test.js` fails the build if a heading here has no
index entry, or an index entry no heading.

Writers: `cdr-import/inboundCalls.js`, `cdr-import/outboundCalls.js`,
`cdr-import/directCallMetrics.js`, `cdr-report/inboundCallsExport.js`,
`cdr-report/outboundCallsExport.js`, `cdr-report/insuranceNumbers.js`.
Readers: `InboundReport.gs`, `OutboundReport.gs`, `DirectCallReport.gs`,
`CallerLookup.gs`, and `Data.gs::computeCsrTransferRange_`.

### Inbound-call capture

**Inbound-call capture is Neon-only and rides the daily import.**
`cdr-import/inboundCalls.js::writeInboundCallsToNeon` runs at the end of
`processIntegratedHistory`, building ONE record per distinct inbound call
from Raw Data (caller HMAC hash via `cdrHashPhone_` -- null for Anonymous;
dial-in line; disposition + abandon stage; abandoned-on-hold + hold/wait
seconds; queue journey) and upserting to Neon `inbound_calls`
(`ON CONFLICT (call_date, call_id) DO UPDATE` -- re-imports refresh). Each
record carries `call_start` ('HH:MM:SS' in raw PST -- clients shift +2h to
CST via `clCstTime_`, the INV-18 convention) and `journey` (a JSON text
column: the ordered leg-by-leg path, capped at `IC_JOURNEY_MAX_EVENTS`=40;
callee names that look like phone numbers are MASKED so no raw number lands
in Neon). Timelines append a synthetic "Call ended" row at last-leg
start+duration so a long abandoned wait doesn't read as an early
disconnect. The writer's idempotent `ALTER TABLE ... ADD COLUMN
IF NOT EXISTS` upgrades pre-extension tables in place, and the insert chunks SIZE-AWARE via
`icChunkTuplesByChars_` (30K/statement; journey rows vary ~0.2-6KB and a
fixed row count overran the JDBC cap). **There is NO sheet primary for this data** -- the
"Inbound Calls" tab (`cdr-report/inboundCallsExport.js::exportInboundCalls`)
is a fallback COPY of Neon, not a source. History: editor-run `backfillInboundCalls`
(cdr-import) reaches at most the ~14-day `Call_Legs_*` retention window.
**Queue-name recognition is config-fed AND brand-prefix aware (F1/F1b) -- do
NOT re-hardcode it.** `icIsQueueName_` decides what counts as a queue leg and
feeds `entry_queue` / `final_queue` / `num_queues` / `abandon_stage`. A name
it fails to recognize yields `entry_queue = NULL`, which makes the call
attributable to NO dept (`inboundDeptPredicate_` matches on `entry_queue`) --
invisible in every dept's Inbound report and heatmap, AND invisible to the
panels that would report it (the blindness is self-concealing; F1 has the
mechanism). Two sources feed it, and the pattern arm alone still matches
(strictly additive): (1) the PATTERN -- `A_Q_` at string start **or after an
underscore** (the `_` alternative is F1b -- do NOT re-anchor it), plus an
exact `Backup CSR` -- keep that arm
EXACT, since widening it the way the DQE regex does would make "Jane Backup
CSR" a queue (IMP-1 pins it false); (2) the `Dept Config` SHEET via
`icLoadConfiguredQueueNames_` (QCD Queues + Inbound Queue Aliases, incl. the
RAW side of a `raw=canonical` pair), so a new queue is an admin edit rather
than a code change. Digit-only tokens are rejected (extensions, not queue
names); inactive rows contribute nothing. Both writers load the set BEFORE
the record builder, and one `icResetConfigMemos_()` clears every Dept-Config
memo (the row cache feeds both the F1 set and the canonical-name map, so
clearing one alone serves a stale read). `buildInboundCallRecords_` stays
PURE -- `IC_KNOWN_QUEUE_NAMES_` is a module global, `null` = pattern-only.
**⚠ The DQE and INBOUND recognizers diverge ON PURPOSE -- do not "harmonize"
them.** The DQE regex (`(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)`, IMP-8)
deliberately does NOT capture a brand-prefixed token, because an INV-23
sentinel name must START with `A_Q_`. The inbound capture MUST capture it
verbatim, because `entry_queue` is matched by EXACT name against the Dept
Config lists. Widening DQE gives you phantom `A_Q_Main` sentinels;
re-anchoring inbound makes brand-prefixed queues invisible again. Two
subsystems, two rules. **Diagnosing a suspected miss:** `entry_queue IS NULL`
is NOT by itself a signal -- see Operator State #38 for the runbook.

### Internal-transfer journey enrichment (R11-N)

**Internal-transfer journey enrichment (R11-N) -- inbound capture.**
When an agent answers an inbound call and transfers the caller to a queue
where they then abandon, `buildInboundCallRecords_` cross-references that
internal leg group to the answering agent's concurrent captured inbound call
and, ONLY on a UNIQUE match, APPENDS one
synthetic `{kind:queue, abandoned:true, transfer:true}` event to that call's
journey. Strictly JOURNEY-ONLY (disposition/counts/queues NEVER touched);
an ambiguous match is left as-is -- it never guesses. Idempotent on
re-import; no widening is warranted (R11-N5). **Round-17 (owner) REVERSED
the Round-16 drop: a matched internal group is ALSO written as its own
record**, linked by `related_call_id` and PREFIXED with the reconstructed
origin hop (origin queue -> answering agent, events flagged
`origin:true`/`transfer:true`, rendered "before transfer"). The abandon
belongs to the RECEIVING dept, whose Missed report renders a path button
off the DQE queue-only sentinel (wait > 60s, no internal/external
distinction) -- dropping the record made that button resolve
`not-captured`, so the better the matcher worked the more reliably that
dept's drill failed. Still metric-safe (every metric query excludes
is_internal). **Round-17b: an internal-origin record also carries
`origin_agent` / `origin_dept`** (the employee who PLACED it + the raw CDR
org label, read from the CALLER columns of the earliest QUEUE leg -- see
the shared-leg-tree bullet below for why that leg and not `legs[0]`;
`firstAgent` derives from the CALLEE name, which on these groups is the
queue, so it is null). Without it the receiving dept's drill said only "an
internal call abandoned in your queue"; with it the manager sees the
abandon was a colleague's assist request, not a lost customer. NULL on
every externally-originated row; phone-shaped caller names are never
stored (the firstAgent PHI guard). **Step 4 (owner ruling) links the assist
to the requester's concurrent OUTBOUND call** -- `related_call_kind`
('inbound' | 'outbound'; NULL reads as inbound) says which table
`related_call_id` points at, and `getCallJourney({kind:'outbound'})` serves
it. That is the first surface where one dept sees another dept's customer
call, so access is a SERVER-RE-DERIVED capability, never the client's claim:
a manager reaches outbound call O only if an internal record links to it AND
that record passes the unchanged F-4 gate on their own dept. Full ruling +
what is disclosed: docs/known-issues.md. Editor diagnostics
`previewInternalTransferPaths` / `previewInternalTransferChains` scope it
(CDR Tools menu / `TRANSFER_PREVIEW_DATE` property; R11-N4), and
`previewOutboundAssistLinks` validates the Step-4 link by running the REAL
record builder over a Call_Legs sheet (never a parallel implementation --
the chain diagnostic's hand-written rule is what once "resolved" a
temporally impossible chain). Pinned by
`tests/unit/inbound-calls.test.js`.

### A CDR root is a leg tree

**A CDR root is a leg TREE, not a call -- scope every internal-origin
derivation to the ORIGINATOR.** A warm transfer puts two people's legs under
one root (owner's 2026-08-21 sample: Margie's leg into `A_Q_FieldOps` and
Marie's Outgoing leg to the customer share root `1783983008517`). Three
rules in `buildInboundCallRecords_`, all internal-origin-ONLY -- external
inbound records are unchanged, since every leg there descends from the one
incoming caller: (1) **`answered` counts only talk legs that pass
`icLegFromOriginator_`** (caller EXT or caller NAME matches the requester --
the name arm is what recognizes the queue-fronted delivery leg, whose CALLER
renders `CallQueue (144)`; an external Outgoing leg never qualifies, since
the party answering an internal queue call is always an internal extension).
A sibling's customer leg used to mark a genuinely-abandoned assist
`answered`, shrinking the one population the path drill serves. (2) The
abandon leg **PREFERS** an originator leg but falls back to any, so a
fan-out leg carrying the flag can never cost an abandon (`abandonLeg` is
only consulted when nothing answered, which makes the fallback safe).
(3) The requester -- `origin_agent` / `origin_dept` and the ext the
related-call match keys on -- comes from the **earliest QUEUE leg, not
`legs[0]`**: a colleague's leg can start first. TIMING fields
(`call_start` / `call_date` / `wait_seconds`) still key on `legs[0]` by
design; this changes identity, not the record's clock. **The same root is
ALSO captured in `outbound_calls`** -- its gate is no-Incoming + an answered
external Outgoing leg, which a merged tree satisfies -- so one id can name a
row in both tables and the Outbound report counts that leg as the answering
agent's activity. `previewOutboundAssistLinks` counts the overlap and the
drill's abandon population on every run rather than leaving it to be
eyeballed (measured 2026-08-24: 6 of 28 outbound links, all in the answered
noise, none among the 12 abandons). Pinned by
`tests/unit/inbound-calls.test.js`.

### Caller Lookup

**Caller Lookup** (`CallerLookup.gs`, route `#/admin/caller-lookup`,
admin-only) is the FULL communication history: the entered number is
normalized to `+<digits>`, HMAC-hashed with the dashboard's `HMAC_SECRET`
(must match cdr-import's -- cross-project hash parity pinned by
`tests/unit/caller-lookup.test.js`), bound as a prepared-statement param, and
NEVER stored/logged/cached. The same candidate hashes query
`inbound_calls.caller_hash`, `outbound_calls.callee_hash` (per-call outbound,
see the outbound bullet) and `call_history_phones.phone_hash` (day-level
aggregates, rendered as "Earlier outbound activity" ONLY for dates the
per-call capture doesn't cover -- day-level is the ceiling there). Each
section is independently best-effort: a missing `outbound_calls` table
flags `meta.outboundAvailable=false`; the inbound results stand.
**Neon-down degrades to the SHEET FALLBACK** (`callerLookupSheetFallback_`):
both export tabs carry the hash the lookup keys on (`Inbound Calls` col 4,
`Outbound Calls` col 3), so the per-call history reconstructs from the
sheets with no raw number stored anywhere, shaped by the same
`callerLookupShapeCall_`/`...Outbound_`. The day-level "Earlier outbound
activity" has NO sheet primary and reports `historyAvailable:false`.

### Per-call journey drill-through

**Per-call journey drill-through (inbound capture).**
`InboundReport.gs::getCallJourney({callId, date, department})` returns ONE
call's journey for the "↳ path" affordance on abandoned rings in the Missed
views. **INTERNAL-ORIGIN queue calls (an
employee dials another dept's queue; no Incoming leg) are captured as
`is_internal` rows for THIS drill only** -- every metric query excludes
them (pinned both ways); since Round-17 a uniquely-matched R11-N transfer
group is BOTH enriched onto the caller's journey AND written as its own
origin-prefixed record, and a standalone internal record carries
`related_call_id` when uniquely nested in the originator's concurrent
answered inbound call (the path drill links the two). Unlike the full Inbound report it is
manager-reachable for the manager's OWN dept: managers are pinned to their
dept AND the query is scoped by `inboundDeptPredicate_`. **The entitlement is
enforced SERVER-side (F-4):** the exact-`(call_date, call_id)` fallback --
needed because `inbound_calls` stores RAW queue names that can miss the
scoped predicate -- is gated for managers by `callIdInDeptMissedReport_`,
which requires the id to appear as an abandoned parent id in that manager's
OWN dept's Missed report for the date (admins ungated; fail-closed on error).
A miss carries a `reason` (`before-capture` -- with `minDate` -- / `date-gap`
/ `not-captured`, R7/M-2) probed only when the unscoped lookup was entitled
to run, so a gate-closed manager learns nothing. **Neon-down degrades to
the `Inbound Calls` tab (cols 18-22, journey/origin/related --
`inboundCallJourneySheetFallback_`)**: same shaper, BOTH auth arms
re-derived (the F-4 gate reads the DQE sheet, so it survives the outage),
disclosed via `fallbackSource`/`fallbackThrough` + an overlay caption, a
`fallback-gap` reason for dates past the copy's ceiling; journey cells
are only exported within `INBOUND_EXPORT_JOURNEY_DAYS` (=90, Op State
#49), older dates render the summary; the OUTBOUND arm falls back to the
`Outbound Calls` tab (Op State #50) with its two-arm entitlement
RE-DERIVED from the Inbound tab's related-call columns, never trusted.
Pinned by
journey-fallback.test.js. The journey carries no
caller identity; the client reuses the Caller Lookup renderers
(`clChainHtml_` / `clJourneyRowHtml_`) in a `#call-journey-overlay`.

### Insurer labels and the Inbound report gate

**Insurer labels, and the Inbound report's TEMPORARY admin-only gate.**
Insurer labels come from `insurance_numbers`, synced by the editor-run
`syncInsuranceNumbersToNeon` (`cdr-report/insuranceNumbers.js`) from the
insurance block in `DO NOT EDIT!` cols X-AG. Re-run it after editing that
block or new numbers stay unlabeled in the Inbound report
(`InboundReport.gs`, route `#/report/inbound`), which reads Neon directly and
renders an "unavailable" state -- intentionally NOT cached -- when Neon is
unreachable. `getInboundInsurerDaily` binds the insurer label as a
prepared-statement parameter; it is admin-entered free text, never inline it
into SQL. The report is **TEMPORARILY admin-only** while vetted; the per-dept
manager path is kept intact in `inboundResolveRequest_`, so restoring manager
access is a one-line gate removal + un-hiding the `data-admin-only` tab.
**Vetting tool: `runInboundQcdParityCheck`** (editor-run, admin-gated,
read-only; `INBOUND_QCD_PARITY_FROM/_TO/_DEPT` props) joins the two lenses
per dept/day and lists the window's UNATTRIBUTED raw entry-queues (fix: the
Dept Config "Inbound queue aliases" column; inbound-qcd-parity.test.js).
Run it, populate aliases, re-run -- BEFORE any un-gating decision.

### QCD vs inbound abandons

**⚠ The QCD-vs-inbound abandon gap is SETTLED -- read `docs/known-issues.md`
"QCD Abandoned vs inbound_calls abandons" before re-investigating** -- the
eliminated explanations all look plausible again from a standing start, and
the measurements behind the three LIVE RULES live there:
(1) **QCD's Abandoned applies a minimum QUEUE-WAIT threshold and the inbound
capture applies NONE.** Inbound answers "did this
caller hang up without reaching a human?", QCD answers "did this caller wait
past the threshold and give up?". Both are correct; they are several-fold
apart and must never be shown side by side without saying so -- that caption
is the prerequisite for un-gating.
(2) **`wait_seconds` is WHOLE-CALL elapsed time from IVR pickup
(`abandonLeg.stop - firstLeg.start`), NOT queue wait.** The IVR runs on
nearly every call here, so a near-instant queue abandon still stores tens of
seconds. Never
compare it to a queue threshold or read it as "time waiting for an agent";
the per-leg `secs` inside `journey` is where a real queue wait is derivable.
It feeds the heatmap cell drill's "wait/hold" label, which is misleading for
the same reason (open follow-on).
(3) **QCD is work-window-scoped and the inbound capture is NOT.**
`buildInboundCallRecords_` captures around the clock while QCD's Abandoned
counts only 6:30 AM-3:00 PM PST, so any comparison must scope the inbound
side to `INBOUND_WORK_WINDOW_PST` (Config.gs -- the THIRD copy of the window,
INV-06 sync obligation; text `HH:MM:SS` in raw PST so it compares to
`call_start` with no conversion, NULL `call_start` counting as in-window).
**Out-of-window calls are RESEARCH data, never a dept metric (owner
ruling)** -- report them separately, never in a dept total. Scoped surfaces:
`compareInboundVsQcdAbandons_`, the whole `computeInboundReport_` payload
(`inbound:v10`), and `getInboundInsurerDaily` (so the drill reconciles with
the byInsurer row it hangs off). Two deliberate NON-scopings: `coverageStart`
(answers "when did capture begin", not a dept metric) and **the abandon
HEATMAP, already bounded by its own 8 AM-5 PM CST band -- the INV-18
convention, 30 min wider at the start on purpose. Do NOT add the work-window
clause on top of it.** `tests/unit/inbound-window-scope.test.js` pins both
exemptions plus a count-based guard that every `FROM inbound_calls c`
sub-select carries the window.

### Dept attribution contract

**Dept attribution contract (inbound capture):** a call belongs to the
dept whose effective queue list (`queuesForDept_`, same map as QCD) contains
its ENTRY queue -- one call = one dept; overflow stays with the entry
queue's dept -- EXCEPT an
answered call abandoned ON HOLD, which attributes by `final_dept` (the
answering agent owned it). `final_dept` carries the raw CDR ORG-CHART label
(`Customer Success`, `Inside Sales`, ...), which in this install matches no
dashboard dept header, so that arm is driven by the Dept Config **`Final Dept
Labels`** column (INV-54, col 11) via `getFinalDeptLabels_`, which ALWAYS
prepends the dept's own name. **Adding a label is a Dept Config edit, no
redeploy.** **A label mapped to NO dept falls back to the ENTRY QUEUE** --
the two arms are exclusive on the on-hold flag, so without the fallback an
unmapped label attributes the call to NOBODY. The fallback gates on
`getAllFinalDeptLabels_()`, the UNION across every dept, NOT this dept's
list: a label mapped to dept A must not ALSO fall back to entry-queue dept B,
or both count the call. It fails OPEN (unreadable config ⇒ empty union ⇒
everything falls back to the entry queue -- degraded attribution, never lost
or double-counted calls). **This is what makes an AMBIGUOUS label safe to
leave unmapped, which is the only correct handling for one:** `Field Ops` and
`Field Ops Power` carry both `Field Operations (Market Activity)` and `Field
Operations (Markets)` INTERCHANGEABLY, so no label→dept entry is right for
either -- and those two depts have no crossover agents, so the entry queue
attributes their on-hold abandons correctly with nothing mapped. Leave a
shared label out of BOTH rows. Admins can additionally pick "All
departments" -- the only view including the "Abandoned in IVR" bucket, since
IVR abandons never reached a queue at all.

### Outbound-call capture

**Outbound-call capture is Neon-only and rides the daily import (Option
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
with NULL `callee_hash` and heal on re-import. Consumers: the
Caller Lookup communication history (above) and the Outbound report
(next bullet). Pinned by `tests/unit/outbound-calls.test.js`.

### Outbound report

**Outbound report (`OutboundReport.gs`, route `#/report/outbound`) --
"did we call back the ones who abandoned?" + per-agent outbound activity.**
TEMPORARILY admin-only while vetted (the Inbound/Direct resolver model --
latent per-dept manager path, release = one-line gate removal + un-hiding
the menu item). Two CONTRACT rules, both test-enforced
(`tests/unit/outbound-report.test.js`): (1) the callback DENOMINATOR is
exactly the Inbound report's Abandoned population for the same scope --
it reuses `inboundDeptPredicate_` + `inboundWindowClause_` + the
is_internal exclusion verbatim (`outboundAbandonWhere_`), so the two
reports can never disagree on what an abandon is; (2) agents attribute by
ROSTER dept (exact INV-04 match via `buildDeptsByAgent_`), NEVER the raw
CDR org label in `outbound_calls.department` -- the SQL never reads that
column. A callback = the EARLIEST outbound with `callee_hash =
caller_hash` within `OUTBOUND_CALLBACK_WINDOW_DAYS` (=3), matched from
ANY dept/agent and uncapped by the report's `to`; anonymous abandons are
excluded from the rate denominator (a dept is never punished for its
caller-ID mix); `pendingTail` counts tracked abandons still inside the
window. "Connected" is the disclosed stricter subset -- the CDR cannot
distinguish no-answer/voicemail/busy. **Company view is the FLAT table by
owner ruling (Option C, 2026-08-20)**: crossover agents have multiple
roster homes, so per-dept cards would double-count or misattribute --
don't "upgrade" without a new ruling. `getOutboundUncalled` is the
not-called-back drill (same lateral as the KPI, cap 200, no caller
identity; rows reuse the heatmap cell renderer + "↳ path"). Cached
`outboundReport:v2` + the freshness tag; unavailable payloads uncached.
**Neon-down degrades to the SHEET FALLBACK** (`outboundSheetFallback_`):
the `Outbound Calls` export tab (Op State #50) + the `Inbound Calls` tab
for the abandon denominator, fed through the SAME pure
`outboundShapeReport_` the Neon path uses -- so source parity is by
CONSTRUCTION (outbound-fallback.test.js pins it over one fixture).
Disclosed via `meta.fallbackSource`/`fallbackThrough`, NEVER cached.
**Vetting tool: `runOutboundVettingCheck`** (editor-run, admin-gated,
read-only; `OUTBOUND_VETTING_FROM/_TO/_DEPT/_SAMPLE` props) -- LIVE
two-code-path parity (rule 1 above, vs `computeInboundReport_`'s own
`kpis.abandoned`) + per-sample verdict re-verification with the call ids
logged for Caller Lookup eyeballing. OPS-8 verdict prefixes; a
zero-abandon window reports INCONCLUSIVE (the Batch-6 gate contract) --
**never un-gate on an INCONCLUSIVE / FAILED / MISMATCH run.**

### Temporal abandon heatmap

**Temporal abandon heatmap (weekday × hour), sourced from
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
`inboundDeptPredicate_`. Cached `inboundHeatmap:v3`. Rendered by the
SHARED client `renderAbandonHeatmap_` / `loadAbandonHeatmap_` as a
CSS-grid heatmap (no Chart.js dep) in the **Inbound report**
(`#inbound-heatmap`, always, since that report is admin-only), AND the **Insights report**
(`#ins-heatmap`, a Queue-health companion gated by the SAME
`USER.role==='admin'` check in `insRenderReport_` -- part of the
QCD->Insights consolidation parity; managers get the else-branch hide).
Cell color pivots on the 4%
company standard (C2, ABANDON_STANDARD_): ≤4% sage, >4% ramps warm; cells under
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
**Neon-down degrades to a SHEET FALLBACK, not a blank panel:** the
`Inbound Calls` tab (cols 16-17, Op State #49) is rebucketed with mirrored
SQL semantics incl. the two-arm dept attribution
(`inboundHeatmapSheetFallback_`; pinned by heatmap-fallback.test.js), NEVER
cached, disclosed via `meta.fallbackSource`/`fallbackThrough` + a panel
caption; the cell drill stays Neon-only (fallback cells non-drillable).
**Cell drill:** any cell with at least one abandon is click-to-drill --
`getInboundHeatmapCell({department, from, to, dow, slot})` (InboundReport.gs)
lists that cell's individual abandoned calls (date, CST time, entry->final
queue, stage, wait/hold) into a panel below the legend, each row carrying
the existing "↳ path" journey drill (`.pid-journey` -> `getCallJourney`).
**`dow`+`slot` are OPTIONAL and must be passed TOGETHER (R16h):** omit both
and it answers for the WHOLE `from..to` range instead of one bucket -- how
the Insights Daily-breakdown day drill asks for a single date's abandons
(`from = to = date`). Half a pair THROWS rather than silently widening to
the day (a cell click would over-report ~9x). Everything else is shared
verbatim between the two scopes, so they can never disagree on what an
abandon is; `meta.scope` says which one answered.
Same auth (the admin-only vetting gate via `inboundResolveRequest_`) +
dept predicate + TZ-shift/window/slot math as the heatmap SQL, so the list
always reconciles with the cell's count; `disposition='abandoned'` only;
capped at `INBOUND_HEATMAP_CELL_MAX`=200 newest (meta.truncated);
intentionally UNCACHED (per-cell, cheap; unavailable payloads must not
pin). Pinned by tests/unit/heatmap-cell-drill.test.js. No caller identity
in the response.

### Direct-extension call metrics

**Direct-extension call metrics are a separate population from the
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
created -- **no setup() change.** Three build paths (editor-run
`runDirectCallBuild()`; the daily `processIntegratedHistory` 6th block,
best-effort; the bulk backfill with `skipNeon`) share one core
`buildDirectCallFromRaw_(ss, rawDisp, configSheet, opts)`. Two guards on
it: **`opts.expectedDate` (P-4, the F2 class)** makes the build REFUSE
(throw into the caller's Pipeline-Health catch) when the grid's
first-row-derived date disagrees -- a stray carry-over first row would
stamp the whole day as D-1 and the delete-then-rewrite writers would wipe
D-1's correct rows (daily + bulk pass the importer's `dateObj`; the
editor-run build self-derives); **P-5:** `writeDirectCallRowsToNeon_`
runs its authoritative date-DELETE even for an EMPTY row set (matching
`dcWriteSheet_`'s unconditional clear), skipping only when there is no
date at all. The deferred bulk mirror is flushed by the editor-run
**`backfillDirectCallToNeon()`** (cdr-import-local; resumable via
`DIRECT_UPSERT_RESUME`, optional `DIRECT_UPSERT_SINCE` floor); the shared
`dcUpsertRows_` holds the upsert SQL for both writers. Dashboard read
surface: `DirectCallReport.gs::getDirectCallReport({from,to,department?})`
(ONE json_build_object round-trip; answer rate EXCLUDES the busy
carve-out; cached `directCall:v4`; R11-M `kpisPrior`/`deptsPrior` feed
the client delta chips). **TEMPORARILY admin-only while the carve-out
numbers are vetted** (the Inbound-report model: latent per-dept manager
path; release = a one-line gate removal in `directCallResolveRequest_` +
un-hiding the `data-admin-only` tab). **Neon-down degrades to the SHEET
(DC-1)** -- `Direct Call History` is the PRIMARY (Neon is the mirror), so
`directCallSheetFallback_` re-derives the SAME payload from it via the
shared `directCallShapePayload_` shaper (source parity pinned by
direct-fallback.test.js), uncached, disclosed via `meta.fallbackSource` +
a complete-figures note. Route `#/report/direct`. Company
view renders per-DEPT `<details>` cards (R11-C5; card order = the
R11-B11 impact score); single-dept view keeps the flat table; the CSV
stays flat with its Dept column. See
`docs/direct-extension-metrics-design.md`.

### CSR transfer detail

**CSR transfer detail reads an APPEND-ONLY, never-sorted sheet.**
`CSR Transfer Historical Data` (INV-52) is per-AGENT per-DAY with 11
per-QUEUE transfer-DESTINATION columns (H..R, labels in its own header row
-- read them, never hardcode). `computeCsrTransferRange_` surfaces the
headline tile plus `agents` / `queues` / `daily`. Three rules: (1) cdr-import
APPENDS at `getLastRow()+1` on both the daily and the BULK paths and nothing
ever sorts the sheet, so a backfill of older dates lands after newer rows --
the reader scans the DATE COLUMN then reads only the window's row SPAN at
full width; the export tabs' widening TAIL scan is WRONG here and would
silently drop backfilled rows (pinned by an out-of-order test). (2) Per-agent
rows are deliberately NOT roster-filtered -- the headline sums every row, so
filtering would break the reconciliation. (3) The 11 destination columns are
a FIXED set, so `queueSum`/`queueUnaccounted` DISCLOSE transfers going
anywhere else rather than letting the lists silently disagree with the
headline. `tests/unit/csr-transfer-detail.test.js` pins all three.

