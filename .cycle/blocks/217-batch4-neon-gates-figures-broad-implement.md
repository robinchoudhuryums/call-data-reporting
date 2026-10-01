---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 4 -- "Neon-flip gates and figure correctness", dashboard only):
- DL-1  the DQE parity gate counts ROWS per date|agent: a duplicated sheet agent-day (which the sheet path sums) is NOT clean any more -- it used to collapse to one map entry and read CLEAN
- DL-2  the DQE gate diffs `queueSplit` (fetched, never compared, so a COALESCE-preserved stale Neon split passed)
- QO-3  the QCD parity gate counts rows per date|queue|source -- the same duplicate blind spot
- QO-1  the Overview's "X viol MTD" chip is month-to-date through the LATEST QCD date (the D-8 rule), not through today -- the 1st of every month showed last month's latest day beside a green "0 viol MTD"; companyOverview:v26
- DL-4  a custom comparison window's DISTANCE is capped too: window + prior may span at most REPORT_MAX_SPAN_DAYS (731 + 366) days -- a two-day prior in 2000 read 26 years
- DL-5  the roster joins the `individual:`, both `missed:` and the `overviewChartYtd:` cache keys, and a combined `summary` hashes EVERY dept it shows (D-7 hashed only the primary)
- DL-6  a failed Missed-report enrichment (Neon configured but unreachable, or the query threw) is flagged `meta.enrichmentFailed` and never cached (it was pinned for 6 h un-enriched, unflagged)
- DL-9  CacheWarm resets the two sticky per-execution read-failure flags before each payload, and counts what the cache actually did (written / already cached / served but not cached / failed) instead of calls that returned

Files modified:
apps-script/department-dashboard/NeonRead.gs, apps-script/department-dashboard/QCDReport.gs, apps-script/department-dashboard/CompanyOverview.gs, apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/InsightsReport.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/MissedCallsReport.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/CacheWarm.gs, apps-script/department-dashboard/OrphanFix.gs + DeptConfig.gs (comment version refs only), tests/unit/dal-cutover.test.js, tests/unit/qcd-report.test.js, tests/unit/overview-qcd-snapshot.test.js, tests/unit/util.test.js, tests/unit/cache-key.test.js, tests/unit/missed-report.test.js, tests/unit/cache-warm-budget.test.js, CLAUDE.md (cache-tier roster sentence; companyOverview:v26), docs/invariants.md (INV-30), docs/operator-state.md (#19 gate contract), docs/known-issues.md, docs/conventions.md, docs/architecture.md, docs/client-ui-conventions.md (version refs), docs/module-dependencies.md (regenerated)

CHANGES:
DL-1 + DL-2 | NeonRead.gs (compareDqeSources_) | per-key row counts -> `duplicates` (verdict field, NOT clean), `queueSplit` added to FIELDS, MISMATCH text names the duplicate-merge repair
QO-3 | QCDReport.gs (compareQcdSources_) | `norm` records per-key counts; `duplicates` verdict field; NOT clean
QO-1 | CompanyOverview.gs (computeQcdSnapshots_) | MTD anchored on the latest Total-Calls QCD date in the grid; re-reads from that month's 1st when the window starts after it (free on the sheet path -- memoized whole sheet); cache v25 -> v26
DL-4 | Util.gs (REPORT_MAX_SPAN_DAYS, assertReportSpanCap_), IndividualReport.gs, InsightsReport.gs x2 | combined-span cap on every custom-prior site
DL-5 | Data.gs (rosterSetHash_, rosterAllDeptsHash_; summary uses the set), IndividualReport.gs, MissedCallsReport.gs (both key sites), CompanyOverview.gs (chart key) | key SUFFIXES (D-7 pattern), single-dept hash byte-identical to D-7
DL-6 | MissedCallsReport.gs | missedEnrichQueueOnlyFromInbound_ returns ok/skipped/failed; meta.enrichmentFailed; both cache-put sites skip on it
DL-9 | Config.gs (resetExecReadFailureFlags_, noteReportCache_, reportCacheTally_), Data.gs / CompanyOverview.gs / InsightsReport.gs / QCDReport.gs (note write + hit), CacheWarm.gs (warmOne_, four-way outcome, FAILED-ALL when nothing was cached) | honest warm accounting

TEST RESULTS: passed -- `npm run ci` 2041/2041 (16 new tests), INV-16 guard clean, module-deps regenerated + up to date; bare `TZ=UTC node --test` 2041/2041; `CI=true npm run lint:gas` clean (75 files). Every new pin was mutation-checked against the pre-batch file (git stash or a reverted line). cache-warm-budget.test.js's RPC stubs were updated to note a cache write (the DL-9 contract the real endpoints now follow) -- they encoded "returned = warmed". One mid-run failure was this session's own (cache-version-sync: the known-issues / conventions version tables still said companyOverview v25) -- fixed. ci:ui not run -- no client file touched.
REGRESSION RISKS:
- DL-1 / QO-3: a gate that read CLEAN before may now read MISMATCH on an install with duplicated sheet rows -- intended; that state was unsafe to flip on.
- QO-1: a dept with no QCD rows in the latest data month now shows 0 MTD for that month (previously the same 0 against the calendar month). Overview payloads re-key once (v26).
- DL-4: a legitimate custom prior more than ~3 years from the report window is now refused with a clear message.
- DL-5: one extra roster read per IR / Missed / Overview-chart request (the chart reads the roster block in ONE range); every key in those prefixes re-keys once on deploy (a cold cache for one TTL).
- DL-6: an install whose Neon is configured but down now recomputes the Missed report on every open until Neon returns (no cached un-enriched copy) -- the per-call facts were missing either way.
- DL-9: resetting the sticky flags means a payload computed AFTER a failed read in the same warm run is judged on its own reads; the flags still serve their purpose within each payload. The Health `out-warm` text changed shape ("already cached" / "served but not cached").
INVARIANTS AT RISK: INV-30 (companyOverview v26 -- entry, tables and every current-truth doc synced; the roster suffixes follow the D-7 no-bump pattern); INV-36 (new key segments are 32-char hashes, keys stay well under 250 chars); INV-01 (no new write path). None violated.
NET SCORE: 3 − 1 = 2 (production fixes this month: QO-1 -- fired today, Oct 1, and on the 1st of every month; DL-9 -- every warm run reported calls, not caches; DL-5 -- any roster edit inside a 6 h TTL. DL-1/DL-2/QO-3 are gate blind spots with no evidence of a flip this month; DL-4/DL-6 latent. New failure mode, documented above: DL-6 makes a Neon outage cost a recompute per Missed-report open.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (every change is in the dashboard project) | BLOCKS DEPLOY: Y
- Before any future DQE_READ_SOURCE / QCD_READ_SOURCE flip, re-run the parity gate: a `duplicates` count above 0 must be repaired first (Operator State #19 / #56) | BLOCKS DEPLOY: N
- After the next 9 AM warm, read the Health page's out-warm row: it should list "N warmed" and, if any, "served but not cached" | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- DL-6: the client does not yet render `meta.enrichmentFailed` (a one-line note on the queue-only card would say why wait / insurer are missing) -- client change, needs ci:ui.
- DL-5: Insights runs with an EXPLICIT agent selection still carry no roster dimension (the agent-free default already resolves to the roster); `companyOverview` relies on the Orphan Fix busts, so a hand edit of `DO NOT EDIT!` still lags it up to the TTL.
- DL-9: getOverviewChartTrend and the IR / Missed caches are not warmed, so they do not report outcomes; only the four warmed endpoints note writes.
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (INV-30, Operator State #19, the CLAUDE.md cache-tier sentence, the version tables). /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
