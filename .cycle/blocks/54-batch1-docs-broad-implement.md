---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch 1 (documentation truth + harness tooling) — the four items the Round-13 scan left as doc/tooling debt after F1/F1b, F2, F3, F12, F13 shipped in increment 53.
- Batch 1.1 | The stale F2 rationale in CLAUDE.md — a LIVE documentation error asserting a limitation the code no longer has, for a reason that was already false
- Batch 1.2 | Document increment 53 (F1/F1b, F2, F3, F12, F13) across CLAUDE.md's live-rule surfaces + docs/fix-history.md's archive, including a new Operator State runbook for diagnosing the F1 class
- Batch 1.3 | Promote S39 (keyboard walk) + S40 (overdue count agreement) from Stage-3 OPERATOR VISUAL CHECKS into Regression Scenarios
- Batch 1.4 | The stale Chromium path in the UI harness README and all four drivers

Files modified:
- CLAUDE.md
- docs/fix-history.md
- tools/ui-harness/README.md
- tools/ui-harness/chromium-path.js (new)
- tools/ui-harness/drive.js
- tools/ui-harness/drive-insights.js
- tools/ui-harness/drive-phase3.js
- tools/ui-harness/drive-f13.js

CHANGES:
Batch 1.1 | CLAUDE.md (Neon write discipline, P-1 paragraph) | Replaced "An extreme date-goes-to-ZERO-inbound re-import is still the one corner it can't clear -- an empty payload carries no date to delete" with the F2 rule: both no-sheet-primary writers now run a delete-only pass via `icDeleteDateOnly_`, GATED on a non-empty source grid (the P-3 discipline), reporting `unreachable` so a deferred-mirror date stays queued. Explicitly records that the old stated reason was already stale since P-1 made every caller pass `expectedDateIso` — the wrong REASON was the more misleading half, since it would have deterred the fix.
Batch 1.2 | CLAUDE.md (inbound-capture bullet) | New "Queue-name recognition is config-fed AND brand-prefix aware (F1/F1b) -- do NOT re-hardcode it" block: what `icIsQueueName_` gates (`entry_queue`/`final_queue`/`num_queues`/`abandon_stage`), why the blindness is SELF-CONCEALING (both diagnostics filter `COALESCE(entry_queue,'') <> ''`), the two feed sources, the measured `UDC_A_Q_Main`/`UUC_A_Q_Main` evidence, why the `Backup CSR` arm must stay EXACT (IMP-1 pins "Jane Backup CSR" false), and the purity/memo contract.
Batch 1.2 | CLAUDE.md (Operator State #38, NEW) | The F1/F1b diagnostic runbook. Leads with the ANTI-pattern — do NOT probe with `entry_queue IS NULL AND disposition='abandoned'` — explains why (`abandon_stage='queue'` implies non-NULL, so every NULL-entry abandon is 'direct', a genuine IVR give-up, or the bug), gives the discriminating journey leg-name histogram SQL, and says to read its output against `DQE_EXCLUDED_AGENTS` (which already classifies every queue vs pseudo-agent name in this install). Records that person names in the 'ivr' bucket are expected pre-R5-split rows, that journey-NULL rows can't be diagnosed, and that recognition ≠ attribution (UDC/UUC have no dashboard dept).
Batch 1.2 | CLAUDE.md (Operator State #22) | Added the F12 "step order + no-skip" rule: five types run least-recoverable-FIRST (Inbound, Outbound, CDR, QCD, DQE), every step is attempted despite an earlier hard error, errors aggregate into ONE throw so attempt-counting is unchanged — plus the explicit "don't reintroduce a rethrow inside `step()`, don't reorder the sheet-derivable types ahead of Inbound/Outbound".
Batch 1.2 | CLAUDE.md (INV-54) | Records the THIRD cross-project consumer of the Dept Config columns: `icLoadConfiguredQueueNames_` now feeds CAPTURE-TIME recognition from QCD Queues + Inbound Queue Aliases, so listing a queue changes what the next import recognizes — not merely how an already-captured name attributes. Notes the shared per-run memo + `icResetConfigMemos_()` and that digit-only tokens are rejected on both sides.
Batch 1.2 | CLAUDE.md (INV-55) | "OVERDUE IS CALENDAR DAYS ON BOTH SIDES (F3)": `ESC_OVERDUE_DAYS` + `ESC_OVERDUE_SQL_` as the single server definition used by both aggregates, what the old 72-hour test did to the tile-vs-⚑ agreement, the two-runtime mirror obligation (change both), and the accepted midnight-boundary residual.
Batch 1.2 | CLAUDE.md (Key commands) | Documented the rendered-UI harness — that it exists, that it is NOT in `npm run ci`, that it has caught render bugs the .gs harness structurally cannot (R12-1, R12-2), and the `drive-f13.js` invocation behind S39. Closes the scan's "the UI harness is not mentioned there at all" gap without pre-empting F7.
Batch 1.2 | docs/fix-history.md | New "`F1`…`F13` — broad scan Round 13" section (per-code table with pointers to the live rule), plus a RETRACTED/CORRECTED table preserving the four wrong claims and why (Overview cache-size estimate ~2× high; the PHI-leak retraction; the sub-queue-chip error that would have double-fired Enter; the misleading NULL-entry probe). Taxonomy table + collision note updated: Round-13 `F#` is a THIRD `F`-shaped family (`F1` here ≠ the Neon read-back flag; `F2` here ≠ the dup-guard self-heal), and the scenario range is now `S1`…`S40`.
Batch 1.3 | CLAUDE.md (Regression Scenarios) | S39 = keyboard-only walk of all five F13 surfaces, naming `drive-f13.js` as its automated counterpart and recording WHY table rows carry `tabindex` but no `role="button"`. S40 = overdue count agreement, specifying the 68–76h window where a 72-hour and a calendar-day test disagree, and warning that the counts are viewer-scoped + status-independent so the comparison is against ALL open cards.
Batch 1.4 | tools/ui-harness/chromium-path.js (new) + all four drivers | The documented default `/opt/pw-browsers/chromium` is a DIRECTORY, not the binary, so every driver failed with "executable doesn't exist" until CHROMIUM_PATH was passed by hand (it cost a failed run in increment 53). The real path carries the Playwright browser REVISION (`chromium-1194/chrome-linux/chrome`), so hardcoding today's revision would just re-stale. New shared resolver globs the revision, prefers the full browser over `headless_shell`, sorts to the highest revision, and returns null so Playwright's own registry still works. All four drivers now call `launchOptions()`.
Batch 1.4 | tools/ui-harness/README.md | Corrected path guidance (explaining the directory-vs-binary trap), added `drive-f13.js` to the run list, and documented the first-run-chrome suppression (`cdr.tour.done` / `cdr.ins.intro.v1`) that any new driver needs or its clicks time out on the tour overlay.

TEST RESULTS: passed. `npm run ci` → 488/488 unit tests, INV-16 duplicated-file guard clean, cache-version-sync clean (that guard polices prefix-qualified `prefix:vN` mentions in CLAUDE.md prose, so it is the real check on this batch's largest edit; the only such mention touched was the pre-existing `missed:v17` inside INV-54, still canonical). The UI harness re-run with NO `CHROMIUM_PATH` set — the case Batch 1.4 fixes — resolved `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and reported 13/13 keyboard checks.
Regression Scenarios: NOT EXECUTED — no runtime code changed, so no scenario's behavior is in scope. S39 was executed in its AUTOMATED form (13/13). S40 remains NOT EXECUTED: it needs a live escalation aged 68–76h plus a deployed app.

REGRESSION RISKS:
- CLAUDE.md / fix-history.md carry no executable behavior. The one automated consumer of CLAUDE.md is `cache-version-sync.test.js` (it parses prose for `prefix:vN`), and it passes. `scripts/verification-pack.mjs` parses the Invariant Library and the Regression Scenarios block — INV-54/INV-55 kept their single-line `INV-N | text | Subsystem:` shape and S39/S40 follow the existing `S# | name | Subsystem:` + `Steps:` + `Expected:` format, with the block boundary to `### Frozen Subsystems` verified intact.
- The harness resolver could in principle pick a DIFFERENT browser than before on a machine with several revisions installed — it sorts to the highest revision and prefers the full browser over `headless_shell`. Previously such a machine simply failed to launch, so any resolution is an improvement; `CHROMIUM_PATH` still overrides.
- `launchOptions()` OMITS `executablePath` when nothing resolves, where the old code passed a non-existent path. That changes a hard failure into Playwright's own registry lookup — strictly better, and it is why the drivers now work on a plain `npm i playwright` machine.
- No interface, return type, or default value changed for any production module. Nothing in `apps-script/` was touched in this batch.
- Honest counter-consideration: CLAUDE.md grew 357 KB → 369 KB (+12 KB), and its size IS finding F8. The content added is live-rule/runbook content, which the project's own doc split assigns to CLAUDE.md (narrative went to fix-history.md, +5 KB), and Operator State #38 is the single most operationally valuable artifact of this cycle. But this batch made F8 worse in absolute terms and should raise its priority.

INVARIANTS AT RISK: None.
- INV-54 and INV-55 were EXTENDED in prose to match code that already shipped in increment 53; no rule changed, no behavior implied that the code doesn't do.
- INV-16: no duplicated file touched; guard clean.
- INV-30: no cache version referenced or bumped; sync guard clean.
- INV-22 (DQE Report Legacy frozen): untouched.
- INV-12 / setup(): no sheet or schema change.

NET SCORE: 0 production fixes − 0 new failure modes = 0
This is the honest score for a documentation batch and should not be inflated: nothing here changes production behavior. Under /reflect's three-way tally these are 5 DEFENSIVE/STRUCTURAL items. Their value is preventing future misdiagnosis — the stale F2 rationale would have deterred the very fix that closed it, and Operator State #38 exists because this cycle's own first probe was wrong and cost a round trip.

OPERATOR ACTIONS / DEPLOY:
- Still outstanding from increment 53 (unchanged by this batch): deploy BOTH projects, then re-run the Operator State #38 histogram to confirm no queue-shaped name remains in the `abandon_stage='ivr'` slice. | BLOCKS DEPLOY: N
- Decide UDC/UUC attribution: `UDC_A_Q_Main` / `UUC_A_Q_Main` will now populate `entry_queue` and appear in Dept Config's "Discovered inbound queues" as UNATTRIBUTED until an owner maps them to a dept (or creates one). | BLOCKS DEPLOY: N
- Walk S41 (theme × mode sweep) and S42 (narrow-viewport trend band) — perceptual checks no code can verify. | BLOCKS DEPLOY: N
- Nothing in THIS batch requires a deploy: no `apps-script/` file changed. | BLOCKS DEPLOY: N
Deploy: N/A for this batch — docs + audit tooling only. The increment-53 deploys still stand: `cd apps-script/cdr-import && clasp push -f`, and `clasp push -f` from the repo root + a new dashboard deployment version.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F7 (Batch 2): the UI harness is documented now but still not in `npm run ci`. `gen-payloads.js` dumps no `qcdAll` payload, so the all-dept QCD report still can't be exercised there.
- F8 (Batch 7) is now MORE urgent, not less: CLAUDE.md is 369 KB / 3,707 lines. Operator State #38 and the new inbound-capture block are good candidates to survive a split intact — they are runbooks, not narrative.
- F6 / F9 / F10 + the "is this install armed?" consolidation (Batch 3) untouched.
- Batch 4 (deploy.sh orphan-file check) and Batch 6 (flag flips) untouched.
- Batch 5: the QCD-vs-inbound discrepancy is still unexplained — F1 was exonerated as its cause, and it remains the stated blocker on releasing the Inbound + Direct reports to managers.
- `escEnsureTable_` performs DDL from a read endpoint (`getEscalations`). Harmless, still worth knowing.

DOCUMENTATION UPDATES NEEDED: None outstanding from increment 53 — this batch WAS that update. Newly noted:
- `docs/known-issues.md`, `docs/architecture.md` and `docs/conventions.md` were NOT swept this batch (Batch 1 scoped to CLAUDE.md + fix-history.md). If any of them restates the inbound-capture queue-recognition rule, the deferred-mirror step order, or the escalation overdue definition, those copies are now behind. A `/sync-docs` pass should check them.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
