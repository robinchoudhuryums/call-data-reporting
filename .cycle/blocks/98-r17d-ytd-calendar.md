# Increment 98 — R17d: the Calendar is always available (year-to-date fallback)

Owner ask (Round 17d): "the 'Calendar' view is grayed-out/unclickable
unless the selected date range is a month or more — make it always
available and have year-to-date info available by default."

## Server — `trendYtd`, and why it costs nothing

`computeInsights_` already walks every row from `computeTrendStartDate_`
(12 months back) to the end date for the monthly rollup. Jan 1 of the end
date's year is ALWAYS inside that span, so a second accumulator over the
same pass yields a full year of DAILY buckets with no extra read and no
second query. `ytdTeam` is filled inside the existing
`if (inTrend && isRoster)` branch, so it inherits the INV-53 roster gate
by construction rather than by a parallel rule that could drift.

Payload: `trendYtd { from: '<year>-01-01', to: <end>, labels: ['MM-DD'…],
series: [{rung, missed, answered, ttt, att}…] }`, emitted at BOTH sites —
the real one and the empty-shape one, so the client never has to
existence-check it differently by path. `INSIGHTS_CACHE_KEY_PREFIX` →
`insights:v20` (INV-30), which `cache-version-sync.test.js` then forced
through five stale doc/comment references.

## Client — one decision function, read by four places

`insCalendarUsesYtd_(data)` is the ONLY place that decides which series
is on screen: queue metric → never (`queueHealth.dailySeries` is
window-scoped, so the 14–366-day rule survives there unchanged); window
fills a calendar → `trendDaily`; otherwise → `trendYtd` when it has more
than one day. `insCalendarEligible_`, `insRenderTrendCalendar_`, the
trend header and `insCalendarIneligibleReason_` all call it. That
matters more than it looks: the month list, the month-reset key and the
per-cell in-window gate must all come from `trendYtd.from/.to` in YTD
mode — leaving any ONE of them on `meta` blanks most of the year while
the rest of the grid looks fine.

**The caption is load-bearing, not decoration.** Cells describing the
year, sitting under a page scoped to one day, read as that day's data —
the exact misreading the old refuse-to-render gate avoided by showing
nothing at all. `.ins-cal-ytd-note` names the SELECTED window (the trend
header already names the YTD span, so repeating it there would be noise);
a single-day window renders one date, not `Aug 10–Aug 10`.

## The drill branch that had to change with it

`insCalJumpToDaily_`'s "no row for that date" fallback re-ran the region
for that single day by writing `ins-from`/`ins-to`. That was rare before
(a ≥14-day window has a daily row for nearly every cell) and is now the
COMMON path, since most YTD cells sit outside the window — and it
produces exactly the split-range state the owner rejected in R16g: the
top half of My Department on one range, Insights on another.

It now moves the DEPT controls (`from-date`/`to-date` + `refresh()`,
the page's single date authority since M4) and arms a one-shot
`insCalDayPending_`, consumed at the end of `insRenderReport_` after the
cascade through `insSyncToDeptWindow_` — read and cleared unconditionally
so a date the rebuilt table still lacks cannot leave the flag armed
(`insScrollPending_` discipline). The in-window branch is untouched.

## Harness — the single-day Insights payload

`getInsightsReport` served ONE 30-day fixture for every span, so the
region's single-day shape — which is what the dept page's DEFAULT window
renders (INV-43) — was never exercised, and the YTD branch was
structurally unreachable from the gate. `gen-payloads` now captures
`insights-day` and the stub picks by span like `getDepartmentSummary`.
Two drive-smoke assertions ride it (toggle enabled + active + cells
drawn; more months than the window has + the caption present), both
roles.

## Gates

661/661 unit (`insights-report.test.js` +1: `trendYtd` spans Jan 1 for a
ONE-day window, is roster-gated, and excludes the prior December the
12-month pass also visits), INV-16 green, UI gate 50/50 (was 46) +
16/16 + 30/30 + 14/14.

## NET

1 − 0 = 1. The feature the owner asked for, plus a fixture gap closed;
the one new failure mode it introduced (out-of-window drill splitting
the page's ranges) is fixed in the same increment rather than left.

## Where I left off

Committed, pushed, PR opened and merged. Deploy is Department Dashboard
only (`clasp push -f` from repo root + a new deployment version).
**Walk S37 and S14 after deploy**, and specifically: open My Department
on its default single-day window, expand Trends, pick Calendar, confirm
the year renders captioned and a day-click outside the window moves BOTH
halves of the page. Open: the queue metric still refuses a short window
(its series is window-scoped — a `queueHealth` YTD series would be a
separate, real read, unlike this one).
