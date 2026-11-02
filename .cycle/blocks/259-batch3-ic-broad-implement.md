---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- IC-1: the Callbacks explainer paragraph cluttered the section and the two "List …" buttons stacked vertically -- now a "How this is counted" ⓘ with shorter bullets, buttons side by side, the sub-queue scope line moved into the tooltip
- IC-2: Direct lines did not read as expandable -- a turning chevron + hover state; its "How this is counted" fold became an ⓘ with bullets
- IC-3: brief rows opened and closed with no transition -- they slide open and shut
- IC-4: the same ⓘ on the Overview's Callbacks by department and Direct lines
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-4-nav.html (gloss tooltip: data-gloss-src)
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/styles.html
- tests/unit/brief-accordion.test.js, tests/unit/client-dead-ends.test.js
- tools/ui-harness/drive-callbacks.js, tools/ui-harness/drive-cbdept.js, tools/ui-harness/README.md
- docs/client-ui-conventions.md, docs/regression-scenarios.md (S48, S59, S60, S61), docs/fix-history.md, tests/README.md

CHANGES:
IC-1 | dashboard.html, script-4-nav.html, script-8-insights.html, styles.html | the explainer is a hidden #ins-cb-howto (.ob-howto-src: .ds-tip-title + .ds-tip-list) read by a "How this is counted ⓘ" (data-gloss-src) at SHOW time, #ins-cb-window kept inside; insCbRender_ writes the sub-queue line into #ins-cb-scope-note (the Neon-down note stays a visible note); both list buttons in one .ob-list-actions row
IC-2 | dashboard.html, styles.html | .ob-dl-summary::before ▸ rotating 90° on [open] + hover; the Direct lines .ob-howto fold -> #ins-dl-howto / #ov-dl-howto sources with the ⓘ in the repeat-list row, #ins-dl-counts / #ov-dl-counts inside
IC-3 | script-8-insights.html | insBriefApply_(key, animate): Web Animations height + padding slide (INS_BRIEF_ANIM_MS_ 200) on a user toggle only; reduced motion / rebuild / no slot.animate instant; open shows + opens sections before measuring, close shuts sections in onfinish; a new toggle cancels a running slide
IC-4 | dashboard.html | #ov-cbdept-howto fold -> hidden source (#ov-cbdept-notcounted inside) with the ⓘ in the controls row; the Overview Direct lines as IC-2

TEST RESULTS: node --test 2795 pass / 0 fail (TZ=America/Chicago); lint:gas clean; bites 5/5 (gloss src ignored, close hides before the slide, toggle not animated, scope note visible again, chevron removed); drive-callbacks.js + drive-cbdept.js all PASS standalone; ci:ui see STATE
REGRESSION RISKS:
- The counting rules are now hover/focus-only: a touch user cannot open them (every gloss tooltip shares this; the old folds were tappable)
- Print / Copy image no longer include the counting rules (they were in collapsed folds already, except the Callbacks paragraph)
- The brief slide measures height once at the start; a chart that grows after the measure finishes the slide at the measured height, then the slot takes its natural height (no clipping after)
INVARIANTS AT RISK: None (client presentation only; no payload, cache key or gate changed)
NET SCORE: 4 production fixes (IC-1..IC-4, all live UI issues the owner saw) − 0 new failure modes = 4

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- Batch 4: TR-1 (admin list of retried transfers) after the owner sends the TR-0 numbers
- A tap-to-open affordance for gloss tooltips on touch devices (all of them, not only these)

DOCUMENTATION UPDATES NEEDED:
- None beyond those made
---END BROAD SCAN IMPLEMENTATION SUMMARY---
