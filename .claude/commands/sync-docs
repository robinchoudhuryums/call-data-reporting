Read CLAUDE.md and README before starting. Do not make any changes until the comparison is complete and you have asked for approval.

You are detecting documentation drift — places where the docs no longer match the code, or where state that needs documentation is hiding in the operator's head.

Run all four checks; produce a single drift report at the end.

═══════════════════════════════════════════ CHECK 1 — CLAUDE.md CURRENCY ═══════════════════════════════════════════

For every entry in CLAUDE.md's Common Gotchas, Key Design Decisions, and Operator State Checklist (if present):

Is the gotcha / decision / state item still true?

Verify by reading the relevant file(s).
Flag STALE if the underlying code has changed and the doc no longer describes current behavior.
Flag RESOLVED if the gotcha is no longer reachable (code removed, guard added, etc.) — propose deletion or "Resolved on [date]" note.
Is anything described in CLAUDE.md that no longer exists in the codebase (e.g., a file path that's been moved or removed)?

═══════════════════════════════════════════ CHECK 2 — SUBSYSTEM FILE REFERENCE CURRENCY ═══════════════════════════════════════════

Read the Subsystems section of CLAUDE.md's Cycle Workflow Config.

For each subsystem:

Verify every listed file path still exists.
For each subsystem, scan the project for source files that are in that subsystem's domain but NOT listed (new files added since the last /setup-cycle).
For Frozen Subsystems: verify the rationale still applies.
For Deploy Command entries: verify the referenced subsystem name still exists in the Subsystems list.
═══════════════════════════════════════════ CHECK 3 — OPERATOR STATE INVENTORY ═══════════════════════════════════════════

Look for setup steps that exist only in the operator's head:

Environment variables, API keys, OAuth scopes the code reads but CLAUDE.md / README don't mention as required.
Manual setup steps implied by code (e.g., "must create a sheet named X", "must install trigger Y", "must add the script's service-account email to the target spreadsheet").
Scheduled triggers, cron entries, webhooks that exist in production but aren't described in docs.
One-time migrations or backfills the code expects to have run.
For each item: propose a one-line addition to an "Operator State Checklist" section in CLAUDE.md, or to the README's Setup section, whichever already exists in the project.

═══════════════════════════════════════════ CHECK 4 — IMPLEMENTATION DRIFT ═══════════════════════════════════════════

For every recent change (since the last /sync-docs run, or the last ~10 commits if no prior run):

Does the change introduce behavior that contradicts something in CLAUDE.md or the README?
Does the change introduce a new design decision or invariant that should be captured?
Does the change change a command, deploy step, or runtime expectation that the docs still describe in the old way?
═══════════════════════════════════════════ OUTPUT — DOCUMENTATION DRIFT REPORT ═══════════════════════════════════════════

---DOCUMENTATION DRIFT REPORT---

CLAUDE.md STALE ENTRIES:

[entry] | [evidence the code has diverged] | [proposed update or deletion] (or "None")
CLAUDE.md MISSING ENTRIES:

[topic] | [why it should be documented] | [proposed wording] (or "None")
SUBSYSTEM REFERENCE FIXES:

[subsystem] | [file path no longer exists / new file unassigned] | [fix] (or "None")
OPERATOR STATE ITEMS NOT DOCUMENTED:

[step] | [where the code assumes it has been done] | [proposed checklist line] (or "None")
IMPLEMENTATION DRIFT:

[commit / area] | [what the docs say] | [what the code now does] | [fix] (or "None")
PROPOSED CHANGES (file-by-file):

[file] | [change] | [rationale]
After the report, ask for approval before writing any files. Apply only the approved changes; do not bundle unapproved suggestions. ---END DOCUMENTATION DRIFT REPORT---
