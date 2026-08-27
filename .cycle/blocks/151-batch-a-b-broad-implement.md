---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-08-27 broad-scan, Batches A + B)
- P3 — Inbound report's priorDr + drOutside ranges missing the is_internal exclusion (delta chips inflated by internal-origin calls); cache bumped inbound:v9 → v10 per INV-30
- P5 — outbound_calls (no sheet primary) added to the Neon backup's monthly-partition registry; not-created-yet table reads as a clean skip
- P6 — Digest run-claim marker no longer claimed by a zero-attempted run (the O-9 rule ported from QueueReportEmail): NO-SUBSCRIBERS / FAILED-ALL-VALIDATION outcomes clear the marker so the window can still be delivered
- P8 — Bulk-force path gains the QCD/CSR force-loss guards (bulkBackfill:QCD / bulkBackfill:CSR failure rows at queue time — the S2-2 rule was daily-path-only)
- P16 — runOutboundVettingCheck's default window computed in script TZ, not UTC (an evening run no longer vets a partial day)
- P18 — deleteOldCDRSheets' null-active-spreadsheet fallback no longer opens the WRONG workbook (the target, where Call_Legs never live) — it fails loudly into runRetentionPrune_'s failure row instead of logging green "deleted 0" forever
- P13 — Coaching new-flag notification survives a failed send: committed-but-unnotified flags park in COACHING_NOTIFY_PENDING and fold into the next send; property clears only on a confirmed send (OPS-1)
- P14 — Sign-in notifications record LOGIN_NOTIFY_SEEN only AFTER a confirmed send — a MailApp failure or empty admin list no longer permanently burns the first-sighting/DENIED one-shot (OPS-1)
- P26 — Force-loss guards gate on rows ACTUALLY deleted (new per-sheet forceDeleted capture threaded through processIntegratedHistory + both buildDQE call sites) — Manual Export (always force) no longer throws/emails false "data may be lost" alarms on first-time light days
- P30 — Neon egress metering covers the missing surfaces: agentHome journey scan, Caller Lookup's outbound + history sections, and the call-journey drill now labeled ('agentHome' / 'caller-lookup' / 'callJourney')

Files modified:
- apps-script/department-dashboard/InboundReport.gs, NeonBackup.gs, Digest.gs, OutboundReport.gs, Coaching.gs, Auth.gs, AgentHome.gs, CallerLookup.gs
- apps-script/cdr-import/autoImport.js, DeleteOldSheets.js
- CLAUDE.md + docs/{invariants,architecture,known-issues,conventions}.md (inbound:v10 version sync only)
- tests/unit/{inbound-window-scope,coaching,digest-wow,login-notify}.test.js

CHANGES:
P3 | InboundReport.gs | `AND COALESCE(c.is_internal, FALSE) = FALSE` added to priorDr + drOutside; INBOUND_CACHE_KEY_PREFIX bumped to inbound:v10; the occurrence-count tripwire updated 5 → 7 aliased clauses.
P5 | NeonBackup.gs | outbound_calls joins the monthlies registry (call_date/date, call_date+call_id order); the per-spec catch classifies "relation … does not exist" as a clean pre-capture skip, everything else stays FAILED.
P6 | Digest.gs | `attempted === 0` now deletes the run marker and records NO-SUBSCRIBERS (no rows) or FAILED-ALL-VALIDATION (all rows failed the O-3 dept check) instead of claiming the window with "ok … sent 0 of 0".
P8+P26 | autoImport.js | processNewImport captures per-sheet `forceDeleted` before the force-delete; threaded into processIntegratedHistory (new optional param, all-true default) gating the QCD/CSR guards and both buildDQE `opts.force` call sites (INV-16 pair untouched — only the caller's flag changed); queueToPendingArchive returns {queued, byType} and the bulk branch runs guardForceRebuildLoss_ for bulkBackfill:QCD / bulkBackfill:CSR at queue time.
P16 | OutboundReport.gs | vetting default-window iso() uses TZ (matches runInboundQcdParityCheck).
P18 | DeleteOldSheets.js | null-active-spreadsheet fallback replaced with a thrown error (no pointer to the source workbook exists); runRetentionPrune_'s catch turns it into a retentionPrune FAILURE row.
P13 | Coaching.gs | send wrapped; on failure/no-recipients the toEmail batch (new + carried, capped 40) parks in COACHING_NOTIFY_PENDING and the result says "EMAIL NOT SENT … kept pending"; next run folds carried flags in (deduped by dept+agent) and clears the property only on a confirmed send. Also fixes the old false "emailed admins" claim when no admin recipients existed.
P14 | Auth.gs | notifyLoginEvent_ writes LOGIN_NOTIFY_SEEN only after MailApp.sendEmail succeeds; empty recipients or a throw leave the store untouched for retry.
P30 | AgentHome.gs, CallerLookup.gs, InboundReport.gs | neonNoteEgress_ calls added/labeled on the three missing surfaces.

TEST RESULTS: 944/944 pass (was 936; +8 new: 3 coaching P13 incl. the pending-carry round-trip, 3 digest P6 marker semantics incl. dedup preserved on success, 2 login-notify P14 OPS-1). cache-version-sync green after the v10 sync across 6 doc locations; INV-16 guard green; claude-md-split green. Live Regression Scenario walks (S5, S20/S21, S28/S29, S33/S34) need the deployed environment — spot-checks listed under deploy.
Note: the new coaching tests reinstall coachingDeliveryRun_ at load time because a pre-existing test `delete`s the real vm binding after stubbing it (a latent suite trap, worked around not fixed).

REGRESSION RISKS:
- P3 changes the admin-only Inbound report's prior deltas + outsideWindow counts (intended correction); v10 bump prevents mixed-version cache serves.
- P6: a genuinely-delivered run still claims the marker (pinned); only no-delivery runs stop claiming — retry cannot duplicate by construction.
- P26 narrows when guards fire; the one behavior removed is the false alarm (a real force-delete still guards identically — pinned semantics unchanged in the INV-16 pair).
- P18: if the unbound-context fallback ever actually fires, the prune now fails loudly instead of no-opping — a visible failure row replaces silent wrong-workbook behavior.
- P13/P14: duplicate-email edge on concurrent runs/hits after a failed send — accepted, bounded, documented in-code.

INVARIANTS AT RISK: None violated. INV-30 honored (inbound v10 + all current-truth docs synced, enforced by cache-version-sync); INV-16 pair untouched byte-identical (guard green); INV-44 gains two step names (bulkBackfill:QCD / bulkBackfill:CSR — doc note below); INV-01/32 gates unchanged; INV-33 windows unchanged.
NET SCORE: 10 − 0 = 10 (P3/P16/P26 plausibly firing this month; P5/P6/P8/P13/P14/P18/P30 latent/coincidence-gated but real).

OPERATOR ACTIONS / DEPLOY:
- None blocking — no new operator-set properties, triggers, scopes, or migrations (COACHING_NOTIFY_PENDING is engine-written outcome state per the Operator State scope note). | BLOCKS DEPLOY: N
- Post-deploy spot-checks (non-blocking): next Neon backup run's outcome line shows `outbound_calls ok (…)` (or the clean pre-capture skip); Alerts modal digest last-run lines after a zero-subscriber cadence show NO-SUBSCRIBERS not "ok 0 of 0".
Deploy:
- Department Dashboard: `clasp push -f` from repo root + New version (or `scripts/deploy.sh .`)
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- (cdr-report unchanged this batch)

FOLLOW-ON ITEMS:
- The bulk-path guard wiring (P8) and forceDeleted threading (P26) are pinned only via the guard helper's existing csr-transfer.test.js coverage — processNewImport itself has no harness; a bulk-flow fixture would close this.
- coaching.test.js's FLAG-GATED test deletes the real coachingDeliveryRun_ binding from the vm context (worked around in the new tests; fix by restoring instead of deleting).
- Batches C–F from the 2026-08-27 scan remain (pre-cutover data-accuracy, enforcement holes, client polish/a11y, strategic).

DOCUMENTATION UPDATES NEEDED:
- docs/invariants.md INV-44: add `bulkBackfill:QCD` / `bulkBackfill:CSR` to the step-name vocabulary (+ the P7 note from increment 150 that an `autoImport` failure row can mean a lock-skip).
- docs/fix-history.md: entries for P3/P5/P6/P8/P13/P14/P16/P18/P26/P30 under this scan.
- CLAUDE.md M3 sentence still owes the increment-150 third-call-site mention (unchanged this session).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
