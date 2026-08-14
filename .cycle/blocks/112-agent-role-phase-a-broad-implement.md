---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Phase A of docs/agent-role-plan.md (owner-commissioned): agent-role identity + deny wall, shipped DARK behind AGENT_ROLE_ENABLED
- Owner decisions folded into the plan: rank line built-but-hidden; CSR pilots; missed list gains wait time where derivable (Phase B item)

Files modified:
- apps-script/department-dashboard/Config.gs (ACCESS_CONTROL_HEADERS + Role + Agent Name)
- apps-script/department-dashboard/Auth.gs (getAccessEntries_/getAgentAccessEntry_/agentRoleEnabled_, resolveUser_ agent branch, editor role+agentName validation, acRosterNamesForDept_, acEnsureSchema_, login-notify agent key)
- apps-script/department-dashboard/Util.gs (assertDeptAccess_ allowlist; new assertManagerOrAdmin_)
- apps-script/department-dashboard/Code.gs (doGet allowlist -- agents land on access-denied until Phase B)
- apps-script/department-dashboard/CompanyOverview.gs, QCDReport.gs, QueueReportEmail.gs, Escalations.gs, InboundReport.gs (explicit gates on the un-pinned all-dept surfaces + escAssertRowAccess_ allowlist)
- tests/unit/agent-role.test.js (NEW, 14), tests/unit/escalations-hardening.test.js (deny sweep + Util.gs in loader), tests/unit/access-control-editor.test.js (5-col row pin)
- docs/agent-role-plan.md (decisions + Phase A shipped), docs/operator-state.md (#46), CLAUDE.md (index line 46)

CHANGES:
A-1 | Util.gs | assertDeptAccess_ flipped from a role-none DENYLIST to an admin/manager ALLOWLIST. The audit finding that shaped the phase: the old check let any unrecognized role fall through BOTH pinning branches and pass unpinned -- a naive role:'agent' would have inherited manager-grade access to all 8 dept-scoped report endpoints. Same flip in escAssertRowAccess_ (its pinning branch is manager-only too). New assertManagerOrAdmin_ guards the surfaces with NO dept argument where assertDeptAccess_ never runs: getCompanyOverview, getOverviewChartTrend, getQcdAllDeptReport, sendQcdAllDeptEmail, getEscalationsInit, getEscalationsBadge, getCallJourney. Deliberately agent-reachable: getLatestDataDate(s) + reportClientIssue.
A-2 | Auth.gs | Access Control read generalized to getAccessEntries_ ([{dept, role, agentName}], same 'access:' cache key; a pre-deploy cached string-list fails the new shape check and re-reads -- self-heals in 60s). Blank Role = manager (every pre-existing row keeps meaning what it meant); unknown Role values are DROPPED (fail closed). resolveUser_ resolves an agent row ONLY when AGENT_ROLE_ENABLED='true', AFTER admin+manager (manager rows win), to the fail-closed shape: department null, departments [], identity only in agentDept/agentName -- even a missed allowlist edit grants nothing. loginNotifyOutcomeKey_ gains 'agent:<dept>'.
A-3 | Auth.gs editor | saveAccessControlRow accepts role ('manager' default) + agentName; agent rows validate: exactly ONE real dept (never ALL) + Agent Name matching that dept's roster EXACTLY (INV-04; acRosterNamesForDept_ reads the DO NOT EDIT! column, INV-03 name-before-comma). acEnsureSchema_ heals a pre-agent 3-column header row on the next editor save (widen-first, REP-10). getAccessControlInit returns role/agentName on rows, a separate agents list, and agentRoleEnabled.
A-4 | Code.gs | doGet renders the dashboard only for admin/manager -- an agent (or any future role) gets access-denied until Phase B routes them to the agent pages. Keeps Phase A truly dark even with the flag on.
A-5 | docs | Plan doc: owner decisions (rank hidden, CSR pilot, wait-time-where-derivable) + Phase A marked shipped with its real contents. Operator State #46 (AGENT_ROLE_ENABLED) + CLAUDE.md index line. The CLAUDE.md role-model bullet is deliberately NOT amended yet -- per the write-the-bullet-ONCE-at-END-of-rollout discipline; it lands with Phase C.

TEST RESULTS: passed. node --test 715/715 (+15: agent-role 14 + the escalations deny sweep; access-control-editor updated for the 5-col row and still 23/23). INV-16 green. claude-md-split green (#46 index<->file). npm run ci:ui running at block-write time; commit gated on it.

REGRESSION RISKS:
- getAccessControlInit's grouped `managers` now EXCLUDES rows with an unknown Role value (before: any row grouped). Only affects hand-typed garbage in the new column; blank stays manager.
- saveAccessControlRow writes 5-cell rows; the modal client doesn't send role yet (defaults 'manager') -- unchanged behavior for the existing UI.
- The 'access:' cache value shape changed; pre-deploy cached entries re-read within the 60s TTL (the documented self-heal pattern already in place for the Tier C migration).
- Existing roles pass every changed gate byte-identically (allowlist admits exactly admin+manager; role-none threw before and still does).

INVARIANTS AT RISK: None violated. INV-01 (editor stays admin-gated + validated + LockService + audit log; the new validation only tightens); INV-03/INV-04 reused for agent-name validation; INV-12 (setup writes the new headers only on sheet CREATE; idempotency pinned green).

NET SCORE: 1 latent security hole closed (the assertDeptAccess_ role fall-through -- the recurring defect class of the role model, found 5 times now) + the commissioned Phase A scaffold − 0 new failure modes = positive

OPERATOR ACTIONS / DEPLOY:
- None required now. AGENT_ROLE_ENABLED stays UNSET until Phase B ships the agent pages (Operator State #46) | BLOCKS DEPLOY: N
- When piloting later: add CSR agent rows (Role=agent + exact roster Agent Name) via the Access modal or sheet, supply the agent emails, then set AGENT_ROLE_ENABLED=true | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Phase B (My Performance page + getAgentHome + harness agent build + Access modal UI for agent rows) -- the modal currently manages agent rows only via the server RPC / sheet; its UI section lands in Phase B.
- Wait-time derivation for the agent missed list (owner decision 3): per-call wait exists only where inbound_calls captured the call; design note recorded in the plan.
- CLAUDE.md role-model bullet update deferred to end of rollout (Phase C) per the file's own growth discipline.

DOCUMENTATION UPDATES NEEDED:
- DONE: plan doc, operator-state #46, CLAUDE.md index line. Remaining: the role-model bullet at Phase C (deliberate).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
