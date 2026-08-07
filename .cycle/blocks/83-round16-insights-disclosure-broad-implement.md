---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner Round-16 requests — (R1) hide the Missed-report
Bars/Radar toggle (default bars); (R2) hide the My Department sub-queue
relationship bar ("Combined view…" banner + child pointer + "all queues"
split chip), remove the group-heading "View X's missed calls" button and the
missed-section "Per-agent timelines below…" scope banner; (P1) retire the
Insights Simple/Detailed mode for per-section progressive-disclosure folds;
(P2) unify the Insights header with the My Department controls pattern
(From/To inputs + shared Quick-select chips); (P3) motion layer (page-swap
fade, fold-expand animation, elevation-on-stuck); (SW) the shared two-tab
"Agent table · Insights" lens switcher in both sticky headers.
Files modified: apps-script/department-dashboard/dashboard.html,
script-2-chrome.html, script-4-nav.html, script-5-dept.html,
script-8-insights.html, styles.html, tools/ui-harness/drive-smoke.js,
tools/ui-harness/drive-subqueue.js, docs/client-ui-conventions.md

CHANGES:
R1 | dashboard.html, script-5-dept.html | Bars/Radar segment display:none
(data-admin-only attr REMOVED — the admin reveal loop sets display:'' on
tagged elements and would un-hide it); missedChartMode_ hardcodes 'bars'
(radar code + markup kept for a one-line restore).
R2 | script-5-dept.html, drive-subqueue.js | SUBQ_BAR_HIDDEN_=true gates
subqRenderScopeBar_ AND subqMissedScopeNote_ (bodies intact); the
.subq-missed-btn render removed from subqRowGroups_ (handler machinery
inert). drive-subqueue's four affected assertions now pin the HIDDEN states.
P1 | script-8-insights.html, script-4-nav.html, dashboard.html, styles.html,
drive-smoke.js | insFolds layer (cdr.ins.folds.v1:<email>; role-seeded;
one-time density-pref migration) replaces insDensity/insIsSimple_/
insSetDensity_/insSyncDensity_ + the toggle + the ds-density-simple CSS
list + the D3 Simple caption. Queue health + Trends wrapped in
<details class="ins-fold"> with headline summaries (insQhFoldSync_ fills
Queue health's from the payload); draw-on-open for the trend chart (C3) and
the admin heatmap (Team-detail expand); quick-start scroll opens ANY
enclosing fold; on-track card fold universal; share-link view= param maps
onto the folds. drive-smoke's blank-canvas checker skips canvases inside
closed <details> (newer Chromium answers offsetParent for skipped content
via forced layout — the old visibility filter no longer excludes them).
P2 | dashboard.html, script-2-chrome.html, script-8-insights.html,
styles.html | #ins-period-bar replaced by #ins-hdr-controls (From/To inputs
+ #ins-date-presets via the NEW shared buildDatePresetChips_; dept's
initDatePresets_ refactored onto it). insSyncHeaderDates_ (canonical→header
per render, keeps the R9-3 recordPageWindow_ ride-along) + insApplyWindow_
(validation → picker regroup → prefs → runInsReport) + insInitHeaderDates_
(debounced edits). Edit popover retitled "Comparison & agents"; its date
row hidden (apply flow round-trips the seeded values unchanged).
P3 | styles.html, script-2-chrome.html | 160ms page-in fade on the four
page sections (pure CSS; animations restart when display flips); 180ms
ins-fold-in on fold expand; .is-stuck elevation via IntersectionObserver
(threshold 1) on both sticky strips — base shadows removed, shadow paints
only while pinned. All behind prefers-reduced-motion. The fold caret is a
square inline-block box — the bare glyph box rotated 90° overflowed the
page by 2px and tripped drive-smoke's overflow gate.
SW | dashboard.html, script-2-chrome.html, styles.html | .ds-lens-switch
(ds-seg + hair border) in both headers; Insights side's "Agent table"
button KEEPS #ins-open-mydept-btn (existing hand-off + hover-prefetch
wiring untouched); dept side's #lens-ins-btn → handoffToInsights_ with the
current window. The one-way "My Department →" button retired.

TEST RESULTS: 651/651 unit tests pass; INV-16 guard clean; npm run ci:ui
full pass (28+16+30+14 checks; drive-subqueue consolidated two assertions).
Regression scenarios overlapping the touched files (S1/S2/S6/S14/S23/S37/
S39/S43 surface areas) are covered by the gating drivers where automated;
the perceptual walks (S41/S42) remain manual post-deploy.
REGRESSION RISKS: (1) The subqSplitChip_ B-1 "queue mapping mismatch"
warning no longer surfaces in the UI — if QUEUE_SPLIT_SCOPE is ever set to
'dept' with an incomplete alias bridge, the only signal is
auditQueueSplitAttribution() (Op State #41). Currently scope=off, so no
live exposure. (2) A manager whose saved link carried view=simple now gets
folds-closed rather than a hidden-sections mode — data access unchanged.
(3) The popover's hidden date row still feeds insApplyEditPopover_; if a
future edit removes those inputs, apply breaks — the markup comment says so.
INVARIANTS AT RISK: None violated — INV-37 (page toggling) untouched by the
fade (CSS-only); INV-41/42 unaffected (no chart color changes); INV-45
(agent-free default) untouched; the INV-29 trend window unchanged (only its
draw timing is fold-gated). The scope-note retirement removes a DISCLOSURE,
not a computation (Phase 3 missed-section non-merge semantics unchanged).
NET SCORE: 0 − 0 = 0 (owner-directed UX restructure; no production bug
class fixed or introduced — the 2px overflow + closed-details canvas were
introduced-and-fixed within this session, caught by the gates).

OPERATOR ACTIONS / DEPLOY:
- None (no Script Properties, no triggers, no new scopes, no sheet changes).
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps
Script editor → Deploy → Manage deployments → pencil → Version: New
version → Deploy. (No web-editor deletions — no server files removed.)

FOLLOW-ON ITEMS:
- drive-insights.js / drive.js (non-gating, human-report drivers) still
  reference the retired #ins-density-toggle / #ins-period-bar — harmless
  (they record absences) but worth refreshing next time they're run.
- If the Cards view decision lands on "remove", the hidden
  #ins-cards-view-toggle + cards code can be excised properly.
- The bottom #dept-insights-strip teaser now overlaps the lens switcher's
  job; consider retiring it if the switcher proves sufficient.
- Restoring the sub-queue relationship bar/chip is one flag flip
  (SUBQ_BAR_HIDDEN_=false) if the mapping-mismatch visibility is missed.

DOCUMENTATION UPDATES NEEDED:
- docs/client-ui-conventions.md updated in this session (fold layer, header
  unification, lens switcher, motion, removals). CLAUDE.md's index line for
  client-ui-conventions already covers these families; no CLAUDE.md edit
  needed (no new trap that bites unrelated work).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
