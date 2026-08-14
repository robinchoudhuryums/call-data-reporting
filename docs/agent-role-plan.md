# Agent Role Plan — "My Performance" for individual reps

Status: **Phase A SHIPPED (dark, flag off); Phases B/C planned**
(owner-commissioned 2026-08-14; owner ruling: agents see their OWN numbers in
full + the team's AGGREGATE numbers only — no per-teammate rows, named or
anonymized).

**Owner decisions (2026-08-14):**
1. **Rank line: build it, ship it HIDDEN** (render gated off) while the owner
   decides how it should deploy — the server computes it, the client doesn't
   show it until the gate flips.
2. **Pilot team: CSR.**
3. Mocks approved as-is; **My Performance's missed-call list adds WAIT TIME
   where derivable** — the per-call wait exists only where the inbound capture
   has the call (`inbound_calls` journey / ring legs); older or uncaptured
   rings show the timestamp alone, labeled, never a guessed wait.

## The product shape

A third role, `agent`, for individual reps whose managers requested access.
An agent signs in with their domain account and gets a **purpose-built,
two-page experience** — not a stripped-down manager view. The manager pages
are table-first (compare agents); the agent experience is self-first
(am I on track?), so the layout is a different, simpler thing: single
centered column, large KPI numbers, team context as a reference strip.

**Visibility contract (the owner ruling this plan encodes):**

| Data | Agent sees |
|---|---|
| Own answered / missed / rung / rates / TTT / ATT | Full detail |
| Own missed-call timestamps (their DQE slot times) | Full detail |
| Team totals + team averages + dept answer rate | Aggregates only |
| Rank ("Nth of M on answer rate") | Optional — ordinal only, no names (owner to confirm) |
| Any per-teammate row, named or anonymized | **Never** |
| Other depts, Overview, Escalations, admin surfaces | **Never** |

Anonymized teammate rows were considered and rejected: cohorts of 4–8 make
anonymity cosmetic (one absence de-anonymizes everyone). If a dept later wants
full named-team visibility for agents, that becomes a per-dept `Dept Config`
column (`Agent visibility: self | team`), not a global flip.

## Pages (mocks delivered with this plan)

1. **My Performance** (`#/me`, landing) — window picker (same presets as the
   dept page, default = the dept default window); four KPI cards (Answered,
   Missed, Answer rate with the 92%-standard tint, ATT) each with a
   vs-team-average delta chip; a **Team context** strip (team answered /
   missed / rate / ATT avg / active agent count — the INV-53/INV-26 basis,
   labeled); **My missed calls** (their own timestamps by day — self-coaching,
   own data only); a 30-day own-trend chart (answer rate + volume).
2. **My History** (`#/me/history`) — 12-month view of their own trajectory:
   monthly trend chart (INV-29 window) + month cards (answered / rate /
   weighted ATT per INV-25, best-month highlight, vs-team-avg per month).
3. **Help** — the existing Help modal, trimmed by role (agent topics only).

Header chrome for agents: kicker + their name + dept tag, the freshness pill
(subtle variant, per the existing non-admin rule), Help, and nothing else —
no dept selector, no Reports/Admin menus, no Escalations tab.

## Identity: email → roster agent name

The missing link today. Access Control maps email → department; the roster
(`DO NOT EDIT!`) maps NAME → extensions; nothing connects an email to a
roster row. Plan:

- `Access Control` gains two columns: **Role** (`manager` default when blank —
  every existing row keeps meaning what it meant; `agent`) and **Agent Name**
  (required for agent rows; must EXACTLY match a roster name in that dept's
  column, INV-04 semantics — validated at save time by the Access Control
  editor, which lists the dept's roster names in a picker rather than free
  text). Existing editor + audit trail cover it; no new admin surface.
- The owner supplies the agent emails (confirmed available on request).
- `EMAIL_ALIASES` (Operator State #36) composes in front of the lookup
  unchanged.

## Security design (the part that must not be improvised)

**Finding that shapes everything:** `Util.gs::assertDeptAccess_` pins ONLY
`role === 'manager'`; an unrecognized role with a `department` field would fall
through both checks and PASS. Likewise `getEscalations` treats every
non-admin/non-allDepts caller as a manager and scopes by `user.departments`.
So a naive `role:'agent'` user object would inherit MANAGER-grade access from
the existing gates. Three-layer fix, all in Phase A:

1. **Explicit allowlist in `assertDeptAccess_`**: any role other than
   `admin` / `manager` throws (with `allDepts` handling unchanged). Deny by
   default — the same fail-safe property the `allDepts` role was built on,
   from the other direction.
2. **Agent user shape fails closed mechanically**: `resolveUser_` returns
   `role:'agent'`, `department: null`, `departments: []` — the agent's dept
   and roster name travel ONLY in new fields (`agentDept`, `agentName`) that
   no existing gate reads. Even a missed allowlist edit grants nothing.
3. **Deny-sweep test**: a fixture agent user is thrown at EVERY existing
   public endpoint (the 8 report endpoints, escalations verbs, admin RPCs)
   and must be refused — pinned the way `escalations-hardening.test.js` pins
   the manager gates, so a future endpoint that forgets the rule fails CI.

New endpoints (`AgentHome.gs`): `getAgentHome({from,to})` and
`getAgentHistory()`, gated by a new `assertAgent_()`; the agent identity is
ALWAYS server-derived from the resolved user — the request never carries an
agent name. Both also serve admins (for view-as / support) but never managers
(nothing there a manager's own pages don't already show).

**Caching**: compute once per (dept, window) — the same
`computeSummary_`-family blob managers already warm — then extract the
caller's own row + the aggregate per request (the `personalizeOverview_`
pattern). Eight agents on a team share one compute; no per-agent cache keys
(and no INV-36 concern — no agent lists in keys).

**What the payload must never contain**: other agents' rows. Extraction
happens server-side BEFORE the response is built (the INV-39 strip
discipline): the client never receives data it must hide. Rank, if kept, is
computed server-side as ordinals only.

## Client architecture

- `Code.gs::doGet` serves the same dashboard.html; `USER.role === 'agent'`
  sets `body[data-role="agent"]`. A new fragment (`script-12-agent.html`)
  owns the two agent pages; every existing page/init path guards on role so
  the dept/overview machinery never initializes for agents (no null derefs,
  no accidental fetches — the F11 non-admin deep-link no-op rule extends to
  the whole router: any non-agent route lands on `#/me`).
- Existing CSS tokens + `ds-*` components; the KPI-card and calendar patterns
  already exist. New styles are additive.
- Telemetry: `logReportUsage_('agentHome'|'agentHistory', dept, user, hit)`;
  the R19 error beacon works for agents as-is (role ≠ none); login-notify
  outcome keys extend naturally (`agent:CSR` — a grant change emails the
  admins like any other).
- UI harness: `build-harness.js` gains a third role build (`agent`) and
  drive-smoke gains an agent section — no admin/manager surface visible
  (measured as rendered visibility, per the view-as discipline), both agent
  pages render, no console errors, no unmocked RPCs.

## Rollout phases

- **Phase A — identity + deny wall (ships dark). ✅ SHIPPED 2026-08-14.**
  Access Control schema (Role + Agent Name appended; blank Role = manager;
  `acEnsureSchema_` heals a pre-agent header row on the next editor save) +
  save-time agent validation (one real dept, exact roster name via
  `acRosterNamesForDept_`); `resolveUser_` agent resolution behind the
  `AGENT_ROLE_ENABLED` Script Property (unset ⇒ agent rows resolve to `none`,
  exactly the pre-agent behavior; manager rows win over agent rows; unknown
  Role values grant nothing); the fail-closed agent shape (`department:null`,
  `departments:[]`, identity only in `agentDept`/`agentName`);
  `assertDeptAccess_` + `escAssertRowAccess_` flipped to explicit
  admin/manager ALLOWLISTS; `assertManagerOrAdmin_` (Util.gs) added to the
  un-pinned all-dept surfaces (getCompanyOverview, getOverviewChartTrend,
  getQcdAllDeptReport, sendQcdAllDeptEmail, getEscalationsInit/Badge,
  getCallJourney); `doGet` renders access-denied for any non-admin/manager
  role until Phase B; login-notify outcome key `agent:<dept>`. Deliberately
  still agent-reachable: `getLatestDataDate(s)` (freshness metadata the agent
  pages will need) and `reportClientIssue` (the error beacon). Pinned by
  `tests/unit/agent-role.test.js` (14) + the deny sweep in
  `escalations-hardening.test.js`.
- **Phase B — My Performance. ✅ SHIPPED 2026-08-14.** `AgentHome.gs::
  getAgentHome({from,to})` — identity always server-derived for agents
  (admins pass `{department, agentName}` to preview; managers refused); own
  KPIs off the SAME computeSummary_ the My Department table serves (INV-05
  ATT on purpose — an agent's number always reconciles with their manager's
  view of them), roster-only team aggregates (INV-53), ordinal-only rank
  (computed + shipped; the client's `AGENT_RANK_SHOW_` renders it HIDDEN per
  the owner decision), own 30-day trend + own missed timestamps via the DQE
  DAL (B-2 cutover honored; coerced slot cells recover-or-drop). Two caches:
  a per-(dept,window) TEAM blob every teammate shares + a per-agent ME blob
  (hashAgents_, INV-36); own-row extraction is post-cache (the
  personalizeOverview_ pattern) and the payload NEVER carries teammate
  identities (pinned). Client: `agent.html` + `agentApp.html` — a SEPARATE
  small template (implementation deviation from the original single-doc
  sketch, deliberately: guarding every init path of the ~20K-line manager
  client for a third role was judged riskier than a second page that shares
  styles.html); inline-SVG trend (no Chart.js), the R19 beacon installed,
  presets anchored to the latest DQE date. `doGet` routes agents there.
  Access modal grew the agent-rows section (dept + roster-name PICKERS fed
  by `rosterNamesByDept`, so the exact-spelling rule is unmistypable; the
  hint states the flag's live state). Rendered gate: `build-agent.js` +
  `drive-agent.js` joined `npm run ci:ui` (boot, KPIs, hidden rank,
  teammate-name privacy, no errors/unmocked RPCs/self-beacons, overflow).
  Unit: `tests/unit/agent-home.test.js`. NOT in B (deferred): missed-ring
  WAIT TIME (needs the inbound_calls journey join — Phase C candidate), the
  My History page, view-as-agent.
- **Phase C — My History + polish. ✅ SHIPPED 2026-08-14. The rollout is
  code-complete.** (1) `getAgentHistory` — 12-month window via the INV-29
  shared `computeTrendStartDate_`; monthly own answered/missed/rate +
  **INV-25 weighted ATT** (the labeled exception to Phase B's INV-05
  reconciliation rule — the history footer explains the difference); team
  monthly average from roster rows only; best-month highlight gated on a
  10-call floor; cached per dept (`agentHist:v1`), own view extracted
  post-cache, teammate identities never in the payload (pinned). Client: a
  My History tab with the dual-line you-vs-team SVG + month cards.
  (2) **Missed-ring wait time — DERIVABLE and shipped**: `ahWaitJoin_`
  matches the agent's DQE slot timestamps (CST) to their missed ring legs in
  `inbound_calls.journey` (raw PST `t` + 2h; INV-04 exact name), attaching
  ring seconds + caller wait (elapsed-from-IVR-pickup — the `wait_seconds`
  semantics, labeled "waited", never "queue wait"). Capture-bounded and
  best-effort: unmatched or pre-capture rings show the bare timestamp
  (glossary explains); conflicting duplicate matches are dropped, never
  guessed; Neon-unreachable serves timestamps-only. (3) **View-as-agent**:
  `?agentPreview=<dept>||<name>` on the web-app URL (admin-only branch in
  doGet; the Access modal's agent rows carry a Preview link) renders the
  agent app with a warn banner; requests ride getAgentHome/History's
  existing admin-preview path, so no new authorization surface. (4) The
  glossary fold ("What do these numbers mean?"). (5) CLAUDE.md gained the
  agent-role bullet (the grandfathered role-model bullet is ratchet-frozen,
  so the agent role documents itself in its own bullet, as the split test
  intends). drive-agent grew to 20 checks (history tab, dual-line SVG,
  month cards, best-month, weighted-ATT disclosure, glossary).

Decisions the owner still owns: (1) keep or drop the rank line; (2) which
team pilots; (3) whether managers get told when their agents' access is
granted (login-notify already tells the admins).

## Operator actions when built (preview)

Arrange agent emails → add Access Control agent rows (dept + exact roster
name) → set `AGENT_ROLE_ENABLED=true` → agents visit the same dashboard URL.
No new deployment model; no new scopes.
