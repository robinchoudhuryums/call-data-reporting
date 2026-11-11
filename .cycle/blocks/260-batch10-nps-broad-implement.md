---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F73 (NPS-1): Ctrl+P with a report or admin modal open printed the page behind it plus a clipped overlay
- F81 (NPS-2): admin modals scrolled sideways as a whole at tablet and phone widths
- F78 (NPS-3): charts and the My Department tables had no accessible names
- F76 (NPS-4): about 30 loading, save and validation lines were not live regions
- F80 (NPS-5): the benchmark tier (amber / red) was colour only
- F43 (NPS-6): three split-bar segments hardcoded white text on fills that lighten in dark mode
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/styles.html, dashboard.html, script-1-core.html, script-4-nav.html, script-5-dept.html, script-9-inbound-direct.html
- tests/unit/names-print-narrow.test.js (new), tests/unit/html-include-structure.test.js
- tools/ui-harness/drive-admin.js, README.md
- CLAUDE.md (S72 index line), docs/client-ui-conventions.md, docs/fix-history.md, docs/next-steps.md, docs/regression-scenarios.md, tests/README.md

CHANGES:
F73 / NPS-1 | script-1-core.html, styles.html | A beforeprint hook marks the top open modal (the one holding the focus trap, so Help over a report prints Help) and sets body.modal-printing; print rules hide everything else, drop the panel's height cap and scroll boxes, turn tables back into tables and keep the close / open-in-tab / action buttons off the page; afterprint undoes it. The scripted Individual and Insights prints set their own body class first and are left alone. Measured on the Inbound report: 571 px clipped on screen, 0 in print.
F81 / NPS-2 | styles.html | Under 820 px the four modal table classes (al-config-table, al-log-table, al-results-table, qcd-source-table) become their own sideways scroller, so the modal body no longer scrolls sideways with its fields and buttons. Under 600 px the modal's side padding drops from 40 px to 16 px (placed after the wide-variant padding rules it must override). Measured at 390 px: Dept Config body 852 -> 372 px of scroll width in a 372 px body; nine modals fixed.
F78 / NPS-3 | dashboard.html, script-5-dept.html, script-9-inbound-direct.html | All ten chart canvases carry role="img" and an aria-label naming what they plot; the three My Department tables carry an aria-label; their header cells carry scope="col" (static markup and the two JS-built headers).
F76 / NPS-4 | dashboard.html | 26 status / loading lines gained role="status" aria-live="polite" and 3 error lines role="alert".
F80 / NPS-5 | styles.html, script-4-nav.html | Each amber / red / over-standard value carries its tier as CSS-generated text (", just below target" / ", below target" / ", outside the standard"), clipped to a transparent 1px box: a screen reader reads it after the number; page code, a copied selection and a print never see it. One pass on the glossary's observer adds the same words as a hover title, leaving a title a builder wrote. Green stays silent.
F43 / NPS-6 | styles.html | New --on-accent and --on-dir-out tokens (white in light mode and in print, dark ink in dark mode); the three filled category segments read them instead of a hardcoded #fff. Measured in dark mode: all three now use the same dark ink as the green segment.

TEST RESULTS: passed -- 3029 pass, 0 fail, 1 skipped (pre-existing) under TZ=America/Chicago; lint:gas clean; module-deps --check clean; INV-16 guard in sync; ci:ui all stages passed. 8 new unit tests in names-print-narrow.test.js; 10 mutation (bite) checks, all red on mutation. New rendered checks in drive-admin (218 checks): print emulation on the Inbound report, five modals at 390 and 768 px, tier words (generated text + title, the element's own text untouched), every canvas a named image, segment ink in both modes. One existing pin (html-include-structure: the header-cell regex) was updated on purpose to accept scope="col". The two "check first" items were measured in headless Chromium before any change: V1 confirmed (white on the dark-mode fills is about 2.5:1), V7 confirmed (Close stays visible at 768 px; Dept Config and Outlier Fix scroll sideways as a whole).

REGRESSION RISKS:
- NPS-2: between 600 and 820 px a modal table narrower than the panel no longer stretches to full width (a block scroller shrink-wraps its rows). Cosmetic, tablet only.
- NPS-2: display:block on a table drops its table semantics in older Safari. Current Chrome, Firefox and Safari keep them.
- NPS-1: a scroll box inside a modal whose class does not end in "-wrap" and is not a table still prints clipped. None found in the modals measured; the rule is documented.
- NPS-1: charts print at their on-screen bitmap size, scaled down to fit the page width, not re-rendered for paper.
- NPS-5: the generated text depends on ::after, so a tinted element that already had its own ::after would lose one of the two. None exists today (checked).
- NPS-4: a status line that is filled when its modal opens (the trigger and cache-warm state lines) is now announced on open. Polite, but more speech than before.
- NPS-3: an existing test pinned the exact header markup; any other consumer matching the literal '<th data-sort=' on the dept table would need the same allowance (none found).

INVARIANTS AT RISK: None. Client-only; no payload, cache key, gate or write path changed. INV-37 (page model), INV-41 / INV-42 (charts: no chart option or colour plumbing touched; the canvases only gained attributes) unaffected.

NET SCORE: 2 − 0 = 2
(a) Fired in production this month: F73 YES (any Ctrl+P with a report open prints the clipped overlay -- reproduced, 571 px lost), F43 YES (dark mode is in use and the CSR transfer detail renders these segments on every load -- reproduced), F81 NO (no evidence of phone or tablet use), F78 NO, F76 NO, F80 NO (each reproduces, but nothing shows a screen-reader user hit them).
(b) New failure mode: F73 NO, F81 NO, F78 NO, F76 NO, F80 NO, F43 NO. (Two were introduced and removed inside this batch before commit: a hidden span that widened the page at phone width, and one that leaked into the day quick view's Range line.)

OPERATOR ACTIONS / DEPLOY:
- Walk S72 after the deploy (a real print preview, a phone, dark mode, and a screen reader if one is to hand) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The scan also noted "no Print item on six modals". Not added: Ctrl+P now prints any open modal, and a Print button per modal is new UI the plan did not ask for.
- The print block re-asserts the light palette but not --on-good / --on-warn, so a dark-mode print puts dark ink on the light green / orange fills (readable, about 5:1, but not what the screen shows in light mode). One line; outside F43.
- The team cards' day bars (.dts-bar is-watch / is-bad) are colour-only too and carry no text (the scan's V8 mentions a day bar). Different classes from F80's; not touched.
- The agent app does not use the benchmark classes, so it needed nothing; if it ever does, it has no glossary observer to add the hover title (the spoken text is CSS and would work).
- .sr-only itself is position:absolute and has the same page-widening hazard inside a sideways-scrolling container. No current use sits in one.

DOCUMENTATION UPDATES NEEDED:
- None outstanding. Done in this batch: docs/client-ui-conventions.md (accessibility + print contract: five new or extended rules), docs/fix-history.md (NPS-1..6), docs/next-steps.md, docs/regression-scenarios.md (S72) + its CLAUDE.md index line, tests/README.md, tools/ui-harness/README.md.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
