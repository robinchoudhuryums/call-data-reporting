# Operator State Checklist

<!-- Split out of CLAUDE.md (finding F8). CLAUDE.md was ~372 KB and is loaded
into EVERY session's context; this file holds the full text of one reference
section so the working document stays readable. CLAUDE.md keeps a one-line
index and a pointer here. The text below is the AUTHORITATIVE version --
the index is a finding aid, never a substitute. Keep them in sync;
tests/unit/claude-md-split.test.js fails the build if they drift. -->

The numbered **Operator State Checklist** items referenced from CLAUDE.md.
These are OPERATOR INPUTS -- Script Properties you set, triggers you install,
sheets you create, migrations you run. Cited elsewhere by number
("Operator State #38"), so the numbering is stable: retire an item in place
rather than renumbering.

Read CLAUDE.md's `## Operator State Checklist` section first -- it carries the
scope note (which properties are deliberately NOT listed) and the
start-at-the-Health-page instruction.

When something looks wrong, before assuming a code bug, check:

1. Did the daily ingest run? Verify the latest date in `DQE Historical Data` (CDR Report sheet). If a DATE-RANGE gap shows on the Overview chart while the sheet AND Neon verifiably hold the rows (parity clean), run the editor diagnostic `probeOverviewChartDates()` (CompanyOverview.gs; admin, read-only; optional `OV_PROBE_FROM`/`OV_PROBE_TO` Script Properties set the range) -- it replays the chart pipeline's per-row filters and logs which one eats the rows (roster-unmatched sample names usually mean an agent-name-variant era; fix via Outlier Fix renames/aliases, R11-C0).
2. Did the dashboard's deployed version include the latest code? Apps
   Script editor → Deploy → Manage deployments → check the timestamp.
3. Did the user actually have access? `Access Control` sheet rows are
   case-sensitive on email.
4. Is the cache stale? Bump the relevant per-report prefix (see INV-30)
   or wait out the TTL -- up to 30 min for the heavy report aggregations
   (`REPORT_CACHE_TTL_SECONDS`), 5 min for the latest-date + freshness
   pill lookups (`CACHE_TTL_SECONDS`).
5. Did the source-pipeline bugs (window inclusion / ATT denominator / leg
   attribution — see `known-issues.md`) get re-introduced? Spot-check Sonia
   2026-03-09: TTT should be `0:15:03`, ATT should be `0:03:01`.
6. After pulling new code that adds sheets, was `setup()` re-run?
   `setup()` requires admin auth (`assertAdmin_()`) — run from the
   Apps Script editor while logged in as an admin listed in
   `ADMIN_EMAILS` Script Property (or `ADMIN_EMAILS_FALLBACK`). It
   creates `Access Control`, `Alert Config`, `Alert Log`,
   `Pipeline Health`, `Digest Config`, `Agent Alias Overrides`,
   `Orphan Fix Log`, `Dept Config`, `Report Usage`, and `Queue Report
   Subscribers` -- whichever are missing. Idempotent on re-runs
   (existing data untouched). Without re-running setup() after a
   fresh pull, downstream writers (Pipeline Health appends, Digest
   config reads, Orphan Fix log appends) silently no-op against
   the missing sheet, and the Orphan Fix modal will throw "sheet
   missing -- run setup()" on first write.
7. For alerts AND report-modal new-tab buttons: is the
   `DASHBOARD_URL` Script Property set? Two consumers since Phase C
   (commit ce4220a): (a) the "Open Dashboard" link in alert emails
   — without the property, emails still send but omit the link;
   (b) the `↗ Open in new tab` buttons on every report modal —
   without the property, the buttons silently hide via
   `.is-disabled` and the side-by-side comparison flow doesn't
   work. Strongly recommended; set in the dashboard project's
   Script Properties to the deployed `/exec` URL.
8. Are all three trigger types installed? Three independent triggers
   now feed the dashboard's freshness, and each one missing is a
   silent failure:
   - **Daily alerts**: dashboard project → Triggers should list
     `runDailyAlerts_` (or install via the Alerts modal). Without
     it, alerts only fire when an admin clicks "Send alerts".
   - **Daily DQE build** is now integrated into cdr-import's
     `processIntegratedHistory` (5th block; INV-16 expanded). Each
     successful daily import now refreshes DQE Historical Data
     alongside CDR / Q Path / QCD / CSR. The bulk-backfill path
     (`bulkHistoricalUpdate`) also builds DQE per-date now, logged
     as `bulkBackfill:DQE`. The cdr-report project's standalone
     `runDailyDQEBuild_` trigger is preserved as a safety net
     during stabilization; **uninstall it once the integrated path
     proves reliable -- a CORRECTNESS step, not just redundancy
     cleanup (R8-E5)**: LockService is per-project, so the trigger
     can fire while cdr-import is mid-way through its chunked Raw
     Data rewrite, read a PARTIAL grid, and write a silently-short
     DQE day that the dup-guard then freezes (and, in inline mirror
     mode, pushes to Neon authoritatively). Narrow window, silent
     failure until a force re-import. Look for `processIntegratedHistory:DQE`
     (or `bulkBackfill:DQE` if a backfill ran) rows in Pipeline
     Health (INV-44) -- present = integrated path working.
     Absent only = either no import ran today OR the DQE block
     specifically failed (the autoImport row will still be
     `success`; check the cdr-import execution log).
   - **Daily + weekly digests**: dashboard project → Triggers should
     list `runDailyDigests_`, `runWeeklyDigests_`, and `runMonthlyDigests_` (or install
     via Alerts modal → Report Subscribers → Install digest triggers).
     Without them, Digest Config rows have no effect.
9. Did the latest push add a new OAuth scope? Open the Apps Script
   editor → Run → any function → grant the new permission. Scope-
   gated calls (trigger install, mail send) otherwise throw
   permission errors at runtime even though the dashboard page
   loads fine.
10. After adding a sub-queue to `OVERVIEW_PARENT_OF`, verify the
    key matches the `DO NOT EDIT!` column header byte-for-byte
    (case, spaces, and any ` Q` suffix). Mismatches show up as a
    `Logger.log` warning in the project's Stackdriver / execution
    log on every `getCompanyOverview` call; the sub-queue still
    renders as an unrelated top-level dept until the key is
    fixed. Use both spellings as aliases if you're unsure.
11. Pipeline Health sheet: open the dashboard's Alerts modal →
    Pipeline Health section. A long quiet stretch on `autoImport`
    (or on any of the DQE-freshness step names -- `buildDQE`,
    `processIntegratedHistory:DQE`, `bulkBackfill:DQE`; see
    INV-44 for the full list) with rows from 2+ days ago and
    nothing since means the daily ingest or DQE rebuild hasn't
    run. Cross-check with Operator State #1 + #8. An empty sheet
    right after deploy means setup() hasn't been re-run on this
    project. Phase B (commit 9b1f263) adds a Pipeline Health
    banner above the Overview summary line that warns admins
    when no DQE-freshness success has landed in the last 36h --
    same staleness condition without opening the Alerts modal.
    If the banner fires, fall through to this checklist item to
    investigate.
12. Manager digest delivery: if a subscriber says they didn't get
    their digest, check (a) Digest Config row Active=TRUE,
    (b) Cadence is `daily`, `weekly`, or `monthly` (normalized -- other values
    are dropped), (c) digest triggers installed (#8), (d) admin
    inbox for a `notifyDigestFailure_` email if the run threw,
    (e) the Alerts modal's Manager-digest "Last runs" line (the
    `DIGEST_LAST_RESULT_<cadence>` Script Properties via
    `getDigestsInit.lastResults`) -- a `FAILED-ALL` entry means every send
    in that run failed AND the run-claim marker was cleared, so a same-day
    re-run of `sendDigestsForCadence_` will retry; also check (f) the row's
    Department matches a `DO NOT EDIT!` header exactly (an unknown dept is
    skipped + admin-notified instead of sending an all-zero digest, O-3) and
    (g) it isn't a flagged `duplicateRow` copy (first row wins, O-4).
13. `ADMIN_EMAILS` Script Property: if a recently-added admin
    doesn't see admin-only features, verify Project Settings →
    Script Properties → `ADMIN_EMAILS` includes their email
    (comma-separated). Without the property, `getAdminEmails_()`
    falls back to `ADMIN_EMAILS_FALLBACK` in Config.gs (which
    requires a redeploy to change).
14. Insights Queue health shows "No queues mapped" for a dept, OR no Overview QCD chips, OR
    "Queue Call Data" tiles missing on My Department? Confirm the
    dept's effective queue list (`getDeptQcdQueues_(dept)`) lists the
    right `A_Q_*` queue names. Open `QCD Historical Data` col D for
    recent rows to see the canonical values written by the import
    pipeline (the admin **Dept Config** modal auto-discovers these
    and flags unmapped queues). Fastest fix: open the Dept Config
    modal (admin), pick the dept, and add the queue names -- takes
    effect on the next request, no redeploy (INV-54). Alternatively
    add/edit the `DEPT_QCD_QUEUES` constant + redeploy. New depts
    producing QCD data don't surface until they're mapped one of
    these two ways.
    **Since sub-queue Phase 2 this list ALSO drives My Department's
    per-agent NUMBERS, and the failure direction inverted.** The agent
    table narrows each row to the dept's own queues via
    `inboundQueuesForDept_` (QCD Queues UNION Inbound queue aliases), so
    a dept missing ONE of its queues now UNDER-reports -- those calls
    land in no dept at all -- where before an unmapped queue merely meant
    no QCD chips. Only a dept with NO queues mapped fails open to the old
    all-queue figures; a partially-mapped dept looks fine and is quietly
    short. **After deploying Phase 2, spot-check each dept's total
    against a known day** rather than assuming a mapping that was good
    enough for QCD chips is complete.
    NB (R8-1): the QCD Queues field accepts only
    CANONICAL names seen in QCD col D -- a queue missing from the
    Missed report's queue-only card or the Inbound report usually
    needs its RAW phone-system name (e.g. `A_Q_CSR`) added to the
    dept's **"Inbound queue aliases"** field instead (the raw-name
    space; see the two-queue-name-spaces entry in known-issues).

    **Answered-on-hold attribution (2026-07).** The same Dept Config row now
    carries a **`Final Dept Labels`** field: the raw CDR "Departments"
    org-chart strings (`Customer Success`, `Patient Intake - Supplies`, ...)
    that belong to this dept. It feeds ONE thing -- the answered-then-
    abandoned-ON-HOLD carve-out in the Inbound report's dept attribution,
    which matches `inbound_calls.final_dept`. The dept's own name always
    matches without being listed. A label may belong to only one dept -- save
    rejects a duplicate claim. **Verify by re-running
    `runInboundQcdParityCheck`: the `onHold` column should stop reading `0.0`
    on every dept.** Expect a few depts' inbound figures to rise slightly the
    first time; that is the fix landing, not a regression.

    **A label you leave OUT now falls back to the ENTRY QUEUE, so blank is a
    legitimate answer (2026-07).** Originally an unmapped label meant the call
    attributed to no dept at all; it now attributes by `entry_queue`, i.e.
    wherever the call would have counted had nobody answered it. So the field
    is for OVERRIDING entry-queue attribution when the answering agent's dept
    differs from the queue the caller entered -- not a prerequisite for the
    call being counted.

    **The one case where you MUST leave it blank: a label that two depts share.**
    `Field Ops` and `Field Ops Power` carry both `Field Operations (Market
    Activity)` and `Field Operations (Markets)` interchangeably in Raw Data, so
    no mapping is correct for either -- save will refuse to put a shared label
    on both (one-call-one-dept), and putting it on one silently steals the
    other's calls. Because these two queues have no crossover agents, leaving
    both labels unmapped attributes their on-hold abandons by entry queue, which
    is right. If the phone system is ever fixed to emit distinct labels per
    queue, map them then.
15. `TARGET_SS_ID` Script Property in CDR Import: must point at
    the CDR Report spreadsheet ID. Without it, `getTargetSsId_()`
    falls back to a hardcoded ID that may not match your install.
    Set in CDR Import project → Project Settings → Script Properties.
16. Neon Script Properties in CDR Import: `NEON_HOST`, `NEON_DB`,
    `NEON_USER`, `NEON_PASS` must be set in the CDR Import project's
    Script Properties (same values as the CDR Report project).
    Without them, Neon mirror writes from the import pipeline are
    silently skipped (logged as "Neon unreachable").
17. `HMAC_SECRET` Script Property: must be set in the CDR Import,
    CDR Report, AND (since Caller Lookup) the Department Dashboard
    project's Script Properties (same value in all three).
    Used by `writeCDRRowsToNeon` and `hashPhone` (dbHistorical.js,
    reused by the insurance-number sync) to
    HMAC-SHA256 hash phone numbers for PHI protection, and by the
    dashboard's `getCallerLookup` to hash the queried number so it
    matches `inbound_calls.caller_hash`. Without it, CDR Neon mirror
    rows still write (main metric columns) but JSONB name-list fields
    and `call_history_phones` child rows are skipped; the Caller
    Lookup modal renders an "HMAC_SECRET not set" hint
    (meta.configured=false) instead of failing.
18. Neon Script Properties + scope on the DASHBOARD project (for
    orphan-rename-to-Neon): `NEON_HOST`, `NEON_DB`, `NEON_USER`,
    `NEON_PASS` must also be set on the Department Dashboard project
    (same values), and the `script.external_request` OAuth scope
    (added to `appsscript.json`) must be consented -- after deploying,
    Run any function once in the editor (per #9). Until both are done,
    `applyOrphanRename`'s Neon mirror cleanly no-ops (logs "NEON_HOST
    not set") and the sheet rename still succeeds. This is the only
    place the dashboard WRITES to Neon.
19. `DQE_READ_SOURCE` Script Property (dashboard) -- the F1 Neon
    read-back switch read by `getDqeReadSource_()`. Unset / `sheet`
    (default) = dashboard reads the `DQE Historical Data` sheet as
    always; `neon` flips the cut-over readers (`getLatestDataDate`,
    `getCompanyOverview`, `computeSummary_`, and the IR /
    Insights builders; the `getDeptQueueExts_` derived scan also reads
    Neon via `neonGetAgentExtPairs_`; Missed Calls + the
    `computeActiveAgentsInRange_` picker subset are cut over too as of
    the DAL-cutover phase -- parity pinned by tests/unit/dal-cutover.test.js;
    since CORE-2 the picker subset also survives a trimmed/archived sheet
    on the neon path, the F-35 pattern)
    to read `dqe_history`. **Only flip to `neon` after `compareDqeSources_`
    (NeonRead.gs, editor-run via the `runDqeParityCheck` wrapper -- the Run
    picker hides `_`-suffixed functions) shows parity-clean over a
    representative range AND `dqe_history` is fully backfilled** -- otherwise the read-back serves data that lags the
    sheet.
    **Batch 6 -- the gate contract:** both read-source gates now RETURN a
    structured verdict (`{clean, compared, missingInNeon, extraInNeon,
    mismatches, error}`) instead of only logging, and **`clean` can never be
    true unless rows were actually COMPARED**: a range with zero sheet rows
    logs `PARITY INCONCLUSIVE` and returns `clean:false` with an `error`. That
    hole was REAL on the QCD gate -- `neonFetchQcdGrid_` returns a non-null
    EMPTY grid, so both sides could be empty, all three mismatch counters read
    0, and it printed `CLEAN ... gate PASSED` on no evidence. The in-source
    default range is a FIXED WEEK that ages out of the data, so that was the
    likely first experience of anyone running a gate without setting its
    `*_PARITY_FROM/_TO` properties. **Never flip a read-source flag on a result
    carrying `error` or `compared: 0`** -- the CORE-5/F-5 rule the config gates
    already followed. Pinned by qcd-report.test.js + dal-cutover.test.js. Reversible with no redeploy (set back to `sheet`); cut-over
    readers also fall back to the sheet on any Neon error. After a bulk
    rebuild (which defers the DQE->Neon mirror via `skipNeon`), run
    `backfillDQEHistoryUpsert()` (cdr-report) to populate/refresh
    `dqe_history` before relying on the read-back. It is resumable via
    the code-written `DQE_UPSERT_RESUME` cursor (clear it to restart from
    the top), and takes an optional **`DQE_UPSERT_SINCE`** Script Property
    -- a `YYYY-MM-DD` floor that upserts only rows on/after that date, so
    a bulk rebuild of a few recent days doesn't redo the whole history.
    (`DIRECT_UPSERT_SINCE` is the same knob on the Direct backfill, item
    26.) Unset = full history. The Alerts modal
    shows a **Neon mirror health** line (`computeNeonMirrorHealth_`:
    sheet vs `dqe_history` `MAX(call_date)`) so a stale mirror is
    visible at a glance; a transient outage that left a date
    un-mirrored self-heals on the next import of that date -- the
    dup-guard re-mirrors the existing sheet rows to Neon (F2). The
    Alerts modal ALSO shows a **Neon read-back health** line
    (`computeNeonReadHealth_`, surfacing the durable `NEON_READ_LAST_ERROR`
    streak `recordNeonReadFailure_` writes): a failing Neon read-back
    -- which silently falls back to the sheet, so a sustained outage
    would serve stale data once the sheet ages -- is now visible to
    admins. The line renders only when Neon is configured AND (reads
    are on `neon` OR a failure is on record), warn-tinted with the
    last error + consecutive-failure count, cleared on the next
    successful read. The parity gate `compareDqeSources_` reads the
    optional `DQE_PARITY_FROM` / `DQE_PARITY_TO` Script Properties for
    its range (in-source defaults if unset).
20. Neon keep-warm (optional; only relevant once `DQE_READ_SOURCE=neon`).
    Toggle from the Alerts modal → **Neon keep-warm** section
    (`NeonKeepWarm.gs`). When enabled it sets `NEON_KEEPWARM_ENABLED=true`
    and installs the `keepNeonWarm_` trigger (every 5 min, gated to a
    weekday window). Tune the window via the `NEON_KEEPWARM_START_HOUR` /
    `NEON_KEEPWARM_END_HOUR` Script Properties (defaults 7 / 13 Central);
    the modal shows the estimated monthly compute-hours so you stay under
    the Neon free allowance (~190h). Needs the dashboard `NEON_*` props +
    `script.external_request` + `script.scriptapp` scopes (same as the
    read-back + alerts trigger). If keep-warm shows "unreachable" pings,
    check the `NEON_*` props; pings no-op cleanly when Neon is unconfigured.
    A keep-warm ping failure does NOT pollute the DQE read-back health line
    (it connects via `getDashboardNeonConn_({skipReadHealth:true})`), so a
    warm-ping blip can't show a sticky false "read-back FAILING" while reads
    are still on the sheet -- the warm ping cannot pollute it (F29). Since NEO-3, recording is opt-IN (`{recordReadHealth:true}`, passed only by the three DQE read-back readers) -- non-DQE Neon surfaces (Inbound report/heatmap, Caller Lookup, escalation writes, config readers) neither record nor clear it, so the line is strictly a DQE read-back signal.
21. Report cache warming (optional; `CacheWarm.gs`). Toggle from the Alerts
    modal → **Report cache warming** section (`installCacheWarmTrigger` /
    `uninstallCacheWarmTrigger`, both `assertAdmin_`-gated). When enabled it
    installs the `warmReportCaches_` daily trigger (default `CACHE_WARM_HOUR`
    = 9 Central, after the morning ingest), which pre-warms the Overview blob
    + each dept's My Department default-range summary + the all-departments
    Daily Queue Report for YESTERDAY (the exact key its modal pre-loads;
    6h `qcdAll` TTL keeps it hot -- the warm is SKIPPED when the QCD latest
    date is older than yesterday, so a late ingest can't pin an empty report
    for the long TTL) + each dept's AGENT-FREE Insights over the launcher
    window (last 30 days ending yesterday -- the exact request the Insights-routing
    quick-start chips (Help modal since R10-1) auto-run; runs LAST under a 4-min runtime budget so the
    trigger can't be killed mid-warm; unwarmed depts take the cold path and
    the outcome line reports how many were skipped) so the first manager of
    the day gets cache hits instead of cold aggregations. **Must run in the
    dashboard project** -- CacheService is per-project, so the cdr-import
    ingest can't warm it. "Warm now" (`warmReportCachesNow`, admin) primes on
    demand. Reuses `script.scriptapp`; independent of `DQE_READ_SOURCE`
    (helps the sheet path too). Best-effort: per-dept failures are logged,
    last outcome shown in the modal.
22. Deferred Neon mirror (optional; `NeonMirror.js`, CDR Import). Defaults OFF
    -- the daily import mirrors to Neon inline as before until you opt in.
    To move the mirror off the synchronous import path: (a) run **CDR Tools →
    Install Neon Mirror Trigger** in the cdr-import project (installs
    `runNeonMirror_`, every 15 min; needs `script.scriptapp`), then (b) set the
    cdr-import Script Property `NEON_MIRROR_MODE=deferred`. The import then
    enqueues each date to the `Neon Mirror Queue` tab and the trigger mirrors
    it shortly after; the daily toast shows `Neon ⏳ queued` and per-type
    outcomes appear as `neonMirror:*` Pipeline Health rows. Verify on one
    import (queue drains, `neonMirror:*` success rows, dashboard data current)
    before relying on it. Reversible: set `NEON_MIRROR_MODE=inline` (or clear).
    Per-date sheet reads are a bounded tail-scan (F-20); if a drained date
    ever logs oddly-slow, the `NEON_MIRROR_TAIL_ROWS` Script Property
    (cdr-import, default 3000) is the window knob. A date that HARD-errors
    (throws -- not Neon-unreachable, which retries forever) is retried at
    most `NEON_MIRROR_MAX_ATTEMPTS` times (Script Property, default 8),
    then DROPPED with a `neonMirror:gave-up` Pipeline Health failure row +
    one final email -- re-enqueue it (append a row to the Neon Mirror Queue
    tab) after fixing the cause, or run the per-type backfills (IMP-6;
    a date whose `Call_Legs_*` sheet was PRUNED before it drained hard-fails
    the same way -- its inbound_calls rows are unrecoverable and the gave-up
    email says so rather than silently dequeuing, IMP-11;
    duplicate-conflict-key rows, the known poison-pill cause, are now
    deduped last-write-wins inside the writers so they no longer throw).
    **Step order + no-skip (F12):** `neonMirrorDate_` runs the five types
    **least-recoverable FIRST** -- Inbound, Outbound, then CDR, QCD, DQE --
    and every step is attempted even when an earlier one hard-errors (errors
    are collected and thrown ONCE at the end, so the attempt-counting + retry
    cap above are unchanged). Before F12 the first hard error RETHREW
    immediately, so a CDR-side poison pill meant Inbound/Outbound were never
    attempted across all 8 retries -- and then the gave-up path dropped the
    date, permanently losing the only two types that CANNOT be re-derived
    from a sheet once the ~14-day `Call_Legs` window passes, while the step
    that caused the failure stayed re-derivable forever. Don't reintroduce a
    rethrow inside `step()`, and don't reorder the sheet-derivable types
    ahead of Inbound/Outbound. Pinned by neon-mirror-tail.test.js.
    Once trusted, uninstall the cdr-report `runDailyDQEBuild_` safety-net
    trigger so DQE isn't mirrored both inline and via the queue (harmless but
    redundant). Needs the same `NEON_*` props the inline mirror uses (#16).
23. Ingest-failure watchdog (optional; `IngestWatchdog.gs`, dashboard).
    Defaults OFF. PUSHES the same staleness signal the Overview Pipeline
    Health banner / freshness pill show passively: a weekday-morning
    time trigger (`runIngestWatchdog_`) checks DQE freshness via the
    SAME `computeOverviewPipelineFreshness_` (OVERVIEW_PIPELINE_STALE_HOURS
    = 36h) and emails `getAdminEmails_()` when no fresh DQE build has
    landed -- i.e. the daily import or DQE rebuild silently didn't run.
    Enable by running `installIngestWatchdogTrigger()` from the dashboard
    editor (admin; sets `INGEST_WATCHDOG_ENABLED=true` + installs the
    trigger); `uninstallIngestWatchdogTrigger()` reverses it. Emails ONCE
    per stale episode (re-arms on the next fresh build; OPS-1: the episode
    flag arms only on a CONFIRMED send, so a mail-quota failure retries
    next run instead of silencing the episode), skips weekends AND company
    holidays, credits 24h of staleness allowance per weekend/holiday day
    inside the gap (OPS-7 -- a zero-activity holiday's expected rows:0
    build can't false-alarm the next morning), and treats a null freshness
    read as inconclusive (no false alarm).
    Tunable Script Properties: `INGEST_WATCHDOG_HOUR` (0-23, default 10
    Central) and `INGEST_WATCHDOG_STALE_HOURS` (default 36). Reuses
    `script.scriptapp` + `script.send_mail` (no new scope); best-effort
    (never throws). Complements the passive banner (#11) -- the banner is
    pull, this is push.
24. Escalations notification + activity-trail migration (optional;
    `Escalations.gs`, dashboard; INV-55). (a) **`NOTIFY_ON_NEW_ESCALATION`
    Script Property** -- set to `'true'` to email the dept's managers
    (`lookupDeptManagers_`, Access Control rows) on every new escalation.
    Defaults OFF. The email carries FULL escalation detail (caller / patient /
    Trx / reason) -- a PII surface -- so leave it off until that's signed off.
    Best-effort (never blocks/fails the create); needs `script.send_mail`
    (already present) + `DASHBOARD_URL` for the deep link. (b) **§5 activity
    trail**: the `escalation_activity` table is auto-created on first write
    (no setup() change). After deploying, run the admin editor function
    `backfillEscalationActivity()` ONCE to seed `created`/`resolved` rows for
    escalations logged before the trail existed (idempotent, safe to re-run);
    otherwise their Activity timelines render only events that happen post-deploy.
25. `CONFIG_SOURCE` Script Property (dashboard) -- the C2 Dept Config
    read+write source switch read by `getConfigSource_()`. Unset / `sheet`
    (default) = Dept Config is read+written on the `Dept Config` SHEET as
    always (byte-identical to pre-C2). `neon` flips `readDeptConfigRows_` to
    read the Neon `dept_config` table (one `json_agg` fetch, falls back to the
    sheet on any error/unreachable) AND routes `saveDeptConfig`/`removeDeptConfig`
    writes to that table (`neonUpsertDeptConfigRow_` / `neonDeactivateDeptConfig_`;
    list cols stored as the same comma-joined text so `dcParseList_` parity is
    exact). **Only flip to `neon` after `backfillDeptConfigToNeon()` (editor-run,
    admin) copies the sheet rows AND `compareDeptConfigSources()` reports parity
    clean.** Reversible with no redeploy (set back to `sheet`); to revert
    cleanly after edits were made in Neon, copy them back to the sheet first.
    `dept_config` is created lazily (`CREATE TABLE IF NOT EXISTS`, no setup()
    change). Parity pinned by `tests/unit/dept-config-neon.test.js`. Needs the
    dashboard `NEON_*` props + `script.external_request` scope. (First of the
    config-sheets-to-Neon migration, `docs/ui-infra-roadmap.md` Track C.)
    **C3 extends the SAME flag to Alert Config + Digest Config readers**
    (`readAlertConfig_` / `readDigestConfig_` now pull rows from
    `alert_config` / `digest_config` when `CONFIG_SOURCE=neon`, identical
    parse, sheet fallback on error; backfills `backfillAlertConfigToNeon()` /
    `backfillDigestConfigToNeon()` + parity `compareAlertConfigSources()` /
    `compareDigestConfigSources()`; pinned by `tests/unit/config-neon-c3.test.js`).
    **C3 edit UIs SHIPPED:** the Alerts modal now has admin edit forms for both
    Alert Config (per-dept threshold/recipients/skip-dates, key=department) and
    Digest Config (subscribers, key=(email,department)) -- `saveAlertConfigRow` /
    `removeAlertConfigRow` (Alerts.gs) + `saveDigestConfigRow` /
    `removeDigestConfigRow` (Digest.gs), each writing the ACTIVE source. So C3
    is now flippable: backfill (`backfillAlertConfigToNeon` /
    `backfillDigestConfigToNeon`) -> compare (`compareAlertConfigSources` /
    `compareDigestConfigSources`) clean -> set `CONFIG_SOURCE=neon`. (One flag
    governs Dept + Alert + Digest config sources together.) All three compare gates (Alert, Digest, and -- since CORE-5 -- Dept Config) read Neon DIRECTLY and return `clean:false` + an `error` when Neon is unreachable, so a Neon outage (even against an empty sheet) can never print a false "PARITY CLEAN" (F-5/CORE-5); never flip the flag on a result that carries `error`. Access Control is
    deliberately NOT in this flag -- it stays sheet-backed (auth availability),
    managed by the C1 editor.
26. Direct-call history backfill (cdr-import; only relevant if you want Direct
    history for past dates rather than going-forward-only). The bulk-backfill
    path (`bulkHistoricalUpdate`) now builds `Direct Call History` per date with
    the Neon mirror DEFERRED (`skipNeon`), exactly like DQE. **After a bulk
    rebuild, run `backfillDirectCallToNeon()` from the CDR Import editor** to
    mirror those dates to `direct_call_history` (`ON CONFLICT DO UPDATE`); the
    bulk-complete alert reminds you. Tunable Script Properties (cdr-import):
    `DIRECT_UPSERT_RESUME` (resume index; clear to re-run from the top) and
    `DIRECT_UPSERT_SINCE` (YYYY-MM-DD date floor, so you mirror only the
    recently-rebuilt dates). Idempotent (re-run safe); reuses the same `NEON_*`
    props the inline mirror uses (#16). The daily import already mirrors Direct
    inline, so this is ONLY for the bulk path. Recommended only after the busy
    carve-out numbers are spot-checked (the report stays admin-only while
    vetted, and this writes Direct history across all backfilled dates).
27. `COMPANY_HOLIDAYS` Script Property (dashboard) -- the S5 global
    holiday list (comma-separated ISO dates and/or `YYYY-MM-DD..YYYY-MM-DD`
    inclusive ranges; same tolerant grammar as the Alert Config Skip Dates
    cell). Feeds: INV-35 working-day counts (CR + Insights length-mismatch,
    server AND the client form hints via `window.__COMPANY_HOLIDAYS__`),
    the daily alerts + daily digest trigger runs (skipped on a holiday,
    like weekends), the previous-business-day walk-back
    (`prevBusinessDayIso_` -- the Tuesday after a Monday holiday assesses /
    covers Friday), AND (R11-L) the OVERVIEW CHART AXES -- `trendIsoLabels`
    + `ovWeekdayIsoLabels_` drop weekday holidays like weekends via
    `isCompanyHoliday_`, so a weekday holiday no longer draws a false dip
    in the dept sparklines/arrows + the trend chart (no cache bump; unset
    property = no dates dropped). Unset = no holidays = pre-S5 behavior. Maintain it
    yearly (e.g. `2026-01-01, 2026-05-25, 2026-07-03, 2026-11-26..2026-11-27,
    2026-12-25`); it is GLOBAL -- per-dept exceptions stay in Alert Config
    Skip Dates. No redeploy needed to edit.
28. Neon backup (optional but recommended; `NeonBackup.gs`, dashboard).
    Weekly Drive export of the tables with NO sheet fallback --
    `escalations`, `escalation_activity`, `inbound_calls` (incl. journey
    JSON) -- as one-JSON-object-per-line files: a full escalations
    snapshot per run (newest `NEON_BACKUP_KEEP`=8 kept) + monthly
    partition files for the other two (closed months written once,
    current month rewritten). Enable from the Health modal's **Neon
    backup** section (or `installNeonBackupTrigger()` -- Saturdays at
    `NEON_BACKUP_HOUR`=6 Central); "Back up now" seeds the folder. The
    Drive folder is auto-created ("Dashboard Neon Backups") and its id
    persisted to `NEON_BACKUP_FOLDER_ID`. REQUIRES THE NEW
    `https://www.googleapis.com/auth/drive` OAuth scope added to
    appsscript.json -- after deploying, Run any function once in the
    editor to consent (per #9). Fetches use one string_agg round-trip
    per WINDOW (never per-row JDBC); OPS-4: months are fetched in
    ~week-sized windows so no single JDBC string carries a whole month
    of journey rows, and a month over the ~8MB file budget is written
    as `<table>-<ym>.partN.jsonl` files (a parts-month counts as
    closed). OPS-5: when `CONFIG_SOURCE=neon`, the run also snapshots
    the then-Neon-authoritative `dept_config` / `alert_config` /
    `digest_config` as `<table>-latest.jsonl` (skipped while config is
    sheet-backed -- the sheet is the backup then). Last outcome
    surfaces on the Health page (`NEON_BACKUP_LAST_RESULT`).

29. Retired server files must be deleted in the Apps Script WEB EDITOR
    (INV-17: `clasp push -f` never deletes remote files). After deploying
    the consolidation commits, remove `PerformanceReport.gs` and
    `CompareRangesReport.gs` from the Department Dashboard project in the
    web editor -- until then their dead endpoints (`getPerformanceReport`,
    `getCompareRanges`, ...) remain callable (same auth gates as before;
    harmless but stale). The retired QCD / Missed surfaces were in-file
    edits, so no other files need manual deletion.
    **This is now DETECTED rather than remembered (Batch 4):**
    `scripts/deploy.sh` runs `node scripts/check-remote-orphans.mjs <dir>`
    before every push, which pulls the project into a throwaway temp dir and
    names any remote file with no local counterpart (matching `.gs` against the
    `.js` clasp pull writes). It warns by default and skips cleanly when clasp
    isn't authenticated; `STRICT_ORPHANS=1` makes it fatal. Run it standalone
    any time to check whether this item is still open.
30. `QCD_READ_SOURCE` Script Property (dashboard) -- the #3 Neon read-back
    switch for QCD, read by `getQcdReadSource_()` (QCDReport.gs). Unset /
    `sheet` (default) = `computeQcdReport_` reads the whole `QCD Historical
    Data` sheet as always (byte-identical to pre-#3); `neon` flips it to a
    WINDOWED read of `qcd_history` via `neonFetchQcdGrid_` -- a sheet-shaped
    grid adapter (the missedGridsFromDal_ pattern) so the compute loop +
    `computeMtdViolations_` are unchanged, and a one-day all-dept report scans
    ~days of rows per dept instead of all history (the windowed read is
    order-independent, unlike a sheet tail-scan). Reversible with no redeploy
    (set back to `sheet`); every path falls back to the sheet on any Neon
    error/unreachable. Independent of `DQE_READ_SOURCE` (QCD is a separate
    mirror). SET `QCD_PARITY_FROM`/`QCD_PARITY_TO` before running the gate --
    the in-source default is a fixed week that ages out, and an empty range is
    now reported as INCONCLUSIVE rather than clean (see #19's gate contract).
    **Only flip to `neon` after `runQcdParityCheck` (editor-run
    wrapper for `compareQcdSources_`, QCDReport.gs -- reads the optional
    `QCD_PARITY_FROM`/`QCD_PARITY_TO` Script Properties for its range) reports
    parity-CLEAN over a representative range AND `qcd_history` is fully
    mirrored** (the daily import mirrors QCD authoritatively per-date; a bulk
    QCD backfill is force-mode, so re-import fills gaps). The gate holds
    counts/violations EXACT but IGNORES ±1s diffs on the two duration
    fields (avgAnswer/longestWait), reporting them separately -- write-time
    `Math.round(serial*86400)` and Sheets' display formatter round a
    half-second average to different sides of the boundary,
    deterministically, so that noise is not drift and a re-import can't
    clear it (R5; pinned by qcd-report.test.js). The Health page
    surfaces a **QCD read source** row + a **QCD→Neon mirror** health row
    (`computeQcdMirrorHealth_`, sheet vs `qcd_history` `MAX(call_date)`) so a
    stale mirror is visible before you flip. **Coverage (R-1, fixed): ALL QCD
    surfaces honor the flag now** -- the `computeQcdReport_` consumers
    (Insights Queue health + the all-dept `qcdAll` report) AND the three
    formerly sheet-hardwired readers: the Overview per-dept QCD chips
    (`computeQcdSnapshots_`, windowed neon read = min(sinceIso, mtdStart)..
    today -- exactly its in-loop filter), the My Department Queue Call Data
    snapshot (`computeDeptQcdSnapshot_`, window = range ∪ MTD ∪ a 180-day
    latest-day lookback; a dept whose newest QCD row is older than 180 days
    renders no panel on the neon path -- documented divergence), and the
    freshness pill's QCD component (`neonGetMaxQcdDate_`). Every one falls
    back to the sheet on any Neon miss; on the sheet path all QCD readers now
    share one whole-sheet read per request (`readQcdSheetData_` memo). Needs the
    dashboard `NEON_*` props + `script.external_request` scope; parity pinned
    by `tests/unit/qcd-report.test.js` (incl. the R-1 snapshot/max-date tests). NOTE (NEO-3): QCD reads do NOT feed the
    DQE-only `NEON_READ_LAST_ERROR` read-back health line -- a QCD miss logs
    and falls back silently.
31. Automated **Daily Call Queue Report** email (optional; `QueueReportEmail.gs`,
    dashboard). Emails the all-departments Daily Call Queue Report (the
    `getQcdAllDepartments` company-wide QCD snapshot) for the PREVIOUS WORKDAY,
    once each weekday morning, to an opt-in subscriber list -- but ONLY after
    that day's Raw Data has been imported and processed (the readiness gate:
    `queueReportQcdLatestIso_() >= targetDate`, since QCD is the last historical
    sheet the import writes). Enable from the Alerts modal's **Daily Call Queue
    Report** section (`installQueueReportTrigger` / `uninstallQueueReportTrigger`,
    admin) -- sets `QUEUE_REPORT_ENABLED=true` + installs `runDailyQueueReport_`
    (every 30 min). WHY POLL A WINDOW not a fixed hour: the import finishes at a
    variable time; the trigger polls a weekday-morning window
    (`QUEUE_REPORT_WINDOW_START_HOUR`=6 .. `QUEUE_REPORT_WINDOW_END_HOUR`=12
    Central) and sends ONCE as soon as the data has landed, deduped by the
    `QUEUE_REPORT_LAST_SENT` Script Property (target ISO); `QUEUE_REPORT_LAST_RESULT`
    surfaces the last outcome in the modal. The pure `queueReportGateDecision_`
    (disabled / outside-window / weekend / holiday / already-sent / not-ready /
    ready) is unit-pinned (`tests/unit/queue-report.test.js`); it skips weekends
    + `COMPANY_HOLIDAYS`. Subscribers are the `Queue Report Subscribers` sheet
    (`Email | Active | Notes`; created by setup(), INV-12) managed by the modal's
    admin-gated `saveQueueReportSubscriber` / `removeQueueReportSubscriber`
    (config write path per INV-01: assertAdmin_ + validation + LockService +
    Logger.log audit); "Send me a preview" (`sendQueueReportPreview`) emails the
    active admin regardless of the gate. Every subscriber gets the FULL all-dept
    report (company snapshot, no per-dept slice). Reuses the extracted
    `computeQcdAllDepartments_` (QCDReport.gs -- the pure compute split out of
    `getQcdAllDepartments` so the trigger has no Session user to feed its auth
    gate, the `computeDigestStats_` convention). Needs `script.send_mail` +
    `script.scriptapp` (both present); best-effort (a run failure emails admins
    via `notifyQueueReportFailure_` + records `FAILED` in LAST_RESULT, and the
    next poll retries). **Send-loop reliability (O-1/O-4/O-7):** sends are
    per-recipient isolated -- one malformed address / mid-list quota failure
    no longer aborts the loop. Partial success CLAIMS the `LAST_SENT` marker
    (delivered recipients are never re-blasted; failures are batched to admins
    via `notifyQueueReportSendFailures_` and NOT auto-retried); a TOTAL failure
    leaves the marker unset (`FAILED-ALL` in LAST_RESULT) so the next poll
    retries safely. The single-address preview still throws so the admin sees
    the error. Duplicate subscriber rows (hand-edited sheet) are deduped
    first-row-wins (`duplicateRow` flag + "⚠ duplicate" chip in the modal;
    Remove deletes all copies). A day whose data never lands before the window
    closes is flagged ONCE post-window (`queueReportFlagMissedDay_`:
    `QUEUE_REPORT_LAST_MISSED` property + a `MISSED <iso>` LAST_RESULT + one
    admin email; suppressed on fresh installs with no prior send) instead of
    being silently skipped -- it is NOT auto-retried after the window.
    Reversible: uninstall clears the flag + removes the
    trigger. Readiness reads the QCD SHEET max date (the authoritative import
    output) even when QCD reads are flipped to Neon -- so a lagging deferred
    mirror can't gate the send, though an extreme mirror lag could make the
    emailed report (which reads per `QCD_READ_SOURCE`) trail the sheet by a day.
    The send + the admin "Send me a preview" both compute through the shared
    `qcdAllDeptCachedData_` (QCDReport.gs), so a preview reuses the 6h-TTL
    `qcdAll` cache the web report warms (and warms it for the next web open)
    instead of paying the full cold all-departments compute each time.
    **Manual sends from the report modal (QV-4/5):** "Email me this report"
    (`sendQcdAllDeptEmail`, any signed-in viewer, caller-only, displayed
    range) never touches this engine's state; the admin-only "Send to
    subscribers…" (`sendQcdAllDeptToSubscribers`, single-day) CLAIMS
    `QUEUE_REPORT_LAST_SENT` when it delivers the gate's current target day
    (so the poll can't double-blast) and never writes
    `QUEUE_REPORT_LAST_RESULT` (that stays the trigger run's diagnostic --
    a manual send must not repaint the Health outcome row).
32. Pipeline-failure watchdog (optional; `PipelineWatch.gs`, dashboard).
    Defaults OFF. PUSHES the explicit Pipeline Health FAILURE signal that the
    System Health page ("Recent pipeline step failures") + the Overview
    Pipeline Health banner show passively: an hourly time trigger
    (`runPipelineWatch_`) scans the last `PIPELINE_WATCH_SCAN_ROWS` (=300)
    Pipeline Health rows for `status=failure` newer than a stored epoch-ms
    watermark (`PIPELINE_WATCH_LAST_TS`) and emails `getAdminEmails_()` a
    BATCHED digest of the new failures (`:DQE` / `:QCD:neon` mirror errors, a
    `buildDQE` throw, `neonMirror:gave-up`, ...). Complements the ingest-failure
    watchdog (#23): that one pushes STALENESS (no fresh DQE build at all), this
    one pushes explicit FAILURE rows (a step ran and errored). The FIRST run
    establishes a SILENT baseline (never blasts the historical backlog); each
    failure alerts at most once (the watermark advances past every examined
    row); a failed send leaves the watermark un-advanced so the same failures
    retry next run (the OPS-1 "arm only on a confirmed send" discipline).
    Enable by running `installPipelineWatchTrigger()` from the dashboard editor
    (admin; sets `PIPELINE_WATCH_ENABLED=true` + installs the trigger);
    `uninstallPipelineWatchTrigger()` reverses it. Tunable Script Property:
    `PIPELINE_WATCH_SCAN_ROWS` (default 300). Reuses `script.scriptapp` +
    `script.send_mail` (no new scope); best-effort (never throws). Surfaces on
    the Health page as a trigger service row + a "Pipeline watch -- last run"
    outcome. The pure `pipelineWatchScan_` is pinned by
    `tests/unit/pipeline-watch.test.js`, and (O-6) a tail read that comes back
    CLIPPED above the watermark widens x4 (bounded, the F-20 pattern; pure
    predicate `pipelineWatchTailClipped_`) so a >300-row retry storm can't
    permanently silence evicted failure rows. **Piggybacked ping (Gap #3):**
    `runPipelineWatch_` ALSO dispatches `escPendingReviewPing_` (Escalations.gs)
    on every hourly run, BEFORE its own early returns -- a COUNT-ONLY, PII-free
    admin email when new `pending_review` escalation submissions have appeared
    (team-tools INSERTs directly into Neon, so no dashboard event fires at
    submission time; this poll is the push complement to the worklist's
    "N awaiting review" chip). Gated by its OWN `NOTIFY_PENDING_REVIEW` Script
    Property ('true' to enable; default OFF -- and it only runs at all while
    the PipelineWatch trigger is installed). OPS-1 watermark
    (`ESC_REVIEW_PING_WATERMARK`): first run baselines silently, later runs
    email once per new batch and advance only on a confirmed send. The email
    carries count + dept names ONLY (never caller/patient/reason), so it
    composes safely with `NOTIFY_ON_NEW_ESCALATION` (the full-detail PII
    surface) staying off. Pinned by tests/unit/escalations-hardening.test.js.
    **R7 (G-1) aux signals:** each hourly run ALSO folds in two
    property-backed alerts (pure `pipelineWatchAuxDecide_`, pinned by
    pipeline-watch.test.js): a NeonBackup run whose `NEON_BACKUP_LAST_RESULT`
    isn't ok-prefixed (incl. 'skipped — unreachable'; once per run timestamp
    via `PIPELINE_WATCH_BACKUP_MARK`, re-arms on an ok run) and a Neon
    read-back failure streak (`NEON_READ_LAST_ERROR` count >=
    `PIPELINE_WATCH_READBACK_MIN_STREAK`=3; once per streak via
    `PIPELINE_WATCH_READBACK_MARK`, re-arms when the property clears). Both
    markers advance ONLY on a confirmed send (OPS-1); alerts fold into the
    failure digest or send standalone on the scan's early-return paths.
    They fire only while the PipelineWatch trigger is installed.
33. `DIAL_IN_LABELS` Script Property (dashboard; optional, R5) -- names the
    MAIN dial-in lines in the Inbound report's "By advertised line" table.
    Comma-separated `number = Label` pairs (e.g. `18668646332 = Main CSR
    Line, 19722281820 = Intake Line`); keys are digit-normalized, malformed
    tokens dropped silently (the Skip Dates grammar discipline), edits need
    no redeploy. Precedence per line: this map > the derived dominant
    first-rung agent (`inbound_calls.first_agent` -- populates going
    forward / on re-import) > the raw number. Agents' direct DIDs usually
    need no entry; only the shared/IVR main lines do.

34. `UI_FLAGS` Script Property (dashboard; optional, R7/G-3) -- admin
    UI-surface toggles. Comma-separated keys from the CURATED
    `Config.gs::UI_FLAG_SURFACES` registry (dept-team-strip,
    dept-queue-tiles, dept-missed-section, dept-qcd-side, ov-user-table,
    ins-heatmap, ins-queue-health, report-headlines -- R11-M, the answer-first
    summary banners); each listed key HIDES that surface for
    ALL viewers (presentation-only -- data/endpoints/caches unchanged) while
    it's being fixed or investigated. Managed from the Health page's
    **"UI surface toggles"** editor (`getUiFlags`/`saveUiFlags`,
    SystemHealth.gs -- assertAdmin_ + registry validation + LockService +
    Logger audit; empty set deletes the property); unknown keys are silently
    dropped (`uiFlagsSanitize_`, the Skip Dates grammar discipline).
    Injected as `window.__UI_FLAGS__` (renderDashboard_) -> stamped on
    `body[data-ui-flags]` -> enumerated `!important` CSS rules in
    styles.html (which beat the render paths' inline display), plus fetch
    gates so hidden sections don't still call the server. Changes apply on
    each viewer's NEXT page load -- no redeploy. Adding a surface = registry
    key + CSS rule + optional fetch gate.
35. Neon coverage check (optional but recommended; `NeonCoverage.gs`,
    dashboard; R7/G-2). Editor-run `runNeonCoverageCheck()` (admin,
    READ-ONLY) reconciles per-date row counts sheet-vs-Neon over
    `NEON_COVERAGE_DAYS` (default 30, ending yesterday) for `dqe_history`,
    `qcd_history`, `call_history_dept`, `direct_call_history` -- findings
    per date: missing-in-neon / count-mismatch / extra-in-neon (phantoms),
    each emailed with its runbook fix (force re-import /
    `backfillDQEHistoryUpsert` / `backfillCDRHistory` /
    `backfillDirectCallToNeon`) -- and flags zero-row WEEKDAYS on the two
    no-sheet-primary per-call tables, `inbound_calls` AND `outbound_calls`
    (holiday-aware, each floored at its own capture-start MIN(call_date);
    an outbound_calls table that doesn't exist yet -- the Option B capture
    not deployed -- is a clean skip, not a probe error; days past the
    ~14-day Call_Legs retention are unrecoverable, IMP-11).
    Outcome in `NEON_COVERAGE_LAST(_RESULT)` ('ok clean' / 'GAPS n
    finding(s)' / 'FAILED*'), surfaced as the Health page's "Neon coverage
    -- last check" row. Complements the MAX(call_date)-only mirror-health
    lines (#19/#30): those catch a LAGGING mirror; this catches INTERIOR
    gaps and count drift. Run after deploys that touched mirrors, or when
    a journey drill reports a 'date-gap'. It never writes -- remediation is
    always the existing idempotent re-import/backfill paths.
36. `EMAIL_ALIASES` Script Property (dashboard; optional, Tier C) -- maps
    sign-in alias addresses to a canonical identity so several Workspace
    addresses that route to one person resolve to the SAME role + departments.
    Comma/newline-separated `alias@x = canonical@x` pairs (tolerant grammar
    like `DIAL_IN_LABELS` / `COMPANY_HOLIDAYS`: a token missing `=`, with a
    non-email side, or mapping an address to itself is silently dropped;
    never throws). `resolveUser_` canonicalizes BEFORE the admin/manager
    lookup, so an alias inherits the canonical user's access and the returned
    identity is canonical. Unset = no aliasing. Gmail dot-normalization does
    NOT cover `john.doe`→`john` (different local parts), so the map is
    explicit. No redeploy to edit (memoized per request on the raw value).
    Also note (Tier C, same feature area, no property): a manager with
    MULTIPLE `Access Control` rows (same email, different dept) is a
    multi-department manager -- they get the header dept selector for their
    assigned subset; see the "Role model" gotcha. If a manager who should
    see several depts sees only one, check for a stale 60s auth cache or
    that all their rows share the exact same email.
37. `ANSWER_TARGETS` Script Property (dashboard; optional, R12-25) -- the
    admin-tunable answer-rate DISPLAY standards. Tolerant `key=value` pairs
    (`global=92, direct=80`; keys from `Config.gs::ANSWER_TARGET_SURFACES`:
    `global` / `direct` / `inbound`; unknown keys + out-of-range values
    silently dropped by `parseAnswerTargets_`). Unset = the seed 92%
    everywhere. Drives the benchmark tints (`benchValueCls_` via
    `answerTarget_(surface)`), the "On track / Watch" headline tones, the
    Overview chart baseline + team-strip target tick, the Insights calendar
    coloring, the Direct dept-card tone rail, the metric-glossary text, and
    the digest verdict pill -- display/tone layer ONLY, so no cache bump;
    injected as `window.__ANSWER_TARGETS__` at render, so viewers pick a
    change up on their NEXT page load (emails at their next send). Edit
    from the Alerts modal's **"Answer-rate standards"** section
    (`saveAnswerTargets` -- assertAdmin_ + loud validation + LockService +
    Logger audit; property-only, no sheet write). Deliberately NOT covered:
    the 5% abandon threshold (baked into written QCD Violations history,
    INV-50) and the per-dept ALERT thresholds (Alert Config, INV-34).
    Pinned by `tests/unit/answer-targets.test.js`.
38. **Diagnosing "a queue's inbound calls are missing" (F1/F1b runbook).**
    A queue whose raw name `icIsQueueName_` doesn't recognize gets
    `entry_queue = NULL` and attributes to NO dept. **Do NOT probe with
    `SELECT count(*) FROM inbound_calls WHERE entry_queue IS NULL AND
    disposition='abandoned'`** -- that count unions THREE causes and only one
    is a bug (measured at 9353 here, of which the real miss was tens of
    calls). `abandon_stage='queue'` implies `entry_queue` is non-NULL, so
    every NULL-entry abandon is either `'direct'` (caller dialed a DID, no
    queue -- legitimate), `'ivr'` from a genuine auto-attendant give-up
    (legitimate; R5 recorded this bucket at ~25% of calls), or `'ivr'` from an
    UNRECOGNIZED queue -- the bug, which lands in `'ivr'` precisely because a
    queue leg carries no `Departments` value (R5's own direct-vs-ivr
    discriminator). The DISCRIMINATING probe is a journey leg-name histogram,
    because `journey` stores RAW leg names even when `entry_queue` is NULL:
    ```sql
    SELECT ev->>'kind' AS kind, ev->>'name' AS leg_name,
           count(DISTINCT c.call_id) AS calls, max(c.call_date) AS last_seen
    FROM inbound_calls c
    CROSS JOIN LATERAL jsonb_array_elements(c.journey::jsonb) AS ev
    WHERE c.disposition='abandoned' AND c.entry_queue IS NULL
      AND c.abandon_stage='ivr' AND c.journey LIKE '[%'
    GROUP BY 1,2 ORDER BY calls DESC LIMIT 40;
    ```
    Read it against `DQE_EXCLUDED_AGENTS` (cdr-import/buildDQEHistoricalData.js)
    -- that list already enumerates every queue AND pseudo-agent/IVR-node name
    in this install, so it classifies the output for you: a real queue name
    there is a miss; an IVR prompt / brand intro / ad-routing name
    (`Introduction - New`, `Universal Dialysis Center`, `PAP Advt`, ...) is
    not. PERSON names in the `'ivr'` bucket are expected on rows imported
    before the R5 direct-split went live (`abandon_stage='direct'` first
    appears 2026-07-17 here) -- they heal on re-import, not a bug. Rows
    predating the journey extension carry `journey = NULL` and CANNOT be
    diagnosed this way. **Remedy:** for a brand-prefixed `*_A_Q_*` name the
    F1b pattern already covers it; anything else goes in the dept's Dept
    Config "Inbound queue aliases" field (no redeploy). Then re-import any
    affected dates still inside the ~14-day `Call_Legs` window to heal their
    `entry_queue`; older dates are unrecoverable. **A recognized queue still
    needs ATTRIBUTION:** `UDC_A_Q_Main` / `UUC_A_Q_Main` belong to separate
    brands with no dashboard dept, so they now surface in the discovery panel
    as unattributed until an owner maps them to a dept (or one is created).

39. **Sub-queue access widening (verify who gained what BEFORE deploying).**
    Since sub-queue Phase 0 a manager assigned to a PARENT department can also
    reach its one-level sub-queues, via the Overview parent map
    (`OVERVIEW_PARENT_OF` + Dept Config `Overview Parent`). This is the first
    time that map affects authorization rather than tile layout -- see INV-38.

    **It takes effect on deploy with NO admin edit**, because the shipped
    constant already contains `PAP -> Sales`, `PAP Q -> Sales`,
    `Spanish -> CSR`, `PAK -> Power`. So the moment this deploys: every Sales
    manager can see PAP, every CSR manager can see Spanish, every Power manager
    can see PAK -- agent-level data included.

    **CONFIRMED BY THE OWNER (2026-07), so this is no longer a question:**
    *"Managers of parent dept should have access to child queue data (including
    agents in that queue)."* All seeded pairings are intended, agent-level data
    included. Do NOT re-open this on the next read; if a FUTURE pairing should
    not confer access, that is a new decision about that pairing, not a
    reconsideration of the rule.

    The knob, if a specific pairing ever needs revoking: clear that dept's
    `Overview Parent` cell in Dept Config. Note it will also stop nesting on the
    Overview tile grid -- one cell, two meanings, which is the trade-off of
    reusing the existing map. Splitting them would need a second map in code.

    **When NOT to use this map: two INDEPENDENT queues that merely share a
    manager.** The `Overview Parent` cell does four things at once -- nests the
    Overview tile, turns on the My Department combined view + per-dept
    subtotals, folds the child's queues into the parent's QCD rollup
    (`queuesForDept_`), and confers access. If all you need is the last one, use
    **multiple `Access Control` rows with the same email** instead (Tier C
    multi-department manager -- the Access Control admin modal's dept picker is
    a multi-select). That grants per-dept data access with no relationship
    implied: both depts stay independent tiles, there is no switcher and no
    combined view, and nothing is rolled up. Using the parent map here would
    misrepresent the relationship in every rollup, not just the tile grid.

    **`Field Ops Power` is settled (owner, 2026-07) and is deliberately NOT in
    the parent map:** *"Field Ops Power isn't necessarily a child queue in the
    same way as the other child queues and should still be represented as a
    separate queue, but the same manager(s) should be able to see both Field Ops
    and Field Ops Power data."* So the action for this pair is TWO ACCESS
    CONTROL ROWS per shared manager, not a Dept Config edit. Do not "finish" the
    parent map by adding it. (Related, and also settled: the two
    `Field Operations (...)` labels stay UNMAPPED in Final Dept Labels -- see
    item 14.)

    Admins and all-departments managers are unaffected (they already hold every
    dept). A department with no children is unaffected -- 11 of 14 here.

40. **Per-queue split backfill -- a ONE-TIME step whose window CLOSES (do this
    right after deploying sub-queue Phase 1).**

    The DQE per-queue breakdown (col AI / `dqe_history.queue_split`) is computed
    from `Call_Legs_*`, and `DeleteOldSheets.js` prunes those sheets at **14
    days**. The per-leg queue identity exists nowhere else, so:

    > **Any date not rebuilt inside that 14-day window can NEVER be split.**

    There is no repair for it later -- not a backfill, not a re-import, not a
    Neon fix. Phase 2 falls back to all-queue figures for those dates and says
    so in the UI, which is correct behavior but permanent.

    **Order matters.** Deploy `cdr-import` and `cdr-report` FIRST, let one build
    run, then force a re-import for each surviving date (the normal force
    re-import path -- the build rewrites that date's rows with the split). Only
    then deploy the dashboard, though deploying it early is harmless: every row
    fails open to the rollup until splits exist.

    **Verify:** `DQE Historical Data` should be 35 columns wide with JSON in col
    AI (e.g. `{"A_Q_CSR":{"u":5,...}}`), and `dqe_history` should have a
    `queue_split` column. The build widens the sheet itself -- Sheets does not
    auto-expand columns -- so a 34-wide sheet after a successful build means the
    build did not actually run against it.

    **No new Script Property or trigger.** This item exists purely because the
    step EXPIRES. Nothing in the code will tell you that you missed it: the
    dashboard looks correct while quietly serving all-queue numbers for every
    date you did not reach.

41. **"A department's totals changed after a re-import" -- the queue-split
    attribution audit.**

    Expected after sub-queue Phase 2: a dept that shares agents with another
    dept SHOULD drop, because it stopped counting the other dept's calls. What
    is NOT expected is volume vanishing from every dept at once.

    Phase 2 fails OPEN on an unmapped DEPARTMENT (it keeps the all-queue
    rollup), but **NOT on an unmapped QUEUE inside an otherwise-mapped dept** --
    those calls are narrowed out of that dept and land nowhere. From the
    dashboard the two look identical: a number went down.

    **Run `auditQueueSplitAttribution()`** (dashboard project, editor,
    admin-gated, read-only; optional `QUEUE_SPLIT_AUDIT_DATE` = YYYY-MM-DD,
    default = the latest date in DQE Historical Data). It prints every queue in
    that date's split, which dept claims it, each dept's narrowed totals, and a
    reconciliation ending in one of two verdicts:

    - *"Every queue is claimed by exactly one dept, so no volume was dropped"* --
      the de-duplication worked; the fall is the fix.
    - *"CLAIMED BY NO DEPT"* rows plus a dropped rung/answered tally -- that is
      the missing volume. It also names the depts whose roster agents worked the
      orphan queue, which is almost always the row that needs editing.

    **Fix:** add the RAW queue name exactly as printed to that dept's
    **Inbound queue aliases** in Dept Config (the QCD Queues field takes only
    CANONICAL names seen in QCD col D, which is why a raw name like `A_Q_CSR`
    or `A_Q_Intake` belongs in the aliases column). No redeploy; effective on
    the next request.

    It also flags a queue claimed by TWO depts (double-counted) and a dept whose
    mapped names appear nowhere in the split (a raw-vs-canonical mismatch).
