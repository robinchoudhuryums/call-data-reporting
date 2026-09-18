---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- C1-13 — Enter/Space on `tr.subq-group-head` toggles the group (re-dispatched as the one click path)
- C2-10 — `srtApply_` wires Enter/Space, `tabIndex`, `aria-sort` on all 41 report sort headers
- C2-11 — guided tour: `trapFocus_` on the tip, Next focused, focus returned on finish, document-level Enter scoped off focused buttons
- UD-1 — `.ir-row` stacks under 700px
- UD-2 — `#ins-heatmap` / `.ins-qh-table-card` floors are `min(Npx, 100%)`
- UD-3 — one global `:focus-visible` ring; the three `outline: none` overrides deleted (sweep-pinned)
- C1-17 — `--on-good` / `--on-warn` tokens; toasts + the danger confirm read them (dark ink on the lightened dark-mode fills)
- C1-14 — Overview tiles `aria-describedby` a shared action note instead of `aria-label`
- C2-9 — Insights day row + Health fold head: disclosure moved to an inner `<button>`; row keydown handlers removed (double-toggle); fragment sweep pins "no role=button on a <tr>"
- UD-4 — `.ms-bucket-link` / `.ms-agent-link` are `<button tabindex="-1">` (announced/activatable, no tab-stop flood)
- C1-15 — `dsConfirm_` labelled + described; `dsPrompt_` labelled
- C1-16 — `#dept-clamp-note`, `#ov-cached-pill`, `#ov-refresh-warn` are `role=status`
- C1-18 — chart-tips popover: Close control, `trapFocus_`, the opener modal's trap re-armed on close
- C2-12 — `wireMenuKeys_` on the Views menu (text fields keep caret keys); Escape closes an open IR / Insights edit popover before the modal and returns focus
- C2-13 — agent date inputs labelled; agent tabs a tablist with `aria-selected` (+ the inbound drill tabs); caption/spacer `<label>`s → `.ctl-label`; Report type → `fieldset/legend`
- UD-5 — `.agent-scope-btn` rendered after `</summary>`, positioned onto the header row by CSS
- UD-6 — side-panel ⓘ hints: `role=note` + the `.ds-tooltip` layer (which now links the tooltip via `aria-describedby` while shown)
- UD-7 — retired pr-/cr-printing print CSS + `.pr-th-sortable` deleted
- UD-8 — global print hides (FAB, A/B panel, dev overlay, toasts, update notice, tour, confirm/tooltip layers, backdrop); sticky strips print in flow
- UD-9 — IR modal close after an Insights drill focuses `#page-title` (now `tabindex=-1`)
- UD-10 — 34 admin-modal section titles are `<h3 class="al-section-title">` (margins pinned in CSS)

Files modified:
- apps-script/department-dashboard/agent.html, agentApp.html, dashboard.html, styles.html
- apps-script/department-dashboard/script-1-core.html, script-2-chrome.html, script-3-overview.html, script-4-nav.html, script-5-dept.html, script-6-ir.html, script-8-insights.html, script-9-inbound-direct.html, script-10-escalations.html
- tests/unit/client-dead-ends.test.js (Batch 9 pin block), tests/README.md
- tools/ui-harness/drive-subqueue.js (C1-13 keypress), tools/ui-harness/drive-f13.js (C1-14: description, not label)
- CLAUDE.md (missed-card bullet, net −66 B), docs/client-ui-conventions.md (UD-4), docs/regression-scenarios.md (S39), docs/fix-history.md (Batch 9 row)

CHANGES:
C1-13 | script-2-chrome.html | tbody keydown: `tr.subq-group-head` → `ghead.click()`
C2-10 | script-9-inbound-direct.html | `srtApply_`: shared `sortBy`, thead keydown, `th.tabIndex=0`, `aria-sort`
C2-9 | script-8-insights.html, script-9-inbound-direct.html, styles.html | inner `.ins-daily-toggle` / `.sh-fold-btn` buttons carry `aria-expanded`; `insQhDayToggle_` reads the button; row keydown handlers removed
C2-11 | script-10-escalations.html | `tourOpener_`, `trapFocus_($('tour-tip'))`, Next focused, `onTipButton` guard in `tourKey_`, `releaseFocus_` + focus return in `tourFinish_`
C2-12 | script-8-insights.html, script-6-ir.html, script-1-core.html | `wireMenuKeys_(viewsBtn…)`; Escape → popover first; `wireMenuKeys_` ignores caret keys in a text field
C1-18 | script-4-nav.html, styles.html | `.chp-close` control, `trapFocus_(pop)`, `outerTrap` restore
C1-14 | script-3-overview.html, styles.html | `#ov-tile-action-desc` (`.sr-only`) + `aria-describedby`
C1-15 / C1-16 | script-1-core.html, script-3-overview.html, dashboard.html | dialog ids + `aria-labelledby`/`aria-describedby`; `role=status` on the three notices
C1-17 | styles.html | `--on-good`/`--on-warn` in `:root` + dark; `.toast-success/.toast-error/.ds-confirm--danger` read them
UD-1 / UD-2 | styles.html | `@media (max-width:700px) .ir-row`; `min(360px,100%)` / `min(340px,100%)`
UD-3 | styles.html | global `:focus-visible`; three `outline: none` lines removed; `.sr-only`
UD-4 | script-5-dept.html, script-9-inbound-direct.html, styles.html | `<button tabindex="-1">` + button reset CSS
UD-5 | script-5-dept.html, styles.html | `.agent-card-tools` after `</summary>`; absolute placement; summary `padding-right: 78px`
UD-6 | dashboard.html, script-4-nav.html | `.side-hint-i gloss` + `role=note` + `aria-label`; tooltip `id` + `aria-describedby` while shown
UD-7 / UD-8 | styles.html | ~70 lines of retired print CSS deleted; global print hides + static sticky strips
UD-9 | script-6-ir.html, dashboard.html | `h1#page-title[tabindex=-1]` focused on the from-Insights close
UD-10 | dashboard.html, script-9-inbound-direct.html, styles.html | `<h3 class="al-section-title">`; `margin: 0 0 10px; line-height: 1.35`
C2-13 | agent.html, agentApp.html, dashboard.html, script-9-inbound-direct.html, styles.html | labels / tablist / fieldset

TEST RESULTS: 1696/1696 passed (`TZ=America/Chicago node --test`); INV-16 guard clean; `npm run lint:gas` clean (75 files); module-deps `--check` up to date. 9 new pins bite-checked (C1-13, C2-10, C2-9, C2-11, UD-3, C1-17, C1-18, UD-4, UD-10). `npm run ci:ui`: first run FAILED at drive-f13 ("OV tile is focusable + announced" expected the removed `aria-label`); the driver now asserts the description wiring (content is the accessible name, the action a description). Re-run PASSED: exit 0, 285 assertions, all eight stages, including the two new keyboard checks ("Enter on a focused group header collapses it", "Space re-expands it").
REGRESSION RISKS:
- UD-4: the cross-links are no longer reachable by Tab (they never were) — but now they ARE real buttons with `tabindex=-1`, so a `Tab`-order audit tool will list them as focusable-but-unreachable; the docstring states why.
- UD-5: the scope button is absolutely positioned over the summary; a very long agent name wraps under the reserved 78px instead of overlapping (summary wraps, R11-C6). Walk S4 on a narrow card.
- UD-3: every focusable element now shows the accent ring on keyboard focus, including programmatic focus on `#page-title` after the IR close / tour finish — intended, but visible.
- C1-18: the chart-tips close re-arms the opener modal's trap by re-adding its handler directly (`activeFocusTrap_` is a shared IIFE var); if `trapFocus_`'s record shape changes, update `initChartHelp_` with it.
- C2-9: `insQhDayToggle_` falls back to the row when the inner button is missing, so `insJumpToDailyRow_` and the violation drill keep working on either markup.
INVARIANTS AT RISK: None (client-only; no INV-numbered rule touched; INV-41/42 chart rules untouched).
NET SCORE: 6 − 0 = 6
  (Would have fired this month: C1-13 YES (parent-dept managers, keyboard), C2-10 YES, C2-11 YES (auto-runs for every first-time visitor), UD-2 YES (phone-width My Department), C1-17 YES (dark-mode toasts), UD-3 YES; the rest are AT-only or cosmetic — NO. New failure modes: none identified.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `scripts/deploy.sh . <dashboard-deployment-id>` (or `clasp push -f` + Manage deployments → New version). Then walk S39 (keyboard) and S41 (theme × mode — the dark toasts / danger confirm) by hand.

FOLLOW-ON ITEMS:
- `.ds-heatmap { min-width: 360px }` (styles.html ~7209) is a third phone-width floor outside the two the finding named; same `min(360px, 100%)` fix if it overflows on a phone.
- The Health fold head and the Insights day row are the only two `aria-expanded` disclosures on inner buttons; the agent table's `tr[data-agent]` and `tr.qcd-expandable` still carry `aria-expanded` on the row (allowed on `row` in ARIA 1.2, left as-is).
- `wireMenuKeys_` is not applied to the IR / Insights EDIT popovers (they are dialogs, not menus); Escape + focus return is the fix here — a Tab trap on them would need the modal-trap restore dance C1-18 does.
- drive.js (a non-gate driver) checks `outlineStyle !== 'none'` per element; with the global ring it should now pass everywhere — not re-run here.

DOCUMENTATION UPDATES NEEDED:
- Done in this commit: CLAUDE.md missed-card bullet (button after `</summary>`), client-ui-conventions (UD-4 buttons), S39 keyboard walk additions, fix-history Batch 9 row.
- /sync-docs: client-ui-conventions could name the E-8 house rule (role=button never on a `<tr>`, inner control instead) beside the S39 note; the tour bullet (~line 552) could mention the focus trap; README deploy wording "skips if playwright absent" is still stale from Batch 8.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
