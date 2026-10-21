---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (owner requests 2026-10-21, not scan findings):
  - BRF-1  The admin brief froze on the old window while the Insights region at the bottom was collapsed (window sync + dept Refresh re-run returned early on a closed region)
  - BRF-2  Insights Copy image and Print missed the six sections the brief had moved up
  - ICON-1 The side panels' ⓘ grew a second circled i on hover (.gloss::after)
  - QD-3b  drive-outbound-e's QD-3 amber check depended on the run date (red on main 2026-10-21)
New capabilities (G/ST): None from a scan. Owner-requested features:
  - APN-1  Admin-only outbound call id + copy + OUTBOUND "↳ path" on the agent panel's Outbound tab and the Agent Day cards (audit aid for "are these outbound calls internal?")
  - APN-2  The agent panel slides open and shut
  - Note   next-steps.md: what the bottom Insights region still carries, for a careful removal on a wide brief release
  - Mocks  (no code) agent-table layouts A/B/C + day-bar target line: https://claude.ai/artifact/PJvnqUpQJ2tmZ1Z89pZJax
Files modified:
  apps-script/department-dashboard/script-8-insights.html (insReportLive_; insSyncToDeptWindow_ + deptInsightsEnsureLive_ gate on it; insBriefMountedEls_ / insBriefHomeIn_; insBuildCanvas_ snapshots brief canvases + homes them in the clone; insPrint_ unmount/remount)
  apps-script/department-dashboard/script-2-chrome.html (dept Refresh re-run gates on insReportLive_)
  apps-script/department-dashboard/script-5-dept.html (parentIdBadge(id, date, kind))
  apps-script/department-dashboard/script-10-escalations.html (adOutboundIdHtml_; apOutboundTableHtml_(rows, date) + admin "Call" column; adOutboundCardHtml_(c, date); .ap-clip wrapper; apAnimateOpen_ / apAnimateClose_; apClose_ detaches via the slide)
  apps-script/department-dashboard/styles.html (.side-hint-i.gloss::after none; .ap-clip slide rules + reduced motion)
  tests/unit/brief-accordion.test.js (pin moved to insReportLive_ + the sync gate)
  tools/ui-harness/drive-smoke.js (+4: collapsed-region re-run, Print, Copy image, one ⓘ)
  tools/ui-harness/drive-agentpanel.js (+4: admin call ids, manager none, settled unclipped, slide-shut detach)
  tools/ui-harness/drive-admin.js (+2: Agent Day outbound ids, the outbound drill opens)
  tools/ui-harness/drive-outbound-e.js (QD-3 amber colour on a probe chip)
  tools/ui-harness/README.md, docs/client-ui-conventions.md, docs/regression-scenarios.md (S56, S61), docs/fix-history.md (6 rows), docs/next-steps.md (region-removal note)

CHANGES:
BRF-1 | script-8, script-2 | One gate `insReportLive_()` = region open OR insBriefActive_(); the sync, the page ensure and the Refresh re-run read it. A dept switch with the region collapsed now re-runs too (it also used to stay on the old dept).
BRF-2 | script-8 | Copy image: canvases from the brief's sections are snapshotted and `insBriefHomeIn_(clonedDoc)` moves the sections to their [data-ins-home] placeholders in the CLONE only. Print: insBriefUnmountAll_ before window.print(), insBriefMountAll_ in a finally (open state kept by INS_BRIEF_OPEN_).
ICON-1 | styles | `.side-hint-i.gloss::after { content: none; }` (three panels).
QD-3b | drive-outbound-e | The amber colour is read from a probe chip appended inside a real tile; real amber chips, when the date gives some, must match too.
APN-1 | script-5, script-10 | Admin-only; managers get no column. The server already sent callId to every viewer (AgentDay.gs) -- no payload change. adOutboundIdHtml_ also calls initClipboardOnce() (idempotent) so the copy / path buttons work even when the Agent Day view renders first.
APN-2 | script-10, styles | grid-template-rows 0fr <-> 1fr, 220 ms; clipped only while moving (.ap-settled -> overflow visible, sticky-left intact); a closing row loses its id + gets inert at once and is removed after AP_ANIM_MS_ + 40 ms; reduced motion snaps.

TEST RESULTS: passed -- node --test 2615 tests, 2614 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps --check clean; ci:ui full gate green on the final code (rc=0, all 15 stages; drive-smoke 176/176, drive-agentpanel 36/36, drive-admin 111/111, drive-outbound-e 33/33). 11/11 bites land: brief re-run, Copy image, Print, ⓘ, QD-3 amber, manager no-id, admin id kind, settled overflow, slide-shut detach, Agent Day card id. One test double updated (brief-accordion's source pin on the old gate). Pre-existing failure found and fixed in scope: QD-3's date dependence (red on main; classified "red on base", fix ported here). initClipboardOnce() in adOutboundIdHtml_ is NOT bite-pinned (the handler is already wired at boot in the harness) -- defensive only.
REGRESSION RISKS:
  - BRF-1: an admin with the region collapsed now pays the Insights re-run on every window / dept change (it paid it on first load already); managers and View-as unchanged (insBriefActive_ false).
  - BRF-2: Print briefly moves the sections home and back; in a browser whose window.print() does not block, the remount lands before the print renders and the print is as before (sections missing) -- never worse.
  - APN-2: for ~260 ms after a close a detached, inert, collapsing ghost row sits in the tbody; any code that queries tr.ap-row in that window sees it (none does today; apRowsFor_ needs data-agent, which it lacks). Opening a second agent while one closes shows both rows for that moment.
  - APN-1: parentIdBadge's new third argument is optional; every existing two-argument caller renders identically.
INVARIANTS AT RISK: None changed. INV-39 / the 6c gate: the call id is shown to admins only on the client; the id itself already reached managers' Agent Day payloads (no new data). INV-37 untouched (no page / setPage change). INV-30 untouched (no cache or payload change). INV-01 untouched (client only).
NET SCORE: 4 production fixes (BRF-1, BRF-2, ICON-1 -- reachable by the admin trial's one user, the owner, who reported ICON-1; QD-3b -- red on main today) − 1 new failure mode (APN-2's transient ghost row, documented) = 3

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version). Walk S56 and S61.

(Not complete in production until the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Direct Calls Report: audit done, plan D0 (read-only classification probe) / D1 (missing-date guard + clamp, int/ext columns, copy fixes, harness mock + driver + scenario; dashboard-only) / D2 (capture fixes: Internal-direction outbound, every roster extension, root dedup, anonymous callers; needs re-import) / D3 (My Department Direct summary, shared server function) -- awaiting owner go-ahead.
- Outbound internal-vs-external: a read-only editor probe bucketing a CSR's outbound (company line / forwarded-to-colleague / root-split twin / misdial / redial) with call ids -- proposed, not built.
- Agent table layout: owner to pick B (stacked) or C (paired bars, recommended) from the mocks.
- Day-bar target line: owner to rule (recommended only on a fitted scale, % Ans + Abandoned % only).
- Bottom Insights region removal on a wide brief release (next-steps.md note).
- The unreachable Outbound-only table rendering (from Step 3) is still inert code.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in these commits (CLAUDE.md untouched: S56 / S61 titles unchanged).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
