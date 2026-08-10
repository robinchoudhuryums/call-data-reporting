# Increment 93 — R16g: calendar→Daily-breakdown drill + Absolute view hidden

Two owner notes (2026-08-10, post-#225 testing).

## 1. Agents chart: Absolute hidden, Rung removed

The Absolute basis restated the agent table at the top of the same page
(the M3 reasoning that made gap the DEFAULT, taken to its end). The abs
seg-btn is display:none (Round-16 removal convention -- markup + wiring +
insRenderCardsChartAbs_ inert; the M3 saved-'abs' self-heal already
existed; the admin A/B remote still reaches it). The metric selector
dropped Rung (~ answered + missed; its gap/trend lines restated the other
two): option removed, saved-'rung' pref self-heals to answered in
insRestorePrefs_, renderers still accept 'rung' if fed.

## 2. Calendar day-click → Daily breakdown drill

OLD: clicking a calendar day RELOADED the Insights region for that single
date -- the dept half of the page kept its range, so the two halves showed
conflicting windows. NEW (`insCalJumpToDaily_`): open the Queue-health
fold + the daily details, expand the date's day group (the existing
insJumpToDailyRow_ smooth-scroll + flash), and insert a per-DATE drill row
(`insQhDayDetail_`): getMissedCallsSlice with from=to=date and NO dow/hour
filter -- every missed ring + queue abandon for the day (time · agent or
queue · 🚨 · "↳ path" via parentId), rendered by the heatmap drill's
missedSliceListHtml_ so the path chips ride the delegated .pid-journey
handler (initClipboardOnce). The detail row joins the day group's
open/close (insQhDayToggle_'s selector covers sub + detail rows) and
inherits the R16f in/out animations. FALLBACK: the old single-day reload
survives ONLY when the daily table can't take the jump (no QCD daily
rows, or the date outside its series) -- a dead click would be worse.
The trend LINE chart's point-drill keeps the reload (owner scoped the
complaint to the calendar). Cell titles updated ("Click to open this day
in the Daily breakdown").

NOTE (wait time / call path): the DQE missed-ring lens carries time +
agent/queue + the parentId path drill, but NOT wait seconds -- that lives
in the inbound lens (getInboundHeatmapCell), which is dow×slot-scoped and
can't serve a whole date without a new RPC. If the owner wants wait times
in this drill, that's a server addition (per-date inbound abandons list).

Probe: day-click on the calendar → fold+daily open, day group expanded,
detail row visible with 39 path chips, Insights window UNCHANGED (the
old conflicting-range behavior gone). The harness's canned missed-slice
payload ignores date args, so the mock shows a range's entries -- prod
returns only the clicked date.

Gates: 653/0, INV-16, ci:ui 36+16+30+14. No PR (not requested).
