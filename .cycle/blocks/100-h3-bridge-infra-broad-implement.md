---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (cross-repo evaluation, 2026-09-17; the "three small bridge fixes" + the S-sized infrastructure adaptations)
- B1 | team-tools: `cdrRowDateIso_` reads a bare Sheets serial as a date (formatted in UTC) instead of silently dropping the row (the dashboard's F-8 class)
- B2 | team-tools: the `CDR_CACHE_TTL` comment no longer claims to match the dashboard's cache (6 h since R24)
- B3 | team-tools: both DQE readers are SPAN-bounded (`cdrDqeWindowSpan_`, the dashboard's R41 port) instead of reading the whole 34-column tab twice per call; per-row filter kept
- I-TT1 | team-tools: MAIL-SWEEP pin -- every MailApp/GmailApp send lives inside the two sanctioned senders (the dashboard's app-email sweep)
- I-TT2 | team-tools: `.gitattributes` LF policy (the dashboard's), tree already LF-clean
- I-TT3 | team-tools: CI pins TZ=America/Chicago (verified green under it)
- I-CDR1 | call-data-reporting: `scripts/lint-gas.mjs` -- no-undef over each project's ONE global scope (team-tools' lint-server port); eslint devDependency + a separate CI `lint` job; all 72 files clean
- I-CDR2 | call-data-reporting: cross-file-pins fails on a top-level name declared in two files of one project (team-tools' F2c port); zero today
- I-CDR3 | call-data-reporting: `scripts/bite.sh` (team-tools' bite-check port); both new pins proven to BITE with it
- I-CDR4 | call-data-reporting: Health `trg-quota` row -- installed triggers vs the 20-per-script cap, warn at 17 (team-tools' quota pre-flight, as a row)
Files modified:
- team-tools: web-app/40_metrics.js, web-app/00_config.js, web-app/Tests.js, test/client/run.js, test/client/server-split-manifest.json, .github/workflows/client-tests.yml, .gitattributes (new), CLAUDE.md, docs/gotchas.md, docs/modules.md, docs/design-decisions.md, .cycle/config.md
- call-data-reporting: scripts/lint-gas.mjs (new), scripts/bite.sh (new), package.json, package-lock.json (new), .github/workflows/ci.yml, apps-script/department-dashboard/SystemHealth.gs, tests/unit/cross-file-pins.test.js, tests/unit/system-health.test.js, CLAUDE.md
Estimate: S (~3 h) for the bridge fixes + S (~3 h) for the infrastructure set, recorded before the first edit
Actual: ~2.5 h across both repos

CHANGES:
B1 | web-app/40_metrics.js, web-app/Tests.js | `cdrRowDateIso_` gains the numeric branch (30000..100000 = days since 1899-12-30, formatted in UTC); smoke test `test_metrics_cdrRowDateIso_serial`
B2 | web-app/00_config.js | comment corrected
B3 | web-app/40_metrics.js | `cdrDqeWindowSpan_` scans the date column, `getCdrAgentMetrics_` + `getCdrDailyBreakdown_` read only the span at full width; the per-row date filter stays; `meta.rowsScanned` is now the span size
I-TT1..3 | test/client/run.js, .gitattributes, .github/workflows/client-tests.yml | the sweep pin, the LF policy, the TZ pin
Docs (TT) | CLAUDE.md, docs/gotchas.md (g125), docs/modules.md, .cycle/config.md (INV-212) | plus two scenario-ID collisions from H1/H2 fixed (S106/S107 were taken -> S110/S111; INV-210/INV-211 and the H2 decision repointed)
I-CDR1 | scripts/lint-gas.mjs, package.json, package-lock.json, .github/workflows/ci.yml, CLAUDE.md | per-project concatenated no-undef; skips without eslint except under CI=true (F-9 rule)
I-CDR2 | tests/unit/cross-file-pins.test.js | the H3 duplicate-declaration pin over dashboard / cdr-report / cdr-import
I-CDR3 | scripts/bite.sh, CLAUDE.md | runner `node --test`, needle `not ok.*<name>`, refuses dirty files
I-CDR4 | apps-script/department-dashboard/SystemHealth.gs, tests/unit/system-health.test.js | `TRIGGER_QUOTA_`=20 / `TRIGGER_QUOTA_WARN_AT_`=17, the row after `trg-readiness`

TEST RESULTS: passed.
- team-tools: pure harness 865/865, DOM harness 121/121, `npm run lint:server` clean, `counts.mjs --check` and the split manifest current, every server file parses. Test Command is `manual`: the Regression Scenarios overlapping 40_metrics.js (S110 holidays, S111 answer rate, the Metrics surface scenarios) are NOT APPLICABLE here -- no live instance in this container; the behaviour is pinned by H3-1..H3-4 (incl. the real `getCdrAgentMetrics_` over an out-of-order fixture equal to the pre-H3 full scan) and the editor smoke test runs at deploy.
- call-data-reporting: `npm run ci` 1566/1566 + INV-16 in sync; `npm run lint:gas` clean across 72 files in 3 projects; bite-checks: `trg-quota row` BITES, `dup-name pin` BITES. `npm run ci:ui` skipped (playwright absent) -- no client file was touched. Scenarios overlapping SystemHealth.gs: none of S1-S47 names the Health page's Triggers section -> NOT APPLICABLE; the row is unit-pinned.
REGRESSION RISKS:
- B3: `meta.rowsScanned` now counts the window's row span, not the whole tab -- any Health/diagnostic surface that prints it will show a smaller number (informational only; no consumer computes from it).
- B3: an empty window reads nothing (`values=[]`) -- identical outputs to the old empty loop, cached the same way.
- B1: a numeric Date cell in 30000..100000 is now COUNTED where it was dropped -- intended; a legitimately numeric non-date cell in that column does not exist by the tab's contract.
- I-CDR1: the new CI `lint` job depends on the npm registry (`npm ci`); the zero-dep `test` job is untouched, so a registry hiccup fails lint only.
- I-CDR4: one more row in the Health `triggers` section; the shim's empty inventory renders "0 of 20" (no false warn on a fresh install).
INVARIANTS AT RISK: None. team-tools INV-64 (getDisplayValues for durations) and INV-85 (no rate change, no key bump owed) hold; call-data-reporting INV-22 (dqe-report frozen -- deliberately excluded from the lint) and INV-16 untouched.
NET SCORE: 1 (B3 -- the four full scans per cold Dashboard open fire every workday) - 1 (the lint job's registry dependency, isolated to its own job) = 0

OPERATOR ACTIONS / DEPLOY:
- team-tools: `clasp push -f` + a New-version deploy; then `runSmokeTests` on prod -- the run prints its own `Expected:` count (now includes `metrics_cdrRowDateIso_serial`) | BLOCKS DEPLOY: N
- call-data-reporting: none required. Optional: `npm ci` once locally so `npm run lint:gas` runs instead of skipping | BLOCKS DEPLOY: N
Deploy:
- team-tools (web-app): `cd web-app && clasp push -f` (or `npm run push:prod`), then Apps Script editor -> Deploy -> Manage deployments -> Edit -> Version: New version -> Deploy
- call-data-reporting Department Dashboard: `scripts/deploy.sh . <deployment-id>` (or `clasp push -f` from repo root + the manual New-version step) -- SystemHealth.gs changed

FOLLOW-ON ITEMS:
- The remaining infrastructure adaptations from the evaluation are M-sized and were NOT started: call-data-reporting -- a trigger pre-flight at the install sites (the row only reports), `propSetBounded_` for engine JSON properties, the witness-row audit counter, per-employee presence keys, a blue-green dev instance, the content-hash deploy stamp + working Reload, durable ClientErrors rows; team-tools -- a modelled fake Sheet in Node, a blocking rendered-UI gate, `deploy.sh` + the remote-orphan check, a Script Property registry, sign-in notifications, `svc()` installed-vs-enabled reconciliation, a cache-version-sync test, the hash router, `csvSafeCell_`, the callnotes partial split, explicit `oauthScopes`, dropping the forms/deptRequests fallback into the payroll sheet.
- Queue/dept vocabulary publish (the last mirrored config; the H2 pattern) -- the next paired change.
- team-tools' `.cycle/config.md` had reused scenario IDs (S106, S107) -- fixed here; nothing enforces uniqueness of S-numbers (counts.mjs counts lines).
- The two rulings (agent self-view; the Escalations writer) remain the owner's.

DOCUMENTATION UPDATES NEEDED: None outstanding -- team-tools g125 + index, INV-212, modules.md and the counts block landed; call-data-reporting CLAUDE.md Key commands + the global-scope gotcha's enforcement line landed. (tests/README.md needs no entry: no new suite file.)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
