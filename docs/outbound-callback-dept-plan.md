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
both is not.**

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
- `outboundReport:v3` -> `v4`.

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

1. ✅ **DONE (2026-09-15).** `probeOutboundAnswerQuality()` built. *(No
   product change — it measures and sets nothing.)* **The run itself is
   still owed**: it needs live Neon, so it is an operator step (#64), and
   step 2 cannot start until its verdict is read.
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
says "Actually reached" is live for admins today.
