// F7: one entry point for the rendered-UI gate -- `npm run ci:ui`.
//
// Deliberately SEPARATE from `npm run ci`: the .gs unit harness is zero-dep by
// design (Node's built-in runner, no install), and this needs playwright. So the
// main suite keeps its zero-dep promise and this runs as its own CI job, skipping
// cleanly with a clear message when playwright isn't installed.
//
// Stages: generate payloads from the REAL server code -> build the admin +
// manager sites from the REAL client -> run the ASSERTING drivers listed in
// STAGES below (the single source of truth for what gates -- currently the
// seven CLAUDE.md's "Rendered-UI gate" block names, incl. the agent-app
// pair). The exploratory drivers (drive.js / drive-insights.js /
// drive-phase3.js) are NOT run here: they emit screenshots + reports for a human
// to read, which is not a pass/fail signal.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (!existsSync(path.join(HERE, 'node_modules', 'playwright'))) {
  // F-9: in CI the install step is supposed to have provided playwright --
  // a missing install there means a broken workflow (e.g. a refactor that
  // hoisted node_modules away from HERE), and silently exiting 0 would turn
  // the gate permanently green. Fail loudly under CI; skip cleanly elsewhere.
  if (process.env.CI) {
    console.error('ui-harness: playwright not installed but CI=true -- the workflow\'s install '
      + 'step did not land node_modules under ' + HERE + '. FAILING instead of skipping, '
      + 'so the gate cannot go silently green.');
    process.exit(1);
  }
  console.log('ui-harness: playwright not installed -- SKIPPING the rendered-UI gate.');
  console.log('  Install it with:  cd tools/ui-harness && npm i playwright');
  console.log('  (Vendor bundles are committed, so playwright is the only dependency.)');
  process.exit(0);
}

const STAGES = [
  ['node', ['gen-payloads.js'], 'payloads from real server code'],
  ['node', ['gen-phase3.js'], 'escalations + admin-modal fixtures'],
  ['node', ['build-harness.js', 'admin'], 'build admin site'],
  ['node', ['build-harness.js', 'manager'], 'build manager site'],
  ['node', ['drive-smoke.js'], 'boot / console / blank-canvas / overflow'],
  ['node', ['drive-f13.js'], 'keyboard access (S39)'],
  // Sub-queue scope switcher + the combined-view CSV. Also the FIRST automated
  // coverage of any CSV writer in this repo (S43): the exporter Blob-and-clicks,
  // so the driver stubs URL.createObjectURL and asserts the real bytes.
  ['node', ['drive-subqueue.js'], 'sub-queue scope + combined CSV (S35 addendum / S43)'],
  ['node', ['drive-journey.js'], 'call-path drill: origin line, outbound link, refusal'],
  // The admin modals + the Escalations worklist. These have thorough
  // SERVER-side pins and, until this stage, no assertion that any of them
  // RENDERS -- the gap that shipped the header dept-selector ReferenceError.
  // drive-phase3.js already opened them but swallowed every failure into a
  // report for a human and exited 0; this asserts. It reads modal ids off the
  // ROUTER TABLE in script-4-nav.html, which is how it caught that phase3 had
  // been checking a `#system-health-modal` that never existed.
  ['node', ['drive-admin.js'], 'admin modals + escalations worklist'],
  // O-11. The dev overlay redefines `google.script.run` for admins -- the one
  // object every server call in the app passes through -- so a wrong wrapper
  // breaks everything at once, and nothing in `node --test` can see it. This
  // stage asserts the app still works WITH the probe installed before it
  // asserts anything about the overlay.
  ['node', ['drive-devoverlay.js'], 'dev overlay + the google.script.run probe (O-11)'],
  // Agent role Phase B. The agent app (agent.html + agentApp.html) is a
  // SEPARATE page no other stage boots -- this pair is its only rendered
  // check: real client + real styles against a payload from the REAL
  // getAgentHome, asserting render, the hidden rank line, teammate-name
  // privacy, and cleanliness (errors / unmocked RPCs / self-beacons).
  ['node', ['build-agent.js'], 'build agent site (payload from real getAgentHome)'],
  ['node', ['drive-agent.js'], 'agent app boot / privacy / hidden rank'],
];

for (const [cmd, args, label] of STAGES) {
  console.log('\n=== ui-harness: ' + label + ' (' + args.join(' ') + ') ===');
  const r = spawnSync(cmd, args, { cwd: HERE, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error('\nui-harness FAILED at: ' + label);
    process.exit(r.status === null ? 1 : r.status);
  }
}
console.log('\nui-harness: all stages passed.');
