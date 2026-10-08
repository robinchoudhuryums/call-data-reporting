# Rendered UI harness (audit tooling — never deployed)

Runs the REAL dashboard client (dashboard.html + script.html + styles.html)
in headless Chromium against payloads computed by the REAL server code
(via `tests/harness/loadGas` over fixture sheets + a fake JDBC conn), with
`google.script.run` stubbed. Found the R12-1 blank-missed-chart and R12-2
gray-arrow bugs that unit tests structurally cannot see.

## Run the CI gate (one command, from the repo root)
```bash
cd tools/ui-harness && npm init -y >/dev/null && npm i playwright && cd -
npm run ci:ui
```
`ci:ui` (→ `ci.mjs`) generates payloads → builds the admin + manager sites →
runs the **asserting** drivers, and exits non-zero on any failure. It SKIPS
cleanly with a message when playwright isn't installed, so it's safe in any
environment. This is what `.github/workflows/ci.yml`'s `ui-harness` job runs.

**playwright is the only dependency** — the Chart.js / datalabels /
html2canvas-pro bundles are COMMITTED under `vendor/` and copied into the built
site by `build-harness.js`. `tests/unit/ui-harness-vendor.test.js` pins their
versions to the CDN versions `dashboard.html` loads, so the harness can never
quietly verify the client against a different Chart.js than production ships.

### Running ONE asserting driver by hand — rebuild BOTH roles first
```bash
node gen-payloads.js && node build-harness.js admin && node build-harness.js manager
node drive-cbdept.js          # or any drive-*.js below
```
`build-harness.js` builds ONE site per run and defaults to admin, so after a
client edit a bare `node build-harness.js` leaves `site/index-manager.html`
STALE. That fails two ways, and only one is loud: a manager-side locator for
new markup never matches (a confusing error), **or a manager-side "never
sees / never fetches" check passes VACUOUSLY** because the stale page does not
contain the surface at all (G2: a mutation that removed the admin guard went
undetected until the manager page was rebuilt). `ci.mjs` always rebuilds both,
so the gate itself is not affected -- this is the hand-run trap. When
bite-checking a manager assertion, rebuild the manager site AFTER the mutation.

### Asserting drivers (pass/fail — these gate CI)
- `drive-smoke.js` — boots every page as admin AND manager; fails on page /
  console errors, unexpected unmocked RPCs, **blank chart canvases** (the R12-1
  class: laid out and visible but entirely uniform pixels), and horizontal page
  overflow -- at 1440 px AND, in a separate fresh boot, at 360 px (CL-9), where
  a failure names the elements that reach past the viewport. `drive-agent.js`
  runs the same 360 px check on the agent app's two tabs. A third fresh boot
  per role walks browser **Back / Forward** (CL-23): `build-harness.js`'s
  `google.script.history` mock records every push and replays an entry into
  the app's change handler the way a popstate does (`__HARNESS__.historyBack()`
  / `historyForward()`), and the driver asserts one entry per view, no push
  on Back/Forward, a modal closed by Back and reopened by Forward, and an
  admin-only route left closed for a manager. The mock proves the app's half;
  the owner walks S54 in two real browsers for the browser's half.
- `drive-f13.js` — the S39 keyboard walk: every non-button click target is
  focusable, activates on Enter/Space, shows a focus ring, doesn't scroll on
  Space, and round-trips `aria-expanded`.
- `drive-subqueue.js` — the collapsible sub-queue groups, the S35
  parent-subtotal parity property, and the combined **and** single-dept CSV
  shapes. The **only automated coverage of any CSV writer in this repo** (S43):
  the exporter Blob-and-clicks, so the driver stubs `URL.createObjectURL` and
  reads the real bytes. Also the header **department switch**, which threw a
  `ReferenceError` in production until a driver first tried it.
- `drive-deptoutbound.js` — the My Department **Inbound | Outbound | Both**
  switch and Team Outbound panel (Batches D/F): payload totals, manager and
  View-as fall back to Inbound, panels never overlap, prior-period chips on
  agent rows only, and one request per window (a Refresh never re-sends one
  in flight; the table and the Insights fold share one store, FO-3).
- `drive-outbound-e.js` — the Overview tiles' outbound line per card window
  and the Insights **Outbound** fold (Batch E): two-window deltas, shown only
  on Outbound / Both, never for a manager or View-as.
- `drive-callbacks.js` — the Insights **Callbacks** fold (G1): lazy (one
  fetch, on open), the shared renderers incl. a drawn chart after a reopen,
  the not-called-back drill's call path, CSV / email, 360 px, and the retired
  modal's `#/report/outbound` deep link (G3) for an admin and a manager.
- `drive-cbdept.js` — **Callbacks by department** on the Overview (G2):
  admin-only, lazy (nothing on landing), its own window + sort, grouped rows,
  keyboard expand and sort, CSV bytes.
- `drive-admin.js` — eight **modals** (Alerts, Outlier Fix, Dept Config,
  Access Control, System Health, Caller Lookup, Coaching, and the Agent Day
  report, run past its setup form; the Outbound modal is retired, G3) and the **Escalations
  worklist**. Each modal must open, render content, trap focus over 25 tabs,
  close on Escape and fit the viewport, with no page or console errors; the
  Escalations page must render its cards, give an admin the dept filter, and
  never duplicate its nav count badge across re-entry (F10). Modal ids come
  from the ROUTER TABLE in `script-4-nav.html`, which is the authority --
  guessing them is what left phase3 silently checking a modal that does not
  exist. These surfaces had thorough server-side pins and, until this driver,
  nothing asserting that any of them RENDERED. Two walks ride along (broad
  scan Batch 7): Help, the chart tips and the "↳ path" overlay stacked over a
  real report, where Escape must close only the top layer and hand the
  report back its focus trap and scroll lock (UI-1/UI-2); and a FAILED
  Escalations init, which must clear the loader, offer Retry, beacon, and
  recover (UI-4). To force a failure a driver sets
  `window.__HARNESS__.failOnce[<rpc>] = N`: the next N calls of that RPC reach
  the failure handler. To boot on a DEEP LINK a driver sets
  `window.__HARNESS_HASH__` (e.g. `'/report/outbound'`) in an init script; the
  stubbed `google.script.url.getLocation` answers ASYNCHRONOUSLY like the real
  one, so the link lands after boot's default page, as in production.
- `drive-devoverlay.js` — the O-11 dev overlay and, more importantly, its
  `google.script.run` **probe**. That probe redefines the single object every
  one of the ~91 server calls in `script.html` passes through, so a wrong
  wrapper doesn't degrade a feature — it breaks the whole app while the page
  still paints. The driver therefore asserts the app **works** with the probe
  installed before asserting anything about the panel, and its
  handler-isolation check is **behavioural** (two concurrent chains must each
  invoke their own handler): comparing two reads for identity does *not* catch
  a shared runner, because a fresh Proxy is minted either way.

### Exploratory drivers (artifacts for a human to read — NOT in CI)
```bash
node gen-payloads.js          # Overview/dept/missed/IR/Insights payloads (real server code)
node gen-phase3.js            # Escalations (fake JDBC) + admin-modal inits
node build-harness.js admin && node build-harness.js manager
# NB both roles: `build-harness.js` builds ONE site and defaults to admin, so a
# bare `node build-harness.js` leaves site/index-manager.html STALE. New markup is
# then invisible to half of drive-smoke, which fails on a locator that never
# matches -- a confusing error with a trivial cause. ci.mjs always builds both.
node drive.js                 # Phase 1: Overview + My Department sweep
node drive-insights.js        # Phase 2: Insights
node drive-phase3.js          # Phase 3: Escalations + modals
```
Output: `shots/*.png` + `report*.json` (console errors, overflow, focus walks,
contrast, focus-trap escapes) — findings to read, not a pass/fail signal, which
is why CI runs only the asserting drivers above (via `ci.mjs`;
`npm run ci:ui`). NB `drive-phase3.js` also opens the admin modals, but it
records failures instead of raising them -- `drive-admin.js` is the asserting
version, and the two disagreed: phase3 had been probing a
`#system-health-modal` that does not exist.

**Chromium path** is resolved by `chromium-path.js` — it globs
`/opt/pw-browsers/chromium-<rev>/chrome-linux/chrome` (the path carries the
Playwright browser REVISION, so it moves on image bumps), prefers the full
browser over `headless_shell`, and falls back to Playwright's own registry.
Override with `CHROMIUM_PATH` if your binary lives elsewhere. The old
documented default (`/opt/pw-browsers/chromium`) was a DIRECTORY, not the
binary, so every driver failed with "executable doesn't exist" until you
passed the variable by hand.

**Suppress the first-run chrome** in any new driver, or clicks time out on
the onboarding tour's overlay:
```js
await page.addInitScript(() => {
  localStorage.setItem('cdr.tour.done', '1');
  localStorage.setItem('cdr.ins.intro.v1', '1');
});
```

## Gotchas learned
- fullPage screenshots race Chart.js re-layout (Chromium resizes the
  viewport mid-capture) — trust element/viewport clips, not fullPage, for
  chart pixels.
- The stub's runner must return the PROXY from withSuccessHandler /
  withFailureHandler chains.
- Payload realism: regenerate after server-shape changes (`gen-*.js` call
  the live .gs code, so they inherit shape changes automatically).
