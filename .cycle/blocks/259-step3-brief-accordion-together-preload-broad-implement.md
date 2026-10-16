---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 3" (2026-10-16; not scan findings), all admin-only while trialled:
  - 3  The Insights ranked brief is an ACCORDION directly under the My Department team cards, above the Agent Call Metrics table; every section starts collapsed and opens IN PLACE under its row
  - 5  Inbound and outbound TOGETHER by default: the Inbound | Outbound | Both switch became one "Show outbound columns" toggle (on = Both); Outbound and Callbacks are their own accordion rows, independent of the toggle
  - 8  Preloading: the Callbacks payload and the Direct lines block load in the background once the page settles; the inline agent panel is prefetched on row hover / focus
New capabilities (G/ST): None (owner-requested features)
Files modified:
  apps-script/department-dashboard/dashboard.html (#ins-brief moved under #dept-team-strip; the 3-way switch -> one [data-ob-cols] toggle in the same admin-only container)
  apps-script/department-dashboard/script-8-insights.html (accordion: INS_BRIEF_OPEN_ / _MOUNTED_, insBriefActive_, mount / unmount / restore, insBriefApply_ / _Toggle_, insOpenSection_, insBriefRowText_ / RowFromHead_; Outbound row; fold store skips mounted sections; deptInsightsEnsureLive_ generates for the brief; insObSync_ / insCbSync_ gate on obAllowed_; Callbacks preload via insCbFetch_ + INS_CB_PREFETCH_MS_; chart only while open; deep link opens the row)
  apps-script/department-dashboard/script-5-dept.html (obDir_ defaults to 'both', 'in' only when saved; the toggle)
  apps-script/department-dashboard/script-9-inbound-direct.html (obDlSync_ opts.prefetchMs; obDlFetch_ split out)
  apps-script/department-dashboard/script-10-escalations.html (agent panel prefetch store apPreFetch_ / apPreStrip_ / apPreDay_, hover + focus wiring; apLoadStrip_ / apSelectDay_ read through it)
  apps-script/department-dashboard/styles.html (accordion slot, chevron, hidden in-slot summary)
  tests/unit/brief-accordion.test.js (new, 14 tests), insights-brief.test.js (F20 + F24 for the accordion), cross-file-pins.test.js (6c: obAllowed_ not obEffectiveDir_), client-lifecycle.test.js (CL-2 sandbox loads the store)
  tools/ui-harness: drive-smoke (accordion placement / collapsed / open-in-place / close / View-as home; openInsSection helper), drive-crossstate, drive-deptoutbound, drive-outbound-e, drive-callbacks (default Both, toggle, rows, preload counts), drive-agentpanel (hover prefetch), drive-f13 (opens the Queue row by keyboard), drive-f13 / drive-agentpanel / drive-subqueue pin the inbound table ('in')
  docs: client-ui-conventions.md (Outbound columns, Outbound summary, Callbacks, the brief, the agent panel prefetch), regression-scenarios.md (S56, S57, S58, S59, S60, S61), tests/README.md, CLAUDE.md (two scenario titles, one driver line)

CHANGES:
3 | dashboard.html, script-8, styles | #ins-brief sits between #dept-team-strip and the agent table. Each row is a disclosure button; the section's EXISTING element is moved into the row's slot (a hidden [data-ins-home] placeholder marks home) and moved back at the top of every insRenderBrief_, so ids, renderers and draw-on-open listeners are unchanged and View-as / managers get every section home (insBriefRestoreFolds_ re-applies the saved fold state). Open state is per page load; the per-user fold store is never written by the accordion. Jumps (agent chip, calendar day, Callbacks deep link) open the ROW via insOpenSection_. Row text for Outbound / Callbacks updates in place (a rebuild would steal focus). deptInsightsEnsureLive_ generates for the admin even with the bottom region collapsed.
5 | dashboard.html, script-5, script-8, styles | One "Show outbound columns" toggle (aria-pressed); obDir_ = 'both' unless 'in' was saved (a retired 'out' lands on 'both', so the Outbound-only rendering is now unreachable, left inert). Outbound + Callbacks sections follow obAllowed_ only and are their own grey brief rows (rank: queue, agents, outbound, callbacks, detail, trend).
8 | script-8, script-9, script-10 | Callbacks: ONLY while My Department is the page (insCbOnDeptPage_; the dept page also renders under the Overview landing, and entering it re-syncs via deptInsightsEnsureLive_), a closed section fetches INS_CB_PREFETCH_MS_ (1.5 s) after the last sync, joining any fetch already out (INS_CB_.loadingKey); opening fetches at once; the chart draws only while open (C3). Direct lines preloads with it (opts.prefetchMs; the Overview's block stays lazy). Agent panel: hover / focus on a row of either table loads strip + newest day after 250 ms into a capped (24) per-page store the open reads through; failures are not kept; keys carry window + dept.

TEST RESULTS: passed -- node --test 2563 tests, 2562 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps --check clean; ci:ui green on the full gate; 16/16 bites land (two pins were tightened after their first bite missed: the open-section join, and the Outbound row's in-place update). The gate runs caught, in order: two driver gaps from collapsed-by-default (the admin agents chart no longer draws on landing -- the T-9 floor now opens its row; the trend check ran after an earlier step had left the Calendar view selected); a driver race (an explicit Refresh clears the shared outbound store by design, so "turning the columns on asks for nothing" became "each window at most once"); and ONE REAL BUG -- drive-cbdept's lazy check saw the Callbacks + Direct lines preload firing from the Overview landing (the dept page renders underneath it), fixed by the dept-page guard above.
REGRESSION RISKS:
  - Admin landing on My Department now shows the COMBINED (Both) table, not the inbound one; Export / Copy still produce the inbound table (the note says so). The Outbound-only view (Avg talk, Attempts columns) is no longer reachable; Team Outbound and the Outbound row carry the outbound detail.
  - Every admin page load now sends the Callbacks + Direct lines requests (one each per window, ~1.5 s after settle) and, on hover, agent panel requests -- extra Neon reads metered as before. Managers and View-as send none.
  - Moving live DOM between the brief and home: a section added to INS_BRIEF_TARGET_ must keep its own id and a data-fold; the placeholder rule depends on it.
INVARIANTS AT RISK: None changed. INV-39 / the 6c gate untouched (the toggle keeps the admin-only container and obAllowed_ stays the one client permission; cross-file-pins' 6c pin updated to the new line). INV-01 untouched (client only). INV-37 untouched.
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested features)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- The unreachable Outbound-only rendering (obViewRender_'s non-both branch, the body[data-dir="out"] CSS) can be deleted once the owner confirms the Both view is the keeper.
- Plan Steps 4 (day bars option B) and 5 (notifications / coaching / alert reasons, all admin-only) remain.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
