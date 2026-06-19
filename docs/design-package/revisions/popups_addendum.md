# Addendum: In-app pop-up fixes

Small, self-contained refinements to the existing pop-up layer (modals / toasts / `uiConfirm`).
The system is already unified and on-brand — these are corrections, not a redesign.

## 1. Toast type normalization (real bug)
`showToast(msg, type)` is called two ways: most modules pass the full class (`'toast-success'`/`'toast-error'`/`'toast-warn'`), but **Training passes bare names** (`'success'`/`'error'`/`'warn'`/`'info'`). If `showToast` doesn't normalize, Training's toasts render with **no colored accent rail**.
- Normalize inside `showToast`: `var cls = /^toast-/.test(type) ? type : (type ? 'toast-' + type : '');`
- Add a **`.toast-info`** rule (none exists today, yet `'info'` is used by the Training quiz-import flow):
  ```css
  .toast-info { box-shadow: inset 3px 0 0 var(--info), var(--shadow-sm); }
  .toast-info .toast-icon { color: var(--info); }
  ```
- Confirm each `showToast` injects the matching glyph (check / × / triangle / info) — the `.toast-icon` color rules exist but the icon must actually be emitted.

## 2. Unify overlay entrance with the motion system
Static modals (`modals.html`) already slide-up via `modal-enter` + `fadein`. The JS-built `ensureOverlay` overlays (Training reader/quiz/quiz-editor, CN composer/external-email/form-submission) may just appear. Route them through the same entrance as motion §9 ("Rise + fade") so every overlay in the app enters identically — add the `.overlay.open`/`.modal` animation to whatever wrapper `ensureOverlay` produces.

## 3. Token mismatch (cosmetic)
`.day-info-row.holiday` and `.day-info-row.own-approved` pair `--accent-soft` (green) background with `--info-deep` (blue) text. Pick one tone — either `--info-soft` + `--info-deep` (blue) or `--accent-soft` + `--success-deep` (green). Same family as the Call Notes TRX-badge mismatch already noted.

## 4. Reduced motion
The `@media (prefers-reduced-motion: reduce)` block from `loaders_and_motion.md` also neutralizes modal/toast animation — make sure it lands once in `styles.html`.

Files touched: `index.html` (or wherever `showToast`/`uiConfirm` live), `styles.html`, the `ensureOverlay` helper, and the `modals.html` consumers. No data-flow changes.
