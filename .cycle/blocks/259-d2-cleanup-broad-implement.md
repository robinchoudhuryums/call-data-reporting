---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (owner requests 2026-10-21; the Direct Calls audit's D2 items + the Step 3 leftover):
  - DC-D2  The Direct build's counting gaps, fixed in computeDirectCallMetrics / dcBuildExtMaps_:
           (a) a coworker dial logged Internal is ALSO the caller's internal outbound call (it reached only the callee's inbound);
           (b) every digit-only roster extension maps to its agent -- a FIRST extension always beats another agent's later one;
           (c) one event per ROOT call (parent, else the leg's own id): two legs of one call are one call, talk added per leg, answered if any leg was; an Outgoing + Internal pair for one dial stays one;
           (d) an anonymous / blank Incoming caller is kept (external); a caller field naming a queue still is not a direct call;
           (e) explicit handling (not a third bucket -- no schema change): an outbound dial to an extension-length (1-6 digit) number no roster names is INTERNAL (dcOutboundSide_); an outside call keeps its first leg's side through a later internal transfer.
  - OB-TRIM  The unreachable Outbound-only agent table (Step 3): obViewRender_'s non-Both header / row / total / grouping branches, the two body[data-dir="out"] CSS rules, apTbody_'s 'out' test. Verified unreachable first: obDir_ is only 'in' / 'both' (a stored 'out' reads as 'both'), obEffectiveDir_ returns 'in' or obDir_, obViewRender_ returns on 'in'; no test or driver reached the branches.
New capabilities (G/ST): None. (D0's diagnose mode is re-pointed, not new: since D2 it reports what D2 counts differently per day = the size of a re-import of a pre-D2 date.)
Files modified:
  apps-script/cdr-import/directCallMetrics.js (dcSumValues_, dcOutboundSide_; root-keyed ib / ob events with per-leg talk; Internal dials in the outbound branch; anonymous-caller rule; dcBuildExtMaps_ all extensions + firstExtToAgent; diagnose counters + dcDiagSummary_ re-pointed; the tool's log text)
  apps-script/department-dashboard/script-5-dept.html (obViewRender_ Both-only)
  apps-script/department-dashboard/script-10-escalations.html (apTbody_)
  apps-script/department-dashboard/styles.html (two data-dir="out" rules removed)
  tests/unit/direct-call-metrics.test.js (D2 block +8: both sides of an Internal dial, Outgoing + Internal = one call, second extension, anonymous kept / queue-named not, root dedup with per-leg talk + a twice-missed call once, extension-length internal + dcOutboundSide_, an outside call through an internal transfer, first-beats-later map; the D0 tests re-pointed)
  tests/unit/overview-outbound.test.js (totals call sites 2 -> 1)
  docs: direct-extension-metrics-design.md (as built), per-call-capture.md, operator-state.md (#80 -> re-import sizing + the re-import step), regression-scenarios.md (S67 D2 step), fix-history.md (DC-D2, OB-TRIM), client-ui-conventions.md (the trim), next-steps.md, CLAUDE.md (#80 index line)

CHANGES:
DC-D2 | directCallMetrics.js | See (a)-(e). The schema, sheet width, Neon mirror and the dashboard reader are unchanged; only the counts a build writes move.
OB-TRIM | script-5, script-10, styles | Dead branches removed; the Both table renders byte-for-byte as before (the drivers that walk it are unchanged and green).

TEST RESULTS: passed -- node --test 2640 tests, 2639 pass, 0 fail, 1 skipped (pre-existing); lint:gas clean; INV-16 clean; module-deps --check clean; ci:ui full gate green on the final code (rc=0, all 15 stages; drive-deptoutbound 41/41 walks the trimmed Both table, drive-agentpanel 36/36 the trimmed apTbody_). Bites: 12 land. Two first-round misses were acted on, not papered over: (1) the "an Internal leg makes the call internal" override did not bite -- and on reflection was WRONG (an outside call transferred to a coworker would read internal), so it was removed and the opposite is now pinned (bites); (2) a root-level busy exclusion could not change any reachable outcome (the call's other talking leg already answers the merged event), so it was reverted rather than kept unpinned. Test doubles updated as part of the change: the D0 fixtures (pre-D2 meaning) were rewritten for the new one; one source pin (two totals call sites) counts the single remaining one.
REGRESSION RISKS:
  - DC-D2 is NOT retroactive: a date built before the cdr-import deploy keeps the old counts until re-imported, so a Direct window spanning the deploy mixes two rule sets and its vs-prior chips compare them (Operator State #80 sizes it; #56 re-imports).
  - Anonymous inbound rings now count: if spam / robocalls hit direct lines, IB missed (free) rises and the direct answer rate falls -- by design, but a visible shift.
  - Every roster extension maps: an extension a roster cell lists that is really a SHARED line credits that line's calls to the agent (a first extension can never be taken over).
  - Root dedup lowers IB / OB counts where calls re-rang the same agent; talk is now the SUM of the legs (was the longest leg of one leg id).
  - Extension-length callees move from OB ext to OB int.
  - OB-TRIM: none -- the removed branches were unreachable.
INVARIANTS AT RISK: INV-03 (the extension parse takes digit-only tokens after the first comma -- now behaviour-bearing, consistent with the rule). INV-06 (work window unchanged). INV-16 (directCallMetrics.js is cdr-import-only, not duplicated; guard clean). INV-19 (exclusions unchanged). INV-30 (no dashboard cache / payload change; the freshness tag moves with the next import, and a rebuilt date changes rows, not shapes). None violated.
NET SCORE: 1 production fix (DC-D2 -- Internal dials, multi-leg calls and anonymous rings are everyday CDR shapes; magnitude unmeasured until D0 runs) − 1 new failure mode (the pre-/post-D2 mix until re-import, plus a shared-line extension's possible misattribution; both documented) = 0. OB-TRIM is code health (no production effect, no failure mode).

OPERATOR ACTIONS / DEPLOY:
- After the cdr-import deploy: run `diagnoseDirectCallCounting` on 3-4 imported days; where the shares matter, re-import the dates the Direct Calls report is read over (CDR Tools -> Manual Export per date, Operator State #56 / #80) | BLOCKS DEPLOY: N
- Check the roster for extensions that are really shared lines listed on an agent's cell (they now count for that agent) | BLOCKS DEPLOY: N
Deploy:
  CDR Import: `scripts/deploy.sh apps-script/cdr-import` (or `cd apps-script/cdr-import && clasp push -f`)
  Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)
Walk S67 (incl. its D2 step) and S57.

(Not complete in production until the deploy steps are confirmed.)

FOLLOW-ON ITEMS:
- The legacy CDR Historical direct columns (autoImport.js's own extToAgent, first extension only) share the second-extension gap; out of scope here (a different sheet / reader).
- A "built under D2" marker per date (so the report could say which dates in a window predate D2) -- not built; the re-import is the remedy.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in these commits.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
