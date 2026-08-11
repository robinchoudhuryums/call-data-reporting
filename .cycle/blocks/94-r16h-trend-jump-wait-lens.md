# Increment 94 — R16h: trend point-jump + wait-time lens in the day drill

## 1. Trend LINE point-click matches the calendar

`insTrendPointDrill_` now routes a point whose label resolves to ONE DAY
(`range.from === range.to`, i.e. Daily mode) through `insCalJumpToDaily_`
-- same jump the calendar day-click got in R16g. A MONTHLY point spans a
month the day-scoped drill cannot represent, so it keeps the old re-run.
Probe: daily point "08-10" -> detail row for 2026-08-10, fold+daily open,
getInsightsReport count UNCHANGED (1->1) and the window untouched;
monthly point "Jul, 26" -> re-run (1->2), no detail row.

## 2. Wait times: the SAME info as the heatmap drill, one param change

The owner asked whether wait time could come from the heatmap drill's
data. It can -- same table, same endpoint, same fields. `dow`/`slot` on
`getInboundHeatmapCell` are now OPTIONAL and PAIRED: omit both and the
two bucket clauses drop, leaving the whole `from..to` range; the day
drill passes `from = to = the clicked date`. Half a pair THROWS (a lone
dow returning a whole day would over-report a cell click ~9x). Auth,
dept predicate, is_internal exclusion, disposition='abandoned', the CST
shift, the 8a-5p band, the 200 cap and the row mapper are all untouched
and shared, so the two scopes can never disagree about what an abandon
is. `meta.scope` = 'cell' | 'range'.

The day drill now renders TWO labeled lenses (the heatmap drill's own
shape): DQE missed RINGS (time · agent · path) beside inbound ABANDONS
(wait/hold · entry->final queue · stage · path). Different sources +
definitions, never expected to reconcile -- hence the labels.

**The inbound lens is ADMIN-ONLY** and that is not incidental:
`inboundResolveRequest_` still carries the Inbound report's vetting gate,
so a manager request throws. The client fetches it only for
`USER.role === 'admin'` (the same check the Insights heatmap uses) and a
manager sees the missed lens alone at full width. Restoring manager
access is the same one-line gate removal that releases the Inbound
report -- no second decision.

**Not carried:** the missed lens has no wait time (a rung-but-unanswered
call has no queue wait) and the inbound lens has no agent (an abandoned
caller never reached one). That asymmetry is the data, not a gap.

## Harness

`getInboundHeatmapCell` is now MOCKED (hand-authored fixture --
gen-payloads has no Neon; the shape is what heatmap-cell-drill.test.js
pins field by field). `getInboundHeatmap` stays unmocked as documented:
the panel hiding silently on failure is what that audit is for; the
cell drill's failure mode is an in-panel error instead.

+3 unit pins (heatmap-cell-drill 6 -> 9): range scope drops ONLY the
bucket clauses, cell scope still pins them, half a pair throws, and the
admin gate applies to both scopes.

Gates: node --test 656/0, INV-16, ci:ui 36+16+30+14. Mock sent.

**WHERE I LEFT OFF:** committed + pushed on claude/broad-scan-l9ojgm.
No PR (owner asks explicitly).
