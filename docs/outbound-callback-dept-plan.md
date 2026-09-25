# Per-dept callback table + outbound answer quality — plan

Status: **PLAN ONLY, nothing built.** Two linked pieces the owner asked for on
2026-09-15, after the six-point Outbound round (block 193):

1. **A per-dept callback table** — which departments' abandoned callers get
   called back, and how well.
2. **Outbound answer-quality parameters** — `connected` currently counts a
   voicemail pickup as a reached caller, which inflates the very rates the
   table would compare.

They are one plan because the table makes the defect worse, not neutral: a
single scope-level rate carries the over-count as a constant everyone reads
past, while a dept COMPARISON turns it into a ranking that is wrong by
different amounts per dept (a dept whose callers mostly go to voicemail looks
as good as one whose callers actually answer).

**Do part 2 first.** Shipping the table on today's `connected` would publish a
league table built on a number we know to be wrong.

---

## Part 2 — outbound answer quality (do this first)

### What `connected` actually means today

`cdr-import/outboundCalls.js`, per outbound call group:

```
connected     = ANY external leg with Talk > 0 AND Answered = 'Answered'
talk_seconds  = MAX talk across those legs
ring_seconds  = start -> connected (when connected), else start -> stop
attempts      = number of external legs
```

The owner's read is correct, and the reason is structural rather than a bug:
**a voicemail system genuinely answers the call.** The carrier reports
`Answered`, the agent talks (leaves a message), so `Talk > 0`. Every condition
`connected` tests is satisfied. There is no field in the CDR that says
"a machine picked up".

So `connected = true` today means *"something on the far end answered and
audio flowed"* — a human, a voicemail greeting, an IVR at the other company,
or an auto-attendant. The existing docs say the CDR cannot tell no-answer from
voicemail from busy on the UNCONNECTED side; the unstated other half is that
it cannot tell a person from a machine on the CONNECTED side either. That
second half is the one that reaches a KPI.

### Why this matters more now

The six-point round promoted **"Actually reached"** to a headline tile
(`calledBackConnectedPct`). That tile inherits this: it is currently
"call-backs where *something* answered", not "call-backs that reached the
caller". The tile is more honest than the raw callback rate it sits beside —
it still excludes rang-out callbacks — but it is not yet what its label
claims. **Fixing the label or fixing the number are both acceptable; leaving
both is not.** **RESOLVED 2026-09-23 by fixing the LABEL:** the number cannot
be fixed from stored data (round 2 below), so the tile is now "Callbacks
connected", with an upper-bound disclosure.

### The two discriminators we actually have

No new capture column is needed (the same constraint the owner set for 6d).
Both signals are already stored:

**A. `talk_seconds` — weak on its own.** A voicemail interaction is
greeting + message ≈ 20–60s. A real conversation is usually longer, but a
genuine "wrong number, sorry" is 10s. Talk time alone cannot separate them and
a threshold on it *will* misclassify some real short calls.

**B. `ring_seconds` on a CONNECTED call — the strong one, and it is not being
used.** When voicemail answers, the handset rang out to the carrier's
no-answer timeout first — a near-CONSTANT value per destination (commonly
20–30s, or a fixed ring count). A human picks up at a variable, usually
shorter time. So on connected calls, `ring_seconds` should be **bimodal**: a
broad low cluster (people) and a tight spike at the timeout (voicemail).

That spike is the measurement this whole decision rests on. If it is there,
the classifier is good; if the distribution is flat, it is not, and we should
say so rather than ship a threshold that looks principled.

### Step 1: MEASURE, then set (do not skip) — ✅ SHIPPED 2026-09-15

`probeOutboundAnswerQuality()` is implemented in `OutboundReport.gs`
(read-only, admin-gated, editor-run, sibling of `runOutboundVettingCheck`).
**Operator State #64 is the runbook**; what follows is the design.

> **⚠ Correction to this plan, found while building it.** The measurement
> below said "histogram of `ring_seconds` on `connected = true` rows". That
> mixes two different legs' facts: in `cdr-import/outboundCalls.js`,
> `connected` is true when ANY external leg had Talk>0 Answered, but
> `ring_seconds` is measured on the FIRST leg only. On a multi-attempt call
> the ring length and the connect need not belong to the same dial, which
> blurs exactly the spike being looked for. **Spike detection therefore runs
> on `attempts = 1` rows**; the all-attempts histogram is reported beside it
> and the by-attempts split is unchanged.

Over a representative window (default: the 28 days ending yesterday):

- histogram of `ring_seconds` on `connected = true` rows (1s buckets to 60s),
- histogram of `talk_seconds` on `connected = true` rows (5s buckets to 300s),
- the joint counts in each candidate quadrant,
- the same split by `attempts` (a 3rd-attempt connect is likelier voicemail),
- **per-callee-hash repeat check**: the same `callee_hash` connecting at the
  same ring length repeatedly is voicemail with high confidence, and this is
  the one signal that can *validate* the threshold rather than assume it.

Only after reading that do the numbers below get set. The candidate defaults
are starting points for the probe to confirm or move, **not recommendations to
apply blind** — this repo has been bitten by plausible-looking constants
before (the R18b tally unit was measured, not reasoned).

**As built, the probe refuses rather than guesses.** It does not hand back a
histogram for a human to eyeball a threshold off; it applies six gates and
reports `ok bimodal` with measured values or `INCONCLUSIVE` with the gate
that refused — sample size (<200 single-attempt connects), no candidate peak
at or above a 12 s floor, flat (peak under 4× the median bucket), too wide
(FWHM over 12 s, i.e. a cluster rather than a fixed timeout), too small a
share (under 8% of connects), or not bimodal (under 15% of connects ringing
shorter than the spike). The threshold is the spike's LEFT edge and the
tolerance its half-width, both read off the measurement. Two of those gates
exist because of a specific way this can go wrong:

- the **floor** gate, because a peak down at 3-4 s is the human-pickup mode,
  and reading a voicemail band off it would classify nearly every connect as
  voicemail — the worst available failure;
- the **bimodality** gate, because one mode is not two. The spike is
  deliberately sought only in the at-or-above-floor region rather than as the
  global maximum: most calls are answered by people, so the human cluster is
  normally the TALLER mode, and a global-max search would reject every
  genuinely bimodal distribution. That was a real bug in the first
  implementation, caught by its own test.

`OUTBOUND_MIN_TALK_SEC` is measured the same way, from a trough in the talk
histogram deep enough to be a boundary (at or under half of both shoulders);
when there is no such trough the probe falls back to the candidate 10 and
flags `suggestedIsMeasured: false`, so the number cannot later be cited as
measured. An empty bucket is treated as absence of data, not as the perfect
trough. **The trough is sought between TWO HUMPS wherever it sits** — the
first version searched only below the mode, and the live distribution's mode
turned out to BE the low cluster (5 s) with the real boundary at 20 s above
it, so it answered "mode-at-floor": a wrong answer dressed as a refusal.

**A refusal still emits the joint cut**, labelled `exploratory` and carrying
no `suggested` block. The original "no band, no second query" rule was
guarding against manufacturing evidence for an unmeasured number, and that
property is intact; what it had also done, unintentionally, was leave a
refused run with no ring×talk cross-tab at all — which is the one view that
would say whether a multi-band rule is worth building.

### Step 1 RESULTS — first live run, 2026-09-18 (both probes INCONCLUSIVE)

Window `2026-08-21..2026-09-17`, all departments, 62,738 connects of which
62,732 are single-attempt. **Nothing was set.** Two findings, and only one of
them is a dead end.

**`probeOutboundAnswerQuality` refused on ONE gate: share.** The peak holds
7.7% of connects against the 8.0% floor. The feature it found is otherwise
strong: peak at 31 s, 3,022 calls, baseline 330, **ratio 9.16**, FWHM 2 s,
band 30-31 s. So this is a near miss on a real timeout, not a flat
distribution.

The min-talk half DID measure: **`suggestedMinTalkSec: 20`, measured, trough
at 20 s between humps at 5 s and 35 s** (`suggestedIsMeasured: true`). That
is the half of the rule that is defensible today. It cannot be set alone --
the classifier needs a ring band too.

Second signal, disclosure not a gate: `agreesWithSpike: false`. The 9,812
repeat-callee groups peak at **0 s**, not 31 s. Per the contract above a
DISAGREES still verdicts `ok`, so it did not refuse the run -- but it points
at the instant-connect problem below rather than at voicemail.

**BLOCKER 1 (design, not data): the share gate is probably unreachable here,
because the voicemail mass is MULTI-MODAL.** The ring histogram carries
distinct bumps at 21 s (2,077), 26-27 s (927 / 1,010) and 30-31 s (1,784 /
3,022) -- the signature of several carriers with different voicemail pickup
delays. A test that measures ONE 2 s-wide peak cannot capture mass split
three ways, so a wider window or a per-dept scope will not fix it. **Summing
the whole 20-32 s band gives 13,798 calls = 22.0% of connects** (summed by
hand from the run's `ringHist`, NOT a probe output -- do not cite it as
measured; roughly 3.6k of it is baseline). That is the number this plan
already said it wanted: "the one view that would say whether a multi-band
rule is worth building." It is worth building. **The change is a probe that
sums a BAND rather than a peak**, with the floor and bimodality gates kept --
a code change and a deliberate decision, never a re-run.

**BLOCKER 1 ADDRESSED 2026-09-21 -- and building it surfaced the number that
actually decides this work.** `obProbeRingBand_` is a SECOND detector, not
looser gates on the first: the spike detector is untouched and still encodes
"one carrier, one timeout, one tight peak", and the band runs only when the
spike refused as `spike-too-small` or `too-wide` (the two shapes mass split
across several timeouts produces through a one-peak test). A passing spike
still wins, because a 2 s band implies a far higher precision than a 13 s one.

**The new gate is PURITY, and on the live numbers it is the whole story.**
Summing the 20-32 s band counts the baseline traffic inside it as if it were
voicemail: 13,798 calls in the band, of which 13 x 330 = 4,290 are baseline,
so **roughly 31% of anything a threshold there flags is a human who simply
answered slowly.** That is the classifier's precision CEILING -- before any
implementation error -- it was measurable all along, and no gate in the
original design looked at it. A band that is mostly baseline is now refused as
`band-impure` rather than handed over. The ceiling travels with the parameters
as `out.suggestedBasis.expectedPrecisionCeiling`, deliberately OUTSIDE the
`suggested` block (that block is copied key-for-key into Script Properties, so
a non-property key in it invites setting a property by that name -- pinned).

**One claim was corrected while building it.** The scan was first written as
"maximise EXCESS over baseline, never raw mass, so it cannot drift onto the
human cluster". At FIXED window width that is false: `mass - W*baseline` and
`mass` rank windows identically, the subtracted term being constant. What
actually keeps the scan off the human cluster is the FLOOR (the left edge may
not fall below `OB_PROBE_VM_FLOOR_SEC_`) and the new SHOULDER gate (`no-trough`
-- a window whose three preceding seconds are nearly as busy is the upper tail
of people answering). Both are pinned; the excess is computed for the purity
gate, not to steer the scan.

**What is still NOT established: that a 20-32 s ring means voicemail at all.**
Every measurement in this document is unlabelled inference from timing. The one
independent signal available -- the repeat-callee check -- DISAGREED (its modal
ring is 0 s, not 31 s). The band makes the rule REACHABLE; it does not make it
CORRECT. See "Step 1b" below.

**BLOCKER 2 -- RESOLVED 2026-09-18, and the answer came with it.**
`probeOutboundInstantConnects` could not verdict: it sampled 300 rows in each
group and found zero usable external legs in all 600 (`verdict:
'no-journeys'`, `sampled: 0`, `noExternalLeg: 300` both sides).
`probeOutboundJourneyShape()` was written to decide the fix by measurement
rather than by inspection, and it overturned the standing hypothesis.

**The hypothesis was wrong.** We expected P-11: `icBuildJourney_` has two
masking branches, and a callee carrying a carrier CNAM takes the P-11 branch
and becomes masked initials or `(external caller)`, which the
`'(external number)'` marker misses. Measured across 600 rows the counts were
`extNumber: 0`, `extCaller: 0`, `initials: 0`. **None of the three name
shapes is present at all**, so no masking branch was firing, and P-11 was
never the mechanism.

**The actual cause is one level up.** `icBuildJourney_` derives every event's
name from **CALLEE_NAME**. An outbound dial carries the number in **CALLEE**
and leaves CALLEE_NAME blank, so the phone-shaped branch never fires; the
P-11 branch is additionally gated on `name &&`, so it never fires either; and
the leg falls through to `if (!name ...) name = '(unknown)'`. Every outbound
external leg is named `(unknown)`, by construction -- the rung group was 100%
`unknown`, 600 of 600 events, every one of them carrying `secs`. The other
two candidate causes are ruled out by the same run: `nullMatchNoSecs: 0` on
both groups (never a matched-but-duration-less event), and the query already
carried `AND journey IS NOT NULL`.

This is still the deeper problem named above -- the blob cannot identify the
leg, because the external leg is defined by `DIRECTION = 'Outgoing' AND
icExternalNumber_(CALLEE)` and the capture stores neither. The name mask was
always a proxy. What changed is that we now know the proxy is not merely
lossy, it is empty.

**The fix (shipped): a measured fallback inside `obInstantDerivedRing_`**,
reader-side so it works on existing history. `(external number)` stays the
first and authoritative marker -- so a capture-side fix later takes
precedence with no reader change -- and behind it sits the first
`unknown`-CLASS event. The answer key endorsed that marker at **100%
coverage, a median 27 s derived ring, every value a real ring**, while the
same marker read a median **1 s** on the instant group: it tracks the stored
ring across both populations, which an internal hop could not. `lastEvent`
was the one candidate eliminated outright -- it read 38 s on the rung group
but **74 s** on rows whose stored ring is <= 1 s, i.e. it measures the talk
leg. The other three survivors (`firstEvent`, `lastAnswer`, `maxSecs`) tied
with `unknown` at 27 s on the answer key, because 87% of sampled journeys are
two events and all four resolve to the same one there; `unknown` was chosen
over them because it is selected by CLASS, and `obJourneyNameClass_` scores a
queue event as `queue` whatever its name, so the 12% of instant rows that
passed through a queue skip it rather than measuring hold music. A bare
`firstEvent` fallback would have measured the music on those rows.

**The answer to #65: `carrier-instant`** -- reached on the 09-18 run, briefly
contradicted, and CONFIRMED on a second shape run 2026-09-21 with the
corrected marker. The confirming figures are the clean ones: the P-11 masked
external leg (`initials`) covers 300/300 rows and reads a median **1 s with a
0% real-ring share** on the instant group, against **27 s with 100%** on the
rung control -- a marker that tracks the stored `ring_seconds` at both ends to
the second. Well under the 20% `OB_INSTANT_CARRIER_SHARE_` gate. (The 09-18
figures were a median 1 s at **12.3%**, from the pre-P-11 marker; same answer,
noisier instrument. The `connected-timestamp` verdict in between came from
reading the wrong leg on post-P-11 rows -- Operator State #65 has the era
split.) So **these
calls genuinely connect instantly, `ring_seconds` is telling the truth, and
the classifier must EXCLUDE them and disclose the reduced reachable
population (~60%, permanently).** Re-run #65 to have the probe state that in
its own verdict before building on it.

Two things that follow. First, this **overrules the talk-profile cut**, which
pointed the other way: talk medians fall monotonically as ring rises (**104
s** in the 0-1 s band, 64 s at 2-16 s, 36 s at 17-32 s), so instant-ring rows
talk the LONGEST, which looked like real conversations carrying a mis-recorded
CONNECTED timestamp. The derived ring outranks it because it measures the ring
directly instead of inferring it from behaviour -- and long talk is equally
consistent with an early-media trunk that connects for real. The supporting
cuts stand and are consistent either way: the 40.5% instant share is flat on
all 18 days and spread across all 161 agents (`concentrated: false`, top-5
share 10.3% vs a 3.1% even baseline), so it is systemic telephony, not a few
handsets.

Second, the agreement is **not circular**, which matters because both figures
come from the same leg rows. `ring_seconds` is `START -> CONNECTED`; the
derived ring is `STOP - START - talk - hold` and never reads CONNECTED. A
spuriously early CONNECTED would shrink the former and leave the latter
untouched, so the two agreeing is a genuine check on CONNECTED rather than a
restatement of it.

**Capture-side follow-on, recorded and NOT done.** Labelling a leg whose
CALLEE is external as `(external number)` when it carries no CNAM would make
the authoritative marker correct and retire the fallback. It is a WRITER
change in `icBuildJourney_`, which means: forward-only (history still needs
the fallback), and shared with INBOUND, whose journeys render in the call-path
drill and Caller Lookup. Worth doing deliberately, with its own regression
walk -- not folded into a probe fix.

### Step 1b: GROUND TRUTH — listen to calls before setting anything (owner ask, 2026-09-21; SHIPPED 2026-09-21, CONCLUDED 2026-09-23)

**Why this is the gate, not another distribution.** Everything in Step 1 is
UNLABELLED inference: we observe that rings cluster at 21 / 26-27 / 30-31 s and
interpret the clusters as carrier voicemail timeouts. Nobody has confirmed that
a single 31 s-ring connect actually went to voicemail. Three facts say the
interpretation needs a check rather than more measurement:

1. The one independent signal in the probe **DISAGREED**: the repeat-callee
   check peaks at 0 s, not 31 s (`agreesWithSpike: false`). The design treats a
   disagreement as disclosure rather than a refusal, which is right, but a
   disagreeing independent estimate is exactly when labels are worth more than
   another histogram.
2. The band's measured purity puts a **~69% ceiling** on precision. Whether
   that is acceptable is a judgement about how the number will be read, and it
   cannot be made from the distribution alone.
3. #65 closed by establishing that 40.6% of connects are genuinely instant.
   That conclusion is also unlabelled -- it rests on a derived ring agreeing
   with a stored one. Listening to a handful would confirm it independently and
   cheaply.

**Sample by STRATUM, and let the listener assign the label.** "Get me some
voicemail calls" is not a query this data can answer -- voicemail is the thing
being inferred, so it cannot be a sampling filter without assuming the
conclusion. Only two of the four classes the owner named are stored facts;
the other two are hypotheses:

*Revised 2026-09-22 after the ground truth below -- this is the LIVE table.*
The first version had B at `2-11 s AND talk >= 20 s` and no B2, which left
12-19 s in no stratum (finding 1), and it framed A and B as human controls,
which an 8 s voicemail falsified (finding 9). Ids are frozen: the scorer joins
on the id stored in each run's Key tab.

| Stratum | Selector | Want | What a label settles |
| --- | --- | --- | --- |
| `A-instant` | `connected`, ring <= 1 s | 8 | RECALL -- how many instant connects are not a person |
| `B-human` | `connected`, ring 2-11 s | 5 | RECALL -- fast rings can be voicemail |
| `B2-shoulder` | `connected`, ring 12-19 s | 12 | The band's LEFT EDGE |
| `C-inband` | `connected`, ring 20-32 s | 20 | **The precision question** -- what fraction are machines |
| `D-above` | `connected`, ring >= 33 s | 5 | Whether the right edge is placed right |
| `E-unconnected` | `connected = false` | 4 | The one CONTROL -- that `connected` means what it should |

The connected bands TILE 0..inf with no gap (pinned). Allocation is uneven on
purpose: at n=20 a share carries about +/-10 pts, at n=12 about +/-13, and the
call is "mostly machines vs a coin flip", so the listening goes where the
decision is.

**Blind the listener to the stratum.** If the sheet says "31 s ring -- expected
voicemail", the label is contaminated by the hypothesis and the exercise
confirms itself. Emit ONE shuffled list with an opaque token per row and keep
the stratum in a separate key the listener does not open until after labelling.
This costs a few lines and is the difference between evidence and agreement.

**The PHI question is SETTLED, and the answer was the good one (owner,
2026-09-21): recordings are locatable by AGENT + TIME.** I had expected this
tool to break the aggregates-only probe convention ("no hash, no number, no
call id is selected, logged or returned") because a sampler must emit row
identifiers to be useful. It does not: agent + date + time locates the
recording, so **no callee identity is needed at all** -- no phone number, no
`callee_hash`, no `call_id`. The convention holds unchanged. What leaves is
internal-staff and duration data (agent name, department, ring/talk seconds).
Pinned, because a later "add the call id, it's handy" would otherwise be
invisible.

**The owner also confirmed the label is directly observable:** the recording
carries the automated greeting and the agent's own message, so a listener can
separate voicemail from a human without judgement calls. That is what makes
this the cheapest decisive evidence available rather than another proxy.

**SHIPPED 2026-09-21, streamlined 2026-09-22: `sampleOutboundCallsForReview()`
+ `scoreOutboundReviewSample()`** (`OutboundReport.gs`, admin-gated,
editor-run). Operator State #71 is the runbook. The 09-22 pass removed every
manual step between sampling and a verdict: the worksheet is WRITTEN into a
standing review workbook instead of pasted out of the execution log, the key
is a hidden tab the SCORER reads so no human ever needs to open it, and the
scorer does the join, the per-stratum tally and the decision rule. Two
judgement calls in that pass are worth stating:
- **Allocation is UNEVEN, because only stratum C decides.** 20 in C, 10 in A,
  6 in B and D, 4 in E -- 46 calls rather than a uniform 60, with the
  precision spent where it changes the answer (+/-10 pts at n=20 versus
  +/-13 at n=12, against a "mostly machines vs coin flip" call).
- **The verdict tests the INTERVAL, not the point estimate.** A 14-of-20 run
  reads 70% voicemail and still returns `inconclusive`, because its Wilson
  lower bound reaches down to the coin flip. `validated` needs the lower
  bound above 60%, `refuted` the upper bound below 50%. And a failed CONTROL
  downgrades a validation: if stratum A comes back mostly non-human then
  #65's carrier-instant conclusion is wrong and stratum C is not
  interpretable, so the scorer refuses rather than letting C outvote a broken
  premise.

Design notes worth keeping:
- **The worksheet is blinded and the key is separate.** `worksheet` carries
  token / date / time / agent / department and a Label column -- and
  deliberately NOT ring or talk seconds, which would name the stratum outright
  and turn the exercise into self-confirmation. `key` maps token -> stratum +
  ring + talk afterwards.
- **Tokens are assigned AFTER the shuffle**, so their order leaks nothing
  either. Pinned against a deterministic shuffle rather than hoping a random
  run happens to show it.
- **Each stratum is sampled independently** (`ORDER BY random() LIMIT n` per
  stratum, one round trip): a single global sample would starve the in-band
  stratum, which is the smallest of the five and the only one that decides
  anything. A stratum returning under 5 rows is flagged THIN in the result.
- **Both TSV writers route through `sheetSafeCell_`** and flatten embedded
  tabs -- the paste target is a spreadsheet and agent names come from the
  external CDR feed (the injection rule's "CSV or not" clause).
- **The stratum travels into SQL as an integer index**, so nothing
  name-derived is concatenated into the statement.
- **A per-recording DEEP LINK is not derivable, and the reason is worth
  knowing (2026-09-22).** 8x8 addresses a recording by its own UUID
  (`/recordings/details/cdd3ea31-...`); `outbound_calls.call_id` is the CDR's
  Call ID, numeric and epoch-millis-shaped -- the same id space as the DQE
  AD/AE columns, which is why those coerce. Different spaces, no mapping. The
  optional `OB_REVIEW_RECORDING_URL` template (Operator State #71) renders a
  SEARCH url per row instead, since the console's parameter scheme is operator
  knowledge rather than anything the repo can infer.
- **The window now anchors to the DATA** (`obProbeAnchorDate_`, shared by all
  four outbound tools): unset, it ends at `max(call_date)` rather than at
  yesterday, so no window carries a tail of empty days. **Capped at
  yesterday** -- `max(call_date)` becomes today the moment a mid-day import
  lands a partial day, which is the P16 bug, so the anchor may only pull the
  window earlier. An explicitly set window is never moved.

### GROUND TRUTH: the first two labelled calls (owner, 2026-09-22)

Two outbound calls from 2026-09-21, same agent (ext 279) two minutes apart,
both confirmed from the recordings as **voicemail reached, message left**.
Raw CDR rows supplied; ring derived as `CONNECTED - START` on the external
Outgoing leg, exactly as `outboundCalls.js` computes it:

| Call id | Outcome | START | CONNECTED | **Ring** | Talk | `CALL_TIME` | Recording |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `1783984138942` | voicemail | 14:56:24 | 14:56:46 | **22 s** | 73 s | 95 s | 73 s |
| `1783984138898` | voicemail | 14:55:30 | 14:55:48 | **18 s** | 30 s | 48 s | **29 s** |
| `1783984138422` | **human** | 14:50:52 | 14:50:56 | **4 s** | 168 s | 172 s | 167 s |
| `1783984138413` | **voicemail** | 14:50:49 | 14:50:57 | **8 s** | 127 s | 135 s | 127 s |

**The human control (added 2026-09-22) separates cleanly, and in the
hypothesised direction:** 4 s for a person against 18 / 22 s for voicemail.
That is the bimodality this plan was built on, observed for the first time
with a labelled human in the sample -- and it OVERTURNS the 09-22 worry that
voicemail here might answer FAST. It answers slower than the human, which is
the carrier-timeout model behaving as designed. Three calls cannot site a
threshold; they can say the premise is not dead.

**Four findings, in order of how much they change.**

**1. The strata had a HOLE, and a real voicemail was in it.** B ran 2-11 s and
C 20-32 s, so ring 12-19 belonged to no stratum -- the 18 s call could never
have been sampled, in exactly the region where the band's left edge is in
question. FIXED: `ring` ranges are declarative, `B2-shoulder` (12-19 s) is a
new stratum with a real allocation, B dropped its `talk_seconds >= 20`
condition (it made the bands non-contiguous, and a control pre-filtered to the
outcome it confirms is a weaker control), and two pins now fail on any gap or
overlap. The scorer reports a voicemail-heavy shoulder as **"THE BAND STARTS
TOO HIGH"** -- a finding about the edge, deliberately NOT a control failure,
so it does not downgrade stratum C's verdict.

**2. The 20 s left edge would MISS one of the two known voicemails** (18 s).
On this evidence the measured band is too narrow at the bottom. Two labelled
calls do not move a threshold, but they do say which question to measure
first, which is what B2 now does.

**3. The console's "29 s duration" is the RECORDING LEG**, not the call and
not the talk time: the `Internal / CallRecording` leg runs 14:55:49-14:56:19
while the call itself is 48 s (18 ring + 30 talk). That resolves the 09-22
worry that ring + message could not both fit 29 s -- they were never meant to.
**Read a console duration as the recording, never as the call.**

**4. The capture handles both calls correctly**, verified by hand against the
real grouping rules: both legs share root `call_id` (the `CallRecording` leg
carries `Internal` + a non-phone callee, so `extLegs` excludes it), `first`
is the Outgoing leg, `connected` is true via Talk>0 + `Answered`, and
`ring_seconds` is 22 / 18. Also worth noting as OBSERVED rather than reasoned:
**a voicemail pickup really does report `Answered` + `Connected`** -- the
structural premise this whole plan rests on.

**5. NO CDR FIELD DISTINGUISHES THEM -- now verified, not assumed.** Swept
every column across all three calls: `Answered`, `Connected`, `Completed`,
`Normal`, `Missed`, `Abandoned`, the hold-duration and disconnect-on-hold
fields, `VOD`, `Record Service On` are IDENTICAL on the voicemail and human
legs. The only fields that differ are the ring/talk durations, the dialled
number, and the agent's own org columns. So the plan's structural claim --
"there is no field in the CDR that says a machine picked up" -- holds against
a matched voicemail/human pair rather than as an inference. **Ring time is the
only discriminator in the data**, which is why this whole exercise exists.

**6. The HAND-WRITTEN candidate band fits the labels better than the measured
one, at the low end.** Step 2's candidate is `VM_RING 22 ± TOL 4` = **18-26 s**,
which classifies all three calls correctly (both voicemails in, the human
out). The band the DETECTOR measured from the 09-18 histogram is **20-32 s**,
whose left edge misses the 18 s voicemail by one second and whose right edge
runs well past anything observed. Two labelled voicemails cannot move a
threshold -- but "the measured left edge is a second too high" is now a
specific, testable claim, and `B2-shoulder` is what tests it.

**7. `OUTBOUND_MIN_TALK_SEC` contributes NOTHING to voicemail detection on
this evidence.** Both voicemails talk 30 s and 73 s, clearing any plausible
floor (the measured trough was 20 s, the candidate 10 s). The plan already
calls talk "weak on its own", but it is worth stating flatly: in the Step 3
model the RING BAND does all the voicemail work and min-talk only separates
conversations from hangups. A 73 s voicemail message also exceeds the
"greeting + message ~= 20-60 s" expectation written into Step 1, so a talk
UPPER bound would have misclassified it.

**8. ⚠ THE STEP 3 OUTCOME MODEL DOES NOT PARTITION.** `voicemail-likely` is
ring-only and `brief` is talk-only, so a voicemail with a short message
(ring in band AND talk < MIN_TALK) matches BOTH and the model states no
precedence. This is the same defect class as the sampler's stratum gap found
the same day: categories that look exhaustive and are not. **Owner ruling
needed before Step 3 is built** -- the natural resolution is that
`voicemail-likely` WINS over `brief`, since it is the more specific claim and
a short voicemail is still a voicemail, but that is a decision about what the
surface should say, not an implementation detail. Whatever is chosen, the four
outcomes need an explicit evaluation ORDER and a test that every
`connected` row lands in exactly one.

**9. ⚠⚠ THE COUNTEREXAMPLE: A VOICEMAIL RANG 8 SECONDS (2026-09-22).**
`1783984138413` -- agent left a message, then sat on a silent line for ~2 min
until it dropped -- rings **8 s**, one second outside the human's 4 s and
nowhere near the 18-31 s timeout region. **No ring threshold can catch it**,
and today's `connected` boolean counts it as a reached caller.

**The mechanism, which this plan did not account for: there are TWO KINDS of
voicemail.**

| | Ring | Ring-detectable? |
| --- | --- | --- |
| **Timeout voicemail** -- phone rings out, carrier forwards after N s | 18-31 s | yes, this is what the band finds |
| **Immediate voicemail** -- phone off / DND / unconditionally forwarded | call-setup time only (~4-10 s) | **NO -- indistinguishable from a human answer** |

The 40.6% instant population (#65) is plausibly a third variant with near-zero
setup, which would mean #65's "these genuinely connect instantly" says nothing
about WHO answered -- it established the stored ring is TRUTHFUL, never that a
person picked up. That distinction was collapsed in my own earlier reading.

**What this changes, in order of consequence.**

(a) **The ring method has a RECALL ceiling on top of its ~31% precision
ceiling.** It can only ever catch timeout voicemail. Immediate voicemail stays
inside `reached` -- and `reached` is the number managers act on, so the error
runs in the direction that flatters the team. A precision problem inflates
`voicemail-likely`; this inflates `reached`, which is worse.

(b) **`strict` mode should not ship on this evidence.** It would present
`reached` as fact while a population it cannot see sits inside it. `disclose`
must state that reached is an UPPER BOUND.

(c) **A-instant and B-human were never human controls, and the scorer treated
them as such.** A voicemail-heavy fast band was wired to downgrade stratum C
as though the strata were broken. FIXED: A and B are now MEASUREMENTS of
voicemail share by ring band, a voicemail-heavy 0-11 s band emits the
`IMMEDIATE VOICEMAIL EXISTS` finding with its Wilson interval, and
`E-unconnected` is the only genuine data-integrity control left (a
not-connected row carrying a real conversation means the stored `connected`
flag is wrong). Pinned three ways.

(d) **The decisive number is no longer just "is the band voicemail?" but
"what SHARE of all voicemail is immediate?"** The sampler can now measure
both, because the bands tile the ring space -- but converting per-band shares
into a true recall figure needs each band's POPULATION size as a weight, which
the scorer does not yet have. Until it does, read the per-band shares as
directional, not as a recall percentage.

**Caveat on independence, and a hard limit of this sample:** the two
voicemails are one agent minutes apart on a callback run, and the human is a
different agent. So with three calls from two agents, **every agent-level
attribute is perfectly confounded with the outcome** -- department (`Field
Operations (Market Activity)` vs `Inside Sales`), brand (`UniversalMed` vs
`UniversalMed (Sales)`), extension, roster. None of those can be read as a
discriminator from this sample, however suggestive the split looks. That
confounding is precisely why the sampler draws at random across the window
instead of taking whatever is to hand.

**One labelled example already exists, and it raises a question the audit
should answer first (owner, 2026-09-22).** An outbound call on 2026-09-21 at
4:55 PM CST, 29 s, where the agent reached voicemail and left a message. Two
things follow. (1) It confirms the LABEL is directly observable from the
recording -- the automated greeting and the agent's message are both audible
-- which is the premise Step 1b rests on. (2) **It does not yet support the
band, and might cut against it.** If that 29 s is the WHOLE call, then ring +
message ≈ 29 s, leaving far too little for a 20-32 s ring plus a spoken
message -- which would mean voicemail here answers FAST rather than after a
carrier no-answer timeout, and the band premise weakens. If the 29 s is TALK
only, it is consistent. **So the cheapest next measurement is a single-row
parity check, not 46 labels:** take this exact call, read its ring / talk
split in the console, and compare against its stored `ring_seconds` /
`talk_seconds` row. One row either supports the timeout model or undermines
it before any listening effort is spent. (Caveat: 2026-09-21 must be imported
for the stored row to exist.)

**Sequence: 1b comes BEFORE Step 2.** No parameter should be set from the band
alone. If stratum C comes back mostly machines, the band is validated and Step
2 proceeds with a measured precision figure to disclose. If it comes back mixed,
the honest outcome is that `ring_seconds` cannot carry this classifier here, and
Part 1's table needs a different treatment of `connected` -- a relabel rather
than a reclassification.

### GROUND TRUTH round 2: 53 labels -- ring time is not a classifier (owner, 2026-09-23)

Run "Review 20260922-1313", 53 of 54 rows labelled. Weighted by each band's
share of the 62,646 connected first-attempt calls in the #64 ring histogram
(a different, earlier window -- directional, not exact):

| Ring band | Share of connected | Voicemail (labels) | 95% interval |
|---|---|---|---|
| 0-1 s (A) | 40.6% | 3/8 (+1 ivr) | 14-69% |
| 2-11 s (B) | 26.2% | 1/5 | 4-62% |
| 12-19 s (B2) | 10.7% | 5/12 | 19-68% |
| 20-32 s (C) | 22.0% | 13/20 | 43-82% |
| 33+ s (D) | 0.6% | 4/5 | 38-96% |

**Voicemail is an estimated ~40% of all connected calls**, and its share
RISES with ring without ever splitting: a `>= 20 s` rule flags 23% of calls
at ~65% precision and catches only **~37% of all voicemail**; `>= 12 s` gets
~58% precision and ~48% recall. The bulk of voicemail sits in the 0-1 s band,
where ring says nothing. Stratum C's 65% cannot be settled by listening
(~350 rows to clear the 60% bar) -- the scorer now says so instead of asking
for more.

**Conclusion: the stored CDR cannot tell a person from a machine**, and the
open-ended voicemail variants (message left / no message / screening) are
less separable still. The CDR reports all four answerers identically
(Answered, talk > 0); ring carries a gradient, not a boundary. Only the AUDIO
can decide it (a person listening, or the phone system's own answering-machine
detection / speech analytics if it offers one). The talk-time comparison the
scorer now runs is the last stored-duration check; unless it passes -- and
then on a FRESH sample -- **Step 2 is superseded: no `OUTBOUND_VM_RING_SEC`,
no `strict`.** `connected` is relabelled as "answered (person or machine)"
and the reached figure disclosed as an upper bound.

**SHIPPED the same day, with two owner rulings.** (1) The word stays
**"Connected"** -- "Picked up" was proposed and rejected as MORE misleading --
but it is DEFINED wherever it appears through one client constant,
`OB_CONNECTED_DEF_` (glossary tooltips on the Outbound + Direct reports'
Connected / Connect % / OB connected labels, the Caller Lookup and agent-day
chips, the call-path head). The callback tile "Actually reached" became
**"Callbacks connected"**, its foot and the caption / email footer calling it
an upper bound on callers reached. (2) **Audit figures stay out of the
reporting**: the owner keeps auditing raw calls as research, and no measured
voicemail share appears on any surface -- the definition string is pinned to
carry no number. Steps 2-4 below are SUPERSEDED; the per-dept callback table
(Part 1) is unblocked, since it ranks by called-back and any connected column
inherits the definition.

**The talk-time follow-up (same day).** Re-scored after deploy, the same
run's labels showed TALK separates far better than ring: person median 147 s
(none under 62 s), voicemail median 37 s, and the best window -- talk 8-79 s
-> machine -- scored 92% balanced accuracy. That window was FITTED to the rows
it was scored on, and the ring-drawn sample held no fast-hang-up person call,
the rule's most likely failure. So it is now **pre-registered**
(`OB_REVIEW_TALK_RULE_`, pinned) and tested on a fresh TALK-stratified draw,
`sampleOutboundCallsForReviewByTalk()`, weighted toward the rule's edges; the
scorer applies the rule as-is (Operator State #71). Research only either way:
the owner ruling keeps audit findings out of the reports.

**Open, and it outranks everything above: the E control failed** (0 of 3
unconnected rows came back no-answer; 2 human, 1 voicemail). The likely cause
is the lookup, not the data -- an unconnected call often has no recording, so
agent + time lands on the agent's next call (usually the redial, a separate
row). Check each E row's recording start against its row time, and whether
the agent redialled within a minute. A match would mean `connected` itself is
wrong.

### Step 2: the parameters

All READ-time, not capture-time. `connected` / `talk_seconds` / `ring_seconds`
stay exactly as stored — they are facts. Classification is a lens over them,
which means the thresholds are tunable without a re-import and **every
historical row reclassifies for free**. This is the same posture as
`QUEUE_SPLIT_SCOPE` and the read-source flags.

Each needs a `PROP_REGISTRY_` entry in the same commit (the registry rule) and
a numbered Operator State item.

| Property | Gates | Candidate | How to pick it |
|---|---|---|---|
| `OUTBOUND_ANSWER_QUALITY` | the whole feature: `off` (today's boolean) / `disclose` / `strict` | `off` | ship dark, flip after the probe — the `QUEUE_SPLIT_SCOPE` precedent |
| `OUTBOUND_VM_RING_SEC` | connected calls whose ring ≥ this are *likely voicemail* | 22 | the left edge of the timeout spike in the ring histogram |
| `OUTBOUND_VM_RING_TOLERANCE_SEC` | half-width of the spike, so a clean bimodal distribution is matched tightly instead of by a half-open threshold | 4 | the spike's observed width |
| `OUTBOUND_MIN_TALK_SEC` | connected + talk below this is *not a conversation* (a hangup, a misdial answered) | 10 | the trough in the talk histogram, if there is one |

**`OUTBOUND_ANSWER_QUALITY` is the important one.** Three modes, and the
middle one is the recommendation:

- `off` — today's behavior exactly. Byte-identical payloads. The default, so
  deploying this changes nothing until someone decides.
- `disclose` — **recommended.** The boolean becomes a three-way outcome and
  the uncertain band is shown as its own category rather than being silently
  reassigned. Nothing is subtracted from any existing number; a new,
  narrower number appears beside it.
- `strict` — `reached` excludes the likely-voicemail band outright.

### Step 3: the outcome model

Replace the connected boolean *at read time* with:

```
reached          connected AND NOT likely-voicemail AND talk >= MIN_TALK
voicemail-likely connected AND ring within [VM_RING - TOL, VM_RING + TOL]
brief            connected AND talk < MIN_TALK
no-answer        NOT connected           (already split brief/real by ring, point 4)
```

**Why `disclose` over `strict`:** every other place this codebase meets an
unrecoverable ambiguity, it shows the ambiguity instead of guessing — the
`#REBUILD` sentinel, the UNKNOWN ring bucket from point 4, `meta.partial` on a
budget-truncated queue report, the 6d tier banner. A voicemail classifier is a
heuristic on someone else's phone system; presenting its output as fact would
be the first place here that hides a guess inside a number. A third category
also degrades safely: if the probe shows no spike, `voicemail-likely` is
near-empty and the surface just says so.

### Step 4: what it changes

> **SUPERSEDED 2026-09-23** -- no classifier; see "GROUND TRUTH round 2".
> Kept as the record of what was planned.

- `kpis`: `obReached` / `obVoicemailLikely` / `obBrief` alongside
  `obConnected` (which KEEPS its current meaning — nothing reinterprets a
  stored field).
- `callback.calledBackReached` + `calledBackReachedPct` — the honest version
  of "Actually reached". The current tile either adopts this or is relabelled
  to "Answered by something".
- The **email** and the **CSV** inherit it.
- **Both paths**, as always: the SQL and the sheet fallback feed one shaper,
  and `outbound-fallback.test.js` compares them byte for byte. The
  classifier must be ONE pure function both call — the
  `outboundClassifyRing_` pattern from point 4.
- `outboundReport:v4` -> `v5` (v4 was taken by broad-scan Batch 6's PCR-1/PCR-3).

---

## Part 1 — the per-dept callback table

**Owner rulings, 2026-09-15** (the three questions this section used to end
with):

1. **Rank by called-back** — specifically the OWN-DEPT column (confirmed
   2026-09-15), with reached beside it. A heuristic column does not drive an
   ordering.
2. **Sub-queues follow `queuesForDept_`** — a parent's row includes its
   children's queues, so this reconciles with every other queue rollup.
3. **Separate by the DEPT'S AGENTS** — the table must show whether a dept
   called back its OWN customers. Clarified the same day with the operating
   model (below): depts are RESPONSIBLE for their own callbacks, and when
   another dept takes the customer's call they email the owning dept to make
   it. That model is what makes ruling 3 buildable as a real rate; the rest
   of this section is written around it.

### The operating model (owner, 2026-09-15) — this is what the table measures

The clarification that settles the design:

> **Depts are expected to be responsible for their own callbacks.** An agent
> from another dept may take the customer's call, but they then EMAIL the
> appropriate dept to do the callback.

Three consequences, and together they simplify the plan rather than
complicating it:

**1. The rate is coherent after all.** The previous draft of this section
worried that a per-agent-dept percentage is not a rate, because callbacks
dialed by dept X and abandons on dept X's queues are different populations.
Under the operating model they are the SAME population in the normal case:
dept X owns its abandons and dept X is expected to dial them. So the headline
becomes a strict subset of its own denominator and cannot exceed 100%:

```
own-dept callback rate = abandons on X's queues called back BY AN X AGENT
                         ------------------------------------------------
                         trackable abandons on X's queues
```

That is the accountability number ruling 3 was reaching for, and it needed
the operating model to be expressible. **The earlier >100% objection is
withdrawn** — it applied to a design nobody wanted.

**2. The email handoff is INVISIBLE to the CDR, and that is fine here.** A
handoff is an email; nothing in the call data records it. It does not need
to: the handoff exists precisely so the OWNING dept makes the call, so the
outbound still comes from dept X and still matches dept X's abandon by hash.
The mechanism is invisible and the outcome is exactly what the diagonal
measures. (One cost, under "What this does not capture" below.)

**3. Cross-dept callbacks should therefore be RARE, which makes them a
signal.** If another dept dialed one of X's abandoned callers, either the
handoff was skipped or the queue is mapped to the wrong dept. Worth seeing,
not worth a column per dept.

### The shape: own / other / none, not an N x N matrix

The previous draft recommended a full cross-tab (rows = abandon's dept,
columns = every dialing dept). Under the operating model that is more
structure than the question needs — the off-diagonal is expected to be
sparse, and "which OTHER dept helped" is a rare follow-up, not the headline.

**Recommended row shape:**

| Department | Trackable abandons | Called back by US (n, %) | By another dept (n) | Not called back (n) | Reached (n, %) | Median time | Pending |
|---|---|---|---|---|---|---|---|

- **"Called back by US" is the ranked column** (ruling 1: rank by
  called-back). It is what the dept controls and what the operating model
  holds it to.
- **"By another dept" is the exception count**, and the tension is worth
  stating on the surface: the CUSTOMER was served, but the OWNING dept did
  not do it. Ranking on own-dept slightly penalises a dept whose partner
  covered for them — accepted deliberately, because the owner's model is
  accountability for your own queue. The total (own + other) stays visible
  so nobody mistakes a low own-rate for an unanswered customer.
- The three call columns **sum to trackable abandons**, which is the
  arithmetic property that makes the row readable at a glance.
- **The full N x N matrix becomes a row EXPAND**, not the default layout —
  available when someone asks "who covered for us?", absent otherwise.

### Crossover agents: still need handling, smaller blast radius

An agent on two rosters (CSR + Sales) dialing a callback still has to land
somewhere. With own/other/none the question narrows usefully: the only thing
that matters is **is this agent a member of the ROW's dept?**

- if the dialing agent's homes INCLUDE the row dept -> **own** (correct under
  the operating model: an agent of that dept did the callback, whatever else
  they are);
- otherwise -> **other**.

That is unambiguous, needs no Multi-home column, and cannot double-count —
each callback lands in exactly one bucket per row. The N x N expand still
needs the Multi-home treatment described earlier, which is another reason to
keep the matrix as a drill rather than the default.

Two buckets still need naming, both from existing precedent:

- **Unrostered dialer** (ex-employee, orphan spelling) — counts as `other`,
  since they are provably not a member of the row dept, but the EXPAND should
  name them rather than implying a peer dept did the work.
- **No agent recorded** — `outbound_calls.agent_name` is NULL when the
  capture could not resolve a name. Also `other`, also named in the expand.

### The clock starts at the ABANDON (owner ruling, 2026-09-15)

**Time-to-callback is measured from the moment the customer hung up, not from
when the owning dept learned about it.** Ruled explicitly, and the
distinction matters to anyone tempted to "improve" it later.

An earlier draft of this plan treated the handoff delay as an unfortunate
skew to apologise for: on a handoff the clock starts when the customer
abandoned on another dept's queue, while the owning dept only found out when
the email arrived, so a prompt response reads as slow. **That framing was
wrong, and the ruling corrects it.** The measurement is from the CUSTOMER's
perspective, where the wait began when they gave up. Internal handoff time is
part of the company's response, not an exemption from it — a two-hour
handoff followed by an instant dial is a two-hour wait as far as the caller
is concerned, and a metric that hid that would be measuring the org chart
rather than the service.

So this is a deliberate definition, not a limitation:

- **Do NOT attempt to net out handoff time.** The email is invisible to the
  CDR, so any such adjustment would be invented; and even if it were
  measurable, the ruling is that it should not be subtracted.
- The surface says what the clock measures ("elapsed since the caller hung
  up, including any internal handoff") so the number is not mistaken for
  agent responsiveness.
- A dept with a slow median and a healthy own-dept RATE is a handoff-latency
  story, not a calling-discipline one. Both numbers sit in the same row, so
  the reader can tell those apart without the metric doing it for them.

### Attribution on the abandon side is still simple

`inboundDeptPredicate_` has two arms: an answered-on-hold arm keyed on
`final_dept`, and an entry-queue arm. The on-hold arm requires
`disposition = 'answered'`.

The callback denominator is `disposition = 'abandoned'` — so **the on-hold arm
can never fire for this population**, and the ROW dept reduces exactly to:

```
lower(trim(coalesce(entry_queue,''))) IN (<dept's queue list>)
```

Worth verifying with a test rather than trusting this paragraph, but if it
holds the row axis is one GROUP BY instead of 14 queries.

### Implementation: one query, a two-part key, folded client-side

Three options considered for the ROW axis:

| | Approach | Verdict |
|---|---|---|
| (a) | run the existing `callbackSel` once per dept | 14x the lateral. Rejected on cost. |
| (b) | one query with a dept CASE expression | needs the predicate as a projection, not a filter — a real refactor of a function five surfaces depend on. Rejected on blast radius. |
| (c) | **one query grouped by `entry_queue`, folded to depts in the shaper** | **recommended** |

(c) wins on a property the others lack: **a queue mapped to TWO depts (the M2
double-mapping case) folds into both**, which is the documented Overview
behavior. A SQL `GROUP BY dept` physically cannot do that without duplicating
rows. The grouping keys are few, the queue->dept map is already loaded, and
the sheet fallback iterates rows in JS so it mirrors trivially.

**Ruling 3 widens the key but not the cost.** The `cbLateral` already selects
`o.connected` and `delay_sec` from the matched outbound row; add
`o.agent_name` and group by the PAIR:

```
callbackCells: [{ queue, callbackAgent, tracked, calledBack, reached }]
   -> shaper folds queue -> row dept (inboundQueuesForDept_, queuesForDept_
      rollup per ruling 2), then per row asks only "is this dialing agent a
      member of THIS dept?" (buildDeptsByAgent_) ->
callbackByDept: [{ dept, tracked,
                   ownCalledBack, ownPct, ownReached, ownReachedPct,
                   otherCalledBack, notCalledBack,
                   medianSec, pending,
                   byCallerDept: {...} }]   // the EXPAND only
```

`ownCalledBack + otherCalledBack + notCalledBack === tracked` is the
invariant to pin first — it is what makes every row readable, and it is the
one thing a grouping bug would quietly break.

Still ONE round trip and one GROUP BY; the key is (queue x agent), which at
this volume is a small grid. `tracked` must be summed on the QUEUE axis only —
an abandon has one dept and must not be counted once per dialing agent, which
is the arithmetic trap in this shape.

**Unmapped queues get their own row, never silent omission** — the totals must
reconcile against the scope KPIs, and a queue mapped to no dept is a Dept
Config gap the admin should see (the `unmappedQcd` nag precedent).

### Scope and placement

- **COMPANY VIEW ONLY.** On a single-dept view the row axis collapses to one
  row that duplicates the KPI tiles above it — though note the COLUMNS would
  still be informative there ("who called back OUR abandons"), so a
  single-dept variant showing one row's column breakdown is a reasonable
  later addition.
- A new section between the callback KPIs and the per-agent table.
- Rows sortable, worst-first by default (ruling 1: rank by called-back %).
- Row columns: Department · Trackable abandons · Called back by US (n, %,
  the ranked column) · By another dept (n) · Not called back (n) · Reached
  (n, %, once Part 2 lands) · Median time · Pending. The per-dialing-dept
  matrix is a row EXPAND, not a default column set.

### What ruling 3 makes MORE important

Under agent attribution, a dept whose agents dial diligently but reach
voicemail every time looks productive. **The reached column is what separates
effort from outcome**, so Part 2 is not merely sequenced before this — it is
what keeps this table from rewarding dialing over connecting.

### Sequence

1. ✅ **DONE (2026-09-15), and RUN (2026-09-15).**
   `probeOutboundAnswerQuality()` built and run over 2026-08-18..09-14
   (66,207 single-attempt connects). Verdict: **INCONCLUSIVE, correctly.**
   What the data actually shows, none of which the plan anticipated:
   - the voicemail signal is **four spikes** (17 s / 21 s / 27 s / 31 s,
     ~5–6 s apart — ring-cadence harmonics, i.e. destinations handing to
     voicemail after a different NUMBER of rings), not one tight spike. FWHM
     around the tallest holds 7.6%, which is why the share gate refused;
   - a **hard cliff at 32→33 s** (1,224 → 115). 99.3% of connects ring ≤ 32 s;
   - **40.6% of connects ring 0–1 s** (17,197 at exactly 0, no NULL rings).
     The repeat-callee check corroborates: its largest cluster is 3,446
     callee-groups connecting at 0 s *repeatedly*.

   **Step 1b (2026-09-16): `probeOutboundInstantConnects()`** built to settle
   that last point — see Operator State #65. **Its run is owed, and step 2
   cannot start until its verdict is read**, because the 0–1 s population
   caps any ring-based classifier at ~60% of calls regardless of threshold.
   If the verdict is `connected-timestamp` the ring is recoverable and the
   population comes back; if it is `carrier-instant` the ceiling is permanent
   and the classifier must exclude and disclose those calls.
2. Set the Part 2 parameters from what the probe shows; ship the classifier
   `off` by default, both paths, one shared pure function.
3. Flip to `disclose` after eyeballing a window; fix or relabel the
   "Actually reached" tile.
4. Verify the entry-queue-only attribution claim with a test.
5. Build the table on the corrected numbers, with the crossover/unrostered/
   no-agent columns explicit from the first commit — retrofitting a
   disclosure after people have read the numbers is how a misattribution
   becomes institutional. `v3` -> `v4`.
6. Regression scenario + `drive-admin` coverage, as with every surface here.

**Steps 1–3 are worth doing even if the table is never built** — the tile that
says "Actually reached" is live for admins today. **(2026-09-23: steps 2-3
SUPERSEDED -- the tile was relabelled "Callbacks connected" instead; step 5
is unblocked.)**
