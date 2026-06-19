# Addendum: New tabs, off-style controls & Time-Clock emails

Follow-on work after the second implementation review. References:
`Team Training Redesign.dc.html`, `Punctuality Redesign.dc.html`,
`Email Templates - Time Clock (hybrid).dc.html`.

---

## 1. Off-style controls — shared fix (confirmed bugs)

The only global form rule in `styles.html` is `button, input, select, textarea { font-family: inherit; font-size: inherit; }` (fonts only). So any control rendered **without a class** falls back to OS chrome — this is the "computer-default gray button / native date box" the review flagged.

**1a. Undefined `.btn` / `.btn-sm` → gray default button.**
`metrics/script_metrics.html` renders the range **Refresh** buttons as `<button class="btn btn-sm">`, but no `.btn`/`.btn-sm` rule exists (only `.btn-clockin`, `.btn-modal-ok`, …). Swap to the shared **`.refresh-btn`** (already defined in `styles.html`). Grep the repo for any other `class="btn ` / `btn-sm` and fix the same way.

**1b. Oversized full-width black "Load" button.**
The **Punctuality** and **Coverage** views (`tc/script_manager.html`) render Load as a full-bleed ink bar (it's `.btn-modal-ok`-style stretched to 100%). Make it a normal inline button beside the date fields — ink-on-paper, auto width, ~`9px 18px` padding. (See the redesign mocks.)

**1c. Bare `<input type="date">` / `<select>`.**
Classless instances show native OS pickers: `metrics/script_metrics.html` (`#m-my-date`, `#m-my-from`, `#m-my-to`, `#m-team-from`, `#m-team-to`); bare `<select>` without an `appearance` reset in `cn/script_deptrequests.html` (`.dr-input`) and the training quiz-editor (`#tr-qed-kb`).
**Systemic fix:** add a shared field baseline to `styles.html` and apply it to the bare instances:
```css
.field, input[type=date].field, input[type=text].field, select.field {
  font: inherit; padding: 7px 10px; border: 1px solid var(--line);
  border-radius: var(--radius); background: var(--paper); color: var(--ink);
}
select.field { appearance: none; background-image: <chevron>; padding-right: 28px; }
.field:focus { border-color: var(--accent); box-shadow: var(--ring-focus); outline: none; }
```

---

## 2. Team Training manager view — put the bottom half on cards
Ref: `Team Training Redesign.dc.html`. `trainRenderMgr_` (`train/script_training.html`).

The telemetry strip + assign form are already carded; the sections **below** render bare on the page background:
- **Completion matrix** — wrap in a `.panel`-style card with a `seclabel` title + a "N rep · N item" count badge. **Fix the sprawl:** the grid currently uses fixed track widths inside a full-width container, so a 1-item matrix flings the lone cell + Cov to the far right. Set the grid to `width: max-content` (or `display:inline-grid`) and left-align it so cells sit next to the employee name. Render the Done state as a filled accent chip, not a bare check.
- **Active assignments** — card + titled label + count badge; keep the table.
- **Quizzes** — card + label + count; give the empty state a real placeholder (dashed well: "No quizzes yet — …") instead of a lone "New quiz" button.
- **Quiz analytics** (when present) — same card treatment.
Assign-form `<select>`/date use the shared field style from §1c (custom chevron).

---

## 3. New "Punctuality" tab — fill it in
Ref: `Punctuality Redesign.dc.html`. (`tc/script_manager.html`, the punctuality view.)

The page is sparse and has the §1b Load-button issue. Changes:
- **Controls row:** From/To + a normal Load button + 7d/30d/QTR presets (mirror Metrics' preset row).
- **Stat strip → 4-up:** Team on-time · Reps · **Avg late** · **Worst** (the two new cells use data already in the table, and stop the 2-cell sprawl).
- **Table in a card** with a titled label.
- **Tri-tone on-time** (reuse `mPctClass_`/thresholds) + a per-rep **adherence bar**; color-grade Avg/Worst late; lunch-on-time as a chip.
- Move the description up beside the title.

---

## 4. "Spanish Inbox" tab — still a stub
`script_core.html` registers `metricsSpanish → enterSpanishInboxView` (manager-only), but **no `enterSpanishInboxView` exists in any client file** and `metrics/script_metrics.html` has no Spanish/Inbox code or styles — clicking it errors. Decide intent (a manager inbox of Spanish-language call-note / intake submissions?) and either build the view or pull it from the registry. A design pass is pending that decision — no mock yet.

---

## 5. Time-Clock notification emails — were NOT redesigned
They shipped plain (not part of the Call Note / PPD email pass). Three mocked directions:
- `Email Templates - Time Clock.dc.html` — strict **company navy** (conservative).
- `Email Templates - Time Clock (app style).dc.html` — full **Console** green/paper.
- **`Email Templates - Time Clock (hybrid).dc.html` — CHOSEN.** Navy keeps the official cue (wordmark, header rule, table header band); green + mono labels + soft chips bring the Console warmth; the primary action is the app accent.
Covers the **missed-punch employee alert** and the **manager daily digest**. Email-safe (tables, inline hex, system stack). Server builders to target: `sendDailyMissedPunchAlerts` + the digest senders in `Code.js`. Build the hybrid as the target.
