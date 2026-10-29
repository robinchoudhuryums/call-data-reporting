# Rendered UI harness (audit tooling — never deployed)

Runs the REAL dashboard client (dashboard.html + script.html + styles.html)
in headless Chromium against payloads computed by the REAL server code
(via `tests/harness/loadGas` over fixture sheets + a fake JDBC conn), with
`google.script.run` stubbed. Found the R12-1 blank-missed-chart and R12-2
gray-arrow bugs that unit tests structurally cannot see.

## Run the CI gate (one command, from the repo root)
```bash
cd tools/ui-harness && npm init -y >/dev/null && npm i playwright@1.62.1 && cd -
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
- `drive-smoke.js` — (since #81 also the generated Individual Report's
  exception-day note) boots every page as admin AND manager; fails on page /
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
  the owner walks S54 in two real browsers for the browser's half. It also
  walks VIEW-AS-MANAGER: enters the preview, checks the admin-only surfaces
  are actually hidden (measured as rendered visibility, not a class),
  reverses cleanly, and throws nothing. Since 2026-10-21 it also checks the
  admin brief re-runs with the bottom Insights region collapsed, that Insights
  Copy image / Print include the brief's sections, and that a side panel's ⓘ
  shows one circled i on hover.
- `drive-f13.js` — the S39 keyboard walk: every non-button click target is
  focusable, activates on Enter/Space, shows a focus ring, doesn't scroll on
  Space, and round-trips `aria-expanded`.
- `drive-subqueue.js` — the collapsible sub-queue groups, the S35
  parent-subtotal parity property, and the combined **and** single-dept CSV
  shapes. The **only automated coverage of any CSV writer in this repo** (S43):
  the exporter Blob-and-clicks, so the driver stubs `URL.createObjectURL` and
  reads the real bytes. Also the header **department switch**, which threw a
  `ReferenceError` in production until a driver first tried it.
- `drive-journey.js` — the **"↳ path" call-path drill**: the origin line,
  the OUTBOUND call reached through the related-call link, and the
  not-entitled refusal. All three were unit-pinned but had never RENDERED
  until this driver clicked one (the dept-selector class of bug); the drill
  was unreachable by any driver until `getCallJourney` was mocked, since
  drive-smoke's unmocked-RPC check would have flagged the call.
- `drive-agentpanel.js` — the My Department **row-click inline agent panel**
  (Batch B): open, day / tab switch, survives a re-sort, the IR button,
  Escape / Collapse focus return, one panel at a time, CSV untouched, 360 px.
  Since 2026-10-21 also the open / close slide (settled = unclipped, a
  closing panel detached at once) and the admin-only outbound call ids;
  since SB-1 the day's outbound split bar adding up to Placed.
- `drive-daybars.js` — (since 2026-10-21 also the target line on % Ans and
  Abandoned %, never among the bars) the team cards' **linked day bars** (Step 4): one
  shared selection, workday / monthly buckets, keyboard + touch, admin-only. Since QD-1
  it also checks the Queue calls and Abandoned % cards' vs-prior chips.
- `drive-dayqv.js` — the **day quick view** (QV-1, owner 2026-10-29;
  admin-only, released with the day bars): a click on a day bar opens THAT
  day; its cards equal the bars' own readouts beside the range figure; it
  reads that day first, then only its two neighbours (QV-1b prefetch: a step
  to the next day paints with no new request and queues the one after); the condensed
  agent table with its total row and outbound column; the 18-slot missed
  chart, ring times and "↳ path"; a name opening that agent's day; the
  arrows stepping workdays (ends disabled) and the arrow keys; Escape and
  focus return; Enter on a selected bar; "Open this day on the page"; month
  bars not opening it; a manager without it; 360 px.
- `drive-exceptions.js` — **exception days** (Operator State #81): the
  disclosure note on My Department, Insights and the Overview (day, reason,
  calls left out), one striped untinted bar per day-bar card with an
  "Excluded" readout, the admin-only include switch re-asking the summary and
  the missed calls WITH the flag and back, View-as and a manager never seeing
  it, the Overview trend's shaded band + bridged lines, 360 px.
- `drive-notify.js` — the **Notifications** page: sentence rules, History,
  Test send, the manager-layer switch, a manager's Settings section off and
  on (Step 5a); the coaching gates, Met / Rotated / Dismissed and the held
  manager email (Step 5b); the alert reasons' sentences and Preview rows
  (Step 5c).
- `drive-deptoutbound.js` — (since LB-2, 2026-10-28, the one-line agent
  table: 7 cells on CSR, the group row with its keys, every inbound and
  outbound bar adding up to its counts with the per-day pace under them, the
  two scales, two rate chips per row and the count changes in the hover, and
  every header's sort -- and the D3 Team
  Direct Calls card: lazy, one request per window, the coverage note, the
  report button, absent for a manager) the My Department **outbound columns** toggle (on
  by default since Step 3; it replaced the Inbound | Outbound | Both switch)
  and Team Outbound panel (Batches D/F): payload totals, manager and
  View-as fall back to Inbound, panels never overlap, prior-period chips on
  agent rows only, and one request per window (a Refresh never re-sends one
  in flight; the table and the Outbound summary share one store, FO-3).
  Since SB-2/3/6 also the Team Direct Calls and Team Outbound slim bars
  adding up to their totals, and the CSR Transfer detail's two split bars
  (destinations incl. the hatched untracked part, and calls handled per
  agent with the transferred part tier-coloured, sorted by transfers).
- `drive-crossstate.js` — **cross-state sequences** on My Department (E5 /
  ST4), the manager-release readiness check for UX-2 and 6c: a dept switch
  with the brief open (it follows the new dept's payload, tier and default-
  target label), a dept switch in the Outbound view (the direction holds, no
  previous-dept row survives), the brief's Callbacks row never quoting another
  dept, View-as in and out (brief + switch hide, the direction falls back to
  Inbound and returns, the brief comes back WITH its Callbacks row), and the
  Callbacks jump changing direction only from Inbound (F24). The Insights mock
  routes by dept and serves real CSR and Sales captures. Since BR-1 it holds
  the new dept's Insights reply back (`__HARNESS__.delay`, a per-call hold the
  harness stub honours) to check the brief reads "Loading <dept>…" meanwhile.
- `drive-outbound-e.js` — the Overview tiles' outbound line per card window
  and the **Outbound summary** under the outbound table on My Department
  (Batch E; moved out of Insights by UX-1): two-window deltas, shown only on
  Outbound / Both, never for a manager or View-as. Since QD-2 it also checks that the tiles'
  abandoned chips and the sub-queue strip's Abd follow the card window, with
  tooltips, and (QD-3) the "viol MTD" chip's 0 green / 1-3 amber / 4+ red tiers
  (the amber colour on a probe chip, since whether the fixture holds a 1-3
  month depends on the run date). Since SB-3 the tiles' slim connected /
  did-not-connect bar and the summary's one Placed bar (parts add up, five
  vs-prior chips).
- `drive-callbacks.js` — the **Callbacks** section under the outbound table on
  My Department (G1; moved out of Insights by UX-1): lazy (one
  fetch, on open), the shared renderers incl. a drawn chart after a reopen,
  the not-called-back drill's call path, CSV / email, 360 px, and the retired
  modal's `#/report/outbound` deep link (G3) for an admin and a manager; since
  CE-2/CE-3 also both drill lists (episode grouping, the outbound "callback
  path") and the lazy Direct lines block with its repeat-callers list; since
  the follow-ons, the misdial count line (FO-1) and the deep link holding the
  fold at the TOP of the screen while the page settles (FO-3); since
  CB-R1/DL-R2 the callback summary's bar and legend (one base, adding up) and
  the Direct lines summary + department table with its person drill.
- `drive-cbdept.js` — **Callbacks by department** on the Overview (G2):
  admin-only, lazy (nothing on landing), its own window + sort, grouped rows,
  keyboard expand and sort, CSV bytes, and (CE-3) the company Direct lines
  block, including its spreadsheet-served note (FO-2); since CB-R1/CB-R2 the
  summary that leads with the unreturned callers and its one-base bar, the
  most-not-called-back default order, and a row's own unreturned-caller list.
- `drive-admin.js` — ten **modals** (Alerts, Outlier Fix, Dept Config,
  Access Control, System Health, Caller Lookup, Coaching, Exception Days --
  since #81 its list, the in-place refusal of a missing reason, save, and a
  danger-tone Remove -- and the Agent Day
  report, run past its setup form -- whose outbound cards must carry an admin's
  call id and an OUTBOUND path drill that opens; and, since D1, the Direct
  Calls report -- a clean company run with its chips, then a clamped + gappy
  dept run: the coverage note, the corrected End date, no chips, the int / ext
  split; the Outbound modal is retired, G3; since SB-1/2/5 the Agent Day
  outbound bar, the Direct Calls split summaries adding up to their
  headlines, and the Inbound report -- mocked for the first time -- as one
  answered / rang out / hung up bar plus where the hang-ups happened) and the **Escalations
  worklist**. Each modal must open, render content, trap focus over 25 tabs,
  close on Escape and fit the viewport, with no page or console errors; the
  Escalations page must render its cards, give an admin the dept filter, and
  never duplicate its nav count badge across re-entry (F10). Modal ids come
  from the ROUTER TABLE in `script-4-nav.html`, which is the authority --
  guessing them is what left phase3 silently checking a modal that does not
  exist. Since F1 that mirror is ENFORCED: `cross-file-pins.test.js` fails
  when a `kind:'modal'` route is neither driven by an asserting driver nor
  listed in its `DRIVER_MODAL_EXEMPT` with a reason (the Inbound and Direct
  report modals are the current exemptions -- admin-only while vetted, no
  harness fixture yet). These surfaces had thorough server-side pins and, until this driver,
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
  a shared runner, because a fresh Proxy is minted either way. A manager
  gets no overlay even with the localStorage flag hand-set.
- `build-agent.js` + `drive-agent.js` — the **agent app** (the fourth role's
  separate page): boot, the hidden rank line, rendered teammate-name
  PRIVACY, the History tab, no errors / unmocked RPCs / self-beacons, the
  360 px overflow check on both tabs, and (#81) the "Not counted" exception-day
  note from the real exclusion step.

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
