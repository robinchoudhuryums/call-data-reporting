---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (owner request, 2026-11-09)
New capabilities (G/ST): DCD-1 -- "Save all defaults as sheet rows" in Admin ▾ → Dept Config: one click writes a sheet row for every department running on the dashboard's built-in defaults only, so the CDR Import pipeline (which reads saved rows only) sees the same mapping. Closes the CLN block's follow-on.
Files modified: apps-script/department-dashboard/{DeptConfig.gs, dashboard.html, script-7-admin.html}; tests/unit/{dept-config, client-correctness}.test.js; tools/ui-harness/{build-harness.js, drive-admin.js, README.md}; tests/README.md; docs/{fix-history.md, operator-state.md, regression-scenarios.md, module-dependencies.md}

CHANGES:
DCD-1 | DeptConfig.gs | `saveDeptConfig` = assertAdmin_ + `saveDeptConfigRow_(req, false)` (its unchanged body; `deferPublish` skips the H2 republish). `dcDefaultRowsToSave_()`: departments with NO row (active or not) and a non-empty default (QCD queues / Overview parent / team-avg excludes / queue-ext overrides), with the in-force values; a deactivated row is reported as left alone. `saveDeptConfigDefaults()` (admin): each row through `saveDeptConfigRow_(…, true)`, refusals reported per dept, standards republished once, Logger audit line. `getDeptConfigInit` carries `defaultsToSave` / `defaultsInactive`.
DCD-1 | dashboard.html, script-7-admin.html | `#dc-defaults-bar` under the CLN-6 note (hidden when the list is empty); dsConfirm_ naming the departments; ONE no-argument `saveDeptConfigDefaults` request; status line names saved / refused / warnings; reload keeps the status (CL-15); the button joins `dcSetBusy_`.
DCD-1 | tests + harness | dept-config +4 (the plan; rows written with the in-force values and a second run saves nothing; a refused row reported while the rest save; admin-only + the single Save unchanged); client-correctness CL-15 count 2 -> 3; drive-admin Dept Config probe (3 checks against the REAL init from gen-phase3); build-harness mock.

TEST RESULTS: `TZ=America/Chicago node --test` 2879 pass / 0 fail; lint:gas clean; module-deps up to date; INV-16 clean; `CI=1 npm run ci:ui` all stages passed (drive-admin 171/171). Bites 3/3: deactivated row reactivated, bulk bypasses the single save's validation, standards republished per row.
REGRESSION RISKS: (1) `saveDeptConfig` now delegates -- same body, same order, same publish (pinned by the admin-only/single-save test and every existing save test). (2) Under CONFIG_SOURCE=neon each row writes Neon first and mirrors to the sheet (S2B-5), so a mirror failure comes back as a warning in the status line, not a saved sheet row.
INVARIANTS AT RISK: INV-01 (DeptConfig.gs is an existing carve-out; the new public function asserts admin and uses the single save's validation + lock + stamp) -- held. INV-54 (accessor semantics unchanged; saved values equal the defaults, so no effective value moves) -- held.
NET SCORE: 0 production fixes (new capability) − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- After the deploy: Admin ▾ → Dept Config → Save all defaults as sheet rows; then A_Q_Sales_MWC in Sales' Inbound queue aliases (XB-0c "MWC is Sales") and A_Q_BackUp_FieldOps in Field Ops' (not built-in defaults, so the button cannot save them); re-run `diagnoseTransferBouncesAllDates` | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` + new version)

FOLLOW-ON ITEMS:
- None new.

DOCUMENTATION UPDATES NEEDED:
- None beyond the commit (fix-history DCD-1, Operator State #86, S36 step, tests/README, ui-harness README).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
