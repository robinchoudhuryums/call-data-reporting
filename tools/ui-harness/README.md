# Rendered UI harness (audit tooling — never deployed)

Runs the REAL dashboard client (dashboard.html + script.html + styles.html)
in headless Chromium against payloads computed by the REAL server code
(via `tests/harness/loadGas` over fixture sheets + a fake JDBC conn), with
`google.script.run` stubbed. Found the R12-1 blank-missed-chart and R12-2
gray-arrow bugs that unit tests structurally cannot see.

## Run (from this directory)
```bash
npm init -y && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright \
  chart.js@4.4.4 chartjs-plugin-datalabels@2.2.0 html2canvas-pro@1.5.11
mkdir -p site/vendor
cp node_modules/chart.js/dist/chart.umd.js site/vendor/chart.umd.js
cp node_modules/chartjs-plugin-datalabels/dist/chartjs-plugin-datalabels.min.js site/vendor/datalabels.min.js
cp node_modules/html2canvas-pro/dist/html2canvas-pro.min.js site/vendor/html2canvas-pro.min.js

node gen-payloads.js          # Overview/dept/missed/IR/Insights payloads (real server code)
node gen-phase3.js            # Escalations (fake JDBC) + admin-modal inits
node build-harness.js admin && node build-harness.js manager
node drive.js                 # Phase 1: Overview + My Department sweep
node drive-insights.js        # Phase 2: Insights
node drive-phase3.js          # Phase 3: Escalations + modals
node drive-f13.js             # F13: keyboard-only walk of the non-button click targets
```
Output: `shots/*.png` + `report*.json` (console errors, overflow, focus
walks, contrast, focus-trap escapes); `drive-f13.js` prints PASS/FAIL per
check and exits non-zero on any failure.

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
