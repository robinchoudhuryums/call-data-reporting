---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- EML-1 (Step 0a): ALL/'*' Access Control managers are OPT-IN only for dept-manager email (low-answer-rate alerts + new-escalation notice), via ALL_DEPT_NOTIFY_OPT_IN
- EML-2 (Step 0b): the admin copy of every dashboard email is a SEPARATE "[Copy]" message To the admin (never a BCC); cdr-report's DCTR sends the same copy
Files modified: apps-script/department-dashboard/Alerts.gs, Config.gs, Escalations.gs, SystemHealth.gs; apps-script/cdr-report/emailDailyReport.js; tests/unit/alert-recipients, app-email, access-control-editor, digest-freshness-gate, email-kit-v2, ir-send-to-agent, queue-report, system-health (.test.js); CLAUDE.md; docs/operator-state.md (#58), docs/fix-history.md, docs/module-dependencies.md (regenerated), tests/README.md, .cycle/STATE.md

CHANGES:
EML-1 | Alerts.gs, Config.gs, Escalations.gs | lookupDeptManagers_ includes an ALL/'*' manager row only when its address is in ALL_DEPT_NOTIFY_OPT_IN (new allDeptNotifyOptIn_, case-insensitive; the list filters ALL rows, never adds a recipient); the property is registered (operator); both callers (alerts resolveRecipients_, escNotifyNewEscalation_) inherit it
EML-2 | Config.gs, SystemHealth.gs | sendAppEmail_ sends the real email, then one separate message per copy address (appEmailCopyList_ replaces appEmailBcc_; appEmailCopyMessage_ builds "[Copy] <subject>", To the admin only, a "Sent to: … · cc: … · bcc: …" line in the plain body and a banner injected inside <body> of the HTML, attachments/inlineImages/name/replyTo carried); skipped for an address already in to/cc/bcc; a failed copy is logged and never fails the send; EMAIL_BCC list/none/ENG-6 semantics unchanged; Health email-bcc hint reworded
EML-2 | cdr-report/emailDailyReport.js | new sendReportAdminCopy_ (same rule, address = NEON_WRITE_CONFIG.alertEmail) called after the DCTR send; the Daily Queue Report already CCs the admin, failure notices already go To the admin, the batch zip goes To the runner
Tests | 7 existing suites | test doubles that counted sends or asserted m.bcc updated to the copy model (real-message filter / copy assertions)

TEST RESULTS: node --test 1941/1941 pass; INV-16 guard clean; module-deps --check clean (regenerated); lint:gas clean; ci:ui all stages passed. New pins bite-checked (ALL always included, opt-in case, back-to-BCC, copy failure failing the send, banner outside body, cdr-report dedupe -- each turns its test red). Regression Scenarios S20/S29 (alerts/digest sends) are live-only: NOT APPLICABLE here -- walk after deploy (an ALL manager no longer appears in an alert preview's recipients unless opted in; every email arrives in the admin inbox as a [Copy]).
REGRESSION RISKS: (1) behaviour change by design: an ALL manager who relied on receiving every dept's alert stops receiving it until listed in ALL_DEPT_NOTIFY_OPT_IN; (2) the admin inbox now receives one [Copy] per dashboard email (same recipient quota as the BCC); (3) MailApp calls per send double when a copy applies (execution time only; quota counts recipients).
INVARIANTS AT RISK: None (INV-01 unaffected -- no new write path; INV-31 send_mail scope unchanged; INV-34/45 schemas unchanged).
NET SCORE: 2 production fixes (both firing today: the owner never sees the copies; ALL managers receive alerts/escalations they did not ask for) − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- If any ALL manager SHOULD keep receiving every dept's alerts/escalation emails, set ALL_DEPT_NOTIFY_OPT_IN (dashboard Script Property, comma-separated addresses) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version
Deploy: CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`

FOLLOW-ON ITEMS:
- Steps 1 / 2a / 2b of the escalations plan (admin reassignment; linked department copies with a shared thread) -- approved, not started; plan in .cycle/STATE.md
- EMAIL_BCC now names a copy list rather than a BCC list; renaming the property was deliberately skipped (compatibility)
DOCUMENTATION UPDATES NEEDED:
- None (CLAUDE.md email bullet + Multi-row bullet + OS #58 index, operator-state #58, fix-history EML-1/EML-2, tests/README updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
