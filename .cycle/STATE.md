# Cycle State — resume note

## Latest session (Insights modal->page conversion: Phases 7+8 of 8 -- COMPLETE, PR)
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
