# Known issues and quirks

Institutional memory for things that have bitten us, or that *will* bite if
not respected. Add to this file whenever you discover something non-obvious
or fix a subtle bug — future-you will thank you.

Entries are ordered roughly by severity / how often they trip people up.

---

## Source pipeline: `buildDQEHistoricalData.gs` (CDR Report project)

### Bug 1: TTT included calls outside the work window

**Status:** Fixed (see `apps-script/cdr-report/buildDQEHistoricalData.gs`).

**Symptom:** An agent's `Total Answered` in `DQE Historical Data` would
exclude a call (e.g., one that started at 15:01 PST = 17:01 CST, outside the
6:30 AM – 3:00 PM PST work window), but the same agent's `TTT` would
include that call's talk time. The two columns silently disagreed.

**Cause:** Pass 3's TTT/ATT loop iterated `legs` (all-day legs for the
agent), while `totalAnswered` was computed from `windowLegs` (the
in-window subset). Two different denominators.

**Fix:** Iterate `windowLegs` for the TTT/ATT computation too.

### Bug 2: ATT denominator was the all-hours unique-parent count

**Status:** Fixed.

**Symptom:** For an agent with 5 in-window answered calls but 6 unique
answered parent calls across the full day, source ATT was stored as
`TTT / 6` instead of `TTT / 5`. The dashboard's weighted-ATT formula
(`TTT / Answered`) then disagreed with the source's stored ATT by a small
but consistent amount.

**Cause:** Same loop as Bug 1. `talkTimes.length` (the count used as the
ATT denominator) was the count of unique answered parents the agent had
*across all hours*, not Total Answered.

**Fix:** Same as Bug 1 — once the loop is windowed, the count matches
Total Answered.

### Bug 3: TTT misattributed another agent's talk time

**Status:** Fixed.

**Symptom:** When two agents both had legs on the same parent call (e.g.,
a transfer scenario), the agent whose leg was *shorter* would still get
attributed the *longer* leg's talk time. Real case: call
`1762242119044` on 2026-03-09, Sonia's own leg was 0:01:01 but TTT
attributed 0:01:58 (the other agent's leg).

**Cause:** Pass 3 summed `parent.talkSec` per parent call, where
`parent.talkSec` is `Math.max(...legs.map(l => l.talkSec))` — the
longest leg of *any* agent on that parent. This is a max-of-all-agents,
not per-agent.

**Fix:** New `findAgentTalkOnParent(parentCallId, agentName)` helper
walks `parent.legs` and returns the longest leg where
`leg.calleeName === agentName`. Each parent leg now also stores its
`calleeName` (added in Pass 1).

**Subtle gotcha for future readers:** Queue-leg rows (where caller_id
matches `A_Q_*`) have talk_time = 0. The agent's actual talk time lives
on a *parent-level* leg with the agent's name in col L. Don't try to
shortcut this by reading talk_time off the queue leg — you'll get TTT = 0
for everyone.

### Dead-code remnant: `entry.talkSec = Math.max(...)`

**Status:** Not fixed (harmless).

The Pass 1 finalization sets `entry.talkSec` per parent, but after the
Bug 3 fix Pass 3 no longer reads it. Safe to delete in a future cleanup.
Kept for now to minimize diff churn.

---

## Spreadsheet vs script timezone mismatch (Mexico City vs Chicago)

**Status:** Worked around in code; underlying setting unchanged.

**Symptom (now fixed):** Every duration column (TTT, ATT, Avg Abd Wait,
CSR Avg Abd Wait) in the dashboard was exactly 36:36 (36 min 36 sec) too
high vs. the source sheet's displayed value.

**Cause:** The CDR Report spreadsheet's timezone is set to "Central Time -
Mexico City" (GMT-06:00 year-round), but `appsscript.json` declares the
script's timezone as `America/Chicago`. When `getValue()` returns a JS
`Date` for a duration-formatted cell, the underlying number is interpreted
through the **spreadsheet's** TZ. The dashboard's `toSeconds_()` then
read `getHours()/getMinutes()/getSeconds()` in the **script's** TZ. The
difference at the 1899-12-30 Sheets epoch between America/Chicago's CST
(-6:00:00) and America/Mexico_City's LMT (-6:36:36) is exactly 36:36 —
the fingerprint we observed.

**Fix:** Dashboard's `computeSummary_` reads `getDisplayValues()` for the
four duration columns and parses the formatted H:MM:SS string via
`parseHmsDisplay_`. Display strings are TZ-agnostic.

**Belt-and-suspenders:** `rowDateIso_(v, tz)` now accepts the spreadsheet's
TZ explicitly. `computeSummary_` pre-fetches it via
`getSpreadsheetTimeZone()`. The date column (col B) is currently stored as
strings so the Date-object path isn't exercised today, but if it ever is,
the right TZ is used.

**If you ever change the spreadsheet's TZ** (e.g., to Central Time -
Chicago to match the script): the dashboard code will still work (display
strings don't care). But formulas elsewhere in the workbook that use
`NOW()`, `TODAY()`, or date arithmetic *will* shift. Check those before
flipping.

---

## `neonWrite.gs` duplicated across projects

**Status:** Accepted drift risk.

Both **CDR Import** and **CDR Report** Apps Script projects need
`neonWrite.gs` (to write to the Neon `dqe_history` and related tables).
Apps Script has no native cross-project sharing, so the file is
duplicated. If you fix a bug in one copy, **fix it in the other too**.

**Mitigation:** None right now. Eventually we may consolidate to a single
project or extract a separate "Neon utilities" lib, but that's a Phase
2/3 concern. For now, treat any change to either copy as a two-file edit.

---

## Source-data quirks (not code bugs)

### "Sales Voicemails" and similar pseudo-agents

Historical data sometimes contains rows where `Agent Name` is a system
entity ("Sales Voicemails", "A_Q_*" queue names, "Normal Call Menu",
etc.) instead of a real person. These won't be in any dept roster and
will appear in the dashboard's `whyNoMatches` diagnostic under
"Agents in historical NOT in ANY roster".

These are correct rejections — don't add them to any dept roster.
`buildDQEHistoricalData.gs` has a `DQE_EXCLUDED_AGENTS` allowlist that
*should* drop them upstream; missing entries should be added there, not
worked around downstream.

### Per-leg attribution issue on `1762242119044` (2026-03-09)

Identified during Bug 3 investigation. Distinct from Bug 3 itself —
this was about the wrong agent's talk time being summed. After the Bug
3 fix, Sonia's row correctly attributes her actual 0:01:01 leg, not the
other agent's 0:01:58.

If you see similar attribution issues on other days, suspect either:
- Bug 3 wasn't actually fixed in the running version (re-check
  `findAgentTalkOnParent` exists and is called from Pass 3)
- An agent's name appears differently between the queue leg and the
  parent leg (data quality issue in the CDR export)

---

## Dashboard design rules to preserve

### No write paths exposed via `google.script.run`

The deploy is **"Execute as: Me"** (the deployer), so any function
callable from the client runs with Robin's spreadsheet permissions. The
safety guarantee is therefore: **no public server function writes to any
sheet**. All helpers that touch spreadsheet state end in `_` (trailing
underscore) so Apps Script blocks them from `google.script.run`.

If you ever need a "save preferences" or "edit roster" feature, do it
through a public function that explicitly checks `resolveUser_(email).role
=== 'admin'` first. Don't loosen the convention.

### `setup()` is idempotent

`setup()` only creates the Access Control sheet if it doesn't exist. It
never overwrites existing rows. Safe to re-run as many times as you want.
Keep it that way.

### Cache key version bumping

`Data.gs` uses a versioned cache key (`'summary:vN:'`). Bump `N` whenever
the response shape or aggregation rules change so stale caches invalidate
on deploy. Current version: `v3` (scope param + diagnostics field added).
