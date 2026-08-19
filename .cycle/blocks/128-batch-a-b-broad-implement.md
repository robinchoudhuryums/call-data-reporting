---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Batch A | Deploy + verify — OPERATOR ACTIONS, done by the owner (no code this session)
- B1 (F10) | runNeonMirror_ had no runtime budget and wedged silently past the ~6-min ceiling
- B2 (F3)  | inbound insurer-drill + heatmap cache keys lacked the reportFreshnessTag_ anchor
- B3 (F4)  | notifyLoginEvent_ emailed on EVERY visit for new addresses once the store filled
- B4       | MailApp daily quota — the other shared exhaustible resource — was unmeasured
- B5 (F3/F3b) | agentHome blobs lacked the freshness anchor; agentHome/agentHist were absent
              from cache-version-sync's SPECS (documented but unenforced)

Files modified:
- apps-script/cdr-import/NeonMirror.js
- apps-script/department-dashboard/Auth.gs
- apps-script/department-dashboard/AgentHome.gs
- apps-script/department-dashboard/InboundReport.gs
- apps-script/department-dashboard/SystemHealth.gs
- tests/harness/fakeSheet.js
- tests/harness/shim.js
- tests/unit/neon-mirror-tail.test.js
- tests/unit/login-notify.test.js
- tests/unit/system-health.test.js
- tests/unit/cache-version-sync.test.js

CHANGES:

B1 | apps-script/cdr-import/NeonMirror.js | `runNeonMirror_` iterated EVERY queued date with no
clock check. Each date runs five mirrors, each a bounded tail scan plus a JDBC connect carrying a
5s probe timeout. Dates stay queued by design while Neon is unreachable, so a multi-day outage grew
the queue — and once one full pass exceeded Apps Script's ~6-minute ceiling the run was killed at
the same point every time and the drain could NEVER complete again. Silent in two separate ways:
the queue rewrite sits at the BOTTOM of the loop (so a timeout preserved the queue but emitted no
summary), and the IMP-6 attempt counter increments only on a THROW, so a timeout never counted an
attempt, never tripped the retry cap, and never sent the gave-up email. Nothing anywhere said "I ran
out of time". Added `NEON_MIRROR_BUDGET_MS` (default 4 min, Script-Property-tunable; the shape
CacheWarm.gs's INSIGHTS_WARM_BUDGET_MS already uses), converted the `forEach` to an indexed loop that
can stop, left untried dates queued with attempts UNCHANGED (they were not tried, so penalizing them
would walk them toward the gave-up drop without ever having failed), and log a `neonMirror:budget`
row — status `success`, because nothing failed — naming what was left and what makes it actionable
(the same row run after run with the count not falling).

B2/B5 | InboundReport.gs, AgentHome.gs | Four 6 h keys joined the freshness anchor: the
`inbound:v9:daily:` insurer drill, `inboundHeatmap:v3`, and both `agentHome:v1` blobs (team + me,
via their shared `tag`). The insurer drill is the one that actually bit — it hangs off a byInsurer
ROW whose key DOES carry the tag, so a same-day re-import refreshed the row and left the drill
behind it disagreeing for the TTL. agentHome's exposure is narrower (presets anchor to the latest
date, so from/to usually self-bust) but a custom window or an in-place date rebuild moves neither.
**No INV-30 bump:** a key SUFFIX is not an aggregation-rule change — the CORE-3 / S2-0 precedent,
and the same reasoning R24 used when it added the tag (its bumps were for the INV-28 prior-window
redefinition, not for the tag). The three InboundReport callsites are `typeof`-guarded to match
`overviewCacheKey_`, which already guards this exact function with the same `'na'` fallback that
`reportFreshnessTag_` itself returns on any internal failure.

B5 | tests/unit/cache-version-sync.test.js | `agentHome` / `agentHist` were added to
docs/invariants.md's INV-30 list in increment 116 but never to this suite's SPECS — documented and
unenforced, the one combination the suite exists to prevent. Both now tracked (agentHome via its
named constant, agentHist via its inline literal).

B3 | apps-script/department-dashboard/Auth.gs | A full `LOGIN_NOTIFY_SEEN` store notified WITHOUT
recording, on the reasoning that extra emails beat silent blindness. But "don't record" means the
same address is a first sighting again on its very next visit, so the branch emailed on EVERY page
view, forever, for every address past the cap. MailApp's daily quota is shared with alerts, digests
and the queue report — so the extra signal was paid for by the channel that carries the real signal,
the exact failure mode it was trying to avoid, one level down. `loginNotifyDecide_` now evicts the
OLDEST entry (JS preserves string-key insertion order) and records the new address: bounded store,
exactly one email per address, change-detection preserved for known users. Returns `evicted` so the
behavior is assertable. Accepted trade-off, documented in place: a long-dormant address evicted by
churn re-notifies once as a "first sighting" — one duplicate per eviction cycle, not one per view.

B4 | apps-script/department-dashboard/SystemHealth.gs | New "Email quota remaining today" row from
`MailApp.getRemainingDailyQuota()`. Same reasoning as the F5 Neon gauge: one shared exhaustible
resource sits behind alerts, digests, the Daily Call Queue Report, pipeline-failure notices,
sign-in notifications and the client-error beacon, and running it dry stops sends with nothing
surfaced to anyone. Warn floor is ABSOLUTE (`MAIL_QUOTA_WARN_FLOOR_` = 50), not a percentage,
because the quota is plan-dependent (~100/day consumer, ~1500 Workspace) and the app cannot read
which plan it is on — below ~50 the alert channel is at risk on either. Placed in the R21 FAST part
(no connection opened); the fast+neon key-set pin still passes.

HARNESS | tests/harness/fakeSheet.js, tests/harness/shim.js | `Range.clearContent` was MISSING from
the fake sheet, so the mirror's queue rewrite (clearContent-then-setValues) could not be driven and
a shrinking queue was untestable. Added as a real implementation, not a no-op — the F-6 discipline
says model the method, never stub it away, and a no-op here would have left drained dates in the
fixture and made the B1 tests pass vacuously. `MailApp.getRemainingDailyQuota` added to the shim
(returns 1500; tests drive the low branch via `state.mailQuota`).

TEST RESULTS: PASSED — 779/779 (was 773; +6). INV-16 guard green. All five modified sources pass
`node --check`. `npm run ci:ui` skips locally (playwright absent, by design) and runs in CI — NO
client file changed this session, so the rendered-UI gate has nothing new to cover, but it still
runs on the PR.

One test failed mid-session and was fixed, not worked around: `inbound-window-scope.test.js` hit
`reportFreshnessTag_ is not defined` because that suite loads a subset of files. Resolved by
guarding the callsites (the file's own convention, per `overviewCacheKey_`) rather than by loosening
the suite.

Manual Regression Scenarios: NOT walked (headless, no deployed build). No client surface changed, so
none of S1–S43 covers a behavior change here; the four server behaviors are covered by the new pins.

REGRESSION RISKS:
- B1 changes drain SHAPE, not per-date behavior: with a queue that fits the budget (the normal case,
  and the default is 4 of ~6 minutes) the loop is byte-equivalent to the `forEach` it replaced.
  Pinned by "a generous budget drains everything".
- B1's budget row is status `success`. Deliberate — the System Health classifier flags a step whose
  LATEST outcome is `failure`, and a routine backlog draining a few dates per run is not a failure.
  Marking it `failure` would make the Health page cry wolf on normal catch-up.
- B2/B5 mint new cache keys on deploy, so the first request per key recomputes. One cold pass.
- B3 changes what a full store does. The store is 300 keys against a <20-user install, so the branch
  is not reachable in normal operation; when it is, one duplicate email per eviction replaces an
  unbounded stream.
- B4 adds one `getRemainingDailyQuota()` call per Health page load (a metadata read, no send).
- fakeSheet.clearContent is a shared harness change: additive (a method that did not exist), so no
  existing fixture can have depended on its absence. Full suite confirms.

INVARIANTS AT RISK: None.
- INV-30: no version bumped and none needed — suffixes only (CORE-3 / S2-0 precedent). The
  cache-version-sync suite now covers two MORE prefixes than before.
- INV-01: B3 writes a Script Property (unchanged from before); B4 reads quota metadata; no new
  spreadsheet write and no new public function.
- INV-44: B1 adds a `neonMirror:budget` step name to the Pipeline Health vocabulary — additive,
  alongside the existing `neonMirror:*` family.
- R21 fast/neon split: the new quota row is a metadata read in the fast range; pin passes.
- INV-16: no duplicated file touched; guard green.

NET SCORE: 2 production fixes − 0 new failure modes = +2
  (B1 would fire the moment deferred mirror mode is enabled during any multi-day Neon outage — and
  the owner has just come off exactly such an outage. B2's insurer-drill disagreement fires on any
  same-day re-import, which the 4%-era rebuild guidance in increment 121 actively invites. B3 is
  latent at a 300-key cap; B4/B5 are observability and enforcement, counted as neither. No new
  failure mode: every change either bounds something previously unbounded or adds a read-only row.)

OPERATOR ACTIONS / DEPLOY:
- Batch A is DONE (owner, this session): cdr-import + cdr-report + dashboard deployed,
  `runLiveSmoke` all passed, `NEON_EGRESS_BUDGET_MB` set to 5000.
- NOTE on that value: the gauge computes MB as 1024×1024, so 5000 = 5.24 GB decimal. If the Neon
  plan's "5 GB" is decimal (5×10⁹ bytes), the budget is ~4.8% generous and the 80% warn lands
  slightly late. Set 4768 to be exact. Minor — the gauge is a FLOOR either way, so both errors point
  the same (optimistic) direction. | BLOCKS DEPLOY: N
- STILL OPEN from Batch A: walk **S36** (Dept Config validation round-trip) — the one behavior change
  from the previous session that wants a human. | BLOCKS DEPLOY: N
- STILL OPEN from Batch A: confirm the new Health rows render (Neon read volume, Email quota). |
  BLOCKS DEPLOY: N
- **SEP 1, dated:** `backfillInboundCalls` + `backfillOutboundCalls` FIRST, then
  `runNeonCoverageCheck`. Both tables have no sheet primary and rebuild only from `Call_Legs_*`,
  which prunes at ~14 days. | BLOCKS DEPLOY: N
- OPTIONAL: `NEON_MIRROR_BUDGET_MS` to tune B1's budget. Only meaningful when
  `NEON_MIRROR_MODE=deferred`, which is not currently on. | BLOCKS DEPLOY: N

Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → pencil →
  New version (or `scripts/deploy.sh . <dashboard-deployment-id>`)
- CDR Import (NeonMirror.js): `cd apps-script/cdr-import && clasp push -f`
- CDR Reporting Tools: NOT modified this session.

(Not complete in production until the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- `neonAgentExts:v1` (NeonRead.gs) is a 6 h cache with no freshness anchor — found while sweeping for
  B2/B5, deliberately NOT fixed (out of the named scope). It backs `getDeptQueueExts_`'s derived
  all-history path, so a newly-added agent's extensions can take up to 6 h to appear in the IR
  floater group and Diagnostics. Low impact: scope is locked to `roster` on the main surfaces
  (INV-53), so floaters do not render there at all.
- F7 (unchanged): `dashboardCDR.js` + `dataFilters.js` are ~1,700 lines of live, menu-reachable,
  spreadsheet-writing code with zero test coverage. Batch C1.
- F8 (unchanged): `time1Min` is `>60s`, not "~59s". Batch C3.
- The remaining batches C–H are unchanged and listed in block 127.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md cache-tier bullet: the "Not yet true of every 6 h key" clause added by the last
  /sync-docs is now STALE in the good direction — all four named keys carry the tag. Rewrite to
  state the rule plainly, and note `neonAgentExts:v1` as the one remaining exception.
- docs/operator-state.md #22 (deferred Neon mirror): add `NEON_MIRROR_BUDGET_MS` and what a
  repeating `neonMirror:budget` row means.
- docs/operator-state.md #45 (sign-in notifications): the full-store behavior changed from
  "notifies forever, never records" to "evicts oldest, one email per address".
- CLAUDE.md System Health bullet: mention the two new rows (Neon read volume, Email quota).
- docs/invariants.md INV-44: add `neonMirror:budget` to the step vocabulary.
- CLAUDE.md Operator State index #47 is fine as written.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
