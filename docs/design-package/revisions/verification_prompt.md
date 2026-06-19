# Verification prompt — check the redesign review against the codebase

Paste the block below into the Code session. It asks Code to confirm/deny each
open item from the design review against the actual repo, and fix the clear bugs.

---

You are auditing the UMS Team Tools web app (`web-app/`) against a design review. For each item: report **status** (confirmed / already-handled / not-applicable) with the file+line evidence, then apply the fix where one is called for. Don't change behavior beyond what's described. Run `Tests.js` when done.

**A. `.btn` / `.btn-sm` is undefined → OS-default gray buttons (confirmed bug).**
`metrics/script_metrics.html` renders the range **Refresh** buttons as `<button class="btn btn-sm">` (the My Stats control row and the Team Metrics control row). Grep `styles.html` — there is no `.btn` or `.btn-sm` rule (only `.btn-clockin`, `.btn-modal-ok`, etc.), so these render as raw browser-default buttons. Every other module uses the shared `.refresh-btn` (defined in `styles.html`). Fix: swap `class="btn btn-sm"` → `class="refresh-btn"` on those buttons. Then grep the whole repo for any other `class="btn\b` / `btn-sm` usages and fix the same way.

**B. Bare date inputs / selects fall back to OS styling (confirmed).**
The only global form rule in `styles.html` is `button, input, select, textarea { font-family: inherit; font-size: inherit; }` — fonts only, no visual styling. So any `<select>` or `<input type="date">` rendered **without a class** shows native OS chrome, while classed ones (`.cn-history-range input[type=date]`, `.tr-assign select`, `.clk-tz-pill`) look on-system. Confirm these unstyled instances and bring them onto a shared style:
  - `metrics/script_metrics.html`: `#m-my-date`, `#m-my-from`, `#m-my-to`, `#m-team-from`, `#m-team-to` (all classless `<input type="date">`).
  - bare `<select>` without an `appearance` reset (native chevron): `cn/script_deptrequests.html` `.dr-input`, training quiz-editor `#tr-qed-kb`, and check others.
  Recommended systemic fix: add a shared field baseline in `styles.html` — e.g. a `.field` class (or element selectors scoped to the app shell) for `select, input[type=date], input[type=text]` using `--line` border, `--radius`, `--paper` bg, `--ink` text, `appearance:none` + a custom chevron for selects, and `:focus { border-color:var(--accent); box-shadow:var(--ring-focus); }` — then apply it to the bare instances above.

**C. "Spanish Inbox" tab appears to be an unimplemented stub.**
`script_core.html` registers `metricsSpanish: { label:'Spanish Inbox', enter:'enterSpanishInboxView', managerOnly:true }`, but **`enterSpanishInboxView` is not defined in any client file**, and `metrics/script_metrics.html` contains zero `Spanish`/`Inbox` references — no view function, no styles. Confirm: does `enterSpanishInboxView` exist anywhere (client or generated)? If not, clicking the tab errors. Report what the tab is intended to show so a design pass can be built; until then it needs either an implementation or removal from the registry.

**D. "Team Training" manager view looks incomplete (needs eyes on a live render).**
`trainRenderMgr_` in `train/script_training.html` is code-complete: status strip (`.telemetry`/`.tel-cell`, defined in `styles.html`), styled assign form (`.tr-assign select/input` are styled), completion matrix, active assignments, quizzes, quiz analytics. I can't reproduce "incomplete" from source. Check the **live** render for: (1) the empty-data state (no assignments yet → only the assign form + "No training assigned yet" empty state — may read as sparse); (2) native `<select>` chevrons on `#tr-as-item` (no `appearance` reset); (3) any class referenced in the render but missing from CSS. Report what's actually missing.

**E. Open items carried from the prior review (confirm status):**
  1. **Loader unification not rolled out** outside Intake's Sent tab. `metrics/script_metrics.html` still uses `<div class="m-loading"><div class="spinner">`; KB / Coverage / CN admin panels still use raw `<div class="spinner">`. Confirm and roll out the `loaders_and_motion.md` roles (glyph-pulse full-view via `renderLoading`, `loSweep()` for in-place refresh, skeleton for lists).
  2. **`showToast` type normalization + `.toast-info`.** `train/script_training.html` and `train/script_empdocs.html` call `showToast(msg, 'error'|'success'|'warn'|'info')` with **bare** names; other modules pass `'toast-error'` etc. Confirm whether `showToast` (in `index.html`/`script_core.html`) normalizes the prefix — if not, Training/Docs toasts lose the accent rail. Also confirm a `.toast-info` rule exists (`'info'` is used by quiz-import/doc-verify); if missing, add it.
  3. **Lingering hex fallbacks** the cleanup note asked to drop: `var(--danger-deep, #c13030)` (training ×4), `var(--danger, #c13030)` (`.kb-btn`), `var(--warning-deep, var(--warn))` (coverage). Note `#c13030` is actually `--destructive` (`#8a1f1f` is `--danger-deep`), so a fallback render is the wrong shade. Replace with the bare token.
  4. **Dead Stats-card CSS** in `cn/script_callnotes.html` (`.cn-stats-grid-outer`, `.cn-stats-card`, `.cn-stats-head`, `.cn-stats-name`, `.cn-stats-span`, `.cn-stats-total`, `.cn-stats-total-lbl`, `.cn-stats-grid`, `.cn-stats-row`, `.cn-stats-k`, `.cn-stats-v`) — the Stats tab now renders via `mtRenderTable_`. Confirm unreferenced, then delete. Keep `.cn-stats-name-link` and `.cn-stats-foot-note`.
  5. **Coverage all-clear callout** uses `data-tone="sage"` — confirm `sage` is a defined `.panel[data-tone]` variant (the understaffed case uses `destructive`, which exists).
  6. **Clock histogram** (`.ribbon-hist`) buckets today's **notes** by hour, not CDR call volume — confirmed intentional; just verify the UI label isn't claiming "call volume."

(The off-token purple/orange/blue category tints in the Intake module are **intentional** — do not change.)
