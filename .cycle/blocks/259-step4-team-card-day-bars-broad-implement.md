---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 4" (2026-10-16; not scan findings), admin-only while trialled:
  - 7  Linked day bars in the My Department team cards, option B: one shared selection across the cards, a per-card readout line, workdays only, weekly past 31 workdays, monthly past ~6 months, keyboard + touch
  - Owner ruling mid-step ("Extend the dept payload"): the bars read per-day figures added to the payload the cards already use (same call), because the page held no per-day avg answer and, on parent depts (CSR / Sales / Power), the Insights daily series covers the dept's own roster while the % Answered card covers the combined view -- client-only bars would not have added up to the cards
New capabilities (G/ST): None (owner-requested feature)
Files modified:
  apps-script/department-dashboard/Data.gs (computeSummary_ opt-in totals.daily + a non-enumerable per-agent day map; summaryDailyList_; combineSummaries_ grand daily with the crossover / DATA-8 repeat days dropped; computeDeptQcdSnapshot_ range.daily, own queues, weighted avg answer; getDepartmentSummary asks for daily)
  apps-script/department-dashboard/script-5-dept.html (data-dts-metric on the tiles; dtsDayBuckets_ / dtsBarsActive_ / dtsDayMap_ / DTS_METRICS_ / dtsAttachDayBars_ / dtsSelect_ / dtsWire_)
  apps-script/department-dashboard/styles.html (.dts-daybars / .dts-bars / .dts-bar / .dts-axis / .dts-readout)
  tests/unit/day-bars.test.js (new, 10 tests), tests/README.md
  tools/ui-harness/drive-daybars.js (new asserting driver, 20 checks), tools/ui-harness/ci.mjs (new stage)
  docs: client-ui-conventions.md (day bars bullet), regression-scenarios.md (S62), invariants.md (INV-30 note), module-dependencies.md (regenerated), CLAUDE.md (S62 index line, driver list)

CHANGES:
7 | Data.gs | totals.daily = [iso, answered, missed] over the ROSTER agents (the tile's population), opt-in so Digest / Coaching / the agent app are unchanged; the per-agent map rides NON-ENUMERABLE (never serialized or cached) so combineSummaries_ drops a crossover agent's repeat days exactly where it drops their repeat totals -- the bars sum to the combined tile. qcd.range.daily = [iso, calls, answered, abandoned, avgAnswerSec] over the dept's OWN queues in the same scan (sums to the Queue calls / Abandoned % tiles). Compact tuples: the summary is cached under the ~100 KB per-value cap (year to date: 6.8 KB vs 18 KB as objects).
7 | script-5-dept.html, styles.html | Each tile with a per-day source gets a bar row (Transfer % has none). dtsDayBuckets_ (PURE): workdays only (weekends + isCompanyHolidayIso_ excluded; quiet workday = empty bar), weekly past 31 workdays, monthly past 130; per-workday averages on multi-day count buckets. One selection shared by every card (strip.__dts): hover, touch tap-to-hold, role=slider rows with focus / arrows / Home / End / Escape; each readout names the day and its own value. Admin-only: built only for an admin outside View-as, block carries data-admin-only. No new server request.

TEST RESULTS: passed -- node --test 2573 tests, 2572 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps regenerated and --check clean; drive-daybars 20/20 on its own; full ci:ui recorded in the commit; 9/9 bites land (crossover day drop, own-queue only, roster-only population, non-enumerable map, no partial grand daily, the 31-workday threshold, the holiday rule, the admin gate).
REGRESSION RISKS:
  - The summary payload grows by the two compact lists (about 6.8 KB on year to date, about 13 KB at the 2-year cap); the Overview blob is unaffected.
  - Weekend / holiday calls stay in the card totals but get no bar, by the owner's workdays-only rule; on a window with weekend activity the bars do not add up to the card by exactly that amount.
  - No cache-version bump (additive): a payload cached before the deploy draws no bars until the next ingest mints a new key.
INVARIANTS AT RISK: INV-53 (floaters kept out of the daily sums -- pinned); INV-30 (no bump, documented in the entry); INV-04 unaffected; INV-01 untouched (reads only).
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested feature)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- The CSR Transfer % card has no per-day source, so it gets no bars; a per-day transfer figure would need computeCsrTransferRange_ to bucket by date.
- With five cards (CSR), the fifth wraps to a second row (pre-existing four-column grid).
- Plan Step 5 remains (9a/9b notifications page, 10 coaching release prep, 9c alert reasons; all admin-only; stricter-only manager thresholds).

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
