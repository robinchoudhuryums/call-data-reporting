---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: the owner's six-point Outbound list (2026-09-15), code
half — five of the six. Point 1 ("release it") is an OPERATOR gate, not code
(Operator State #63), and is untouched here.
- (2) connected-callback rate promoted to a first-class KPI
- (3) time-to-callback as a DISTRIBUTION, not a median
- (4) unconnected outbound split by ring seconds
- (5) sendOutboundReportEmail — the gap where Inbound / Individual / Insights
      all had one
- (6) callback rate by the ABANDON's hour

Files modified:
- apps-script/department-dashboard/OutboundReport.gs
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-9-inbound-direct.html
- apps-script/department-dashboard/styles.html
- tools/ui-harness/build-harness.js, tools/ui-harness/drive-admin.js
- tests/unit/outbound-report.test.js, tests/unit/outbound-fallback.test.js
- docs/invariants.md, docs/architecture.md, docs/per-call-capture.md,
  docs/next-steps.md

CHANGES:

(all) | OutboundReport.gs | `outboundReport:v2` -> `v3`. Four additions change
  what the SAME window means, so a v2 blob would serve half a page for the
  6 h TTL. **Every one lands in the SQL AND the sheet fallback**, because the
  two feed ONE shaper and outbound-fallback.test.js compares them byte for
  byte — that parity test is what made this round four mirrored edits rather
  than four.

(3) | OutboundReport.gs | ONE `OUTBOUND_CALLBACK_BUCKETS_` ladder (15m / 1h /
  4h / 1d / later) drives `outboundBucketSql_` (generated FILTER clauses) and
  `outboundBucketDelays_` (the fallback's JS bucketer). Generated rather than
  hand-written on both sides because two maintained copies of a boundary list
  is the exact drift this repo keeps paying for. Buckets are
  cumulative-exclusive so they sum to the called-back total. Boundaries chosen
  to separate decisions, not to look tidy: inside 15 min the caller is
  plausibly still by the phone; past a day it is a courtesy call.

(2) | OutboundReport.gs | `calledBackConnectedPct` over the SAME trackable
  denominator as `calledBackPct` — a different one would make the two tiles
  incomparable, which is the entire point of showing them side by side. The
  prior block carries it too, so the new tile gets a real delta chip; that
  cost no SQL, since `calledBackConnected` was already in the non-detail set.

(4) | OutboundReport.gs | `obUnconnectedBrief` / `obUnconnectedReal` /
  `obUnconnectedUnknown` split on `OUTBOUND_BRIEF_RING_SEC_` (=8) via the pure
  `outboundClassifyRing_`. A LABELLED heuristic, not a new CDR fact — the CDR
  still cannot tell no-answer from voicemail, and the UI says so. Two rules:
  the boundary is STRICT (`< N` brief, `= N` real, matching the SQL FILTERs),
  and a NULL ring is UNKNOWN, surfaced as the remainder rather than filed into
  a bucket — so an export column that stops being written reads as unknowns,
  not as a pile of misdials.

(6) | OutboundReport.gs + script-9 | `callbackByHour`: the same
  tracked/called-back pair as `daily`, cut by the abandon's hour. Rows with no
  `call_start` cannot be placed on an hour axis and are excluded on both
  paths identically; they still count in every date-scoped figure.
  **I said in chat that this would reuse `renderAbandonHeatmap_`. On reading
  it, that was wrong and I did not do it.** That renderer is hard-wired to
  abandon rate — its title, its drill, and above all its colour polarity,
  where HIGH is bad. Callback rate inverts that, so reuse would tint a great
  hour red; it also serves two live surfaces, a poor thing to generalise
  mid-round. Hour-of-day alone is also the right cut: splitting this volume
  across five weekdays leaves most cells under the low-signal floor.

(5) | OutboundReport.gs + dashboard.html + script-9 | `sendOutboundReportEmail`
  goes through the SAME resolver (so the vetting gate and per-dept pinning
  apply identically) and RECOMPUTES server-side, so the email cannot drift
  from the screen it was sent from. `sendAppEmail_` + a banded `ekShellHtml_`
  per R28/R30. The delay distribution ships as a TEXT table — it is the part
  the median was hiding, and a table survives a mail client where a canvas
  does not.

(client) | script-9 + styles.html | Two new tiles (Rang out / Brief-misdial),
  one new callback tile (Actually reached), and two strips. Both strips are
  token-only and chart-free on purpose: they survive the print/email clone,
  and this page already carries a canvas. Both hide themselves when empty —
  an all-zero delay strip reads as "every callback was slow" rather than
  "there were no callbacks".

TEST RESULTS: passed. `TZ=America/Chicago npm run ci` — 1441/1441, INV-16
guard clean. 21 new tests.
MUTATION-CHECKED, 13 mutations. 10 caught first time; THREE survived:
  - TWO were real gaps, fixed: (a) the SQL pin checked only bucket UPPER
    bounds, so deleting every lower bound — which makes independent SQL
    FILTERs overlap and double-count, unlike the JS loop which returns on
    first match — passed. Now pinned per bucket. (b) the ring BOUNDARY was
    invisible: the shared fallback fixture has no call ringing exactly 8s, so
    `<` vs `<=` changed nothing. Extracted `outboundClassifyRing_` and pinned
    the boundary on both sides, plus a source pin that the fallback routes
    through it instead of re-implementing inline.
  - ONE is EQUIVALENT, not a gap: removing the `d > prev` guard in
    outboundBucketDelays_ changes no output, because the loop iterates an
    ascending ladder and returns on first match. The guard is defensive. What
    is NOT redundant is the sort order, so that is what the new test pins.
All three re-checked after the fix and now caught, as is a fourth mutation
dropping a bucket key.

`npm run ci:ui` CANNOT RUN HERE — playwright is absent and the gate skips with
exit 0, so its green is not evidence. This round touches client fragments:
  - The harness fixture was updated to the v3 shape and `drive-admin.js` now
    asserts BOTH new strips render and the Email control is present. That
    matters more than usual here: both strips hide themselves when empty, so
    a strip that never appears is indistinguishable from a quiet window
    without a driver on a populated fixture.
  - `sendOutboundReportEmail` is mocked in the harness, so the new button
    does not trip drive-smoke's unmocked-RPC check.
  - Structural cover that DID run: html-include-structure `node --check`s the
    assembled client and passes; the new CSS was added inside the existing
    `<style>` block (the F7 "appended after `</style>`" trap).
  RUN `npm run ci:ui` BEFORE DEPLOY; deploy.sh gates on it.

REGRESSION RISKS:
- The payload GREW; nothing changed meaning. Existing fields keep their
  values, so an old client against a new server degrades to "the new tiles
  are missing", never to a wrong number.
- The cache bump costs one cold recompute per (dept, window) after deploy.
- `outboundShapeReport_` gained fields but no signature change; the sheet
  fallback and Neon path still produce identical payloads (pinned).
- The agent TABLE and the CSV are deliberately unchanged — the ring split is
  a scope-level KPI, not a per-agent column — so the export stays consistent
  with what the table shows. The per-agent split IS in the payload if a
  column is wanted later.
- `outboundClassifyRing_` is new and only the fallback calls it; the Neon
  path expresses the same boundary in SQL. Those two are pinned to agree, but
  they are still two expressions of one rule — the honest residual risk here.

INVARIANTS AT RISK: None violated.
- INV-30: honoured — v2 -> v3, with every mention across the code and the
  eight cache-version-sync DOC_FILES updated (the suite caught two).
- INV-31: the new send rides `script.send_mail` like every other export.
- INV-01: `sendOutboundReportEmail` writes no spreadsheet beyond the
  `logReportUsage_` append-only carve-out.
- INV-42: the new strips use design tokens only; no raw colour reaches a
  chart option (they are not charts at all).
- INV-18: `call_start` stays raw PST server-side; the +2h CST shift happens
  in the client, as the per-call lists already do it.

NET SCORE: production fixes 2 − new failure modes 0 = 2
- (2) (a) would it have fired this month? YES — the report has been showing a
  callback rate that counts rang-out callbacks as saves, with the connected
  number in a caption. Anyone reading the tile has been reading the softer
  number. (b) new failure mode? NO.
- (5) (a) YES in the same sense — the absence meant the number never arrived
  unprompted. Counted as a fix because it closes a documented gap against
  three sibling reports. (b) NO.
- (3), (4), (6) are new capability, not bugs: NO / NO each.

OPERATOR ACTIONS / DEPLOY:
- None for this round. No Script Property, sheet, trigger or migration.
- STILL PENDING from 6c (unchanged by this round): the Outbound manager
  release — backfill, `runOutboundVettingCheck`, release only on a CLEAN
  `ok parity`. Operator State #63. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `scripts/deploy.sh .` from the repo root, run
where playwright is installed.

FOLLOW-ON ITEMS:
- **Point 1 of the six is the operator gate and is not code.** Until it runs,
  every improvement in this round is visible to admins only.
- **OPEN QUESTION, deliberately not built:** the per-dept CALLBACK table. The
  Option C ruling was about per-dept AGENT cards, and the crossover objection
  that drove it does not reach this: an abandoned call has an unambiguous
  dept, a crossover agent does not. Different unit of analysis. Recorded in
  docs/next-steps.md; it needs an owner ruling, not an inference from a
  ruling about something else.
- The per-agent ring split ships in the payload but no per-agent column
  renders it. A column is a small follow-up if the scope-level tiles prove
  useful.
- The hour strip's low-signal floor (3 trackable abandons) is hardcoded in
  the client, unlike `HEAT_MIN_VOLUME_` which the heatmap shares. Worth
  unifying if a third surface needs one.

DOCUMENTATION UPDATES NEEDED: done in this commit.
- docs/invariants.md: INV-30's outbound entry carries the full v3 history
  including why each addition forced the bump.
- docs/per-call-capture.md: the six-point round documented on the Outbound
  report bullet, including the strict ring boundary, the NULL-ring rule, and
  why the shared heatmap renderer was NOT reused.
- docs/architecture.md: the routing table's cache prefix.
- docs/next-steps.md: the observed gap struck through as shipped; the
  per-dept callback question recorded as open.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
