# Handoff: Email styling (Call Note + PPD)

Restyle of the server-built HTML emails. **Email uses the company brand navy `#223b5d`** — intentionally distinct from the in-app editorial green. Builders live in `Code.js`: `buildCallNoteEmailHtml_` (+ `renderShippingDetailsHtml_` / `renderResupplyDetailsHtml_` / `renderOopDetailsHtml_`) and `intakeBuildPpdBodyHtml_` / `intakeRecListHtml_` / `intakeBuildAcctBodyHtml_`.

Reference mocks (open in a browser): `Email Templates.dc.html` (final Call Note + PPD) and `Email Templates — Call Note variants.dc.html` (the four update themes).

## Email-safe rules (keep)
Table layout (no flex/grid), all-inline styles, literal hex (no `var()`), system font stack (`Arial,Helvetica,sans-serif`; the current `'Inter'`-first stack is harmless but won't render — falls back), ≤600px single column, badges as `inline-block` spans, buttons as padded `<a>`. **No `display:flex`, `gap`, or `filter`** — Outlook drops them.

## Call Note email — modernized pass on the original
Keep the original's structure (logo bar, "Update for {patientAndTrx}" heading, intent banner, navy **Call Details** table, mono footer) — just modernized:
- **Logo bar**: wordmark + 2px navy underline (or the real logo image), rounded 8px container.
- **Title**: "Update for … · TRX" in navy `#223b5d`, intro line muted, optional flag pills (Action `#fbf1d9`/`#8a4500`, Training `#e1ecfa`/`#154980`, Review `#e4f5ec`/`#0b6e40`).
- **Callback banner**: `#fbf1d9` bg, `#b7791f` left rail, `#8a4500` text (when `callbackNeeded`).
- **Update banner** — themed per template (this is the only chrome that changes color):

| Template | color / soft / deep | extra detail block |
|---|---|---|
| Default (status check) | navy `#223b5d` / `#eef2f7` / `#223b5d` | — |
| Verified Shipping · Repeat Resupply | green `#0f8a52` / `#e4f5ec` / `#0b6e40` | shipping/resupply detail card |
| OOP Order | amber `#b7791f` / `#fbf1d9` / `#8a4500` | OOP detail card + total; generated resolution |
| Close Order | red `#c13030` / `#fce5e5` / `#8a1f1f` | reason line |

- **Call Details table**: navy header band (`#223b5d`, white, uppercase), alternating rows `#ffffff` / `#f5f7fa`, label column navy-bold. Rows: Callback Number, Caller Name, Relationship, Patient & TRX (bold), Issue, Transferred To, **Resolution**.
- **Resolution row highlighted in place** (not split out): `background:#eef2f7`, `border-left:3px solid #223b5d` on the label cell.
- Footer: mono, `#a5acb8`, "UMS Team Tools · Call Notes".

The subform builders (`renderShippingDetailsHtml_` etc.) should adopt the themed-tinted detail-card look (soft bg + matching border, uppercase label row) — see the variants mock.

## PPD recommendation email — two required fixes
The mock leads with the **completed questionnaire**, then recommendations (matches `intakeBuildPpdBodyHtml_` order).

**1. Detable the recommendation list (functional — `intakeRecListHtml_`).** It currently uses `<li style="display:flex;…;gap">` + `filter:grayscale` for rejected — breaks in Outlook. Rebuild each product as a **2-cell table row** (image cell + content cell); grey rejected with explicit `background:#f6f7f9; color:#a5acb8;` (no filter). Star-preferred in app amber `#b7791f`.

**2. Pull colors onto the palette (drift).** Current builders hardcode Material/Google/Atlassian hexes. Map:

| Current | → Use |
|---|---|
| Complex `#b71c1c` / Standard `#1565c0` headings | navy `#223b5d` |
| Accepted `#e6fffa`/`#00875A`/`#b3f5e1` | `#e4f5ec` / `#0b6e40` / `#abdfc4` |
| Rejected `#ffebe6`/`#DE350B`/`#ffbdad` | `#fce5e5` / `#8a1f1f` / `#f3d4d4` |
| Undecided `#e2e8f0`/`#334155` | `#fbf1d9` / `#8a4500` |
| Unconfirmed `#f4f5f7`/`#888` | `#f6f7f9` / `#737c8c` |
| Link `#1a73e8` | `#1e63b8` |
| Star `#FFD700` | `#b7791f` |
| Alt row `#e6f2ff` | `P.brandSoft` (matches Call Note) |
| Borders `#ccc`/`#ddd`/`#999` | `#dce0e7` |

Same for `intakeBuildAcctBodyHtml_`: checkbox `#FFC107`/`#00875A` → `#b7791f`/`#0f8a52`; audit the layout `CONDITIONAL_FORMATTING_ROWS` `rule.bg/fg` constants. Also check **`intakePpdAnswerStyles_()`** (`s.red/green/gray/yellow`) → `#c13030` / `#0f8a52` / `#737c8c` / `#b7791f`.

**Questionnaire answer table** (the bulk of the email): navy section header bands, label col + centered answer, alternating `#ffffff` / `#f5f7fa`, color-coded answers (Yes `#e4f5ec`/`#0b6e40`, No `#fce5e5`/`#8a1f1f`, severity Moderate `#fbf1d9`/`#8a4500` & Severe `#fce5e5`/`#8a1f1f`, None muted, N/A italic `#a5acb8`).

## Root pattern
Both email families should route **all** color through one palette constant (extend `CN_EMAIL_PALETTE` with the semantic badge pairs) rather than inline literals — that's what let these accumulate off-system colors. Navy stays the brand; semantic colors come from the shared set.
