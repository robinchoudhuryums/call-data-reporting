# The Neon mirror + read-back layer

Everything about the Postgres side: how a connection is obtained, the write
discipline that keeps the daily import inside its execution budget, the
flag-gated DQE read-back and its parity gate, what an outage degrades, and
the two optional engines (keep-warm, the deferred mirror).

Split out of CLAUDE.md on 2026-09-18 for the F8 reason: these eight bullets
describe how ONE subsystem is built rather than a trap that bites unrelated
work, and at 18 KB they were the single largest such family left in a file
injected into every session. **This file is authoritative**; CLAUDE.md keeps
a one-bullet index plus the two rules that bite from OUTSIDE this subsystem
(the JDBC-URL prohibition and the new-DQE-reader cutover obligation).

Read it before touching `neonWrite.js`, `NeonMirror.js`, `NeonRead.gs`,
`NeonKeepWarm.gs`, `NeonRetention.gs`, `NeonCoverage.gs`, any
`Jdbc.getConnection` callsite, or any DQE reader. The bullets are in their
original CLAUDE.md order, because several refer to each other by position
("above", "see next bullet").

Related, and deliberately NOT here: the `neonWrite.js` INV-16 duplication
rule stays in CLAUDE.md with the other hand-mirrored file pairs; the Neon
operator inputs are Operator State #16, #18, #19, #20, #22, #28, #30, #35,
#47, #54 and #57; the storage and egress Health rows are in the System
Health bullet; per-call table semantics are in
[`docs/per-call-capture.md`](per-call-capture.md).

- **Neon writes are guarded by `getReachableNeonConn_()`** which opens
  one write connection and probes it with `SELECT 1` (5-second timeout),
  returning that SAME connection for the insert (or null). If Neon is
  down (free-tier suspend, exhausted compute) or unconfigured, the write
  is skipped with a clean log — no failure email, no exception (the one-probe
  rule's backstory: the 2026-09-11 section of fix-history). `NEON_HOST`, `NEON_DB`,
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
  that hangs can still burn the execution ceiling (measure it, #70), whose kill SKIPS catch blocks,
  so none of the designed "fall back on error" paths run (the class that
  silently ate a Daily Queue Report day). Any future attempt needs a
  platform-supported mechanism, not URL properties.
- **Neon write discipline (don't regress this — it caused a daily-import
  timeout).** The Neon mirror is the dominant cost of the daily import,
  and these rules live in `neonWrite.js` (duplicated, INV-16) -- plus the
  cdr-import-ONLY `directCallMetrics.js`, which has NO twin. (1) **Hash phone numbers through the per-run memo
  `CDR_HMAC_CACHE_`, never raw per-occurrence** (slow, and the same numbers
  recur thousands of times per day); the cache is reset at the top of
  `writeCDRRowsToNeon`. (2) **Inline-literal
  VALUES, size-packed, commit ONCE (R38)** — every daily writer (DQE / QCD /
  CDR parents + the cdr-import-only Direct writer, all via
  `neonInsertInline_`, plus the phones children) emits dollar-quoted literals
  with ZERO bound params, packed to `NEON_INLINE_STMT_CHARS_` (30 KB -- R38
  in fix-history has the bridge's cap); a lone oversize tuple falls back to the ORIGINAL
  bound insert (`dqeBoundInsert_` / `qcdBoundInsert_` / `cdrBoundInsert_` /
  `dcBoundUpsert_`); the writer suites pin inline == bound value-for-value. One
  `conn.commit()` after the loop: smaller commits add round-trips AND leave
  partial rows behind on a mid-loop timeout. (3) **One probed connection per
  writer** via `getReachableNeonConn_()` (above), not a separate probe +
  write connection. (4) **Authoritative per-date replace (IMP-5).** Callers whose payload is provably the COMPLETE
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
  pass `expectedDateIso`** (records are dated from their own first leg;
  stray-dated records are dropped with a log line and the DELETE can only
  touch the expected date). **F2 -- an empty record set still runs a delete-only
  pass** (`icDeleteDateOnly_`) so a legitimately-zero date sheds its
  phantoms -- GATED on a NON-EMPTY source grid (P-3) AND on zero
  stray-dated/date-less records (C-1 / C-6: all-stray or all-unparsed means a
  wrong grid, refused with `allStray`/`allUnparsed` + a failure row + email). It reports
  `unreachable` when Neon is down so a deferred-mirror date stays queued.
  Pinned by the inbound-/outbound-calls suites.
  Partial-set callers -- the bulk archive after `dedupeAlreadyArchived_`,
  the row-batched backfills (`backfillDQEHistory*`,
  `backfillDirectCallToNeon`) -- must NOT pass authoritative. Duplicate
  conflict-key rows are deduped last-write-wins first (IMP-6; since P10
  `backfillCDRHistory`'s batches too). The
  `call_history_phones` children are per-parent DELETE-then-insert (IMP-4 --
  each payload row carries its parent's COMPLETE entry set, so per-parent
  replace is safe even on a partial-date bulk batch; `DO NOTHING` is ONLY an
  intra-payload dup guard, never cross-run dedup; `backfillCDRHistory`'s
  child path stays fill-only per its docstring).
  (5) **`call_history_phones` children are GATED OFF (R27)** -- written only
  when `CDR_PHONES_MIRROR` is `on` (both copies), and the weekly
  `NeonRetention.gs` prune bounds storage (`NEON_RETENTION_ENABLED`).
  Operator State #57 has the why, the runbook and the tests.
  (6) **DDL runs in AUTOCOMMIT, before `setAutoCommit(false)` (P-9 in
  fix-history: `ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE even when the
  column exists); the three writer suites pin the order.**
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
  regress to per-row `rs.getXXX` iteration (Apps Script JDBC is ~0.5 s/row;
  F1 in fix-history).**
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
  fallback -- OD-4: that set is bounded by the 25-month `dqe_history`
  retention (#57) while the sheet scan sees all history, so a >2-year-idle
  extension is recognized on one source and not the other.
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
  which measured 730 s+ on the all-departments queue report (R43 in
  fix-history) -- and a run killed at the execution ceiling (#70) skips its
  catch blocks, so the designed fallbacks never run. **That run now
  bounds itself (R43):** `computeQcdAllDepartments_` stops its dept loop on a
  DEPT BOUNDARY once `QCD_ALLDEPT_BUDGET_MS` (default 4 min) is spent -- a
  half-computed dept would corrupt the company grand totals it feeds -- and
  marks the payload `meta.partial`. **A partial is served, never trusted:** it
  is not cached (it would pin an incomplete report for the 6h TTL), the
  subscriber email REFUSES it (a non-zero dept count slips past the D-1 empty
  check, and an omitted dept reads as "no calls"), the day is not claimed so
  the next poll retries, and the web view carries an explicit note. A new
  consumer of this payload must decide what `meta.partial` means for it. Three tiers
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
  dequeue lost the rows for good. **P-2 (Batch 5): a PRUNED per-call source
  is a per-TYPE terminal, not a date failure** (`{pruned:true}`: a failure row,
  the sheet-derivable types still complete, ONE email at completion), and a
  hard error thrown while Neon was unreachable in the same run
  (`err.neonUnreachable`) never counts toward the retry cap. Only affects the daily/manual
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
