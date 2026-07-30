# Per-queue split of DQE agent metrics — design plan

**Status:** Phases 0, 1 and 2 IMPLEMENTED (see §6 for the phase table). Phases 3-4 open.
**Reported:** 2026-07, after the sub-queue scope switcher shipped — "if I go to
the Spanish-only view, those agents' numbers are for all of those agents' calls
from both CSR and Spanish queues, instead of highlighting the respective part of
the split."

---

## 1. What is actually wrong

A `DQE Historical Data` row is keyed on **(Date, Agent)** and nothing else.
`buildDQEHistoricalData.js`:

```js
const legs = queueLegs.filter(l => l.agentName === agentName);   // ALL queues
```

Every per-agent figure — Total Unique, Rung, Missed, Answered, TTT, ATT, the 19
half-hour missed-time slots (K–AC) and the abandoned columns (AD/AE/AF) — is
computed from that queue-blind list. The dashboard then attributes a row to a
department by **exact roster-name match** (INV-04) and takes the whole row;
`Data.gs` never filters counts by queue.

So for an agent on two rosters (CSR + Spanish here):

| symptom | severity |
|---|---|
| Spanish-only view shows the agent's **CSR + Spanish** calls | the reported bug |
| CSR-only view shows the same inflated number | same root cause |
| **Combined view lists the agent TWICE** (one row per dept group) | visible |
| **Combined grand total double-counts every crossover agent** | *worse than reported* |
| Missed timelines show CSR-queue misses inside the Spanish view | knock-on |

The last two were not in the report and should be weighed when scheduling. Note
that the per-dept **subtotal parity** property still holds — a dept's subtotal
equals its own view because both come from the same `computeSummary_` call. The
parity is intact; the number being compared is queue-blind on both sides.

## 2. Why this is fixable — the data exists upstream

Every queue leg already carries its queue identity:

```js
queueLegs.push({ agentName, queueExt, queueName, parentCallId, callId,
                 missed, answered, startPST });
```

`queueName` is the RAW phone-system name (`A_Q_CSR`, `A_Q_Spanish`,
`Backup CSR`) and is guaranteed present — a leg whose caller-ID has no
recognizable queue name is skipped before this point. The aggregation simply
doesn't group by it.

**Key the split on `queueName`, not `queueExt`.** Extensions look like the
natural key (col D already holds them) but the dept→ext mapping is *circular*
for precisely this case: `getDeptQueueExts_`'s derived mode collects col D
extensions "from any row whose agent is on this dept's roster", so a crossover
agent teaches Spanish that the CSR extension is Spanish's. Its own docstring
anticipates the trap — the `DEPT_QUEUE_EXT_OVERRIDES` escape hatch exists
because "CSR agents covering A_Q_Spanish … should NOT count toward this dept".
Queue **names** have a non-circular, already-admin-curated dept mapping in
`inboundQueuesForDept_` (= `queuesForDept_` ∪ the Dept Config *Inbound Queue
Aliases* raw names), which the Missed report already uses for exactly this
raw-name→dept job (R8-1).

## 3. The hard constraint: history cannot be split retroactively

`DeleteOldSheets.js` prunes `Call_Legs_*` at **14 days**. The per-leg queue
identity exists only there. So:

> **A per-queue split can only ever cover dates built after the pipeline change
> ships, plus whatever part of the trailing 14-day window is backfilled
> immediately.** Every earlier date is permanently unsplittable.

Three consequences that shape the whole design:

1. **Shipping the pipeline half early has standing value even with no reader
   consuming it.** Each day of delay is one more permanently unsplittable day.
   This is the same argument as the F1b queue-recognition fix.
2. **Readers need a defined, visible behavior for pre-split dates.** A range
   spanning the cutover mixes split and unsplit rows. Showing them
   interchangeably reproduces today's bug silently, which is worse than the bug
   itself — a manager would have no way to know which is which.
3. **A one-off "fix history" is not available.** Anything promising fully split
   history is wrong.

## 4. Schema options

### Option A — per-queue breakdown column, keep the (date, agent) grain *(recommended)*

Append one column holding the per-queue figures for that agent-day (per queue:
rung / missed / answered / unique / talk seconds, and the missed-slot times).
Existing columns keep their current all-queue meaning as a rollup.

- Every existing reader stays byte-identical; readers opt in one at a time.
- `uq_dqe_history (call_date, agent_name)` is untouched — and it is depended on
  by the authoritative per-date replace (IMP-5/IMP-6), `renameAgentInNeon_`,
  the DAL's normalized per-(date,agent) shape, `compareDqeSources_`, and the
  cache keys.
- Row count unchanged (relevant to the Apps Script write budget and the ~100 KB
  per-value cache ceiling).
- Non-destructive column append is the established pattern here (Skip Dates,
  Inbound Queue Aliases, Final Dept Labels).
- **Honest cost:** it is a denormalized blob — fine for "read the row, take my
  dept's slice", poor for ad-hoc SQL analytics per queue. If per-queue SQL
  reporting is wanted later, Option B is the better substrate.

### Option B — one row per (date, agent, queue)

Normalized and SQL-friendly, but changes the row grain: new unique constraint,
Neon migration, DAL rewrite, every reader re-summing to get today's numbers,
every cache key bumped, and row count multiplied. Larger and riskier for the
same user-visible outcome.

### Option C — derive at read time

Not viable. Raw Data is gone after 14 days, and `inbound_calls` covers only
inbound calls, not the per-agent ring detail DQE is built from. It would also
create a second source of truth for numbers DQE owns.

## 5. Proposed phasing

Each phase ships independently and leaves the product correct.

**Phase 1 — pipeline writes the breakdown. No reader changes.** SHIPPED.
`dqeQueueSplitForAgent_` groups the agent's window legs by `queueName` and emits
col **AI** (`HISTORICAL_COLS.QUEUE_SPLIT`, 35) as JSON; both INV-16 copies, plus
`queue_split` on `dqe_history` and every writer that touches it. Zero behavior
change anywhere -- cols A..AH are pinned byte-identical -- so it deploys
immediately and starts accumulating splittable history the same day. No separate
backfill function: re-running the existing DQE build (force re-import) for a
surviving date rewrites its rows with the split, which is the documented
operator step.

**Phase 2 — My Department consumes it.** SHIPPED. `applyQueueSplitToRows_`
narrows each source row to the dept's own queues (matched case-insensitively
against `inboundQueuesForDept_`) BEFORE `computeSummary_`'s aggregation loop, so
every rule inside that loop inherits the narrowing unchanged. **Fails open three
ways** — an unmapped dept, a row with no split, and unparseable JSON all keep
the rollup — because showing a department zero calls is far worse than showing
it too many. Each row carries `queueScoped`, and the client renders a
warn-tinted "per-queue detail starts `<date>`" note for any range that isn't
fully split. This also inverts Phase 0: a scoped row is never de-duplicated,
because two narrowed rows partition the day and summing them is now correct.
`summary:v18` (Phase 0 took v17).

**Phase 3 — Missed report.** Split slots + AD/AE/AF so per-agent timelines and
the hour-of-day chart are queue-scoped. `missed:v17→v18`.

**Phase 4 — IR / Insights.** Per-agent cards, team averages, trends.
`individual:v*`, `insights:v19→v20`.

Phases 3–4 are only worth doing after enough split history accumulates to make
their windows meaningful.

## 6. Owner decisions (settled 2026-07)

1. **Schema: Option A** — per-queue breakdown column, (date, agent) grain kept.
2. **Pre-split dates: show, marked.** A sub-queue view renders the unsplit
   number for dates before the cutover, visibly flagged, with a "split from
   `<date>`" note naming when the split begins. Continuity over holes — but the
   marker is not optional, because an unmarked unsplit number in a sub-queue
   view *is* the bug being fixed.
3. **Interim mitigation: yes.** De-duplicate crossover agents in the combined
   view's grand total now, ahead of Phase 2. It does not fix attribution; it
   stops the total being arithmetically wrong while split history accumulates.
   Ships as **Phase 0**.
4. **Scope: all four phases.**

Revised order, with Phase 0 first because it is the smallest change and the
only currently-wrong *total*:

| phase | what | user-visible |
|---|---|---|
| 0 | de-dupe crossover agents in the combined grand total | yes — total corrects |
| 1 | pipeline writes the breakdown + backfill the ~14-day window | no |
| 2 | My Department consumes it (`summary:v18`) | yes — the reported bug |
| 3 | Missed report (`missed:v18`) | yes |
| 4 | IR / Insights (`insights:v20`, `individual:v*`) | yes |

Phase 1 should deploy as soon as it is ready even though nothing consumes it:
until it ships, every day becomes permanently unsplittable (§3).

## 7. Risks

- **Queue-name recognition drift.** The split inherits the DQE regex
  (`(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)`, IMP-8), which deliberately does NOT
  match brand-prefixed queues. That divergence from the inbound recognizer is
  intentional and must not be "harmonized" — see CLAUDE.md.
- **A queue mapped to no dept** yields a slice nobody claims. Needs the same
  discoverability treatment the inbound capture got (Dept Config surfaces
  unattributed queue names) or it fails silently.
- **Roster changes are not retroactive.** Splitting by queue name means a
  dept's historical numbers change if its queue mapping is edited. Today's
  roster-name matching has the same property, so this is not new — but it
  becomes more visible.
- **Crossover is currently CSR/Spanish only**, per the owner, "but it is
  possible that changes in the future". The design must not assume two depts or
  one crossover pair.
