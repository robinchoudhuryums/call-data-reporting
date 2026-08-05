---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- #7 | neonbackfill.js carried 3 raw NUL bytes (two string-literal dedupe-key separators, one comment) making git treat the file as BINARY -- every diff/review of it opaque, including the function-level sanitize*ForNeon_ guard's target -- replaced with \u0000 escapes (behavior-identical; the F-8 class from Round 15's sheetRepairs.js fix)
- #5 | one-time localStorage orphan-prefs sweep: sweepOrphanPrefs_() (first call in init()) deletes the SIX documented dead keys (cdr.pr.prefs.v1, cdr.cr.prefs.v1, cdr.qcd.datalabels, cdr.dept.subscope, bare cdr.ins.prefs.v2, bare cdr.ir.prefs.v1); read-before-remove keeps the steady state write-free, superseding the documented "left in place" ruling on cdr.dept.subscope with the owner's #5 selection
- #4 | script.html (1.06 MB, ~21K lines, ONE IIFE) split into 11 raw-JS fragment includes (script-1-core ... script-11-qcd-boot) assembled into the SAME single script element / single IIFE by a now template-evaluating include_ (Code.gs); the partition is byte-identical to the old body, so runtime semantics are provably unchanged while per-edit blast radius drops to one 37-200 KB fragment

Files modified:
- apps-script/cdr-report/neonbackfill.js (#7)
- apps-script/department-dashboard/script.html (now the ~45-line assembler; #5's sweep lives in the script-2-chrome fragment)
- apps-script/department-dashboard/script-{1-core,2-chrome,3-overview,4-nav,5-dept,6-ir,7-admin,8-insights,9-inbound-direct,10-escalations,11-qcd-boot}.html (NEW -- the fragment family)
- apps-script/department-dashboard/Code.gs (include_ -> createTemplateFromFile().evaluate())
- tools/ui-harness/build-harness.js (resolveIncludes_ nested-include resolver)
- tests/unit/html-include-structure.test.js (4 new pins), tests/unit/cross-file-pins.test.js (UI-flag search reads the fragment family)
- docs/client-ui-conventions.md ("The assembled client" section + orphan-key passages), CLAUDE.md (test-list + ci:ui notes; Key-commands section only, no ratcheted bullet touched)

CHANGES:
#7 | apps-script/cdr-report/neonbackfill.js | 3 raw NULs -> \u0000 escapes; file is text to git again; node --check clean; check-duplicated-files.sh clean
#5 | script-2-chrome.html (authored pre-split in script.html), docs | sweepOrphanPrefs_() + init() call; the six-key dead list with the safety analysis in comments (bare prefs keys can never be live -- irPrefsKey_/insPrefsKey_ always append ':<email>'; cdr.ov.cardperiod/tableperiod.v1 deliberately NOT swept, still R12-19 migration seeds)
#4 | script.html + 11 fragments + Code.gs + build-harness.js + 2 test files | assembler pattern; include_ evaluates templates so includes nest; harness resolves includes itself; pins: per-fragment purity (no script tags / no scriptlets -- evaluation makes a stray scriptlet EXECUTE at render; styles.html pinned scriptlet-free too since it rides the same helper), include-list<->disk parity BOTH directions (a fragment on disk but not included silently drops its features), node --check of the assembled body

TEST RESULTS: passed -- node --test 635/635 (631 -> 635: +4 structure pins), INV-16 guard clean, node --check clean on neonbackfill.js and the assembled client body. npm run ci:ui FULL PASS (drive-smoke both roles + view-as, drive-f13 keyboard walk, drive-devoverlay probe, drive-subqueue incl. both CSV shapes) against the assembled client. New pins mutation-verified: closing-tag pattern in a fragment / stray fragment on disk / mid-fragment syntax break each fail the suite. Regression Scenarios: client scenarios' automated equivalents (the four asserting drivers) pass; the assembly is byte-identical so client behavior is unchanged except the #5 sweep -- the manual scenario walk applies at deploy time as usual.

REGRESSION RISKS:
- include_ now template-evaluates everything it includes (styles.html + the fragments, incl. access_denied.html's styles include): a scriptlet-open sequence in any included file executes server-side at render. Mitigated by the purity pins (fragments + styles.html); scriptlet-free evaluation returns content verbatim, so today's output is byte-identical.
- A missing fragment file at render would break the dashboard; mitigated by the list-parity pin and build-harness's hard error.
- ~12 template evaluations per doGet instead of 2 getContent() calls -- pure-literal templates, negligible vs. request cost; noted in case profiling ever looks at render time.
- #5: deleting a LIVE key would be user-visible data loss; verified impossible for the six listed (bare-key derivation analysis in the code comment).

INVARIANTS AT RISK: None violated. INV-17: NO file was removed (script.html remains as the assembler) so no web-editor deletion is needed -- the fragments are additive. INV-01: include_ keeps its trailing underscore (RPC-unreachable). The scriptlet-escape gotcha: the assembler's header comment deliberately spells the dangerous patterns in words so the (now-evaluated) file cannot contain them. No aggregation rules touched -- no INV-30 bumps.

NET SCORE: 0 − 0 = 0 (all three are maintainability/hygiene: #7 restores diffability, #5 is storage hygiene, #4 is blast-radius reduction on the least-tested surface; no production-firing bug was fixed and the new failure modes introduced by evaluation/assembly are each test-pinned).

OPERATOR ACTIONS / DEPLOY:
- None beyond the standard deploy; explicitly NO web-editor file deletion (script.html was kept as the assembler) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (picks up the 11 new fragment files + Code.gs + script.html). CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (#7). N/A for cdr-import / dqe-report this batch.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The remaining Round-16 recommendations by priority: #8 (Neon backup as a HARD precondition before any sheet trim -- runbook edit), #1 (post-soak flag-retirement pass), #2 (dqe-report decommission scheduling), #3 (INV-16 build-time copy in deploy.sh), #6 (automate syncInsuranceNumbersToNeon), #9 (NeonMirror payload-mapping test), #10 (usage-telemetry review after 30-60 days), #11 (CLAUDE.md F8 shrink of the two biggest bullets).
- Fragment granularity: script-8-insights is 200 KB; if Insights keeps growing it can be sub-split later -- the parity pin makes that a mechanical, test-guarded operation.
- The fragment map lives in script.html's header comment; keep it current when fragments change (noted in docs/client-ui-conventions.md).

DOCUMENTATION UPDATES NEEDED: None outstanding -- docs/client-ui-conventions.md gained the authoritative "The assembled client" section + the updated orphan-key passages; CLAUDE.md's test-list and ci:ui re-run notes were updated in the Key-commands section (no ratcheted bullet grew); CLAUDE.md's existing orphan-key mentions remain true (the keys ARE orphans; the sweep is documented at the authoritative doc).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
