# Increment 95 — R16i: a manager-reachable slice of the inbound abandons

Owner: "Can the necessary Inbound report info be released with a gate or in
a limited fashion, so they can get the data for this drilldown, but not the
full Inbound report?" Yes -- as a NEW narrow endpoint, not by relaxing the
existing gate.

## What was released, and what keeps it narrow

`getDeptDayAbandons({department, date})` (InboundReport.gs):
- ONE DATE. No range parameter exists, so no trend / month / window totals.
- ONE DEPARTMENT, required, resolved through `assertDeptAccess_` -- the same
  gate the 8 report endpoints use, so single-dept pinning, multi-dept
  managers, the ALL sentinel and sub-queue widening are all inherited
  rather than re-decided. No company view => no cross-dept comparison.
- The abandoned-call LIST only: no insurer / dial-in / journey-length
  breakdowns, no KPI block, no prior-window deltas.
- Marginal disclosure over what a manager already has: their Missed report
  already lists their dept's abandoned ring times + parent ids. What is new
  is the CALLER side -- wait/hold seconds, entry->final queue, abandon stage.

## Why not just relax inboundResolveRequest_

That gate is a VETTING hold on the full report, whose aggregate abandon
counts sit ~4x from QCD's (different definitions, both correct). The thing
being avoided is shipping those side by side unexplained. This endpoint
can't show an aggregate comparison, and it carries the explanation:
`meta.reconcileNote` travels WITH the payload and `heatCellDetailHtml_`
renders it whenever present -- the list appears directly beneath a
QCD-sourced abandoned count, so a caller that dropped the note would be
displaying an unexplained contradiction.

## Structure

`inboundAbandonList_(scope, bucket)` is extracted and shared:
`getInboundHeatmapCell` (admin, cell or range) and `getDeptDayAbandons`
(per-dept, one day) both call it. AUTH lives in each public function; the
DEFINITION (abandon = disposition='abandoned', the 8a-5p CST band, the dept
predicate, is_internal exclusion, the 200 cap, the row shape) lives once.
The two can never drift on what the data MEANS.

+4 unit pins (heatmap-cell-drill 9 -> 13): a manager reaches their own dept
(and the SQL matches the cell drill's definition), the note ships, another
dept / a bad date / a from-to range are all refused and a blank dept falls
back to the manager's own, and role 'none' gets nothing.
Harness: `dept-day-abandons` payload (the cell rows + the note) so the
rendered note is exercised; manager-page probe confirms both lenses with
wait times.

Gates: node --test 660/0, INV-16, ci:ui 36+16+30+14.

**FOLLOW-ON (owner's call):** releasing the full Inbound report is still the
one-line `inboundResolveRequest_` gate removal, unchanged by this.

## Note: the per-bullet ratchet caught a CLAUDE.md addition

I first documented the new endpoint inside CLAUDE.md's inbound-capture
bullet -- the file's LARGEST (12.8 KB) and a grandfathered one, so
`claude-md-split.test.js` failed with "a grandfathered bullet GREW". That
is the ratchet working as designed, and the fix it prescribes is the one
taken: the detail lives in docs/client-ui-conventions.md (the R16g/R16h
day-drill bullet), the endpoint's own docstring, and the unit pins --
CLAUDE.md gains nothing. Reverted in the follow-up commit; the failing
commit was 7df3ee8 and was green on every other gate.
