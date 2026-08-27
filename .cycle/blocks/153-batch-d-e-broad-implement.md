---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-08-27 broad-scan, Batches D + E)
Batch D — enforcement holes:
- S1 — INV-06 work-window cross-pin: the pipeline's numeric seconds, the dashboard display mirror, and the inbound query strings are now test-equal (cross-file-pins)
- S2 — cache-prefix completeness: SPECS gained the 4 untracked prefixes (overviewChartYtd, presence, orphanFix:init, deptConfig:init) and a sweep test fails on any .gs cache literal not registered
- S3 — freshness-anchor membership: every SPECS prefix carries an anchor classification ('tag' → the file must call reportFreshnessTag_(); exceptions documented per-prefix) — the B1–B5 stale-morning class now needs a deliberate exception entry to recur
- S4 — the B-2 DQE tripwire also matches string-literal sheet opens (the F11 hardening mirrored); SmokeCheck.gs allow-listed with a reason
- S7 — CI's blocking UI gate installs playwright@1.62.1 (pinned; bump deliberately)
- S8 — two prose-only client rules pinned: safeChart_ is the only `new Chart(` callsite, and all 8 tabular writers (csvEscape/exportTableCsv_, ins/inbound/direct/outbound/qcdAll CSVs, the IR copy-as-TSV) route through csvSafeCell_ (html-include-structure)
Batch E — client polish + accessibility:
- P11 — applyDeptColsPref_'s bare localStorage reads (and the two toggle handlers) are try/catch-wrapped — a storage-blocked browser no longer kills init() mid-flight
- P15 — Insights export actions regained busy-state + a double-send guard: insBtnFeedback_ targets the live #dept-export-btn (the #ins-export-btn it fed was retired in R16c, silently no-op'ing it) and insExportBusy_ gates re-entry on email/copy
- I1 — escalations summary-band tiles activate on Enter/Space (delegated keydown mirroring the click; Space no longer scrolls)
- I2 — the call-journey overlay traps focus (stack-aware: it remembers and re-arms a displaced modal's trap — the Inbound heatmap drill opens it OVER a modal — and restores the opener per F-42)
- I3 — the three report Export menus deliver the arrow-key semantics their role="menu" announces, via a shared wireMenuKeys_ (ArrowDown opens+focuses, wrap, Home/End, Escape returns focus); the dept menu's ins-items refresh is shared between click and keyboard open
- I4 — #toast-container is aria-live="polite" and all 20 .status blocks carry role="status" — success/failure feedback reaches assistive tech app-wide
- P23 — the parent-id copy button's clipboard REJECTION falls back to the execCommand path (was: silently swallowed) and flashes ✗ if both fail
- P24 — the consumed-but-undefined CSS tokens are defined as aliases (--ink-muted → --muted, --sans → --ui) at the base token block, fixing Health-hint/escalation-pill contrast and the View-as select's monospace face in both themes
- P27 — the Overview pipeline banner names the real 250-row scan window (LM1), not the pre-widening 40
- P29 — both report runners check the stale-response token BEFORE restoring the Generate button, so a superseded response can't clear a newer request's busy state

Files modified:
- tests/unit/cross-file-pins.test.js, cache-version-sync.test.js, html-include-structure.test.js
- .github/workflows/ci.yml
- apps-script/department-dashboard/: script-1-core.html, script-2-chrome.html, script-3-overview.html, script-5-dept.html, script-6-ir.html, script-8-insights.html, script-10-escalations.html, script-11-qcd-boot.html, dashboard.html, styles.html

CHANGES: (as itemized above; each finding's mechanism is commented at its site with its code)

TEST RESULTS: 957/957 pass (was 952; +5: S1, S2, S3, and the two S8 pins). INV-16 guard green; the assembled-client node --check (html-include-structure) passes on every touched fragment; `npm run ci:ui` skips cleanly locally (playwright absent) — the BLOCKING ui-harness CI job validates the rendered client on the PR, which matters this batch since ten client files changed.
REGRESSION RISKS: I2's stack-aware trap is the subtlest change — it re-arms a displaced modal trap on close and defers opener-focus past the trap's autofocus (FIFO timeouts); drive-smoke/f13 don't cover this surface, so the S44-class manual walk should include one journey-drill open/close from inside the Inbound modal. I3's ArrowDown open path shares the ins-items refresh with click (extracted, not duplicated). P15's busy flag could stick if a handler dies before restore — every handler path calls restore() (verified: success, failure, null-blob, catch). P24 defines tokens previously inherited — the five consuming rules now render muted/sans as their authors intended (visual change, intended).
INVARIANTS AT RISK: None — INV-41/42 untouched (no chart changes); the F-42 focus-return discipline extended, not altered; INV-30 untouched (no key changes); CSP/SRI untouched.
NET SCORE: 4 − 0 = 4 (P11 latent-any-day in Safari-ITP contexts, P15 fires on any double-click today, P23/P29 minor-but-live; the D batch are guards, not production fixes — they're what keeps the other 16 findings' classes from recurring).

OPERATOR ACTIONS / DEPLOY:
- None blocking. Post-deploy visual spot-checks (the S44/S45 operator checks from the scan): Health-page hints + escalation pills read muted in both themes; the View-as dropdown renders sans; Export ▾ menus walk with arrow keys; a journey drill opened from the Inbound heatmap returns focus cleanly on close. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + New version (or `scripts/deploy.sh .`)
- (cdr-import/cdr-report unchanged; ci.yml + tests ship with the repo)

FOLLOW-ON ITEMS:
- S3's file-level anchor check can't see a second un-anchored key added to an already-tagged file (documented in the test comment; reviewers own that corner).
- The remaining scan items are Batch F (owner/strategic): run the vetting tools + un-gate Inbound/Direct/Outbound, execute the Neon cutover runbook, agent-app dark mode (I5), P28 auto-refresh pin persistence (owner call), sibling deploy stamping (S6), P9/P10/P19–P22 small pipeline fixes, and the longer-term single-sourcing of hand-mirrored rules.
- CLAUDE.md headroom (~15KB under the 200KB cap) still warrants a trim pass.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md's cache-tiers bullet says "verify a new key joined the tag by hand" — S3 now partially enforces this; the sentence could name the test (one-line, next doc pass).
- CLAUDE.md's SRI bullet and csvSafeCell_/safeChart_ bullets can each gain "pinned by html-include-structure" one-liners (C2 answers), also next doc pass — kept out of this batch to hold the size line.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
