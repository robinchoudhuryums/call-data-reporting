---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Phase C of docs/agent-role-plan.md (owner: "/broad-implement Phase C"): My History, missed-ring wait time, view-as-agent, glossary, CLAUDE.md closeout. The agent-role rollout is CODE-COMPLETE.

Files modified:
- apps-script/department-dashboard/AgentHome.gs (ahWaitJoin_ + wait decoration in getAgentHome; getAgentHistory + agentHistoryBlob_/OwnView_)
- apps-script/department-dashboard/agent.html (tabs, history page, glossary fold, preview banner, home-page wrapper)
- apps-script/department-dashboard/agentApp.html (tab logic, history render incl. dual-line SVG + month cards, wait chips, preview mode + reqParams_)
- apps-script/department-dashboard/Code.gs (?agentPreview admin route; renderAgentApp_ preview flag)
- apps-script/department-dashboard/script-7-admin.html (Preview link on agent rows)
- tools/ui-harness/build-agent.js (+history payload from real getAgentHistory) + drive-agent.js (20 checks)
- tests/unit/agent-home.test.js (10; wait join + history pures + endpoint)
- CLAUDE.md (new agent-role bullet + subsystem file list), docs/agent-role-plan.md (Phase C closeout)

CHANGES:
C-1 | AgentHome.gs | WAIT TIME: derivable, and shipped. inbound_calls.journey missed-ring events carry the leg start (raw PST `t` -- +2h aligns to the CST DQE slot axis, INV-18/20), the agent's name (INV-04 exact), and ring `secs`; caller wait = event start - call_start (elapsed-from-IVR-pickup, the wait_seconds semantics -- labeled "waited", the glossary says what it includes, never "queue wait"). ahWaitJoin_ is best-effort Neon (LIKE-prefiltered, json_agg single fetch per the JDBC perf rule); conflicting duplicate matches DROP (never guess); unreachable serves bare timestamps with meta.waitsAvailable=false. No work-window clause ON PURPOSE: the joined-to slot timestamps are already window-bounded, and the inbound-window-scope rule governs dept METRICS in InboundReport.gs (its guard scans that file only -- verified before writing).
C-2 | AgentHome.gs + agentApp/agent.html | MY HISTORY: getAgentHistory -- 12-month window from the INV-29 shared computeTrendStartDate_ (so "12 months" means what it means in IR/Insights/QCD); monthly own answered/missed/rate + INV-25 WEIGHTED ATT (this page is reports-family; the in-page footer explains why it can differ from the INV-05 Performance card); team monthly average from roster rows only (sentinels fall out by roster filter); best-month gated on a 10-call floor so a 1-call 100% month is never crowned; per-dept cache (agentHist:v1), own view extracted post-cache, NO teammate identities in the payload (pinned). Client: My History tab, dual-line you-vs-team SVG, month cards newest-first with prior-month delta chips.
C-3 | Code.gs + script-7-admin | VIEW-AS-AGENT: admin + ?agentPreview=<dept>||<name> renders the agent app for that identity (warn banner, "close the tab to exit"); every request then names the target explicitly, riding getAgentHome/History's EXISTING admin path -- no new authorization surface, agents themselves still cannot name anyone. The Access modal's agent rows carry the Preview link (needs DASHBOARD_URL, like every open-in-tab affordance).
C-4 | agent.html | Glossary fold: answered/missed, the 92% standard, ATT, what "waited" includes (and that older rings show the time alone), and the team-average privacy statement.
C-5 | CLAUDE.md | The role-model bullet is grandfathered (ratchet: shrink-only), so the agent role documents itself in a NEW bullet: the fail-closed shape, the allowlist rule for new endpoints, the separate template, the INV-05-vs-INV-25 split, the privacy pin, the preview URL. Subsystem file list gained the three agent files.

TEST RESULTS: passed. node --test 725/725 (+3 net in agent-home: wait join, history pures, history endpoint). INV-16 green; claude-md-split green (new bullet under the 4KB cap; grandfathered bullets untouched). npm run ci:ui running at block-write time with drive-agent at 20 checks (agent stages verified standalone 20/20); commit gated on the full run.

REGRESSION RISKS:
- getAgentHome's missedDays shape changed (times -> entries with {t, ring, wait}) -- same-deploy client updated; no other consumer exists.
- ahWaitJoin_ adds one Neon query per ME-blob compute (cache-bounded, best-effort, closed conn in finally).
- The manager/admin dashboard is untouched except the Access modal's Preview link.

INVARIANTS AT RISK: None violated. INV-04/18/20/23/25/29/36/53 deliberately encoded + pinned; INV-05-vs-INV-25 split is labeled in-product; the inbound work-window pin (inbound-window-scope) is not implicated (verified: its guard scans InboundReport.gs; the join is a slot-keyed lookup, not a dept metric).

NET SCORE: 1 commissioned phase (3 features + docs closeout) - 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- Unchanged from Phase B: CSR pilot = add agent rows + AGENT_ROLE_ENABLED=true (Operator State #46). Wait times appear only for rings inside inbound-capture coverage -- expect bare timestamps on older dates | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Rank-line reveal stays one client constant (AGENT_RANK_SHOW_) on the owner's word.
- If a dept later wants named-team visibility for agents, it becomes a Dept Config column per the plan -- not built.

DOCUMENTATION UPDATES NEEDED:
- DONE: the CLAUDE.md agent bullet + subsystem list, plan-doc Phase C closeout. None remaining.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
