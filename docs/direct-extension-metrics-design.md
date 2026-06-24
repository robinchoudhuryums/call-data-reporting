# Design — Direct-Extension Call Metrics (with busy carve-out)

Status: **DESIGN / APPROVED-DEFINITIONS — not built.** Planning record only; no
code written. Supersedes nothing yet; will become a CLAUDE.md entry + invariants
when Phase 1 lands.

## Goal

Per-agent metrics (answer %, avg talk time, volume) for **direct / individual-
extension calls** — inbound + outbound calls to/from an employee's own extension
— as a distinct population from **department call-queue** calls (which are
already covered by DQE Historical Data and the QCD report). The defining
requirement: when an employee misses an incoming direct call **because they were
already on another call**, that miss must **not** count against them.

## Scope boundary: direct vs. queue

- **Queue calls** = Raw Data legs whose `CALLER_ID` matches `A_Q_*` / `Backup
  CSR`. Already handled by `buildDQEHistoricalData` (DQE Historical Data) + QCD.
  **Untouched by this feature.**
- **Direct calls** = the non-queue legs (the `CALLER_ID` regex does NOT match).
  These ring exactly ONE extension (the agent's own); multi-extension /
  simultaneous ringing IS the queue mechanism, so there is no sim-ring
  false-miss inside the direct set.
- **Roll-over edge:** a direct call that then enters a queue or voicemail — the
  queue leg stays in the DQE/queue path; classification is per-leg by
  `CALLER_ID` + disposition, so a direct ring later answered via a queue is not
  also counted as a direct miss. **Must be spot-checked live.**

## Locked definitions (owner-approved)

| Question | Decision |
|---|---|
| Carve-out direction | **Inbound only.** You can't "miss" a call you placed. Outbound has no answer-rate-against-the-agent at all. |
| What makes an agent "busy" | **Any active leg** of theirs — internal/external queue, direct inbound, outbound. (An agent dialing an external callee is "busy" for this purpose.) |
| Active vs. ringing | Only legs the agent was actually **on** (talk/hold) make them busy. A leg where they were merely ringing-unanswered does NOT. |
| Busy window | `[answer_start, talk_end + DIRECT_BUSY_WRAPUP_SEC]` where the wrap-up tail = **5s** (Interpretation B; see below). `talk_end = answer_start + talk + hold`. |
| Overlap rule | **Any** overlap (≥1s) between a missed inbound ring's window and a busy window of a *different* call → `missed_busy`. No minimum-overlap floor. |
| Internal vs. external | **Both counted, and split** in the stored metrics. |
| Outbound | **Activity only** (placed / connected / talk-time / ATT). No pass/fail rate. Outbound legs DO feed the "busy" intervals. |
| `missed_busy` treatment | **Excluded from the answer rate (numerator AND denominator), but counted and displayed** as its own number (auditable, like `TEAM_AVG_EXCLUDES` / floater exclusions). |
| Compute location | **Import time**, in `cdr-import` (Raw Data is the only source with per-leg timing and is pruned ~14 days). Going-forward only; no deep backfill. |
| Persistence | **`Direct Call History` sheet (primary) + Neon `direct_call_history` mirror** (agent-day grain), like DQE/QCD. |
| Surfacing | **Dedicated dashboard modal/report**, per-dept gated (not folded into Individual Report). |

### The 5s wrap-up tail (Interpretation B), by example

Agent on a call **10:00:00 → 10:05:00**; a different call rings unanswered:
- ring **10:03:00** (mid-call) → overlaps → `missed_busy` (excused).
- ring **10:05:03** (3s after hangup) → within the 5s tail → `missed_busy` (excused).
- ring **10:05:08** (8s after) → past the tail, no overlap → `missed_free` (counts).

Rejected alternative (Interpretation A): "minimum 5s of overlap with the active
call." A ring grazing the tail of a call by <5s would have counted against the
agent. Not chosen.

### Answer rate

```
direct_inbound_answer_rate = answered / (answered + missed_free)
missed_busy                = surfaced separately, not in the rate
inbound_ATT                = ib_talk_sec / answered
```

## Agent attribution

Reuse the existing per-agent attribution already in
`autoImport.js::processIntegratedHistory` (the CDR Historical block already
groups direct calls per agent via the roster extension map from the dashboard
`DO NOT EDIT!` sheet, `"Name, ext1, ext2"`). Extensions not on any roster →
bucket as **unknown**, excluded (same discipline as queue sentinels).

## The new computation (the only genuinely new logic)

A pure, **unit-testable** helper (proposed `cdr-import/directCallMetrics.js`),
called from `processIntegratedHistory`:

1. From the day's Raw Data, group legs by attributed agent.
2. Per agent, build sorted **occupied intervals** = `[answer_start, talk_end +
   5s]` for every leg they were on (direct in/out + queue talk legs).
3. Per **missed inbound direct** ring (deduped to one event per parent call id,
   like DQE `uniqueParentCalls`), sweep for overlap against occupied intervals
   **from other calls** → tag `missed_busy` / `missed_free`.
4. Emit per-agent-day metrics (below).
5. All overlap math in **one timezone** — reuse `displayToTimeSec` / the
   PST-seconds-since-midnight convention the DQE build already uses (INV-02/20).

Complexity is trivial (per agent/day: sort + linear sweep).

## Data model — `Direct Call History` (agent-day grain)

Key columns: `Month Year | Date | Department | Agent`.

Metric columns (internal/external split per your decision):

Inbound (per internal / external):
- `ib_<int|ext>_answered`
- `ib_<int|ext>_missed_free`
- `ib_<int|ext>_missed_busy`
- `ib_<int|ext>_talk_sec`

Outbound (per internal / external):
- `ob_<int|ext>_total`
- `ob_<int|ext>_connected`
- `ob_<int|ext>_talk_sec`

Derived at read time (not stored): answer rate, inbound ATT, outbound ATT,
internal+external rollups. Internal vs. external decided by `DIRECTION`
(`Internal` vs. `Incoming`) for inbound, and callee being an internal extension
vs. an external number for outbound.

Neon `direct_call_history` mirrors these columns 1:1 (agent-day PK on
`(call_date, department, agent_name)`), written best-effort alongside the
existing CDR/QCD/DQE/Inbound writes, logged to Pipeline Health as
`processIntegratedHistory:Direct` (INV-44). Idempotent `ON CONFLICT DO UPDATE`.

## Dashboard surfacing (Phase 2)

Dedicated **Direct Calls** modal, per-dept gated like QCD/Individual. Per agent:
adjusted inbound answer rate, `answered` / `missed_free`, the surfaced
`missed_busy` count, inbound ATT, and outbound activity + ATT, with the
internal/external split available. Reads the sheet (or Neon mirror under the F1
read-back flag).

## Risks / live validations

- **Fairness + inference:** "busy" is inferred from time-overlap, not a feed
  field (no native Busy disposition). Desk+softphone, call forwarding, shared
  extensions, and consult/transfer legs can misfire. Phase 1 ships
  **numbers-only** so the operator spot-checks before any manager sees it.
- **Roll-to-queue/voicemail** classification (above) — spot-check.
- **TZ correctness** of overlap math.
- **No existing import-path test coverage** → the pure overlap helper gets new
  unit fixtures (bucket classification on hand-built leg sets). This is the one
  part that CAN be unit-tested.
- **INV-16 avoided:** logic lives in cdr-import-only modules, not the
  byte-identical duplicated `buildDQEHistoricalData.js` / `neonWrite.js`.

## Phased delivery

- **Phase 1 — compute + persist, NO UI.** Helper + overlap engine +
  `Direct Call History` sheet + Neon mirror + unit tests + Pipeline Health
  logging. Operator validates raw numbers against known agent-days.
- **Phase 2 — dedicated dashboard modal.** After numbers are trusted.
- **Phase 3 — tuning.** `DIRECT_BUSY_WRAPUP_SEC`, internal/external presentation,
  optional minimum-overlap floor, etc.

## Open items (pre-Phase-1)

- Confirm the **5s = wrap-up tail (Interpretation B)** reading (owner indicated
  yes; locked here pending final nod).
- Exact Raw Data column for outbound internal-vs-external classification
  (callee-is-extension test) to verify against live rows.
- Whether `hold` time counts toward the busy window (currently: yes —
  `talk_end = answer_start + talk + hold`).
