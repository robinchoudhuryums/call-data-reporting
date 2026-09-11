---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Roadmap parallel track (Neon storage decision) | Health page `neon-storage` row "Neon storage by table": `pg_database_size` + every public table's `pg_total_relation_size` in ONE json round trip on the page's shared connection (R21), top 5 named largest-first; informational (muted) until `NEON_STORAGE_CAP_MB` is set, then ok / warn at 80% (the egress gauge's rule); unreachable Neon -> muted (the mirror + retention-risk rows already warn); a throwing reader -> its own warn row; unconfigured / fast part / helper absent -> no row

Files modified:
- apps-script/department-dashboard/NeonRetention.gs (`neonStorageByTable_`, `neonStorageMb_`, the pure `neonStorageVerdict_`)
- apps-script/department-dashboard/SystemHealth.gs (the row, after retention-risk inside the shared-conn block)
- apps-script/department-dashboard/Config.gs (`NEON_STORAGE_CAP_MB` registered as operator)
- tests/unit/neon-retention.test.js (+3), tests/unit/system-health.test.js (+3), tests/README.md
- CLAUDE.md (capacity-rows sentence -> three; Operator State index #57; the System Health bullet trimmed back under the 4 KB ratchet), docs/operator-state.md (#57 (d)), docs/next-steps.md (parallel track's code half SHIPPED), docs/module-dependencies.md (regenerated), .cycle/STATE.md

CHANGES:
storage-read | NeonRetention.gs | `neonStorageByTable_(conn)`: one `createStatement` + `setQueryTimeout(20)` + one `rs.getString('j')` of a `json_build_object('db', pg_database_size(current_database()), 'tables', json_agg(... ORDER BY pg_total_relation_size DESC) FROM pg_class JOIN pg_namespace WHERE nspname='public' AND relkind IN ('r','p'))`; nameless entries dropped; defensive re-sort; a JDBC error PROPAGATES (never a fake zero)
storage-verdict | NeonRetention.gs | `neonStorageVerdict_(reading, capMb)` -> `{status, value, hint, pct, dbMb}`: `"<db> MB on disk[ — <pct>% of the <cap> MB cap] · top: t1 x MB, …"`; hint always carries FLOOR (history retention invisible to any in-DB query) + "a DELETE never moves it (TRUNCATE / VACUUM FULL only)" + the #57 levers; warn prepends "at 100% every Neon WRITE fails while every read still says reachable"
storage-row | SystemHealth.gs | typeof-gated on both helpers; reads the cap via `PropertiesService.getScriptProperties()` DIRECTLY -- the section's `props` var is assigned only inside the FIRST `part !== 'neon'` range, so a `part:'neon'` load (what the client actually sends for this half) would have thrown "probe failed"; the new system-health test caught it on its first run
registry | Config.gs | `NEON_STORAGE_CAP_MB: 'operator'` (prop-registry S1/S2 green)

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 1357/1357 (1351 + 6 new); INV-16 guard in sync; claude-md-split / cross-file-pins / prop-registry / cache-version-sync green. NB this container has no TZ set: one PRE-EXISTING test (`neon-write-mapping` Batch 4 free-form date, `new Date('May 19, 2026')`) fails under UTC and passes under the CI zone -- the suites legitimately assume process TZ == script TZ (roadmap 1a's note), not a regression. `npm run ci:ui` NOT run (playwright absent here) and not needed: no client / payload-shape change -- gen-phase3.js's file list omits NeonRetention.gs, so the harness payload carries no `neon-storage` row (typeof gate) and every driver assertion is unchanged. Mutations 6/6 killed: cap read from the fast-part `props` var (the real bug above); unreachable -> warn (test expects muted); reader throw swallowed to a zero reading (propagation test); `pg_relation_size` instead of `pg_total_relation_size` (SQL pin); top list uncapped (top-5 pin); warn threshold 90% (80%-exact case). Regression Scenarios overlapping SystemHealth.gs: none by name (the Health page has no S# scenario); the live check is Operator State #57 (d): open Admin -> Health, the row renders muted with the top-5 list, set `NEON_STORAGE_CAP_MB=512`, reload -> ok/warn with a percentage.

REGRESSION RISKS:
- One more statement on the Health page's neon half per load (~1 KB payload, catalog-only, 20 s query timeout); the page already pays the connection. No egress note (the egress gauge counts report payloads; a catalog read is not a consumer to rank).
- `pg_class` / `pg_namespace` are readable by every role; `pg_database_size(current_database())` needs CONNECT on the database, which the writer role has. If Neon ever restricts it, the row degrades to its own warn ("probe failed: permission denied…") and nothing else on the page moves.
- The CLAUDE.md System Health bullet was trimmed (two illustrative lists) to stay under the 4 KB ratchet; no rule was removed.

INVARIANTS AT RISK: INV-01 (read-only; `getSystemHealth` stays admin-gated at the top); the R21 shared-connection rule (rides `sharedNeonConn`, no second handshake -- pinned); the JDBC one-getString rule (pinned); INV-30 (no cache involved -- the Health page is uncached). None violated.
NET SCORE: 1 (the fast-part `props` scope trap surfaced by the test) − 0 = 1
