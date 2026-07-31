---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- S2-0 | Phase-2 queue narrowing was applied by 1 of 6 DQE surfaces -> gated behind QUEUE_SPLIT_SCOPE, default OFF
- B-1  | applyQueueSplitToRows_ had no fail-open for "mapped queues match none of the split's keys" -> window-level rollback + reporting
- B-2  | Three DQE readers still read the sheet directly while docs claimed all were cut over -> cut over + CI tripwire
- S2-2 | guardForceRebuildLoss_ skipped CSR Transfer, which became dashboard-read in R10-5 -> guarded + CI tripwire

Files modified:
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/script.html
- apps-script/department-dashboard/Alerts.gs
- apps-script/department-dashboard/Digest.gs
- apps-script/department-dashboard/OrphanFix.gs
- apps-script/department-dashboard/NeonRead.gs
- apps-script/cdr-import/autoImport.js
- tests/unit/queue-split.test.js
- tests/unit/cross-file-pins.test.js
- CLAUDE.md

CHANGES:

S2-0 | Data.gs, script.html, tests/unit/queue-split.test.js |
  New `getQueueSplitScope_()` reads the `QUEUE_SPLIT_SCOPE` Script Property
  ('off' default | 'dept'); anything unrecognized is 'off'. The gate lives
  INSIDE `applyQueueSplitToRows_` (not at its call site) so Phases 3/4 inherit
  it by adopting the function rather than each re-deciding. With it off the
  function returns the empty shape, so `meta.queueSplitFrom` stays null and no
  coverage chip renders. The scope joins the `summary:v18` cache key as a
  SUFFIX (the CORE-3 read-source pattern) so a flip cannot serve the other
  mode's table for the 30-min TTL -- deliberately not a version bump, since
  INV-30 versions track aggregation-RULE changes and both modes are the same
  rule at a different scope. `meta.queueSplitScope` added; `meta.queueSplitMapped`
  is now null (not false) when the gate is off, because "no queues are mapped"
  is a claim nothing checked. Client `subqSplitChip_` gained a scope-off branch
  stating the figures are all-queue BY DESIGN and match the other pages -- the
  pre-existing "detail is not available" wording would have claimed the data
  was missing when it is merely not applied.
  BEHAVIOURAL CONSEQUENCE, stated plainly: My Department and the manager
  digests revert to all-queue figures, matching Overview / Insights / IR /
  Missed / the alert engine. That restores the crossover over-count on the
  three parent depts (Sales / CSR / Power) -- the pre-Phase-2 state -- and the
  warn chip is now permanently visible on them. This is consistency bought at
  the price of per-dept accuracy, reversible with one Script Property.

B-1 | Data.gs, script.html, tests/unit/queue-split.test.js |
  Fail-open #4. `applyQueueSplitToRows_` now tracks, across the WHOLE window,
  which queue names the splits carry (`observedQueues`) and which the dept
  claims (`matchedQueues`). If names were observed and NONE matched, every row
  is restored from a pre-narrowing snapshot (exact values, incl. attSec --
  never re-derived), `applied`/`dates` are cleared so no coverage is claimed,
  and `fellOpenUnmatched` is set with a Logger line naming the fix.
  Assessed per WINDOW, not per row, on purpose: a single row matching nothing
  is legitimate (a crossover agent whose whole day was elsewhere) and failing
  open there would re-introduce the very bug Phase 2 fixes. An `{}` split
  contributes no observed names, so a genuinely idle window still narrows to
  zero. PARTIAL mismatches do not roll back (the matched queues are real) but
  are reported via `meta.queueSplitUnmatched` and a "missing a queue" chip,
  checked before the fully-split early-return so a 100%-split range can still
  report a dropped queue.

B-2 | Alerts.gs, Digest.gs, OrphanFix.gs, NeonRead.gs, CLAUDE.md, tests/unit/cross-file-pins.test.js |
  `alertRowsForDate_`, `computeDigestWowDriver_` and `computeOrphans_` now use
  the DAL (`neonFetchDqeRows_` + `neonDqeRowsUsable_`) with the established
  sheet fallback. Each was restructured around a shared `accept()` closure so
  the two sources provably produce identical output (same INV-23 sentinel skip,
  same coercion, same roster gate). Alerts' unconditional
  `if (!sheet) throw` is now conditional on `!neonCapable` (the F-35 pattern);
  on the default sheet path it still throws, byte-identically. computeOrphans_
  uses an open-ended upper bound ('9999-12-31') so the Neon window matches the
  sheet scan's "everything on or after the cutoff" with no clock-skew clipping.
  NEW CI TRIPWIRE: a dashboard .gs referencing SHEETS.HISTORICAL must also
  reference neonFetchDqeRows_ or sit on `DQE_SHEET_ONLY_ALLOWED` with a reason
  (NeonRead.gs = the DAL; Diagnostics.gs = sheet-cell diagnostics). Verified to
  have teeth: run against HEAD it flags exactly Alerts.gs, Digest.gs,
  OrphanFix.gs. Doc claims in NeonRead.gs + CLAUDE.md corrected to record that
  the "ALL readers are cut over" claim preceded the fact.

S2-2 | autoImport.js, CLAUDE.md, tests/unit/cross-file-pins.test.js |
  Added `guardForceRebuildLoss_(targetSS, 'processIntegratedHistory:CSR',
  dateObj, force, csrBatch.length)` before the CSR write block, on the same
  log-only terms as QCD. Uses the EXISTING `:CSR` step name (no new INV-44
  vocabulary; `:CSR-guard` is the unrelated fan-out guard). CLAUDE.md's guard
  bullet rewritten: the exemption list is keyed on "is this dashboard-read",
  and that property changes -- when a historical sheet gains its first
  dashboard reader, its force-path guard goes in the same commit. Two pins
  added: the guard calls exist for QCD and CSR, and the premise (Data.gs reads
  CSR Transfer Historical Data) still holds.

TEST RESULTS: PASSED -- `npm run ci` 610/610 (was 601; +9 new tests), INV-16
duplicated-file guard clean. `node --check` on the extracted script.html IIFE:
OK. html-include-structure 3/3.
NOT RUN: `npm run ci:ui` (the rendered-UI gate). Playwright cannot install in
this container; the harness SKIPs and exits 0 by design. script.html WAS
modified, so this gate is a real gap locally -- the CI `ui-harness` job is
blocking and will run it on the PR. The change is confined to
`subqSplitChip_`'s branch chain (pure string building, no DOM/chart work).

REGRESSION RISKS:
- S2-0 turns OFF a shipped behavior. Depts with genuine crossover (Spanish /
  PAP / PAK under Sales / CSR / Power) go back to over-counting their
  crossover agents' other-dept calls. This is the pre-Phase-2 state, not a new
  defect, and the chip says so -- but it IS a per-dept accuracy regression
  against the last deploy, accepted in exchange for all six surfaces agreeing.
- B-1's window-level rollback has a narrow false-positive: a short window in
  which the dept's ONLY active agents worked entirely on other depts' queues
  looks identical to a mapping fault, so it rolls back and shows those
  other-dept calls. Bounded (needs zero matched queues across the whole
  window), visible (the chip reads "queue mapping mismatch"), and dormant while
  the S2-0 gate is off. Judged better than the alternative it replaces:
  silently reporting a department as zero.
- The `summary:v18` cache key gained a suffix, orphaning existing entries; one
  cold-compute per (dept, range) within 30 min of deploy.
- On the Neon path, computeOrphans_ now fetches ~180 days of rows in one
  json_agg string. Comparable to the whole-sheet read it replaces and shorter
  than the 12-month window IR/Insights already pull, so not a new risk class.
- No signatures changed. `applyQueueSplitToRows_`'s return and `meta` gained
  fields additively; the one `queueSplitMapped` consumer handles null.

INVARIANTS AT RISK:
- INV-30 (versioned cache prefixes) -- JUDGMENT CALL, not a violation. The
  queue-split scope was added as a key SUFFIX rather than a version bump,
  following the CORE-3 read-source precedent. cache-version-sync passes.
- INV-05 / INV-02 / INV-04 / INV-23 / INV-53 -- all checked and preserved. The
  three DAL cutovers keep their sentinel skips, exact-name matching and
  roster-only gates; none of them read duration columns, so INV-02 is not
  engaged. B-1's rollback restores stored ATT exactly rather than recomputing.
- INV-44 (Pipeline Health step vocabulary) -- no new step name.
- INV-01 / INV-16 -- no new public functions (getQueueSplitScope_ is
  `_`-suffixed); duplicated-file guard clean.

NET SCORE: 2 production fixes − 1 new failure mode = 1
  S2-0 would have fired this month (the inconsistency is live wherever col AI
  is populated). B-1 would have fired conditionally -- it needs a dept whose
  mapped names miss the raw split keys, which CSR is documented to be, but I
  could not confirm against live data. B-2 and S2-2 are both latent (B-2 needs
  DQE_READ_SOURCE=neon + a trimmed sheet; S2-2 needs a force re-import with
  zero CSR rows), so neither counts. The one new failure mode is B-1's
  narrow-window false rollback described above.

OPERATOR ACTIONS / DEPLOY:
- Decide and record the intended QUEUE_SPLIT_SCOPE value. Deploying as-is
  leaves it unset = 'off' = all six surfaces agree. Set it to 'dept' ONLY when
  Phases 3/4 plus Overview and Alerts also narrow. | BLOCKS DEPLOY: N
- Verify `deleteOldCDRSheets` is actually installed as a trigger in the
  cdr-import project (found during the audit sweep: no caller, no menu item,
  no installer in the repo, yet the ~14-day Call_Legs retention it enforces is
  what Operator State #40's urgency and IMP-11's "pruned = permanent loss"
  logic both rest on). Not touched by this session. | BLOCKS DEPLOY: N
- Operator State #40 remains outstanding and time-boxed: the per-queue-split
  backfill window closes at 14 days. Unaffected by this session -- the split
  is still WRITTEN by the pipeline; only the dashboard's use of it is gated.
  | BLOCKS DEPLOY: N
- After deploy, walk the live Regression Scenarios listed below. | BLOCKS DEPLOY: N
Deploy:
  Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage
    deployments → pencil → Version: New version → Deploy
    (or `scripts/deploy.sh . <dashboard-deployment-id>`)
  CDR Import: `cd apps-script/cdr-import && clasp push -f`
    (or `scripts/deploy.sh apps-script/cdr-import <cdr-import-deployment-id>`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

REGRESSION SCENARIOS: NOT WALKED — every scenario overlapping these files is a
live-environment walk (deployed web app + real spreadsheet + browser), none of
which exist in this container. Recorded rather than assumed. The ones that
specifically overlap the changed behavior and must be walked after deploy:
- S1  (manager loads own-dept dashboard) — Department Dashboard — computeSummary_ path
- S2  (admin switches departments) — still un-walked from increment 70
- S4  (Missed Calls section) — shares the missed:v17 compute
- S6  (Source column + roster-only totals) — totals row changed basis
- S20 (Alerts preview + send) — alertRowsForDate_ rewritten
- S21 (Alerts daily trigger install/uninstall) — same
- S28/S33/S34 (Pipeline Health rows / integrated DQE build) — new :CSR guard row
- S29 (Manager Digest install + preview) — computeDigestWowDriver_ rewritten
- S31 (Orphan Fix end-to-end) — computeOrphans_ rewritten
- S35 (Phase D totals parity) — the combined-view totals basis changed
- S43 (Combined-view CSV export) — same
Plus the three checks proposed in the Stage-3 review (S44 cross-surface
reconciliation, S45 coverage-chip truth, S46 group-collapse by keyboard);
S44 should now show all four surfaces AGREEING, which is the point of S2-0.

FOLLOW-ON ITEMS:
- S2-1 (sub-queue group header announces role="button" + aria-expanded but
  ignores Enter/Space; also violates S39's documented "rows carry tabindex but
  deliberately NO role=button" convention). Selected out of this session's
  scope. S ≈ 1h.
- B-3 (digest/alert run outcomes absent from the Health page; a zero-subscriber
  digest records `ok ... sent 0 of 0` — the O-9 pattern, unfixed for digests).
- B-5 (queue-sentinel rows bypass the work-window filter that agent rows apply,
  so the queue-only abandoned section is ~30 min wider at the start than the
  per-agent section beside it).
- B-6 (combined-view meta describes only the primary dept — now partly moot
  while the gate is off, but returns with it).
- Dead code from the pre-implementation sweep, untouched: escRowDepartment_,
  yesterdayIso_, typeOfCell_, cdr-report's pullReportData; plus five
  `_`-suffixed "editor-run" diagnostics the Run picker structurally cannot show
  (diagnoseDate_, diagnoseTimes_, dumpCell_, diagnoseAbandoned_,
  invalidateAuthCache_) which want one-line wrappers, not deletion.
- Phases 3 (Missed) and 4 (IR/Insights) of the queue split, plus Overview and
  Alerts, remain all-queue. They are now the precondition for setting
  QUEUE_SPLIT_SCOPE=dept.

DOCUMENTATION UPDATES NEEDED:
- DONE in this session: CLAUDE.md's DQE read-back bullet (the false "ALL DQE
  readers are now cut over" claim) and its force-path guard bullet (the stale
  CSR exemption); NeonRead.gs's header claim.
- STILL NEEDED: CLAUDE.md's queue-split bullets do not yet mention
  QUEUE_SPLIT_SCOPE at all — the "DQE col AI" gotcha and the sub-queue Phase 2
  section both still read as though narrowing is unconditionally on.
- STILL NEEDED: a new Operator State item for QUEUE_SPLIT_SCOPE (what it does,
  why it defaults off, the precondition for flipping it) — it is a new operator
  input and the checklist is the documented home for those.
- STILL NEEDED: INV-30's entry should note the summary key's queue-split scope
  suffix alongside the read-source suffixes.
- Suggest running /sync-docs to land these four.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
