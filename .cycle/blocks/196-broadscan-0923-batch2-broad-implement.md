---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- S2B-1 — "Add agent" replace-all deleted the same address's manager rows (lockout while AGENT_ROLE_ENABLED is off); save and remove are now role-scoped.
- S2B-2 — Uncached sign-in reads waited up to 10 s on the project-wide script lock (held by the 8 AM alerts run) and then went uncached; the read now takes no lock and uses a save-in-flight marker + generation token instead.
- SEC-1 — DQE/QCD report RPCs accepted any window (R24 transfer-cap class); shared `assertReportRangeCap_` caps them at 731 days (agent app 366), prior windows included.
- SEC-3 — `sendIndividualReportEmail` used a bare `role === 'none'` gate (agents reached send-to-self); now `assertManagerOrAdmin_`.
- S2B-6 — Access Control rows saved under an EMAIL_ALIASES alias never matched at sign-in; the save now stores the canonical address.
- SEC-5 — All rendered pages used XFrameOptionsMode.ALLOWALL (clickjacking); now DEFAULT (owner: nothing embeds the app).
Files modified:
- apps-script/department-dashboard/Auth.gs
- apps-script/department-dashboard/Code.gs
- apps-script/department-dashboard/Util.gs
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/IndividualReport.gs
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/MissedCallsReport.gs
- apps-script/department-dashboard/QCDReport.gs
- apps-script/department-dashboard/QueueReportEmail.gs
- apps-script/department-dashboard/AgentHome.gs
- apps-script/department-dashboard/script-7-admin.html
- tests/unit/agent-role.test.js
- tests/unit/access-control-editor.test.js
- tests/unit/ir-send-to-agent.test.js
- tests/unit/util.test.js
- tests/unit/agent-home.test.js
- tests/unit/cross-file-pins.test.js
- CLAUDE.md
- docs/operator-state.md (#36)
- docs/fix-history.md
- docs/module-dependencies.md (regenerated)

CHANGES:
S2B-1 | Auth.gs, script-7-admin.html, agent-role.test.js | New `acRowIsAgent_` / `acDeleteEmailRows_(sheet, email, role)`: a save deletes only the email's rows of the SAVED role (non-'agent' = manager side, so legacy unknown-role rows are still cleaned by a manager save); returns `coexistsWith`. `removeAccessControlRow` takes optional `role` (none = legacy delete-all) and returns `kept`. The modal's agent/manager removes pass their role; both save statuses say when the other role's rows remain. 3 new tests, all fail on the old Auth.gs.
S2B-2 | Auth.gs, access-control-editor.test.js | `getAccessEntries_` no longer calls LockService: it reads the sheet (`acReadEntriesUncached_` now pure, no caching) and caches only when neither end of the read saw `acsave:inflight` and `acsave:gen` did not move (re-checked after the put, un-pinning if a save slipped in). `saveAccessControlRow` / `removeAccessControlRow` call `acSaveMarkStart_` before their first write and `acSaveMarkEnd_` in `finally`. `AUTH_READ_LOCK_WAIT_MS_` removed. The two A-6 tests (which pinned the lock) were replaced by five S2B-2 tests: no lock + caches; a held unrelated lock no longer blocks or un-caches; a read during a save serves but does not cache (the A-6 guarantee); a save wholly inside a read blocks the put; markers cleared after save/remove, including a save that throws mid-write.
SEC-1 | Util.gs, Data.gs, IndividualReport.gs, InsightsReport.gs, MissedCallsReport.gs, QCDReport.gs, QueueReportEmail.gs, AgentHome.gs, util/agent-home/cross-file-pins tests | `REPORT_MAX_RANGE_DAYS`=731, `AGENT_MAX_RANGE_DAYS`=366, `reportRangeDays_`, `assertReportRangeCap_(from, to, maxDays, label)`. Called after the existing ISO/order checks in getDepartmentSummary, getIndividualReport (+ prior window), getIndividualReportInit, getInsightsReport + sendInsightsReportEmail (+ prior windows), getMissedCallsReport, getMissedCallsSlice, getQcdAllDepartments, sendQcdAllDeptEmail, getAgentHome (366). cross-file-pins sweep fails if a listed RPC stops calling it.
SEC-3 | IndividualReport.gs, ir-send-to-agent.test.js | `assertManagerOrAdmin_(user)` replaces the role-none check; test covers agent + unknown role refused, admin still sends.
S2B-6 | Auth.gs, script-7-admin.html, access-control-editor.test.js | Save canonicalizes via `canonicalizeEmail_`, stores the canonical address, deletes same-role rows under the alias too, busts both `access:` keys, returns `storedAs`; the modal shows it. Welcome email still goes to the typed address.
SEC-5 | Code.gs, cross-file-pins.test.js, CLAUDE.md | `XFrameOptionsMode.DEFAULT` on the agent app, dashboard and access-denied templates; pin: no ALLOWALL in any dashboard .gs and one DEFAULT per `tmpl.evaluate()` in Code.gs.

TEST RESULTS: passed — `node --test` 1806/1806 (TZ=America/Chicago); INV-16 guard clean; `module-deps --check` clean after `--write`; `CI=1 npm run lint:gas` clean (75 files); `CI=1 npm run ci:ui` ALL stages passed (playwright 1.62.1 installed locally; includes drive-admin's Access Control modal).
REGRESSION RISKS:
- SEC-1: a saved/typed custom window longer than 731 days (366 in the agent app) now errors instead of running. No UI preset exceeds a year; INV-29's >366-day trend branch is still reachable up to two years.
- SEC-5: anything that frames the app (a Google Site embed) stops rendering. Owner confirmed nothing does.
- S2B-2: the cache-miss path makes 4-6 extra CacheService calls (ms each). If CacheService evicts the in-flight marker DURING a save, a read in that window could cache a mid-save snapshot for 60 s -- the pre-A-6 behaviour, now only on eviction.
- S2B-1: an old open tab calling `removeAccessControlRow({email})` without a role still deletes every row (legacy) until reloaded.
INVARIANTS AT RISK: None. INV-01 unchanged (no new public write; the Access Control editor stays admin-gated). Role model: `assertManagerOrAdmin_` is the allowlist the AGENT-role bullet prescribes.
NET SCORE: 1 − 1 = 0 (S2B-2 fired: the alerts trigger holds the lock every weekday morning while managers sign in. S2B-1/S2B-6/SEC-1/SEC-3/SEC-5 need an admin action, the agent role, a crafted request or an embedder -- none observed this month. New failure mode: SEC-1's deliberate refusal of >2-year windows, documented in CLAUDE.md.)

OPERATOR ACTIONS / DEPLOY:
- None required. (Optional: if any Access Control row was hand-typed under an EMAIL_ALIASES alias address, re-save it from the modal so it is stored canonically -- Operator State #36.) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or `scripts/deploy.sh .`), then Deploy → Manage deployments → New version

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Other public RPCs still use `role === 'none'` followed by `assertDeptAccess_` (safe, because the dept gate is an allowlist) -- IR/Insights/Missed/getDepartmentSummary/DeptSummaryEmail/Escalations. Not in scope; converting them is cosmetic.
- `ahWaitJoin_` (AgentHome) still has no row LIMIT; with the 366-day cap and the 90-day journey prune it is bounded, and a LIMIT would silently drop ring/wait data. Left as is.
- Remaining broad-scan batches 3-11 (`.cycle/blocks/195-broadscan-0923-plan.md`).

DOCUMENTATION UPDATES NEEDED:
- Done: CLAUDE.md (SEC-1 + SEC-5 in the "Execute as: Me" decision), Operator State #36 (S2B-1, S2B-6), fix-history.
- None outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
