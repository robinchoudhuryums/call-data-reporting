---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ENG-1 — The Neon backup froze each closed month at its last IN-month Saturday run, so the tail days were never backed up; a closed month is now final only once written >= 3 days after it closed, and pre-fix months get a lossless .tail.jsonl supplement.
- ENG-2 — The retention prune ran regardless of backup health; the per-call (no-sheet-primary) steps are now held unless the backup ran clean in the last 15 days.
- S2A-1 — The digest week-over-week callout omitted `missed`, so under ANSWER_RATE_FORMULA=answerable every digest said "no notable shift"; the digest now accumulates `missed` (the queue-split narrowing half is deferred, see follow-ons).
- ENG-11 — Health hint + NeonRetention header said history is kept 13 months; it is 25 (OD-4).
Files modified:
- apps-script/department-dashboard/NeonBackup.gs
- apps-script/department-dashboard/NeonRetention.gs
- apps-script/department-dashboard/Digest.gs
- apps-script/department-dashboard/SystemHealth.gs
- apps-script/department-dashboard/Config.gs
- tests/unit/neon-backup.test.js (new)
- tests/unit/neon-retention.test.js
- tests/unit/digest-wow.test.js
- tests/README.md
- docs/module-dependencies.md (regenerated)
- docs/operator-state.md (#28, #57)
- docs/fix-history.md

CHANGES:
ENG-1 | NeonBackup.gs, NeonRetention.gs (header), neon-backup.test.js | New pure `nbClosedMonthAction_` (write / skip / rewrite / tail) + helpers `nbAddDaysIso_`, `nbJourneyDays_`, `nbMonthMainFile_`, `nbFileUpdatedIso_`, `nbWriteMonthTail_`; constant `NB_FINAL_GRACE_DAYS_`=3. A closed month is skipped only when its Drive file was last updated >= month-end + 3 days. Otherwise it is fully rewritten if every row is still inside the retention journey horizon (2-day slack), else a `<table>-<ym>.tail.jsonl` of rows after the file's last row is written. An unreadable last row FAILS the table. A full (re)write trashes any stale tail. The outcome string adds "N closed-month tail(s) written". Bite-checked: all 6 new tests fail on the old code.
ENG-2 | NeonRetention.gs, Config.gs (PROP_REGISTRY_), neon-retention.test.js | New `neonRetentionBackupGate_` + `NEON_RETENTION_PERCALL_TABLES_` / `NEON_RETENTION_BACKUP_MAX_AGE_MS_` (15 d). `neonRetentionRun_` drops the inbound_calls/outbound_calls steps when the gate holds; the dqe/qcd steps still run. Outcome: `PARTIAL per-call prune HELD -- <reason> ...` (Health reads it bad; no email). New operator property `NEON_RETENTION_WITHOUT_BACKUP` (registered). The existing tests' `runWith` fixture now carries a healthy backup by default (the old fixture encoded "prune never looks at the backup").
S2A-1 | Digest.gs, digest-wow.test.js | `computeDigestWowDriver_`'s trendByDate now carries `missed` (the field CompanyOverview got in DD-2). New test pins the WoW under both formulas with rung != answered+missed; bite-checked against the old code.
ENG-11 | SystemHealth.gs, NeonRetention.gs | "13 months" -> "25 months (OD-4)"; the Health hint also names the ENG-2 backup gate.

TEST RESULTS: passed — `node --test` 1794/1794 (TZ=America/Chicago, as CI); `check-duplicated-files.sh` clean; `module-deps --check` clean after `--write`; `CI=1 npm run lint:gas` clean (75 files). `npm run ci:ui` not run (playwright not installed here; no client file changed).
REGRESSION RISKS:
- ENG-1 first run after deploy is heavier than a normal Saturday: it rewrites every closed month still inside the journey horizon (~2-3 months x 3 tables of Neon reads) and writes a tail for every older month (reads each legacy month file from Drive + a small Neon fetch). There is no time budget in the backup; a run killed at the execution ceiling records nothing, but progress persists (written tails and rewritten months are final), so the next run continues. Operator: run "Back up now" once after deploying and read the result.
- ENG-1 steady state: the previous month is re-read by the first one or two Saturdays of each new month (egress +1-2 month reads/month).
- ENG-2: an install with retention enabled but no (healthy) backup stops pruning inbound_calls/outbound_calls — per-call storage grows until the backup is fixed or the opt-out is set. Deliberate; surfaced as PARTIAL on the Health row.
- S2A-1: none under the default `rung` formula (computeWowDelta_ reads `missed` only via answerRatePct_, which ignores it under `rung`).
INVARIANTS AT RISK: None. (INV-01: no public write path added; INV-30: the digest WoW is not cached; INV-48: driver semantics unchanged; INV-45: digest schema unchanged.)
NET SCORE: 1 − 1 = 0 (ENG-1 fired in production whenever the backup trigger was armed; S2A-1 fires only once ANSWER_RATE_FORMULA=answerable is set — imminent, not yet; ENG-2/ENG-11 did not fire. New failure mode: ENG-2's deliberate prune hold, documented in Operator State #57.)

OPERATOR ACTIONS / DEPLOY:
- After deploying the dashboard, run "Back up now" (Health -> Neon backup, or `runNeonBackupNow()`) once and confirm the result starts `ok` and names any closed-month tails written | BLOCKS DEPLOY: N
- If the Neon backup trigger is NOT installed but retention is, either install the backup (#28) or set `NEON_RETENTION_WITHOUT_BACKUP=true` — otherwise the next Sunday prune reads PARTIAL and stops pruning the per-call tables | BLOCKS DEPLOY: N
- `ANSWER_RATE_FORMULA=answerable` (#69) is now safe for the digest WoW callout once this deploy is live | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or `scripts/deploy.sh .`), then Deploy → Manage deployments → New version

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- S2A-1 second half: `computeDigestWowDriver_` never calls the queue-split narrowing, so under QUEUE_SPLIT_SCOPE=dept the digest callout stays all-queue while its tiles narrow. Needs the sheet path to read col AI / DAL-shaped rows — add to Batch 11 (flip prerequisites).
- ENG-1 has no automated restore check; the broad scan's completeness gap #1 (a backup verifier comparing Drive month files to Neon row counts) would have caught ENG-1 without a code read.
- Remaining broad-scan batches 2-11 (see the 2026-09-23 scan in the session log / STATE.md).

DOCUMENTATION UPDATES NEEDED:
- Done in this change: Operator State #28 (finalization rule, tail files, restore) and #57 (ENG-2 hold + opt-out); fix-history entries; tests/README.md map.
- None outstanding for Batch 1. (CLAUDE.md unchanged: its Operator State index line for #57 still reads correctly.)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
