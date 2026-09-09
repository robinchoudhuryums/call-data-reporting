---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: F1 (modal-route rendered coverage unenforced; Coaching uncovered), F2 (svc() flagProp membership unenforced), F3 (window.confirm backlog unratcheted + miscounted in docs), F5 (non-finite numerics silently written as 0). F4 RETRACTED — see below.
Files modified: tools/ui-harness/drive-admin.js, tests/unit/cross-file-pins.test.js, tests/unit/html-include-structure.test.js, tests/unit/neon-write-chunking.test.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-report/neonWrite.js, CLAUDE.md

CHANGES:
F1 | drive-admin.js, cross-file-pins.test.js, CLAUDE.md | Added the Coaching modal to the driver's MODALS list (its RPCs were already mocked in build-harness.js). Added a tripwire pinning every `kind:'modal'` router route to either an asserting driver or a documented `DRIVER_MODAL_EXEMPT` entry, plus a second test failing on a stale exemption. The driver list is parsed out of ci.mjs's STAGES so it follows the real gate rather than a hardcoded list. CLAUDE.md's "Coaching is NOT in it yet" claim corrected and the enforcement named.
F2 | cross-file-pins.test.js | Tripwire pinning every flag-gated TRIGGER engine to a `flagProp` actually passed to `svc()`. Engines are discovered from their own files (a file that reads a `*_ENABLED` property AND installs a trigger), so a ninth engine cannot inherit the old blind spot.
F3 | html-include-structure.test.js, CLAUDE.md | Ratchet on the legacy `window.confirm` backlog: it may only shrink, and shrinking requires lowering the cap in the same commit. CLAUDE.md's "~12" corrected to the real 11 and the enforcement named.
F5 | neonWrite.js (BOTH INV-16 copies), neon-write-chunking.test.js | Non-finite numerics (NaN / undefined / Infinity) are now COUNTED by `neonSqlInt_`/`neonSqlNum_`, reset per `neonInsertInline_` call, and reported on the log note every writer already prints. The written VALUE is unchanged, so inline == bound parity holds exactly. Pinned, including that the clean note stays byte-identical.

TEST RESULTS: passed — `npm run ci` green: 1237 tests (was 1232; +5), 0 fail, INV-16 duplicated-files guard in sync. Every new assertion was mutation-verified rather than assumed: removing Coaching from MODALS fails F1; dropping a `flagProp` argument fails F2; adding a `window.confirm` callsite fails F3; reverting the F5 counting fails its pin AND the INV-16 guard flags the divergent copies. Two of my own pins were WRONG on first run and were corrected rather than forced: F1 initially scanned only drive-admin and called the Individual Report modal uncovered (it is covered by drive-smoke + drive-f13); F2 initially demanded a flagProp for AGENT_ROLE_ENABLED / LOGIN_NOTIFY_ENABLED, which are feature flags in Auth.gs with no trigger. F2's first draft also passed a deliberate mutation because it only grepped for the flag STRING — it now walks svc()'s balanced parens.

Regression Scenarios: none walked. The overlapping scenarios (S5 / S7 / S28 / S33 / S34, CDR Import + Pipeline) require a live Apps Script import, which is not reachable from this environment. The neonWrite change is value-neutral by construction and that property is pinned (clean log note asserted byte-identical, inline == bound parity untouched), so those scenarios' expected results are unchanged.

REGRESSION RISKS:
- `neonInsertInline_`'s return gained a `coerced` field. Consumers read named fields only and no test deep-equals the object. `NEON_COERCED_` is module-global but reset at each `neonInsertInline_` entry; Apps Script is single-threaded per execution and the only other caller (`directCallMetrics.js::dcUpsertRows_`) routes through that same function, so no cross-writer leakage. Verified `directCallMetrics.js` does not call `neonSqlInt_` at all — its only mention is a comment stating it deliberately uses `v | 0` instead.
- **UNVERIFIED: the Coaching driver stage.** Playwright is not installed in this environment, so `npm run ci:ui` SKIPS locally and CI is the first real run of the new stage. Statically confirmed the Coaching modal has the structure the driver asserts (`.modal-panel`, `.modal-close`, `data-close` backdrop, shared open/close wiring, both RPCs mocked) and is byte-comparable to the six passing modals, so the risk is low — but it is not zero, and if it goes red that is the coverage gap doing its job.
- Test-only and doc changes otherwise; no production behavior altered.

INVARIANTS AT RISK: None. INV-16 was directly engaged and is the one that mattered: both `neonWrite.js` copies were edited identically (one edited, then mirrored) and the shell guard passes; a mutation confirms the guard still catches divergence. No cache prefix changed (INV-30 not engaged), no aggregation rule changed (INV-05 / INV-25 untouched), no Script Property added (PROP_REGISTRY_ unaffected). CLAUDE.md is 169.3 KB against the 200 KB cap with the per-bullet ratchet green.

NET SCORE: 0 production fixes − 0 new failure modes = 0
Every finding was preventive. (a) Would any have fired in production this month? NO — no bug was fixed; three conventions gained the enforcement they were documented as having, and one silent path gained a signal. (b) New failure mode introduced? NO.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: the F5 change is shipped code in TWO Apps Script projects and is not live until both are pushed:
  CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
  CDR Import:          `cd apps-script/cdr-import && clasp push -f`
(The other changes — tests, the ui-harness driver, CLAUDE.md — are repo-only and need no deploy.)

FOLLOW-ON ITEMS:
- The three REPORT modals (`inbound-modal`, `direct-call-modal`, `outbound-modal`) have NO rendered-gate coverage. Building F1's tripwire surfaced this; it is now explicit in `DRIVER_MODAL_EXEMPT` instead of invisible. Closing it needs harness payload fixtures in gen-phase3.js, and the reports are admin-only-while-vetted anyway — out of scope for this batch.
- `directCallMetrics.js` coerces with `v | 0`, which turns NaN into 0 on the same silent path F5 just instrumented, and is NOT counted. Deliberately untouched: it carries a documented contract that its inline and bound paths use the SAME coercion, so changing one means changing both together with the parity pin.
- F5's counter does not cover the bound fallback's own `|| 0`. Stated in the code comment; it runs only for a lone oversize tuple.
- `npm run ci:ui` was never executed in this session (playwright absent). Worth a local run before merge if the environment allows.

DOCUMENTATION UPDATES NEEDED:
- Done in this session. CLAUDE.md: the `window.confirm` count corrected 12 → 11 with its ratchet named; the stale "Coaching is NOT in the MODALS list" claim replaced with the enforced-mirror description and the current exemptions. No further doc work outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
