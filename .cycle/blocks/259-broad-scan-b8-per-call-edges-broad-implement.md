---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F30 A trailing ("late") attempt never consumed a dial, so one-day and prior-window callback OUTCOMES differed from the week's (only the episode counts were pinned)
- F31 The Outbound report email never showed the unmapped-dept flag, the sheet-fallback source, or that callback data was lagging
- F32 The PC-3 callback entitlement checked dates only, so it also admitted a dial placed before the abandon (latent until the 6c release)
- F34 On the Caller Lookup sheet fallback, a missing Inbound Calls tab read as "no inbound calls" (no inboundAvailable flag)
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/OutboundReport.gs
- apps-script/department-dashboard/InboundReport.gs
- apps-script/department-dashboard/CallerLookup.gs
- apps-script/department-dashboard/script-10-escalations.html
- tests/unit/outbound-episodes.test.js, tests/unit/outbound-report.test.js, tests/unit/call-journey-entitlement.test.js, tests/unit/caller-lookup.test.js
- docs/per-call-capture.md (the trailing-edge rule + the PC-3 timing), docs/module-dependencies.md (regenerated: symbol counts)
- .cycle/STATE.md, .cycle/blocks/259-broad-scan-b8-per-call-edges-broad-implement.md

CHANGES:
F30 | OutboundReport.gs | obCallbackEpisodes_: an attempt past ctx.to with no open episode to join now opens a HIDDEN episode (the lookback's treatment on the trailing edge) instead of returning, so its own team's dial is consumed by it rather than falling through as "another team" on the caller's in-window episode; finalize reports only episodes whose first attempt is inside [from, to] (a missing `to` stays unbounded, as the late flag already treated it); docblock + per-call doc updated
F31 | OutboundReport.gs | new obMarkUnmapped_ (the PC-5 flag, now one helper used by the web report AND the email -- the email calls the uncached compute, which never set it) and PURE obEmailCaveats_ (unmapped / sheet fallback + through date / calls loaded through, the client's wording); the email leads with an escaped warn ekCalloutHtml_ "Read this first" when any apply
F32 | InboundReport.gs | outboundJourneyCallbackEntitled_ additionally requires (abandon date + call_start) <= (dial date + call_start) -- same-second counts the dial as after, the engine's rule; the timestamp form is the uncalled-list SQL's; still bound parameters, still fails closed
F34 | CallerLookup.gs, script-10-escalations.html | meta.inboundAvailable (true on the Neon path, !!ib on the sheet fallback); the client says "inbound unavailable" in the title, a note in the results, and an empty-state hint that names outbound only and says the history is incomplete

TEST RESULTS: passed -- 2480 tests (2479 pass, 0 fail, 1 pre-existing skip; +4: the F30 outcome add-up, F31 caveats + flag + wiring, F32 SQL pin via a recording connection (the function had no test), F34 fallback + client wording). lint:gas clean, module-deps regenerated (OutboundReport.gs symbol count only) and up to date, INV-16 guard in sync. ci:ui: all stages passed (Caller Lookup modal driven in drive-admin). Bites: 7/7.
REGRESSION RISKS:
- F30: one-day and prior-window callback outcomes can move from 'other' to the week's verdict ('none' / 'pending') where a caller also abandoned another team just past the window -- the intended correction; the callback prior-window deltas shift with it. Episode COUNTS are unchanged (the hidden episodes are never reported).
- F32: a malformed call_start makes the cast throw, so that one drill refuses (fails closed) -- the uncalled-list SQL already uses the same cast on the same columns.
INVARIANTS AT RISK: None (INV-01 untouched -- no new write; the F32 entitlement only narrows; INV-30 untouched -- the outbound payload's shape is unchanged and the email is not cached).
NET SCORE: 1 − 0 = 1 (production fix: F30; F31 needs an emailed report on a degraded day, F32 is latent until the 6c release, F34 needs a Neon outage plus a missing tab -- counted NO)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Department Dashboard -- `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Caller Lookup's outbound-unavailable note still says "capture isn't live yet (deploy cdr-import ...)" on the sheet fallback too, where the real cause is a missing Outbound Calls tab during a Neon outage -- same wording gap as F34 on the other half.
- Batches 9-10 of the cycle-259 plan remain.

DOCUMENTATION UPDATES NEEDED:
- None beyond docs/per-call-capture.md (updated in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
