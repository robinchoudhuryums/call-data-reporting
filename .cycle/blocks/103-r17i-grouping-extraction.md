# Increment 103 — R17i: one definition of "these rings are one call"

Closes the objective half of R17h's follow-on. The owner asked whether it
was an objective improvement or a taste call; the answer split cleanly, and
only the objective half was done.

## What was actually duplicated

The RULE — consecutive entries, same `parentId`, same `date` — was written
twice: `missedAgentsHtml_` (agent cards) and `missedSliceListHtml_` (the
four drills). Nothing made the copies agree. Change the key in one place
(drop the date, decide non-adjacent rings should also group) and the two
surfaces silently disagree about what one call IS, while both still render
something plausible. Same drift class as INV-16's byte-identical guard; a
shared pure function is the cheap version of that discipline.

`groupConsecutiveByCall_` (script-1-core.html) returns runs
(`{start, end, length, isRun}`) covering the input exactly and renders
nothing. Both callers now slice by `[start, end)` and phrase their own
markup.

## What was deliberately NOT unified

The renderings. Every difference traces to a decision: the card has no
visible "rang N×" (owner, R17a: hover only) and puts the siren + id badge
on the LAST ring; the lens shows the count and puts them on the FIRST row.
Unifying those would overturn an owner ruling.

The two also consume DIFFERENT sequences, so the runs mean different
things — a card iterates ONE agent's rings (a run is that agent rung
repeatedly), a lens iterates a slice sorted chronologically ACROSS agents
(`missedSliceFilter_` pushes every agent's + queue's entries, then sorts by
date/sortKey), so a run there can span agents. That asymmetry is why the
helper returns runs instead of markup.

## Verification: A/B, not eyeballing

Probe counts moved between runs (174 -> 188 rings), which looked like a
regression and was NOT: `gen-payloads.js` seeds its RNG (42) but derives
its date window from the REAL CLOCK, so a regeneration mid-session slid the
window (`meta.json` latest 2026-08-10 -> 2026-08-11). **Fixture counts are
not a regression signal in this harness** — worth knowing before anyone
diffs probe output across a day boundary again.

The decisive check was a direct A/B: both OLD loops (restored verbatim in a
throwaway script) vs the new helper over 200,000 randomized ring lists
spanning null ids, repeated ids, date changes and lengths 0-8. **Zero
mismatches on both.** The old loops are not kept in the suite — enshrining
deleted code creates a second authority that drifts.

## Test

`tests/unit/call-grouping.test.js` — the FIRST unit coverage of a
client-fragment pure function. Lifts the declaration out of the fragment by
brace-matching and evaluates just it (zero-dep, no jsdom), mirroring the
text-reading technique in html-include-structure.test.js. Pins the two
load-bearing properties (adjacency is part of the rule; a null `parentId`
never groups), that runs COVER the input exactly (a gap would drop rings
from the page, an overlap would render them twice), and that BOTH call
sites still call the shared rule — a re-inlined loop would pass every
semantic test while re-opening the drift this closed.

## Gates

669/669 unit (+8), INV-16 green, UI gate 56/56 + 16/16 + 30/30 + 14/14.

## NET

0 - 0 = 0. Refactor + new coverage, no behavior change (proven), no new
failure mode.

## Where I left off

Committed, pushed, PR opened + merged with R17e/f/g/h. Remaining follow-ons
from 102: the abandons lens has no sparse-date mode (same shape in the
admin-only heatmap cell drill, low value), and the bucket drill's empty
state now uses the shared renderer's wording.
