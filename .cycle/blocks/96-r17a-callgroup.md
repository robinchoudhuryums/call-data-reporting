# Increment 96 — R17a: same-call grouping on the missed agent cards

Owner-approved mock (Round 17, item 1). CLIENT-ONLY -- no server change, no
cache bump, no pipeline touch (per the owner's standing caution).

## The rule

`missedAgentsHtml_` groups CONSECUTIVE timeline entries sharing
(date, parentId) into a `.ms-callgroup` -- one CALL that rang the agent
repeatedly before the caller gave up (the F-2 lockstep emits one AF entry
per ring, each paired to the same AD id, so a re-rung abandoned parent
arrives as N adjacent entries with one id). The group renders the siren +
the id badge / "↳ path" drill ONCE on the last ring -- previously N
identical badges -- and the explainer is the group's HOVER TITLE ("Same
call — rang N× before the caller hung up (call ID ...)"); no visible
caption (owner note on the mock). A nested <ul> needs an <li> wrapper
(.ms-callgroup-wrap, kept visually inert) -- a bare ul-in-ul is invalid.

## The honest limitation (documented, not worked around)

Only ABANDONED rings carry an id in DQE. Plain missed rings (calls
answered elsewhere) have no identity in the sheet -- it exists only in
Call_Legs at build time (14-day retention) -- so they stay ungrouped. A
time-proximity heuristic was considered and rejected as guessing.

## Harness

The fixture's abandoned pairs were never chronologically ADJACENT (two
random slots with other rings interleaving once sorted), so no group could
form -- and the dept default window (latest day) additionally landed on
the distinct-ids branch. The fixture now alternates: a RE-RUNG parent
(sibling ring 40s later in the SAME slot, one id twice -- the groupable
shape) on even days AND always on the LATEST day (the dept page's default
window, where drive-smoke asserts), vs two distinct abandoned calls on odd
days (must NOT group). +2 drive-smoke checks per role (36 -> 40): a group
renders, with >=2 rings, exactly ONE id badge, a "rang N×" hover title,
and no visible caption text.

Gates: node --test 660/0, INV-16, ci:ui 40+16+30+14.
