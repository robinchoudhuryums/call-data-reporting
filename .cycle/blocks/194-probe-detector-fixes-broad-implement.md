---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- (a1) obProbeTalkTrough_ searched only BELOW the mode — a blind spot that
  returned a WRONG answer ('mode-at-floor') on the first live run
- (a2) obProbeSpikeHint_ rounded shares to whole percent, printing the
  self-contradictory "only 8% of connects (need 8%)" for 7.6% vs 8.0%
- (b) a REFUSAL produced no ring×talk cross-tab at all, because query 2 was
  gated on a measured band

Files modified:
- apps-script/department-dashboard/OutboundReport.gs
- tests/unit/outbound-report.test.js
- docs/operator-state.md (#64)
- docs/outbound-callback-dept-plan.md

CHANGES:
(a1) | OutboundReport.gs | obProbeTalkTrough_ now finds the trough BETWEEN TWO
HUMPS wherever it sits, via prefix/suffix max+argmax arrays, scoring each
candidate split by SEPARATION = min(tallest left, tallest right) − the bucket
itself. Scoring by depth alone would pick the emptiest bucket in the tail,
where there is no second hump to separate from. The `mode < 2` gate is gone
(the mode's position no longer decides anything) and 'mode-at-floor' is
replaced by 'unimodal' for the one-hump / monotonic case. Reports
leftPeakSec / rightPeakSec so the two humps are visible. Every existing
refusal is preserved: sample size, the empty-bucket 'sparse' guard, the
both-shoulders-≥2× depth requirement, and suggestedIsMeasured:false whenever
no trough is found.
(a2) | OutboundReport.gs | new pure obProbePct1_ renders shares to one
decimal; spike-too-small and unimodal hints route through it. The other
reason strings were checked — 'flat' already carries a 2dp ratio, the rest
are integers, so neither can collide.
(b) | OutboundReport.gs | query 2 extracted to obProbeJointCut_(conn, from,
to, lo, hi, minTalk) so the measured and exploratory paths cannot compute it
differently — what differs is the LABEL, never the SQL. A refusal now emits
`out.exploratory` cut at the OBSERVED peak/FWHM edges, carrying an
EXPLORATORY note, `refusedBecause`, and the cross-tab — with NO `suggested`
and NO `band`. Gated on the FWHM edges existing, so a too-few-rows /
empty-region refusal still runs exactly one query. The verdict STRING also
names the exploratory block, since the payload alone is not where a reader
looks first.

TEST RESULTS: passed. 1469 unit tests (was 1466), INV-16 guard clean,
`npm run ci:ui` all stages green (Playwright installed this session).
11 mutations applied to the new/changed pins, 11 killed — including the two
that re-introduce the original defects (search below the mode only; refusal
emits no cut).

REGRESSION RISKS:
- obProbeTalkTrough_'s return shape GAINED leftPeakSec/rightPeakSec and its
  reason vocabulary lost 'mode-at-floor' / gained 'unimodal'. Only the probe
  and its tests read this function; nothing persists the reason string.
- obProbeJointCut_ extraction: the measured path's SQL and bind order are
  byte-identical (pinned by the pre-existing 19-bind positional test, which
  still passes unchanged).
- The old behaviour was NOT correct in the (a1) case — 'mode-at-floor' on a
  distribution with a real trough is a wrong answer, not a conservative one.

INVARIANTS AT RISK: None. The probe is read-only, admin-gated, editor-run;
no cache prefix, no Script Property written, no INV-30 surface, PHI
discipline unchanged (aggregates only, both queries egress-metered).

NET SCORE: 3 − 0 = 3

OPERATOR ACTIONS / DEPLOY:
- Re-run `probeOutboundAnswerQuality` after the deploy | BLOCKS DEPLOY: N
  The previous run's verdict stands (INCONCLUSIVE, correctly), but the re-run
  now measures the 20s talk trough and returns the exploratory ring×talk cut
  that the first run could not produce. Operator State #64 is the runbook.
Deploy: Department Dashboard — `scripts/deploy.sh .` (or `clasp push -f` +
Manage deployments → New version)

FOLLOW-ON ITEMS:
- (c) THE 0–1s POPULATION, deliberately not started here: 40.6% of connected
  single-attempt outbound calls ring 0 or 1 second (17,197 at exactly 0s,
  zero NULL rings), and the repeat check's largest cluster is 3,446
  callee-groups connecting at 0s REPEATEDLY. `ring_seconds` discriminates
  nothing for four calls in ten regardless of threshold, which caps any
  ring-based classifier at ~60% of the population. Needs a look at raw legs
  for a sample (journey drill / Caller Lookup) before Part 2 step 2.
- The live ring distribution is FOUR spikes (17s, 21s, 27s, 31s, ~5–6s apart
  = ring-cadence harmonics) plus a hard cliff at 32→33s (1224→115; 99.3% of
  connects ring ≤32s), not the single tight spike the plan hypothesised. If a
  classifier is built at all it likely needs a SET of bands, not one
  threshold. Not acted on — the gates correctly refuse, and the exploratory
  cut from (b) is what should inform that decision.

DOCUMENTATION UPDATES NEEDED: None outstanding — Operator State #64 and
docs/outbound-callback-dept-plan.md were updated in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
