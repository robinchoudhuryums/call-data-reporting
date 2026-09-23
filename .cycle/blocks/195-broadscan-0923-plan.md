# Broad scan 2026-09-23 — findings + batch plan (HEAD ed98956)

Record of the `/broad-scan` run on 2026-09-23 so later `/broad-implement Batch N`
sessions have the scope without the chat. IDs: `ING-#` = cdr-import,
`CRT-#` = cdr-report (renamed to avoid the older `IMP-#`/`RPT-#` fix codes),
`ENG-#` engines, `DATA-#` dashboard data layer, `SEC-#`, `PCR-#` per-call
reports, `UI-#`, `DOC-#`, `S2A/S2B/S2C-#` Stage-2 deep dives.
Dashboard files are under apps-script/department-dashboard/.

Owner rulings (2026-09-23): SEC-5 -> switch to DEFAULT (nothing embeds the app).
SEC-6 -> ACCEPTED (PHI in Script Properties stays in Workspace; Apps Script is
HIPAA Included Functionality) -- docs note only.

## Batch 1 — durability + the answer-rate flip blocker — SHIPPED (block 195)
ENG-1, S2A-1 (missed half), ENG-2, ENG-11.

## Batch 2 — access & auth — SHIPPED (block 196)
- S2B-1 Med: `saveAccessControlRow` replace-all (Auth.gs:574-593) deletes ALL rows for the email; "Add agent" on a manager deletes their manager rows -> lockout (AGENT_ROLE off). Fix: role-scoped replace + confirm; remove-agent must not delete manager rows.
- S2B-2 Med: uncached auth reads wait 10 s on the project-wide script lock (Auth.gs:229-236, A-6); the 8 AM alerts run holds it across compute+send; unlocked reads are not cached so every RPC pays. Fix: CacheService save-in-flight marker instead of the lock.
- SEC-1 Med: no max date range on getDepartmentSummary (Data.gs:811), IR, Insights, Missed, QCD, getAgentHome (AgentHome.gs:211; journey pull ~:330 has no LIMIT) -> R24-class Neon egress. Fix: shared max-range assert (~400d; tighter for agents).
- SEC-3 Low: `sendIndividualReportEmail` gate is `role === 'none'` (IndividualReport.gs:953) -> use assertManagerOrAdmin_.
- S2B-6 Low: Access Control row saved under an EMAIL_ALIASES alias never matches (resolveUser_ canonicalizes first); welcome email says live. Canonicalize on save.
- SEC-5 Low (ruled): Code.gs:90/209/218 ALLOWALL -> DEFAULT; CLAUDE.md line.

## Batch 3 — pipeline sibling-fix drift — SHIPPED (block 197; S2C-1's agentBusy half deferred)
- ING-1 Med: `buildDirectCallFromRaw_` (cdr-import/directCallMetrics.js:716-741) dates the day from the FIRST row; P-7 fixed this for DQE only -> a D-1 carry-over first row makes Direct refuse the date on every re-run.
- S2C-1 Med: inboundCalls.js `firstAgent` loop (:527-535) doesn't skip external-callee legs -> stores a caller's raw CNAM (IMP-12/P-11 bypass) and misattributes; `agentBusy` keys on customer digits. Fix + SQL audit/re-mask of existing rows.
- S2C-3 Low-Med: Direct engine never drops other-day legs (dcStartSec_ time-of-day only) -> inflates activity, excuses missed rings as missed_busy.
- ING-2 Med-Low: force re-import runs inline CDR/QCD Neon mirrors AFTER the five-sheet delete, BEFORE the QPath/QCD/CSR/DQE rewrites (autoImport.js ~541-572 vs ~2000/2127); a hung connect killed at the ceiling loses those dates silently.
- S2C-4 Low: `icSqlStr_` (inboundCalls.js:262) doesn't strip NUL.
- ING-6 Low: `backfillOutboundCalls` ignores IC_BACKFILL_TIME_LIMIT_MS (outboundCalls.js:389).
- ING-7 Low: `repairCsrTransferForRawDataDate` first-row date + no lock/snapshot (autoImport.js:3716/3759).

## Batch 4 — silent degradation & observability — SHIPPED (block 198)
- ENG-3 Med: daily alerts have no DQE-readiness gate (Alerts.gs:558-568, 8 AM); late data -> all depts `no-data`, outcome `ok`. Reuse the digest R31 gate + retry.
- DATA-2 Med: Missed (MissedCallsReport.gs:112-121/242-245), IR (IndividualReport.gs:229-240), picker (Util.gs:773) cache despite deptConfigReadFailed_.
- DATA-3 Low-Med: computeCsrTransferRange_ catch -> null == "no rows" (Data.gs:1689); Insights prior Queue-health (InsightsReport.gs:861); both cached 6h.
- S2A-3 Low-Med: getAgentHome/getAgentHistory cache outage/config-degraded payloads (AgentHome.gs:236-277, 459-469).
- ENG-5 Low-Med: digest/queue-report Health rows have no staleness allowance (SystemHealth.gs:734-749); killed runs stay green.
- ENG-6 Low-Med: appEmailBcc_ (Config.gs:91-110) unvalidated -> one EMAIL_BCC typo breaks every send.
- DATA-7 Low: pipelineFreshness.isStale frozen in the 6h Overview blob (CompanyOverview.gs:1225).
- ING-3 Low: bulk archive CDR/QCD mirror skip is console-only (autoImport.js:1292-1331).
- CRT-6 Low: any *_RESUME pointer defers the nightly sort for ALL sheets indefinitely (sheetRepairs.js:1472-1483).
- ENG-7 Low: coaching "ok ... EMAIL NOT SENT" classified healthy.
- ENG-8 Low: manual queue-report send reports partial/failed as "0 subscribers" (QueueReportEmail.gs:1454, script-11:150).

## Batch 5 — cdr-report repair/export hardening (~7h)
- CRT-1 Med: ic_/oc_removeRowsInRange_ getValues->setValues round trip re-arms apostrophe-neutralized formulas daily (only Call Start is '@'); the R8-3 mechanism.
- CRT-7 Low: bulk repairs write back without F-22-style re-verify.
- CRT-3 Low: duplicate merge re-sums byte-identical token-less duplicates (sheetRepairs.js:783-794).
- CRT-4 Low: DQE upsert overwrites Neon abandoned ids/slots with #REBUILD/NULL (neonbackfill.js:595-613).
- S2B-7 Low: formula-leading names written back raw (OrphanFix sanitizeAgentName_ :863, col C :587; DeptConfig teamAvgExcludes :1025).
- CRT-5 Low: HR_BACKUP_KEEP_=3 < repair chain; no-op slot repair still snapshots.
- CRT-8 Low: findDqeDuplicateRows writes names without crSheetSafeCell_ (neonbackfill.js:731-742).

## Batch 6 — per-call report attribution (~8h)
- PCR-1 Med: inboundQueuesForDept_ (InboundReport.gs:156-175) omits CHILD depts' raw inbound aliases (contradicts CLAUDE.md "parent covers sub-queues").
- PCR-2 Low: on-hold arm label list is parent-only (InboundReport.gs:212-245).
- SEC-7 Low: journey sheet fallback returns miss reason before auth + `insurer` (InboundReport.gs:858-913).
- PCR-3 Low: outbound pendingTail off-by-one + UTC current_date vs script TZ (OutboundReport.gs:419/3838).
- PCR-9 Low: outbound vetting Leg A accepts a sheet-fallback payload (OutboundReport.gs:893-896).
- PCR-5 Low: AgentDay LIMIT before exact-name filter -> truncated wrong (AgentDay.gs:341, 442-452).
- PCR-8 Low: escalation outage snapshot force-refreshed only after delete.

## Batch 7 — client UI layering & races (~9h)
UI-1 Escape on a stacked layer closes the report modal (script-5:629, script-4:1010, script-2:968 vs script-9:39); UI-2 Help drops outer modal trap (script-2:947-967); UI-3 view-as YTD Company line (script-3 ovYtdData + ovStripChartTrend_ ignores viewAsDept); UI-4 Escalations init failure spinner/no retry/no beacon (script-10:103-162); UI-5/6/7/11 stale-response races (script-9:2072, :410; script-10:1828; script-7:2890/2983); UI-9 focusable rows w/o aria-expanded; UI-8 placeholder-only labels (script-7:1697/1698/2963, script-8:4530).

## Batch 8 — engines & admin write hygiene (~11.5h)
S2B-3 orphan rename unprobed Neon before audit append; S2B-4 failed Neon rename not retryable; PCR-7 coaching delivery no lock / no status guard; SEC-2 no per-user email throttle; S2B-8 queue-report manual vs poll double-send; ENG-4 alerts per-date marker; SEC-4 LOGIN_NOTIFY_SEEN > 9KB at ~165 addrs (Auth.gs:729/847); ING-5 importer empty sheet + prune vs recovery; S2A-5 digest stale-note wording/previews; S2A-4 CacheWarm Insights warms the wrong key; ENG-10 CacheWarm queue key on Mondays.

## Batch 9 — performance & chart edges (~5h)
DATA-5 computeSummary_ unmemoized per-dept span (Data.gs:1140); DATA-6 orphan nag whole-sheet read per Overview miss (OrphanFix.gs:471); S2A-2 Company line only 30 days on 60/90-day views (CompanyOverview.gs:538 vs 910); DATA-8 Feb-29 trend start (Util.gs:228).

## Batch 10 — docs (~5h)
DOC-1 INV-01 carve-out list incomplete; DOC-2 conventions.md:283 old access model; DOC-3 "cannot be backfilled" (INV-10, Config.gs); DOC-4 30-min/5-min cache claims; DOC-7 OVERVIEW_PARENT_OF "Overview-only" comment; DOC-5/6/8/9/10/11/12/13/14/15 stale counts/comments (see scan); + SEC-6 accepted-PHI note (ESC_SNAPSHOT_*).

## Batch 11 — flag-flip prerequisites (~6h+)
S2B-5 CONFIG_SOURCE=neon: cdr-import capture reads the sheet only (inboundCalls.js:860); DATA-1 B-1 fall-open on divergent row sets (Data.gs:503/572); CRT-2 merge + upsert stale queue_split; S2A-1 queue-split half (digest WoW never narrows).

## Deferred
S2C-2 (final_dept = first answering leg; needs owner ruling), S2C-5 (Direct dedupe per CALL_ID; needs live data), ING-4 (older Call_Legs sheet never processed; confirm arrival pattern), DATA-4 (roster hash on missed/IR/insights keys; already tracked as D-4).
