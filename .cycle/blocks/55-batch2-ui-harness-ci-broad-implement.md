---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch 2 — F7 (the client's only automated guard was manual and unwired) plus the two harness gaps the scan attached to it.
- F7 | The rendered-UI harness now runs as a CI gate (`npm run ci:ui` + a `ui-harness` GitHub Actions job), with the vendor bundles committed so playwright is the only install
- F7a | The missing `qcdAll` fixture payload — the all-departments QCD report could not be exercised at all, which is why F13's row fix was previously verified only on the Insights proxy surface
- F7b | `drive-f13.js` folded into the standard run, and extended to walk BOTH `tr.qcd-expandable` surfaces (they wire separate delegated keydown handlers)

Files modified:
- package.json (new `ci:ui` script)
- .github/workflows/ci.yml (new `ui-harness` job)
- CLAUDE.md (Key commands: the gate replaces the Batch-1 "NOT part of npm run ci" note, which this batch made stale; the CI line now names both jobs)
- tests/unit/ui-harness-vendor.test.js (NEW)
- tools/ui-harness/ci.mjs (NEW — the orchestrator)
- tools/ui-harness/drive-smoke.js (NEW — the asserting boot/render driver)
- tools/ui-harness/vendor/{chart.umd.js,datalabels.min.js,html2canvas-pro.min.js,VERSIONS.json} (NEW, committed)
- tools/ui-harness/build-harness.js (copies committed vendor; new `getQcdAllDepartments` stub handler)
- tools/ui-harness/gen-payloads.js (dumps the `qcd-alldept` payload)
- tools/ui-harness/drive-f13.js (both expandable surfaces, per-surface labels)
- tools/ui-harness/.gitignore (un-ignore `vendor/`)
- tools/ui-harness/README.md (CI-gate section; asserting vs exploratory drivers)

CHANGES:
F7 | package.json, .github/workflows/ci.yml, tools/ui-harness/ci.mjs | `npm run ci:ui` runs one orchestrator: gen payloads (real server code) → gen phase-3 fixtures → build admin + manager sites (real client) → the two ASSERTING drivers. Kept SEPARATE from `npm run ci` deliberately: the .gs suite is zero-dep by design and this needs playwright, so folding them would break that promise. CI runs it as its own `ui-harness` job that installs playwright + chromium. With playwright absent, `ci.mjs` prints an install hint and exits 0 — verified by hiding `node_modules/playwright` and re-running.
F7 | tools/ui-harness/drive-smoke.js (NEW) | The deterministic pass/fail driver, asserting the classes the .gs harness structurally cannot see, for BOTH roles across Overview / My Department / Insights / Escalations: (1) page + console errors, (2) unmocked RPCs beyond an explicit allowlist (`getInboundHeatmap` and friends are intentionally unmocked — the panel must hide silently, and that IS the audited behavior), (3) **BLANK chart canvases** — visible, laid-out canvases whose sampled pixels are entirely uniform, i.e. the R12-1 blank-missed-chart class and the main reason the harness exists, (4) horizontal document overflow. 22 checks.
F7 | tools/ui-harness/vendor/ + build-harness.js + tests/unit/ui-harness-vendor.test.js | The three CDN libraries are now COMMITTED (436 KB) and copied into the built site by `build-harness.js`, replacing three manual `cp` lines out of `node_modules` that the README told you to run. That manual step was a real trap: a fresh checkout built a site with NO `Chart` global, so every chart silently took `safeChart_`'s "unavailable" path and the harness reported nothing useful. New zero-dep unit test pins the committed versions to the versions `dashboard.html` loads from jsdelivr (currently chart.js@4.4.4 / datalabels@2.2.0 / html2canvas-pro@1.5.11) — without it the harness could quietly verify the client against a DIFFERENT Chart.js than production ships, in either direction.
F7a | tools/ui-harness/gen-payloads.js, build-harness.js | Added the `qcd-alldept` payload (`getQcdAllDepartments` for the latest queue day) + its stub handler. The all-dept Daily Call Queue Report previously had no fixture, so `#qcd-alldept-modal` rendered nothing and its `tr.qcd-expandable` rows never existed — the documented reason F13's fix could only be checked on Insights Queue health. It now renders 9 expandable rows in both roles.
F7b | tools/ui-harness/drive-f13.js | Now walks BOTH expandable surfaces (Insights Queue health AND the all-dept QCD report). They share `qcdToggleExpandRow_` but wire SEPARATE delegated keydown handlers (Insights tbody vs `#qcd-alldept-body`), so testing one proved only half the fix. Checks are labelled per surface. 13 → 16 checks.

TEST RESULTS: passed.
- `npm run ci` → 490/490 unit tests (was 488; +2 vendor-pin tests), INV-16 guard clean, cache-version-sync clean.
- `npm run ci:ui` → all stages passed: drive-smoke 22/22, drive-f13 16/16.
- No-playwright path verified separately (skip message, exit 0).
- The workflow file parses and exposes exactly two jobs (`test`, `ui-harness`) with the expected steps.
Regression Scenarios: S39 EXECUTED in its automated form and now covers both expandable surfaces. Everything else NOT EXECUTED — no runtime code changed in this batch (the only `apps-script/` edit is CLAUDE.md, which ships no behavior).

REGRESSION RISKS:
- **`continue-on-error: true` on the `ui-harness` job is a deliberate, temporary choice**: a brand-new headless-render gate that hard-fails on day one would block correct pipeline fixes on a flaky screenshot. The cost is that the gate is ADVISORY until someone deletes that line — which is a real risk of it being ignored, so it's called out in the workflow comment, the CLAUDE.md note, and the follow-ons here. Drop it once it's green across a few PRs.
- The blank-canvas check could false-positive on a chart that is legitimately uniform (all-zero data). Mitigated by an explicit `BLANK_OK` id set, a ≥40×40 layout-box requirement, and skipping anything without an `offsetParent`. It currently passes clean on both roles, so the fixture doesn't trip it; a future all-zero fixture would need an allowlist entry rather than weakening the check.
- Committing 436 KB of third-party minified bundles is new repo weight and a supply-chain surface. Accepted because it removes a silent-failure setup step, and the version-pin test means they can't drift from what production loads. They must be re-copied whenever `dashboard.html`'s CDN pins change — the test fails loudly if not.
- `build-harness.js` now EXITS NON-ZERO when a vendor file is missing, where it previously built a broken site. Strictly better, but it is a new hard failure for anyone who deletes `vendor/`.
- The unmocked-RPC allowlist could mask a genuine regression if an endpoint is added to it carelessly. It is a 5-entry explicit set, not a pattern.
- No production interface, return type, or default changed. Nothing under `apps-script/` changed behaviorally.

INVARIANTS AT RISK: None.
- The zero-dep discipline of `npm test` / `npm run ci` is PRESERVED — that was the main constraint here and the reason `ci:ui` is a separate script rather than appended to `ci`.
- INV-16: no duplicated file touched; guard clean. INV-30: no cache version referenced or bumped; sync guard clean.
- The new unit test is zero-dep (reads two text files) and adds ~0ms to the suite.

NET SCORE: 0 production fixes − 0 new failure modes = 0
No production behavior changed. Under /reflect's three-way tally: 1 new capability (an automated client gate where there was none) + 2 defensive/structural items (the vendor-pin guard, the fixture gap). The value is future-tense — this is the batch that makes the NEXT client regression fail in CI instead of in front of a manager.

OPERATOR ACTIONS / DEPLOY:
- Delete `continue-on-error: true` from the `ui-harness` job once it has run green across a few PRs, or the gate stays advisory forever. | BLOCKS DEPLOY: N
- Still outstanding from increment 53 (untouched by Batches 1–2): deploy both projects; re-run the Operator State #38 histogram; decide UDC/UUC attribution; walk S41/S42. | BLOCKS DEPLOY: N
- Re-copy `tools/ui-harness/vendor/*` whenever `dashboard.html`'s CDN pins change (the vendor-pin test fails loudly if you forget). | BLOCKS DEPLOY: N
Deploy: N/A for this batch — CI, audit tooling and docs only; no `apps-script/` behavior changed. The increment-53 deploys still stand: `cd apps-script/cdr-import && clasp push -f`, and `clasp push -f` from the repo root + a new dashboard deployment version.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The gate's coverage is boot-level: it proves pages render without errors, charts aren't blank, nothing overflows, and keyboard paths work. It does NOT assert VALUES on screen (e.g. that the agent table's totals match the payload). That's the natural next layer.
- The three exploratory drivers still produce human-read artifacts only. Promoting their objective findings (focus-trap escapes, contrast) into assertions would widen the gate further.
- `drive-smoke.js` visits pages but not most MODALS (Alerts, Dept Config, Access, Health, Caller Lookup). `gen-phase3.js` already generates their init payloads, so extending coverage is mostly driver work.
- Batch 3 (F6 payload-size logging / F9 double column scan / F10 stale esc badge / the "is this install armed?" consolidation), Batch 4 (deploy.sh orphan-file check), Batch 5 (the QCD-vs-inbound discrepancy — still the blocker on releasing Inbound + Direct), Batch 6 (flag flips), Batch 7 (F8 CLAUDE.md split) all untouched.
- F8 note: CLAUDE.md is now ~370 KB. Batches 1 and 2 both added to it. Its priority should keep rising.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. Specifically, Batch 1's own Key-commands note ("NOT part of `npm run ci`") was made stale BY this batch and has been corrected in the same commit; the CI description now names both jobs. `tools/ui-harness/README.md` was restructured into CI-gate / asserting / exploratory sections.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
