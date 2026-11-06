// F7: one entry point for the rendered-UI gate -- `npm run ci:ui`.
//
// Deliberately SEPARATE from `npm run ci`: the .gs unit harness is zero-dep by
// design (Node's built-in runner, no install), and this needs playwright. So the
// main suite keeps its zero-dep promise and this runs as its own CI job, skipping
// cleanly with a clear message when playwright isn't installed.
//
// Stages: generate payloads from the REAL server code -> build the admin +
// manager sites from the REAL client -> run the ASSERTING drivers listed in
// STAGES below (the single source of truth for what gates -- the asserting
// drivers CLAUDE.md's "Rendered-UI gate" block names, incl. the agent-app
// pair; DOC-7: no count here, it drifted every time a driver was added). The exploratory drivers (drive.js / drive-insights.js /
// drive-phase3.js) are NOT run here: they emit screenshots + reports for a human
// to read, which is not a pass/fail signal.
//
// SPEED-1 (owner 2026-11-06): the asserting drivers run CONCURRENTLY, at most
// UI_HARNESS_JOBS at a time (default 4; 1 = the old one-after-another order).
// Measured: each driver takes the same time alone as beside three others --
// they spend it in fixed page waits, not CPU -- and they load file:// pages and
// write nothing, so they cannot see each other. 14.6 min serial -> ~4 min at 4.
// The SETUP stages (payload generation + site builds) still run first, in
// order, because every driver reads what they write. Each driver's output is
// buffered and printed whole when it ends, and EVERY driver runs to the end
// even after one fails, so a red run names every failing driver, not the first.
// SPEED-2: drive-smoke runs as two shards, `admin` and `manager` -- the two
// halves of its role loop share nothing -- so the longest driver no longer
// sets the wall time alone. cross-file-pins pins that both shards are listed.
import { spawn, spawnSync } from 'node:child_process';
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
  console.log('  Install it with:  cd tools/ui-harness && npm i playwright@1.62.1');
  console.log('  (Vendor bundles are committed, so playwright is the only dependency.)');
  process.exit(0);
}

// SETUP: run first, in this order -- every driver reads what these write.
const SETUP = [
  ['node', ['gen-payloads.js'], 'payloads from real server code'],
  ['node', ['gen-phase3.js'], 'escalations + admin-modal fixtures'],
  ['node', ['build-harness.js', 'admin'], 'build admin site'],
  ['node', ['build-harness.js', 'manager'], 'build manager site'],
  // Agent role Phase B: the agent app's site, from a payload built by the REAL
  // getAgentHome (drive-agent.js below is its only rendered check).
  ['node', ['build-agent.js'], 'build agent site (payload from real getAgentHome)'],
];

// DRIVERS: the asserting stages, run concurrently (SPEED-1). The three longest
// (the two smoke shards, drive-admin) are listed first so they start at once
// and the short ones fill in around them; the order is otherwise free.
const STAGES = [
  // SPEED-2: one shard per role; each boots, walks and checks only its role.
  ['node', ['drive-smoke.js', 'admin'], 'boot / console / blank-canvas / overflow (admin)'],
  ['node', ['drive-smoke.js', 'manager'], 'boot / console / blank-canvas / overflow (manager)'],
  // The admin modals + the Escalations worklist. These have thorough
  // SERVER-side pins and, until this stage, no assertion that any of them
  // RENDERS -- the gap that shipped the header dept-selector ReferenceError.
  // drive-phase3.js already opened them but swallowed every failure into a
  // report for a human and exited 0; this asserts. It reads modal ids off the
  // ROUTER TABLE in script-4-nav.html, which is how it caught that phase3 had
  // been checking a `#system-health-modal` that never existed.
  ['node', ['drive-admin.js'], 'admin modals + escalations worklist'],
  ['node', ['drive-f13.js'], 'keyboard access (S39)'],
  // Sub-queue scope switcher + the combined-view CSV. Also the FIRST automated
  // coverage of any CSV writer in this repo (S43): the exporter Blob-and-clicks,
  // so the driver stubs URL.createObjectURL and asserts the real bytes.
  ['node', ['drive-subqueue.js'], 'sub-queue scope + combined CSV (S35 addendum / S43)'],
  ['node', ['drive-journey.js'], 'call-path drill: origin line, outbound link, refusal'],
  // Batch B: the inline agent panel an agent-row click opens on My Department
  // -- a DOM row inside a table that re-renders on every sort, so it is the
  // shape that renders in review and breaks on a real click. Asserts open /
  // day + tab switch / survive a re-sort / IR button / Escape + Collapse focus
  // return / one panel at a time / CSV untouched / no overflow at 360 px.
  ['node', ['drive-agentpanel.js'], 'inline agent panel (My Department row click)'],
  // Step 4 (owner 2026-10-16): the team cards' linked day bars -- one shared
  // selection across four cards, workday / monthly bucketing, keyboard and
  // touch, admin-only, and no sideways scroll at 360 px.
  ['node', ['drive-daybars.js'], 'team cards: linked day bars (Step 4)'],
  // QV-1 (owner 2026-10-29): a day bar opens that day's quick view -- the
  // cards equal the bars' readouts, single-day reads, workday stepping, the
  // agent-day drill, keyboard, "Open this day on the page", admin-only, 360 px.
  ['node', ['drive-dayqv.js'], 'team cards: day quick view (QV-1)'],
  // Exception days (owner 2026-10-22, #81): every report says which day it
  // leaves out, the day bars stripe the day off the scale, the include switch
  // is an admin's alone and really re-asks, the Overview bridges + shades it.
  ['node', ['drive-exceptions.js'], 'exception days: notes, striped bars, include switch, Overview band (#81)'],
  // Step 5a: the Notifications page -- sentence rules, History, Test send, the
  // manager-layer switch, and a manager's Settings section (off / on).
  ['node', ['drive-notify.js'], 'Notifications: rules, history, test send, manager layer (Step 5a)'],
  // Batch D: the Inbound | Outbound | Both switch -- a second table over the
  // same page state, so the bugs are visibility and reconciliation ones only
  // a browser shows (the wrong table, the inbound panel painting back, the
  // switch leaking to a manager or surviving view-as).
  ['node', ['drive-deptoutbound.js'], 'My Department outbound view (Batch D)'],
  // E5 / ST4 (broad-scan 259): the SEQUENCES before the UX-2 / 6c gates open --
  // dept switch with the brief open, dept switch in the Outbound view, view-as
  // in and out, the Callbacks jump. Every other stage checks one state; the
  // bugs Batches 5-6 fixed were all moves between two (it found one more).
  ['node', ['drive-crossstate.js'], 'cross-state: dept switch, view-as, direction (E5)'],
  ['node', ['drive-outbound-e.js'], 'Overview tile outbound line + Outbound summary (Batch E, UX-1)'],
  // Batch G1: the Callbacks fold (the Outbound report moving onto My
  // Department) -- lazy fetch, the shared renderers painting into it, the
  // chart after a close/reopen, the drill's call path, and the 6c half.
  ['node', ['drive-callbacks.js'], 'Callbacks under the outbound table (Batch G1, UX-1)'],
  // Batch G2: Callbacks by department on the Overview -- admin-only forever,
  // lazy (nothing on the landing / auto-refresh), its own sort and window.
  ['node', ['drive-cbdept.js'], 'Overview Callbacks by department (Batch G2)'],
  // O-11. The dev overlay redefines `google.script.run` for admins -- the one
  // object every server call in the app passes through -- so a wrong wrapper
  // breaks everything at once, and nothing in `node --test` can see it. This
  // stage asserts the app still works WITH the probe installed before it
  // asserts anything about the overlay.
  ['node', ['drive-devoverlay.js'], 'dev overlay + the google.script.run probe (O-11)'],
  // The agent app (agent.html + agentApp.html) is a SEPARATE page no other
  // stage boots -- its only rendered check: real client + real styles against
  // a payload from the REAL getAgentHome, asserting render, the hidden rank
  // line, teammate-name privacy, and cleanliness (errors / unmocked RPCs /
  // self-beacons).
  ['node', ['drive-agent.js'], 'agent app boot / privacy / hidden rank'],
];

function runSetup() {
  for (const [cmd, args, label] of SETUP) {
    console.log('\n=== ui-harness: ' + label + ' (' + args.join(' ') + ') ===');
    const r = spawnSync(cmd, args, { cwd: HERE, stdio: 'inherit', env: process.env });
    if (r.status !== 0) {
      console.error('\nui-harness FAILED at: ' + label);
      process.exit(r.status === null ? 1 : r.status);
    }
  }
}

// One driver; resolves { label, code, out, secs } -- never rejects.
function runDriver([cmd, args, label]) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const p = spawn(cmd, args, { cwd: HERE, env: process.env });
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { out += '\n' + e.message; });
    p.on('close', (code) => resolve({ label, args, code: code === null ? 1 : code, out, secs: (Date.now() - t0) / 1000 }));
  });
}

async function runDrivers() {
  const raw = parseInt(process.env.UI_HARNESS_JOBS || '4', 10);
  const jobs = Math.max(1, Math.min(STAGES.length, Number.isFinite(raw) ? raw : 4));
  console.log('\n=== ui-harness: ' + STAGES.length + ' asserting drivers, ' + jobs + ' at a time (UI_HARNESS_JOBS) ===');
  const t0 = Date.now();
  const results = [];
  let next = 0;
  async function worker() {
    while (next < STAGES.length) {
      const stage = STAGES[next++];
      const r = await runDriver(stage);
      results.push(r);
      console.log('\n=== ui-harness: ' + r.label + ' (' + r.args.join(' ') + ') -- '
        + (r.code === 0 ? 'PASS' : 'FAIL') + ' in ' + r.secs.toFixed(1) + 's ===');
      process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n');
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  const failed = results.filter((r) => r.code !== 0);
  console.log('\nui-harness: drivers done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (failed.length) {
    console.error('\nui-harness FAILED at: ' + failed.map((r) => r.label).join('; '));
    process.exit(failed[0].code || 1);
  }
}

runSetup();
await runDrivers();
console.log('\nui-harness: all stages passed.');
