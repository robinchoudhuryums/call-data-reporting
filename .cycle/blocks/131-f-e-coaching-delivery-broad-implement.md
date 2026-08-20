---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F-e | Coaching delivery: the weekly email + the SEPARATE coaching worklist (Phase 3 of the
  turnover-suggestion engine — Phase 1 shipped the dark preview in increment 124). Honors every
  owner ruling on record: separate worklist (NEVER mixed into customer-account Escalations), all
  depts / no pilot, ADMIN-ONLY notifications until released, no cross-dept de-dup, 0%-answered
  agents are genuine flags.
- (rider) Row-34 owner ruling RECORDED: "CSR Total Calls row — the sum of total calls, answered
  calls, avg ans time, etc." = direction (a), sum semantics. Doc + parity-suite scope note updated;
  the CODE fix (sidebar refuses row 34 as a total row, dead r34 counters deleted) is a follow-on,
  deliberately not smuggled into this scope.

Files modified:
- apps-script/department-dashboard/Coaching.gs          (delivery layer appended, ~360 lines;
                                                         previewCoachingFlags refactored into a
                                                         gate-free computeCoachingPreview_ core)
- apps-script/department-dashboard/SystemHealth.gs      (svc('trg-coaching', …, 'COACHING_DELIVERY_ENABLED')
                                                         + the out-coaching outcomes row)
- apps-script/department-dashboard/dashboard.html       (Coaching admin-menu item + coaching-modal)
- apps-script/department-dashboard/script-4-nav.html    (ROUTES_ '/admin/coaching')
- apps-script/department-dashboard/script-7-admin.html  (initCoaching_ + worklist render + verbs)
- apps-script/department-dashboard/script-2-chrome.html (initCoaching_() in the boot list)
- tools/ui-harness/build-harness.js                     (mocks for the 6 new RPCs)
- tests/unit/coaching.test.js                           (+9 delivery tests, 20 total)
- docs/known-issues.md                                  (row-34 entry: AWAITING → RULED)
- tests/unit/qcd-sidebar-parity.test.js                 (scope-note comment only)

CHANGES:

F-e server | Coaching.gs | The delivery engine, shaped by the repo's existing patterns end to end:
- STORAGE: Neon `coaching_flags` (auto-created DDL + a PARTIAL UNIQUE INDEX `uq_coaching_open` on
  (department, agent_name) WHERE status='open') — one open card per agent per dept; closed history
  never blocks a later re-flag. No sheet twin (the escalations model); flags are cheap to
  re-derive from DQE history, so an outage loses nothing permanent.
- RUN (`coachingDeliveryRun_`, shared by trigger + admin run-now): computeCoachingPreview_ (the
  gate-free refactor of the Phase-1 preview — trigger-safe, no Session user) → pure
  `coachingDeliveryDiff_(flags, openRows)` splits NEW (insert + email) / CONTINUING (metrics
  refresh + times_flagged+1, NO email — not news) / RECOVERED-OPEN (reported, NEVER auto-closed:
  the math doesn't know whether the conversation happened). One transaction, rollback on failure.
  Email ONLY when newFlags.length (the B3 shared-MailApp-quota lesson), to getAdminEmails_() only
  (owner ruling), plain-text watchdog family, deep link `#/admin/coaching`, gates stated in the
  footer. Neon down → 'skipped (Neon unreachable — flags not persisted, no email)': emailing flags
  that cannot land as cards would notify without a workflow.
- ENGINE PLUMBING: `runCoachingDelivery_` gated on COACHING_DELIVERY_ENABLED (default OFF — ships
  dark), stamps COACHING_DELIVERY_LAST/_LAST_RESULT (OPS-8 prefix-coded: 'ok …'/'skipped …'/
  'ERROR: …'); weekly Monday-8AM install/uninstall RPCs set/clear the flag (the DqeSilenceWatch
  template); `runCoachingDeliveryNow` = full manual fire ([manual] suffix).
- WORKLIST RPCs: `getCoachingWorklist` (admin; open|closed|all; uncached — small, admin-only,
  fresh-after-close matters more; json_agg single-fetch; LIMIT 300; egress-metered) and
  `updateCoachingFlagStatus` (the INV-01 data-mutation set: assertAdmin_ + validation (action ∈
  {resolved, dismissed}, note ≤500) + LockService + audit via closed_by/at + Logger). The UPDATE
  carries `AND status='open'` with executeUpdate()!==1 → a clear "not open any more" error — two
  admins racing from stale views can never silently overwrite each other.

F-e health | SystemHealth.gs | The install-readiness rule ("a new flag-gated engine must pass its
flagProp to svc() or it inherits the old blind spot") honored in the same commit: trg-coaching row
with COACHING_DELIVERY_ENABLED (both mismatch directions surface + it joins the trg-readiness
verdict count) + the out-coaching outcomes row reading the OPS-8 result props. A 'skipped' result
trips the bad-word match ON PURPOSE — a skip here means no worklist upkeep happened.

F-e client | dashboard.html / script-4-nav / script-7-admin / script-2-chrome | Admin ▾ → Coaching
(data-admin-only, view-as-manager hides it; the F11 router guard no-ops a non-admin deep link).
Modal = the health-modal shape: status filter (Open default / Closed / All), idempotent
innerHTML-replace render (F10), per-open-row optional note input + Resolve/Dismiss both
dsConfirm_-gated (Dismiss carries the danger tone), delegated tbody listener (rows re-render every
load). Failure path on a race says so and refreshes to the truth. Delivery section: install /
uninstall (direct — reversible) + Run now (dsConfirm_-gated: it persists AND emails, not a
preview). ROUTES_ '/admin/coaching' is what the email deep link lands on. Neon-unavailable renders
an explicit error state naming that flags are re-derivable. Zero styles.html changes — everything
reuses al-config-table / ds-toolbar / status / btn classes.

Row-34 ruling | docs/known-issues.md + qcd-sidebar-parity.test.js | Entry retitled RULED, records
the owner's words and direction (a); names the follow-on code fix (sidebar refusal-list + predicate
removal + dead-counter deletion, a two-file edit) and flags that the 35+37 double-count is now a
property of the RULED definition — to surface separately, not fix unilaterally. Parity suite's
scope comment points at the entry.

TEST DOUBLES: build-harness.js mocks all 6 new RPCs (fixture shape mirrors the server payload
pinned by coaching.test.js). The unit fake conn models prepareStatement/execute/executeUpdate/
commit/rollback with SQL+param capture — updateResult:0 drives the race branch.

TEST RESULTS: PASSED — 819/819 (was 800; +19: 9 coaching-delivery + the Batch-E additions already
counted at 810 — net +9 from this block). Includes html-include-structure (fragment purity + the
assembled-client node --check over the edited script-7-admin/script-2-chrome/script-4-nav) and
system-health.test.js (unaffected by the new svc row — its fixtures don't assert the armed count).
INV-16 guard green. `npm run ci:ui` (full rendered gate, playwright installed): PASSED — all six
asserting stages green (drive-smoke incl. view-as-manager, drive-f13, drive-devoverlay 14/14,
drive-subqueue, build-agent + drive-agent 20/20), exit 0. Coaching.gs passes node --check.

REGRESSION RISKS:
- computeCoachingPreview_ refactor: previewCoachingFlags is now a two-line gated wrapper — behavior
  pinned unchanged by the pre-existing preview test (still passes verbatim, including the gate).
- The svc()/outcomes additions render two more Health rows; muted 'never run' until the engine is
  touched — no false amber on installs that never enable it.
- The engine ships DARK (flag unset, no trigger): production behavior changes only when an admin
  installs the trigger. The modal is reachable (admin-only) before that and renders the empty
  worklist + 'Not enabled' state.
- coaching_flags DDL runs lazily on first worklist open / first run — no setup() change (the
  Direct Call History precedent).
- The email fires at most weekly and only on NEW flags; a run storm is impossible (one trigger,
  and the manual path is behind dsConfirm_).

NET SCORE: +2 − 0 = +2
  (The Phase-1 engine's flags now GO somewhere: a coach gets an email and a card with a close
  workflow, instead of an editor-run preview only an admin who remembers it exists ever sees.
  Score kept modest: dark until the owner arms it.)

OPERATOR ACTIONS / DEPLOY:
- Dashboard deploy required to ship (Coaching.gs + SystemHealth.gs + the 4 client files):
  `scripts/deploy.sh . <dashboard-deployment-id>`. | BLOCKS DEPLOY: N (dark until armed)
- To ARM (when ready): Admin ▾ → Coaching → "Install weekly trigger" (sets
  COACHING_DELIVERY_ENABLED=true, Monday 8AM). First run inserts every currently-qualifying agent
  as NEW → expect ONE larger first email; consider "Run now" on a weekday to see it land before
  trusting the schedule. Health page: trg-coaching / out-coaching rows track it.
- No new Script Properties to set by hand; no new OAuth scopes (MailApp/ScriptApp/JDBC already
  consented).

FOLLOW-ON ITEMS:
- Row-34 CODE fix (now unblocked by the ruling): add 34 to dataFilters.js's total-row refusal
  list + remove its row-34 predicate; delete the dead r34_abnd1m/2m counters in autoImport.js;
  extend qcd-sidebar-parity to assert the refusal. Two files, small.
- The 35+37 double-count inside the ruled sum (internal status-3 abandon >1m) — surface to the
  owner if row 34 ever drives a decision.
- Release path for coaching (owner-gated): swap assertAdmin_ for the manager gate in
  getCoachingWorklist/updateCoachingFlagStatus, un-hide the menu item for managers, widen the
  email recipients. All surfaces were built so this is gate-swapping, not rebuilding.
- Coaching worklist has no ci:ui driver stage (the modal is admin-only and dark); if it ever
  releases to managers, add a drive-smoke visit the way the health modal got one.

DOCUMENTATION UPDATES NEEDED (for the next /sync-docs):
- CLAUDE.md: the Coaching engine one-liner in the test-suite roll already names 'coaching' — amend
  its parenthetical from "dark, admin preview only" to note the delivery layer + worklist (still
  admin-only, still dark by default). Consider an Operator State item for
  COACHING_DELIVERY_ENABLED (#48) — it is a real operator input now.
- docs/operator-state.md: add the #48 item (install/arm/first-run semantics, the one-larger-first-
  email note, the release path).
- tests/README.md coverage map: coaching.test.js now covers the delivery layer too.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
