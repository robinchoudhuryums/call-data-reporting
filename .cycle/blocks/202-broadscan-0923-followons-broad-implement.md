---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (the pertinent follow-ons from blocks 197–201: unscheduled, concrete defects):
- UI-1 follow-on: Escape on a report's Export menu (IR, the all-dept Queue report) also closed the report.
- UI-9 follow-on: the Team Rings row's jump action was described only by `title`. `tr.ins-qh-row` was reviewed and is not a defect.
- UI-4 follow-on: Escalations init had no in-flight guard.
- UI-3 follow-on: under view-as, the Overview logged the synthetic manager, not the real admin.
- PCR-2 follow-on: the journey's dept predicate and its two sheet mirrors matched `final_dept` against the dept NAME only.
- S2B-7 follow-on: the Dept Config QCD-queues cell was written raw.
- Batch 4 follow-on: Alerts had no INTERRUPTED signal.
- CRT-4 follow-on: CHECKED, NOT FIXED. The shape exists, but the fix is larger than a follow-on; see FOLLOW-ON ITEMS.

Not in scope (still open):
- S2C-1 `agentBusy`: blocked on live evidence.
- The `first_agent` audit: a new tool.
- The callback table: a feature.
- ENG-4: scheduled in Batch 8.

Files modified:
apps-script/department-dashboard/script-1-core.html, script-5-dept.html, script-10-escalations.html, dashboard.html,
CompanyOverview.gs, InboundReport.gs, DeptConfig.gs, Alerts.gs, SystemHealth.gs, Config.gs;
tests/unit/html-include-structure.test.js, overview-chart-answered.test.js, inbound-window-scope.test.js,
journey-fallback.test.js, dept-config.test.js, alerts-readiness.test.js, system-health.test.js;
tools/ui-harness/drive-f13.js; docs/client-ui-conventions.md, docs/fix-history.md;
.cycle/STATE.md

CHANGES:
UI-1 FO | script-1-core, drive-f13 | `wireMenuKeys_` stops an Escape that closes an open menu, both on the trigger (a click-opened menu keeps focus there) and inside the menu. So the report behind the menu no longer closes. This covers every `wireMenuKeys_` menu. `drive-f13.js` presses Escape on the IR Export menu, opened by click and by keyboard, and asserts that the menu closes and the report stays open.
UI-9 FO | script-5-dept, dashboard.html | The trp row gets `aria-describedby="trp-row-action-desc"`, pointing at one static `.sr-only` node (never `aria-label`; C1-14). `ins-qh-row` is unchanged: it is the documented F13 shape shared with `qcdToggleExpandRow_`, not the E-8 `role="button"` defect.
UI-4 FO | script-10 | `escInitInFlight_` + `escInitPendingCb_`: while init is in flight, the newest continuation replaces the pending one, both handlers clear the flag, and Retry re-runs with the pending continuation.
UI-3 FO | CompanyOverview.gs | `getCompanyOverview` logs `realUser` (the dept column keeps the viewed scope), matching the YTD endpoint.
PCR-2 FO | InboundReport.gs | `callJourneyDeptPredicate_` now matches `final_dept IN (inboundDeptFinalLabels_(dept))`, i.e. own + children's labels, always including the dept name. The inbound and outbound-linker sheet-fallback mirrors do the same through a label set.
S2B-7 FO | DeptConfig.gs | The `qcdQueues` cell goes through `sheetSafeCell_`.
Batch 4 FO | Alerts.gs, SystemHealth.gs, Config.gs | `ALERTS_STARTED` is stamped before each assessment (not on DEFER). It is the `out-alerts` row's 8th column, so a run killed mid-assessment reads INTERRUPTED after 30 min. It is registered as engine state in `PROP_REGISTRY_`.
All new tests bite against HEAD. For the menu fix, the driver fails both presses with the old core.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 1861/1861.
- INV-16 in sync; module-deps up to date; `CI=1 npm run lint:gas` clean.
- `CI=1 npm run ci:ui`: all stages passed (drive-f13 18/18).
- Regression Scenarios: S39 is driven (drive-f13); S20 alerts is covered by server tests; S36 Dept Config save by `dept-config.test.js`. S38 (journey) is not walked live.

REGRESSION RISKS:
- Escalations init: if the init RPC never invoked either handler, `escInitInFlight_` would stay set and later entries would wait on it. `google.script.run` always calls one handler (a timeout reaches the failure handler), so this is theoretical.
- The journey predicate is WIDER for a parent dept: children's org-chart labels now satisfy arm 1. This is intended (it matches PCR-1/PCR-2's rollup, and INV-38 already grants parent managers their child queues).
- An Escape pressed on an Export menu trigger with the menu open now only closes the menu. A second press closes the report, as before.

INVARIANTS AT RISK: None.
- INV-01: the Dept Config write is still admin-gated; only the cell is neutralized.
- INV-38: the journey widening stays within the one-level parent access already granted.
- INV-44 / PROP_REGISTRY_: the new key is registered, and `prop-registry.test.js` passes.

NET SCORE: 1 − 0 = 1
- Production this month: UI-1 FO YES (Escape on the IR Export menu is an ordinary keystroke on a much-used report).
- Not this month: the rest need rare timing, an assistive tech, a view-as session, an unusual label or queue name, or a killed run.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or `scripts/deploy.sh .`), then Manage deployments → New version. cdr-import and cdr-report are untouched.

FOLLOW-ON ITEMS:
- CRT-4 on the deferred mirror / dup-guard re-mirror (CHECKED, NOT FIXED; needs a design decision). `remirrorExistingDqeDate_` (both INV-16 copies) and `NeonMirror.js` re-read the SHEET and upsert through `neonWrite.js`'s `DO UPDATE SET slot_* = EXCLUDED…, abandoned_* = EXCLUDED…`, so a cell corrupted on the sheet after its first mirror overwrites Neon's good value. That is the CRT-4 shape. A SQL-level COALESCE is NOT safe:
  - The writer binds `(slots[s]) || null`, and the re-mirror maps a lost slot to ''. Lost and empty therefore both reach Neon as NULL.
  - With COALESCE, a legitimate rebuild that empties a slot would keep the stale value.
  The fix needs a lost-cell channel through the duplicated writer: CRT-4's keep-stored SELECT, moved into `neonWrite.js` or run in both callers. It touches the authoritative daily write's module. Recommend its own planned change. Exposure is low: the dup guard only re-mirrors dates already in history, which are recent, plain-text-protected rows.
- `tr.ins-qh-row` / `qcdToggleExpandRow_` (Insights Queue health + the all-dept report) put `aria-expanded` on a focusable row. This is valid ARIA 1.2 and the documented F13 shape. The button-in-cell contract is newer; aligning both surfaces would be a small a11y refactor if wanted.
- The shared INTERRUPTED text reads "a send started" on the alerts row too. Alerts do send, so it stays.
- Still open from earlier: S2C-1 `agentBusy` (needs live evidence), the `first_agent` off-roster audit (needs the roster in cdr-import), ENG-4 re-scope (Batch 8), and the callback table (`outboundReport:v5`).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit, which updates:
  - client-ui-conventions: the Escape rule now covers menus
  - fix-history: a follow-ons section
---END BROAD SCAN IMPLEMENTATION SUMMARY---
