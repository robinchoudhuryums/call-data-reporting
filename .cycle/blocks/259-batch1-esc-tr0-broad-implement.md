---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ESC-C1: a comment given when resolving is also written to the Activity thread (it was saved only on the row, so a reopened card hid it and the next resolve overwrote it)
- ESC-C4: deleting ONE linked copy keeps its comments in the shared thread (moved to a surviving copy, tagged with the deleted dept)
- DEP-5 (committed earlier on this branch, rides in this PR): deploy.sh counts the project's versions before rolling a deployment
New capabilities (G/ST):
- ESC-C2: previewEscalationCommentGaps / backfillEscalationCommentGaps (admin, editor-run) -- list, then add, saved comments missing from their threads
- ESC-C3: cards show the latest three comments (author, time, dept on a linked copy) + "View all N in Activity"
- TR-0: diagnoseTransferRetries (cdr-import, read-only) -- a missed attempt to a person in another dept followed by an attempt to someone else there on the same call
Files modified:
- apps-script/department-dashboard/Escalations.gs
- apps-script/department-dashboard/script-10-escalations.html
- apps-script/department-dashboard/styles.html
- apps-script/cdr-import/transferFilter.js
- tests/unit/escalations-hardening.test.js
- tests/unit/transfer-filter.test.js
- tools/ui-harness/gen-phase3.js, tools/ui-harness/drive-admin.js
- docs/operator-state.md (#88, #89), docs/fix-history.md, docs/regression-scenarios.md (S52), docs/module-dependencies.md, tests/README.md, CLAUDE.md (index lines 88/89)

CHANGES:
ESC-C1 | Escalations.gs | resolveEscalation appends a 'comment' activity row (credited to the resolver) before 'resolved' when a comment is given; escAppendActivity_ stamps clock_timestamp() so two rows in one txn keep their order
ESC-C2 | Escalations.gs | ESC_COMMENT_GAP_WHERE_ (one predicate) + previewEscalationCommentGaps (read-only, logs ids/length never text) + backfillEscalationCommentGaps (INSERT…SELECT, resolver else creator, resolve time − 1 ms, idempotent, forced snapshot refresh)
ESC-C3 | Escalations.gs, script-10-escalations.html, styles.html | list SELECT gains card_comments (latest 3, group-wide, 600 chars, oldest-first) + comment_count; escCardCommentsHtml_ renders them with a "View all" that opens Activity, falling back to the row's comments field; escSnapshotChunk_ drops the preview so the snapshot's row budget is unchanged; the resolved branch's separate Comments line is gone (the block covers it)
ESC-C4 | Escalations.gs, script-10-escalations.html | single-copy delete of a linked escalation first moves its 'comment' rows to a survivor (active first) with COALESCE(department, deleted dept), same txn; result.commentsKeptOn; confirm text says so
TR-0 | transferFilter.js | tfRetriesOfJourney_ / tfRetryOutcome_ / tfRetryLegIndex_ / tfRetryFold_ / tfRetriesForGrid_ / tfRetryLine_ + diagnoseTransferRetries(AllDates); quick decline ≤ 8 s, ring buckets, gap, Cause + Last Leg Disposition (col 41) census, samples (names + call ids only)

TEST RESULTS: node --test 2787 pass / 0 fail (TZ=America/Chicago); lint:gas clean; module-deps --check clean; INV-16 guard clean; ci:ui see STATE; bites 8/8 (C1 append dropped, C4 move dropped, C2 predicate loosened, C3 snapshot keeps preview, C3 view-all always, TR own-dept not excluded, TR quick line exclusive, TR same person counted)
REGRESSION RISKS:
- The escalations list query gains two correlated subqueries per row (≤ 501 rows); bounded by LIMIT 3 + 600 chars each, worst case ~0.9 MB more egress on a full list -- metered under 'escalations'
- Resolved cards no longer show "Comments:" from the row field when the thread has comments; the same text appears in the comments block (after ESC-C1 / the backfill)
- escalation_activity.at now uses clock_timestamp() instead of the DEFAULT now(): ordering within a transaction changes from a tie to statement order -- the intended effect
INVARIANTS AT RISK:
- INV-01 / INV-55: the backfill is a new write path -- admin-gated, editor-run, Neon-only (no sheet), lock-serialized; the ESC-G1 sweep lists it as an exemption with a reason
- INV-16: transferFilter.js is not a duplicated file; guard clean
NET SCORE: 2 production fixes (ESC-C1, ESC-C4) − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- Dashboard: after the deploy, run previewEscalationCommentGaps(), review, then backfillEscalationCommentGaps() (Operator State #88) | BLOCKS DEPLOY: N
- cdr-import: after the push, run diagnoseTransferRetriesAllDates() and send the TOTAL + census lines (decides TR-1, Operator State #89) | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version
CDR Import: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- Batch 2: DV-1 (Inbound · Outbound · Inbound + outbound · Direct switch, admin-only) + TDC-1 (Team Direct Calls card loader / visual / shared fetch)
- Batch 3: TR-1 (admin list of retried transfers) after the TR-0 numbers
- Transfer % on the CSR Agent Metrics table: owner checks after the redeploy (likely the stale deployment from the 200-version cap)
- Comments overwritten by a re-resolve before ESC-C1 cannot be recovered (the row field held only the latest)

DOCUMENTATION UPDATES NEEDED:
- None beyond those made (Operator State #88/#89, fix-history ESC-C1..C4 + TR-0, S52 steps, tests/README, CLAUDE.md index)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
