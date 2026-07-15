# Spec — Chart → Missed-Calls drill-down (heavier / per-cell)

Status: **APPROVED — Phase 1 implemented; Phases 2–4 pending.** Follows the
shipped *lighter* hand-off (PR #168: navigational "See missed calls →" from
Insights Queue health + the collapsed Insights summary strip on My Department).
This spec covers the **heavier** version: clicking a specific element on the
Insights charts — a **heatmap cell**, a **Queue-health queue row**, or an
**agent missed-calls bar** — and landing on the *matching* call-by-call
Missed-Calls detail, not just the whole dept/range.

**Owner rulings (locked):** (1) **two labeled lenses** — the heatmap keeps its
own inbound count and gains a separate, labeled "DQE missed rings" lens (no
re-sourcing); (2) cross-source detail shows in an **in-place overlay** (keeps
the chart context); (3) build order confirmed. **Phase 1 (server slice +
tests) is shipped** — `getMissedCallsSlice` in `MissedCallsReport.gs`, pinned by
`tests/unit/missed-slice.test.js`.

This is a **dashboard** drill (cross-page, read-only). It is NOT the
editor-side `docs/qcd-drilldown-design.md` (that traces QCD numbers back to
Raw Data legs in the spreadsheet for auditing). They can coexist.

---

## The core constraint: three surfaces, three data sources

The single fact that shapes this whole design — the three drill targets are
computed from **different tables with different definitions of "a bad call":**

| Surface | Where it lives | Source table | What it counts | Has call-level rows? |
|---|---|---|---|---|
| **Temporal abandon heatmap** (`getInboundHeatmap` / `getInboundHeatmapCell`) | Insights (admin-only) | `inbound_calls` | **Abandoned inbound calls**, weekday×hour, CST (`call_start` raw PST +2h) | **Yes** — already drills to individual abandoned calls + `getCallJourney` |
| **Queue health** (`computeQcdReport_`) | Insights (manager: own dept) | `qcd_history` | **Aggregate** abandoned counts / violations per queue/day | **No** — QCD is roll-up counters, no per-call rows |
| **Agent missed-calls bar chart** (`getMissedCallsReport`) | My Department Missed section (manager: own dept) | `dqe_history` (DQE missed detail) | **Missed agent rings** + abandoned parents, 18 half-hour CST buckets (INV-18, 8 AM–5 PM) | **Yes** — bucket detail + abandoned-parent `↳ path` journey (`getCallJourney`) |

**Why this matters:** the heatmap's abandon count and the Missed report's
abandon count come from different pipelines and do **not** reconcile — this is
the known, *parked* "QCD-vs-inbound abandonment discrepancy" (CLAUDE.md, Inbound
bullet). A naïve "click a heatmap cell → show the Missed rows for that
weekday×hour" would put **two numbers that disagree** next to each other with no
explanation. Avoiding that is the whole design problem.

The good news: **time zone is already consistent** across all three — the
heatmap shifts `call_start` +2h to CST (`INBOUND_HEATMAP_CST_SHIFT_HOURS`), DQE
slots are stored CST (INV-20, no reconvert), and the Missed buckets are CST
(INV-18). So an hour window means the same wall-clock on every surface. Weekday
is derivable everywhere (both sources are per-date).

---

## Design principles

1. **A drill reconciles with the number it drills from.** Clicking an element
   sourced from table X opens detail from table X. We never silently swap the
   count under the user. (The heatmap already honors this; we keep it.)
2. **"My Department Missed Calls info" is the DQE lens.** When the owner says the
   drilldown data "would be My Department Missed Calls info," that is the
   `dqe_history` missed report. So the cross-source drills (heatmap, queue
   health) surface the DQE missed detail as a **clearly-labeled second lens**,
   with its own (possibly different) count and a one-line "different source &
   definition" note — never as a replacement for the surface's own number.
3. **Reuse, don't reinvent, the renderers.** The Missed section already has a
   per-bucket detail factory (`makeMissedBucketDetail_`), per-agent timelines,
   and the `↳ path` journey overlay (`getCallJourney`, `clJourneyRowHtml_`). All
   three drills render through these. No new call-card markup.
4. **Read-only, additive, flag-free.** No new writes, no cache-version bumps to
   existing report payloads (the one new endpoint gets its own key).

---

## Per-surface drill design

### A. Agent missed-calls bar chart (My Department) — *already the reference*

This bar (hour-of-day, `deptMissedDrawChart_`) is DQE-sourced, so it already
reconciles, and clicking a bar already opens that bucket's detail
(`deptMissedBucketDetail_.toggle(idx)`). **Heavier ask here is small:** make the
per-bucket detail list each abandoned parent with its `↳ path` journey link
inline (today the journey link lives on the per-agent timelines; the bucket
panel lists times). One client change in `makeMissedBucketDetail_` to emit
`.pid-journey` chips for abandoned entries in the bucket. No server work.

### B. Queue health (Insights) — scoped navigational hand-off

QCD has **no call-level rows**, so there is nothing to open in place that
reconciles with the queue's abandon count. Two honest routes:

- **B1 (recommended, dashboard):** upgrade the shipped "See missed calls →"
  hand-off (PR #168) from *whole-dept/range* to **queue-scoped**: carry the
  clicked queue into the Missed section and pre-filter its per-agent timelines /
  abandoned section to that queue's extension set. Labeled "DQE missed-ring lens
  for queue X — distinct from the QCD abandon count above (N)."
- **B2 (separate effort):** the editor-side QCD→Raw-Data leg trace in
  `docs/qcd-drilldown-design.md`. That is the tool for "audit *this exact* QCD
  abandon number," and it belongs in the spreadsheet, not the dashboard. Out of
  scope here; cross-reference only.

### C. Temporal abandon heatmap (Insights, admin) — dual-lens cell drill

The cell drill **already exists** and reconciles with the cell (inbound
abandoned calls + journeys, `getInboundHeatmapCell`). The heavier ask adds a
**second tab / section** inside the existing cell-drill panel:

- **Lens 1 (unchanged):** "Abandoned inbound calls — N" (the current list; this
  is the number the cell colored).
- **Lens 2 (new):** "DQE missed rings — M" for the **same weekday × hour
  window** over the report range, from the new filtered Missed endpoint (§ below),
  each abandoned parent carrying its `↳ path` journey. Header note: "Agent-ring
  lens (DQE) — a different source & definition than the abandon count above."

So the heatmap keeps its self-consistent number *and* answers "what were the
agents doing in that slot" — the thing the owner actually wants — without
pretending the two counts are the same.

---

## The shared new capability: a filtered Missed endpoint + drill overlay

All three drills need "give me the Missed detail for a **narrower** scope than
the whole dept/range." One new read-only server endpoint provides it; the client
renders it in a lightweight overlay (heatmap/queue-health) or in-place (bar
chart, already there).

### Server: `getMissedCallsSlice(req)` (MissedCallsReport.gs)

Thin wrapper over the existing `computeMissedCallsReport_` with an optional
filter applied to its already-computed per-call entries (so the heavy DQE read
+ bucketing is unchanged and stays cache-shared):

```
req = {
  department, from, to,          // same auth + validation as getMissedCallsReport
  isoDow?    : 1..5,             // heatmap weekday
  hourStart? : "HH:MM", hourEnd? : "HH:MM",   // CST window (heatmap slot / bar bucket)
  queue?     : "A_Q_...",        // queue-health queue (matched via its ext set)
  agent?     : "Name"            // optional narrowing
}
-> { meta:{department,from,to,filter, matchedCount, source:'dqe'}, entries:[ ... ] }
```

- **Reuse, don't re-query:** call `computeMissedCallsReport_(dept, from, to,
  'roster')`, then filter its per-agent timeline entries + abandoned-parent
  entries by `(weekday(date)==isoDow) && (bucketTime in [hourStart,hourEnd)) &&
  (queue matches) && (agent matches)`. Weekday from the entry's date; bucket
  time from the stored CST H:MM:SS. Entries already carry `parentId` + `date`,
  so the client's `↳ path` journey works unchanged.
- **Auth:** identical to `getMissedCallsReport` — `resolveUser_` + `assertDeptAccess_(user, dept)`; manager pinned to own dept. The journey drill inside stays F-4-gated (`callIdInDeptMissedReport_`).
- **Cache:** own key `missedSlice:v1:<dept>:<from>:<to>:<filter-hash>:<dqeSrc>`
  (source-suffixed per CORE-3), `REPORT_CACHE_TTL_SECONDS`. Or skip caching
  (it's a filter over an already-cached compute; cheap) — recommend uncached
  like the heatmap cell drill.

### Client: reuse existing renderers

- Heatmap Lens 2 + Queue-health overlay: a small `#missed-slice-overlay` (mirror
  the existing `#call-journey-overlay` pattern) that renders the returned
  entries with the shared `clJourneyRowHtml_` / abandoned-parent markup and the
  `.pid-journey` chips. No new card CSS.
- Bar chart: no overlay — enrich the in-place bucket detail (§A).

---

## Time-zone & data caveats (must be surfaced, not hidden)

- **CST alignment holds** (heatmap +2h shift == DQE/Missed stored CST), so an
  `[hourStart,hourEnd)` window means the same slot on every surface. Pin this
  with a test: a fixture call at 10:15 CST lands in the heatmap 10:00 slot AND
  the Missed 10:00 bucket AND passes the slice filter.
- **PST→CST era split (pre-2026-03-09):** DQE slot/abandon times before the
  cutover are stored PST (2h behind) until `repairDqeOldPstTimestampShift()` is
  run. A weekday×hour slice over an unrepaired range mis-buckets those days ~2h
  early — the *same* pre-existing Missed-report caveat, inherited. Note it in the
  overlay when `from < 2026-03-09`; don't try to fix it here.
- **Cross-source counts differ by design.** Every cross-lens surface (heatmap
  Lens 2, queue-health hand-off) carries the "different source & definition"
  note so the two numbers reading differently is understood, not a bug report.

---

## Auth / security summary

- New `getMissedCallsSlice` = same gate as `getMissedCallsReport` (signed-in +
  `assertDeptAccess_`; manager → own dept only). Filter params are validated
  (isoDow 1–5, HH:MM shape, queue ∈ dept's effective set) and never inlined into
  SQL (the compute reads DQE via the existing DAL; the filter is in-memory).
- Heatmap drills stay admin-only (the Insights heatmap is admin-gated); the new
  DQE lens there rides the same admin context.
- Journey overlay unchanged — still F-4-gated per call id.

---

## Phased delivery

- **Phase 1 — server slice + tests. ✅ SHIPPED.** `getMissedCallsSlice`
  (filter over `computeMissedCallsReport_` via the pure `missedSliceFilter_`) +
  `missedSliceValidateFilter_` + `missedSliceIsoDow_` + `missedReportDataCached_`
  (shares the section's `missed:v14` cache). Filters: `isoDow`, `hourStart` /
  `hourEnd` (CST), `agent`, `queue`. Response: `{ meta:{ department, from, to,
  filter, lens:'dqe-missed', source:'dqe', matchedCount, abandonedCount,
  abandonedDetailLost }, entries:[{ date, time, label, abandoned, parentId,
  sortKey, bucket, source:'agent'|'queue', who }] }`. Auth = `getMissedCallsReport`
  (signed-in + `assertDeptAccess_`). Pinned by `tests/unit/missed-slice.test.js`
  (weekday/hour/agent filters, empty-filter passthrough, validation throws, the
  pure-helper flatten). **Known Phase-1 limitation:** the `queue` filter narrows
  the queue-only abandoned section only — agent rings aren't queue-tagged in the
  Missed payload, so a queue filter excludes them (the weekday/hour path the
  heatmap needs is unaffected). No UI yet. Zero risk to existing reports.
- **Phase 2 — bar-chart bucket enrichment (§A).** `.pid-journey` chips in the
  Missed bucket detail. Client-only, smallest visible win, no new endpoint call
  (bucket data is already client-side).
- **Phase 3 — Queue-health queue-scoped hand-off (§B1).** Upgrade PR #168's
  "See missed calls →" to carry the queue + pre-filter. Uses Phase 1 for the
  filtered view (or the existing section with a client filter).
- **Phase 4 — heatmap dual-lens cell drill (§C).** Add Lens 2 to the cell panel
  via `getMissedCallsSlice` + the overlay. Admin-only; highest-effort, do last.

Each phase is independently shippable and independently valuable.

---

## Decisions (resolved)

1. **Cross-lens honesty — RESOLVED: two labeled lenses.** The heatmap keeps its
   own inbound abandon count and gains a separate, clearly-labeled "DQE missed
   rings" lens. NOT re-sourcing the heatmap from `dqe_history` (that would change
   what the heatmap *is* — abandon-of-inbound → missed-rings). Counts may differ;
   the "different source & definition" note makes that explicit.
2. **Queue health — RESOLVED: dashboard hand-off (B1) here.** The editor-side
   QCD-leg trace (`qcd-drilldown-design.md`) stays its own effort (it answers
   "prove this exact QCD number," a different question).
3. **Presentation — RESOLVED: in-place overlay.** Show the filtered Missed
   detail in a lightweight overlay over the chart (keeps context), NOT a
   navigate-and-pre-filter of the My Department section.
4. **Phase 1 filter scope — RESOLVED: shipped all of** `{isoDow, hourStart,
   hourEnd, queue, agent}` (one in-memory filter; agent/queue nearly free) so
   Phases 2–4 don't reopen the endpoint.
