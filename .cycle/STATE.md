# Cycle State — resume note

## Current
Cycle: 261
Phase: implement
Scope: broad (/broad-scan, whole codebase)
Test Command: node --test
Subsystem cycles since last Seams audit: 0
Updated: 2026-11-25
(Cycle seeded 2026-10-13 at the /sync-commands to claude-workflow-tools
v1.43.0: the new CYCLE OPEN step increments this field, and the blocks are
numbered by session up to 258, so the next audit opens cycle 259. The Seams
counter starts at 0 here because no earlier count was kept.)

## Open follow-on items
(One line each: ID | where -- what | -> disposition. Rule: the FOLLOW-ON IDS step of the implement commands, since the 2026-11-23 command sync. Older follow-ons are still prose inside the entries below and carry no IDs.)
- FO-260-1 | script-8-insights.html: the "queues with no calls" fold row keeps its open state on the tbody, so it stays open across a department switch within one session | -> confirmed as F25 (Cycle 261)
- FO-260-2 | script-8-insights.html: insRenderQhChart_'s partial-month marking pairs the queue chart's month labels with the team trend's month keys by equal LENGTH alone; a probe outside TZ=America/Chicago showed them one month apart at equal length (harness artifact; QH2's marks no longer depend on it) | -> confirmed as F26 (Cycle 261)
- FO-261-1 | Data.gs computeSummary_ (+ IR / Insights): the prior / trend window still takes the CURRENT window's queue-split verdict, so a mapping that changed mid-span narrows the prior to zero; a per-window verdict needs one pass per window | -> next audit
- FO-261-2 | cdr-import buildDQEHistoricalData.js TT-1: whether the S2C-1 talk leg is top-level in live data is unverified; if `previewCallLegShapes` prints "none reached", the build must read the child leg instead | -> decision (owner runs the probe, reports the "DQE talk (TT-1)" line)
- FO-261-3 | cdr-import autoImport.js processIntegratedHistory block 6: a daily Direct write that misses Neon is still not put in the pending ledger; the retention prune (day 15) is the backstop since PCC-1, so with no prune trigger (#43) nothing catches it | -> next audit

## OPEN NOW (read this first)
- **2026-11-26 -- Cycle 261 Batch 3 IMPLEMENTED (block `.cycle/blocks/261-batch3-broad-implement.md`).** Dashboard only. Scan F3 -> **RH-1**: `neonJourneyHeldFromIso_` (NeonRetention.gs) is the journey retention edge; Transfer retries and the partial-day suggestions start their read there, the Inbound report names it in `meta.retentionNotes` (page, CSV, email); INV-69 gains a sweep over every journey reader. Scan F4 -> **RH-2**: the Inbound report drops a prior window that starts before capture ("No comparison"), `inbound:v18`. 3,211 tests + `ci:ui` (all 18 drivers) green; net 0.
  **Where I left off:** committed + pushed on claude/wonderful-bardeen-vcbwse; no PR (not asked). Owner-side: deploy the dashboard; walk S38 / S69 / S73. Next in the plan: Batch 4 (sends that fail silently: F5, F33, F32, F6, F34, F35).
- **2026-11-25 (2) -- Cycle 261 Batch 2 IMPLEMENTED (block `.cycle/blocks/261-batch2-broad-implement.md`).** cdr-import only. Scan F1 -> **PCC-1**: `dcNeonDirectOwed_` asks Neon whether a date's Direct data is whole (`direct_call_history` present; `direct_calls` present when calls were counted); the pending catch-up, the retention prune's last check and Make a date whole rebuild an owed date from its Call_Legs tab and keep it owed while Neon cannot take it. Scan F36 -> **PCC-2**: the bulk path queues before the force delete; P-7 appends before deleting stale queued rows. Scan F37 -> **PCC-3**: the CSR Transfer repair sets the CR-5 marker and re-verifies its rows before writing. 3,207 tests green; net −2 (two Low new failure modes, no fix shown to have fired).
  **Where I left off:** committed + pushed on claude/wonderful-bardeen-vcbwse; no PR (not asked). Owner-side: push cdr-import; walk S5 / S28 / S33 / S34. Next in the plan: Batch 3 (retention horizons: F3, F4).
- **2026-11-25 -- Cycle 261 Batch 1 IMPLEMENTED (block `.cycle/blocks/261-batch1-broad-implement.md`; scan `.cycle/blocks/261-scan.md`, gitignored, this checkout only).** Scan F2 -> **VS-1**: My Department, IR, Insights and the agent app take the queue-split verdict on the window they show (`verdictFromIso: from`); cache bumps summary:v28 / individual:v15 / insights:v31 / agentHome:v2. Scan F38 -> **TT-1**: the DQE build + drill credit the agent's own Outgoing top-level talk leg as a fallback; `previewCallLegShapes` prints whether live data reaches it. Codes re-filed because bare `F#` collides with the Neon family. Net −1 (honest: neither fix is shown to have fired; TT-1 may be inert).
  **Owner rulings recorded on the scan (2026-11-25):** F11 yes -> Batch 6; F15 manager-role and up -> Batch 5; F23 RETRACTED on re-read (the worklist menu and list always agree); F41 "yes, keep the earliest-queue rule" pending the worked examples -- stays Deferred until confirmed.
  **Where I left off:** committed + pushed on claude/wonderful-bardeen-vcbwse; no PR (not asked). Owner-side: push all three projects; `previewCallLegShapes()` and report the TT-1 line (re-import per #56 only if it says reached); `runLiveSmoke`; walk S1, S6, S14, S35, S37. Next in the plan: Batch 2 (per-call completeness: F1, F36, F37).

## Carried from Cycle 260 (still live; detail in `.cycle/HISTORY.md`)
- Dashboard deploy + walks still owed for the QH round (S32's QH + FO-260-3 steps, S61) and the MD round (S61, S25, S14 / S37, S32; the MD2 / MD4 size log lines).
- Earlier owner items: P11-S1's "Took N s" timing, S74, the partial-day read time, the team-tools change (#94), sign-off on the P4 card form, the `Other` column + `rebuildDirectCallHeldDates()`.
- 6c Outbound release to managers (#63), Batch 5 (end the timezone split) and Phase 3 remain the roadmap's open items.
