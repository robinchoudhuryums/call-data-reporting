---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F1  | Extraction Sidebar (dataFilters.js) drifted from the pipeline's R20 row-40 abandon rule
- F2  | That duplication was unguarded — added an INV-16-style guard + the pin that would have caught F1
- F12 | System Health's pipeline-failure classifier scanned 80 rows and degraded to a FALSE OK
- F11 | Two QCD readers bypass getQcdReadSource_ (the B-2 blindness, QCD dimension) — tripwire + fail-open
- F5  | Neon transfer exhaustion was unmonitored — added a month-to-date read-volume gauge
- F6  | Undeployed merged rounds — OPERATOR ACTION ONLY, no code (see OPERATOR ACTIONS)

Files modified:
- apps-script/cdr-report/dataFilters.js
- apps-script/department-dashboard/SystemHealth.gs
- apps-script/department-dashboard/DeptConfig.gs
- apps-script/department-dashboard/NeonRead.gs
- apps-script/department-dashboard/QCDReport.gs
- apps-script/department-dashboard/Escalations.gs
- apps-script/department-dashboard/InboundReport.gs
- apps-script/department-dashboard/DirectCallReport.gs
- apps-script/department-dashboard/CallerLookup.gs
- apps-script/department-dashboard/script-7-admin.html
- scripts/check-duplicated-files.sh
- tests/unit/cross-file-pins.test.js
- tests/unit/system-health.test.js
- tests/unit/dept-config.test.js

CHANGES:

F1 | apps-script/cdr-report/dataFilters.js | Row-40 (A_Q_Spanish) TOTAL predicates t2/t4 changed from
`waitDec > 0` to `waitDec > time1Min`, matching the R20 owner ruling already applied to autoImport.js's
q40_name block. The sidebar was listing rows the pipeline no longer counts, so an operator reconciling a
Spanish discrepancy was told the pipeline was under-counting — by the tool built to prevent that
conclusion. t2 === t5 and t4 === t6 by design now (mirroring the pipeline's tot2/tot5, tot4/tot6 pairs);
comment says so and says not to collapse them.

F2 | scripts/check-duplicated-files.sh | Added `extract_fn_normalized` / `check_fn_pair_normalized` and
wired the THIRD duplication pair: simulateSplitCol2 + parseDurationDecimal across
cdr-report/dataFilters.js ↔ cdr-import/autoImport.js. dataFilters declares its copies INSIDE a closure
while cdr-import's are top-level, so the existing column-1 anchor could not see them and a byte compare
would fail on indentation alone; the new variant compares code with indentation/blank lines/alignment
whitespace normalized away. Negative-tested (perturbed one copy → exit 1; restored → exit 0).

F2 | tests/unit/cross-file-pins.test.js | Added the "R20 row-40" pin — the primitives guard alone would
NOT have caught F1, because the row RULES are structurally different code in the two files. The pin
brace-matches each file's row-40 block and asserts every `abandoned === "abandoned" && waitDec > X`
threshold token is `time1Min` on both sides. Negative-tested: reintroducing the original `waitDec > 0`
fails the pin with the drift message.

F12 | apps-script/department-dashboard/SystemHealth.gs | readPipelineHealth_(80) → the new
HEALTH_PIPELINE_SCAN_ROWS = 250, matching the Overview banner's post-LM1 value. LM1 was learned at 40 rows
on the banner (a retry storm evicted the DQE row → false WARN, widened to 250); this classifier was left at
80, where the same eviction yields the OPPOSITE and worse outcome — the failing step drops out of
latestByStep entirely and the row renders `ok`, a false ALL-CLEAR on the page CLAUDE.md calls the single
trustworthy pipeline signal. The OK text now states the measured scope ("no step failing in the last 250
entries") plus a hint naming the window, instead of an unqualified all-clear.

F11 | apps-script/department-dashboard/DeptConfig.gs | saveDeptConfig now FAILS OPEN when
scanQcdQueueNames_ returns an empty universe. That helper reads the QCD sheet directly with no
getQcdReadSource_ path, so against a missing/emptied/trimmed sheet (the end state Operator State #30's
cutover describes) or a pre-first-ingest install it returned {} — and the unknown-name filter then matched
EVERY queue name and threw "Unknown QCD queue name(s)…", leaving the admin unable to save a correct
config. A non-empty universe still rejects genuine typos (unchanged); an empty one saves and pushes a
non-blocking warning through the existing `warnings` channel.

F11 | apps-script/department-dashboard/script-7-admin.html | The Dept Config save handler appended a
double-mapping-specific explanation to ALL warnings, which was safe while `warnings` carried one kind of
message. Now conditional on a double-mapping warning actually being present, so the new
validation-skipped warning does not send the operator after a problem they do not have.

F11 | tests/unit/cross-file-pins.test.js | Added the B-2 tripwire in the QCD dimension: no dashboard .gs
may OPEN the QCD sheet without getQcdReadSource_ or a recorded allowlist reason. Detection is the
getSheetByName call, NOT a mention of the sheet name — six files discuss "QCD Historical Data" in prose
while reading through the source-aware readQcdGrid_, and a prose-matching tripwire flags those forever and
gets muted. Allowlist has 3 entries, each with its reason AND its consequence (notably: QueueReportEmail's
deliberate sheet read BLOCKS retiring the QCD sheet — undocumented until now). A second test fails if an
allowlist entry goes stale. Negative-tested with a temporary blind reader.

F11 | tests/unit/dept-config.test.js | Two behavior tests: a typo is still rejected when the universe is
readable; an empty universe saves with a "WITHOUT validation" warning. (sheetSafeCell_ stubbed as the
identity it is for non-formula values — it lives in Util.gs which this suite does not load; its real
CORE-7 behavior is pinned in util.test.js.)

F5 | apps-script/department-dashboard/NeonRead.gs | New month-to-date read-volume gauge:
neonNoteEgress_(bytes) / readNeonEgress_() over one Script Property {m, bytes, reads}, reset on UTC month
rollover, with an optional NEON_EGRESS_BUDGET_MB threshold. INV-01-clean (Script Property only, the
login-notify precedent). Lossy read-modify-write with no lock, deliberately — the presence-map discipline;
serializing every read would cost more than the gauge is worth.

F5 | NeonRead.gs, QCDReport.gs, Escalations.gs, InboundReport.gs, DirectCallReport.gs, CallerLookup.gs |
Metered all 14 bulk json_agg fetch sites (one line each, immediately after the getString). Metering only
the DQE path would have under-reported exactly the Neon-only surfaces that go dark when the cap blows.
The 12 cross-file callsites are `typeof`-guarded per the house convention (also keeps suites that load a
subset of files working).

F5 | apps-script/department-dashboard/SystemHealth.gs | New "Neon read volume (month to date)" row in the
FAST part (property read, no connection — the R21 fast/neon key-set pin still holds). Muted with no
declared budget (the plan's allowance is a billing fact this code cannot discover, and an invented
threshold would either cry wolf or reassure wrongly); ok/warn at 80% once NEON_EGRESS_BUDGET_MB is set.
The hint states it is a FLOOR measured from our side — over budget is proof of a problem, under budget is
NOT proof of headroom.

F5 | tests/unit/system-health.test.js | Six tests: accumulation, stale-month reads as zero, budget→percent,
zero/garbage/corrupt-JSON self-heal, the three row states, and graceful absence when NeonRead.gs is not
loaded.

TEST RESULTS: PASSED — 773/773 (was 761; +12 new). INV-16 guard green. html-include-structure green.
`npm run ci:ui` SKIPS locally (playwright absent, as designed) and will run in CI; script-7-admin.html was
modified, so the rendered-UI gate is the outstanding automated check.
All 10 modified source files pass `node --check`; check-duplicated-files.sh passes `bash -n`.

Manual Regression Scenarios: NOT walked — this session runs headless with no deployed build. The one that
directly covers a behavior change is S36 (Dept Config modal: auto-discovery, validation, override
round-trip) and a human should walk it. S32 / S38 / S40 touch files that received instrumentation only
(no logic change). The Health page has no numbered scenario; it is covered by the new system-health pins.

REGRESSION RISKS:
- F1 is DEPLOY-ORDER COUPLED. cdr-import is currently undeployed (F6), so the LIVE pipeline still runs the
  old >0s row-40 rule and the live sidebar currently AGREES with it. Deploying cdr-report WITHOUT
  cdr-import would make the sidebar lead the pipeline — the same mismatch, inverted. Deploy both.
- F1 forward-only: for dates imported BEFORE the R20 pipeline deploy, the sidebar now under-lists relative
  to the stored QCD cell (those cells keep their >0s-era totals). Same era-mix the R20 operator note
  already documents; matching the pipeline is still strictly better than matching neither.
- F11 relaxes a validation. A genuinely broken QCD sheet now saves unvalidated instead of erroring — but
  the warning says exactly that, and "cannot save a correct config at all" is the worse failure.
- F5 adds one Script Property write per Neon bulk read. Writes are ~10ms against multi-hundred-ms JDBC
  reads, all best-effort/try-caught, so the worst case is a slightly under-counted gauge.
- Nothing changed a cache key, a payload shape, or a return type. saveDeptConfig still returns
  {saved, warnings} with warnings already an array.

INVARIANTS AT RISK: None.
- INV-01: neonNoteEgress_ writes a Script Property, not a spreadsheet — the documented login-notify
  carve-out class. No new public write path; no new public function at all.
- INV-16: the two existing byte-identical pairs are untouched; a third pair was ADDED to the guard.
- INV-30: no cache prefix, key component, or payload shape changed — no bump needed.
- INV-44: only how many Pipeline Health rows are READ changed; the schema and step vocabulary are untouched.
- INV-54: Dept Config row shape and accessor semantics unchanged; only save-time validation of an
  unreadable universe was relaxed.
- R21 fast/neon split: the new Health row is a property read placed in the first fast range; the
  fast+neon == all key-set pin passes.

NET SCORE: 2 production fixes − 1 new failure mode = +1
  (F12 would have fired THIS MONTH — the live Neon incident is generating Pipeline Health rows, and at 80
  rows a morning DQE failure is invisible by the time an admin looks. F1 had not yet fired in production
  because the R20 pipeline change is also undeployed, but was guaranteed to fire on the next cdr-import
  deploy. F2/F11/F5 are preventive or observability, counted as neither. The one new failure mode is F1's
  deploy-order coupling, documented above and in OPERATOR ACTIONS.)

OPERATOR ACTIONS / DEPLOY:
- F6 (pre-existing, unchanged by this session): five merged rounds are still undeployed — live presence,
  R22 (4% abandon standard), R23 (display standards + dark coaching), R24 (workday prior windows), and the
  Neon egress round that is the actual remedy for the live transfer-cap outage. | BLOCKS DEPLOY: N (it IS
  the deploy)
- Deploy cdr-import AND cdr-report TOGETHER, or cdr-import first. Deploying cdr-report alone puts the
  Extraction Sidebar on the R20 rule while the pipeline is still on the old one. | BLOCKS DEPLOY: Y
- OPTIONAL, to arm the F5 gauge's threshold: set the dashboard Script Property NEON_EGRESS_BUDGET_MB to
  the plan's monthly transfer allowance. Unset = the row is informational only and never warns. |
  BLOCKS DEPLOY: N
- The F5 gauge starts at zero on deploy and fills over the month; it will read low until it has a full
  month, and it is a FLOOR by construction. Do not read an early low number as headroom. |
  BLOCKS DEPLOY: N

Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage
  deployments → pencil → Version: New version → Deploy
  (or `scripts/deploy.sh . <dashboard-deployment-id>`)
- CDR Reporting Tools (dataFilters.js): `cd apps-script/cdr-report && clasp push -f`
- CDR Import (NOT modified this session, but see the deploy-order action above):
  `cd apps-script/cdr-import && clasp push -f`

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F10 (found in the audit, NOT in the top 5, not fixed): runNeonMirror_ has no runtime budget. During a
  multi-day Neon outage the queue grows and, once a full drain exceeds Apps Script's ~6-min ceiling, it can
  never complete — and because a timeout is not a throw, the IMP-6 attempt counter never increments and no
  neonMirror:* row explains it. CacheWarm.gs's INSIGHTS_WARM_BUDGET_MS is the pattern to copy. Latent:
  NEON_MIRROR_MODE defaults to inline.
- F3 (not in the top 5): agentHome:v1 team/me and inbound:v9:daily / inboundHeatmap:v3 cache keys lack the
  reportFreshnessTag_ anchor CLAUDE.md declares mandatory for the 6h tier. The inbound insurer drill is the
  one that matters — it can visibly disagree with the freshness-tagged row it expands.
- F3b: agentHome / agentHist are absent from cache-version-sync.test.js's SPECS list.
- F4: notifyLoginEvent_ emails on every visit for new addresses once LOGIN_NOTIFY_SEEN passes 300 keys;
  MailApp quota is shared with alerts and digests.
- F7: dashboardCDR.js (1073 lines, 4 setValues sites) and dataFilters.js are live, menu-reachable, and have
  zero test coverage. F1 hid there.
- F8: `time1Min` is 1/1440 day = exactly 60s with a strict `>`, so the rule is ">60s". The R20 comment and
  the STATE entry both call it "~59s", which is backwards.
- MailApp.getRemainingDailyQuota() would be a one-line Health row on the same reasoning as F5 — deliberately
  left out of scope.
- Noticed but not touched: INV-09 is effectively subsumed by INV-30 (both cover cache versioning).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Common Gotchas: add the THIRD duplication pair (cdr-report/dataFilters.js ↔
  cdr-import/autoImport.js). The INV-16 bullet documents two pairs and directCallMetrics.js carries an
  explicit "NOT a duplicated file" disclaimer, so the absence currently reads as "there is no third pair".
- docs/invariants.md INV-16: same addition (the guard now covers it).
- docs/operator-state.md #30 (QCD read source): record that QueueReportEmail.gs's deliberate sheet read
  BLOCKS retiring the QCD sheet — the cutover framing currently implies the sheet can go.
- docs/operator-state.md: new item (or an extension of #18/#19) for NEON_EGRESS_BUDGET_MB and how to read
  the gauge as a floor.
- CLAUDE.md System Health bullet: note the 250-row scan window and that the OK text is window-scoped.
- CLAUDE.md cache-tier bullet asserts every heavy report key carries reportFreshnessTag_; F3 shows four
  that do not. Either fix them or soften the claim — it is currently stated as a fact about the code.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
