# Department Dashboard — Design Update Package

A visual + structural redesign of the Call Data Reporting department dashboard,
delivered as four self-contained HTML design files plus this guide. Everything
keeps your existing cool-theme palette, type system (Inter Tight / Inter / IBM
Plex Mono), and dark mode — the work is hierarchy, clarity, status color, soft
depth, progressive disclosure, and the surfaces around the reports.

---

## ⚠️ GOVERNING PRINCIPLE — read before implementing anything

**The codebase is the source of truth. The design suggestions in this package are
proposals, not instructions.** When anything in these mockups conflicts with the
actual code, data model, metric definitions, business rules, permissions, or
constraints in the repository, **the codebase always wins.**

### What "wins" means in practice

Do **not** change working behavior, data, or logic to make the product match a
mock. The mocks illustrate *visual and structural intent*; they are not a spec for
behavior.

### When you hit a conflict, follow this procedure — do not guess

1. **STOP.** Do not silently implement either side, and do not quietly drop the
   conflicting suggestion.
2. **NOTE the conflict.** Cite the specific code (file / function / line / observed
   behavior) and the specific design suggestion it contradicts.
3. **EXPLAIN it.** State plainly what the code currently does and why, versus what
   the design assumes. Make the disagreement legible to a human.
4. **PROVIDE resolution options.** Typically three:
   - **(A) Keep the code as-is, adapt the design** — preferred default.
   - **(B) Adopt the design** — only with an explicit list of every code/logic
     change required and the risk each carries.
   - **(C) Hybrid** — take the visual change, keep the existing behavior/data.
   Recommend one, but leave the decision to a human.
5. **When the call is unclear or debatable, ERR ON THE SIDE OF CAUTION.** Choose the
   **least destructive, most reversible** path:
   - Preserve existing behavior and data.
   - Make changes **additive** (the new `ds-` classes are designed to land
     *alongside* the old CSS — migrate one report at a time, nothing is ripped out).
   - Gate anything behavioral behind a flag.
   - **Flag for human review rather than committing a judgment call.**

> Rule of thumb: a wrong *visual* tweak is cheap to revert; a wrong *behavior or
> data* change can corrupt reporting trust. Bias every ambiguous decision toward
> not touching logic.

### Data vs. design — what to adopt and what to ignore

- **Adopt:** style values (hex, spacing, radii, shadows, motion timings), layout
  structure, component patterns (`ds-*`), copy *patterns* (plain-language
  headlines), and interaction ideas.
- **Never adopt as real:** the sample numbers, agent names (Aisha Khan, James
  Carter, …), department names, thresholds, dates, and example copy in the mocks
  are **illustrative placeholders**. Pull real values, labels, formulas, and rules
  from the code and data source.
- **Never redefine a metric to match a mock.** Answer rate, abandon %, TTT, ATT,
  unique/rung/missed/answered, the work-window logic, and the 92% / 5% thresholds
  must come from the existing code. If a mock implies a different definition, that
  is a conflict — see the procedure above.

### High-risk areas where caution specifically applies

- **"More metrics" collapse (My Department):** hiding TTT / ATT / Abd / CSR-Abd is
  *progressive disclosure* — they must remain reachable, never deleted. If any
  consumer (export, email, downstream) depends on them always rendering, keep them.
- **Report consolidation (Component Handoff, Part 3):** merging 7 reports → 2 is a
  **product decision**, not a mechanical refactor. Do not implement without sign-off.
  The component layer (Parts 1–2) does **not** require consolidation to land.
- **Charts / libraries (Part 4):** the SRI-hash, version-pin, and
  `html2canvas-pro` notes are suggestions based on comments in the repo — verify
  against the *current* code before changing any `<script>` tag or build step.
- **Permissions / Admin nav (Part 6):** the role-gated admin menu assumes an
  `isAdmin`-style check. Use whatever the code actually exposes; do not invent a
  permission model.
- **Perceived-speed caching (Part 5):** stale-while-revalidate writes to
  `localStorage`. Confirm there is no PII in the Overview payload before caching it
  client-side; if unsure, **don't cache** — that's the cautious default.

---

## What's in the package

| File | What it is |
|---|---|
| `Design Deep-Dive.dc.html` | Before → after redesigns of every screen: Overview, My Department (table + QCD + Missed), Individual report, Insights report, and the admin pages (Inbound, Alerts, Outlier Fix, Caller Lookup, Dept Config). Plus three dept-tile directions (status rail recommended). |
| `System Additions.dc.html` | The surfaces around the reports: daily digest email, navigation, empty/error/no-data state kit, dark-mode render, first-run / unmapped-queue onboarding. |
| `Loaders.dc.html` | Loader coverage map (what exists, what's weak, what's missing) and five themed, animated busy-states mapped to use cases. |
| `Component Handoff.dc.html` | The consolidated developer spec, Parts 1–9: tokens, component layer, consolidated report IA, charts, perceived speed, navigation, loaders, surrounding surfaces, and motion — each with paste-ready CSS/JS. **Start here for implementation.** |
| `support.js` | Runtime required to open the `.dc.html` files in a browser. Keep it alongside them. |

> **Viewing:** open any `.dc.html` file directly in a browser (with `support.js` in
> the same folder). They are static — no build step, no network calls.

---

## Suggested implementation order

1. **Part 1 (tokens) + Part 2 (components)** — non-breaking and additive; everything
   else builds on it. Migrate **one** report to the `ds-` components as a proof,
   then proceed report-by-report.
2. **Part 7 (loaders)** and **Part 5 item 1 (stale-while-revalidate)** — independent
   quick wins.
3. **Part 9 (motion)** — layer onto components once they're in.
4. **Part 6 (navigation)** — a light refactor of the existing top bar (top-bar nav
   for managers; Admin behind a role-gated menu — *not* a persistent rail).
5. **Part 3 (consolidation)** — the one product decision; discuss before building.

At every step, the governing principle above takes precedence. If implementing a
step would require changing behavior or data and that change is not obviously
correct, stop and surface the conflict with options rather than proceeding.
