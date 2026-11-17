---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (P11 is new capability from the owner follow-up plan of 2026-11-13, built on the owner's privacy decision of 2026-11-17)
New capabilities (G/ST):
- P11a | A read-only feasibility check that a caller's number can be found for the calls on the callback worklist: `probeCallbackNumberLookup()` (dashboard editor; counts only, no number).
- P11b | The callback worklist (Admin ▾ → Callback worklist): callers not yet called back, most urgent first, and the ONE page a caller's phone number can be shown on -- one call per click, each lookup logged first.
Files modified:
- apps-script/department-dashboard/CallbackWorklist.gs (new)
- apps-script/department-dashboard/Config.gs
- apps-script/department-dashboard/Setup.gs
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-2-chrome.html
- apps-script/department-dashboard/script-4-nav.html
- apps-script/department-dashboard/script-7-admin.html
- apps-script/department-dashboard/styles.html
- tests/unit/callback-worklist.test.js (new)
- tests/unit/setup.test.js
- tests/unit/cache-version-sync.test.js
- tests/unit/client-correctness.test.js
- tests/unit/keyboard-focus.test.js
- tools/ui-harness/gen-phase3.js
- tools/ui-harness/build-harness.js
- tools/ui-harness/drive-admin.js
- tools/ui-harness/README.md
- tests/README.md
- CLAUDE.md
- README.md
- docs/operator-state.md
- docs/invariants.md
- docs/regression-scenarios.md
- docs/fix-history.md
- docs/client-ui-conventions.md
- docs/per-call-capture.md
- docs/known-issues.md
- docs/module-dependencies.md
- .cycle/STATE.md (the plan's P11 entry, with the owner's decision)

CHANGES:
P11b | CallbackWorklist.gs | `getCallbackWorklist({department})`: the last 14 days' not-called-back episodes from the existing engine (`getOutboundUncalled`), minus the ones called back or got through late, pending first by days left then missed newest first; whether each row's raw tab still exists; NEVER a number. `revealCallbackNumber({department, callDate, callId})`: the outbound gate, then `cbwMayReveal_` (admin, or a manager while `CALLBACK_NUMBERS_MANAGERS` is exactly `true`), input validation, a 40-per-hour per-person cap that fails closed, worklist membership re-derived for that request, the lookup, an audit row appended BEFORE the reply (no reply if it cannot be written), then `{ ok, state, number? }`. `setCallbackNumbersForManagers(on)`: admin-only switch.
P11b | CallbackWorklist.gs | The lookup: the `Call_Legs_<date>` tab of the CDR Import workbook (`CDR_IMPORT_SS_ID`), the call's legs by own or parent call id (two id columns read, then the matched rows), the outside numbers on its incoming non-recording legs as candidates, and ONLY the candidate whose HMAC equals the call's stored `caller_hash` is returned. States: found / notConfigured / noTab / notFound / noNumber / unconfirmed.
P11a | CallbackWorklist.gs | `probeCallbackNumberLookup()`: admin, read-only; every department's worklist, each number looked up as the page does; logs counts, call-id samples and a verdict (GOOD 95%+, PARTIAL, POOR, INCONCLUSIVE under 10 held calls, NOT CONFIGURED). Writes no audit row (nothing is shown).
P11b | Config.gs, Setup.gs | `SHEETS.CALLBACK_NUMBER_LOG` + `CALLBACK_NUMBER_LOG_HEADERS` (Timestamp, User, Role, Department, Call Date, Call ID, Result); `setup()` creates it (fifteen managed sheets), and the first lookup creates it too; `CDR_IMPORT_SS_ID` and `CALLBACK_NUMBERS_MANAGERS` registered in `PROP_REGISTRY_`.
P11b | dashboard.html, script-2-chrome.html, script-4-nav.html, script-7-admin.html, styles.html | The modal, its Admin menu item and `/admin/callbacks` route, the boot step, and the client: "Show number" per row, the reply written into one cell as `.cbw-num` + "logged", reasons for a number not shown, the table emptied on every reload and on close, the managers' switch (asks before turning on), and `.cbw-num` hidden in print.
P11 | tests | New suite `callback-worklist.test.js` (11 tests: the five terms, the hash proof, parity with cdr-import's caller rule / column map / hash, the probe, setup, and a source sweep that neither the client block nor the server file stores, exports or logs a number). Updated pins: the sheet count (15), the boot-step count (33), the focus-return count (17), the cache-prefix registry (`cbwReveal`).
P11 | harness | The REAL `getCallbackWorklist` payload over a stubbed episode list and a fake import workbook; mocks for the lookup and the switch; eleven rendered checks in drive-admin.js.
P11 | docs | Operator State #95 (new), #6, #63; INV-01 (the audit carve-out) and INV-12; S74 (new) and S22; fix-history `P11`; client-ui-conventions; per-call-capture; tests/README; harness README; README; known-issues; CLAUDE.md (index lines, the Subsystems list, one Common Gotchas bullet); module map regenerated.

TEST RESULTS: passed — unit 3,162 pass / 0 fail (TZ=America/Chicago node --test); `npm run lint:gas` clean; module map up to date; INV-16 guard in sync; `npm run ci:ui` all stages passed (drive-admin 270 of 270); 13 of 13 bite-checks bite.
REGRESSION RISKS:
- `setup()` now creates a fifteenth sheet in the CDR Report workbook.
- The dashboard opens a second workbook (the CDR Import one) when the worklist loads or a number is looked up; if the deploying account cannot open it, the page reads "Not set up" and no number is shown.
- Nothing existing changed behaviour: the callback engine, the outbound gate and every other payload are untouched.
INVARIANTS AT RISK: INV-01 is EXTENDED, not broken -- `revealCallbackNumber` is a public, non-admin-capable function that appends an audit row; the carve-out is written into INV-01 and pinned. INV-12 moves from fourteen sheets to fifteen (docs and pin updated). The "a caller is a hash everywhere" rule now has one documented exception.
NET SCORE: 0 − 1 = −1 (no production fix; one new failure mode, accepted by the owner and documented: a number shown to an entitled viewer can be copied or photographed, which no log undoes. Whether the lookup works on the live raw tabs is unmeasured until the probe runs.)

OPERATOR ACTIONS / DEPLOY:
- Run `setup()` once after the deploy (creates `Callback Number Log`; the first lookup would create it too) | BLOCKS DEPLOY: N
- Set the `CDR_IMPORT_SS_ID` Script Property on the DASHBOARD project to the CDR Import workbook's id (per Operator State #53), and check `HMAC_SECRET` is set there and matches cdr-import (#17) | BLOCKS DEPLOY: N (the page reads "Not set up" until then)
- Run `probeCallbackNumberLookup()` in the dashboard editor and read the VERDICT | BLOCKS DEPLOY: N
- Walk S74, then `runLiveSmoke` | BLOCKS DEPLOY: N
- Leave "Allow managers" off until you want managers on the page; that also needs the outbound release (#63) and a manager entry point (not built) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`). No cdr-import or cdr-report push is needed for P11.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- No manager entry point: the page is on the Admin menu only. The server already admits a manager (released + switched on + own department); the menu item for them belongs in the same change as the outbound release or its own.
- The worklist covers queue abandons only. Direct-line callers who were not called back (`getOutboundDirectCallbacks`) are not on it.
- Each lookup re-runs the whole not-called-back list to check the call is still on it (a few seconds). A short per-user membership memo would make it faster; not done, because a stale memo weakens the scope rule.
- Nothing trims `Callback Number Log`, and the Health page has no row for it (lookups per day, last lookup).
- The feasibility of reading the live raw tabs is unmeasured: `probeCallbackNumberLookup()` is the measurement.
- The plan's batches P1-P11 are now all built; P6-P11 and the follow-on rounds are on the branch with no PR.

DOCUMENTATION UPDATES NEEDED:
- None — updated in this change (see CHANGES).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
