---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R39 — Direct Call step cost on a Manual Export: (A) `dcWriteSheet_` deletes the date's rows as contiguous blocks instead of one `deleteRow` per row; (B) `dcUpsertRows_` emits inline literals through the shared `neonInsertInline_` with the original bound statement kept as the oversize fallback.
Files modified: apps-script/cdr-import/directCallMetrics.js, tests/harness/fakeSheet.js, tests/unit/direct-call-backfill.test.js, tests/unit/direct-call-metrics.test.js, CLAUDE.md, docs/per-call-capture.md, tests/README.md, docs/fix-history.md

CHANGES:
R39-A | directCallMetrics.js | `dcWriteSheet_`: same single date-column `getDisplayValues` read and the same F-3 ISO-normalized match; matches are grouped into contiguous blocks and removed with `deleteRows` bottom-up. `deleted` keeps its C-5 meaning; the append is unchanged. No re-pad (the old per-row delete shrank capacity too, so the post-state is identical).
R39-B | directCallMetrics.js | `dcUpsertRows_`: dedupe unchanged, then `neonInsertInline_(conn, DIRECT_CALL_UPSERT_HEAD_, DIRECT_CALL_UPSERT_TAIL_, rows, dcInlineTuple_, dcBoundUpsert_)` + a log line with the statement/fallback counts. The SQL was split byte-identically into head/tail; `dcBoundUpsert_` is the original prepare/bind/execute; `dcInlineTuple_` renders the 4 text values via `neonSqlLit_` and the 14 metrics via `String(v | 0)` (the setter's coercion, deliberately not `neonSqlInt_`). The caller still owns the transaction; the authoritative single-bind DELETE is untouched. The helpers come from `neonWrite.js` in the same project, so no INV-16 edit.
R39-T | fakeSheet.js, two suites | Fake `deleteRow` / `deleteRows` now keep the `_displays` grid in step with `_data`. The backfill suite's fake conn records inline statements and decodes tuples; new pins: inline == bound value-for-value (quotes, the `$nq$` tag collision, NULL month, the `v | 0` coercions), size packing under the JDBC cap with the caller-owned transaction, and the oversize-row fallback. The metrics suite pins the block delete (split blocks bottom-up, `deleteRow` never called, other dates kept in order).

TEST RESULTS: passed — node --test 1231/1231; INV-16 guard clean (neonWrite.js untouched).
REGRESSION RISKS:
- `directCallMetrics.js` now calls `neonSqlLit_` / `neonInsertInline_` / `neonInlineNote_` from `neonWrite.js`. Both files are always present in the cdr-import project (global scope), and the backfill suite already loaded both; a future suite that calls the Neon path with only `directCallMetrics.js` loaded would ReferenceError, which is a test-setup error, not a production one.
- Postgres type inference for the inline `isoDate` literal into the `date` column: a dollar-quoted literal is `unknown`-typed and coerces exactly as the old `setString` did.
- `deleteRows` on a sheet with a filter view or protected range differs from per-row `deleteRow` only in batching; `Direct Call History` carries neither.
INVARIANTS AT RISK: INV-16 not touched (no duplicated file edited). INV-44 untouched (the Pipeline Health `processIntegratedHistory:Direct` row keeps its shape). INV-02 not applicable (the writer receives parsed seconds).
NET SCORE: 1 − 0 = +1 (the ~4 min Direct block fired on every Manual Export of the owner's Aug 20–31 reprocessing this week; the bound fallback + parity pin close the escaping failure mode before it ships).

OPERATOR ACTIONS / DEPLOY:
- Acceptance: deploy cdr-import, run Manual Export for ONE remaining August date, read the `processIntegratedHistory:Direct` Pipeline Health row's durationMs (expect well under a minute) and confirm `neon=ok` in its notes; then `runNeonCoverageCheck` after the batch confirms `direct_call_history` counts. | BLOCKS DEPLOY: N (blocks the next Manual Export)
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`). cdr-report and the dashboard are untouched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The daily block, the inbound capture and the outbound capture each call `rawDataSheet.getDataRange().getDisplayValues()` separately (three full Raw Data reads per import); one shared read would save a few seconds each. Out of scope (touches the inbound/outbound blocks).
- The manual export's closing `ui.alert` keeps the execution clock running until it is dismissed, which inflates the reported duration; cosmetic.
- `writeInboundCallsToNeon` / `writeOutboundCallsToNeon` already inline (their own `icSqlStr_` family); no change needed.

DOCUMENTATION UPDATES NEEDED:
- Done in this PR: CLAUDE.md Neon write discipline rule (2) names the Direct writer + `dcBoundUpsert_` (bullet stays under the 4 KB ratchet); docs/per-call-capture.md Direct section; tests/README; fix-history R39 row.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
