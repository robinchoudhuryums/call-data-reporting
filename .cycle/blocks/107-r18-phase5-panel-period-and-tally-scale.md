---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18 item 1 (second half) | The Team Rings panel had no period toggle — panel 1 has had Yesterday/MTD since R16
- R18 tally scale (owner, post-deploy) | The Daily Call Queue Report email's per-section tally unit made bar length incomparable across departments

Files modified:
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-5-dept.html
- apps-script/department-dashboard/QueueReportEmail.gs
- tests/unit/queue-report.test.js
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md

CHANGES:
item 1 | dashboard.html + script-5-dept.html | `#trp-period` reuses panel 1's control markup with a THIRD option. Range is the default and stays it: it is the page's own window and therefore the only period whose figures reconcile with the agent table beside it. Yesterday / MTD are windows off `latestDqeIso_`, decoupled from the page dates the way panel 1's already are, and the date chip NAMES them (`· MTD` / `· latest day`) — an unlabelled span next to a table built from another window reads as a bug.
item 1 | script-5-dept.html | The two fixed periods fetch on demand via `getDepartmentSummary` with a different from/to — the endpoint the Overview mini-table already reuses this way — rather than by widening `computeSummary_`'s read. MTD can sit months from the selected window; paying that on EVERY dept load to serve a panel toggle is the wrong trade. Memoized per (dept, from, to) on top of the server's 30-min `summary:` cache, and the memo is dropped in `refresh()`: surviving an explicit Refresh is the one way this panel could lie. A pending fetch FROSTS the panel rather than flashing it empty; a failure falls back to Range and says so in the chip.
tally | QueueReportEmail.gs | The unit is EMAIL-WIDE again and R16d's per-section unit is retired. Per-section was defensible on paper — each section reads well, cross-dept magnitude is in the Total column — and it does not survive contact with a reader: bar length is pre-attentive, a caption is not. Measured on the 2026-08-11 email, CSR's 349 calls drew 17 blocks while Sales (50) and Field Ops Power (25) each drew 25, so the busiest queue in the company rendered as the shortest of the three; the owner reported the milder Field Ops (42, 21 blocks) vs Field Ops Power (25, 25 blocks) inversion.
tally | QueueReportEmail.gs | `tallyBasisFor_` picks what the one unit scales to. The naive answer — the true maximum — fails here: a 349-to-1 day puts nine of twelve queues under a single block and the small half of the report stops saying anything. Leading OUTLIERS (a value more than `TALLY_OUTLIER_RATIO` = 2.5× the next down) are dropped, the largest survivor sets the scale, and dropped rows CLIP at the 25-block ceiling carrying a `»`. Two guards keep it honest: a broad top is NOT an outlier (349 vs 300 stops the walk immediately, nothing clips, and the squeeze is real rather than an artifact of dropping rows), and the walk can never drop more than a quarter of the rows or leave fewer than two survivors.
tally | QueueReportEmail.gs | A clipped row keeps its answered/abandoned proportions and never exceeds the ceiling, so R16e's layout constraint (past the column's width budget the renderer shrinks every cell and blocks stop being uniform) still holds. The block size and the `»` legend are disclosed ONCE in the table footnote, beside the sentence that already explains the bars — the per-section banner note was what made a changing scale look sanctioned, and the column header proved too narrow to carry the text without wrapping to two lines (verified by rendering the email).
tests | queue-report.test.js | Two tests encoded the retired behavior and were rewritten, plus two added. The new ones pin the PROPERTY that was violated rather than the arithmetic that fixed it: over every queue row, block count is monotonic in call volume (with the owner's exact 349/50/42/25 case asserted directly), and a broad top clips nothing. Note for future edits: `split('<tr>')` cannot be used to slice queue rows — the tally is a nested table with its own `<tr>` — so the tests match name → total → tally in one regex.
item 1 | drive-smoke.js | Three assertions: Range is the default, MTD loads a different window and labels it, switching back restores the page-window figures. Clicks are dispatched IN-PAGE rather than via `page.click`, matching the file's existing convention for controls that ride the sticky aside.

CORRECTION (2026-08-12 /sync-docs, verified against the run logs): an earlier draft of this block — and the commit message for 95f5e03 — blamed the first red run on Playwright's actionability wait timing out under the frost overlay. That was wrong twice over. (a) The locator never matched because the element did not EXIST: `build-harness.js` builds ONE site and defaults to admin, so an ad-hoc `node build-harness.js` during probing left `site/index-manager.html` stale and without the new `#trp-period` markup. `ci.mjs` and the harness README both build admin AND manager, so the gate itself was never at risk; the in-page click is a convention match, not the fix. (b) drive-smoke did NOT swallow the throw — it exited 1 and printed no summary line at all. What misled the read was a grep filter that matched some PASS lines but not the summary, so a partial capture looked like a completed run. The lesson is about reading a filtered log as if it were the whole one, not about the driver.

TEST RESULTS: passed. `node --test` 673/673 (was 671; +2 tally property tests); INV-16 green; `npm run ci:ui` all stages — drive-smoke 74 (was 68), f13 16, subqueue 30, devoverlay 14. The email was additionally RENDERED with the owner's real 2026-08-11 volumes and read back as an image: bar lengths now rank 349 » / 50 / 42 / 25 / 14 / 13 / 11 / 9 / 9 / 8 / 2 / 1 in order, with the one clipped row marked.

REGRESSION RISKS:
- The web all-departments report still uses the per-section unit (`qcdSectionUnit`, script-11-qcd-boot). Deliberately not changed: it is one scrollable page where the Total column sits beside every bar, and no inversion has been reported there. If it is unified later, `tallyBasisFor_` is the piece to port. Documented rather than left implicit.
- The clip marker is new visual vocabulary in the email. It appears only on a day that actually clips, and the footnote legend appears with it, so it never explains a mark that is not on screen.
- The Team Rings toggle adds an RPC only when a user selects a non-Range period, and it reuses an endpoint + cache key other surfaces already warm.
- No cache bump: the tally is render-time only, and the panel toggle changes which window is REQUESTED, not how any window is computed.

INVARIANTS AT RISK: None. R16e's block-ceiling layout constraint is preserved by clipping (pinned by the existing ≤25 test). INV-43's "land on real data" principle is unaffected — Range still follows the page's clamped window.

NET SCORE: 2 production fixes − 0 new failure modes = 2
(The tally inversion shipped in every daily email to the subscriber list. Item 1 is a capability gap rather than a defect, but the panel could only answer one question before.)

OPERATOR ACTIONS / DEPLOY:
- None new. The Phase 2 action still stands: populate Dept Config "Team Avg Excludes" for other depts with a call-taking manager on the roster | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The web all-departments report's per-section unit (see the regression note) — a deliberate non-change, worth revisiting if anyone reports the same misread there.
- (WITHDRAWN — see the CORRECTION above. drive-smoke already fails loudly: exit 1, no summary line. Nothing to fix. The real, much smaller lesson went to `tools/ui-harness/README.md`: a bare `node build-harness.js` rebuilds admin only and silently leaves the manager site stale.)

DOCUMENTATION UPDATES NEEDED:
- DONE: docs/client-ui-conventions.md — the Daily Call Queue Report bullet now carries the email-wide unit, the outlier/clip rule with both guards, and the deliberate web-report non-change; the Team Rings bullet carries the period toggle with its default rationale and its fetch/memo/frost rules.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
