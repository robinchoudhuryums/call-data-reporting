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
runs the two **asserting** drivers, and exits non-zero on any failure. It SKIPS
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

### Exploratory drivers (artifacts for a human to read — NOT in CI)
```bash
node gen-payloads.js          # Overview/dept/missed/IR/Insights payloads (real server code)
node gen-phase3.js            # Escalations (fake JDBC) + admin-modal inits
node build-harness.js admin && node build-harness.js manager
node drive.js                 # Phase 1: Overview + My Department sweep
node drive-insights.js        # Phase 2: Insights
node drive-phase3.js          # Phase 3: Escalations + modals
```
Output: `shots/*.png` + `report*.json` (console errors, overflow, focus walks,
contrast, focus-trap escapes) — findings to read, not a pass/fail signal, which
is why CI runs only the two asserting drivers above.

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
