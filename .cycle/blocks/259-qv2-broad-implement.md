---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: QV-2 (owner 2026-10-29) -- the day quick view's per-day reads are ONE combined server request (agent table + missed calls + admin outbound), and it takes a LIST of days so both neighbours prefetch in one request; same gates, same on-screen behaviour.
New capabilities (G/ST): None (an efficiency change to QV-1 / QV-1b)
Files modified: apps-script/department-dashboard/DayQuickView.gs (new), apps-script/department-dashboard/script-5-dept.html, tests/unit/day-quick-view.test.js (new), tests/unit/day-bars.test.js, tests/unit/cross-file-pins.test.js, tools/ui-harness/build-harness.js, tools/ui-harness/drive-dayqv.js, tools/ui-harness/README.md, tests/README.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/module-dependencies.md (regenerated), CLAUDE.md (Subsystems list)

CHANGES:
QV-2 | DayQuickView.gs | `getDayQuickView({ department, dates[≤3], outbound, includeExceptionDays, prefetch })`: `assertDeptAccess_` up front, ISO + deduped dates (at most `DQV_MAX_DATES_` = 3), the SEC-1 cap over the list; per day it calls the EXISTING `getDepartmentSummary` / `getMissedCallsReport` / (when asked) `getDeptOutboundSummary` for a one-day window inside one execution, so their gates (incl. the outbound vetting gate and the admin-only exception include), caches and payloads are unchanged; a part that throws lands in that day's `errors`; inner usage rows run under `REPORT_USAGE_SUPPRESS_` (restored in `finally`) and the request logs ONE `dayView` row, none for a prefetch; `meta.partMs` times each part.
QV-2 | script-5-dept.html | one per-DAY store `dqvFetchDays_(bs, ob, prefetch, ok, fail)` (key dept|iso|ob|inc; held days replay async, in-flight days joined, failures not kept, FIFO 18, cleared by `refresh()`), sending the unheld days in ONE request (split only by the exception flag); `dqvShow_` paints both sections from the one reply (a failed outbound part leaves the column on dashes, as before); `dqvPrefetch_` asks for both neighbours in one prefetch request. Removed the per-report `dqvFetch_` and QV-1b's `DQV_OB_STORE_`; `obSummaryFetch_` back to its pre-QV-1b signature.
QV-2 | build-harness.js | a `getDayQuickView` mock composed from the three endpoints' own mocks.
QV-2 | tests | day-quick-view.test.js (6 tests: parts + one-day windows, outbound-on-ask + the exception flag, per-part failure, usage suppression / one row / none on prefetch / restore, the gates, restore on a tampering part); day-bars.test.js QV-1 / QV-1b pins rewritten for the one request; cross-file-pins SEC-1 list gains getDayQuickView; drive-dayqv.js asserts the request count (open = 1, neighbours = 1, step = 1, no per-report RPC).

TEST RESULTS: `node --test` 2746 pass / 0 fail (TZ=America/Chicago); lint clean (79 files); module-deps regenerated; INV-16 guard in sync; drive-dayqv 25/25; full `CI=true TZ=America/Chicago npm run ci:ui` EXIT 0 (all 18 stages; drive-dayqv 25/25). Bites 7/7: unit -- suppression, dept gate, prefetch usage row, date cap, per-part failure isolation, neighbours only; UI -- neighbours sent separately turns the request-count check red.
REGRESSION RISKS: (1) The three parts now run in SEQUENCE in one execution where they used to run in parallel, so a COLD first open could take longer than before even though the server does less work in total; `meta.partMs` records each part so this can be measured after deploy. Steps hit prefetched days and are unaffected. (2) A request for three cold days runs up to nine parts in one execution; the client never sends more than two (the neighbours). (3) Usage telemetry: the per-report rows the pop-up used to write (QV-1, QV-1b) become one `dayView` row per opened day.
INVARIANTS AT RISK: None -- INV-01 (read-only; the usage append is the existing carve-out), SEC-1 (capped, and pinned in cross-file-pins), INV-30 (no new cache key; each part uses its own), INV-39 / the outbound gate (enforced by the wrapped endpoint itself).
NET SCORE: 1 − 0 = 1 (the QV-1b usage-row inflation would have fired in production: every prefetched neighbour wrote two or three Report Usage rows for days nobody opened)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (a NEW server file, DayQuickView.gs -- `clasp push -f` uploads it) | BLOCKS DEPLOY: N
- After deploy, open a day once and read `meta.partMs` (devtools, the getDayQuickView reply) to compare a cold open with before | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- If a cold first open proves slower in production, the open day could be sent as one request per part again (parallel) while the neighbours stay batched -- a client-only change.
- The Health page's usage section shows `dayView` as a raw report name (there is no label map); fine, noted.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---

---BROAD SCAN IMPLEMENTATION SUMMARY (addendum, 2026-10-29: QV-3)---
Findings implemented: QV-3 (owner 2026-10-29) -- the day quick view's loading states.
Files modified: apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/styles.html, tests/unit/day-bars.test.js, tools/ui-harness/drive-dayqv.js, tools/ui-harness/README.md, tests/README.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/regression-scenarios.md
CHANGES:
QV-3 | script-5-dept.html, styles.html | `dqvSkeletonHtml_` (six table rows, the outbound column when shown; the 18-slot chart + ring lines; an agent's KPI tiles + call lines; a labelled `role="status"`), `dqvBusy_` (skeleton when the section holds nothing of this visit, else `dsFrostShow_` over the current content, relabelled for the day on screen) and `dqvPaint_` (lifts either, clears `aria-busy`); a held (prefetched) day shows no busy state; a fresh open resets the "filled" marker so it never frosts the last visit's day. Replaces the one-line "Loading…" (the pop-up opened ~450 px tall and jumped to ~920; now ~765).
Two bugs caught on the way, both fixed and pinned: a second quick step kept the first day's frost label (`dsFrostShow_` keeps an overlay that is already up); inline skeleton lines had no width (`display: block`).
TEST RESULTS: `node --test` 2747 pass / 0 fail; lint clean; drive-dayqv 32/32 (seven new loading checks with held replies); full `CI=true TZ=America/Chicago npm run ci:ui` EXIT 0 (all 18 stages). Bites 4/4: unit -- the held-day skip, the relabel, the fresh-open reset; UI -- skeleton-instead-of-frost turns the stepping check red.
REGRESSION RISKS: None found (client-only, the pop-up's own sections).
INVARIANTS AT RISK: None.
NET SCORE: 0 − 0 = 0 (a polish item on an admin-trial surface)
OPERATOR ACTIONS / DEPLOY: deploy the dashboard; walk S62's QV-3 step | BLOCKS DEPLOY: N
FOLLOW-ON ITEMS: None new.
---END ADDENDUM---

---BROAD SCAN IMPLEMENTATION SUMMARY (addendum, 2026-10-29: QV-4)---
Findings implemented: QV-4 (owner 2026-10-29) -- a week / month day bar opens the quick view on its first workday; the arrows then step by day.
Files modified: apps-script/department-dashboard/script-5-dept.html, tests/unit/day-bars.test.js, tools/ui-harness/drive-dayqv.js, tools/ui-harness/README.md, tests/README.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/regression-scenarios.md
CHANGES:
QV-4 | script-5-dept.html | `strip.__dts.qv`, the quick view's per-DAY model (`dtsQuickViewDays_`: the bars' own buckets on a daily view; one per workday on a weekly / monthly one, built like the daily view -- weekends and holidays never a stop, an exception day its own stop with its figures); `dqvDayIndex_` maps a clicked bar to its day (itself, or its bucket's first workday = the bucket's own `from`); every dqv function reads the model through `dqvModel_`; `dqvDaily_` removed; the weekly / monthly idle line invites the click.
TEST RESULTS: `node --test` 2748 pass / 0 fail; lint clean; drive-dayqv 33/33, drive-daybars 24/24; full ci:ui -- see STATE. Bites 3/3: unit -- the first-workday mapping, the per-day model; UI -- a bar index used as a day index turns two drive-dayqv checks red.
REGRESSION RISKS: a click on a week / month bar used to do nothing; it now opens the pop-up (Escape closes). A year-to-date range builds ~210 day stops (cheap: client-side sums over the payload's existing daily tuples).
INVARIANTS AT RISK: None.
NET SCORE: 0 − 0 = 0 (new capability on an admin-trial surface)
OPERATOR ACTIONS / DEPLOY: deploy the dashboard; walk S62's QV-4 step | BLOCKS DEPLOY: N
FOLLOW-ON ITEMS: None.
---END ADDENDUM---
