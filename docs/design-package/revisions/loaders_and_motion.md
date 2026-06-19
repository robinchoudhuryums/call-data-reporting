# Handoff: Loader + Motion system

A unified set of loading states and purposeful micro-animations for the whole web app.
References: `Loader Options.dc.html` (the 6 loader candidates) and `Motion Demo.dc.html`
(all 10 effects, interactive). Decisions are baked into this doc.

**Principles (apply to everything below):**
- UI transitions ≤ 200ms; content reveals are one-shot (never looping).
- CSS-only where possible — animate `transform` / `opacity` / `stroke-dashoffset` only (GPU-cheap; safe on the Apps Script webview).
- Drive reveals with keyframe `animation` + `animation-fill-mode: both` (visible end-state baked in) — NOT transition-on-a-JS-class (those can stick).
- Replay reveals on scroll-into-view via one shared `IntersectionObserver`, not just at load (lower content otherwise animates off-screen before it's seen).
- Reuse the existing tokens: `var(--accent)`, `var(--line)`, `var(--paper-2/3)`, `var(--ease)` (= cubic-bezier(.4,0,.2,1)), `var(--t)` (180ms).
- Global kill-switch: wrap nothing — instead add the `@media (prefers-reduced-motion: reduce)` block once (below) in `styles.html`.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration:.001s!important; transition-duration:.001s!important; }
}
```

---

## PART 1 — LOADER SYSTEM

Today there are four parallel idioms (see audit). Collapse to ONE shared set with four roles.
All share two custom props so they theme in dark mode automatically (map to the app tokens):

```css
:root { --lo-accent: var(--accent); --lo-track: var(--line); }
@keyframes lo-spin  { to { transform: rotate(360deg); } }
@keyframes lo-dot   { 0%,80%,100%{ transform:scale(.5); opacity:.4; } 40%{ transform:scale(1); opacity:1; } }
@keyframes lo-bar   { 0%{ left:-40%; } 100%{ left:100%; } }
@keyframes lo-shimmer { 100% { background-position:200% 0; } }
@keyframes lo-pulse { 0%,100%{ transform:scale(.82); opacity:.45; } 50%{ transform:scale(1); opacity:1; } }
```

### Role A — Full-view enter → **Glyph pulse** (chosen)
The module's own icon, pulsing, + a mono label. Replaces BOTH `renderLoading()`/`.state-center`
AND the `.m-loading` idiom. Fold both into one helper so every tool enters the same way.

```css
.lo-glyph { color: var(--lo-accent); animation: lo-pulse 1.25s var(--ease) infinite; display:inline-flex; }
```
Extend the existing `renderLoading(area, msg, iconName)` to emit:
`<div class="state-center"><span class="lo-glyph">${icon(iconName, 30)}</span><div class="state-label">${esc(msg)}</div></div>`
Pass each tool's icon: Intake `clipboardList`, Time Clock `clock`, Call Notes `mail`/`list`, Metrics `chart`, Training `check`, Reference `fileText`.

### Role B — Lists / tables / cards → **Skeleton shimmer** (chosen)
Replaces the text-only `.cn-stack-empty` "Loading…" and the pop-in slots.
```css
.skel { border-radius:6px; background:linear-gradient(90deg, var(--paper-3) 25%, var(--paper-2) 37%, var(--paper-3) 63%); background-size:200% 100%; animation: lo-shimmer 1.3s linear infinite; }
```
Emit a few skeleton rows shaped like the real content (avatar circle + 2 text bars for note stacks; header row + N cells for tables). Cross-fade to real content when it arrives (see Motion §2).

### Role C — In-place refresh → **Sweep bar** (chosen)
Content stays visible; a thin indeterminate bar sits at the panel top. Replaces the repeated
bare `<div class="spinner" style="margin:24px auto">` in admin panels / coverage body / intake Sent.
```css
.lo-sweep { position:relative; height:3px; border-radius:999px; background:var(--lo-track); overflow:hidden; }
.lo-sweep::after { content:''; position:absolute; top:0; bottom:0; width:40%; border-radius:999px; background:var(--lo-accent); animation: lo-bar 1.15s var(--ease) infinite; }
```

### Role D — Buttons / tiny slots → **Dot pulse** (or the existing ring)
Replaces ad-hoc "Sending…/Saving…/Filing…" text-only swaps with a consistent inline mark
(keep the word too; just prepend the dots). Keep the existing `.spinner` ring as the universal small fallback.
```css
.lo-dots { display:inline-flex; gap:5px; vertical-align:middle; }
.lo-dots span { width:6px; height:6px; border-radius:50%; background:currentColor; animation: lo-dot 1.4s var(--ease) infinite; }
.lo-dots span:nth-child(2){ animation-delay:.18s; } .lo-dots span:nth-child(3){ animation-delay:.36s; }
```

### Loader call-site conversions
- **Unify full-view:** `web-app/metrics/script_metrics.html`, `web-app/train/script_training.html`, `web-app/train/script_empdocs.html` → replace `.m-loading` markup with `renderLoading()` (Role A).
- **Skeletons (Role B):** `web-app/cn/script_callnotes.html` — the ~6 `.cn-stack-empty` "Loading…" spots (history stack, mgr results, reps, stats body, search). Also `web-app/tc/script_clock.html` — the silent `#teammate-card-slot` and `#ribbon-hist`, and the coverage strip.
- **Sweep (Role C):** CN admin panels (augment/trends/audit/storage/health/enroll), `tc/script_manager.html` `#cov-body`, `intake` Sent list — replace inline `.spinner` blocks.
- **Missing loaders:** add Role B skeleton to the Clock async slots above (currently pop in), and a `renderLoading` on the **initial** `loadManagerDashboard()` enter (only the refresh path has one today).
- **Keep as-is:** the `.cn-compose-loading` bobbing-envelope moment, and the `.tr-spin` inline button spinner.

---

## PART 2 — MOTION SYSTEM

Shared easing: `--ease: cubic-bezier(.4,0,.2,1)`. Reveal cards get a class + are observed by one
shared IntersectionObserver (threshold ~.35) that re-applies the animation on scroll-in:
```js
const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) {
  e.target.querySelectorAll('.js-anim').forEach(el => { el.style.animation='none'; void el.offsetWidth; el.style.animation=''; });
}}), { threshold: .35 });
// observe each reveal container after render
```

### 1 · View transition → **Fade + rise** (chosen)
Global: every view-area swap. Apply to the content wrapper each tool renders into.
```css
@keyframes revFade { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
.view-enter { animation: revFade .18s var(--ease) both; }
```
Hook once in the central view router (`showView`/`enterX`) so it's automatic for all tools.

### 2 · Skeleton → content handoff
When real content replaces a skeleton, cross-fade (don't hard-swap). Pairs with Loader Role B.
```css
@keyframes skelOut { 0%,68%{ opacity:1; } 100%{ opacity:0; } }
@keyframes realIn  { 0%,68%{ opacity:0; } 100%{ opacity:1; } }
.sk-skel { animation: skelOut 1.25s var(--ease) both; }   /* overlay */
.sk-real { animation: realIn  1.25s var(--ease) both; }
```
(In practice: render skeleton, then on data arrival render real content with `.sk-real` and let the skeleton fade out.)

### 3 · Ring fill — Training completion + Clock PTO
```css
@keyframes ringFill { from { stroke-dashoffset: var(--circ); } to { stroke-dashoffset: var(--target); } }
.ring-arc { stroke-dashoffset: var(--target); animation: ringFill .9s var(--ease) both; }
```
Set `--circ` (= 2πr) and `--target` (= circ·(1−pct)) inline per ring; `stroke-dasharray` = circ.

### 4 · Sparkline draw + count-up — Metrics hero/rail + Stats
```css
@keyframes sparkDraw { from { stroke-dashoffset: var(--len); } to { stroke-dashoffset: 0; } }
.spark { stroke-dasharray: var(--len); stroke-dashoffset: 0; animation: sparkDraw 1s var(--ease) both; }
```
Set `--len` ≥ the polyline's `getTotalLength()`. Count-up the hero number with a small rAF tween
(ease-out cubic, ~900ms) triggered by the same IntersectionObserver — recapture `start` per run so a
backgrounded tab doesn't make it snap.

### 5 · Grid stagger-in — Coverage heatmap + Training matrix
```css
@keyframes hmIn { from { opacity:0; transform:scale(.5); } to { opacity:1; transform:none; } }
.hm { animation: hmIn .25s var(--ease) both; animation-delay: var(--d, 0ms); }
```
Set `--d: <cellIndex * 14>ms` inline; cap total stagger < ~350ms.

### 6 · Mutation feedback → **Settle** (chosen; not collapse)
On resolve / mark-complete / accept: dim + tint the row in place, draw a check, strike the label.
Keeps the row (good for undo affordance / context).
```css
.mc { transition: opacity .3s var(--ease), background .3s var(--ease); }
.mc.done { opacity:.72; background: var(--paper-card); }
.mc.done .mc-label { text-decoration: line-through; color: var(--muted-3); transition: color .3s var(--ease); }
@keyframes drawCheck { to { stroke-dashoffset:0; } }
.ck { stroke-dasharray:24; stroke-dashoffset:24; }
.mc.done .ck { animation: drawCheck .35s var(--ease) forwards; }
```
Sites: Training "Mark complete", PPD accept→star, CN flag resolve. (Pairs with optimistic writes already in place.)

### 7 · Selection & copy
```css
@keyframes pop { 0%{transform:scale(1);} 42%{transform:scale(1.15);} 100%{transform:scale(1);} }
.chip.popping, .star.on { animation: pop .28s var(--ease); }   /* star uses a 1.32 scale variant */
@keyframes flashBg { 0%{ background:var(--accent-soft);} 100%{ background:transparent;} }
.copybtn.copied { animation: flashBg .7s var(--ease); }         /* swap label to "Copied ✓" for ~1.3s */
```
Sites: Intake severity chips + CN flag rail (pop); PPD recommendation star; ⌘C copy-anywhere (CN) + recommendation-code copy (Intake) → copy flash (also helps ⌘C discoverability).

### 8 · Collapse — KB department / CN trays
```css
.acc-body { max-height:0; opacity:0; overflow:hidden; transition: max-height .26s var(--ease), opacity .26s var(--ease); }
.acc.open .acc-body { max-height: 240px; opacity:1; }           /* set a max ≥ tallest content */
.acc-chev { transition: transform .2s var(--ease); }
.acc.open .acc-chev { transform: rotate(90deg); }
```
Sites: KB department collapse (already collapsible — add the transition + chevron rotate), CN pinned tray + training-Q&A tray.

### 9 · Overlay entrance → **Rise + fade** (chosen)
One shared pattern for every drawer/modal (reference drawer, quiz, reader, day-edit, composer overlays).
```css
.ov { opacity:0; pointer-events:none; transition: opacity .2s ease; }
.ov.open { opacity:1; pointer-events:auto; }                    /* backdrop fade */
.ov .sheet { transform: translateY(14px); opacity:0; transition: transform .22s var(--ease), opacity .22s var(--ease); }
.ov.open .sheet { transform:none; opacity:1; }
```

### 10 · Timezone sky cross-fade — Clock big-clock card
Stack the phase gradients as absolute layers; on tz change toggle `.on` (opacity) instead of swapping
the background, so the sky cross-fades between phases.
```css
.sky-layer { position:absolute; inset:0; opacity:0; transition: opacity .6s ease; }
.sky-layer.on { opacity:1; }
```

---

## Notes for the implementer
- Add the loader keyframes/classes and the reduced-motion block to `styles.html` (shared), and the per-tool reveal hooks in each module.
- The one IntersectionObserver can live in the shell (`script_core.html`) and observe any `[data-reveal]` container a tool renders — keeps it DRY.
- Verify motion in a **foreground** tab: browsers freeze animation clocks + rAF while a tab is backgrounded (this is also why a load-only count-up can snap — the scroll-into-view trigger avoids it).
- Run `Tests.js` after; none of this changes data flow, but the view-router hook (effect 1) touches every tool's enter path.
