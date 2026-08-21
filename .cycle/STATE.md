# Cycle State — resume note

## Latest session (R17i — one definition of "these rings are one call")
Branch `claude/broad-scan-l9ojgm`, **669/669 unit tests** (+8), INV-16 green, UI gate 56/56 + 16/16 + 30/30 + 14/14. Increment 103. Block: `.cycle/blocks/103-r17i-grouping-extraction.md`.
- **Closed the OBJECTIVE half of R17h's follow-on and deliberately left the subjective half.** The RULE (consecutive + same parentId + same date) was written twice with nothing making the copies agree — the INV-16 drift class. It is now `groupConsecutiveByCall_` (script-1-core.html), returning runs and rendering nothing. The RENDERINGS stay different on purpose: the card has no visible "rang N×" (owner R17a, hover only) and puts the siren/badge on the LAST ring; the lens shows the count on the FIRST.
- **The two callers feed DIFFERENT sequences, which is why the helper returns runs rather than markup:** a card iterates ONE agent's rings (a run = that agent rung repeatedly), a lens iterates a slice sorted chronologically ACROSS agents (`missedSliceFilter_`), so a run there can span agents.
- **⚠ Harness fixture counts are NOT a regression signal.** Probe ring counts moved 174→188 and it looked like a regression; `gen-payloads.js` seeds its RNG (42) but takes its date window from the REAL CLOCK, so a mid-session regeneration slid it (meta latest 08-10 → 08-11). Verify refactors by A/B, not by diffing probe output across a day boundary.
- **Verified decisively:** both OLD loops restored verbatim in a throwaway script vs the new helper over 200k randomized ring lists (null ids, repeated ids, date changes, lengths 0-8) — ZERO mismatches on both. The old loops are deliberately not kept in the suite (a second authority that drifts).
- **`tests/unit/call-grouping.test.js` is the FIRST unit coverage of client-fragment logic** — lifts the declaration out of the fragment by brace-matching and evaluates just it (zero-dep, no jsdom), mirroring html-include-structure.test.js's text technique. Pins adjacency, the null-id rule, exact input coverage, and that BOTH call sites still call the shared rule.
- **NET 0 − 0 = 0** — refactor + coverage, behavior provably unchanged.
- **Where I left off:** committed, pushed, PR opened + merged (R17e/f/g/h/i together). Deploy is Department Dashboard only. Remaining follow-ons: the abandons lens has no sparse-date mode (admin-only heatmap cell drill, low value); the bucket drill's empty-state wording is now the shared renderer's.

## Prior session (/broad-implement — R17h: Options A+B, the missed-slice consolidation)
Branch `claude/broad-scan-l9ojgm`, **661/661 unit tests**, INV-16 green, UI gate **56/56** (was 50) + 16/16 + 30/30 + 14/14. Increment 102. Summary block: `.cycle/blocks/102-r17h-broad-implement.md`.
- **Option A: the hour-bucket drill was the last missed-list on private markup** — it now renders through `missedSliceListHtml_`, so all four drills (bucket / per-queue / day / heatmap-cell) share one visual language. `.bucket-detail-list`, `.bucket-detail-empty` and the bucket-scoped `.ring-*` rules are retired; the queue-only list keeps its own.
- **The port was a DENSITY REGRESSION until the sparse-date mode landed, and that is the reusable lesson.** A date header exists to stop the date repeating per row; in a slice averaging <1.5 rings per date (bucket + heatmap-cell drills — one half-hour across many dates) every header served ONE row at ~3x the cost, in the page's shortest panels — ~6 visible rings vs ~12 before. Under that ratio the list goes flat with an inline date chip. Dense slices can't trip it by construction (day drill = one date; queue drill = a window), so they render unchanged.
- **Option B cross-links both directions:** a drill row's agent name → that agent's card (spotlit, `<details>` chain opened); an agent card's ring time → the DEPT-WIDE hour bucket for that half-hour (`show`, never `toggle`, or clicking a ring would close the bucket it meant to open). Option A is what let one edit give all four drills the agent link.
- **Regression found and closed mid-implementation:** the Inbound report is a MODAL over the dept page running the same shared renderer — ungated, its rows offered agent links that spotlight a card *behind the modal*. `missedAgentCardExists_` now requires `data-page==='dept'` and no open modal; both states probed live.
- **Two deliberate positions worth not re-litigating:** the links are link-styled SPANS, not buttons (a day slice is hundreds of rings = hundreds of tab stops; both destinations are separately in the tab order, so nothing is keyboard-unreachable), and `missedAgentCardEl_` matches by ITERATION rather than a `[data-agent-card="…"]` selector, since agent names are external CDR text and a quote breaks the selector string.
- **NET 0 − 0 = 0** — owner-requested consolidation on correctly-working surfaces, not a bug fix; the one failure mode it could have introduced was caught pre-ship.
- **Where I left off:** committed + pushed; PR on the owner's word. Follow-ons in the block: the agent cards and the shared lens still hold two same-call grouping implementations (`ms-callgroup` vs `hd-run`), and the ABANDONS lens has the same sparse-date shape but was left alone to keep this change to the renderer Option A named.

## Prior session (R17g — header date cleanup, share overflow, tile centering + the consolidation investigation)
Branch `claude/broad-scan-l9ojgm`, **661/661 unit tests**, INV-16 green, UI gate 50/50 + 16/16 + 30/30 + 14/14. Increment 101. NOT yet PR'd.
- **The Insights header date chip is HIDDEN when the report covers the page controls' window** (the normal case — the dept controls are the single date authority, M4) and survives WARN-TINTED ("(scoped: …)", `.ins-results-date--scoped`) when a monthly trend-point drill diverges the two — a split range stays visible, never silent. The workday count moved to the sticky controls strip (`#dept-workdays`, `updateDeptWorkdays_`: S5 client mirror every refresh, refined by the server INV-35 count from a same-window Insights render; a diverged render passes 0 so the strip keeps the DEPT window's number).
- **Call-share overflow root cause:** the card inherits `.ir-chart-wrap`'s fixed 420px canvas height, but the tally is DOM rows — a real roster spilled past `overflow: visible` into the drills below (the 5-agent fixture fits, which is why no probe saw it). Now auto-height capped at 560px with the ROWS scrolling internally.
- **Panel-1 tiles** get the flex-center treatment (Abandoned % sat top-anchored at the equal grid height).
- **Consolidation investigation (NO CHANGES — owner decision pending):** five missed/abandoned list surfaces, all slices of two stores; 3 of 5 already share renderers. Real redundancy: the missed chart's hour-bucket drill still uses its own older `bucket-detail-list` renderer, and the agent cards vs the shared lens carry two same-call grouping implementations. Recommended Option A (port the bucket drill onto the shared renderer, nothing removed); Option C (universal explorer) recommended AGAINST — kills in-context affordances and risks blurring the settled DQE-vs-inbound definition split. See `.cycle/blocks/101-*.md`.
- **Where I left off:** committed + pushed; PR on the owner's word. Consolidation awaits an A/B/C pick.

## Prior session (R17f — follow-ups on the R17e round)
Branch `claude/broad-scan-l9ojgm`, **661/661 unit tests**, INV-16 green, UI gate 50/50 + 16/16 + 30/30 + 14/14. Increment 100. NOT yet PR'd — R17e + R17f ride together on the owner's word.
- **Panel-1 tile values 15px → 18px** — R17c's shrink served a one-line split that has been two-line since that same round.
- **Email tally widened instead of slimmed:** the "Abandoned %" column is 190px (was 150 — the Viol column had slack), block cells back to 4px+1px from R17e's 3px slivers, ceiling and 20-calls/block landing unchanged. The comment now carries the full width-budget math (25×5px + ~45px label + padding = 186 ≤ 190).
- **Both lens tables gained a meaningful row treatment:** missed-rings groups CONSECUTIVE same-parentId rings as a connected run (warm rail, id badge once, "rang N×" — the R17a grouping applied here; adjacency is the key on purpose, a later same-id ring is a re-rung call), and the abandons lens carries a stage tick (warm = queue, accent = on hold, muted = IVR; redundant with the text on purpose).
- **Where I left off:** committed + pushed. Deploy is Department Dashboard only. When the owner approves, PR + merge R17e+R17f together, then restart the branch from origin/main.

## Prior session (R17e — post-deploy polish round from the owner's screenshot)
Branch `claude/broad-scan-l9ojgm`, **661/661 unit tests** (queue-report 39/39 after re-targeting three pins), INV-16 green, UI gate 50/50 + 16/16 + 30/30 + 14/14. Increment 99. NOT yet PR'd — owner reviewing.
- **The one real bug: the Queue Call Data panel rendered HALF-width for every multi-queue dept.** The carousel is a single child of the `#dept-qcd-tiles` grid, and R17c's side-column `1fr 1fr` override put it in column 1 with its tiles overflowing the track. `.dept-qcd-carousel { grid-column: 1 / -1; }` — the span `.dept-qcd-queue-row` already had. Single-queue depts never showed it, which is why R17c's probes missed it.
- **Daily-breakdown lenses:** each is its own bordered `--paper` card on the row's `--paper-2`; the abandons lens displays CHRONOLOGICALLY (display-only re-sort AFTER the newest-N cap, so the truncation note stays true — the SQL's DESC order is what the cap semantics need); `meta.reconcileNote` is a hover-ⓘ on the heading now, not a text box (the R16i ships-with-the-data rule survives, only the form changed).
- **`#ins-team-detail` joined the fold store** (`data-fold="detail"`, matched by bare attribute — it lacks `.ins-fold`): open by DEFAULT for everyone (unlike qh/trend's role seed), persisted per user, pre-R17e blobs without the key read as open.
- **Call-share delta is color-coded** (sage above / warm below the equal share, muted under 2 pts) — deliberately overrides R17c's neutral-gray ruling, owner asked. Team Rings KPI cards center vertically.
- **Email tally: "20 calls/block" was a CEILING change, not a unit constant.** Cells slimmed 5px+2px → 3px+1px, `TALLY_MAX_BLOCKS` 14 → 25 (25×4px=100px, under the ~112px squeeze threshold), so the ladder lands on unit 20 for a ~350–500-call queue day where 14 forced 50. Measured post-change: uniform 3px blocks across rows.
- **One probe artifact fixed:** drive-devoverlay's App-state assertion sampled 400 chars of the overlay; the default-open fold's extra RPC pushed "App state" past the slice. Slice widened to 2000 with the why.
- **Where I left off:** committed + pushed, awaiting owner review before PR/merge. Deploy is Department Dashboard only. Owner's open question (merge the two lenses?) answered in chat: keep TWO — different sources/definitions, an interleaved merge invites row-level reconciliation that structurally can't exist; they're now visually tied instead.

## Prior session (R17d — the Calendar is always available, year-to-date by default)
Branch `claude/broad-scan-l9ojgm`, **661/661 unit tests** (+1), INV-16 + cache-version-sync + claude-md-split green, UI gate **50/50** (was 46) + 16/16 + 30/30 + 14/14. Increment 98.
- **The year-to-date series costs no extra read, and that is the whole reason this was cheap.** `computeInsights_` already walks 12 months of rows for the monthly rollup; Jan 1 of the end year is always inside that span, so `trendYtd` is a second accumulator on the same pass, inside the same `inTrend && isRoster` branch — inheriting the INV-53 roster gate by construction instead of by a parallel rule that could drift. `insights:v20`.
- **One decision function, four readers.** `insCalendarUsesYtd_` alone decides which series is on screen; eligibility, the renderer, the header and the ineligible-reason text all call it. In YTD mode the month list, the month-reset key AND the per-cell in-window gate must all come off `trendYtd.from/.to` — leaving any one of them on `meta` blanks most of the year while the rest of the grid still looks right.
- **The caption is load-bearing.** Cells describing the year under a page scoped to one day read as that day's data — the misreading the old refuse-to-render gate avoided by rendering nothing.
- **A rare fallback became the common path, and it was wrong.** The day-drill's out-of-window branch re-ran only the Insights window, which under YTD splits the page's two halves onto different ranges — exactly what R16g removed. It now moves the DEPT controls and re-lands on the Daily breakdown via a one-shot pending consumed at render end.
- **The harness served ONE 30-day Insights payload for every span**, so the single-day shape the dept page renders BY DEFAULT (INV-43) was never exercised and the YTD branch was unreachable from the gate. `insights-day` is now captured and the stub picks by span.
- **NET 1 − 0 = 1.** The requested feature plus a fixture gap closed; the one failure mode it introduced is fixed in the same increment.
- **Where I left off:** committed, pushed, PR opened + merged. Deploy is Department Dashboard only. **Walk S37 + S14**, and specifically: default single-day window → Trends → Calendar → confirm the captioned year renders and an out-of-window day-click moves BOTH halves. Open: the QUEUE metric still refuses a short window (its series is window-scoped; a YTD version would be a real extra read, unlike this one).

## Prior session (/broad-implement harness single-dept fixture — found a live dept-switch bug)
Branch `claude/sync-commands-dnxgcv`, **590/590 unit tests**, UI gate 24/24 + 16/16 + **31/31** (was 24). Increment 67.
- **The fixture work immediately surfaced a PRODUCTION bug: the header department selector threw and did nothing for every admin.** `selectOption('#dept-selector','Sales')` raised `ReferenceError: prLastRoster is not defined` — the change handler still cleared roster caches belonging to the Performance and Compare Ranges reports, retired and DELETED long ago. script.html is `'use strict'`, so the assignment threw, and it threw on the line BEFORE `refresh()`. Two dead lines deleted.
- **No automated check had ever switched departments**, which is exactly why it survived. The switch is now asserted two ways: that it doesn't throw, AND that the row count actually changed (CSR 7 → Sales 4) — a no-throw check alone would pass if the handler ran but the refresh never landed.
- **No fixture DATA change was needed for the single-dept payload**, which is worth knowing before someone adds agents for it: Sales's seeded child `PAP` is absent from the harness roster and `subQueueChildMap_` drops edges naming a non-existent dept, so Sales ALREADY renders like the 11 of 14 real depts with no sub-queue. Adding a Billing profile (the other candidate) would have shifted the company Overview payload for every other driver.
- **Restored coverage:** a sub-queue-less dept renders no relationship bar / group headers / subtotals but still renders agents and a totals row, and its CSV has NO leading `Department` column and no subtotal or `All shown` rows — the byte-compatibility promise to every dept that never had a sub-queue.
- **Both verified by breaking them:** restoring one `prLastRoster` line reproduces the exact production error and leaves Sales showing CSR's 7 rows.
- **NET 1 − 0 = 1** — a continuously-firing production bug on the primary admin control, fixed by deleting code.
- **Where I left off:** committed + pushed. **S2 (admin switches departments) needs a live walk after deploy** — it is the scenario that should have caught this and evidently wasn't being run. Deploy is Department Dashboard only. **Open argument worth acting on:** the `ui-harness` job still carries `continue-on-error: true`, so all 31 assertions are advisory; this increment is a concrete case for dropping it. Other header controls (view-as-manager, theme/mode toggles, the Export dropdown beyond the CSV item) still have no automated interaction and are candidates for the same failure class. Phases 3/4 remain all-queue; the Insights combined view is still unstarted.

## Prior session (/broad-implement — scope switcher retired for collapsible groups)
Branch `claude/sync-commands-dnxgcv`, **590/590 unit tests**, UI gate 24/24 + 16/16 + 24/24, INV-16 + cache-version-sync + claude-md-split green. Increment 66.
- **The owner concluded the three-way scope switcher was over-built, and they were right.** Every view it offered is reachable by collapsing a group — "<dept> only" IS the combined view with the sub-queue collapsed — and each dept's subtotal stays on screen either way. The tabs cost a SERVER ROUND TRIP per view to show the same thing.
- **The group HEADING ROW is now the control.** Collapsing hides agent rows and deliberately KEEPS the subtotal; that is the whole point and exactly what made the tabs redundant. Default EXPANDED so the combined view is unchanged on open.
- **The client no longer sends `subScope`; the SERVER still honors it** (CSV Department column, combined default). Client retirement, not capability removal — the comment says so, because the obvious later "fix" is to restore a parameter that was never broken.
- **A sub-queue's group header carries the ONLY route to its missed calls.** Phase 3 can't merge that section (queue abandons would double-count), and the tabs were previously that route. The button re-scopes + scrolls; the note offers "Back to <parent>"; the override RESETS on any dept/window change, since a child's missed calls pinned under a different parent would be wrong rather than stale.
- **Aggregate rows scaled up** (text + bar height) so totals and subtotals read as a different KIND of number. Asserted by measuring RENDERED font-size, not a class — the first attempt measured `td:first-child` and failed, because the label cell is uppercase letter-spaced type that is legitimately smaller in px.
- **Driver assertions were REPLACED, not supplemented** — one that still passed with the tabs present wouldn't be testing what shipped. Two were re-targeted rather than deleted: S35 parity now compares against the SERVER's own-scope payload (the property itself, not a UI proxy), and the multi-slot SWR check flips DATE RANGES instead of scopes.
- **One assertion was genuinely LOST and is named:** "single-dept CSV has no Department column" needed the retired `own` tab to make a one-dept payload; the fixture has no sub-queue-less dept. S43 was rewritten to carry that step manually. A fixture for such a dept would restore it.
- **NET 1 − 0 = 1** — fixes a real owner-reported slowness; no new failure mode.
- **Where I left off:** committed + pushed, NOT deployed. PR #211 (roster-scoped audit, idle/unmapped roll-call, call-id sampler) may still be open — check before opening another. Deploy is Department Dashboard only. Tell Sales/CSR/Power managers the tabs are gone. Walk S43 (incl. its new single-dept step), S4, S6, S35. **Next:** Phase 3 (Missed, `missed:v18`) and Phase 4 (IR/Insights, `insights:v20`) are still all-queue, so an IR run for a sub-queue disagrees with My Department for a crossover agent. Open: a harness fixture for a dept with no sub-queues; `meta.subQueueAgentHint` is now unambiguously dead (it was read by the retired own-scope branch); the Insights combined view still unstarted.

## Prior session (/broad-implement queue-split Phase 2 — the reported bug is FIXED)
Branch `claude/sync-commands-dnxgcv`, **581/581 unit tests** (was 571; +10), INV-16 + cache-version-sync + claude-md-split green, UI gate 24/24 + 16/16 + 19/19. Increment 65.
- **This is where the owner's reported bug actually gets fixed.** Phase 0 corrected the combined total; Phase 1 captured the data; Phase 2 makes a department's view show only ITS OWN queues' calls.
- **`applyQueueSplitToRows_` is a PRE-PASS, not edits inside the loop.** It rewrites the six per-agent metrics from the dept's slice before `computeSummary_` aggregates, so E5, the INV-53 floater gate, diagnostics and the totals row all inherit the fix without any of them learning what a queue is. That function is the most heavily pinned in the app; narrowing at the boundary keeps every rule inside it untouched.
- **Fails open THREE ways** — unmapped dept, row with no split, unparseable JSON — because showing a department zero calls is far worse than showing it too many. Each path is tested separately.
- **Phase 2 INVERTS Phase 0, and that is the one place the two could silently fight.** Phase 0 subtracts a crossover agent's repeat because both depts carried identical all-queue figures; once narrowed the two rows PARTITION the day, so summing is correct and subtracting would under-count. A `queueScoped` row now returns before the de-dup and never enters the seen map. Judged per ROW, because a range spanning the cutover holds both kinds. Pinned by its own test.
- **ATT is recomputed on the queue's own denominator** (t/n), not scaled. `avgAbdWait`/`csrAvgAbdWait` are deliberately NOT narrowed — the pipeline stamps one per-DAY value on every row, so they were never per-agent.
- **Queue names matched case-insensitively against `inboundQueuesForDept_`** (the raw-name union). Matching `queuesForDept_` alone would silently drop CSR's main queue — the R8-1 lesson.
- **Reads clamped `Math.min(QUEUE_SPLIT, getMaxColumns())`** in both Data.gs and the DAL: the sheet is 34 wide until Phase 1 runs against it, and an unclamped read throws (REP-10). At 34 every row fails open to the rollup, so deploying the dashboard ahead of the pipeline is harmless.
- **The disclosure is warn-tinted on purpose** (`subqSplitNote_`): it changes how the numbers above it should be read, so it must not look like a footnote. Three states (unmapped dept / no split in range / partially split), silent once the range is fully split.
- **The one risk worth naming:** a dept whose queues are mapped WRONG now under-reports where it used to over-report. Only the fully-unmapped case fails open, so a dept missing ONE of its queues is invisible without checking Dept Config. Spot-check per dept after deploy.
- **NET 1 − 0 = 1** — fixes the reported bug; no new failure mode (all three uncertainty paths fail open, the read widening is clamped).
- **Where I left off:** committed + pushed, NOT deployed. **Phase 2 does nothing until Phase 1 has run** — deploy cdr-import + cdr-report first, force re-import the surviving ~14 dates (time-critical: Call_Legs is pruned at 14 days), then the dashboard + a new deployment version. Verify each dept's Dept Config queue mapping early. Walk S35 (a crossover agent's two rows should now show DIFFERENT numbers summing to their old single figure), S6, S4. **Next: Phase 3** (Missed report — timelines + hour-of-day chart still all-queue; the split already carries `mt` for it, but AD/AE/AF need the same earliest-leg attribution) then **Phase 4** (IR/Insights — still all-queue, so an IR run for a sub-queue disagrees with My Department for a crossover agent). Open: no UI-harness coverage of the split note (fixture has no crossover agent); `meta.subQueueAgentHint` dead reference; the Insights combined view still unstarted.

## Prior session (/broad-implement queue-split Phase 0 + Phase 1)
Branch `claude/sync-commands-dnxgcv`, **571/571 unit tests** (was 556; +15), INV-16 + cache-version-sync + claude-md-split green, UI gate 24/24 + 16/16 + 19/19. Increment 64. Also this session: the CSS-outside-`</style>` production bug (`0fb6b76`) and the split PLAN (`0d8d000`).
- **The reported bug:** an agent on two rosters (CSR + Spanish) shows the same all-queue numbers in BOTH depts' views. Root cause is upstream — a DQE row is keyed on (Date, Agent) with no queue dimension and `buildDQEHistoricalData` filters legs by agent name alone.
- **Two symptoms the report did NOT mention, and worse:** in a combined view the crossover agent appears as TWO rows and the grand total counts their calls TWICE. Found by reading `combineSummaries_` rather than by looking at a screen.
- **Phase 0 (shipped):** `combineSummaries_` subtracts each repeat appearance. Built as a CORRECTION PASS over the untouched accumulation, not a re-derivation from `rows` — so a no-crossover combine is byte-identical *by construction*, and the totals don't become coupled to `matchedViaRoster` being set on every row. I built the re-derivation first and it broke four fixtures that don't set that flag; that coupling is exactly what the correction pass avoids.
- **Subtotals stay UN-deduped on purpose** (each must equal that dept's own view, S35), so the grand total can now be LESS than their sum. That had to be captioned in BOTH the table and the CSV — trading a wrong number for an unexplained one would not be an improvement, and a spreadsheet reader is likelier to add the subtotals up.
- **Duration means deliberately NOT deduped.** A doubled sum is arithmetically wrong; a mean weighting one agent twice stays in range, and recomputing would move the number for EVERY combined view. Phase 2 dissolves it.
- **Phase 1 (shipped):** new pure `dqeQueueSplitForAgent_` writes DQE col **AI** (JSON keyed by raw queue name) plus `dqe_history.queue_split` through every writer. **Key the split on queue NAME, not extension** — `getDeptQueueExts_`'s derived mode is circular for exactly this case (a crossover agent teaches Spanish that the CSR extension is Spanish's).
- **The reconciliation rule is the load-bearing part:** leg-level figures partition by each leg's own queue, parent-level ones by that parent's EARLIEST leg. Without it an overflow call ringing one agent through two queues is counted twice and the split silently exceeds the rollup, which would surface later as a dashboard bug rather than a pipeline one.
- **The additive guarantee is asserted, not claimed:** all 11 pre-existing pipeline tests pass UNMODIFIED, and the new suite freezes cols A–AH as literals. The split call is try/catch-wrapped so a defect in it can never cost a day of history.
- **The trap that would have lost a day:** Sheets does NOT auto-expand columns — `getRange` past `getMaxColumns` throws (REP-10) — and every production sheet is 34 wide, so the first build after deploy would have thrown. The build now widens to 35 first. Same clamp applied to the deferred mirror and both backfills.
- **`backfillDQEHistoryUpsert` would have wiped every split** (DO UPDATE without the field). Fixed, and every upsert COALESCEs so a sheet-sourced NULL can't erase a stored value.
- **NET 1 − 1 = 0** — Phase 0 fixes a bug firing in production now; Phase 1 adds two operations that can fail where nothing could before (sheet widen, Neon ALTER), both guarded and precedented but not free.
- **Where I left off:** committed + pushed, NOT deployed. **Deploy is time-critical for Phase 1**: `Call_Legs` is pruned at 14 days, so every day undeployed is a day permanently unsplittable. Order: cdr-import, then cdr-report, then the dashboard (+ new deployment version), **then force re-import the surviving ~14 dates** to capture their splits. Also still pending from earlier: the CSS fix, the F1b inbound queue recognition, the `final_dept` fallback, and the whole sub-queue feature. **Next: Phase 2** (`computeSummary_` consumes the split, `summary:v18`) — that is where the REPORTED bug actually gets fixed; Phase 0 only corrected the total. Then Phase 3 (Missed, `missed:v18`) and Phase 4 (IR/Insights). Open: the Insights combined view (still unstarted); `meta.subQueueAgentHint` dead reference; AD/AE/AF not split (Phase 3).

## Prior session (owner rulings recorded; unmapped-label entry-queue fallback; /sync-docs)
Branch `claude/sync-commands-dnxgcv`, **553/553 unit tests** (was 546; +7), INV-16 + cache-version-sync + claude-md-split green, UI gate 24/24 + 16/16 + 19/19. Commits `5d9d705`, `9d6541d`, plus this sync-docs pass. **THE DEPLOY IS NO LONGER BLOCKED** — every pre-deploy question from increments 53–63 is now answered.
- **Phase 0's blocking action is CLOSED.** Owner ruling: *"Managers of parent dept should have access to child queue data (including agents in that queue)."* Recorded in INV-38, CLAUDE.md's sub-queue decision, and Operator State #39, each with the revocation knob (clear that dept's `Overview Parent` cell), so it can't be re-opened as a suspected accident.
- **`Field Ops Power` is CLOSED too, and NOT the way four increments assumed.** Owner: it "isn't necessarily a child queue in the same way as the other child queues and should still be represented as a separate queue, but the same manager(s) should be able to see both." So the answer is **two Access Control rows** (Tier C multi-dept manager), NOT a parent-map edge. That distinction is now documented in four places because the `Overview Parent` cell does FOUR things (nest the tile, enable the combined view + subtotals, fold the child's queues into the parent's QCD rollup, confer access) and only the last was wanted here. **Do not "finish" the parent map by adding it.**
- **A real hole in the 2026-07 `final_dept` fix, found by the owner's config work and FIXED (`inbound:v7` / `inboundHeatmap:v2`).** `inboundDeptPredicate_`'s two arms are exclusive on the on-hold flag, so an on-hold-abandoned call whose label was mapped to NO dept had the entry-queue arm skipped and attributed to **nobody** — the same silent-disappearance bug the fix was meant to close, relocated from "no map exists" to "this label isn't in it". Unmapped labels now fall back to `entry_queue`. The label map is an OVERRIDE for genuine cross-dept answering, not a prerequisite for being counted.
- **The load-bearing detail is the UNION, not the per-dept list.** The fallback gates on `getAllFinalDeptLabels_()` (every dept's labels) because a per-dept list can't separate "another dept's label" (that dept counts it, no fallback) from "nobody's label" (fall back) — gating per-dept would have counted every cross-dept on-hold call TWICE and pushed dept totals above the company total. Fails OPEN: unreadable config ⇒ empty union ⇒ everything falls back, degrading attribution without losing calls and never double-counting. Blank/NULL `final_dept` is coalesced so it takes the fallback instead of vanishing to three-valued logic (the L10 lesson).
- **Both new bug classes verified by breaking them:** gating the fallback per-dept fails the double-count test; removing the fallback fails all three fallback tests.
- **A correction I had to make to my own earlier proposal.** The known-issues mapping table had both `Field Operations (...)` labels pointing at `Field Ops`. The owner found they appear **interchangeably** for agents in the Field Ops AND Field Ops Power queues, so no mapping is correct for either — save validation refuses a shared label on both (one-call-one-dept), and mapping it to one steals the other's calls. The table now records both as deliberately blank, with a note not to "complete" it later; the fallback is what makes blank correct rather than data-losing, since the two queues have **no crossover agents**.
- **/sync-docs (applied), two real finds.** (1) **README was stale since PR #197** — it presented Access Control as one-row-or-`ALL` with no mention of multiple rows per email, which is exactly the mechanism the Field Ops Power ruling needs. (2) The accessor finding-aid bullet didn't name `getAllFinalDeptLabels_`, whose fail-open contract is load-bearing. Checks 2 clean (76/76 paths both directions, no unlisted source file); the `inbound:v7` cache mentions were caught by the guard during the commit, in four files.
- **NET SCORE 1 − 0 = 1** — one real production bug fixed (on-hold calls attributing to nobody on any unmapped label), no new failure mode.
- **Where I left off:** committed + pushed. **DEPLOY IS THE NEXT ACTION AND NOTHING BLOCKS IT.** Order matters: **CDR Import FIRST** (`cd apps-script/cdr-import && clasp push -f`) because F1b's brand-prefixed queue recognition is losing inbound attribution daily and dates past the ~14-day `Call_Legs` retention are unrecoverable; **then Department Dashboard** (`clasp push -f` from repo root **+ a new deployment version** — the push alone doesn't move the deployment, Operator State #2). Operator actions after that: give shared Field Ops / Field Ops Power managers a second Access Control row; **clear** the two `Field Operations (...)` labels if they were entered against Field Ops; re-run `runInboundQcdParityCheck` (expect the mapped labels to cover **140 of 146**, not 145 — the 5 Field Operations calls now attribute by entry queue); walk S4/S6/S11/S13/S35/S37/S40/S43. Then: **(1) the Insights combined view — own session, `insights:v19→v20`; (2) drop `continue-on-error: true` from the `ui-harness` CI job.** Smaller open items unchanged: the weighted-duration half of S35's addendum isn't automated; `meta.subQueueAgentHint` is still a dead reference; the missed section's `all` scope stays a documented partial; re-run the QCD parity gate if `QCD_READ_SOURCE=neon` was ever set on a default-range pass.

## Prior session (/sync-docs + /broad-implement harness fixture & CSV coverage; Insights combined view NOT started)
Branch `claude/sync-commands-dnxgcv`, **546/546 unit tests** (unchanged — the new coverage is necessarily browser-side), INV-16 + cache-version-sync + claude-md-split green, UI gate now **24/24 + 16/16 + 19/19, all stages passed**. **No `apps-script/` file changed in the implement half — nothing new to deploy.** Increments 63 (+ the sync-docs pass).
- **/sync-docs (applied), three finds.** (1) **S35 was stale in a way that mattered** — I'd named it as THE post-deploy check in three consecutive increments, but its text still described only the Phase D floater validation with nothing about `deptGroups`, per-dept subtotals or the combined grand total. It now carries an addendum with the three comparisons that actually catch a regression (parent subtotal == its own-scope total to the digit; counts sum; durations are the agent-count-WEIGHTED mean, not a mean of means). (2) **The S41/S42 numbering collision is finally resolved** by PROMOTING the two never-numbered perceptual checks from increment 54 (theme×mode sweep, narrow-viewport reflow) rather than leaving an un-numbered TODO blocking every new scenario — which unblocked **S43, the first regression scenario covering CSV export at all**. (3) The agent-table column-model bullet described the CSV as "all columns + the bar + Answer %", which stopped being the whole story in increment 62. Checks 2+3 clean (76/76 paths both directions; the same 11 benign properties).
- **⚠ ITEM 3 OF 3 — the Insights combined view — was NOT STARTED, deliberately.** I measured it first: `InsightsReport.gs` is 992 lines with 23 references to the team-comparison fields, and the client has 93 `ins*` functions with 15 more touch points on them. A combined view means per-dept team rollups threaded through the KPI tiles, share donut, per-agent cards, trend chart AND the Insights↔My-Department hand-off, plus `insights:v19→v20`. Starting it with the context left would have produced a half-wired report, and Insights is the flagship surface where a half-wired team average is worse than no feature. **Nothing is broken while it waits** — Phase 2's one-dept-per-run rule is the correct interim behavior, and a parent manager reaches a sub-queue's Insights via its picker group. **Give this its own session.**
- **What DID ship: the untested-client-surface problem is closed for the sub-queue work.** New `drive-subqueue.js` with **19 asserting checks**, wired as the gate's THIRD driver. Covers the scope bar (all three options, combined default), the note in every scope including `own` where it must disclose the exclusion, the grouped table with the child tagged, per-dept subtotal rows, all 7 agents across both depts, the switch dropping the grouping, and the missed section's scope note.
- **A pleasant surprise worth recording: the harness fixture was ALREADY parent/child capable** — the roster nests `Spanish` under `CSR` via the `OVERVIEW_PARENT_OF` constant, so the default CSR payload was already the combined view. Only the missing scopes needed adding (`summary-30d-own` / `-subs`) plus a subScope-aware stub. Checking before building saved writing a fixture from scratch.
- **The S35 parity property is now AUTOMATED** — the driver reads the CSR subtotal from the combined view, switches to `own`, reads the totals row, and compares every numeric cell. That property is what makes the combined view trustworthy, and it was previously only checkable by a human with two screenshots.
- **First automated CSV coverage in the repo (S43).** The exporter Blob-and-clicks, so the driver stubs `URL.createObjectURL` and asserts the REAL bytes: single-dept has no `Department` column (byte-compatibility), combined leads with it and carries both subtotals + an `All shown` total, and there are no group-header banner rows.
- **Both new assertion classes verified by breaking them:** removing the CSV Department header fails the column check; making `combineSummaries_` mutate a part it should only read (`t.totalRung += 1`) fails the parity check with a visible off-by-one — exactly the silent bug class that property exists to catch.
- **NET SCORE 0 − 0 = 0** — no production bug fixed; one defensive item, but the one that changes the odds on every future sub-queue change, which is why it came before item 3 rather than after.
- **Where I left off:** committed + pushed. **Nothing to deploy from THIS increment** (harness-only), but increments 53–62 are all still undeployed and **Phase 0's blocking action still stands** (confirm the four seeded parent pairings should confer access at all). **Next, in the order I'd do it: (1) the Insights combined view — own session, `insights:v19→v20`; (2) drop `continue-on-error: true` from the `ui-harness` CI job** — three asserting drivers are green now, and until that line goes every one of these checks is advisory; (3) DEPLOY, which is the real blocker on all of it being worth anything. Smaller open items: the weighted-duration half of S35's addendum isn't automated (needs a fixture where two depts' durations differ); `meta.subQueueAgentHint` is still a dead reference — wire it as an agent count or remove; `Field Ops Power` isn't in the parent map — owner to confirm; the missed section's `all` scope stays a documented partial. Also: the 12 Dept Config `Final Dept Labels` rows aren't entered, and the QCD parity gate should be re-run if `QCD_READ_SOURCE=neon` was ever set on a default-range pass.

## Prior session (/broad-implement the CSV gap + Phase 3 — Missed & Escalations)
Branch `claude/sync-commands-dnxgcv`, **546/546 unit tests (UNCHANGED — no new tests, see below)**, INV-16 + cache-version-sync + claude-md-split green, UI gate **24/24 + 16/16**. No cache version changed. Deploy: **Department Dashboard** (script.html, dashboard.html). Increment 62.
- **CSV gap closed.** `exportTableCsv_` adds a leading **Department** column ONLY when >1 dept is shown, so a single-dept export is byte-identical; rows are emitted per dept, each followed by that dept's OWN subtotal from `deptGroups`, then a grand total labelled `All shown`. The filename gains a `_subs`/`_all` tag — without it, exporting two scopes of the same dept+range silently overwrote the first file.
- **Deliberate divergence from the on-screen table: NO group-header pseudo-rows in the CSV.** A human reads a table top-to-bottom so banners work there; a spreadsheet reader wants a Department COLUMN to pivot and filter on, and banner rows break both. Written into `docs/client-ui-conventions.md` specifically so the next person doesn't "fix" the inconsistency.
- **Phase 3 Missed: scoped ONLY for single-dept scopes** (`subs` with one child runs on that child). **Deliberately NOT merged for `all`** — the queue-only abandoned section already covers a parent's sub-queue queues (`queuesForDept_` rolls them up), so summing a child's report in would double-count every queue abandon AND every abandoned-ring bucket in the hour-of-day chart. Same trap as the QCD snapshot in Phase 1, same root cause. `subqMissedScopeNote_` states what is/isn't included in one line under the title — that sentence is the difference between a defensible partial and a confusing one.
- **Phase 3 Escalations: NO CODE CHANGE, and that's the finding.** `getEscalations` already scopes by `user.departments`, so Phase 0's widening gave a parent manager their sub-queue's escalations automatically and `metaDept` already reports the joined list. Verified rather than inventing work to fill the phase.
- **⚠ HONEST GAP: no new unit tests.** Both changes are pure client rendering in `script.html`, which the zero-dep `.gs` harness structurally cannot load; the UI harness could reach them but has no CSV-download or sub-queue fixture, and building one is bigger than either change. So they're covered at boot level only (no console errors, no overflow) plus manual walks. **If either regresses, a person notices, not CI.** The tractable fix is a UI-harness fixture with a parent/child payload — it would cover the scope bar, grouped table, subtotal rows AND the missed note in one go, and is worth doing before the next sub-queue phase because every phase adds more untested client surface.
- **Also noticed: no regression scenario covers CSV export at all** — not just the sub-queue case. S6 covers the Source column/totals on screen but nothing exercises a download. Promoting one is cheap and overdue, but it's blocked behind the S41/S42 numbering collision.
- **NET SCORE 0 − 0 = 0** — both items were created by Phase 1 and closed here, which nets to zero rather than counting as fixes.
- **Where I left off:** committed + pushed, **NOT deployed**. **Phase 0's blocking pre-deploy action still stands** (confirm the four seeded parent pairings should confer access at all). New non-blocking action: **export a combined CSV for Sales and eyeball it** — it's the one change with zero automated coverage. Then walk **S4** in all three scopes (confirm the scope note matches what the section shows), **S6**, **S40**, and Phase 1's **S35**. **Remaining sub-queue work:** the **Insights combined view** is the last substantial piece (own phase, `insights:v19→v20`, needs per-dept team rollups threaded through KPI tiles + share donut + per-agent cards + trend chart). The missed section's `all` scope is a documented partial, not a finished state. Still open: the UI-harness sub-queue fixture (above); `meta.subQueueAgentHint` referenced in a dead branch and never populated; the S41/S42 collision (now blocking TWO scenario promotions); `Field Ops Power` not in the parent map — owner to confirm. **And still true: NOTHING in increments 53–62 is deployed**, the 12 Dept Config `Final Dept Labels` rows aren't entered, and the QCD parity gate should be re-run if `QCD_READ_SOURCE=neon` was ever set on a default-range pass.

## Prior session (/broad-implement Phase 2 — sub-queue groups in the IR + Insights pickers)
Branch `claude/sync-commands-dnxgcv`, **546/546 unit tests** (+6), INV-16 + cache-version-sync + claude-md-split green, UI gate **24/24 + 16/16**. **No cache version changed** (a consequence of the separate-helper decision below, not an oversight). Deploy: **Department Dashboard** (Util.gs, IndividualReport.gs, script.html, styles.html). Increment 61.
- **⚠ SCOPE HONESTY — Insights' report BODY did NOT get the Phase 1 combined view.** What shipped is the PICKER side of both reports plus the correctness rule it requires. The reason is a design finding, not time: a combined agent-level Insights run needs per-dept team ROLLUPS, and Insights' team comparison is threaded through the KPI tiles, the share donut, the per-agent cards AND the trend chart. Bolting a second dept into one run would compare agents against the wrong team average — exactly the failure the owner's per-dept-subtotals decision exists to prevent. So the right move was the one-dept-per-run rule, not a partial combine. Doing it properly is comparable in size to Phase 1 and deserves its own phase.
- **What shipped:** both pickers gain one collapsed group per sub-queue, from a new `subQueueGroups` field on `getIndividualReportInit`. **Insights delegates to that same init, so it inherited the field with zero changes** — which also means the two pickers cannot drift.
- **Key design call: `computeSubQueuePickerGroups_` is a SEPARATE Util.gs helper, not a new mode on `computeActiveAgentsInRange_`.** That function's `{agents, floaters}` shape is pinned by `individual_active:v2`, is consumed by both pickers, and contains the INV-53 floater gate — leaving it untouched meant **no cache bump and no risk to that gate**. Each child is computed with THAT child's roster, so a sub-queue's active set inside the parent's picker is identical to what its own report shows. Per-child best-effort: a failure omits the group and logs, because a picker that fails to open is worse than one missing a group. **Verified by breaking the try/catch.**
- **The correctness rule that makes the groups safe: ONE report run is ONE department.** `subqPickerScope_` reads the checked boxes — a selection confined to one sub-queue group runs against THAT dept; a selection SPANNING depts is refused with a reason. The team average/rollup is per-dept (INV-25/27), so a mixed run would silently compare agents against the wrong team. The group carries an inline note naming which team average will be used, so the behavior is visible before the click rather than surprising after.
- **The sub-queue group is deliberately NOT muted.** Inactive and floater groups are de-emphasised because you rarely want them; a sub-queue is a department and a first-class choice.
- **INV-53 stayed untouched and that was the point** — a sub-queue agent is a roster member of their own dept, never a floater, and the two now render as distinct picker groups instead of being conflated.
- **NET SCORE 0 − 0 = 0** — correct for a feature phase.
- **Where I left off:** committed + pushed, **NOT deployed**. **Phase 0's blocking pre-deploy action still stands** (confirm the four seeded parent pairings should confer access at all). After deploy, walk **S13** (picker grouping — the sub-queue group appears for Sales/CSR/Power, is not muted, and a cross-dept selection is refused) plus S11/S37, and Phase 1's **S35**. **Next candidates:** (a) **Insights combined view** — the named gap above, own phase, `insights:v19→v20`; (b) **Phase 3** (Missed `missed:v18` + Escalations); (c) the **Phase 1 CSV gap** (a combined-view CSV still has no Dept column, group headers or subtotals) which is the smallest of the three and the most visible to a manager who exports. I'd do the CSV first. Also still open: `meta.subQueueAgentHint` referenced in a dead branch and never populated; the S41/S42 numbering collision; `Field Ops Power` not in the parent map so a Field Ops manager won't see it — owner to confirm. **And still true: NOTHING in increments 53–61 is deployed**, the 12 Dept Config `Final Dept Labels` rows aren't entered, and the QCD parity gate should be re-run if `QCD_READ_SOURCE=neon` was ever set on a default-range pass.

## Prior session (/broad-implement Phase 1 — the My Department sub-queue switcher)
Branch `claude/sync-commands-dnxgcv`, **540/540 unit tests** (+5), INV-16 + cache-version-sync + claude-md-split green, UI gate **24/24 + 16/16** (dept page clean in both roles — no blank canvases, no horizontal overflow, which was the specific risk of adding a bar above the table). Deploy: **Department Dashboard** (Data.gs, script.html, dashboard.html, styles.html). Increment 60.
- **What shipped:** a three-way segmented control on My Department for a parent dept — `<dept> only` / `<subs> only` / `<dept> + <subs>` — persisted per dept in `cdr.dept.subscope`, **defaulting to COMBINED** per the owner's decision. Depts with no sub-queues get no control and no behavior change (11 of 14). `subScope` is a cache-key dimension → `summary:v15→v16`.
- **"Combined" means grouped, never merged.** Rows carry `dept`; each dept gets a `subq-group-head` subheader and its OWN subtotal row from the new `deptGroups`; the grand total is explicitly labelled. So the familiar own-dept number stays on screen and every figure reconciles against that dept's own view. Team averages and benchmark tints stay PER-DEPT — one average across two teams with different call profiles is a worse number, not a better one.
- **The always-on relationship line is the highest-value piece and renders in EVERY scope**, including `own`, where it says the sub-queue is excluded. That exclusion was previously *completely invisible* to a parent manager. A CHILD dept gets an upward pointer only, no switcher (one level, matching the server).
- **Key design call: `combineSummaries_` calls `computeSummary_` once PER DEPT and merges, rather than teaching that function to aggregate a list.** `computeSummary_` carries INV-02/04/05/23/53 + S35 + E5 and is the most pinned function in the app, so merging outside it leaves all of that untouched — and it buys the property the owner actually asked for: **a dept's subtotal in the combined view comes from the exact code path as its own view, so the two cannot disagree.** Cost is N DQE reads instead of 1 (2 for the real parents), once per 30-min TTL per (dept, range, scope).
- **Two traps handled, both pinned with the reason in the assertion:** (1) duration means merge as an agent-count-WEIGHTED mean, never a mean of means, which would over-weight a one-agent sub-queue — a dept with no non-zero agents drops out of both sides, matching `avgNonzero_` (v11/F-29); **verified by breaking it**. (2) **`qcd` comes from the PRIMARY dept only** — `queuesForDept_` already rolls a parent's sub-queue queues into its own QCD snapshot (the v6 change), so merging QCD across depts would double-count every sub-queue call.
- **INV-53 is the invariant most at risk from a careless merge**, and the reason the merge sums each dept's `totals` rather than re-deriving from `rows`: each dept's total already excluded its own floaters, so the grand total excludes them exactly once.
- **The cache-version guard fired on its own** during this change and forced the `summary:v15→v16` sweep across OrphanFix.gs + 5 docs. Second time this cycle it has caught a real omission.
- **Honest gap, listed rather than hidden: the CSV export does not reflect the combined view** — no Dept column, no group headers, no subtotals. Out of Phase 1's stated scope, so not silently added. Also: the missed section + team strip still show the primary dept only (Phase 3), and the switcher's note doesn't yet say what it does and doesn't scope.
- **NET SCORE 0 − 0 = 0** — correct for a feature phase; no pre-existing bug fixed.
- **Where I left off:** committed + pushed, **NOT deployed**. **Phase 0's blocking pre-deploy action still stands** (confirm the four seeded parent pairings should confer access at all). New non-blocking action: tell the Sales / CSR / Power managers their view now opens combined. **After deploy, walk S35** — verify a combined grand total equals the sum of its subtotals AND that each subtotal equals that dept's own view; that is the one scenario this change could break invisibly. **Next: Phase 2** (Insights + IR picker, `insights:v20`, `individual_active:v3`), then **Phase 3** (Missed `missed:v18` + Escalations). Alerts/Digests stay OUT by decision. Still open: the CSV gap above; `meta.subQueueAgentHint` is referenced in a dead branch and never populated (wire it as an agent count or remove); the S41/S42 numbering collision; `Field Ops Power` is not in the parent map so a Field Ops manager will not see it — owner to confirm. **Also still true: NOTHING in increments 53–60 is deployed**, the 12 Dept Config `Final Dept Labels` rows aren't entered, and the QCD parity gate should be re-run if `QCD_READ_SOURCE=neon` was ever set on a default-range pass.

## Prior session (/broad-implement Phase 0 — sub-queue ACCESS widening)
Branch `claude/sync-commands-dnxgcv` **restarted from `origin/main`** after PR #206 merged (40 commits landed; the branch carried only merged history, so a clean re-base was correct rather than stacking). **535/535 unit tests** (+15), INV-16 + cache-version-sync + claude-md-split green, UI gate 24/24 + 16/16. Deploy: **Department Dashboard** (Auth.gs, DeptConfig.gs). Increment 59.
- **Context:** the owner asked for a way to view sub-queue detail separately / combined-with-transparency. I planned it in 4 phases and asked 4 design questions. Owner chose: parent-implies-child ACCESS, all three phases, **combined by DEFAULT** (against my recommendation — I flagged that it moves every existing Sales figure, they took it; their choice of per-dept subtotals + a labelled grand total substantially de-risks it, since the familiar parent number stays on screen), and per-dept subtotals rather than one merged total. Phase 0 is the security-bearing part, built and committed ALONE so it can be reviewed in isolation.
- **What Phase 0 does:** `resolveUser_`'s manager branch returns `departments` = assigned ∪ **one-level** sub-queues (Overview parent map), plus a new `assignedDepartments` holding the raw Access Control assignment. `department` (landing dept) is unchanged. **Widening in ONE place is the whole design point** — `assertDeptAccess_`, `escAssertRowAccess_`, `getEscalations` scoping, `personalizeOverview_` and the client's `canPickDept_`/selector all already read `departments`, so they inherit it instead of me patching six gates and missing one.
- **Guards (this is the first time the parent map affects AUTHORIZATION, not tile layout — INV-38 rewritten):** ONE LEVEL only (a transitive walk would let one bad cell cascade); FAIL CLOSED (any error reading the map returns the assigned list unchanged — auth must never widen *or break* on a config read); and read-side re-validation that drops self-parent edges, edges naming a non-existent dept, and any cyclic edge. **That read-side check is NOT redundant with `saveDeptConfig`'s** (which already had self-parent/unknown/cycle validation via `dcWouldCreateParentCycle_`) — the sheet is hand-editable, Neon is backfillable, and `OVERVIEW_PARENT_OF` is a code constant; none pass through the modal.
- **⚠ The single most important operator fact: this confers access ON DEPLOY with NO admin edit.** The shipped constant already holds `PAP→Sales`, `PAP Q→Sales`, `Spanish→CSR`, `PAK→Power`, so every Sales manager gains PAP, every CSR manager Spanish, every Power manager PAK — agent-level data included. Pinned by a dedicated test so it can't surprise anyone later, and written up as **Operator State #39** with a BLOCKING pre-deploy check. Clearing an `Overview Parent` cell revokes access but also un-nests the Overview tile — one cell, two meanings, which is the inherent trade-off of reusing the existing map instead of adding a second one.
- **Side effects that are intended but land early:** escalations scope widens for a parent manager (the Phase 3 end state), and `canPickDept_()` now returns true for them, so a dept selector appears where there was none and the role tag reads "manager · 2 depts". That means Phase 0 alone already lets a parent manager switch to their sub-queue, before any Phase 1–3 UI exists.
- **Verified both guards by breaking them**: reverting `departments: effective` fails 5 tests; disabling the cycle filter fails the cycle test. Two of my own fixture bugs surfaced and were fixed properly rather than worked around — the REAL `OVERVIEW_PARENT_OF` constant seeds live edges that bled into tests naming PAP/Spanish/PAK (renamed to neutral depts + a dedicated seeded-constant test), and a `getOverviewParentMap_` stub leaked between tests (install() now restores it).
- **NET SCORE 0 − 0 = 0** — correct for an enabling change; no bug is fixed here, and the pre-existing gap was a design decision rather than a defect.
- **Where I left off:** committed + pushed, **NOT deployed**, and the pre-deploy pairing confirmation BLOCKS deploy. **Next: Phase 1** (My Department switcher — `Sales only · PAP only · Sales + PAP`, combined default, per-dept subtotals + labelled grand total, the always-on relationship line, `summary:v15→v16`), then Phase 2 (Insights + IR picker, `insights:v20`, `individual_active:v3`), then Phase 3 (Missed `missed:v18` + Escalations). Alerts and Digests stay OUT by decision. Open: the S41/S42 numbering collision (two never-promoted perceptual checks from increment 54 hold those names — promote them or start new scenarios at S43); `Field Ops Power` is not in the parent map and looks like a `Field Ops` sibling, so a Field Ops manager will NOT see it — owner to confirm; `user.assignedDepartments` is populated but unread until Phase 1 uses it for the relationship line. **Also still outstanding from the merged branch:** nothing is deployed at all (increments 53–58 included), the 12 Dept Config `Final Dept Labels` rows aren't entered, and the QCD parity gate should be re-run if `QCD_READ_SOURCE=neon` was ever set on a default-range pass.

## Prior session (/broad-implement Batch 7 — F8, the CLAUDE.md split; LAST batch of the cycle)
Branch `claude/sync-commands-dnxgcv`, **505/505 unit tests** (+5), INV-16 + cache-version-sync green. Docs + tests ONLY — no `apps-script/` file touched, **nothing to deploy**. Increment 58.
- **CLAUDE.md 373,570 → 153,222 bytes (−59%)**, split into a working document + four indexed reference files: `docs/invariants.md` (the Invariant Library, 97 KB), `docs/operator-state.md` (the 38 numbered items, 51 KB), `docs/regression-scenarios.md` (S1…S40, 43 KB), `docs/client-ui-conventions.md` (14 client/presentation gotcha bullets, 55 KB). **Zero content lost** — verified line-by-line against `git show HEAD:CLAUDE.md`: 3 lines differ, all three the Read-first prose I deliberately rewrote. All four headings STAY in CLAUDE.md holding an index + pointer, so every `/cycle-*` / `/broad-*` instruction that reads "CLAUDE.md's Cycle Workflow Config → Invariant Library" still lands on a section by that name.
- **The invariant index is 55 HAND-WRITTEN one-liners, not truncations** — a truncated INV-30 or INV-55 is worse than no index. Scenario titles + operator item numbers are verbatim. Every index header states the entry is authoritative and the summary is a finding aid.
- **What deliberately did NOT move:** the six client traps that bite unrelated work (`safeChart_`, `dsConfirm_`, `csvSafeCell_`, the datalabels registration, the OKLCH/datalabels fillStyle rule, the `</script>`-in-scriptlet escape) stayed in Common Gotchas, and the index bullet says so in both directions; so did the Operator-State scope note + "start at the Health page" instruction (rules about HOW to use the checklist, needed unprompted); so did four mixed server+client bullets (WoW chips, missed-card tiers, threshold drift, heatmap) that describe payload fields as well as rendering. The 14-bullet cut is my judgement call, named as such: if a client rule turns out to be missed, copy that ONE rule back rather than unwinding the split.
- **The split would have silently gutted the cache-version guard.** `cache-version-sync.test.js` had a hardcoded 4-file `DOC_FILES`, and INV-30 — the cache-version table, the densest source of `prefix:vN` claims in the repo — moved into a file that wasn't on it. Added all four. Kept the list EXPLICIT rather than globbing `docs/*.md`: I tested the glob and it fails on 10 legitimate historical references in `fix-history.md` + `insights-drilldown-spec.md`, which are archives. **This is the one item that would have fired — a bug this batch would have introduced, catching itself.**
- **NEW `tests/unit/claude-md-split.test.js` guards the split's own new failure mode** (index↔file drift, silent in the worst direction: an invariant added only to the doc is invisible to anyone reading CLAUDE.md). Five checks: all four files linked AND linked from "Read first" specifically; invariant IDs+Subsystems match; scenario IDs+titles+Subsystems match exactly; operator numbers match and stay contiguous from 1 (they're cited BY NUMBER across the repo); and a **200 KB size cap on CLAUDE.md** whose failure message names the split pattern as the remedy rather than raising the number. **Every check was verified by breaking it first** — that surfaced a real bug in my `section()` helper (it cut a `##` section off at its first `###` sub-heading, so the Read-first check failed the moment I restructured that section).
- **Swept the pointers the split made WRONG, not merely imprecise:** two docs claimed canonicality that had moved ("CLAUDE.md INV-30 is the canonical current-version list"), so a reader would land on a one-line summary and believe it was the full contract. Fixed in `architecture.md` (4 sites) + `conventions.md`; `fix-history.md`'s live-truth/archive division — its whole premise — now names the four split files as still-LIVE-TRUTH; README gains a paragraph explaining that "see CLAUDE.md INV-54" means index-there, entry-in-the-doc; `tests/README.md` repointed to the scenarios file.
- **Honest cost:** ~25 KB of NET new bytes across the repo (indices + provenance headers) in exchange for 220 KB out of every session's context. 55 invariant summaries and 40 scenario titles now exist in two places — which is exactly what the new guard exists to police.
- **⚠ `/setup-cycle` would undo this** — it rewrites `### Invariant Library` / `### Regression Scenarios` with full bodies. The ID checks would still pass (bodies would agree with the docs); the **size cap is the backstop**. Re-split rather than raising the cap.
- **NET SCORE 0 − 0 = 0** — the correct score for a docs batch, deliberately not inflated. Under the three-way tally: one restructure + one new guard + one repaired guard. Value is future-tense: the file is readable in one sitting and cannot regrow to 372 KB without a test failing.
- **Where I left off:** committed + pushed, nothing to deploy. **Common Gotchas is still the largest section (~87 KB / 50 bullets)** — CLAUDE.md is readable now but not small, and the remaining reduction is a DIFFERENT, higher-risk job: separating each bullet's rule from its version history means paraphrasing live rules, and a paraphrase that drops a caveat is how this repo gets bitten. Do that bullet-by-bullet with review, never in one pass; the four biggest (Inbound capture 13 KB, Neon write discipline 5.8 KB, role model 5.5 KB, Neon read-back 5.0 KB) are all genuinely load-bearing and mostly history. **ALL SEVEN SCAN BATCHES ARE NOW CLOSED** — what remains is entirely operator work, carried across four increments: from **57**, re-run the QCD parity gate if `QCD_READ_SOURCE=neon` was set on a default-range pass (that pass may have compared nothing), then the four flips in order each requiring `clean:true` AND `compared > 0`, and run `runInboundQcdParityCheck` for the still-OPEN Batch-5 investigation (the QCD-vs-inbound discrepancy is NOT resolved); from **56**, read the Health page's Install-readiness row and run `node scripts/check-remote-orphans.mjs .`; from **55**, drop `continue-on-error: true` from the `ui-harness` job once it's been green; from **53**, deploy both projects, re-run the Op-State-#38 histogram, decide UDC/UUC attribution, walk S41/S42. Follow-ons: `docs/known-issues.md` has no entry for either guard class hardened this cycle (Batch 6's false-clean compare gate, this batch's index drift); `docs/fix-history.md` has no `F8` entry for the split itself; `/broad-implement`'s §4 wording locates the invariant library in "Common Gotchas" where it never was (a `/sync-commands` fix, it's a template file).

## Prior session (/broad-implement Batch 5 + Batch 6 — the two operator-gated batches; gate tooling only)
Branch `claude/sync-commands-dnxgcv`, **500/500 unit tests** (+7), INV-16 + cache-version-sync green. UI gate NOT re-run (no client file changed). Deploy: **Department Dashboard** (QCDReport.gs, NeonRead.gs, InboundReport.gs — all editor-run diagnostics, so the push only matters for when you next RUN them). Increment 57.
- **Read this first: both batches are operator-gated by construction and were only PARTIALLY implementable here.** Batch 5's core act is running `runInboundQcdParityCheck` against live Neon and judging the output; Batch 6's is running each parity gate and then setting a Script Property on a live deployment. I cannot execute Apps Script, reach Neon, or set Script Properties. **No flag was flipped** — flipping one by changing a code default would move production onto an unverified mirror without a parity-clean gate, which every runbook here forbids. **The QCD-vs-inbound discrepancy is NOT resolved and I am not claiming it is.** What I did instead: audited the tools both batches depend on and fixed what would have made the operator's runs wrong or inconclusive.
- **Batch 6 — a LIVE false-pass on Batch 6's own critical path.** `compareQcdSources_` computed `clean = missingInNeon===0 && extraInNeon===0 && mismatches===0`, so with ZERO comparable rows all three are 0 and the gate printed `QCD PARITY CLEAN -- the gate PASSED`: the strongest possible green light for a `QCD_READ_SOURCE=neon` flip, on no evidence. `neonFetchQcdGrid_` returns a non-null EMPTY grid for an empty range so the existing `!neonGrid` guard never covered it, and **the in-source default range is a hardcoded week (2026-05-23..2026-05-29) that has aged ~2 months out of the data** — an operator who ran the gate without setting `QCD_PARITY_FROM/_TO` was the likely first victim. Now an empty comparison logs `QCD PARITY INCONCLUSIVE`, names the cause, says "Do NOT flip QCD_READ_SOURCE on this", and returns `clean:false`; the CLEAN line states how many rows backed the verdict.
- **Verified the new test actually catches it** — removed the guard, confirmed `Batch 6: ZERO comparable rows is INCONCLUSIVE, never CLEAN` fails, restored it. Without that step the test would have been a tautology.
- **Batch 6 — both read-source gates now return a structured verdict** (`{from,to,clean,compared,missingInNeon,extraInNeon,mismatches,roundingOnly,error}`) from every exit; they previously returned `undefined`, so nothing could read them programmatically. `compareDqeSources_` was **not** actually broken — its `extraInNeon` check catches sheet-empty because every Neon row reads as "extra" — but that protection was **incidental, not designed**, and would have become the same false CLEAN the moment the verdict stopped counting extras (exactly what the QCD gate did). Made the requirement explicit and said so in the comment. This extends the CORE-5/F-5 rule (a compare gate must never print a false PARITY CLEAN) from the three config gates to the two read-source gates, which is where it was missing.
- **Batch 5 — `runInboundQcdParityCheck` was structurally blind to the population that mechanically produces the gap it exists to settle.** Its unattributed-queue scan filters `COALESCE(entry_queue,'') <> ''` — the same filter that hides an unrecognized queue from Dept Config's discovery panel (Op State #38) — so calls the capture never recognized had no row anywhere. New NO-entry_queue probe counts window calls with `COALESCE(entry_queue,'') = ''` grouped by `(disposition, abandon_stage)`, returned as `noEntryQueue`. Those calls count in the ADMIN company view but attribute to no dept. The log **deliberately warns that an `abandoned + ivr` count is NOT automatically a bug** (it unions genuine auto-attendant give-ups with unrecognized-queue misses), points at the Op-State-#38 journey histogram to split them, and notes F1b makes brand-prefixed queues attribute so a re-import inside the ~14-day window shrinks the bucket.
- **NET SCORE 1 − 0 = 1.** The QCD false-clean is the one that counts YES on "would it fire this month": the gate is the documented precondition for the flip, Batch 6 was queued to run it, and on the shipped default range it would have returned a meaningless pass. The DQE guard and the inbound probe are the 2 defensive/structural items.
- **Where I left off:** committed + pushed, NOT deployed. **⚠ Highest-value operator action: if `QCD_READ_SOURCE=neon` was already set on the strength of a default-range pass, RE-RUN the gate now** — that pass may have compared nothing (reversible with no redeploy). Then the flips in order, one per cycle, each requiring **`clean:true` AND `compared > 0`** (an `error` or `compared: 0` is a STOP, not a pass): 1. `QCD_READ_SOURCE` (set `QCD_PARITY_FROM/_TO` to a representative recent range first), 2. `CONFIG_SOURCE`, 3. `DQE_READ_SOURCE`, 4. `NEON_MIRROR_MODE=deferred`. **Batch 5 stays OPEN as an investigation** — run `runInboundQcdParityCheck` and read THREE things (per-dept `diff`/`diffWithHold` = the definitional gap; UNATTRIBUTED entry-queues → fix via Dept Config "Inbound queue aliases"; the NEW no-entry_queue bucket = attributable to no dept at all); expect one round trip. Only after the gap is quantified should the Inbound/Direct manager gates come off. **Still outstanding from increment 53:** deploy both projects; the Op-State-#38 histogram; UDC/UUC attribution; S41/S42. **From 56:** read the Health page's Install-readiness row; run `node scripts/check-remote-orphans.mjs .`. **From 55:** delete `continue-on-error: true` from the `ui-harness` job once it's been green. **Remaining: Batch 7** (F8 — CLAUDE.md split, now ~372 KB; every batch this cycle grew it, L ≈ 3d+). Follow-ons: a "flip readiness" function calling all five gates is now possible (all return structured verdicts) but deliberately NOT built (new scope); both gates' default parity ranges are still hardcoded fixed weeks (they now fail loudly instead of falsely passing — deriving them is a behavior change to a safety tool and warrants its own decision); `docs/known-issues.md` has no entry for the false-clean-gate class, now a genuine institutional-memory item.

## Prior session (/broad-implement Batch 3 + Batch 4 — ops smalls + deployment hygiene)
Branch `claude/sync-commands-dnxgcv`, **493/493 unit tests** (+3), INV-16 + cache-version-sync green, UI gate **24/24 + 16/16** (+1 F10 assertion). Deploy: **Department Dashboard** (Data.gs, CompanyOverview.gs, SystemHealth.gs, script.html). Increment 56.
- **F9 (cost):** `getLatestDataDate` (MAX) and `getLatestDataDates` (MAX + the R12-26 `dqeEarliest` MIN) each ran their own whole-column `getValues()` on `DQE Historical Data`, so a COLD cache read a multi-year column TWICE per 5-min expiry. New `sheetScanDqeDateBounds_()` yields both from one read, memoized per execution (the `DEPT_CONFIG_ROWS_MEMO_` discipline). Deliberately NOT cached across requests — each caller keeps its own R8-C2 negative-cache semantics. **Test-side trap handled:** `install()` in dal-cutover + missed-report now reset `DQE_DATE_BOUNDS_MEMO_`, or a fixture swap would serve the previous test's bounds. New test proves ONE date-column read where there were two.
- **F10 (real user-visible bug):** the escalations nav badge was APPEND-ONLY (`!tab.querySelector('.nav-count-badge')`) and fetched once at init, so a manager resolving their last escalation kept a stale non-zero badge for the whole session and the Overview strip never hid. New `escApplyBadge_()` updates in place and REMOVES at zero; `escLoad_` refreshes it, and since every mutation reloads the list the badge follows every change. **Chose a fresh `getEscalationsBadge()` over reusing the list's `meta.statusCounts`** — the list can be filtered to one dept (admin pick / view-as) while the badge is viewer-FULL-scope, so deriving it would undercount. Pinned in drive-smoke (badge never duplicates on reload).
- **Batch 3.4 (real misreporting bug, the item I'd underestimated):** the Health page already covered every trigger + outcome + property + sheet, so "consolidate install state" was mostly built. The REAL gap: four engines gate their handler BODY on an `*_ENABLED` flag (`NEON_KEEPWARM`, `INGEST_WATCHDOG`, `PIPELINE_WATCH`, `QUEUE_REPORT`) and that was never reconciled against the trigger — **a trigger installed with the flag off fires on schedule, returns immediately, and the page said "installed"**. `svc()` now flags both mismatch directions ("installed but DISABLED — every run is a no-op" / "NO trigger but flag=true — it never runs") plus a single `trg-readiness` verdict row ("N armed, K need attention").
- **F6 (tripwire, downgraded finding):** the Overview cache put now logs the blob size on every put, warns past 80 KB of the ~100 KB CacheService cap, and on FAILURE says explicitly that the Overview is now uncached so every request pays the full compute. Measured ~27 KB at 14 depts (~1.9 KB/dept) ⇒ cap is ~50+ depts away; this is instrumentation, not a live risk.
- **Batch 4 (closes Operator State #29, open across cycles):** new `scripts/check-remote-orphans.mjs`, wired into `deploy.sh` BEFORE the push. clasp has no "list remote files", so it PULLS into a throwaway temp dir (`rootDir` forced to `.` so it can never touch the real project dir) and compares. **Key detail: clasp pull writes server files as `.js` even when they live locally as `.gs`**, so the comparison is on (basename-without-extension, kind) — without that every `.gs` would look orphaned. WARNS by default (an orphan is no reason to block an urgent fix); `STRICT_ORPHANS=1` is fatal; every unrunnable path (no/placeholder `.clasp.json`, pull failure, missing rootDir) skips with a reason and exit 0. **Verified against a SIMULATED clasp pull, which caught a real bug**: the temp dir's own `.clasp.json` was reported as an orphan (it lives outside rootDir locally but inside the pull dir) — now excluded.
- **NET SCORE 2 − 0 = 2** (F10 + Batch 3.4 are live bugs; F9/F6/Batch 4 are the 3 defensive/structural items).
- **Where I left off:** committed + pushed, NOT deployed. **Two NEW operator actions:** (1) after deploying, read the Health page's new "Install readiness (engines)" row — anything saying "installed but DISABLED" has been doing nothing on every run; (2) run `node scripts/check-remote-orphans.mjs .` with an authenticated clasp to finally settle Op State #29 (it will name PerformanceReport.gs / CompareRangesReport.gs if still live). The orphan check could NOT be exercised against the real projects here (no clasp auth in this environment) — logic is simulation-verified, the first real run is the operator's. **Still outstanding from increment 53:** deploy both projects; re-run the Op-State-#38 histogram; decide UDC/UUC attribution; walk S41/S42. **Remaining batches: 5** (QCD-vs-inbound discrepancy — still the blocker on releasing Inbound + Direct, M ≈ ½–1d), **6** (flag flips from `QCD_READ_SOURCE`, S ≈ 2h each), **7** (F8 CLAUDE.md split, now ~370 KB and grown by every batch since — L ≈ 3d+). Follow-ons: F6 only LOGS (a Health row would need a property written at put time); the badge isn't a live subscription across pages; `docs/known-issues.md` has no entry for the trigger-vs-flag mismatch class.

## Prior session (/sync-docs + /broad-implement Batch 2 — F7, the rendered-UI CI gate)
Branch `claude/sync-commands-dnxgcv`, **490/490 unit tests** (+2), INV-16 + cache-version-sync green, and a NEW second gate: `npm run ci:ui` → drive-smoke 22/22 + drive-f13 16/16. Docs + CI + audit tooling only — **no `apps-script/` behavior changed, nothing to deploy**. Increments 55 (+ the sync-docs pass).
- **/sync-docs (applied).** One material find: `docs/known-issues.md` still documented the inbound capture as `/^A_Q_/i` — the exact claim F1b invalidated — which would have recreated the F1 trap for the next reader. Rewrote the two-queue-name-spaces section (brand-prefix class FIXED, spelling class still live), merged both recognizer-gap histories (Backup CSR/IMP-1 + UDC-UUC/F1b) into one healing note with the measured 38-abandon evidence, and pointed the diagnostic at Operator State #38 instead of the bare NULL-entry count. Added the **deliberate DQE-vs-inbound recognizer asymmetry** to IMP-8 *and* CLAUDE.md — widening the DQE regex gives phantom `A_Q_Main` sentinels (INV-23), re-anchoring the inbound one hides brand-prefixed queues (F1b); nothing said so, so a plausible "harmonize the two regexes" cleanup could have broken either side. `conventions.md` called QCD col D's names "raw" where CLAUDE.md calls them canonical — that overloading is how the confusion started. Checks 2+3 came back CLEAN: 76 listed subsystem paths = 76 on disk (both directions), and all 11 "undocumented" Script Properties are code-written outcome markers or compound-notation false positives — recorded as a scope note on the Operator State Checklist so the next audit doesn't re-flag them.
- **Batch 2 / F7 SHIPPED — the client has an automated guard for the first time.** `npm run ci:ui` (→ `tools/ui-harness/ci.mjs`): gen payloads from the REAL server code → build admin + manager sites from the REAL client → two ASSERTING drivers. Kept SEPARATE from `npm run ci` on purpose — that suite is zero-dep by design and this needs playwright, so folding them would break that promise. New CI job `ui-harness` installs playwright + chromium and runs it.
- **`drive-smoke.js` (NEW)** is the real prize: both roles × Overview/My-Department/Insights/Escalations, failing on page+console errors, unexpected unmocked RPCs, **BLANK chart canvases** (visible, laid-out canvas with entirely uniform pixels = the R12-1 class this harness was born for), and horizontal page overflow. 22 checks.
- **Vendor bundles COMMITTED** (436 KB) + copied by `build-harness.js`, replacing three manual `cp` lines from the README — a real trap, since a fresh checkout built a site with NO `Chart` global, so every chart silently took `safeChart_`'s unavailable path and the harness reported nothing useful. New `tests/unit/ui-harness-vendor.test.js` pins the committed versions to `dashboard.html`'s CDN tags, so the harness can never quietly verify the client against a different Chart.js than production ships.
- **Closed the fixture gap:** added the `qcd-alldept` payload, so the all-departments QCD report renders (9 expandable rows) instead of nothing — the documented reason F13's row fix could only be checked on the Insights proxy. `drive-f13.js` now walks BOTH `tr.qcd-expandable` surfaces, since they share `qcdToggleExpandRow_` but wire SEPARATE delegated keydown handlers; testing one proved half the fix. 13 → 16 checks.
- **Verified the skip path** by hiding `node_modules/playwright`: prints an install hint, exits 0. Safe to run anywhere.
- **⚠ The gate is ADVISORY until someone acts.** The `ui-harness` job carries `continue-on-error: true` so a flaky first-day render can't block a correct pipeline fix. **Delete that line once it's been green across a few PRs**, or the gate is decoration. Flagged in the workflow comment, CLAUDE.md, and the block.
- **Honest note:** Batch 1's own Key-commands text ("the harness is NOT part of `npm run ci`") was made stale BY this batch and is corrected in the same commit. CLAUDE.md is now ~370 KB — Batches 1 and 2 both grew it, so **F8's priority should keep rising**.
- **NET SCORE 0 − 0 = 0** (1 new capability + 2 defensive items under the three-way tally). Value is future-tense: this is what makes the NEXT client regression fail in CI rather than in front of a manager.
- **Where I left off:** committed + pushed. **Gate coverage is boot-level** — it proves pages render, charts aren't blank, nothing overflows, keyboard paths work; it does NOT assert VALUES on screen, and it skips most MODALS (Alerts/Dept Config/Access/Health/Caller Lookup), whose init payloads `gen-phase3.js` already generates — that's the natural next layer. **Still outstanding from increment 53:** deploy both projects; re-run the Op-State-#38 histogram; decide UDC/UUC ATTRIBUTION; walk S41/S42. **Remaining batches:** **5** (QCD-vs-inbound discrepancy — still unexplained, still the blocker on releasing Inbound + Direct to managers, M ≈ ½–1d), **3** (F6/F9/F10 + "is this install armed?", M ≈ 1d), **4** (deploy.sh orphan-remote-file check, closes Op State #29, M ≈ ½d), **6** (flag flips from `QCD_READ_SOURCE`, S ≈ 2h each), **7** (F8 CLAUDE.md split, L ≈ 3d+).

## Prior session (/broad-implement Batch 1 — Round-13 doc truth + harness tooling)
Branch `claude/sync-commands-dnxgcv`, **488/488 tests**, INV-16 + cache-version-sync green. Docs + audit tooling ONLY — **no `apps-script/` file changed, so NOTHING to deploy for this batch**. Increment 54.
- **1.1 Killed a LIVE doc error.** CLAUDE.md's Neon-write-discipline P-1 paragraph claimed the zero-record corner "can't be cleared -- an empty payload carries no date to delete". Both halves were false: F2 clears it, and the stated REASON had been stale since P-1 gave every caller `expectedDateIso`. The wrong reason was the more dangerous half — it would have deterred the fix.
- **1.2 Documented increment 53** on the live-rule surfaces: inbound-capture bullet (a new "queue-name recognition is config-fed AND brand-prefix aware -- do NOT re-hardcode it" block with the measured UDC/UUC evidence and why the `Backup CSR` arm must stay EXACT); **Operator State #38 (NEW)** — the F1 diagnostic runbook, leading with the ANTI-pattern (do NOT probe `entry_queue IS NULL AND disposition='abandoned'`, it unions three causes) and giving the discriminating journey leg-name histogram + "read it against `DQE_EXCLUDED_AGENTS`, which already classifies every queue vs pseudo-agent name in this install"; Operator State #22 (F12 step order + no-skip, with the two don'ts); INV-54 (Dept Config now has a THIRD cross-project consumer — capture-time recognition, so listing a queue changes what the next import RECOGNIZES, not just how it attributes); INV-55 (overdue = calendar days both sides, the two-runtime mirror obligation, the accepted midnight residual); Key commands (the UI harness exists, is NOT in CI, and has caught render bugs the .gs harness structurally cannot). `docs/fix-history.md` gained the Round-13 section + a **RETRACTED/CORRECTED table** preserving the four wrong claims from the scan and why, and the taxonomy now warns that Round-13 `F#` is a **THIRD** `F`-shaped family.
- **1.3 Promoted S39 + S40** into Regression Scenarios. S39 (keyboard walk) names `drive-f13.js` as its automated counterpart and records why table rows carry `tabindex` but no `role="button"`; S40 specifies the 68–76h window where a 72-hour and a calendar-day test disagree, and warns the counts are viewer-scoped + status-independent.
- **1.4 Fixed the harness Chromium path properly.** The documented default `/opt/pw-browsers/chromium` is a DIRECTORY, not the binary — every driver failed until `CHROMIUM_PATH` was passed by hand (it cost a failed run last increment). Hardcoding today's path would re-stale because it carries the Playwright browser REVISION, so new `tools/ui-harness/chromium-path.js` globs the revision, prefers the full browser over `headless_shell`, and returns null so Playwright's own registry still works; all four drivers call `launchOptions()`. README corrected + `drive-f13.js` added to the run list + the first-run-chrome suppression (`cdr.tour.done`) documented, since without it a new driver's clicks time out on the tour overlay. **Verified with `CHROMIUM_PATH` UNSET: resolves and reports 13/13.**
- **Honest cost:** CLAUDE.md went 357 KB → 369 KB (+12 KB) and its size IS finding F8, so this batch made F8 worse in absolute terms and should RAISE its priority. The added content is live-rule/runbook material (narrative went to fix-history.md, +5 KB), and Operator State #38 is the most operationally valuable artifact of the cycle — but the tension is real, not explained away.
- **NET SCORE 0 − 0 = 0**, which is the correct score for a docs batch and deliberately not inflated; under /reflect's three-way tally these are 5 defensive/structural items.
- **Where I left off:** committed + pushed. **Still outstanding from increment 53 (NOT done):** deploy both projects; re-run the Op-State-#38 histogram to confirm no queue-shaped name remains in the `abandon_stage='ivr'` slice; decide UDC/UUC ATTRIBUTION (they will surface as unattributed in Dept Config's discovery panel — recognition ≠ attribution, and neither brand has a dashboard dept); walk S41/S42. **Remaining scan batches, in priority order: Batch 2** (F7 — wire the UI harness into CI + add the missing `qcdAll` fixture payload, M ≈ 1.5–2d), **Batch 5** (the QCD-vs-inbound discrepancy — still unexplained now that F1 is exonerated, and the stated blocker on releasing Inbound + Direct to managers, M ≈ ½–1d), **Batch 3** (F6 payload-size logging / F9 double column scan / F10 stale esc badge / the "is this install armed?" consolidation, M ≈ 1d), **Batch 4** (deploy.sh orphan-remote-file check, closes Operator State #29, M ≈ ½d), **Batch 6** (flag flips, S ≈ 2h each starting with `QCD_READ_SOURCE`), **Batch 7** (F8 CLAUDE.md split, L ≈ 3d+). Also NOT swept this batch: `docs/known-issues.md` / `architecture.md` / `conventions.md` may restate the three rules I corrected in CLAUDE.md — a `/sync-docs` pass should check.

## Prior session (/broad-scan Round 13 + /broad-implement F1, F2, F3, F12, F13)
Branch `claude/sync-commands-dnxgcv`, **486/486 tests** (+13), INV-16 + cache-version-sync green, script.html parses, and the UI harness's new `drive-f13.js` reports **13/13** keyboard checks in real Chromium. Deploy: **CDR Import AND Department Dashboard** (both touched). Increment 53.
- **F1 (High, capture bug — recurrence of IMP-1):** `icIsQueueName_` recognized queues by a HARDCODED `/^A_Q_/` + `backup csr` literal, so the next queue named outside it would repeat IMP-1's silent, permanent mis-capture (`entry_queue=NULL` -> attributable to NO dept -> invisible in every dept's Inbound report/heatmap). Worse, BOTH diagnostics are structurally blind to it: `scanInboundQueueNames_` (the Dept Config "Discovered inbound queues" panel) and the QCD-parity unattributed list filter `COALESCE(entry_queue,'') <> ''`, so an unrecognized queue has no row to discover. Recognition is now ALSO fed from the `Dept Config` sheet (QCD Queues col 2 + Inbound Queue Aliases col 10, incl. the RAW side of `raw=canonical` pairs) via `icLoadConfiguredQueueNames_`, loaded once per write run by BOTH writers before the builder. Strictly ADDITIVE (the regex still matches alone) and `buildInboundCallRecords_` stays PURE — `IC_KNOWN_QUEUE_NAMES_` is a module global, null = pre-F1 behavior. Digit-only tokens rejected (extensions, not queue names); inactive rows contribute nothing. Refactored the Dept Config read into one shared `icDeptConfigActiveRows_` memo serving both consumers + a single `icResetConfigMemos_()` reset (the two-memo split was a footgun: the existing R8-N test reset only one and would have read stale rows).
- **F2 (Medium):** both no-sheet-primary writers returned BEFORE the authoritative per-date DELETE when the record set was empty, so a date whose LEGITIMATE count is zero could never shed phantom rows from an earlier import (nothing else corrects `inbound_calls`/`outbound_calls`). New `icDeleteDateOnly_` runs the delete-only path, gated on `authoritative && expectedDateIso && rawRows.length` — the non-empty-source gate is the safety: an empty/unreadable grid keeps the old early-return, since that is the one case where deleting would destroy good data. Reports `unreachable` so a deferred-mirror date stays queued instead of being marked done with phantoms intact (both backfill loops widened to honor it). CLAUDE.md's stated rationale ("an empty payload carries no date to delete") was STALE since P-1 and needs a doc sweep.
- **F12 (Medium, data durability):** `neonMirrorDate_`'s `step()` RETHREW on a hard error, so a failure in an early step meant the later steps were never attempted — across all 8 retries — and then the gave-up path dropped the date. Inbound/Outbound were LAST, so a CDR-side poison pill permanently cost the two types that cannot be re-derived past the ~14-day Call_Legs retention, while the CDR/QCD/DQE step that caused it stayed re-derivable forever. Errors are now COLLECTED and thrown once after every step runs (caller's attempt-counting + retry cap unchanged), and the order is by RECOVERABILITY: Inbound, Outbound, CDR, QCD, DQE.
- **F3 (Low-Medium):** the escalation overdue threshold meant CALENDAR days on the client (`escDaysOpen_`) and 72 HOURS on the server (`occurred_at < now() - interval '3 days'`, in BOTH `getEscalations` and `getEscalationsBadge`), so the "Overdue >3d" band tile / nav badge could disagree with the ⚑ cards they were counting — and the server comment claimed they matched. One `ESC_OVERDUE_DAYS` + `ESC_OVERDUE_SQL_` (`CURRENT_DATE - occurred_at::date >= N`) now drives both queries; the client copy carries a sync note (two runtimes, the INV-06 mirror pattern). Residual, documented: CURRENT_DATE is the DB's date vs the browser's, so they can differ for a few hours around midnight — bounded, versus the old always-on 1-day skew.
- **F13 (Medium, a11y):** five click-only surfaces made keyboard-operable via shared `keyActivate_` / `makeActivatable_` + a shared `qcdToggleExpandRow_`: Overview dept tile (solo/compare — the LANDING page), My Department agent row (IR drill), `tr.qcd-expandable` on Insights Queue health AND the all-dept QCD report (the per-source breakdown has no other route), and the QCD carousel dots. Table rows get tabindex + a delegated keydown but NOT `role="button"` (that would override the implicit row role and break table semantics); div/span targets get the full role+tabindex treatment. Focus rings added in styles.html (a focusable element with no visible ring is still unusable). `aria-expanded` now tracked on the expandable rows.
- **Stage-2 corrections worth keeping:** F6 (Overview cache-size risk) was MEASURED and downgraded — the real cached blob is 27 KB at 14 depts (26% of the ~100 KB cap), ~1.9 KB/dept, so ~50+ depts to cross it; my Stage-1 estimate was ~2x off. A suspected PHI leak in the R11-N transfer enrichment was RETRACTED (the leg is pre-filtered by `icIsQueueName_`). A claim that the Overview sub-queue chip was mouse-only was WRONG — it is already a real `<button aria-expanded>`; the fix I had started would have DOUBLE-fired on Enter and was reverted.
- **New audit tooling (not wired to CI):** `tools/ui-harness/drive-f13.js` — keyboard-only walk of all five F13 surfaces, asserting focusability, activation, focus outline, no-scroll-on-Space, and aria-expanded round-trip. Run: `cd tools/ui-harness && node gen-payloads.js && node build-harness.js admin && CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node drive-f13.js`. NOTE the README's Chromium path is stale (`/opt/pw-browsers/chromium` -> `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`), and `gen-payloads.js` dumps NO qcdAll payload, so the all-dept QCD modal can't be exercised there (F13's row fix is verified on the Insights Queue-health table, which shares the exact same markup + helper).
- **Where I left off:** all five findings implemented, full CI + the browser walk green, committed? not yet — about to. NOT deployed. Follow-ons NOT done (out of scope): F7 (wire the UI harness into CI), F8 (CLAUDE.md 357KB split), F10 (esc badge is load-time-only and add-only), F6 (log the Overview payload size), the stale CLAUDE.md F2 rationale + the harness README's Chromium path, and the F1 exposure question, still OPEN. My first probe was WRONG: `entry_queue IS NULL AND disposition='abandoned'` came back 9353, but that count does NOT indicate F1 — it unions three causes and only one is F1 (stage='direct' = a DID call, no queue, legitimate; stage='ivr' with a genuine auto-attendant give-up, legitimate and already ~25% of calls per R5's note; stage='ivr' where the call DID enter an unrecognized queue = the F1 victim, which lands in 'ivr' precisely because a queue leg carries no Departments value). stage='queue' implies entry_queue non-NULL, so all 9353 are direct-or-ivr. The DISCRIMINATOR is the journey leg-name histogram over the stage='ivr' subset (the journey keeps RAW leg names even when entry_queue is NULL) — any real queue name there is an F1 victim; remedy is a Dept Config "Inbound queue aliases" entry, no code. Rows predating the journey extension have journey=NULL and can't be diagnosed this way. Awaiting the owner's histogram output.

## Prior session (R11 … + R11-L trend viz + R11-M Wave-1 feedback — testing passes, owner-approved)
Branch `claude/broad-scan-ak8g04`, **447/447 tests**, INV-16 + cache-version-sync green, script.html parses. Deploy: Department Dashboard ONLY. NOTE: Tiers A–C merged via PR #197; R11-L merged via PR #198; R11-M is NEW work on top, not yet PR'd.
- **R11-M Wave 2 SHIPPED (server work: Direct delta chips + Inbound email; owner-approved):** M7 = Direct report delta/trend chips — `getDirectCallReport` computes a prior window in the SAME json query (`kpisPrior` scope-level + `deptsPrior` per-dept, INV-28 window); `directCall:v1→v2` (docs + tables synced). Client: `inboundDelta_` chips on IB Answered/IB Answer Rate/OB Calls KPI cards + company-view dept header rows (answered/OB pos, missed neg, answer% pos-pctPoints) + a 92%-tone rail on dept cards. Test +1 (direct-call-report.test.js kpisPrior/deptsPrior). M8 = Inbound email — `sendInboundReportEmail` (InboundReport.gs, admin-gated via inboundResolveRequest_, styled HTML: KPI table w/ prior deltas + By-insurer/By-line top-10, 5%-tinted; caller-recipient; charts stay in web app) + "Email me this report" button beside the Inbound CSV. 448/448 (+1), cache-version-sync + INV-16 clean, script.html + DirectCallReport.gs + InboundReport.gs parse. Docs: Direct/Inbound bullets, INV-30 (directCall:v2), INV-31 (send_mail), fix-history R11-M7/M8, known-issues/conventions version tables. Valence decisions baked: OB up=good (more outbound activity). **Where I left off:** committed/pushed? about to. NOT deployed. Wave 2 DONE — the whole R11-M feedback batch (Waves 1+2) is complete.
- **R11-M Wave 1 SHIPPED (7-item owner feedback batch, client-only + 1 Config registry entry, NO cache bump):** M1 = per-agent Trend chart metric-aware gaps (BUG from R11-H1's spanGaps:true+tension0.4 on a gappy series — now count metrics 0-fill/drop-to-0, % breaks the line via spanGaps:false, monotone+tension0 for crisp no-overshoot). M2 = Simple view Agents shows the per-agent Trend chart, not cards (chartView forced true + mode forced 'trend' in Simple; #ins-cards-chart-wrap dropped from the ds-density-simple hide list; note/caption reworded). M3 = animate the solo/pin chart zoom (chartSpotlightApplyPins_ uses animated update(); release via chartSpotlightClear_(chart,true); hover-preview stays instant 'none'). M4 = red abandoned-volume line on the Inbound insurer Volume chart (data already in the daily drill; legend shown in Volume view). M5 = "Show report summary banners" Settings toggle (cdr.headlines → body.headlines-off → CSS hides .report-headline; hide-entirely per owner) + report-headlines UI_FLAG (admin-global). M6 = Missed drilldown open no longer flashes (deptMissedResizeDuringTransition_ rAF-resizes every frame for the ~420ms column transition, both open+close, no rebuild). 447/447, INV-16 + cache-version-sync clean, script.html + Config.gs parse. Docs: Insights + density + anti-intimidation + prefs bullets, Op State #34 (report-headlines UI flag), fix-history R11-M1..6. **Where I left off:** committed/pushed? about to. NOT deployed. **Wave 2 STILL OPEN (server work, owner-queued):** #4b Inbound report EMAIL export (new `sendInboundReportEmail` + styled HTML), #6 Direct report delta/trend chips on IB Answered/IB Answer Rate/OB Calls + per-dept header-row metrics (needs a NEW prior-window compute in getDirectCallReport + `directCall:v1→v2` cache bump).
- **R11-L SHIPPED (trend-viz + holiday axis; owner-approved, client + 1 server axis change, NO cache bump):** L1 = holiday-aware chart axes — `trendIsoLabels` + `ovWeekdayIsoLabels_` drop weekday `COMPANY_HOLIDAYS` via `isCompanyHoliday_` (like weekends), killing false weekday-holiday dips; unset property = pre-change = no cache bump (S5 precedent). L2 = `irTrendArrow_` replaces the auto-scaled sparkline on the Overview dept-GRID tiles (`ovBuildGridTile_`): angle = real least-squares slope of the 30-day %-answered series on a FIXED 70-100% band (grown for outliers, cap ±60°), red-amber-green gradient on slope (amber=flat, sat ±30°; `--bad` resolved via canvas since not in THEME), nulls skipped. Sub-queue chips already had a collapsed WoW arrow (untouched). L3 = honest-scaled sparklines on the surfaces that STAY (hero, company aggregate, expanded sub-queue): `irSparkline_(vals,color,{band:[70,100]})` uses the same grown fixed band + GAP-CONNECTS nulls (no more 0% crash on a no-data day); no `opts` = legacy auto-scale kept for count/duration KPI sparks (zero regression). New client helpers: `honestBand_`, `linRegSlope_`, `parseColorRgb_`, `arrowAnchorColors_`, `arrowGradientColor_`, `irTrendArrow_`. CSS: `.ir-trend-arrow` + `.ov-dept-tile-arrow`. 447/447, INV-16 + cache-version-sync clean, script.html + CompanyOverview.gs parse. Docs: Overview trend bullet + Op State #27 (CLAUDE.md), fix-history R11-L1/2/3. **Owner decisions baked in: fixed band 70-100% (a); no admin holiday UI — Script Property is fine (b); AND the owner's mid-turn add: honest-scale the remaining sparklines too.** **Operator: maintain `COMPANY_HOLIDAYS` for the axis smoothing (already the property that drives alerts/digests).** **Where I left off:** R11-L committed/pushed? NOT YET — about to commit + push, then (per the pattern) can PR. NOT deployed. Client helpers aren't unit-testable by the .gs harness (no client JS harness); the server axis change rides the already-tested `isCompanyHoliday_`.
- **R11-K / Tier C COMPLETE (multi-dept managers + alias emails; AUTH-critical, server+client+editor+tests):** K1 = a manager may hold MULTIPLE Access Control rows (same email, diff dept) → `resolveUser_` unions them into `departments` (removed the F13 first-only cap), `department`=first, `allDepts` stays false. Gates generalized to `dept ∈ user.departments` (`assertDeptAccess_`, `escAssertRowAccess_`, latent admin-only inbound/direct/getCallJourney pins) — byte-equivalent for single-dept (1-elem list). `getEscalations` scopes multi-dept to `department IN (...)` (all-their-depts default via `escDeptWhere_` + `metaDept`; the aggregate uses the same predicate); `getEscalationsInit.departments`=their list; `personalizeOverview_` keeps drivers for all their depts; `Code.gs` ships `departments` when >1. Client `canPickDept_()` (=isAllDeptViewer_ || manager w/ departments>1) gates ONLY the switch surfaces (selector pop / getRequestedDept / ovViewerDept_); Overview routing/spotlight stay isAllDeptViewer_ (server rejects non-assigned regardless). Role tag shows "manager · N depts". Editor: `saveAccessControlRow` REPLACE-ALL (accepts `departments[]`; ALL exclusive), `getAccessControlInit` returns grouped `managers`, `#ac-dept` is a multi-select, table groups by manager w/ dept chips; esc dept control gets "All my departments". K2 = `EMAIL_ALIASES` Script Property (`alias@=canonical@` pairs, tolerant, memoized-on-raw, ≤5-hop) → `resolveUser_` canonicalizes BEFORE lookup so an alias inherits canonical role+depts; returned email is canonical. Multiple-managers-per-dept already worked. Tests: access-control-editor.test.js (+11: multi-dept union/dedup, alias→mgr/admin, parse tolerance, departments[] replace-all/shrink/ALL-exclusive/reject, grouped managers) + escalations-hardening.test.js (+1 multi-dept row gate). 447/447, INV-16 green, all files parse. Docs: role-model gotcha + Op State #36 + INV-01 + fix-history R11-K1/K2. **NO cache-version bump** (access: cache key unchanged; value format string→JSON self-heals via Array.isArray/JSON.parse guard within the 60s TTL). **Operator: set `EMAIL_ALIASES` (optional) for alias routing; to assign a multi-dept manager, add >1 Access Control row (or use the multi-select editor). No new scope/migration.** **Where I left off:** Tier C committed/pushed, NOT deployed. Tiers A+B already shipped this branch. All owner testing-batch items now addressed (request-access UI dropped per owner).
- **R11-I + R11-J / Tier B COMPLETE (Insights top-area + floating admin remote, client-only, NO cache bump):** I1 = the Insights/Escalations TOP GAP root cause, finally nailed from the owner's element dimensions — the two pages are siblings AFTER `.container`, so when active the container collapses to just the app header and its `padding-bottom:48px` + header `margin-bottom:12px` (60px) become dead space above the sibling page. Fix at source: `body[data-page="insights"|"escalations"] .container { padding-bottom:0 }` (removed the E2/F1 page-side zeroing hacks). I2 = shortened the Insights sticky strip by moving the "Comparing against…" + "Showing: N agents" lines OUT of `.ir-results-header` into a non-sticky `.ins-subhead` block below the popover (same ids; `reportHeadline_` skips `.ins-subhead` so `#ins-headline` still anchors below it). **J = the small FLOATING admin A/B remote** (`#ins-ab-panel`, bottom-right above the Help FAB, collapsible): mirrors the 4 view controls (Agents Cards/Chart, Basis Gap/Abs/Trend, Trends Line/Calendar, Metric select) by FORWARDING clicks to the real segmented controls (no parallel state); `insSyncAbPanel_` reflects live state + calendar-eligibility back onto it from `insApplyCardsView_` + `insRenderTrendChart_`. Admin-gated (`data-admin-only`), inside `#insights-page` so it auto-hides elsewhere + in view-as, hidden ≤900px. 435/435, INV-16 green, script.html parses. **Tier B done.** Remaining: **Tier C** (multi-dept managers via Auth `resolveUser_` full `departments[]` + client dept selector for >1-dept managers + `assertDeptAccess_`/`escAssertRowAccess_` accept any assigned dept + Access Control multi-dept editor; alias-email canonicalization john.doe@=john@; confirm multiple-managers-per-dept already works — request-access UI DROPPED per owner) — awaiting go-ahead.
- **R11-H / Tier A SHIPPED (client + one Escalations aggregate; owner's 10-item testing batch, Tier A = 4 items, all client-visible, NO cache bump):** H1 = Insights per-agent Trend chart restyled to MATCH the app's canonical trend charts (borderWidth 2.2 / tension 0.4 / spanGaps / no fill / pointRadius 0 + paper-card point borders) AND made the DEFAULT Agents view (`insCardsView='chart'` + `insCardsChartMode='trend'`, was a role-split cards/gap default). H2 = Escalations "Needs review" summary tile REMOVED (dup of the category list) + Resolved·7d → **Resolved·MTD** (server SQL `date_trunc('month', now())` → `n_resolved_mtd`; `meta.resolvedLast7`→`resolvedMTD`; client label/read); the category list already dropped the standalone Needs-review row. H3 = Escalations Sort → compact ↑/↓ arrow icon (`.esc-icon-btn`) in `.esc-sb-head` beside Refresh at every viewport (`escSyncSortToggle_` glyph-only + title); `#esc-sort` select hidden at all sizes as the state store; dead `.esc-sort-toggle/-arrow/-lbl` CSS swept. H4 = heatmap cell-drill lists (BOTH lenses — inbound abandons `heatCellDetailHtml_` + DQE missed rings `missedSliceListHtml_`) GROUP rows by date with a colored per-date header (MM-DD + weekday + count) + left rail, tone cycling accent/good/warn/muted by first-seen date order (shared `heatDrillGroupedList_`/`heatDrillDateHeader_`; date moved off rows into the header). 435/435, INV-16 green, script.html + Escalations.gs parse. **Where I left off:** committed/pushed, NOT deployed. Tier B (Insights sticky-strip height: move "Comparing against…"/"Showing:…" out of the sticky header + the top-gap live Inspect; a small FLOATING admin view-toggle control for live A/B — NOT in Help) + Tier C (multi-dept managers + alias-email canonicalization; request-access UI DROPPED) both awaiting the owner. Live smoke for Tier A: Insights Agents opens on per-agent trend lines styled like the team trend; Escalations sidebar has no Needs-review tile, shows Resolved·MTD, sort is an arrow beside refresh; heatmap cell drill (Inbound report + Insights, admin) groups the drill rows by colored date clusters.
- Shipped: B1 QCD verdict tiles centered/smaller; B2 dept-banner tone = section pct only + mini left-beside-name; B3 QCD modal Export ▾ (blast separate); B4 email = no banner + single-date label (shared dateLabel builder in QCDReport.gs) + green/red share-of-total split bar (soft red <5%) + Arial styling; B5 collapsible Overview trend band (`cdr.ov.trendcollapsed`); B6 missed-bars width belt-and-braces (canvas 100% CSS + transitionend re-measure + <70%-of-wrap rebuild) + compact "8AM" ticks; B7 Bars/Radar admin-only (missedChartMode_ forces bars for managers); B8 chart-tips "?" popovers (CHART_HELP_/initChartHelp_, 4 toolbars); B9 Insights sticky strip = whole results header (period bar moved inside, ids unchanged); B10 modal top-padding → first-child margin so stuck theads hug the modal bar; B11 sortable Inbound/Direct tables (srtApply_, impact default (100−ans%)×calls; Direct impact on busy-excluded answerable).
- **PHASE C cycle 1 SHIPPED (C0 probe + C1 + C2):** C1 = qcd.rangePrior (E5 prior window, same scan; buildBlock_ reused) + csrTransfer.prior → Avg answer / Transfer % delta chips (valence 'bad' = increase warns, 3s/1pt floors), summary:v15 (docs swept; the cache-version-sync test polices even in-prose CLAUDE.md mentions — historical references must avoid the prefix-qualified `summary:vN` form). C2 = `armDwellPrefetch_(page)` armed from setPage + re-armed on each recordPageWindow_ render; dept→Insights fires agent-free getInsightsReport({dept, dept-window, agents:[]}) once per reportSig_ per session, writing reportLastGoodWrite_('ins', sig) so entry SWR-paints; insights→dept uses prefetchDeptSummary_. Known miss: saved agent/compare prefs change the entry sig (prefetch then only warms the server's agent-free key).
- **Diagnostic added (read-only, no pipeline change): `previewInternalTransferPaths(dateIso)`** in cdr-import/inboundCalls.js. The "abandoned A_Q_Spanish call" that the ↳ path drill can't resolve turned out (from the owner's Raw Data) to be an AGENT'S INTERNAL TRANSFER to the Spanish queue (Direction=Internal, caller=an extension, Parent Call ID=N/A) that went unanswered -- not an external caller abandoning; inbound_calls correctly excludes it, so the drill correctly reports "not captured", and the OWNER decided these abandons should STILL COUNT (so NO DQE change). The owner then asked to evaluate the fragile "cross-reference the abandon to the agent's concurrent inbound call" idea safely: this editor-run function replays that cross-ref against a Call_Legs_<iso> sheet and LOGS the would-be path + a unique/ambiguous/miss tally (writes nothing, deletable). Deploy: `cd apps-script/cdr-import && clasp push -f`, then run `previewInternalTransferPaths('2026-07-21')`. Awaiting the owner's read of its output before deciding whether the import-time capture fix is worth the risk. (Still pending: the R11-F1 Insights header-gap live Inspect + the optional client-only ↳ path miss-message reword.)
- **R11-G SHIPPED (items 4/5a/5b, chart hover+zoom behavior, all client):** G4 auto-zoom-fit on solo -- `chartSpotlightFitAxis_` fits the y-axis to the PINNED series on every pin change (called from `chartSpotlightApplyPins_`), restores the build-time axis stashed in `chartSpotlightStash_` (`_origYAxis`) on un-solo; generic across Overview / Insights trend / per-agent trend / QCD; handles scalar + `{x,y}`, caps pct at 100; the Overview `chartSpotlightAfterHide_` (Alt-hide) also defers to the pin-fit. Overview Full/Fit toggle KEPT (fits ALL lines; composes via stash/restore -- owner said removal optional). G5a tooltip filter-to-pinned + G5b global on/off both via ONE shared `chartTooltipPinFilter_` set as the Chart.js default `filter` (composed into the Overview-baseline + QCD-threshold per-chart filters): pins active -> only pinned in the card; `CHART_TOOLTIPS_OFF_` (Settings "Show chart hover cards", `cdr.charts.tooltips`) -> filter returns false for all -> card off live on next hover (no per-instance update; point still highlights). 435/435, INV-16 green, parses.
- **R11-F PARTIAL (5-item feedback batch; items 1-3 SHIPPED, 4-5 scoped-for-confirm):** F1 = Insights header gap — strengthened E2 (zeroed all top-spacing on the insights page); the ~80px gap is NOT reproducible from static markup/CSS (hidden form+loader, results header is first flow child) so it's best-effort pending a live Inspect of the gap element (asked owner). F2 = Queue Report EMAIL dept strip — health verdict as a colored LEFT EDGE (green/watch/red border-left) + distinct tinted bg (drops the HEALTHY/WATCH text) + abandoned COUNT in the mini-summary (web QV-2 shape); queue-report.test.js pins border-left + "N abandoned". F3 = Overview animations — trend-band collapse animates (max-height+opacity, not display:none; inner .ir-chart-wrap fixed height so canvas never zeroes) + My-Dept mini-table `.ov-tbl-fade` on range switch (both reduced-motion-aware). **DEFERRED for owner confirm: item 4 (auto-zoom-fit on solo — owner offered to clarify; needs per-chart y-axis fit-to-pinned, generalizing ovYAxis_) + item 5 (tooltip filter-to-pinned on solo, generalizable via a shared Chart.js tooltip `filter` reading `_spotlightPins`; + a tooltip on/off toggle needing a UI-placement decision, global vs per-chart).** 435/435, INV-16 green, parses.
- **R11-E SHIPPED (6-item feedback batch; mostly client, 1 server field + cache bump):** E1 = Caller Lookup call cards grouped into collapsible per-day `<details>` (`clGroupByDayHtml_`, newest open; flat for single-day). E2 = Insights sticky-header gap tightened (best-guess CSS -- the attached screenshot wasn't visible to me; flagged to owner). E4 = Insights per-agent **Trend line chart** (third Cards-chart basis: Gap/Absolute/**Trend**; `insRenderCardsChartTrend_`, one line per agent over the 12-mo axis, Overview chartSpotlight pin/hover + point-drill to IR; server adds per-agent `trendMonthly`). E5 = Insights sticky-strip date range made a prominent pill (My-Dept treatment, scoped so IR untouched). E6 = **Share donut true shares** (server `meta.answeredDeptTotal` = whole-dept answered over ALL active roster agents accumulated before the selection gate; client folds unselected into a muted "Other agents" slice -- fixes the subset-inflated shares). insights:v18→v19 (docs swept: INV-30, architecture/conventions/known-issues tables, page-plan, prose). E3 (A_Q_Spanish "↳ path") = **diagnosis only, NO code:** the drill correctly reports "not-captured" -- the Spanish abandoned call's root id (the parent id DQE emits) isn't a `call_id` in `inbound_calls`; root cause is pipeline-side in `buildInboundCallRecords_` (a leg group with no Incoming-direction/external-or-anon caller is skipped, or the Spanish language-IVR branch forks under a different root than DQE) -- needs a live Raw-Data leg inspection, flagged to owner. 435/435, INV-16 green, parses.
- **R11-C6 + R11-D SHIPPED (client-only, post-cycle-2 testing pass):** C6 = missed bar-click no longer flashes (detail-toggle transitionend calls `deptMissedResize_(false)` -- resize only, the R11-B6 tooNarrow rebuild guard was spuriously firing a full destroy+recreate mid-reflow; initial paint still passes true) + the R11-C4 "■ chart" scope button no longer clips a narrow card's right edge (`.agent-card-head` flex-wraps). D = Escalations sidebar redesign per a Claude design handoff (Option-a for the band overlap, A everywhere): D1 status → sidebar category list (`escRenderCatMenu_`, six real statuses, counts from `meta.statusCounts`/`pendingReviewCount` NOT the filtered in-memory rows -- the handoff's source was wrong, codebase won; "Open"/Rejected-fold rejected) + C1 band trimmed to health tiles (Overdue/Oldest/Resolved·7d); D2 refresh→↻ icon; D3 sort→↑/↓ toggle over `#esc-sort`; D4 dept name-text for single-dept managers / selector for admins (reuse `escInit_.isAdmin||allDepts`). Native `#esc-status`/`#esc-sort` selects kept as ≤900px fallback + state store. NB the handoff framed it as "the modal" + "turn the toolbar into a side menu" -- both stale: Escalations is a PAGE (#6) and the sidebar already existed (C2); reframed as restyling the existing sidebar. 435/435, INV-16 green, parses.
- **PHASE C cycle 2 SHIPPED (C3 + C4 + C5, all client-only):** C3 = ONE `#ins-trend-metric` dropdown replaces the trend sub-tabs + per-queue metric select + the calendar's cell-metric segment (queue metrics as `queues:<m>` values; the ATT option removed at init for non-admins — `<option>` can't use data-admin-only; `insSyncTrendMetricSel_` self-heals a non-offered saved value to Answered); NEW Missed + Call volume (rung) line metrics from `trendDaily`; calendar cell metric DERIVED from the dropdown (ans/pct/missed/vol/abd; segment → `.ins-cal-metric-lbl` label; `insCalMetric` pref vestigial; ATT + count queue metrics stay line-only per `insCalendarEligible_`); the reported calendar day-click no-op fixed with belt-and-braces DIRECT wiring on `.ins-cal-drill`/`[data-cal-nav]` after each innerHTML render. C4 = `.agent-scope-btn` (■/✕ chart) on each missed card summary rebuckets the 18-slot chart from that agent's own timeline entries (`missedTimeBucketIdx_`/`deptMissedScopedChart_`, zero fetch); `#dept-missed-scope-chip` in the toolbar names the scope with ✕ clear; clicks intercepted in the initClipboardOnce document delegate (preventDefault so the `<details>` never toggles); bucket drill stays dept-wide; scope resets each fetch. C5 = Direct company view renders per-dept `<details>` cards (`directCallDeptGroups_` groups the same rows by `r.dept`; aggregate summary stats — busy-excluded answer % w/ 92% tint, answered-weighted IB ATT; card order = B11 impact on the aggregate) expanding into per-dept sortable agent tables (shared `directAgentRowHtml_`/`directImpact_`; `direct-dept-tbody-*` srtWired_ entries dropped + re-armed per render since innerHTML kills the theads); flat table stays for single-dept; CSV already had the Dept column.
- **May 6–26 chart gap — REFRAMED (data layer exonerated):** owner's SQL shows dqe_history HAS the range; parity CLEAN scoped to exactly 2026-05-06..26; gap persists on the chart across days ⇒ the loss is inside the Overview chart pipeline's per-row filters (sentinel skip / roster name join INV-04 / rung accumulation). Shipped `probeOverviewChartDates()` (CompanyOverview.gs, editor-run, OV_PROBE_FROM/TO props default to the range) — owner runs it once; "roster-unmatched" with sample names ⇒ fix via Outlier Fix/aliases; rows-with-rung-0 ⇒ zeroed count columns in that era's rows. ALSO ask owner: does the My Department agent table populate for May 6–12? (Empty table = same roster-join cause.)
- Where I left off: committed/pushed; not deployed. Live smoke (adds to the Phase-B list): Insights Trends — the single Metric dropdown (admin sees ATT + queue entries, manager doesn't see ATT), Missed/Call-volume lines, Calendar for Answered/%/Missed/Volume + Queue Abd% with working day-clicks + month nav; missed section — ■ chart button scopes the chart to one agent + the chip clears it, drill panel stays dept-wide; Direct report as admin All-departments — dept cards expand into sortable agent tables, single-dept still flat, CSV unchanged. Phase-B smoke list: QCD verdict band + banner tones, Export ▾ menus, email preview (no banner, split bars, single-date subject, no Courier), Overview collapse chevron, missed bars filling + 8AM ticks + no toggle for managers, chart ? tips, Insights pinned header w/ period row, Inbound/Direct stuck headers + column sorting. **May 6–26: still awaiting the owner's `probeOverviewChartDates()` log output** (expected: roster-unmatched sample names → Outlier Fix renames/aliases; the owner's "My Dept shows SOME data but low volume for May 5–26" supports partial roster-join failure on a variant-names era).

## Prior session (R10 — second post-deploy testing pass, 8 owner notes)
Branch `claude/broad-scan-ak8g04`, **433/433 tests** (2 added: R10-5 in overview-qcd-snapshot), INV-16 green, script.html parses. Deploy: Department Dashboard ONLY. All client-only except R10-5 (summary:v13→v14).
- **R10-1:** quick-start chips → Help modal (`.help-quickstart`/`#help-launcher`; `initOverviewLauncher_` injects there only, chips close Help first); `#help-tour-btn` added; page-top launcher rows + `#ov-launcher` static block + `.ov-launcher--page` CSS removed; tour step folded into the Help step.
- **R10-2:** `.dept-side` sticky top = `calc(var(--dept-sticky-h) + 10px)`; `syncDeptStickyOffset_` (ResizeObserver on `#dept-page .controls`) publishes the var.
- **R10-3:** `initCountUp_` (debounced MO, `CU_SELECTORS_`, once-per-node so the observer refiring on its own text mutations can't re-target an intermediate value; skips durations/rich text; reduced-motion off) + `ds-bar-grow` scaleX keyframe on `.ans-track`/`.dts-track-fill`/`.qcd-hero-fill`/`.ins-cbar-fill`.
- **R10-4:** `.ans-bar--pass` (red seg opacity .35) / `.ans-bar--fail` (bold value) on `answeredBarHtml_` (92%) + `qcdDailyBarCell_` (5%).
- **R10-5:** `computeDeptQcdSnapshot_` range block gains answered-weighted `avgAnswerSec`/`avgAnswer` (displays grid + `parseHmsDisplay_`; Yesterday/MTD blocks null); new `computeCsrTransferRange_` (Data.gs; CSR-only, `CSR Transfer Historical Data` cols C/F/G via getDisplayValues + `rowDateIso_`, weighted transferred/total, null best-effort) → `csrTransfer` on the summary response (+ emptySummary_ mirror); team strip renders Avg answer (any dept with data) + Transfer % (CSR) tiles. summary:v14 — docs synced everywhere the cache-version-sync test pins (CLAUDE.md INV-30/INV-51, known-issues table, architecture, conventions, OrphanFix.gs comment, Data.gs F-29 comment).
- **R10-6:** `.dash-header` margin-bottom 24→12 (+ launcher removal) kills the blank strip.
- **R10-7:** missed bars: `.missed-chart-hwrap--bars` fixed 320px wrap + `maintainAspectRatio:false` (aspectRatio removed) + bars-mode section cap none; radar untouched.
- **R10-8:** QCD all-dept verdict: callout retired (return band only), tile values 32px, hero 42px + 12px labeled bar (`.qcd-hero-tick-lbl` "5%") + min-width fill, `.qcd-deptrow-mini` 13px ink + `.qcd-mini-pct` bold row-toned.
- **R10-9 (follow-up note, same round):** sticky table headers on the Inbound + Direct report tables — `#inbound-modal/#direct-call-modal .qcd-source-table th { position:sticky; top:0 }`, with the table's `overflow:hidden` → `clip` in those two modals only (hidden = a scroll container that traps sticky) + a box-shadow bottom line (collapsed borders don't travel with a stuck header).
- **Where I left off:** R10-1..9 committed/pushed. Live smoke adds: Help modal chips + tour button, side-card clearance, count-up/bar animations (and reduced-motion off), pass/fail bar tints, CSR strip tiles (needs CSR Transfer sheet data in range), blank-strip gone, missed bars filling, QCD verdict layout, Inbound/Direct sticky headers on long tables.

## Prior session (R9 — post-deploy owner testing notes, client-only)
Branch `claude/broad-scan-ak8g04`, **431/431 tests**, INV-16 green, script.html parses. Deploy: Department Dashboard ONLY. Owner notes → fixes:
- **R9-1:** retired the R7 B3 sticky BANNERS (`initStickyBar_`, `.page-sticky-bar`, both markup blocks) — the REAL controls are sticky now: `#dept-page .controls` + `#ins-period-bar` get `position:sticky; top:0; z-index:60` on an opaque `var(--paper)` strip (above `.dept-side`'s sticky card, below modal z 100). Scoped selectors — the Dept Config modal's `.controls` is unaffected.
- **R9-2:** dept toolbar = horizontal `.control-btn-row` with "↻ Refresh" (btn-secondary, Insights parity) + an "Export ▾" `.ir-export-wrap` menu (single item: Download CSV → `exportTableCsv_`). The WRAP keeps id `#csv-export-btn` so the two hidden-until-data gating sites are untouched. Help topic reworded.
- **R9-3:** retired the Batch-E date-sync offer chip (`maybeShowDateSyncChip_`/`applyDateSync_`/`dsyncFmtRange_`/`dateSyncDismissed_`, both `#*-date-sync` hosts, `.dsync-chip` CSS). Replacement: `adoptSharedWindow_(page)` in setPage — `pageActiveWindow_` entries now carry `at:Date.now()`; entering dept/insights adopts the OTHER page's window when it rendered more recently and differs (dept: feeds the existing setPage refresh branch via `adoptedWin_`; insights: `runInsReport()` unless `insAutoRunPending_`, whose queued auto-run reads the rewritten inputs). Hand-offs unaffected (Insights direction sets inputs AFTER setPage; dept direction carries the already-recorded window → input-match no-op). Tour step copy updated.
- **R9-4:** Escalations blank first paint — `escEnsureInit_` shows `dsRingsHtml_` in `#esc-loading` at fetch start.
- **R9-5:** view-as-manager on Escalations now pins the request dept to `viewAsDept_` + hides `#esc-dept-col`; `applyViewAs_` exit restores the column + reloads the page when active. (Real managers were always server-pinned in `getEscalations` — this was admin-preview parity only.)
- **R9-6 (charts outage ROOT CAUSE, from the owner's console error):** `this._fn is not a function` in Chart.js core.animation — R7 B1/O-2 REPLACED `Chart.defaults.animation` with `{duration,easing}`; `Animations.configure` copies only `Object.keys(defaults.animation)` per animated-property group, so `type` vanished → colors group lost `type:'color'` → first animated color killed the SHARED animator → every chart frozen. Fix: mutate `anim.duration/easing` in place; reduced-motion = duration 0 (never `false` — same key-list hazard). Reproduced + proven headless (scratchpad chartrepro, chart.js@4.4.4 + datalabels@2.2.0, custom platform since BasicPlatform force-disables animation; crash on color-changing update in 'replace' mode, clean in 'mutate').
- **R9-7 (Field Ops Power / Denials Overview gap ROOT CAUSE):** owner confirmed recent `Total Calls` rows for both queues (7/20: Denials 4/2/2, FieldOps_Power 21/21/0) — so the server snapshot was fine. The CLIENT dropped it: `ovBuildQcdCaption_` was appended from inside `ovBuildWowChip_`, whose `!dept.wow` early-return fires when `computeWowDelta_` returns null (zero DQE rung in either 7-day window) — queue-centric low-ring depts lost ALL QCD chips. Fix: hero + grid tile builders call `ovBuildQcdCaption_` independently. If chips STILL missing after deploy, next check: whether 'Denials'/'FieldOps' are real DO NOT EDIT! headers (tiles exist at all) — probe `google.script.run.withSuccessHandler(o=>console.table(o.depts.map(d=>({name:d.name,hasQcd:!!d.qcd})))).getCompanyOverview({})`.
- **Where I left off:** committed/pushed, NOT deployed (dashboard clasp push + New version). Live smoke adds: sticky strips on scroll (no side-panel overlap), Export menu, window follows across dept⇄Insights both directions, Escalations loader + view-as pinning. Backlog unchanged: Neon flip runbook (owner will run), Inbound/Direct un-gating, legacy decommission, QV sparkline extension.

## Prior session (/broad-implement QV — Daily Call Queue Report visual second pass + manual email)
Branch `claude/broad-scan-ak8g04`, **431/431 tests** (2 added: QV-4/QV-5 in queue-report), INV-16 green, script.html parses. Deploy: Department Dashboard ONLY. Owner-approved decisions: Item 1 hybrid C (tick on the split bar at answered%+5, not an abandon-scaled bar), Item 4 binary tones (no amber band), Item 3 sparklines OMITTED (quoted S–M ~½ day as a later server extension: trailing 7-day company series — free-ish on the sheet path, needs a widened neon window, `qcdAll:v4→v5`), Email = options A **and** B.
- **QV-1:** 5% tick on the all-dept bars — opt-in `qcdDailyBarCell_(r,{tick:true})` (Insights daily table untouched); hidden when answered>95% or zero volume.
- **QV-2:** dept banners — binary rail/tint (warn = section abandon%≥5 or any queue violation; sage; muted-empty), 16px name, mini-summary from `qcdAllDeptSectionTotal_` (now computed per section unconditionally; subtotal row still >1-queue-only).
- **QV-3:** company hero (0–10% bar, midpoint 5% tick, "N of M calls lost" — `grandTotals.abandoned` verified present). Verdict container is outside the print clone.
- **Print contract:** `qcdAllDeptPrint_` clones `#qcd-alldept-body` — all decorations carry `qcd-screen-only` and the print path now strips them from a detached clone (byte-identical print). CSV builds from data — untouched.
- **QV-4:** `sendQcdAllDeptEmail({from,to})` — signed-in gate (= getQcdAllDepartments), caller-only, displayed range (email builder verified range-safe: targetIso is only the dateLabel fallback). Button `qcd-alldept-email-btn` (all viewers).
- **QV-5:** `sendQcdAllDeptToSubscribers({date})` — assertAdmin_, single-day (button disabled on ranges via qcdAllDeptRender_), reuses sendQueueReportForDate_ O-1 isolation; claims `QUEUE_REPORT_LAST_SENT` ONLY when date === current gate target && count>0; never writes LAST_RESULT. Button `qcd-alldept-blast-btn` (data-admin-only) + dsConfirm_.
- **Where I left off:** committed/pushed (see git log). NOT deployed (dashboard clasp push + New version). Live smoke: S32 all-dept walk — ticks on bars/subtotals/company row, banner tones (esp. a violation dept), hero vs the old first tile, print WITHOUT ticks/mini-summaries, CSV unchanged, "Email me this report" on a range, blast disabled on ranges + confirm/claim flow on yesterday. Backlog otherwise: Batch F owner-gated (Neon flip next per owner; Inbound/Direct un-gating; legacy decommission) + optional QV sparkline extension.

## Prior session (/broad-implement R8 Batch E + R8-N normalization + drilldown-phases verification)
Branch `claude/broad-scan-ak8g04`, **429/429 tests** (6 added: 3 R8-N in inbound-calls, 1 in dept-config, 2 in config-editor-c3), INV-16 green, script.html + all edited standalone .js parse. Deploys: Department Dashboard + cdr-import (inboundCalls.js, NeonMirror.js) + cdr-report (sheetRepairs.js, inboundCallsExport.js, emailDailyReport.js).
- **Batch E (ops tail + docs):** E1 NeonBackup trashes stale higher-numbered partN on a shrinking parts-month; E2 slot-repair PREVIEW restores formats per-group (abnormal exit can't persist the numeric lens); E3 `exportInboundCalls` per-date replace (fallback rows for Neon-lost dates survive; `ic_removeRowsInRange_` gained optional `onlyDates`); E4 `runBatch` per-day date-cell restore (ceiling kills skip finally) + malformed Neon Mirror Queue rows dropped with a log; E5 Op State #8 reworded (safety-net trigger uninstall = CORRECTNESS); E6 doc sweep (architecture migration-complete label + root-clasp layout + file list, conventions IR-last-floater, .claspignore comment, INV-16 guard doc both sanitizers, Op State #14 raw-name pointer, known-issues R8-1 cross-ref — the cache-version-sync test caught and forced a bare-version rewording in conventions).
- **R8-N (capture-time queue normalization — the two-name-space root fix, option 1):** Dept Config "Inbound queue aliases" accepts **`raw=canonical` pairs** (plain raw names unchanged = attribution-only). cdr-import `icQueueCanonicalMap_` (memoized, best-effort, reads the target ss's Dept Config cross-project — the INV-46 pattern; strict-truthy Active) + `icNormalizeQueue_`; `writeInboundCallsToNeon` translates ONLY entryQueue/finalQueue on every capture path (daily/deferred/backfill); journey JSON + num_queues stay raw. Dashboard: `getInboundQueueAliases_` returns the RAW side of pairs (union unchanged = belt-and-suspenders for old rows + DQE sentinels); `saveDeptConfig` validates pairs (canonical side ∈ dept's QCD queues — row's own field or `queuesForDept_` fallback; malformed pairs rejected; digit check on raw sides). **SCHEMA DECISION MADE THIS SESSION** (the previously-parked owner question): the `raw=canonical` syntax, chosen as backward-compatible + explicit for multi-queue depts — flag to owner in summary. **OPERATOR: set pairs (CSR: `A_Q_CSR=A_Q_CustomerSuccess`), re-run `backfillInboundCalls` within Call_Legs retention; older rows via the union or one-off SQL (runbook in known-issues).**
- **Insights drilldown Phases 2–4: VERIFIED ALREADY SHIPPED, no code needed.** The scope item came from a STALE CLAUDE.md claim ("endpoint is dormant") — spec + code confirm `insQhMissedDrill_` (P3), `heatCellToggleDrill_` dual lens (P4), bucket journey chips (P2). CLAUDE.md bullet corrected (R8-E6).
- **Where I left off:** committed/pushed (see git log). NOT deployed. Remaining from the scan: Batch F owner-gated only — Inbound/Direct un-gating (vetting run; the R8-N pairs + R8-1 alias population are the same operator step), Neon flip EXECUTION (unblocked since Batch C), legacy dqe-report decommission. The R8 scan is otherwise FULLY DRAINED (A+B+C+D+E+N + findings 1–5).

## Prior session (/broad-implement R8 Batches C+D → R8-C1..C4, R8-D1..D4)
Branch `claude/broad-scan-ak8g04`, **423/423 tests** (13 added: 4 dal-cutover C1/C2, 1 insights-report C3, 2 dept-config C4, 4 in NEW cross-file-pins.test.js D1/D2, 2 individual-report D3), INV-16 green, script.html + DQEdrilldown parse. Deploys: Department Dashboard + cdr-report (DQEdrilldown.js). **The Neon-flip runbook's outage corners are now swept — the README flip runbook (Op State #19/#30) is safe to execute.**
- **C1:** IR/Insights/Missed outage-empty shapes (Neon unreachable + no sheet, the F-35 corner) carry `meta.sourceUnavailable` and every cache-put site skips them (getMissedCallsReport + missedReportDataCached_ + IR + Insights); reachable-empty (LM2) stays cacheable. Latent until a sheet is trimmed.
- **C2:** `getLatestDataDate` caches the `__none__` NEGATIVE only when no primary source failed (`cacheNegative_` guard; the F6 discipline) — a neon blip + trimmed sheet no longer pins "no data" under the :neon key.
- **C3:** `insightsQueueHealth_`'s QCD-sheet pre-check gates on `getQcdReadSource_()` — neon-path installs keep Queue health when the QCD sheet is trimmed (F8 benign-hide preserved on the sheet path).
- **C4:** `sheetReadDeptConfigRows_` distinguishes ERRORED (flag `DEPT_CONFIG_READ_FAILED_` via `deptConfigReadFailed_()`) from ABSENT (documented constants fallback, unflagged); the four QCD-embedding cache puts (summary Data.gs / companyOverview / insights / qcdAll — the 6h-TTL one) skip pinning a constant-only view after a transient read error.
- **D1/D2:** NEW `tests/unit/cross-file-pins.test.js` (the cache-version-sync extract-canonical pattern): NeonMirror DQE/QCD read widths + merge-repair width vs Config.gs schema constants; UI_FLAG_SURFACES registry↔CSS↔markup parity (missing rule / stale target fails CI; a rule targeting a wrong-but-existing element still needs eyes — documented limit).
- **D3:** IR prevPeriod resolves SERVER-side — client sends `priorMode:'prevPeriod'` (both call sites: runIrReport + the edit popover; keepCustom unaffected), `getIndividualReport` resolves via `computePriorWindow_`; explicit dates win; YoY/custom unchanged. INV-49 updated. Client resolver survives for the form hint only.
- **D4:** DQEdrilldown `canonicalize_` mirrors the build's INV-24 strip+FLATTEN union (was strip-only — false "no matching rows" on flatten-matched agents).
- **Where I left off:** committed/pushed (see git log). NOT deployed. Remaining from the scan ranking: Batch E (ops tail + doc sweep: NeonBackup stale parts, slot-repair preview formats, exportInboundCalls per-date delete, runBatch restore, immortal queue rows, Op State #8 rewording, doc drift G1-G7 + the two carried /sync-docs items), Batch F (owner-gated: Inbound/Direct un-gating, capture-time queue normalization, Neon flip EXECUTION — now unblocked by Batch C, drilldown phases, legacy decommission).

## Prior session (/broad-implement R8 Batches A+B → R8-A1..A7, R8-B1..B6)
Branch `claude/broad-scan-ak8g04`, **410/410 tests** (5 added: 3 R8-B6 in sheet-repairs-merge, 1 R8-A5 in config-editor-c3, 1 R8-A6 in pipeline-watch; +1 R8-B4 assertion in an existing c3 test), INV-16 green, script.html + all edited files parse. Deploys: Department Dashboard + cdr-import (autoImport.js) + cdr-report (dashboardCDR.js, neonbackfill.js, sheetRepairs.js).
- **Batch A (live-surface quick wins):** A1 UI_FLAGS `dept-team-strip` CSS now hides the strip (not just the caption) + `insQhNoRingGate_` honors the `ins-queue-health` flag; A2 Direct mirror skip/error logs a `processIntegratedHistory:Direct:neon` FAILURE row (L7 pattern; NEON_HOST-unset installs stay silent — Direct has a sheet primary, unlike F9's inbound); A3 Caller Lookup `clLookupSeq_` stale-token + Enter respects the disabled button; A4 CRB render clear widened 40→`max(45, headers+1)` cols; A5 `computeThresholdDrift_` skips `duplicateRow` (OPS-9 first-row-wins); A6 `pipelineWatchRecord_` refuses watermark 0 (backlog-blast guard); A7 `insScrollPending_` disarmed on both Insights failure paths + Insights CSV Prior columns formatted (`priorCell`: durations short-formatted, pct as %).
- **Batch B (data/tool correctness):** B1 `backfillQCDHistory` stores `abandoned_pct` as a FRACTION (T-4's unit analysis was inverted; known-issues entry corrected — T-4-era percent rows do NOT heal on re-run: DO NOTHING insert; heal = force re-import or `UPDATE ... SET abandoned_pct=abandoned_pct/100 WHERE abandoned_pct>1`); B2 `assertNotOnAnyRoster_` guard on the alias/rename SOURCE name in `addAgentAlias` + `applyOrphanRename` (a live-roster source would silently reroute that agent's future builds; de-roster first for merges — INV-01 text updated); B3 `saveBulkReport_` caps the bulk report property at 80 tail lines + try/catch (the F2 lastSheets discipline; 9KB ceiling hit ~date 100); B4 `saveDigestConfigRow` lowercases email (Neon exact-case PK vs sheet case-insensitive upsert); B5 `missedEnrichQueueOnlyFromInbound_` binds its (date,id) tuples as `(?::date,?)` params (last inline-SQL deviation closed); B6 `mergeDqeDuplicateRows_` interrupted-apply recovery — `scMergeAlreadyApplied_` multiset-containment detector: a re-run after a crash deletes leftover duplicates WITHOUT re-summing (the old re-run compounded), and byte-identical double-append rows now dedupe instead of doubling; counts-only groups stay unverifiable (logged caution). Docblock idempotence claim rewritten honestly.
- **Where I left off:** committed/pushed (see git log). NOT deployed. Post-deploy live smoke: UI-flag `dept-team-strip` round-trip from Health; a Caller Lookup double-Enter; Alerts modal drift chip on a dept with hand-edited dup rows; a preview+apply of `repairDqeDuplicateMerge` on a copy. Remaining from the scan ranking: Batches C (sheet-retirement/Neon-outage sweep — prerequisite to the Neon flip), D (guard/tooling + IR server-side prior resolution), E (ops tail + doc sweep), F (strategic/owner-gated: Inbound/Direct un-gating F1, capture-time queue normalization F2, Neon flip F3, drilldown phases F4, legacy decommission F5).

## Prior session (/broad-scan Round 8 + /broad-implement findings 1–5 → R8-1..R8-5)
Branch `claude/broad-scan-ak8g04`, **405/405 tests** (7 added: 2 R8-1 in missed-report, 2 R8-2 in neon-mirror-tail, 1 R8-3 in orphan-roster-add, 1 R8-3 in dept-config, 1 R8-4 in escalations-hardening), INV-16 green, script.html parses. Deploys: Department Dashboard + cdr-import (NeonMirror.js only).
- **Fresh 3-stage /broad-scan ran first** (7 parallel subsystem agents, every High/Medium finding re-verified at source). Full ranked findings 1–24 + Stage 3 strategic review in the session transcript. Owner selected findings 1–5 for implementation; the Low tail (findings 6–24, incl. T-4 unit inversion, Direct `:neon` failure row, bulkReport 9KB cap, Caller Lookup seq token, drift duplicateRow, NeonBackup stale parts, negative-cache corners B2/A3/B3) is NOT yet implemented.
- **R8-1 (was audit finding 1, HIGH/live):** Missed report queue-only sentinel match now uses the inbound name-space union (`inboundQueuesForDept_`, fallback `queuesForDept_`) — R6 matched QCD-canonical names while DQE sentinels carry RAW names, silently dropping CSR's `A_Q_CSR` abandons. missed:v16→v17 (code + 4 docs; cache-version-sync green). **OPERATOR: populate Dept Config → CSR → "Inbound queue aliases" with `A_Q_CSR` (and any other raw-only queue names) or CSR's queue-only card stays empty of main-queue abandons.**
- **R8-2 (finding 2, latent):** NeonMirror `mirrorDqeForDate_` 36→34 cols (REP-10 propagated); `mirrorQcdForDate_` parses display strings via new `nmInt_`/`nmPctFraction_` (fraction units = the inline writer's, per Config.gs ABANDONED_PCT). Deferred mode is still OFF; it is now safe to validate per Op State #22.
- **R8-3 (finding 3, security):** `deactivateAgentAlias_` + `sheetDeactivateDeptConfig_` write ONLY the Active cell — the whole-block getValues→setValues round-trip re-armed CORE-7-neutralized formula cells as live formulas.
- **R8-4 (finding 4):** `escAssertRowAccess_` passes `allDepts` managers (the R-3 class; the role was fully locked out of escalation actions + saw blank activity trails).
- **R8-5 (finding 5):** client `resolveComparisonWindow_` prevPeriod `Math.floor`→`Math.round` (DST-spanning ranges resolved a one-day-short prior window in IR; server `computePriorWindow_` was already immune).
- NB: audit markers deliberately named `R8-#`, NOT bare `F#` (that family = Neon read-back codes; collision warning in fix-history, where the R8 table now lives).
- **Where I left off:** committed/pushed (see git log). NOT deployed. Post-deploy live smoke: S4 (CSR missed queue-only card after the alias is populated), S31 (alias remove — formula-shaped old names stay inert), S36 (Dept Config deactivate), IR "Immediately-preceding period" over a Mar-spanning range (prior window length), escalations as an ALL-sentinel manager (approve/resolve + activity timelines render). R8-2 validation = Op State #22's one-import deferred-mode check, if/when the operator enables it. Remaining: the audit's Low tail above + the parked strategic items (Inbound/Direct un-gating vetting run, Neon flip runbook, legacy decommission, capture-time queue normalization).

## Prior session (/broad-implement Round-7 Batch C — server/ops C1–C4)
Branch `claude/broad-scan-mowwqb`, **398/398 tests** (10 added: 6 in NEW neon-coverage.test.js, 2 aux in pipeline-watch, 2 uiflags in system-health), INV-16 green, script.html + all edited .gs files parse. Deploy: Department Dashboard only (all four items are dashboard-project).
- **C1 (M-2)**: `getCallJourney` classifies a miss — on a found:false where the UNSCOPED lookup ran (admins / entitled managers only; a gate-closed manager learns nothing), one cheap probe (`MIN(call_date)` + per-date EXISTS) sets `reason`: `'before-capture'` (+`minDate`) / `'date-gap'` / `'not-captured'`. Client renders an actionable note per reason (date-gap points admins at the coverage check). Owner's Eligibility MM&R case will now self-identify.
- **C2 (G-2)**: NEW **NeonCoverage.gs** — `runNeonCoverageCheck()` (assertAdmin_, editor-run, READ-ONLY): per-date sheet-vs-Neon row-count reconciliation over `NEON_COVERAGE_DAYS` (=30, ending yesterday) for dqe_history/qcd_history/call_history_dept/direct_call_history (findings: missing-in-neon / count-mismatch / extra-in-neon, each with its runbook fix line), plus `inbound_calls` zero-row-WEEKDAY gaps (holiday-aware via isCompanyHoliday_, floored at MIN(call_date) capture start). One json_agg round-trip per table (the 0403b2c discipline); sheet dates via getDisplayValues + `ncCellDateIso_` (F-3/F-10 rule). Emails admins; `NEON_COVERAGE_LAST(_RESULT)` OPS-8-coded ('ok clean' / 'GAPS n finding(s)' / 'FAILED*'); Health page row `out-coverage` (classifier gained `^GAPS\b`). Pure pieces pinned by tests/unit/neon-coverage.test.js.
- **C3 (G-1)**: PipelineWatch's hourly run folds two property-backed signals in — a NeonBackup run whose LAST_RESULT isn't ok-prefixed (once per run timestamp, marker `PIPELINE_WATCH_BACKUP_MARK`, re-arms on ok) and a Neon read-back streak `NEON_READ_LAST_ERROR` count >= `PIPELINE_WATCH_READBACK_MIN_STREAK`(=3) (once per streak, marker `PIPELINE_WATCH_READBACK_MARK`, re-arms when the property clears). Pure `pipelineWatchAuxDecide_` (unit-pinned); markers advance ONLY on a confirmed send (OPS-1); aux alerts fold into the failure digest or send standalone via `pipelineWatchAuxDispatch_` on every early-return path; `notifyPipelineFailures_(failures, auxLines)` signature widened (both args optional).
- **C4 (G-3)**: `UI_FLAGS` admin surface toggles — Config.gs `UI_FLAG_SURFACES` registry (7 keys: dept-team-strip, dept-queue-tiles, dept-missed-section, dept-qcd-side, ov-user-table, ins-heatmap, ins-queue-health); renderDashboard_ injects sanitized `window.__UI_FLAGS__`; client stamps `body[data-ui-flags]`; enumerated `body[data-ui-flags~="key"] … { display:none !important }` CSS rules beat the render paths' inline display; fetch gates on deptMissedFetch_/FrostArm + ins-heatmap loadAbandonHeatmap_ + ovRenderUserTable_ so hidden surfaces don't still fetch; the two strip tiles gained `.dts-tile--queue`. Server RPCs in SystemHealth.gs: `getUiFlags` / `saveUiFlags` (INV-01 config path: assertAdmin_ + registry validation via pure `uiFlagsSanitize_` + LockService.waitLock + Logger audit; empty set DELETES the property). Health page "UI surface toggles" editor (checkbox per registry key, checked = hidden; loads with healthLoad_). Changes apply on the next page load — no redeploy. Harness shim gained lock.waitLock.
- **Where I left off:** committed/pushed (see git log). ROUND 7 IS FULLY DRAINED (Batches A+B+C). Post-deploy: run `runNeonCoverageCheck()` once from the editor (validates + seeds the Health row); if PipelineWatch isn't installed yet, `installPipelineWatchTrigger()` to get the G-1 signals; try a UI toggle round-trip from Health. NEXT: consolidated /sync-docs pass for Round 7 (calendar v2, sticky bars, UI_FLAGS Op State entry, coverage-check bullet, INV-01 saveUiFlags carve-out note, Subsystems + NeonCoverage.gs, fix-history R7 table). Owner asked-for follow-ups pending their input: an example failing path-drill call (confirms C1's bucket), watermark content beyond the missed clock (none requested), Inbound/Direct un-gating (parity evidence first).

## Prior session (/broad-implement Round-7 Batch B — visual/UX layer B1–B4)
Branch `claude/broad-scan-mowwqb`, **388/388 tests**, INV-16 green, script.html parses. Client-only (script.html / dashboard.html / styles.html). Deploy: Department Dashboard only.
- **B1 (O-2)**: global chart animations — `setChartAnimationDefaults_` IIFE sets `Chart.defaults.animation = {duration:400, easing:'easeOutQuart'}` (or `false` under prefers-reduced-motion); ALL 9 per-chart `animation: false` opt-outs removed. Spotlight/pin stays instant (`update('none')` sites untouched); the two plain `update()` sites (Alt-hide, axis rescale) now animate deliberately.
- **B2 (M-3)**: missed-calls bar chart flipped VERTICAL (time buckets on x, workday reads left→right; `aspectRatio: 2`, every-other x label via ticks callback, counts above bars, tooltip reads `parsed.y`); `maxBarThickness` 16→26. NEW `missedClockWatermark_` inline plugin (owner ask): faint vector clock face (circle + 12 ticks + 10:10 hands, `rgbaWithAlpha_(THEME.muted, 0.14)`) drawn `beforeDraw` behind the bars, skipped under r<24px; radar untouched. styles comment updated (bars-mode width cap rationale).
- **B3 (M-5/I-2)**: sticky context toplines — `.page-sticky-bar` (position:FIXED top-center, hidden until revealed; backdrop blur; z 90 < modal 100) + shared `initStickyBar_(barId, sentinelSel, pageName)` (IntersectionObserver; reveals when the sentinel scrolls above the viewport top AND the page is active; hidden pages' zeroed rects fail the top<0 test). Dept: `#dept-sticky-bar` (sentinel `#dept-page .controls`, text set in refresh(), ↻ = refresh). Insights: `#ins-sticky-bar` (sentinel `#ins-period-bar`, text set in insSyncPeriodBar_, ↻ = runInsReport).
- **B4 (I-4)**: `.seg-rich` sub-selector reads secondary — smaller (10px/8.5px, 3px padding), muted titles, active = accent-soft fill instead of full ink inversion; `.ins-view-fade` one-shot fade applied by `insApplyCardsView_` to whichever view becomes visible (Cards⇄Chart, Gap⇄Absolute; reduced-motion no-op).
- **Watermark content (owner)**: a clock icon — done as vectors (no emoji font dependency).
- **Where I left off:** committed/pushed (see git log). Live smoke: charts animate on create (and NOT for reduced-motion users); missed bars vertical + clock watermark visible + ramp working (A1); sticky bars appear on scroll on both pages and never on other pages; sub-selector reads lighter; Cards⇄Chart fades. **Round-7 remaining: Batch C** (see the Batch A section below for the approved specs: M-2 journey reason enrichment, G-2 runNeonCoverageCheck, G-1 PipelineWatch gap-fills, G-3 UI_FLAGS registry).

## Prior session (/broad-implement Round-7 Batch A — client fixes A1–A8)
Branch `claude/broad-scan-mowwqb`, **388/388 tests** (no server changes — all client: script.html / dashboard.html / styles.html), INV-16 green, script.html parses. Deploy: Department Dashboard only.
- **A1 (O-1 ROOT CAUSE)**: `rgbaWithAlpha_` now delegates to the canvas-based `colorWithAlpha_` when its rgb() regex misses — `colorToCanvasRgb_` returns HEX for opaque colors (canvas fillStyle normalization), so every `rgbaWithAlpha_(THEME.*)` callsite was silently returning the input UNCHANGED: the chart tooltip stayed opaque despite the alpha-0.6 setting AND the missed-bar volume ramp was flat (all bars solid warn). One fix repairs tooltip translucency + the ramp + any other translucent THEME fill. Side-card tooltip panel = parked fallback if the owner still wants it after seeing this live.
- **A2 (O-3)**: the 'selected'/'My Dept' tile badge + mini-table title are view-as-aware (`isAllDeptViewer_() && !viewAsDept_`); manager wording is now 'My dept:'; `applyViewAs_` pre-paints hero/table/tiles from `ovLastData` instantly before the live re-fetch (the badge used to sit stale for seconds in view-as).
- **A3 (M-1)**: new `deptMissedFrostArm_()` frosts the missed section from `refresh()` START (all roles) — the frost previously armed only when the missed fetch began (after the summary returned), leaving a stale unfrosted window; `onError` unfrosts (no missed fetch coming).
- **A4 (M-4)**: Queue-calls tile per-day sub renders only when workdays > 1.
- **A5 (I-1)**: calendar v2 — (a) ‹ › MONTH PAGINATION (`insCalMonth_`, one month per view, defaults most-recent, resets on window change; the old all-weeks render CLIPPED past month 1 inside the 420px `.ir-chart-wrap` — calendar mode now also releases the height via `.ir-chart-wrap--cal`); (b) 'Abd %' cell metric (`insCalMetric='abd'`, backed by `queueHealth.dailySeries` ISO rows, 5%-threshold color ramp, queues-tab entry auto-defaults to it, self-heals to 'pct' when no series); (c) the Line⇄Calendar toggle stays VISIBLE but disabled (`.segmented.is-disabled` + reason title via `insCalendarIneligibleReason_`) on ineligible tabs/windows — it used to vanish (the owner's "not seeing calendar" was a saved Abd%/ATT tab pref + this hiding). Eligibility now includes the queues tab; ATT stays line-only. Prefs accept 'abd'.
- **A6 (I-3)**: re-runs over a rendered report frost the WHOLE `#insights-results` (SWR pre-paint stays readable under it; live/fail clears; SWR status note suppressed under frost — the dept-table M3 precedent). Intro card is show-once-automatically (first render marks `cdr.ins.intro.v1`).
- **A7 (N-1)**: `#ins-refresh-btn` (results header, next to My Department →) re-runs `runInsReport()` in place. NOTE: server report cache still applies (30-min TTL).
- **A8 (N-2)**: `insAgentHasActivity_` filter — zero-activity agents (rung+missed+answered all 0) are dropped from BOTH cross-agent charts (gap + absolute); cards untouched.
- **Where I left off:** committed/pushed (see git log). Live smoke: tooltip translucent + bar ramp visible; view-as badge flips to 'My Dept' instantly; missed frost visible as manager; 1-day range hides /day sub; calendar month arrows + Abd% metric + disabled toggle tooltip on ATT tab; date-change frosts whole Insights report; intro card gone on 2nd entry; Refresh button; ex-employees absent from Agents charts. **Round-7 remaining: Batch B** (O-2 global chart animations reduced-motion-aware; I-4 seg-rich sub-selector smaller/lighter + view-switch transitions; M-5/I-2 sticky toplines dept+Insights; M-3 vertical missed bars RECOMMENDED swap — time on x reads as a workday timeline; watermark parked pending owner content) + **Batch C** (M-2 getCallJourney found:false `reason` enrichment (before-capture / date-gap / not-captured) + ask owner for a concrete example; G-2 `runNeonCoverageCheck` per-table per-date sheet-vs-Neon gap/mismatch + Health section + runbook pointers, inbound = zero-row-weekday check; G-1 approved gap-fills: NeonBackup failure + Neon read-back streak fold into the hourly PipelineWatch email; G-3 approved `UI_FLAGS` Script Property + registry: dept team strip, Queue-calls/Abd tiles, missed section, QCD side card, Overview mini-table, Insights heatmap, Insights queue health; admin editor on Health page).

## Prior session (R6 queue-only fix + /broad-implement density Phase 2)
Branch `claude/broad-scan-mowwqb`, **388/388 tests** (2 added: R6 pins in missed-report), INV-16 green, script.html parses. Deploy: Department Dashboard only.
- **R6 (owner report; missed:v16, committed separately):** queue-only abandoned SENTINEL rows now attribute by QUEUE NAME against the dept's effective list (`queuesForDept_`, case-insensitive) instead of shared-EXTENSION overlap — other depts' queues no longer leak onto the card; unmapped/no-abandon dept renders no card; noRing/abandoned counts follow. Fixture stubs (`h.ctx.queuesForDept_`) added to missed-report/missed-slice/dal-cutover suites. If a queue that used to appear goes missing live → map it in Dept Config (Op State #14).
- **Phase 2 #8:** `#ins-views-btn` Views menu — personal named saved views (`cdr.ins.views.v1:<email>`, max 12; snapshot = SHARE_STATE_ state incl. `view=simple|detailed` via a provider WRAPPER; no dept) + Copy share link (reuses `encodeShareParams_` + the `#/report/insights?…` deep-link path — normal auth/fetch on open). `insApplyViewState_` re-checks a rendered picker directly; missing agents param = uncheck all (agent-free).
- **Phase 2 #10:** Line ⇄ Calendar trend renderer (`#ins-trend-render-toggle`, `insTrendRender`/`insCalMetric` prefs): Mon–Fri day-grid over the SAME `trendDaily` series (no server change), 92%-target / missed-intensity coloring via color-mix, in-cell numbers, per-day drill via new shared `insDrillToRange_` (extracted from insTrendPointDrill_), gated to 14–366-day windows + team tabs (`insCalendarEligible_`); calendar branch early-returns in insRenderTrendChart_ (hides canvas/view-toggle/datalabels box).
- **Phase 2 #9:** `sendInsightsReportEmail({style:'summary'})` + Export → "Email summary": `renderInsightsEmailSummary_` (Digest.gs) = takeaway + rollup tiles + behind-team-average list (min `INSIGHTS_EMAIL_MIN_CALLS_`=10; plain definition, not the client tier replica). Same auth/compute/recipient.
- **Where I left off:** committed/pushed (see git log). Live smoke: R6 (Power page shows only A_Q_PowerChairs card or none), Views save/apply/delete + share-link round-trip (incl. density restore), Calendar toggle on a 30-day window (color/drill/metric seg; hidden on <14d + Abd%/ATT tabs), Email summary arrives short-form. Remaining parked: legacy dqe-report decommission, capture-time queue normalization (owner schema), CONFIG_SOURCE flip (optional).

## Prior session (/broad-implement density-design Phase 1 — Insights Simple/Detailed)
Branch `claude/broad-scan-mowwqb`, **386/386 tests**, INV-16 green, script.html parses. ALL CLIENT-ONLY (dashboard.html/script.html/styles.html + CLAUDE.md bullet); no compute/cache/gate change. Owner design doc reconciled against code first (conflict register in-chat): form-wall item redirected to the POPOVER (form is retired), #ins-needs-attention is the headline chips, remember-last-view + share-link + email tie-in already largely shipped.
- **D1 Simple/Detailed**: `insDensity` ('simple'|'detailed'; ROLE DEFAULT manager=simple/admin=detailed via lazy `insIsSimple_`; sticky via prefs blob additive `density` field). Header `#ins-density-toggle` segmented control. Simple = `ds-density-simple` class hides `#ins-team-detail` / `#ins-trend-wrap` (+ its zone label via :has) / Chart controls; `insApplyCardsView_` forces cards display (pref untouched); on-track tiers (On par + Ahead) collapse behind `.ins-ontrack-details` "+N on track"; `#ins-simple-note` with inline Switch-to-Detailed. C3 chart trap handled: render pass SKIPS trend/share/heatmap in Simple; `insSetDensity_('detailed')` rebuilds all three (heatmap admin-only). Quick-chips landing inside Team detail auto-switch to Detailed (insScrollPending_ branch).
- **D2 popover Advanced**: compare select + custom-prior row + agent search/list/select-links wrapped in `#ins-edit-advanced` <details> (IDs/wiring untouched; Apply stays outside); auto-opens when comparisonMode==='custom' or a partial agent selection is active.
- **D3**: first-run intro card `#ins-intro-card` (dismiss -> `cdr.ins.intro.v1`); #6 all-clear headline line (no behind-team agents AND |team pct Δ| <= 1.5 pts, `INS_ALLCLEAR_MAX_PTS_`); #7 small-sample guard (`INS_SMALL_SAMPLE_PER_AGENT_`=10 avg answerable/agent -> `#ins-small-sample` note + `.ins-small-sample-mode` mutes delta pills); Abd%/ATT subtab native titles; Simple-only Agents caption `#ins-agents-cap`.
- **Where I left off:** committed/pushed (see git log). Deploy: Department Dashboard only. Live smoke points: toggle Simple→Detailed on a rendered report (trend draws, both tabs; share after opening Team detail; heatmap loads for admin), chips from Simple land open+spotlighted, popover Advanced auto-open with custom prior, manager default = Simple / admin = Detailed, prefs stickiness. Phase 2 parked: saved views + copy-share-link (#8), calendar trend renderer (#10), summary email variant (#9).

## Prior session (post-deploy owner rounds 4+5 — dept strip/table, no-ring gate, inbound cleanup + stage split, misc polish)
Branch `claude/broad-scan-mowwqb`, **384/384 tests** (3 added in inbound-calls: direct-stage + firstAgent), INV-16 guard green, script.html parses.
- **Round 4 (commit 71fe243):** team strip = %Ans(rings) · Queue calls (+≈N/day over workdays via workingDaysBetween_) · Answered · Abd% (Missed/ATT tiles dropped); Total-calls column folded into the split bar as muted "(N)" (CSV splices a numeric column); parentIdBadge + info-line admin-only for non-admins; Insights no-ring drill GATED+counted via one whole-window getMissedCallsSlice prefetch (case-insensitive queue match, serves clicks instantly; failure reveals plain buttons); heatmap lens renamed 'Missed Rings'; ATT trend tab data-admin-only (+pref fallback); Abd% tab styled like team tabs (single-queue = filled curve, no legend; multi-queue = 2.2px/0.4 tension); Inbound v4: byInsurer/byDialInInsurer labeled-only, byQueue queue-entered-only.
- **Round 5:** (1) missed:v15 — `missedEnrichQueueOnlyFromInbound_` stamps waitSec + insurer label on queue-only abandoned entries (one bounded IN-list query, best-effort/Neon-optional, PHI: label only); client renders '· waited M:SS · <insurer>' (.qo-facts). (2) inbound:v5 + capture: abandon_stage gains 'direct' (abandon leg carries a real Departments value = person; IVR stays ivr; old rows heal on force re-import within Call_Legs retention), NEW inbound_calls col `first_agent` (first person leg; phone-shaped skipped); byDialIn display labels: DIAL_IN_LABELS Script Property map (dashboard; "number = Label, ...") > derived mode(first_agent) (catalog-probe-guarded for deploy order) > raw number (kept in `number`); client adds companyView 'Abandoned direct' tile. (3) missed section frost+ripple while fetching (dm-loading min-height). (4) access_denied primary button opens GMAIL web compose (mailto kept as small fallback). (5) Access Control: 'ALL — every department' option in the dept picker (server sentinel already existed) + remove-confirm via dsConfirm_.
- **Where I left off:** committed/pushed (see git log). DEPLOYS: Department Dashboard + cdr-import (inboundCalls.js). Operator: set `DIAL_IN_LABELS` (dashboard Script Property) for the main lines; force re-import recent dates (or run backfillInboundCalls) to heal ivr->direct + populate first_agent; QCD flip runbook (README) for the 251s qcd-alldept cold time. Owner questions answered in-chat (IVR artifact, dial-in derivation, ALL role exists).

## Prior session (/broad-implement Batch 10 — Report Usage review, P-6, live smoke)
Branch `claude/broad-scan-mowwqb`, **381/381 tests** (14 added: 2 P-6 in neon-write-mapping, 7 in NEW smoke-check.test.js, 5 usage in system-health), INV-16 guard green, script.html JS parses.
- **P-6 (both INV-16 neonWrite copies)**: `writeCDRRowsToNeon` gains `opts.authoritative` — the IMP-5 per-date replace for the LAST mirror family: in-txn DELETE of the payload dates' `call_history_phones` CHILDREN first (parent-id subselect — a deleted parent would strand children / trip an FK), then the `call_history_dept` parents, before the insert. Date derivation guards ISO input against parseDateForNeon's UTC-midnight shift (all three callers pass ISO). Callers: daily inline mirror (autoImport ~1777) + deferred `mirrorCdrForDate_` (NeonMirror) pass it; the bulk post-`dedupeAlreadyArchived_` mirror stays NON-authoritative (partial set, note added mirroring the QCD sibling's). Known window (documented in-code): main txn commits before the phone-child txn — a phone failure leaves the date's children absent until the existing retry paths re-run. Non-authoritative path pinned byte-identical.
- **Report Usage review**: the telemetry sheet finally has a reader — `SystemHealth.gs::computeReportUsageSummary_` (30-day window, bounded 5000-row tail read with an explicit "window clipped" note) renders a per-report "runs · unique users · N by managers / admin-only use · cache-hit% · last used" MUTED section on the Health page (busiest-first; `managerRuns` is the un-gating signal). Config.gs REPORT_USAGE comment updated; client HEALTH_SECTIONS_ gains `usage`.
- **Live smoke harness**: NEW `SmokeCheck.gs` — `runLiveSmoke()` (editor-run, assertAdmin_, READ-ONLY) sweeps 7 live checks (sheet-open, latest-dqe-date source-aware, dept-summary, missed-report, agent-free insights over 7d, qcd-alldept on the latest QCD day, Neon SELECT 1 — unconfigured = informational pass, unreachable = FAIL). Per-check try/catch + timing; failed prerequisites cascade as labeled "skipped:" FAILs; REPORT_USAGE_SUPPRESS_ held true during the run (F-27). Emails getAdminEmails_() + stores SMOKE_LAST/SMOKE_LAST_RESULT (OPS-8 prefix-coded 'ok N/N'/'FAILED k/N'); surfaced as the Health page's new `out-smoke` outcome row. Harness shim gained Session.getScriptTimeZone.
- Docs: CLAUDE.md (IMP-5 rule 4 gains the P-6 CDR entry; System Health bullet gains the usage section + smoke row; Subsystems + SmokeCheck.gs), fix-history Batch-10 table.
- **Where I left off:** committed/pushed (see git log). Deploys pending: Department Dashboard (SystemHealth, SmokeCheck NEW FILE, Config, script.html) + cdr-import (neonWrite, autoImport, NeonMirror) + cdr-report (neonWrite). Post-deploy: Run → runLiveSmoke once from the editor (consents nothing new; validates the deploy). Remaining: legacy dqe-report decommission (T-8) + the deferred capture-time queue normalization (owner schema decision) — the 2026-07 broad scan is otherwise fully drained, strategic items included.

## Prior session (/sync-docs + /broad-implement Batch 7-9, gates KEPT)
Branch `claude/broad-scan-mowwqb`, **367/367 tests** (2 added: inbound-qcd-parity.test.js NEW), INV-16 guard green.
- **Batch 7 (docs) COMPLETE**: Batch 5+6 archived (fix-history C-#/T-# rows; known-issues P-8 + T-1 + compact 5+6 list; CLAUDE.md tour parenthetical now states the FIXED behavior).
- **Batch 8 (vetting slice; gates stay ON per owner)**: NEW `compareInboundVsQcdAbandons_` + `runInboundQcdParityCheck` (InboundReport.gs; admin-gated, read-only; `INBOUND_QCD_PARITY_FROM/_TO/_DEPT` props, default last-14-days/all-mapped-depts) — per-dept per-day join of QCD Abandoned (canonical queues, source-aware grid) vs inbound_calls abandons via the SAME `inboundDeptPredicate_`, strict + answered-on-hold reported separately, plus the window's UNATTRIBUTED raw entry-queues. This is the quantification the un-gating decision needs. **DEFERRED with rationale**: capture-time raw→canonical queue normalization — the alias column maps dept→raw names; a rewrite needs raw→SPECIFIC-canonical, ambiguous for multi-queue depts (needs an owner mapping-schema decision, e.g. `raw=canonical` syntax), and it mutates vetting-pending inbound data. Admin gates on Inbound/Direct NOT touched (owner instruction).
- **Batch 9 (flip)**: code side was already complete (R-1); consolidated the full 8-step operator flip runbook (DQE → QCD → CONFIG, indexes, backfills, parity gates, soak, reversibility) into README's Neon read-back section.
- **Where I left off:** committed/pushed (see git log). Deploys pending: Department Dashboard (InboundReport.gs + all prior batches) + cdr-import + cdr-report. Operator next: walk the README flip runbook when ready; run `runInboundQcdParityCheck` + populate Dept Config inbound aliases as the vetting path toward un-gating. Remaining: Batch 10 strategic only (smoke harness, Report Usage review, legacy decommission, optional P-6) + the deferred capture-time normalization (owner schema decision first).

## Prior session (/broad-implement Batch 5 & 6 — THE SCAN'S FIX BATCHES ARE DRAINED)
Branch `claude/broad-scan-mowwqb`, **365/365 tests** (5 added: 2 T-1 merge in NEW sheet-repairs-merge.test.js, 1 P-8 in csr-transfer, plus prior batches), INV-16 guard green, extracted client JS parses. Deploys needed: Department Dashboard (Batch 5) + cdr-report + cdr-import (Batch 6).
- **Batch 5 (client-only)**: C-1 merged the two `#ins-trend-header` writers (the #4 range label finally renders, + the by-queue suffix); C-2 tour replay closes the SETTINGS modal (its real home; F-42 discipline kept); C-3 Overview mini-table WoW tooltips read their OWN response meta (`ovUserMeta_` + `wowChipMetaOverride_` render-context override in `wowChipHtml_`); C-4 router `[data-route="..."]` lookups escape the hash; C-5 the all-dept QCD CSV title line routes through the shared escaper (comma in "Jul 10, 2026" split columns); C-6 `irRenderCharts` restores panel visibility on its empty-datasets early return; C-7 removed double-encoding `escapeHtml` in the two textContent Neon-health renderers; C-8 `reportReqSeq_` gains `inb`/`dir` tokens (Inbound + Direct runners join the stale-response guard family); C-9 `escCssId_` ESCAPES quotes/backslashes instead of stripping (attribute-selector lookups can now match names containing them).
- **Batch 6 (tools)**: T-1 `mergeDqeDuplicateRows_` rebuilds AD/AE/AF as ONE time-sorted paired list + trailing unpaired ids (the F-2 lockstep; #REBUILD rows skipped, all-lost stays sentinel; unpairable AE/AF tails logged; total_unique double-count now comment-labeled an approximation) — pinned by NEW tests/unit/sheet-repairs-merge.test.js (shim gained SpreadsheetApp.flush). T-2/T-3 null-date poison-row guards in `backfillCDRHistory` + `backfillQCDHistory` (skip + log, resume can't wedge). T-4 `abandoned_pct` stored in PERCENT units matching the inline writer ('%'-suffixed = percent; bare <=1 = fraction ×100). T-6 DQEdrilldown col-W gate uses the IMP-8 boundary regex. T-7 `writeDiagnostics` clears the previous panel's FULL height (stale rows ≥12 beyond col 40 no longer strand). P-7 `queueToPendingArchive` REPLACES a type's stale queued rows when the run produced fresh rows (never deletes without a replacement; `parseHistoryDateCell_`-era note: alreadyQueued Set removed, `queuedRowsByType` + `producedTypes`/`markProduced`). P-8 new `parseHistoryDateCell_` (ISO text → local noon) at all four dup-guard/dedup/force-delete comparison sites.
- **Where I left off:** committed/pushed (see git log). NOT deployed. Docs pending (/sync-docs): fix-history Batch 5+6 rows; known-issues P-8 note under the date-coercion section; T-4 pct-unit note; nothing INV-numbered changed. Remaining scan work: Batches 8-10 strategic only (queue identity + Inbound un-gating; Neon flip execution — now fully unblocked; smoke harness / Report Usage review / legacy decommission / P-6 optional). ALL corrective findings from the 2026-07 broad scan are now implemented.

## Prior session (/broad-implement Batch 3 & 4)
Branch `claude/broad-scan-mowwqb`, **362/362 tests** (14 added), INV-16 guard green. Dashboard-only deploy.
- **Batch 3**: R-1 — the three sheet-hardwired QCD readers now honor `QCD_READ_SOURCE`: `computeDeptQcdSnapshot_` (Data.gs; windowed neon read = range ∪ MTD ∪ 180-day latest-day lookback) and `computeQcdSnapshots_` (CompanyOverview.gs; window = min(sinceIso, mtdStart)..today, exactly the old in-loop filter) route through `readQcdGrid_` (sheet path unchanged + now memo-shared); `getLatestDataDates`' QCD component uses new `neonGetMaxQcdDate_` (QCDReport.gs) with sheet fallback, and its cache key suffix became the COMBINED `readSourceCacheTag_()` (one-time cold read on deploy; INV-30 doc update pending). **The Op State #30 flip runbook is now actually safe — remove the R-1 warning from CLAUDE.md after deploy.** O-5 — SystemHealth: tenth sheet in the expected list, `trg-queuereport` trigger row, `out-queuereport` outcome row, OPS-8 classifier flags `^MISSED`. O-6 — PipelineWatch widens its tail read x4 (≤3 times, F-20 pattern) via new pure `pipelineWatchTailClipped_` so a >300-row storm can't evict unexamined failures before the watermark advances.
- **Batch 4**: R-2 — Caller Lookup truncation keeps the ascending list's TAIL (newest). R-3 — allDepts-manager widening: `getCallJourney` (+ F-4 fallback entitlement `|| user.allDepts`), `inboundResolveRequest_`, `directCallResolveRequest_` pin only `manager && !allDepts`. A-1 — `applyOrphanRename` pre-flights the Agent Alias Overrides sheet BEFORE the rename when alsoAddAlias (the audit-gap edge closed; the "audit before returning" doc claim holds again). A-2 — `escRowFull_` selects `occurred_at` so approve emails carry "When". A-3 — `getActiveDeptConfigMap_` is FIRST-active-row-wins (matches the save editor; OPS-9 convention). A-4 — `approveEscalation` refuses unknown-dept rows (fail-open on roster-read failure) with a reject-and-resubmit message. Gap #3 — `escPendingReviewPing_` (Escalations.gs): count-only, PII-free admin ping for new `pending_review` submissions, polled from `runPipelineWatch_`'s hourly run (dispatched FIRST, before its early returns), gated by NEW Script Property `NOTIFY_PENDING_REVIEW` ('true' to enable, default OFF; requires the PipelineWatch trigger, Op State #32), OPS-1 watermark `ESC_REVIEW_PING_WATERMARK` (baseline-silent; advance only on confirmed send).
- Test doubles updated: overview-qcd-snapshot + qcd-report reset `QCD_SHEET_DATA_MEMO_`; system-health fixture installs the tenth sheet; qcd-report fake conn's MAX(call_date) stub returns the bare ISO.
- **Where I left off:** committed/pushed (see git log). NOT deployed — Department Dashboard only (`clasp push -f` + New version). Docs pending (/sync-docs): Op State #30 warning removal, INV-30 latestDates combined suffix, Op State #32 + INV-55 ping/A-4, fix-history Batch 3+4 rows. Remaining scan batches: 5 (C-1..C-9 client), 6 (T-1..T-7, P-7/P-8 tools), 8-10 strategic. Post-deploy note: installs whose setup() predates the queue report will now (correctly) warn "missing: Queue Report Subscribers" on Health — re-run setup().

## Prior session (/broad-scan 3-stage audit + /broad-implement Batch 1 & 2)
Branch `claude/broad-scan-mowwqb`, **348/348 tests** (14 added), INV-16 guard green, script.html extracted-JS clean.
- **Ran a fresh full 3-stage /broad-scan** (6 parallel subsystem agents; every High/Medium finding re-verified at source). Verdict: auth/SQL/XSS/cache all clean; residual risk = pipeline data-loss edges on the newer Neon-only writers + scheduled-send reliability in the newest email engines. Full ranked findings + 10-batch plan in the session transcript. Top 5: P-2 (PHI bypass), P-1 (inbound authoritative delete), O-1 (queue-report send loop), O-3 (silent un-monitoring), R-1 (QCD_READ_SOURCE doc-vs-code gap — NOT yet fixed, Batch 3).
- **Implemented Batch 1 (pipeline)**: P-2 autoImport `join()` always emits the `|` separator when an external side exists + BOTH neonWrite copies hash phone-shaped entries on the internal path too (external-only NOP cells no longer bypass IMP-12 masking; old rows heal on re-import); P-1 `writeInboundCallsToNeon` gains `opts.expectedDateIso` — stray-dated records DROPPED, authoritative DELETE pinned to the import's date (all 3 callers pass it); P-3 `processNewImport` reads+validates the source BEFORE the force-delete block; P-4 `buildDirectCallFromRaw_` gains `opts.expectedDate` refusal (F2 pattern; both callers pass dateObj); P-5 `writeDirectCallRowsToNeon_` runs the authoritative date-DELETE even for an empty row set (matches dcWriteSheet_).
- **Implemented Batch 2 (dashboard ops)**: O-1 queue-report per-recipient try/catch + marker-on-partial-success + `notifyQueueReportSendFailures_` (FAILED-ALL leaves marker unset → retry; preview path still throws); O-7 `queueReportFlagMissedDay_` (post-window polls flag a never-sent day ONCE: `QUEUE_REPORT_LAST_MISSED` + MISSED result + one admin email; fresh installs suppressed); O-2 digest total-failure clears the run marker (same-day retry possible) + `DIGEST_LAST_RESULT_<cadence>` props surfaced in getDigestsInit; O-3 unknown-dept validation (alerts: `error` outcome + "⚠ unknown dept" modal chip; digests: skip + admin-notify instead of all-zero digest; both fail-open if the roster read fails); O-4 OPS-9 first-row-wins dedup + `duplicateRow` flag in `parseDigestConfigValues_` (key email+dept) and `readQueueReportSubscribers_` (key email), send loops skip flagged rows; O-8 Alerts modal defaultDate = `prevBusinessDayIso_`.
- Harness: formatDate shim gained the single-`H` token (unpadded hour — the queue-report window gate).
- **Follow-up in-session:** /sync-docs RAN + APPLIED (commit f8ff9dd): CLAUDE.md (Op State #30 R-1 coverage warning, #31 O-1/O-4/O-7 semantics + QUEUE_REPORT_LAST_MISSED, #12 DIGEST_LAST_RESULT diagnostics, INV-45 O-2/O-3/O-4, INV-34 O-3/O-8, Neon-write rule 4 P-1 + PHI-healing note, M2 bullet P-3, direct bullet P-4/P-5, tour-in-Settings), README (ten sheets, tour wording), known-issues (ten sheets, IMP-12/P-2 entry), fix-history (new P-#/O-# family section — NB O-# ≠ OPS-#), Setup.gs docblock, sheetRepairs.js T-5 comments. ALSO shipped the Batch-2 UI follow-ons: Report Subscribers duplicateRow chips (digest + queue rows) and the digest "Last runs" line (#al-digest-last-results, warn-tinted on FAILED-ALL).
- **Where I left off:** committed/pushed (44a5e10 + f8ff9dd). NOT deployed — needs cdr-import + cdr-report + Department Dashboard pushes (see summary OPERATOR/DEPLOY). Remaining scan batches: 3 (R-1 QCD readers + O-5/O-6), 4 (R-2/R-3/A-1..A-4 + review-notify), 5 (C-1..C-9), 6 (T-1..T-7/P-7/P-8), 7 (doc sweep), 8-10 strategic. PHI healing for pre-P-2 rows: force re-import recent dates (Call_Legs retention permitting); older external-only cells' raw CNAMs need `backfillCDRHistory` (hashes phone-shaped) or SQL cleanup for name strings.

## Prior session (/broad-implement — lighter Insights↔My-Department hand-off + summary strip + drilldown)
Branch `claude/reports-escalations-design-c2t0n7` (design-update track, PRs #159-167 merged; this is the follow-up). **304/304 tests**, INV-16 guard clean, script.html parses. Client-only (dashboard.html + script.html + styles.html); no server/cache/endpoint change. The owner-approved "lighter alternative" (keep two pages, make the relationship explicit) — scoped to NAVIGATIONAL hand-offs per "lighter alternative first."
- **Hand-off (both directions, dept is the shared global selector so only DATES are carried):** `handoffToInsights_(from,to,scroll)` (parametrized `launcherOpenInsights_` — arms `insLauncherAutoRun_` + `insEnsureRoster()`) and `handoffToMyDept_(from,to,{missed})` (mirrors `launcherOpenMissed_`; `missed:true` arms `deptMissedScrollPending_`).
- **Collapsed Insights summary strip on My Department** (`#dept-insights-strip`, `renderDeptInsightsStrip_` called beside `renderDeptTeamStrip_` in `render()`): one-line teaser (answer-rate + missed, from the SAME server totals — no new fetch) + expand (`.dis-more`) describing what Insights adds + "Open full report →" (→ `handoffToInsights_` with the dept-page dates). Delegated wiring (`wireDeptInsightsStrip_`, once, survives innerHTML swaps).
- **Insights → My Department affordances:** header "My Department →" button (`#ins-open-mydept-btn`) + Queue-health "See missed calls →" drilldown (`#ins-qh-missed-link`, `{missed:true}`), both wired in `initInsightsReport`.
- CSS: `.dept-insights-strip`/`.dis-*` + `.ins-handoff-link` (styles.html, reduced-motion aware).
- **DECISION:** built the LIGHTER (navigational) drilldown. The agent missed-calls bar chart already has its per-bucket detail (`makeMissedBucketDetail_`); the heatmap already has its per-cell drill; so the only NEW drill affordance is Queue-health→Missed. DEFERRED as heavier follow-on: deep per-cell / per-weekday-hour cross-page drilling into a specifically-filtered missed view (heatmap weekday×hour has no clean missed-section equivalent).
- **Where I left off:** merged? see git log / PR. NOT deployed (Department Dashboard `clasp push -f` + New version — owner). Live smoke: S1 (My Dept strip renders + expand + Open full report → Insights carries dates), S32/S37 (Insights "My Department →" + Queue-health "See missed calls →" land on the dept page / scroll to missed). Prior track follow-ups still open: `insWorstMover_` dead code; the heavier per-cell drilldown above.

## Latest session (/broad-implement I4 — Insights unified period slider + trend-chart move) [MERGED PR #167, squash b98dad2]
I4 shipped: `#ins-period-bar` preset slider (Last 7/Last 30/MTD/YTD/Custom…) drives the whole Insights window via `runInsReport` (preserving compare mode + agents); the 12-month trend chart moved out of the Team-detail <details> to an always-visible bottom "Trends" section (measure-guarded `insDrawTrendChart_`). Client-only; no cache bump.

## Latest session (/broad-implement: L2 + LM2 + strategic hardening)
Branch `claude/broad-scan-ekn18f`, **292/292 tests** (6 new), INV-16 + cache-version-sync green. 16 files.
Implemented the deferred/strategic set:
- **L2**: `writeInboundCallsToNeon({authoritative:true})` -- per-date REPLACE (DELETE payload dates in-txn before upsert) so a shrinking re-import can't leave a phantom in the dashboard-read, sheet-primary-less `inbound_calls`. Both callers (daily inline + per-date backfill/deferred) pass it (complete-per-date). Fake-conn test in inbound-calls.test.js.
- **LM2**: `neonFetchDqeRows_` marks `out._neonReachable`; all 6 cutover consumers gate on the shared `neonDqeRowsUsable_` -- reachable-empty is TRUSTED (skip redundant sheet scan), only unreachable/errored `[]` falls back (aligns with the neon cutover contract). Helper test in dal-cutover.test.js.
- **Health single signal**: SystemHealth "Recent pipeline step failures" row -- flags a step only when its LATEST outcome is failure (recovered steps don't warn; no wolf-crying). Catches :neon inline mirrors, neonMirror:* drains, guardForceRebuildLoss_. 2 tests.
- **Escalation notify on approve**: `approveEscalation` now also fires `escNotifyNewEscalation_` (Phase 2's real new-escalation inflow is team-tools->pending_review->approve, not create). Same flag/PII gating.
- **Data-loss guard convention**: new shared `guardForceRebuildLoss_(ss, step, dateObj, force, wroteCount)` (autoImport.js) -- on force+0-rows logs a `<step>` failure Pipeline Health row (caught by the Health signal), no throw. Applied to QCD (dashboard-read force-path writer with no empty-rebuild handling); DQE keeps its stronger M2 throw. Documented as a Common Gotcha. csr-transfer.test.js pins the helper.
Docs: CLAUDE.md gained the force-path convention + Health-signal gotchas; updated IMP-5 (inbound now authoritative), INV-55 §1 (notify on approve), F1 read-back (LM2 reachable-empty).
Where I left off: committed/pushed? see git log. NOT deployed (Dashboard + cdr-import clasp pushes pending). Every ranked finding from the original scan is now implemented or explicitly deferred-with-reason (the remaining defers -- LM3/S2-6/S2-7/L8/sheetRepairs edges/L5-doc -- are the truly-low-value/frozen ones).

## Prior session (/broad-implement: P2 + P3 fixes + /sync-docs)
Branch `claude/broad-scan-ekn18f`, **286/286 tests**, INV-16 guard green. 15 files.
Implemented P2: L1 (source-suffix IR/Insights/Missed cache keys, CORE-3), L3 (IR prefs per-email `irPrefsKey_`), L4 (Access Control email/dept via sheetSafeCell_), L6 (escCleanDateTime_ rejects impossible calendar dates via UTC round-trip + test), L9 (getEscalationActivity denial returns not-found shape, no existence oracle), L10 (inboundDeptPredicate_ COALESCE(abandoned_on_hold,false)), L11 (neonFetchDqeRows_ resets out=[] on error so a mid-loop throw falls back to sheet), S2-3 (agent table `.agents-table-wrap` overflow-x), S2-4 (.qcd-warn-strong -> var(--bad)), S2-5 (dark-mode .date-preset-chip.active override).
P3: neonbackfill null-date skip (both backfill loops, prevents poison batch), NeonBackup stale-parts-on-shrink trash, dbReporting undefined-dept binds SQL NULL, keepNeonWarm_ outer try/catch.
DEFERRED (with rationale): L2 (inbound authoritative replace -- risky transactional DELETE on no-sheet-fallback table for a Low finding; needs a deliberate tested change), LM2 (empty-vs-unreachable -- current conflation is protective during mirror lag), LM3 (deferred-mirror per-type independence -- M effort, opt-in), S2-6 (CacheWarm budget -- marginal), S2-7 (dead-branch test -- reports still admin-only), L8 (roster-missing guard -- sensitive), sheetRepairs PST-half/preview-format edges. L5 (ATT wording) -> doc.
Then ran /sync-docs (apply): see next commit for doc updates (INV-44 :CDR:neon/:QCD:neon steps, number-coercion AF gotcha, CORE-3 IR/Insights/Missed, fix-history resolved notes, freshness 250, CSV five writers, README Insights builders).
Where I left off: P2/P3 + docs committed/pushed? see git log. NOT deployed (Dashboard + cdr-import + cdr-report clasp pushes pending). All ranked findings now addressed or explicitly deferred.

## Prior session (/broad-implement: P0 + P1 fixes)
Branch `claude/broad-scan-ekn18f`, **286/286 tests** (added 2), INV-16 guard green, buildDQE copies byte-identical.
Implemented 7 findings (P0: M1/M2/M3; P1: S2-1/S2-2/L7/LM1). 10 files, 3 subsystems.
- **M2** (both buildDQEHistoricalData.js copies + autoImport.js): force-path silent DQE loss. New `refuseIfForce_` helper throws (mirrors IMP-7) on the empty/no-dates/zero-rows early-returns, GATED on `opts.force` (threaded a `force` param into processIntegratedHistory + both build call sites) so the daily NON-force F5 rows:0 path is unchanged -- only a force re-import (rows pre-deleted) alerts. New test in pipeline-build.test.js.
- **M1** (NeonBackup.gs): backup Health row amber-on-every-run. Summary now LEADS with `ok`/`FAILED` so the OPS-8 `/^ok\b/` classifier is correct (was starting with a table name + always contained "skipped"). New test in system-health.test.js.
- **M3** (neonbackfill.js ×2 + NeonMirror.js): AF (`abandoned_missed_times`) routed through `sanitizeSlotCellForNeon_(r[31]) || null` (was the ID sanitizer) so a coerced date-render is RECOVERED not mirrored as garbage; `|| null` preserves empty→NULL. Sanitize FUNCTIONS untouched (F-24/F-51 guard green -- only call sites changed).
- **S2-1** (styles.html): dark-mode Print blank page -> `@media print` re-asserts the light palette + `print-color-adjust:exact`.
- **S2-2** (styles.html): neutral toast invisible in dark mode -> `color: var(--paper)`; success/error re-assert `#fff`.
- **L7** (autoImport.js): inline CDR/QCD Neon-mirror errors now log `processIntegratedHistory:CDR:neon` / `:QCD:neon` Pipeline Health failure rows (parallel to `buildDQE:neon`/`:Inbound`).
- **LM1** (CompanyOverview.gs): watchdog/banner false-alarm -> `computeOverviewPipelineFreshness_` scan window widened 40 -> `OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS=250` so a deferred-mirror retry storm can't evict the DQE-freshness row.
Where I left off: fixes complete + committed/pushed? see git log. NOT deployed (Dashboard + cdr-import + cdr-report clasp pushes pending, operator). DOC updates pending (INV-44 new steps, number-coercion gotcha AF, fix-history M1/M2/M3 resolved) -> run /sync-docs. Remaining scan findings (P2/P3) not started.

## Prior session (/broad-scan 3-stage audit + /broad-implement: CLAUDE.md split)
Branch `claude/broad-scan-ekn18f`, 284/284 tests, INV-16 guard green. Working tree: 3 files changed, none deployed (docs only).
- **Ran a full 3-stage /broad-scan** (8 parallel subsystem agents + 2 Stage-2 deep-dive agents; every top finding independently verified at source). Verdict: mature, well-tested, airtight auth + correct core math; residual risk clusters in **observability** and **force-path/edge handling**, plus lots of **built-but-dormant** capability (Neon read-back/config-Neon default to sheet; Inbound/Direct admin-only "while vetted"; Escalations Phase-2 unfed). Full ranked findings + effort in the session transcript (P0: M2 force-reimport silent DQE loss, M1 SystemHealth backup always-amber, M3 AF sanitizer mis-routing — all Small).
- **Implemented (scope = docs only, per /broad-implement args)**: split CLAUDE.md into current-invariants (CLAUDE.md stays live truth) vs a new **`docs/fix-history.md`** historical fix-log (code taxonomy + per-family index tables F-#/bare-F#/IMP/CORE/RPT/OPS/NEO/M/E/TST, the dashed-vs-bare-F and S#-overload collision warnings, and codes that are in code but NOT CLAUDE.md: CORE-7/OPS-8/NEO-5/NEO-6). Added two additive CLAUDE.md pointers (Read-first bullet + Common-Gotchas note). **Did NOT** do the aggressive in-place shrink (risk of dropping a live rule) — awaiting owner go-ahead; AskUserQuestion was interrupted so defaulted to the safe non-destructive archive.
- **Guard preserved**: `docs/fix-history.md` is intentionally OUT of cache-version-sync.test.js's DOC_FILES (holds historical `prefix:vN` literals) — documented in the file's migration note. Do not add it.
Where I left off: split complete + committed? NO — changes are in the working tree, NOT yet committed/pushed (user drove this interactively; commit on request). Findings NOT implemented — queued for a future `/broad-implement <ids>`, recommend P0 trio (M2/M1/M3) first.

## Prior session (/sync-docs sweep after feedback rounds 1-4)
Branch `claude/broad-scan-d60m5l`, 284/284 tests, INV-16 guard green.
- **Caught a real shipped inconsistency**: the round-3 chip rename ("When did we miss calls?") landed only in dashboard.html's Overview static block -- the `launcherRowHtml_` builder edit was dropped when the round-3 edit batch failed on read-state and only half was re-issued, so Insights + My Department showed the OLD label. FIXED in script.html (builder + comment). Lesson: after a failed multi-edit batch, re-verify EVERY edit in the batch landed, not just the ones re-issued.
- Doc fixes: CLAUDE.md Operator State intro (Health under the Admin ▾ dropdown); README Outlier Fix / Dept Config now "under the Admin dropdown", deep-link list gained `#/report/direct` + `#/admin/access-control` + `#/admin/health`, missed-route note (inline on My Dept), ↗-button phrasing covers the Insights page; known-issues.md gained the **QCD blank-date incident** entry (07/03-07/10 rows with blank col C: daily path can't produce it -- one dateObj to all four sheets; bulk `parsePendingDate` -> Invalid Date -> blank IS possible; repair = hand-fill or force re-import, Neon mirror shares the gap; capture Pipeline Health rows if it recurs).
- Verified clean: all subsystem file lists match disk; all INV-30 cache versions match code; no new operator-state items (rounds 1-4 were client-only); frozen dqe-report rationale intact.
Where I left off: sync-docs sweep committed+pushed, PR + merge on CI green.

## Prior session (post-deploy owner feedback round 4 -- Admin dropdown + rings labeling)
Branch `claude/broad-scan-d60m5l`, 284/284 tests, INV-16 guard green. Client-only (script.html/dashboard.html) + docs; Department Dashboard-only deploy.
- **Admin dropdown**: Alerts / Outlier Fix / Dept Config / Access / Health collapsed into one `.header-menu` "Admin" group (`#admin-menu-btn` / `#admin-menu-list`, dashboard.html) mirroring the Reports group -- initHeaderMenus_ + updateTabActiveState_ are already generic, so ZERO script.html changes were needed; items keep ids/data-route/data-admin-only (deep links, F11 guard, Overview-nag programmatic clicks unchanged); wrapper carries data-admin-only (managers + view-as never see it). Caller Lookup deliberately left top-level (owner listed exactly 5; fold-in is a one-move follow-up). Chose dropdown over a dedicated Admin PAGE: modals keep drag/resize/deep-links/all wiring; a page conversion (Insights-scale project) remains possible later.
- **'% Answered (rings)' label** on the Insights rollup tile (benchValueCls_ still matches via /answer/); glossary gains `'% answered (rings)'` plain + rich entries (exact-key match would otherwise have dropped the tooltip).
- **Owner Q&A (no code)**: rollup Answered = sum of DQE col H over the window for agents EXACTLY on the dept roster (sentinels INV-23 + orphans + floaters excluded; reads NEON dqe_history when DQE_READ_SOURCE=neon -- a sheet-vs-neon manual-sum mismatch is expected if the mirror lags). Missed (rings) = col G same scope, ring-level. Violations (MTD) = computeMtdViolations_: sum of the Violations COLUMN over rows source='Total Calls', dept's OWN queues, date >= 1st of current month, NO range upper bound -- vs per-queue violationDates which are RANGE-scoped days where the column >0; 2-vs-3 is two different windows/scopes, verify by summing col L for July over the dept's own queues.
- **QCD blank-date incident (owner report)**: daily import writes ONE dateObj to CDR/QPath/QCD/CSR alike (autoImport.js:1763), so a QCD-only blank date column doesn't match the daily path; the only code path that can write a blank date is the BULK Pending Archive path (`parsePendingDate` -> Invalid Date -> blank cell on setValues). Advised sheet-edit as likely cause; repair = fill dates or force re-import those dates; Neon qcd_history probably shares the gap for those rows.
- Docs: CLAUDE.md router bullet (dropdown re-collapse note), S31/S36 steps, Insights popover bullet (rings label), Help nav topic (dashboard.html).
Where I left off: round 4 committed+pushed, PR + merge on CI green.

## Prior session (post-deploy owner feedback round 3 -- date honesty pass)
Branch `claude/broad-scan-d60m5l`, 284/284 tests, INV-16 guard green. Client-only (script.html/dashboard.html) + docs; Department Dashboard-only deploy.
- **Popover position**: `reportHeadline_`'s insertion-anchor loop also skips `.ir-edit-popover` siblings, so the headline ("Watch"/"On track" banner) inserts AFTER the popover -- the Insights/IR edit panel now expands directly beneath its button instead of below the banner. Existing pages fix themselves on next full render (the headline element is created once per page life).
- **Chip rename**: "Why did we miss calls recently?" -> "When did we miss calls?" in BOTH `launcherRowHtml_` (script.html) and the Overview static block (dashboard.html); routing unchanged. README launcher bullet also refreshed (it still described the pre-round-2 four-report routing).
- **Daily Call Queue Report default**: new `latestQcdIso_` (stashed from the init getLatestDataDates fetch, next to latestDqeIso_) drives `qcdAllDeptDefaultDates_`; fallback = new `prevWorkdayIso_` (walks back from yesterday over Sat/Sun + __COMPANY_HOLIDAYS__ ranges, 30-step guard). Preset select stays honest: 'yesterday' only when the chosen date IS literal yesterday, 'today' if today, else 'custom'. The explicit Yesterday/Today PRESET options keep literal semantics.
- **Insights date line**: `insWorkdaysLabel_` (server meta.currentWorkDays preferred, client workingDaysBetween_ fallback -- covers <=30min of pre-deploy cached blobs) appends "· N workdays" to `#ins-results-date`, plus "last 30 days" when the range matches the launcher default; the compare line appends the prior window's workdays "(N workdays)" before the length/overlap flags.
- **QCD side-panel note is now DIAGNOSTIC** (round-2 note wasn't enough): when snapshot day != page To, `#dept-qcd-date` compares against `latestQcdIso_` -- company QCD newer than the dept's => "check the dept's queue mapping" wording (renamed-queue drift is the usual cause); else "queue data lands separately from the agent call data (through <latestDqeIso_>)". Answered to the owner: the panel date is the newest QCD row for THIS dept's mapped queues; DQE (drives the page default) and QCD land in different import blocks and can diverge -- if 07/06 rows exist in QCD col D under a spelling the dept's effective list misses, that's the mapping case the new note flags.
Where I left off: round 3 committed+pushed, PR + merge on CI green. Owner backlog unchanged (backfills + smoke list).

## Prior session (post-deploy owner feedback round 2 -- form retirement, quick-start chips everywhere, dept-page fixes)
Branch `claude/broad-scan-d60m5l`, 284/284 tests, INV-16 guard green. All client-side (script.html/dashboard.html/styles.html).
- **Insights setup form RETIRED from the normal flow (owner)**: first entry AUTO-GENERATES (insEnsurePage_ arms insAutoRunPending_, consumed in insRenderAgentList after the prefs-restored pending selection lands; nothing checked = agent-free whole-dept run INV-45; loading pane via launcherShowLoading_); insSetDefaultDates default = the launcher window (last 30 ending yesterday -- the CacheWarm-warmed request, was MTD); "« Back" button DELETED (markup + wiring); the form survives HIDDEN as the failure/empty-roster fallback (insShowForm -- roster-failure + report-failure + empty-roster paths all land there); launcher flag clears insAutoRunPending_ so no double run. **The popover can now EXPRESS a custom prior**: Compare=custom option + #ins-edit-prior-row Prior from/to inputs (prefilled from the main form's last-used values), insApplyEditPopover_ validates + stages them -- required because the form was the only custom-prior surface. Deep-link/digest ?state applies after setPage and the auto-run picks it up (digest links now auto-generate).
- **Quick-start chips on ALL THREE pages** (launcherRowHtml_ one source of truth; injected into new #ins-launcher (.ins-page-body top) + #dept-launcher (dept page, above controls); Overview's static block kept in sync manually -- comment says so). **Every chip lands on + SPOTLIGHTS its answering section**: qsSpotlight_ (scrollIntoView + .qs-spotlight accent-ring pulse, reduced-motion static, one-shot) -- team-lately -> ins-kpi-row, abandons -> ins-queue-health, agent-trend -> ins-agent-cards (REPOINTED from the Individual Report's primed form -- launcherOpenIndividual_ DELETED; there was never an 'old IR', just IR's setup form), missed -> dept-missed-section (deptMissedScrollPending_ consumption now spotlights). insScrollPending_ consumed at end of insRenderReport_ (SWR pre-paint consumes it too).
- **My Department fixes**: (1) missed BAR chart first-render blank -- deptMissedResize_ now rebuilds ONCE from deptMissedLastData when the chart still measures 0x0 after settle+resize (deptMissedRebuilt_ guard, re-armed when healthy); (2) QCD side panel: Answered+Abandoned merged into one "Ans / Abd" tile (green/warn split, .dept-qcd-ans/abd/sep); (3) when the snapshot day != the page To date, a VISIBLE note ("latest queue day -- the page's date range doesn't apply here") renders in #dept-qcd-date (was hover-title only).
- Docs: CLAUDE.md multi-page bullet (auto-generate + form-fallback), popover bullet (custom-prior capability), anti-intimidation launcher bullet (rewritten: chips on 3 pages + spotlight + agent repoint), S14/S18/S19/S32/S37 steps reworded for the form-less flow.
Where I left off: round 2 committed+pushed, PR + merge on CI green. Owner still to run: backfills + smoke. NOTE for smoke: first Insights entry now auto-runs; custom-prior now set via the popover.

## Prior session (post-deploy owner feedback round 1 -- 5 UX notes)
Branch `claude/broad-scan-d60m5l`, 284/284 tests, INV-16 guard green. Owner redeployed + is testing; five notes implemented:
1. **Freshness pill role-tiered**: non-admins get `.freshness-pill--subtle` (quiet inline text, no box; `setFreshnessPill_` toggles by USER.role); `.is-stale` warn tint still wins for both roles.
2. **Trend classification per working day**: NEW `insPerDayMetrics_` (script.html) adjusts volume metrics' deltaPct onto per-working-day values before deltaClassify_/deltaImprovementScore_/deltaIsQuiet_ at ALL consumers (cards enriched block, headline top/bottom + regressed count, CSV classification cols); server meta gains currentWorkDays/priorWorkDays (InsightsReport.gs, + empty shape; NO cache bump -- client falls back to unadjusted when a pre-deploy cached blob lacks them, <=30min). Badges keep raw totals; trend-pill tooltip explains the per-day basis. Rates + equal-workday windows numerically unchanged.
3. **Cards-chart basis selector**: 'vs Prior' RETIRED (insRenderCardsChartPrior_ deleted; saved 'prior' pref restores as 'gap'); the two remaining options render as `seg-rich` two-line choices (title + hint) -- new CSS variant in styles.html.
4. **Insights edit affordance promoted**: `#ins-edit-selection-btn` moved from the tiny editing-line "change" link into the results action row as a real button ("✎ Edit dates & agents"); same id so ALL popover wiring (open/apply/outside-click guard) untouched. NOTE: the popover itself already existed -- this was discoverability.
5. **Call Path fixes**: (a) journey times display-shifted PST->CST via new `clCstTime_` (+2h, INV-18 convention) in clJourneyRowHtml_/callJourneyHtml_/clCallCardHtml_; (b) builder sort gains LEG_ID tiebreak for same-second legs (inboundCalls.js -- STORED journeys keep old order until re-imported/backfilled); (c) synthetic "Call ended" terminal row (`clJourneyEndRowHtml_`, .cl-ev-end style) at max(leg start+duration), "caller disconnected here" when abandoned -- appended in BOTH journey consumers (dept drill + Caller Lookup).
Docs synced: CLAUDE.md freshness bullet, per-agent-cards bullet (per-working-day classification), consolidation bullet + S19 (vs-Prior retirement), inbound bullet (call_start display shift + end row); Help topic (dashboard.html) Gap/Absolute only.
DEPLOY: Department Dashboard + cdr-import (inboundCalls.js ordering). Owner's in-flight backlog: backfills (were in progress), smoke list.
Where I left off: feedback round committed+pushed, PR + merge on CI green. Awaiting more test notes from the owner.

## Prior session (broad-implement: Batch F -- polish backlog, THE SCAN IS NOW FULLY DRAINED)
Branch `claude/broad-scan-d60m5l`, 284/284 tests, INV-16 guard green (incl. the new brace-counting extractor), extracted-JS + shell syntax clean. Docs synced INLINE (the chained /sync-docs): CLAUDE.md INV-34 (OPS-9), INV-45 (OPS-6 + OPS-2), INV-54 (CORE-6), Op State #28 (OPS-4/5), deploy.sh key-commands note (TST-7); known-issues.md Batch-F section (fixes + the 5 accepted deferrals).
- **OPS-2**: digest lock narrowed to a run-CLAIM (DIGEST_RUN_MARKER_<cadence> Script Property set under a short lock, sends run UNLOCKED; a died-mid-sends run leaves the marker set -- same loss as the old timeout, failure email still fires); alerts tryLock 15s->120s. **OPS-11**: alerts scan DQE ONCE per run (alertRowsForDate_ per-execution memo; ~14 depts previously re-read the whole sheet 14x). **OPS-6**: invalid digest cadence flagged (invalidCadence+cadenceRaw, modal chip) not dropped. **OPS-9**: duplicate Alert Config dept rows first-row-wins + duplicateRow flag + skipped log + modal chip.
- **OPS-4**: NeonBackup months fetched in 4 week-windows (bounds JDBC strings); >8MB months written as .partN.jsonl (parts count as closed; stale single file trashed). **OPS-5**: CONFIG_SOURCE=neon => dept/alert/digest_config snapshotted as <table>-latest.jsonl per run.
- **REP-1**: dashboardCDR diagnostics panel FLOATS right of the report (col = max(12, lastColumn+2)); previous column remembered in CRB_DIAG_COL prop, its rows 1..11 cleared (rows >=12 are wiped by the render's 40-col clear). **REP-4** ('N/A' parent-id filter, both buildDQE copies -- INV-16 re-synced). **REP-5** (csr_team null guard). **REP-7** (10-digit insurance numbers -> +1 prefix + log). **REP-9** (slot repair applies per column group end-to-end). **REP-10** (neonbackfill reads 34 cols not 36, 3 sites).
- **CORE-6** (dept's own effective queues always valid on save), **CORE-8** (emptySummary_ totals carry rosterAgentCount/queueOnlyAgentCount; rowsScanned clamped >=0), **CORE-9** (Diagnostics dates default to getLatestDataDate(); cross-file-const dependency documented), **RPT-4** (Insights neon path uses deptQueueExtsForNeonReader_ -- last full-sheet ext read gone), **RPT-5** (orphan-parent depts render top-level with a log line instead of vanishing), **RPT-9** (emptyIndividualReport_ meta mirrors the populated shape), **RPT-10** (getQcdAllDepartments logs Report Usage, dept='ALL', both paths).
- **TST-1** (shim WeekDay duplicate key removed), **TST-6** (guard extractor counts braces), **TST-7** (deploy.sh gates on npm run ci; DEPLOY_SKIP_CI=1 escape hatch). tests/README already canonical-directory style (TST-2 previously handled).
- **DEFERRED (documented in known-issues.md)**: OPS-3 (CacheWarm TZ-vs-browser date miss -- Central-office user base), OPS-10 (drive->drive.file narrowing -- operator's call, needs re-consent + live verify), REP-6 (extraction-tool drift detection -- mini-project), REP-8 (slot-aware DQE drill), TST-4/5 (frozen legacy, per audit ruling).
DEPLOY: Department Dashboard (Alerts, Digest, Data, DeptConfig, Diagnostics, CompanyOverview, IndividualReport, InsightsReport, QCDReport, NeonBackup, script.html) + cdr-report (dashboardCDR, dataFilters, insuranceNumbers, neonbackfill, sheetRepairs, buildDQE INV-16 sync) + cdr-import (buildDQE). Behavior notes: alert emails no longer double-send on dup rows; the digest no longer blocks alerts; Q-Path counts for comma-joined ext rows appear (IMP-2 landed in Batch E; this is its sibling infra).
**THE BROAD SCAN IS FULLY DRAINED** (Batches A-F + the first fix batch + IMP-4 + the Insights page conversion). Remaining operator backlog: the three deploys; backfillDQEHistoryUpsert + parity re-run 05-18..05-22; backfillInboundCallsForce after the cdr-import deploy; the Insights-page smoke list (docs/insights-page-plan.md); optional Neon backup re-consent if OPS-10 is ever picked up.
Where I left off: Batch F committed+pushed, PR + merge on CI green.

## Prior session (broad-implement: Batch E -- owner-ruled accuracy + the back-to-insights highlight)
Branch `claude/broad-scan-d60m5l`, 284/284 tests (4 added: REP-3 + IMP-8 in pipeline-build, RPT-7 in digest-wow, IMP-12 in neon-write-mapping), INV-16 guard green. OWNER RULINGS captured: REP-3=include no-ring abandons in AH; RPT-8=ratify weighted; IMP-12=stop storing raw names; RPT-6=document the difference.
- **REP-3** (both buildDQE copies): csrAbanIds also attributes abandoned parents via their own parent legs' calleeName queue identifiers (the Pass-4 method) scoped to DQE_CSR_QUEUES -- AH now includes no-ring CSR abandons. FORWARD-only: pre-fix rows keep rung-only semantics until rebuilt; AH will read HIGHER from deploy onward (the correction). No cache bump (sheet values change only on rebuild).
- **IMP-8** (both buildDQE copies, Pass 2 + Pass 4): queue regex -> `(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)` -- &-names stay whole (A_Q_Eligibility_MM&R), embedded tokens (UDC_A_Q_Main) no longer phantom-match A_Q_Main (they now DON'T match at all -- capturing the full token would break INV-23's ^A_Q_ sentinel detection).
- **IMP-12** (both neonWrite copies): cdrParseNameFieldJson_ masks external non-phone CNAM displays to initials via new cdrMaskExternalName_ ("SMITH JOHN"->"S.J."); internal + sheet-side raw unchanged; old rows heal on re-import.
- **IMP-2** (autoImport.js): queueMap exclusions/queueExtensionSet split comma-joined cells (dcBuildExtMaps_ pattern, raw kept); deptQueues carries exts[] and the Q-Path matcher tests each ext, counting a path once per row (old single-string regex /103,108(?!\d)/ matched nothing).
- **IMP-10** (inboundCalls.js): icParseTs_ -> Date.UTC; icIsoDate_/icIsoTime_ -> UTC getters. Pure wall-clock math, DST-immune; never mix with Date.now() (comment pinned). Wall-clock output identical outside DST edges -- existing inbound tests unchanged.
- **RPT-7** (CompanyOverview.gs computeWowDriver_): narrative metric is dominance-based both directions; positive weeks require the missed delta to be a DROP; ties fall to 'answered'. digestWowNarrative_ already phrases "missed N fewer ... answer-rate gain" correctly; ovBuildWowDriver_ is a stub. INV-48 text updated.
- **RPT-8**: QCDReport.gs comment now states the weighted mean is owner-RATIFIED intent (docs already matched). **RPT-6**: Overview-tile-ATT-is-weighted vs My-Dept-simple-mean pinned in CLAUDE.md ATT bullet + docs/conventions.md.
- **Cosmetic (pre-batch)**: IR closeModal now reverts the header-tab highlight via setTimeout(setRoute_(basePageRoute_())) -- covers the Back-to-Insights button + Escape closes that initRouter's .modal-close/[data-close] hook missed.
- Docs: known-issues.md gained REP-3/IMP-8 entries (source-pipeline section), IMP-12 (neonWrite section), new "Batch-E CDR Import fixes" section (IMP-2/IMP-10); CLAUDE.md INV-48 + ATT bullet.
DEPLOY: cdr-import (buildDQE, neonWrite, autoImport, inboundCalls) + cdr-report (buildDQE, neonWrite -- INV-16 sync) + Department Dashboard (CompanyOverview.gs, QCDReport.gs, script.html). NOTE: AH semantics + Q-Path counts + inbound overnight ordering all shift at deploy (each is the intended correction).
REMAINING scan work: Batch F only (polish backlog: OPS-2/3/4/5/6/9/10/11, REP-1, REP-4..10, CORE-4/6/8/9, RPT-4/5/9/10, TST-1/6/7). Operator backlog unchanged (backfillDQEHistoryUpsert + parity re-run; backfillInboundCallsForce after cdr-import deploy; the pending dashboard deploys).
Where I left off: Batch E committed+pushed, PR + merge on CI green.

## Prior session (Insights modal->page conversion: Phases 7+8 of 8 -- COMPLETE, PR)
Branch `claude/broad-scan-d60m5l`, 280/280 tests, INV-16 guard green, extracted-JS + div/section nesting clean, repo-wide insights-modal refs = 0. **Conversion complete; shipped as ONE PR** (Phases 1-8; docs/insights-page-plan.md has the full checklist + the post-deploy manual smoke list).
- **Phase 7 (copy/docs)**: tour gained an Insights-tab step; "Deeper reports" step now = the admin dropdown (Individual + Inbound/Direct); Help "The four pages" + nav topic + Insights-is-a-page lead-in; CLAUDE.md swept (multi-page bullet now 4 pages, INV-37 rewritten to the multi-page model, IR-drill paragraph, router/deep-link bullet incl. the page-branch SHARE_STATE_ note, draggable-modals count, "buttonId repoint"->"page repoint" x2, INV-45 + S14/S32 modal->page); docs/known-issues.md digest wording. NO cache-version strings touched (cache-version-sync stayed green).
- **Phase 8 (verification)**: automated checks all green (nesting/syntax/tests/guard). Manual smoke deferred to POST-DEPLOY (needs the live app) -- the 8-item list is in docs/insights-page-plan.md: S37 e2e, S14 + performance deep link, digest deep link WITH ?query state, launcher chips + forced roster failure, IR drill round-trip, open-in-new-tab, S23 tab states + re-entry + chart resize, view-as-manager.
OPERATOR after merge: deploy Department Dashboard (clasp push -f + New version, or scripts/deploy.sh), then walk the smoke list. No setup() re-run, no Script Properties, no web-editor file deletions (the conversion deleted no server files). Prior backlog unchanged: backfillDQEHistoryUpsert + parity re-run for 05-18..05-22; backfillInboundCallsForce after the cdr-import deploy.
Remaining scan work: Batch E (owner rulings: REP-3, RPT-8, IMP-12), Batch F (polish). Optional polish noted in-conversion: Back-to-Insights tab-highlight refresh (pre-existing cosmetic class), Insights results header could carry its own kicker once page-native design is revisited.

## Prior session (Insights modal->page conversion: Phases 5+6 of 8 -- launcher + CSS finish)
Branch `claude/broad-scan-d60m5l`, 280/280 tests, INV-16 guard green, extracted-JS syntax clean. NOT deployable until the post-Phase-8 PR (docs/insights-page-plan.md = live checklist, 6 of 8 checked).
- **Phase 5 (script.html)**: launcherOpenInsights_ calls setPage('insights') (guarded on $('insights-page')) instead of clicking the tab; everything else unchanged. Re-entry launch double-fetch (insEnsurePage_'s old-dates roster call then the launcher's new-range re-ensure) is race-safe via the CL1-3 insRosterReqSeq_ token -- same shape the modal era had.
- **Phase 6 (styles.html + script.html)**: ins-printing print block retargeted #insights-modal/.modal-panel -> #insights-page/.ins-page-body (width unconstrained, form/open-tab-btn/toolbars hidden, quiet-details + page-break rules kept, dead .modal-backdrop line dropped); NEW insResizeCharts_() (deptMissedResize_ double-rAF pattern) called from insEnsurePage_ on EVERY entry -- re-measures insChartInstance/insShareChartInstance/insCardsChartInstance so a window-resize while on another page can't leave them mis-sized. Repo-wide insights-modal refs now ZERO (dashboard.html/script.html/styles.html all 0).
- 1440px visual polish deliberately deferred to the Phase 8 manual smoke (fluid grids expected to stretch cleanly).
Where I left off: Phases 5+6 committed+pushed (NO PR). NEXT: **Phase 7 -- copy/docs sweep**: tour "Deeper reports" step (Insights is a top-level tab now, not in the Reports menu), #help-topic-insights wording, Reports-menu title (already updated in Phase 1 -- verify), CLAUDE.md (multi-page architecture bullet: pages list + INV-37, the Insights-consolidation bullet's "modal" wording, router bullet's routes list, per-report prefs bullet if needed, S14/S18/S19/S32/S37 scenario wording, INV-51 prose), docs tables' prose, README if it mentions the modal. Then **Phase 8 -- verification** (extracted-JS check, node --test, the manual smoke list in the plan doc incl. the digest deep-link with query state) and the SINGLE PR.

## Prior session (Insights modal->page conversion: Phase 4 of 8 -- IR drill simplification)
Branch `claude/broad-scan-d60m5l`, 280/280 tests, INV-16 guard green, extracted-JS syntax clean. NOT deployable until the post-Phase-8 PR (docs/insights-page-plan.md = live checklist).
- **Phase 4 (script.html only)**: irDrillToAgent_ detects the Insights origin via `document.body.getAttribute('data-page') === 'insights'` (both $('insights-modal') probes deleted -- script.html now has ZERO insights-modal refs; only styles.html's ins-printing block remains, Phase 6). The modal hide (drill entry) and re-show + scroll-lock-keep (IR closeModal's irCameFromInsights_ branch) are deleted -- the page sits behind the IR overlay all along; the flag survives solely for the Back-button visibility swap; drill-close restores body overflow and deliberately does NOT move focus (the old btn.focus() target is the admin-only Reports-dropdown Individual item).
- Pre-existing cosmetic carry-over noted (unchanged): closing IR via the Back-to-Insights button doesn't refresh the tab highlight (initRouter's revert hook only covers .modal-close/[data-close] clicks) -- same class as the documented Escape-close gap.
Where I left off: Phase 4 committed+pushed (NO PR). NEXT: **Phase 5 -- launcher**: launcherOpenInsights_ calls setPage('insights') instead of btn.click() (behavior-identical today since the tab click handler just calls setPage, but removes the DOM-indirection); auto-run flag / loading pane / CL1-2 failure fallback unchanged. Then Phase 6 (print-CSS retarget to #insights-page + .ins-page-body, charts-resize on page re-entry, polish), Phase 7 (copy/docs sweep incl. CLAUDE.md INV-37/multi-page/consolidation bullets + tour/help), Phase 8 (verification + the single PR).

## Prior session (Insights modal->page conversion: Phase 3 of 8 -- initInsightsReport rework)
Branch `claude/broad-scan-d60m5l`, 280/280 tests, INV-16 guard green, extracted-JS syntax clean. Still NOT deployable until the post-Phase-8 PR (docs/insights-page-plan.md = live checklist).
- **Phase 3 (script.html only)**: initInsightsReport's modal machinery DELETED (openModal/closeModal/onKeyDown, trapFocus_/releaseFocus_/resetModalTransform_/initModalDragResize_ calls, closeBtn/backdrop listeners, scroll lock); guard now `if (!btn || !page) return;` with `page = $('insights-page')`; ALL form/popover/export wiring kept verbatim and now ACTIVE (was dead behind the modal guard since Phase 1); the 3 delegated listeners (card IR-drill click, hover-prefetch mouseover/mouseout) retargeted modal->page; the 3 dead insights-solo-btn blocks deleted (init reveal else-branch, proxy IIFE, View-as toggle -- top-level tab has no data-admin-only so view-as keeps it).
- Post-Phase-3 state: the Insights PAGE is functionally complete -- tab/deep-links/launcher/generate/popover/export all wired. Remaining known gaps: IR drill degrades gracefully (irDrillToAgent_ probes the absent modal -> fromInsights=false -> IR just overlays the page, no "Back to Insights" button; close reveals the page) = Phase 4; print CSS still targets #insights-modal (the page section sits OUTSIDE .container so body.ins-printing>.container{display:none} doesn't hide it, but the panel/form-hiding selectors no-op) = Phase 6; copy/docs sweep = Phase 7. script.html insights-modal refs down to 2 (both irDrillToAgent_, Phase 4).
Where I left off: Phase 3 committed+pushed (NO PR). NEXT: **Phase 4 -- IR drill simplification**: irDrillToAgent_ detects origin via `document.body.getAttribute('data-page')==='insights'` (drop both $('insights-modal') probes ~5257/5308); keep irCameFromInsights_ for the Back-button visibility swap; IR closeModal's irCameFromInsights_ branch just restores overflow + re-shows nothing (page is already there) -- delete the modal re-show + scroll-lock keep. Then Phases 5-8.

## Prior session (Insights modal->page conversion: Phase 2 of 8 -- router/page plumbing)
Branch `claude/broad-scan-d60m5l`, 280/280 tests, INV-16 guard green, extracted-JS syntax clean. Still NOT deployable (one PR after Phase 8; docs/insights-page-plan.md holds the live checklist).
- **Phase 2 (script.html only)**: setPage gains 'insights' (whitelist + kicker "Reports · Insights"/title + setRoute_ -> '/report/insights'); NEW `insEnsurePage_` (+`insPageInited_` flag: first entry = insShowForm/insSetDefaultDates/insRestorePrefs_/insEnsureRoster in openModal's exact order; re-entry = insEnsureRoster only, never clobbers rendered results); ROUTES_ re-typed all 4 routes ('/report/insights' + the performance/compare/qcd repoints) to `{kind:'page', page:'insights'}` (buttonId/modalId dropped); basePageRoute_ returns '/report/insights' when data-page=insights (IR-drill modal close restores the tab highlight); the deep-link NO-TRIGGER page branch now applies SHARE_STATE_ params after setPage (the Digest.gs email deep-link keeper; retired repoints have no provider -> quietly dropped, unchanged). PULLED FORWARD from Phase 3: tab click -> setPage('insights') at the top of initInsightsReport (the deep-link trigger path clicks the tab; the route re-types were dead without it), followed by the `if (!btn || !modal) return;` guard -- the modal machinery below is untouched dead code until Phase 3.
- Intermediate state: page opens + form shows; the Overview launcher auto-run MAY work end-to-end (runInsReport is called programmatically; insRestorePrefs_'s compare-mode dispatchEvent no-ops with no listener); manual form controls (Generate/presets/popover/export) unwired until Phase 3. initRouter's modal-close loop skips the re-typed defs cleanly (kind filter).
Where I left off: Phase 2 committed+pushed (NO PR). NEXT: **Phase 3 -- initInsightsReport rework**: delete openModal/closeModal/trapFocus_/drag-resize/scroll-lock/Escape/backdrop machinery, drop the modal guard so the form/popover/export wiring below runs (keep it all verbatim), delete the dead insights-solo-btn wiring blocks (init reveal, proxy click, View-as toggle -- all null-checked no-ops today). Then Phases 4-8 per the plan doc.

## Prior session (Insights modal->page conversion: Phase 1 of 8 -- markup move)
Branch `claude/broad-scan-d60m5l`, 280/280 tests, INV-16 guard green. Owner approved the full conversion plan (now at **docs/insights-page-plan.md** -- decisions + per-phase checklist live there): (1) top-level Insights tab, (2) `#/report/insights` stays canonical, (3) re-entry keeps the rendered report, (4) 1440px page body. **The conversion lands as ONE PR after Phase 8 -- intermediate commits are NOT deployable.**
- **Phase 1 (this commit)**: dashboard.html -- `#insights-modal` shell deleted, panel-body contents lifted into `<section id="insights-page" class="page page-insights"><div class="ins-page-body">` (outside `.container`, the Escalations precedent; ALL inner ids unchanged); open-in-new-tab button relocated as first child of `.ins-page-body` (same class + data-open-tab-route, the wiring loop keys on those); top-level Insights tab added carrying the stable `#insights-report-btn` id; `#insights-solo-btn` (the #10 manager proxy) removed -- its script.html wiring is null-checked so it no-ops until the Phase 3 cleanup; Reports dropdown loses the Insights item (title text updated). styles.html -- `body[data-page="insights"]` display rule + `.ins-page-body` (1440px, position:relative anchoring the open-tab button, top/right 0 override).
- **INTERMEDIATE STATE: Insights is UNREACHABLE** -- initInsightsReport early-returns ($('insights-modal') null, so NOTHING is wired incl. the generate button) and setPage doesn't know 'insights' yet. div/section nesting verified balanced; zero insights-modal refs left in dashboard.html; script.html (7) + styles.html (3, the ins-printing block) refs remain BY DESIGN for Phases 3/6.
- Prior small fix also merged this session: PR #149 (Inbound/Direct/all-dept-QCD last30 presets end yesterday).
Where I left off: Phase 1 committed+pushed (NO PR). NEXT: **Phase 2 -- router/page plumbing** per docs/insights-page-plan.md: setPage gains 'insights' (first-entry init = insShowForm + insSetDefaultDates + insRestorePrefs_ + insEnsureRoster; re-entry only re-ensures roster, never clobbers results), ROUTES_ re-types the 4 routes (incl. the 3 legacy repoints) to kind:'page', currentRouteFallback_ + setPage's setRoute_ mapping gain insights, AND the deep-link page branch must apply SHARE_STATE_ query state (the Digest.gs email deep-links carry ?from=&agents= -- the one subtle bit). Then Phases 3-8. Operator backlog unchanged (backfillDQEHistoryUpsert + parity re-run; backfillInboundCallsForce after cdr-import deploy; dashboard deploy for Batch D + PR #149 can go out anytime BEFORE this conversion's WIP commits -- deploy from main, not this branch).

## Prior session (broad-implement: Batch D -- client staleness/races, script.html + dashboard.html only)
Branch `claude/broad-scan-d60m5l`, 280/280 tests (none added -- script.html is outside the harness; extracted-JS `node --check` clean), INV-16 guard green. NO server/cache changes; ALL fixes are client-only.
- **CL1-1**: Overview stale-response token (`ovLoadSeq_`; both handlers guarded) so a View-as switch mid-flight can't paint the other role's payload; `#ov-company-aggregate` gained `data-admin-only` in dashboard.html (belt-and-suspenders under the View-as CSS hide; server strip unchanged).
- **CL2-1**: shared `reportReqSeq` split into `reportReqSeq_={ir,ins}` -- an Insights run no longer invalidates an in-flight IR drill (and vice versa).
- **CL1-2**: insEnsureRoster failure handler now cancels `insLauncherAutoRun_` + `insShowForm()` (the IR #1-Part-B pattern) -- a launcher-chip roster failure no longer strands the eternal loading pane.
- **CL1-3**: per-picker roster stale tokens (`irRosterReqSeq_`/`insRosterReqSeq_`) on BOTH the init fetch and the 350ms debounced refetch -- an out-of-order older response can't repaint the picker or poison rangeKey.
- **CL1-4**: My-Dept `onError(err, hadSwrPaint)` keeps the SWR-painted table under a "couldn't refresh" error instead of wiping to empty (the behavior refresh()'s comment already promised).
- **CL1-5**: `callJourneySeq_` token on the "↳ path" journey overlay (rapid double-drill can't cross-paint).
- **CL1-6**: `deptMissedScrollPending_` disarmed on missed-fetch failure + the no-dept early return (a leaked one-shot no longer yanks the page down on a later unrelated refresh).
- **CL2-2**: `escLoadSeq_` token on the Escalations list (filter-switch races).
- **CL2-3**: `reportSwrPaint_` calls `repaintFn(data,{swr:true})`; Insights + Inbound renderers skip `loadAbandonHeatmap_` on the SWR pre-paint (live pass fetches once; fail-fallback still fetches); per-container `heatLoadSeq_` token in the heatmap loader.
- **CL2-4**: `qcdAllDeptReqSeq_` token on the all-departments QCD report (preset changes re-run immediately -> overlap).
- **CL2-6**: guided-tour Reports step copy updated (was listing retired Performance/Compare/QCD + the retired Missed modal).
- **CL1-9**: IR + Insights "Last 30 days" presets are now 30 days ENDING YESTERDAY (was 31 days ending today) -- matches the main-page chip, the Overview launcher window, and CacheWarm. Inbound/Direct/qcdAllDept last30 presets deliberately untouched (different reports' semantics; noted as follow-on).
- **CL2-7**: Insights prefs key is per-user (`insPrefsKey_()` = `cdr.ins.prefs.v2:<email>`, the reportLastGoodKey_ pattern) because the blob stores the agent selection; bare-key blobs are orphans (one-time prefs reset per user, deliberate).
- Docs: CLAUDE.md per-report-prefs bullet (per-user ins key) + Report-SWR bullet (onError keep-last-good, repaintFn opts, heatmap skip).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions; no cache bumps. Post-deploy smoke: S23 (Overview), S37 (Insights incl. launcher chip with a forced roster error if practical), S4 (missed deep-link scroll), S32 (all-dept QCD preset switching).
FOLLOW-ON (not in scope): CL1-7/CL1-8 (from the audit); Inbound/Direct/qcdAllDept last30 presets still end today; IR prefs key (cdr.ir.prefs.v1) not per-user (stores no agent selection -- lower stakes).
Where I left off: Batch D committed+pushed, PR + merge on CI green per the established flow. Remaining scan work: Batch E (owner rulings: REP-3, RPT-8, IMP-12), Batch F (polish). Operator backlog unchanged: backfillDQEHistoryUpsert() to heal the 12/30/1899 Neon slots then re-run parity for 05-18..05-22; backfillInboundCallsForce() after the cdr-import deploy (TIME-SENSITIVE); deploys.

## Latest session (broad-implement: IMP-4 -- phone-child corrections propagate)
Branch `claude/broad-scan-d60m5l`, 280/280 tests (1 added), INV-16 guard green. Owner asked "should we address IMP-4 before merging?" -- yes (same neonWrite.js pair already queued for deploy; completes the corrections-propagate story IMP-5 started; per-parent replace is safe on EVERY caller unlike date-level).
- **IMP-4** (both neonWrite.js copies): cdrInsertPhoneChildRows_ now DELETEs the looked-up parents' call_history_phones rows (chunked 500 ids/statement, same child transaction) before the inline inserts -- corrected duration_sec/occurrences propagate on force re-import and REMOVED entries no longer linger as phantoms. The zero-entries early-return COMMITS the delete (a re-import that emptied every list: the delete IS the correction). ON CONFLICT DO NOTHING kept as intra-payload dup guard only. Per-parent (not per-date) replace: each payload row carries its parent's COMPLETE entry set, so partial-DATE bulk batches are safe. Documented edge: an all-lists-empty payload never reaches the helper (hasAnyPhones gate) -- stale children would persist; practically unreachable. neonbackfill.js::backfillCDRHistory child path DELIBERATELY left fill-only (its documented design).
- Test: neon-write-chunking IMP-4 (id-serving fake conn; delete-before-insert sequence, both parents incl. the now-empty one, DO NOTHING retained, 2 commits). Docs: architecture.md "phone child rows stay DO NOTHING" corrected; CLAUDE.md Neon-write-discipline rule (4) extended.
DEPLOY: rides the already-pending cdr-import + cdr-report deploys (no new subsystems).
Where I left off: owner pausing to merge + deploy + test. Post-deploy sequence: backfillInboundCalls (TIME-SENSITIVE, IMP-1) -> Neon-flip runbook (Batch B entry above). Remaining scan work: Batch D (client races), Batch E (owner rulings: REP-3, RPT-8, IMP-12), Batch F (polish).

## Latest session (broad-implement: Batch B -- Neon-flip prerequisites)
Branch `claude/broad-scan-d60m5l`, 279/279 tests (5 added/updated: IMP-5 authoritative-replace + REP-2 lookup-chunking in neon-write-chunking, IMP-11 in neon-mirror-tail, CORE-2 in dal-cutover, direct-call-backfill DELETE+upsert; CDR chunk test re-pinned at 300), INV-16 guard green. NO cache-version bumps (CORE-3 adds a SOURCE SUFFIX to summary:/individual_active: keys -- the latestDate pattern, one-time cold read per key on deploy).
- **IMP-5 (authoritative per-date replace)**: writeDQERowsToNeon/writeQCDRowsToNeon take `{authoritative:true}` -> DELETE the payload's distinct dates in the SAME txn before inserting (helpers neonDistinctIsoDates_/neonAuthoritativeDateDelete_). Opted in: daily DQE build + dup-guard re-mirror (both INV-16 copies), daily QCD mirror (autoImport), deferred per-date mirrors (NeonMirror). Deliberately NOT: bulk-archive QCD (post-dedupeAlreadyArchived_ can be a PARTIAL date -- commented at the call site) + all row-batched backfills. Daily Direct writer (writeDirectCallRowsToNeon_) deletes its date likewise; dcUpsertRows_/backfill untouched. Phantom-row divergence (the Neon-flip correctness blocker) is closed for dqe_history/qcd_history/direct_call_history going forward; EXISTING phantoms need one force re-import of the affected date (or the runbook below). inbound_calls + call_history_dept deliberately excluded (no-sheet-primary risk / FK children) -- noted as follow-on.
- **CORE-2**: computeActiveAgentsInRange_ applies the F-35 pattern (sheet hard-required only when it IS the source; Neon path survives a trimmed sheet; neon-fail + no-sheet -> clean empty).
- **CORE-3**: summary: + individual_active: cache keys suffixed with the active DQE read source.
- **IMP-3**: CDR_CHUNK_ROWS 500->300 (~27KB/chunk vs the measured ~44KB JDBC cap). **REP-2**: cdrInsertPhoneChildRows_ parent-id lookup chunked at 400 rows/query (was ONE statement over the whole rows array -- blew the cap ~2,900 rows on the F-18 bulk mirror), idMap merged across chunks; serves both the inline path and mirrorCdrPhonesToNeon.
- **IMP-11**: backfillInboundCalls returns sheetsFound; mirrorInboundForDate_ HARD-fails a queued date whose Call_Legs sheet was pruned (composes with the IMP-6 cap -> one final gave-up email) instead of silently dequeuing an unrecoverable loss.
- Docs synced: Neon-write-discipline rule (4) authoritative replace; INV-30 summary/individual_active source-suffix notes; Op State #19 (CORE-2) + #22 (IMP-11).
- **OPERATOR (the flip runbook, now unblocked)**: (1) deploy cdr-import + cdr-report + dashboard; (2) run backfillDQEHistoryUpsert() once (refreshes stale rows; does NOT remove pre-existing phantoms -- if the parity gate reports missing-in-sheet rows, force re-import those dates or delete them in SQL); (3) run runDqeParityCheck until PARITY CLEAN incl. missing-in-neon=0 AND missing-in-sheet=0; (4) flip DQE_READ_SOURCE=neon; (5) watch the Neon read-back health line + [dqe-read] timings; revert by clearing the property.
DEPLOY: cdr-import (neonWrite, buildDQE, autoImport, NeonMirror, inboundCalls, directCallMetrics) + cdr-report (neonWrite, buildDQE -- INV-16 sync) + Department Dashboard (Util.gs, Data.gs).
REMAINING from the scan: Batch D (client races), Batch E (owner-gated accuracy), Batch F (polish). IMP-4 (phone children DO NOTHING) and inbound/CDR authoritative replace remain the known Neon-consistency leftovers.
Where I left off: Batches A+B+C + the first fix batch + sync-docs all committed+pushed; operator backlog: merge PR, four deploys, web-editor deletions, TIME-SENSITIVE backfillInboundCalls (IMP-1), then the flip runbook above.

## Latest session (broad-implement: Batch A truthful-alarms + Batch C auth hygiene)
Branch `claude/broad-scan-d60m5l`, 275/275 tests (9 added: ingest-watchdog.test.js NEW x4, escalations NEO-2, missed-report CORE-1, util CORE-7, insights RPT-3, dept-config-neon CORE-5), INV-16 guard green. NO cache bumps (RPT-3 is caching POLICY, not a shape change). Harness: formatDate shim gained the 'u' (ISO dow) token the weekend/holiday gates use.
- **Batch A**: OPS-1 watchdog episode flag arms only on a CONFIRMED send (notifyIngestStale_ returns bool; LAST_RESULT honest on failure); OPS-7 watchdog skips company-holiday runs + credits 24h/non-business day in the stale gap (ingestWatchdogNonBusinessCredit_, 14-day cap); RPT-3 Insights skips the cache put when queueHealth={error:true}; CORE-5 compareDeptConfigSources returns clean:false+error on unreachable Neon (F-5 parity with Alert/Digest gates); NEO-3 read-health recording is opt-IN ({recordReadHealth:true}, the 3 DQE readers only) -- the 9 non-DQE recordNeonReadFailure_ call sites removed (Inbound x5, CallerLookup, Alerts/Digest/DeptConfig config readers); OPS-8 Health outcome classifier is ok-prefix-aware (no false amber on "ok (... skipped on budget)").
- **Batch C**: NEO-2 updateEscalationComment requires non-empty text + is worklist-only (pending_review/rejected refused), resolve preserves stored comments via COALESCE; CORE-1/DEEP-1 signed-in gate landed on getLatestDataDate(s) (the phantom F-28); NEO-4 Caller Lookup subquery is ORDER BY call_date DESC, call_start DESC NULLS LAST before LIMIT (truncation keeps newest); CORE-7 Util.gs sheetSafeCell_ neutralizes formula-leading cells at the OrphanFix log/alias/roster-add, DeptConfig notes+inboundAliases, and Auth notes write sites; NEO-5 getInboundInsurerDaily gained the unmapped-dept short-circuit; NEO-6 directCallResolveRequest_ mirrors inbound's manager-first/'ALL' ordering.
- Docs synced in-batch: Op State #20/#23/#25, Key Design Decision auth note, INV-30 insights RPT-3 note, INV-55 NEO-1/NEO-2 semantics, KeepWarm F29 comment.
- BEHAVIOR NOTES: (1) watchdog now alerts up to 24h/non-business-day LATER on real outages spanning weekends/holidays -- deliberate false-alarm trade; (2) client "Save comment only" with an empty box now errors visibly ("A comment is required.") instead of silently NULLing the comment; (3) DQE read-back health line no longer reflects non-DQE Neon outages (those surface in their own reports' unavailable states).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions; no cache bumps.
REMAINING from the scan: Batch B (Neon-flip prereqs: IMP-5, CORE-2, CORE-3, IMP-3/REP-2, IMP-11) is next by priority; then Batch D (client races), Batch E (owner-gated accuracy: REP-3, RPT-8, IMP-12, IMP-8, IMP-2, IMP-10, RPT-6/7), Batch F (polish incl. OPS-2 alerts/digest lock contention).
Where I left off: Batches A+C committed+pushed on top of the audit-fix + sync-docs commits; operator backlog unchanged (merge PR, 3 deploys, web-editor deletions, TIME-SENSITIVE backfillInboundCalls for IMP-1).

## Latest session (broad-scan #2 + broad-implement: IMP-1, NEO-1, RPT-1/2, IMP-7, IMP-6)
Branch `claude/broad-scan-d60m5l`, 266/266 tests (8 added: missed-report.test.js NEW ×4, inbound-calls IMP-1, pipeline-build IMP-7, neon-write-chunking IMP-6, escalations NEO-1), INV-16 guard green. ONE cache bump synced everywhere (test-enforced): missed v13->v14.
- **Full 3-stage broad-scan ran first** (9 parallel deep-read audits, ~85 findings, all top findings source-verified). Report delivered in-session; the five below were owner-selected. NOT implemented (notable, awaiting selection): RPT-3 (Insights caches queueHealth {error:true} 30 min), OPS-1 (watchdog marks episode alerted on failed email), CORE-5 (compareDeptConfigSources false PARITY CLEAN on Neon-down + empty sheet), CL1-1 (Overview stale-response/View-as leak, #ov-company-aggregate lacks data-admin-only), CL2-1 (shared reportReqSeq: Insights->IR drill strands stale data), NEO-2/3/4, IMP-2/3/5/8/10/11/12, REP-1/2/3, OPS-2/3, DEEP-1 (F-28's "signed-in gate on getLatestDataDate(s)" was claimed in commit 22c5fd7's message but NEVER implemented -- fix ledger drift), + doc contradictions (INV-53/S6 say scope='both', code is 'roster'; Op State #20/#25/#19 claims; known-issues "Backup CSR happens to match"; QCD avgAnswer weighted vs doc day-mean).
- **IMP-1** (cdr-import/inboundCalls.js): icIsQueueName_ now matches `Backup CSR` (case-insens, exact) alongside /^A_Q_/ -- abandons on Backup CSR were captured abandon_stage='ivr' / entry_queue=NULL, permanently (Call_Legs prune ~14d). OPERATOR: run `backfillInboundCalls` ASAP to re-capture the last ~14 days' mis-classified rows (ON CONFLICT DO UPDATE refreshes them); older rows are unrecoverable.
- **NEO-1** (Escalations.gs): resolveEscalation guard is now status!==pending (was not-resolved-only) -- pending_review can no longer bypass approveEscalation, rejected can no longer be walked back via resolve->reopen. Client already only offered Resolve on pending cards; INV-55's "PENDING-ONLY (F-43)" claim is now true.
- **RPT-1/2** (MissedCallsReport.gs, missed:v14): AD/AF classification + unique-abandoned collection moved ABOVE the zero-slot early-continue (slot-less F-2 rows count; lost-detail flag fires on them); AF<->AD pairing is a per-time-key FIFO (duplicate seconds keep distinct parent ids on journey drills; one AF entry flags at most one ring). Docs synced (INV-30 + 3 version tables).
- **IMP-7** (buildDQEHistoricalData.js BOTH copies): the F2 expectedDate-mismatch guard now THROWS after logging its buildDQE failure row -- daily caller catch emails notifyDqeBuildFailure_ + logs :DQE failure (was: silent return under a success-rows:0 row with the force-deleted date left missing); bulk catch logs + continues. CLAUDE.md INV-16 text synced.
- **IMP-6** (neonWrite.js BOTH copies + directCallMetrics.js + NeonMirror.js): (a) neonDedupeByKey_ last-write-wins dedupe on each writer's conflict key (DQE date+agent, QCD date+queue+source, CDR date+dept+agent, Direct date+dept+agent) so sheet-derived duplicate rows can't throw "cannot affect row a second time"; (b) deferred-mirror queue gains an Attempts col (4th; pre-existing 3-col tabs fine, blank=0) + NEON_MIRROR_MAX_ATTEMPTS (default 8, property-tunable) -- HARD-error dates park with a `neonMirror:gave-up` failure row + ONE final email; unreachable still retries forever. CLAUDE.md INV-44 + Op State #22 synced.
DEPLOY: Department Dashboard (Escalations.gs, MissedCallsReport.gs) + cdr-import (inboundCalls, buildDQE, neonWrite, directCallMetrics, NeonMirror) + cdr-report (buildDQE, neonWrite -- INV-16 sync). dqe-report untouched.
OPERATOR: (1) backfillInboundCalls after the cdr-import deploy (IMP-1 heal, time-boxed by Call_Legs retention -- do it FIRST); (2) missed:v14 self-heals via TTL.
Where I left off: this batch committed+pushed on top of the 48 unmerged consolidation commits; the rest of the broad-scan findings await owner selection (Top remaining by impact: RPT-3, OPS-1, CORE-5, CL1-1/CL2-1 client-race batch, IMP-5 Neon reconcile-before-flip, DEEP-1 process rule).

## Latest session (CR RETIREMENT -- consolidation complete)
Branch `claude/broad-scan-xkmoam`, 258/258 tests, INV-16 guard green. Individual + Insights are now the two agent reports.
- **Pre-retirement ports (so nothing remained to confirm):** (1) `insDeltaBadge_` gained an optional prior-value hover tooltip -- every Insights card delta badge shows the prior window's exact value (CR showed P1 explicitly); (2) the cards Chart view gained a THIRD basis, **vs Prior** (`insRenderCardsChartPrior_`: grouped current-vs-prior bars per agent for the selected metric, IR drill on click) -- CR's only remaining unique visual. Metric selector now applies to gap + prior (hidden only in Absolute).
- **Compare Ranges RETIRED** (the PR/QCD playbook): CompareRangesReport.gs deleted (nothing else consumed its compute); script.html CR region deleted (~1,450 lines) with the four SHARED helpers re-homed to a "Shared delta/duration helpers (ex-Compare Ranges)" block (`crFormatSecondsShort_`, `deltaImprovementScore_`, `deltaClassify_`, `deltaIsQuiet_` -- Insights consumes all four); crHeadline_ deleted; ROUTES_ '/report/compare' -> insights modal (buttonId repoint mechanism from the PR session); SHARE_STATE_ provider + date-link pairs + init call removed; dashboard.html Compare button/modal/help topic removed, Insights help documents the absorption. KEPT: cr-vs-team / cr-quiet-* / pr-kpi-row CSS (Insights uses them). NOT carried over (deliberate): floater cards -- Insights is roster-only (v15); IR still surfaces floaters.
- Tests: compare-ranges.test.js deleted (countWorkingDays_/INV-35 covered by util.test.js + insights-report.test.js); cache-version-sync 'compareRanges' SPECS row retired; docs tables -> RETIRED rows; CLAUDE.md swept (consolidation bullet, INV-30/31/32/35/36, S17/S27 retired, S18/S19 rewritten around Insights, report lists).
OPERATOR (INV-17): delete CompareRangesReport.gs AND PerformanceReport.gs in the Apps Script WEB EDITOR after deploy. Orphaned localStorage: cdr.cr.prefs.v1, cdr.pr.prefs.v1.
Where I left off: commit+push, then /sync-docs apply, then PR + merge on CI green (owner-directed).

## Latest session (Absolute toggle + PR RETIREMENT + IR hover-prefetch)
Branch `claude/broad-scan-xkmoam`, 262/262 tests (performance-report.test.js deleted; parity test reworked into the consolidation FREEZE), INV-16 guard green.
- **A: Absolute sub-toggle** on the Insights per-agent Chart view (`#ins-cards-chart-mode`, 'gap'|'abs' in `insCardsChartMode`, persisted in cdr.ins.prefs.v2 -- additive key, no version bump): 'abs' renders PR's Volume & Efficiency view (`insRenderCardsChartAbs_`: stacked Answered+Missed per agent + % Answered dots on y1, datalabels honor the report toggle, bar click drills to IR); metric selector is gap-only.
- **C: IR hover-prefetch** (initInsightsReport): ~300ms rest on an `.ins-card` fires getIndividualReport with the drill's EXACT request shape ({department, from, to, agents:[name]} -- field order matters for reportSig_) and writes reportLastGoodWrite_('ir', sig, data), so the click-drill SWR-paints instantly. Guards: mouseout cancels, one fetch per sig per session, skip when store already warm. TRADE-OFFS (documented in CLAUDE.md): prefetches count in Report Usage telemetry (sig must match, no marker possible) and overwrite the one-entry IR last-good slot.
- **B: Performance Report RETIRED** (PR->Insights consolidation, the QCD playbook): PerformanceReport.gs DELETED (`deltaBlock_` MOVED to Util.gs -- Insights consumes it, CR mirrors the shape); script.html PR region (~1,240 lines: initPerformanceReport..prEmailImage_, prHeadline_, SHARE_STATE_ provider, date-link pairs, init call) deleted; dashboard.html menu button + #performance-modal + help topic removed (Insights help mentions the absorption); ROUTES_ '/report/performance' -> insights modal. **Router fix found in-scope: retired-route modal repoints ('/report/qcd' AND now '/report/performance') never actually dispatched on deep links** (no [data-route] element carries the legacy route so querySelector missed and the handler returned) -- the no-trigger branch now resolves kind:'modal' defs via def.buttonId (admin-gated), fixing the pre-existing qcd gap too. pr-* CSS classes are SHARED with Insights/CR/Inbound/Direct (pr-delta, pr-kpi-row, pr-trend-subtab) -- kept; dead .pr-agent-table/.pr-subset-hint CSS left (harmless, precedent). Tests: performance-report.test.js deleted; insights parity test -> consolidation-freeze literals (INV-25 weighted ATT 160s/'0:02:40', INV-28 window 03-02..03-08, INV-29 13 buckets, roster gate; trend asserts by INDEX not label text -- shim formatDate has a TZ off-by-one artifact on label strings); digest-insights.test.js load list fixed; cache-version-sync 'performance' SPECS row retired. Docs: CLAUDE.md (PR gotcha bullet rewritten as retirement, INV-25/28/29/30/31/36 + S14 (now the Insights absorbed-views scenario)/S16/S26/S37 + SWR/headline/datalabels/share-state/prefs/cutover lists), doc tables in known-issues/conventions/architecture -> RETIRED rows.
OPERATOR (INV-17): delete PerformanceReport.gs in the Apps Script WEB EDITOR after deploy -- clasp push does not remove remote files. cdr.pr.prefs.v1 localStorage key is an orphan.
DEPLOY: Department Dashboard only. Post-deploy smoke: S14 (Insights absorbed views incl. Absolute toggle + #/report/performance deep link), hover-prefetch (hover card ~1s then drill -> instant paint), #/report/qcd deep link (now actually works).
Where I left off: commit+push this session; ~35 unmerged commits awaiting PR/merge + the four deploys. CR retirement remains the last consolidation candidate (needs Report Usage evidence).

## Latest session (drilldowns #1-#4: heatmap cell, violation dates, trend point, agent row)
Branch `claude/broad-scan-xkmoam`, 265/265 tests (6 added), INV-16 guard green. NO cache-version changes (new endpoint uncached; #2/#3 client-only).
- **#1 heatmap cell drill**: `getInboundHeatmapCell` (InboundReport.gs) -- same auth (admin-only vetting gate via inboundResolveRequest_) + dept predicate + TZ/window/slot math as getInboundHeatmap, disposition='abandoned' only, capped INBOUND_HEATMAP_CELL_MAX=200 (meta.truncated), UNCACHED, no caller identity. Client: cells with abandons get `.ds-heatmap__cell--drill` (click/Enter/Space; stale-guard by panel data-cell key) -> `.ds-heatmap-detail` panel listing date/CST time/entry→final/stage/wait+hold, each with the existing "↳ path" `.pid-journey` -> getCallJourney. Pinned by tests/unit/heatmap-cell-drill.test.js (6 tests; isIsoDate_ stubbed -- it lives in Data.gs).
- **#2 violation-date drill** (client-only): Insights Queue health violation dates render as `.ins-viol-date` chips; click -> `insJumpToDailyRow_` opens the collapsed Daily breakdown <details>, scrolls to + flashes (`.ins-daily-hit`) the day's row (daily rows now carry data-date via qcdDailyRowsHtml_ -- both modes, harmless for the all-dept modal).
- **#3 trend-point drill** (client-only): clicking a data point on any tab of the consolidated Insights trend chart re-runs Insights for that month (Monthly) or day (Daily) -- `insTrendPointDrill_` requires an actual point hit (intersect:true, the Overview-chart convention), skips the 5% threshold line + no-op when already that window, syncs form dates (agents + compare kept), runs through runInsReport (SWR/D1b). 'MMM, yy' monthly labels parsed client-side; team-daily 'MM-DD' labels re-derive year from meta.from/to. Tooltip footer advertises the drill.
- **#4 agent-row IR drill**: ALREADY IMPLEMENTED (tr[data-agent] + delegated agents-tbody click -> irDrillToAgent_ with page From/To, cursor+hover+title all present) -- verified, no change. My drilldown gap list overstated this one.
QUEUED NEXT (owner-approved, not yet built): (A) Insights cards-Chart "Gap vs team ⇄ Absolute" sub-toggle, THEN retire the Performance Report (its share pie + all data are already in Insights; the absolute stacked-volume view is the last visual); (B) IR hover-prefetch -- on ~300ms agent-card hover in Insights, fire getIndividualReport in the background + write the D1b keep-last-good store under the drill's exact signature so the drill SWR-paints instantly (do NOT blanket-preload all agents -- quota + contention).
DEPLOY: Department Dashboard only. Post-deploy smoke: heatmap cell click (admin, Insights or Inbound), violation-date chip jump, trend point click, S37/S38 unaffected paths.
Where I left off: commit+push this session; ~33 unmerged commits awaiting PR/merge + the four deploys.

## Latest session (UX consolidation: Insights edit popover + IR back-button + Missed-modal retirement)
Branch `claude/broad-scan-xkmoam`, 259/259 tests, INV-16 guard green. Client-only (script.html/dashboard.html) + CLAUDE.md sync; NO server/cache changes (`getMissedCallsReport` + `missed:v13` untouched -- the dept section still consumes them).
- **Missed Calls modal RETIRED** (owner directive: "available in its entirety on the My Department page"). Deleted: the Reports-menu Missed button, `#missed-modal` markup, `initMissedReport`/`renderMissedReport`/`renderMissedChart`/`renderQueueOnly`/`renderMissedAgents`/`clearMissedChart`/`setMissedStatus`, the modal's bucket-detail instance, the dept section's "Full report" button, the dead `missed-from/to` + `qcd-from/to` date-link pairs. KEPT (all shared builders): `missedHeadline_`, `missedChartCfg_`/bars/radar + `cdr.missed.chartmode`, `makeMissedBucketDetail_` (one instance now), `missedQueueOnlyParts_`, `missedAgentsHtml_`, journey drill. Routing: `'/report/missed'` is now `{ kind:'page', page:'dept', scrollTo:'dept-missed-section' }`; the deep-link reader dispatches tab-less page routes directly (setPage + refresh) and arms the one-shot `deptMissedScrollPending_` flag, consumed in `deptMissedRender_` after the section is revealed (scroll never races the fetch). `launcherOpenMissed_` rewritten: sets page dates to latest DQE date, opens dept page, arms the scroll. Nuance vs the modal: the modal had its OWN from/to; the section follows the page From/To (help text updated to say so).
- **Insights in-results edit popover** (`#ins-edit-popover`, mirrors IR's): dates + compare + agent list editable from the results header. Insights semantics: Apply allows EMPTY selection (= whole-dept agent-free run, INV-45; "Select none (whole department)"; Apply never disabled; pre-checks `insLastRequestedAgents_` -- the REQUESTED list, not server-resolved meta.agents -- so agent-free stays agent-free); compare defaults to 'keep' sentinel (re-resolves via the MAIN form incl. un-representable custom priors). Apply syncs back into the form then reuses runInsReport() (SWR/D1b/stale-guard). New "Showing:" editing line via `insRenderEditingLine_` (agent-free renders "Whole department (N agents)").
- **IR back-button de-confusion**: during an Insights drill the generic "« Back" (`ir-back-btn`) is HIDDEN (only "Back to Insights" shows); restored in closeModal's `irCameFromInsights_` branch. Individual tab de-starred + retitled (drill-down target framing).
- ANSWERED (no build): PR share pie == Insights donut (`insRenderShareChart_` already the port -- earlier analysis corrected); Share-view proposal moot; CR CSV per-day port described (~1h, not authorized); PR's only unported visual = Volume & Efficiency stacked bars.
DEPLOY: Department Dashboard only.
Where I left off: commit+push this session's work; ~31 unmerged commits awaiting PR/merge + the four deploys.

## Latest session (backup + health page)
Branch `claude/broad-scan-xkmoam`, commit `c278feb`, PUSHED. 259/259 tests (6 added), INV-16 guard green. NEW OAUTH SCOPE: `auth/drive` in appsscript.json (one consent run after deploy, Operator State #9).
- **NeonBackup.gs**: weekly Drive export of the NO-sheet-fallback tables. escalations = full JSONL snapshot/run (keep newest NEON_BACKUP_KEEP=8); escalation_activity + inbound_calls (incl. journeys) = monthly partition files, closed months immutable-skip, current month rewritten. string_agg(row_to_json) one-round-trip fetches (never per-row JDBC -- the 0.5s/row trap). Folder auto-created -> NEON_BACKUP_FOLDER_ID. Trigger: Saturdays NEON_BACKUP_HOUR=6. Admin install/uninstall/runNeonBackupNow; outcome -> NEON_BACKUP_LAST(_RESULT). Restore = psql/script over JSONL (documented in file header).
- **SystemHealth.gs + #health-modal** (route #/admin/health, data-admin-only Health tab): live status table replacing memory-driven use of the 28-item checklist -- pipeline freshness, Neon conf/read-source/config-source/read-back/mirror, dashboard trigger presence (alerts/digests required=warn; warm/keepwarm/watchdog/backup optional=muted) + last outcomes, Script Property presence, setup()-sheet presence. Every probe individually try/caught -> its own warn row. Hosts the backup controls. NOTE: covers the DASHBOARD project only (cdr-import/cdr-report props+triggers are per-project-unreachable; rows say so).
- Tests: system-health.test.js (backup pure helpers: nbNextMonth_/nbMonthsBetween_/nbSnapshotTrimList_; health admin gate + healthy/degraded shapes + probe-failure degradation). Shim: ScriptApp.everyWeeks/WeekDay added.
DEPLOY: Department Dashboard only + the drive-scope consent (blocks the BACKUP feature, not the deploy). Post-deploy: open Health tab -> install backup trigger -> "Back up now" to seed.
REMAINING strategic: S1(a) capture-normalization (post-vetting), S7 legacy decommission. Advisory list from the review session otherwise open (self-serve digests, escalation aging, anomaly alerts, mobile pass, Sonia canary, access-control case fix).
Where I left off: 30 unmerged commits awaiting PR/merge + deploys.

## Latest session (broad-implement: S6 Escalations Phase 2)
Branch `claude/broad-scan-xkmoam`, commit `46c01b6`, PUSHED. 253/253 tests (5 added), INV-16 guard green. Escalations stays uncached by design -- no cache bumps.
- **Status model**: `pending_review` -> (`pending` <-> `resolved`) | `rejected` (terminal). getEscalations accepts all four + 'all'; meta gains viewer-scoped `pendingReviewCount`.
- **INSERT contract for the external team-tools app** documented at the top of Escalations.gs: INSERT (id, department, occurred_at, caller, patient_name, trx, area, reason, status='pending_review', created_by, source='team-tools') directly into Neon `escalations`; NEVER write escalation_activity; NEVER UPDATE after insert (corrections = reject + resubmit). The dashboard treats these rows as UNTRUSTED at the review boundary.
- **approveEscalation** (pending_review-only): re-normalizes fields (escNormalizeReviewFields_/escClean_, ESC_MAX_TEXT caps), refuses empty-reason rows, promotes to `pending`, 'approved' activity row atomically. **rejectEscalation**: required reason -> trail, status `rejected`, data retained. Both: escAssertRowAccess_ on the ROW's dept + LockService + txn + Logger (full INV-55 mitigation set). A typo'd dept from the external app is reviewable by ADMINS (escAssertRowAccess_ admin-passes any stored dept).
- **Client**: "Needs review" accent pill + `via team-tools · submitter` provenance tag, Approve/Reject (reason-gated) card actions, clickable "N awaiting review" toolbar chip (any filter -> review queue), new dropdown options (Needs review / Rejected), review-aware empty states. No notification on external insert (dashboard can't observe Neon inserts) -- the chip is the pull signal; push is the external app's job if wanted (noted in contract).
- Tests: fake-JDBC reviewConn in escalations-hardening.test.js (promotion+normalization+atomicity, gates write nothing on refusal, reject semantics, pure normalizer); harness shim gained deterministic Utilities.getUuid.
DEPLOY: Department Dashboard only. EXTERNAL DEPENDENCY: the team-tools app must implement the INSERT contract (Escalations.gs header) -- until then the review queue is simply empty (chip hidden, zero behavioral change).
REMAINING strategic: S1(a) capture-normalization (post-vetting), S7 legacy decommission (F-25 stub awaiting dqe-report deploy; F-59/F-60 deletion-order cautions). Everything else from the scan is done.
Where I left off: 28 unmerged commits awaiting PR/merge + the four deploys.

## Latest session (broad-implement: S3/F-20 tail-scan + S5 holidays)
Branch `claude/broad-scan-xkmoam`, commit `f300ba9`, PUSHED. 248/248 tests (9 added), INV-16 guard green. NO cache bumps (S5 unset-property = byte-identical, the INV-54 precedent; S3 is read-path perf only).
- **S3/F-20** (cdr-import/NeonMirror.js): `nmReadDateRowsTail_` bounded tail-scan replaces the full-sheet read in mirrorCdrForDate_/mirrorQcdForDate_/mirrorDqeForDate_ -- bottom `NEON_MIRROR_TAIL_ROWS` (=3000, Script-Property-tunable) rows, widen x4 to full when date absent OR window-top row matches (block clipped); accepts only complete blocks -> row-identical to full scan. Old dates fall back to full read. Pinned by neon-mirror-tail.test.js (5 tests). This was the "do before enabling NEON_MIRROR_MODE=deferred long-term" prerequisite -- deferred mode is now safe to adopt (Operator State #22).
- **S5 holidays** (dashboard): `COMPANY_HOLIDAYS` Script Property (Skip-Dates grammar) -> Util.gs holiday layer (`getCompanyHolidayRanges_`/`isCompanyHoliday_`/`prevBusinessDayIso_`; `parseSkipDateRanges_`/`isDateInSkipRanges_` MOVED from Alerts.gs). Wired: countWorkingDays_ (INV-35, CR+Insights server flag), client `workingDaysBetween_` via injected `window.__COMPANY_HOLIDAYS__` (Code.gs/dashboard.html -- hint + flag can't disagree), runDailyAlerts_/runDailyDigests_ holiday-run skips (trigger-only) + shared prev-business-day walk-back (Tuesday-after-Monday-holiday covers Friday; alerts and digest use ONE walker). NOT touched (deliberate): computePriorWindow_/INV-28 window selection, WoW chips, digest weekly/monthly windows -- window SELECTION stays calendar-based; only counting/skipping is holiday-aware.
- OPERATOR: set `COMPANY_HOLIDAYS` (dashboard Script Property) with this year's dates to activate; maintain yearly. Nothing changes until set.
DEPLOY: Department Dashboard (Util/Alerts/Digest/Code.gs, dashboard.html, script.html) + cdr-import (NeonMirror.js).
REMAINING strategic: S1(a) capture-normalization (post-vetting), S6 Escalations Phase 2, S7 legacy decommission. All other scan items done.
Where I left off: 26 unmerged commits awaiting PR/merge + deploys (dashboard, cdr-report B1-3, cdr-import B1-3+S3, dqe-report F-25 stub).

## Latest session (perceived-speed: report SWR + Insights warm keys)
Branch `claude/broad-scan-xkmoam`, commit `05e4a65`, PUSHED. 239/239 tests, INV-16 guard green. Client + CacheWarm only; no cache-version bumps (no payload shapes changed).
- **Report SWR layer** (script.html, `reportSwrPaint_` riding the D1b localStorage keep-last-good store): a repeat Generate whose `reportSig_` matches the stored payload paints INSTANTLY with a visible `status-loading` note "Showing your previous result for this exact selection (from <time>) — refreshing now…"; live fetch always continues -- success repaints + clears the note (every wired repaint path resets its results-status), failure swaps it for the D1b warn. Wired: IR, PR, CR (main Generate; edit-popover keeps its own refreshing status), Inbound, Insights (ALSO gained the D1b store/fail-fallback itself), My Department table (`onData(data,{swr:true})` skips deptMissedFetch_ on the stale paint so the missed section isn't double-fetched). Overview untouched (already had SWR + ovSetCachedIndicator_). CLAUDE.md gained an SWR gotcha bullet with the indicator contract + wiring rule for new reports.
- **Warm more keys** (CacheWarm.gs): warmReportCaches_ now also warms each dept's AGENT-FREE Insights over the launcher window (last 30 days ending yesterday -- the exact request both Overview chips auto-run), LAST, under a 4-min runtime budget (INSIGHTS_WARM_BUDGET_MS) so the ~6-min trigger kill can't truncate mid-warm; skipped count logged + in the outcome line. Operator State #21 + header synced.
- OPERATOR: warming trigger must be installed (Alerts modal) for any warm to run; watch CACHE_WARM_LAST_RESULT for "insights skipped on budget" -- if chronic, raise the hour spacing or accept partial.
DEPLOY: Department Dashboard only.
REMAINING perf ideas (not built): DQE_READ_SOURCE=neon flip (biggest lever, operator-gated), localStorage multi-signature SWR history (currently last-signature-only per report), Missed-report SWR (shared modal+dept-section render paths make it fiddly), prefetch-on-modal-open.
Where I left off: 24 unmerged commits awaiting PR/merge + the four deploys.

## Latest session (S1 option-C + performance levers)
Branch `claude/broad-scan-xkmoam`, commit `0fcb426`, PUSHED. 239/239 tests (3 added), INV-16 guard green. No cache-version bumps (TTL/memo/discovery are not shape changes).
- **S1(c) DONE (owner picked option c).** Dept Config modal gains "Discovered inbound queues": `scanInboundQueueNames_` (InboundReport.gs, Neon json_agg over entry_queue+final_queue, 180d, count(DISTINCT call_id)) -> `discoverInboundQueues_`/`classifyInboundQueues_` (DeptConfig.gs) attribute each raw name via `inboundQueuesForDept_` (the report's own scoping set); unattributed-first; explicit Neon-unavailable state. INV-54 synced. Option (a) full capture-normalization deferred until after the Inbound/Direct accuracy vetting.
- **QCD sheet memo** (`QCD_SHEET_DATA_MEMO_`, per-execution): computeQcdReport_ reads the QCD sheet once per request -- the all-dept report drops from ~2 reads x N depts (~28) to 2; Insights Queue health 4 -> 2. Tests reset it per install (qcd-report, insights-report).
- **All-dept report pre-warm (owner request)**: warmReportCaches_ additionally warms getQcdAllDepartments(yesterday,yesterday) -- the exact key the modal pre-loads -- GUARDED on getLatestDataDates().qcd >= yesterday (late ingest -> skip, never pins an empty blob); `qcdAll:` TTL raised to 6h (QCD_ALLDEPT_CACHE_TTL_SECONDS -- CacheService max; trade-off documented: mid-day force re-import corrections lag up to 6h there). CLAUDE.md tiers bullet + Operator State #21 synced.
- OPERATOR: cache warming must be ENABLED for the pre-warm to run (Alerts modal -> Report cache warming -> install trigger; "Warm now" to prime immediately). Biggest remaining perf lever = DQE_READ_SOURCE=neon flip (parity gate first, Operator State #19).
DEPLOY: Department Dashboard only.
REMAINING strategic: S1(a) capture-normalization (post-vetting), S3 F-20 tail-scan, S5 holidays, S6 Escalations Phase 2, S7 legacy decommission.
Where I left off: 22 unmerged commits awaiting PR/merge + deploys (dashboard; cdr-report + cdr-import Batches 1-3; dqe-report F-25 stub).

## Latest session (broad-implement: S2 QCD retirement; S1 STOPPED for a design decision)
Branch `claude/broad-scan-xkmoam`, commit `39af0a1`, PUSHED. 236/236 tests, INV-16 guard green. insights:v17->v18 (queueHealth.unmapped signal); the per-dept `qcd:` prefix RETIRED.
- **S2 DONE (QCD->Insights consolidation).** Gap check ran first (owner request): the modal had 4 things Insights lacked -- violation-day chart markers, multi-queue legend spotlight, unmapped-dept hint + admin Dept Config CTA, own KPI layout/exports. First three CLOSED in Insights; fourth intentional (Insights has equivalent exports incl. CSV, which QCD lacked). Deleted: QCD tab, #qcd-modal, getQcdReport/getQcdReportInit/sendQcdReportEmail, ~780 lines of client code. KEPT: computeQcdReport_, getQcdAllDepartments (qcdAll:v3), queuesForDept_, both snapshots, the shared client builders (abandonForecastHtml_/qcdDailyRowsHtml_/qcdSourceSubtableHtml_/qcdDailyBarCell_/fmtViolDate_/insQhStatStrip_). #/report/qcd repoints to Insights; the Overview "abandons" chip opens Insights agent-free auto-run. Docs: INV-51 retirement banner, S32 rewritten, INV-30/31, help topics, version tables. Orphan localStorage key cdr.qcd.datalabels (harmless).
- **S1 STOPPED (queue-identity normalization at capture) -- needs an owner design decision.** Finding: the Inbound Queue Aliases config maps raw names -> DEPT (a per-dept list), NOT raw-name -> canonical-queue-name, so "normalize at capture" is ambiguous for multi-queue depts (no stored pairing exists). Also: normalizing mid-vetting changes what inbound_calls stores (pre/post rows differ -- complicates the accuracy confirmation the owner wants FIRST), journey-JSON leg names would stay raw unless also normalized, and historical rows keep raw names regardless (the read-side alias UNION cannot retire without a backfill). Options for the owner: (a) new alias->canonical PAIRING config + normalize at capture + backfill; (b) normalize only the unambiguous cases (identity + single-queue depts); (c) SKIP normalization, instead add an unmapped-INBOUND-queue discovery surface (mirror of the QCD discovery in Dept Config) so vetting can find unattributed raw names -- lightest, serves the vetting directly. Recommendation: (c) now, revisit (a) after vetting.
- Owner directive this session: Inbound + Direct reports STAY admin-gated until accuracy is confirmed (the un-gate half of S1 is off the table for now).
DEPLOY: Department Dashboard only (QCDReport.gs, InsightsReport.gs, script.html, dashboard.html). insights v17 caches TTL out within 30 min.
REMAINING strategic: S1 (awaiting the a/b/c decision above), S3 F-20 deferred-mirror tail-scan, S5 holidays, S6 Escalations Phase 2, S7 legacy decommission (F-25 stub awaiting dqe-report deploy).
Where I left off: S2 shipped + pushed (20 unmerged commits total); S1 awaiting owner decision; deploys still pending (dashboard, cdr-report, cdr-import, dqe-report).

## Latest session (broad-implement: Quick wins Q1-Q4 + S4/F-22)
Branch `claude/broad-scan-xkmoam`, commit `515f54e`, PUSHED. 236/236 tests (9 added), INV-16 guard green. TWO cache bumps synced everywhere (test-enforced): summary v10->v11, individual v10->v11.
- **Q4/F-29 follow-up (OWNER DECISION, ratified this session):** My Department totals-row ATT / Avg Abd Wait / CSR Avg Abd Wait means EXCLUDE zero rows (`avgNonzero_` in Data.gs) -- idle agents no longer drag the dept averages; the totals now use the SAME skip-zero method the per-agent accumulators use. conventions.md Totals-row spec updated. Managers will see totals-row means CHANGE (up) for ranges containing zero-value agents -- intended.
- **Q3/F-32 follow-up:** IR carries `meta.priorOverlap` + renders the inline "Windows overlap" caveat (shared `insOverlapFlagHtml_`) when a custom prior overlaps the current range -- Insights/IR parity.
- **Q2:** neon-write-mapping.test.js -- the LAST unit gap closed. neonWrite writers now pinned end-to-end (chunking + field mappings). Remaining manual: NeonMirror.js payload re-derivation only.
- **Q1/F-25:** legacy sendManualAlert neutralized to a no-send stub (stale 13-manager hardcoded map; was fireable by any spreadsheet editor). Needs a dqe-report deploy to take effect (cleanup deploy, allowed under the freeze).
- **S4/F-22:** renameHistoricalAgent_ re-verify-before-write guard -- aborts (no write, retry message) if the DQE sheet's row count or agent column changed between snapshot and write; the cross-project rename-vs-build race can no longer clobber. Mitigation, not serialization (documented in CLAUDE.md + known-issues §3). Pinned by orphan-rename-race.test.js (delete-shift + same-rowcount-cell-change + happy path).
DEPLOY: Department Dashboard (Data.gs, IndividualReport.gs, OrphanFix.gs, script.html) + dqe-report (sendManualAlert stub; cleanup deploy). cdr projects untouched this session.
REMAINING: strategic track only -- S1 queue normalization -> un-gate Inbound/Direct (next by priority), S2 QCD->Insights retirement, S3 F-20 deferred-mirror tail-scan, S5 holidays, S6 Escalations Phase 2, S7 legacy decommission (F-25 now done; F-59/F-60 deletion-order cautions remain).
Where I left off: Batches 1-6 + quick-wins all shipped + pushed; branch has 19 unmerged commits awaiting PR/merge + deploys (dashboard; cdr-report + cdr-import from Batches 1-3; dqe-report for the F-25 stub).

## Latest session (broad-implement: Batch 6 -- test debt, no production code changes)
Branch `claude/broad-scan-xkmoam`, commit `c44c825`, PUSHED. 227/227 tests (3 added), INV-16 guard green. TEST-ONLY batch -- no deploy needed.
- **Pass-4 sentinel producer** (pipeline-build.test.js): INV-23 producer side now pinned -- no-ring abandoned queue call -> ONE sentinel row (C=queue, D=exts, E-J zeros, CST slot at the QUEUE-hit leg's time, AD=no-ring parents only, AE='', AF=slots); a rung-abandoned parent stays on the agent row (no double count). Closes the audit's oldest coverage gap.
- **qcd-report.test.js** (new): F-15 daily axis (sub-queue-only date on the axis; dept total zero-fills; child per-queue line keeps its numbers; subDept tag + own-only dept total asserted) + F-36 grand-total dedup (double-mapped queue counts once company-wide, listed under both dept sections). Dept Config fixture rows drive the parent/child + double-mapped setups -- the Batch-4 deferred follow-on, now done.
- Coverage notes synced (CLAUDE.md Key Commands + Test Command blocks, tests/README.md): remaining unit gap is ONLY the neonWrite field mappings (chunking/commit pinned by neon-write-chunking.test.js since Batch 3).
DEPLOY: none (tests + docs only; nothing ships to Apps Script).
REMAINING from the scan: NOTHING in the fix batches -- Batches 1-6 complete. Strategic track only (queue-identity normalization -> un-gate Inbound/Direct, QCD->Insights retirement, F-20 deferred-mirror tail-scan, F-22 rename-vs-build race, holiday awareness, Escalations Phase 2, legacy decommission incl. F-25). Awaiting ratification: F-32 (IR overlap = current-wins) + F-29 (code-is-spec comment fix).
Where I left off: all six batches shipped + pushed; branch has 17 unmerged commits awaiting PR/merge + deploys (dashboard: F-1..F-6 + Batches 1/4/5; cdr-report + cdr-import: Batches 1-3).

## Latest session (broad-implement: Batch 5 -- Escalations hardening, F-43..F-46)
Branch `claude/broad-scan-xkmoam`, commit `448ac45`, PUSHED. 224/224 tests (5 added: escalations-hardening.test.js -- first unit coverage of Escalations.gs), INV-16 guard green.
- **F-45** `escAssertRowAccess_` replaces `assertDeptAccess_` at the 4 ROW-dept call sites (resolveEscalation / updateEscalationComment / reopenEscalation / getEscalationActivity): manager must match the row's STORED dept; admin passes unconditionally -- including rows whose stored dept was renamed/retired (assertDeptAccess_'s roster validation would have locked admins out, orphaning those rows unresolvable). Request-PARAM dept checks (getEscalations) keep assertDeptAccess_ -- input validates against real depts, row data doesn't.
- **F-43** resolveEscalation is PENDING-ONLY (reads escRowMeta_, throws "already resolved... Reopen it first" on a resolved row) -- a second resolve can no longer silently overwrite the first resolution note + resolved_by/at.
- **F-44** escCleanDateTime_ anchored + per-field range checks (mo 1-12 / da 1-31 / hh<=23 / mi,se<=59); invalid -> '' (stored NULL) per the documented contract. Old unanchored regex let '2026-01-01T99:99' / trailing garbage reach Postgres's ::timestamptz cast (opaque "Could not save").
- **F-46** getEscalations subquery capped at ESC_MAX_ROWS=500 newest (ORDER BY occurred_at DESC NULLS LAST) + meta.truncated; client escApplyFilter_ shows "showing the N most recent -- narrow by status or department" in the filter-count chip (the text filter only searches the rows that arrived).
- INV-55 synced in CLAUDE.md (row gate, pending-only resolve, occurred_at validation, row cap).
DEPLOY: Department Dashboard ONLY (`clasp push -f` + new version). No operator actions; no cache bumps (Escalations is uncached by design).
REMAINING: Batch 6 residual (Pass-4 sentinel-row producer test; F-15/F-36 QCD fixtures), strategic track (queue normalization -> un-gate Inbound/Direct, QCD retirement, F-20, F-22, holidays, Escalations Phase 2, legacy decommission incl. F-25). Awaiting ratification: F-32 (IR overlap = current-wins) + F-29 (code-is-spec comment fix).
Where I left off: Batches 1-5 all shipped + pushed; branch has 15 unmerged commits awaiting PR/merge + deploys (dashboard: F-1..F-6 + Batches 1/4/5; cdr-report + cdr-import: Batches 1-3).

## Latest session (broad-implement: Batch 4 -- report-consistency sweep, 16 findings)
Branch `claude/broad-scan-xkmoam`, commit `22c5fd7`, PUSHED. 219/219 tests (1 added), INV-16 guard green. SIX cache bumps synced everywhere (test-enforced): individual v9->v10, performance v4->v5, missed v12->v13, qcd v9->v10, qcdAll v2->v3, insights v16->v17.
- **F-35** all 7 DQE readers (IR/PR/CR/Insights/Missed/Overview/computeSummary_) + deptQueueExtsForNeonReader_: sheet hard-required only on the SHEET path; neon path tolerates a trimmed/archived sheet (empty-shape fallback, never crash). getLatestDataDate was already correct. THE blocker for ever retiring the sheet.
- **F-15/F-36/F-37** QCDReport: daily axis includes sub-queue-only dates (Insights inherits); all-dept grand total dedupes double-mapped queues (gSeenQueues); empty shape carries subQueuesSeparated/violationDates/subDept.
- **F-32** IR custom-prior overlap -> current-wins else-if (DECISION: unified on PR/Insights' F12 semantics; test pins it). **F-31** IR/PR empty shapes roster-filtered. **F-34** abandonedRings agent-only. **F-48** inbound accepts 'ALL'. **F-49** digest lock-skip notifies admins. **F-28** assertAdmin_ on runDqeParityCheck/runHistoricalBackfillCheck + signed-in gate on getLatestDataDate(s). **F-29** totals-mean comment corrected (code = spec per conventions.md -- DECISION).
- Client: **F-38** CR/Insights hints use workingDaysBetween_ (INV-35 parity); **F-39** modal drag/resize wire-once (handle re-wires per-creation -- resetModalTransform_ removes it); **F-40** ov mini-table stale token; **F-41** basePageRoute_ + escalations; **F-42** tour replay uses Help's real close; **F-47** "Last 30 assessed days" label + tooltip.
DEPLOY: Department Dashboard ONLY (`clasp push -f` + new version). No operator actions; all six bumped caches self-heal.
NOT unit-tested (fixture-heavy, noted as follow-on): F-15's sub-queue-date axis + F-36's dedup (need parent/child QCD fixtures); verify live via S32 (multi-queue dept daily chart) + the all-dept report with a deliberately double-mapped queue.
REMAINING: Batch 5 (escalations F-43..F-46), Batch 6 residual (Pass-4 sentinel test), strategic track (queue normalization -> un-gate Inbound/Direct, QCD retirement, F-20, F-22, holidays, Escalations Phase 2, legacy decommission).
Where I left off: Batch 4 shipped + pushed; branch has 13 unmerged commits awaiting PR/merge + the dashboard deploy (plus the two cdr deploys from Batches 2-3).

## Latest session (broad-implement: Batch 3 -- F-7/F-17/F-18/F-21/F-55, bulk-path hardening)
Branch `claude/broad-scan-xkmoam`, commit `f29160d`, PUSHED. 218/218 tests (4 added: neon-write-chunking.test.js, fake-conn), INV-16 guard green.
- **F-7** processBatchArchive: QCD wait cols (9/10) + CDR ST duration cols (22/23) read from the already-parallel DISPLAY grid -- bulk-archived QCD rows no longer write "Sat Dec 30 1899..." garbage into Neon longest_wait/avg_answer. NOTE: PRE-fix garbage rows in qcd_history remain (no reader consumes longest_wait today); one-off SQL cleanup or a re-import of the date self-heals via DO UPDATE.
- **F-17** processBulkQueue + standalone processBatchArchive take the script lock (per-invocation; released at pause boundaries; NOT re-entrant -> bulk passes callerHoldsLock=true). Tradeoff documented in-code: a daily INSERT_GRID during a bulk CHUNK skips with a console log (recover via Manual Processing); between chunks it runs normally.
- **F-18** bulk archive mirrors CDR to Neon (writeCDRRowsToNeon, best-effort, QCD-mirror precedent, deduped rows); completion report gains the inbound_calls "not captured -- run backfillInboundCalls()" reminder.
- **F-21** neonWrite.js (INV-16 pair): DQE/QCD/CDR-main INSERTs chunked (400/1000/500 rows) under the JDBC statement + 65,535-param caps; ONE commit per writer preserved. Fake-conn test pins chunks + single commit + unchanged daily single-statement path.
- **F-55** processNewImport non-silent failure returns "ERROR: <msg>" (runManualExport suppresses the redundant second dialog); archive alert/audit/return show POST-dedup appended counts + explicit skipped count.
DEPLOY: cdr-import (autoImport, neonWrite) + cdr-report (neonWrite -- INV-16 sync). Dashboard untouched.
VALIDATE post-deploy: one small bulk run (2-3 dates) -- confirm lock busy-alert when a manual export races it, Neon CDR mirror lines in the log, post-dedup counts in the completion alert.
REMAINING: Batch 4 (consistency Lows: F-15/F-28/F-29/F-31/F-32/F-34..F-49), Batch 5 (escalations F-43..F-46), Batch 6 (test debt F-58 -- partially started: chunking now covered), strategic track.
Where I left off: Batch 3 shipped + pushed; branch has 11 unmerged commits awaiting PR/merge + the two cdr-project deploys.

## Latest session (broad-implement: Batch 2 -- F-13/F-11/F-12/F-10/F-19/F-26/F-51/F-52, cdr-tooling data accuracy)
Branch `claude/broad-scan-xkmoam`, commit `9af11e4`, PUSHED (stacks on F-1..F-6 + sync-docs + Batch 1). 214/214 tests (5 added), extended INV-16 guard green.
- **F-13** DQEdrilldown: windows Unique/TTT/ATT (Bug 1/2 parity) + abandoned-leg wait (IVR parity) -- the verification tool agrees with the build again. Editor-tool; no unit harness (SpreadsheetApp-bound, like sheetRepairs).
- **F-11** dashboardCDR Custom Report Builder: OB-Ext duration via parallel getDisplayValues (INV-02) -- +36:36 offset gone.
- **F-12** emailDailyReport: NOON anchor replaces the DST-blind +1 day (winter PDFs were dated one day late); sheet-TZ coupling removed. Pinned by batch2-helpers.test.js.
- **F-10** inboundCallsExport: ic_cellDateIso_ display-normalized delete + max-date detection. OPERATOR: one explicit full-range `exportInboundCalls('<earliest-affected>', '<today>')` heals the existing duplicated rows (known-issues runbook updated; F-10 status flipped to Fixed in CLAUDE.md + known-issues).
- **F-19** autoImport + directCallMetrics roster reads: getLastColumn + first-blank-header stop (was hard-capped at 14 cols = current width). Test pins 16-dept grid + insurance-block exclusion.
- **F-26** dcLogSamples_ masks phones to last-4 (dcMaskPhone_/dcMaskPhonesInText_); exts/call-ids kept.
- **F-51** sanitizeSlotCellForNeon_ (NEW duplicated fn: neonbackfill.js + NeonMirror.js, guard-pinned) applied in both DQE backfills + deferred mirror + the INV-16 remirror (typeof-guarded saneSlot). Clean cells byte-identical; garbage -> NULL.
- **F-52** slot-repair PREVIEW snapshots/restores original formats (dry run no longer flips displays to bare serials).
DEPLOY: cdr-report (DQEdrilldown, dashboardCDR, emailDailyReport, inboundCallsExport, neonbackfill, sheetRepairs, buildDQE) + cdr-import (autoImport, directCallMetrics, NeonMirror, buildDQE). Dashboard NOT touched this batch.
REMAINING: Batch 3 (bulk-path: F-7/F-17/F-18/F-21/F-55), Batch 4 (consistency Lows), Batch 5 (escalations F-43..F-46), Batch 6 (test debt F-58), strategic track.
Where I left off: Batch 2 shipped + pushed; branch has 7 unmerged commits awaiting PR/merge + deploys (both cdr projects this batch).

## Latest session (broad-implement: Batch 1 -- F-9/F-14/F-16/F-8/F-50/F-23/F-24/F-56/F-33/F-27/F-30/F-61/F-62 + alerts weekend)
Branch `claude/broad-scan-xkmoam`, commit `ca60afd`, PUSHED (stacks on the F-1..F-6 batch `07fb4de` + sync-docs `e7afaf0`). 209/209 tests (4 added, 1 stale expectation fixed), INV-16 guard (now extended) green.
- **F-9** QCD modal expand: wire-once guard (`tbody._qcdExpandWired`) -- S32 regression fixed.
- **F-14** Overview "X viol MTD" chip: window filter no longer truncates MTD (`companyOverview:v17`->`v18` + docs synced; new `overview-qcd-snapshot.test.js`).
- **F-16** remirrorExistingDqeDate_ (BOTH buildDQE copies) sanitizes AD/AE/AF via `sanitizeAbandonedCellForNeon_` (typeof-guarded, null->'').
- **F-8** `rowDateIso_` serial branch formats in UTC (was -1 day for coerced numeric date cells in west-of-UTC zones); the old test pinned the bug -- corrected.
- **F-50** `dcLogPipelineHealth_` passes the event OBJECT -- the `directBuild` Pipeline Health row now writes real Step/Status/Rows/Notes.
- **Alerts weekend (F-6 class):** `runDailyAlerts_` skips weekend RUNS + assesses the previous BUSINESS day (Mon->Fri). Previously Friday's alerts fired SATURDAY and Monday skipped. INV-33 synced. NOTE for operator: Friday alert emails now arrive Monday morning (intended).
- **F-33** `sendInsightsReportEmail` rejects reversed custom prior ranges (was silently emailing prior=0/+100% reports).
- **F-27** `REPORT_USAGE_SUPPRESS_` execution flag: cache-warm runs no longer pollute Report Usage. NOTE: PRE-deploy history still contains warm rows (installing-admin email at the warm hour) -- filter when analyzing.
- **F-30** dead `ADMIN_EMAILS_DISPLAY` deleted (CLAUDE.md synced).
- **F-23** cache-version-sync now tracks qcdAll/inboundHeatmap/directCall (15 prefixes).
- **F-24/F-56** check-duplicated-files.sh: missing pair file FAILS; function-level `sanitizeAbandonedCellForNeon_` drift check added (both failure paths tested).
- **F-61/F-62** dashboard.html copy: QCD hint (retired toggle) fixed; Help "two pages"->three incl. Escalations; freshness-pill title = DQE+QCD max.
DEPLOY: all three projects -- Department Dashboard (`clasp push -f` + version), cdr-report (buildDQE), cdr-import (buildDQE + directCallMetrics). No blocking operator actions.
REMAINING from the scan (see the Batch plan in-session): Batch 2 (data accuracy: F-13 drilldown, F-10 inbound export dupes, F-12 winter day shift, F-11 +36:36 custom report, F-19 roster cap, F-26 PII logs, F-51/F-52), Batch 3 (bulk-path: F-7/F-17/F-18/F-21/F-55), Batch 4 (consistency Lows: F-15/F-28/F-29/F-31/F-32/F-34..F-49), Batch 5 (escalations: F-43..F-46), Batch 6 (test debt F-58), strategic track (queue normalization -> un-gate Inbound/Direct, QCD retirement, F-20, F-22, holidays, Escalations Phase 2, legacy decommission incl. F-25).
Where I left off: Batch 1 shipped + pushed; branch has 4 unmerged commits awaiting PR/merge + the three deploys.

## Latest session (broad-implement: broad-scan F-1..F-6)
Branch `claude/broad-scan-xkmoam`, commit `07fb4de`, PUSHED. 205/205 tests (12 added), INV-16 in sync. Preceded by a full 3-stage /broad-scan (findings F-1..F-62 in that session's report; top-5 = F-2, F-1, F-3, F-5, F-6 -- all now fixed, plus F-4).
- **F-1** IR cross-dept trend leak: `computeIndividualReport_` now applies the INV-53 `visibleAgents` filter to `trendData.datasets` too (was summaryData-only). Cache `individual:v8`->`v9` + all doc tables synced (cache-version-sync green). Test pins no-dataset-for-crafted-name.
- **F-2** AD/AE/AF lockstep (BOTH buildDQEHistoricalData copies, byte-identical): the three columns now come from ONE chronologically-sorted missed-leg list (one entry per missed leg on an abandoned parent; unpairable abandoned parents APPENDED to AD with no AE/AF partner), so the Missed report's positional AF[i]<->AD[i] pairing / "path" journey drill gets the right parent id. AD's id SET is unchanged (dept-wide unique-abandoned counts intact; sentinel rows were already lockstep). HISTORICAL rows keep the old pairing until rebuilt -- rebuild recent dates via buildDQEHistoricalData + backfillDQEHistoryUpsert() if drill accuracy on old dates matters.
- **F-3** Direct Call History refresh-delete: new `dcDateIso_` + getDisplayValues compare (Sheets coerced the M/D/YYYY strings to Dates; String(getValues) never matched -> duplicates every re-import). EXISTING duplicate rows from past re-imports are NOT auto-removed -- operator repair below.
- **F-4** getCallJourney fallback entitlement: manager fallback now requires the call id to appear in the manager's OWN dept's Missed report for that date (`callIdInDeptMissedReport_`; admin fallback ungated). Fail-closed on any error.
- **F-5** compareAlertConfigSources/compareDigestConfigSources: read sheet + Neon DIRECTLY (new `sheetAlertConfigRawValues_`/`sheetDigestConfigRawValues_` + `parseAlertConfigValues_`/`parseDigestConfigValues_` splits); Neon-unreachable -> `{clean:false, error}` instead of the sheet-vs-sheet false "PARITY CLEAN"; no more CONFIG_SOURCE property flip mid-compare.
- **F-6** Daily digest: trigger skips weekend RUNS (today's dow); `digestWindowFor_('daily')` = previous BUSINESS day (Mon->Fri; weekend manual/preview->Fri). Docs synced (Digest.gs header, CLAUDE.md INV-45, known-issues). Previously Friday's digest went out SATURDAY and Monday sent nothing.
DEPLOY: Department Dashboard (F-1/F-4/F-5/F-6) + cdr-report (F-2) + cdr-import (F-2/F-3), each `clasp push -f` + new version. OPERATOR: (1) optionally rebuild recent DQE dates + `backfillDQEHistoryUpsert()` for corrected AD/AF pairing on historical rows; (2) dedupe existing `Direct Call History` duplicate rows (delete + re-import affected dates, or a one-off repair -- new writes self-heal per date on next build); (3) daily digest subscribers will notice delivery moving from Sat to Mon (intended).
Follow-ons (from the same broad-scan, NOT implemented): F-7..F-62 -- notable next: F-9 QCD expand dead listener, F-14 Overview MTD undercount, F-16 remirror sanitizer bypass, F-23/F-24 guard gaps.
Where I left off: F-1..F-6 shipped + pushed on `claude/broad-scan-xkmoam`; awaiting PR/merge + the three deploys + operator actions.
## Latest session cont'd (broad-implement #2 option a + #1 solo-toggle)
Same branch `claude/broad-scan-je9ga7`. Commit d1097e2 (#1) + a doc-sync commit (CLAUDE.md S23/design-decision). 193/193, balanced.
- **#2 = option (a) = NO-OP:** owner chose to leave the 0-metric cards as-is (correct-but-quiet: dept had no activity on the single latest date while the 30-day sparkline shows history). No code.
- **#1 SHIPPED:** Overview dept-tile click now SOLOS that dept's line on the 30-day trend chart instead of navigating. Refactored the spotlight model from a single `chart._spotlightPinned` index to a `chart._spotlightPins` set (`chartSpotKey_`/`chartSpotlightStash_`/`chartSpotlightHasPins_`/`chartSpotlightApplyPins_`/`chartSpotlightTogglePin_`). Legend onClick + tile onClick both call `chartSpotlightTogglePin_(chart, key, additive)`; Shift/Cmd/Ctrl-click = additive (compare 2+). Pinned tiles get `.ov-tile-soloed` via `ovSyncTilePins_` (guarded to `chart === ovChartInstance` so the QCD chart reusing these helpers isn't cross-contaminated). NAVIGATION now via chart POINT click (`ovHandlePointClick_`→`ovRouteToDept_`) or the dept-selector dropdown. CLAUDE.md S23 + the multi-page design-decision text updated.
- **STILL QUEUED:** #7 YTD Overview chart tab (server trend expansion + cache bump + tab UI); #11b (what the 12-mo Answered chart measures for Power — needs live numbers); #9-Spanish (re-verify after redeploy).
- **PENDING:** PR + merge for the accumulated on-branch commits — GitHub MCP was disconnected/needs auth at end of session.

## Latest session cont'd (batch 4: #10, #5, #12 + #2/#11b investigation)
Same branch. Commits ed74b3d (#10+#5), d9d3106 (#12). 193/193, balanced.
- **#10:** Reports dropdown → `data-admin-only`; managers (+ admins in view-as) get a solo `#insights-solo-btn` proxying to the dropdown's launcher. Wired in init (non-admin reveal) + applyViewAs_ (view-as toggle).
- **#5:** Overview "abandons" question chip repointed QCD → Insights.
- **#12:** heatmap already has rich native-title hover (abandoned/total per cell); added a subhead hint + margin-bottom gap. (Did NOT use `.gloss` — its ::after circled-i would clutter every cell.)
- **#2 INVESTIGATED (not fixed — needs UX decision):** cards show 0 metrics + a sparkline because the headline uses ONLY the global `latestDate` (`latestDay`, CompanyOverview.gs:385) while the sparkline uses the whole 30-day `trendByDate`. Depts with no activity ON the latest date (Manual Mobility / Eligibility MM&R / Field Ops Power / Denials) read 0 but show recent history. Correct-but-confusing. FIX OPTIONS to ask: show 0 / "quiet on <date>" note / each dept's own last-active day.
- **#7 DEFERRED (bigger):** YTD Overview chart tab needs a server trend expansion (~180+ days × 14 depts) + cache bump + tab UI.
- **STILL QUEUED:** #1 Overview card→solo/Shift-multi-select chart toggle (big, NOT started); #7 YTD; #2 fix (pending UX decision); #11b (what the 12-mo Answered chart measures for Power — likely DQE per-agent answered summed monthly, needs the actual numbers to confirm the mismatch); #9-Spanish (RE-VERIFY after redeploy of the #8 fix — if Power's queue-only section still shows Spanish, scope it to queuesForDept_).

## Latest session (broad-implement: big deploy-feedback batch — 4 commits)
Branch `claude/broad-scan-je9ga7` (restarted from merged main after PR #142). 193/193 tests, INV-16 in sync, braces/divs balanced. Commits: be9569a, f5b31fc, 01ee847, b22a837 (pushed, NOT PR'd).
- **#8 view-as/nav stale dept (be9569a):** `setPage('dept')` now reloads when the painted dept (`lastSummaryDept_`) != requested dept (guarded vs double-load via the disabled refresh btn); `ovRouteToDept_` simplified. Fixes My-Dept nav + view-as click showing a stale wrong-dept table/Missed/QCD until Refresh.
- **Insights categorization #11c/d/a (f5b31fc):** new `insClassifyAgent_` (STANDING-first: current %answered vs 92% target + 5-ring volume gate → strong/steady/attention) drives the card rail + triage tiers; `deltaClassify_` (trend) becomes the secondary trend pill. Tiers relabeled Strong/Steady/Needs attention. Positive Insights-banner mark ↑ green (`--good`) not blue. Client-only, no cache bump. deltaClassify_ unchanged for Compare Ranges.
- **Small tweaks (01ee847):** #6 removed the redundant Overview "Data through … Rung …" summary line (ovRenderSummaryLine_ hidden no-op); #9 "Queue-only abandoned" gloss tooltip (both surfaces); #11e delta-chip hover tooltip (insDeltaBadge_); #4 sticky `.agents thead th` given an opaque bg (was transparent → rows showed through = the all-dept "gap").
- **All-dept report #3 (b22a837):** nest sub-queues under parent banner (server `parent` per dept + raw longestWaitSec/avgAnswerSec; client groups + computes section total); "(dept) total" row only when section >1 queue; exclude A_Q_Intake + Backup CSR (`QCD_ALLDEPT_EXCLUDE_QUEUES`, owner-asserted roll-ups); abandon% >5% bold on the bar + source lines; CSV gains Sub-dept col. Cache qcdAll:v2→v3; INV-51 updated.
- **DECISIONS captured this session:** #11c standing-first, #11d Strong/Steady/Needs-attention, #5 repoint chips to kept reports, #6 remove line (done), #7 add YTD (queued).
- **STILL QUEUED (not built):** #1 Overview card→solo/Shift-multi-select chart toggle (big); #7 YTD tab on Overview chart; #10 managers get an Insights button instead of Reports dropdown; #12 heatmap↔chart gap + richer cell hover; #5 repoint question chips to Insights/Missed/Individual. **INVESTIGATIONS:** #2 dept cards with 0 metrics but a mini-chart (Manual Mobility/Eligibility MM&R/Field Ops Power/Denials — likely QCD data but no DQE agent rows); #9-Spanish (verify after the #8 fix loads correct dept; if Spanish still in Power's queue-only section, scope it to `queuesForDept_`); #11b what the 12-mo "Answered" chart measures for Power.
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions; qcdAll:v3 self-heals. Where I left off: 4 batches shipped on-branch (unmerged); awaiting redeploy + a PR/merge and/or "continue" for the queued items.


## Latest session (deploy feedback batch: diagnostics gate, total-to-top, missed-chart, view-as bugs, all-dept report overhaul)
Branch `claude/broad-scan-je9ga7` (restarted from merged main after PR #141). 193/193 tests, INV-16 in sync, braces/divs balanced. Commits `e858812` (fixes) + `7b1547a` (all-dept overhaul). NOT yet PR'd.
- **Diagnostics admin-gate:** `renderDiagnostics` early-returns for non-admins; `#diagnostics` got `data-admin-only` so view-as preview hides it too.
- **Totals row moved to TOP** of the My-Dept agent table + Overview mini-table: the `<tfoot>` became a `<tbody class="agents-totals">` above the data rows (tfoot always renders bottom); CSS retargeted `.agents .agents-totals td` (divider below). JS writes same id.
- **Missed bars width (root cause):** `#dept-missed-chart-row .chart-section {max-width:480px}` ID rule out-specificity'd the `.mode-bars` 760px rule -> scoped `:not(.mode-bars)`. Peak outline 3px->2px.
- **View-as click-through (#5):** `ovRouteToDept_` now forces `refresh()` when the selector was already on the clicked dept (pinned+disabled in view-as) -- `setPage('dept')` doesn't load the table itself, so stale data persisted. FIXED.
- **#6 Daily Call Queue Report -> open to all managers** (owner decision): `getQcdAllDepartments` `assertAdmin_` -> signed-in check; button no longer `data-admin-only`. INV-51 + S32 synced.
- **#1 all-dept report overhaul:** pre-loads yesterday on open; in-modal date changer (preset+from/to+Update, re-gen in place, form/Generate/Back retired); Answered/Abandoned/Abandoned% -> split bar (`qcdDailyBarCell_`); per-queue rows expand into data-driven `bySource` + violation dates (server adds bySource+violationDates; `qcdAll:v1->v2`).
- **OPEN -- #4c (Spanish in Power's missed report, view-as):** queue-only section includes a queue whose exts overlap the dept's ROSTER-derived ext set; Spanish appears in Power only if a Power roster agent (maybe the admin) bridges to Spanish. Likely a staleness artifact of the #5 bug OR a roster-overlap data issue -- OWNER TO RE-TEST after redeploy; if it persists, confirm whether a Power roster agent takes Spanish overflow / admin is on Power's roster before any code fix (don't break legitimate overlap).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions; qcdAll:v3 self-heals. Where I left off: batch shipped on-branch (unmerged); awaiting redeploy + #4c re-test + a PR/merge request.

## Latest session (broad-implement: QCD-parity #1 secondary metrics + #2 short-window presets)
Branch `claude/broad-scan-je9ga7`, commit `cf5f205`. 193/193 tests, INV-16 in sync, braces/divs balanced. NOT yet PR'd (stacks on the prior unmerged deploy-feedback commits).
- **#1 secondary queue metrics (Answered / Longest wait / Avg answer):** passed through `insightsQueueHealth_` (`totalAnswered` on totals; `totalAnswered`/`longestWait`/`avgAnswer` on each perQueue row -- all already on computeQcdReport_'s queueBreakdown, just dropped before). Surfaced WITHOUT new headline tiles/columns: a muted dept-total secondary line (`#ins-qh-secondary`) under the tiles + a stat strip atop each per-queue EXPAND (every queue row is now expandable, not only ones with sources/violations). Shared `insQhStatStrip_`. Cache insights:v15->v16 (INV-30 + docs + cache-version-sync synced). Test pinned.
- **#2 short-window presets:** added Yesterday / This week / Last week to the Insights Quick-select (`ins-preset` + `insApplyPreset` handler) for the agent-free queue/dept quick-look. **Single-day daily-chart hiding was ALREADY handled** -- the consolidated trend chart gates its Monthly/Daily toggle on `labels.length > 1`, so a single-day window already hides Daily + forces Monthly (no code change).
- **#3 all-departments report:** owner + I agreed NO porting -- it's a company-wide admin surface that survives QCD retirement (getQcdAllDepartments is already independent of getQcdReport; just keep the Overview `#ov-qcd-alldept-btn` wired when the QCD tab is removed).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions. Where I left off: #1+#2 shipped on-branch (unmerged). Remaining QCD-retirement prereqs now: only the QCD image-export + the standalone all-dept button rewire (both minor), then the retirement itself (repoint /report/qcd -> Insights, delete QCD tab/modal/getQcdReport). Awaiting redeploy + a PR/merge request.

## Latest session (deploy feedback: missed-chart polish + Insights daily bar + roster-only Insights)
Branch `claude/broad-scan-je9ga7` (restarted from merged main after PR #140). 193/193 tests, INV-16 in sync, braces/divs balanced. Commits `10d0fa2` (UI polish) + `2ee9bc1` (roster-only Insights). NOT yet PR'd.
Four items of live-deploy feedback from the owner:
- **Missed bar chart (item 1):** abandoned-aware color (buckets containing an abandoned ring = solid warn red, still volume-ramped; abandoned-free = faint semi-transparent) via a NEW server-side per-bucket `chart.abandoned` array (missed cache v11->v12); peak outline 1.5px->3px; wider bars (a `mode-bars` class lifts the 520px radar cap to 760px + aspect 1.05->1.4; radar keeps its cap). `missedSyncToggles_` now also tags each chart-row mode-bars/mode-radar (called from both render paths).
- **Call-path chip (item 2 layout):** long numeric parent-id truncates (ellipsis, max ~7ch) with full value in the hover title; 📋/↳ still use the full id. Stops overrun onto the agent name.
- **Insights Daily breakdown (item 3):** Answered/Abandoned/Abandoned% folded into one green/red split bar (reuses `.ans-bar`; 5% bench tint) via `qcdDailyRowsHtml_(rows,{bar:true})` (QCD modal's numeric table unchanged). Violation dates -> MM-DD-YY via shared `fmtViolDate_` (applied in Insights + the QCD modal detail).
- **Insights roster-only (item 4):** owner confirmed the cross-dept agents carried QUEUE chips (queue-only floaters, e.g. CSR transferring into Service). `computeInsights_` `visibleAgents` now roster-only (floaters dropped from agentData; teamStats/trend already roster-gated so unchanged; queueOnlyAgentCount always 0); the Insights picker no longer offers the floater group. IR/PR/CR still surface floaters (INV-53) -- same split as My Department. insights cache v14->v15.
- **Items 2-data (path button "no results") + 6 (empty heatmap):** BOTH scope by the dept's mapped queue names against `inbound_calls` (the INV-54 two-name-space bridge). Owner's call: "likely no inbound data" for Service -- LEFT AS-IS, revisit if a known-abandoned Service call still shows no path (then check inbound_calls entry_queue/final_queue vs `inboundQueuesForDept_('Service')` and add Inbound Queue Aliases in Dept Config).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator actions. Where I left off: all four feedback items shipped on-branch (unmerged); awaiting redeploy + a PR/merge request. Still-open follow-up = the deferred Phase 2 QCD RETIREMENT (repoint /report/qcd -> Insights + delete the QCD tab/modal/getQcdReport, after prod validation).

## Latest session (broad-implement: QCD->Insights consolidation Phase 2 PARITY — heatmap + agent-free run)
Branch `claude/broad-scan-je9ga7`, commit `c7b6b06`. 193/193 tests pass, INV-16 in sync, script.html braces balanced (0 diff), dashboard.html divs balanced (0 diff).
- **Scope decided WITH OWNER (AskUserQuestion):** "Parity only, keep QCD" + agent-free render = "Full roster (digest pattern)". So this session landed the additive parity (gaps 4 + 6) and KEPT the QCD tab/modal/getQcdReport for parallel-run prod validation (parity-first house style, INV-51). The `/report/qcd` repoint + retirement are explicitly DEFERRED to a post-validation follow-up.
- **Gap 5 (export) was already DONE** — `insCopyImage_`/`insEmailReport_`/`insPrint_`/`insDownloadCsv_` all wired (corrects the prior `.cycle` note that listed it as pending). No work.
- **Gap 4 — heatmap:** new `#ins-heatmap` container in dashboard.html (after the Queue health section) + a `loadAbandonHeatmap_('ins-heatmap', meta.department, meta.from, meta.to)` call in `insRenderReport_` (after `insRenderQueueHealth_`), reusing the shared `getInboundHeatmap`. Admin-gated `if (USER.role==='admin')` exactly like the QCD heatmap; else-branch hides the panel for managers. Insights meta already carries department/from/to (both the data + empty paths).
- **Gap 6 — agent-free run:** new shared `resolveInsightsAgents_(rawAgents, roster)` in InsightsReport.gs — dedups/trims a non-empty selection BYTE-EQUIVALENTLY to the loop it replaced, and defaults an EMPTY selection to `roster.names` (the digest pattern, INV-45; floaters excluded since only roster seeds the default). Both `getInsightsReport` AND `sendInsightsReportEmail` use it (the only remaining throw is a genuinely empty roster: "No agents on this department's roster."). Client: `insUpdateGenerate` now enables Generate whenever the roster has ≥1 agent (checked or not, via `.ir-agent-cb` count) instead of requiring a check; the empty-selection guard in `runInsReport` removed; the `2. Agents` picker hint advertises "leave all unchecked to see the whole department (queue / dept view)".
- **NO cache bump** — `meta.agents` already carried the resolved selection, so agent-free is byte-identical to explicitly selecting the full roster (deterministic per `hashAgents_` key). insights:v14 unchanged.
- **Tests:** the `sendInsightsReportEmail` empty-agents double (encoded the OLD throw) updated to assert it now SENDS over the full roster; new positive test pins agent-free `getInsightsReport` meta.agents == full roster == explicit full-roster teamStats.
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions. **Where I left off:** Phase 2 PARITY shipped + pushed (c7b6b06). REMAINING = Phase 2 RETIREMENT (owner deferred until prod-validated): repoint `/report/qcd` → Insights (ROUTES_ registry, one entry), delete the QCD tab (`#qcd-report-btn`)/modal (`#qcd-modal`, ~163 lines)/`getQcdReport` RPC/`qcdRenderReport_` (~450 lines) — KEEP `computeQcdReport_`, `getQcdAllDepartments`, `computeQcdSnapshots_`, `computeDeptQcdSnapshot_` (all independent of `getQcdReport`, confirmed). That step breaks S32 + needs a deep-link deprecation note.

---

## Latest session (broad-implement: QCD->Insights consolidation Phase 1 — gap 1, tri-metric by-queue chart)
Branch `claude/broad-scan-je9ga7`. 192/192 tests pass, INV-16 in sync, script.html/dashboard.html braces balanced.
- **Gap 1 (option ii — one "By Queue" tab + a metric sub-selector):** completes the data+chart superset. The Insights consolidated trend chart's queue tab (renamed "Abandoned % by Queue" -> "By Queue") now plots Abandoned % / Total Calls / Violations via a `#ins-queue-metric` `<select>` (shown only on that tab). Abandoned % stays the default (5% threshold line + % formatting); Total Calls / Violations are integer counts (no threshold line). Server `insightsQueueHealth_.trend` gained `metrics: { totalCalls, violations }` (monthly+daily, per queue + own dept total), parallel to the default abandoned-% series (refactored via generic per-field extractors; the abandoned-% fields are byte-identical, so the forecast + existing path are unchanged). Client: `insQueueMetric` state (persisted in prefs `cdr.ins.prefs.v2` as `queueMetric`), sub-selector handler + visibility toggle in `insRenderTrendChart_`, the `isQueues` branch parameterized by metric (% vs count formatting, conditional 5% line). Cache `insights:v13`->`v14` (+ all doc/comment refs synced; cache-version-sync green). Test extended (trend.metrics totalCalls/violations daily series; used `.join(',')` not deepEqual -- harness vm-realm arrays trip deepStrictEqual's prototype check).
- **Consolidation status:** Phase 1 COMPLETE (gaps 1+2+3) -- Insights Queue health is now a strict data+chart superset of the QCD modal's per-dept view. REMAINING = Phase 2: the UX-model change (render Queue health regardless of agent selection -- owner already approved) + gaps 4-7 (heatmap, image/email export, QCD date-defaults/agent-free run, `#/report/qcd` routing/nav), then retire the QCD tab/modal/getQcdReport (keeping computeQcdReport_, getQcdAllDepartments, computeQcdSnapshots_, computeDeptQcdSnapshot_ -- all independent).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions; insights:v14 cache self-heals. Where I left off: Phase 1 fully shipped; Phase 2 is the next consolidation step (start with the agent-free Queue health render + gap 4 heatmap).

---

## Latest session (broad-implement: QCD->Insights consolidation Phase 1 — gaps 2 & 3 + My-Dept QCD card tooltip)
Branch `claude/broad-scan-je9ga7`. 192/192 tests pass, INV-16 in sync, script.html/dashboard.html braces balanced.
- **My-Dept QCD card tooltip (decision C):** the "Queue Call Data" side-card always shows the latest QCD day (computeDeptQcdSnapshot_ is range-independent -- QCD can update on a different day than DQE, and the range defaults to latest DQE, so anchoring avoids an empty card). Added a native tooltip + help cursor on the card title clarifying it's the most recent queue day, independent of the range. Client-only, committed `eb1a8f3`.
- **QCD->Insights consolidation Phase 1 (gaps 2 & 3 of the 7-gap parity list):** make Insights Queue health a DATA-superset of the QCD modal's tables.
  - **Gap 3 (daily table):** `insightsQueueHealth_` now returns `dailySeries` (the per-day QCD rows, dept-OWN queues, range-scoped); client renders a collapsed "Daily breakdown" `<details>` table in the Queue health section (`#ins-qh-daily`/`#ins-qh-daily-tbody`) via the new shared `qcdDailyRowsHtml_`.
  - **Gap 2 (bySource subtable):** `insightsQueueHealth_` perQueue rows now carry the full `bySource` array; Insights queue rows became expandable (chevron + detail row) showing the same per-call-source subtable the QCD modal shows, via the new shared `qcdSourceSubtableHtml_` (extracted from the QCD modal's inline block; QCD modal refactored to use it -- byte-identical output). Violation dates moved off the inline cell `<details>` into the row expand (QCD-modal parity).
  - Cache bumped `insights:v12`->`v13` (+ all doc/comment refs synced: InsightsReport.gs, architecture.md, known-issues.md table, conventions.md table, CLAUDE.md x3 incl. INV-30; cache-version-sync test green). insights-report.test.js extended (dailySeries + bySource pass-through assertions).
- **DEFERRED -- Gap 1 (tri-metric queue chart):** STOPPED & flagged per broad-implement rules. The Insights consolidated trend chart's "Abandoned % by Queue" tab is abandoned-%-specialized (5% threshold line, %-formatting throughout). Adding Total Calls / Violations per-queue needs: (a) generalizing that shared chart branch by metric, (b) server `trend` series for the 2 new metrics, and (c) a UX decision -- 3 extra top-level tabs vs a metric sub-selector within the queue view. Higher regression risk to the existing working tabs + a UX call that's the owner's. NOT started; awaiting direction on the UX shape.
- **Consolidation remaining after Phase 1:** Gap 1 (above) finishes the data/chart superset. Phase 2 = the UX-model decision (render Queue health regardless of agent selection -- owner ALREADY approved) + gaps 4-7 (heatmap, export, date-defaults, `#/report/qcd` routing), then retire the QCD tab/modal/getQcdReport (keeping computeQcdReport_, the all-dept report, and both snapshot paths -- all independent).
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions; insights:v13 cache self-heals. Where I left off: Phase 1 gaps 2&3 shipped; gap 1 awaiting the tabs-vs-subselector UX decision.

---

## Latest session (broad-implement: P3 — My-Dept QCD snapshot own-canonical total)
Branch `claude/broad-scan-je9ga7`. 192/192 tests pass, INV-16 in sync, script.html braces balanced (parens -1 pre-existing on HEAD).
- **P3 (from this cycle's /broad-scan):** the My Department "Queue Call Data" snapshot's all-queues total folded sub-queue children in, contradicting the QCD modal + Overview (own-queues-only) -> same parent dept (Sales/Power/CSR) showed different dept-level violations/abandoned% across surfaces. FIX: `Data.gs::computeDeptQcdSnapshot_` now decomposes own (main) vs sub-queues; the UNQUALIFIED dept total (`totalCalls`/`abandonedPct`/`violations`) is OWN-only (reconciles cross-surface), with new `subTotals`/`allTotals` (null when no sub-queues) + `mainQueueCount`/`subQueueCount`. Client `renderDeptQcdSnapshot_` renders GATED carousel pages: Main queues (only >1 own), Sub-queues (separate depts) (only >1 sub), All queues (incl. sub-queues) (only when sub exist) -- single-queue depts unchanged. Cache bumped `summary:v9`->`v10` (+ all doc/comment refs synced: OrphanFix.gs, known-issues.md x2, conventions.md, architecture.md, CLAUDE.md INV-30/INV-51; cache-version-sync test green). Test `insights-report.test.js` updated to the own-canonical shape (+ sub/all/count assertions).
- **DEFERRED (follow-on, owner-flagged):** the QCD MODAL still shows only the own "Department total (own queues)" + separated child rows -- NOT a pre-summed All-queues row. Adding consistent Sub/All rows there needs a `computeQcdReport_` extension (per-group MTD violations via `computeMtdViolations_` + volume-weighted avgAnswer + max longestWait) + a `qcd:v10`->`v10` bump, which touches the shared engine Insights depends on -- out of proportion to the P3 defect, so split out. My-Dept fix alone removes the silent mismatch.
- **Consolidation context (no code):** earlier this session examined QCD Report -> Insights consolidation feasibility (shared `computeQcdReport_` engine; ~70% already in Insights Queue health; 7 UI-porting gaps, one M [tri-metric chart] + six S; UX decision = render Queue health regardless of agent selection, owner-approved). Not started.
DEPLOY: Department Dashboard only (`clasp push -f` + new version). No operator/env actions. Where I left off: P3 shipped on branch; awaiting the QCD-modal-symmetry follow-on decision + the broader consolidation go-ahead.

---

## Latest session (feature build: #3 call-path drill-through + #5 onboarding tour)
Branch `claude/brave-dijkstra-wuonrv`. 136/136 tests, INV-16 in sync, divs/braces balanced.
- **#3 Inbound-call path drill-through** (commit 081491b): `InboundReport.gs::getCallJourney({callId,date,department})` returns one call's journey by (call_date, call_id); per-dept gated + scoped by `inboundDeptPredicate_` (manager only sees own-dept calls). Client "↳ path" button on abandoned 🚨 rings (Missed report + My Dept missed section) -> `#call-journey-overlay`, rendered via the reused Caller Lookup renderers (clChainHtml_/clJourneyRowHtml_). Scoped to abandoned calls (which carry a parent id); Insights/QCD aggregates don't expose per-call ids.
- **#5 Onboarding tour** (this commit): client-only coachmark walkthrough (`initTour_`/`startTour_` + `.tour-*` styles). Spotlight via box-shadow dim; 7 steps anchored to stable IDs (missing/hidden targets skipped); reduced-motion aware. Auto-runs once for first-time visitors (localStorage `cdr.tour.done`, Overview only) + replayable from Help -> Guided tour.

DEFERRED still: workday-ALIGN the prior window (vs flag-only); Escalations Phase 2 (team-tools queue); inbound-journey drill for Insights/QCD (no per-call id there). DEPLOY: Department Dashboard only (#3 + #5). #3 needs a live Neon smoke test (abandoned ring -> ↳ path -> journey renders).

---

## Latest session (feature build: working-day mismatch flag + Escalations + View-as)
Branch `claude/brave-dijkstra-wuonrv`. 136/136 tests pass, INV-16 in sync, divs/braces balanced.
- **A — Working-day mismatch flag** (commit f5688b0): shared `Util.countWorkingDays_`; CR + Insights flag on Mon-Fri days not calendar days (no more false mismatch on equal-workday windows). Holidays deferred (no global source). Cache bumps compareRanges:v6 / insights:v12 + INV-30/INV-35 + tests.
- **B — Escalations module Phase 1** (commit 9ec3b62): Neon `escalations` table; `Escalations.gs` (getEscalationsInit/getEscalations read, createEscalation admin-only, resolveEscalation/updateEscalationComment = the FIRST per-dept non-admin write path, INV-55). Header tab + modal, admin-only create form, pending/completed filter, mandatory-resolution UX. Deploy-verified (JDBC; no unit harness). Needs dashboard NEON_* + script.external_request.
- **C — View-as-Manager** (this commit): admin "View as <dept>" header control; `getCompanyOverview(req.viewAsDept)` personalizes as a synthetic manager (admins only, safe — only hides); `body[data-view-as]` CSS hides admin chrome; dept selector pinned; SWR cache bypassed in preview. No INV-30 bump (post-cache personalization).

DEFERRED (decided but not built this session): inbound-journey drill-through for abandoned calls (#3, ready); onboarding tutorial (#5, ready); workday-ALIGN the prior window itself (vs just the flag); Escalations Phase 2 (team-tools pending_review queue). DEPLOY: Department Dashboard (all three) + cdr-report (none) -- A/C dashboard-only, B dashboard-only. Escalations + View-as need a live Neon/deploy smoke test.

---

## Latest session (broad-implement: Tier 2 — F25, F13, F12, F9, F11)
Branch `claude/brave-dijkstra-wuonrv`. 135/135 tests pass, INV-16 in sync.
- **F25** dashboardCDR.js: `idxOr` helper (fixes the `|| dflt` index-0 trap) + a warning logging any missing/renamed CDR Historical Data list-columns that would otherwise silently report a metric as zero. Detection only; aggregation unchanged.
- **F13** Auth.gs `getManagerDepartment_`: scans all Access Control rows and logs a warning when a manager matches >1 dept (only the first is honored — managers are pinned to one dept). Behavior unchanged for single-row managers; makes the truncation detectable.
- **F12** InsightsReport.gs + script.html: new `meta.priorOverlap` flags a CUSTOM prior window overlapping the current range (overlapping days count toward current only); client renders an inline "Windows overlap" caveat. Cache bumped `insights:v10`→`v11` (response shape change) + doc sync. New regression test.
- **F9** buildDQEHistoricalData.js (BOTH copies, byte-identical): counts queue legs whose START_TIME is present-but-unparseable (dropped from in-window counts) and surfaces the count in the final `buildDQE` Pipeline Health note — was silent shrinkage on a CDR format drift.
- **F11** OrphanFix.gs `renameAgentInNeon_`: wraps the rename in an explicit transaction (atomic, rollback on error) and computes the conflict-skip count EXACTLY (rows still under the orphan name after the rename) instead of a racy pre-count subtraction.
Deploy: Department Dashboard (F12/F13/F11) + cdr-report (F25/F9) + cdr-import (F9). No blocking operator actions.

---

## Latest session (broad-implement: Tier 1 observability — F5, F6, F8, F29; F7 deferred)
Branch `claude/brave-dijkstra-wuonrv`. 134/134 tests pass, INV-16 in sync.
- **F29** NeonRead.gs + NeonKeepWarm.gs: `getDashboardNeonConn_(opts)` gains `skipReadHealth`; keep-warm passes it so a warm-ping failure no longer writes the DQE read-back failure streak (was a sticky false "read-back FAILING" on the sheet path).
- **F5** autoImport.js + CompanyOverview.gs: the integrated `:DQE` block now logs a rows:0 `success` row on a no-op build (already-in-history / no new data / F2 refusal), so "ran-empty" is distinct from "didn't run"/"failed". `computeOverviewPipelineFreshness_` now requires `rows>0` so a no-op can't falsely reset the 36h staleness clock.
- **F6** Data.gs `getLatestDataDates`: only caches a result computed WITHOUT a thrown error (was pinning a null/partial freshness blob for the full TTL on a transient read error).
- **F8** InsightsReport.gs + script.html: `insightsQueueHealth_` returns `{error:true}` on a genuine compute error (vs `null` for unmapped / missing-QCD-sheet, both benign); client renders a "Queue health unavailable" note instead of silently hiding. Missing-sheet pre-check keeps fresh installs benign (pinned by the existing test).
- **F7 DEFERRED**: on close reading the admin-facing detection already exists (`recordNeonReadFailure_` fires on every Neon read-error path; surfaced by the read-back health line) and gross staleness is caught by the 36h pill. The only residual is a MANAGER-facing "served from sheet fallback" banner = M-scope product UX across all report headers; deferred, not forced.
Deploy: Department Dashboard (F5/F6/F8/F29) + cdr-import (F5). No blocking operator actions.

---

## Latest session (broad-implement: F1–F4, F10, F24)
Branch `claude/brave-dijkstra-wuonrv`. Implemented six broad-scan findings; 134/134 tests pass, INV-16 in sync.
- **F1** InsightsReport.gs: `meta.rosterAgentCount` now = roster members ACTIVE in the current window (INV-27), not all selected roster. `queueOnlyAgentCount` derived independently. Cache bumped `insights:v9`→`v10` (+ doc sync in CLAUDE.md/known-issues/conventions/architecture). New regression test added.
- **F2** buildDQEHistoricalData.js (BOTH copies, byte-identical) + autoImport.js: build refuses to write when `opts.expectedDate` (the importer's date) ≠ Raw-Data-derived date; daily + bulk call sites pass `expectedDate: dateObj`. Standalone trigger unaffected (no opts).
- **F3** NeonMirror.js: deferred DQE mirror now routes abandoned cols 29-31 through a local byte-identical `sanitizeAbandonedCellForNeon_` (+ `#REBUILD` sentinel) — matches neonbackfill.js.
- **F4** Alerts.gs + script.html: invalid-threshold dept rows no longer silently dropped — flagged `invalidThreshold`, logged as `error` Alert Log rows, drift-skipped, and shown as "⚠ invalid" in the modal config table.
- **F10** script.html: shared `reportReqSeq` stale-response guard on all 6 IR/PR/CR/Insights fetch sites (button always resets; render skipped if superseded).
- **F24** DQEdrilldown.js: drill-down canonicalizes Raw Data col-L names via `loadRosterCanonicalNames_` before matching the canonical DQE agent name.
Deploy: Department Dashboard (F1/F4/F10) + cdr-import (F2/F3) + cdr-report (F2/F24). No blocking operator actions; insights cache self-heals on deploy.

---


**Branch:** `claude/dazzling-heisenberg-2png1z` · working tree has uncommitted design Phase 1 changes
**Verify on resume:** `node --test` (132 pass) + `bash scripts/check-duplicated-files.sh` (INV-16 in sync)

> Prior session's F1–F6 bug-fix work was **merged via PR #83** (commit `06639f5`),
> so the earlier "not yet committed" note is superseded. This is a new work-stream:
> the Claude Design package redesign (`docs/design-package/`), planning + Phase 1.

## What shipped this session (NOT yet committed/pushed)
Design-package planning + **Phase 1 foundation** (additive, zero behavioral change):
- **Plan of record:** `docs/design-update-plan.md` — full conflict register (C1–C8),
  decisions, and the phased sequence. Decisions: keep `--r:2px` (C1-A), binary
  thresholds only (C2-A), keep `data-mode` dark (C3-A), chart factory yes / SRI-restore
  no (C4-A), wire to `getDepartmentSummary` not `computeSummary_` (C5), adopt SWR with
  per-viewer guardrails (C6-A), consolidation parked (C7), nav deferred (C8-A).

**Separate work-stream this session (NOT redesign):** added a DQE Historical Data TZ repair to
`cdr-report/sheetRepairs.js` — `previewDqeOldPstTimestampShift()` / `repairDqeOldPstTimestampShift()`.
Old rows (Date < 2026-03-09) stored slot/AF missed-times in PST; current pipeline stores CST (+2h).
Repair shifts K-AC (11-29) + AF (32) time-of-day strings +7200s, date-gated AND per-row PST-window
validated (re-run safe; skips already-CST/mixed/anomaly rows), AF follows the row's slot decision
(skips #REBUILD sentinel + non-time tokens), surgical per-row writes + plain-text lock. Fixes the
Missed Calls report (it buckets by parsing the stored time; old PST values mis-bucket / drop off the
8AM-5PM CST chart). Does NOT touch durations (TTT/ATT/AvgAbdWait) or counts. node --check clean;
core shift/window math sanity-checked. NEEDS: deploy cdr-report (`clasp push -f`), run preview ->
apply from the editor, then backfillDQEHistoryUpsert() if Neon mirror is consumed. NOT in the Node
suite (SpreadsheetApp-bound, like the existing two repairs).
  - **Follow-up (AF coercion ownership):** `repairDqeSlotTimestamps_` now recovers coerced
    time cells in BOTH K-AC (11-29) AND AF (32) — AF holds the same H:MM:SS strings and
    coerces to time serials identically; the slot repair previously skipped it. Correspondingly
    `repairDqeAbandonedIds_` narrowed to AD/AE (30-31): it was mis-marking coerced single AF
    times as "#REBUILD" (a fractional serial fails Number.isSafeInteger). CAVEAT: if anyone ran
    the OLD 3-col `repairDqeAbandonedIds()`, some single AF times may already be wrongly
    "#REBUILD" (serial overwritten → unrecoverable from the cell; needs a Raw Data rebuild).
    DOC: CLAUDE.md number-coercion gotcha still says repairDqeAbandonedIds handles "AD-AF" — /sync-docs.
- **Phase 1 / Part 1 — tokens** (`styles.html` `:root`): added `--r-sm/--r-lg/--r-pill`,
  `--shadow-1/2/modal`, `--ease/--dur-1..3/--stagger`. **`--r` LEFT at 2px** (decision C1).
- **Phase 1 / Part 2 — component layer** (`styles.html`, new block before `</style>`):
  `.is-good/.is-warn/.is-bad` status helpers + 8 `ds-*` components (kicker/section,
  chip/delta, KPI tile, status-rail card, table+bar, banner, toolbar/seg, modal shell).
  Net-new `ds-` namespace (verified collision-free); NOTHING references them yet, so
  the live app renders byte-identically. Static (no animation — that's Phase 2).

Tests: 132/132 pass; whole-file CSS brace balance 860/860; INV-16 untouched. No invariants at risk.

## OPEN / next steps
1. **Commit + push** the Phase 1 CSS + `docs/design-update-plan.md` to this branch (not yet done).
2. **Deploy (only when ready):** Department Dashboard `clasp push -f` + new deployment version.
   Inert until markup uses the classes, so deploy is non-urgent / non-blocking.
3. **Phase 1 / Part 3 — DONE (contained proof):** Insights team-rollup KPI tiles
   migrated onto `ds-*`. New Insights-only `insKpiTileDs_` (script.html) emits `.ds-kpi`
   markup; the four `prKpiTile_` calls in `insRenderReport_` swapped to it. Behavior
   identical (same valence→color map, same binary `benchValueCls_` 92%/5% tint, shared
   `irSparkline_`). Performance Report's `prKpiTile_` untouched; shared `reportHeadline_`
   (used by all reports) intentionally NOT migrated. `.ds-kpi__spark` height nudged
   20→22px so the 70×22 sparkline isn't clipped. **Live visual verify still pending**
   (manual S37 post-deploy — can't run Apps Script here).
   - **Increment 2 (DONE):** Insights queue-health per-queue table migrated to `.ds-table`
     inside a `.ds-card` (dashboard.html) — the card supplies the chrome ds-table omits.
     Contained to that one table; QCD's own `.qcd-source-table` instances untouched; no
     JS references it (`.num`/`.qcd-warn-*` classes stay harmless). Tbody row builder
     unchanged. Whole-file divs balanced 608/608.
   - **Increment 3 (DONE):** Insights length-mismatch warning → `.ds-banner is-warn`
     (badge + text). dashboard.html class swap (`cr-length-warning`→`ds-banner is-warn`,
     contained — CR's own `.cr-length-warning` untouched) + `insRenderLengthWarning_`
     restructured to emit `ds-banner__badge` ("Heads up") + a text `<div>`; warning copy
     verbatim. Demonstrates the banner component (a new one). NOTE: the at-a-glance
     headline still can't use ds-banner cleanly — it's the SHARED `reportHeadline_`.
   - **Agent cards → `ds-card--rail`: DEFERRED on purpose.** They ALREADY use a left-border
     classification rail (`.ins-card-improved/regressed/mixed` = accent/warn/muted), so a
     ds-card--rail migration is ~zero visual gain but high unverifiable risk (padding/layout
     preservation, drill-through, cards⇄chart toggle, collapsible details). Recommend doing
     it only alongside a live before/after, or skipping (the existing rail already matches
     the target look). Queue-health KPI tiles (inboundKpiTile_) remain a safe-but-quirky
     option (bench-tint-on-cap + pr-delta badges to preserve).
4. **/sync-docs:** add a CLAUDE.md note for the new `ds-*` component layer + radius scale
   under CSS conventions (currently only `docs/design-update-plan.md` documents it).
5. **Later phases (planned, not started):** Phase 2 (loaders + motion + `.ds-state` kit +
   SWR Overview, per-viewer keyed), Phase 3 (chart factory + graceful fallback +
   debounce/token on date edits). Held for sign-off: C7 consolidation, C8 nav restructure.

## Post-merge increments (Phase 1 + sheetRepairs merged to main via PR #84 + sync-docs PR)
- **Phase 1 eyeball-verified by the operator** (deployed; Insights ds-kpi tiles + ds-table +
  ds-banner confirmed). Phase 1 is DONE.
- **Increment 4 (DONE — first cross-report shared component):** promoted the Insights-only
  `insKpiTileDs_` to a SHARED `dsKpiTile_` and migrated the **Performance Report** rollup tiles
  onto it (6 `prKpiTile_` calls → `dsKpiTile_`); the dead `prKpiTile_` function was removed
  (two history breadcrumbs + two stale comments updated to `dsKpiTile_`). Now used by Insights (4)
  + PR (6) = 10 callsites, one definition. Behavior identical (same valence map, binary
  benchValueCls_ 92%/5% tint, shared irSparkline_). `.pr-kpi-tile`/`.pr-delta` CSS untouched
  (still used by `inboundKpiTile_` + a CR tile site). Live visual verify = scenario S14 (PR) +
  S37 (Insights) post-deploy. tests 132/132; INV-16 in sync; JS `node --check` clean.

- **Increment 5 (DONE):** Compare Ranges length-mismatch banner → `.ds-banner is-warn`
  (mirrors Insights Increment 3). dashboard.html class swap on `#cr-length-warning`
  (`cr-length-warning`→`ds-banner is-warn`, id kept); `crRenderLengthWarning_` restructured to
  `ds-banner__badge` ("Heads up") + text `<div>`, copy verbatim; the now-dead `.cr-length-warning`
  CSS removed (CR was its last user after Insights migrated). INV-35 logic (form hint / KPI
  captions / CSV) untouched. tests 132/132; CSS braces 858/858; JS clean. Live verify: S18 (CR
  length-mismatch) post-deploy.

- **Increment 6 (DONE — includes a prod-regression FIX):**
  (a) **FIX:** the `ds-kpi` migration silently dropped the binary benchmark tint (benchValueCls_
  → `bm-target`/`bm-over`, the 92%/5% company standard) on KPI VALUES. Cause: the ds-* layer
  sits at the END of styles.html, AFTER `.bm-target`/`.bm-over`, so `.ds-kpi__value`'s explicit
  `color:var(--ink)` won the cascade (legacy `.pr-kpi-value` sat BEFORE `.bm-target`, so it never
  needed this). Added two-class overrides `.ds-kpi__value.bm-target/.bm-over` (+ `__foot`) so the
  tint wins regardless of order. **This was already in prod** on the merged Insights KPI tiles
  (PR #84) — subtle (value not green/orange) so the eyeball pass missed it. Restores it there +
  on the PR tiles (this branch).
  (b) **Migrate:** `inboundKpiTile_` (label, value, cap, deltaHtml) → `.ds-kpi` markup — converts
  BOTH the Inbound report KPI row AND the Insights queue-health tiles. Value/cap/delta preserved;
  cap bench tint preserved via the (a) fix; dropped the literal "vs prior" (the delta pill conveys
  it). `.pr-kpi-tile`/`.pr-delta` CSS still used by the CR-team + QCD tile renderers (not migrated).
  tests 132/132; CSS braces 860/860; JS clean. Live verify: S38 (Inbound) + S37 (Insights qh) +
  re-check 92%/5% tint shows on IR/PR/Insights KPI values, post-deploy.

- **Increment 7 (DONE):** QCD KPI tiles (`qcdRenderKpiTiles_`) → `.ds-kpi`. label + value only
  (no delta/spark/caption); the two warn-coded tiles (Abandoned % ≥5, Violations MTD >0) now tint
  the VALUE via the ds-* status mechanism (`ds-kpi--status is-warn` → `.ds-kpi__value` reads
  `var(--status)`; specificity-safe). Minor visual refinement: legacy `pr-delta-neg` gave the value
  a warn-soft BACKGROUND block; ds tints the text only — which matches how abandon-%/bench tints
  render on every other report (consistency, not regression). tests 132/132; JS clean; INV-16 in
  sync. Remaining `.pr-kpi-tile` renderer: CR team tiles (script.html:7956) — bigger (per-day
  caption + "(P1)" badge), left for a focused next increment. IR tiles (`irKpiTile`) are the most
  complex (team-comparison + share + prior). Live verify: S32 (QCD) post-deploy.
- **Increment 8 (DONE — milestone: all simple KPI tiles on ds-kpi):** Compare Ranges team tiles
  (`crTeamTile_`) → `.ds-kpi`. Badge → `ds-kpi__top`; value keeps `benchValueCls_` (tint preserved
  by #85's override); the "vs <prev> (P1)" comparison → `ds-kpi__foot`; the conditional per-day
  caption stays as its nested `.pr-kpi-perday` line. NO more `pr-kpi-tile` emitters remain — every
  simple KPI-tile renderer (PR/Insights/Inbound/QCD/CR + Insights queue-health) is on ds-kpi. IR's
  richer `ir-kpi-tile` (team-avg marker + share + prior) is intentionally NOT migrated. The
  `.pr-kpi-tile`/`.pr-kpi-value`/etc. CSS is now likely dead but LEFT in place (separate cleanup
  sweep; `.pr-delta*` + `.pr-kpi-perday` are still used). tests 132/132; JS clean; INV-16 in sync.
  Live verify: S17/S18 (Compare Ranges) post-deploy. On branch `claude/ds-cr-team-tiles` off main
  (#85 merged).

- **Increment 9 (DONE — cleanup + 2 migration-regression fixes):** retired the dead `.pr-kpi-*`
  sub-class CSS (`.pr-kpi-tile`/`-row-top`/`-spark`/`-label`/`-value`/`-delta`) after every tile
  moved to `.ds-kpi`; kept `.pr-kpi-row` (grid container) + `.pr-delta*` badges + `.pr-kpi-perday`.
  PLUS two regressions the tile migration had silently introduced, surfaced by the cleanup audit:
  (1) metric-glossary applier targeted `.pr-kpi-label` → repointed to `.ds-kpi__label` so KPI-label
  hover definitions work again; (2) the 3 print page-break selectors targeted `.pr-kpi-tile` →
  repointed to `.ds-kpi` so tiles avoid page-breaks in print/export again. tests 132/132; CSS braces
  854/854; JS clean; INV-16 in sync. Live verify: hover a KPI label (tooltip) + Print/Export any
  report with tiles. Branch claude/ds-prkpi-cleanup off main (#86 merged).


- **Increment 10 (DONE — Phase 2 kickoff):** restyled the no-data empty-state to the ds-state
  "no-data" tone (soft rounded icon TILE + display headline + muted sentence), CSS-only. Class
  names kept (`.empty-state`/`-icon`/`-title`/`-hint`), so the shared `emptyStateHtml_` helper AND
  the 7 static empty/unavailable surfaces (dept / QCD x2 / Inbound-unavailable / Caller-Lookup x3)
  pick it up with ZERO markup/JS change. Chose this over renaming to `.ds-state` because the class
  is deeply embedded (helper + 7 static elements + the reportHeadline_ anchor check) and several
  states (Neon-down, Caller Lookup) are hard to trigger/verify. The `.status-*` inline banners +
  error/loading/permission tones stay as-is (a fuller ds-state unification is a larger future
  effort). tests 132/132; CSS braces 854/854; INV-16 in sync. Live verify: any empty-date-range
  report (Missed/Individual/QCD) shows the new icon-tile empty state. Branch claude/ds-empty-state.

- **Increments 11–17 (DONE — merged via PRs #87–#96, not individually logged here):**
  the operator-feedback + Phase 2 polish wave: at-a-glance headline TONED banner
  (`headlineTone_` + per-report `*Headline_` composers, 92%/5% good/warn/neutral);
  Insights length-mismatch demoted from a banner to a compact `.ds-note`; glossary
  circled-ⓘ indicator (`.gloss::after`) + styled `.ds-tooltip` replacing the
  unstyleable native `title=` on hover; symmetric `benchValueCls_` so KPI VALUES (not
  just chips) tint on both sides of the 92%/5% standard; date-range autocorrect
  (`linkDateRange_` — End snaps to Start when Start passes End); modal entrance motion
  (`ds-modal-rise`, keyed off `aria-hidden`); inline equalizer busy-indicator
  (`.ds-loader--eq`); Overview stale-while-revalidate cache (`OV_CACHE_KEY_`, per-viewer
  keyed). All behind the additive ds-* layer / CSS-only where possible; CLAUDE.md +
  README synced.

- **Increment 18 (DONE — Part 4 chart graceful fallback):** wrapped all 13 `new Chart(`
  callsites in `safeChart_(target, config)` (script.html). Common path is provably
  unchanged — when `Chart` is defined it's a transparent pass-through to
  `new Chart(target, config)`; ONLY when the global is missing (blocked/failed Chart.js
  CDN, SRI mismatch) does `chartUnavailable_` hide the canvas and insert an idempotent
  `.ds-note.ds-chart-unavailable` message ("Chart unavailable — … numbers above are
  unaffected"). Scoped strictly to the CDN-absent case; does NOT try/catch per-chart
  render errors (that would alter happy-path control flow). `chartUnavailable_` resolves
  the canvas from either a 2d-context target (`.canvas`) or a canvas element. tests
  132/132; JS `node --check` clean; INV-16 in sync. Live verify: block the Chart.js CDN
  in devtools → any report's chart slot shows the inline note, KPIs/tables still render.
  Branch `claude/ds-chart-fallback` off main (#96 merged).

- **Increment 19 (DONE — Part 5 #3 / C5: debounce + stale-token on My Dept date edits):**
  the two `from-date`/`to-date` `change` handlers fired `refresh()` synchronously, and the
  `linkDateRange_` autocorrect (registered LATER via `initDateRangeLinks_`) ran after that
  refresh on the same event — so a `from > to` edit fired one wasted `getDepartmentSummary`
  before the swap. Added a generic trailing-edge `debounce_(fn, ms)` and a monotonic
  `summaryReqSeq` token. Date edits now go through `refreshOnDateEdit_ = debounce_(refresh,
  350)` (rapid typing/arrow presses coalesce to one request; the 350ms trailing call reads
  the values AFTER autocorrect ran). `refresh()` captures `myToken = ++summaryReqSeq` and its
  success/failure handlers drop stale responses (`token !== summaryReqSeq`) so a slower earlier
  request can't clobber a newer one. Scoped to the date-edit path; refresh-btn / dept-switch /
  preset callers still fire `refresh()` directly (single deliberate fires), but they ALSO benefit
  from the stale-token guard. Wired to the PUBLIC `getDepartmentSummary` (C5 — not the private
  `computeSummary_` the design sample referenced). tests 132/132; JS `node --check` clean; INV-16
  in sync. Live verify: type a from-date past the to-date → no flash of empty data, ends on the
  corrected range; spam date edits → only the final range paints. Branch `claude/ds-summary-debounce`.

- **Increment 20 (DONE — verification-pass refinements A, #101):** (1) Insights
  "Different window lengths" caveat moved out of its standalone ds-note banner INLINE
  into the "Comparing against …" line as a warn glyph + bold label, explanation now in a
  hover tooltip (`insLengthFlagHtml_`, `.gloss` → styled ds-tooltip). (2) Insights headline
  status tone neutralized when the two comparison windows differ by > 7 days (apples-to-oranges
  → no false green/orange banner; sentences still render). (3) Glossary circled-ⓘ
  (`.gloss::after`) now hidden by default, fades in on hover/focus (opacity, space reserved so
  no layout shift). tests 132/132; CSS 895/895.

- **Increment 21 (DONE — verification-pass refinements B):** (4) Universal floating Help
  FAB (`#help-fab`, circled "?", fixed bottom-right, z-index 150 so it sits over report modals;
  `#help-modal` lifted to z-index 200 so Help opened from the FAB renders above an already-open
  report modal). Opens the same `#help-modal` as the header "?"; tucked away while Help itself is
  open; hide-able via a new Settings toggle (`#help-fab-toggle`, localStorage `cdr.help.fab`).
  (5) Modal entrance motion smoothed (rise/fade `--dur-2` 200ms → `--dur-3` 360ms, translateY
  10→14px). (6) Inline equalizer (`DS_EQ_HTML_`) now shows on report-fetch buttons — the
  IR/PR/CR "Loading…" and Ins/QCD "Generating…" busy states swap textContent for innerHTML with
  the `.ds-loader--eq` span; restore paths set textContent back (clears it). tests 132/132; CSS
  903/903; divs 608/608. Branch `claude/help-fab-motion`.

- **Increment 22 (DONE — rich tooltips, #103):** styled glossary tooltip gained a
  theme-matching accent border (`var(--accent)`), and high-value terms render a rich variant
  (`METRIC_GLOSSARY_RICH_`): bold title + def + benchmark chip surfacing the 92%/5% standards
  (% answered → green "≥92%"; Abandoned %/Violations → warn "≥5%"; ATT → per-call note).
  innerHTML from dev constants only; plain title kept for SR; `show()` prefers `data-gloss-rich`
  + toggles `.ds-tooltip--rich`. CSS 908/908; tests 132/132.

- **Increment 23 (DONE — Phase 4: IR KPI tile → ds-kpi, user chose "extend then migrate"):**
  extended the shared `ds-kpi` component with the three sub-features that had kept the Individual
  Report tile on its own `ir-kpi-*` dialect: `.ds-kpi__value-row` + `.ds-kpi__share` (inline
  share-of-dept tag), `.ds-kpi__compare` + `.ds-kpi__team` (the "Team X" average-comparison
  marker row), `.ds-kpi__prior` (the INV-49 vs-prior row), `.ds-kpi__spark--inline` (top-row
  spark), and a `.ds-kpi--ir` density modifier that preserves IR's 26px value sizing (5-up grid).
  `irKpiTile` + both `irPriorRow_` returns rewritten onto ds-kpi; the copy-TSV handler repointed
  to `.ds-kpi`/`__label`/`__value`/`.ds-kpi__compare .ds-kpi__team`/`__share`; glossary selector
  dropped the now-unused `.ir-kpi-label` (`.ds-kpi__label` already covered). Bonus: IR KPI labels
  now pick up the rich tooltips. `.ir-kpi-grid` (layout container) kept; the dead `.ir-kpi-*` tile
  CSS left for a cleanup follow-up (increment-9 pattern). Pure client UI — no cache/aggregation/
  invariant impact. tests 132/132; CSS 917/917; JS clean. Branch `claude/ir-tile-dskpi`. Per-agent
  rail-card migration is the remaining Phase 4 item. Live verify: S11/S12 (Individual Report) +
  the per-tile "Copy" TSV.

- **Increment 24 (DONE — verification-pass fixes):** (1) IR "All at once" chart toggle: the
  `.ir-tabs-allmode .ir-tab { pointer-events: none }` CSS (plus the JS `return` on tab clicks in
  all-mode) trapped the user in all-mode — the only exit was a second toggle click. Removed the
  pointer-events block (tabs stay dimmed 0.5 but clickable) and changed the click handler so a
  specific-tab click exits all-mode and jumps to that chart. Relabeled the button "All at once" →
  "ALL". (2) Insights "Team Insights": `buildTeamInsights_` gains an optional
  `opts.excludeVolume` that drops the raw cumulative-volume insights (answered/missed counts) —
  not comparable across windows of different lengths — while keeping the length-independent ones
  (answer rate %, avg talk time per-call). The Insights caller passes `{excludeVolume:
  lengthMismatch}` (INV-35). PR (never mismatches, INV-28) and CR callers pass nothing →
  unchanged; new unit test pins both modes. tests 133/133; CSS 917/917; JS clean. Branch
  `claude/ir-charttabs-insights-volume`. NOTE: CR also calls buildTeamInsights_ and CAN mismatch —
  a candidate same-fix follow-up (left out to stay scoped to the operator's Insights request).

- **Increment 25 (DONE — Phase 4: per-agent cards → ds-card--rail):** migrated BOTH per-agent card
  surfaces onto the shared `ds-card--rail` (4px left status rail colored via inline `--status`).
  Insights cards (`insBuildCard_`): improved=accent / regressed=warn / mixed=muted / floater=warn;
  retired `.ins-card-improved/regressed/mixed/floater` + the `.ins-card` border-left (`.ins-card`
  keeps padding as the print/layout hook). CR cards (`crBuildCard_`): improved/regressed/mixed →
  `--status`; retired `.cr-card-*` + the `.cr-agent-card` border chrome (kept padding). `.ds-card`
  now supplies border/radius(r-lg)/shadow-1/bg for both; print rules (`.ins-card`/`.cr-agent-card`
  page-break-inside) + `.cr-quiet-details .cr-agent-card` opacity hook unaffected (classes kept).
  Pure client UI — no cache/aggregation/invariant impact. tests 133/133; CSS 910/910; JS clean.
  Branch `claude/ds-rail-cards`. This was the last headline Phase 4 item. Remaining: `.ir-kpi-*` +
  the just-retired card dialect dead-CSS cleanup sweep; optional CR volume-insight gating;
  `/sync-docs` pass. Live verify: S12 (Insights peer cards) + S19 (CR agent cards) — rail colors
  match direction; floaters warn; print/quiet-collapse intact.

## Where I left off
Phase 1 confirmed in prod by the operator. Continued report-by-report migration with
`/broad-implement` rigor: Increment 4 promoted the KPI tile to a shared `dsKpiTile_` and moved the
Performance Report onto it (first ds-* component shared across two reports — the consolidation
thesis realized). Tests green, syntax clean. Next candidates: migrate another report surface (CR
length-warning → ds-banner is low-risk; remaining Insights/PR surfaces), or start Phase 2/3 quick
wins. Still deferred/decision-gated: per-agent cards → ds-card--rail (high risk), at-a-glance
headline → ds-banner (shared reportHeadline_ decision), C7 consolidation, C8 nav.
PRIOR CONTEXT (still valid):
Also confirmed access control: non-manager/non-admin domain users land on access-denied with zero
data (Code.gs doGet + per-RPC re-auth); out-of-domain users can't reach the app. Awaiting
commit/push/deploy direction.

- **Increment 26 (DONE — redesign closeout, part 1):** (a) CR volume-insight gating: applied the
  #105 `excludeVolume` fix to Compare Ranges — relocated its `buildTeamInsights_` call to AFTER
  `lengthMismatch` is computed and passed `{excludeVolume: lengthMismatch}`, so a different-length
  P1/P2 comparison drops the raw answered/missed-count insights (keeps answer rate % + ATT). (b)
  Dead-CSS sweep: removed the now-unused `.ir-kpi-tile/row-top/label/spark/value-row/value/share/
  row-bot/row-prior/team` rules left behind by the #104 ds-kpi migration (kept `.ir-kpi-grid`
  container + `.ir-spark-svg`). The `.ins-card-*` / `.cr-card-*` classification rules were already
  removed in #106. tests 133/133; CSS 900/900; JS clean. Branch `claude/cr-gating-irkpi-cleanup`.
  Remaining closeout: `/sync-docs` pass.

- **Increment 27 (NEW FEATURE — temporal abandon heatmap):** weekday × hour abandon-rate
  heatmap sourced from `inbound_calls`, in BOTH the Inbound report and the QCD report (companion).
  Server: `InboundReport.gs::getInboundHeatmap({department,from,to})` -- one json_agg round-trip
  aggregating abandon rate by `ISODOW × hour-slot`, reusing `inboundResolveRequest_` (admin-only
  vetting gate + per-dept scoping) + `inboundDeptPredicate_`; cache `inboundHeatmap:v1`. Client:
  shared `renderAbandonHeatmap_`/`loadAbandonHeatmap_` CSS-grid render (NO Chart.js dep), color
  pivots on the 5% standard (≤5% sage / >5% warm, `colorToCanvasRgb_` OKLCH-safe), low-volume
  (<3 calls) muted. Inbound: `#inbound-heatmap` always loads (report is admin-only). QCD:
  `#qcd-heatmap` companion, load gated by `USER.role==='admin'` (managers never hit the admin
  endpoint; opens to them when the inbound gate is later removed). **TZ:** `call_start` is raw PST;
  SQL shifts +2h (`INBOUND_HEATMAP_CST_SHIFT_HOURS`) to the dashboard CST frame -- single-constant
  knob, NEEDS LIVE SPOT-CHECK. tests 133/133; CSS 915/915; divs 610/610; JS clean; cache-version
  guard green. Branch `claude/abandon-heatmap`. No unit coverage (Neon SQL + client render, like
  the inbound report itself) -- verify via S38-style live check.

- **Increments 28–34 (DONE — My-Department polish + Pass-2 design update):** seven CI-green PRs,
  all client-only (no server compute / cache / metric / permission change).
  - #118 Missed Calls section on My Dept brought to full modal parity (shared
    `makeMissedBucketDetail_` factory; summary strip; radar drill-in; full-width stacked).
  - #119 Missed drill-in side-by-side (`.chart-row` grid + slide animation) + collapsible
    queue-only / per-agent `<details>` cards (shared builders → modal gets it too).
  - #120 Agent table: Answered/Missed stacked bar (folds Rung/Missed/Answered; E5 WoW chips
    inline; sorts by `answerRate`, idle agents sink) + foldable detail columns (`#dept-cols-toggle`,
    `cdr.dept.cols`). Default sort now answerRate asc.
  - #121 Queue Call Data card moved above the agent table (below date controls).
  - #122 `docs/design-update-pass2-review.md` — codebase validation of the Pass-2 proposal +
    owner decisions (A2 = ratify shipped green; C3 = honest single loader).
  - #123 **B1 change-flash**: `dsFlashChanged_` + `.ds-flash`; Overview SWR cache→live + My-Dept
    refresh flash only changed values (never first paint; reduced-motion aware).
  - #124 **A1 Insights triage**: "Needs attention" (regressed) → "On track" groups, regressed
    first; partitions a COPY (never `insLastData.agentData`), parity test green; A2 rail legend.
  - #125 **C1/C3 loaders**: signal-rings in Caller Lookup results; honest single cold-start bar on
    Overview boot (no faked stages). QCD kept its existing equalizer button.
  - #126 **D1a**: "Retry now" button on the Overview refresh-failing banner (Overview already kept
    cached data on error). **C2 dropped** (charts render synchronously — no real wait to fill).
  - #127 **E motion**: rail-card entrance fade+rise + status-rail grow-in (Insights/CR cards).
    Count-up / segment-slide / skeleton-crossfade deferred (touch value rendering / component
    re-arch / broad reveal rework).
  DEFERRED Pass-2 work-streams: D1b (reports keep-last-good on error), D2 (permission tone),
  F (digest redesign + onboarding/unmapped-queue), C2 (chart-slot spark). A3 heatmap +2h TZ is a
  LIVE SPOT-CHECK (not a code change). A1's optional "auto-collapse On-track past 4" trimmed.
  Where I left off: Pass-2 dashboard CSS/JS pass complete; awaiting user redeploy + the standing
  live verifications (heatmap colors/CST, Insights chip/rail, B1 flash, A1 triage).

- **Increments 35–39 (DONE — Phase 15 + deploy feedback + design packages + Tier 3):** all on
  branch `claude/brave-dijkstra-wuonrv`; merged via PRs #131, #132 (+ Tier 3 pushed, unmerged).
  - **Phase 15 (PR #131):** Missed Calls report per-agent timelines flipped to roster-only
    (`getMissedCallsReport` scope 'both'→'roster') to match the now-roster-only Agent Call Metrics
    table; queue-only abandoned section preserved (sentinels always included). Missed cards sort
    most-missed-first + cohort-relative severity tiers (`missedQuantile_`, gated <3 agents / max<3).
    Insights agent-card tier grouping made ALWAYS-ON (Needs attention / Mixed / Improving) instead
    of only-when-regressed. Docs synced (scope decision rewritten roster-only, conventions.md).
  - **My-Dept deploy-feedback polish (PR #132):** fixed the Missed radar render (was created while
    `#dept-missed-section` was display:none → zero-size canvas; now shown before chart build);
    QCD side card condensed + per-queue CAROUSEL (`renderDeptQcdSnapshot_`); container max-width
    1200→1440px.
  - **Escalations Pass 3b (PR #132):** §4 client filter (escLastResp_ copy), §5 append-only
    `escalation_activity` table with TRUE ATOMICITY (write paths refactored to
    `setAutoCommit(false)`+commit/rollback; activity row in same txn), §3 admin `updateEscalation`
    (pending-only), §2 `reopenEscalation` (reason required, retains resolved_*), §1 flag-gated
    `NOTIFY_ON_NEW_ESCALATION` full-detail email via `lookupDeptManagers_`. New endpoint
    `getEscalationActivity` (per-dept). INV-55 + Operator State #24 updated.
  - **Overview layout (PR #132):** STACKED layout — full-width sticky-top trend chart (CSS
    order:-1, position:sticky top:8px z-index:5; condense-on-scroll SKIPPED per user), 4-wide dept
    grid (responsive 4→2→1). P1 taken as HYBRID: sub-queue children stay as their own tiles (parent
    DQE metrics are independent — nesting would falsely imply aggregation). P2.4: chart defaults to
    top-level depts + `#ov-subq-toggle` ("+ sub-queues"). Spotlight preserved (name-based). Retired
    the documented #8 rail; comment + CLAUDE.md updated.
  - **Tier 3 (this /broad-implement, pushed `ddba6ba`, UNMERGED):** implemented ONLY the
    skeleton→content crossfade (Overview boot, `ovRevealBody_` + `.ov-body-in`, fires only when the
    loader was showing, reduced-motion no-op). DEFERRED the rest with rationale: D1b keep-last-good
    (doc's own separate larger item, 5 reports' distinct re-fetch models, IR already does it);
    holiday exclusion (needs holiday-source decision); condense-on-scroll (user explicitly skipped);
    count-up/segment-slide/chart-spark (fiddly/net-new/conflicts animation:false, low value);
    INV-42 THEME.bad (dead code, no consumer); D2 permission-tone (no real dead-ends per F11).
  STANDING OPERATOR ACTIONS (post-deploy): run `backfillEscalationActivity()` once; decide
  `NOTIFY_ON_NEW_ESCALATION` (PII); live spot-check a resolve/reopen (the §5 txn refactor) + the
  Overview sticky chart + QCD carousel. Tier-1 rollout levers still open (deferred Neon mirror,
  `DQE_READ_SOURCE=neon` cutover, uninstall `runDailyDQEBuild_` safety net, restore Inbound manager
  access). Where I left off: Tier 3 crossfade pushed to `claude/brave-dijkstra-wuonrv` (not yet
  PR'd); D1b (reports keep-last-good) is the recommended next focused task.

- **Increment 40 (DONE — D1b reports keep-last-good):** added a per-report last-good payload
  cache (localStorage) so a FAILED report fetch repaints the last good payload for the SAME
  request + a non-destructive `.status-warn` "couldn't refresh — showing the last loaded report"
  banner, instead of blanking to a hard error. Shared helpers in script.html (near `reportReqSeq`):
  `reportSig_` (agents-sorted JSON), `reportLastGoodWrite_`/`reportLastGoodRead_` (ONE entry per
  report, keyed per VIEWER via `reportLastGoodKey_`+USER.email per INV-39 spirit, matched by sig —
  department is in the sig so the per-dept entitlement boundary holds), `reportFailFallback_`,
  `reportSetStatus_`. Wired all 5 reports at every fetch call site: IR (generate + edit-apply),
  PR (generate), CR (generate + edit-apply), QCD (generate, wrapped repaint to clear the shared
  qcd-results-status), Inbound (generate, wrapped repaint to clear inbound-results-status). New
  `.status-warn` tone (warn-soft) in styles.html. Audit finding: the literal "blank on re-fetch"
  was ALREADY prevented (IR/CR edit-apply keep results; PR/QCD/Inbound only fetch from the form),
  so the real D1b value delivered is surviving a transient backend failure / reopen. SKIPPED the
  heavier paint-instantly-on-open SWR variant (follow-on). Pushed `claude/brave-dijkstra-wuonrv`,
  UNMERGED. node --test 136/136; JS + CSS balance checked. Where I left off: D1b pushed, awaiting
  PR/merge decision; remaining Tier-3 items still deferred (holidays/decision, count-up/segment/
  spark cosmetic, INV-42 dead-code, D2 low-value); Tier-1 operational rollouts still open.

- **Increment 41 (DONE — Direct-extension call metrics, Phase 1a):** NEW feature, owner-approved
  definitions in `docs/direct-extension-metrics-design.md`. Per-agent per-day metrics for
  direct/individual-extension calls (distinct from the queue DQE/QCD path) with the "missed while
  on another call" carve-out. NEW cdr-import-only file `directCallMetrics.js` (NOT INV-16
  duplicated): pure `computeDirectCallMetrics` two-pass engine (occupied/busy intervals from all
  talk legs incl. queue+outbound → classify each in-window inbound miss as missed_busy [overlaps
  another call's busy window + 5s wrap-up tail, ANY overlap] vs missed_free; hold counts as busy;
  internal/external split; answer-rate rings work-window-filtered 6:30-15:00 PST but busy
  detection isn't; outbound = activity only). 12 unit tests
  (`tests/unit/direct-call-metrics.test.js`). `Direct Call History` sheet + Neon
  `direct_call_history` mirror, both LAZILY created (no setup() change). Editor-run
  `runDirectCallBuild()` computes the current Raw Data day for spot-checking. **Phase 1b NOT done
  (deliberate):** the daily `processIntegratedHistory` is untouched — wire a best-effort block
  there only AFTER the operator validates the numbers. node --test 148/148 (12 new); INV-16 clean.
  Pushed `claude/brave-dijkstra-wuonrv`, UNMERGED. Where I left off: Phase 1a pushed; awaiting (a)
  PR/merge decision and (b) operator spot-check of `runDirectCallBuild()` output before Phase 1b
  (daily hook) + Phase 2 (dashboard modal). 5s tail = `DIRECT_BUSY_WRAPUP_SEC` (tunable).

- **Increment 42 (DONE — UI polish batch + Tracks A & B):** Deploy-testing feedback,
  multiple commits on `claude/brave-dijkstra-wuonrv` (UNMERGED past PR #137).
  CONCRETE FIXES (shipped): queue-only abandoned cards default-collapsed on a >2-day range;
  dept Missed radar deferred resize (CSR zero-size fix); Dept Config Save spinner; Overview
  viewer-dept folded into the grid as a highlighted first card (hero retired); sub-queue
  chips → expandable mini-card strips (Ans%/Abd/viol + WoW arrow, smooth height morph);
  Source column folded into "Show all columns"; WoW "what changed" agent callout removed
  from Overview cards (#4); inbound queue-name bridge (Dept Config `Inbound Queue Aliases`
  col + getInboundQueueAliases_ + inboundQueuesForDept_ union — per-dept Inbound report still
  admin-only/parked; un-gate later by populating aliases + removing the inboundResolveRequest_
  gate). **Track A (DONE):** Missed Calls bars/radar toggle (missedChartCfg_ dispatch, mode in
  localStorage cdr.missed.chartmode default bars), bar mode = horizontal + COLOR INTENSITY RAMP
  + peak outline + datalabels; toggle re-render guarded to visible charts. **Track B (DONE):**
  Escalations converted modal → full PAGE (body[data-page=escalations], setPage, route kind:'page';
  esc-* logic + Escalations.gs unchanged). node --test 162/162; INV-16 clean; script.html JS
  syntax-checked. PLAN doc `docs/ui-infra-roadmap.md` (Tracks A/B/C). **Track C NOT started**
  (config sheets → Neon; phased C2 Dept Config → C1 Access Control → C3 Alert/Digest; +15-min
  setup() hardening). Where I left off: Tracks A+B pushed UNMERGED; awaiting PR/merge decision;
  Track C deferred (owner approved the plan, build when ready); the transient setup() timeout the
  operator hit just needs a setup() re-run (creates Report Usage).

- **Increment 43 (DONE — setup() hardening + C2 Dept Config→Neon):** On
  `claude/brave-dijkstra-wuonrv` (UNMERGED). (1) `Setup.gs::setup()` now iterates
  the 9 managed-sheet specs in a try/catch + `SpreadsheetApp.flush()` loop, so a
  transient "Service Spreadsheets timed out" on one sheet logs + continues
  instead of aborting (the operator hit this — Dept Config created, Report Usage
  not). Idempotent re-run still completes. (2) **C2** (first config-sheet→Neon
  migration): `CONFIG_SOURCE` Script Property (default `sheet`) switches Dept
  Config read+write to the Neon `dept_config` table. `readDeptConfigRows_` split
  into `sheetReadDeptConfigRows_`/`neonReadDeptConfigRows_` (neon = one json_agg,
  sheet fallback on error); `upsertDeptConfigRow_`/`deactivateDeptConfig_` route
  to `neon*` variants when flagged; lazy `CREATE TABLE`; editor-run
  `backfillDeptConfigToNeon()` + `compareDeptConfigSources()` parity gate. List
  cols stored as comma-joined text → dcParseList_ parity exact. 4 new tests
  (`dept-config-neon.test.js`); node --test 166/166; INV-16 clean. Docs:
  Operator State #25, INV-54 note, roadmap C2 marked SHIPPED. Where I left off:
  pushed UNMERGED; C2 ships default-`sheet` (no behavior change until an admin
  backfills + parity-checks + flips CONFIG_SOURCE=neon). REMAINING Track C: C1
  Access Control (needs a NEW admin editor UI — hand-edited today, fail-closed
  on neon error), C3 Alert/Digest (need edit surfaces), C4 Agent Alias
  (cross-project). Branch carries the whole increment-42+43 batch, awaiting
  PR/merge decision.

- **Increment 44 (DONE — C1 Access Control editor + C3 Alert/Digest data layer):**
  On `claude/brave-dijkstra-wuonrv` (UNMERGED). **C1 (decision + editor):** Access
  Control is NOT moved to Neon -- auth is the hot path and the sheet (dashboard's
  own ss) is the most always-available store, so moving it would trade reliability
  for nothing. Instead shipped a sheet-backed admin editor (`Auth.gs`
  getAccessControlInit / saveAccessControlRow [upsert-by-email] /
  removeAccessControlRow [delete-by-email], all assertAdmin_ + validation +
  LockService + auth-cache bust; managers only -- admins are in ADMIN_EMAILS).
  Client Access modal + nav tab + route /admin/access-control. fakeSheet gained
  deleteRow. Tests access-control-editor.test.js (+7). **C3 (data layer only):**
  readAlertConfig_/readDigestConfig_ now read rows from the active source via
  alertConfigRawValues_/digestConfigRawValues_ (Neon alert_config/digest_config
  when CONFIG_SOURCE=neon, same flag as C2, sheet fallback on error, identical
  parse). Lazy tables + backfill{Alert,Digest}ConfigToNeon + compare*Sources
  parity. Tests config-neon-c3.test.js (+3). node --test 176/176; INV-16 clean.
  Docs: INV-01 (AC RPCs), Operator State #25 (C3 + C1 decision), roadmap C1/C3.
  Where I left off: pushed UNMERGED. **C3 NOT flippable yet** -- Alert/Digest are
  hand-edited, so CONFIG_SOURCE=neon needs admin EDIT UIs in the Alerts modal
  (the per-dept threshold/recipients table + the digest subscribers list) first;
  those UIs are the remaining C3 work. C4 (Agent Alias, cross-project) still open.
  Branch carries increments 42-44; awaiting PR/merge decision.

- **Increment 45 (DONE — C3 edit UIs; C3 now flippable):** On
  `claude/brave-dijkstra-wuonrv` (UNMERGED). Admin CRUD for Alert Config +
  Digest Config in the Alerts modal, writing the ACTIVE source (sheet, or Neon
  when CONFIG_SOURCE=neon -- same dispatch as C2). Server: Alerts.gs
  saveAlertConfigRow/removeAlertConfigRow (key=department) + Digest.gs
  saveDigestConfigRow/removeDigestConfigRow (key=email+dept), all assertAdmin_
  + validation + LockService + audit log + sheet/neon writers. Client: Actions
  (Edit/Remove) columns on both Alerts-modal config tables + add/edit forms
  (dashboard.html) wired in initAlerts, reload via alLoadInit_. Tests
  config-editor-c3.test.js (+7); node --test 183/183; INV-16 clean. Docs INV-01
  (4 new RPCs), Operator State #25 + roadmap (C3 SHIPPED + flippable). Where I
  left off: C3 fully shipped + flippable (backfill{Alert,Digest}ConfigToNeon ->
  compare{Alert,Digest}ConfigSources clean -> CONFIG_SOURCE=neon, one flag for
  Dept+Alert+Digest). REMAINING Track C: C4 Agent Alias Overrides (cross-project
  pipeline read -- optional). Branch carries increments 42-45; awaiting PR/merge.

- **Increment 46 (DONE — C4 evaluated, recommended AGAINST; Track C closed):**
  Doc-only. Agent Alias Overrides is read CROSS-PROJECT by the pipeline
  (loadRosterCanonicalNames_, line 938) in BOTH buildDQEHistoricalData.js copies
  (INV-16 byte-identical pair) + cdr-report/DQEdrilldown.js, on the daily-build
  canonicalization hot path; written only by the dashboard Orphan Fix modal
  (already UI-managed). Moving it to Neon would add a JDBC read + Neon-availability
  dependency to the daily build via a delicate two-file byte-identical edit, to
  retire ONE small rarely-edited sheet with no hand-edit pain to solve. Same call
  as C1: keep it on the sheet (the sheet is the right store for a pipeline-hot-path
  always-available read). Recorded the decision in docs/ui-infra-roadmap.md; NO
  code change. node --test 183/183 (unchanged). Where I left off: Track C closed
  -- C2 + C1 + C3 shipped (Dept/Alert/Digest Neon-flippable; Access Control +
  Agent Alias + logs stay sheet by design). Branch claude/brave-dijkstra-wuonrv
  carries increments 42-46, UNMERGED, awaiting PR/merge decision.

- **Increment 47 (DONE — Direct-call metrics Phase 1b + Phase 2):**
  Phase 1b: extracted the shared core `buildDirectCallFromRaw_(ss, rawDisp,
  configSheet, opts)` in cdr-import/directCallMetrics.js (sheet write +
  refresh-in-window + inline best-effort Neon mirror); refactored
  `runDirectCallBuild()` to call it; wired a 6th best-effort block into
  `processIntegratedHistory` (autoImport.js, after the DQE block) gated on
  rawDataSheet present, logging `processIntegratedHistory:Direct` Pipeline
  Health rows (agents/missedBusy/missedFree/neon in notes). cdr-import-only
  (NOT INV-16 duplicated). Phase 2: new DirectCallReport.gs
  (`getDirectCallReport`, ONE json_build_object Neon read; per-agent answer
  rate EXCLUDING the busy carve-out, inbound ATT, outbound activity+ATT,
  int/ext split; admin-only-while-vetted with the per-dept manager path kept
  intact like Inbound; cached directCall:v1, unavailable not cached). Client:
  Direct report tab (admin-only) + #direct-call-modal + route #/report/direct
  + CSV (dashboard.html + script.html, initDirectCallReport). Tests
  direct-call-report.test.js (+5; gate, derived rates, null-rate, unavailable).
  node --test 188/188; INV-16 clean. Docs: direct-extension-metrics-design.md
  (Phase 1b+2 SHIPPED). Where I left off: Phases 1b+2 done; report is sparse
  until history accrues. Operator: deploy dashboard + cdr-import; the import
  starts writing Direct Call History + direct_call_history automatically. INV-44
  step list + an INV for the Direct report are a sync-docs follow-up. Branch
  claude/brave-dijkstra-wuonrv carries increments 42-47, UNMERGED.

- **Increment 48 (DONE — Direct-call metrics Phase 3: bulk-backfill history):**
  Bulk path now builds Direct history for past dates (DQE skipNeon + end-pass
  upsert pattern). autoImport.js: histDateCache.direct (col B) + existsInDirect
  + willBuildDirect (its OWN gate, NOT willBuildDQE -- old dates with DQE but no
  Direct must still write Raw Data) + needsRawDataWrite widened; bulk branch
  builds the sheet per date via buildDirectCallFromRaw_({skipNeon:true}),
  unconditional (Option A, gated on willBuildDirect), logs bulkBackfill:Direct
  Pipeline Health; force-path clears the direct cache flag; bulk-complete
  reminder added. directCallMetrics.js: extracted shared dcUpsertRows_(conn,rows)
  (INSERT...ON CONFLICT template + per-row bind) used by BOTH writeDirectCall-
  RowsToNeon_ (single-date) and the new editor-run backfillDirectCallToNeon_
  (one connection, batched, resumable via DIRECT_UPSERT_RESUME, DIRECT_UPSERT_
  SINCE date floor) -- cdr-import-local (no cross-project move). Tests
  direct-call-backfill.test.js (+4: one-conn/per-row dates/ON CONFLICT, date
  floor, missing-sheet+unreachable no-op, single-date refactor parity). node
  --test 192/192; INV-16 clean (directCallMetrics.js + autoImport.js are
  cdr-import-only). Docs: direct-extension-metrics-design.md (Phase 3 SHIPPED +
  runbook). Operator: after a bulk rebuild run backfillDirectCallToNeon() in the
  CDR Import editor (DIRECT_UPSERT_SINCE to scope); recommended only after the
  carve-out numbers are vetted. INV-44 step list (bulkBackfill:Direct) is a
  sync-docs follow-up. Branch claude/brave-dijkstra-wuonrv carries 42-48, UNMERGED.

- **Increment 49 (DONE — R12: UI-audit Phase 1 fixes, commit 64cd132):** A
  rendered-harness UI/UX audit (scratchpad-only tooling: real client
  script/styles/markup + payloads computed by the REAL server code via the
  unit-test vm harness over fixture sheets, driven in headless Chromium at
  1440/1024/768/390, light+dark, admin+manager) found 7 issues on
  Overview + My Department; all fixed + harness-verified. R12-1 (BUG): missed
  chart never instantiated when refresh() ran during the Overview landing --
  the MC2 create-while-hidden guard exhausts 30 rAF attempts vs the
  display:none dept page and nothing re-armed on entry (blank until manual
  Refresh); setPage's dept branch now re-draws from deptMissedLastData when
  no instance exists (likely the true root cause under the R10-7/R11-B6
  band-aids). R12-2 (BUG): colorToCanvasRgb_ fillStyle-readback does NOT
  canonicalize oklch in modern browsers (serialized back verbatim) -- THEME
  carried oklch strings, parseColorRgb_ fell to gray, so every R11-L trend
  arrow rendered gray; non-rgb/hex readbacks now resolve via 1x1 getImageData.
  R12-3: .header-meta wraps <=640px + .ov-user-table-wrap overflow-x:auto ->
  0px page overflow at 390/768 (was 290px pan). R12-4: ovPeriodStats_ shows
  the no-data dash when rung===0 (was a catastrophic-looking "0.0%
  answered"). R12-5 (a11y): both agent tables' sort headers keyboard-operable
  (tabIndex + Enter/Space) + aria-sort. R12-6 (a11y): header nav dropped
  role=tablist/tab -> aria-current="page" (updateTabActiveState_); Overview
  chart toolbar role=group + aria-pressed metric buttons. R12-7 (a11y):
  .ir-sort-control select keeps a visible focus ring. npm run ci 452/452 +
  INV-16 clean; harness regression sweep: 0 console errors, 0 overflow,
  manager admin-leak check clean. Clean audit results worth keeping: contrast
  >=4.5:1 AA both modes; focus order logical; 92% boundary tint exact.
  Follow-ons (NOT done): S4 dead #mock-banner relic; IR modal's real
  role=tab set lacks tabpanel/arrow-key wiring (out of Phase-1 scope);
  R6 default Zoom:Full dead space (owner call); audit Phase 2 (Insights page
  or modals+Escalations) not started. Docs: fix-history R12 entries +
  CLAUDE.md INV-42 note are a sync-docs follow-up. Where I left off: R12
  committed+pushed on claude/broad-scan-ak8g04 (ahead of merged PR #199),
  no PR opened yet; operator deploy of the dashboard pending.

- **Increment 50 (DONE — R12 batch 2 + audit Phase 2, commit a6f7b56):**
  Batch-2 fixes: R12-8 mock-banner relic removed (markup+CSS+dead meta.mock
  check); R12-8b Overview chart zoom DEFAULTS to Fit (owner via R6; persisted
  cdr.ov.axiszoom; static markup label synced); R12-9 IR modal chart tabs
  completed as a real APG tabs pattern (inner role=tablist wrapper w/
  display:contents so the mixed toolbar keeps layout; aria-controls + roving
  tabindex anchored to irActiveChartTab; role=tabpanel + aria-labelledby;
  Left/Right/Home/End move+activate). Harness-verified (Fit axis 83-97;
  ArrowRight activates+focuses; no page errors); CI 452/452. AUDIT PHASE 2
  (Insights page; audit-only, no fixes): auto-run, density Simple/Detailed
  (chart-trap avoided; Simple forces trend chart AND instantiates visible),
  popover+advanced, period bar, calendar v2 (month pagination), manager
  gating (no ATT option / AB panel / heatmap; role-default Simple) ALL
  CLEAN; zero console errors. Findings (unfixed): I-1 .ir-results-header 4px
  page overflow (every viewport); I-2 R11-J A/B VIEWS panel occludes chart/
  calendar data when expanded at 1440x950 (suggest default-collapsed or
  persisted collapse); I-3 390px Agents toolbar clips (sort label cut,
  Cards/Chart + basis segments unreachable without undiscoverable horizontal
  scroll); I-4 (polish) trend Metric dropdown floats detached center-chart.
  Harness lesson: fullPage screenshots race Chart.js re-layout (viewport
  clips are the truth). Where I left off: batch 2 pushed on
  claude/broad-scan-ak8g04; Phase 2 findings awaiting owner pick; no PR
  opened for R12 batches yet; dashboard deploy pending.

- **Increment 51 (DONE — R12 batch 3: Insights Phase-2 fixes, commit 4a30a81):**
  R12-10 (I-1) Insights sticky header 4px viewport bleed -> spread-shadow
  bleed (0px overflow everywhere now); R12-11 (I-2) admin A/B VIEWS card
  defaults COLLAPSED + persists (cdr.ins.abpanel) so it can't occlude
  chart/calendar data unnoticed; R12-12 (I-3) Agents toolbar wraps <=700px
  (was clipped at 390 with segments unreachable); R12-13 (I-4) trend Metric
  dropdown relocated into .ins-trend-headctl beside Monthly/Daily +
  Line/Calendar (headctl now an explicit wrapping flex row; export onclone
  hides it by id, unchanged). Harness-verified: 0px overflow 1440+390,
  collapse persistence round-trip, toolbar within viewport, no page errors;
  CI 452/452. Where I left off: R12 batches 1-3 all pushed on
  claude/broad-scan-ak8g04, NO PR yet; /sync-docs pending for R12-1..13
  fix-history entries + INV-41/42 oklch note; dashboard deploy pending;
  remaining audit phases (modals beyond IR, Escalations page) unstarted.

- **Increment 52 (DONE — audit Phase 3: Escalations + admin modals; AUDIT ONLY,
  no fixes):** Harness extended with a fake JDBC conn (escalation rows +
  aggregates) + real-server payloads for esc-init/list/activity, alerts-init,
  digests-init, queuereport-init, orphan-init, deptconfig-init, access-init,
  health, ui-flags. CLEAN: Escalations page admin+manager (cat-menu counts,
  health band, review chip, filter, + New escalation admin-only,
  single-dept manager gets the NAME-TEXT dept control, zero data-admin-only
  leaks, 0px overflow 1440+390); all six admin modals aria-modal + labelled,
  Escape closes all, panels fit viewport, content renders (Orphan Fix showed
  the Jon Smyth orphan + datalist mapping correctly); zero console errors.
  FINDINGS (unfixed): P3-1 (MED, root-caused) trapFocus_'s FOCUSABLE query
  doesn't exclude HIDDEN elements, so the first/last wrap never fires in
  modals whose last focusable node is display:none (collapsed edit forms) --
  Tab ESCAPES Orphan Fix (21/25 presses), Dept Config (18/25), Health
  (15/25) while Alerts/Access/Caller trap 0/25; fix = filter els to visible
  (offsetParent) inside the keydown handler, repairing every modal at once.
  P3-2 (LOW, owner call): the Escalations 'All' view repeats the full
  expanded resolution form on every open card -- a disclosure would compact
  the list. P3-3 (INFO) hidden status divs retain their 'Loading...' text
  after success (DOM-only, not visible). Harness limits: write flows +
  Caller Lookup search + modal drag/resize not exercised. Where I left off:
  Phase 3 findings awaiting owner pick; R12 batches 1-3 still un-PR'd;
  /sync-docs pending (R12-1..13); dashboard deploy pending.

- **Increment 53 (DONE — R12-14 + docs sync + PR #200 MERGED, 4a65632):**
  P3-1 fixed (trapFocus_ filters to VISIBLE elements; 0/25 escapes on all
  modals, was 21/18/15 on Orphan/DeptConfig/Health; P3-3 skipped as
  invisible-DOM-only, P3-2 left as an owner call). Docs synced: CLAUDE.md
  OKLCH gotcha (R12-2 readback caveat + pixel-readback rule), Fit-default
  zoom in the Overview trend bullet, cdr.ov.axiszoom + cdr.ins.abpanel in
  the prefs bullet; fix-history R12-1..R12-14 block. Branch rebased onto
  main, PR #200 (all R12 work) MERGED. Where I left off: everything merged;
  OPERATOR: deploy the Department Dashboard (clasp push -f -> new version)
  to ship R11-M/N + R12; the audit's remaining owner-call items: P3-2
  (Escalations 'All' view repeats full resolution forms) + heatmap live
  spot-check; audit phases 1-3 complete, no further phases queued.

- **Increment 54 (DONE — suggestions #1-7 + empty-state sweep + docs, commits
  c6ecd65/1e0dc20/2ad6a58/+this):** Harness committed as tools/ui-harness
  (portable paths, README). R12-15 esc resolve disclosure; R12-16 compact
  rows (-31%); R12-17 QH promoted (Simple-hide preserved); R12-18 short-
  viewport sticky slimming; toasts on all six esc verbs; R12-19 unified
  Overview Window bar per the owner's 5 rulings (cdr.ov.window, chart
  labeled Chart:, yesterday-only agents caption, WoW tooltip explainer,
  zero-ring no-data note); R12-20 getEscalationsBadge (read-only, scoped)
  -> nav badge + Overview strip; R12-21 empty-state sweep (role-aware dept
  hint, esc inflow context, tour text; other states audited healthy).
  Docs synced (INV-55 callable, prefs keys, density bullet, fix-history
  R12-15..21). All harness-verified; CI 452/452 throughout. Where I left
  off: ~8 commits ahead of main un-PR'd; dashboard + cdr-import deploys
  still pending; next natural steps: PR+merge, deploy, regenerate harness
  payloads after any server-shape change.

- **Increment 68 (DONE — view-as harness coverage + /sync-docs, commits
  cc4ce43/+this):** `drive-smoke.js` now exercises VIEW-AS-MANAGER (28 checks):
  enters preview, hides the admin-only surfaces measured as RENDERED
  visibility rather than a class, reverses cleanly, throws nothing. That
  closes the second of the two follow-ons from increment 67; the first (drop
  `continue-on-error` from the `ui-harness` CI job) shipped in 35c80b3, so the
  gate is BLOCKING now.
  **/sync-docs found one substantial class of drift and it was all the same
  shape:** the sub-queue scope switcher was retired in a4d9673 and the HEAD of
  each doc entry was updated while the TAIL was not, so CLAUDE.md and
  docs/client-ui-conventions.md each contained two entries contradicting each
  other about whether the tabs exist. Fixed in CLAUDE.md (chip placement, the
  banner/tooltip paragraph rewritten as the lesson it actually taught, the
  Phase 3 missed-section rule now describing the group-header override that
  drives it, and the false "no automated coverage for any CSV writer" claim
  which its own harness paragraph contradicted), client-ui-conventions (the
  whole "Sub-queue scope switcher" section + the missed-section rule),
  regression-scenarios S35 (its addendum instructed an IMPOSSIBLE step — "set
  the switcher to `<dept> only`" — and now also states the crossover-de-dup
  exception to counts summing), operator-state (switcher phrasing), and
  script.html (stale jsdoc + a dead `var scope`). Also documented
  `sampleQueueSplitCallIds()` + its three Script Properties under Op State #41
  (it was in active owner use but undocumented), and added fix-history
  R12-22c/R12-22d for the queue-report email changes.
  CI 593/593; ci:ui 24+16+31. Where I left off: PR opened and merged.
  OPERATOR: the Department Dashboard deploy for the email + client changes is
  still pending. Next: Phase 3 (Missed, `missed:v18`) and Phase 4 (IR/Insights,
  `insights:v20`) of the queue split are still all-queue; the Insights combined
  view is unstarted; theme/mode toggles and the Export dropdown beyond the CSV
  item still have no automated interaction.

- **Increment 69 (DONE, MERGED + DEPLOYED — O-9, the queue-report email sent
  nothing and reported success, commits c2d715f / PR #213):** Owner reported
  the Daily Call Queue Report never arrived after enabling it. Arming the
  trigger without adding a subscriber row produced a run where
  `sendQueueReportForDate_` returned `count:0` with no failures — which fell
  into `runDailyQueueReport_`'s SUCCESS branch, wrote `Sent <iso> to 0
  subscribers`, and claimed the dedupe marker. The modal prints that verbatim
  and the Health classifier painted it GREEN (it matches none of the
  fail/error/skipped bad-words nor the MISSED/GAPS prefixes), so the engine
  reported success every weekday while nobody received anything. Fixed three
  ways: recipients resolve BEFORE the report is composed (returning
  `noRecipients`, and no longer paying the all-dept compute on ~12 polls per
  window); the runner writes `NO-SUBSCRIBERS <iso>` and does NOT claim the
  marker (so a subscriber added at 8am still gets that morning's report — the
  FAILED-ALL rule: nobody received it, so a retry can't duplicate); and the
  modal warns BEFORE the first morning when the trigger is installed with zero
  active rows. Plus the `^NO-SUBSCRIBERS` arm on the Health classifier. Same
  family as F5 and O-7: a no-op does not get to look like work.

- **Increment 70 (DONE, PUSHED, NOT MERGED — O-10 gate check + O-11 dev
  overlay, commits cafa4cb / b11fd1b):**
  **O-10** — `runQueueReportGateCheck` (admin-gated, READ-ONLY, button in the
  Alerts modal). Every non-send path in the trigger returns SILENTLY:
  disabled / outside-window / weekend / holiday / already-sent / not-ready
  write nothing anywhere, and the entry point is `_`-suffixed so the editor Run
  picker hides it too — so each hypothesis cost a day to test. It reports every
  gate INPUT beside the decision plus the next window and which date THAT run
  targets. Verdict logic split into a pure `queueReportGateExplain_` (the
  `queueReportGateDecision_` precedent) because the interesting branches are
  the ones a wall-clock test can never reach. `wouldSend` folds in the
  recipient count — a subscriber-less "ready" is the O-9 bug in a new hat.
  **O-11** — the admin-only dev overlay (`#dev-overlay`, Ctrl/Cmd+Alt+D or
  `#/dev`, `cdr.dev.overlay`): captured client errors, `google.script.run`
  timings/failures, app state, and a REGISTRY of admin-gated server
  diagnostics (a new one costs one line). Owner chose the full scope over three
  narrower options. Security shape: presentation only, the `role==='admin'`
  check is COSMETIC (a localStorage flag is not authentication), every
  diagnostic keeps its own `assertAdmin_`, app state is identifiers/flags never
  a payload. **A real bug shipped mid-increment and the new driver caught it:**
  `google.script.run` is a getter returning a FRESH, STATEFUL runner per
  access; the first draft captured one at install time, leaking chain A's
  handlers into chain B. Identity-comparing two reads does NOT detect it (a new
  Proxy is minted either way) — the check had to be behavioural, and the buggy
  build reports `BB`. New `drive-devoverlay.js` (14 checks) is in the ci:ui
  gate and asserts the app still WORKS with the probe installed before
  asserting anything about the panel.
  CI 601/601; ci:ui 28+16+31+14.

  **WHERE I LEFT OFF / DO THESE FIRST IN A FRESH SESSION:**
  1. `cafa4cb` + `b11fd1b` are pushed to `claude/sync-commands-dnxgcv` but NOT
     PR'd and NOT merged. Open a PR and merge (owner has approved this pattern
     each round, but ask — the standing rule is no PR unless asked).
  2. Then DEPLOY the Department Dashboard (`clasp push -f` from repo root → new
     deployment version). O-9 is already deployed; O-10 + O-11 are not.
  3. **Monday morning (Aug 3): confirm the queue report actually sends.** Its
     target is FRIDAY Jul 31, so Friday's raw data must be imported before
     noon Central. If it doesn't arrive, the new "Why hasn't it sent?" button
     answers it in one click. NOTE the Thursday Jul 30 report will never send
     automatically — its window closed, and the pre-O-9 code already claimed
     the dedupe marker for that date; deliver it with "Send to subscribers…".
  4. **Operator State #40 — the per-queue-split backfill window is CLOSING.**
     `Call_Legs` is pruned at 14 days and per-leg queue identity exists nowhere
     else, so every day this is not run is a day that can never be split.
     Highest-urgency operator item outstanding.
  5. Regression scenarios still not walked live: S2 (admin switches
     departments — the one that would have caught the dept-selector bug), S4,
     S6, S35, S43.

  **STILL OPEN (unstarted, no work in progress):** Phase 3 (Missed,
  `missed:v18`) and Phase 4 (IR/Insights, `insights:v20`) of the queue split
  are still all-queue; the Insights combined view is unstarted; the theme/mode
  toggles and the Export dropdown beyond its CSV item still have no automated
  interaction coverage (the same gap class that hid the dept-selector bug).

- **Increment 71 (DONE — broad-scan findings S2-0 / B-1 / B-2 / S2-2; block:
  `.cycle/blocks/71-S2-0-B-1-B-2-S2-2-broad-implement.md`):** A /broad-scan
  audit (stages 1-3) found four issues; the owner selected these four to fix.

  **S2-0 is the one that changes behavior.** `applyQueueSplitToRows_` is called
  from exactly ONE place (`computeSummary_`), so the Phase-2 queue narrowing
  reached My Department + the manager digests while Overview, Insights, IR,
  Missed and the low-answer-rate ALERT engine all kept reporting all-queue
  figures for the same dept and window. A manager comparing the Overview tile
  to the My Department totals saw two different answer rates with nothing
  explaining why, and the alert threshold was evaluated on a different number
  than the dashboard displayed. Now gated on the `QUEUE_SPLIT_SCOPE` Script
  Property, **default 'off'** — so all six surfaces agree again, at the price
  of restoring the crossover over-count on Sales / CSR / Power (the pre-Phase-2
  state, and the chip says so). The gate sits INSIDE the function so Phases 3/4
  inherit it. Flip to 'dept' only once every DQE surface narrows.

  **B-1** added fail-open #4: the dept has mapped queues and the rows have
  splits, but no queue name observed across the window matches the dept's list
  — a name-space config fault (queuesForDept_ returns QCD-canonical
  `A_Q_CustomerSuccess`, splits carry raw `A_Q_CSR`), which used to render the
  department as ZERO with every chip silent. Now rolls the window back to its
  all-queue figures and says so. Assessed per WINDOW not per row, because one
  row matching nothing is legitimate and failing open there would re-introduce
  the bug Phase 2 exists to fix.

  **B-2** cut the last three DQE readers over to the DAL — `alertRowsForDate_`,
  `computeDigestWowDriver_`, `computeOrphans_` — after the docs had claimed for
  some time that ALL readers were cut over. The alert one was the dangerous
  member: the claim is what justifies trimming the sheet, and a
  present-but-aged sheet returns zero rows for yesterday, so every dept logs
  `no-data` and the alerts stop firing behind a full, plausible-looking Alert
  Log. A new cross-file tripwire now fails CI if a dashboard `.gs` reads
  `SHEETS.HISTORICAL` without a Neon path (verified against HEAD: it flags
  exactly those three).

  **S2-2** guarded the CSR force-rebuild path. `guardForceRebuildLoss_`'s
  exemption list is keyed on "is this sheet dashboard-read" — true of CSR
  Transfer until R10-5 made it dashboard-read and nobody revisited it, so a
  force re-import producing zero CSR rows deleted that date silently.

  CI 610/610 (+9 tests) + INV-16 clean. `npm run ci:ui` could NOT run —
  playwright will not install in this container and script.html was modified;
  the blocking `ui-harness` CI job covers it on the PR.

  **WHERE I LEFT OFF / DO THESE FIRST IN A FRESH SESSION:**
  1. Nothing is committed or pushed yet — 10 modified files on
     `claude/broad-scan-c9r2z7`. Commit, push, open a PR (ask first; the
     standing rule is no PR unless asked).
  2. Confirm the `ui-harness` CI job goes green — it is the only coverage of
     the `subqSplitChip_` change.
  3. **DECIDE on QUEUE_SPLIT_SCOPE before deploying.** Unset = 'off' = the
     consistent state. Do NOT set 'dept' until Phases 3/4 + Overview + Alerts
     narrow too.
  4. /sync-docs is needed: CLAUDE.md's queue-split bullets and INV-30 still
     read as though narrowing is unconditional, and QUEUE_SPLIT_SCOPE needs an
     Operator State item. (The two FALSE claims — the DQE read-back cutover and
     the CSR guard exemption — were corrected in this session.)
  5. Deploy BOTH projects: dashboard (Data/script/Alerts/Digest/OrphanFix/
     NeonRead) and cdr-import (autoImport).
  6. Unresolved from the audit sweep, not touched: `deleteOldCDRSheets` has no
     caller, no menu item and no installer in the repo, yet the ~14-day
     Call_Legs retention it enforces is what Operator State #40's urgency and
     IMP-11's "pruned = permanent loss" both rest on. Check the cdr-import
     Triggers panel.
  7. Operator State #40 (queue-split backfill window) is still open and still
     closing — unaffected by this session, since the pipeline still WRITES the
     split; only the dashboard's use of it is gated.

  **REMAINING AUDIT FINDINGS, not selected:** S2-1 (sub-queue group header is
  announced as a button but ignores Enter/Space, and carries the `role="button"`
  S39 explicitly forbids on table rows), B-3 (digest/alert outcomes missing
  from the Health page; zero-subscriber digest records `ok`), B-5 (sentinel
  rows bypass the work-window filter), B-6 (combined-view meta describes only
  the primary dept), plus the small dead-code list in the block file.

- **Increment 72 (DONE — CLAUDE.md extraction pass + three process guards;
  block: `.cycle/blocks/72-claude-md-extraction-broad-implement.md`):** The
  owner asked whether CLAUDE.md needs a second split. **Answer: no, and a
  split would have been the wrong fix.** The measurement is what settled it —
  372 KB → 150 KB at the F8 split, back to 178 KB in seven days; 51 → 53
  bullets, but only ~3 KB of that from the two NEW bullets and ~10 KB from
  EXISTING ones growing. Splitting again would move weight without touching
  the mechanism that produces it, and would buy roughly a week.

  **What shipped instead: one extraction pass plus three things that make the
  growth visible per commit.**

  **Extraction (5 of the 8 biggest bullets).** Inbound capture 17.5 → 12.8 KB;
  role model; Neon write discipline; System Health; deferred Neon mirror. The
  rule in each case survives verbatim — what left is chronology (how a defect
  was found, which increment fixed it, what four explanations were eliminated),
  and every fix code cited already had a `docs/fix-history.md` entry, which is
  what made this deletion-of-duplicate rather than relocation. **I verified
  that BEFORE editing, and it is the single fact that made the edit low-risk.**
  One entry was not narrative but STALE — a "future lever" that had since
  shipped as the deferred mirror. The 3 remaining top-8 bullets (coercion 3.8
  KB, direct-extension metrics 4.8 KB, read-back 5.6 KB) were assessed and
  deliberately left: on close reading they are rule, not padding, and the
  coercion one is the most safety-critical gotcha in the file.

  **The honest number: 178.1 → 171.7 KB, only −6.4 KB.** That is the finding,
  not a disappointment — the bullets are mostly genuinely rules, so extraction
  is not the lever. The ratchet is.

  **Suggestion 2 (the durable one): a per-bullet RATCHET in
  `claude-md-split.test.js`.** New Common Gotchas bullets must be under 4 KB;
  the five already over are grandfathered at measured size and may only
  SHRINK. The 200 KB cap is a CLIFF — it fires on whoever adds the last
  paragraph, not on whoever grew a bullet over six weeks. Negative-tested in
  both directions.

  **The ratchet fired on its own author, and the resolution is recorded in the
  test.** Restoring three pointers the loss-checker caught pushed the inbound
  bullet past its seeded size; I shaved unrelated prose three times before
  recognising the seed was a MID-EDIT snapshot, not a real previous size. Two
  lessons, both in the test comment: seed from a FINISHED state, and shaving
  unrelated prose to satisfy an arbitrary number is the ratchet causing exactly
  the damage it exists to prevent.

  **Suggestion 1** added the Round-14 fix-history family (S2-0, B-1, B-2,
  S2-2) so THIS session's commits don't create the drift the pass cleans up.
  **Suggestion 3** added CHECK 5 (doc weight) to `/sync-docs`, with an explicit
  counter-instruction — never propose deleting a RULE, and verify every dropped
  reference still resolves — because this check's failure mode is the opposite
  of the other four's. **Suggestion 4** put a "how to write one" note atop
  Common Gotchas carrying the measured evidence and three habits, the
  load-bearing one being: **write the bullet ONCE at the END of a phased
  rollout.** Amending per phase is what produced the biggest bullets — the
  sub-queue work alone added ~12 KB across six commits.

  **The real risk in this edit was not a broken build but quietly deleting a
  load-bearing sentence**, so it was checked mechanically rather than by eye: a
  scratch token-loss guard extracts every fix code, INV-/S-/Operator-State
  reference, backticked identifier and Script Property from the BEFORE text and
  asserts each dropped one still resolves somewhere in the live doc set. It
  caught three genuine losses — `REPORT_USAGE_SCAN_CAP_`,
  `ncMissingTableError_`, `clChainHtml_`/`minDate` — all restored as compact
  pointers. Final whole-file run clean.

  CI 612/612 (+2), INV-16 clean, F8 split guard green. No `apps-script/` file
  changed — **nothing to deploy from this increment.** NET 0 − 0 = 0,
  deliberately: a documentation-and-process change is not a bug fix, and
  scoring it otherwise would inflate the tally the reflect step exists to keep
  honest.

  **Also closed this session (items 1 and 4 of increment 71's list):** commits
  `f6b5113` (the four findings), `6fec21a` (/sync-docs — the queue-split
  bullets, INV-30, Operator State #42 and the plan doc all now describe the
  gate) and `3b28a2a` (this pass) are pushed to `claude/broad-scan-c9r2z7`.
  **No PR opened — the standing rule is none unless asked.**

  **WHERE I LEFT OFF:**
  1. Three commits pushed, working tree clean, no PR. Confirm the `ui-harness`
     CI job is green — `script.html` changed in `f6b5113` and playwright will
     not install in this container, so that job is its only coverage.
  2. **`QUEUE_SPLIT_SCOPE` must stay unset ('off') until Phases 3/4 + Overview
     + Alerts narrow too.** Unset is the consistent state; see Operator State
     #42 for what each mode makes the numbers mean.
  3. Deploy from increment 71 is still pending: dashboard (Data / script /
     Alerts / Digest / OrphanFix / NeonRead) **and** cdr-import (autoImport).
  4. **Operator State #40 (queue-split backfill) is still closing** — the
     ~14-day `Call_Legs` window is unaffected by any of this session's work,
     since the pipeline still WRITES the split.
  5. `deleteOldCDRSheets` still has no caller, menu item or installer in the
     repo — check the cdr-import Triggers panel (see increment 71 item 6).

  **NEXT, in the order I'd take them:** Key Design Decisions (40.4 KB, 23% of
  the file) got no extraction pass and has the same shape — it is the obvious
  next target, and the ratchet does not cover it. Then the unselected audit
  findings S2-1, B-3, B-5, B-6, and the dead-code list (`escRowDepartment_`,
  `yesterdayIso_`, `typeOfCell_`, `pullReportData`, plus five `_`-suffixed
  diagnostics wanting Run-picker wrappers). Growth rate remains the thing to
  watch: −6.4 KB buys about a week and a half at the observed ~4 KB/day.

- **Increment 73 (DONE — Key Design Decisions extraction; ratchet extended to
  both prose sections):** The follow-on named at the close of increment 72.
  **40.4 -> 33.7 KB** (CLAUDE.md 171.7 -> 164.9 KB), a bigger proportional cut
  than the Common Gotchas pass (-17% vs -6%), and for a reason worth carrying
  forward.

  **The largest win was deleting DUPLICATION, not condensing prose.** Four
  paragraphs of the sub-queue bullet — the relationship bar, the IR/Insights
  picker groups, the combined CSV, the missed section's scope — were already
  written, in more detail, in `docs/client-ui-conventions.md`, the file
  CLAUDE.md instructs you to read before touching `script.html`. Neither copy
  was wrong; the F8 split had moved the client conventions out and the bullet
  kept growing its own version alongside. That bullet went 10.8 -> 7.5 KB by
  becoming a pointer plus the three rules that are load-bearing SERVER-side.
  **Check the split files for an existing home before condensing a paragraph
  — the duplicate may already be better written than what you are editing.**

  Also extracted: the top-tab router's flattened-then-re-collapsed nav history
  (only the net state matters); the agent table's column-by-column change log;
  Phase E's three "shipped in commit X" paragraphs, each of which has its own
  home; the scope toggle's retirement chronology; and the three Overview
  banners' repeated gating/best-effort boilerplate, now stated once.

  **Two things deliberately kept, both against the instinct to cut.** The
  `E2`/`E3`/`E4`/`E9` codes stay attached to their affordances because they
  appear in code comments across five files. And the Source-column bullet
  still documents machinery that never renders in the My-Dept table — it is
  not dead code, the IR picker and Diagnostics use it, so the bullet now leads
  with that instead of trailing a NOTE that contradicts its own opening.

  **One lesson was relocated rather than deleted:** "a control whose only state
  is a class is a control with no state" existed NOWHERE but CLAUDE.md, so it
  moved to `docs/client-ui-conventions.md` with the assertion rule it implies
  (read the rendered effect, not the class name). The token-loss guard is what
  distinguishes that case from the deletable ones.

  **The ratchet now covers BOTH prose sections.** Leaving Key Design Decisions
  uncovered would have watched one growth surface while the other regrew
  freely. Only ONE bullet in the section exceeds the 4 KB budget after the
  pass, so the same constant works unchanged. Negative-tested both directions.
  A small lesson recorded in the test: seed a grandfathered size from THAT
  test's own failure message, not a side script — mine trimmed trailing
  whitespace differently and was off by one byte.

  Guard results: `npm run ci` 612/612, INV-16 clean, whole-file token-loss
  check clean apart from five ALL-CAPS prose words the regex misreads
  (FOLDED / HEADING / RESETS / ROUND / SETUP — each verified by hand to be
  emphasis in a comment, not a constant). **No `apps-script/` file changed —
  nothing to deploy.** NET 0 − 0 = 0, same reasoning as increment 72.

  **A process note on my own error:** I reverted the test file with
  `git checkout` while cleaning up a negative test, discarding unstaged work.
  The negative-test output had already been captured, so the verification
  stands and the edits were re-applied — but use a scratch copy for
  break-it-on-purpose checks rather than `git checkout` on a dirty file.

  **WHERE I LEFT OFF — increments 71-73 are MERGED TO `main`.** PR #215
  (`c4e5ecd`) landed all six commits: the four audit findings, the /sync-docs
  pass, and both CLAUDE.md extraction passes. **Both CI jobs passed, so
  `ui-harness` is confirmed green** and that item is CLOSED — as is
  "drop `continue-on-error` from the ui-harness job", which was already done
  before this session and lingered in older notes. `claude/broad-scan-c9r2z7`
  has been restarted from `main`; do NOT reuse PR #215.

  **Three things are still open and none of them is code:**
  1. **DEPLOY — this is the gating step, and it is TWO projects.** cdr-import
     (`autoImport.js`) and the dashboard (`Data.gs`, `script.html`,
     `Alerts.gs`, `Digest.gs`, `OrphanFix.gs`, `NeonRead.gs`). The dashboard
     needs a **new deployment version**, not just `clasp push -f` (Operator
     State #2); `scripts/deploy.sh <dir> <deployment-id>` does both.
  2. **Operator State #40 — the queue-split backfill, still on a clock.**
     `Call_Legs` is pruned at 14 days and per-leg queue identity exists
     nowhere else, so every undeployed day is permanently unsplittable. Deploy
     cdr-import, then force re-import the surviving dates. This is the only
     item with a deadline.
  3. **Leave `QUEUE_SPLIT_SCOPE` unset.** Unset = `off` = the consistent
     state, where all six DQE surfaces agree. See Operator State #42.

  Also unverified: the `deleteOldCDRSheets` trigger (no caller, menu item or
  installer exists in the repo, yet the 14-day retention it enforces is what
  item 2's urgency rests on — check the cdr-import Triggers panel).

  **NEXT for doc weight:** the two big prose sections are now both ratcheted
  and both freshly extracted, so the remaining growth surfaces are "Key
  commands" (~14 KB, several entries are effectively prose) and "Read first".
  Neither is urgent. At 164.9 KB there is 35 KB of headroom under the 200 KB
  cap — call it three weeks at the observed rate, and the ratchet is what
  makes that rate visible per commit rather than at the cliff. Unselected
  audit findings S2-1, B-3, B-5, B-6 and the dead-code list are untouched.

- **Increment 74 (DONE — Round-15 broad-scan + six selected fixes):** A fresh
  three-stage audit (six parallel subsystem passes + a seventh over the
  script.html regions no prior pass had read line-by-line, all headline
  findings self-verified in code) produced ~55 findings; the owner selected
  A-1, G-1, C-1+C-2, B-1, B-3+E-2 for implementation. All six landed in one
  commit (`9b65772`, pushed to `claude/broad-scan-l9ojgm`); the full summary
  block is `.cycle/blocks/74-audit-fixes-broad-implement.md`. NOTE: this
  round's finding IDs (A-#/B-#/C-#...) are per-agent namespaces from THIS
  audit — the B-3/B-5/B-6 "unselected findings" mentioned by increments 71-73
  are a DIFFERENT, older numbering; both sets remain open where not fixed.

  Highlights: A-1 was the CONFIG_SOURCE=neon runbook silently wiping Final
  Dept Labels with its own parity gate certifying the loss (backfill + compare
  key both blind to col 11; the ongoing save path was fine — the fix is small
  and the test fixture now carries a non-empty label so the class can't
  recur). G-1 was a shipped, server-computed, doc'd feature dead client-side:
  all four roster-cache writers dropped `subQueueGroups`, so parent managers
  never saw the sub-queue picker groups. C-1/C-2 hardened the no-sheet-primary
  captures: an all-stray grid (wrong-day signature) no longer triggers the
  zero-record authoritative DELETE, and the daily import now surfaces every
  delete-only outcome (unreachable/refused/cleared) instead of logging
  nothing. B-1 (Direct company view per-(agent,dept) grouping, directCall:v3),
  B-3 (YTD trend cache-put guards), E-2 (missed-section inline error + Retry)
  round it out.

  Verification: 615/615 unit tests (+3 pins), INV-16 clean, and — new for this
  container — the FULL rendered-UI gate ran locally (playwright installs fine
  into tools/ui-harness after `npm init -y` there; the root-install trap and
  its package.json pollution are what previously made this look impossible).
  All drivers passed. NET 2 − 0 = 2 (G-1 + B-1 were live; the rest latent).

  **WHERE I LEFT OFF:**
  1. Commit `9b65772` is pushed; working tree clean; NO PR opened (standing
     rule: none unless asked).
  2. **DEPLOY is the gating step, two projects:** dashboard (NEW VERSION, not
     just push — Operator State #2) + cdr-import. cdr-report/dqe-report
     unchanged. `scripts/deploy.sh <dir> <deployment-id>` does both steps.
  3. Post-deploy: runLiveSmoke, then walk S36 (Dept Config round-trip), S38
     (inbound capture), and the IR/Insights picker as a parent-dept manager
     (the G-1 groups + the now-reachable mixed-selection refusal).
  4. If `backfillDeptConfigToNeon` was ever run pre-fix, re-run it +
     `compareDeptConfigSources` (Neon's final_dept_labels are blank from the
     old code). Skip if the C2 migration was never started.
  5. The audit's full report (ratings, top-5, ~49 unimplemented findings,
     Stage-3 effectiveness review) is in the session transcript; the
     follow-on list + doc-drift items are in the increment-74 block file.
     Next best candidates: C-3 (retention trigger unversioned), B-2
     (retirement-aware SmokeCheck/NeonCoverage), F-5/F-6 (harness can't
     enforce REP-10/coercion protections), F-10 (deploy.sh skips ci:ui),
     G-2/G-3 (stuck export button; hardcoded 95% goal line).
  6. /sync-docs is warranted for the doc-drift set (F-3's INV-38 index line
     above all — it misstates an AUTHORIZATION-relevant invariant in the
     always-loaded file).

- **Increment 75 (DONE — Round-15 Batch 1: capture & force-path data safety):**
  C-5 / C-6 / C-8 / C-9, all in cdr-import; commit `05ec643`; summary block in
  `.cycle/blocks/75-batch1-data-safety-broad-implement.md`. 618/618, INV-16
  clean. NET 0 − 0 = 0 (all latent hardening).

  Shape notes worth keeping: C-6 grew past its audit wording during
  implementation — an ALL-unparsed grid turned out to pass the C-1 stray gate
  (date-LESS records are not stray-DATED), so the counter also became a third
  refusal arm (`allUnparsed`) beside `allStray`; and the two capture builders
  are asymmetric (inbound emits date-less records for the writer to filter,
  outbound drops them internally), so outbound counts via a
  `records._unparsedDropped` array property (the `_neonReachable` precedent).
  C-5 splits into an input-validation THROW (empty ext maps — structurally
  zero rows) and a log-only failure row for rebuilt-to-zero-with-deletions
  (P-5's legitimate force-to-zero preserved). `dcWriteSheet_` now returns
  `{written, deleted}` — its one caller and one test updated.

  Also this session, before Batch 1: increment 74's /sync-docs pass landed as
  `4a2a92b` (INV-38 index line, INV-01 bullet, chunking claims, count-free
  index lines, Operator State #43 for the unversioned `deleteOldCDRSheets`
  trigger, the #25 re-run warning, the Round-15 fix-history family, two stale
  in-file comments). The CLAUDE.md per-bullet ratchet seed for the Neon-write-
  discipline bullet tightened 4896 → 4892.

  **WHERE I LEFT OFF:**
  1. Commits `4a2a92b` (sync-docs) + `05ec643` (Batch 1) pushed to
     `claude/broad-scan-l9ojgm`; tree clean; NO PR (standing rule).
  2. **DEPLOY pending, two projects:** dashboard (increment 74's fixes — NEW
     VERSION per Operator State #2) and cdr-import (increments 74 + 75).
     cdr-report has only comment changes (can ride any later deploy).
  3. Next batch when asked: **Batch 2 — Neon endgame enablers** (B-2
     retirement-aware SmokeCheck/NeonCoverage, A-2 init-cache guard, B-4
     case-insensitive entry-queue matching). Full batch list with efforts is
     in the increment-74 close-out / the sync-docs session reply.
  4. Minor deferred doc line: mention the C-6 `allUnparsed` arm beside C-1's
     in the CLAUDE.md F2 sentence at the next /sync-docs.

- **Increment 76 (DONE — Round-15 Batch 2: Neon endgame enablers):** B-2 / A-2
  / B-4; commit `30bd1ac`; block in
  `.cycle/blocks/76-batch2-neon-enablers-broad-implement.md`. 622/622, INV-16
  clean, full ci:ui green. NET 1 − 0 = 1 (B-4 plausibly live: a case-mismatched
  Dept Config alias attributed calls in the Missed report but silently not in
  any inbound surface, and the parity check could not show it).

  Shape notes: B-2 landed as a pure `ncReclassifyTrimmed_` + per-table
  `sourceFn` dispatch (explicit typeof-guarded, NOT this[name] — unreliable
  across the Apps Script global and the test vm) and a SmokeCheck check 1 that
  now also verifies the roster tab under either source. B-4 forced
  `inbound:v8` / `inboundHeatmap:v3` bumps; the cache-version-sync guard's
  every-mention rule then flagged HISTORICAL `prefix:vN` citations in
  invariants/known-issues — those were REPHRASED ("the inbound v7 bump"), not
  deleted, so history stays while the guard tracks only live constants. Note
  for the next bump author: rephrase historical citations up front.
  getDeptConfigInit gained its FIRST test coverage (the A-2 pin).

  **WHERE I LEFT OFF:**
  1. Commits through `30bd1ac` pushed to `claude/broad-scan-l9ojgm`; tree
     clean; NO PR (standing rule).
  2. **DEPLOY pending:** dashboard (increments 74 + 76 — NEW VERSION, Op
     State #2) and cdr-import (74 + 75). After the dashboard deploy, inbound/
     heatmap counts may shift where alias casing differed — that is B-4
     working; runInboundQcdParityCheck is the evidence either way.
  3. Next when asked: **Batch 3 — test-harness teeth** (F-5 fakeSheet
     getMaxColumns enforcement, F-6 setNumberFormat coercion-protection spy,
     F-7 Code.gs userJson escape + Setup.gs idempotency pins, + the guard-
     header note from this increment's follow-on).
  4. B-2's new behavior only MANIFESTS after a `DQE_READ_SOURCE=neon` flip +
     sheet trim; under the current sheet source both tools behave as before.

- **Increment 77 (DONE — Round-15 Batches 3+4: harness teeth + client
  correctness):** F-5/F-6/F-7 + G-2..G-8/E-1/E-3; commit `15cf82c`; block in
  `.cycle/blocks/77-batch3-batch4-broad-implement.md`. 628/628, INV-16 clean,
  full ci:ui green. NET 1 − 0 = 1 (G-3's hardcoded 95% goal line was live
  against the tunable 92 standard).

  The load-bearing change is the HARNESS: fakeSheet now THROWS on a getRange
  past getMaxColumns (columns only — the REP-10 class) and RECORDS
  setNumberFormat calls, so the repo's two worst documented failure classes
  (narrow-sheet writes, plain-text coercion protections) are enforceable for
  the first time. All three new Batch-3 pins were MUTATION-verified (remove
  the widen → 7 failures; strip the '@' calls → pin fails; strip the userJson
  escape → pin fails). Setup.gs gained its first suite (INV-12 enforced).
  If a future suite needs a narrow sheet deliberately, set `_maxColumns` —
  do not loosen the fake.

  **WHERE I LEFT OFF:**
  1. Commits through `15cf82c` pushed to `claude/broad-scan-l9ojgm`; tree
     clean; NO PR (standing rule).
  2. **DEPLOY pending, unchanged set:** dashboard (74 + 76 + 77 — one NEW
     VERSION covers all) and cdr-import (74 + 75).
  3. Remaining batches by priority: 5 (a11y E-6..E-10), 6 (B-5/B-6/A-3/A-4/
     A-5/B-8 + the E-5 one-liner), 7 (C-3/F-10/F-9/F-11/F-8), 8 (D-1..D-6),
     9 (C-7), 10 (D-8/D-9), + strategic (queue-split phases; Inbound/Direct
     un-gating; G-1-class harness payload-contract assertion).
  4. Next /sync-docs: one clause on the harness's new strictness in
     CLAUDE.md's test-command blurb; the C-6 allUnparsed clause from
     increment 75's note.

- **Increment 78 (DONE — Round-15 Batches 5+6: a11y + server smalls):**
  E-6..E-10 + B-5/B-6/A-3/A-4/A-5/B-8/E-5; commit `5c710da`; block in
  `.cycle/blocks/78-batch5-batch6-broad-implement.md`. 630/630, INV-16 clean,
  ci:ui green. NET 1 − 0 = 1 (B-5: ALL-sentinel managers were receiving NO
  dept's alerts; they now receive every dept's — intended role semantics,
  flagged to the operator in the block).

  Two decisions worth carrying: (1) E-6 changed Enter semantics in
  dsConfirm_ to FOLLOW FOCUS — Cancel-focused Enter cancels; it used to
  confirm, destructive actions included. (2) B-6 resolved as
  DOCUMENTED-DELIBERATE, not a code gate: a skipped weekly/monthly run has
  no later run to cover it (unlike daily's next-weekday walker), so the
  "missing" gates would lose digests; deferral needs a trigger redesign and
  was explicitly declined in a comment block at the handlers.

  **WHERE I LEFT OFF:**
  1. Commits through `5c710da` pushed; tree clean; NO PR (standing rule).
  2. **DEPLOY pending:** dashboard (74/76/77/78 — one NEW VERSION covers
     all) + cdr-import (74/75). Post-deploy: quick manual pass on the
     keyboard paths (menus, dsConfirm_, chart-help) and an AT spot-check.
  3. Remaining: Batch 7 (C-3/F-10/F-9/F-11/F-8), 8 (D-1..D-6), 9 (C-7),
     10 (D-8/D-9), strategic items.
  4. /sync-docs queue: harness-strictness clause, C-6 allUnparsed clause,
     B-5's alerts note in the role-model bullet.
  5. New follow-on: script.html ~7758 — the subq group-head <tr> carries the
     same role="button" class as E-8 (has aria-expanded; right fix may
     differ).

- **Increment 79 (DONE — Round-15 Batches 7+8: deploy/ops hygiene + cdr-report
  editor tools):** C-3/F-10/F-9/F-11/F-8 + D-1..D-6; commit `f6e92be`; block in
  `.cycle/blocks/79-batch7-batch8-broad-implement.md`. 631/631, INV-16 clean,
  ci:ui green. NET 0 − 0 = 0 (all latent/hygiene — an honest zero).

  C-3 closes the round's longest-standing operational gap: the Call_Legs_*
  retention prune now has an in-repo installer, a menu entry, and a
  `retentionPrune` Pipeline Health row per run (INV-44 vocabulary + Operator
  State #43 + the CLAUDE.md index line all updated to the new reality —
  #43's ask flipped from "verify the invisible trigger exists" to "install
  ours, remove the hand-made one"). F-9/F-10/F-11 armor the gate machinery
  itself; F-8 makes sheetRepairs.js grep-able again. Batch 8 hardened the
  editor tools that had never seen an audit: width-throw (D-1), sidebar XSS
  (D-2), sheet formula injection (D-3 — a cdr-report-local crSheetSafeCell_
  that deliberately passes signed-numeric strings), silent truncation (D-4),
  falsy-index chains (D-5), and the stranded-Running state (D-6).

  **WHERE I LEFT OFF:**
  1. Commits through `f6e92be` pushed; tree clean; NO PR (standing rule).
  2. **DEPLOY now spans all three projects:** dashboard (74/76/77/78, one new
     version), cdr-import (74/75/79), cdr-report (79 — its first code deploy
     this round). Then: CDR Tools → Install Retention Prune Trigger + delete
     any hand-made deleteOldCDRSheets trigger (#43).
  3. Remaining: Batch 9 (C-7 — defer until the Neon cutover decision), Batch
     10 (D-8/D-9), strategic items.
  4. /sync-docs queue (4 clauses): harness strictness, C-6 allUnparsed, B-5
     alerts note, deploy.sh's TST-7 sentence now including ci:ui.

- **Increment 80 (DONE — /sync-docs for the Round-15 batch queue):** commit
  `e4e8601`. The four queued clauses landed (deploy.sh's ci:ui gate, F-9's
  CI=true fail, harness strictness F-5/F-6, C-6's allUnparsed arm) plus B-5's
  alerts note, #35's B-2 sheetTrimmed nuance, tests/README's strictness
  contract, and a fix-history code→block map for every implemented Round-15
  code. Both ratcheted bullets edited net-NEGATIVE (seeds tightened 4892→4881,
  6160→6156). CLAUDE.md 170.1 KB (~30 KB headroom). 631/631, guards green.
  The /sync-docs queue is now EMPTY.

  **WHERE I LEFT OFF:** unchanged from increment 79 — the gating step is the
  three-project DEPLOY (dashboard new version: 74/76/77/78; cdr-import:
  74/75/79; cdr-report: 79) + the #43 trigger install. Remaining code work:
  Batch 9 (C-7, deferred pending the Neon cutover decision), Batch 10
  (D-8/D-9), strategic tracks. The Neon cutover runbook + its open
  prerequisites were summarized for the owner in the increment-80 session
  reply (README "full flip runbook" + Op State #19/#25/#30/#35 are the
  durable references).

- **Increment 81 (DONE — Round-15 Batch 10: frozen-legacy prep + PR):** D-8
  (the dqe-report dual-onOpen collision resolved by deleting the redundant
  copy — the menu file's is a strict superset, so this is the freeze's
  cleanup-deletion class) + D-9 (a 5-item DECOMMISSION CHECKLIST comment in
  DQEdashboard.js where the deleted function was). Block in
  `.cycle/blocks/81-batch10-frozen-legacy-broad-implement.md`. 631/631,
  INV-16 clean. NET 0 − 0 = 0.

  **OWNER DECISIONS recorded:** staying on the Neon FREE tier; the cutover
  proceeds per the runbook with a MULTI-WEEK soak spanning at least one
  force re-import before any sheet trim. Batch 9 (C-7) stays deferred until
  that soak concludes.

  **WHERE I LEFT OFF:** Round-15's batch work is COMPLETE (1-8 + 10; 9
  deferred by decision). A PR for the whole branch was opened + merged this
  session (see the PR for the roll-up). Post-merge the operator steps are:
  the three-project deploy (dashboard new version: 74/76/77/78; cdr-import:
  74/75/79; cdr-report: 79; dqe-report: 81 cleanup push), the #43 retention
  trigger install, then the Neon cutover runbook (README + Op State
  #19/#25/#30/#35 — deploy first, gates before flags, soak before trim).
  Remaining code work when wanted: strategic tracks (queue-split reader
  phases → QUEUE_SPLIT_SCOPE flip, Inbound/Direct manager un-gating after
  B-1's deploy + parity, the G-1-class harness payload-contract assertion)
  and C-7 after the soak.

- **Increment 82 (DONE — Round-16 quick wins: #7 NUL bytes, #5 orphan-prefs
  sweep, #4 client fragment split):** neonbackfill.js is a text file again
  (3 raw NULs -> escape sequences, the F-8 class); sweepOrphanPrefs_()
  (script-2-chrome fragment, first call in init()) deletes the six documented
  dead localStorage keys read-before-remove (supersedes the "left in place"
  ruling on cdr.dept.subscope — owner selected #5 knowingly); script.html is
  now a ~45-line ASSEMBLER splicing 11 raw-JS script-N-*.html fragments into
  the same single script element / IIFE via a template-evaluating include_
  (byte-identical partition — semantics provably unchanged). New enforcement:
  4 html-include-structure pins (fragment purity, styles.html scriptlet-free,
  include-list<->disk parity, node --check of the assembled body), all
  mutation-verified; build-harness resolves nested includes. 635/635,
  INV-16 clean, npm run ci:ui FULL PASS. NET 0 − 0 = 0. Block in
  `.cycle/blocks/82-round16-nul-prefs-split-broad-implement.md`.

- **Increment 83 (Round-16 owner batch, session continuation):** the Insights
  progressive-disclosure restructure shipped -- Simple/Detailed mode RETIRED
  for per-section folds (Queue health + Trends <details> with headline
  summaries, per-user open-state, density-pref migration, draw-on-open for
  trend chart + admin heatmap), the Insights header unified onto the My
  Department controls pattern (From/To + shared Quick-select chips via the
  new buildDatePresetChips_; popover slimmed to "Comparison & agents"), a
  Phase-3 motion layer (page-swap fade, fold animation, elevation-on-stuck),
  and the shared "Agent table / Insights" lens switcher in both sticky
  headers. Owner removals: Bars/Radar toggle hidden (always bars), the
  sub-queue relationship bar + "all queues" chip hidden (SUBQ_BAR_HIDDEN_),
  the group-heading missed-calls button + missed-section scope banner gone.
  Harness: drive-subqueue re-pinned to the hidden states; drive-smoke's
  blank-canvas checker skips closed-<details> canvases (Chromium forced-
  layout change). Earlier in the same session: EmailKit.gs became the
  outbound-email house style (dept summary email NEW, Insights report/
  summary, digest all cadences, alert, escalation notify, inbound, IR
  snapshot; queue report stays the pinned reference), goal-gap sparklines
  everywhere applicable, icon-only Refresh, share-tally rows replaced the
  Insights donut, company-card escalations line, team-strip frost, the
  sub-queue violation-date drill fix + Insights daily tally, email MTD pace
  line, Cards view hidden + abs default. 651/651, INV-16, full ci:ui. Block
  in `.cycle/blocks/83-round16-insights-disclosure-broad-implement.md`.

  **WHERE I LEFT OFF:** All of the above is code-complete + pushed on
  claude/broad-scan-l9ojgm (post-#219 main + 9 unmerged commits through
  3f36283). No PR opened yet (owner asks explicitly). Deploy on merge:
  dashboard only (`clasp push -f` + new version; EmailKit.gs +
  DeptSummaryEmail.gs are NEW server files, nothing deleted remotely).
  Open decisions: the hidden Cards view's fate; whether to retire the
  #dept-insights-strip teaser now that the lens switcher exists.

## Increment 84 — M1 Insights merge (2026-08-07)

  Owner approved folding the ENTIRE Insights page into My Department
  (docs/insights-merge-plan.md, phases M1–M4). M1 shipped: the Insights
  <section> moved inside #dept-page as the <details id="dept-insights-region">
  collapsible (every inner id preserved incl. #insights-page), with the
  LAZINESS CONTRACT (insEnsurePage_ + auto-generate on first OPEN only, via
  the toggle listener / the sync deptInsightsOpen_ — sync because programmatic
  details.open fires toggle async and handoff callers write ins-* fields right
  after setPage returns). setPage('insights') maps to dept + open/scroll, so
  deep links, Digest email links, quick-start chips, and the lens switcher all
  land correctly. IR drill origin now travels as {fromInsights:true} (the four
  script-8 call sites). Sticky strips stack (insights header at
  --dept-sticky-h, z 59); print path retargeted; data-page="insights" CSS
  retired; INV-37 amended. Earlier the same session (commit 7dbef14): top-nav
  Insights tab retired, multi-queue Daily breakdown (per-queue tally rows + All
  queues total per date, color-coded counts). 651/651, INV-16, full ci:ui,
  plus two live-DOM probes (lazy cold load / lens open / chip route / drill
  origins). Block in `.cycle/blocks/84-m1-insights-merge-broad-implement.md`.

  **WHERE I LEFT OFF:** M1 pushed as e6a704f on claude/broad-scan-l9ojgm
  (branch restarted from post-#220 main; 2 unmerged commits: 7dbef14 +
  e6a704f). No PR opened (owner asks explicitly). Deploy on merge: dashboard
  only (clasp push -f + new version; no remote deletions). Next: M2 controls
  reconciliation per the plan doc — Refresh contract for open folds, region
  headline on the collapsed summary, open-state persistence decision,
  adoptSharedWindow_ retirement; then M3 (dept pill, Gap-vs-team default,
  A/B panel scoping) and M4 (transition-machinery removal). Watch: the
  closed-mid-generate chart-size exposure (M2 re-arm).

## Increment 85 — M2 Insights merge: controls reconciliation (2026-08-07)

  M2 shipped per docs/insights-merge-plan.md. The dept controls row is now
  the page's SINGLE DATE AUTHORITY: the region's own header From/To +
  Quick-select row (#ins-hdr-controls) is hidden (wiring inert until M4),
  and the new insSyncToDeptWindow_ converges the region -- on refresh()
  (open + rendered + window moved -> re-run via insApplyWindow_) and on
  region toggle-open (stale closed region re-runs on next open). It skips
  while a programmatic run is armed, so chip/share-link windows never race;
  priority: share link > chip/handoff > dept window > prefs > defaults.
  insRegionHeadSync_ puts a live headline on the collapsed summary
  (% answered · missed rings · abandoned % · window; teamStats fields are
  stat OBJECTS -- read .formatted). Decisions recorded: NO open-state
  persistence (auto-open would re-fire the RPC per dept visit); per-region
  Export menus stay. adoptSharedWindow_ (R9-3) retired; pageActiveWindow_
  survives only as the dwell-prefetch feed. Toggle-open re-CREATES charts
  from insLastData, closing the collapsed-mid-generate 0x0-canvas exposure
  from the M1 block. Gates: 651/651, INV-16, full ci:ui + a live-DOM probe.
  Block in `.cycle/blocks/85-m2-insights-merge-broad-implement.md`.

  **WHERE I LEFT OFF:** M2 pushed as 8379956 on claude/broad-scan-l9ojgm
  (3 unmerged commits: 7dbef14 tab-retire/daily-breakdown, e6a704f M1,
  8379956 M2 + checkpoints). No PR opened (owner asks explicitly). Deploy
  on merge: dashboard only. Next: M3 -- dept pill on the region header
  (owns the dept-SWITCH convergence gap: an open region keeps the prior
  dept's report until a window change), "See missed calls" as in-page
  scroll, Agents default -> Gap vs team, A/B panel scoping. Then M4
  retirement sweep (inert header-dates markup, lens switcher, handoff
  detours, prefs-blob dates).

## Increment 86 — M3 Insights merge: scope polish (2026-08-07)

  M3 shipped per docs/insights-merge-plan.md. Dept identity: #ins-dept-pill
  states the report's dept (warn --scoped variant when a sub-queue selection
  narrowed it), the dept leads the collapsed headline, and
  insSyncToDeptWindow_ now converges on a header dept SWITCH via
  insLastHeaderDept_ (re-ensure roster + agent-free auto-run behind the
  loading pane) -- closing the M2 gap where an open region kept the old
  dept's report. Both same-page hand-offs became in-page scrolls
  (missed-link -> qsSpotlight_, "Agent table" -> table scroll;
  handoffToMyDept_ kept as fallback). The Agents chart defaults to Gap vs
  team with a saved-'abs' self-heal (the same-page table carries Absolute).
  The fixed A/B remote hides while the region is off-screen
  (IntersectionObserver -> .ins-ab-offscreen). Gates: 651/651, INV-16,
  full ci:ui + live-DOM probes (incl. the sync dept-switch pane proof).
  Block in `.cycle/blocks/86-m3-insights-merge-broad-implement.md`.

  **WHERE I LEFT OFF:** M3 pushed as dc02ea0 on claude/broad-scan-l9ojgm
  (unmerged: 7dbef14, e6a704f M1, 8379956 M2, dc02ea0 M3 + checkpoints).
  No PR opened (owner asks explicitly). Deploy on merge: dashboard only.
  Next: M4 retirement sweep -- inert #ins-hdr-controls markup + header-date
  wiring, the lens switcher decision (keep as scroll affordances vs drop),
  handoff/launcher setPage detours, dead router branches
  (basePageRoute_/updateTabActiveState_ insights arms), the irDrillToAgent_
  data-page belt, insights-side recordPageWindow_, prefs-blob dates, the
  ex-hand-off hover-prefetch.

## Increment 87 — M4 Insights merge: retirement sweep — MERGE COMPLETE (2026-08-07)

  M4 shipped; the M1-M4 Insights->My Department merge is COMPLETE
  (docs/insights-merge-plan.md, all four phases checked). The lens switcher
  is KEPT as a jump affordance ("Insights" -> deptInsightsOpen_ directly,
  no date carry / no forced re-generate; "Agent table" scrolls up).
  Deleted: handoffToInsights_, the #ins-hdr-controls header-dates row +
  wiring + CSS, the ex-hand-off hover-prefetch, basePageRoute_'s insights
  branch, updateTabActiveState_'s effRoute mapping, irDrillToAgent_'s
  data-page belt, the dwell 'insights' arm + pageActiveWindow_.insights,
  and the prefs blob's preset/from/to. setPage('insights') + the
  '/report/insights' route/share-state entries are PERMANENT compat
  surface (deep links + Digest email links). Net -62 lines. Gates:
  651/651, INV-16, full ci:ui + a live-DOM probe (lens first-open
  generates / re-click pure-scrolls / chip route lands / prefs slimmed).
  Block in `.cycle/blocks/87-m4-insights-merge-broad-implement.md`.

  **WHERE I LEFT OFF:** M4 pushed as 9a98ad2 on claude/broad-scan-l9ojgm.
  Unmerged commits: 7dbef14 (tab retire + multi-queue daily breakdown),
  e6a704f (M1), 8379956 (M2), dc02ea0 (M3), 9a98ad2 (M4) + checkpoints.
  No PR opened (owner asks explicitly). Deploy on merge: dashboard only
  (clasp push -f + new version; NO server .gs files changed across the
  whole merge, so no web-editor deletions needed). Post-deploy: walk
  S37/S32/S14/S18/S19/S23/S39 live. Nothing pending on the merge plan.

## Increment 88 — N1 always-inline Insights (2026-08-07)

  Post-deploy owner feedback: M1-M4's collapsed region + tab-styled jump
  switcher still read as two pages. N1 makes it ONE CONTINUOUS page: the
  region is OPEN by default and GENERATES with the dept page
  (deptInsightsEnsureLive_ on dept entry + refresh, data-page-gated so the
  Overview landing pays nothing; manual collapse respected per session;
  insRearmZeroCharts_ covers hidden-created charts). The lens switcher is
  REMOVED on both sides; deep links/chips land via the mapped
  setPage('insights'). Retired as a consequence: the dwell prefetch, the
  shared-window store, prefetchDeptSummary_. Harness: smoke navs drop the
  lens step (24 checks). Gates green + live-DOM probe. Block in
  `.cycle/blocks/88-n1-always-inline-broad-implement.md`.

  **WHERE I LEFT OFF:** N1 pushed as 5991e17 on claude/broad-scan-l9ojgm
  (branch = post-#221 main + 009278a sync-docs? NO -- #221 merged through
  009278a; unmerged: 5991e17 only). No PR opened for N1 yet (owner asks
  explicitly). Deploy on merge: dashboard only. Open decisions: the
  overlapping-surfaces merge (team strip vs KPI tiles, QCD panel vs Queue
  health) -- owner to judge on the live continuous page; the
  viewport-approach fetch trigger stays as the escape hatch if cold
  generates feel heavy.

## Increment 89 — PERF-1/2 cold-load fixes (2026-08-07)

  Owner asked whether first-open latency could be improved after the N1
  always-inline deploy. Investigation found two real defects, both fixed:
  **PERF-1** -- CacheWarm warmed getInsightsReport over the LAUNCHER window
  (30d), but since M2 the inline section takes the DEPT window
  (latest..latest, INV-43). The cache key carries the window, so the warm
  was never read: every first dept open paid a cold aggregation while the
  heaviest ~4 min of the warm job produced unread entries. Now two passes,
  most-used first (dept default, then launcher), one shared budget.
  **PERF-2** -- the first-open auto-run was consumed POST-roster, so
  getInsightsReport waited a full round trip behind getInsightsReportInit.
  An agent-free run needs nothing from the roster (INV-45), so it now
  fires in parallel, deferred one tick so the launcher/deep-link paths
  (which own their window/selection) still win. refresh() also dispatches
  the dept summary BEFORE the Insights legs. Measured: report dispatch
  went from a full round trip behind the roster to the SAME millisecond;
  guards verified end-to-end (chip keeps its 29d window; deep link keeps
  its shared window + agents; exactly one run each). Gates: 651/651,
  INV-16, ci:ui 24+16+30+14. Block in
  `.cycle/blocks/89-perf-cold-load-broad-implement.md`.

  **WHERE I LEFT OFF:** Pushed as 98a4f6b on claude/broad-scan-l9ojgm
  (branch restarted from post-#222 main; 1 commit + this checkpoint).
  No PR opened yet (owner asks explicitly). Deploy on merge: dashboard
  only. **Operator note: PERF-1 only pays off if the cache-warm trigger
  is actually installed** (Alerts modal -> Report cache warming) -- worth
  confirming; likewise DQE_READ_SOURCE (Op State #19) is the largest
  remaining server-side lever. Known follow-ons: the dept-SWITCH path
  still serializes init->report (and double-dispatches the init) --
  deliberately out of scope since firing early there would read the
  outgoing dept's checked agents; cold boot double-dispatches
  getDepartmentSummary (pre-existing); splitting the insights endpoint
  for progressive render is the next lever if cold loads still drag.

## Increment 90 — R16c owner test-pass notes (2026-08-07)

  Seven owner notes on the always-inline deploy, all landed (9851d32):
  collapsed "All queues" day rows in the multi-queue Daily breakdown
  (violation chips force-open their day); Team-detail heatmap + share
  table side by side (.ins-detail-row; mock screenshot sent — stand-in
  heatmap data, real share table); ONE Export menu (labeled groups) + ONE
  Refresh on the dept controls with the region's own pair removed (Views
  wiring un-nested from the dead guard; refresh's same-window insights
  pass has an in-flight guard — the probe caught a double-fetch);
  missed-detail frost unified (deptMissedDetailFrost_); My Department
  email grouped into per-dept sections with deptGroups subtotals;
  Insights email consolidated to ONE form (behind-team block +
  active-only agent table; digest inherits via the shared rows). Item 3
  ("remove the toggle") was already done in N1 — stale cache sighting.
  Gates: 651/651, INV-16, ci:ui 24+16+30+14 + live-DOM probe. Block in
  `.cycle/blocks/90-r16c-test-notes-broad-implement.md`.

  **WHERE I LEFT OFF:** Pushed as 9851d32 on claude/broad-scan-l9ojgm
  (branch = post-#223 main + this commit + checkpoint). No PR opened
  (owner asks explicitly). OPEN QUESTIONS FOR THE OWNER: (a) their note
  "could potentially make the same change to" was cut off — which other
  pairing did they mean?; (b) judge the side-by-side layout from the mock
  / post-deploy; (c) the deeper email consolidation (ONE email = dept
  table + insights) proposed, not built. Follow-on: insBtnFeedback_
  retarget to #dept-export-btn.

## Increment 91 — R16d email polish + Queue-health columns (2026-08-10)

  Owner batch answering increment 90's open threads. Daily Call Queue
  Report email: 'Daily Company Aban %' retitle with tier-colored value
  (green ≤3 / amber 3–4 / red >4; tile bg keeps the ≥5 flag), all KPI
  cards centered, the banner-only single-queue collapse RETIRED (every
  queue gets its own tally row; some repeats accepted — the dedup was
  why tallies went missing), and '/day' added to the MTD pace line's
  prior value (web twin in script-11-qcd-boot too; "Jul 100" read as a
  date). queue-report pins updated (37 pass; the clean-banner Viol pin
  re-targeted by padding signature). Insights Queue health: KPI tiles
  stack in a left third beside the per-queue table (.ins-qh-cols —
  NOT .ins-qh-row, which is already the table's <tr> class and a flex
  rule there wrecks the rows; the probe caught it). ≤900px stacks the
  columns AND restores the horizontal tile grid in one media query.
  Mocks rendered from the REAL builders (harness + playwright) and sent:
  full email, 3-tier company-aban strip, queue-health row. Gates:
  node --test 0 fail, INV-16, ci:ui 24+16+30+14. Block in
  `.cycle/blocks/91-r16d-email-polish-qh-cols.md`.

  **WHERE I LEFT OFF:** committed + pushed on claude/broad-scan-l9ojgm.
  No PR (owner asks explicitly). Awaiting owner verdict on both mocks.

## Increment 92 — R16e owner round (2026-08-10)

  Five owner notes off the #224 deploy. Totals label bare with the
  crossover caption moved to a tooltip (NOT dropped -- the shortfall
  rule needs it, and drive-smoke asserts both halves); Views hidden +
  "Comparison & agents" moved into the Insights title line; the heatmap
  now STRETCHES to the share table's height (grid-auto-rows absorbs the
  slack in the day rows, not the hour header) and its cell drill renders
  BELOW the row with both lenses side by side, via a `data-heat-detail`
  opt-out on the shared renderer (+ an external-panel reset, since the
  innerHTML swap can't reach it); Daily breakdown rows fade+settle and an
  over-5% rate is finally bold (the global weight rule lost on
  specificity to `.ans-nums .ans-rate` -- it had never applied); Queue
  health promotes Avg answer + Longest wait, mirrors Transfer %
  (same-window-guarded, since a saved view can decouple the windows) and
  adopts the dept strip's split Queue-calls format. Harness fixture
  gained CSR Transfer Historical Data -- every payload was
  `csrTransfer: null`, so that tile was unreachable from the gate.
  Gates: 652/0, INV-16, ci:ui 36+16+30+14. Block in
  `.cycle/blocks/92-r16e-owner-round.md`.

  **WHERE I LEFT OFF:** committed + pushed on claude/broad-scan-l9ojgm.
  No PR (owner asks explicitly). Awaiting the owner's verdict on the two
  mocks.

## Increment 93 — R16g calendar drill + Absolute retire (2026-08-10)

  The Agents chart's Absolute basis is hidden (it restated the same
  page's agent table; the M3 self-heal already existed) and Rung left
  the metric selector with a pref self-heal. Calendar day-clicks now
  JUMP to the Daily breakdown -- fold+details open, day group expands,
  and a per-date drill row lists every missed ring + queue abandon
  (getMissedCallsSlice, from=to=date, no filter; missedSliceListHtml_
  renderer so "↳ path" chips work) -- replacing the single-day region
  reload that left the page's halves on conflicting windows. Fallback to
  the old reload only when the daily table can't take the jump. Wait
  times would need a new per-date inbound RPC (noted in block 93).
  Gates: 653/0, INV-16, ci:ui 36+16+30+14. Block in
  `.cycle/blocks/93-r16g-cal-drill-abs-retire.md`.

  **WHERE I LEFT OFF:** committed + pushed on claude/broad-scan-l9ojgm.
  No PR (owner asks explicitly). Mock sent; owner may refine the drill's
  content (they offered to guide from the mock).

## Increment 94 — R16h trend jump + wait-time lens (2026-08-10)

  Trend LINE point-clicks now jump to the Daily breakdown like the
  calendar when the point is a single DAY; a monthly point keeps the
  re-run (a month can't be a day drill). Wait times reached the day
  drill without a new endpoint: `getInboundHeatmapCell`'s dow/slot are
  now optional-but-paired, so omitting both answers for the whole
  from..to range (the drill passes from=to=date) while every other
  guarantee stays shared; half a pair throws rather than silently
  widening. The drill renders two labeled lenses -- DQE missed rings
  (agent + path) and inbound abandons (wait/hold + queue path) -- with
  the inbound half ADMIN-ONLY, since inboundResolveRequest_ still
  carries the Inbound report's vetting gate. Harness mocks the cell
  endpoint (hand-authored; getInboundHeatmap stays unmocked by design).
  Gates: 656/0, INV-16, ci:ui 36+16+30+14. Block in
  `.cycle/blocks/94-r16h-trend-jump-wait-lens.md`.

  **WHERE I LEFT OFF:** committed + pushed on claude/broad-scan-l9ojgm.
  No PR (owner asks explicitly).

## Increments 96–97 — R17: call grouping + Team Rings Data panel (2026-08-11)

  Owner-approved two-part round, both client-only. R17a: consecutive
  missed-timeline entries sharing (date, parentId) group under a warm
  rail -- one abandoned call that rang repeatedly; siren + id badge once
  per group, explainer on hover (no caption, owner). Plain rings can't
  group (no id in DQE; identity dies with Call_Legs). Fixture now seeds
  an ADJACENT re-rung parent (random pairs interleaved and never
  grouped) with the LATEST day always groupable (the dept default
  window drive-smoke sees). R17b: the Insights region moved INSIDE
  .dept-layout > .dept-main so the aside stickies the whole page (print
  carve re-chained); #dept-team-rings renders % Ans (rings) + Avg ans
  time + the condensed agent table (short names/full-name hover,
  per-row tallies capped at 12 blocks via ansTallyUnitFor_'s new
  optional cap, per-dept mini-groups, 10-row scroll, row-jump flash)
  from the same summary payload; the Insights rollup cards (+ title,
  removed per owner) and queue-health cards are hidden inert. Gates:
  660/0, INV-16, ci:ui 46+16+30+14. Blocks 96/97.

  **WHERE I LEFT OFF:** committed + pushed. No PR (owner asks
  explicitly). Awaiting owner's live-deploy verdict on the panel.

## Increments 98–106 — R17d–R18: always-on Calendar, then the R18 owner list (2026-08-12)

  Four merged rounds then an unmerged one. **R17d** (PR #228) made the
  Insights trend Calendar available at EVERY window length: a window too
  short to fill one falls back to the server's new year-to-date daily
  series (`trendYtd`, accumulated inside the 12-month trend pass, so no
  extra read), captioned so a grid of the year under a one-day page
  can't read as that day. **R17e–R17i** (PRs #229, #230) were owner
  polish: lens cards, chronological abandons with a hover-ⓘ, the Queue
  Call Data panel's half-width bug, per-user fold memory, the email
  tally at 20 calls/block, ring-run grouping, the redundant Insights
  header date chip removed (the dept controls are the page's single date
  authority), bucket drill onto the shared missed-ring renderer, and
  `groupConsecutiveByCall_` extracted. **PR #231** was a /sync-docs pass;
  **PR #232** split the 12.5 KB fused Inbound-capture bullet into seven
  topical bullets, all under the 4 KB ratchet.

  **R18** is the current owner list, worked in four phases and NOT yet
  PR'd. Phase 1: visual fixes (tally alignment, dark-mode select
  options, share-list scroll). Phase 2 + the phase-3 follow-on: the
  owner's ruling that **manager call volume stays in dept totals and
  rates but leaves per-agent averages and benchmarks** — INV-26's
  `TEAM_AVG_EXCLUDES` reached ONLY the Individual Report, so a manager
  on the roster diluted every Insights "vs team average". `insights:v22`
  now carries `meta.teamAvgBasis` and per-row `excludedFromTeamAvg`, and
  all four classification surfaces (headline chip, card rails, the
  call-share equal-share benchmark, the email's behind-team block) read
  ONE accessor. Phase 3 also clamps a selected To-date back to the last
  day with data — trailing empty days were deflating every per-workday
  figure (the measured 273.8/day vs 365/day disagreement). Phase 4:
  `repaintLiveCharts_` widened from the Overview chart alone to every
  visible dept-page chart, which is what made the gap chart's zero
  baseline vanish after a light→dark TOGGLE (load-in-dark was always
  fine); and the Calendar now accepts the Queue: Abandoned % metric via
  `queueHealth.ytdDailySeries` — free, because the QCD 12-month trend
  pass already spans Jan 1. Gates across the phases: 671/0, INV-16,
  ci:ui 68+16+30+14. Blocks 98–106.

  **WHERE I LEFT OFF:** R18 phases 1–4 committed on
  claude/broad-scan-l9ojgm, no PR (owner asks explicitly). Owner items
  still open: 1's second half (a Yesterday/MTD toggle on the Team Rings
  panel — needs a data decision, the rings payload has no MTD block), 5
  (Sales' agent count overruns its container), 6 (confirm the
  Gap-vs-Team colour valence on the Missed metric), 7. Standing
  constraint from an earlier round: the Spanish-vs-CSR queue-split
  separation was INVESTIGATED ONLY — owner asked for no pipeline changes.

## Increments 107–109 — R18b/R18c: tally scale everywhere, layout, blast guard (2026-08-13)

  **R18b** (PR #235): the email tally PREFERS 2 calls/block (adaptive ladder
  as fallback -- 2 wins only when it clips a strict minority, since clipping
  is only honest while rare) and the WEB all-dept report got the SAME
  one-unit scale, superseding R18's deliberate deferral (qcdDailyBarCell_
  gained opts.tallyMax so a shared-scale caller can clip). Per-agent missed
  cards moved behind a per-user fold (closed default, count on summary) with
  a measured-rank diagonal wave (waveIn_, reduced-motion-safe, `both` fill);
  heatmap waves on render. The sticky aside became a bounded flex column so
  panel 2's table shrinks instead of the column growing a scrollbar.
  qsSpotlight_ scrolls via scrollFullyIntoView_ (sticky inset from resolved
  top+height) so the spotlighted card clears the pinned strip.
  **Pre-rollout audit** (owner rolling out to managers): all RPC-callables
  verified gated (7 apparent gaps were resolver-internal gates); flagged the
  manager-visible all-dept QCD report (deliberate prior decision) and the
  client-only diagnostics hiding (own-dept data, cosmetic). **R18c**: the
  blast button's double-send gap closed BOTH directions -- fresh lastSent
  read -> danger dialog "Send a second copy" -> force:true; server refuses
  an unforced already-sent day (closes the stale-read race). Blocks 108-109.

  **WHERE I LEFT OFF:** committed + pushed, PRs #233-#235 merged; R18c PR
  pending. Owner deploying to managers today. Open: EMAIL_ALIASES /
  Team-Avg-Excludes population are operator steps; Spanish/CSR crossover
  stays a messaging caveat until QUEUE_SPLIT_SCOPE phases finish.

## Increment 110 — R18d: the Field Ops Power incident's three safeguards (2026-08-14)

  Owner found FOP + Denials agent-dark since 6/17 mid-rollout; diagnosis
  walked dashboard -> Outlier Fix (no orphans) -> Diagnostics (roster
  no-data) -> DQE sheet (no rows at all) -> Raw Data (legs present!) ->
  the build code: the phone system dropped the A_Q_* token from col W
  (Caller ID), starving the DQE build's queue recognizer. QCD flows from
  a different source, so nothing noticed for two months. Three safeguards
  shipped: (1) DqeSilenceWatch.gs -- flag-gated daily engine, per-dept
  silent-streak (QCD volume + zero roster DQE rows), one email per
  episode at days>=2 && cumulative calls>=5 (cumulative so Denials-sized
  depts alert too); DAL-read; inconclusive-on-flaky-reads; svc + OPS-8
  Health rows; operator-state #44. (2) Overview tile queue-lens badge
  (companyOverview:v21, `dqeSilence` per dept, 7-day window) -- a LABELED
  different lens (QCD calls != DQE rings), on grid tiles AND sub-queue
  cards; fixture's Billing turned out to be a live specimen, so smoke
  asserts the positive case permanently. (3) Login notify (Auth.gs,
  doGet) -- first-sighting + outcome-change emails incl. DENIED attempts,
  ON by default, capped store, operator-state #45. 693/693 (+18), smoke
  84/84.

  **R18e (same day):** owner pulled two side-by-side sample calls; the
  broken queues stamp only the originating EXT in col W where working
  queues stamp "A_Q_Name,<origin>" -- a per-queue PROVIDER setting, not
  a feed change (the CSR leg of the same call was fine). Fix shipped in
  the build (both INV-16 copies): pre-pass ext->queue-name map from the
  file's own queue-callee legs; fallback fires only when col W fails AND
  caller is CallQueue(<ext>) AND the ext named a queue today. Col W wins
  when it matches (byte-identical normal path); unresolvable ext stays
  dropped. Pinned with the incident's sample-row shapes. Repair is now
  PLAIN FORCE RE-IMPORT of the surviving window -- no col-W editing.
  known-issues gained the full incident entry.

  **WHERE I LEFT OFF:** PR #239 (safeguards) open unmerged; R18e commit
  going into the same PR. OPEN OPERATOR WORK: ask the provider to restore
  the per-queue caller-ID setting (FOP + Denials vs Manual Mobility);
  after deploy: force re-import the surviving ~14-day window,
  backfillDQEHistoryUpsert() if on neon, install the watchdog trigger.
  6/17->retention-floor agent history is unrecoverable.

## Increment 111 (2026-08-14) — R19: error beacon + usage telemetry (post-#239)

  PR #239 MERGED (squash f43b9c8) + branch reset onto main. Then two
  owner asks in one round: (a) editor-run trigger/status RPCs now
  Logger.log their status JSON via Util.gs::logStatusReturn_ (23
  callables, 9 engines) -- the Apps Script editor discards return
  values, so "started/completed and nothing else" read as a no-op.
  (b) R19 rollout observability: reportClientIssue beacon (client
  listeners for EVERY user + 4 top-level load-failure handlers ->
  immediate admin email, sig-throttled 30min + 15/6h window cap);
  'overview' landing rows (auto-refresh/Retry pass auto:true, not
  logged); 'escalations' page-entry rows (pageView flag only from
  setPage); Health usage section gained a collapsed per-user
  "User activity (last 30d)" rollup (cap 40, top-3 digest). 699/699
  (+5), one new CLAUDE.md bullet, block 111.

  **WHERE I LEFT OFF:** ci:ui was finishing at write time (client
  fragments touched -- must be green before PR). UNANSWERED to owner:
  the feedback-box question (recommendation drafted: yes, email-only +
  html2canvas screenshot + optional anonymity, reuse beacon throttle;
  do NOT build a sheet-backed inbox). Not yet PR'd -- owner merges on
  explicit word. Operator work outstanding from #239 unchanged
  (provider ticket, force re-import, watchdog install,
  NOTIFY_ON_NEW_ESCALATION property now set by owner? -- they said
  "Set NOTIFY_ON_NEW_ESCALATION=true" but only they can do it in
  Script Properties; instructions given).

## Increment 112 (2026-08-14) — R20: per-dept escalation counts + Spanish threshold

  (a) getEscalationsBadge now GROUPs by department; totals summed from
  the groups (can never disagree); byDept lists open-carrying depts
  busiest-first ({dept, open, overdue}). Strip + Company-snapshot line
  render "(Sales 2 · CSR 1)" suffix, capped at 4 named + "+N more"
  (escDeptCountsHtml_, script-2-chrome; reused by ovAggEscRender_).
  Badge is viewer-scoped as before. Pinned in escalations-hardening.
  (b) Spanish abandoned threshold: AbandonedFilter.js 0:00:01 -> 0:00:59
  + CDR Tools menu label. NOTE: that's the MANUAL filter tool; the QCD
  Historical engine (calcQcdReport) keys per-queue rules to QCDR Output
  sheet rows -- row 40's dynamic block counts abandons waitDec > 0 into
  its TOTAL (the only >0s rule in the engine). Whether row 40 IS Spanish
  is sheet data (A40) we can't see from the repo -- owner asked to check;
  if yes and they want QCD parity, it's a 2-line change (r40_tot2/tot4
  -> time1Min) that shifts Spanish's reported totals going forward.
  (c) Agent-role question: thoughts delivered, NO changes (owner said
  don't build yet). Recommended start = own data + team AGGREGATES only
  (no per-teammate rows, anonymized or not -- small cohorts make
  anonymity cosmetic); per-dept configurability if managers differ;
  key build precondition = email->roster-name mapping (Access Control
  has no agent-name column today).

  **WHERE I LEFT OFF:** ci:ui running at write time; commit after green.
  700/700 unit. R19+R20 commits unPR'd on the branch (owner merges on
  explicit word).

## Increment 113 (2026-08-14) — Agent role Phase A (broad-implement)

  Owner approved the agent-role plan with three decisions (rank line
  build-hidden; CSR pilots; missed list + wait time where derivable) and
  commissioned Phase A. SHIPPED DARK behind AGENT_ROLE_ENABLED (unset =
  byte-identical pre-agent behavior): Access Control grew Role + Agent
  Name (blank Role = manager; acEnsureSchema_ heals old headers on next
  editor save; agent rows validate one-real-dept + exact roster name);
  resolveUser_ resolves agents to the FAIL-CLOSED shape (departments [],
  identity only in agentDept/agentName; manager rows win; unknown roles
  drop); assertDeptAccess_ + escAssertRowAccess_ became explicit
  admin/manager ALLOWLISTS (the audit found the old role-none denylist
  passed unrecognized roles UNPINNED -- the role model's recurring
  defect, 5th sighting); assertManagerOrAdmin_ gates the un-pinned
  all-dept surfaces (Overview, YTD trend, qcdAllDept, sendQcdAllDeptEmail,
  esc init/badge, getCallJourney); doGet allowlists the dashboard render.
  Agents CAN reach latestDate + the error beacon (deliberate). 715/715
  (+15), block 112, operator-state #46.

  **WHERE I LEFT OFF:** ci:ui finishing at write time; commit gated on
  it. Everything since PR #239 is unPR'd on the branch: R19 (beacon +
  telemetry), R20 (esc dept counts + Spanish 59s), agent plan + mocks,
  Phase A. Owner merges on explicit word. OPEN QUESTIONS to owner:
  QCDR Output cell A40 (is row 40 Spanish? 2-line QCD-parity change on
  confirm); feedback-box build (recommended email-only + screenshot,
  awaiting go). Phase B next on owner word (My Performance page +
  getAgentHome + harness agent build + modal UI for agent rows).

## Increment 114 (2026-08-14) — Agent role Phase B (broad-implement)

  PR #240 MERGED first (R19+R20+plan+Phase A+Spanish row-40 -- A40
  confirmed A_Q_Spanish, both >0s clauses -> time1Min, forward-only).
  Then Phase B SHIPPED: AgentHome.gs (getAgentHome -- self-only identity,
  INV-05 reconciliation choice, roster-only team aggregates, ordinal
  rank shipped hidden, DAL trend + missed timestamps, TEAM/ME two-tier
  cache, teammate-privacy pinned), agent.html+agentApp.html (SEPARATE
  small template -- recorded deviation from the plan's single-doc
  sketch; SVG trend, beacon, presets off getLatestDataDate), doGet
  routing, Access modal Agents section (roster-name picker), and the
  harness grew build-agent+drive-agent as BLOCKING ci:ui stages
  (13 checks incl. rendered teammate-name privacy). 722/722; ci:ui all
  stages; block 113. Feedback box SHELVED by owner.

  **WHERE I LEFT OFF:** Phase B complete on the branch, unPR'd (owner
  merges on explicit word). Next: owner word to PR/merge; then Phase C
  when commissioned (My History, wait-time join, view-as-agent,
  CLAUDE.md role bullet). Go-live runbook in operator-state #46.

## Increment 115 (2026-08-14) — Agent role Phase C (broad-implement): CODE-COMPLETE

  PR #241 (Phase B) MERGED first. Phase C then shipped the rollout's
  remainder: (1) WAIT TIME on missed rings -- derivable and built
  (ahWaitJoin_: journey missed-ring events by exact name, PST t +2h ->
  CST slot axis; ring secs + elapsed-from-pickup wait, "waited" label,
  capture-bounded, drop-on-ambiguity, bare timestamp when unknown);
  (2) MY HISTORY (getAgentHistory: INV-29 window, monthly INV-25
  weighted ATT with the in-page disclosure, team-avg from roster rows,
  10-call best-month floor, agentHist:v1 dept cache, privacy pinned;
  dual-line SVG + month cards tab); (3) VIEW-AS-AGENT
  (?agentPreview=dept||name, Access modal Preview link, warn banner,
  rides the existing admin path); (4) glossary fold; (5) CLAUDE.md
  agent-role bullet (role-model bullet is ratchet-frozen -- new bullet
  instead) + subsystem list + plan closeout. drive-agent now 20 checks.
  725/725. Block 114.

  **WHERE I LEFT OFF:** ci:ui full run finishing at write time; commit
  gated on it. Phase C unPR'd on the branch -- owner merges on explicit
  word. The agent role is CODE-COMPLETE; go-live = operator-state #46
  (CSR rows + AGENT_ROLE_ENABLED=true + agent emails). Open owner
  decisions: rank-line reveal (AGENT_RANK_SHOW_); feedback box still
  shelved.

## Increment 116 (2026-08-14) — /sync-docs after the agent rollout

  Drift found + fixed: the role-model bullet's "Three roles" (stale
  since Phase A) -> "Four roles" with a pointer to the agent bullet,
  byte-compensated inside the same grandfathered bullet by trimming the
  F13 narrative aside (F13 still resolves in fix-history); the ci:ui
  Key-commands block (FOUR drivers -> SIX stages incl. the agent pair;
  re-run list + suite roll updated); docs/invariants.md INV-30 gained
  agentHome:v1/agentHist:v1. Verified resolved: README scriptId
  placeholder drift (no stale string exists). Weight: 173.6KB /
  ~26KB headroom -- watch it. 725/725; split+cache-sync tests green.

  **WHERE I LEFT OFF:** committing; then PR (Phase C + doc sync) +
  merge on the owner's standing instruction.

## Increment 117 (2026-08-14) — R21: System Health load split

  Owner (testing the redeploy): the full Health report loads slowly.
  Diagnosis: the two Neon mirror probes are the page's ONLY live-Neon
  rows, and outside the keep-warm window they pay the free-tier cold
  start (~15s) INLINE in the single getSystemHealth call. Fix:
  getSystemHealth({part:'fast'|'neon'|'all'}) -- fast (property reads +
  bounded sheet tails) paints immediately with a muted "checking…"
  placeholder in the neon section; the neon part (the shared-conn
  mirror block, verbatim) streams in and replaces it (stale-token
  guarded; warn row on probe failure; summary line notes the pending
  check). Default 'all' byte-identical (editor runs + old tests
  untouched). Pins: fast opens NO conn; neon opens exactly one and
  returns only the two mirror rows; fast+neon == all by key set (the
  third-bucket drift tripwire). 728/728.

  **WHERE I LEFT OFF:** ci:ui running; commit+push after green. UnPR'd
  on the branch; owner merges on word.

## Increment 118 (2026-08-15) — Queue-split adoption round: ship list COMPLETE

  All remaining DQE readers adopted the ONE narrowing helper: Missed
  (both paths unified onto the DAL fetchers, counts + K..AC timeline
  via per-queue mt with narrowSlots), IR + Insights (sheet reads
  widened to col AI, REP-10-bounded), Overview (company pass split
  from per-dept attribution; hero stays all-queue by design; 90d+YTD
  trends; clone-per-dept via NEW queueSplitNarrowedCopy_), Alerts
  (threshold now evaluates the displayed number; clones of the shared
  memo), agent app (detail+history). Scope suffix on EVERY narrowed
  surface's cache key. 732/732 (+4 helper pins incl. rollback-restores-
  slots + shared-original-pristine); all reader suites + ci:ui green.
  #42 rewritten: ship list COMPLETE + the 3-step flip checklist.

  **WHERE I LEFT OFF:** committing; PR + merge on the owner's standing
  instruction. THE FLIP is now operator-side: audit -> property ->
  crossover spot-check (CSR/Spanish).

## Increment 119 (2026-08-15) — Overview e2e suite + doc sync

  The adoption round's follow-on closed: tests/unit/company-overview.test.js
  (4) runs the REAL getCompanyOverview against a DQE fixture with stubbed
  sub-probes -- pins the off-mode Phase 0 double-count (crossover agent
  all-queue in both tiles; company aggregate counts each row once; sentinel
  reaches nothing), the dept-mode PARTITION (11+4=15 with the no-split row
  failing open), the no-cross-dept-leak shape on the shared row array, and
  the all-queue hero invariance under the flip. 736/736. /sync-docs: the
  CLAUDE.md test-suite roll gains the new suite; no other drift (the
  adoption round's docs landed with it).

  **WHERE I LEFT OFF:** committing; PR + merge per the owner's standing
  instruction. All follow-ons from block 115 now closed except the
  cosmetic narrowed-surface client chips (on demand).

## SESSION CLOSEOUT (2026-08-15) — everything merged, branch clean

  All work through increment 119 is MERGED to main (PRs #233-#244) and
  the branch is reset onto main. 736/736 unit tests, INV-16, ci:ui all
  stages green on the merged state. The rollout arcs completed this
  session: R18 tally/report polish, the Field Ops Power incident
  (root-cause fix + watchdog + queue-lens + login notify), R19
  observability (beacon + telemetry + Health per-user), R20 esc dept
  counts + Spanish threshold (both spots), the AGENT ROLE (A/B/C,
  code-complete, dark), R21 two-pass Health load, the QUEUE-SPLIT
  ADOPTION ROUND (ship list complete), and the Overview e2e suite.

  **OPEN OPERATOR ACTIONS (owner-side, not code):**
  1. DEPLOY the dashboard (last owner deploy predates PRs #243/#244).
  2. Queue-split FLIP when ready: operator-state #42 checklist
     (auditQueueSplitAttribution -> QUEUE_SPLIT_SCOPE=dept ->
     CSR/Spanish crossover spot-check).
  3. Agent pilot go-live when ready: #46 (CSR agent rows + emails ->
     AGENT_ROLE_ENABLED=true).
  4. VERIFY from the R18e incident: was the force re-import of the
     surviving Call_Legs window run before retention pruned it? And
     the provider ticket (per-queue caller-ID on FOP + Denials vs
     Manual Mobility) -- the fallback covers recurrence either way.
  5. Routine: COMPANY_HOLIDAYS yearly (#27); optional Neon backup
     trigger if not installed (#28).

  **OPEN CODE FOLLOW-ONS (all small, none blocking):**
  - "Narrowed" indicator chips on IR/Insights/Overview when scope=dept
    (the dept table already explains itself) -- cosmetic, on demand.
  - Rank-line reveal: AGENT_RANK_SHOW_ (one client constant), owner's
    call. Per-dept agent visibility (self|team Dept Config column)
    only if a manager asks. Feedback box SHELVED by owner.
  - The heatmap cell drill's "wait/hold" label still reads as queue
    wait while wait_seconds is elapsed-from-IVR-pickup (the OLD open
    follow-on in the QCD-vs-inbound gotcha) -- one label fix.
  - Doc weight: CLAUDE.md ~174KB of the 200KB cliff (~26KB headroom).
    The next /sync-docs should hunt trims, not just staleness.

  **WHERE I LEFT OFF:** nothing in flight. A fresh session can run
  /cycle-resume for continuity or /broad-scan for a new audit cycle
  directly; this entry is the baseline.

## Increment 120 (2026-08-17) — Live presence: "Active now" on the Health page

Owner request: "see who is using the app live — could allow timing of
rollouts easier/less jarring." Built end-to-end:

- `SystemHealth.gs::recordPresence` (public; any signed-in role incl.
  agents, role `none` rejected — the reportClientIssue gate class).
  INV-01-clean: CacheService only (`presence:v1`), lossy no-lock
  read-modify-write (next beat heals), prune 900s, active window 360s,
  cap 100 entries (stalest dropped). `readPresence_` is the read side.
- getSystemHealth FAST part gains a `presence` section rendered FIRST:
  "Active now (last ~6 min)" summary + one muted row per user
  (email · role · page · age). Muted like usage — information, not a
  health state. The R21 fast/neon key-set pin holds (presence is fast).
- Heartbeats: script-1-core (dashboard, `data-page` as page) +
  agentApp.html ('agent') — on load, every 150s while
  `document.visibilityState === 'visible'`, re-beat on
  visibilitychange→visible; fire-and-forget, never throws.
- Harness: `recordPresence` mocked in build-harness.js handlers AND
  build-agent.js runner api (both drives assert no unmocked RPCs).
- Tests: +6 in system-health.test.js (store+render, nobody-active,
  role-none/agent gate, prune-vs-active windows, cap keeps fresh beat,
  corrupt-JSON self-heal). 742/742. CLAUDE.md R19 bullet extended.

NOT merged — on the branch awaiting the owner's word (the SESSION
CLOSEOUT commit f9c8442 is also still unmerged; one merge carries both).
Operator note: the section self-populates only after the NEXT deploy
(clients must ship the heartbeat before anyone shows as active).

## Increment 121 (2026-08-18) — R22: clamp-note fade, 4% abandon standard, tiered Viol MTD

Three owner requests in one round:

1. **Clamp-note auto-fade** (script-2-chrome + styles): the R18 To-date
   "Adjusted to ..." note fades out ~6s after rendering (0.6s opacity
   transition; re-clamp resets timer + opacity). The To field itself still
   shows the corrected date.
2. **Abandon standard 5% -> 4%** across all three layers:
   - PIPELINE: `QCD_VIOLATION_ABANDON_RATE = 0.04` (cdr-import
     autoImport.js — one constant, both the daily and bulk QCD writers).
     Col L flags are written at import time, so HISTORY keeps its 5%-era
     flags; current-month MTD counts mix eras until (optionally) rebuilt.
   - SERVER display: `Config.gs::ABANDON_STANDARD_PCT = 4`, consumed by
     QueueReportEmail.gs (tiers, preheader, offenders, tally/bar tints)
     and InboundReport.gs (insurer daily tint).
   - CLIENT: `ABANDON_STANDARD_ = 4` (script-1-core), read by
     benchValueCls_, Overview chips + trend baseline (OV_BASELINE_LABELS_),
     Insights QCD chart (QCD_THRESH_LABEL_ centralizes the reference-line
     label sentinel), heatmap ramp + legend, QCD all-dept boot (hero tone,
     tick now positioned inline at standard*10% of the 0-10% bar),
     E9 forecast gate, dept/escalations table tints, glossary/help prose
     (dashboard.html), headline composers.
   - PINNED: cross-file-pins.test.js "R22" test — client == server == 
     pipeline*100. queue-report.test.js pins updated to the 4% strings.
3. **Tiered Viol MTD chip on Overview** (script-3-overview + styles):
   the "N viol MTD" chip now ALWAYS renders — 0 green (.ov-qcd-viol-none),
   1-2 amber (.ov-qcd-viol-low), 3+ red (.ov-qcd-viol-high). Day-level
   per-queue chips keep the binary warn treatment.

Docs synced: CLAUDE.md (heatmap C2 + E9 mentions, byte-neutral),
invariants.md INV-51 live claims, conventions/known-issues/client-ui/
regression-scenarios 5%->4% mentions, neonbackfill.js gate comment.
743/743 unit; ci:ui re-run for the client changes.

OPERATOR NOTE (era mix): QCD col L history keeps 5%-era flags. A day at
4.5% before the redeploy is NOT a violation in history but would be one
now. If a clean current month matters, force re-import (or rebuild) the
current month's dates after deploying cdr-import so col L re-evaluates
at 4%; then the Neon mirror re-upserts. Otherwise the mix ages out at
the month boundary.

## Increment 122 (2026-08-18) — R23: display-standards registry + coaching engine Phase 1

Owner round (same message as increment 121's items): threshold/color-coding
overhaul + the ratified turnover-suggestion Phase 0.

- **Standards registry.** `ANSWER_TARGET_DEFAULT` 92 -> 80;
  `ANSWER_AMBER_BAND_DEFAULT`=10; `DEPT_ANSWER_TARGET_SEED` CSR=92/2;
  `TRANSFER_TIERS_DEFAULT` 25/30/35. Three Script Properties layer over the
  seeds (`ANSWER_TARGETS` gains `band=`; new `DEPT_ANSWER_TARGETS`
  `Dept=target/band`; new `TRANSFER_TIERS`), read via
  `getAnswerStandardFor_(dept)` / `getTransferTiers_` /
  `getStandardsBundle_` (Util.gs). One save RPC (`saveAnswerTargets`,
  extended req) writes all three, all-or-nothing validation before the lock.
- **Three-tier answer tints everywhere.** benchValueCls_ gained a `dept`
  param -> green/amber(bm-watch)/red(bm-bad); wired: agent table bar + pct
  cell (row.dept-aware for combined views), dept team-strip hero (target
  tick now per-dept), Overview tile goal-gap sparklines (per-dept goal),
  IR cards (irLastDept_), Insights KPI tiles + headline tones (dept-aware
  headlineTone_/irHeadlineTone_), Direct/Inbound surface targets (three-tier
  with the global band), Digest verdict + DeptSummaryEmail + Insights email
  (getAnswerStandardFor_(dept)), agent app (server-resolved __ANSWER_STD__,
  new answerRateCls_ + .bad tier).
- **CSR Transfer % tile tiers** (tf-deep/light/amber/red) per owner cuts.
- **Reference + editor.** Help topic "The color-coding standards" renders
  LIVE values from __STANDARDS__ (fillStandardsHelp_); Alerts modal section
  renamed "Display standards" with band / per-dept / transfer fields.
- **Coaching engine (dark).** New Coaching.gs: coachingWindowFromLatest_
  (10 working days, holiday-aware), computeCoachingFlags_ (rate<50 AND
  >=5pts behind team AND >=20 missed; TEAM_AVG_EXCLUDES out of both team
  aggregate and candidacy; roster-only rows), previewCoachingFlags (admin,
  read-only, per-dept best-effort) + runCoachingPreview editor wrapper.
  Owner rulings recorded: delivery later = email + escalation card but a
  SEPARATE worklist from customer escalations; no pilot dept — all depts,
  admin-only notifications until released.
- Tests: answer-targets 11 (band/dept/transfer/bundle), coaching 8 (new),
  cross-file R23 fallback pin, dept-summary-email pin 92->80. 758/758.
  Harness: __STANDARDS__ + __ANSWER_STD__ injections in build-harness /
  build-agent. Docs: operator-state #37 rewritten; CLAUDE.md tint mentions.

Deploy: dashboard only (this increment). NOT merged — awaiting owner word.

## Increment 123 (2026-08-18) — /sync-docs after R22/R23

Drift fixes only: Coaching.gs added to the Subsystems list; INV-50's
violation gate + queue-mapping wording (4% / getDeptQcdQueues_);
regression S-232 tint standard; known-issues then-5% annotation;
client-ui-conventions + README benchmark-tint paragraphs rewritten to the
R23 three-tier / per-dept semantics; CLAUDE.md Direct bullet tint wording
(byte-compensated). Weight: CLAUDE.md 175 KB / 200 KB budget (~25 KB
headroom) — trim hunt still an open follow-on. 758/758, ratchet + INV-16
green. Docs-only (no ci:ui needed).

## Increment 124 (2026-08-18) — Coaching: ratio gate replaces the absolute floor

First live `runCoachingPreview` (window 2026-08-03..08-14, 15 depts) returned
20 flags and showed the absolute gate was inert: this is RING-level data, so
every dept's team aggregate sits at 17-49% and a fixed 50% floor is above
every agent everywhere. The only gate filtering was "5 pts behind team",
which off a 39% average is ring-distribution noise.

Owner ruling: replace the floor with a RATIO — flag when an agent answers
less than half as often as their teammates.

- `COACHING_ANSWER_BELOW_PCT_` (50) -> `COACHING_MAX_TEAM_RATIO_` (0.5);
  gate is now `rate < teamRate * ratio`. `COACHING_BEHIND_TEAM_PTS_` (5)
  stays as an absolute FLOOR beneath it, so a tiny team rate can't
  manufacture flags (half of 3.5% is a 2.5-pt gap = noise). Volume gate
  unchanged. New guard: teamRate <= 0 yields no flags.
- Flags carry `teamRatioPct` ("answers N% as often as the team") and sort by
  it (worst relative standing first, gap as tiebreak); the editor log line
  and `thresholds.maxTeamRatio` follow.
- Expected effect on the owner's live data: 20 -> ~10 flags; Rosie Sarkar
  (0.503) and Monica Jeremiah (0.502) sit ON the line and may land either
  side once computed from unrounded rates.

NOT changed, per owner: cross-dept de-duplication (Shamir Alam is flagged
under both Manual Mobility and Eligibility MM&R with identical whole-day
figures — owner investigating) and the 0%-answered cases (owner confirms
those are genuinely being rung and not answering, so they are real flags,
not roster artifacts).

Tests: coaching 11 (was 8) — ratio spare/flag pair, the ring-level
whole-team-under-50% case, the points floor still holding, the zero-team
guard. 761/761. Engine-only; still dark (no delivery).

## Increment 125 (2026-08-18) — R24: workday prior windows, region header removed, scoped esc banner, IR perf

Four owner items in one round:

1. **INV-28 REDEFINED to working days (owner: "0% vs Sunday").** The shared
   `computePriorWindow_` (Data.gs) + the client `resolveComparisonWindow_`
   (script-6) now produce the immediately-preceding window with the SAME
   WORKING-DAY count (Mon-Fri minus COMPANY_HOLIDAYS), ending on the last
   working day before `from` -- a Monday compares to Friday. Zero-workday
   (weekend-only) windows keep the legacy calendar math. Every consumer
   inherits (E5 chips, Insights auto-prior, IR prevPeriod, Direct
   kpisPrior, Inbound priors). INV-30 bumps for the keys that don't encode
   the prior window: summary v19->v20, directCall v3->v4, inbound v8->v9
   (IR/Insights keys carry the prior window, no bump). invariants.md
   INV-28 + INV-30 rewritten; cache-version-sync tables updated.
2. **Insights region headline REMOVED (redundant).** The #ins-region-head
   live stats (answered · missed rings · abandoned % · window) on the
   region <summary> retired -- the report's own sticky results header
   carries the same facts. Summary stays as the collapse toggle with the
   static sub line; insRegionHeadSync_ is a stub.
3. **Overview escalations banner scoped.** The top-of-Overview strip now
   shows managers only their own depts' OPEN escalations (server counts
   were already dept-scoped; the show condition dropped 'review'-only
   triggers); admins / ALL-sentinel viewers keep the company-wide banner.
   View-as-Manager now narrows the strip client-side to the previewed
   dept via byDept (was showing the admin's company-wide counts). Nav-tab
   badge unchanged (worklist affordance).
4. **IR (and Insights) load perf.** neonFetchDqeRows_ gained opts.agents
   (prepared-statement IN filter, skip on empty/>300): IR + Insights now
   fetch the 12-month union window for roster ∪ selection ONLY (~1 dept
   instead of all 14 -- the whole-window json_agg was the dominant cost).
   Aggregations only ever read roster/selected rows (team totals are
   rosterSet-gated), so payloads are identical -- pinned by the existing
   parity suites.

Tests: prior-window pins recomputed (compute-summary E5, IR R8-D3,
insights x2 -- fixtures moved off the weekend dates). 761/761; INV-16 +
ratchet green. MERGED in PR #247 together with increment 126.

## Increment 126 (2026-08-18) — Neon egress round (transfer cap incident)

Owner hit Neon's monthly public-transfer cap mid-month (managers live).
/broad-implement: ship R24 + three egress cuts. See
.cycle/blocks/126-egress-broad-implement.md for the full summary block.
Key design point: the 6 h report TTL required the reportFreshnessTag_ key
suffix (latest DQE date) -- overviewCacheKey_ had no date anchor, so a long
TTL alone would have hidden each morning's ingest for hours. dal-cutover's
fake conn now mirrors the positional array protocol keyed off the real SQL.
761/761; merged per the owner's "R24 deploy" instruction.

## SESSION CLOSEOUT (2026-08-18) — all merged, deploy pending

**Baseline:** everything through increment 126 is MERGED to main (PRs
#245–#247); branch `claude/broad-scan-l9ojgm` == `origin/main` == 3fd04a8,
working tree clean. 761/761 unit tests, INV-16, CLAUDE.md ratchet,
cache-version-sync, and ci:ui (164 checks) all green on the merged state.

**THE ONE BLOCKING THING: nothing since the manager rollout is DEPLOYED.**
The dashboard's last owner deploy predates PRs #243–#247. Undeployed and
waiting: live presence, R22 (clamp fade / 4% abandon standard / tiered Viol
MTD), R23 (display-standards registry + dark coaching engine), R24 (workday
prior windows / region-header removal / scoped esc banner / IR agent
filter), and the Neon egress round. cdr-import is ALSO undeployed (the 4%
violation gate lives there).
  1. `clasp push -f` from repo root -> Manage deployments -> New version
  2. `cd apps-script/cdr-import && clasp push -f`

**NEON TRANSFER-CAP INCIDENT (live):** the owner exhausted Neon's monthly
public-transfer allowance ~Aug 18. Reads fall back to the sheet
automatically; the Neon-ONLY surfaces (Escalations, Inbound + heatmap,
Direct, Caller Lookup, journey drills, agent wait chips) render their
"unavailable" states until the Sep 1 reset. The egress round above is the
fix (est. 20-50x cut on the dominant read path) but only once DEPLOYED.
  - Optional stopgap: `DQE_READ_SOURCE=sheet` (property, reversible) to
    conserve remaining transfer for the no-fallback surfaces.
  - **SEP 1 (dated, do not miss):** run `backfillInboundCalls` +
    `backfillOutboundCalls` (cdr-import editor) FIRST, then
    `runNeonCoverageCheck`. `inbound_calls`/`outbound_calls` have no sheet
    primary and rebuild only from `Call_Legs_*`, which prunes at ~14 days --
    gap days that age out are permanently lost.
  - Owner ruling recorded: NO sheet twins for Escalations / Inbound /
    Direct (dual-source drift cost > outage-window benefit). Paid Neon tier
    suggested as the structural fix; owner has not ruled.

**OTHER OPEN OPERATOR ACTIONS:** queue-split flip checklist (#42); agent
pilot go-live (#46); COMPANY_HOLIDAYS yearly (#27); optional Neon backup
trigger (#28).

**NEXT PLANNED WORK (owner-directed, not started):**
  - **Outbound report**, parked until Neon is stable. Reads the UNUSED
    Neon `outbound_calls` per-call table (NOT the Direct report, whose
    outbound slice is a different, narrower population). Phases: 1 server
    `OutboundReport.gs` + tests, 2 client page, 3 owner vetting, 4 manager
    un-gate, **5 callbacks cross-reference (owner explicitly wants this in
    the plan)** -- outbound calls to a hash that recently abandoned inbound,
    i.e. "did we call back the ones we missed?". Caveats to caption: the
    CDR cannot distinguish no-answer/voicemail/busy, so `connected` means
    "something picked up"; attribute by the dialing agent's ROSTER dept,
    not the raw CDR org label.
  - **Coaching Phase 3** (delivery) once the owner has vetted a few
    `runCoachingPreview` runs against the new ratio gate. Owner rulings:
    email + card in a SEPARATE coaching worklist (never mixed into
    customer-account Escalations), all depts, admin-only until released.
    Owner is separately investigating the crossover double-count (Shamir
    Alam appears under two depts) and confirmed 0%-answered agents are
    genuine flags, not roster artifacts.

**WHERE I LEFT OFF:** nothing in flight, nothing uncommitted. A fresh
session can `/cycle-resume` for continuity or start directly on the
outbound report once Neon is settled.

## Increment 127 (2026-08-19) — /broad-scan + /broad-implement: the audit's top 5

Fresh /broad-scan (3 stages) then /broad-implement of its final top 5. Full
summary block: `.cycle/blocks/127-broad-scan-top5-broad-implement.md`.

**The audit's shape.** Security came out clean — all 119 public RPC endpoints
gated, checked mechanically then by hand; SQL parameterized; escaping and
failure-handler coverage (a literal 1:1 withSuccess/withFailure ratio across
all 12 client fragments) exemplary. The findings clustered instead in
CROSS-PROJECT CONSISTENCY (6/10, the weakest dimension) and DEPLOYMENT HYGIENE
(5/10) — i.e. not "is the code right" but "do the copies agree" and "is it
running".

**Implemented (773/773 tests, +12; INV-16 green; ci:ui pending in CI):**
1. **F1** — `dataFilters.js` (Extraction Sidebar) row-40 still used the >0s
   abandon rule that R20 moved to >1min in `autoImport.js`. The sidebar listed
   rows the pipeline doesn't count, so a Spanish reconciliation read as "the
   pipeline is under-counting" — from the tool built to prevent exactly that.
2. **F2** — that duplication was unguarded. `check-duplicated-files.sh` gained
   a normalized (indentation-agnostic) function-pair check for
   `simulateSplitCol2`/`parseDurationDecimal`, AND a `cross-file-pins` "R20
   row-40" pin, because the primitives guard alone would NOT have caught F1 —
   the row RULES are structurally different code and can't be diffed.
3. **F12** — System Health's failure classifier read 80 Pipeline Health rows
   while the Overview banner (post-LM1) reads 250. Same eviction, opposite and
   worse outcome: LM1 was a false WARN, this was a false ALL-CLEAR on the page
   CLAUDE.md calls the single trustworthy pipeline signal. Now 250 + the OK
   text states its measured scope.
4. **F11** — the B-2 blindness in the QCD dimension. Two readers open the QCD
   sheet with no `getQcdReadSource_` path; there was no tripwire (and both use
   a string literal, so a constant-based one would have missed them). Added the
   tripwire keyed on the getSheetByName CALL (prose-matching flags six
   innocent files and gets muted), with a 3-entry allowlist carrying reasons
   AND consequences — notably that QueueReportEmail's deliberate sheet read
   BLOCKS retiring the QCD sheet, which #30's cutover framing implies is
   possible. Also made `saveDeptConfig` fail OPEN on an empty queue universe:
   it was rejecting every queue name while itself reporting "No QCD queues
   found in recent data".
5. **F5** — Neon transfer exhaustion was unmonitored; every probe said
   "reachable" right up to the cliff, because a Neon that has spent its
   allowance IS reachable. Added a month-to-date read-volume gauge (Script
   Property, INV-01-clean, lossy by design) metering ALL 14 bulk json_agg
   fetch sites — metering only DQE would under-report exactly the Neon-only
   surfaces that go dark — plus a Health row that stays muted until the
   operator declares `NEON_EGRESS_BUDGET_MB`, and is explicit that it is a
   FLOOR (over budget proves a problem; under budget does not prove headroom).

**F6 (undeployed rounds) was in the top 5 and is OPERATOR-ONLY — no code.**

**⚠ DEPLOY ORDER (new, blocking).** cdr-import is undeployed, so the LIVE
pipeline still runs the old >0s row-40 rule and the live sidebar currently
AGREES with it. Deploying cdr-report alone would make the sidebar LEAD the
pipeline — the same mismatch, inverted. Deploy cdr-import and cdr-report
together (cdr-import also carries the 4% violation gate).

**NOT walked:** the manual Regression Scenarios — headless session, no
deployed build. S36 (Dept Config validation round-trip) directly covers a
behavior change here and needs a human.

**Open follow-ons from the audit, not implemented** (full detail + effort
batches in the block): F10 `runNeonMirror_` has no runtime budget and wedges
silently past the ~6-min ceiling; F3/F3b four 6h cache keys missing
`reportFreshnessTag_` + two prefixes missing from the version-sync SPECS; F4
unbounded login-notify emails past 300 keys; F7 ~1,700 lines of live,
menu-reachable, zero-test cdr-report code (where F1 hid); F8 `time1Min` is
">60s" not "~59s". Docs needing sync are listed in the block.

**WHERE I LEFT OFF:** all five code findings implemented and green on the
branch; nothing in flight. Next: commit + PR, then the blocking deploy-order
action above. `/sync-docs` is warranted — six documentation updates are
enumerated at the end of the block, including one where CLAUDE.md asserts as
fact ("every heavy report key carries reportFreshnessTag_") something F3 shows
is not true of four keys.

## Increment 128 (2026-08-19) — Batch A (operator) + Batch B (silent-failure closers)

PR #249 (broad-scan top 5 + doc sync) MERGED to main first. Owner then
completed **Batch A**: cdr-import + cdr-report + dashboard all DEPLOYED,
`runLiveSmoke` all passed, `NEON_EGRESS_BUDGET_MB` set to 5000. That closes
the deploy gap that had been the audit's #1 finding twice running — the 4%
violation gate and the Neon egress cuts are now actually running.

**Batch B shipped (779/779, +6):** the remaining silent failures.

1. **B1/F10 — the deferred mirror could wedge forever.** `runNeonMirror_` had
   no clock check, so a multi-day Neon outage grew the queue until one pass
   exceeded the ~6-min ceiling; then it died at the same point every run.
   Silent twice over: the queue rewrite is at the BOTTOM (timeout preserved
   the queue, emitted no summary) and the IMP-6 counter increments only on a
   THROW (a timeout never counted an attempt, never hit the retry cap, never
   emailed). Now `NEON_MIRROR_BUDGET_MS` (4 min default), untried dates keep
   their attempt count, and a `neonMirror:budget` row says what was left.
2. **B2/B5 — four 6 h keys joined `reportFreshnessTag_`.** The inbound insurer
   drill was the real one: it hangs off a byInsurer ROW whose key DOES carry
   the tag, so a same-day re-import refreshed the row and left the drill
   disagreeing for 6 h. No INV-30 bump (suffix, not an aggregation change —
   the CORE-3/S2-0 precedent).
3. **B5/F3b — `agentHome`/`agentHist` were in the INV-30 docs but not in
   cache-version-sync's SPECS.** Documented and unenforced: the one
   combination that suite exists to prevent.
4. **B3/F4 — login-notify emailed on EVERY visit past the 300-key cap.** The
   old branch notified WITHOUT recording, so each visit was a fresh "first
   sighting". Now evicts oldest + records: one email per address. The
   trade-off it was defending (extra signal beats blindness) was being paid
   for out of the MailApp quota that carries alerts and digests.
5. **B4 — Health row for `MailApp.getRemainingDailyQuota()`.** Same shape as
   the F5 Neon gauge: one shared exhaustible resource, silent when dry.
   Absolute floor (50), not a percentage — the quota is plan-dependent.

**Harness:** `fakeSheet` gained `Range.clearContent` (a real method that was
missing; a no-op stub would have made the B1 tests pass vacuously) and the
MailApp shim gained `getRemainingDailyQuota`.

**Found but NOT fixed (out of the named scope):** `neonAgentExts:v1`
(NeonRead.gs) is a 6 h cache with no freshness anchor. Low impact — it backs
the derived `getDeptQueueExts_` path and scope is locked to `roster` on the
main surfaces, so floaters don't render there anyway.

**WHERE I LEFT OFF:** Batch B committed + pushed to
`claude/broad-scan-8dgd6m` (re-branched from merged main per the
already-merged-PR rule). PR not yet opened. Full block:
`.cycle/blocks/128-batch-a-b-broad-implement.md`.

**Doc sync IS warranted before/with the PR** — six items in the block, and
one is newly stale in the GOOD direction: the "Not yet true of every 6 h key"
clause the last /sync-docs added is now false, because Batch B fixed all four
keys it named.

**Still open from Batch A (human):** walk S36; confirm the two new Health rows
render. **Dated:** Sep 1 backfills before `runNeonCoverageCheck`.
**Note on the budget value:** 5000 MB = 5.24 GB decimal, so an exact 5 GB
plan wants 4768; the gauge is a floor either way.

## Increment 129 (2026-08-20) — Batch C: the drift-guard sweep

PR #250 (Batch B + doc sync) MERGED first (ui-harness red on its first CI run
was an environment blip — logs rotated before they could be read, base was
green, the exact head passed the full 164-check gate locally; single re-run
went green and auto-merge landed it). Batch C then shipped (783/783, +4):

1. **C1 — the behavioral parity suite** (`qcd-sidebar-parity.test.js`), the
   guard that would have caught F1 as BEHAVIOR rather than as a threshold
   token. One shared 21-row Raw Data fixture drives `calcQcdReport` end to
   end, then drives `getExtractionDataJSON` per cell against the pipeline's
   OWN output grid; parity = sidebar row count === cell value across rows
   3,4,5,6,13,35,36,37,39,40,43 × cols C/D/E, zero cells must refuse. No
   expected numbers in the parity test, so an unmirrored edit to EITHER
   file's ~50 row rules fails it. Negative-tested from both sides (sidebar
   F1-reversion → "(40,3) wrote 4, extracted 5"; pipeline perturbation →
   "(6,3)/(6,5)"). Also the first test coverage dataFilters.js has ever had.
2. **C3** — the R20 comment's "(~59s)" corrected: time1Min is exactly 60s
   with strict >, so the rule is "MORE than 60s". Comment now also records
   that AbandonedFilter.js's >0:00:59 is a SEPARATE deliberate threshold.
3. **C2** — CLAUDE.md habit 3 gains the corollary: a new convention must
   answer "what enforces this?" in the same commit (F2/F3b/F11 were each
   that question unasked).

**FOUND while building C1, reported not fixed (block 129 has full detail):**
- **Row 34 is incoherent across three surfaces** — the pipeline's
  r34_abnd1m/2m counters are DEAD (totalRowMap overwrites row 34 as
  sum(35..37)), the sidebar has its own live row-34 predicate matching a
  DIFFERENT population (a status-3 internal abandon >1m double-counts in the
  35+37 sum but extracts once), and the sidebar's total-row refusal list
  omits 34. Needs an owner ruling on what row 34 MEANS.
- **Window-edge divergence, row 35 col D**: sidebar dp2/dp3 lack the
  pipeline's start<3PM clause — the F1 class, at the window edge.
- dashboardCDR.js remains the zero-test half of F7.

**WHERE I LEFT OFF:** Batch C committed to `claude/broad-scan-8dgd6m`
(re-branched from merged main), about to push + PR per the session's standing
flow. Doc updates queued for /sync-docs: the test-suite roll + the Extraction
Sidebar bullet's "the rest of the row rules are not [pinned]" clause, now
partly stale in the good direction.

## Increment 130 (2026-08-20) — Follow-ons + Batch E (resilience & capacity)

Shipped on the batch-C branch (810/810, +27; INV-16 green; the FULL rendered-UI
gate run locally with playwright — 164+ checks, all stages passed — against the
script-10 change). Full block: `.cycle/blocks/130-follow-ons-batch-e-broad-implement.md`.

1. **FO-1** — `neonAgentExts:v1` (the LAST unanchored 6 h key) joined
   reportFreshnessTag_ + the version-sync SPECS; the CLAUDE.md clause naming
   it as the exception now says "every 6 h key carries an anchor" — true for
   the first time.
2. **FO-2** — the row-35 window-edge divergence FIXED (sidebar dp2/dp3 gained
   the pipeline's start<3PM clause; rows 36/37 verified clause-for-clause
   clean at the same time) + pinned by an edge-time parity fixture row.
3. **FO-3** — dashboardCDR.js has its first tests ever: 6 on the pure
   aggregation helpers incl. the totals row's recompute-not-sum Rate/ATT.
   The 480-line core stays a follow-on (needs the C1 fixture treatment).
4. **E1 — retention-horizon monitor.** `ncSurvivingCallLegsDates_` +
   `ncRetentionRisk_` (NeonCoverage.gs) + two Health rows: 'legs-horizon'
   (FAST, sheet-only — renders mid-outage, when it matters) and
   'retention-risk' (neon part, shared conn) listing the SURVIVING dates the
   per-call tables are missing, each with its ~last recoverable day. Neon
   unreachable → the row IS the Sep 1 runbook, naming the oldest surviving
   sheet. NC_RETENTION_DAYS_ mirrors cdr-import's RETENTION_CUTOFF_DAYS
   (sync obligation — recoverability itself is derived from real sheets).
5. **E2 — escalations outage snapshot.** getEscalations stores open rows in
   chunked Script Properties (age-gated refresh, torn-write-safe) and serves
   them viewer-scoped with meta.snapshotAsOf when Neon is unreachable (both
   the no-conn path and mid-query death); client renders a read-only banner.
   WRITES UNTOUCHED (INV-55) — a snapshot can't drift while the only writer
   is down, which is why this doesn't contradict the no-sheet-twins ruling.
   Note: protects the NEXT outage — nothing to serve until Neon returns once.
6. **E3 — build stamp.** deploy.sh stamps BuildStamp.gs (UTC+sha+branch) at
   push, trap-restores the committed placeholder; a bare clasp push ships
   "unstamped", which is itself the finding. Health 'build-stamp' row, always
   muted.

**NOT implemented, deliberately:** the row-34 three-way incoherence — still
awaiting the OWNER'S RULING on what row 34 means (block 129 has the full
write-up). AbandonedFilter's >0:00:59 stays documented-deliberate.

**WHERE I LEFT OFF:** committing + pushing to `claude/broad-scan-8dgd6m`
(carries Batch C increment 129 + this). NO PR opened yet — batches C + this
one go in a single PR when the owner says. /sync-docs queued: six items in
block 130 (System Health bullet's 3 new rows, test-suite roll ×3, the
Extraction Sidebar bullet's now-stale "not pinned" clause, op-state #43
sync obligation + escalations snapshot, README deploy stamp, INV-55 note).

## Increment 131 (2026-08-20) — F-e: coaching delivery (email + separate worklist)

**Block:** `.cycle/blocks/131-f-e-coaching-delivery-broad-implement.md`

Phase 3 of the turnover-suggestion engine: the Phase-1 flags (increment 124's
dark preview) now DELIVER. All owner rulings honored: SEPARATE worklist (never
mixed into customer-account Escalations), all depts, ADMIN-ONLY email until
released, no cross-dept de-dup, 0%-answered flags are genuine.

1. **Server (Coaching.gs).** Neon `coaching_flags` (auto-DDL + partial unique
   open index — one open card per (dept, agent); closed history never blocks a
   re-flag; no sheet twin, flags re-derive from DQE). Weekly run:
   preview → pure diff (NEW insert+email / CONTINUING metrics-refresh, no
   email / RECOVERED-OPEN reported, NEVER auto-closed — the coach decides).
   One txn; email only on NEW (B3 quota lesson), admins only, plain-text
   watchdog family, deep link #/admin/coaching. Flag-gated engine:
   COACHING_DELIVERY_ENABLED (default OFF — ships dark), OPS-8 outcome props,
   Monday-8AM install/uninstall, run-now manual fire. Worklist RPCs:
   getCoachingWorklist (admin, open/closed/all, uncached, LIMIT 300) +
   updateCoachingFlagStatus (full INV-01 data-mutation set; open-only UPDATE
   → race-safe "not open any more" error).
2. **Health.** trg-coaching svc row WITH its flagProp (the install-readiness
   rule, same commit) + out-coaching outcomes row.
3. **Client.** Admin ▾ → Coaching (route /admin/coaching — the email's deep
   link). Health-modal shape; F10-idempotent render; dsConfirm_-gated
   Resolve/Dismiss with optional ≤500-char note; delivery controls (Run now
   confirm-gated — it persists AND emails). Zero styles.html changes.
4. **Rider: row-34 RULED.** Owner: row 34 = "CSR Total Calls" — the SUM
   (direction (a)). known-issues entry retitled RULED; parity-suite scope
   note points there; the CODE fix (sidebar refuses 34 + dead counters
   deleted) is a named follow-on, not smuggled into this scope.

Tests 819/819 (+9 delivery tests; fake conn models txn + executeUpdate).
ci:ui full gate run after the client changes. Engine ships DARK — deploy is
safe anytime; arming is an explicit admin action with a documented
one-larger-first-email expectation.

**WHERE I LEFT OFF:** committing + pushing to `claude/broad-scan-8dgd6m`
(carries increments 129 + 130 + this). NO PR — not requested this round.
/sync-docs queued: CLAUDE.md coaching parenthetical, Operator State #48
(COACHING_DELIVERY_ENABLED), tests/README coverage map.

## Increment 132 (2026-08-20) — Batch G: the Outbound report

**Block:** `.cycle/blocks/132-batch-g-outbound-report-broad-implement.md`

The scan's one new-capability item: `outbound_calls` gains its first
analytical surface (route `#/report/outbound`, Reports ▾ → Outbound,
admin-only while vetted — the Inbound/Direct model with the latent manager
path). Headline: "did we call back the ones who abandoned?"

1. **Callback linkage.** Abandon denominator = EXACTLY the Inbound report's
   Abandoned population (reuses inboundDeptPredicate_ + inboundWindowClause_
   verbatim — work-window owner ruling honored, pinned in the new suite since
   the inbound-window-scope count guard is InboundReport.gs-scoped). Each
   abandon LATERALs to the EARLIEST outbound with callee_hash = caller_hash
   within 3 days; match deliberately unscoped by dept/agent and uncapped by
   the report's `to`. Anonymous abandons excluded from the rate denominator.
   Median time-to-callback via percentile_cont.
2. **Both mandated caveats are structural, not just captions:** "connected"
   is the disclosed stricter subset (CDR can't tell no-answer/voicemail/
   busy), and attribution is by ROSTER dept — the SQL never reads
   outbound_calls.department (test-pinned); buildDeptsByAgent_ maps dialers,
   dept view discloses off-roster exclusions, company view labels crossover
   agents with all homes and no-roster dialers as "Unrostered".
3. **Plumbing:** one json_build_object round trip, egress-metered,
   `outboundReport:v1` + freshness tag (SPECS row added same commit — C2),
   uncached unavailable, csvSafeCell_ CSV, C-8 stale token, coverage note.

Tests 829/829 (+10). ci:ui full gate after the client changes. v1 scope:
KPIs + callback block + sortable agent table + CSV; deferred (in block):
daily series/chart, not-called-back drill list, kpisPrior chips, per-dept
company cards.

**WHERE I LEFT OFF:** committing + pushing to `claude/broad-scan-8dgd6m`
(carries increments 129–132). NO PR — not requested. /sync-docs queued (see
block 132): the outbound bullet's "sole consumer: Caller Lookup" clause is
now stale, INV-30 gains outboundReport:v1, test-suite rolls.

## Increment 133 (2026-08-20) — Follow-ons: row-34 code fix + Outbound v2

**Block:** `.cycle/blocks/133-follow-ons-outbound-row34-broad-implement.md`

1. **Row-34 fix landed** (the ruling's direction (a), both files together):
   dataFilters.js refuses row 34 as a total row (predicate removed, 34 out of
   isGlobalExcRow); autoImport.js's dead r34 counters deleted (totalRowMap's
   sum — the ruled meaning — untouched, sheet output byte-identical);
   qcd-sidebar-parity pins the refusal; known-issues entry marked APPLIED.
2. **Outbound report v2** (prefix bump v1→v2, INV-30):
   - CORRECTNESS: the abandon denominator now excludes is_internal rows —
     v1 missed the clause every inbound metric query carries, so internal
     test calls inflated the callback denominators. Factored into
     outboundAbandonWhere_, used by report + daily + prior + drill alike.
   - pendingTail (tracked abandons still inside the 3-day window) as a real
     count on the Called-back tile; per-day callback series + safeChart_
     line chart (THEME, datalabels off, <2 days hidden); INV-28
     kpisPrior/callbackPrior via computePriorWindow_ with the prior agents
     routed through the SAME roster filter; getOutboundUncalled — the
     not-called-back drill (same lateral so it can't disagree with the KPI,
     cap 200, no caller identity, rows reuse heatCellDetailHtml_ + the
     "↳ path" journey chips).
   - The window-clause pin upgraded to the count-based every-FROM pattern
     in the new file (the inbound-window-scope guard is file-scoped).

Tests 836/836 (+7); INV-16 green; full ci:ui gate green. Per-dept company
cards for Outbound STILL deferred — now with the stated design blocker
(crossover agents have multiple roster homes; grouping needs an owner
ruling; the flat multi-home-label table dodges it honestly).

**WHERE I LEFT OFF:** committing + pushing to `claude/broad-scan-8dgd6m`
(carries increments 129–133). NO PR — not requested. /sync-docs queue
updated in block 133 (row-34 sidebar clause now RESOLVED wording; INV-30
outboundReport is v2; plus the earlier queued items from 131/132).

## Increment 134 (2026-08-20) — Three owner rulings: Option C, row-34 probe, dashboardCDR core coverage

**Block:** `.cycle/blocks/134-owner-rulings-probe-cdr-core-broad-implement.md`

1. **Option C RULED** — Outbound company view stays the flat table (per-dept
   cards rejected: crossover agents force double-count or misattribution).
   Ruling comment at the render site; the block-133 follow-on is CLOSED.
2. **Row-34 probe** — `previewRow34Overlap` (cdr-import, CDR Tools menu,
   READ-ONLY) counts the internal+status-3 double-count shape per surviving
   Call_Legs date with a plain verdict line. Pure core
   `countRow34OverlapRows_` is pinned BEHAVIORALLY: its r35/r37 counters must
   equal calcQcdReport's own written row 35/37 E cells on a shared fixture.
   OPERATOR: run it once after the cdr-import deploy; zero ⇒ close the
   known-issues double-count note as latent-only.
3. **dashboardCDR core coverage RESOLVED** — new dashboard-cdr-core.test.js
   (9 tests, local recording fake — deliberately not a loosening of the
   shared strict harness) drives generateCustomReportCore_ end to end:
   header shapes both modes, list-multiplier aggregation, F-11 display-read
   TTT (junk values grid + display strings), exact-dept match, D-3 contacts
   neutralization, D-6 alerts, diagnostics panel, chart counts.
   **The suite immediately EXPOSED A REAL BUG and it is FIXED**: the T-7
   full-height panel clear wiped fresh report columns whenever a report was
   WIDER than the previous run's remembered panel column (narrow run →
   comparison run lost TTT(P)/ATT(C)/ATT(P) — the REP-1 clipping class
   reintroduced). Fix splits the clear (strip above the report always;
   full height only for old-panel columns beyond the render clear's reach);
   both directions pinned (wide-report survival + the original T-7
   stale-panel wipe).

Tests 847/847 (+11). INV-16 green. New follow-on noted: agent NAMES bypass
crSheetSafeCell_ in the table col A + diagnostics subtotals (contacts-only
D-3 coverage) — 3-site one-liner when taken.

**WHERE I LEFT OFF:** committing + pushing to `claude/broad-scan-8dgd6m`
(increments 129–134). NO PR — not requested. Deploys owed: cdr-import
(probe), cdr-report (clipping fix). /sync-docs queue grows: probe as the
row-34 resolution instrument; dashboard-cdr-core in the rolls; block-130's
"480-line core stays a follow-on" clause resolved.

## Increment 135 (2026-08-20) — The CLAUDE.md trim/extraction pass

**Block:** `.cycle/blocks/135-claude-md-trim-broad-implement.md`

The overdue doc-maintenance task (headroom had fallen to 12.8 KB):
187,222 → 175,480 bytes (−11.7 KB; 28.6 KB headroom). **Both grandfathered
ratchet maps are now EMPTY** — the five seeds retired by extraction or
split (Role model → four bullets; Sub-queue combined view → two, incl. a
standalone "Queue-split narrowing (Phase 2)" bullet; Neon read-back
5.5→3.0 KB; Neon write discipline 4.9→3.8 KB; Direct-extension
4.8→3.0 KB), so every prose bullet answers to the flat 4,096 B budget and
the map comment forbids re-seeding. The Key-commands suite enumeration
moved to tests/README.md (its designated home, enriched); the third copy
in Cycle Workflow Config compressed to a pointer; the dqe_history index
DDL relocated to Operator State #19. Reference-resolution audit in the
block: no rule deleted, every dropped fix code/identifier still resolves
(fix-history carries the extracted stories verbatim).

Tests 847/847 (incl. the now-stricter flat ratchet). No production code
touched; no deploy needed.

**WHERE I LEFT OFF:** branch restarted from merged main (PR #251), trim
committed + pushed to `claude/broad-scan-8dgd6m`. NO PR — not requested.
Next size lever when needed: an F8-style SECTION split, not more shaving.

## Increment 136 (2026-08-20) — Follow-on: D-3 completed for names (dashboardCDR)

**Block:** `.cycle/blocks/136-d3-name-neutralization-broad-implement.md`

The one actionable code follow-on on the ledger (block 134): dashboardCDR
wrote feed-derived NAMES raw — only contacts cells were D-3-neutralized.
All five sites now route through `crSheetSafeCell_`: table col-A agent
name, pie-chart temp labels, writeTop5 contact names, diagnostics detail
contact names, diagnostics agent subtotals. Pinned by one structural test
(no cell in the written grid may hold a bare formula-leading string;
`'=DROP()` / `'=EVIL(7)` survive prefixed). 848/848.

Remaining ledger is deliberately non-code now: owner-gated un-gatings +
flips, operator deploys/backfills/probe run, and the block-135
"when needed" doc levers (headroom healthy).

**WHERE I LEFT OFF:** committed + pushed to `claude/broad-scan-8dgd6m`
(carries increment 135 + this since PR #251 merged). NO PR — not
requested. Deploys owed: dashboard (nothing new since #251), cdr-report
(row-34 refusal + T-7 clip fix + this), cdr-import (probe + dead-counter
removal).

## Increment 137 (2026-08-21) — Row-34 CLOSED (probe measured zero); deploys confirmed

Owner deployed all three projects and ran `previewRow34Overlap` over all 10
surviving Call_Legs dates (2026-08-07..08-20, ~139K rows): **E-overlap = 0
and colC-overlap(max) = 0 on every date** — the internal+status-3 shape
does not occur in this install, so row 34's ruled sum has been exactly
right all along and column C is proven clean by the superset check.
known-issues entry retitled CLOSED (latent only) with the measurement and
the re-open rule (non-zero on a future probe run). No code change — a zero
measurement warrants no predicate edit.

Operator ledger after this: Sep-1 backfills (backfillInbound/OutboundCalls
before runNeonCoverageCheck), arm coaching delivery when ready, and the
owner-gated releases (Inbound/Direct/Outbound un-gating, queue-split flip
#42, agent role #46). All code follow-ons drained.

**WHERE I LEFT OFF:** doc-close committed + pushed to
`claude/broad-scan-8dgd6m` (restarted from merged main / PR #252). NO PR —
not requested; it's a two-file doc/state commit, fine to fold into
whatever goes next.
