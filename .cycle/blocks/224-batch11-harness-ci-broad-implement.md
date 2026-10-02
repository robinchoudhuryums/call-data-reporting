---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- HT-2 (Med) -- the fake Range.setValues is shape-strict and keeps a fixture's display grid current
- CL-9 (Med) -- phone-width (360 px) overflow assertions in drive-smoke (admin + manager) and drive-agent
- HT-5 (Low) -- the shim models triggers (live set, 20 cap), real lock state, and the property value/store limits
- HT-3 (Low) -- the fake CacheService enforces the 250-char key and 100 KB value caps
- HT-4 (Low) -- the formatDate shim tokenizes Java patterns and throws on an unmodelled letter
- DEP-2 (Low) -- deploy.sh normalizes the project dir, so every spelling stamps the right build
- DEP-3 (Low) -- deploy.sh warns on a dirty / non-main deploy (STRICT_DEPLOY=1 refuses) and uses ONE dirtiness flag
- HT-6 (Low) -- CI on Node 22
- DEP-1 (Low) -- bite.sh restores the mutated file on every exit (EXIT trap)
- DEP-4 (Low) -- the orphan check recognises the repo's real placeholder scriptIds

Files modified:
- tests/harness/fakeSheet.js, tests/harness/shim.js, tests/harness/formatDate.js
- tests/unit/harness-strictness.test.js (new), tests/unit/deploy-tooling.test.js (new)
- tests/unit/individual-report.test.js, tests/unit/dashboard-cdr-core.test.js, tests/unit/inbound-export.test.js
- tools/ui-harness/drive-smoke.js, tools/ui-harness/drive-agent.js, tools/ui-harness/README.md
- scripts/deploy.sh, scripts/bite.sh, scripts/check-remote-orphans.mjs
- .github/workflows/ci.yml
- tests/README.md, README.md, CLAUDE.md

CHANGES:
HT-2 | tests/harness/fakeSheet.js | setValues throws unless the grid is exactly rows x cols (every row checked) with Sheets' own messages; the shape rule is exported as assertSetValuesShape. A write updates the fixture's display grid for the written cells; setValue fills the whole range (the real semantics); clearContent and appendRow keep the display grid aligned. No production writer was exposed (the full suite stayed green).
HT-2 | tests/unit/dashboard-cdr-core.test.js, inbound-export.test.js | Their hand-rolled range doubles call assertSetValuesShape; dashboard-cdr-core's double also drops a cell's display override on write, so its fixture now writes rows first and lays the F-11 display overrides on afterwards (setup order only, same assertions).
HT-3 | tests/harness/shim.js | CacheService get/put/remove throw "Argument too large: key" past 250 chars; put throws "Argument too large: value" past 100 KB; refusals recorded on state.cacheLimitHits.
HT-3 | tests/unit/individual-report.test.js | INV-36 by behaviour: a 61-agent (~2 KB) selection completes, caches, and hits no limit. Mutation-checked: replacing hashAgents_ with a raw join fails it.
HT-4 | tests/harness/formatDate.js | Rewritten as a Java SimpleDateFormat tokenizer: letter runs are fields, 'quoted' text is literal ('' = quote). Models y/yy/yyyy, M..MMMM, d/dd, H/HH, h/hh, m/mm, s/ss, a, u -- every pattern the three projects use (several, e.g. 'h:mm:ss a' and "yyyy-MM-dd'T'HH:mm:ss", previously came out as literal letters). Any other letter run throws.
HT-5 | tests/harness/shim.js | ScriptApp: create() registers a trigger object (getHandlerFunction/getUniqueId/getEventType/getTriggerSource) in state.triggers, getProjectTriggers returns the live set, deleteTrigger removes it, the 20-trigger cap throws; state.createdTriggers keeps its historical shape. LockService: real held state, hasLock(), lockReleases. Properties: > 9 KB value and > 500 KB store throw.
HT-2..5 | tests/unit/harness-strictness.test.js | Seven pins on the fakes themselves; all seven fail against the HEAD harness.
CL-9 | tools/ui-harness/drive-smoke.js | New phonePass: a FRESH boot per role at 360 px (the desktop page can end with a modal open, which scroll-locks body and blocks clicks), asserting html/body do not clip overflow (so the check is not vacuous), each tab is reachable, no horizontal overflow per page (failure names the offending elements), no unexpected unmocked RPCs, no page errors.
CL-9 | tools/ui-harness/drive-agent.js | Resize to 360 px, re-enter both tabs, same measurable + no-overflow checks, before the cleanliness checks; viewport restored to 1100 so the existing desktop layout check still measures desktop.
CL-9 | bite | A temporary 520 px min-width on #escalations-page / #agent-home-page turned exactly the four phone checks red (desktop stayed green) and named the elements; reverted.
DEP-2 | scripts/deploy.sh | <project-dir> resolved to repo-relative ('.' or apps-script/<p>) before first use; outside-repo or missing dirs refused; script cd's to the repo root; case arms use only canonical spellings; orphan check called by absolute path. Verified with a stub clasp: '.', './', $PWD, './apps-script/cdr-import/', 'apps-script/cdr-import/.' and '.' from inside cdr-import all stamp the right file (the last one previously stamped the DASHBOARD file while pushing cdr-import).
DEP-3 | scripts/deploy.sh | TREE_DIRTY (git status --porcelain, untracked included -- clasp pushes untracked files) is now the only dirtiness flag; the stamp's +dirty reads it instead of a second `git diff` check. Dirty / non-main deploys print warnings; STRICT_DEPLOY=1 refuses them.
DEP-4 | scripts/check-remote-orphans.mjs | Placeholder = anchored word (REPLACE/PASTE/YOUR prefix, SCRIPT_ID, scriptId), any of <>{} or whitespace, or not the shape of a real id ([A-Za-z0-9_-]{25,}). PASTE_SCRIPT_ID and <paste-scriptId-here> now SKIP cleanly; random ids containing "your"/"paste" still proceed.
HT-6 | .github/workflows/ci.yml | All three jobs on node-version '22'.
DEP-1 | scripts/bite.sh | restore() on an EXIT trap armed after the dirty-file guard; INT/TERM exit 130/143 through it; the trailing unconditional checkout removed. Verified: an INT to the process group mid-suite leaves the tree clean.
DEP-1..4, HT-6 | tests/unit/deploy-tooling.test.js | Five pins (DEP-4 and DEP-2 behavioural and hermetic: no clasp call, no tree write); all five fail against HEAD.

TEST RESULTS: passed -- `npm run ci` 2118/2118 + INV-16 guard + module-deps --check; `CI=true npm run lint:gas` clean; bare `TZ=UTC node --test` 2118/2118; `npm run ci:ui` all stages passed (drive-smoke 131/131, drive-agent 26/26).
REGRESSION RISKS:
- HT-5: triggers now persist across tests WITHIN a suite (a live set, like production). A future installer test that assumes an empty project must reset state.triggers in its install() -- today's suites all pass, and five suites still carry their own ScriptApp doubles.
- HT-4: a new production formatDate pattern with an unmodelled letter (e.g. EEE) now throws in tests until modelled -- intended.
- HT-3: a test that deliberately caches an oversized payload now sees the throw the production code already try/catches.
- DEP-2: deploy.sh now refuses a project dir outside the repo and always runs its gates from the repo root (previously from the caller's cwd, which the docs already required to be the root).
- DEP-3: warnings only by default; nobody's deploy flow is blocked unless STRICT_DEPLOY=1.
- CL-9: two more boots in drive-smoke (~15 s added to ci:ui).
INVARIANTS AT RISK: None. INV-16 untouched (no duplicated file edited); INV-36 gains a behavioural pin; no production .gs file changed.
NET SCORE: 1 production fix (DEP-2: `scripts/deploy.sh .` run from inside a sibling dir, or a './' spelling, shipped a wrong or "unstamped" build stamp) − 0 new failure modes = 1. Every other item hardens tests/tooling; none exposed a live bug.

OPERATOR ACTIONS / DEPLOY:
- None. No Apps Script project changed; nothing to push.
Deploy: N/A -- no Apps Script file modified (tests, tooling and CI only). deploy.sh's new behaviour applies from the next deploy of any project.

FOLLOW-ON ITEMS:
- Five suites (alerts-readiness, digest-freshness-gate, neon-retention, sheet-coverage, system-health) still hand-roll a ScriptApp trigger double that the shim now models; they could drop it, outside this batch's scope.
- Lock timeout limits and the CacheService TTL cap (21600 s) are not modelled; neither was in HT-3/HT-5's text.
- drive-smoke's phone pass covers the three top-level pages, not the modals; a 360 px modal pass would be the next step if phone use grows.

DOCUMENTATION UPDATES NEEDED:
- Done in this batch: tests/README.md (harness strictness notes + two coverage-map entries), tools/ui-harness/README.md (360 px pass), README.md (deploy.sh dir spellings, dirty/branch warnings, STRICT_DEPLOY), CLAUDE.md (two one-clause notes in Key commands).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
