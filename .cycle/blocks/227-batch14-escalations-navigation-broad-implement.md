---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ESC-D8 (option C) -- a permanent escalation delete also scrubs the escalation out of the existing Neon backups
- CL-23 (option B) -- browser Back / Forward through google.script.history

Files modified:
- apps-script/department-dashboard/NeonBackup.gs, Escalations.gs, SystemHealth.gs, Config.gs (PROP_REGISTRY_), script-4-nav.html
- tools/ui-harness/build-harness.js, tools/ui-harness/drive-smoke.js, tools/ui-harness/README.md
- tests/unit/neon-backup-scrub.test.js (new), tests/unit/escalations-hardening.test.js, tests/unit/system-health.test.js, tests/README.md
- CLAUDE.md (S54 index line), README.md, docs/invariants.md (INV-55), docs/operator-state.md (#24, #28), docs/client-ui-conventions.md, docs/regression-scenarios.md (S54), docs/fix-history.md (header), docs/module-dependencies.md (regenerated), docs/next-steps.md

CHANGES:
ESC-D8 | Escalations.gs | deleteEscalation collects the deleted ids before the DELETE (every copy's on a delete-all, via the new escGroupIds_) and, AFTER the commit, the lock release and the connection close, calls nbScrubAfterDelete_(ids). The return value is otherwise unchanged; it gains `backupScrub` ('ok' / 'pending') when a scrub ran. An unknown id or a failed delete never scrubs.
ESC-D8 | NeonBackup.gs | nbScrubAfterDelete_ queues the ids FIRST (NEON_BACKUP_SCRUB_PENDING, JSON, script-lock read-modify-write, capped at 150 ids with an overflow count), then nbScrubPending_ rewrites every escalations-*.jsonl snapshot and every escalation_activity month / part / tail file without those rows, in EVERY store the install has written to (Drive folder and Sheets workbook -- a fallback run leaves older Drive files behind; never creates a store). Ids leave the queue only when every store opened and no file was deferred. ENG-1 guard (nbScrubMonthSafe_): a CLOSED month that is not yet final is never rewritten on or after its final date (the rewrite would stamp it final with its last days missing) -- it is deferred; before the final date, or once final, it is scrubbed at once. Unchanged files are never rewritten (no timestamp churn). The weekly backup retries the queue AFTER the monthly files (so a deferred month has just been finalized from Neon) and reports `scrub ok (...)` / `scrub pending (...)` without ever making the run FAILED (the ENG-2 retention gate keys on the backup itself). restoreNeonBackupFile leaves out rows of queued ids (`skippedDeleted`). New editor tool runNeonBackupScrubNow() (admin).
ESC-D8 | SystemHealth.gs | New `backup-scrub` row: ok "none waiting", or warn with the count, since-when, overflow count and last error, plus the retry hint. Never shows the ids.
ESC-D8 | Config.gs | NEON_BACKUP_SCRUB_PENDING registered as engine state.
ESC-D8 | tests | neon-backup-scrub.test.js (9): scrub every snapshot + activity file and nothing else, idempotent; unreachable store queues and the next backup run clears it while staying ok; the ENG-1 deferral and the finalize-then-scrub path; scrub before the final date leaves the month open; both stores; no store = no-op, nothing created; queue cap; restore skip; source order (commit -> release -> scrub). escalations-hardening: the delete hands ['e1'] / every copy's id to the scrub with the lock released and after one commit; a failed delete never scrubs (the reviewConn double answers escGroupIds_ from row.groupIds). system-health: the row both ways, no ids in the payload. Bites: the month guard, the restore skip and the run retry each turn a named test red; HEAD Escalations.gs / SystemHealth.gs fail the new pins.
CL-23 | script-4-nav.html | setRoute_ pushes ONE history entry per route change (google.script.history.push, hash = route, the page's own query string kept from getLocation) -- never a duplicate (lastHistoryRoute_) and never during a Back/Forward. setChangeHandler -> onHistoryChange_: normalizes the entry's hash (unknown -> /overview), closes every other open routed modal through its own .modal-close, then swaps the page or opens the target modal; the F11 non-admin no-op applies to admin-only modals. While it runs, setRoute_ accepts only its target, so closed modals' async reverts cannot repaint or push. The landing deep-link dispatch pushes nothing. Every API call is feature-detected and try-wrapped (the old "spotty browser behavior" note). Header comment rewritten.
CL-23 | tools/ui-harness | build-harness.js: the no-op history mock is now a recording stack (push truncates forward entries like a browser; historyBack/historyForward replay an entry into the app's change handler like a popstate). drive-smoke.js: a third fresh boot per role -- one entry per page change, Back/Back/Forward without pushes, the tab lit correctly; admin: a modal route pushed, Back closes it on the page under it, Forward reopens, X close is one entry; manager: an admin-only route from history stays closed. 16 new checks; all fail against the HEAD router.
CL-23 | docs | client-ui-conventions router section rewritten (was "No google.script.history.push"); Regression Scenario S54 (the two-real-browser walk) added + indexed in CLAUDE.md, README, fix-history.

TEST RESULTS: passed -- `npm run ci` 2144/2144 + INV-16 guard + module-deps --check (regenerated); `CI=true npm run lint:gas` clean; bare `TZ=UTC node --test` 2144/2144; `CI=true npm run ci:ui` all stages (drive-smoke 150/150 incl. the 16 history checks).
REGRESSION RISKS:
- ESC-D8: the delete RPC now also reads every escalation backup file before returning (Drive: one read per snapshot + per activity month; a few seconds for a year of weeklies). The Neon delete is already committed and the lock released, so a slow or failing scrub only delays the response; it never fails the delete.
- ESC-D8: a scrub that keeps failing (e.g. an old Drive folder the account can no longer open while backups run on Sheets) leaves the Health row amber until the operator clears the cause -- by design; the hint names the fix.
- ESC-D8 does NOT reach Drive file revisions (kept ~30 days) or the backup workbook's version history; documented in Operator State #28.
- CL-23: closing a modal is now a history step, so Back right after closing reopens it (standard route-driven behavior). Back closes an open routed modal through its own close button, so unsaved input in that modal is lost exactly as with X. Non-routed overlays (Help, confirm dialogs) are left alone.
- CL-23: real-browser behavior of google.script.history is unverified in CI (the harness mocks it); S54 is the owner walk in two browsers BEFORE release. If it misbehaves, the fail-quiet wrapper means removing the setChangeHandler/push calls restores the old routing exactly.
INVARIANTS AT RISK: None. INV-55 text gains the scrub; the delete's transaction, admin gate and audit row are unchanged. INV-01: no new public write path (runNeonBackupScrubNow is admin-gated and editor-run; the scrub rewrites backup files the backup engine already owns). INV-16 untouched.
NET SCORE: 2 production fixes (ESC-D8: a deleted escalation -- often logged by mistake with patient detail -- stayed in up to 8 weekly snapshots and the activity months indefinitely; CL-23: the browser Back button left the dashboard entirely) − 0 new failure modes = 2. The Back-reopens-after-close behavior is the documented navigation model, not a failure mode.

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard | BLOCKS DEPLOY: Y
- Before releasing to managers: walk Regression Scenario S54 (Back / Forward) in two real browsers and record any difference | BLOCKS DEPLOY: Y (per the owner ruling)
- None for the scrub: no property to set, no trigger to install. After the next delete, the Health page's `backup-scrub` row should read "none waiting" (or show why not). | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

FOLLOW-ON ITEMS:
- The escalation card's delete toast does not mention a pending scrub (the result carries `backupScrub`); the Health row is the signal today. A one-line toast addition is possible if the owner wants it.
- Escape-closed modals other than the Individual Report still do not revert the route (pre-existing cosmetic, noted in the router comment), so they push no "page under it" entry; Back from there goes to the previous page entry, which is still the right view.
- Batch 15 (CH-4 selective split) is next; LEG-2 still waits on the decommission date.

DOCUMENTATION UPDATES NEEDED:
- None remaining -- all edits listed above.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
