---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E2 is an expansion batch -- new capability only)
New capabilities (G/ST):
- ST3 one compare gate: parityGate_ (Util.gs) owns the three flip-gate rules -- duplicates fail by name, `compared` = keys on BOTH sides, an empty sheet side is INCONCLUSIVE -- and every key-by-key flip gate reaches its verdict through it (compareDqeSources_, compareQcdSources_, and the three compare*ConfigSources via the configSourceCompare_ shim, which opts into emptyMeans:'clean'); a sweep fails a new compare*Sources gate that skips it
- ST1 queue-anchor sweep: cache-version-sync now requires every cache in a file that reads queue data to be classified (QUEUE_SPECS); an "embeds" cache's file must carry ':q' + qcdFreshnessTag_() AND check qcdSnapshotReadFailed_() before its put; every QCD reader a cached surface calls must note a swallowed throw and flag an empty-grid branch (F5); and every function reading the QCD grid must be a flagging reader or a documented exemption
Files modified: apps-script/department-dashboard/{Util.gs, NeonRead.gs, QCDReport.gs}, tests/unit/{parity-gate.test.js (new), cache-version-sync.test.js, dal-cutover.test.js}, tests/README.md, docs/{known-issues.md, module-dependencies.md}, CLAUDE.md, .cycle/STATE.md

CHANGES:
ST3 | Util.gs | New PURE parityGate_(sheetEntries, neonEntries, {diff, emptyMeans}) -> {clean, inconclusive, compared, missingInNeon, extraInNeon, mismatched, mismatchedKeys, duplicates, roundingOnly}; configSourceCompare_ becomes a shim over it (same return shape and log line).
ST3 | NeonRead.gs | compareDqeSources_ builds [date|agent, row] entries and passes its FIELDS diff as the callback; INCONCLUSIVE comes from gate.inconclusive; logs, verdict shape and operator advice unchanged.
ST3 | QCDReport.gs | compareQcdSources_ builds [date|queue|source, row] entries; the exact-count + ±1 s duration tolerance is the diff callback (rounding -> roundingOnly); verdict shape unchanged.
ST3 | tests/unit/parity-gate.test.js (new), dal-cutover.test.js | 6 helper tests + the compare*Sources sweep (inventory pinned); a DQE value-mismatch test (no gate test had a differing field before -- a bite exposed it).
ST1 | tests/unit/cache-version-sync.test.js | QUEUE_SPECS (summary / insights / companyOverview / overviewChartYtd embed; qcdAll exception; latestDate(s) / deptExts / inbound / inboundHeatmap none) + the producer-side flag sweep over computeDeptQcdSnapshot_ / computeQcdSnapshots_ / computeQcdReport_ + the QCD-grid reader inventory with 4 documented exemptions. No production code needed changing: every current surface already met the contract.
Docs | known-issues.md, CLAUDE.md, tests/README.md | the one-gate rule and the `compared` / first-occurrence semantics; the CacheService bullet names the put-skip and its ST1 enforcement; parity-gate joins the suite map.

TEST RESULTS: passed -- 2510 tests, 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean; module-deps regenerated (--check clean); claude-md-split clean (one over-budget wording caught and compressed). ci:ui not run: no client file changed. Bites 15/15 after two corrections: one QCD bite of mine was an invalid mutation (deleting an `if` before an `else` -- a syntax error, redone as `if (false)`), and the DQE field-diff bite exposed a pre-existing gap (no gate test with a differing field), closed with a new test.
Regression scenarios: none walks a parity gate or a cache put directly; the gate verdict shapes and log lines the operator reads (Operator State #19 / #25 / #30) are unchanged, so S36 (Dept Config) and the flip runbooks are unaffected.
REGRESSION RISKS:
- `compared` now means keys on BOTH sides for the DQE / QCD gates (was: sheet-side keys). Identical on every clean run; on a run with rows missing in Neon it is lower, and the verdict stays MISMATCH.
- A duplicated key's FIRST occurrence is compared on every gate (DQE / QCD used the last); a duplicate fails the gate either way.
- QCD's "sheet rows (in window)" log line counts rows (was unique keys) -- differs only when the sheet holds duplicates, which the DUPLICATE line names.
INVARIANTS AT RISK: None. INV-30 untouched (no key or version changed). The gates stay admin-gated editor tools; nothing writes.
NET SCORE: 0 − 0 = 0 (ST1/ST3 are new capabilities, not production fixes; no new failure mode -- the `compared` change is documented and stricter)

OPERATOR ACTIONS / DEPLOY:
- None. The gates read the same way; Operator State #19 / #25 / #30's contract (clean:true AND compared > 0) is unchanged.
Deploy:
- Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version (gate-only change; no rush -- it matters at the next parity run)
- CDR DQE Pipeline / CDR Reporting Tools / CDR Import: no change

FOLLOW-ON ITEMS:
- getAgentHome calls computeSummary_ WITH sections, so it computes the QCD snapshot and CSR transfer tile it then discards (agentHomeTeamBlob_ keeps rows + totals). Passing { sections: false } would save a QCD grid read per agent-app load; it also means a QCD read throw there sets the degraded flag without affecting that payload.
- The outbound source probe (Operator State #74) and runNeonCoverageCheck are tolerance / per-date reconciliations, not key-by-key gates, and stay outside parityGate_ by design (each already has its own minimum-evidence rule).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
