---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Phase B of docs/agent-role-plan.md (owner: "begin Phase B"): the My Performance agent app, end to end
- Spanish QCD row-40 parity (owner confirmed QCDR Output A40 = A_Q_Spanish) -- committed and MERGED in PR #240 alongside R19/R20/Phase A before this phase started

Files modified:
- apps-script/department-dashboard/AgentHome.gs (NEW -- getAgentHome + pure projections)
- apps-script/department-dashboard/agent.html (NEW -- the agent template; shares styles.html)
- apps-script/department-dashboard/agentApp.html (NEW -- the agent client; named to stay OUT of the script-*.html fragment glob)
- apps-script/department-dashboard/Code.gs (doGet routes agents to renderAgentApp_)
- apps-script/department-dashboard/Auth.gs (acRosterNamesByDept_; init ships rosterNamesByDept)
- apps-script/department-dashboard/dashboard.html + script-7-admin.html (Access modal agent-rows section)
- tools/ui-harness/build-agent.js + drive-agent.js (NEW) + ci.mjs (two new stages)
- tests/unit/agent-home.test.js (NEW, 7)
- docs/agent-role-plan.md (Phase B shipped), docs/operator-state.md (#46 go-live runbook)

CHANGES:
B-1 | AgentHome.gs | getAgentHome({from,to}): agents are ALWAYS themselves (a request naming another agent is ignored); admins preview via {department, agentName}; managers refused. Own KPIs come from the SAME computeSummary_ blob the My Department table serves -- INV-05 simple-mean ATT deliberately, so an agent's number always reconciles with their manager's view (the dispute-avoidance choice, documented in the file). Team figures are the roster-only totals (INV-53). Rank is ordinal-only, computed + shipped. Own trend (30d) + own missed timestamps ride the DQE DAL (getDqeReadSource_-aware with the LM2 fallback -- the B-2 same-commit cutover rule); slot cells recover a coerced date-render's trailing time and DROP junk, never guess. Caching: per-(dept,window) TEAM blob shared by the whole team + per-agent ME blob (hashAgents_, INV-36); own-row extraction is post-cache. PINNED: the payload never carries a teammate identity. logReportUsage_('agentHome', ...).
B-2 | agent.html + agentApp.html + Code.gs | A separate small template (deviation from the plan's single-doc sketch, recorded there: guarding every init of the ~20K-line manager client was judged riskier than a second page sharing styles.html). Inline-SVG trend (no Chart.js/CDNs), presets anchored to getLatestDataDate (agent-reachable by design), the R19 beacon installed for agents, AGENT_RANK_SHOW_=false renders the computed rank HIDDEN (owner decision). doGet: role 'agent' -> renderAgentApp_ (same userJson escape discipline); other unrecognized roles still -> access-denied.
B-3 | Access modal | New "Agent access" section: email + dept picker + roster-NAME picker (fed by rosterNamesByDept, one roster read) so the INV-04 exact-spelling rule is unmistypable; list + dsConfirm_ remove; the hint states whether AGENT_ROLE_ENABLED is live so staged rows aren't a surprise no-op.
B-4 | ui-harness | build-agent.js assembles the REAL client files around a payload computed by the REAL getAgentHome; drive-agent.js (13 checks) asserts boot, KPIs, hidden rank, teammate-name PRIVACY at the rendered-page level, preset switch, no console/page errors, no unmocked RPCs, no self-beacons, no overflow. Both joined ci.mjs as blocking stages.

TEST RESULTS: passed. node --test 722/722 (+7 agent-home). INV-16 green. npm run ci:ui all stages incl. the two new agent stages (13/13); agent stages re-run standalone after a late cosmetic edit (team ATT format) -- still 13/13.

REGRESSION RISKS:
- The manager/admin dashboard is untouched by the agent client (separate template) -- drive-smoke unchanged and green.
- getAccessControlInit grew rosterNamesByDept (one extra roster read per modal open; admin-only surface).
- agentApp.html deliberately does NOT match the script-*.html fragment glob; the include-parity test stays byte-green.
- Dark until AGENT_ROLE_ENABLED=true; with it unset, nothing reaches any of this.

INVARIANTS AT RISK: None violated. INV-01 (getAgentHome writes nothing; telemetry rides the sanctioned carve-out), INV-04/05/23/36/53 all deliberately encoded + pinned; INV-30 n/a (new prefix agentHome:v1, no existing key changed); B-2 DAL rule honored in the same commit.

NET SCORE: 1 commissioned feature shipped with its own rendered gate - 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- CSR pilot go-live (after merge + deploy): add the CSR agent rows in the Access modal's Agents section (emails you supply), then set AGENT_ROLE_ENABLED=true (Operator State #46) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Missed-ring WAIT TIME (owner decision 3): needs the inbound_calls journey join; deferred to Phase C with the design note in the plan.
- Phase C: My History page, Help topics, view-as-agent admin preview, the CLAUDE.md role-model bullet (end-of-rollout discipline).
- Rank line reveal: one client constant (AGENT_RANK_SHOW_) when the owner decides.

DOCUMENTATION UPDATES NEEDED:
- DONE: plan doc Phase B entry, operator-state #46 go-live runbook. Deferred by design: the CLAUDE.md role-model bullet (Phase C).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
