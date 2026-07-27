// F7: one entry point for the rendered-UI gate -- `npm run ci:ui`.
//
// Deliberately SEPARATE from `npm run ci`: the .gs unit harness is zero-dep by
// design (Node's built-in runner, no install), and this needs playwright. So the
// main suite keeps its zero-dep promise and this runs as its own CI job, skipping
// cleanly with a clear message when playwright isn't installed.
//
// Stages: generate payloads from the REAL server code -> build the admin +
// manager sites from the REAL client -> run the two ASSERTING drivers
// (drive-smoke = boot/console/blank-canvas/overflow, drive-f13 = keyboard
// access). The exploratory drivers (drive.js / drive-insights.js /
// drive-phase3.js) are NOT run here: they emit screenshots + reports for a human
// to read, which is not a pass/fail signal.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (!existsSync(path.join(HERE, 'node_modules', 'playwright'))) {
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
