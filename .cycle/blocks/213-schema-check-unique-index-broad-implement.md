---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: ESC-DDL -- the escalations linked-copy column migration is logged on failure and verified by a Health row; ESC-U1 -- a partial unique index makes the database enforce one copy per department per linked group (both the follow-on items from blocks 211-212 / reflect 207-211)
Files modified: apps-script/department-dashboard/Escalations.gs, apps-script/department-dashboard/SystemHealth.gs; tests/unit/escalations-hardening.test.js, tests/unit/system-health.test.js; docs/invariants.md (INV-55), docs/operator-state.md (#24), docs/fix-history.md, docs/module-dependencies.md (regenerated: SystemHealth -> Escalations edge), tests/README.md, .cycle/STATE.md

CHANGES:
ESC-DDL | Escalations.gs | ESC_REQUIRED_COLUMNS_ / ESC_GROUP_DEPT_INDEX_; escEnsureTable_'s linked-copy column catch now Logger.logs the cause (still best-effort, no longer silent); escSchemaRead_ (one metered read of information_schema.columns + pg_indexes for the table, current_schema()); pure escSchemaVerdict_ (no table -> muted; missing columns -> warn, "every escalation save and live Activity fail" + console fix; missing index -> warn + the duplicate-finding query; else ok)
ESC-DDL | SystemHealth.gs | 'esc-schema' row in the Neon section on the SHARED connection (R21), typeof-guarded; unreachable -> muted; probe throw -> warn
ESC-U1 | Escalations.gs | CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_group_dept ON escalations (group_id, department) WHERE group_id IS NOT NULL -- partial (standalone rows NULL), NON-concurrent (a duplicate-hit build rolls back whole, no invalid index), in its OWN try so duplicates never block the columns; failure logged
tests | 5 new tests (index DDL shape, logged-not-silent + independent tries, verdict branches, metered read, Health row on the shared conn / muted / warn); 6 valid bite mutations, each red (one invalid syntax-error mutation re-run as a valid rethrow)

TEST RESULTS: passed -- node --test 1979/1979, INV-16 guard OK, module-deps regenerated, lint:gas clean, ci:ui all stages passed
REGRESSION RISKS: (1) if duplicate (group_id, department) copies already exist, the index build fails on EVERY escalation call (one failed statement each, logged) until resolved -- surfaced by the esc-schema row; (2) a write that would create a duplicate now fails at the database with a "duplicate key" message instead of succeeding -- only reachable if a verb's own check is bypassed
INVARIANTS AT RISK: None (INV-55 strengthened; OD-3 metering kept -- the new read is labelled 'escalations')
NET SCORE: 0 production fixes − 0 new failure modes = 0 (structural: closes reflect 207-211's remaining Low failure mode with a signal, and puts INV-57 in the database)

OPERATOR ACTIONS / DEPLOY:
- After deploying, open Admin -> Health and confirm the "Escalations schema" row (Neon section) reads ok | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- None

DOCUMENTATION UPDATES NEEDED:
- None (INV-55, OS #24, fix-history, tests/README updated)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
