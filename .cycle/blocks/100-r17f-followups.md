# Increment 100 — R17f: follow-ups on the R17e round

Three owner items, all verified in the harness + email mock.

## Panel-1 values bigger

`.dept-side .dept-qcd-value` 15px → 18px. R17c shrank it to fit the
one-line "60 (58 / 2)"; the split has been on its own line since that
same round, so the value line is just the number and takes the size.

## Email tally: wider column, fatter blocks

The owner is right that the Viol column had slack: the "Abandoned %"
header cell is now `width="190"` (was 150), and the block cells go back
to 4px (+1px gap) from R17e's 3px slivers. The 25-block ceiling and the
20-calls/block landing are unchanged — 25 × 5px = 125px + the ~45px %
label + padding = 186px, just inside the wider column. Measured after:
uniform 4px blocks across rows of 6–20 blocks. Pins re-targeted
(width="4"). The constraint comment now states the full budget math so
the next person can re-derive it instead of trusting a stale number.

## Lens rows: meaningful grouping found for BOTH tables

- **Missed rings: consecutive same-parentId rings render as a connected
  run** — warm rail + tint, the id badge once, "rang N×" on the first
  row. This is the R17a agent-card grouping applied to the day-drill
  lens, and it directly serves the two-lens reconciliation story: a
  3-ring run on the left IS one abandoned call on the right. Adjacency
  is the grouping key on purpose — a same-id ring much later is a
  re-rung call and reads better as its own event.
- **Abandons: a stage tick per row** (`.hd-stage`) color-codes where the
  caller gave up — warm = in queue, accent = on hold (an agent had
  answered), muted = IVR (company view only). Deliberately redundant
  with the row's facts text (colorblind-safe).

## Gates

661/661 unit (queue-report 39/39 after the width="4" re-target), INV-16
green, UI gate re-run green (confirm counts in STATE). Probed: value
font 18px, runs 10×"rang 2×" with one badge each, stage dots 3 queue +
1 hold, panel/carousel widths unchanged from the R17e fix.

## Where I left off

Committed + pushed; PR on the owner's word (R17e + R17f ride together).
