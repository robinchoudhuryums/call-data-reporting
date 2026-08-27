---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-08-27 broad-scan, Batch F — the implementable subset)
- P9 — DQE Drill-Down sidebar mirrors the pipeline's R18e ext-fallback queue recognition (same-day ext→queue-name map; CALLER "CallQueue (NNN)" recovered when col W lost its A_Q_* token) — no more false "Found N vs Dashboard X" mismatches during the exact incident the tool debugs
- P10 — backfillCDRHistory dedupes intra-batch conflict-key duplicates last-write-wins (the IMP-6 rule) — a hand-pasted duplicate sheet row can no longer wedge the backfill permanently on "cannot affect row a second time"
- P19 — the interrupted-apply recovery summary splits the merge-group key on its NUL separator, not the agent's first space
- P20 — the drill-down rejects unparseable-start legs from windowed metrics (with a reason) exactly as the build excludes them, instead of counting them
- P21 — the Q-Path dept-extension regex gains a left boundary ((?:^|\D)) so ext 103 no longer matches inside 2103 (legacy-read, INV-52 — but wrong is wrong)
- P22 — internal-origin abandonedOnHold/holdSeconds scope to the REQUESTER's own legs (icLegFromOriginator_, fallback to old inputs on no match) — a warm-transfer sibling's customer's hold state no longer leaks onto the assist record
- I5 — the agent app resolves dark mode (saved 'dash-mode' key → OS preference, shared with the manager app) and gains a ☀/◐ toggle; the token-styled SVG charts repaint automatically
- P28 — Overview trend-chart spotlight pins + Alt-hidden series survive rebuilds (incl. the silent 5-min auto-refresh): captured by the re-render-stable chartSpotKey_ before destroy, re-applied through chartSpotlightApplyPins_/AfterHide_ + ovSyncTilePins_ after build; dropped keys age out naturally
- S6 — sibling-project deploy-bypass detection: per-project buildStamp.js placeholders (cdr-import + cdr-report), deploy.sh stamps whichever project it pushes (trap-restored), and the stamp rides the `autoImport` and `buildDQE` success Pipeline Health notes ("unstamped" = the last push bypassed the CI gates); the buildDQE note is typeof-guarded inside the INV-16-shared builder so both copies stay byte-identical

NOT implemented (by design — see OPERATOR ACTIONS / FOLLOW-ONS):
- Vetting + un-gating the Inbound/Direct/Outbound reports — requires the live vetting tools' clean runs + an owner decision; the documented contract forbids un-gating without them, and every code prerequisite (incl. the P16 TZ fix) already shipped
- Neon cutover execution — the Batch-9 runbook is operator work (live properties, SQL, parity gates); its code blockers (L1/L2/P4/L4) shipped in increments 150–152
- Single-sourcing the hand-mirrored QCD/drill-down rule copies — an L-effort refactor deliberately deferred (P9 + the Batch-C parity suite narrow the drift surface meanwhile)

Files modified: cdr-report/{DQEdrilldown.js, neonbackfill.js, sheetRepairs.js, buildDQEHistoricalData.js, buildStamp.js (new)}, cdr-import/{autoImport.js, inboundCalls.js, buildDQEHistoricalData.js, buildStamp.js (new)}, department-dashboard/{agent.html, agentApp.html, script-3-overview.html}, scripts/deploy.sh, CLAUDE.md (Subsystems +2 files), tests/unit/inbound-calls.test.js (+1)

TEST RESULTS: 958/958 pass (+1: the P22 sibling-hold-leak pin). INV-16 guard green (the shared buildDQE note edit applied identically to both copies); deploy.sh bash -n clean; node --check clean on every touched .js. The client changes (I5/P28) ride the blocking ui-harness CI job.
REGRESSION RISKS: P28 re-applies pins only for keys present in the new payload (a renamed/dropped dept releases naturally); the carry is wrapped in try/catch so a capture failure degrades to the old reset-behavior. S6's deploy.sh case keys on the documented invocation paths (`.`, apps-script/cdr-import[/], apps-script/cdr-report[/]); other paths simply skip stamping (old behavior). P22 changes stored inbound_calls values for internal-origin rows only — metric queries exclude is_internal, so only the journey drill's wait/hold label shifts (to the correct value); old rows heal on re-import. P9/P20 change the DIAGNOSTIC sidebar's counts toward the pipeline's truth — an operator comparing old screenshots will see different (now-correct) numbers.
INVARIANTS AT RISK: None — INV-16 held (guard green, identical edits); INV-52 unchanged (P21 corrects a legacy-read value without changing its consumers); INV-23/INV-04 untouched; the R18e DQE-vs-inbound recognizer divergence preserved (the sidebar mirrors the DQE side only).
NET SCORE: 6 − 0 = 6 (P9/P20 fire whenever the drill-down is used during an incident; P22 on any warm-transfer assist; P10/P19/P21 latent-but-real; I5/P28 are UX corrections).

OPERATOR ACTIONS / DEPLOY:
- Un-gating the three reports (owner + operator): run `runInboundQcdParityCheck` → populate aliases → re-run clean; run `runOutboundVettingCheck` (now TZ-correct) → PASS; then the one-line gate removals per each report's bullet. NEVER on an INCONCLUSIVE/FAILED run. | BLOCKS DEPLOY: N (independent of this push)
- Neon cutover: execute README's Batch-9 runbook steps 1–8 when ready — all code prerequisites shipped. | BLOCKS DEPLOY: N
- After deploying the siblings via deploy.sh once, the next morning's `autoImport` / `buildDQE` Pipeline Health notes should show `build: deploy.sh …` — if they read "unstamped", the push bypassed the helper. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` + New version (or `scripts/deploy.sh .`)
- CDR Import: `scripts/deploy.sh apps-script/cdr-import <id>` (or cd + clasp push)
- CDR DQE Pipeline / Reporting Tools: `scripts/deploy.sh apps-script/cdr-report <id>` (or cd + clasp push)

FOLLOW-ON ITEMS:
- The deferred L-item: single-source the QCD row rules (autoImport ↔ dataFilters) and the drill-down leg recognition — the remaining structural answer to the drift family P4/P9 exemplify.
- DQEdrilldown.js has no unit harness (editor tool); P9/P20 are code-reviewed + syntax-checked but unpinned.
- CLAUDE.md trim pass (~15KB headroom) still owed, along with the three "what enforces this" one-liners from increment 153.
DOCUMENTATION UPDATES NEEDED:
- docs/fix-history.md: Batch-F entries (P9/P10/P19–P22/I5/P28/S6) — fold into the next /sync-docs.
- README's deploy section could mention the sibling stamping (one line, same pass).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
