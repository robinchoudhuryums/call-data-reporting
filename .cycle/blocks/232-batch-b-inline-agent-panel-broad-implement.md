---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch B (owner plan 2026-10-06) -- B1 shared Agent Day rendering, B2 getAgentDayStrip server call, B3 the inline agent panel on My Department, B4 harness/drivers/docs
Files modified: apps-script/department-dashboard/AgentDay.gs, script-10-escalations.html, script-2-chrome.html, script-5-dept.html, styles.html; tests/unit/agent-day.test.js, tests/unit/cross-file-pins.test.js; tools/ui-harness/build-harness.js, ci.mjs, drive-f13.js, drive-agentpanel.js (new); CLAUDE.md, docs/client-ui-conventions.md, docs/per-call-capture.md, docs/regression-scenarios.md, docs/module-dependencies.md, tests/README.md

CHANGES:
B1 | script-10-escalations.html | The panel's day view is built from the modal's own helpers (adTierNote_, adKpiRowsHtml_, adRoleChip_), plus a new shared adOutboundOutcomeChip_ that both the modal card and the panel table use. The Reports -> Agent day modal is unchanged.
B2 | AgentDay.gs | getAgentDayStrip({agentName, from, to}):
  - the entitlement step is split out of agentDayResolve_ as agentDayAuthorize_, and both surfaces share it;
  - the SEC-1 range cap applies, and it is added to the cross-file-pins list;
  - per-day DQE counts come through the DAL;
  - ONE grouped outbound_calls count query, labelled agentDay, and no query at all for a window before 2026-07-10;
  - the pure fold agentDayStripDays_: a day counts as active on a ring OR an outbound call; the 31 most recent ship, newest first, with totalActiveDays; outbound is null on an uncaptured day.
  Not cached and not usage-logged, because the day view's getAgentDay call already logs the open.
B3 | script-2-chrome / script-5-dept / script-10 / styles | A click, Enter or Space on an agent row toggles a #ap-panel <tr> below it.
  - The panel holds the day strip (with ‹ › arrows and a "31 most recent of N" note) and the selected day: tier note, compact tiles, reconcile line, and Inbound / Outbound / Missed-rings tabs.
  - Its first button is the Individual Report, over the same window.
  - One agent at a time. Escape or Collapse close it and return focus to the row. A drag-select does not toggle it.
  - apReattach_ runs at the end of render(): it re-inserts the same node, re-opens on a new window, and closes when the agent is gone.
  - A one-day window skips the strip.
  - The CSS is scoped under .agents, after the table's own rules. The panel is sticky-left and sized to the table's scroll wrapper, with contain:inline-size.
  - The row tooltip now reads "Show X's days".
B4 | harness + docs | getAgentDayStrip mock; drive-f13 now walks row -> panel -> IR button -> Escape; new asserting stage drive-agentpanel.js (21 checks) added to ci.mjs; CLAUDE.md gate block (NINE stages) + S56 index; S39 updated + new S56; per-call-capture, client-ui-conventions, tests/README updated; module-deps regenerated.

TEST RESULTS: passed.
  - npm run ci: 2206/2206, INV-16 in sync, module-deps up to date.
  - lint:gas: clean.
  - ci:ui under CI=1: every stage green (smoke 150, f13 22, subqueue 38, journey 14, agentpanel 21, admin 125, devoverlay 14, agent 26).
  - Bite checks: six strip pins all bite (active-day rule, 31 cap, null outbound, shared auth, no pre-capture query, SEC-1 list). The driver also bites: removing apReattach_ turns drive-agentpanel red.
  - One test needed adjusting during the work: the outbound test pins exactly TWO Connected chips carrying the definition, so the panel reuses the shared chip helper instead of adding a third copy.
REGRESSION RISKS:
  - The row click no longer opens the Individual Report directly; it is one more click away, in the panel. This is the intended owner change; drive-f13 and S39 are updated.
  - Each panel open costs a DQE DAL read over the loaded window (up to the 731-day SEC-1 cap) plus one small grouped Neon count. It is not cached.
  - The panel row lives inside #agents-tbody, so any code that counts "#agents-tbody tr" without [data-agent] will see one extra row while it is open. drive-devoverlay counts this way, but only with the panel closed.
INVARIANTS AT RISK: None.
  - INV-01: read-only RPC.
  - INV-04: exact agent match in the fold.
  - INV-36: no cache.
  - INV-53: the strip is per-agent; no team figure.
  - SEC-1: capped and pinned.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature work, owner-requested)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (it carries Batch A + B) and walk S56, S39 and S47 | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- The strip's date labels drop the year (9/7 – 10/6). For a window that spans a year boundary, the note could carry years.
- If panel opens over long windows ever feel slow, the strip could read only the last ~62 calendar days first and widen only when that is needed.
- Batch C (outbound probe), D (Inbound | Outbound | Both switch, admin-only), and E (Insights / Overview outbound, admin-only) remain.

DOCUMENTATION UPDATES NEEDED:
- None beyond those made in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
