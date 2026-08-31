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

### Asserting drivers (pass/fail — these gate CI)
- `drive-smoke.js` — boots every page as admin AND manager; fails on page /
  console errors, unexpected unmocked RPCs, **blank chart canvases** (the R12-1
  class: laid out and visible but entirely uniform pixels), and horizontal page
  overflow.
- `drive-f13.js` — the S39 keyboard walk: every non-button click target is
  focusable, activates on Enter/Space, shows a focus ring, doesn't scroll on
  Space, and round-trips `aria-expanded`.
- `drive-subqueue.js` — the collapsible sub-queue groups, the S35
  parent-subtotal parity property, and the combined **and** single-dept CSV
  shapes. The **only automated coverage of any CSV writer in this repo** (S43):
  the exporter Blob-and-clicks, so the driver stubs `URL.createObjectURL` and
  reads the real bytes. Also the header **department switch**, which threw a
  `ReferenceError` in production until a driver first tried it.
- `drive-admin.js` — the six **admin modals** (Alerts, Outlier Fix, Dept
  Config, Access Control, System Health, Caller Lookup) and the **Escalations
  worklist**. Each modal must open, render content, trap focus over 25 tabs,
  close on Escape and fit the viewport, with no page or console errors; the
  Escalations page must render its cards, give an admin the dept filter, and
  never duplicate its nav count badge across re-entry (F10). Modal ids come
  from the ROUTER TABLE in `script-4-nav.html`, which is the authority --
  guessing them is what left phase3 silently checking a modal that does not
  exist. These surfaces had thorough server-side pins and, until this driver,
  nothing asserting that any of them RENDERED.
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
