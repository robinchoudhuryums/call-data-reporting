---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: PROPS-1 -- Health row for the Script Properties store's 500 KB total quota; ESC-G1 -- source sweep: every public escalation write verb refuses a removed copy or is a reasoned exemption (both from reflect 207-211)
Files modified: apps-script/department-dashboard/SystemHealth.gs, apps-script/department-dashboard/Escalations.gs (comment only); tests/unit/system-health.test.js, tests/unit/escalations-hardening.test.js; CLAUDE.md (capacity rows: three -> four), docs/invariants.md (INV-55 enforcement), docs/operator-state.md (#53), docs/fix-history.md, docs/module-dependencies.md (regenerated), tests/README.md, .cycle/STATE.md

CHANGES:
PROPS-1 | SystemHealth.gs | PROPS_STORE_CAP_BYTES_ (500 KB) / PROPS_STORE_WARN_PCT_ (80); pure propsUtf8Bytes_ (UTF-8, surrogate pairs = 4) and propsStoreUsage_ (total, %, top-3 key FAMILIES with numbered chunks folded to "<prefix>*"); a 'props-store' row in the visible CONFIG section (ok/warn at 80%, hint leads with what breaks at 100%), built from the inventory's existing getProperties() read -- sizes only, never a value
ESC-G1 | escalations-hardening.test.js (+ Escalations.gs pointer comment) | sweeps every public function in Escalations.gs that contains conn.commit(); fails unless it calls escAssertNotRemoved_ or is in ESC_REMOVED_GUARD_EXEMPT with a reason (create / remove / restore / delete / approve / reject / backfill); also fails on a STALE exemption

TEST RESULTS: passed -- node --test 1974/1974 (4 new), INV-16 guard OK, module-deps regenerated, lint:gas clean, ci:ui all stages passed; 7 bite mutations (new unguarded verb, dropped guard, stale exemption, no family folding, no warn, wrong section, no surrogate handling), each red
REGRESSION RISKS: None -- one extra row in the Health payload (same getProperties() read, no new I/O); the sweep is test-only
INVARIANTS AT RISK: None (INV-55 now test-enforced for the removed-copy rule; the Health payload stays value-free, pinned)
NET SCORE: 0 production fixes − 0 new failure modes = 0 (structural: turns reflect 207-211's two Low failure modes into a visible signal and a CI tripwire)

OPERATOR ACTIONS / DEPLOY:
- After deploying, open Admin -> Health and read the new "Script Properties storage" row once (it reports today's real usage for the first time) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- Failure mode (a) from reflect 207-211 -- escalation reads depend on best-effort ADD COLUMN DDL -- has no signal yet (out of scope: neither follow-up covered it)
- INV-57 "one copy per department per group" is still code-only; a partial unique index on (group_id, department) would make the database enforce it

DOCUMENTATION UPDATES NEEDED:
- None
---END BROAD SCAN IMPLEMENTATION SUMMARY---
