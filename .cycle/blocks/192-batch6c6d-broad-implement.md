---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- 6c | Outbound report RELEASE prep — everything the manager un-gate needs
  EXCEPT the un-gate itself, which is blocked on a live operator check:
  Operator State #63 (the runbook, previously only in .cycle/STATE.md), a
  named release switch whose two halves a pin keeps together, behavioural
  pins on the previously-dead per-dept path, the ci:ui driver stage, and
  Regression Scenario S46.
- 6d | Agent-day interaction view ("what did agent X do on day Y") — new
  AgentDay.gs + the #/report/agent-day modal, three-tier fidelity with the
  boundary DISCLOSED, roster-derived auth, Regression Scenario S47.

Files modified:
- apps-script/department-dashboard/AgentDay.gs                 (NEW)
- apps-script/department-dashboard/OutboundReport.gs
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-4-nav.html
- apps-script/department-dashboard/script-10-escalations.html
- apps-script/department-dashboard/script-2-chrome.html
- tools/ui-harness/drive-admin.js, tools/ui-harness/build-harness.js
- tests/unit/agent-day.test.js                                 (NEW)
- tests/unit/outbound-report.test.js, tests/unit/cross-file-pins.test.js
- tests/README.md, CLAUDE.md, docs/operator-state.md,
  docs/regression-scenarios.md, docs/per-call-capture.md,
  docs/module-dependencies.md (regenerated), docs/next-steps.md

CHANGES:

6c | OutboundReport.gs + dashboard.html + cross-file-pins.test.js | The
  admin-only throw now reads a named `OUTBOUND_VETTING_GATE_` switch, and the
  menu item carries a comment naming it. A new pin, "the outbound vetting gate
  and its menu item are released TOGETHER", reads the switch out of source and
  asserts the button's `data-admin-only` + `display:none` match it in BOTH
  directions. That pairing is the actual risk the runbook's step 3 carries: a
  visible item over a throwing server reads to a manager as a broken app, and
  a released server behind a hidden button reaches nobody and looks like the
  release silently failed. Nothing compared them before.

6c | outbound-report.test.js | Three tests flip the switch and exercise the
  per-dept manager path — which had been UNREACHABLE DEAD CODE since it was
  written. Pinned: a single-dept manager is pinned to their dept and cannot
  use `ALL` as an escape hatch; a multi-dept manager may pick any assigned
  dept and blank falls back to their first; an allDepts manager takes the
  admin-style branch; and flipping the switch changes NOTHING an admin
  resolves to (if it did, the switch is doing more than releasing).

6c | drive-admin.js + cross-file-pins.test.js | The outbound modal LEFT
  DRIVER_MODAL_EXEMPT. Its stated reason ("no harness fixture yet") had gone
  stale — build-harness.js already mocked both its RPCs. The driver's MODALS
  entries gained an optional `menu` (outbound lives under Reports, not Admin)
  and an optional `run` step that drives a form-first modal through to its
  rendered results, because a form-only visit asserts nothing about the
  renderer, which is the half that can break.

6c | docs/operator-state.md #63 + S46 | The five-step runbook, with the verdict
  contract stated plainly (release ONLY on `ok parity`; INCONCLUSIVE is not a
  pass — a zero-abandon window reports it by construction). S46 walks both the
  pre-release state and the post-release one.

6d | AgentDay.gs (NEW) | `getAgentDay({agentName, date})`. Three tiers —
  `full` (journeys intact: every agent who touched a call), `degraded`
  (journey pruned: only calls this agent rang first; outbound stays exact),
  `dqe-only` (missed-ring timestamps and nothing else). The tier is decided by
  WHAT CAME BACK, not the calendar: the prune is flag-gated and its horizons
  are property-tunable, so a calendar guess would mislabel in both directions.
  `agentDayDegradedReason_` separates the three reasons a day is thin
  (neon-down / journey-pruned / before-capture / not-captured) because they
  call for different reactions — an outage is temporary, a prune is permanent.
  Auth re-derives the dept from the ROSTER and runs the shared
  `assertDeptAccess_`, so it inherits the R-3 and Tier C fixes; a crossover
  agent's homes are tried in turn, and an unrostered name is admin-only
  (otherwise the gate is bypassable by misspelling an agent). Not cached, no
  hash or number read or returned, egress labelled `agentDay`.

6d | The header/list split | The day header reads the DQE agent-day row via
  the DAL, never a count of the per-call list. That is what lets the list be a
  subset without the header lying, and it makes these the SAME figures My
  Department shows. `agentDayReconcile_` STATES the gap and never claims
  `exact` on a degraded day even when the numbers coincide.

6d | client (dashboard.html, script-4-nav, script-10, script-2-chrome) | The
  `#/report/agent-day` modal, NOT admin-only (the server admits a manager of
  the agent's roster dept). Rendered through the existing `cl*` card
  vocabulary rather than a second set that would drift. `adTierNote_` is the
  load-bearing piece: it returns '' on a full day (a page that apologises when
  nothing is wrong trains people to ignore the banner that matters) and
  otherwise names the tier and why.

TEST RESULTS: passed. `TZ=America/Chicago npm run ci` — 1420/1420, INV-16
guard clean. 30 new tests (27 in agent-day.test.js, 3 in outbound-report).
MUTATION-CHECKED, 15 mutations. 13 were caught first time; TWO SURVIVED and
both were real gaps, fixed rather than explained away:
  - removing the `first_agent` arm (the whole degraded tier) changed nothing,
    because the logic was inline in `getAgentDay`, which needs Neon to
    exercise. Extracted to the pure `agentDayKeepRow_` and pinned — it is the
    subtlest rule in the file and deserved to be pure.
  - the egress pin matched its own call sitting inside `if (false)`. Tightened
    to pin the guard too.
Both re-checked after the fix and now caught, as is a third mutation on the
extracted function.

`npm run ci:ui` CANNOT RUN HERE — playwright is absent and the gate skips with
exit 0, so its green is not evidence. Both items touch client fragments, so:
  - 6d adds a whole new modal. Its risk is exactly what drive-admin asserts
    (opens, renders, traps focus, closes on Escape, no page errors), and it is
    now IN that driver with its RPCs mocked. The `run` step additionally
    asserts the KPI tiles, both card lists, and that the tier banner stays
    HIDDEN on the full-fidelity fixture — that last one catches an over-eager
    "apologise on every day" regression, which is the likeliest way this
    surface goes wrong.
  - 6c adds a driver stage rather than app behavior; its only shipped-code
    change is the gate switch, which `node --test` covers behaviourally.
  - Structural cover that DID run: html-include-structure `node --check`s the
    ASSEMBLED client (the fragments splice into one IIFE) and passes, and
    every client global the new block references was verified to exist —
    which caught one real bug pre-flight (`latestDataDate_` does not exist;
    the client's latest-DQE-date global is `latestDqeIso_`).
  RUN `npm run ci:ui` BEFORE DEPLOY; deploy.sh gates on it.

REGRESSION RISKS:
- `drive-admin.js`'s MODALS loop gained `menu` and `run`. Both are optional
  and the existing seven entries pass neither, so their behavior is
  unchanged; `adminMenu: true` still resolves to `#admin-menu-btn`.
- `OUTBOUND_VETTING_GATE_` is `var`, not `const`, ONLY so the harness can flip
  it (a `const` in the test vm is unreachable from h.ctx). Apps Script treats
  the two identically at global scope. The risk is a future edit reading `var`
  as "safe to reassign at runtime" — the comment says why it is `var`.
- `getAgentDay` is a NEW public RPC. It is read-only (INV-01 clean), gated by
  the shared allowlist, and uncached. Its one write is `logReportUsage_`, the
  documented append-only carve-out.
- The agent-day client lives in `script-10-escalations.html`, which is about
  escalations. Justified (the `cl*` renderers it reuses are there and the
  roadmap points at them) but it is a locality cost; the section header says
  why.
- No existing payload, cache key or aggregation rule changed, so no INV-30
  bump is needed and no warmed blob goes stale.

INVARIANTS AT RISK: None violated.
- INV-01: `getAgentDay` writes no spreadsheet (telemetry carve-out only).
- INV-04: the exact agent-name match is the load-bearing rule in
  `agentDayInboundRole_`, and the pin for it is a deliberate near-miss
  ('Ann Agentson' vs 'Ann Agent') rather than a happy path.
- INV-30: no cache prefix touched — the response is deliberately uncached.
- INV-36: no agent name reaches a cache key, because there is no cache.
- INV-43: the modal's date defaults to `latestDqeIso_`, not today (today's
  ingest has not landed while a manager is looking).

NET SCORE: production fixes 1 − new failure modes 0 = 1
- 6c: (a) would it have fired this month? NO — the report is admin-only, so
  nothing here is live-broken today. This is release engineering: the pin and
  the driver exist so the release does not fire it. (b) new failure mode? NO.
- 6d: (a) NO — new capability. (b) new failure mode? NO. The one it could have
  introduced — a short list reading as a quiet day — is the thing the tier
  banner and the reconciliation line exist to prevent, and both are pinned.
- The 1 counted fix is the exemption that had gone stale: the outbound modal
  was documented as having no harness fixture when it had had one for a while,
  so it sat uncovered on a false premise.

OPERATOR ACTIONS / DEPLOY:
- 6c step 1: run `backfillOutboundCalls` (cdr-import, editor) while Neon is
  reachable. | BLOCKS DEPLOY: N (blocks the RELEASE, not this deploy)
- 6c steps 2-3: set `OUTBOUND_VETTING_FROM`/`_TO`, run
  `runOutboundVettingCheck`, and release ONLY on a CLEAN `ok parity`.
  INCONCLUSIVE / FAILED / MISMATCH all stop. | BLOCKS DEPLOY: N
- 6c step 4: the un-gate itself — flip `OUTBOUND_VETTING_GATE_` to false AND
  drop `data-admin-only` + `style="display:none;"` from
  `#outbound-report-btn`, in ONE commit. NOT DONE HERE, deliberately: it
  depends on a live-Neon verdict this session cannot produce, and the runbook
  is explicit that judgement is not a substitute. | BLOCKS DEPLOY: N
- 6d: none. No Script Property, sheet, trigger or migration.
Deploy: Department Dashboard — `scripts/deploy.sh .` from the repo root, run
somewhere playwright is installed (it gates on `npm run ci` AND
`npm run ci:ui`; a bare `clasp push -f` bypasses the rendered gate and ships
unstamped, per E3).

FOLLOW-ON ITEMS:
- `sendOutboundReportEmail` does not exist, where Inbound / Individual /
  Insights all have one. Noted in the roadmap under 6c but deliberately NOT
  built here: it is item 5 of the owner's 2026-09-15 six-point Outbound list
  and ships in that round.
- The other five points of that list (connected-callback as a first-class
  KPI, time-to-callback as a distribution, splitting unconnected outbound by
  ring seconds, callback rate by abandon HOUR, and the per-dept callback
  table that needs a fresh owner ruling) are all still open.
- Per-dept company cards for Outbound remain RULED OUT (crossover agents hold
  multiple roster homes); not revived, and Operator State #63 records it.
- 6d has no entry point from My Department or the Individual Report — a
  manager reaches it from the Reports menu and picks the agent + date by
  hand. An agent-row drill-through would be the natural next step and was
  left out to keep this build self-contained.
- Noticed, not fixed: the inbound and direct report modals are still on
  DRIVER_MODAL_EXEMPT for the same "no harness fixture yet" reason outbound
  just outgrew. Worth re-checking whether theirs is stale too.

DOCUMENTATION UPDATES NEEDED: done in this commit.
- docs/operator-state.md: item #63 (the Outbound release runbook), indexed in
  CLAUDE.md.
- docs/regression-scenarios.md: S46 (the 6c release, both sides of the gate)
  and S47 (6d's three horizons), both indexed in CLAUDE.md.
- docs/per-call-capture.md: the agent-day bullet, with the two rules a future
  editor will be tempted to break; CLAUDE.md's index updated to match.
- CLAUDE.md: AgentDay.gs added to the Department Dashboard subsystem list;
  docs/module-dependencies.md regenerated via scripts/module-deps.mjs.
- tests/README.md: the agent-day suite registered in the coverage map.
- docs/next-steps.md: 6d marked DONE, 6c marked CODE DONE / RELEASE PENDING
  with the reason.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
