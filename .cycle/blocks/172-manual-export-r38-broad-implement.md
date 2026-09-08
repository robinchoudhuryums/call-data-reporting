---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R38 — Manual Export cost: (A) inline-literal daily Neon writers (DQE / QCD / CDR) with the bound-param insert kept as the per-row oversize fallback; (B) `deleteHistoricalRowsForDate` deletes contiguous row blocks instead of rewriting each historical sheet in full.
Files modified: apps-script/cdr-import/neonWrite.js, apps-script/cdr-report/neonWrite.js (byte-identical, INV-16), apps-script/cdr-import/autoImport.js, tests/harness/fakeSheet.js, tests/unit/neon-write-mapping.test.js, tests/unit/neon-write-chunking.test.js, tests/unit/force-delete-rows.test.js (new), CLAUDE.md, tests/README.md, docs/fix-history.md

CHANGES:
R38-A | neonWrite.js (both copies) | New shared helpers `neonSqlLit_` (dollar-quoted, tag lengthened on collision, NUL stripped, null/undefined -> NULL), `neonSqlInt_`, `neonSqlNum_`, `neonSqlJson_`, `neonSqlDate_`, `neonInsertInline_` (packs tuples by size under `NEON_INLINE_STMT_CHARS_`=30000; a tuple over the cap alone goes through the caller's bound fallback; returns {statements, fallback}; no commit), `neonInlineNote_`. Each writer's SQL was split byte-identically into `*_INSERT_HEAD_` / `*_INSERT_TAIL_`; the original setter loops moved verbatim into `dqeBoundInsert_` / `qcdBoundInsert_` / `cdrBoundInsert_`; `dqeInlineTuple_` (35 cols) / `qcdInlineTuple_` (12) / `cdrInlineTuple_` (21, HMAC-gated JSONB) mirror the setters' order and null rules. Dedupe (IMP-6), authoritative deletes (IMP-5/P-6), the phones path (R27 gate, IMP-4) and the single commit are unchanged; the log line adds the statement/fallback counts.
R38-B | autoImport.js | `deleteHistoricalRowsForDate` reads only the date column, runs the identical match (Date branch + P-8 `parseHistoryDateCell_`), groups matches into contiguous blocks, `deleteRows` bottom-up, re-pads to the previous `getMaxRows`; same return count (the P26 loss guards key on it) and log shape.
R38-T | fakeSheet.js, three suites | Fake sheet honors `_maxRows` in getMaxRows/deleteRow, gains `deleteRows` (throws out of range) + `insertRowsAfter`. Writer suites decode inline tuples instead of pinning setter calls; new pins: escaping, inline == bound parity for all three writers, oversize-row fallback, per-statement size cap. New `force-delete-rows.test.js` (split blocks, text + Date cells, count, untouched rows, capacity, single-column read).

TEST RESULTS: passed — node --test 1228/1228; INV-16 guard clean (both neonWrite.js copies + sanitizer/time-decode pairs in sync).
REGRESSION RISKS:
- A value whose SQL literal form differs from the bound form would change stored data silently. Mitigated: the parity test drives the same rows through both paths and compares value-for-value (ints via parseInt, doubles via Number with the old `|| 0` semantics, dates regex-checked, text byte-exact under dollar quoting).
- Postgres type inference on inline literals (e.g. an unquoted number into a text column) differs from bound params; the tuple builders quote text columns explicitly and cast dates/JSONB. Live acceptance is the parity gate (below).
- `deleteRows` on a sheet with protected ranges/filters behaves differently from a setValues rewrite (a filter view could hide rows; protections throw). None of the five historical sheets carry either today.
- The sheet is no longer padded with blank rows in place of the deleted ones between data rows: rows shift up. Any reader that cached ROW NUMBERS across a force-delete would be off; none does (every reader re-scans).
INVARIANTS AT RISK: INV-16 (both copies edited together; guard clean). INV-02/INV-20 untouched (writers receive already-parsed seconds/strings). INV-44 untouched (Pipeline Health rows keep their shape).
NET SCORE: 1 − 0 = +1 (the 1003 s Manual Export fired on every date of the owner's Aug 20–31 reprocessing this week; the bound fallback + parity pin close the escaping failure mode before it ships).

OPERATOR ACTIONS / DEPLOY:
- ACCEPTANCE GATE before continuing the Aug 20–31 reprocessing: deploy both projects, run Manual Export for ONE August date, then `runDqeParityCheck` + `runQcdParityCheck` over that date; continue only on CLEAN, otherwise revert the PR and report the mismatch. | BLOCKS DEPLOY: N (blocks the next Manual Export)
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`); CDR Reporting Tools / CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`. The dashboard is untouched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The inbound-call derivation (~3.7 min of the 1003 s) is untouched; it is the remaining Manual Export cost after this change.
- `writeInboundCallsToNeon` / the outbound and direct writers still bind params; same treatment applies if their share grows.
- The deferred mirror (NeonMirror.js) reaches the new inline path through the same writers with no change of its own.

DOCUMENTATION UPDATES NEEDED:
- Done in this PR: CLAUDE.md Neon write discipline rule (2) rewritten for the inline family + one sentence on the force-delete under the force-path guard bullet (bullet trimmed under the 4 KB ratchet; the P-2 PHI healing note moved to fix-history); tests/README suite map; fix-history R33…R38 section.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
