---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Batch G | The Outbound report — the scan's one new-capability item: `outbound_calls` (fully
  populated daily, previously read only by Caller Lookup) gains its first analytical surface,
  headline question "did we call back the ones who abandoned?", plus per-agent outbound activity.
  Both mandated caveats shipped as UI captions AND structural properties: (1) "connected" is a
  disclosed stricter subset — the CDR cannot distinguish no-answer/voicemail/busy; (2) agents are
  attributed by ROSTER dept (exact INV-04 match), never the raw CDR org label (the SQL never
  reads that column — test-pinned).

Files modified:
- apps-script/department-dashboard/OutboundReport.gs   (NEW — resolver, one-round-trip compute,
                                                        pure shaping, cache wrapper)
- apps-script/department-dashboard/dashboard.html      (Reports-menu Outbound item + outbound-modal)
- apps-script/department-dashboard/script-4-nav.html   (ROUTES_ '/report/outbound')
- apps-script/department-dashboard/script-9-inbound-direct.html (outbound client: init/render/CSV;
                                                        srtApply_ text-sort regex gains 'dept')
- apps-script/department-dashboard/script-5-dept.html  (reportReqSeq_.out + COVERAGE_ADJUST_ entry)
- apps-script/department-dashboard/script-2-chrome.html (initOutboundReport() in the boot list)
- tools/ui-harness/build-harness.js                    (getOutboundReport mock)
- tests/unit/outbound-report.test.js                   (NEW — 10 tests)
- tests/unit/cache-version-sync.test.js                (SPECS gains outboundReport — the C2 rule,
                                                        same commit as the new prefix)

CHANGES:

Batch G server | OutboundReport.gs | `getOutboundReport({from,to,department?})`:
- RESOLVER `outboundResolveRequest_` mirrors directCallResolveRequest_/inboundResolveRequest_
  byte-for-byte in semantics (the NEO-6 mirror promise): TEMPORARY admin-only vetting gate with
  the per-dept manager path (R-3 single-dept pin, Tier C multi-dept, allDepts → admin branch)
  written and latent, so release = one-line gate removal + un-hiding the data-admin-only item.
- CALLBACK LINKAGE: the abandon denominator reuses the Inbound report's `inboundDeptPredicate_`
  (entry-queue + on-hold-label arms) AND `inboundWindowClause_` verbatim — it is EXACTLY the
  Inbound report's Abandoned population for the same scope (the two reports can never disagree on
  what an abandon is), and the owner's work-window ruling is honored. Each abandon LEFT JOIN
  LATERALs to the EARLIEST outbound_calls row with `callee_hash = caller_hash` (shared HMAC space)
  within OUTBOUND_CALLBACK_WINDOW_DAYS (=3 — covers Friday→Monday); the match is deliberately
  unscoped by dept/agent (a callback is a callback; captioned) and deliberately NOT capped at the
  report's `to` (a last-day abandon's callback may land after it). Anonymous abandons (NULL hash)
  are counted separately and EXCLUDED from the callback-rate denominator — a dept is never
  punished for its caller-ID mix. Median time-to-callback via percentile_cont over non-negative
  delays (raw-PST call_start on both tables — the shared INV-18 storage convention — so no TZ
  shift; NULL call_start coalesces to midnight for ordering only).
- ROSTER ATTRIBUTION dashboard-side (`outboundShapeReport_`, pure + unit-pinned): the agents
  sub-select groups by agent_name ONLY; buildDeptsByAgent_ maps each dialer to roster homes. Dept
  view keeps only that roster's agents (off-roster dialers DISCLOSED via meta.offRosterAgents,
  never silently dropped); company view shows everyone — crossover agents labeled with all homes,
  no-roster dialers under "Unrostered" (meta.unrosteredAgents). Scope KPIs sum exactly the rows
  shown, so every number reconciles against the table beneath it.
- PLUMBING: ONE json_build_object round trip / single getString (the JDBC discipline);
  egress-metered (neonNoteEgress_, typeof-guarded); cached REPORT_CACHE_TTL_SECONDS under
  `outboundReport:v1` + reportFreshnessTag_() (the 6 h anchor rule); unavailable payloads
  uncached; logReportUsage_('outbound', …); clean unavailable shape on no-conn AND on mid-query
  death (finally closes the conn); coverageStart for the client's predates-data note.

Batch G client | dashboard.html / script-4-nav / script-9-inbound-direct / script-5-dept /
script-2-chrome | Reports ▾ → Outbound (data-admin-only, hidden in view-as-manager; F11 router
guard covers non-admin deep links). Modal mirrors the Direct report's shape: preset/from/to/dept
form → results with KPI tiles (activity row + the callback row), the CONTRACT CAPTION under the
callback block (connected-subset + unscoped-match + anonymous-exclusion + still-pending-tail),
a quantified attribution note (off-roster / unrostered counts), a sortable per-agent table
(srtApply_; impact default = calls desc; 'dept' joins the text-ascending sort set — only the new
table uses that key), csvSafeCell_-routed CSV (the SIXTH+1 writer — every tabular cell passes
through it per the CLAUDE.md rule), C-8 stale-response token (reportReqSeq_.out), and the
coverage note (COVERAGE_ADJUST_.outbound). Zero styles.html changes — all existing classes.

TEST DOUBLES: build-harness.js mocks getOutboundReport (shape mirrors the server payload pinned
by the new suite). Unit fake conn captures SQL for the structural pins.

TEST RESULTS: PASSED — 829/829 (was 819; +10: resolver gate/validation, four SQL property pins
(work-window clause present + dept predicate + hash-join/window/earliest-wins + org-label-column
never read + company view drops dept scoping but keeps the window), roster attribution both
views, callback-rate tracked-denominator + zero-denominator nulls, no-conn + mid-query-death
unavailable). cache-version-sync green with the new SPECS row. INV-16 guard green.
OutboundReport.gs passes node --check. `npm run ci:ui` full rendered gate: PASSED — all six
asserting stages green (drive-smoke incl. view-as-manager, drive-f13, drive-devoverlay,
drive-subqueue, build-agent + drive-agent 20/20), exit 0.

REGRESSION RISKS:
- The srtApply_ text-sort regex gained `dept` — verified no other table uses data-sort="dept", so
  no existing sort direction changes.
- reportReqSeq_/COVERAGE_ADJUST_ additions are additive keys.
- The report is admin-only + a NEW surface — no existing consumer changes. Its Neon query runs
  only on demand (admin opens the modal), cached 6 h per scope, so egress impact is bounded.
- The LATERAL join is per-abandon; a large window over a busy dept is bounded by the abandon
  count (tens/day) × an index-backed hash lookup (idx_outbound_calls_callee_hash exists,
  created by the writer).
- percentile_cont WITHIN GROUP + FILTER requires Postgres ≥ 9.4 — Neon is far past that.

INVARIANTS AT RISK: None violated. INV-01 (read-only public endpoint, no sheet writes); INV-30 +
C2 (new versioned prefix registered in cache-version-sync SPECS in the same commit); INV-04
(exact roster-name match for attribution); the inbound work-window owner ruling honored on the
new abandon sub-select (pinned — note the count-based guard in inbound-window-scope.test.js is
InboundReport.gs-scoped, so the new file carries its OWN pin); INV-53 not applicable (no
team-average here; floaters/off-roster handling is the disclosed-exclusion model instead).

NET SCORE: +1 − 0 = +1
  (New capability, dark behind the admin gate: the callback question is now answerable from data
  that was already being captured daily. No production behavior changes for any existing user.)

OPERATOR ACTIONS / DEPLOY:
- Dashboard deploy required to ship: `scripts/deploy.sh . <dashboard-deployment-id>`.
  | BLOCKS DEPLOY: N (admin-only surface)
- Data prerequisite for USEFUL numbers: outbound_calls history starts at the capture deploy
  (~Aug 15 per Neon coverage) — the report's coverage note says so when From predates it. The
  Sep-1 backfill items (backfillOutboundCalls) remain on the operator backlog and directly
  improve this report's floor.
- Vetting → release path (owner-gated, later): spot-check callback counts against Caller Lookup
  for a few known numbers, then remove the one-line gate in outboundResolveRequest_ + un-hide
  the data-admin-only menu item.

FOLLOW-ON ITEMS (deferred from the 3–5-day estimate, deliberately not in v1):
- Daily callback-rate series + chart (safeChart_), and a per-dept company-view card layout (the
  R11-C5 Direct pattern) — v1 keeps one flat table with the roster-dept column.
- A drill list of NOT-called-back abandons (per-call rows with "↳ path") — pairs naturally with
  getCallJourney; needs a per-call sub-endpoint like the heatmap cell drill.
- kpisPrior delta chips (the R11-M pattern) once the table has enough history for a prior window.
- Un-called-back "pending tail" as a separate counted bucket (abandons < WINDOW days old) instead
  of a caption.
- Row-34 code fix (from increment 131's ruling) still pending — unrelated to this batch, still
  the next small cdr-report item.

DOCUMENTATION UPDATES NEEDED (next /sync-docs):
- CLAUDE.md: the outbound-capture bullet's "Sole consumer: the Caller Lookup communication
  history" clause is NOW STALE — the Outbound report is a second consumer. Add the report to the
  test-suite roll (outbound-report) and to the Reports-menu description in the router bullet if
  named there.
- docs/invariants.md INV-30: add outboundReport:v1 to the version table.
- docs/architecture.md: outbound_calls consumers list.
- tests/README.md coverage map: outbound-report.test.js.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
