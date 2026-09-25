---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- a11y tidy-up (follow-on from block 202): Insights Queue-health and all-dept Queue report rows move `aria-expanded` from a focusable `<tr>` to a button in the cell.
- S2B-3: the orphan rename wrote its audit row after an unprobed, unbounded Neon mirror.
- S2B-4: a failed Neon rename could not be retried.
- PCR-7: coaching delivery took no lock, and its "continuing" UPDATE had no `status='open'` guard.
- SEC-2: user-triggered report emails had no per-user throttle.
- S2B-8: the manual subscriber blast and the automated poll could both send the same day.
- ENG-4 (re-scoped after ENG-3): a second admin's alerts trigger could double-send; the marker is now claimed under the lock.
- SEC-4: `LOGIN_NOTIFY_SEEN` overflowed the 9 KB property limit near ~165 addresses.
- ING-5: the nightly prune deleted recovered Call_Legs tabs, and the importer left an empty tab after a failed write.
- S2A-5: the stale digest note said "tiles empty" on weekly/monthly digests, and previews never checked staleness.
- S2A-4: CacheWarm's Insights warm never matched a quick-start chip request.
- ENG-10: CacheWarm warmed the qcdAll key for calendar yesterday instead of the latest QCD date.

Files modified:
- apps-script/department-dashboard/:
  - script-1-core.html, script-8-insights.html, script-11-qcd-boot.html, styles.html
  - OrphanFix.gs, Coaching.gs, Config.gs, DeptSummaryEmail.gs, IndividualReport.gs, InsightsReport.gs, QueueReportEmail.gs, InboundReport.gs, OutboundReport.gs
  - Alerts.gs, Auth.gs, Digest.gs, CacheWarm.gs
- apps-script/cdr-import/: DeleteOldSheets.js, importBulkCSVsFromDrive.js, propRegistry.js
- tests/unit/:
  - NEW orphan-rename-neon.test.js
  - coaching, app-email, queue-report, alerts-readiness, login-notify, retention-prune, digest-freshness-gate, cache-warm-budget
  - cross-file-pins (OrphanFix left the JDBC-URL list), cache-version-sync (the `mailThrottle` spec)
- tests/README.md; tools/ui-harness/drive-f13.js
- docs/: invariants.md (INV-47 `neon-rename`), operator-state.md (#43 recovery holds, #56 pointer), client-ui-conventions.md, fix-history.md
- CLAUDE.md (the email bullet); .cycle/STATE.md; the plan

CHANGES:
a11y | script-1-core, script-8, script-11, styles, drive-f13 | `button.qcd-expand-toggle` in the first cell owns `aria-expanded` (set by `qcdToggleExpandRow_`). The row `tabindex` and both row keydown handlers are removed (they would double-toggle). The all-dept auto-expand also flips the buttons. drive-f13 presses Enter and Space on both surfaces.
S2B-3 | OrphanFix.gs | The rename's audit row now lands BEFORE the Neon mirror. The mirror uses `getDashboardNeonConn_` (down-memo) with `setQueryTimeout(60)` on both statements. Its outcome goes into a separate append-only `neon-rename` row.
S2B-4 | OrphanFix.gs | With 0 sheet rows left, the rename becomes a Neon-only retry, audited as `neon-rename`. If neither side has rows (or Neon is unreachable), it throws the original error.
PCR-7 | Coaching.gs | The read-diff-write runs under the script lock, held for the DB work only. A busy lock returns `skipped (…)`. The continuing UPDATE is guarded with `AND status = 'open'`.
SEC-2 | Config.gs + 6 senders | `assertReportEmailThrottle_` allows 30 sends per user per rolling 6 h, stored in CacheService, and fails open if the cache is unavailable. It is called early in the dept-summary, IR, Insights, all-dept Queue, Inbound and Outbound email RPCs. A sweep fails any new public sender that skips it.
S2B-8 | QueueReportEmail.gs, Config.gs | Before either path sends, `queueReportClaimSend_` checks the marker and the `QUEUE_REPORT_SENDING` in-flight claim under a short lock. The claim is released in a `finally`; a claim older than 15 min is ignored.
ENG-4 | Alerts.gs, Config.gs | `alertsClaimRun_` re-reads `ALERTS_RUN_MARKER` and claims `ALERTS_RUN_CLAIM` under the lock. A concurrent run returns `in-flight`. A BUSY lock reschedules through `alertsScheduleRetry_` (DEFERRED), or records FAILED-LOCK if no retry can be scheduled. The claim is released in a `finally`.
SEC-4 | Auth.gs | `LOGIN_NOTIFY_MAX_BYTES` (8000, UTF-8) evicts oldest-first after the key cap, never evicting the new entry. A failed `setProperty` is logged, not thrown.
ING-5 | DeleteOldSheets.js, importBulkCSVsFromDrive.js, propRegistry.js | `RETENTION_HOLD` maps tab → until. The prune skips held tabs, drops expired holds, and reports `held` in its Pipeline Health note. The importer holds the tabs it imports for 3 days, and `holdCallLegsForRecovery()` (editor) covers hand-made tabs. `importCallLegsCsv_` fills an empty leftover tab, pads ragged rows, and deletes a tab its own failed write created.
S2A-5 | Digest.gs | The multi-day stale callout says the figures are partial. `sendPreviewDigest` applies the last-business-day freshness gate and says "previewed".
S2A-4 | CacheWarm.gs | `warmInsightsChips_` warms (dept, latest, latest, the picker's active agents, or all agents when none are active), replacing the 30-day whole-roster warm.
ENG-10 | CacheWarm.gs | The qcdAll warm targets `latestQcd`, gated on `prevBusinessDayIso_`.
Every new test was bite-checked against HEAD and fails there. For the a11y change, drive-f13 fails with the old client.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 1888/1888.
- INV-16 in sync; module-deps up to date; `CI=1 npm run lint:gas` clean.
- `CI=1 npm run ci:ui`: all stages passed.
- One failure from this session, fixed: the cache-version-sync S2 sweep and the claude-md-split coverage map (new prefix, new suite).

REGRESSION RISKS:
- SEC-2: a legitimate user past 30 report emails in 6 h is refused with a readable error. This is intended, and the constant is tunable.
- PCR-7: a delivery run that finds the lock busy skips for the week and shows a bad Health outcome; the admin can "Run now".
- S2B-8: a poll that finds the lock busy stands down and the next poll retries.
- The qcd-expandable rows are no longer tab stops; their buttons are. The keyboard path is the same.
- Help and the other layers are unaffected.
- ING-5: a held tab stays up to 3 days past the cutoff (bounded; the hold expires by itself).

INVARIANTS AT RISK: None.
- INV-01: no new public write path. The throttle and the claims are Script Property / Cache writes by existing gated paths.
- INV-47 is extended (`neon-rename`) and stays append-only.
- INV-44: the retentionPrune row keeps its step name.
- INV-30: `mailThrottle:v1` is not a report cache and is registered as an exception.

NET SCORE: 2 − 1 = 1
- Production this month:
  - S2A-4 YES, if cache warm is armed: every daily warm missed the chips.
  - ENG-10 YES, if armed: every Monday.
  - The rest need rare timing, two admins, a Neon read source, a killed run, >165 addresses or a recovery.
- New failure mode: SEC-2's cap can refuse a legitimate heavy user. It is documented and deliberate.

OPERATOR ACTIONS / DEPLOY:
- None required | BLOCKS DEPLOY: N
- After any hand-recreated Call_Legs tab, run `holdCallLegsForRecovery()` (Operator State #43). A runbook step, not a deploy blocker.
Deploy:
- Department Dashboard: `clasp push -f` from repo root (or `scripts/deploy.sh .`), then Manage deployments → New version.
- CDR Import: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- CRT-4 on the dup-guard re-mirror / deferred mirror (block 202) is still open. It needs a lost-cell channel through the INV-16 writer.
- The S2A-4 chip warm approximates the picker for sub-queue parent depts (grouped pickers tick the first active group); those depts may still miss.
- The SEC-2 cap is per user, not global. A coordinated multi-user loop is still bounded only by the per-user caps.
- Still open: S2C-1 `agentBusy` (live evidence), the `first_agent` audit, the callback table (`outboundReport:v5`), and Batches 9–11.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit, which updates:
  - INV-47
  - Operator State #43 / #56
  - the a11y contract
  - the CLAUDE.md email bullet (with its enforcing sweep named, C2)
  - fix-history
---END BROAD SCAN IMPLEMENTATION SUMMARY---
