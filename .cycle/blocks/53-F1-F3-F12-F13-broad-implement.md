---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F1 | Inbound queue recognition was a hardcoded `A_Q_*`/`Backup CSR` literal; a queue named outside it was invisible to the whole capture (and to both diagnostics) — now also fed from the Dept Config sheet
- F2 | Inbound/outbound writers skipped the authoritative per-date DELETE on an empty record set, so a date whose legitimate count is zero could never shed phantom rows
- F3 | The escalation overdue threshold meant calendar days on the client and 72 hours on the server (two copies), so the band tile / nav badge could disagree with the ⚑ cards
- F12 | The deferred Neon mirror rethrew on the first hard error, never attempting the two tables that cannot be re-derived — which then got dropped by the retry cap
- F13 | Five click-only surfaces (incl. the Overview landing grid and the agent-row IR drill) were keyboard-inaccessible

Files modified:
- apps-script/cdr-import/inboundCalls.js
- apps-script/cdr-import/outboundCalls.js
- apps-script/cdr-import/NeonMirror.js
- apps-script/department-dashboard/Escalations.gs
- apps-script/department-dashboard/script.html
- apps-script/department-dashboard/styles.html
- tests/unit/inbound-calls.test.js
- tests/unit/outbound-calls.test.js
- tests/unit/neon-mirror-tail.test.js
- tools/ui-harness/drive-f13.js (new; audit tooling, never deployed)

CHANGES:
F1 | cdr-import/inboundCalls.js, cdr-import/outboundCalls.js | New `IC_KNOWN_QUEUE_NAMES_` module set consulted by `icIsQueueName_` IN ADDITION to the existing regex (strictly additive — it can only recognize more names, never fewer). New `icLoadConfiguredQueueNames_()` populates it from the dashboard's `Dept Config` sheet: "QCD Queues" (col 2) + "Inbound Queue Aliases" (col 10, including the RAW side of `raw=canonical` pairs); digit-only tokens rejected (extensions), inactive rows ignored. Both writers load it BEFORE the record builder (`icIsQueueName_` runs inside it). Refactored the Dept Config read into one shared `icDeptConfigActiveRows_()` memo now serving both the F1 set and `icQueueCanonicalMap_`, with a single `icResetConfigMemos_()` reset entry point. `buildInboundCallRecords_` stays PURE (module global, not a parameter); null = exact pre-F1 behavior.
F2 | cdr-import/inboundCalls.js, cdr-import/outboundCalls.js | New `icDeleteDateOnly_(table, dateIso, label)` performs the authoritative per-date DELETE with no insert. Both writers call it instead of returning early, gated on `authoritative && expectedDateIso && rawRows.length` — the non-empty-source gate is the safety (an empty/unreadable grid keeps the old early-return, the one case where deleting would destroy good data). Returns `unreachable` when Neon is down so the date is retried rather than marked done; both backfill loops widened to honor `res.unreachable`. A missing table is a clean success (nothing stale).
F3 | department-dashboard/Escalations.gs, script.html | New `ESC_OVERDUE_DAYS` + `ESC_OVERDUE_SQL_` (`(CURRENT_DATE - occurred_at::date) >= N`) replace the inline `occurred_at < now() - interval '3 days'` in BOTH `getEscalations`'s band aggregate and `getEscalationsBadge`, so the server counts calendar days like the client's `escDaysOpen_`. Corrected the server comment that claimed they already matched; added a sync note on the client's own copy (two runtimes, the INV-06 mirror pattern).
F12 | cdr-import/NeonMirror.js | `neonMirrorDate_`'s `step()` now COLLECTS hard errors and returns null instead of rethrowing; the aggregated error is thrown ONCE after every step has run, so the caller's hard-fail semantics (attempt counting + the `NEON_MIRROR_MAX_ATTEMPTS` cap) are unchanged. Step order changed to least-recoverable-first: Inbound, Outbound, CDR, QCD, DQE. The Neon-unreachable path is untouched (it never short-circuited).
F13 | department-dashboard/script.html, styles.html | New shared `keyActivate_(el, fn)` / `makeActivatable_(el, fn)` helpers plus a shared `qcdToggleExpandRow_(row)` (keeps chevron + `aria-expanded` in step for both expandable-row surfaces). Applied to: the Overview dept tile (role+tabindex+aria-label, Enter/Space solos, modifiers still add to the pin set), the My Department agent row (tabindex + delegated keydown on the persistent tbody), `tr.qcd-expandable` on Insights Queue health AND the all-dept QCD report (tabindex + `aria-expanded` in markup, delegated keydown, real buttons inside excluded), and the QCD carousel dots (role+tabindex+aria-label). Table rows deliberately get NO `role="button"` — it would override the implicit row role and break table semantics. Focus-ring rules added to styles.html for all four newly-focusable selectors.

TEST RESULTS: passed. `npm run ci` → 486/486 unit tests (was 473; +13 new: 3 for F1's config-fed recognition, 6 for F2's delete/no-delete/unreachable arms across both writers, 4 for F12's ordering + all-steps-attempted + aggregated throw + unreachable-still-continues), INV-16 duplicated-file guard clean, cache-version-sync clean. `script.html` extracted and `node --check`ed (syntax OK). F13 verified BEHAVIOURALLY in real Chromium via the new `drive-f13.js`: 13/13 keyboard checks (focusability, Enter/Space activation, focus outline present, Space does not scroll, aria-expanded round-trip, zero console errors).
Regression Scenarios: NOT EXECUTED — every overlapping scenario (S1/S2/S4/S6/S23/S24/S25/S30/S32/S35/S37/S38 for the dashboard; S28/S33/S34/S38 for CDR Import) requires the deployed web app plus a live spreadsheet/Neon, neither available in this environment. The UI harness did render Overview + My Department (agent table, missed section, QCD side card) + Insights from REAL server payloads with zero console errors, which covers the client-render half of S1/S23/S37 only.

REGRESSION RISKS:
- F1 is additive-only by construction (the regex arm still returns true on its own), so no name recognized before can stop being recognized. The new behavior only fires when a `Dept Config` sheet is reachable AND lists a name; unreachable/absent = byte-identical to before. Residual: a queue name mistakenly listed in Dept Config now counts as a queue at capture time (admin-authored, validated on save, and it only affects classification of that name).
- F2's delete could destroy good rows IF a source grid full of legs ever parses to zero records for a reason OTHER than "no such calls" (e.g. a future Raw Data column-layout change). That is the deliberate trade the non-empty-source gate narrows; a layout change would be a global, same-day, Pipeline-Health-visible failure, and it follows the existing P-5 precedent for the Direct writer.
- F12 changes the ORDER of the five per-date mirrors. They are independent per date and each is idempotent (`ON CONFLICT`), so order is not load-bearing; the aggregate throw preserves the caller's queue/attempt behavior exactly. A date that hard-errors now does MORE work per attempt (all five steps) — bounded by the same retry cap.
- F3 changes what the band tile / nav badge COUNT (by design). An escalation between 48–72 h old on its 3rd calendar day now counts as overdue where it previously did not — this is the fix, and it makes the count agree with the ⚑ badge that was always shown.
- F13 adds `tabindex="0"` to table rows, which lengthens the Tab order through the agent table (one stop per row). This is the standard cost of a focusable row and matches the already-focusable sort headers; no existing handler changed behavior. `role="button"` was deliberately withheld from rows to avoid breaking table semantics.
- No interface, return type, or default value changed for any existing caller. The writers' return objects only GAINED optional fields (`cleared`, `unreachable`); `neonMirrorDate_`'s signature and true/false contract are unchanged.

INVARIANTS AT RISK: None violated.
- INV-16 (byte-identical duplicated files): not at risk — `inboundCalls.js`, `outboundCalls.js` and `NeonMirror.js` are cdr-import-only, not part of either duplicated pair. Guard re-run and clean.
- INV-54 (Dept Config): F1 adds a READER of two existing columns; no schema change, no new column, no write. The sheet-absent path falls through to constant/pattern behavior, preserving the invariant's regression-safety guarantee.
- INV-55 (Escalations): F3 touches only the two read-only aggregate COUNTS; no status transition, gate, write path, or activity-trail behavior changed.
- INV-44 (Pipeline Health): F12 emits the same `neonMirror:<type>` rows with the same statuses — it can now emit MORE of them for one date (previously-skipped steps log their own outcome), which is the intent.
- INV-30 (cache versions): no cached payload SHAPE changed, so no version bump is required; cache-version-sync test passes.
- INV-01: no new public write path (F1/F2/F12 are pipeline-internal; F3 is read-only).

NET SCORE: 5 production fixes − 0 new failure modes = 5
(F1 High, F2 Medium, F12 Medium, F3 Low-Medium, F13 Medium. F1/F2/F12 all fire silently and, in F1's and F12's case, irrecoverably past the ~14-day source retention — F1 is a documented recurrence of IMP-1, which already cost real data once.)

OPERATOR ACTIONS / DEPLOY:
- Run the F1 exposure probe against Neon. NOTE: an earlier version of this action proposed `SELECT count(*) ... WHERE entry_queue IS NULL AND disposition='abandoned'` and claimed a non-trivial count proves F1 fired. That is WRONG and the count was measured at 9353 — `entry_queue IS NULL` on an abandon has three causes and only one is F1: `abandon_stage='direct'` (caller dialed a DID, no queue — legitimate), `abandon_stage='ivr'` where the caller genuinely gave up in the auto-attendant (legitimate; the documented `abandonedIvr` bucket, already observed at ~25% of calls per R5), and `abandon_stage='ivr'` where the call DID enter a queue whose name went unrecognized (the F1 victim — it lands in 'ivr' because an unrecognized queue leg carries no Departments value, R5's own discriminator). `abandon_stage='queue'` implies entry_queue is non-NULL, so all 9353 are direct-or-ivr. The DISCRIMINATING probe is the journey leg-name histogram, since the journey stores raw leg names even when entry_queue is NULL: `SELECT ev->>'kind', ev->>'name', count(DISTINCT c.call_id), max(c.call_date) FROM inbound_calls c CROSS JOIN LATERAL jsonb_array_elements(c.journey::jsonb) ev WHERE c.disposition='abandoned' AND c.entry_queue IS NULL AND c.abandon_stage='ivr' AND c.journey LIKE '[%' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40;` — any REAL queue name in that output is an F1 victim (menu/IVR prompt names are not). Remedy needs no code: add the raw name to that dept's Dept Config "Inbound queue aliases". Rows predating the journey extension carry journey=NULL and cannot be diagnosed this way. | BLOCKS DEPLOY: N
- If that probe shows a gap, add the offending raw queue name(s) to the dept's Dept Config "Inbound queue aliases" field — with this change, recognition then picks them up on the next import with no redeploy. | BLOCKS DEPLOY: N
- No new Script Property, OAuth scope, sheet, or migration. `setup()` does NOT need re-running. | BLOCKS DEPLOY: N
Deploy:
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F7 (not in scope): the UI harness still isn't in `npm run ci`/CI. This session used it and it caught nothing regressive, but it also proved its value again — it is the only thing that can verify client behavior.
- `tools/ui-harness/README.md` documents a STALE Chromium path (`/opt/pw-browsers/chromium`); the real binary is `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Every driver's default `executablePath` has the same stale value.
- `gen-payloads.js` dumps no `qcdAll` payload, so the all-departments QCD modal cannot be exercised in the harness; F13's fix there is verified only via the Insights Queue-health table (same markup + same shared helper).
- F6 (not in scope, downgraded to Low after measurement): the Overview `cache.put` failure is still log-only. Cheap improvement: log the serialized length and warn past ~80 KB.
- F10 (not in scope): the escalations nav badge is fetched once per page load and can only be ADDED, never updated or removed (`!tab.querySelector('.nav-count-badge')`), so it goes stale within a session.
- F8 (not in scope): CLAUDE.md is 357 KB / 3,580 lines with Common Gotchas at 1,982 lines; `.cycle/STATE.md` is now 278 KB.
- The `escalation_activity`/`escalations` tables are DDL-created from a read endpoint (`escEnsureTable_` inside `getEscalations`). Harmless, but a read path performing DDL is worth knowing about.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md, inbound-capture bullet: the sentence "An extreme date-goes-to-ZERO-inbound re-import is still the one corner it can't clear -- an empty payload carries no date to delete" is now WRONG on both counts (F2 clears it, and `expectedDateIso` always carried the date). Same correction applies to the outbound bullet's inherited claim.
- CLAUDE.md, inbound-capture bullet: document that queue-name recognition is now Dept Config-fed (F1), and that adding a non-`A_Q_*` queue is a Dept Config edit rather than a code change.
- CLAUDE.md, Operator State #22 (deferred mirror): note the F12 ordering (Inbound/Outbound first) and that a hard error no longer skips the remaining types.
- CLAUDE.md, INV-54: note that the Inbound Queue Aliases + QCD Queues columns are now ALSO read by cdr-import at capture time (a second cross-project consumer, extending the INV-46 soft-coupling note).
- CLAUDE.md, INV-55 / the escalations bullet: overdue is calendar-days on BOTH sides now, via `ESC_OVERDUE_DAYS`/`ESC_OVERDUE_SQL_`.
- Regression Scenarios: promote the S39 keyboard walk from the /broad-scan Stage-3 OPERATOR VISUAL CHECKS into the config, now that it has an automated counterpart (`drive-f13.js`).
- docs/fix-history.md: entries for F1, F2, F3, F12, F13 (incl. the retracted/corrected Stage-1 claims: F6's measurement, the PHI-leak retraction, the sub-queue-chip error).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
