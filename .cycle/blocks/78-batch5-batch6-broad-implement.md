---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
Batch 5 (a11y structural): E-6 (dsConfirm_ no Tab trap + Enter-confirms-from-anywhere), E-7 (chart-help dialog without focus/label), E-8 (role="button" on a <tr> against the house rule), E-9 (placeholder-only search inputs), E-10 (menu roles without arrow-key behavior).
Batch 6 (server smalls): B-5 (ALL-sentinel managers excluded from all alert delivery), B-6 (weekly/monthly digest gates — resolved as documented-deliberate), A-3 (misleading assertAdmin_ message), A-4 (escalations truncated false-positive at the cap), A-5 (dead numCols), B-8 (two endpoints missing usage telemetry), E-5 (retired button ids in exportCaptureFailed_).

Files modified:
- apps-script/department-dashboard/script.html (E-6, E-7, E-8, E-10, E-5)
- apps-script/department-dashboard/dashboard.html (E-9)
- apps-script/department-dashboard/Util.gs (A-3)
- apps-script/department-dashboard/Escalations.gs (A-4)
- apps-script/department-dashboard/Data.gs (A-5)
- apps-script/department-dashboard/Alerts.gs (B-5)
- apps-script/department-dashboard/Digest.gs (B-6 rationale comment)
- apps-script/department-dashboard/MissedCallsReport.gs, CompanyOverview.gs (B-8)
- tests/unit/alert-recipients.test.js (NEW — lookupDeptManagers_'s first coverage)

CHANGES:
E-6 | script.html | dsConfirm_: Tab toggles between the two buttons (covers Shift+Tab), the capture-phase Enter resolves by FOCUS (Cancel-focused Enter used to CONFIRM — destructive actions included), focus returns to the opener on settle
E-7 | script.html | chart-help popover: aria-label + tabindex=-1, focus in on open, back to the ? on close
E-8 | script.html | insurer drill row keeps its implicit row role (tabindex + existing keydown remain)
E-9 | dashboard.html | aria-labels on ir-agent-search / ir-edit-search / ins-agent-search / ins-edit-search
E-10 | script.html | header menus: ArrowDown-on-trigger opens + focuses first item; Arrow/Home/End walk (wrapping); Escape returns focus to the trigger; items filtered to visible+enabled (respects data-admin-only hiding)
B-5 | Alerts.gs | lookupDeptManagers_ honors isAllDeptsSentinel_ rows (typeof-guarded); pinned by the new suite (both ALL and * spellings; single-dept managers stay scoped)
B-6 | Digest.gs | comment block documenting WHY weekly/monthly deliberately lack the daily gates: a skipped weekly/monthly run has NO later run to cover it (the daily skip is safe only because of the next-weekday business-day walker); deferral would need a trigger redesign — explicitly declined
A-3 | Util.gs | assertAdmin_ throws a surface-neutral message naming the ADMIN_EMAILS triage path (Operator State #13); all /admin/i test asserts still pass
A-4 | Escalations.gs | LIMIT cap+1 then slice (the NEO-4/R-2 pattern); truncated = fetched > cap
A-5 | Data.gs | dead numCols removed, replaced by a one-line note pointing at the real REP-10-clamped readCols
B-8 | MissedCallsReport.gs, CompanyOverview.gs | logReportUsage_('missedSlice', dept, ...) and logReportUsage_('overviewChartYtd', '(all)', ...) on all serve paths (cache-hit + fresh + degraded)
E-5 | script.html | exportCaptureFailed_ re-enable list drops pr-export-btn / cr-export-btn

TEST RESULTS: passed — node --test 630/630 (was 628; +2 in the new alert-recipients suite), INV-16 clean, full ci:ui gate green (all stages — drive-f13's S39 keyboard walk covers the changed focus paths; the dsConfirm_/menu changes threw nothing). Perceptual/AT checks (actual screen-reader announcement of the menus and popover) are NOT verifiable in-container — a quick NVDA/VoiceOver pass post-deploy would close the loop.

REGRESSION RISKS:
- E-6's Enter-follows-focus is a deliberate BEHAVior change: Enter with focus on Cancel now cancels (previously confirmed). This is the safe direction for destructive confirms; mouse flows unchanged (initial focus is still the OK button).
- E-10's menu keydown listeners are additive; Tab still works as before (items are real buttons). The visible-items filter reuses offsetParent, so view-as-manager's hidden admin items are skipped.
- B-5 widens alert delivery: any existing ALL-row manager starts receiving every dept's alerts on the next trigger run — the intended semantics of the role, but worth a heads-up to the operator in case that inbox considered the silence a feature.
- A-3 changes the thrown message text; no test or client string-matched the old one (verified).

INVARIANTS AT RISK: None. INV-32 (alerts admin boundary) untouched — B-5 changes recipient RESOLUTION, not the gate. INV-55 untouched by A-4 (read-path only). The E-8 change aligns with the documented client convention rather than departing from it.

NET SCORE: 1 − 0 = 1
(B-5 fires every alert day for the install's ALL-sentinel managers — if any exist, they were receiving nothing this month; counted as 1 on the same plausibly-live standard as B-4. E-6's Enter-on-Cancel is real but needs a keyboard user mid-confirm; the rest are latent/polish.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard as a NEW VERSION (Operator State #2) | BLOCKS DEPLOY: Y
- Heads-up: managers with an ALL/'*' Access Control row begin receiving every dept's low-answer-rate alerts (B-5 — intended semantics) | BLOCKS DEPLOY: N
Deploy: scripts/deploy.sh . <dashboard-deployment-id> (one new version now covers increments 74/76/77/78; cdr-import's pending 74/75 deploy unchanged)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- script.html:~7758 — the sub-queue group-head <tr> ALSO carries role="button" (the same E-8 class, not in the audit findings; it additionally has aria-expanded, so the right fix may differ — consider with Batch 8-10 or the next scan).
- Remaining batches: 7 (C-3/F-10/F-9/F-11/F-8), 8 (D-1..D-6), 9 (C-7), 10 (D-8/D-9), + strategic items.
- B-6's resolution is documentation-of-intent; if the owner ever WANTS holiday deferral for weekly/monthly, it is a trigger redesign (daily poll + run-claim marker), not a gate.

DOCUMENTATION UPDATES NEEDED:
- Queued for next /sync-docs (with the two clauses already queued): B-5's behavior belongs in the role-model bullet's alerts note ("Alerts + Digests follow neither mechanism" — now alerts DO include ALL-sentinel managers as recipients).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
