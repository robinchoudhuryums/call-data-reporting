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
making it unwieldy. Moving the pure-config sheets to Neon (which the app
already uses) would shrink it. The append-only **log** sheets stay in the
spreadsheet (write-mostly, human-scannable).

**⚠ Key reality check (verified in code) — only Dept Config is modal-driven.**
The roadmap originally assumed the config sheets are "already edited through
admin modals, so edit-in-sheet UX is no longer needed." That's true for
**Dept Config only** (`saveDeptConfig` / `removeDeptConfig`). **Access Control,
Alert Config, and Digest Config have NO write path — they are edited BY HAND
directly in their sheets** (the Alerts/Digest modals only *display* them +
install triggers; Access Control has no UI at all). So moving those three to
Neon **removes their only edit surface** unless the migration ALSO builds a
small admin CRUD UI for each — otherwise the operator would have to edit Neon
via raw SQL. That admin UI, not the data-access swap, is the real cost of
Track C. The "edit in the sheet" workflow is the thing being replaced, so a
replacement editor is mandatory, not optional, for the hand-edited sheets.

A sheet→Neon *read-mirror* (keep editing the sheet, dashboard reads Neon) does
NOT help here: the sheet would have to stay, so it wouldn't reduce the sheet
count. The only way to actually retire a sheet is to replace its edit surface.

**Immediate (not a project):** the `setup()` error you hit was a **transient**
"Service Spreadsheets timed out" AFTER Dept Config was created — just **re-run
`setup()`** (it skips existing sheets, creates Report Usage). **SHIPPED** the
hardening: `setup()` now iterates the sheet specs in a try/catch + `flush()`
loop, so a transient failure on one sheet is logged and the loop CONTINUES to
the rest (and reports which failed); re-running is still idempotent.

**Candidates → Neon (with their CURRENT edit surface):**
- `Dept Config` → `dept_config` — **modal CRUD already exists** (`saveDeptConfig`/
  `removeDeptConfig`). No new UI needed. The free one.
- `Access Control` → `access_control` — **hand-edited, NO UI.** Needs a new admin
  editor (add/edit/remove a manager↔dept row).
- `Alert Config` → `alert_config` — **hand-edited**, modal only displays it. Needs
  an edit surface in the Alerts modal.
- `Digest Config` → `digest_config` — **hand-edited**, modal shows subscribers +
  trigger install only. Needs an edit surface in the Digest section.

**Keep in the spreadsheet:**
- Append-only logs: `Alert Log`, `Pipeline Health`, `Orphan Fix Log`,
  `Report Usage` (write-mostly, human-scannable).
- `Agent Alias Overrides` — **special case**: read CROSS-PROJECT by the
  cdr-report pipeline (`loadRosterCanonicalNames_`, INV-46). Moving it to Neon
  means the pipeline must read Neon for canonicalization. Doable (cdr-report
  already has `NEON_*`), but it adds a pipeline→Neon read dependency on the
  daily build's hot path — defer to last, or keep in the sheet.

**Per-sheet migration = two parts:** (1) the **data-access swap** (same for all,
mirrors the proven F1 DQE read-back pattern) and (2) the **edit surface** (only
needed for the hand-edited three).

*Part 1 — data-access swap (mechanical, low-risk, per sheet):*
1. Neon table mirroring the sheet schema (lazy `CREATE TABLE IF NOT EXISTS`, the
   inbound_calls / escalations precedent — no `setup()` change).
2. A flag-gated DAL: `neonFetch…_` / `sheetFetch…_` returning the SAME normalized
   shape, gated by a Script Property (e.g. `CONFIG_SOURCE=neon|sheet`, default
   `sheet`), **falling back to the sheet on any Neon error**.
3. One-time backfill (sheet → Neon) + a parity check (the two reads agree over
   current data) before flipping the flag. Reversible with no redeploy.

*Part 2 — edit surface (the real work, only for the hand-edited sheets):*
a small admin CRUD modal/section that writes the Neon table (`assertAdmin_` +
`LockService` + validation + an Updated By/At stamp — the INV-54 Dept Config
pattern is the template).

**Phasing (each independently shippable + reversible):**
- **C2 — Dept Config (SHIPPED, flag-gated, default `sheet`).** `CONFIG_SOURCE`
  Script Property switches read+write source: `readDeptConfigRows_` splits into
  `sheetReadDeptConfigRows_` / `neonReadDeptConfigRows_` (one `json_agg` fetch,
  sheet fallback on error); `upsertDeptConfigRow_` / `deactivateDeptConfig_`
  route to `neon*` variants when `CONFIG_SOURCE=neon`. `dept_config` table lazy-
  created. Editor-run `backfillDeptConfigToNeon()` + `compareDeptConfigSources()`
  parity gate. Parity pinned by `tests/unit/dept-config-neon.test.js`. **No new
  UI** (the modal CRUD already existed). Cutover: backfill → compare clean →
  flip the flag (Operator State #25). Reversible.
- **C1 — Access Control (highest value, but needs a UI + extra care).** Readers
  `resolveUser_` + `getManagerDepartment_` (Auth.gs); schema Email|Department|
  Notes. Hand-edited today, so build a small **Access Control admin editor**
  (add/edit/remove a manager↔dept row) — genuinely valuable since adding a
  manager is the most common config edit (no more "open the sheet, add a row,
  wait 60 s"). **SECURITY:** auth is the hot path — keep the sheet as a live
  fallback through a long validation window, cache reads (the 60 s
  `AUTH_CACHE_TTL_SECONDS` already helps), and **fail CLOSED (deny) on a Neon
  read error**, never open. ~1.5–2 days incl. the editor.
- **C3 — Alert Config + Digest Config (need edit surfaces).** Readers
  `readAlertConfig_` / `readDigestConfig_`. Both hand-edited; their modals only
  display + manage triggers, so each needs an edit table added to its existing
  modal. Lower edit frequency, so weigh whether the de-clutter is worth two more
  CRUD surfaces. ~1 day each incl. UI.
- **C4 (optional, last) — Agent Alias Overrides.** Read CROSS-PROJECT by the
  cdr-report pipeline (`loadRosterCanonicalNames_`, INV-46) on the daily build
  hot path. Moving it means the pipeline reads Neon for canonicalization —
  evaluate whether retiring one sheet is worth that build-path dependency.
  (Has the Orphan Fix modal as a partial write surface already.)

**Net result:** retires up to 4 config sheets; `setup()` creates fewer. The
catch is the edit surfaces: only C2 is "free." Recommended scope — **C2 now**
(proves the pattern, zero UX cost), **C1 next** (the editor is a real win on its
own), and treat **C3/C4 as optional** depending on whether two more admin modals
are worth shrinking the sheet list further.

**Effort:** C2 ~half day; C1 ~1.5–2 days (incl. editor + security care); C3
~1 day each; C4 ~1 day (cross-project). One phase per PR.

---

## Suggested sequencing

1. **A** (Missed bar toggle) — small, immediate UX win, client-only.
2. **B** (Escalations page) — medium, client-only, no infra risk.
3. **C** (config → Neon) — **C2 Dept Config** first (free: modal CRUD already
   exists, proves the pattern), then **C1 Access Control** (needs a new admin
   editor but it's a real win; fail-closed on Neon errors), then treat **C3
   Alert/Digest** and **C4 Agent Alias** as optional (each costs an edit
   surface). Plus the 15-min `setup()` hardening up front. NOTE: only C2 is a
   pure data-swap; C1/C3 each require building an admin CRUD UI to replace the
   hand-edit-in-sheet workflow (see Track C body).
