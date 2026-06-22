# Design Update — Pass 2: codebase review & plan of record

Companion to `docs/design-update-plan.md` and the Pass-2 revision plan. This
file records the **validation of the Pass-2 proposal against the shipped code**
(commit `5e1296b` baseline, plus the My-Department polish merged in PRs
#118–#121), the conflicts found, the resolutions chosen, and the build sequence.

> **Governing principle (unchanged):** the codebase is the source of truth.
> Everything below is additive (`ds-*` classes / new client helpers); it changes
> **no** server compute, cache shape, metric definition, or permission gate. Where
> the proposal conflicted with shipped code, the conflict is noted with options and
> a chosen resolution.

Two resolutions were decided by the owner up front:

- **A2 (rail color):** ratify the **shipped sage-green** for "improved" — do **not**
  revert to blue. (The proposal's "keep blue" recommendation was based on a stale
  read; green was an explicit prior decision.)
- **C3 (cold-start loader):** use an **honest single indeterminate loader** — no
  faked "warming DB → fetching calls" staged labels (there is no real stage signal
  client-side).

---

## Conflict register (proposal claim → shipped reality → resolution)

### 🔴 A2 — Agent-card rail color (RESOLVED: ratify green)
- **Proposal claimed:** improved = `var(--accent)` (blue); recommended keeping blue.
- **Shipped reality:** `insBuildCard_` (script.html:11608) already maps
  `improved → var(--good)` (sage), `regressed → var(--warn)`, `mixed → var(--muted)`,
  `floater → var(--warn)`. `crBuildCard_` matches. Green-for-improved was a deliberate
  owner decision earlier this session.
- **Resolution:** **Ratify shipped green (no code change).** Optionally add a one-line
  legend/tooltip on the Insights group headers (see A1) so "green rail = improved
  direction" is not confused with "green benchmark = healthy level" (`benchValueCls_`
  92%/5%). Classification axis (rail) and health axis (benchmark tint) stay distinct.

### 🟡 D1 — "error keeps cached data" (RE-SCOPED: Overview already does it)
- **Proposal claimed:** error tone that preserves last-good data is unbuilt.
- **Shipped reality:** the Overview revalidate **failure** handler (script.html:1213)
  already preserves the cached paint and shows `ovSetRefreshWarn_(true)`
  ("Auto-refresh is failing — showing the last loaded data"); it only shows a hard
  error when there is no cached/last paint (`!paintedFromCache`).
- **Resolution:** narrow D1 to the genuine gaps:
  - **D1a (small, in-scope):** add a **Retry** affordance to the existing Overview
    warn banner (re-invoke the same fetch).
  - **D1b (separate, deferred):** the **reports** (IR/PR/CR/QCD/Inbound) still blank to
    a hard `.status-error` on failure and do not keep a last-good client payload.
    Giving them keep-last-good is a larger change (they don't client-cache like
    Overview) and is tracked as its own item, **not** bundled into this pass.

### ⚠️ A1 — Insights "needs attention first" grouping (VIABLE with guardrails)
- **Proposal claimed:** container `#ins-agent-list`; add grouping; reuse classification.
- **Shipped reality / corrections:**
  1. Container id is **`#ins-agent-cards`** (dashboard.html:1703), not `#ins-agent-list`.
     Toolbar `#ins-cards-toolbar` (1679) is correct.
  2. A **quiet-agents collapse already exists** (`#ins-quiet-details`, "Show N quiet
     agents", script.html:11450). Grouping is therefore a **3-tier** layout:
     *Needs attention (regressed)* → *On track (improved/steady)* → existing *Quiet*
     `<details>`. Do not duplicate the quiet collapse.
  3. **Chart-view coupling:** `insRenderCardsChart_` (11490) reads the same
     `insLastData.agentData`. The current sort already partitions a `slice()` copy
     (`sortedMain`, 11420). Grouping **must operate on a copy at render time and never
     mutate `insLastData.agentData`**, or the Cards⇄Chart toggle silently reorders too.
- **Safe by verification:**
  - Parity test `tests/unit/insights-report.test.js` asserts only the computed payload
    (`teamStats` / `trendData` / `priorDateLabel`), **not** card order → grouping is safe.
  - `Digest.gs` reuses `computeInsights_` server-side and is order-independent → safe.
  - `deltaClassify_` (8666), `.al-section-title` (styles 3341), `.ds-kicker` (4559) all
    exist for reuse. Prefs key `cdr.ins.prefs.v2` (10510) can carry a group-collapse field.

### 🟡 C3 — cold-start loader (RESOLVED: honest single loader)
- **Proposal claimed:** staged-progress bar with a named label that swaps per stage.
- **Shipped reality:** boot is skeleton-based (`#ov-loading`); the client fires a single
  `getCompanyOverview()` — there is **no real staged signal** to drive labels.
- **Resolution:** ship a **single indeterminate progress loader** (the `.ds-loader--staged`
  bar is fine visually) with **one honest label** ("Loading…" / "Fetching the latest
  data…"). No multi-stage label rotation that would imply progress the client can't know.
  Purely cosmetic over the existing fetch; must not gate or delay the real request.

### 🔍 A3 — abandon-heatmap TZ (VERIFY-ONLY; deeper question noted)
- **Confirmed:** `INBOUND_HEATMAP_CST_SHIFT_HOURS = 2` (InboundReport.gs:421), applied as
  `(c.call_start)::time + interval '2 hours'` (≈455). `inbound_calls.call_start` is written
  by `icIsoTime_` (cdr-import/inboundCalls.js:88) as raw `HH:MM:SS` without the DQE
  pipeline's +2h.
- **DST:** `+2` is correct year-round **if** the source clock is America/Los_Angeles
  (PST/PDT runs a fixed 2h behind US Central, which DSTs in sync). Only a few transition-day
  hours could land ±1 slot.
- **Deeper check for the live spot-check:** `icIsoTime_` derives the time via
  `new Date(ms).getHours()`, which renders in the **cdr-import script timezone
  (America/Chicago)** — so the spot-check must confirm `call_start` actually lands as PST
  wall-clock as the comment claims (cross-reference the Mexico-City-vs-Chicago 36:36 footgun
  in `known-issues.md`). **No edit unless a row is demonstrably off.**

### 🟡 D2 — permission tone (LOW VALUE; deprioritized)
- `assertAdmin_` throws `"Alerts are admin-only."`; **no client code string-matches** that
  message (safe to generalize copy client-side, never change the server string). But
  `initRouter` already no-ops admin routes for non-admins (F11) and `data-admin-only` hides
  the surfaces, so there are essentially no dead ends to catch. Build only if time permits;
  if surfaced, generalize the copy client-side ("This area is admin-only").

---

## Verified-clean items (additive, no conflict)

- **B1 change-flash:** SWR helpers confirmed — `OV_CACHE_KEY_` (1150), `ovReadCache_`/
  `ovWriteCache_` (1151/1159), `ovLoad_`. Success handler at 1203; insert the flash call
  after `ovSetCachedIndicator_(false)` / around `ovRender_(data)`. **Correction:** there is
  no `overviewRoot` var — the root element is `#ov-body`. Dept tiles carry a stable
  `data-dept` (`ovBuildGridTile_`:1747); hero `%` in `ovBuildHeroTile_`:1569 — good anchors
  for `data-flash-key`. My-Dept path `refresh()` → `onData()` (3762) → `render()` (4258);
  the text-snapshot helper works even though tbody innerHTML is replaced wholesale. Neither
  `data-flash-key` nor `ds-flash` exists yet. Flash **only on update, never first paint**.
- **C1/C2 loaders:** `DS_EQ_HTML_`/`.ds-loader--eq` (script 3699 / styles 4757) shipped;
  Caller Lookup `cl-results` + `clShowOnly_()` (admin-gated, CallerLookup.gs:42); QCD uses a
  status-banner pattern (`qcd-results`) rather than button-text — target its results region.
  `.ir-chart-wrap` / `ov-chart-wrap`, `safeChart_` (255) and `.ds-chart-unavailable` (272)
  confirmed for C2.
- **Tokens:** `--accent-soft`, `--ease`, `--r-pill`, `--paper-2`, `--stagger`, `--dur-1` all
  exist in `:root`.
- **E motion:** existing keyframes — `ds-modal-fade`/`ds-modal-rise`, `ds-tip-in`,
  `ds-eq`, `skeleton-shimmer`/`irShimmer`, `irDrillSpin`. `.ds-seg` uses `[aria-pressed]`
  (no sliding indicator → segment-slide needs a new indicator element). Skeleton swap is
  `display`-based (crossfade is a real change there). Count-up first-load-only and must not
  double-animate the hero alongside B1's flash.
- **F:** digest already has KPI tiles + WoW narrative (`digestSummaryHtml_`) + a deep-link
  button (`digestDeepLink_` → `DASHBOARD_URL`), reuses `computeInsights_`, gating intact
  (`assertAdmin_`, weekend skip, `notifyDigestFailure_`). Unmapped-queue detection already
  exists via `DeptConfig` discovery (`scanQcdQueueNames_` / `discoverQueues_` /
  `getDeptConfigInit`). F reuses these — it must **not** invent a mapping model. Separate
  work-stream.

---

## Build sequence (plan of record)

1. **B1 change-flash** — additive CSS (`.ds-flash` + `@keyframes`, reduced-motion guard) +
   one `dsFlashChanged_` helper; wire Overview revalidate + My-Dept render. Flash on update
   only.
2. **A1 Insights grouping** — 3-tier (Needs attention / On track / existing Quiet), partition
   a **copy**, never mutate `insLastData.agentData`; reuse `.al-section-title`/`.ds-kicker`;
   group-collapse pref in `cdr.ins.prefs.v2`; add the A2 green legend line. Parity test must
   stay green.
3. **C1 signal-rings** (Caller Lookup + QCD results region) + **C2 sparkline-draw** (chart
   slots, pairs with `safeChart_`) + **C3 honest single loader** (cold-start, one label).
4. **D1a** Overview retry button on the existing warn banner.
5. **E motion** — grow-in, count-up (hero/KPI, first-load only), segment-slide indicator,
   skeleton→content crossfade. All transform/opacity, fire-once, reduced-motion no-ops.
6. **Deferred / separate:** D1b (reports keep-last-good), D2 (permission tone), F (digest +
   onboarding). A3 is a live spot-check, not a code change.

Every step: additive `ds-*` / new helpers only; no change to server compute, cache shape,
metric definitions, or permissions. Anything that would touch those stops and is flagged.
