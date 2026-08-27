---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Phases 1-5 of the call-path sheet fallback: the "↳ path" drill's inbound arm now
  degrades to the `Inbound Calls` export tab when Neon is unreachable, instead of
  dead-ending on "Call path unavailable".
- The per-execution Neon-unreachable memo: one Neon-down request no longer pays a
  15-25s failed connect at every one of the dashboard's ~54 `getDashboardNeonConn_`
  callsites (the measured 53.7s getQcdAllDepartments, mostly failed handshakes).

Files modified:
- apps-script/cdr-report/inboundCallsExport.js
- apps-script/department-dashboard/InboundReport.gs
- apps-script/department-dashboard/NeonRead.gs
- apps-script/department-dashboard/script-5-dept.html
- tests/unit/inbound-export.test.js
- tests/unit/journey-fallback.test.js (new)
- tests/unit/neon-conn-memo.test.js (new)
- CLAUDE.md, docs/operator-state.md (#49), docs/architecture.md, tests/README.md

CHANGES:
Phase 1 | apps-script/cdr-report/inboundCallsExport.js | Headers 17 -> 22: appended
    (never inserted -- the heatmap fallback reads cols 16-17 by position) Journey /
    Origin Agent / Origin Dept / Related Call Id / Related Call Kind. Journey is the
    tab's only heavy column (0.2-6 KB/cell), so the SQL exports it only within
    `INBOUND_EXPORT_JOURNEY_DAYS` (Script Property, default 90 via ic_journeyDays_;
    CASE WHEN on a bound cutoff param) -- older rows keep a blank cell; the small
    origin/related columns are unconditional. No '@' format needed (JSON starts with
    '[', not formula-leading); crSheetSafeCell_ still sweeps every cell. The existing
    widen-before-write handles the 17->22 schema upgrade on the live tab.
Phase 2 | apps-script/department-dashboard/InboundReport.gs |
    `inboundCallJourneySheetFallback_(callId, date, dept, user)`: bounded widening
    TAIL scan of the date column (the F-20/F9 discipline), then a row read capped at
    the tab's real width (17-col heatmap-era tabs still serve the summary + auth).
    BOTH auth arms re-derived in the Neon-path order -- the dept-scoped match mirrors
    callJourneyDeptPredicate_ (entry/final queue in the inbound union OR final_dept
    === dept), then the exact-id arm gated for managers by callIdInDeptMissedReport_,
    which reads the DQE sheet via getMissedCallsReport's own fallback chain, so the
    F-4 gate SURVIVES the outage; a gate-closed manager gets the same reason-less
    miss as on the Neon path. Payload shaped by the SAME callerLookupShapeCall_
    (booleans/nulls converted from display strings first). Miss reasons from the
    sheet's own coverage: before-capture(+minDate) / date-gap / not-captured, plus
    the fallback-only `fallback-gap` (+fallbackThrough) for a date past the copy's
    ceiling. Hooked at BOTH failure points: the no-conn early return and the
    mid-query catch. Best-effort throughout (any internal error -> available:false).
Memo | apps-script/department-dashboard/NeonRead.gs | `NEON_CONN_DOWN_MEMO_` (plain
    var -- per-execution by construction, never CacheService, so one request can
    never mask another's recovery): after the first hard connect failure,
    getDashboardNeonConn_ returns null immediately for the rest of the execution,
    logging the memoized skip; a memoized call with {recordReadHealth:true} still
    feeds the NEO-3 line (synthetic "memoized this execution: <msg>" error). Success
    and unset-NEON_HOST never trip it (unconfigured != unreachable).
Phase 3 | apps-script/department-dashboard/script-5-dept.html | available:false is
    now kind-aware (outbound: "no sheet fallback" stated plainly; inbound: "the
    sheet fallback copy has no data yet"); new `fallback-gap` message naming the
    copy's coverage ceiling; a served-from-fallback caption under the rendered path
    ("Served from the sheet fallback copy -- Neon is unreachable · coverage through
    <date>" + a summary-only note when the journey cell was past the window).
Phase 4 | tests | journey-fallback.test.js (11 tests: source parity via the shared
    shaper, both auth arms + the reason-less gate-closed miss, all four miss
    reasons, blank-journey summary, mid-query catch degrade, missing/empty/15-col/
    17-col tabs, outbound non-coverage). neon-conn-memo.test.js (4 tests: one
    attempt per execution, fresh-execution recovery, NEO-3 recording on memoized
    skips, success/unset never trip). inbound-export.test.js updated + extended
    (9 tests: 22-header contract, SQL terms, the cutoff param order -- a swap
    silently blanks every journey -- the INBOUND_EXPORT_JOURNEY_DAYS override and
    90-day default, journey bytes landing verbatim).
Phase 5 | docs | CLAUDE.md journey-drill bullet + the JDBC bullet's memo sentence;
    Operator State #49 (cols 18-22, the journey window, the 10M-cell sizing note,
    the deploy-before-trigger ordering); architecture.md getCallJourney row;
    tests/README.md themes + count.

TEST RESULTS: passed. `node --test` 928/928 (was 911; +15 new, +2 export). INV-16
guard clean. `npm run ci:ui` full gate green (178/178 across all seven asserting
stages) -- required, since script-5-dept.html changed.

REGRESSION RISKS:
- getCallJourney's healthy-Neon path is untouched (fallback only enters at no-conn
  or catch); its response gains fallbackSource/fallbackThrough only on fallback
  serves, which no existing client code reads.
- The export SQL's new bound-param ORDER (1=cutoff, 2-3=range) is the riskiest
  mechanical change -- pinned by the param-capture test precisely because a swap
  would silently export every journey blank.
- The memo changes behavior for multi-connection executions during an outage:
  surfaces after the first failure now skip their own probe. Within one execution
  that is the point; a mid-execution Neon RECOVERY (sub-minute) would previously
  have let a later surface connect. Accepted: the 6-min ceiling makes that window
  tiny, and the old behavior cost 15-25s per surface every outage request.
- crSheetSafeCell_ on journey JSON: '[' is not in the =+-@ prefix set, verified by
  the verbatim-bytes test.
- Existing suites stub getDashboardNeonConn_ directly, so the memo cannot leak
  across tests (928/928 confirms).

INVARIANTS AT RISK: None. INV-01 (fallback is read-only; getCallJourney's gates
unchanged); INV-02 n/a (no duration cells read); the F-4 entitlement contract is
re-derived, not relaxed -- pinned both ways; INV-30 untouched (getCallJourney is
uncached by design, and fallback payloads are never cached because of it); INV-16
n/a (no duplicated file touched); REP-10 respected (row reads capped at the tab's
real width; the export's widen precedes any col>17 range).

NET SCORE: 2 production fixes (the drill dead-ended during the CURRENT outage; the
53.7s Neon-down request measured TODAY) − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-report AND the dashboard (both changed). | BLOCKS DEPLOY: N
- ORDER: deploy the 22-col export BEFORE installing the Inbound Calls export
  trigger or seeding -- a 17-col seed leaves journey cells blank until a manual
  re-export. | BLOCKS DEPLOY: N (but blocks the SEED)
- Once Neon recovers: run `exportInboundCalls('<capture-start-ISO>')` once from the
  cdr-report editor (the one-time seed -- the tab is currently EMPTY, so this also
  arms the heatmap fallback for the first time), then install the daily trigger
  (CDR Tools -> Daily Inbound Export Trigger). | BLOCKS DEPLOY: N (blocked BY the
  outage, not blocking anything)
- Optional: set INBOUND_EXPORT_JOURNEY_DAYS to override the 90-day journey window.
Deploy: Department Dashboard: `clasp push -f` from repo root, then Manage
deployments -> New version; CDR Reporting Tools: `cd apps-script/cdr-report &&
clasp push -f`.

FOLLOW-ON ITEMS:
- The outbound arm still has no fallback (no sheet primary for outbound_calls);
  covering it means a second export tab -- a separate decision, now stated to the
  user in the overlay rather than implied as missing data.
- The memo covers the DASHBOARD builder only; cdr-report/cdr-import builders
  (getNeonConn / getReachableNeonConn_) keep per-call failures. Their executions
  are single-writer pipelines, so the multiplier is small -- but the same memo
  would fit if an import-side log ever shows repeated handshake failures.
- The heatmap fallback's pre-extension check reads cols>=17; a future 23rd column
  must keep appending (documented at the header block and #49).

DOCUMENTATION UPDATES NEEDED: Applied in this session (CLAUDE.md, Operator State
#49, architecture.md, tests/README.md).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
