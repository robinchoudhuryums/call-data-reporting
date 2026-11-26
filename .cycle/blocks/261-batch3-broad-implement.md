---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F3 (filed RH-1) — every dashboard reader that aggregates the stored call path (`journey`) now starts its read at, or names, the Neon retention horizon; INV-69 gains a sweep over those readers
- F4 (filed RH-2) — the Inbound report no longer compares a prior window that starts before capture began against a whole one (the Outbound and Direct surfaces already refused that comparison)
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/NeonRetention.gs (neonJourneyHeldFromIso_)
- apps-script/department-dashboard/InboundReport.gs (inboundRetentionNotes_, kpisPrior drop, meta fields, email delta + notes, cache prefix inbound:v18)
- apps-script/department-dashboard/TransferRetries.gs (getTransferRetries clamp)
- apps-script/department-dashboard/PartialDays.gs (getPartialDaySuggestions look-back)
- apps-script/department-dashboard/script-9-inbound-direct.html (inboundDelta_, compare line, inboundRetentionNoteUpsert_, CSV notes)
- apps-script/department-dashboard/script-7-admin.html (Transfer retries summary sentence, partial-day suggestion summary)
- tests/unit/neon-retention.test.js
- docs/invariants.md (INV-69, INV-30), docs/fix-history.md (RH-1, RH-2), docs/module-dependencies.md (regenerated), and the `inbound:v18` token in docs/architecture.md, conventions.md, known-issues.md, operator-state.md, per-call-capture.md

Fix codes: scan F3 / F4 are filed as RH-1 / RH-2 (bare `F#` collides with the Neon family).

CHANGES:
F3 / RH-1 | NeonRetention.gs | `neonJourneyHeldFromIso_(props, nowMs)`: '' until a prune is armed (NEON_RETENTION_ENABLED) or has ever run (NEON_RETENTION_LAST); otherwise UTC today minus the effective journeyDays (the prune's own `CURRENT_DATE - j`, floor 30). Conservative: the weekly prune may leave older journeys in place until its next run, so every message says "may".
F3 / RH-1 | InboundReport.gs | `inboundRetentionNotes_` builds the plain-language notes once; when the read's earliest day (the prior window's start) is before the horizon, `meta.journeyHeldFrom` + a note that the two transfer figures (hung up while on hold, transfers nobody picked up) may be counted the older way before that date. The same notes ride `meta.retentionNotes` to the page (a `.retention-note`), the CSV ("Note" rows) and the email (rows under the exception note).
F3 / RH-1 | TransferRetries.gs + script-7 | When `from` is before the horizon, the read starts at the horizon (`meta.from`), keeping `meta.fromAsked` / `journeyHeldFrom` / `journeyHorizonDays`; a window wholly past it reads nothing and returns an empty summary. The summary adds "Call paths are kept for N days, so dates before X could not be read (you asked from Y)."
F3 / RH-1 | PartialDays.gs + script-7 | The suggestion look-back starts at the horizon when that is later (so a day that kept only its outbound calls is never judged short), `journeyHeldFrom` rides the payload, and the summary line says earlier days are not judged.
F4 / RH-2 | InboundReport.gs + script-9 | When the prior window starts before `coverageStart`, `kpisPrior` is null, `meta.priorBeforeCapture` is set and a "No comparison" note joins `retentionNotes`; the compare line, the email subtitle and both delta helpers (`inboundDelta_`, `inboundEmailDelta_`) draw nothing for an absent prior instead of reading it as 0 (+100%). Cache prefix inbound:v17 -> v18 (INV-30), tokens + both version tables updated.
Tests | neon-retention.test.js | The helper (unarmed, enabled, ran-once, the 30-day floor, the UTC edge); the INV-69 reader sweep (a dashboard file reading the journey must call the helper or OD-5's `journeyPrunedMeta_`, or be allow-listed with its reason: AgentDay, AgentHome, OutboundReport's research probes, the prune); the Inbound notes + the prior drop + both delta guards; Transfer retries through the REAL `getTransferRetries` (clamped read, `fromAsked`, a wholly-past window reads nothing); the suggestion look-back. Bite-checked: disabling the Transfer retries clamp and removing PartialDays' helper call each turn a test red.

TEST RESULTS: passed -- `node --test` (TZ=America/Chicago) 3,211 tests, 3,210 pass, 0 fail, 1 skipped; `check-duplicated-files.sh` clean; `npm run lint:gas` clean; `module-deps.mjs --check` up to date after `--write`; `npm run ci:ui` (CI=true) all stages passed, 18 asserting drivers -- run with the container's pre-installed Playwright 1.63.0 symlinked into the gitignored tools/ui-harness/node_modules (the harness pins 1.62.1) and CHROMIUM_PATH=/opt/pw-browsers/chromium.
Regression scenarios: S38, S69, S73 (Inbound, Transfer retries, partial days) -- NOT APPLICABLE here (they need the live deployment); walk after the dashboard deploy.

REGRESSION RISKS:
- RH-1: the horizon is the CONSERVATIVE edge, so for up to a week after each prune run Transfer retries skips a few days whose journeys are still held, and the Inbound note may appear for days that still read the new rule. Accepted: the alternative was reading cleared rows as "no retries".
- RH-1: on an install where a prune ran once and was then switched off, the horizon keeps moving forward although nothing newer is cleared; the notes then over-warn. Prose-only.
- RH-2: `inboundDelta_` / `inboundEmailDelta_` draw no badge for an absent prior field; every kpisPrior field is a COALESCEd SQL value, so only the dropped-prior case reaches it.
- inbound:v18 misses cold for the first loads after deploy (expected).

INVARIANTS AT RISK:
- INV-69 — extended (the journey-reader rule + sweep), not violated.
- INV-28 — the prior window's definition is unchanged; only whether it is SHOWN.
- INV-30 — inbound bumped; cache-version-sync green.
- INV-62 — no hash or number added to any payload (counts and dates only).
None violated.

REFLECT:
- RH-1: (a) fired this month? NO evidence -- it fires only where `NEON_RETENTION_ENABLED` is on (recommended by #57, not confirmed live). (b) new failure mode? YES (Low) -- the conservative edge hides up to a week of still-held days from Transfer retries after each prune.
- RH-2: (a) fired this month? YES, likely -- inbound capture is months old, so any Inbound window long enough that its prior window starts before capture began showed growth chips against part of a period (admin-only report while vetted). (b) new failure mode? NO.
Tally: 1 production fix − 1 new failure mode = 0.

NET SCORE: 1 − 1 = 0

OPERATOR ACTIONS / DEPLOY:
- None beyond the deploy. | BLOCKS DEPLOY: N
- After the deploy: walk S38 (an Inbound window whose prior predates capture shows "No comparison" and no chips), S69 (Transfer retries over 92 days with retention on names the horizon), S73 (suggestions' summary line). | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version)
(Not complete in production until the dashboard deploy is confirmed.)

FOLLOW-ON ITEMS:
None

DOCUMENTATION UPDATES NEEDED:
- None beyond those made (INV-69, INV-30, fix-history RH-1 / RH-2, the inbound:v18 tokens, the regenerated module map). /sync-docs may want Operator State #57 to point at RH-1's notes.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
