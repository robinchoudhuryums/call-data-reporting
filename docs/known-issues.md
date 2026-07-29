# Known issues and quirks

Institutional memory for things that have bitten us, or that *will* bite if
not respected. Add to this file whenever you discover something non-obvious
or fix a subtle bug — future-you will thank you.

Entries are ordered roughly by severity / how often they trip people up.

---

## Source pipeline: `buildDQEHistoricalData.gs` (CDR Report project)

### Bug 1: TTT included calls outside the work window

**Status:** Fixed (see `apps-script/cdr-report/buildDQEHistoricalData.gs`).

**Symptom:** An agent's `Total Answered` in `DQE Historical Data` would
exclude a call (e.g., one that started at 15:01 PST = 17:01 CST, outside the
6:30 AM – 3:00 PM PST work window), but the same agent's `TTT` would
include that call's talk time. The two columns silently disagreed.

**Cause:** Pass 3's TTT/ATT loop iterated `legs` (all-day legs for the
agent), while `totalAnswered` was computed from `windowLegs` (the
in-window subset). Two different denominators.

**Fix:** Iterate `windowLegs` for the TTT/ATT computation too.

### Bug 2: ATT denominator was the all-hours unique-parent count

**Status:** Fixed.

**Symptom:** For an agent with 5 in-window answered calls but 6 unique
answered parent calls across the full day, source ATT was stored as
`TTT / 6` instead of `TTT / 5`. The dashboard's weighted-ATT formula
(`TTT / Answered`) then disagreed with the source's stored ATT by a small
but consistent amount.

**Cause:** Same loop as Bug 1. `talkTimes.length` (the count used as the
ATT denominator) was the count of unique answered parents the agent had
*across all hours*, not Total Answered.

**Fix:** Same as Bug 1 — once the loop is windowed, the count matches
Total Answered.

### Bug 3: TTT misattributed another agent's talk time

**Status:** Fixed.

**Symptom:** When two agents both had legs on the same parent call (e.g.,
a transfer scenario), the agent whose leg was *shorter* would still get
attributed the *longer* leg's talk time. Real case: call
`1762242119044` on 2026-03-09, Sonia's own leg was 0:01:01 but TTT
attributed 0:01:58 (the other agent's leg).

**Cause:** Pass 3 summed `parent.talkSec` per parent call, where
`parent.talkSec` is `Math.max(...legs.map(l => l.talkSec))` — the
longest leg of *any* agent on that parent. This is a max-of-all-agents,
not per-agent.

**Fix:** New `findAgentTalkOnParent(parentCallId, agentName)` helper
walks `parent.legs` and returns the longest leg where
`leg.calleeName === agentName`. Each parent leg now also stores its
`calleeName` (added in Pass 1).

**Subtle gotcha for future readers:** Queue-leg rows (where caller_id
matches `A_Q_*`) have talk_time = 0. The agent's actual talk time lives
on a *parent-level* leg with the agent's name in col L. Don't try to
shortcut this by reading talk_time off the queue leg — you'll get TTT = 0
for everyone.

### Roster-driven name canonicalization (paren-variant fix)

**Status:** Fixed in `buildDQEHistoricalData.js`.

**Symptom:** ~100+ employees have parenthesized nicknames in their
roster name (e.g. `Roman (Robin) Paulose`). The upstream CDR feed
occasionally writes the same person's leg without the parenthetical
(`Roman Paulose`) or with a different one (`Roman (Bob) Paulose`).
Pre-fix, the variants produced split
daily rows for the same agent in `DQE Historical Data` and one of
them silently dropped out of the dashboard's roster join (INV-04
requires exact match).

**Fix:** At the start of every build, `loadRosterCanonicalNames_`
reads the `DO NOT EDIT!` sheet (same spreadsheet as Raw Data) and
builds two lookups: a Set of all canonical names plus a
`strippedForm -> [canonical, ...]` map. The agent-read loop calls
`canonicalizeAgentName(rawName)`:

1. If `rawName` exactly matches a roster entry → no-op.
2. Else compute `stripParens_(rawName)` (drop `\([^)]*\)` segments).
3. If exactly one roster entry has the same stripped form → use it.
4. Otherwise (zero or >1 match) → write raw, same as before.

Soft coupling: the pipeline now reads a sheet whose schema is owned
by the dashboard. If the roster cell format changes
(`"Name, ext1, ..."` → something else), update
`loadRosterCanonicalNames_` and `Data.gs`'s `parseRosterCell_` in
lockstep.

**Historical rows** written before this fix keep their old names; no
backfill ran. Either edit the stray cells manually or accept the
small noise.

**Why we didn't use a static alias map:** wouldn't scale to 100+
paren employees; would require code edits per new hire. The roster
is already the canonical source of "who works here" so deriving
canonicalization rules from it is robust to new hires.

### REP-3: CSR Avg Abd Wait (AH) excluded no-ring abandons

**Status:** Fixed going FORWARD (owner ruling; both
`buildDQEHistoricalData.js` copies, INV-16); rows built before the fix
keep the old rung-only semantics until rebuilt.

**Symptom:** the dept-wide `Avg Abd Wait` (AG) includes ALL abandoned
parents — including callers who hung up before any agent rang — but
`CSR Avg Abd Wait` (AH) was built only from `queueLegs` (agent RINGS),
so no-ring abandons on CSR queues (statistically the longest waits)
never entered it. AH systematically read LOW relative to AG's
population.

**Fix:** after the rung-leg scan, abandoned parents are also attributed
by their own parent legs' `calleeName` queue identifiers (the same
attribution the Pass-4 queue-sentinel producer uses); those on
`DQE_CSR_QUEUES` join `csrAbanIds`. Pinned by
`tests/unit/pipeline-build.test.js` (REP-3 test). Expect AH to read
somewhat HIGHER from the fix's deploy date onward — that's the
correction, not a regression.

### IMP-8: queue-name regex truncated `&`-names and matched embedded tokens

**Status:** Fixed (both `buildDQEHistoricalData.js` copies, INV-16).

**Symptom:** the Pass-2/Pass-4 queue regex `(A_Q_\w+|Backup CSR)`
stopped at `&` (`A_Q_Eligibility_MM&R` → a truncated `A_Q_Eligibility_MM`
sentinel that no Dept Config mapping matches) and matched MID-TOKEN
(`UDC_A_Q_Main` → a phantom `A_Q_Main` attribution).

**Fix:** `(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)` — `&` allowed in the
tail, and a non-word boundary required before `A_Q_` so embedded tokens
simply don't match (capturing the full prefixed token was NOT an
option: INV-23 sentinel consumers require names STARTING with `A_Q_`).
Pinned by `tests/unit/pipeline-build.test.js` (IMP-8 test).

**⚠ The DQE and INBOUND recognizers diverge ON PURPOSE — do not "harmonize"
them.** DQE must NOT capture a brand-prefixed token (`UDC_A_Q_Main` yields no
match here, by design, because an INV-23 sentinel name must START with `A_Q_`).
The inbound capture MUST capture it verbatim, since F1b, because
`inbound_calls.entry_queue` is matched by exact name against the Dept Config
lists — nothing there requires an `A_Q_` prefix. Making either regex "match the
other one" breaks the other subsystem: widen DQE and you get phantom
`A_Q_Main` sentinels; re-anchor inbound and brand-prefixed queues go invisible
again (F1b).

---

## AD/AE/AF positional pairing (Missed report / journey drill)

**Status:** Fixed going FORWARD (F-2, both `buildDQEHistoricalData.js`
copies); historical rows keep the old values until rebuilt.

The dashboard's Missed Calls report pairs `AF[i]` (abandoned missed-ring
time) with `AD[i]` (parent call id) positionally to hang a parent id on
each 🚨 timestamp -- the pairing behind the "↳ path" journey drill
(`getCallJourney` by `(call_date, call_id)`). The pre-fix build did NOT
guarantee that: AD was the unique-abandoned-parents-with-any-leg list
while AF was Set-deduped per-missed-leg times, so the lists diverged
whenever a queue re-rang the same agent on one abandoned parent, an
agent's only leg on an abandoned parent wasn't missed, or two missed
legs shared a timestamp -- and after the first divergence every later
🚨 timestamp carried the WRONG parent id (the drill opened a different
caller's journey).

**The fix:** all three columns now come from ONE chronologically-sorted
missed-leg list (one AD/AE/AF entry per missed leg on an abandoned
parent); abandoned parents with no pairable missed leg are APPENDED to
AD with no AE/AF partner, so AD's id SET -- the dept-wide
unique-abandoned counts -- is unchanged. Pinned by
`tests/unit/pipeline-build.test.js` ("F-2: AD/AE/AF are positionally
paired").

**Runbook for historical rows** (only where journey-drill accuracy on
old dates matters): rebuild the date from Raw Data via
`buildDQEHistoricalData` where Raw Data still exists (or force
re-import), then `backfillDQEHistoryUpsert()` (cdr-report) to refresh
the Neon mirror. Rows that can't be rebuilt keep old pairings -- treat
pre-fix "↳ path" results on old dates as unverified.

**The duplicate-row merge repair honors the pairing since T-1**:
`mergeDqeDuplicateRows_` (sheetRepairs.js) rebuilds AD/AE/AF as ONE
chronologically-sorted paired list + trailing unpaired parent ids --
its earlier per-row concatenation broke the lockstep whenever a source
row carried unpaired AD appends. If the merge was ever APPLIED before
the T-1 fix, those merged rows keep mispaired values until their dates
are rebuilt (same runbook as above). Pinned by
`tests/unit/sheet-repairs-merge.test.js`.

---

## Sheets auto-coercion of DATE-shaped strings (writer-side)

**Status:** One instance fixed (Direct Call History, F-3); one still
open (`inboundCallsExport.js`, F-10).

Writing an `"M/D/YYYY"` STRING via `setValues` gets auto-coerced by
Sheets into a Date value; a later `getValues()` read returns Date
objects whose `String()` form never equals the original string. Any
writer that "deletes the date's existing rows, then re-appends"
using that comparison silently deletes NOTHING and duplicates the
row set on every run. This is the date-string sibling of the
comma-joined ID/time coercion gotcha in CLAUDE.md.

- **Fixed:** `directCallMetrics.js::dcWriteSheet_` now compares
  ISO-normalized `getDisplayValues()` via `dcDateIso_` (pinned by
  `tests/unit/direct-call-metrics.test.js`). **Repair for existing
  duplicates:** rows duplicated by pre-fix re-imports are NOT
  auto-removed; force re-import each affected date once (the fixed
  delete then removes all stale copies of that date), or delete the
  older duplicates by hand.
- **Fixed (F-10):** `inboundCallsExport.js::exportInboundCalls` -- both
  the refresh-in-window delete and the incremental max-date detection now
  normalize col-A DISPLAY values via `ic_cellDateIso_` (pinned by
  `tests/unit/batch2-helpers.test.js`). **Repair for existing duplicates:**
  rows duplicated by pre-fix runs are NOT auto-removed outside the refresh
  window; run one explicit full-range export --
  `exportInboundCalls('<earliest-affected-iso>', '<today-iso>')` -- and the
  now-working in-range delete replaces the whole polluted window with one
  fresh Neon copy.
- **Rule for new writers:** compare ISO-NORMALIZED DISPLAY values
  (`getDisplayValues()` + a parse), never `String(getValues())`, for
  any date-keyed delete/dedup; or plain-text (`'@'`) the column at
  write time.
- **Fixed (P-8):** the autoImport history-date comparisons
  (`checkHistoryForDate` / `buildHistoryDateSet` /
  `dedupeAlreadyArchived_` / `deleteHistoricalRowsForDate`) parse
  ISO-shaped TEXT cells via `parseHistoryDateCell_` (local-noon
  construction) instead of `new Date("YYYY-MM-DD")`, which is UTC
  midnight = the PREVIOUS Chicago day -- an ISO-typed text cell (the
  README-sanctioned paste-old-rows flow can leave them) made the
  dup-guard report the wrong day and the force-delete silently no-op.
  Pinned by the P-8 test in `tests/unit/csr-transfer.test.js`.
- **Related (F-51):** the DQE sheet->Neon paths (both backfills, the
  deferred mirror, the dup-guard re-mirror) now route the 19 SLOT columns
  through `sanitizeSlotCellForNeon_` (clean cells pass; a coerced cell's
  date render recovers its time part; anything else mirrors as NULL
  instead of garbage). The helper is duplicated across
  cdr-report/neonbackfill.js and cdr-import/NeonMirror.js -- pinned by
  the guard script's function-level check, like
  `sanitizeAbandonedCellForNeon_`.

---

## CSR Transfer ring fan-out over-count (CDR Import project)

**Status:** Fixed in `calcCsrReport` (`apps-script/cdr-import/autoImport.js`).

**Symptom:** Per-agent CSR transfer counts in `CSR Transfer Historical Data`
(Transferred, Trans %, and the 11 per-queue cols) were inflated. E.g. on
2026-06-22, Camila's transfers to the Field Ops queue logged as 22 when the
real figure was a handful — the 22 reflected the number of agents the
destination queue *rang*, not actual calls.

**Cause:** `calcCsrReport` counted transfer **legs**, not distinct calls. A
single transfer to a queue that fans out to N ring-legs emits N Raw Data rows
with the same `caller -> callee`, so each leg was counted. Latent since the
file entered the repo; exposed by a day with wide multi-agent ring queues.

**Fix:** Dedup by **root call id** — `csrRootCallId_(row)` = parent-call id
(col O / idx 14) when present, else call id (col A / idx 0), the same
call-level identity DQE's `uniqueParentCalls` / `inbound_calls` use. The
per-queue accumulator is now a `Set` of root ids; `.size` is the transfer
count. `Total Calls` (col F) was never affected — it's counted independently
from callee talk-legs (`talk > 0`), so it stays the clean baseline.

**Tooling (three pieces):**

- **Retroactive repair (recent dates):** `repairCsrTransferForRawDataDate()` —
  editor-run in **CDR Import**; recomputes with the fixed engine and overwrites
  in place cols E/G/H..R for the date currently in the `Raw Data` sheet (which
  lives in CDR Report). Surgical, idempotent, leaves col F untouched. Only
  works while that date's legs are still in `Raw Data` (Raw Data is pruned).
- **Vet the whole history (B):** `vetCsrTransferHistory(referenceFromIso)` —
  editor-run, **read-only**. Most history can't be exactly recomputed (legs
  pruned ~14 days), so it heuristically flags likely-inflated rows by comparing
  each agent's **trusted reference window** (`Date >= referenceFromIso`, default
  `2026-06-22` — the repaired + post-fix era) against the **suspect era** before
  it. Because the bug was *systematic* (uniform per-queue multiplier), a
  within-agent spike detector would miss it — the reference comparison reveals
  systematic inflation and estimates the fan-out factor. Three signals:
  SYSTEMATIC (suspect median ≥ 1.8× reference median), SPIKE (a single row ≥ 3×
  the reference median), PCT_EXTREME (Trans % > 150%). Writes findings to a
  separate **`CSR Transfer Vet`** diagnostic sheet (never the data sheet) and
  logs a summary. Cannot auto-fix suspect rows (legs gone) — it scopes how
  widespread the inflation is and which agent/queue/dates to inspect.
- **Standing guard (C):** `csrTransferGuardFindings_(csrBatch, opts)` (pure,
  unit-tested in `tests/unit/csr-transfer.test.js`) runs inside the daily
  `processIntegratedHistory` CSR write block. If any written row shows gross
  inflation (Transferred ≥ 10 **and** > 3× Total Calls) it logs a best-effort
  `processIntegratedHistory:CSR-guard` `failure` row to Pipeline Health
  (surfaces in the Alerts modal) **without** failing the import. Deliberately
  conservative — Transferred and Total Calls are different populations, so a
  high Trans % alone is legitimate; only a re-inflation regression trips it.

---

## Spreadsheet vs script timezone mismatch (Mexico City vs Chicago)

**Status:** Worked around in code; underlying setting unchanged.

**Symptom (now fixed):** Every duration column (TTT, ATT, Avg Abd Wait,
CSR Avg Abd Wait) in the dashboard was exactly 36:36 (36 min 36 sec) too
high vs. the source sheet's displayed value.

**Cause:** The CDR Report spreadsheet's timezone is set to "Central Time -
Mexico City" (GMT-06:00 year-round), but `appsscript.json` declares the
script's timezone as `America/Chicago`. When `getValue()` returns a JS
`Date` for a duration-formatted cell, the underlying number is interpreted
through the **spreadsheet's** TZ. The dashboard's `toSeconds_()` then
read `getHours()/getMinutes()/getSeconds()` in the **script's** TZ. The
difference at the 1899-12-30 Sheets epoch between America/Chicago's CST
(-6:00:00) and America/Mexico_City's LMT (-6:36:36) is exactly 36:36 —
the fingerprint we observed.

**Fix:** Dashboard's `computeSummary_` reads `getDisplayValues()` for the
four duration columns and parses the formatted H:MM:SS string via
`parseHmsDisplay_`. Display strings are TZ-agnostic.

**Belt-and-suspenders:** `rowDateIso_(v, tz)` now accepts the spreadsheet's
TZ explicitly. `computeSummary_` pre-fetches it via
`getSpreadsheetTimeZone()`. The date column (col B) is currently stored as
strings so the Date-object path isn't exercised today, but if it ever is,
the right TZ is used.

**If you ever change the spreadsheet's TZ** (e.g., to Central Time -
Chicago to match the script): the dashboard code will still work (display
strings don't care). But formulas elsewhere in the workbook that use
`NOW()`, `TODAY()`, or date arithmetic *will* shift. Check those before
flipping.

---

## `neonWrite.js` duplicated across projects (currently identical)

**Status:** Accepted drift risk; verified byte-identical as of Phase R3 pull.

Both **CDR Import** and **CDR Report** Apps Script projects need
`neonWrite.js` (to write to the Neon `dqe_history` and related tables).
Apps Script has no native cross-project sharing, so the file is
duplicated. If you fix a bug in one copy, **fix it in the other too**.

Currently both copies are identical:

- `apps-script/cdr-report/neonWrite.js`
- `apps-script/cdr-import/neonWrite.js`

Quick check before changing either:

```bash
diff apps-script/cdr-report/neonWrite.js apps-script/cdr-import/neonWrite.js
```

If the diff is empty, you're starting from sync. If non-empty, **reconcile
before adding your change**, otherwise you'll bake the drift in further.

**Mitigation options for the future:**
- Consolidate Neon writes into a single Apps Script Web App / Library and
  have both projects call it. Apps Script Libraries are first-class.
- Or use a sync script in this repo that diffs + copies the canonical
  version into the other location.

For now, treat any change to either copy as a two-file edit.

### IMP-12: external CNAM names are masked to initials in Neon (owner policy)

The `ib_list_*` JSONB name-list fields' EXTERNAL side used to store a
non-phone caller display name (CNAM) raw — often a personal name
(patients, at a med-supply company) — while the same pipeline HMACs
every phone number for PHI. Owner ruling: `cdrParseNameFieldJson_` now
reduces external non-phone display strings to INITIALS
(`cdrMaskExternalName_`: "SMITH JOHN" → "S.J."); phone-shaped entries
keep the hash-only shape, and the INTERNAL side (employee names) plus
the sheet-side raw values are unchanged (accepted policy). Rows written
before the change keep their raw values until the date is re-imported.
Pinned by `tests/unit/neon-write-mapping.test.js` (IMP-12 test).

**P-2 (masking-bypass fix):** the parser splits internal|external on the
`|` separator, but `autoImport.js::join` used to OMIT the separator when
the internal side was empty — so an external-only NOP cell parsed
entirely as INTERNAL and skipped the IMP-12 masking + phone hashing on
its way into Neon (any agent-day whose inbound callers were all-external
wrote raw CNAM strings / numbers into `ib_list_*` JSONB). Two-part fix:
(1) `join` always emits the separator when an external side exists
(external-only cells now render with a leading `|` line sheet-side — the
same separator mixed cells already show); (2) the parser (both INV-16
`neonWrite.js` copies) hashes phone-shaped entries on the INTERNAL side
too — no employee name is phone-shaped, so a raw number can no longer
land in the JSONB from either side. Rows written before the fix heal on
re-import of their date (within the ~14-day Call_Legs retention); for
older dates, `backfillCDRHistory` re-hashes phone-shaped entries, but
raw NAME strings in old external-only cells heal only via re-import or
a one-off SQL cleanup. Pinned by the P-2 tests in
`tests/unit/neon-write-mapping.test.js`.

---

## Batch-E CDR Import fixes (autoImport.js / inboundCalls.js)

### IMP-2: legacy CDR engine now splits comma-joined queue-extension cells

`calculateMetricsInMemory` treated a config col-B cell like `"103,108"`
as ONE token: `queueExtensionSet.has("103")` never matched (queue
remotes leaked into the F/G/H callee-name lists), `exclusions` missed
the individual exts, and the Q-Path dept regex was built as
`/103,108(?!\d)/` (matched nothing). Now split on commas exactly like
`dcBuildExtMaps_` / `buildQueueNameToExts_` (the raw cell is kept too,
harmless); the Q-Path matcher tests each ext and counts a path at most
once per config row.

### IMP-10: inbound timestamps parse as UTC instants

`icParseTs_` built the CDR's PST wall-clock strings as SCRIPT-TZ-local
Dates (America/Chicago), so the spring-forward hour didn't exist and
the fall-back hour was ambiguous — skewed `call_start` / wait / journey
ordering for overnight calls two nights a year. It now parses via
`Date.UTC` and `icIsoDate_` / `icIsoTime_` read UTC getters: pure
wall-clock math, DST-immune (the DQE/Direct pipelines were already pure
string math). Never mix these ms values with real-clock `Date.now()`.

---

## Batch-F polish fixes + accepted deferrals

**Fixed (see the finding IDs in code comments):** OPS-2 (digest lock
narrowed to a run-claim marker; alerts lock wait 15s→2min), OPS-4
(backup months fetched in week windows; oversize months split into
`.partN.jsonl`), OPS-5 (config tables snapshotted once
`CONFIG_SOURCE=neon`), OPS-6 (invalid digest cadence flagged, not
dropped), OPS-9 (duplicate Alert Config dept rows first-row-wins +
flagged), OPS-11 (alerts scan the DQE sheet ONCE per run, memoized
per date), REP-1 (Custom Report Builder diagnostics panel floats right
of wide reports; previous column remembered in `CRB_DIAG_COL`), REP-4
(`'N/A'` parent ids excluded from unique-parent counts), REP-5
(`csr_team` named-range null guard), REP-7 (10-digit insurance numbers
normalized to `+1…` with a log line), REP-9 (slot repair applies each
column group end-to-end, shrinking the partial-apply serial-display
window), REP-10 (neonbackfill reads 34 cols, not 36), CORE-6/8/9,
RPT-4/5/9/10, TST-1/6/7.

**Deferred (accepted, revisit when they bite):**

- **OPS-3** — CacheWarm derives its warmed date keys in the SCRIPT TZ
  while the client derives the same dates browser-locally, so the warm
  silently misses for viewers whose browser date disagrees with
  Central (late-evening or non-Central use). Accepted: the user base
  is Central-office; a cold path is correct, just slower.
- **OPS-10** — the full `auth/drive` scope is broader than NeonBackup's
  single self-created folder needs (`drive.file` would do). Deliberate
  grant documented in NeonBackup.gs; narrowing requires re-consent and
  a live verification that script-created files stay reachable —
  operator's call.
- **REP-6** — the extraction tool (`dataFilters.js`) hardcodes the QCDR
  Output row map, two DNIS literals, and `Steering Number!B51:H51`
  with no drift detection; a layout change silently re-labels which
  filter logic runs. Real fix is a config block + assertions
  (mini-project on an internal verification tool).
- **REP-8** — DQE drill-down on a slot column (K–AC) returns the whole
  day's missed set, not the slot's half hour, so "Found N vs
  Dashboard X" can read as a false mismatch. Slot-aware drilling needs
  the slot window threaded through the drill query (admin-only tool).
- **TST-4/TST-5** — [FROZEN: DQE Report Legacy] intentionally skipped
  per the audit ruling; put the time into the S7 legacy decommission
  instead.

---

## Broad-scan Batch 5+6 fixes (2026-07, compact list)

> **Name collision, read this first.** "Batch 5+6" here means the CLIENT
> fix batches `C-1`…`C-9` from an EARLIER 2026-07 scan round. The Round-13
> cycle (also 2026-07) numbered its implementation batches 1-7, and ITS
> "Batch 5 & 6" is a completely different piece of work -- the inbound/QCD
> parity investigation and the read-source flag flips (see
> `.cycle/blocks/57-batch5-batch6-broad-implement.md` and the parity-gate
> rule below). Same words, different rounds; match on the fix codes, not
> the batch number. This is the same hazard `docs/fix-history.md` documents
> for the three `F`-shaped families.

Client (script.html): C-1 single `#ins-trend-header` writer (the range label
renders now), C-2 tour replay closes Settings, C-3 Overview mini-table WoW
tooltips use their own response meta, C-4/C-9 `escCssId_` escapes (not strips)
quotes for attribute selectors + the router deep-link lookups use it, C-5 the
all-dept QCD CSV title line routes through the shared escaper, C-6
`irRenderCharts` restores panel visibility on its empty early-return, C-7 no
double-encoding in the textContent Neon-health lines, C-8 Inbound/Direct
runners carry `reportReqSeq_` stale-response tokens.

Tools: T-1 (see the AD/AE/AF section above), T-2/T-3 null-date poison-row
guards in `backfillCDRHistory`/`backfillQCDHistory` (an unparseable date cell
used to wedge the resumable loop on the same batch forever), T-4
`backfillQCDHistory` abandoned_pct units — **CORRECTED by R8-B1 (2026-07-21):
T-4's unit analysis was INVERTED.** The inline writer stores a FRACTION
(autoImport's `abndPct = abnd/total`, 0..1, mirrored verbatim; Config.gs
ABANDONED_PCT pins "0..1 decimal, NOT percent"), so T-4's percent-units
backfill made the column mixed-unit (backfilled rows 100x the inline ones).
The backfill now normalizes to fraction ('%'-display or bare >1 → /100;
bare <=1 kept). Rows written by the T-4-era backfill do NOT heal on re-run
(the INSERT is DO NOTHING); heal via force re-import of the date or
`UPDATE qcd_history SET abandoned_pct = abandoned_pct/100 WHERE
abandoned_pct > 1`. No dashboard reader consumes the column (pct is
recomputed from abandoned/total), T-6 DQEdrilldown's col-W queue gate uses the IMP-8 boundary regex
(the verification sidebar accepts exactly what the build accepts), T-7
`writeDiagnostics` clears the previous panel's full height, P-7
`queueToPendingArchive` replaces a type's stale queued rows when the run
produced fresh ones (a failed-drain queue no longer beats a corrected
recompute; never deletes without a replacement), P-8 (see the date-coercion
section above).

---

## Source-data quirks (not code bugs)

### "Sales Voicemails" and similar pseudo-agents

Historical data sometimes contains rows where `Agent Name` is a system
entity ("Sales Voicemails", "A_Q_*" queue names, "Normal Call Menu",
etc.) instead of a real person. These won't be in any dept roster and
will appear in the dashboard's `whyNoMatches_` diagnostic under
"Agents in historical NOT in ANY roster".

These are correct rejections — don't add them to any dept roster.
`buildDQEHistoricalData.gs` has a `DQE_EXCLUDED_AGENTS` allowlist that
*should* drop them upstream; missing entries should be added there, not
worked around downstream.

### Blank Date column in QCD Historical Data (observed 2026-07, cause unconfirmed)

Owner-reported incident: rows for 07/03–07/10 were present in
`QCD Historical Data` with all metric columns populated but the **Date
column (col C) blank**, while the sibling CDR / Q Path / CSR / DQE sheets
had normal dates for the same days. Symptoms while the dates were blank:
the My Department QCD side panel, Insights Queue health, the Overview QCD
chips, and `computeMtdViolations_` all silently skipped those rows
(`rowDateIso_` returns `''` for a blank cell), so queue data appeared
"stuck" at the last dated row.

What the code can and can't produce:

- The **daily import cannot produce this**: `processIntegratedHistory`
  writes the SAME `dateObj` value into CDR / Q Path / QCD / CSR in one
  run (autoImport.js), so a QCD-only blank date column doesn't match any
  daily write path.
- The **one code path that can write a blank date** is the bulk Pending
  Archive path: `parsePendingDate()` returns an Invalid Date for an
  unparseable Pending Archive date cell, and `setValues` writes an
  Invalid Date as a blank cell. Only relevant if a bulk archive ran for
  the affected dates.
- Otherwise suspect a sheet-level edit (a cleared or partially-pasted
  column).

Repair: fill the Date cells by hand (M/D/YYYY is fine — the coercion to
a Date value is what the column wants), or force re-import the affected
dates (deletes + rewrites each date's QCD rows). Note the Neon
`qcd_history` mirror takes its date from the same value, so rows
mirrored while blank likely share the gap — a force re-import re-mirrors
them; a hand-fill does not. Report caches serve the old skip for up to
30 min after the fix.

If it recurs after a plain daily import, capture the Pipeline Health
rows for that run and the raw sheet state before repairing — that would
point at a genuine pipeline bug rather than an edit.

### Per-leg attribution issue on `1762242119044` (2026-03-09)

Identified during Bug 3 investigation. Distinct from Bug 3 itself —
this was about the wrong agent's talk time being summed. After the Bug
3 fix, Sonia's row correctly attributes her actual 0:01:01 leg, not the
other agent's 0:01:58.

If you see similar attribution issues on other days, suspect either:
- Bug 3 wasn't actually fixed in the running version (re-check
  `findAgentTalkOnParent` exists and is called from Pass 3)
- An agent's name appears differently between the queue leg and the
  parent leg (data quality issue in the CDR export)

---

## Dashboard design rules to preserve

### No write paths exposed via `google.script.run`

The deploy is **"Execute as: Me"** (the deployer), so any function
callable from the client runs with Robin's spreadsheet permissions. The
safety guarantee is therefore: **no public server function writes to any
sheet**. All helpers that touch spreadsheet state end in `_` (trailing
underscore) so Apps Script blocks them from `google.script.run`.

If you ever need a "save preferences" or "edit roster" feature, do it
through a public function that explicitly checks `resolveUser_(email).role
=== 'admin'` first. Don't loosen the convention.

### `setup()` is idempotent

`setup()` creates `Access Control`, `Alert Config`, `Alert Log`,
`Pipeline Health`, `Digest Config`, `Agent Alias Overrides`,
`Orphan Fix Log`, `Dept Config`, `Report Usage`, and
`Queue Report Subscribers` sheets if they
don't exist (each with a frozen header row). It never overwrites
existing rows on any of the ten. Safe to re-run as many
times as you want. Keep it that way; the alerts engine assumes
`appendAlertLog_` can blindly append without coordinating reads.

### Cache key version bumping

Each report file uses its own versioned cache key prefix. Bump the
version whenever the response shape or aggregation rules change so
stale caches invalidate on deploy.

INV-30 (`docs/invariants.md`, indexed from CLAUDE.md's Cycle Workflow
Config) is the canonical current-version list. This table mirrors it; if
the two ever diverge, INV-30 wins. Bump both at the same time as the code
change -- `tests/unit/cache-version-sync.test.js` extracts the canonical
version from the code's cache-key LITERAL and fails the build on any doc
that disagrees, so a missed bump here is a CI failure, not a silent trap.

| Source file | Cache prefix | Current version |
|---|---|---|
| `Data.gs` (main table) | `summary:vN:` | `v15` |
| `Data.gs` (latest-date snap for default From/To) | `latestDate:vN:` | `v1` |
| `Data.gs` (multi-source latest dates for freshness pill) | `latestDates:vN:` | `v2` |
| `IndividualReport.gs` | `individual:vN:` | `v11` |
| `IndividualReport.gs` (active-in-range subset shared by all three report pickers) | `individual_active:vN:` | `v2` |
| `PerformanceReport.gs` | `performance:vN:` | RETIRED (Performance Report deleted; Insights is the replacement) |
| `CompareRangesReport.gs` | `compareRanges:vN:` | RETIRED (Compare Ranges deleted; Insights custom-prior + vs-Prior chart replace it) |
| `MissedCallsReport.gs` | `missed:vN:` | `v17` |
| `CompanyOverview.gs` | `companyOverview:vN` | `v20` |
| `QCDReport.gs` | `qcd:vN:` | RETIRED (QCD modal deleted; `qcdAll:` remains) |
| `InboundReport.gs` | `inbound:vN:` | `v6` |
| `InsightsReport.gs` | `insights:vN:` | `v19` |
| `QCDReport.gs` (all-departments daily report) | `qcdAll:vN:` | `v5` |
| `InboundReport.gs` (weekday×hour abandon heatmap) | `inboundHeatmap:vN:` | `v1` |
| `DirectCallReport.gs` | `directCall:vN:` | `v2` |

`Alerts.gs` holds no cached compute. Preview/send always re-reads the
DQE Historical Data for the chosen date.

If you change ATT or % Answered semantics anywhere, you almost
certainly need to bump every prefix downstream of it. When in doubt,
bump.

### Chart color re-alphaing goes through canvas (R7/O-1 lesson)

Canvas `fillStyle` normalizes **opaque** colors to a HEX string
(`#rrggbb`) — it returns `rgba(...)` only when alpha < 1. Since
`colorToCanvasRgb_` (INV-42) reads back `fillStyle`, every `THEME.*`
token is HEX in practice. `rgbaWithAlpha_` used to parse only
`rgb()`/`rgba()` and **return the input unchanged** on a miss — a silent
no-op that kept the chart tooltip fully opaque despite the alpha-0.6
setting and flattened the missed-bar volume ramp (every bar the same
solid warn) for weeks. Since R7 it delegates to the canvas-based
`colorWithAlpha_` on a parse miss.

The rule: **never regex-parse a THEME token for re-alphaing** — route
through `colorWithAlpha_`/`rgbaWithAlpha_` (which now handle every
format), and never "return the input unchanged" when a color transform
fails to parse; delegate or fail loudly, because the unchanged-input
path renders plausibly and hides for weeks.

### A compare gate must never print a false PARITY CLEAN

Every "is the mirror safe to read from?" gate in this repo -- the three
`compare*ConfigSources` config gates, `compareDqeSources_` (NeonRead.gs),
`compareQcdSources_` (QCDReport.gs) -- exists to authorize an irreversible-
feeling decision: flipping a `*_READ_SOURCE` / `CONFIG_SOURCE` Script Property
so production serves from Neon instead of the sheet. **A gate that reports
CLEAN having compared NOTHING is worse than no gate**, because it converts
"I have no evidence" into "I have the strongest possible evidence".

This happened. `compareQcdSources_` derived `clean` from three counters
(`missingInNeon`, `extraInNeon`, `mismatches`); with zero comparable rows all
three are 0, so it printed `QCD PARITY CLEAN -- the gate PASSED`. The existing
`!neonGrid` guard did not cover it because `neonFetchQcdGrid_` returns a
non-null EMPTY grid for an empty range, and the in-source default range is a
hardcoded week that ages out of the data -- so an operator running the gate
without setting `QCD_PARITY_FROM`/`_TO` was the likely first victim.

The rule, now applied to all five gates: **a verdict must count what it
compared, and an empty comparison is INCONCLUSIVE, never CLEAN.** Each gate
returns a structured `{from, to, clean, compared, ...}` from every exit, and
the operator contract (Operator State #19) is `clean:true` AND `compared > 0`
-- an `error` or `compared: 0` is a STOP.

Note `compareDqeSources_` was NOT broken, but only incidentally: its
`extraInNeon` check catches a sheet-empty range because every Neon row reads
as "extra". That protection was emergent, not designed, and would have become
the same false CLEAN the moment the verdict stopped counting extras. It now
has the explicit guard too. Pinned by `qcd-report.test.js` /
`dal-cutover.test.js`.

### CLAUDE.md's split reference files can drift from their index

CLAUDE.md reached ~372 KB -- it is injected into every session's context, so
size is a real cost -- and four reference sections moved into `docs/` with a
one-line index left behind (`docs/invariants.md`, `docs/operator-state.md`,
`docs/regression-scenarios.md`, `docs/client-ui-conventions.md`; finding F8).

That trade buys readability and introduces exactly one new failure mode, which
is silent in the worst direction: **an invariant added to `docs/invariants.md`
but not to the index is invisible to anyone reading CLAUDE.md**, and an index
line for an entry that no longer exists sends a reader looking for nothing.

`tests/unit/claude-md-split.test.js` makes either a CI failure -- it checks IDs
and Subsystem/title strings (never prose; the index line is deliberately a
summary), that all four files are linked from "Read first" specifically, that
operator item numbers stay contiguous from 1 (they are cited BY NUMBER across
the repo), and it **caps CLAUDE.md at 200 KB** so the file cannot regrow
unnoticed the way it did.

Two things to know: the split also silently widened the blast radius of
`cache-version-sync.test.js`, whose hardcoded `DOC_FILES` did not include the
new file holding INV-30 -- the guard would have passed while policing nothing
(fixed in the same change; the list is explicit rather than a `docs/*.md` glob
because `fix-history.md` and the design specs legitimately name past versions).
And **`/setup-cycle` would undo the split**, since it rewrites those sections
with full bodies; the ID checks would still pass, so the size cap is the
backstop.

### Pipeline depends on the dashboard's roster sheet

`buildDQEHistoricalData` (CDR Report project) reads `DO NOT EDIT!` —
the dashboard's roster — for name canonicalization. See
"Roster-driven name canonicalization" above. This is the only
cross-project read; both projects live in the same spreadsheet so the
coupling is layout-level, not deploy-level. If you ever move the
roster to a different spreadsheet, update the pipeline's
`loadRosterCanonicalNames_` to open by ID instead of from the active
spreadsheet.

---

## Low Answer Rate Alerts (Alerts.gs)

### Sheet-driven config, not hardcoded

Unlike the legacy `checkLowAnswerRate.js` which hardcoded a 13-dept
threshold map + recipient map, the new engine reads two sheets:

- `Alert Config` — Department | Threshold % | Extra Recipients |
  Active | Notes | Skip Dates (col F, added in E8 — honored by the
  daily trigger only). One row per dept that should receive alerts.
- `Alert Log` — append-only history of every preview / send /
  skip with timestamp, threshold, observed answer rate,
  recipients, and a status enum.

Both schemas are pinned in `Config.gs` (`ALERT_CONFIG_HEADERS`,
`ALERT_LOG_HEADERS`) and idempotently created by `setup()`.

### Recipient resolution

For each dept, `to:` = dept managers from Access Control ∪ Extra
Recipients (Alert Config), and `cc:` = `ADMIN_EMAILS`. Dedup;
managers first. If neither side yields any address the dept is
skipped with `status: 'no-recipients'` and logged.

### Status enum

`sent` (fired live), `would-send` (preview / dry-run), `above-threshold`
(healthy, no email), `no-data` (zero rung in range), `no-recipients`
(see above), `skipped` (Active=FALSE in Alert Config), `error` (caught
exception with message captured in Notes).

### What gets persisted to Alert Log

Every per-dept outcome of every run — both real and preview — is
appended to the `Alert Log` sheet. Preview rows (from the modal's
**Preview** button) are distinguished by:

- The status column carries the `would-send` enum value (vs. `sent`
  on real runs).
- The Triggered By column is prefixed with `preview:` (e.g.
  `preview:robin.choudhury@…`).

Real-only queries should filter on
`triggeredBy NOT LIKE 'preview:%'`. The `Sent` boolean column is
`TRUE` only for `sent` outcomes; everything else (preview,
above-threshold, no-data, no-recipients, skipped, error) is `FALSE`.

Earlier behavior (`sent` and `error` only; preview rows dropped on
the floor) is no longer the case. Anyone with a saved query / script
against the legacy shape should update it.

### Weekend skip

`runDailyAlerts_` returns early on Saturdays + Sundays so the
daily trigger doesn't fire alarmist Sunday alerts. Manual runs via
the UI ignore this skip — if an admin clicks "Send alerts" on a
Saturday, alerts fire as configured.

### Crash notification

If `runDailyAlerts_` throws (e.g., transient sheet read failure),
the catch block emails ADMIN_EMAILS so a silent trigger crash
doesn't go unnoticed. The notification includes the exception
message + stack and the date being checked.

### Optional Script Properties

- `DASHBOARD_URL` — sets the link target of the "Open Department
  Dashboard" button in alert emails. Unset = emails still send,
  just without the link.

---

## Pipeline Health observability sheet

**Created by** `setup()`. Schema pinned in `Config.gs::PIPELINE_HEALTH_HEADERS`:
`Timestamp | Step | Status | Rows | Duration (ms) | Notes`.

Append-only telemetry of the daily pipeline. `Step` values are
free-form; current writers emit:

- `autoImport` — overall import outcome, from
  `apps-script/cdr-import/autoImport.js::processNewImport`
  (success at the end, failure in the outer catch block).
- `processIntegratedHistory:CDR` / `:QPath` / `:QCD` / `:CSR` /
  `:DQE` / `:Inbound` — one row per output type that produced > 0
  rows (`:Inbound` also logs a `failure` row when the inbound_calls
  Neon mirror is unreachable or errors, since that table has no
  sheet primary to fall back on — F9). Added
  so a partial failure (e.g. CDR + QPath succeed but QCD throws)
  surfaces immediately instead of being hidden inside the outer
  `autoImport` row's Notes count line. If a block fails
  mid-`processIntegratedHistory`, the per-output rows already
  written stay; the outer `autoImport` row logs the failure. The
  `:DQE` row was added when buildDQEHistoricalData was folded into
  the integrated path (INV-16 expanded).
- `bulkBackfill:DQE` — DQE build outcome from cdr-import's
  bulk-historical-backfill path (`bulkHistoricalUpdate` ->
  `processBulkQueue` -> `processNewImport` in silent mode).
  Bulk mode writes Raw Data per-date only when DQE actually
  needs building (`willBuildDQE = !existsInDQE`) and calls
  `buildDQEHistoricalData` inline right after queueing the
  other 4 sheet types to Pending Archive. One row per date in
  the bulk range; a failure on one date is logged and the loop
  continues to the next.
- `buildDQE` — DQE rebuild outcome, from
  `apps-script/cdr-report/buildDQEHistoricalData.js` standalone
  trigger path (`runDailyDQEBuild_`). Still installed as a safety
  net during stabilization of the integrated path; uninstall once
  every recent successful import shows a corresponding
  `processIntegratedHistory:DQE` row.

Every writer wraps every write in try/catch and swallows failures
so pipeline-health logging can never block or fail the pipeline.
The schema is owned by the dashboard but the writers live in two
different Apps Script projects -- each project has its own copy of
the helper (same shape on both sides; INV-44 + INV-52 in
`CLAUDE.md`).

**Reader** is `Alerts.gs::readPipelineHealth_(maxRows)`; the
dashboard's Alerts modal renders the last 20 entries under the
"Pipeline Health" section (admin-only). A long quiet stretch on
either step (rows from 2+ days ago and nothing since) is the
diagnostic for "the daily ingest didn't run" before assuming a
data bug.

---

## Manager Digest engine

**Sheet:** `Digest Config` (`Email | Department | Cadence | Active | Notes | Format`).
Created by `setup()`. Schema pinned in
`Config.gs::DIGEST_CONFIG_HEADERS`. The `Format` column (col F) was
appended at the end of the row -- the Alert Config Skip Dates
precedent -- so pre-existing sheets keep their 5-col header and read
back `format='summary'` until an admin populates F.

**Cadence** is `daily` (sends each weekday morning for the previous
BUSINESS day's data -- Monday's digest covers Friday; weekend runs
skipped), `weekly` (sends Monday 8 AM for
the prior Mon-Fri window), or `monthly` (sends on the 1st, 8 AM,
for the prior calendar month). Anything else is treated as inactive.

**Format** is `summary` (the KPI-tile digest + WoW driver callout;
default) or `insights` (the digest-Insights bridge: the SAME
`computeInsights_` the Insights page serves, run over the dept's
full roster -- floaters excluded -- vs a cadence-appropriate prior
window: daily compares to the INV-28 auto-adjacent day, weekly to
the previous Mon-Fri, monthly to the previous calendar month).

**Engine** is `Digest.gs`. Every public callable
(`getDigestsInit`, `sendPreviewDigest`, `installDigestTriggers`,
`uninstallDigestTriggers`) starts with `assertAdmin_`. Trigger
entry points (`runDailyDigests_`, `runWeeklyDigests_`,
`runMonthlyDigests_`) end in `_`
so `google.script.run` can't reach them, but `ScriptApp` dispatch
still calls them by name.

**Trigger lifecycle** is managed via the Alerts modal's
"Manager Digest Subscribers" section. Install / uninstall buttons
wrap `installDigestTriggers` / `uninstallDigestTriggers`. The
per-row "Send preview" button invokes `sendPreviewDigest` --
delivers a sample digest to the active admin's inbox so they can
verify what the subscriber will see (with a yellow "Preview only"
banner). On failure, `notifyDigestFailure_` emails the
`ADMIN_EMAILS` set so a silent trigger crash doesn't go unnoticed.

---

## QCD Abandoned vs inbound_calls abandons: why the two numbers differ (2026-07 investigation)

**Settled.** The two counts are not in conflict; they answer different
questions. Recorded in full because four plausible explanations were
eliminated along the way, and each one will look plausible again to the next
person who notices the gap.

### The measurement

CSR, `2026-07-15`..`2026-07-24` (8 business days), via
`runInboundQcdParityCheck` plus direct Neon probes:

| | inbound_calls (`A_Q_CSR` + `A_Q_Intake`) | QCD (`A_Q_CustomerSuccess`) |
|---|---|---|
| total calls | 2,583 | 2,737 |
| answered | 2,424 | 2,708 |
| abandoned | **113** | **29** |
| missed | 46 | (no such state) |

The totals agree within 5.6%, so both sources are looking at the SAME calls --
this is not a population difference. QCD's model is strictly
`total = answered + abandoned`; it has no third state. All 113 inbound
abandons carry `abandon_stage = 'queue'`.

### The answer: QCD applies a minimum queue-wait threshold; we apply none

On `2026-07-23` QCD reported **0** abandons for `A_Q_CustomerSuccess`;
inbound recorded **10**. Reading those 10 journeys leg-by-leg, their actual
QUEUE waits were 1, 5, 6, 9, 11, 22, 28 and 48 seconds (plus two outliers --
see Backup CSR below). A Raw Data check confirmed zero CSR abandons at or
above 1 minute of queue wait that day. So QCD is CORRECT by its own
definition: it counts callers who waited in a queue past a threshold and gave
up. The observed threshold is above 48s; a 60s setting fits every
observation.

The inbound capture has no threshold and answers a broader question: **did
this caller hang up without ever reaching a human?** Both are legitimate.
Neither is wrong. They must not be presented side by side without saying so.

### `wait_seconds` is WHOLE-CALL elapsed time, not queue wait

This is the trap that made the gap look far worse than it is, and it is easy
to fall into twice. `buildInboundCallRecords_` computes
`waitSeconds = abandonLeg.stop - firstLeg.start` -- measured from **IVR
pickup**, not from queue entry. The IVR (`Introduction` + `Normal Call Menu`)
runs 54-65 seconds on nearly every call here, and one sampled call sat in the
menu for 108s:

```
#10  17s intro + 37s menu = 54s IVR,  then A_Q_CSR queue  1s  -> wait_seconds 55
#3   17s intro + 108s menu = 125s IVR, then A_Q_CSR queue  6s  -> wait_seconds 131
```

Read as queue wait, that says "83% of abandons waited over a minute". Read
correctly, almost all of them waited seconds. **`wait_seconds` is NOT
comparable to QCD's threshold** and must not be used as one. The per-leg
`secs` inside `journey` is where a true queue wait is derivable. Note the
column feeds the heatmap cell drill under a "wait/hold" label, which is
misleading for the same reason -- open follow-on, not yet fixed.

### RETRACTED: "`Backup CSR` overflow is invisible to QCD"

**This claim was wrong and is recorded so it is not repeated.** It rested on
two `2026-07-23` calls that passed through `A_Q_CSR` in 0s and then waited
637s and 497s in `Backup CSR` before abandoning, against a QCD row reporting
`abandoned = 0, longest_wait = 2:42`.

Both calls started at **17:12 and 17:48 PST = 19:12 and 19:48 CST** -- hours
past the 3:00 PM PST / 5:00 PM CST cutoff. QCD excluding them is CORRECT. The
`longest_wait` argument fails for the same reason: QCD would exclude that call
from `longest_wait` too, so the 2:42 proves nothing about queue membership.

What actually remains is one unexplained fact with a plausible benign reading:
`Backup CSR` has no `qcd_history` row in the window (the queue breakdown lists
14 queues and it is not among them), which is what you would expect from an
overflow queue that mostly catches calls when the main queue is unstaffed --
i.e. out of hours. **Do not treat this as a code defect without first
confirming upstream whether the phone system reports queue stats for
`Backup CSR` at all.**

### The work-window scope: QCD is windowed, the inbound capture is not

Found while investigating the above, and the reason it was missed for so long.
`buildInboundCallRecords_` captures every inbound call around the clock. QCD's
Abandoned column only counts calls inside the `DQE_WINDOW_START`..
`DQE_WINDOW_END` work window (6:30 AM - 3:00 PM PST). So every row of the
parity table compared an unwindowed count against a windowed one.

Measured for CSR over `2026-07-15`..`2026-07-24`, bucketing on `call_start`
(raw PST, so it compares directly with no conversion):

| bucket | calls | abandoned | abandon rate |
|---|---|---|---|
| before hours (`< 06:30`) | 70 | 2 | 2.9% |
| **in window** | **2,494** | **102** | **4.1%** |
| after hours (`>= 15:00`) | 19 | 9 | **47%** |

So the window scope accounts for 11 of the 113 (~10%) -- **real but modest;
the wait threshold above is still the dominant mechanism.** In-window inbound
abandons are 102 against QCD's 29, so scoping alone does not close the gap.

Two things worth carrying forward. First, the in-window abandon rate of 4.1%
sits UNDER the 5% company standard, as does QCD's 1.06% -- the two lenses
disagree on magnitude but agree on the verdict, which further de-escalates
this. Second, the **47% after-hours abandon rate on 19 calls** is the useful
finding here: roughly half of out-of-hours callers give up, which is exactly
what an unstaffed queue should look like.

**Owner ruling: out-of-window calls are RESEARCH data, never a dept metric.**
They are tracked and reported separately, never folded into a dept total.
`compareInboundVsQcdAbandons_` scopes its inbound side to
`INBOUND_WORK_WINDOW_PST` (Config.gs) and reports
`outsideWindowAbandoned` / `outsideWindowCalls` as a separate line. Rows with
a NULL `call_start` (pre-extension captures, no time-of-day) count as
IN-window rather than being dropped -- dropping them would silently shrink
historical dates and read as a fixed gap. Pinned by
`tests/unit/inbound-qcd-parity.test.js`.

**Shipped (`inbound:v6`).** `computeInboundReport_` window-scopes its whole
payload from one place -- the clause is appended to the shared `dr`/`priorDr`,
so the KPIs, prior KPIs, all five breakdowns and the daily series inherit it
and a sub-select added later cannot miss it (pinned by a count-based assertion
in `tests/unit/inbound-window-scope.test.js`). `getInboundInsurerDaily` is
scoped identically, since it drills off a `byInsurer` row and would otherwise
fail to reconcile with the count the user clicked.

**Two deliberate exemptions, both pinned:**

- `coverageStart` answers "when did capture begin" -- a data-availability fact,
  not a dept metric. Scoping it would move the reported start to the first
  in-window call and mis-warn on the client's coverage note.
- **The abandon heatmap is already window-bounded** by
  `INBOUND_HEATMAP_WINDOW_START_HOUR`/`_END_HOUR` (8 AM - 5 PM CST), which is
  the INV-18 display convention and 30 minutes WIDER at the start than the work
  window on purpose. Adding the work-window clause on top would silently narrow
  the grid's first column. Don't.

The client surfaces the research block as an "Outside business hours" section
below the heatmap -- muted, captioned as not a department metric, and hidden
entirely when nothing falls outside the window.

### Hypotheses eliminated (do not re-run these)

1. **Overflow / entry-vs-abandon-queue attribution** -- only 6 of 113 CSR
   abandons changed queue (5%). Cannot account for the gap. (It IS the
   mechanism behind the Backup CSR blind spot above, at small volume.)
2. **QCD filtering short abandons, us counting them** -- inverted: it is QCD
   that filters, but by QUEUE wait, and our `wait_seconds` measures something
   else entirely (above).
3. **Queue name-space mismatch** -- `A_Q_CustomerSuccess` does not exist in
   Raw Data; it is the pipeline's canonical rollup of `A_Q_CSR` +
   `A_Q_Intake`, which is exactly what inbound counts. The mapping is
   CORRECT. (`A_Q_Intake` and `Backup CSR` produce no separate QCD rows,
   consistent with a rollup.)
4. **The work-window scope** -- real, but only ~10% of the gap (11 of 113).
   Worth applying for correctness; does NOT explain the discrepancy.
5. **Abandons hidden under a non-`Total Calls` QCD source (INV-50)** -- the
   other sources (`CSR`, `Call Menu`, `Ad-campaign`, `Non-CSR (internal)`,
   `New Call Menu`, `Internal`, `Misc`) sum EXACTLY to the `Total Calls` row
   on both measures: 4,390 calls and 72 abandons. `Total Calls` is a true
   rollup; summing every source would double-count. **INV-50's
   single-source filter is confirmed correct.**

### Unrelated bug found by the same run: the answered-on-hold carve-out has never fired

`inboundDeptPredicate_` attributes an answered-then-abandoned-on-hold call by
`lower(trim(final_dept)) = lower(<dept>)`. The parity check reported
`onHold = 0.0` for every dept on every day -- but 146 such calls exist in the
window. `final_dept` holds the raw CDR ORG-CHART labels (`Customer Success`,
`Inside Sales`, `Patient Care`, `Patient Intake - Supplies`, `Intake -
Service/Repair`, ...) and **not one of them matches a dashboard dept header**
(`CSR`, `Sales`, `Power`, ...). The documented soft coupling has never held in
this install, so all 146 attribute to no dept and are invisible in every
dept's inbound slice. Fix needs an admin-authored label->dept map (the
`DIAL_IN_LABELS` shape); the mapping is not one-to-one (four `Intake -*` /
`Patient Intake -*` labels, plus one blank) so it needs an owner decision, not
a derived rule.

### Consequence for the un-gating decision

The Inbound + Direct reports stay admin-gated NOT because either number is
wrong, but because a manager comparing the Inbound abandon count against the
Daily Queue Report will see roughly 4x and have no way to know why. Releasing
them needs the report to state that its abandon count has **no minimum-wait
threshold and includes IVR time**. That caption is the cheap prerequisite;
the Backup CSR gap and the `wait_seconds` semantics are the substantive ones.

---

## Two queue-name spaces: raw Raw-Data names vs QCD-canonical names

**Status:** Partly closed. The BRAND-PREFIX class is FIXED (F1b, 2026-07-27 --
see below); the raw-vs-canonical SPELLING class is still live, worked around for
the per-call journey drill and bridged at capture time by R8-N normalization +
the Dept Config alias union for the per-dept Inbound report.

There are **two different spellings for the same queue** in this install:

- **Raw Data leg names** (CALLER_ID col 22 / CALLEE_NAME col 11): the actual
  queue identifiers the phone system emits, e.g. `A_Q_CSR` (ext 103),
  `A_Q_Intake` (ext 108), `A_Q_Spanish`, `Backup CSR`, and the BRAND-PREFIXED
  `UDC_A_Q_Main` / `UUC_A_Q_Main`. `inbound_calls` captures these into
  `entry_queue` / `final_queue` via `icIsQueueName_`, which since F1/F1b matches
  `A_Q_` at string start **or after an underscore**, plus an exact
  `Backup CSR`, plus any name listed in the `Dept Config` sheet's QCD Queues /
  Inbound Queue Aliases columns (`icLoadConfiguredQueueNames_`). It was
  `/^A_Q_/i` alone until 2026-07-27 -- see the F1b entry below.
- **QCD-canonical names** (QCD Historical Data col D / `DEPT_QCD_QUEUES`): the
  names the QCD pipeline writes, e.g. CSR's main queue is `A_Q_CustomerSuccess`
  (NOT `A_Q_CSR`). `queuesForDept_` / `getDeptQcdQueues_` return THESE.

So `inbound_calls.entry_queue = 'A_Q_CSR'` but `queuesForDept_('CSR')` =
`['A_Q_CustomerSuccess', 'A_Q_Intake', 'Backup CSR']` -- the CSR main queue
does **not** match across the two spaces (Intake happens to).

**NOTE on names the capture didn't recognize yet.** `icIsQueueName_` has twice
been taught a queue shape it was missing, and BOTH times the pre-fix rows are
identical in shape: `abandon_stage='ivr'` + `entry_queue=NULL`, attributable to
no dept, healing only via a re-import/`backfillInboundCalls` while the
`Call_Legs_*` sheets survive (~14 days) -- older dates are unrecoverable.
- **`Backup CSR`** — learned in IMP-1.
- **`UDC_A_Q_Main` / `UUC_A_Q_Main`** — learned in **F1b** (2026-07-27). The
  `/^A_Q_/i` anchor missed every brand prefix. Measured: a journey leg-name
  histogram over abandoned NULL-`entry_queue` calls found `UDC_A_Q_Main` on 38
  abandons in one ~8-week window, still accruing -- while the DQE pipeline had
  listed BOTH names in `DQE_EXCLUDED_AGENTS` all along, so the two pipelines
  disagreed about what a queue is.

The miss is **self-concealing**, which is why it survived so long:
`scanInboundQueueNames_` (the Dept Config "Discovered inbound queues" panel)
and `runInboundQcdParityCheck`'s unattributed list BOTH filter
`COALESCE(entry_queue,'') <> ''`, so a queue that was never recognized has no
row to discover. Diagnose with the journey leg-name histogram in **CLAUDE.md
Operator State #38** — NOT with a bare `entry_queue IS NULL` count, which
unions three causes (measured at 9353 here, of which the real miss was tens of
calls).

**Symptom that surfaced it:** the "↳ path" call-journey drill on abandoned
rings in the Missed Calls / My Department views returned "No inbound-call path
on record" for CSR-entry calls. `getCallJourney` (`InboundReport.gs`) scoped
the lookup with `callJourneyDeptPredicate_` (`entry_queue`/`final_queue` IN
`queuesForDept_(dept)`), which never matched `A_Q_CSR`.

**Fix (journey drill):** `getCallJourney` now falls back to an exact
`(call_date, call_id)` match when the dept-scoped query finds nothing.
For MANAGERS the fallback is server-gated since F-4: `callIdInDeptMissedReport_`
requires the id to appear as an abandoned parent id in the manager's OWN
dept's Missed report for that date (fail-closed on any error; admins
ungated). The old "the call_id is already dept-entitled upstream" claim was
client-trust reasoning and is NOT the entitlement boundary -- the F-4 gate is.
The journey carries no caller identity (no hash/number; phone-like callee
names are masked at capture). Logs when the fallback hits.

**Fix (per-dept Inbound report + journey) — Dept Config alias column.** A new
`Inbound Queue Aliases` column on the `Dept Config` sheet (INV-54, appended at
the end / col 10 so pre-existing 9-col prod sheets keep working) holds the RAW
queue names per dept. `getInboundQueueAliases_` (DeptConfig.gs, sheet-only — no
seed constant) reads it, and `InboundReport.gs::inboundQueuesForDept_` UNIONs it
with `queuesForDept_(dept)`. Since R8-1 (missed:v17) the **Missed report's
queue-only SENTINEL attribution** consumes the same union too -- DQE sentinel
rows carry the raw names, so R6's canonical-only match silently dropped CSR's
`A_Q_CSR` no-ring abandons until the union was wired in. BOTH inbound dept predicates now consume that union
(`inboundResolveRequest_` → the report + heatmap; `getCallJourney` → the per-call
path), so a call whose `entry_queue`/`final_queue` is a raw alias (e.g. `A_Q_CSR`)
attributes to the right dept. Admin-curated via the Dept Config modal's "Inbound
queue aliases" field; no redeploy. **To un-gate the per-dept Inbound report:**
populate the aliases for each affected dept (CSR = `A_Q_CSR` etc.), confirm the
slices, then remove the one-line admin gate in `inboundResolveRequest_`. The
parked QCD-vs-inbound abandonment discrepancies are likely the same root cause —
re-check them once aliases are populated.

**Capture-time normalization — IMPLEMENTED (R8-N, 2026-07-21), option 1 of the
two designs previously sketched here.** `inbound_calls.entry_queue`/`final_queue`
are now translated raw → QCD-canonical AT CAPTURE
(`cdr-import/inboundCalls.js::icQueueCanonicalMap_` + `icNormalizeQueue_`,
applied inside `writeInboundCallsToNeon` so the daily import, the deferred
mirror, and `backfillInboundCalls` all normalize), seeded from the SAME
admin-curated Dept Config "Inbound queue aliases" column via a new
backward-compatible **`raw=canonical` pair syntax**:

- `A_Q_CSR` — plain RAW alias: attribution-only via the dashboard union,
  exactly as before.
- `A_Q_CSR=A_Q_CustomerSuccess` — alias + capture-time translation: new
  captures write the canonical name into `entry_queue`/`final_queue`. The
  `=` right side is validated at save against the dept's QCD queues.

Scope decisions: ONLY the two attribution columns are translated — the
journey JSON keeps the raw phone-system names (faithful leg record) and
`num_queues`/`num_transfers` count raw legs. The cross-project read is
best-effort (the INV-46 soft-coupling pattern): any failure yields an empty
map and capture stays raw. The dashboard union (`inboundQueuesForDept_`,
which now takes the RAW side of pair entries) is KEPT as belt-and-suspenders
— it still matches rows captured before normalization and the DQE sentinels
(which remain raw; the R8-1 Missed-report union is unaffected).

**Operator steps to activate:** (1) edit each affected dept's "Inbound queue
aliases" to the pair form (e.g. CSR: `A_Q_CSR=A_Q_CustomerSuccess`); (2)
re-run `backfillInboundCalls` (cdr-import editor) to rewrite rows still
inside the ~14-day Call_Legs retention; (3) older rows keep raw names — the
union covers them, or a one-off SQL
`UPDATE inbound_calls SET entry_queue='A_Q_CustomerSuccess' WHERE
entry_queue='A_Q_CSR'` (repeat per mapping/column) migrates them fully.
Option 2 (store the queue EXTENSION at capture) remains unbuilt — revisit
only if name-pair curation proves burdensome.

---

## QCD Report engine

**Sheet:** `QCD Historical Data` (12 cols), written daily by the
import pipeline (`apps-script/cdr-import/autoImport.js::processIntegratedHistory`
QCD block). Schema pinned in `Config.gs::QCD_HISTORICAL_COLS`:
`Month Year | Week | Date | Call Queue | Call Source | Total Calls
| Total Answered | Abandoned | Longest Wait | Avg Answer |
Abandoned % | Violations`.

**Key trap (don't repeat this mistake).** Col D (`Call Queue`)
holds **raw queue names** like `A_Q_CSR` / `A_Q_Sales` / `Backup
CSR`, NOT dashboard dept names. The legacy
`dqe-report/DQEdashboard.js::buildTable4` filters with
`r.callQueue === ctx.deptName` and reads like a working reference;
it isn't, and copying its pattern produces an empty modal. The
correct route is `Config.gs::DEPT_QCD_QUEUES`, an admin-curated
dept → list-of-queue-names map.

**Engine** is `apps-script/department-dashboard/QCDReport.gs`.
Since the QCD->Insights consolidation, the standalone QCD Report
modal and its endpoints (`getQcdReport` / `getQcdReportInit` /
`sendQcdReportEmail`, per-dept `qcd:` cache prefix) are RETIRED.
What remains public is `getQcdAllDepartments` (the company-wide
daily report, `qcdAll:` cache); `computeQcdReport_` is the shared
internal aggregation consumed by Insights Queue health + the
Overview / My Department snapshots. Queue data for a dept + range
is now read via the Insights report (Queue health section).

**What gets summed.** Only `Call Source === 'Total Calls'` rows.
The other sources (CSR / Ad-campaign / New Call Menu / Non-CSR
(internal)) are sub-counts that would double-count if added
alongside the Total Calls roll-up. Longest Wait is the **MAX**
across days in range; Avg Answer is an **answered-volume-WEIGHTED mean**
(`sum(avgAnswer × answered) / sum(answered)` over in-range rows). NOTE
(RPT-8): this diverges from the legacy `buildTable4` day-mean the docs
previously claimed parity with — flagged for owner ratification; the
code is treated as spec meanwhile (the F-29 precedent).

**UI surfaces** all visible to everyone (no admin gate beyond the
existing per-dept dropdown):

- **Insights → Queue health** (the retired QCD modal's replacement):
  headline tiles + secondary strip, per-queue rows with expandable
  per-call-source detail + violation dates, the collapsed Daily
  breakdown table, and the consolidated trend chart's queue metrics
  (since R11-C3 the "Queue: Abandoned % / Total calls / Violations"
  entries in the ONE `#ins-trend-metric` dropdown — the old by-queue
  tab + metric sub-selector are retired; violation-day warn markers +
  legend spotlight unchanged).
- **Overview tile chips**: an "Aban N (P%)" chip whenever QCD
  data exists (warn-tinted when P >= 5%), and a "X viol MTD" chip
  when month-to-date violations > 0. Powered by
  `CompanyOverview.gs::computeQcdSnapshots_`.
- **My Department "Yesterday's QCD"**: tile row below the agent
  table showing the dept's most-recent QCD day. Powered by
  `Data.gs::computeDeptQcdSnapshot_` and returned as the new
  `qcd` field on `getDepartmentSummary` (the `summary:` cache prefix
  was bumped when this shipped; see INV-30 (`docs/invariants.md`) for the current
  version).

**Onboarding a new dept.** When a new dept starts producing rows
in `QCD Historical Data`, the dashboard ignores them until a
matching entry exists in `DEPT_QCD_QUEUES`. To onboard:

1. Open `QCD Historical Data` and find the new dept's `A_Q_*`
   values in col D for recent rows.
2. Add a row to `Config.gs::DEPT_QCD_QUEUES` keyed on the
   dashboard dept name (the value in `DO NOT EDIT!` row 1 header),
   with the value as an array of those queue names.
3. `clasp push -f` + create a new deployment version.

The 5-min cache TTLs out automatically; no manual cache bump
needed unless the aggregation logic itself changes (in which case
bump `insights:vN` (Queue health), `companyOverview:vN`, AND `summary:vN` since all
three read QCD now).

---

## Orphan Fix engine (the first dashboard write path)

**Sheets:**
- `Agent Alias Overrides` (`Old Name | Canonical Name | Active |
  Added By | Added At | Notes`) -- persistent rename map.
- `Orphan Fix Log` (`Timestamp | Admin | Action | From Name |
  To Name | Affected Rows | Notes`) -- append-only audit trail.

Both created by `setup()`. Schemas pinned in
`Config.gs::AGENT_ALIAS_OVERRIDES_HEADERS` and
`ORPHAN_FIX_LOG_HEADERS`.

**Engine** is `apps-script/department-dashboard/OrphanFix.gs`.
Four admin-only public callables:

- `getOrphanFixInit` -- read-only: orphan list (180-day lookback),
  roster names, current aliases, last 20 fix-log rows.
- `addAgentAlias({ oldName, canonicalName, notes? })` -- forward
  fix only; appends or re-activates an entry in
  `Agent Alias Overrides`. Doesn't touch DQE Historical Data.
- `removeAgentAlias({ oldName })` -- soft-deactivates (Active=FALSE).
- `applyOrphanRename({ fromName, toName, alsoAddAlias?, notes? })`
  -- the **write path**. Bulk-renames every row in DQE Historical
  Data where Agent Name === fromName; with `alsoAddAlias=true`,
  also upserts the alias so the next CDR build keeps the mapping.

**Why this exists.** Before OrphanFix, an admin had to either edit
the roster cell to add the orphan as an alias, or wait for the
orphan to recur and rename rows by hand in the spreadsheet.
Neither scaled. The modal in the dashboard (Admin → Orphan Fix)
surfaces orphans, lets admins map each to a canonical roster name,
and applies the fix end-to-end with audit.

**INV-01 carve-out.** `OrphanFix.gs` holds the dashboard's ONLY
public write functions; the rest of the surface is read-only via
the trailing-underscore convention. The carve-out is documented in
CLAUDE.md's INV-01 (text was widened to spell out the four
mitigations). Don't add new public writes outside `OrphanFix.gs`
without the same belt-and-suspenders:

1. `assertAdmin_()` at the top -- the same gate Alerts and Digest
   use.
2. Input validation: `sanitizeAgentName_` rejects queue sentinels
   (`A_Q_*`, `Backup CSR`), empty strings, oversized values;
   `assertOnSomeRoster_` rejects renames to names that aren't on
   any dept's roster (prevents "rename everything to garbage").
3. `LockService.tryLock` serializes concurrent DASHBOARD callers
   (two admins clicking Apply at once). NB: LockService is
   per-script-project, so it does NOT serialize against the daily
   DQE build -- that runs in the cdr-import / cdr-report projects.
   A force re-import that deletes a date's rows mid-rename would
   shift rows under the rename's read-modify-write. F-22 mitigation:
   `renameHistoricalAgent_` re-verifies the agent column + row count
   immediately before writing and ABORTS with a "retry in a minute"
   error if either changed since its snapshot (no partial write;
   pinned by `tests/unit/orphan-rename-race.test.js`). The unguarded
   window is now just the back-to-back re-read -> write RPCs -- a
   mitigation, not a serialization, so still avoid renaming during
   an active import/rebuild.
4. Every action -- alias add, alias remove, rename, rename+alias
   -- appends to `Orphan Fix Log` BEFORE returning to the client.

**Cross-project soft coupling.** The dashboard writes
`Agent Alias Overrides`; the CDR Report project's
`buildDQEHistoricalData::loadRosterCanonicalNames_` reads it on
every build and folds it into the canonicalization map (priority:
alias > roster-exact > paren-strip). The pipeline-side read is
best-effort -- a missing or empty sheet leaves the build's
behavior byte-identical to pre-OrphanFix.

**Cache invalidation.** `applyOrphanRename` removes the single
fixed-key Overview cache entry (via the `COMPANY_OVERVIEW_CACHE_KEY`
constant -- currently `companyOverview:v20`) on success. Per-(dept,
range) caches (`summary:v15`, `individual:v11`,
etc.) are left to TTL out within 30 minutes
(`REPORT_CACHE_TTL_SECONDS`). The Orphan Fix modal tells the user
the Overview updates immediately and other views may lag up to the
cache TTL.

**Error message footgun.** `assertAdmin_` is defined in
`Util.gs` and throws "Alerts are admin-only." Non-admin calls to
OrphanFix surface that same message -- slightly misleading but
correctly rejects the call. Worth noting if you ever see it in a
log entry that has nothing to do with alerts.
