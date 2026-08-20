---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FO-1 | neonAgentExts:v1 — the LAST unanchored 6 h cache key — joined reportFreshnessTag_ + the
        version-sync SPECS (and the CLAUDE.md clause that documented it as the exception updated)
- FO-2 | Row-35 window-edge divergence (the F1 drift class at the window edge): the sidebar's
        dp2/dp3 lacked the pipeline's start<3PM clause — fixed + pinned by an edge-time fixture row
- FO-3 | dashboardCDR.js first-ever coverage: the pure aggregation helpers feeding its 4 setValues
        sites (bounded scope; the 480-line core stays a follow-on)
- E1   | Call_Legs retention-horizon monitor: two Health rows turn three memory-dependent deadlines
        (#40, #43, post-outage backfills) into a glance
- E2   | Escalations OUTAGE SNAPSHOT: the worklist's open rows survive a Neon outage read-only
- E3   | Deployed-build stamp: deploy.sh stamps BuildStamp.gs at push time; Health renders it
- NOT IMPLEMENTED (needs the owner's ruling, deliberately): the row-34 three-way incoherence from
  block 129 — what row 34 MEANS must be decided before any code moves. AbandonedFilter's >0:00:59
  stays documented-deliberate.

Files modified:
- apps-script/department-dashboard/NeonRead.gs            (FO-1)
- apps-script/cdr-report/dataFilters.js                   (FO-2)
- apps-script/department-dashboard/NeonCoverage.gs        (E1 helpers)
- apps-script/department-dashboard/SystemHealth.gs        (E1 two rows + E3 row)
- apps-script/department-dashboard/Escalations.gs         (E2 snapshot layer)
- apps-script/department-dashboard/script-10-escalations.html (E2 banner)
- apps-script/department-dashboard/BuildStamp.gs          (NEW — E3 placeholder)
- scripts/deploy.sh                                       (E3 stamping + trap restore)
- tests/harness/fakeSheet.js                              (getSheets — real method, modelled)
- tests/unit/qcd-sidebar-parity.test.js                   (FO-2 Family E + scope note)
- tests/unit/cache-version-sync.test.js                   (FO-1 SPECS)
- tests/unit/neon-coverage.test.js                        (E1, +4)
- tests/unit/system-health.test.js                        (E3 +2, E1 +4)
- tests/unit/escalations-snapshot.test.js                 (NEW — E2, 11 tests)
- tests/unit/dashboard-cdr-helpers.test.js                (NEW — FO-3, 6 tests)
- CLAUDE.md                                               (FO-1 clause correction)

CHANGES:

FO-1 | NeonRead.gs, cache-version-sync.test.js, CLAUDE.md | 'neonAgentExts:v1' gains the freshness
suffix (typeof-guarded, 'na' fallback — the tag's own failure value), joins the SPECS list, and the
CLAUDE.md CacheService clause now reads "every 6 h key carries an anchor" — true for the first time.

FO-2 | dataFilters.js, qcd-sidebar-parity.test.js | Row 35's dp2/dp3 (col D) gain the pipeline's
`startDec < time300PM` clause. The pipeline counts C and D inside ONE guard block, so its col-D
population equals its col-C p2/p3; the sidebar's dp variants extracted rows STARTING after 3 PM
that were never in the cell. Verified first that rows 36/37 match the pipeline clause-for-clause —
row 35 was the only edge divergence. Parity fixture gains Family E: a queue name on the csr_team
range (isCsrQ) with an in-window status-4 row and a 3:10 PM edge row; negative-tested (reverting
the fix fails "(35,4): pipeline wrote 1 but the sidebar extracted 2").

FO-3 | dashboard-cdr-helpers.test.js | Six tests on countItemsInList / durationToSeconds /
parseAndAggregate (incl. the EXT timestamp-strip) / mapToContactString (cap + remainder) /
buildTotalsRow — pinning that the totals row RECOMPUTES Rate (dept Ans/Total) and ATT (dept
TTT/Ans) rather than summing ratios (the v9 headline fix), and the zero-denominator guard.
Learned in the writing: the Rate recompute only engages for production-shaped headers
("<cat> Rate"); a bare 'Rate' header correctly finds nothing. The 480-line core (sheet inputs +
charts + diagnostics) remains uncovered — needs the C1 fixture treatment, still a follow-on.

E1 | NeonCoverage.gs, SystemHealth.gs, fakeSheet.js, tests | Three deadlines hang off the ~14-day
Call_Legs prune and each lived only as a note an operator had to remember. Now:
  * `ncSurvivingCallLegsDates_(ss)` — enumerates the workbook's Call_Legs_YYYY-MM-DD tabs.
    Recoverability GROUND TRUTH is which sheets actually survive, never a constant's promise.
  * `ncRetentionRisk_(conn, surviving, holidayFn)` — per table (inbound_calls/outbound_calls),
    the SURVIVING weekdays with zero rows, each with lastDay = date + NC_RETENTION_DAYS_ (the
    dashboard-side mirror of cdr-import's RETENTION_CUTOFF_DAYS — an INV-06-style sync obligation,
    used only to PHRASE the deadline). No capture-start floor ON PURPOSE: a pre-capture surviving
    date is exactly the "backfill it while you still can" case (#40's deploy-day step). A pruned
    date is NOT "at risk" — it is already gone. Missing table → missingTable (deploy-ahead reads
    as such), never a throw.
  * Health rows: 'legs-horizon' (FAST part, sheet-only — renders even mid-outage, which is
    precisely when the deadline matters) and 'retention-risk' (neon part, rides the R21 shared
    connection). Neon unreachable → retention-risk WARNS with the outage playbook naming the
    oldest surviving sheet — the first date to die. Both typeof-gated, so the R21 "only two mirror
    rows" pin holds unchanged in suites that don't load NeonCoverage.gs.

E2 | Escalations.gs, script-10-escalations.html, escalations-snapshot.test.js | During the 2026-08
transfer-cap outage the ENTIRE worklist was invisible for two weeks, including read-only viewing of
items managers were mid-way through. Now: after a successful list read, getEscalations stores the
OPEN rows (pending/in_progress/pending_review, newest-first, cap 150) in CHUNKED Script Properties
(~9KB/value cap → ESC_SNAPSHOT_META + ESC_SNAPSHOT_1..6, meta written LAST so a torn write reads as
absent; refresh AGE-GATED to one bounded query per 30 min). When Neon is unreachable — the no-conn
path AND the mid-query-death catch — the snapshot is served with THE SAME viewer scope the live
path computed (scope resolved before Neon is touched), shaped exactly like the live payload plus
meta.snapshotAsOf. The client renders an idempotent read-only banner (textContent only, the F10
update-or-remove discipline). Closed statuses aren't in the snapshot: requesting them serves an
empty list with the banner explaining why; band counts come from scoped open rows, closed/MTD/
overdue stay 0 (unknowable — never guessed, the F3 lesson). WRITES STILL HARD-FAIL (INV-55
untouched): a snapshot cannot drift while the only writer is down — which is why this does not
contradict the owner's no-sheet-twins ruling (that was about a second SOURCE; this is a labeled
stale read-only cache). Store is Script Properties, the login-notify/presence precedent (INV-01
covers spreadsheet writes). NOTE: escalation rows include patient_name — the property store is the
same project-internal trust domain as the CacheService blobs that already carry report data.

E3 | BuildStamp.gs (new), deploy.sh, SystemHealth.gs | deploy.sh overwrites the committed
placeholder with "deploy.sh <UTC> | git <shortsha>[+dirty] | <branch>" before `clasp push -f` and
trap-restores the placeholder on ANY exit (the restore warns instead of silently no-opping — an
edge the validation simulation itself caught: git checkout can't restore an untracked file). A bare
`clasp push -f` ships the placeholder, so the Health row reading "unstamped" is ITSELF the finding:
the last push bypassed the deploy helper and its CI gates. Row always MUTED — a manual push is
legitimate; the hint carries the meaning.

TEST RESULTS: PASSED — 810/810 (was 783; +27: E2 11, FO-3 6, E1 8 across two suites, E3 2... plus
the FO-2 fixture rides inside existing parity tests). INV-16 green. All modified .gs/.js pass
`node --check`; deploy.sh passes `bash -n` and the stamp/restore block was simulated including the
failure path. `npm run ci:ui` — the FULL rendered-UI gate, playwright installed locally — run
against the script-10 change; result recorded in STATE (green at write time or the commit was
held). Negative tests: FO-2 reversion trips (35,4); torn snapshot write reads as absent; the
age gate provably suppresses the refresh query.

REGRESSION RISKS:
- FO-2 changes user-visible sidebar output for row 35 col D: it no longer lists rows the cell
  never counted. Strictly more correct; an operator who relied on seeing those rows was being
  misled by them.
- E2's stale read is a NEW state for the escalations page: labeled with a role=status banner and
  meta.snapshotAsOf; write verbs fail with their existing clear errors. The accepted residual risk
  is a user skimming past the banner and thinking an item is still open that someone resolved just
  before the outage — bounded by the 30-min refresh cadence.
- E2 adds ≤1 bounded query per 30 min to the live read path, and property writes on refresh.
- E3's trap replaces no existing EXIT trap in deploy.sh (there was none).
- FO-1 mints a new cache key → one cold read per viewer window after deploy.
- fakeSheet.getSheets is additive; no fixture could have depended on its absence.

INVARIANTS AT RISK: None.
- INV-55: the escalations write verbs are byte-untouched; the snapshot is read-only.
- INV-01: property writes only (login-notify/presence class); no new public function anywhere —
  every E2 helper is _-suffixed and rides inside getEscalations.
- INV-30: FO-1 is a key SUFFIX (the CORE-3/S2-0 precedent, fourth application); no version bumps.
- R21 fast/neon: legs-horizon + build-stamp are fast (sheet/property only — pinned connCalls===0);
  retention-risk rides the existing shared conn; key-set pin recomputes green.
- INV-16: dataFilters/autoImport guard green; the FO-2 edit is sidebar-only because the PIPELINE
  was already correct — parity, not mirroring drift in.

NET SCORE: 2 − 0 = +2
  (E1 and E2 both address the LIVE incident class: the retention-risk row will show the current
  outage's unmirrored dates the moment it deploys — before the Sep 1 deadline it exists to guard —
  and E2 makes the next outage a read-only inconvenience instead of a two-week blackout. E3, FO-1,
  FO-2, FO-3 are preventive. The E2 stale-read trade-off is labeled and documented, not silent.)

OPERATOR ACTIONS / DEPLOY:
- E2's snapshot only exists after the FIRST successful post-deploy list load — during the CURRENT
  outage it serves nothing until Neon returns (Sep 1). It protects the NEXT outage. | BLOCKS: N
- E1's retention-risk row: once deployed, expect it to WARN through the outage — that is the row
  doing its job (it is the Sep 1 runbook, on the page). | BLOCKS: N
- E3: nothing to set — the first scripts/deploy.sh push stamps automatically; pushes made without
  it will show "unstamped", which is accurate. | BLOCKS: N
- Sep 1 (unchanged, now also on the Health page once deployed): backfillInboundCalls +
  backfillOutboundCalls BEFORE runNeonCoverageCheck. | BLOCKS: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root → New version (or scripts/deploy.sh . <id>,
  which now also stamps). Carries E1/E2/E3/FO-1.
- CDR Reporting Tools (dataFilters.js FO-2): `cd apps-script/cdr-report && clasp push -f`.
- CDR Import: nothing this batch (batch-C comment rides whenever).

FOLLOW-ON ITEMS:
- ROW 34 (unchanged from block 129): needs the owner's ruling on what the number MEANS — the
  pipeline's dead r34 counters vs the sum(35..37) overwrite vs the sidebar's third population, and
  the sidebar's total-row refusal list omitting 34.
- dashboardCDR's generateCustomReportCore_ end-to-end (fixture-driven, the C1 treatment) — the
  pure helpers are now covered; the core is not.
- getEscalationsBadge / the Overview strip during an outage: still 0/absent (E2 scoped to the
  LIST, the worklist itself). Extending the snapshot to the badge is a small follow-on if wanted.
- E2 idea, cheap: a Health row showing snapshot age ("outage readiness") — not built, debatable value.

DOCUMENTATION UPDATES NEEDED (queued for /sync-docs):
- CLAUDE.md System Health bullet: three new rows (build-stamp, legs-horizon, retention-risk).
- CLAUDE.md test-suite roll: qcd-sidebar-parity (batch C), escalations-snapshot,
  dashboard-cdr-helpers.
- CLAUDE.md Extraction Sidebar bullet: "the rest of the row rules are not [pinned]" is now stale —
  the parity suite covers them for mid-window + the row-35 edge.
- operator-state #43: NC_RETENTION_DAYS_ is a dashboard-side mirror of RETENTION_CUTOFF_DAYS (sync
  obligation); #24/escalations: the outage snapshot semantics; README deploy section: the stamp.
- docs/invariants.md INV-55 entry: note the read-only snapshot explicitly does not alter the
  write-path contract.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
