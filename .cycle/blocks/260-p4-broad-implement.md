---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: P4 (Team Direct Calls side card) from the follow-up plan of 2026-11-13 (owner notes, not a scan finding): P4a the side column overlap; P4b a loader from the first moment and the last figures kept while a new range loads; P4c the decluttered card. Before it, on the owner's same message: Transfer retries prints its times in Central (commit a0aa9cd, `P3-TZ`).
New capabilities (G/ST): None from the scan's expansion plan. P4c (the new card form) is a redesign, not a fix.
Files modified: apps-script/department-dashboard/script-5-dept.html, script-9-inbound-direct.html, script-7-admin.html (P3-TZ), dashboard.html, styles.html; tests/unit/team-direct-card.test.js (new), brief-accordion.test.js, transfer-retries.test.js (P3-TZ); tools/ui-harness/drive-deptoutbound.js, drive-admin.js (P3-TZ), README.md; tests/README.md; docs/client-ui-conventions.md, fix-history.md, regression-scenarios.md, operator-state.md (P3-TZ); .cycle/STATE.md.

CHANGES:
P3-TZ | script-7-admin.html, dashboard.html | Transfer retries printed journey times as stored (Pacific). All three prints (who answered the caller, each list's When cell) go through `trWhen_` -> `clCstTime_`, the journey drill's shift; the modal says "Times are Central". Display only.
P4a | styles.html, script-5-dept.html | With the card in the side column (admins), `tdcSync_` sets `.dept-side--direct` on the aside and Team Rings / Team Outbound become `flex: 0 0 auto` with a 200px scrolling table, as in the Both view. Before, R18b's two-panel shrink-to-fit let Team Rings give up all its height (26px measured on the Inbound view) and its tiles and pinned table header were drawn over the card. The same collapse applied to Team Outbound on the Outbound view.
P4b | script-5-dept.html, dashboard.html | `refresh()` calls `tdcArm_()` (`TDC_.pending`) beside `deptMissedFrostArm_()`, so the card is busy from the page's own request; `onError` and refresh()'s two early returns call `tdcDisarm_()`. While busy the card shows `tdcHeld_()` -- the newest good payload (`TDC_.last`) for the SAME department -- under a frost on `#tdc-body`; with nothing to keep, before the first window is known, or after a department switch it shows the skeleton. An error shows the error and Retry, never old figures. `TDC_.data` keeps its meaning, so the Direct view of the agent table is unchanged.
P4c | script-9-inbound-direct.html, script-5-dept.html, dashboard.html, styles.html | The card form of `directSummaryHtml_` is one headline (answered of rang, with the rate when free at its end), one bar, a key line (the colours plus the missed and busy counts; it also keys the agent tallies) and a three-row labelled block (Outside answered, Calls to colleagues, Calls to outside numbers). The second headline and bar, the two lines of small text and the legend row under the table are gone; the block size sits in the table header (`#tdc-unit`); the table is `table-layout: fixed`; a coverage caveat is one quiet line, the boxed note kept for "nothing to show". The tally caps at 10 blocks (was 12). 588px -> 471px in the harness. No figure changed. `directViaLineHtml_` was split into `directViaAnsweredBits_` / `directViaTip_` so the card reuses its figures; its own output is unchanged.

TEST RESULTS: passed — `TZ=America/Chicago node --test` 3071 pass, 0 fail, 1 skipped (12 new tests: 11 in team-direct-card.test.js, 1 in transfer-retries.test.js); `npm run lint:gas` clean; module-deps and the INV-16 guard clean; `npm run ci:ui` all stages passed on the final code, with 6 new rendered checks in drive-deptoutbound.js and 1 in drive-admin.js; 7 bite-checks, each named test went red on its mutation. Regression scenarios were not walked against the live app (no deployment from here); the steps added to S57's Team Direct Calls scenario, S69 and S70 are the owner's to walk.
REGRESSION RISKS: (1) On the Inbound and Outbound views an admin's side column is now taller than a short window, so it scrolls and the card can sit below the fold; before, it fit by drawing one panel over another. (2) While a new range loads, the figures under the frost are the previous window's while the date line names the new one; the frost and "Loading…" are the only signal. (3) The owner has not yet signed off the new card form; the before/after images are attached to this session's report. (4) The table overrun the owner reported was not reproduced in the harness; the fixed columns make it impossible for this table, but it may have been the agent panel's colleague table, fixed in P2.
INVARIANTS AT RISK: None — client-only; the card stays admin-only (`data-admin-only` + `tdcActive_`, INV-39's direct strip untouched), a manager and View-as never get the class or the request (driver-checked); no cache key, payload or server rule changed.
NET SCORE: 2 − 0 = 2 (P4a and P4b fired in production for the admin on every Inbound-view load and every date change; P3-TZ is a display correction counted with them as no new failure mode; P4c is a redesign and claims no fix)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard | BLOCKS DEPLOY: N
- Look at the before/after images and say whether the new card form stands | BLOCKS DEPLOY: N
- Walk the P4 step of the Team Direct Calls scenario and the new time step of S69 | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Direct view of the agent table still blanks under its frost while a new range loads; it reads `TDC_.data`, and could read the held payload the card now keeps.
- Team Rings and Team Outbound still blank or keep stale figures on their own rules; the card's "busy from the page request" was not extended to them.
- With four panels in an admin's side column (Both view) the column is about twice a laptop window's height; a collapse control per panel would address it.
- The card's percentages keep one decimal (as the Direct Calls report serves them) while Team Rings shows whole percents.

DOCUMENTATION UPDATES NEEDED:
- None — client-ui-conventions (the Team Direct Calls bullet and the Transfer retries bullet), fix-history (`P3-TZ`, `P4`), regression scenarios, Operator State #89, tests/README and the harness README were updated in these changes.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
