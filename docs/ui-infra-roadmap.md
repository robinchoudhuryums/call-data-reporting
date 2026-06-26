# Roadmap — Missed bar chart, Escalations page, Config sheets → Neon

Status: **PLAN ONLY.** Three independent tracks from deploy-testing feedback,
each phaseable. Ordered by effort/risk: A (small, client-only) → B (medium,
client) → C (larger, infra, security-sensitive). Owner-approved direction;
this doc is the build plan to approve before coding each track.

---

## Track A — Missed Calls: radar ⇄ horizontal bar toggle (#5)

**Why:** the radar is evocative but weak for reading values / comparing buckets.
A horizontal bar chart (18 half-hour buckets, count = bar length) is far more
legible for "when in the day do misses happen."

**Current code:** `missedRadarCfg_(chart, onBucketClick)` (script.html) is the
SHARED config used by both the Missed Calls modal (`renderMissedChart`) and the
My Department inline section (`deptMissedRender_`). `chart = { labels, counts }`
(18 buckets, 8 AM–5 PM CST, INV-18). Click → bucket index → the shared
bucket-detail panel.

**Plan (client-only, no server/payload change):**
1. Add `missedBarCfg_(chart, onBucketClick)` — `type:'bar'`, `indexAxis:'y'`
   (horizontal), same `labels`/`counts`, same `onClick` → bucket index, same
   datalabels-off (INV-41). Reuse `THEME.warn`/`warnSoft`.
2. Add a **chart-mode toggle** (segmented "Bars / Radar") in both the modal and
   the dept section, persisted in `localStorage` (`cdr.missed.chartmode`,
   default `bars`). The render sites read the mode and pick the config; the
   deferred-resize (#5 fix already shipped) applies to both.
3. Keep the bucket-detail drill identical (both configs call the same
   `onBucketClick`).

**"Spice up" the bar version to read like a work day** (pick any; all cheap,
client-only):
- **Work-window band**: shade 8:30 AM–5 PM CST (the INV-18 window) so misses at
  the edges read as context, not headline.
- **Peak marker**: bold/annotate the single busiest bucket ("Peak: 11:30").
- **Intensity color ramp**: bars tint from calm → warm by count, so the
  worst stretch pops (resolve via `colorToCanvasRgb_`, INV-42).
- **Average reference line**: a dashed line at the mean misses/bucket.
- **Abandoned overlay**: stack the abandoned subset as a second segment per
  bucket (missed vs abandoned) — needs the abandoned-per-bucket series; if the
  payload doesn't already carry it, this one is a small server add (defer).
- **Lunch/open/close ticks**: light vertical gridlines at 12 PM + window
  open/close so the day's shape is obvious.

**Effort:** ~half day (the band + peak + ramp are the high-value trio; abandoned
overlay is the only piece that might touch the server).

---

## Track B — Escalations as a full page (#6)

**Why:** Escalations is an interactive **worklist** (list + filter + create +
resolve + reopen + per-card activity timeline), not a generate-and-read report.
A draggable modal cramps it; a page gives room, deep-linking, and a calmer
presentation.

**Current code:** `Escalations.gs` server (INV-55, unchanged by this); client is
a modal (`#escalations-modal`) opened from the Escalations nav tab, with the
route `#/escalations` already registered. The dashboard is a two-page app
(`body[data-page="overview|dept"]`, `setPage`).

**Plan (client-only; server endpoints untouched):**
1. **Generalize the two-page app to N pages.** `setPage(name)` already swaps
   `body[data-page]`, the header kicker/title, and (for overview) triggers a
   fetch. Add `escalations` as a third value + a `<section>` page.
2. **Move the modal's inner markup into a new page `<section id="page-escalations">`**
   in dashboard.html (toolbar: Filter + New escalation (admin); body: the
   escalation cards with their lazy Activity timelines). The existing
   `esc-*` render/init functions move over near-verbatim (they target ids, not
   the modal shell).
3. **Wire the Escalations tab** to `setPage('escalations')` instead of
   `openModal('escalations-modal')`; on enter, run the existing init/load.
   Keep the deep link `#/escalations` → `setPage('escalations')`.
4. **Header behavior**: set the kicker/title to "Escalations" on enter; make
   sure `refresh()` (dept-only title writer) doesn't clobber it (it already
   guards on `data-page`).
5. Retire the modal shell once the page is validated (keep one release as
   parity, like the Missed section migration).

**Effort:** ~1 day. The only real work is the markup move + the two→N page
generalization + router wiring; the server + the esc-* logic are reused as-is.

---

## Track C — Pure-config sheets → Neon (#8)

**Why:** the dashboard now manages **10 sheets** in the CDR Report spreadsheet,
making it unwieldy. The pure-config sheets are small and already edited through
admin modals (not by hand), so the "edit in the sheet" benefit is mostly gone —
they're good candidates to move to Neon (which the app already uses). The
append-only **log** sheets stay in the spreadsheet (easy to eyeball, and they're
write-mostly).

**Immediate (not a project):** the `setup()` error you hit was a **transient**
"Service Spreadsheets timed out" AFTER Dept Config was created — just **re-run
`setup()`** (it skips existing sheets, creates Report Usage). Optional small
hardening: `SpreadsheetApp.flush()` between `ensureSheet_` calls + a
catch-and-continue so one slow create doesn't abort the rest. I can do that in
~15 min independently of the migration.

**Move to Neon (config, modal-driven):**
- `Access Control` → `access_control`
- `Dept Config` → `dept_config`
- `Alert Config` → `alert_config`
- `Digest Config` → `digest_config`

**Keep in the spreadsheet:**
- Append-only logs: `Alert Log`, `Pipeline Health`, `Orphan Fix Log`,
  `Report Usage` (write-mostly, human-scannable).
- `Agent Alias Overrides` — **special case**: read CROSS-PROJECT by the
  cdr-report pipeline (`loadRosterCanonicalNames_`, INV-46). Moving it to Neon
  means the pipeline must read Neon for canonicalization. Doable (cdr-report
  already has `NEON_*`), but it adds a pipeline→Neon read dependency on the
  daily build's hot path — defer to last, or keep in the sheet.

**Migration discipline (mirror the proven F1 DQE read-back pattern):** each
sheet gets (1) a Neon table with the same schema, (2) a DAL with **sheet
fallback** gated by a Script Property flag (e.g. `CONFIG_SOURCE=neon|sheet`,
default `sheet`), (3) a one-time backfill (sheet → Neon), (4) a parity check,
then (5) cut over by flipping the flag — reversible with no redeploy. Writers
(the admin modals' save paths) dual-write or switch with the same flag.

**Phasing (each is independently shippable + reversible):**
- **C1 — Access Control.** Highest value (most-read, security-critical) but
  therefore the most careful: keep the sheet fallback through a full validation
  window. Reader: `resolveUser_` / the auth cache (60 s TTL already). Backfill +
  parity + flag.
- **C2 — Dept Config.** Cleanest swap — `readDeptConfigRows_` is the single read
  chokepoint and `saveDeptConfig`/`removeDeptConfig` the single writers. The
  per-execution memo stays. (Watch the col-10 Inbound Queue Aliases we just
  added — the table schema must include it.)
- **C3 — Alert Config + Digest Config.** Readers `readAlertConfig_` /
  `readDigestConfig_`; writers are the Alerts/Digest modal saves. Lower traffic.
- **C4 (optional, last) — Agent Alias Overrides.** Only if we want it off the
  sheet; requires the cdr-report pipeline to read Neon (cross-project). Evaluate
  whether the hot-path cost is worth retiring one more sheet.

**Net result:** removes up to 4–5 sheets from the CDR Report ss; `setup()`
creates fewer sheets; config edits still flow through the same admin modals
(UX unchanged), just persisted to Neon. Security note: Access Control governs
who gets in — its migration must keep the sheet as a live fallback until parity
is proven, and fail **closed** (deny) on a Neon read error rather than open.

**Effort:** C1 ~1–1.5 days (careful), C2 ~half day, C3 ~half day, C4 ~1 day
(cross-project). Best done one phase per PR.

---

## Suggested sequencing

1. **A** (Missed bar toggle) — small, immediate UX win, client-only.
2. **B** (Escalations page) — medium, client-only, no infra risk.
3. **C** (config → Neon) — start with **C2 Dept Config** (cleanest) to prove the
   pattern, then **C1 Access Control** (highest value, most care), then C3, then
   reconsider C4. Plus the 15-min `setup()` hardening up front.
