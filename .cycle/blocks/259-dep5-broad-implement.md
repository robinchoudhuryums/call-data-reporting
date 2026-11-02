---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: DEP-5 (owner 2026-11-02) -- a dashboard deploy failed with "Cannot create more versions: Script has reached the limit of 200 versions"; deploy.sh now counts the project's versions before it rolls a deployment.
New capabilities (G/ST): None
Files modified: scripts/check-version-limit.mjs (new), scripts/deploy.sh, tests/unit/deploy-tooling.test.js, tests/README.md, docs/operator-state.md (#2), docs/fix-history.md, CLAUDE.md (deploy-helper notes)

CHANGES:
DEP-5 | scripts/check-version-limit.mjs | PURE exported `countVersions(out)` (clasp 2's "~ N Versions ~" header, "Found N versions", "N - description" lines, "No deployed versions" = 0, else null); runs `clasp versions`, then `clasp list-versions` on failure; warns from VERSION_WARN_AT (180), exits 2 at VERSION_LIMIT (200) with the editor cleanup steps; an unreadable count (no clasp, not logged in, unknown output) is reported and exits 0.
DEP-5 | scripts/deploy.sh | runs the check only when a deployment id is set, after the redundant-run guard and BEFORE the CI gates and the push, so a full project never pushes code it cannot serve; VERSION_WARN_AT documented in the header.

TEST RESULTS: `TZ=America/Chicago node --test` 2774 pass / 0 fail (+4); lint:gas clean; module-deps up to date. Bites 5/5 (the refusal, the header parse, the list-versions fallback, the deployment-id-only gate, the check ahead of the push). No client file changed.
REGRESSION RISKS: (1) a deploy at 200 versions now stops before the gates instead of failing after the push -- the intended change. (2) A clasp whose output shape is unknown is skipped with a note, never blocks. (3) Versions made in the editor count but are not checked there.
INVARIANTS AT RISK: None (tooling only).
NET SCORE: 1 − 0 = 1 (the owner hit the cap this deploy)

OPERATOR ACTIONS / DEPLOY:
- Now: Manage deployments -> note the live version; Project History -> delete the oldest versions (keep the live one and the last ~20); then redo the deploy | BLOCKS DEPLOY: Y (the cap blocks every dashboard deploy until cleared)
Deploy: N/A -- tooling; takes effect the next time scripts/deploy.sh runs from this checkout

FOLLOW-ON ITEMS:
- None

DOCUMENTATION UPDATES NEEDED:
- None (Operator State #2, CLAUDE.md deploy notes, fix-history DEP-5, tests/README updated)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
