/**
 * E3 (broad-scan): the deployed-build stamp.
 *
 * "Is the deployed version current?" is Operator State #2 and was the
 * audit's top finding twice running (five merged rounds sat undeployed
 * while the live incident's fix was among them). This makes the answer a
 * glance on the Health page instead of a Manage-deployments archaeology
 * session.
 *
 * HOW IT WORKS: this committed file holds the PLACEHOLDER below.
 * scripts/deploy.sh overwrites it with the real stamp (UTC time + git
 * short SHA + branch) immediately before `clasp push -f` and restores the
 * placeholder from git immediately after (trap-guarded, so a failed push
 * restores too) -- the working tree never stays dirty and the repo never
 * churns. The stamp therefore lives ONLY in the pushed Apps Script
 * project, which is exactly where it means something.
 *
 * CONSEQUENCE OF THE DESIGN, on purpose: a bare `clasp push -f` (outside
 * deploy.sh) pushes the placeholder, so the Health row reading
 * "unstamped" is ITSELF the finding -- it tells you the last push
 * bypassed the deploy helper and its CI gates (TST-7/F-10). Do not
 * "fix" the placeholder to look like a stamp.
 *
 * The Health page renders this in the pipeline section
 * (SystemHealth.gs, 'build-stamp' row); nothing else reads it.
 */
var BUILD_STAMP_ = 'unstamped — last push bypassed scripts/deploy.sh';
