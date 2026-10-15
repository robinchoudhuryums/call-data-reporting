---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F26 `--ink-muted: var(--muted)` resolved once at :root, so dark mode kept the light grey (~3.1:1) on Health hints, escalation pills and similar text; the P24 comment claimed the opposite
- F27 Focusable <tr> agent rows carried aria-expanded on the row and closing REMOVED it -- the row-control shape Batch 9 retired
- F54 The Overview Window buttons wrote aria-checked onto aria-pressed markup (aria-pressed stuck on "Yesterday")
- F55 A collapsed sub-queue card kept its hidden "Open" button in the tab order
- F56 Sub-queue cards snapped shut on every re-render (the 5-minute refresh included)
- F57 Health folds re-collapsed when the Neon pass landed seconds after the fast pass
- F58 Every IR "Copy data" button had the same accessible name
- F65 (added 2026-10-15 from Batch 6's follow-ons, owner) Insights share links / Open in new tab carried no dept
- F66 (added 2026-10-15 from Batch 6's follow-ons, owner) a mini-table header click while a NEW window loaded repainted the previous window's rows
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/styles.html
- apps-script/department-dashboard/script-2-chrome.html, script-3-overview.html, script-4-nav.html, script-5-dept.html, script-6-ir.html, script-8-insights.html, script-9-inbound-direct.html, script-10-escalations.html
- tests/unit/client-dead-ends.test.js, tests/unit/client-lifecycle.test.js
- tools/ui-harness/drive-agentpanel.js, tools/ui-harness/drive-f13.js
- docs/client-ui-conventions.md (the E-8 bullet names the agent rows), docs/regression-scenarios.md (S39's keyboard step)
- .cycle/STATE.md, .cycle/blocks/259-broad-scan-b7-a11y-broad-implement.md

CHANGES:
F26 | styles.html | the dark overlay re-declares `--ink-muted: var(--muted)`; the P24 comment now says an alias resolves where it is DECLARED, so any palette overriding --muted must re-declare it (swept)
F27 | script-5-dept.html, script-10-escalations.html, script-2-chrome.html, styles.html | new apRowToggleHtml_: the agent-name cell is a `button.ap-row-toggle` (aria-expanded="false") in all three row builders (combined, flat, outbound); rows lose tabindex; apMarkRow_/apClose_ set aria-expanded true/false + aria-controls on the BUTTON (never the row, never removed); focus returns to the button, and a mouse open also leaves focus there (preventScroll) so Escape/Tab work as before; the two tbody keydown handlers drop their Enter/Space paths (the native button does it -- a second path would toggle twice), keeping Escape and the group-head re-dispatch; CSS styles the button as the plain name with the focus ring
F54 | script-3-overview.html | ovWirePeriodBar_ sets aria-pressed (the markup's attribute) instead of aria-checked
F55 | script-3-overview.html | a closed sub-queue detail renders `inert`; ovToggleSubqCard_ removes it on open and restores it on close
F56 | script-3-overview.html | session map ovSubqOpen_ (by dept name): the toggle records it and ovBuildSubqCard_ renders open cards open (is-open, aria-expanded=true, height:auto, no inert)
F57 | script-9-inbound-direct.html | healthFoldsOpen_ holds open folds per LOAD: the toggle records, healthRender_ renders from it, healthLoad_ (a refresh) resets it -- the documented "refresh re-collapses" default stands
F58 | script-6-ir.html | aria-label="Copy data for <agent>" (starts with the visible text, WCAG 2.5.3)
F65 | script-4-nav.html, script-8-insights.html | new shareLinkStateFor_(route): collect() + dept for '/report/insights'; used by Copy share link and Open in new tab; collect() itself (and so saved views, dept-free by design) is unchanged; applied on the way in by F16's shareApplyDeptParam_
F66 | script-3-overview.html | ovOnUserSort_ keeps the sort choice but repaints only when the table holds rows for the window on screen (ovUserTableKey_ set and rows present) -- also stops a click wiping the "No agent rows" message

TEST RESULTS: passed -- 2476 tests (2475 pass, 0 fail, 1 pre-existing skip; +4 client-dead-ends pins, +5 client-lifecycle behavioural). lint:gas clean, module-deps up to date, INV-16 guard in sync. ci:ui: all stages passed; drive-f13 + drive-agentpanel now assert the button (row has no tabindex/role/aria-expanded, button true on open, false -- not removed -- on Escape/Collapse, focus on the button, Space opens without scrolling). Bites: 10/10 (F54's first run mutated an identical line in another function; re-run with a unique anchor bit).
REGRESSION RISKS:
- F27: the row is no longer a tab stop -- keyboard users land on the name button instead (same position, first cell). A mouse open now moves focus to that button; programmatic focus after a mouse click does not normally show the focus ring.
- F55: `inert` is ignored by very old browsers (the button stays tabbable there, as before).
- F56: open cards now stay open across the 5-minute refresh, for the session.
INVARIANTS AT RISK: None (INV-37 untouched; INV-42 untouched -- F26 is a CSS token, not chart colour plumbing).
NET SCORE: 3 − 0 = 3 (production fixes: F26, F56, F57; F27, F54, F55, F58 bite assistive-tech / keyboard users and F65, F66 need a rarer path -- counted NO)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Department Dashboard -- `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The sub-queue GROUP head rows on My Department still carry role/tabindex/aria-expanded on the <tr> (set from script, so the C2-9 markup sweep does not see them) -- the same retired shape as F27, not in this batch's list.
- The IR share-state provider ('/report/individual') also omits dept (shareLinkStateFor_ adds it for Insights only; IR's apply has no dept handling yet).
- Batches 8-10 of the cycle-259 plan remain.

DOCUMENTATION UPDATES NEEDED:
- None beyond the two docs updated in this batch
---END BROAD SCAN IMPLEMENTATION SUMMARY---
