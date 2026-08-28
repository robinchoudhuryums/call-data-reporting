---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-08-28 property-store consolidation ask — owner-approved package)
- PROP-1 — `Config.gs::PROP_REGISTRY_`: every dashboard Script Property classified operator / engine / tool (exact map + prefix map for `ESC_SNAPSHOT_*` / `DIGEST_RUN_MARKER_*` / `DIGEST_LAST_RESULT_*`; secret set `NEON_PASS`/`HMAC_SECRET`) + the `propRegistryGroup_` classifier
- PROP-2 — Health page "All Script Properties (inventory)" section (folded, the 'users' precedent): summary counts + per-group key-name rows + a warn row per UNRECOGNIZED stored key (retired leftovers, manual one-offs, operator typos of real keys). Property VALUES never reach the payload — pinned with a planted secret sentinel
- PROP-3 — self-cleaning diagnostic-tool params: `clearToolParamsAfterCleanRun_` (Util.gs) clears each tool's window props on its CLEAN verdict only — runDqeParityCheck / runQcdParityCheck (`clean:true`, in the WRAPPERS so a hypothetical scheduled `compare*Sources_` caller keeps its stored range), runInboundQcdParityCheck (zero unattributed queues; the noQueue bucket is informational and does not block), runOutboundVettingCheck (the PASS verdict). MISMATCH / INCONCLUSIVE / FAILED keep the params so the documented fix-and-re-run loops re-compare the SAME window. All four call sites typeof-guarded
- PROP-4 — enforcement: `tests/unit/prop-registry.test.js` sweeps every getProperty/setProperty/deleteProperty literal, resolvable constant (`var X = 'KEY'`), and composed `'PREFIX' +` key in the dashboard .gs files — unregistered key fails CI (forward) and dead registry entry fails CI (reverse); the cache-version-sync S2 pattern applied to the property store

SKIPPED by owner decision (assessed, poor ROI / functional risk): merging operator config keys into JSON blobs (concurrent-writer hazard + breaks Operator State citations); the `*_LAST`+`*_LAST_RESULT` pair-merge (~11 engines + Health classifiers + a dozen suites for a cosmetic gain).

Files modified: department-dashboard/{Config.gs, Util.gs, SystemHealth.gs, NeonRead.gs, QCDReport.gs, InboundReport.gs, OutboundReport.gs, script-9-inbound-direct.html}, tests/harness/shim.js (getProperties on the PropertiesService fake), tests/unit/{prop-registry.test.js (new), system-health.test.js, inbound-qcd-parity.test.js, outbound-report.test.js}, CLAUDE.md (new registry bullet + Operator State scope-note pointer), docs/fix-history.md

CHANGES:
PROP-1 | Config.gs | PROP_REGISTRY_ (frozen) + propRegistryGroup_
PROP-2 | SystemHealth.gs, script-9-inbound-direct.html | inventory rows after the config section; client section title + folded-by-default
PROP-3 | Util.gs + the four tool files | clearToolParamsAfterCleanRun_ + clean-path call sites (typeof-guarded)
PROP-4 | tests/unit/prop-registry.test.js | two-way sweep + classifier + secrets + wrapper-cleanup pins

TEST RESULTS: 969/969 pass (+9: 6 prop-registry, 1 system-health inventory/secret pin, 1 inbound clean-run cleanup, 1 outbound PASS-clears/non-clean-keeps). INV-16 guard green (no duplicated files touched). CLAUDE.md governance tests green (size + per-bullet ratchet). script-9 changed → the blocking ui-harness CI job re-covers the client (local ci:ui skips, playwright absent).
REGRESSION RISKS: (1) On the first live Health load, genuinely-stale stored keys will render warn rows and raise the "items need attention" count — that is the janitor signal working, not a defect; each row's hint says verify-then-delete or register. (2) After a CLEAN parity/vetting run the window props are gone, so a LATER re-run of the same tool falls back to its default window (DQE/QCD defaults age out → INCONCLUSIVE until re-set) — disclosed in the tool log line + the Health tool-params row hint. (3) The inventory is try/catch-wrapped; a probe failure costs the section, never the page.
INVARIANTS AT RISK: None — no new public functions (the inventory rides admin-gated getSystemHealth; the tools were already admin-gated); property writes are not spreadsheet writes (INV-01 untouched); no aggregation or cache-key changes (INV-30 untouched); PROP_REGISTRY_ is frozen read-only data.
NET SCORE: 1 − 0 = 1 (the >50-cap opacity bit the owner THIS WEEK; the inventory + registry answer it durably; self-cleaning params are latent housekeeping; no behavior changed on any manager-facing surface).

OPERATOR ACTIONS / DEPLOY:
- After deploying, open Admin ▾ → Health and expand "All Script Properties (inventory)": review any UNRECOGNIZED warn rows — delete true leftovers in the editor (PropertiesService...deleteProperty), or register a deliberate manual key in Config.gs PROP_REGISTRY_. | BLOCKS DEPLOY: N
- Note for future parity/vetting rounds: a CLEAN run now clears that tool's window props — set them again before any later run (the execution log says so when it happens). | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` + New version (or `scripts/deploy.sh .`)

FOLLOW-ON ITEMS:
- The sibling projects (cdr-import / cdr-report) have their own property stores with no registry; the same pattern could be applied there if their stores grow past legibility (currently much smaller).
- The `*_LAST`+`*_LAST_RESULT` pair-merge remains available if the key count itself ever becomes a problem (it is not one today — the store's real limits are 500KB total / 9KB per value).
DOCUMENTATION UPDATES NEEDED:
- None further — CLAUDE.md (registry bullet + scope-note pointer) and docs/fix-history.md (2026-08-28 entry) updated in this increment.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
