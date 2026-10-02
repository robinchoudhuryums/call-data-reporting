---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 7 -- "Client correctness (wrong or missing information)", dashboard client only):
- CL-2  Insights agent cards: on different-length windows the volume/time delta badges compare PER DAY and the per-day subline (insMetricPerDay_, defined but never called) renders; the badge no longer claims a "same-length" comparison
- CL-1  the Overview Company line wears THEME.ink (THEME.text does not exist, so it fell back to near-black, invisible on the dark card)
- CL-15 Access Control and Dept Config keep their save/remove message across the post-write reload (the Orphan Fix preserveStatus pattern), so the F11 / S2B-1 / S2B-5 / S2B-6 warnings are readable
- CL-17 an Insights share or digest deep link carries its window into the dept controls (the page's one date authority) and marks it user-chosen, so the latest-date snap no longer re-runs Insights over the latest day
- CL-18 boot enters through bootInit_ and every surface init runs under initStep_: a throwing step is recorded, beaconed and skipped, and a role=alert note names it; a throw outside the steps replaces the skeleton with a "failed to start" note
- CL-4  an error toast with no explicit duration is sticky (✕ to dismiss, role=alert, selectable text, max 3); input nudges pass a duration and stay transient; escalation restore and the queue-report email/blast failures also land inline
- CL-6  a failed abandon-heatmap load shows an error with Retry instead of hiding the panel
- CL-16 isAllDeptViewer_ is false while an admin previews a manager (View as), so chart-point / tile clicks no longer route to another dept; canPickDept_ keeps the raw role so the pinned selector still drives getRequestedDept
- CL-14 the agent app's presets anchor to yesterday (not today) when the latest date is unknown, and the header says so
- CL-7  an IR Generate request superseded by the edit popover's Apply gives the Generate button back (it sat on "Loading…")
- CL-5  the share-link copy believes execCommand's return value; a refused copy opens a dialog with the link pre-selected instead of claiming success or putting the URL in a toast
- CL-22 a Report Subscribers save whose second half fails says which half saved and reloads to show it

Files modified:
apps-script/department-dashboard/script-1-core.html, script-2-chrome.html, script-3-overview.html, script-4-nav.html, script-5-dept.html, script-6-ir.html, script-7-admin.html, script-8-insights.html, script-9-inbound-direct.html, script-10-escalations.html, script-11-qcd-boot.html, agentApp.html, styles.html, tests/unit/client-correctness.test.js (new), tests/unit/overview-chart-answered.test.js, tests/README.md, docs/client-ui-conventions.md

CHANGES:
CL-2 | script-8-insights.html (insPerDayDeltaPct_, insDeltaBadge_ meta/perDayKind, insBuildCard_ wiring), styles.html (.ins-card-bars2 .ins-metric-perday) | per-day basis = calendar days, matching the subline and the CSV /day columns
CL-1 | script-3-overview.html | THEME.text -> THEME.ink (3 sites)
CL-15 | script-7-admin.html (acLoadInit_/acClearForm_/dcLoadInit_ preserveStatus; 6 write-path reloads pass true) | modal opens still clear
CL-17 | script-4-nav.html (insCarryLinkWindowToDept_, called from the Insights share provider's apply), script-8-insights.html (saved views pass keepDeptWindow) | sets from/to-date, datesTouched_, clearActivePreset_, refresh() when the window moved
CL-18 | script-2-chrome.html (bootFailures_, initStep_, bootFailureNotice_, bootInit_; 30 steps wrapped), script-11-qcd-boot.html (boot via bootInit_), styles.html | beacon kind boot-failure
CL-4 | script-1-core.html (showToast sticky errors, TOAST_STICKY_MAX_), styles.html (.toast-sticky/.toast-close), script-5/6/8 (input nudges pass 4000), script-10 (escRowError_ on restore failure), script-11 (qadSetStatus_ on email + blast outcomes) |
CL-6 | script-9-inbound-direct.html (loadAbandonHeatmap_ failure handler) | no beacon -- CLAUDE.md R19: a panel with its own visible error state does not report
CL-16 | script-2-chrome.html (isAllDeptRole_, isAllDeptViewer_ preview-aware, canPickDept_ on the raw role) |
CL-14 | agentApp.html (yesterdayIso_, applyPreset anchor, noteUnknownFreshness_ on null + failure) |
CL-7 | script-6-ir.html (irGenerateTok_, releaseIfSuperseded in both handlers) | P29 kept: a newer Generate still owns the button
CL-5 | script-8-insights.html (insCopyShareLink_: legacyCopy checks === true, clipboard rejection -> legacy -> dsPrompt_ with the URL) |
CL-22 | script-7-admin.html (alRsSave_ labels/saved, "Partly saved" + alLoadInit_) |

TEST RESULTS: passed -- `npm run ci` 2083/2083 (12 new tests in the new client-correctness suite), INV-16 guard clean, module-deps up to date; bare `TZ=UTC node --test` 2083/2083; `CI=true npm run lint:gas` clean (75 files); `npm run ci:ui` all eight asserting stages passed (smoke 113/113, keyboard 18/18, sub-queue 38/38, journey 14/14, admin 123/123, dev overlay 14/14, agent 20/20). Every new pin was mutation-checked by reverting each touched fragment to HEAD in turn (each reverted file fails its own pins). One test double encoded the bug and was updated as part of CL-1: overview-chart-answered pinned `THEME.text`. Two failures mid-run were this session's own: a comment that swallowed a `return; }` in script-8 (caught by html-include-structure's assembled-body parse) and two test-side issues (cross-realm array compare; a token-count regex). Regression Scenarios S14/S18/S19/S20/S23/S25/S36/S37 not walked live (no deployed app here) -- the rendered gate covers boot, view-as, the admin modals and the agent app.
REGRESSION RISKS:
- CL-4: every error toast without a duration now stays until dismissed; a burst of failures stacks up to three. Any remaining input-validation toast that I did not tag with a duration (none found among the 27 error-toast sites) would linger.
- CL-16: while previewing a manager, an admin can no longer click into another dept from the Overview chart or tiles -- by design (the preview IS that manager); exiting View as restores it.
- CL-17: opening an Insights share/digest link now also moves the My Department window to the linked range (that is the point -- the page has one date authority); a second dept-summary fetch is issued when the window changed (refresh's token drops the stale reply).
- CL-18: a broken surface init now degrades to "this surface missing + a note" instead of a hung page; an init that previously threw silently AFTER doing useful work will now also produce a boot-failure beacon email.
- CL-2: cards on a mismatched custom prior show different (per-day) delta figures than before; equal-length windows are byte-identical.
INVARIANTS AT RISK: INV-37 (setPage/refresh untouched; CL-17 calls refresh() only on the dept page); INV-39 / the view-as contract (CL-16 narrows client gates only; the server strips are unchanged); INV-42 (CL-1 now resolves through THEME, as the invariant requires). None violated.
NET SCORE: 3 − 1 = 2 (production fixes this month: CL-1 -- every admin in dark mode; CL-17 -- every digest/share Insights link; CL-15 -- every AC/DC save that carries a warning. CL-2/CL-4/CL-5/CL-6/CL-7/CL-14/CL-16/CL-18/CL-22 are real but rarer, or behind flags (the agent app is off by default). New failure mode, documented above: CL-4's sticky error toasts can accumulate on screen.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (every change is client-side in the dashboard project) | BLOCKS DEPLOY: Y
- After deploy, walk S37 / S19 once with a digest Insights link (the window should hold) and S25 in View as (tiles should not route) | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- CL-4: the scan's exact list of seven toast-only failures was not preserved in the report; the sticky toast covers every error toast by construction, and inline status was added where a surface had a status line (escalation restore, queue report). Coaching's flag failure stays toast-only: its worklist reload immediately repaints the status line.
- CL-6: the scope asked for a beacon too; skipped deliberately per CLAUDE.md's R19 rule (panels with their own visible error state must not beacon).
- CL-17: a saved view applied from inside the open region still sets only the Insights window (it runs the report itself); the dept table stays on its own window until the next refresh.
- The Insights KPI tiles (team rollup) still show raw volume deltas on mismatched windows; only the per-agent cards were in scope.
- CL-7's mirror risk exists in Insights (runInsReport vs its popover) -- not verified, not changed.
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (docs/client-ui-conventions.md: the boot guard + the sticky-toast rule; tests/README map). /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
