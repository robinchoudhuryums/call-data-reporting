---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Option A | Port the missed chart's hour-bucket drill onto the shared missed-ring renderer so all four drills share one visual language
- Option B | Cross-links between the missed-call slices (drill row → agent card; agent-card ring → dept-wide hour bucket)

Files modified:
- apps-script/department-dashboard/script-5-dept.html
- apps-script/department-dashboard/script-9-inbound-direct.html
- apps-script/department-dashboard/script-4-nav.html
- apps-script/department-dashboard/styles.html
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md

CHANGES:
Option A | script-5-dept.html | `makeMissedBucketDetail_.show()` renders through `missedSliceListHtml_` instead of its private `<ul class="bucket-detail-list">` markup. Rings map to the slice entry shape (agent → who) and carry `meta.abandonedDetailLost` through. The panel header keeps the bucket identity (`9:30 AM CST`); the shared head carries the count + lens note, so neither repeats the other. The drill inherits date treatment, the R17f same-call run grouping and the "↳ path" chips for free.
Option A | script-9-inbound-direct.html | `missedSliceListHtml_` gained a SPARSE mode: a date header exists to stop the date repeating per row, so when a slice averages under 1.5 rings per date (the bucket drill and the heatmap cell drill — one half-hour across many dates) every header served ONE row at ~3x the vertical cost, in the shortest panels on the page. Under that ratio the list goes flat with a `.heat-drill-inline-date` chip. Dense slices cannot trip it by construction (the day drill is one date; the per-queue drill spans a window), so their rendering is byte-unchanged. Without this, Option A was a measurable density regression: ~6 visible rings vs ~12 before.
Option A | styles.html | Retired `.bucket-detail-list` (+ its `.ring-date`/`.ring-agent`/`.ring-time` grid and the wrap/overflow follow-ups) and `.bucket-detail-empty`; added `.bucket-detail .heat-drill-list { max-height: 280px }` so the drill shows the same row count it used to, plus `.heat-drill-inline-date`. The queue-only list keeps its own `.queue-only-list .ring-*` rules — only the bucket-scoped copies went.
Option B | script-5-dept.html | New `missedAgentCardEl_` / `missedAgentCardExists_` / `deptMissedJumpToAgent_`; `data-agent-card="<name>"` anchor on each agent card; `timeLabelOf()` wraps a ring's time in `.ms-bucket-link` carrying `m.bucket` (both the single and the R17a call-group branches); two handlers on the existing document-delegated chain, ahead of the id-chip handlers, each with `stopPropagation`. `makeMissedBucketDetail_` now also returns `show` — the ring link must always OPEN its bucket, where `toggle` would close it when that bucket is already on screen.
Option B | script-9-inbound-direct.html | `missedSliceWhoHtml_` renders the WHO cell as `.ms-agent-link` when a card exists. All four drills inherit the link at once — which is the point of Option A having unified them first.
Option B | script-4-nav.html | `qsSpotlight_` accepts an ELEMENT as well as an id (agent cards are keyed by name, which makes a poor id fragment). Existing string callers unchanged.
Option B | styles.html | `.ms-agent-link` / `.ms-bucket-link` — dotted underline, pointer, accent on hover.
Option B | drive-smoke.js | Three new assertions per role (6 total): an agent-card ring opens the dept-wide bucket drill; that drill renders through the shared lens (and NOT the retired markup, and does not overflow the narrow panel); a drill row's agent name jumps to and spotlights that agent's card. The round trip is asserted as a whole — each half is useless if the other end is missing.

TEST RESULTS: passed. `node --test` 661/661; INV-16 duplicated-file guard green; `npm run ci:ui` 56/56 (was 50) + 16/16 + 30/30 + 14/14. No pre-existing failures. Regression Scenarios: the ones with automated equivalents are green (S4-adjacent missed-section rendering and S39's keyboard walk ride drive-smoke/drive-f13). The remaining Department Dashboard scenarios are live-app manual walks and CANNOT be executed pre-deploy in this environment — flagged under OPERATOR ACTIONS rather than reported as passed.

REGRESSION RISKS:
- FOUND AND CLOSED during implementation: the Inbound report is a MODAL over the dept page and carries its own heatmap cell drill on the same shared renderer. Ungated, its rows would have offered agent links that spotlight a card behind the modal. `missedAgentCardExists_` now requires `data-page === 'dept'` AND no open modal, verified in both states with a live probe.
- `missedAgentCardEl_` matches the attribute by ITERATION, not a `[data-agent-card="…"]` selector: agent names are external CDR/roster text and a quoted name would break the selector string (the `csvSafeCell_` lesson).
- Accessibility, accepted and documented: both cross-links are link-styled SPANS, not buttons. A day slice runs to hundreds of rings, and that many tab stops would bury the page's real controls. Nothing becomes keyboard-unreachable — both destinations (the agent cards, the chart's bucket bars) are themselves in the tab order on the same page; the links are a shortcut, not the route.
- The bucket drill stays DEPT-WIDE by design (unchanged) even when the chart is agent-scoped — the R11-C4 documented behavior.
- The `who` cell of a queue-sentinel row ("A_Q_CSR (no agent rang)") has no card, so it degrades to plain text rather than a dead click. Same for an agent outside the rendered section.

INVARIANTS AT RISK: None. All changes are client presentation only — no server, no payload shape, no cache key, no aggregation rule. INV-30 needs no bump (nothing cached changed). INV-23 (queue sentinels) is respected: sentinel rows render, they simply get no cross-link. INV-01/INV-13 untouched (no new callable). The `.gs` files were not modified, so the INV-16 duplicated-file pair is unaffected.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(Neither option fixes a bug that fires in production — both are owner-requested consolidation/navigation work on correctly-functioning surfaces. The one new failure mode this could have introduced, the cross-modal dead link, was found and closed before it shipped, so it is not counted against the tally.)

OPERATOR ACTIONS / DEPLOY:
- Walk the live Regression Scenarios that cannot run pre-deploy — S4 (missed section renders), S39 (keyboard walk), S41/S42 (perceptual) — after deploying | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The agent cards and the shared lens still carry TWO same-call grouping implementations (`ms-callgroup` in `missedAgentsHtml_`, `hd-run` in `missedSliceListHtml_`). They agree on behavior but are separate code; a future round could extract one. Deliberately out of scope here — merging them touches the agent cards' markup, which Option A did not ask for.
- The ABANDONS lens (`heatCellDetailHtml_`) does not share the new sparse-date mode; in the heatmap cell drill it has the same one-row-per-date shape. Left alone to keep this change to the missed-ring renderer Option A named.
- `.bucket-detail-empty`'s removal leaves the bucket drill's empty state on the shared renderer's wording ("No missed rings recorded here for the selected range"), which is true but less specific than the old "No rings in this bucket."

DOCUMENTATION UPDATES NEEDED:
- DONE in this session: `docs/client-ui-conventions.md` — the R17h consolidation paragraph (bucket drill on the shared renderer, retired CSS, the sparse-date rule and why) plus a new bullet for the cross-links (anchors, the iteration-not-selector rule, the same-page/modal gate, and the span-not-button reasoning).
- No CLAUDE.md change needed: the client-surface detail belongs in the split file per the F8 index rule, and no live rule in CLAUDE.md's Common Gotchas changed.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
