---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- QO-2 -- a QCD violation is 4.00% OR MORE (owner ruling 2026-10-02): pipeline writers + a date-gated history repair
- DX-11 -- conventions.md: the source is Pacific LOCAL time (owner confirmed a 2 h gap during DST), so the fixed +2 h is right all year
- PC-12 -- a parent dept's Outbound agent table covers its one-level sub-queue rosters, grouped per dept
- AC-2 -- "Email to agent": the server enforces one agent and writes the agent's figures itself (option B)

Files modified:
- apps-script/cdr-import/autoImport.js
- apps-script/cdr-report/sheetRepairs.js, apps-script/cdr-report/neonbackfill.js (comment)
- apps-script/department-dashboard/OutboundReport.gs, IndividualReport.gs, script-6-ir.html, script-9-inbound-direct.html, styles.html
- tools/ui-harness/build-harness.js, tools/ui-harness/drive-admin.js
- tests/unit/qcd-violation-rule.test.js (new), tests/unit/sheet-repairs-backup.test.js, tests/unit/outbound-report.test.js, tests/unit/ir-send-to-agent.test.js, tests/README.md
- CLAUDE.md, docs/conventions.md, docs/invariants.md, docs/per-call-capture.md, docs/architecture.md, docs/client-ui-conventions.md, docs/module-dependencies.md (regenerated), docs/next-steps.md

CHANGES:
QO-2 | cdr-import/autoImport.js | New qcdViolationFlag_(total, abandoned): 1 when abandoned*10000 >= total*400 (basis points, integers -- float rounding can never decide a boundary row). Both QCD writers (bulk Pending Archive + daily processIntegratedHistory) use it in place of `abndPct > QCD_VIOLATION_ABANDON_RATE`. The constant stays 0.04 (the R22 cross-file pin reads it). The dashboard tints and queue-report email already used >= 4, so nothing dashboard-side changed.
QO-2 | cdr-report/sheetRepairs.js | previewQcdViolationFlags() / repairQcdViolationFlags(): re-flags ONLY QCD Historical Data rows whose stored counts are EXACTLY 4.00% (abandoned*25 === total) dated on/after QCD_VIOL_GTE_FROM_ISO_ = 2026-08-01 (the month the 4% rule took effect, per the owner) -- the 5% era keeps its meaning. Bulk-apply contract order (fingerprint incl. a checksum of queue/source/counts/flag -> read -> snapshot when >= 500 cells -> re-verify -> write). Neon: every in-scope exactly-4.00% row is upserted via writeQCDRowsToNeon (DO UPDATE), not only the ones changed this run, so re-running heals an unreachable-Neon mirror. Joins both source-pin lists in sheet-repairs-backup.test.js (1b + CR-1).
QO-2 | tests/unit/qcd-violation-rule.test.js | Flag edges (exactly 4.00% at 1/25, 4/100, 12/300; 3.96% not; zero calls not); both writers call the helper and no `>` gate remains; repair preview writes nothing; apply flags only the in-scope row (July exact-4% untouched, 4.17% / 3.96% untouched, already-1 not rewritten but re-mirrored); idempotent re-run; unreachable Neon leaves the sheet repaired with a re-run message. Bites: HEAD writer fails 1-2, a moved cutoff fails 3-5.
QO-2 | docs/invariants.md (INV-50), docs/client-ui-conventions.md | The Violations column is "reached the gate", 4.00% or more since QO-2, with the repair named; the company card's ladder text no longer cites a 5% violation line.
DX-11 | docs/conventions.md | Work-window and after-hours tables now in Pacific/Central LOCAL time (the CDT column that implied a summer shift is gone); the Timezones row and the offset paragraph record the owner's 2026-10-02 confirmation and how to re-check (a 3 h gap during DST would mean fixed PST). No code change -- the code was right.
PC-12 | OutboundReport.gs | outboundScopeDepts_(dept) = [dept] + inboundChildDepts_(dept) (the SAME child map the callback denominator rolls in, so the two cannot disagree); the resolver puts it on scope.scopeDepts; outboundShapeReport_ keeps an agent when any in-scope dept is among their roster homes, tags the row scopeDept (the parent wins a crossover, so no agent counts twice) and ships meta.scopeDepts. A scope built without the list keeps the old own-roster rule. outboundReport:v6 -> v7.
PC-12 | script-9-inbound-direct.html, styles.html | A parent view renders the agent table GROUPED: one static heading row per in-scope dept (name, agent count, subtotals) followed by that dept's rows in the current sort; single-dept and company views render exactly as before. The attribution note names the included sub-queues. New .ob-group-head style (deliberately not .subq-group-head, which promises a collapse toggle).
PC-12 | tests/unit/outbound-report.test.js; tools/ui-harness/build-harness.js + drive-admin.js | Three pure pins (parent + child rosters with the crossover rule, legacy scope + company view unchanged, the child map); the harness mock returns a Sales (+PAP) parent payload and drive-admin selects Sales and asserts the rendered group order and subtotals. All bite (the HEAD renderer prints the rows flat).
PC-12 | docs (INV-30, conventions cache table, architecture, per-call-capture) | v7 recorded; the Outbound report section states the parent-view rule.
AC-2 | IndividualReport.gs | sendIndividualReportEmail's agent path calls irAgentEmailFigures_: refuses unless req.agents is exactly [agentName]; requires a valid from/to inside the report range cap (SEC-1); computes the agent's figures with computeIndividualReport_ (the on-screen IR builder, INV-25 weighted ATT) for that agent + window. The email then leads with server-written tiles (Answered, Missed, Answer rate, Avg talk time) and a line naming the window; the subject uses the server's date label; the PNG follows as a labelled supplement. Send-to-self is unchanged.
AC-2 | script-6-ir.html | irEmailToAgent_ sends agents (the report's list), from and to with every agent send.
AC-2 | tests/unit/ir-send-to-agent.test.js | The suite's send() double now sends the client's new shape (agents + window) and stubs computeIndividualReport_; new pins: multi/mismatched/missing agents refused, missing/inverted/over-cap window refused, the agent copy carries server figures + server subject (the client label is ignored), send-to-self untouched, and a client source pin. All bite against HEAD.
AC-2 | CLAUDE.md | The IR-to-agent bullet gains the AC-2 clause (CLAUDE.md 173.9 KB, 84.9% of its cap).

TEST RESULTS: passed -- `npm run ci` 2133/2133 + INV-16 guard + module-deps --check; `CI=true npm run lint:gas` clean; bare `TZ=UTC node --test` 2133/2133; `npm run ci:ui` all stages (drive-admin 125/125 incl. the new PC-12 check).
REGRESSION RISKS:
- QO-2: from deploy, an exactly-4.00% queue-day counts as a violation everywhere (Viol columns, Queues-in-viol, the queue report). That is the ruling; the visible effect is a few more violations, all on days that were already tinted red.
- QO-2 repair: dated from 2026-08-01 per "August"; if the switch happened mid-August, exactly-4.00% days between Aug 1 and the switch day (written under the 5% rule) are also re-flagged. Change QCD_VIOL_GTE_FROM_ISO_ before running if that matters.
- PC-12: a parent dept's Outbound agent count, KPIs and activity rise (sub-queue agents now included); the callback rate is unchanged. Cache v7 means no stale v6 payload is served.
- AC-2: an agent send now fails with a clear message if the report on screen is not exactly one agent or has no window -- the client always sends both, so this only refuses crafted or stale requests. Each agent send now also runs the IR builder once (an explicit user action).
- AC-2 does NOT close the image path: the server cannot inspect a PNG, so a crafted request can still attach an arbitrary image to an otherwise-correct email (option C would close it; not chosen).
INVARIANTS AT RISK: None. INV-50 updated (the flag's meaning). INV-25 (weighted ATT) is what the AC-2 figures use. INV-16 untouched (neither duplicated file changed). INV-01: the repair is an editor-run cdr-report tool; no new public write.
NET SCORE: 3 production fixes (QO-2 exactly-4.00% days read red with Viol 0; PC-12 a parent view's table and denominator disagreed; AC-2 the one-agent rule was client-only) − 0 new failure modes = 3. DX-11 is docs only.

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (the QO-2 writers) | BLOCKS DEPLOY: Y
- Deploy cdr-report (the repair tool) | BLOCKS DEPLOY: N
- Deploy the dashboard (PC-12, AC-2) | BLOCKS DEPLOY: Y
- After the cdr-report deploy: run previewQcdViolationFlags() in the cdr-report editor, read the listed rows, then repairQcdViolationFlags(). If it reports Neon unreachable, run it again later. Cached reports pick it up within 6 h. | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`
Deploy: CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

FOLLOW-ON ITEMS:
- The Daily Queue Report's COMPANY card keeps its own ladder (red only ABOVE 4%), documented as deliberately different from the violation rule. After QO-2 an exactly-4.00% company day reads amber while a 4.00% queue counts as a violation -- worth an owner glance.
- AC-2 option C (render the whole agent email server-side, drop the client PNG) remains the only full close of the image path.

DOCUMENTATION UPDATES NEEDED:
- None remaining -- all edits listed above (CLAUDE.md, INV-30/INV-50, conventions, per-call-capture, architecture, client-ui-conventions, next-steps, tests/README).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
