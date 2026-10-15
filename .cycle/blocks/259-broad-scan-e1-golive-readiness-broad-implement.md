---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E1 is an expansion batch -- new capability only)
New capabilities (G/ST):
- G3 staged agent access: an agent row saved while agent sign-in is OFF is recorded on a pending-welcome list; the Access modal lists it, and once AGENT_ROLE_ENABLED is on one admin click sends every pending welcome (or clears the list)
- G2 default-target visibility: Alerts -> Answer targets lists which depts ride the company default vs have their own target; the Insights brief's top line carries a "Default 80% target" label for a dept with no target of its own
Files modified: apps-script/department-dashboard/{Auth.gs, Config.gs, dashboard.html, script-4-nav.html, script-7-admin.html, script-8-insights.html, styles.html}, docs/{operator-state.md, module-dependencies.md}, tests/README.md, tests/unit/{agent-role, insights-brief, client-correctness}.test.js, tools/ui-harness/{gen-phase3.js, drive-admin.js}, .cycle/STATE.md

CHANGES:
G3 | Auth.gs, Config.gs | saveAccessControlRow records a deferred (F1) agent address on AGENT_WELCOME_PENDING (JSON array, lowercase canonical address, under the save's lock, capped at 150 for the 9 KB value limit; the response carries pendingTracked); removeAccessControlRow drops it when the agent row goes (not on a manager-only remove); getAccessControlInit returns pendingWelcomes; new admin-gated sendPendingAgentWelcomes({dismiss}) -- refuses while AGENT_ROLE_ENABLED is off, ACCESS_WELCOME_EMAIL=false or DASHBOARD_URL unset; sends up to 40 per call OUTSIDE the lock to each address's current agent row (stored email + dept), then re-reads the list under the lock and removes sent + row-gone addresses, keeping failures; dismiss clears unsent. Property registered as engine state in PROP_REGISTRY_.
G3 | dashboard.html, script-7-admin.html | Agents section: a pending bar ("N staged agents have no welcome email yet…") with "Send N welcomes" (disabled while sign-in is off) and "Clear the list without sending", both behind dsConfirm_; a "welcome pending" chip on each pending row; the deferred-save status says the welcome waits on the list (or that the list is full).
G2 | script-4-nav.html, script-8-insights.html, styles.html | answerStdFor_ returns isDefault; PURE insBriefTargetNote_ -> "Default 80% target" chip after the brief's top line (dashed, muted; title points at Alerts -> Answer targets) when the dept has no own target and there are calls.
G2 | dashboard.html, script-7-admin.html | PURE alAnswerTargetCoverage_ + a line under the per-dept overrides: "On the company default (80%, amber within 10 pts): …. Own target: CSR 92% (amber 2)." -- fed the roster dept list from the Alerts init (kept across the save re-render).
Harness | tools/ui-harness/gen-phase3.js, drive-admin.js | fixture gains one staged agent + the pending property; drive-admin asserts the coverage line, the pending bar (send disabled while off) and the row chip.
Tests | agent-role (4 G3 tests), insights-brief (3: G2 x2, G3 wording), client-correctness CL-15 count 4 -> 5 (the welcome send is a fifth reload-keeping write path)

TEST RESULTS: passed -- 2501 tests, 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean; module-deps regenerated (--check clean); ci:ui all stages passed incl. the 3 new rendered checks. Bites 11/12: the miss is an equivalent mutant (isDefault `!o` vs the full validity check -- the parser never stores an override without a valid target). One test was strengthened after a bite missed (the manager-only remove now removes a real manager row).
Regression scenarios walked (by reading against the change): S8 (new manager visible within 60 s) PASS -- the manager save path is unchanged apart from a skipped branch; S20 (Alerts preview + send) PASS -- only the Display standards section gained a line; S61 (Insights brief) PASS -- the top line gains an optional chip, ranking and tiers untouched.
REGRESSION RISKS:
- answerStdFor_ gains a field; every caller reads only target/band (grep), and a test sandbox stub in client-lifecycle returns {target} only, which the brief path does not reach.
- getAccessControlInit gains pendingWelcomes (additive).
- The pending list is per-Script-Property: a hand-edit of AGENT_WELCOME_PENDING is parsed tolerantly (bad JSON reads as empty).
INVARIANTS AT RISK: None. INV-01: sendPendingAgentWelcomes is admin-gated and writes a Script Property only (no sheet write); the save/remove keep their four mitigations. INV-13 / the email rule: every welcome still goes through sendAppEmail_ (the admin copy per message is the R28 rule).
NET SCORE: 0 − 1 = -1 (G2/G3 are new capabilities, not production fixes; G3 adds one documented failure mode: if the post-send lock cannot be taken, the sent addresses stay listed and the error says to clear them before sending again)

OPERATOR ACTIONS / DEPLOY:
- After deploying, when you turn on AGENT_ROLE_ENABLED: reopen Admin ▸ Access and press "Send N welcomes" (Operator State #46). Rows staged before this deploy are not on the list (the pre-F1 code had already emailed them); remove and re-add one while the flag is off to queue it | BLOCKS DEPLOY: N
- Optional: check Alerts ▸ Display standards for depts listed "On the company default" and set their targets before reading the brief's colours | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version
- CDR DQE Pipeline / CDR Reporting Tools / CDR Import: no change

FOLLOW-ON ITEMS:
- A bulk send of N welcomes also sends N "[Copy]" messages to the first admin (the R28 copy-every-email rule). Fine at pilot size; a summary copy for bulk sends would need an owner ruling on R28.
- The brief's "Default target" chip has no rendered driver check (the brief is admin-only Insights; pinned by the pure function + a source pin).

DOCUMENTATION UPDATES NEEDED:
- None beyond what this commit made (Operator State #46 + #37, tests/README).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
