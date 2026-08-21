---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- OV-1 | The Outbound report's vetting instrument — the one remaining code item on its path to
  release. `runOutboundVettingCheck` (OutboundReport.gs; editor-run, admin-gated, READ-ONLY)
  turns "vet the numbers" into one execution-log read, the same move runInboundQcdParityCheck
  made for the Inbound report.

Files modified:
- apps-script/department-dashboard/OutboundReport.gs   (runOutboundVettingCheck appended)
- tests/unit/outbound-report.test.js                   (+6 tests, 22 total; Util.gs joins the
                                                        harness load; stub capture/restore)
- CLAUDE.md                                            (Outbound bullet: vetting-tool sentence,
                                                        the Inbound-bullet pattern)

CHANGES:

OV-1 | OutboundReport.gs | Two legs, OPS-8 verdict prefixes ('ok …' / 'INCONCLUSIVE …' /
'MISMATCH …' / 'FAILED …'):
- LEG A — LIVE two-code-path parity: the outbound report's `callback.abandonedTotal`
  (computeOutboundReport_) must equal the Inbound report's `kpis.abandoned`
  (computeInboundReport_ — verified to count over the identical population: date range + dept
  predicate + work window + is_internal exclusion) for the same scope. This certifies contract
  rule 1 against LIVE Neon, not only via the unit suite's shared-predicate pins. Any
  disagreement → 'MISMATCH parity … do NOT un-gate.'
- LEG B — per-sample verdict re-verification: one bounded pairs sweep (the report's own
  denominator predicates + caller_hash present, newest 200) yields up to OUTBOUND_VETTING_SAMPLE
  called-back pairs and the same number of not-called-back abandons; each is re-checked by a
  SEPARATELY-WRITTEN per-call query (explicit callee_hash = caller_hash equality + timestamp
  ordering; bound parameters, ids never inlined). Called-back must match exactly 1; not-called-
  back must match 0. Every sample's call ids + dates + times are logged (no hashes, no numbers)
  so any verdict can be eyeballed in Caller Lookup. Honest framing in the docstring: leg B is
  semi-independent (same tables) — its value is differently-written predicates agreeing plus the
  ready-made spot-check list.
- GATE CONTRACT (Batch 6 / Operator State #19's rule): a zero-abandon window reports
  INCONCLUSIVE, never ok — parity over nothing certifies nothing, and the un-gating decision
  must never ride an INCONCLUSIVE/FAILED/MISMATCH run. Unmapped dept, unavailable computes, and
  Neon-down all FAIL loudly. Config via optional Script Properties: OUTBOUND_VETTING_FROM/_TO
  (default: the 14 days ending yesterday), OUTBOUND_VETTING_DEPT ('' = company view),
  OUTBOUND_VETTING_SAMPLE (=8, clamped 1..25). Egress-metered; conn closed in finally; nothing
  written anywhere (INV-01-clean, not even outcome properties — a one-shot tool, matching the
  inbound parity checker, not a recurring engine).

Tests | outbound-report.test.js | +6: the clean run end-to-end (parity + both sample verdicts +
the pairs sweep's predicate pins + bound-parameter pins on both verification query shapes);
parity mismatch → MISMATCH; zero abandons → INCONCLUSIVE and never 'ok'; a failed sample
re-verification → 'MISMATCH samples: 1/2' naming the call id; unavailable computes / unmapped
dept / malformed props / non-admin each refuse loudly; unset date props default to a ~14-day
window and still run. Harness note: Util.gs joined the load (assertAdmin_/logStatusReturn_),
and the vetting stubs CAPTURE + RESTORE the real compute globals (assignment over a vm global
loses the original — the first run broke the downstream unavailable-path test until the restore
was added).

TEST RESULTS: PASSED — 854/854 (was 848; +6). OutboundReport.gs passes node --check. CLAUDE.md
guards green (the bullet stays under the flat 4,096 B ratchet; file at 171.8 KB). No client
files touched → ci:ui N/A. INV-16 guard unaffected.

REGRESSION RISKS: None to production surfaces — the probe is a new editor-run function nothing
calls; the report code is untouched. Cost per run: one outbound compute + one inbound compute +
one bounded sweep + ≤50 tiny lookups (a few hundred KB of egress, once).

INVARIANTS AT RISK: None. INV-01 clean (read-only, `_`-free name is deliberate for the Run
picker, admin-gated); the Batch-6 gate contract is implemented, not merely cited.

NET SCORE: 0 − 0 = +0
  (Pure release-enablement: nothing fires in production this month, but the vetting gate that
  keeps the report dark now has a concrete, evidence-or-nothing instrument.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard, then RUN THE PROBE from the editor: `runOutboundVettingCheck` (optionally
  set OUTBOUND_VETTING_DEPT to spot a single dept; defaults cover the last 14 days company-wide).
  Read the verdict line: 'ok …' ⇒ optionally eyeball a logged call id or two in Caller Lookup,
  then release is the one-line gate removal in outboundResolveRequest_ + un-hiding the
  data-admin-only menu item. INCONCLUSIVE/MISMATCH/FAILED ⇒ do not un-gate; bring me the log.
  | BLOCKS DEPLOY: N
- Still recommended first: `backfillOutboundCalls` (cdr-import) — the retention window slides
  daily; running it before the probe both extends the report's floor and gives the probe more
  to chew on. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- Release itself (owner-gated, after a clean probe run): the one-line gate removal + menu
  un-hide; add the ci:ui driver visit + a Regression Scenario (S44) in the SAME change, per the
  coaching precedent (admin-only surfaces skip the rendered gate; released ones must not).
- The rest of the ledger is unchanged (operator backfills, coaching arming, the other
  vetting-gate releases).

DOCUMENTATION UPDATES NEEDED:
- Applied in this change: the CLAUDE.md Outbound bullet's vetting-tool sentence. Nothing else —
  the props are self-describing and scoped to the tool; no Operator State item needed for a
  one-shot instrument (the runInboundQcdParityCheck precedent).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
