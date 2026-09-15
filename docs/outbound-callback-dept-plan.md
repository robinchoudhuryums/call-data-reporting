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

### Step 1: MEASURE, then set (do not skip)

A read-only, admin-gated, editor-run probe — `probeOutboundAnswerQuality()`,
sibling of `runOutboundVettingCheck` — over a representative window:

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

1. **Rank by called-back**, show reached beside it. A heuristic column does
   not drive an ordering.
2. **Sub-queues follow `queuesForDept_`** — a parent's row includes its
   children's queues, so this reconciles with every other queue rollup.
3. **Separate by the DEPT'S AGENTS** — the owner wants the table keyed on who
   DID the calling back, not on whose queue the caller abandoned from. This
   reverses the recommendation this plan opened with, and it changes the
   design materially rather than cosmetically. The rest of this section is
   rewritten around it.

### What ruling 3 changes, and the one thing it breaks

The original design keyed rows on **the abandoned call** (dept = its entry
queue). That gave every row a self-contained rate: numerator ⊆ denominator,
one dept per call, no crossover.

Keying on **the dialing agent's dept** breaks that, and it is worth being
exact about why rather than discovering it at render time:

**A callback and the abandon it answers can belong to different depts.** A CSR
agent calling back a caller who abandoned on the Sales queue is a normal,
deliberate event — "callbacks count no matter who dialed" is an existing
contract, not an accident. So:

```
numerator   = callbacks DIALED BY dept X's agents
denominator = abandons ON dept X's queues        <- a DIFFERENT population
```

Those two are not nested. A dept whose agents help out elsewhere can exceed
**100%**; a dept whose abandons are covered by other teams can read near 0%
while every caller was in fact called back. **A percentage built from them is
not a rate, and would be wrong in a way that looks plausible** — the worst
kind, because it ranks depts confidently.

So ruling 3 forces a choice about what the column even means. Three coherent
shapes:

| | Shape | Keeps a valid rate? | Answers "which dept called back?" |
|---|---|---|---|
| (i) | abandon-dept rows (the original) | yes | no |
| (ii) | agent-dept rows, **counts only** — no rate column | n/a | yes |
| (iii) | **CROSS-TAB**: rows = abandon's dept, columns = dialing agent's dept | yes (per row) | yes |

**Recommendation: (iii), the cross-tab.** It is the only one that satisfies
the ruling without inventing a rate from mismatched populations. Each ROW
still divides by its own abandons, so the rate stays honest and rankable per
ruling 1; the COLUMNS show which dept's agents did the dialing; and the
**diagonal** — own-dept callbacks — is the number most likely to be the real
question, with the off-diagonal showing cross-dept help that is currently
invisible everywhere in this app.

(ii) is the smaller build and is perfectly defensible as a pure ACTIVITY
table — "CSR agents made 143 callbacks this window" — as long as no
percentage appears in it. If the cross-tab reads as too dense, fall back to
(ii) rather than to a per-agent-dept rate.

### The crossover problem is back, and must be handled explicitly

This is exactly what the Option C ruling avoided by refusing per-dept agent
cards. Ruling 3 opts back into it, so the handling is now a design decision
rather than something the design sidesteps.

A dialing agent on TWO rosters (CSR + Sales) made one callback. Options:

- **count it in BOTH** — the columns then sum to MORE than the row total, and
  every total needs a "counted in each home" caption or it reads as a bug;
- **count it in ONE** (first home alphabetically) — silently misattributes,
  and the same agent's work lands in a different column than their agent-table
  row would suggest;
- **give crossover agents their OWN column** ("Multi-home") — honest, no
  double-count, and the cell is small enough to ignore when it is small.

**Recommendation: the third.** It is the only one where every number sums
correctly AND nothing is silently misfiled. It also self-discloses: if that
column is large, the install has more crossover than anyone assumed, which is
itself worth knowing. `buildDeptsByAgent_` already returns the full home list,
so the classification is free.

Two more buckets the columns need, both from existing precedent:

- **Unrostered dialer** — an agent on no roster (ex-employee, orphan
  spelling). The report already counts these for its `meta.unrosteredAgents`
  disclosure; here they need a visible column, not a silent drop.
- **No agent recorded** — `outbound_calls.agent_name` is NULL when the
  capture could not resolve a name (a phone-shaped callee name is nulled at
  capture). Its own bucket, never folded into a real dept.

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
      rollup per ruling 2) and agent -> column dept (buildDeptsByAgent_,
      with the Multi-home / Unrostered / No-agent buckets above) ->
callbackMatrix: { rows: [{ dept, tracked, calledBack, calledBackPct,
                           reached, reachedPct, byCallerDept: {...} }],
                  columns: [...] }
```

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
- Row columns: Department · Abandoned (trackable) · Called back (n, %) ·
  Reached (n, %, once Part 2 lands) · Median time · Pending · then the
  per-caller-dept breakdown.

### What ruling 3 makes MORE important

Under agent attribution, a dept whose agents dial diligently but reach
voicemail every time looks productive. **The reached column is what separates
effort from outcome**, so Part 2 is not merely sequenced before this — it is
what keeps this table from rewarding dialing over connecting.

### Sequence

0. Decide (iii) cross-tab vs (ii) counts-only, if the recommendation above is
   not adopted as written. Everything below is the same either way.
1. `probeOutboundAnswerQuality()`, read the distributions. *(No product change.)*
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
