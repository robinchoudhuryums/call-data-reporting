---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: **R45** — the follow-on opened by block 180: move the all-history dept queue-ext derivation off the per-request path with a CacheService entry anchored on `reportFreshnessTag_()`.

Files modified: apps-script/department-dashboard/Data.gs, tests/unit/dqe-span-readers.test.js, tests/unit/cache-version-sync.test.js, docs/invariants.md, CLAUDE.md

CHANGES:
R45 | Data.gs::deptQueueExtsFromSheet_ | Cross-request cache of the DERIVED ext set under `deptExts:v1:<dept>:<freshnessTag>:<rosterHash>`, TTL `REPORT_CACHE_TTL_SECONDS`. Cache get/put both try/caught — a cache failure degrades to a plain read.
R45 | Data.gs::deptQueueExtsForNeonReader_ | Its sheet fallback now delegates to `deptQueueExtsFromSheet_`, so the Neon path's fallback shares the same cached derivation instead of duplicating it.
R45 | cache-version-sync.test.js | `deptExts` registered in SPECS + classified `'tag'` in ANCHOR_SPECS (the S2 sweep caught the unregistered prefix immediately, which is what it is for).
R45 | docs/invariants.md (INV-30), CLAUDE.md | The prefix, its two key inputs, and the inherited tier limitation.

**WHAT IS CACHED, AND WHY NOT THE OBVIOUS THING.** The grid is ~128k cells — far past CacheService's ~100 KB per-value cap, so the grid is not a cacheable unit at all. What is cached is the derived SET: a few dozen short extension strings per dept. Checked before designing, not after.

**THE KEY HAS TWO INPUTS BECAUSE THE VALUE DOES.** `getDeptQueueExts_`'s derived path depends on (1) the all-history grid and (2) the dept ROSTER. Only the first is covered by the freshness tag: editing `DO NOT EDIT!` or using the Orphan Fix add-to-roster flow does NOT move the latest DQE date, so a tag-only key would serve the previous ext set — and a stale ext set changes which agents count as floaters (INV-53), which is a wrong number rather than an error. The key therefore also carries `hashAgents_` over the roster names (the existing INV-36 helper).

The OVERRIDE path returns before the cache lookup, so a Dept Config override added later takes effect on the next request and one removed later falls through to a derived value that never depended on it.

TEST RESULTS: passed. `npm run ci` 1271 pass / 0 fail; INV-16 guard clean. `npm run ci:ui` skips (playwright not installed locally).

Six new pins, all mutation-tested:
| mutation | pin that fired |
|---|---|
| roster hash dropped from the key | roster-change bust |
| freshness tag dropped from the key | tag-in-key |
| cached set returned by reference | two-hits isolation |
| override checked AFTER the cache | override-precedence |
| the get try/catch removed | throwing-cache tolerance |
| cache put dropped | tag-in-key (warm path) |

**THREE OF MY FIRST-DRAFT PINS DID NOT FIRE, and each was the test's fault, not the code's** — recorded because it is the recurring failure mode of this kind of work: the freshness-tag test drove the tag through fixtures, but `install()` clears the shared cache and `reportFreshnessTag_` reads through the `latestDate` cache, so it could not isolate the key (rewritten to stub the tag directly); the isolation test mutated a cache MISS result, never exercising the hit path where sharing could happen (rewritten to use two hits); and the throwing-cache mutation was equivalent to the original along the tested path (re-targeted at removing the guard). A pin that cannot fail is worse than no pin.

REGRESSION RISKS:
- **Staleness is the whole risk surface**, and it is enumerated above: grid → tag, roster → hash, override → precedence. The one uncovered case is a force re-import that REWRITES an existing date's extensions without moving the latest date; it lags up to the TTL. That is the documented, pre-existing tradeoff of this entire 6h tier (CLAUDE.md's CacheService decision already states it for `summary`/`missed`/`insights`), not something R45 introduces.
- Each caller gets a freshly rebuilt set object, so a cache hit is never a shared mutable — pinned (the R40 clone lesson applied preemptively).
- Key length: `deptExts:v1:<dept>:<yyyy-mm-dd>:<32-hex>` is far under the 250-char cap (INV-36).
- Layering is intact: R44's per-execution grid memo still serves repeats within one request on a cache MISS; R45 removes the read from most requests entirely.
- No aggregation rule changed, so no other prefix needed a version bump.

INVARIANTS AT RISK: None.
- INV-53 is the one this could have broken; the roster-hash pin exists specifically for it.
- INV-30 satisfied both ways — the prefix is registered in SPECS (S2) and classified `tag` in ANCHOR_SPECS (S3), and Data.gs genuinely calls `reportFreshnessTag_()`.
- INV-36 — the roster goes through `hashAgents_`, never raw into the key.
- INV-01 — `_`-suffixed, RPC-unreachable; no write path.

NET SCORE: 1 production fix − 0 new failure modes = 1
(a) YES — this is on the live 53s request the owner reported; the ext read was ~8s of it and is now absent from most requests. (b) NO — the only new state is a cache entry whose every input is in its key, pinned.

OPERATOR ACTIONS / DEPLOY:
- None. No Script Properties, triggers or migrations. | BLOCKS DEPLOY: N
- After deploy the SECOND load of a dept (and every load for the next 6h) should show no cols-A..D read; the `[dqe-read] computeSummary_:*` lines are where to see it. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `clasp push -f` from repo root, then Manage deployments → New version (or `scripts/deploy.sh .`).

REGRESSION SCENARIOS: NOT RUN (manual, needs a live deploy). **S6, S35, S13** remain the priority — they exercise the floater/ext derivation, which is exactly what this caches. Worth one deliberate check the unit tests cannot do: add an agent to a dept roster mid-day and confirm the floater/Source-chip view reflects it on the next load rather than after the TTL.

FOLLOW-ON ITEMS:
- `getDeptQueueExts_` reads only cols C and D but is handed A..D because it indexes from col A. On a cache MISS that is still 2× the cells needed; an offset parameter would halve it. (Carried over from block 180; less urgent now that most requests skip the read.)
- The CLAUDE.md span bullet remains at ~4026/4096 bytes carrying R25b/R26b/R40/R41/R42/R44. R45 was deliberately documented in the CacheService decision block instead, but the next span-related addition still trips the ratchet and the honest fix is moving incident detail to `docs/fix-history.md`.
- The remaining per-request cost after R44+R45 is the date-column read (~7.4s, once) and the QCD grid (~7.7s, already once). The date column is the same shape as this one — dept-independent, changes only on ingest — so the same treatment would apply if it is still the visible floor after deploy.

DOCUMENTATION UPDATES NEEDED: None outstanding — INV-30 (the prefix, its two inputs, the tier limitation) and CLAUDE.md's CacheService decision were updated in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
