---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch 3 (four ops/observability smalls) + Batch 4 (deployment hygiene).
- F6 | The Overview's cached-blob size was never measured and its cache-put failure was log-only — a silent full-recompute cliff
- F9 | `getLatestDataDate` and `getLatestDataDates` each scanned the whole DQE date column, so a cold cache read it TWICE per 5-min expiry
- F10 | The escalations nav badge was append-only and fetched once per page load — it could never update, clear, or avoid stacking
- Batch 3.4 | No reconciliation between an engine's installed TRIGGER and its `*_ENABLED` flag: a trigger installed while the flag is off fires on schedule and does nothing, while the Health page reported "installed"
- Batch 4 | `clasp push -f` never deletes remote files (INV-17), so a file removed from the repo stayed live and callable with nothing detecting it (Operator State #29, open across cycles)

Files modified:
- apps-script/department-dashboard/Data.gs (F9)
- apps-script/department-dashboard/CompanyOverview.gs (F6)
- apps-script/department-dashboard/script.html (F10)
- apps-script/department-dashboard/SystemHealth.gs (Batch 3.4)
- scripts/check-remote-orphans.mjs (NEW, Batch 4)
- scripts/deploy.sh (Batch 4)
- CLAUDE.md (deploy-helper block + Operator State #29)
- tests/unit/dal-cutover.test.js (+3 F9 tests, + memo reset)
- tests/unit/missed-report.test.js (memo reset)
- tools/ui-harness/drive-smoke.js (+1 F10 assertion)

CHANGES:
F9 | Data.gs | New `sheetScanDqeDateBounds_()` returns `{min, max, rows}` from ONE date-column read, memoized per execution (the established `DEPT_CONFIG_ROWS_MEMO_` / `QCD_SHEET_DATA_MEMO_` discipline, `var` so the harness can reset it). `getLatestDataDate` takes `max` from it instead of its own whole-column scan; `getLatestDataDates`'s `dqeEarliest` (R12-26) takes `min` from the same memo instead of a second scan. Deliberately NOT cached across requests — each caller keeps its own R8-C2 negative-cache semantics, which a shared cross-request cache would have blurred. Neon paths untouched (indexed MIN/MAX queries).
F6 | CompanyOverview.gs | New `OVERVIEW_CACHE_MAX_BYTES` (100 KB, the CacheService per-value ceiling) + `OVERVIEW_CACHE_WARN_BYTES` (80 KB tripwire). The put now serializes once, logs a loud warning past the tripwire (with the byte count, % of cap, and dept count, plus the concrete remedy — split a field to its own key, the `getOverviewChartTrend` precedent), and on FAILURE logs the size, the dept count, and explicitly that the Overview is now uncached so every request pays the full compute. Measured context recorded inline: ~27 KB at 14 depts (~1.9 KB/dept), so the cap is ~50+ depts away — this is a tripwire, not a live risk, and the per-put size log makes the trend visible before it becomes a cliff.
F10 | script.html | Extracted `escApplyBadge_(counts)` from `loadEscBadge_`. It is now IDEMPOTENT: it UPDATES an existing badge (text, warn class, tooltip) and REMOVES it — and hides + empties the Overview strip — when the count reaches zero. The old code only ever appended (guarded by `!tab.querySelector('.nav-count-badge')`) and ran once at init, so after a manager resolved their last escalation the badge kept the old number for the whole session. `escLoad_`'s success handler now calls `loadEscBadge_()`, and since every mutation reloads the list, the badge follows every change. Deliberately a FRESH `getEscalationsBadge()` rather than reusing the list response's `meta.statusCounts`: the list can be filtered to one dept (an admin picking a dept, or view-as) while the badge is scoped to the viewer's FULL set, so deriving it from a filtered response would undercount. One cheap COUNT aggregate is the right trade.
Batch 3.4 | SystemHealth.gs | `svc()` takes an optional `flagProp` and reconciles it against the installed trigger for the four flag-gated engines (`NEON_KEEPWARM_ENABLED`, `INGEST_WATCHDOG_ENABLED`, `PIPELINE_WATCH_ENABLED`, `QUEUE_REPORT_ENABLED`). Two mismatches are now warn rows with specific remedies: **installed but DISABLED** ("every run is a no-op" — the dangerous one, previously reported as plain "installed") and **flag on with no trigger** ("it never runs"). A complete+enabled engine reads "installed + enabled". Added a single `trg-readiness` verdict row — "N armed, K need attention" — so "is this install armed?" is one row instead of fifteen. Engines with no flag (alerts, digests, cache warm, backup) pass nothing and behave exactly as before.
Batch 4 | scripts/check-remote-orphans.mjs (NEW) + scripts/deploy.sh + CLAUDE.md | clasp has no "list remote files" command, so the check PULLS the project into a throwaway temp dir (with `rootDir` forced to `.`, so it can never land in or clobber the real project dir) and compares against the local rootDir. Comparison is on `(basename-without-extension, kind)` because **clasp pull writes server files as `.js` even when they live locally as `.gs`** — without that normalization every single `.gs` file would have looked orphaned. Wired into `deploy.sh` BEFORE the push (so the comparison isn't confused by the files the push is about to add). WARNS by default — an orphan is not a reason to refuse to ship an urgent fix — with `STRICT_ORPHANS=1` to make it fatal. Every unrunnable path (no `.clasp.json`, placeholder scriptId, unparseable JSON, missing rootDir, `clasp pull` failure) skips with a reason and exit 0, because a diagnostic must never block a deploy.

TEST RESULTS: passed.
- `npm run ci` → 493/493 unit tests (was 490; +3 F9 tests), INV-16 guard clean, cache-version-sync clean.
- `npm run ci:ui` → 24/24 smoke (was 22; +1 F10 badge-duplication assertion per role) + 16/16 keyboard. Run because F10 changed `script.html`.
- The Batch 4 script was verified against a SIMULATED clasp (a fake `clasp pull` writing a remote file set): correctly found the 2 planted orphans and nothing else, correctly reported clean when they were removed, correctly skipped on a credentials failure, and `STRICT_ORPHANS=1` exited 1. **That simulation caught a real bug**: the temp dir's own `.clasp.json` was being reported as an orphan (it lives outside rootDir locally but inside the pull dir), now excluded via `NOT_PROJECT_FILES`.
Regression Scenarios: NOT EXECUTED — all overlapping scenarios (S1/S2/S23/S25/S30 for the dashboard readers, S37 for Insights) need the deployed app plus a live spreadsheet. The UI gate covered the client half of the F10 change.

REGRESSION RISKS:
- **F9 is the one with real regression surface.** The memo is per-execution shared state across two public readers. Behavior equivalence was checked line-by-line: same range (`HISTORICAL_COLS.DATE`, rows 2..lastRow), same `rowDateIso_` parse with the spreadsheet TZ, same "no parseable date ⇒ negative" outcome, and `getLatestDataDate`'s R8-C2 `cacheNegative_` / `logDqeReadTiming_` behavior is preserved (the timing log now reports ~0ms on a memo hit, which is honest — no read happened). The memo could serve stale bounds if a single execution mutated the DQE sheet and then re-read it; no dashboard path does that (all writers live in cdr-import/cdr-report). The TEST-side risk was real and handled: `install()` in dal-cutover + missed-report now reset `DQE_DATE_BOUNDS_MEMO_` alongside the existing memo resets, or a fixture swap would have served the previous test's bounds.
- F6 adds one `JSON.stringify` whose result is then reused for the put — no extra serialization versus before (the old code stringified inline).
- F10 adds one `getEscalationsBadge()` aggregate per escalations list load. It is a single COUNT query over the viewer's scope, on a page that already issues 1–2 RPCs. The badge can now REMOVE itself, which is the intended behavior change; a viewer whose count legitimately drops to zero will see the tab badge and Overview strip disappear.
- Batch 3.4 changes row STATUS for the four flag-gated engines: an engine that is installed-but-flag-off flips from muted/ok to **warn**. That is the fix (it was silently inert), but an operator who intentionally parked a trigger with the flag off will now see amber until they uninstall the trigger — the hint says exactly that. Existing tests pinning `trg-warm`/`trg-backup`/`trg-queuereport` still pass because those rows are unchanged when no flag is set / not installed.
- Batch 4 runs `clasp pull` (network + auth) inside the deploy path. It is wrapped so any failure skips; the temp dir is always removed in a `finally`. It cannot write to the project directory because `rootDir` is forced to `.` inside the temp dir.
- No interface, return type, or default value changed for any existing caller: `getLatestDataDate` still returns an ISO string or null, `getLatestDataDates` keeps its blob shape, `getSystemHealth` keeps its row shape (one row ADDED), and the new script is standalone.

INVARIANTS AT RISK: None.
- INV-43 (My Department default snaps to the latest DQE date) — preserved: `getLatestDataDate` returns the same value from the same column scan.
- INV-30 — no cached payload SHAPE changed, so no version bump; the `latestDate:` / `latestDates:` keys and their source suffixes are untouched, and cache-version-sync passes. F6 changes only logging around the put.
- INV-17 — Batch 4 doesn't work around it (nothing can delete remote files but a human in the editor); it makes the consequence VISIBLE, which is the most that can be automated.
- INV-55 — F10 touches only the client badge presentation; no endpoint, gate, or status transition changed.
- INV-16 — no duplicated file touched; guard clean. INV-01 — no new public write path.

NET SCORE: 2 production fixes − 0 new failure modes = 2
- F10 counts YES on "would it fire in production this month": a manager resolving their last escalation saw a stale non-zero badge for the rest of their session — a user-visible defect on a path users hit, which the /reflect rubric says not to demote to defensive.
- Batch 3.4 counts YES: a trigger installed with its flag off is silently inert TODAY and the Health page actively reassured the operator it was armed. It is a live misreporting bug, not a hypothetical.
- F9 (cost, not correctness), F6 (a tripwire for a cap ~50 depts away), and Batch 4 (a detector for a known-open manual step) are defensive/structural — 3 under the three-way tally.

OPERATOR ACTIONS / DEPLOY:
- Open the Health page after deploying and read the new **"Install readiness (engines)"** row. Any engine reading "installed but DISABLED" has been doing nothing on every scheduled run — decide per engine whether to set its `*_ENABLED=true` or uninstall the trigger. | BLOCKS DEPLOY: N
- Run `node scripts/check-remote-orphans.mjs .` (needs an authenticated clasp) to settle Operator State #29 — it will name `PerformanceReport.gs` / `CompareRangesReport.gs` if they are still live in the dashboard project. Delete each in the Apps Script web editor. | BLOCKS DEPLOY: N
- Still outstanding from increment 53: deploy both projects; re-run the Operator State #38 histogram; decide UDC/UUC attribution; walk S41/S42. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`, which now runs the orphan check first). Data.gs, CompanyOverview.gs, SystemHealth.gs and script.html all changed.
- CDR Import: unchanged by this batch, but the increment-53 push (`cd apps-script/cdr-import && clasp push -f`) is still pending.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The remote-orphan check could not be exercised against the REAL projects here (no authenticated clasp in this environment). Its logic is verified against a simulated pull; the first real run is the operator's.
- F6 only LOGS. A size that crosses the tripwire will sit in the Executions panel until someone looks. Surfacing it as a Health-page row would close that loop (it has no property to read today, so it would need one written at put time).
- The F10 badge still can't reflect changes made on ANOTHER page (e.g. an admin resolving via a different tab) until the escalations list is loaded again — it is not a live subscription, and the Overview strip only refreshes on an escalations load or a page reload.
- Batch 3.4 reconciles flags for the four engines that have them. `CACHE_WARM` and `NEON_BACKUP` have install-only arming (no flag), so their rows are unchanged — correct today, but if either gains a flag it must be added to the `svc()` call or it will silently regress into the same blind spot.
- Remaining scan batches: **5** (the QCD-vs-inbound discrepancy — still unexplained, still the blocker on releasing Inbound + Direct to managers), **6** (flag flips, starting with `QCD_READ_SOURCE`), **7** (F8 CLAUDE.md split — now ~370 KB and growing each batch).

DOCUMENTATION UPDATES NEEDED: None outstanding — the two that would have gone immediately stale are done inline (the Key-commands deploy-helper block now documents the orphan check + `STRICT_ORPHANS`, and Operator State #29 now says the item is DETECTED rather than remembered, with the standalone command). Noted for a future `/sync-docs`: `docs/known-issues.md` has no entry for the trigger-vs-flag mismatch class, which is a genuine institutional-memory item now that the Health page names it.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
