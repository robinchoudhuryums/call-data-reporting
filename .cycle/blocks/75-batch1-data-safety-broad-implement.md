---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- C-5 | Direct force-path had no zero-row loss guard — an empty roster read (empty ext maps) or any rebuild-to-zero silently erased the date's `Direct Call History` + `direct_call_history` under a success rows:0 row
- C-6 | Inbound/outbound calls with an unparseable first-leg timestamp were silently dropped with no counter — and an ALL-unparsed grid could pass the C-1 stray gate and trigger the zero-record DELETE (format-drift wipe)
- C-8 | `QCDR Output` sheet + `csr_team` named range had no null guards — a rename/lost-range null-dereffed the whole import with a message blaming the wrong layer
- C-9 | The inbound/outbound writers never reset `CDR_HMAC_CACHE_` — an `HMAC_SECRET` rotation could serve stale hashes from a warm instance until cold start

Files modified:
- apps-script/cdr-import/directCallMetrics.js (C-5: empty-map refusal throw; dcWriteSheet_ returns {written, deleted}; deletedExisting on the build result)
- apps-script/cdr-import/autoImport.js (C-5: rebuilt-to-zero failure rows on daily + bulk Direct blocks; C-6: allUnparsed refusal branch + unparsedDropped in success notes, both capture blocks; C-8: four named-error guards)
- apps-script/cdr-import/inboundCalls.js (C-6: writer-side unparsed counter + allUnparsed refusal + backfill failure class; C-9: memo reset)
- apps-script/cdr-import/outboundCalls.js (C-6: builder-side counter via array property — the builder drops date-less groups itself — + refusal + backfill class; C-9: memo reset)
- tests/unit/direct-call-metrics.test.js (F-3 pin updated to {written, deleted} + deleted-count assert)
- tests/unit/direct-call-backfill.test.js (new C-5 empty-roster refusal pin)
- tests/unit/inbound-calls.test.js, tests/unit/outbound-calls.test.js (new C-6 all-unparsed refusal pins)

CHANGES:
C-5 | directCallMetrics.js, autoImport.js | Input-validated refusal (P-3 discipline) when ext maps are empty — throws into the callers' Pipeline-Health catches; residual rebuild-to-zero-with-deletions logs a failure row AFTER the success row so System Health's most-recent-outcome classifier flags the step (log-only — P-5's legitimate force-to-zero still works)
C-6 | inboundCalls.js, outboundCalls.js, autoImport.js | Date-less records counted (inbound: writer filter; outbound: inside the builder via `records._unparsedDropped`, since it drops them pre-filter); partial drops ride success-row notes (the F9 discipline); an ALL-unparsed yield refuses the zero-record cleanup with `allUnparsed` (same semantics as C-1's `allStray`), surfaced by the daily import (failure row + email) and classified as a per-date failure by both backfills
C-8 | autoImport.js | `updateQcdrOutputSheet` / `calcQcdReport` / `calcCsrReport` throw named, actionable errors naming the missing tab/named range
C-9 | inboundCalls.js, outboundCalls.js | `CDR_HMAC_CACHE_ = {}` at writer entry (typeof-guarded), the A2 discipline

TEST RESULTS: passed — node --test 618/618 (was 615; +3 net new pins), INV-16 guard clean. No client files touched, so the ci:ui gate is unaffected (still green from the prior commit's run). Regression scenarios overlapping CDR Import (S5, S28, S33, S34, S38) are NOT APPLICABLE in this container (no live Apps Script/Sheets/Neon); the writers' behavior is unit-pinned, and the daily-caller branch chains should be spot-checked via Pipeline Health after the next deploy + import.

REGRESSION RISKS:
- dcWriteSheet_'s return type changed number → {written, deleted}. Both consumers updated (the one production callsite in buildDirectCallFromRaw_, the one test); grep confirms no other caller. buildDirectCallFromRaw_'s public result keeps `wrote` (unchanged name/meaning) and gains `deletedExisting`.
- The C-5 empty-map throw makes a previously-silent state loud: if an install legitimately had an empty roster (none does — every dept block carries extensions), the Direct block would now fail each run with a clear message instead of writing empty days. Accepted trade-off, consistent with M2.
- The C-6 all-unparsed refusal, like C-1, is conservative: stale Neon rows persist (recoverable, surfaced) instead of a possibly-wrong delete (unrecoverable).
- C-8 converts null-derefs into named throws on the same paths — the outer catches already logged + emailed; only the message quality changes.
- C-9 is behavior-identical except immediately after a secret rotation on a warm instance, where it is now correct.

INVARIANTS AT RISK: None. INV-16 untouched (no duplicated-pair file changed; guard clean). INV-44 respected (existing step names + status vocabulary; new note strings only). The P-5/F2/P-1/P-3 contracts are tightened, not altered; their existing pins all still pass.

NET SCORE: 0 − 0 = 0
(All four are latent hardening — none would demonstrably have fired this month; C-6's partial-drop counter may reveal drops already occurring, which is the point.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import | BLOCKS DEPLOY: Y (all four fixes live there)
- No new Script Properties, scopes, sheets, or triggers.
Deploy: scripts/deploy.sh apps-script/cdr-import <cdr-import-deployment-id> (dashboard/cdr-report unchanged by THIS batch; the increment-74 dashboard deploy is still pending separately)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The remaining Round-15 batches (2-10 + strategic) as listed at the close of increment 74 / the sync-docs reply — next up: Batch 2 (B-2 retirement-aware health tools, A-2, B-4).
- inbound builder asymmetry noted: inbound pushes date-less records for the writer to filter, outbound drops them in the builder — harmonizing them (builder-side counting for both) would simplify the C-6 plumbing but touches the record-building contract, so it was left alone.

DOCUMENTATION UPDATES NEEDED:
- None blocking. Optional: the CLAUDE.md F2 sentence now says "AND on ZERO stray-dated records (C-1 …)" — it could mention the C-6 all-unparsed arm too; deferred to the next /sync-docs to avoid another ratchet dance for one clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
