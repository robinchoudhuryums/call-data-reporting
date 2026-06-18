# Design Update Plan — Department Dashboard

Planning deliverable for the Claude Design package at `docs/design-package/`
(`DESIGN_PACKAGE_GUIDE.md` + four `.dc.html` files + `support.js`). This
document is the agreed plan, the conflict register, and the implementation
sequence. **No code has been changed yet** — this is the plan of record.

> **Governing principle (from the package guide):** the codebase is the source
> of truth. The design files are *proposals*. Where they conflict with the code,
> data model, metric definitions, business rules, or permissions, **the codebase
> wins.** Conflicts are noted → explained → given options → resolved, never
> silently applied or dropped.

---

## 1. Headline assessment

The package is deliberately additive: every new class is `ds-`-prefixed and
designed to "land alongside the old CSS," migrating report-by-report. It got the
semantic color hexes exactly right (`--accent #4e7bc4`, `--good #3d9476`,
`--warn #c66b4b`, `--bad #b23a2c` + softs all match `styles.html:31-42`) and
correctly identifies several things already done in-repo. Friction is
concentrated in a small set of token/behavior conflicts plus the two items the
guide itself flags as product decisions (consolidation, nav).

Verification was done against: `styles.html`, `dashboard.html`, `script.html`,
`Data.gs`, `CompanyOverview.gs`, `Auth.gs`, `Code.gs`.

---

## 2. Decisions of record

| # | Topic | Decision |
|---|---|---|
| C1 | `--r` radius token | **Keep `--r:2px`**; add only the *new* tokens `--r-sm`/`--r-lg`/`--r-pill`. Do **not** redefine `--r`. |
| C2 | Status thresholds | Drive `ds-` status color from the existing **binary** `benchValueCls_` (92% / 5%). Do **not** add the design's invented 85%/8% bands. |
| C3 | Dark mode | Keep `body[data-mode="dark"]` + the existing contrast-tuned palette. Decline the design's `[data-theme="dark"]` override. |
| C4 | Charts / SRI | Adopt the chart-factory + "Chart unavailable" fallback. Keep current pinned versions, html2canvas-pro, and the **intentionally-omitted datalabels SRI**. |
| C5 | Part 5 code sample | Sample calls a private `computeSummary_` via RPC — wire debounce/token logic to the public `getDepartmentSummary` instead. |
| C6 | Overview client cache (SWR) | **Adopt**, with guardrails: key the `localStorage` cache by **viewer email + role**, persist only the already-personalized payload, never persist admin-only fields, never paint a stale blob for a different viewer. |
| C7 | Report consolidation (7→2) | **Parked** — product decision, not built in this design pass. Component layer does not require it. |
| C8 | Navigation restructure | **Defer.** Keep the existing Phase C tab + Reports-menu + admin-gated structure. Optional later win: move the 4 admin tabs into an avatar dropdown. |

---

## 3. Conflict register

Format per the package guide: **Design** vs **Codebase** → **why it conflicts**
→ **options (A preferred / B adopt-design / C hybrid)** → **resolution**.

### C1 — `--r` redefinition (keystone)
- **Design** (Component Handoff Part 1, lines 90-91): introduces a radius scale
  and redefines `--r` from `2px` → `10px`; `ds-` components use `var(--r)` /
  `var(--r-lg)` expecting rounded corners.
- **Codebase** (`styles.html:48`, `--r: 2px;`): `--r` is the canonical,
  documented border-radius token. CLAUDE.md CSS conventions §2: squared-off
  corners are house style; ~56 hardcoded `2px` callsites are intentionally left.
- **Conflict:** redefining `--r` silently re-rounds every existing `var(--r)`
  callsite across all reports — a sweeping change to working UI.
- **Options:** (A) keep `--r:2px`, add new tokens only; (B) adopt `--r:10px`
  globally (high blast radius); (C) hybrid `--r-card` alias.
- **Resolution: A.** This is what keeps the whole "additive, migrate
  report-by-report" strategy safe.

### C2 — three-band status thresholds (invented values)
- **Design** (Part 1, lines 103-104): `statusFor()` uses three bands —
  answer rate `>=92 good / 85-92 warn / <85 bad`; abandon `<5 good / 5-8 warn /
  >8 bad`.
- **Codebase** (`script.html:2478-2485`, `benchValueCls_`): strictly binary —
  `answer >= 92 → bm-target`, else nothing; `abandon >= 5 → bm-over`, else
  nothing. The `85%` and `8%` cut-points exist nowhere. CLAUDE.md
  anti-intimidation §4: "Don't add invented thresholds here; dept-specific alert
  thresholds stay with the Alerts engine."
- **Conflict:** the design invents metric semantics ("never redefine a metric to
  match a mock").
- **Options:** (A) keep binary, map onto `is-good`/`is-warn` only; (B) adopt 3
  bands (needs product sign-off on what 85%/8% mean); (C) binary for the 92/5
  standards, reserve `is-bad` only where code already uses `--bad` (hard errors).
- **Resolution: A (with C's nuance).** Use the `ds-chip` / `ds-card--rail`
  machinery, but drive it from `benchValueCls_`, not new thresholds.

### C3 — dark-mode mechanism & palette
- **Design** (Part 8, lines 578-586): keys dark mode on `[data-theme="dark"]`
  with its own palette (`--paper:#0e151c` …).
- **Codebase** (`styles.html:71-127`): dark mode is `body[data-mode="dark"]`,
  orthogonal to `data-theme` (`warm|cool|clinical`, the *light* picker). Existing
  dark values are AA-contrast-tuned with documented ratios + an OKLCH path.
- **Conflict:** wrong selector for the two-axis theme model; the design's palette
  would overwrite contrast-checked values.
- **Options:** (A) keep `data-mode="dark"` + existing palette (new `ds-`
  components inherit dark mode via tokens "for free"); (B) adopt design palette
  (regresses contrast — rejected).
- **Resolution: A.** The design's *principle* (components read tokens, only
  neutrals swap) already matches the code; only its selector/values are wrong.

### C4 — charts / SRI already decided
- **Design** (Part 4, line 373): restore SRI hashes (esp. datalabels), keep
  html2canvas-pro, pin versions, register plugins once.
- **Codebase** (`dashboard.html:13-28`, CLAUDE.md / INV-41): versions already
  pinned (`chart.js@4.4.4`, `datalabels@2.2.0`, `html2canvas-pro@1.5.11`);
  html2canvas-pro already in use; plugins registered once. datalabels SRI was
  **intentionally omitted** ("Option A") because the hash combo silently blocked
  the plugin.
- **Conflict:** "restore datalabels SRI" reverses a known-good decision and would
  re-break data labels.
- **Options:** (A) treat Part 4 as mostly-done; adopt the chart-factory + target
  band + graceful "Chart unavailable" fallback; keep datalabels SRI omitted;
  (B) restore SRI (rejected).
- **Resolution: A.** Chart factory + unavailable-state guard are genuine wins;
  decline only the SRI-restore note.

### C5 — Part 5 sample references a private function
- **Design** (Part 5, line 473): debounce example calls
  `google.script.run … .computeSummary_(from, to)`.
- **Codebase** (`Data.gs:274` vs `:165`): `computeSummary_` ends in `_` →
  RPC-blocked (INV-01). Public entry point is `getDepartmentSummary(req)`. (The
  SWR sample's `getCompanyOverview()` *is* correct, `CompanyOverview.gs:131`.)
- **Conflict:** copy-pasting the sample throws at runtime.
- **Resolution:** doc error, not a design conflict. Wire debounce/token-cancel
  logic to `getDepartmentSummary`. Noted so no one pastes it verbatim.

### C6 — caching Overview in localStorage (PII / per-viewer)
- **Design** (Part 5 item 1, lines 455-467): stale-while-revalidate — cache the
  `getCompanyOverview()` payload in `localStorage`, paint instantly, revalidate.
  Guide warns: confirm no PII before caching; if unsure, don't cache.
- **Codebase** (`CompanyOverview.gs`, `personalizeOverview_`): payload is
  per-viewer personalized — admin-only fields (`companyAggregate`,
  `pipelineFreshness`, `orphanNag`) stripped for managers; `viewerRole`/
  `viewerDept` injected per request. Contains dept names + activity counts +
  (for admins) company aggregates — operational, viewer-scoped data.
- **Conflict:** safe only if keyed per-user and never shared across logins on a
  shared machine; a stale admin blob must never paint for a later manager.
- **Options:** (A) implement SWR keyed by viewer email + role, persisting only
  the already-personalized payload, never admin-only fields; (B) skip client
  caching, rely on server CacheService + `CacheWarm.gs`; (C) SWR for managers
  only (already-stripped payload).
- **Resolution: A.** Adopt SWR with the per-viewer guardrails above. The
  revalidate fetch is still the source of truth; the cache is paint-only.

### C7 — report consolidation (7 → 2) — PRODUCT DECISION, not built
- **Design** (Part 3): merge Individual + Performance + Insights → "Team &
  Agents"; Missed + QCD + Inbound → "Calls & Queues"; Compare becomes a *mode*.
- **Codebase:** 7 distinct `.gs` builders, distinct cache keys, per-dept gating,
  a parity test (`insights-report.test.js` pins Insights==Performance); the
  report menu already carries `*` "pending consolidation review" stars
  (`dashboard.html:71-83`). CLAUDE.md calls Insights "the consolidation candidate
  for PR (and eventually CR)."
- **Resolution:** guide is explicit — do not implement without sign-off; the
  component layer (Parts 1-2) does not require it. **Parked.** Parts 1-2 make a
  future consolidation easier; we plan around it, not toward it.

### C8 — navigation partly reverses Phase C
- **Design** (Part 6): top bar = Overview / Team & Agents / Calls & Queues
  (depends on Part 3); Admin → role-gated avatar dropdown.
- **Codebase** (`dashboard.html:44-104`): Phase C deliberately flattened
  dropdowns into a tab row, then re-grouped the 7 reports into a single "Reports"
  dropdown; admin items are already `data-admin-only` (hidden for managers).
  "Team & Agents / Calls & Queues" labels require consolidation (C7).
- **Options:** (A) defer nav restructure; apply only the visual token refresh to
  the existing nav; (B) move the 4 admin tabs into an avatar dropdown now
  (cosmetic, reversible) without touching consolidation; (C) full Part 6 (blocked
  on C7).
- **Resolution: A**, with B available later as a small standalone win.

### Minor — "More metrics" collapse on My Department (guide-flagged high-risk)
- **Design:** hide TTT / ATT / Abd / CSR-Abd behind a "More metrics ▾" toggle
  (progressive disclosure).
- **Codebase:** `exportTableCsv_` exports the current view; Digest/email paths
  recompute server-side.
- **Caution:** safe **only if** the columns stay in the DOM (visually collapsed,
  not removed), so CSV export and any downstream consumer still see all columns.
  Default-expanded or remembered preference recommended so power users/exports
  aren't surprised. Implementable safely; flagged per the guide.

---

## 4. Safe & additive work (low risk)

| Item | Source | Notes |
|---|---|---|
| New tokens: `--r-sm`/`--r-lg`/`--r-pill`, `--shadow-1/2/modal`, `--ease`/`--dur-*` | Part 1, 9 | Additive; **do not** touch `--r` (C1) |
| `ds-` component layer (8): kicker/section, chip/delta, KPI tile, status-rail card, table+bar, banner, toolbar/segment, modal shell | Part 2 | Net-new classes; status color from `benchValueCls_` (C2) |
| Loaders: signal-rings, equalizer, sparkline-draw, skeleton shimmer, staged progress | Part 7 | `.skeleton-*` already exists (`styles.html:4211`); rest additive; reduced-motion gated |
| Motion: grow-in, change-flash, crossfade, modal-rise, segment-slide, count-up | Part 9 | `transform`/`opacity` only; reduced-motion no-op |
| State kit `.ds-state` (no-data/error/loading/permission); dark-mode-via-tokens | Part 8 | Components read tokens → dark mode free (C3) |
| Chart factory + "Chart unavailable" fallback | Part 4 | Keep current SRI/library decisions (C4) |
| Debounce + stale-response token on date edits | Part 5 #3 | Wire to `getDepartmentSummary` (C5) |
| SWR Overview paint-on-cache | Part 5 #1 | Per-viewer keyed, no admin-only fields (C6) |

---

## 5. Implementation sequence (updated for the decisions above)

The original package order was Parts 1-2 → loaders/SWR → motion → nav →
consolidation. Adjusted for C6=adopt, C7/C8=parked:

1. **Phase 1 — Tokens + one-report proof** *(additive, reversible)*
   - Add `--r-sm`/`--r-lg`/`--r-pill`, `--shadow-*`, `--ease`/`--dur-*`. Leave
     `--r:2px` untouched (C1).
   - Build the 8 `ds-` components; status color via `benchValueCls_` (C2).
   - Migrate **one** report to `ds-` as a proof. **Insights** is the natural
     anchor (it's the consolidation candidate). Reviewable before wider rollout.

2. **Phase 2 — Independent quick wins**
   - Part 7 loaders + Part 9 motion + the `.ds-state` kit (reduced-motion gated).
   - **SWR Overview** (C6): paint cached payload instantly, revalidate via
     `getCompanyOverview()`, swap + stamp freshness. Cache key = viewer email +
     role; persist only the personalized payload; never admin-only fields.

3. **Phase 3 — Charts + responsiveness**
   - Chart factory (single `lineChart()`, target-band plugin, end-point label) +
     "Chart unavailable" graceful fallback (C4).
   - Debounce + stale-response token on date-range edits, wired to
     `getDepartmentSummary` (C5).

4. **Phase 4 — Migrate remaining reports** to `ds-` components, one at a time.
   - Optional: "More metrics" disclosure on My Department, keeping all columns
     in-DOM for CSV/export (see Minor note).

5. **Held for product decisions (not scheduled)**
   - C7 report consolidation (needs sign-off; everything above lands without it).
   - C8 nav restructure (optional admin-avatar-dropdown is a small standalone win
     if desired).

At every step the governing principle holds: additive first, behavior/data
unchanged, anything ambiguous flagged rather than committed.

---

## 6. Access-control confirmation (asked during planning)

A non-manager, non-admin agent **cannot** use the web app. Three layers:

1. **Deployment** (INV-13): "Execute as: Me / Access: Anyone within domain" — an
   external (out-of-domain) person can't reach `doGet` at all.
2. **Entry gate** (`Code.gs:14-21`): `doGet` resolves the signed-in email via
   `resolveUser_` (`Auth.gs:22-47`) → `admin` only if in `ADMIN_EMAILS`,
   `manager` only if a row in the `Access Control` sheet, **`none` otherwise**.
   A `none` user is served the access-denied page, never the dashboard.
3. **Defense in depth**: every public RPC re-resolves auth independently (e.g.
   `Data.gs:167-177`: `resolveUser_` → throw on `role==='none'` →
   `assertDeptAccess_`), so a direct `google.script.run` call from a `none` user
   is rejected and managers can't read other depts.

**Net:** an in-domain agent can open the URL but lands on access-denied with no
data; out-of-domain users can't reach it. Ongoing safety is hygiene (keep
`Access Control` + `ADMIN_EMAILS` accurate — Operator State #3, #13), not code.
