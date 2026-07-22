# Fix History — the "why" archive

**This is the historical fix log. It is NOT a source of live rules.**

The project keeps two surfaces:

- **CLAUDE.md = current invariants / live truth.** The rules you must follow
  now: the Invariant Library (`INV-01`…`INV-55`), the Common Gotchas *rules*,
  Key Design Decisions, the Operator State Checklist, and the Cycle Workflow
  Config. If a rule governs how you write code today, it lives in CLAUDE.md.
- **This file = the historical fix log.** The commit-by-commit "why": what each
  short fix code (`F-2`, `IMP-7`, `CORE-3`, `RPT-1`, `OPS-7`, `NEO-1`, …) fixed,
  and a pointer to the CLAUDE.md invariant / gotcha the fix produced. Read this
  when you hit a code in a comment or in CLAUDE.md and want the backstory —
  **not** to learn a current rule.

**How to use it:** codes are terse on purpose. To find a code's full narrative,
`grep -n "<code>" CLAUDE.md docs/*.md apps-script/**` — the live rule is in
CLAUDE.md; the reasoning is here or in `docs/known-issues.md`. When a fix code's
rule changes, update CLAUDE.md; leave the history entry as-is (it's an archive).

> Migration note: this file was introduced by splitting the fix-narrative out of
> CLAUDE.md's prose. CLAUDE.md still contains the interwoven narrative for each
> bullet (removing it in place is a separate, higher-risk edit); this index is
> the browsable, drift-reconciling companion so a code can be looked up without
> reading 2,500 lines. It is intentionally **excluded** from
> `tests/unit/cache-version-sync.test.js`'s `DOC_FILES` list, because it
> references past cache versions (the "from" side of `vOLD → vNEW` bumps) that
> would otherwise fail the sync guard.

---

## Code taxonomy (read this first — the families overlap and collide)

| Family | Meaning | Where the live rule lives |
|---|---|---|
| `INV-01`…`INV-55` | **Current invariants.** Not history — the live contract. | CLAUDE.md → Cycle Workflow Config → Invariant Library |
| `F-2`…`F-56` (**dashed**) | Dashboard bug fixes / hardening from cycle + audit passes | CLAUDE.md Common Gotchas / INV-## |
| `F1`,`F2`,`F4`… (**bare, no dash**) | The Neon read-back / feature-flag / router family. **A DIFFERENT family from `F-2`, `F-4`** — see the collision note below | CLAUDE.md F1 gotcha / Operator State #19 |
| `IMP-4`…`IMP-11` | Neon **im**port-mirror write discipline | CLAUDE.md "Neon write discipline" gotcha, INV-16 |
| `CORE-1`…`CORE-7` | The CORE hardening pass (auth gates, cache-source suffix, config parity) | various INV / Operator State |
| `DEEP-1` | Companion to CORE-1 (signed-in gate) | Key Design Decisions (auth) |
| `RPT-1`…`RPT-7` | **R**e**p**or**t** semantics rulings | INV-05/25/48, INV-30 report keys |
| `OPS-1`…`OPS-9` | **Op**erational: watchdog / backup / digest / alerts | Operator State #22/#23/#28, INV-34/45 |
| `NEO-1`…`NEO-6` | Escalations + Neon-read-health hardening | INV-55, Operator State #20 |
| `TST-7` | Test / deploy gating | Key commands, Operator State #2 |
| `M1`,`M2` | companyOverview v16 population-scoping fixes | INV-30 companyOverview, INV-51 |
| `E2`…`E10` | **Phase E** UI surfaces (commit 94bbca9 + follow-ons) | CLAUDE.md "Phase E UI surfaces", INV-33/34/51 |
| `S1`…`S38` | **Regression Scenarios** (Cycle Config) — but a few inline `S#` are batch-step codes, see below | Cycle Workflow Config → Regression Scenarios |
| `Phase A`–`E`, `Phase 1`–`15`, `Phase D`/`D+1`, `Batch E`/`F` | Redesign / rollout phases named in commit narratives | commit messages + CLAUDE.md prose |

### ⚠ Two collisions that WILL confuse you

1. **Dashed `F-#` vs bare `F#` are different families.** `F-2` (the AD/AE/AF
   pairing fix) has nothing to do with `F2` (the dup-guard Neon self-heal).
   `F-4`/`F4`, `F-5`/`F5` likewise collide. Always preserve the dash (or its
   absence) when grepping.
2. **`S#` is overloaded.** `S1`…`S38` in the Cycle Config are **Regression
   Scenarios**. But inline prose uses `S5` for the *holiday layer*
   (`COMPANY_HOLIDAYS`, Operator State #27), `S1(c)` for `discoverInboundQueues_`
   (INV-54), and `S35` both as a fix reference *and* as Regression Scenario 35
   (Phase D totals parity). Disambiguate by context.

---

## `F-#` (dashed) — dashboard fixes & hardening

| Code | What it fixed / changed | Live rule |
|---|---|---|
| `F-2` | `buildDQEHistoricalData` emits AD/AE/AF from ONE chronologically-sorted missed-leg list; unpairable abandoned parents appended to AD (no AE/AF partner) so the id SET is unchanged | "DQE cols AD/AE/AF are POSITIONALLY PAIRED" gotcha; INV-16 |
| `F-3` | `Direct Call History` refresh-in-window: date-string coercion made the delete a silent no-op → fixed via `dcDateIso_` + `getDisplayValues` | number-coercion gotcha (date-shaped strings) |
| `F-4` | `getCallJourney` manager fallback gated server-side by `callIdInDeptMissedReport_` (dept entitlement re-derived from the manager's own Missed report) | inbound-capture gotcha; INV-55-adjacent |
| `F-5` | (a) `computeThresholdDrift_` counts only ASSESSED days; (b) `computeOverviewPipelineFreshness_` requires `rows>0` (no-op build ≠ fresh) | threshold-drift gotcha; Operator State #11; INV-44 |
| `F-6` | Daily alerts/digests assess the previous BUSINESS day (old check tested the DATA date's dow → fired Friday's on Saturday, skipped Monday) | INV-33, INV-45 |
| `F-10` | `inboundCallsExport` refresh-in-window uses `ic_cellDateIso_` ISO-display compare (same coercion class as F-3) | number-coercion gotcha |
| `F-14` | `companyOverview:v18` stopped the 30-day snapshot window filter from also truncating the MTD violation accumulation | INV-30 companyOverview; INV-51 |
| `F-15` | QCD daily axis unions sub-queue-only dates; inherited by Insights `queueHealth.trend` (insights v17) | INV-30 insights/qcd; qcd-report.test |
| `F-20` | Deferred mirror per-date reads are a bounded tail-scan (`nmReadDateRowsTail_`, `NEON_MIRROR_TAIL_ROWS`) instead of O(full history) | deferred-mirror gotcha; Operator State #22 |
| `F-22` | `renameHistoricalAgent_` re-verifies the agent column + row count immediately before writing (cross-project daily-build race mitigation) | public-write-paths gotcha; INV-01 |
| `F-24` | `sanitizeAbandonedCellForNeon_` pinned byte-identical across `neonbackfill.js` / `NeonMirror.js` by the function-level check in `check-duplicated-files.sh` | INV-16; number-coercion gotcha |
| `F-28` | `getLatestDataDate`/`getLatestDataDates` signed-in gate ACTUALLY implemented (an earlier commit message claimed it without shipping it) | Key Design Decisions (auth); INV-01 |
| `F-29` | Totals-row ATT / Avg Abd Wait / CSR Avg Abd Wait exclude ZERO rows (`avgNonzero_`, `summary:v11`) so idle roster agents don't drag dept averages | INV-30 summary |
| `F-30` | Removed the dead `ADMIN_EMAILS_DISPLAY` constant; membership + contact resolve via `getAdminEmails_()` | admin-emails gotcha; Operator State #13 |
| `F-31` / `F-32` | `individual:v10`: the EMPTY-shape `trendData` filtered to roster members; a CUSTOM prior window overlapping the range counts overlap days to the CURRENT window only | INV-30 individual; INV-49 |
| `F-34` | `missed:v13`: `meta.abandonedRings` counts AGENT rings only (sentinel rows no longer inflate it) | INV-30 missed |
| `F-35` | IR/Insights hard-require the DQE sheet only when it IS the read source, so the Neon path survives a trimmed/archived sheet | F1 read-back gotcha; Operator State #19 |
| `F-36` | QCD all-dept grand-total dedups a double-mapped queue by name (no double-count) | INV-51; qcd-report.test |
| `F-43` | `resolveEscalation` is PENDING-ONLY (pending_review + rejected refused too) — with `NEO-1` | INV-55 |
| `F-44` | `escCleanDateTime_` strict validation so a malformed `occurred_at` stores NULL instead of throwing at Postgres. **RESOLVED (L6): a UTC round-trip now rejects impossible calendar dates (`2026-02-31`, non-leap `2026-02-29`) too, so they store NULL.** | INV-55 |
| `F-45` | `escAssertRowAccess_` — the dedicated row gate: managers match the row's STORED dept; admins pass unconditionally (so a renamed/retired dept doesn't orphan admin access) | INV-55 |
| `F-46` | `getEscalations` capped at `ESC_MAX_ROWS=500` newest + `meta.truncated` | INV-55 |
| `F-56` | `check-duplicated-files.sh` now also fails when a file is MISSING from a duplicated pair (not just when the two differ) | INV-16; Key commands |

## `F#` (bare) — Neon read-back / feature flags / router

| Code | What it introduced / fixed | Live rule |
|---|---|---|
| `F1` | Neon DQE read-back, flag-gated by `DQE_READ_SOURCE` (default `sheet`); `NeonRead.gs` DAL | F1 read-back gotcha; Operator State #19; CORE-3 |
| `F2` | Dup-guard re-mirrors existing sheet rows to Neon on a non-force re-import (mirror self-heal); also names the `expectedDate` write-guard (with `IMP-7`) | INV-16; Neon-mirror gotcha |
| `F4` | `buildDQE:neon` Pipeline Health FAILURE row when the sheet build succeeds but the per-date Neon mirror is unreachable/errors | INV-44; Operator State #19 |
| `F5` (bare) | Same fix pair as dashed `F-5` is cross-referenced here in prose: `rows:0` success ≠ fresh; threshold-drift assessed-days | threshold-drift gotcha; Operator State #11 |
| `F8` | Insights `queueHealth = {error:true}` renders a client "unavailable" note instead of silently hiding (with `RPT-3`: don't cache the error payload) | INV-30 insights |
| `F9` | `processIntegratedHistory:Inbound` writes a Pipeline Health FAILURE row on Neon-unreachable/error (inbound has no sheet fallback) | INV-44 |
| `F11` | Router quietly no-ops an admin-only deep link for a non-admin (no error-modal flash) | top-tab router gotcha |
| `F12` | Insights custom-prior overlap days count to the CURRENT window only; auto/YoY priors are disjoint so `priorOverlap` is always false there | INV-30 insights; INV-28 |
| `F29` | Keep-warm pings via `getDashboardNeonConn_({skipReadHealth:true})` so a warm-ping blip can't pollute the DQE read-back health line | Operator State #20 |

## `IMP-#` — Neon import-mirror write discipline

| Code | What it fixed | Live rule |
|---|---|---|
| `IMP-4` | `call_history_phones` children written per-parent DELETE-then-insert (each payload row carries the parent's COMPLETE entry set) | Neon write discipline gotcha |
| `IMP-5` | Authoritative per-date replace for callers whose payload is the COMPLETE set (`{authoritative:true}` DELETEs the dates in-txn before insert) — kills phantom rows | Neon write discipline gotcha |
| `IMP-6` | Duplicate conflict-key rows deduped last-write-wins before insert; deferred mirror parks a hard-erroring date after `NEON_MIRROR_MAX_ATTEMPTS` with `neonMirror:gave-up` | Neon write discipline; Operator State #22; INV-44 |
| `IMP-7` | `buildDQEHistoricalData` THROWS on an `expectedDate` mismatch (routes into each caller's failure plumbing + email) instead of a silent return. **RESOLVED (M2): the sibling early-returns (empty Raw Data / no valid dates / zero rows) now throw too, gated on a new `opts.force` so only a force re-import (rows pre-deleted) alerts; the non-force F5 rows:0 path is unchanged.** | INV-16 |
| `IMP-11` | A date whose `Call_Legs_*` sheet was pruned before it drained hard-fails the deferred mirror; the `gave-up` email says the inbound rows are unrecoverable rather than silently dequeuing | Operator State #22; INV-44 |

## `CORE-#` / `DEEP-1` — core hardening pass

| Code | What it fixed | Live rule |
|---|---|---|
| `CORE-1` / `DEEP-1` | `getLatestDataDate`/`getLatestDataDates` carry a signed-in gate (the F-28 commit had claimed it without shipping) | Key Design Decisions (auth) |
| `CORE-2` | `computeActiveAgentsInRange_` picker subset survives a trimmed/archived sheet on the Neon path | Operator State #19 |
| `CORE-3` | Report cache keys suffixed with the active DQE read source (`:sheet`/`:neon`) so a `DQE_READ_SOURCE` flip can't serve a cross-source blob. **RESOLVED (L1): `individual:`/`insights:`/`missed:` are now suffixed too (were the last unsuffixed cutover readers).** | INV-30 |
| `CORE-5` | Alert / Digest / Dept-config compare gates read Neon directly and return `clean:false`+`error` on unreachable (never a false "PARITY CLEAN") | Operator State #25 |
| `CORE-6` | Dept Config save accepts a dept's own current effective queue even if it went quiet >180 days (so a saved row stays editable) | INV-54; scenario S36 |
| `CORE-7` | `sheetSafeCell_` neutralizes formula-leading cells on OrphanFix/Access-Control sheet writes. Pinned by `util.test.js`. **RESOLVED (L4): Access-Control `email` + `department` are now routed through it too (`acIsValidEmail_` admits a formula-leading address).** | INV-01 |

## `RPT-#` — report semantics rulings

| Code | Ruling | Live rule |
|---|---|---|
| `RPT-1` / `RPT-2` | Missed report processes AD/AF BEFORE the zero-slot early-continue; AF↔AD paired via a per-time-key FIFO (two missed legs in the same second keep distinct parent ids) | INV-30 missed (`missed:v14`) |
| `RPT-3` | An error-shaped `queueHealth` payload is NOT cached (transient failure never pinned for the TTL) | INV-30 insights |
| `RPT-6` | The Overview tile's weighted ATT vs the My-Dept table's simple-mean ATT may disagree — intended (tile = rollup, table = row-level), owner ruling | ATT-semantics gotcha; INV-05/25 |
| `RPT-7` | WoW driver narrative is dominance-based (larger of \|answeredDelta\|/\|missedDelta\| names the driver; ties → 'answered') | INV-48 |

## `OPS-#` — operational (watchdog / backup / digest / alerts)

| Code | What it fixed | Live rule |
|---|---|---|
| `OPS-1` | Ingest watchdog arms its per-episode flag ONLY on a CONFIRMED send (a mail-quota failure retries next run instead of silencing the episode) | Operator State #23 |
| `OPS-2` | `sendDigestsForCadence_` holds the shared lock only long enough to CLAIM the run via a marker, then releases before the (expensive) sends | INV-45 |
| `OPS-4` | Neon backup fetches months in ~week-sized windows; a month over the file budget is written as `partN` files | Operator State #28 |
| `OPS-5` | When `CONFIG_SOURCE=neon`, the backup run also snapshots the Neon-authoritative `dept_config`/`alert_config`/`digest_config` | Operator State #28 |
| `OPS-6` | Digest unrecognized/blank cadence is FLAGGED (`invalidCadence`) not dropped — renders a "⚠ invalid" chip instead of vanishing | INV-45 |
| `OPS-7` | Watchdog credits 24h of staleness allowance per weekend/holiday day inside the gap. **RESOLVED (LM1): the freshness scan window widened 40 -> 250 (`OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS`) so a deferred-mirror retry storm can't evict the DQE row and force the null-freshness false-alarm. (Residual: an extreme sustained storm could still evict within 250.)** | Operator State #23 |
| `OPS-9` | Alert Config duplicate same-dept rows deduped FIRST-ROW-WINS (parser flags later rows `duplicateRow`; run loop skips them) | INV-34 |

## `NEO-#` — escalations + Neon-read-health hardening

| Code | What it fixed | Live rule |
|---|---|---|
| `NEO-1` | `resolveEscalation` refuses `pending_review` + `rejected` too (pending-only) — with `F-43` | INV-55 |
| `NEO-2` | A blank resolve-comment PRESERVES the stored comment (COALESCE); `updateEscalationComment` is worklist-only (pending_review/rejected refuse annotation) | INV-55 |
| `NEO-3` | Neon read-health recording is opt-IN (`{recordReadHealth:true}`, passed only by the three DQE read-back readers) — non-DQE Neon surfaces don't pollute the line | Operator State #20 |
| `NEO-5` | Inbound unmapped-dept short-circuit consistency across the inbound surfaces. **NOT in CLAUDE.md prose** (code-only). | InboundReport.gs |
| `NEO-6` | Resynced the Inbound vs Direct dormant manager-auth branches (Direct cleared `'ALL'` before the manager check; Inbound threw). **NOT in CLAUDE.md prose** (code-only). **Audit S2-7 (DEFERRED): these branches are unreachable + untested and can re-diverge -- deferred until the Inbound/Direct reports are released to managers (a one-line gate removal), at which point add a parity test.** | InboundReport.gs / DirectCallReport.gs |

## `M#`, `E#`, `TST-7`

| Code | What it is | Live rule |
|---|---|---|
| `M1` / `M2` | `companyOverview:v16`: hero volume scoped to the on-roster non-hidden population (M1); a double-mapped QCD queue attributed to EVERY dept that lists it (M2) | INV-30 companyOverview; INV-51 |
| `E2` | Phase E: work-window pill (`__WORK_WINDOW__` template inject) | Phase E UI surfaces; INV-06 |
| `E3` | Phase E: Diagnostics severity chip | Phase E UI surfaces |
| `E4` | Phase E: `excludedFromTeamAvg` flag on the IR response (`individual:v6`→`v7`) | Phase E; INV-26 |
| `E5` | Phase E: per-row WoW delta chips on the agent table | "Per-row prior-period chips" gotcha |
| `E8` | Phase E: Alert Config Skip Dates column (daily-trigger only) | INV-33 / INV-34 |
| `E9` | Phase E: QCD days-to-violation 7-day forecast | INV-51 |
| `E10` | Phase E: threshold-drift "Last 30 days" chip on the Alerts config table | threshold-drift gotcha |
| `TST-7` | `scripts/deploy.sh` gates the push on `npm run ci` (tests + INV-16 guard); `DEPLOY_SKIP_CI=1` for emergencies | Key commands; Operator State #2 |

## `OPS-8` — code-only (not in CLAUDE.md)

`OPS-8` names the System Health outcome classifier convention (a healthy result
starts with `ok`; the row is amber only on `fail|error|unreachable|skipped`).
It lives in `SystemHealth.gs` comments/tests, not CLAUDE.md.
**RESOLVED (M1): the NeonBackup summary now LEADS with an `ok`/`FAILED` status
token so the start-with-`ok` classifier is correct for it too (it previously
started with a table name + always contained "skipped", painting the backup
Health row amber on every run and masking real outages). Pinned by
`system-health.test.js`.**

---

## `P-#` / `O-#` — broad-scan Batch 1+2 (2026-07-17)

Findings from the 2026-07 three-stage broad scan, implemented in the
"Batch 1+2" commit. `P-#` = **p**ipeline (cdr-import/cdr-report); `O-#` =
dashboard **o**ps engines. **NB: `O-#` is a DIFFERENT family from `OPS-#`**
(the earlier watchdog/backup/digest pass) — the same collision class as
dashed-`F-#` vs bare-`F#`.

| Code | What it fixed | Where the live rule lives |
|---|---|---|
| `P-1` | Inbound authoritative DELETE trusted payload-derived dates; a stray D-1 carry-over leg wiped D-1's `inbound_calls` rows. `expectedDateIso` pins the delete + drops strays. | Neon write discipline rule (4), CLAUDE.md |
| `P-2` | External-only NOP cells bypassed IMP-12 PHI masking (`join()` omitted the `\|` separator; parser treated pipe-less cells as internal). Producer always emits the separator; parser hashes phone-shaped entries on BOTH sides. | known-issues.md IMP-12/P-2 section |
| `P-3` | Force re-import deleted 5 sheets' rows BEFORE validating the source; an empty/corrupt source destroyed the date then threw. Source read+validate now precedes the delete block. | Force-path guard convention (M2) bullet, CLAUDE.md |
| `P-4` | Direct-call build stamped the whole day with the grid's first-row date (no F2 guard); a stray first row mislabeled + wiped D-1. `opts.expectedDate` refusal, both callers pass it. | Direct-extension metrics bullet, CLAUDE.md |
| `P-5` | `writeDirectCallRowsToNeon_` early-returned on empty rows before its date-DELETE while the sheet writer cleared the date — permanent sheet/Neon divergence on goes-to-zero force re-imports. | Direct-extension metrics bullet, CLAUDE.md |
| `O-1` | Queue-report send loop had no per-recipient isolation; a mid-list mail failure re-blasted earlier subscribers every 30-min poll while later ones never got it. Isolated + marker-on-partial-success + `notifyQueueReportSendFailures_`. | Operator State #31 |
| `O-2` | Digest run-claim marker armed pre-send made a TOTAL failure unrecoverable for the day; now cleared on zero-success + `DIGEST_LAST_RESULT_<cadence>` surfaced in the modal. | INV-45 OPS-2/O-2 paragraph |
| `O-3` | An Alert/Digest Config Department matching no roster header silently un-monitored the dept forever (perpetual `no-data` / all-zero digest). Alerts: `error` outcome + "⚠ unknown dept" chip; digests: skip + admin notify. | INV-34, INV-45, Operator State #12 |
| `O-4` | Hand-edited duplicate subscriber rows double-sent digests / queue reports. OPS-9 first-row-wins dedup + `duplicateRow` flag + modal chips (Digest Config key = email+dept; Queue Report Subscribers key = email). | INV-45, Operator State #31 |
| `O-7` | A day whose QCD landed after the send window closed was silently never reported. Post-window polls flag it ONCE (`QUEUE_REPORT_LAST_MISSED` + MISSED result + one admin email). | Operator State #31 |
| `O-8` | Alerts modal defaulted to calendar yesterday — every Monday opened on Sunday (guaranteed all-`no-data` preview). Now `prevBusinessDayIso_`. | INV-34 |

**Batch 3+4 (same scan, second implement pass).** `R-#` = dashboard report
endpoints (NOT the `RPT-#` semantics-rulings family); `A-#` = auth/admin-path
findings.

| Code | What it fixed | Where the live rule lives |
|---|---|---|
| `R-1` | The Overview QCD chips, My-Dept QCD panel, and freshness-pill QCD component were hard-wired sheet scans -- flipping `QCD_READ_SOURCE` stranded them on an aging sheet. All three now route through `readQcdGrid_` / `neonGetMaxQcdDate_` with sheet fallback. | Operator State #30, INV-30 (`latestDates` combined suffix) |
| `R-2` | Caller Lookup truncation kept the OLDEST 200 of the fetched newest-201 (ascending re-sort + head-slice), dropping the caller's most recent call. Tail-slice now. | NEO-4 note in code |
| `R-3` | The allDepts manager threw on every journey drill (`getCallJourney` compared against a null `user.department`); latent same-pattern in the inbound/direct resolvers. Pinning is `manager && !allDepts`; the F-4 fallback entitles `allDepts` like admins. | Role-model gotcha (widening note) |
| `A-1` | `applyOrphanRename` with `alsoAddAlias` could throw in `upsertAgentAlias_` AFTER the irreversible rename but BEFORE the audit append. The Agent Alias Overrides sheet is now pre-flighted alongside the Log. | INV-01 / OrphanFix "audit before returning" (claim holds again) |
| `A-2` | `escRowFull_` never selected `occurred_at`, so approve-path notification emails always dropped their "When" line. | INV-55 |
| `A-3` | Dept Config effective map was last-row-wins while the save editor edits the FIRST match -- a hand-edited duplicate made modal saves silently ineffective. First-ACTIVE-row-wins now (OPS-9 convention). | INV-54 (accessor comment) |
| `A-4` | `approveEscalation` had no known-dept check despite the header's mitigation list claiming one -- a typo-dept submission entered a worklist no manager could see. Refused with a reject-and-resubmit message. | INV-55 |
| `O-5` | System Health's expected-sheets list stopped at nine and its trigger/outcome inventory omitted the queue-report engine; the OPS-8 classifier also learned the `^MISSED` prefix. | Operator State #31 |
| `O-6` | PipelineWatch advanced its watermark past rows evicted from the 300-row tail by a retry storm, silencing those failures forever. Clipped tails widen x4 (bounded) via `pipelineWatchTailClipped_`. | Operator State #32 |
| Gap #3 | External `pending_review` submissions could sit unseen (no dashboard event fires on a direct Neon INSERT). Count-only PII-free hourly ping via PipelineWatch, `NOTIFY_PENDING_REVIEW` flag, OPS-1 watermark. | Operator State #32, INV-55 |

**Batch 5+6 (same scan, third implement pass).** `C-#` = client (script.html);
`T-#` = cdr-report tools. One-liners only -- the full narratives live in
known-issues.md ("Broad-scan Batch 5+6 fixes" + the AD/AE/AF and
date-coercion sections).

| Code | What it fixed |
|---|---|
| `C-1` | Second `#ins-trend-header` writer clobbered the explicit range label -- merged into one writer |
| `C-2` | Tour replay closed HELP while the button lives in SETTINGS -- stranded Settings under the tour |
| `C-3` | Overview mini-table WoW tooltips cited the dept page's prior window -- now their own response meta |
| `C-4`/`C-9` | `escCssId_` stripped quotes (lookups could never match) + raw hash in router selectors threw -- proper escaping both places |
| `C-5` | All-dept QCD CSV title line split on the dateLabel comma |
| `C-6` | `irRenderCharts` empty-datasets early-return left all three chart panels stacked visible |
| `C-7` | `escapeHtml` into textContent double-encoded the Neon-health lines |
| `C-8` | Inbound/Direct runners lacked stale-response tokens -- joined `reportReqSeq_` |
| `T-1` | Duplicate-row merge broke the F-2 AD/AE/AF lockstep -- re-pairs + time-sorts now |
| `T-2`/`T-3` | CDR/QCD backfills wedged forever on an unparseable date cell -- skip + log |
| `T-4` | `abandoned_pct` mixed units -- percent-number convention matching the inline writer |
| `T-6` | Drilldown queue gate used the pre-IMP-8 loose regex -- false verification mismatches |
| `T-7` | Stale diagnostics panel stranded beyond col 40 -- full-height clear |
| `P-7` | Stale Pending-Archive rows beat a fresh recompute -- replaced when fresh rows exist |
| `P-8` | ISO-text date cells parsed as UTC midnight (previous Chicago day) in the dup-guard/force-delete -- `parseHistoryDateCell_` local-noon |

**All corrective findings from the 2026-07 broad scan are implemented.**
Batch 8 shipped its vetting slice -- `runInboundQcdParityCheck`
(InboundReport.gs), the QCD-vs-inbound reconciliation the un-gating decision
needs; the gates stay ON (owner) and capture-time raw→canonical queue
normalization is DEFERRED (needs an owner-decided raw→canonical mapping
schema -- the alias column maps dept→raw names, ambiguous for multi-queue
depts). Batch 9's flip runbook is consolidated in the README.

**Batch 10 (same scan, strategic pass).**

| Code | What it shipped | Where the live rule lives |
|---|---|---|
| `P-6` | `writeCDRRowsToNeon({authoritative:true})` -- per-date replace for the CDR mirror (children-first delete via the parent-id subselect, then parents, in-txn). Daily inline + deferred `mirrorCdrForDate_` pass it; the bulk post-dedup mirror stays non-authoritative. Was "optional" (call_history_* isn't dashboard-read) but closes the last phantom-row family. | Neon write discipline rule (4), CLAUDE.md |
| Usage review | The Report Usage telemetry finally got a READER: `computeReportUsageSummary_` (SystemHealth.gs) renders a per-report runs / unique users / manager-runs / cache-hit-rate section on the Health page -- the consolidation/un-gating evidence surfaced instead of hand-pivoted. | System Health bullet, CLAUDE.md |
| Smoke | `SmokeCheck.gs::runLiveSmoke` -- editor-run, admin-gated, read-only 7-check sweep of the live read paths with a pass/fail email + `SMOKE_LAST_RESULT` Health row. | System Health bullet, CLAUDE.md |

Remaining strategic work: legacy dqe-report decommission (incl. T-8 onOpen
collision) + the deferred capture-time queue normalization above.

**Owner feedback rounds 4-6 + density design (2026-07-20).** Code comments
carry `R4`/`R5`/`R6` (post-deploy owner rounds -- NOT the Batch-3+4 `R-#`
endpoint family) and `D1-D3` / `#8-#10` (the density-design phases). The
live rules all live in CLAUDE.md; one-liners here for the code→backstory
contract:

| Code | What it shipped/fixed | Where the live rule lives |
|---|---|---|
| R4 (round 4) | Team strip reduced to one row (+per-workday Queue calls sub); Total-calls column folded into the split bar; call-ID/copy + info-line admin-only; Insights no-ring drill gated+counted via a whole-window slice prefetch; 'Missed Rings' rename; ATT trend tab admin-only; Abd% tab styling aligned; Inbound v4 dropped '(unlabeled)'/'(none)' rows | Team-strip/agent-table/consolidation bullets + INV-30 inbound v4, CLAUDE.md |
| R5 (round 5) | missed:v15 queue-only enrichment (waitSec + insurer from inbound_calls); inbound v5 ivr→ivr\|direct stage split + `first_agent` capture + DIAL_IN_LABELS/derived dial-in labels; missed-section frost loader; access-denied Gmail compose; Access Control ALL option + dsConfirm_ | Number-coercion/missed bullets, INV-30 inbound v5, Operator State #33 |
| R6 | Queue-only sentinel attribution by QUEUE NAME (`queuesForDept_`) instead of shared-ext overlap -- cross-dept card leak killed; missed:v16 | "Scope is locked to roster" decision, CLAUDE.md |
| D1-D3 | Insights Simple/Detailed density toggle (role default manager=simple/admin=detailed), popover Advanced collapse, intro card / all-clear line / small-sample guard | Density Phase-1 bullet, CLAUDE.md |
| #8/#9/#10 (density Phase 2) | Saved views + copy share link (SHARE_STATE_ + `view` param); Line⇄Calendar trend renderer over trendDaily; `style:'summary'` Insights email | Density Phase-2 bullet, CLAUDE.md |

(Also from this stretch: the QCD parity gate's ±1s duration tolerance --
write-time float rounding vs Sheets display rounding, Operator State #30.)

**Owner feedback round 7 (2026-07-20).** Three batches (A = bug fixes,
B = visual/UX, C = server/ops); code comments cite `R7 (<id>)`:

| Code | What it fixed / added | Live rule lives in |
|---|---|---|
| A1 / O-1 | ROOT CAUSE of the opaque chart tooltip + flat missed-bar ramp: canvas fillStyle returns HEX for opaque colors, so `rgbaWithAlpha_`'s rgb()-only regex silently no-op'd on THEME tokens; now delegates to `colorWithAlpha_` | INV-41 bullet note, CLAUDE.md; known-issues |
| A2 / O-3 | 'selected'/'My Dept' tile badge + mini-table chip are view-as-aware; instant pre-paint on view-as switch; manager wording 'My dept:' | code (`ovBuildGridTile_`, `applyViewAs_`) |
| A3 / M-1 | Missed-section frost arms at refresh() start (all roles), not only when the missed fetch begins; onError unfrosts | code (`deptMissedFrostArm_`) |
| A4 / M-4 | Queue-calls per-day sub-note only when workdays > 1 | code (`renderDeptTeamStrip_`) |
| A5 / I-1 | Calendar v2: ‹ › month pagination (fixed the fixed-height clipping = "only first month"), 'Abd %' metric (queues tab eligible), visible-but-disabled toggle with reason tooltip | Density Phase-2 #10 bullet, CLAUDE.md |
| A6 / I-3 | Re-runs frost the whole Insights results (SWR paint under it); intro card shows once automatically | Density bullets, CLAUDE.md |
| A7 / N-1 | ↻ Refresh button in the Insights results header (server cache TTL still applies) | code (`#ins-refresh-btn`) |
| A8 / N-2 | Zero-activity agents dropped from both cross-agent charts (cards unchanged) | code (`insAgentHasActivity_`) |
| B1 / O-2 | Global chart animations (400ms easeOutQuart, prefers-reduced-motion off); per-chart `animation:false` opt-outs removed. **As shipped it REPLACED `Chart.defaults.animation`, which broke every chart in prod ("this._fn is not a function") — corrected by R9-6 (mutate keys, never replace)** | INV-41 bullet note (R9-6), CLAUDE.md |
| B2 / M-3 | Missed bars flipped VERTICAL (workday timeline) + vector clock-face watermark (`missedClockWatermark_`) | INV-41 bullet, CLAUDE.md |
| B3 / M-5, I-2 | Sticky context toplines (dept · window + ↻) on My Department + Insights (`initStickyBar_`, IntersectionObserver, fixed-position) — **RETIRED by R9-1** (the banner overlapped the QCD side card and couldn't edit the range; the controls strip / period bar are the sticky elements now) | superseded — see R9-1 |
| B4 / I-4 | seg-rich sub-selector smaller/lighter (accent-soft active); Cards⇄Chart / Gap⇄Absolute one-shot fade | code (`.ins-view-fade`) |
| C1 / M-2 | getCallJourney miss carries `reason` (before-capture / date-gap / not-captured), probed only when the unscoped lookup was entitled | Inbound bullet, CLAUDE.md |
| C2 / G-2 | `runNeonCoverageCheck` — per-date sheet-vs-Neon reconciliation + inbound zero-row weekdays; Health `out-coverage` row | Op State #35 + System Health bullet |
| C3 / G-1 | PipelineWatch aux signals: failed NeonBackup run + read-back streak ≥3, once per episode, OPS-1 markers | Op State #32, CLAUDE.md |
| C4 / G-3 | `UI_FLAGS` admin surface toggles (curated registry, Health editor, CSS + fetch gates, no redeploy) | Op State #34, CLAUDE.md |

**Broad-scan Round 8 (2026-07-21).** Audit findings 1–5 implemented; code
comments cite `R8-<n>` (deliberately NOT bare `F<n>` — that family is taken
by the Neon read-back codes, see the collision warning above):

| Code | What it fixed | Live rule lives in |
|---|---|---|
| R8-1 | Missed report queue-only sentinel match used the QCD-CANONICAL name space while DQE sentinels carry RAW phone-system names — CSR's `A_Q_CSR` no-ring abandons silently vanished (an R6 regression). Match set is now the inbound union `inboundQueuesForDept_` (queuesForDept_ + Dept Config inbound aliases); missed:v17 | "Scope is locked to roster" decision + INV-30, CLAUDE.md |
| R8-2 | Deferred Neon mirror: `mirrorDqeForDate_` read 36 cols (REP-10's 34-col fix never propagated — threw on a width-trimmed sheet) and `mirrorQcdForDate_` fed raw DISPLAY strings into `setInt`/`setDouble` (every drained date would hard-error toward `neonMirror:gave-up`). Now 34 cols + `nmInt_`/`nmPctFraction_` parsing (fractions match the inline writer's units) | Deferred-mirror gotcha, CLAUDE.md; neon-mirror-tail.test.js |
| R8-3 | CORE-7 completion: the two deactivate paths (`deactivateAgentAlias_`, `sheetDeactivateDeptConfig_`) round-tripped the whole block via getValues→setValues, re-arming neutralized formula cells as LIVE formulas; they now write only the Active cell | INV-01 mitigations context; orphan-roster-add / dept-config tests |
| R8-4 | `escAssertRowAccess_` had no `allDepts` branch — the ALL-departments manager could list escalations but not act on any, and activity timelines rendered silently blank | Role-model bullet (R-3 note), CLAUDE.md |
| R8-5 | Client `resolveComparisonWindow_` prevPeriod used `Math.floor` on a local-noon date diff — one day short across spring-forward (INV-28 violation in IR's client-resolved prior window); now `Math.round`, matching the server's `computePriorWindow_` | INV-28, CLAUDE.md |

Batches A+B (the audit's remaining quick-win + correctness tail, same session family):

| Code | What it fixed | Live rule lives in |
|---|---|---|
| R8-A1 | UI_FLAGS `dept-team-strip` CSS hid only the caption (`#dept-team-zone`), not the strip; `ins-queue-health`'s no-ring prefetch still fired while the section was flag-hidden | Op State #34, CLAUDE.md |
| R8-A2 | Direct Neon-mirror skip/error was buried in a SUCCESS row's notes — now a `processIntegratedHistory:Direct:neon` failure row (L7 pattern; unconfigured installs stay silent) | INV-44, CLAUDE.md |
| R8-A3 | Caller Lookup: Enter bypassed the disabled button and the fetch had no stale-response token — overlapping lookups could paint caller A's history under input B | code (`clLookupSeq_`) |
| R8-A4 | Custom Report Builder cleared 40 cols but a 4-category comparison renders 45 — stale columns survived beside fresh reports and parked the T-7 diagnostics panel far right forever | code (`dashboardCDR.js` render clear) |
| R8-A5 | Threshold-drift ignored the OPS-9 `duplicateRow` flag — the LAST duplicate's threshold drove the chip while everything else is first-row-wins | INV-34/E10 context; config-editor-c3 test |
| R8-A6 | PipelineWatch could persist watermark `'0'` (no parseable timestamps) — the next run would treat 0 as real and blast the whole failure backlog | code (`pipelineWatchRecord_`); pipeline-watch test |
| R8-A7 | `insScrollPending_` leaked on Insights failures (scroll-jump on a later unrelated render); Insights CSV "Prior" columns emitted raw seconds / raw floats beside formatted "Current" values | code (script.html) |
| R8-B1 | T-4's unit analysis was inverted — the backfill now stores `abandoned_pct` as a FRACTION matching the inline writer; T-4-era rows heal via force re-import or one-off SQL (DO NOTHING insert can't heal them) | known-issues T-4 entry (corrected) |
| R8-B2 | `addAgentAlias`/`applyOrphanRename` accepted a SOURCE name that is a live roster agent — alias precedence would silently reroute that agent's every future build; new `assertNotOnAnyRoster_` guard (de-roster first for deliberate merges) | INV-01 OrphanFix mitigations |
| R8-B3 | `bulkReport` Script Property was unbounded — crossed the ~9KB ceiling around date ~100 of a bulk run, killing the run after each date on resume; now tail-capped + non-fatal (`saveBulkReport_`, the F2 lastSheets discipline) | code (autoImport.js) |
| R8-B4 | `saveDigestConfigRow` lowercases the email — Neon's exact-case `(email, department)` PK created duplicate rows where the sheet path's case-insensitive match edited one | code (Digest.gs); config-editor-c3 test |
| R8-B5 | `missedEnrichQueueOnlyFromInbound_` inlined cell-derived (date, id) tuples into SQL with hand escaping — the one binding-discipline deviation; now bound `(?::date,?)` params | code (MissedCallsReport.gs) |
| R8-B6 | `mergeDqeDuplicateRows_` interrupted-apply recovery: a crash between the merged-row writes and the deletes used to leave a double-count that a re-run COMPOUNDED; the apply now detects already-merged groups (multiset containment of slot/AD tokens) and deletes leftovers without re-summing — also dedupes byte-identical double-append rows instead of doubling them; counts-only groups stay unverifiable (logged caution) | sheet-repairs-merge tests; docblock in sheetRepairs.js |

Batches C+D (sheet-retirement outage sweep + recurrence-prevention tooling):

| Code | What it fixed / added | Live rule lives in |
|---|---|---|
| R8-C1 | IR / Insights / Missed cached the OUTAGE-empty shape (Neon unreachable + no sheet) for the 30-min TTL — the empty return now carries `meta.sourceUnavailable` and every cache-put site skips it (the Inbound/Direct unavailable-not-cached discipline); reachable-empty (LM2) stays cacheable | INV-30 discipline; dal-cutover tests |
| R8-C2 | `getLatestDataDate` cached the `__none__` negative sentinel after a FAILED neon read with no sheet fallback — negative now caches only when no primary source failed (the F6 discipline) | code (Data.gs); dal-cutover tests |
| R8-C3 | `insightsQueueHealth_`'s QCD-sheet pre-check is source-aware — with `QCD_READ_SOURCE=neon` a trimmed QCD sheet no longer silently hides Queue health (the F-35 treatment, applied to QCD) | code (InsightsReport.gs); insights-report test |
| R8-C4 | A THROWING Dept Config sheet read (vs the documented absent-sheet fallback) is now flagged (`deptConfigReadFailed_`) and the four QCD-embedding cache puts (summary / insights / companyOverview / qcdAll) skip pinning that request's constant-only view | INV-54 context; dept-config tests |
| R8-D1 | Cross-file width tripwires (`cross-file-pins.test.js`): NeonMirror's DQE/QCD read widths + the merge repair's read width extract-and-compare against the Config.gs schema constants — the REP-10/R8-2 drift class now fails CI | tests/unit/cross-file-pins.test.js |
| R8-D2 | UI_FLAGS registry↔CSS↔markup parity test: every `UI_FLAG_SURFACES` key must have a CSS hide rule and every rule target must exist in the markup/client — missing-rule and stale-target drift now fails CI (the R8-A1 class; a rule targeting the WRONG-but-existing element still needs eyes) | tests/unit/cross-file-pins.test.js |
| R8-D3 | IR prevPeriod comparison resolves SERVER-side: the client sends `priorMode:'prevPeriod'` and `getIndividualReport` resolves via the canonical `computePriorWindow_` (INV-28) — removes the duplicated client math whose drift caused R8-5; YoY/custom stay explicit dates | INV-49, CLAUDE.md; individual-report tests |
| R8-D4 | DQEdrilldown's `canonicalize_` gained INV-24's strip+flatten UNION — the verification sidebar now canonicalizes the same names the build does (paren-carrying feed names matching via FLATTEN no longer read as false mismatches) | code (DQEdrilldown.js) |

Batch E (ops tail + doc sweep) + R8-N (capture-time queue normalization):

| Code | What it fixed / added | Live rule lives in |
|---|---|---|
| R8-E1 | NeonBackup: a shrinking parts-month now trashes higher-numbered stale `.partN.jsonl` files (restore can't duplicate/resurrect rows; the month no longer freezes closed with a stale part) | code (NeonBackup.gs) |
| R8-E2 | Slot-repair PREVIEW restores each group's number formats immediately (per-group, the REP-9 discipline) — an abnormal exit can no longer persist the numeric lens across K-AC | code (sheetRepairs.js) |
| R8-E3 | `exportInboundCalls` refresh-in-window deletes only the DATES the Neon fetch returned — interior dates Neon lost keep their fallback-copy rows | code (inboundCallsExport.js) |
| R8-E4 | `runBatch` restores the live report's date cell after EVERY day (execution-ceiling kills skip finally blocks); malformed Neon Mirror Queue rows are dropped with a log line instead of living forever | code (emailDailyReport.js / NeonMirror.js) |
| R8-E5 | Operator State #8 reworded: uninstalling the cdr-report safety-net DQE trigger is a CORRECTNESS step (cross-project write race can freeze a partial day), not just redundancy cleanup | Op State #8, CLAUDE.md |
| R8-E6 | Doc-drift sweep: architecture.md (migration COMPLETE label, root-clasp layout, missing dashboard files), conventions.md (IR is the last floater-surfacing report), .claspignore comment, INV-16 guard doc (checks BOTH sanitizers), Op State #14 raw-name pointer, known-issues R8-1 cross-ref, and the STALE "drilldown endpoint is dormant" claim (Phases 2–4 shipped long since — `insQhMissedDrill_` / `heatCellToggleDrill_` / `missedSliceListHtml_`) | the corrected docs |
| R8-N | Capture-time queue-name normalization (the two-name-space root-cause fix, option 1): Dept Config inbound aliases accept `raw=canonical` pairs; cdr-import's `icQueueCanonicalMap_` reads them cross-project and `writeInboundCallsToNeon` writes canonical `entry_queue`/`final_queue` on every capture path (journey stays raw; union predicates kept as belt-and-suspenders; save-validated; best-effort = raw on any failure) | known-issues two-name-spaces entry + INV-54, CLAUDE.md |

**QV — Daily Call Queue Report visual second pass (2026-07-21, owner-approved
design handoff; presentation + two mail endpoints, no compute/CSV/print-content
change).** Code comments cite `QV-<n>`:

| Code | What it shipped | Live rule lives in |
|---|---|---|
| QV-1 | 5%-threshold tick on the all-dept split bars (opt-in `{tick:true}`; positioned at answered%+5 since the bar is share-of-total; hidden >95% answered; `qcd-screen-only`, stripped from the print clone) | INV-51 QV note, CLAUDE.md |
| QV-2 | Dept banner rows: binary health rail (warn ≥5%/violations, sage, muted-empty — no invented amber band per the benchmark convention), 16px name, light tint, right-aligned calls·abandon% mini-summary (screen-only) | INV-51 QV note |
| QV-3 | Company-abandon% hero tile in the verdict band (0–10% target bar, 5% tick, "N of M calls lost" from `grandTotals`); sparklines deliberately OMITTED (no trailing series in the data path — a future server extension) | INV-51 QV note |
| QV-4 | "Email me this report" — `sendQcdAllDeptEmail`: caller-only, displayed range, signed-in gate matching the report (the `sendInsightsReportEmail` precedent) | Op State #31, CLAUDE.md |
| QV-5 | Admin-only "Send to subscribers…" — `sendQcdAllDeptToSubscribers`: single-day, O-1 isolation reused, claims `QUEUE_REPORT_LAST_SENT` only for the gate's current target day with ≥1 delivery; never writes LAST_RESULT | Op State #31, CLAUDE.md |

**Owner feedback round 9 (2026-07-21, post-deploy testing notes).** All
client-only; code comments cite `R9-<n>`:

| Code | What it fixed / added | Live rule lives in |
|---|---|---|
| R9-1 | Retired the R7 B3 sticky context BANNERS (`initStickyBar_`, `.page-sticky-bar`) — they overlapped the QCD side card and duplicated the range read-only. The REAL controls are sticky now: `#dept-page .controls` and `#ins-period-bar` pin via CSS `position:sticky` on an opaque strip (z 60, above `.dept-side`, below modals), so users change the range from the pinned strip itself | code (styles.html R9-1 block) |
| R9-2 | My Department toolbar matches the Insights convention: Refresh + an "Export ▾" dropdown sit horizontally (`.control-btn-row`); the one-click CSV icon became the `.ir-export-wrap` menu (wrap keeps the `#csv-export-btn` id so the hidden-until-data gating is untouched) | "My Department CSV export" decision, CLAUDE.md |
| R9-3 | Retired the Batch-E "Use these dates" offer chip (`maybeShowDateSyncChip_`/`applyDateSync_`/`.dsync-chip`) — My Department and Insights now SHARE one date window: `adoptSharedWindow_` (setPage) silently adopts the other page's more-RECENTLY-rendered window (`pageActiveWindow_` entries carry a timestamp; newest explicit choice wins; hand-off buttons unaffected) | Insights hand-off bullet (R9-3), CLAUDE.md |
| R9-4 | Escalations first entry painted a blank page until init returned — `escEnsureInit_` now shows the `dsRingsHtml_` loader in `#esc-loading` at fetch start | code (script.html) |
| R9-5 | View-as-manager on Escalations still showed every dept (client list default) — `escLoad_` pins the request dept to `viewAsDept_` and hides the dept filter; exiting view-as restores + reloads. Real managers were always pinned SERVER-side (`getEscalations`); this closes the admin-preview parity gap only | code (`escLoad_` / `applyViewAs_`) |
| R9-6 | "All charts not loading" prod outage: R7 B1/O-2 REPLACED `Chart.defaults.animation` with `{duration, easing}` — Chart.js's `Animations.configure` copies only `Object.keys(defaults.animation)` into each animated-property group, so the stock `type` key vanished, the `colors` group lost `type:'color'`, and the first animated color (theme refresh / SWR repaint / hover) threw `this._fn is not a function` in the SHARED animator, freezing every chart. Fix: mutate `anim.duration`/`anim.easing` on the existing object; reduced-motion = duration 0 (`animation:false` empties the key list the same way). Reproduced + fix proven headless against chart.js@4.4.4 | INV-41 R9-6 hard rule, CLAUDE.md |
| R9-7 | Overview tiles dropped a dept's QCD chips whenever its DQE WoW was null: the QCD caption (`ovBuildQcdCaption_`) was appended from INSIDE `ovBuildWowChip_`, whose `!dept.wow` early-return fired for any dept with zero rung in either 7-day window (`computeWowDelta_`) — exactly the queue-centric low-ring depts (Denials at 50% abandoned, FieldOps' A_Q_FieldOps_Power) whose QCD data matters most; the snapshot was computed + shipped, never rendered. Fix: the hero + grid tile builders call `ovBuildQcdCaption_` independently, same DOM position | code (`ovBuildGridTile_` / `ovBuildHeroTile_`) |

**Owner feedback round 10 (2026-07-21, second testing pass).** Client-only
except R10-5 (summary:v14); code comments cite `R10-<n>`:

| Code | What it fixed / added | Live rule lives in |
|---|---|---|
| R10-1 | Quick-start question chips moved OFF the page tops into the Help modal (`.help-quickstart` / `#help-launcher`; chips close Help via its own close button before navigating — F-42); Help also gained `#help-tour-btn` (the tour's closing step always pointed at Help); the `#ov-launcher` tour step folded into the Help step | Anti-intimidation launcher bullet + tour bullet, CLAUDE.md |
| R10-2 | The QCD side card slid UNDER the R9-1 sticky controls strip while scrolling — `.dept-side`'s sticky top now clears the strip's measured height (`--dept-sticky-h`, published by a ResizeObserver in script.html; 84px CSS fallback) | code (styles.html `.dept-side` + `syncDeptStickyOffset_`) |
| R10-3 | Load animations, aesthetics-only: KPI values count up from 0 (`initCountUp_` — debounced MutationObserver, curated selector list, once per node, numeric/percent text only, reduced-motion off) and bar tracks/fills grow in from the left (`ds-bar-grow` on `.ans-track`/`.dts-track-fill`/`.qcd-hero-fill`/`.ins-cbar-fill`) | code (script.html `initCountUp_`; styles.html R10-3 block) |
| R10-4 | Threshold-aware split-bar red: rows PASSING their standard (92% answer / 5% abandon) render the red segment at 0.35 opacity so healthy rows recede; FAILING rows keep full red + a bold value (`.ans-bar--pass/--fail` on both bar builders) | code (`answeredBarHtml_` / `qcdDailyBarCell_`) |
| R10-5 | My Department team strip gains an answered-weighted **Avg answer** tile (qcd.range.avgAnswer, from QCD Avg Answer display strings) for QCD-mapped depts + a CSR-only **Transfer %** tile (`csrTransfer`: weighted transferred/total from `CSR Transfer Historical Data` — the dashboard's FIRST read of that INV-52 sheet; best-effort null). summary:v13→v14 | INV-30 + hand-off bullet, CLAUDE.md; overview-qcd-snapshot tests |
| R10-6 | The unexplained blank strip under the app header (Insights especially) — the launcher row's reserved space (gone with R10-1) + `.dash-header` margin-bottom trimmed 24→12px | code (styles.html) |
| R10-7 | Missed-calls bar chart stuck small in its slot: `aspectRatio:2` derived height from a possibly-mid-transition width measurement — bars now render in a fixed-height wrap (`.missed-chart-hwrap--bars`, 320px) with `maintainAspectRatio:false` and the bars-mode 960px section cap removed; radar unchanged | INV-41 Track A note, CLAUDE.md |
| R10-8 | Daily Call Queue Report polish: Watch/On-track callout RETIRED (rows are color-coded + the violation tile carries the count), verdict tile values 24→32px, hero value 42px + thicker labeled target bar ("5%" caption on the tick) + min-width fill, dept banner mini-summary 11px-muted → 13px with the abandon% bold + row-toned (`.qcd-mini-pct`) | code (`qcdAllDeptVerdictHtml_` + styles.html R10-8 blocks) |
| R10-9 | Sticky column headers on the Inbound + Direct report tables (follow-up note): `th` pins to the `.modal-panel-body` scrollport. The table's `overflow: hidden` corner clip becomes `overflow: clip` in these two modals only — `hidden` creates a scroll container that traps the sticky th inside the non-scrolling table; a box-shadow stands in for the collapsed bottom border, which doesn't travel with a stuck header | code (styles.html R10-9 block) |

**Owner feedback round 11, Phase B (2026-07-22, third testing pass; owner-approved
plan).** Client + email template only; code comments cite `R11-B<n>`:

| Code | What it fixed / added | Live rule lives in |
|---|---|---|
| R11-B1 | Daily Call Queue Report verdict band: the three secondary tiles center their values, tile values 32→28px, hero 42→36px — the row reads slightly smaller | code (styles.html R11-B1) |
| R11-B2 | Dept banner tone reads the DEPARTMENT AS A WHOLE (section abandon% vs 5% only — a sub-queue in violation keeps its red row but no longer flips a healthy dept's banner; CSR at 0.82% read red because A_Q_Spanish sat at 6.25%); the calls·abandon% mini-summary moved LEFT beside the dept name | INV-51 QV-2 note, CLAUDE.md |
| R11-B3 | QCD modal's Download CSV / Print / Email-me consolidated into an Export ▾ dropdown (Insights convention); the admin-only subscriber blast stays a separate deliberate button | INV-51 QV-4/5 note |
| R11-B4 | Email report: verdict banner RETIRED (KPI tiles + row color carry it; preheader keeps the offender line); single-day ranges label as ONE date (shared dateLabel builder — fixes the subject and the web header); the 0–20%-scaled bar became a green/red share-of-total SPLIT bar (a 50%-abandon day rendered a full orange bar that contradicted its number; red softens under 5% per the R10-4 convention); Courier New labels became Arial-based styling | queue-report tests (R11-B4 pins) |
| R11-B5 | Overview trend band is collapsible (`#ov-trend-collapse-btn`, persisted `cdr.ov.trendcollapsed`) so the dept cards can take the whole screen; chart re-measures on expand | Overview layout bullet, CLAUDE.md |
| R11-B6 | Missed bars stuck small in prod despite R10-7 — belt-and-braces: canvas display size forced to 100% of the fixed wrap, re-measure on the chart-row's grid transition end, rebuild when the canvas settles under 70% of wrap width; x labels render compact ("8AM") | INV-41 note, CLAUDE.md |
| R11-B7 | Bars/Radar toggle is ADMIN-ONLY (`data-admin-only` on the segment; `missedChartMode_` resolves non-admins to bars so a pre-fence saved radar pref can't strand a manager); the toolbar stays for the B8 tips button | INV-41 note, CLAUDE.md |
| R11-B8 | Chart-tips "?" popover on the Overview trend, Insights trend, IR charts, and missed chart toolbars — lists each chart's real interactions (spotlight/pin/Shift-click/point drills/zoom), which were otherwise invisible | code (`initChartHelp_` / `CHART_HELP_`) |
| R11-B9 | Insights sticky strip is the WHOLE results header now (title + toolbar + period presets — the My Department pattern); the period bar moved inside the header markup, same ids | Insights period-slider bullet, CLAUDE.md |
| R11-B10 | Inbound/Direct modals: the scroll body's 18px top padding read as a gap strip above the stuck table headers — padding moved onto the first child so the pinned row hugs the modal bar | code (styles.html R11-B10) |
| R11-B11 | Click-to-sort columns on all four Inbound tables + the Direct per-agent table (static theads carry `data-sort`; shared `srtApply_` machinery). Default order = the IMPACT score `(100 − answer%) × calls` desc (owner-confirmed) — worst-AND-busiest first; Direct's impact uses the busy-excluded answerable population | code (`srtApply_` + theads) |

---

## Phases & batches (rollout narrative, not rules)

These name *when* something shipped, in commit messages and CLAUDE.md prose:

- **Phase A–E** — the design-system redesign + Phase E UI surfaces.
- **Phase 1–15** — feature-build phases (roster-only flip @ Phase 14/15, etc.).
- **Phase D / D+1** — the floater / Source-column work (INV-53).
- **Batch E / Batch F** — owner-ruled accuracy + polish backlogs.
- **Track A / B / C** — the `docs/ui-infra-roadmap.md` tracks (Missed bar toggle,
  Escalations page, Config→Neon; C1/C2/C3 shipped, C4 intentionally skipped).

For the current state of any phase, trust CLAUDE.md + the code, not this list —
phases are history, invariants are truth.
