---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (P10 is new capability from the owner follow-up plan of 2026-11-13, not a scan finding)
New capabilities (G/ST):
- P10a | A read-only match-rate check between a transfer retry's first attempt and its `direct_calls` record: `probeTransferRetryAvailability()` (dashboard editor), plus the same rate printed on the page.
- P10b | Transfer retries, "Not answered first": a Free or on a call column for the person tried first (with whom, when on a call), and "While free" / "While on a call" counts in the ranking.
Files modified:
- apps-script/department-dashboard/TransferRetries.gs
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-7-admin.html
- apps-script/department-dashboard/styles.html
- tests/unit/transfer-retries.test.js
- tests/unit/manager-numbers.test.js
- tools/ui-harness/gen-phase3.js
- tools/ui-harness/drive-admin.js
- tools/ui-harness/README.md
- tests/README.md
- CLAUDE.md
- docs/operator-state.md
- docs/regression-scenarios.md
- docs/fix-history.md
- docs/client-ui-conventions.md
- docs/per-call-capture.md
- docs/module-dependencies.md

CHANGES:
P10a | TransferRetries.gs | `trAvailMatch_` (pure): an attempt matches the person's inbound internal direct-call record whose ring holds its time, give or take `TR_AVAIL_SLACK_SECS_` = 3 s; a record naming a different caller than the sender is never accepted; a record naming the sender beats an unnamed one; a tie is `ambiguous`; a record that says answered is `conflict`. `trAttachAvailability_` sets each case's `first.avail` = { state, with? } and returns the tally (known / free / busy / noDay / noRow / ambiguous / conflict, sender-named count, time offsets, samples). `probeTransferRetryAvailability()`: admin-gated, read-only, last 30 days ending yesterday, all departments; logs a VERDICT (GOOD 90%+, PARTIAL 60%+, POOR, INCONCLUSIVE under 20 attempts on covered dates) and what a 30 s allowance would add.
P10b | TransferRetries.gs | `trFetchJourneyRows_` (the existing read, extracted unchanged) and `trFetchDirectFor_` (one metered statement: the cases' own date + person pairs joined to `direct_calls`, inbound internal only, plus which dates hold any record; employee names only, `busy_with` through to_jsonb). `trBuildFromRows_` takes an optional `opts.attach(cases)` run over every case before the tallies and the 500 cap, so the ranking's `free` / `busy` counts stay exact. `trAvailAttacher_`: a failed direct-call read leaves the list whole and reports `avail.unavailable`. `trRetriesOfJourney_` is untouched (cdr-import parity stands).
P10b | dashboard.html, script-7-admin.html, styles.html | The "Free or on a call" column (Free / On a call + with whom on the light-yellow busy colour / a visible "Not known" with the reason on hover), the ranking's two extra columns, the match-rate line `#tr-avail-note`, and the intro sentence. The columns are `.tr-avail-col`, shown only while at least one attempt is known.
P10 | tests/unit/transfer-retries.test.js, manager-numbers.test.js | Seven new tests (the match rules, per-case states, the ranking before the cap, the direct-call SQL and its parameters, a failed read, wrong-shaped replies, no second read without a case, the probe's gate / window / verdicts); the "one metered read" test now expects two reads; NUM-5's source pin follows the new call.
P10 | tools/ui-harness/gen-phase3.js, drive-admin.js | A direct-call fixture (one free, one on a call with a colleague, one date with no record) and three rendered checks.
P10 | docs | Operator State #89 (the rule, the limits, the probe and how to read it), S69 (a P10 step), fix-history `P10`, client-ui-conventions, per-call-capture (a second reader of `direct_calls`), tests/README, harness README, CLAUDE.md index #89, module map regenerated.

TEST RESULTS: passed — unit 3,151 pass / 0 fail (TZ=America/Chicago node --test); `npm run lint:gas` clean; module map up to date; INV-16 guard in sync; `npm run ci:ui` all stages passed (drive-admin 252 of 252); 8 of 8 bite-checks bite.
REGRESSION RISKS:
- `getTransferRetries` now makes a second Neon read whenever at least one retry is found. It is small (only the cases' own date + person pairs) and failure-isolated, but it adds a little time and read volume to every run.
- `summary.callees[]` rows gain `free` / `busy` and `summary` gains `avail` when the attach step ran; the shape without it is unchanged (pinned).
INVARIANTS AT RISK: None — INV-01 (both new functions are read-only and admin-gated; no sheet or Neon write), the no-phone-number rule (employee names only; no hash, extension or dialled number selected) and the TR parity rule (rule function untouched) were checked.
NET SCORE: 0 − 1 = −1 (no production fix; one documented new failure mode: the state shown rests on a match whose rate has not been measured, so until the probe reads GOOD the column is a sample, and a wrong state is possible in one narrow shape — two rings to the same person within seconds where the record names no caller)

OPERATOR ACTIONS / DEPLOY:
- Run `probeTransferRetryAvailability()` in the dashboard Apps Script editor after the deploy and read the VERDICT; send the log back on PARTIAL / POOR / INCONCLUSIVE | BLOCKS DEPLOY: N
- Walk S69's P10 step (compare a "Free" and an "On a call" row with that person's Direct tab in the agent panel), then `runLiveSmoke` | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`). No cdr-import or cdr-report push is needed for P10.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The durable fix if the match rate is not GOOD: have the capture store the internal call's id on the journey's person-transfer event (IXT-1 / OXT-1, cdr-import), so the match is by id. Not retroactive.
- Retries on dates before the per-call direct list began (AC-6, about 14 days before 2026-11-04) can never be known; the page says so per row and in the note.
- Only a retry's FIRST attempt gets a state. The second attempt, and a not-answered second try on the "Answered, then redirected" list, do not.
- cdr-import's `diagnoseTransferRetries` prints no availability (it could compute it from the raw legs directly).
- The harness mock does not re-tally `summary.avail` when a department is picked (harness only).
- P11 (callback worklist) still needs the owner's privacy decision.

DOCUMENTATION UPDATES NEEDED:
- None — updated in this change (see CHANGES).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
