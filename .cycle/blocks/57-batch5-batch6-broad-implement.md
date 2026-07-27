---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch 5 + Batch 6 — PARTIALLY. Both batches are operator-gated by construction, so the deliverable is the code-level work that makes them safe and decisive, NOT the operator steps themselves.

**What could NOT be done here, and why (read this first):**
- Batch 5's core act is running `runInboundQcdParityCheck` against live Neon and judging the result. It is an editor-run function needing a live Neon connection, the deployed dashboard project, and an admin session. None exist in this environment. **The QCD-vs-inbound discrepancy is NOT resolved and I am not claiming it is.**
- Batch 6's core act is running each parity gate against live data and then setting a Script Property on a live deployment. I cannot execute Apps Script or set Script Properties. **No flag was flipped.** Flipping one by changing a default in code would flip production behavior without a parity-clean gate, which every runbook in this repo explicitly forbids — so it was not done, and should not be.
- What I did instead: audited the tools both batches depend on, and fixed what would have made the operator's runs wrong or inconclusive. One of those was a live false-pass bug directly on Batch 6's critical path.

- Batch 6 | **The QCD read-source parity gate could print "CLEAN … gate PASSED" having compared ZERO rows** — the strongest possible green light for a `QCD_READ_SOURCE=neon` flip, on no evidence
- Batch 6 | Both read-source gates returned `undefined`, so nothing could read their verdict programmatically
- Batch 5 | `runInboundQcdParityCheck` was structurally blind to the calls that attribute to NO dept — the population that mechanically produces a company-vs-sum-of-depts gap, i.e. the shape of the discrepancy it exists to settle

Files modified:
- apps-script/department-dashboard/QCDReport.gs (Batch 6 — the false-clean fix + structured verdict)
- apps-script/department-dashboard/NeonRead.gs (Batch 6 — symmetric guard + structured verdict)
- apps-script/department-dashboard/InboundReport.gs (Batch 5 — the no-entry_queue probe)
- CLAUDE.md (Operator State #19 gate contract, #30 pointer)
- tests/unit/qcd-report.test.js (+4)
- tests/unit/dal-cutover.test.js (+2)
- tests/unit/inbound-qcd-parity.test.js (+1)

CHANGES:
Batch 6 | QCDReport.gs::compareQcdSources_ | **The bug:** `clean` was `missingInNeon === 0 && extraInNeon === 0 && mismatches === 0`. With zero comparable rows on both sides all three are 0, so the gate printed `QCD PARITY CLEAN -- the QCD read-back gate PASSED`. `neonFetchQcdGrid_` returns a non-null EMPTY grid for an empty range, so the existing `!neonGrid` guard does not cover it, and the in-source default range is a hardcoded week (`2026-05-23..2026-05-29`) that has already aged ~2 months out of the data — meaning an operator who ran the gate without setting `QCD_PARITY_FROM/_TO` was the likely first victim. Now: an empty comparison logs `QCD PARITY INCONCLUSIVE`, names the cause, says "Do NOT flip QCD_READ_SOURCE on this", and returns `clean:false`. Every exit (missing sheet, unavailable Neon grid, empty comparison, real result) returns a structured `{from, to, clean, compared, missingInNeon, extraInNeon, mismatches, roundingOnly, error}`. The CLEAN log line now states how many rows backed the verdict.
Batch 6 | NeonRead.gs::compareDqeSources_ | Same structured verdict and the same explicit zero-comparison guard. **This gate was not actually broken** — its `extraInNeon` check catches the sheet-empty case because every Neon row reads as "extra" — but that protection is incidental, not designed: it would silently become a false CLEAN the moment the verdict stopped counting extras, which is precisely what the QCD gate did. Made the requirement explicit rather than emergent, and noted why in the comment.
Batch 5 | InboundReport.gs::runInboundQcdParityCheck | Added a NO-entry_queue probe: counts window calls with `COALESCE(entry_queue,'') = ''`, grouped by `(disposition, abandon_stage)`, returned as `noEntryQueue` and logged. **Why this specific probe:** the tool's existing unattributed-queue scan filters `COALESCE(entry_queue,'') <> ''` — the same filter that hides an unrecognized queue from Dept Config's "Discovered inbound queues" panel (Operator State #38) — so calls the capture never recognized had no row to report anywhere. Those calls count in the ADMIN company view but attribute to no dept, which is a mechanical contributor to any "company total ≠ sum of depts" gap. The log deliberately warns that an `abandoned + ivr` count here is NOT automatically a bug (it unions genuine auto-attendant give-ups with unrecognized-queue misses), points at the Op-State-#38 histogram to split them, and notes that F1b makes brand-prefixed queues attribute so a re-import inside the ~14-day window shrinks the bucket.

TEST RESULTS: passed. `npm run ci` → **500/500** (was 493; +7), INV-16 guard clean, cache-version-sync clean. The UI gate was NOT re-run: no client file changed in this batch.
**The false-clean test was verified to actually catch the bug** — I removed the new guard, confirmed `Batch 6: ZERO comparable rows is INCONCLUSIVE, never CLEAN` fails, then restored it. Without that check the test would have been a tautology.
Regression Scenarios: NOT EXECUTED — all three changed functions are editor-run diagnostics with no scenario coverage, and no runtime read/write path changed.

REGRESSION RISKS:
- **The QCD gate can now report MISMATCH/INCONCLUSIVE where it previously reported CLEAN.** That is the entire point, but it means an operator who previously saw a green gate may now see a stop — and if they ran it on the stale default range, the earlier green was meaningless. Anyone who already flipped `QCD_READ_SOURCE=neon` on a default-range pass should re-run the gate with real `QCD_PARITY_FROM/_TO` values; the flip is reversible with no redeploy.
- Both gates now RETURN a value where they returned `undefined`. Purely additive for existing callers (the two editor wrappers already returned whatever the compare returned; nothing inspected it). No caller reads these programmatically today.
- The new inbound probe is one extra aggregate query per parity run, wrapped in its own try/catch so a failure logs and leaves the rest of the check intact. It is read-only, on an editor-run diagnostic that nothing schedules.
- `roundingOnly` semantics are unchanged: ±1s duration diffs still don't block a pass (R5), and that behavior is still pinned by the pre-existing tests.
- No production read/write path, cache key, payload shape, or auth gate was touched. No `apps-script` file outside the three diagnostics changed behavior.

INVARIANTS AT RISK: None.
- INV-30 — no cache key or version referenced; sync guard clean.
- INV-16 — no duplicated file touched; guard clean.
- INV-01 — no new public write path; `runInboundQcdParityCheck` remains `assertAdmin_`-gated and read-only.
- The CORE-5/F-5 rule (a compare gate must never print a false PARITY CLEAN) is now **extended** from the three config gates to the two read-source gates, which is where it was missing.

NET SCORE: 1 production fix − 0 new failure modes = 1
- The QCD false-clean counts YES on "would it fire this month": the gate is the documented precondition for a `QCD_READ_SOURCE` flip, Batch 6 was queued to run it, and on the shipped default range it would have returned a meaningless pass. A wrong flip serves the dashboard from an unverified mirror.
- The DQE guard and the Batch 5 probe are defensive/structural (2 under the three-way tally): one hardens an incidental protection, the other makes an existing investigation decisive rather than fixing a defect.

OPERATOR ACTIONS / DEPLOY:
**Batch 6 — the flips themselves are yours; do them in this order, one per cycle:**
- 1. Set `QCD_PARITY_FROM` / `QCD_PARITY_TO` to a REPRESENTATIVE RECENT range the QCD sheet actually covers (the in-source default is a fixed week, now ~2 months stale). Run `runQcdParityCheck`. **Require `clean:true` AND `compared > 0`** — an `error` or `compared: 0` is a STOP, not a pass. Only then set `QCD_READ_SOURCE=neon`. Reversible with no redeploy. | BLOCKS DEPLOY: N
- 2. Then `CONFIG_SOURCE` (after `backfillDeptConfigToNeon` + the three `compare*ConfigSources` gates, which already had the CORE-5 protection), 3. `DQE_READ_SOURCE` (same drill via `runDqeParityCheck`, with the same `compared > 0` requirement), 4. `NEON_MIRROR_MODE=deferred` (verify one import drains + `neonMirror:*` success rows first). | BLOCKS DEPLOY: N
- **If `QCD_READ_SOURCE=neon` was already set on the strength of a default-range pass, re-run the gate now** — that pass may have compared nothing. | BLOCKS DEPLOY: N
**Batch 5 — the investigation is yours:**
- Run `runInboundQcdParityCheck` (set `INBOUND_QCD_PARITY_FROM/_TO`, default last 14 days) and read THREE things: the per-dept `diff` / `diffWithHold` totals (the definitional gap: strict abandons vs the answered-on-hold carve-out), the UNATTRIBUTED raw entry-queues (fix: Dept Config "Inbound queue aliases"), and the NEW no-entry_queue bucket (calls attributable to no dept at all). | BLOCKS DEPLOY: N
- If the no-entry_queue `abandoned/ivr` count is material, run the Operator State #38 journey histogram to split genuine IVR give-ups from unrecognized queues, then re-import affected dates inside the ~14-day `Call_Legs` window. | BLOCKS DEPLOY: N
- Only after the gap is quantified and explained should the Inbound/Direct manager gates be removed (a one-line change in `inboundResolveRequest_` / `directCallResolveRequest_` plus un-hiding the `data-admin-only` tabs). | BLOCKS DEPLOY: N
- Still outstanding from increment 53: deploy both projects; the Op-State-#38 histogram; UDC/UUC attribution; S41/S42. Plus increment 56's two: read the Health page's Install-readiness row, and run `node scripts/check-remote-orphans.mjs .`. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (QCDReport.gs, NeonRead.gs, InboundReport.gs changed). These are editor-run diagnostics, so the push matters only for when you next RUN them.
- CDR Import: unchanged by this batch; the increment-53 push is still pending.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Batch 5 remains OPEN** as an investigation. Nothing here explains the discrepancy; it makes the measurement decisive. Expect it to need one round trip: run → read → possibly alias/re-import → re-run.
- A "flip readiness" editor function that calls all five gates and prints one table would now be possible (all of them return structured verdicts). Deliberately not built — it is new scope, and the per-flag runbooks already exist.
- The in-source default parity ranges are hardcoded fixed weeks in both gates. They now fail loudly instead of falsely passing, but defaulting to something derived (e.g. the last 7 days ending at the sheet's max date) would remove the trap entirely. Left alone: changing a gate's default range is a behavior change to a safety tool, and warrants its own decision.
- `roundingOnly` is reported but not returned in the DQE verdict (only QCD's), because the DQE gate has no tolerant-field concept. Harmless asymmetry, noted so it isn't read as an omission.
- F8 (CLAUDE.md, now ~372 KB) and Batch 7 remain. Every batch this cycle has added to that file.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. Operator State #19 now carries the full gate contract (structured verdict, `compared > 0` requirement, why the QCD hole existed, "never flip on `error` or `compared: 0`"), and #30 points at it plus tells the operator to set the range properties before running. Noted for a future `/sync-docs`: `docs/known-issues.md` has no entry for the false-clean gate class, which is a genuine institutional-memory item now that two gates have been hardened against it.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
