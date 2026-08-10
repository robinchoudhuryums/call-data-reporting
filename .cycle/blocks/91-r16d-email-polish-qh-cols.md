# Increment 91 — R16d: Daily Queue Report email polish + Queue-health columns

Owner batch (2026-08-10), answering the two open threads from increment 90.

## Daily Call Queue Report email (QueueReportEmail.gs)

- **'Daily Company Aban %'** retitle; the VALUE is tier-colored — green
  ≤3%, amber (C.watch) 3–4%, red >4% (`gValColor`). The tile BACKGROUND
  keeps its existing ≥5% tint (two different thresholds on purpose: the
  value narrates the owner's finer bands, the background still flags the
  company 5% standard).
- **Every KPI card centers its content** (`align="center"` +
  `text-align:center` in `kpi()`): the sub-line-less "Queues in viol."
  card read awkward left-aligned, and centering only it would have broken
  the row's symmetry.
- **Banner-only single-queue collapse RETIRED**: every queue now renders
  its own data row beneath the section banner, so the visual TALLY (which
  only queue rows carry) appears for every queue — not just sub-queue
  depts. Banner keeps the section rollup; some numbers repeat on
  single-queue sections (accepted; the old dedup was why the tally went
  missing). The banner no longer carries the inline queue name or the
  ride-along pace line.
- **MTD pace line prior value gets '/day'** — "MTD Ø 110/day · Jul
  100/day ▲ 10.0%" (a bare "Jul 100" read as a date). Same fix on the web
  twin `qMtdSub` in script-11-qcd-boot.html.
- tests/unit/queue-report.test.js pins updated to the new contract (37
  pass): banner no longer carries the queue name (queue string appears
  exactly once), pace-line format with both '/day's, and the clean-banner
  Viol-cell pin re-targeted by its `padding:8px 12px` signature (the old
  `</table></td><td>0<` regex now also matched legitimate queue rows).
- Mocks rendered from the REAL builder via the unit harness
  (scratchpad gen-queue-email-mock.js → playwright screenshots):
  full email + a 3-tier strip of the company-aban card.

## Queue-health columns (R16d, Insights region)

- The 3 KPI tiles STACK in a left third beside the per-queue table
  (right two-thirds): `.ins-qh-cols` flex row in dashboard.html,
  `align-items:flex-start` so the table's variable height is moot; the
  secondary stat strip sits under the tiles. ≤900px stacks the columns
  AND returns the tiles to a horizontal 3-across grid in ONE media query
  (probe verified both: wide sameRow 340/1028px, narrow wrapped+grid).
- ⚠ CLASS-COLLISION TRAP (probe caught it): `.ins-qh-row` is ALREADY the
  queue table's `<tr>` class from `insRenderQueueHealth_`'s row builder —
  a flex rule there wrecks the table rows. Hence `.ins-qh-cols`;
  documented in the CSS comment + client-ui-conventions.
- Rationale for going ahead (owner asked for advice-or-mock): the 3
  tiles filled only half the 6-col `.pr-kpi-row` grid and the 5-col
  table was mostly whitespace — the pairing reclaims a screen of
  vertical space. Mock sent (mock-qh-row.png).

Gates: node --test 0 fail (queue-report 37), INV-16 clean,
ci:ui 24+16+30+14. Docs: client-ui-conventions R16c bullet extended
with the R16d layout + the class trap.

**WHERE I LEFT OFF:** committed on claude/broad-scan-l9ojgm, pushed.
No PR (owner asks explicitly). Awaiting owner verdict on the email mock
(tier colors / centered cards / per-queue tallies / '/day' pace) and the
queue-health column mock.
