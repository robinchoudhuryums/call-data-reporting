---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R29 | Email family restyle: EmailKit v2 (dark header band + accent stripe + glyph, status tiles, numbered steps, severity-toned notices) for the welcome email and every plain-text admin notice, per the approved v2 mock
Files modified: apps-script/department-dashboard/EmailKit.gs, Config.gs, Auth.gs, Alerts.gs, Digest.gs, DqeSilenceWatch.gs, Escalations.gs, IngestWatchdog.gs, PipelineWatch.gs, QueueReportEmail.gs, SystemHealth.gs, SmokeCheck.gs, Coaching.gs, NeonCoverage.gs, SheetCoverage.gs, NeonRetention.gs; tests/unit/email-kit-v2.test.js (new), tests/README.md; CLAUDE.md, docs/operator-state.md

CHANGES:
R29 | EmailKit.gs | v2 additions: ekBandRowsHtml_ (stripe + dark band + glyph badge, four tones), ekTilesHtml_ (≤4 tinted status tiles), ekStepsHtml_ (numbered chips), ekListHtml_, ekMonoHtml_ (escaped, capped), ekSectionTitle_, ekDashUrl_, and ekNoticeHtml_ (one spec → intro/tiles/callout/list/steps/mono/outro + CTAs). ekShellHtml_ gains `band`, a second text CTA and the CALL DATA wordmark; callers without `band` render byte-identically (pinned).
R29 | Config.gs | sendAppEmail_ renders a `notice:` spec into htmlBody via ekNoticeHtml_ when the kit is loaded (production's shared scope always is), drops the spec either way, and sends the plain body if the render throws. New appEsc_ / appDashUrl_ helpers so sender files need no Util/EmailKit dependency.
R29 | Auth.gs | acWelcomeEmailHtml_ rebuilt on the banded shell: tiles (departments / role / access live), "Getting started" steps, access-denied callout, primary + "Read the quick guide" CTAs; agent variant. Sign-in notice gets a warn/neutral notice with grant steps.
R29 | 13 plain-text senders (Alerts, Digest ×2, DqeSilenceWatch, Escalations ping, IngestWatchdog, PipelineWatch, QueueReportEmail ×3, SystemHealth client issue, SmokeCheck, Coaching) | each passes a `notice:` spec beside its unchanged `body`; SmokeCheck moved from the positional to the object signature.
R29 | NeonCoverage / SheetCoverage / NeonRetention | the three bare-<p> HTML notices moved onto the same spec (SheetCoverage + NeonRetention now also carry a plain body).

TEST RESULTS: passed — node --test 1198/1198 (6 new in email-kit-v2: shell parity without band, band/CTA2/wordmark, tiles/steps/list/mono shapes, notice section order + tone, the render hook incl. no-kit and throw paths, a real sender end-to-end, and the SWEEP that every `body:` sender carries `notice:` or htmlBody). No client / pipeline / INV-16 file touched, so the rendered-UI gate and the duplicate-file guard were not re-run.
REGRESSION RISKS: (1) Suites that load a sender file without EmailKit.gs now send the plain body only — by design (typeof guard); the sweep + the ingest end-to-end test cover the styled path. (2) sendAppEmail_ now mutates a copy, not the caller's object — it already did (R28). (3) Report emails (IR/Insights/Dept summary/Digest/Escalation notify) keep the light header: `band` is opt-in. (4) Mail clients that strip HTML fall back to the unchanged plain body.
INVARIANTS AT RISK: None (INV-31 unchanged — same send scope; INV-01 untouched — no sheet writes added).
NET SCORE: 0 − 0 = 0 (a presentation change; the only production-facing behavior added is the HTML alternative on emails that already went out)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (or `clasp push -f` + new version)

FOLLOW-ON ITEMS:
- The report emails (Individual / Insights / My Department summary, the manager digest, the escalation notify) still use the light header; adopting `band: {tone:'neutral'}` there is a one-line change per caller if the family should be uniform.
- The Daily Call Queue Report email keeps its own pinned local shell (queue-report.test.js); left alone on purpose.
- cdr-import / cdr-report failure emails (notifyNeonWriteFailure, notifyDqeBuildFailure_, emailDailyReport.js) are plain text and outside the dashboard project; they go to admins only.

DOCUMENTATION UPDATES NEEDED:
- Done in this commit: CLAUDE.md R28 bullet extended with the `notice:` rule + enforcement; Operator State #58 describes the styled family; tests/README lists email-kit-v2.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
