---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (owner 2026-11-05, from the first all-dates direct-attribution run)
- DCA-3: a leg naming a roster person on an extension their cell does not list is theirs (reassigned / unlisted); a blank leg follows the one person an extension named that day
- DCA-4: the non-person filter matched "Parker" (call park) -- a current employee's direct calls were dropped
- DCA-5: a person on the Spanish AND CSR rosters is credited to their CSR row
New capabilities (G/ST): the attribution diagnostic's REASSIGNED section
Files modified:
- apps-script/cdr-import/directCallMetrics.js
- tests/unit/direct-call-metrics.test.js
- docs: operator-state.md (#83, #90), fix-history.md, per-call-capture.md; CLAUDE.md (#90 index)

CHANGES:
DCA-3 | directCallMetrics.js | `dcBuildExtMaps_` adds `nameCells` (every roster cell by name, name-only cells too); `dcNameIndex_` / `dcCellForName_`; `dcResolveAgent_` kinds `named` / `namedUnlisted` (extension-length, not a queue ext); `confirmBlank` credits `blankNamed` when the extension named exactly one person that day; events carry `otherAgent` so the Direct tab names the credited colleague; AT + diagnostic + build log count the new kinds
DCA-4 | directCallMetrics.js | `DC_NON_PERSON_RE_` words matched whole (`\bpark(ed|ing)?\b`, `call ?park`, `\bhunt\b`, `\bmenu\b`, ...); a name in the roster index is a person regardless
DCA-5 | directCallMetrics.js | `DC_DEPT_PREFER_ = { Spanish: 'CSR' }` + `dcPreferCell_` on every credited agent

TEST RESULTS: node --test 2824 pass / 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean; module-deps --check clean; bites 6/6 (named credit, park regex, Spanish prefer, Direct-tab colleague, blankNamed, extension-length guard)
REGRESSION RISKS:
- An internal 8x8 display name that equals a roster name on an unlisted short extension now credits that person (intended); outside numbers are never credited by caller-ID name.
- A roster name exactly matching a feature word phrase is now a person (intended; roster is authoritative).
INVARIANTS AT RISK: INV-24 (names still go through the same canonicalizer) -- not violated; INV-16 untouched (directCallMetrics.js is not duplicated)
NET SCORE: 2 production fixes (DCA-3 lost calls, DCA-4 Parker) − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- After the cdr-import push, run `rebuildDirectCallHeldDates()` again, then `diagnoseDirectCallAttributionAllDates()` | BLOCKS DEPLOY: N
- Add Outlier Fix aliases for the spelling variants (Alice (Ashmika) Shrivastava -> Shirvastava; Millie (Monisha) S. -> D. if the same person) | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- Dates older than the held Call_Legs_* tabs keep the old credit until re-imported (#56).
- DC_DEPT_PREFER_ covers Spanish -> CSR only; other parent/sub-queue pairs on request.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
