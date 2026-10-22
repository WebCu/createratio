# Verification

This guide owns verification workflows, commands, and completion criteria.
Coding standards live in [CONTRIBUTING.md](../CONTRIBUTING.md#coding-standards);
agent navigation lives in [AGENTS.md](../AGENTS.md).

Use stable Node.js 24.x and pnpm 12.x. Other majors are not supported.
CI pins versions within these majors; contributors need not match them exactly:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:browser
pnpm smoke:browser
```

`pnpm check` is the fast gate: JavaScript syntax, deterministic Node tests, all
browser builds, and the website build. `pnpm check:browser` builds Chrome and runs
the built extension in a disposable real Chromium profile. `pnpm smoke:browser`
preserves the broader rule, page, and worker checks. CI requires all three;
missing browsers and failed checks are errors, not successful skips.

`pnpm verify` runs all three completion commands in order, stopping on the first
failure and preserving its exit code. Each invocation creates a fresh private
temporary directory, prints its path, and saves per-stage logs plus `summary.json`.
The summary records the starting commit, working-tree dirty state, and actual Node
and pnpm versions. Unavailable Git or package-manager metadata is recorded as
`null`, not inferred from another checkout. Metadata and release-smoke preflight
Git reads disable optional locks so stat-cache refreshes cannot rewrite the
caller's index.
Later stages are marked **not-run**, with no log file; output from an earlier run
is never reused. Keep these artifacts outside Git and remove them when no longer
needed. Existing browser-failure artifacts remain under `BROWSER_ARTIFACT_DIR`.

## Strategy and completion

Use a testing-trophy shape, not fixed test percentages:

- **Static checks:** parse JavaScript with the pinned Node runtime; verify
  manifest, packaged paths, dependency, and permission contracts.
- **Focused tests:** scoring, URL classification, and time arithmetic.
- **Integration tests:** the largest investment. Exercise real UI or content
  scripts through background messages and storage, replacing external browser
  APIs and time rather than internal application logic.
- **Browser journeys:** a small set against the generated bundle, proving
  browser enforcement and actual page wiring. Sanitized fixtures do not prove
  current logged-in website selectors.

Properties complement these layers: generated action sequences check invariants
that must hold across retries, clearing, disabling, and worker replacement.
When replacing an implementation, compare old and new behavior over the same
seeded inputs, identifying intentional differences before review. Keep the old
implementation only for the migration. Use the existing
[access bundle comparison](#refactor-equivalence) for access-module replacements;
extend comparisons for concrete migrations rather than hypothetical ones.

A tracer bullet is one working user journey across the necessary layers, not a
mocked screen or a new test category. Before implementing, define the outcome,
test interface, acceptance criteria, and commands that decide completion. Add
one sensitive test and the smallest working slice, then extend it. A reproduction
or temporary relevant mutation must make the check fail; restore mutations before
running the completion gate.

Finish source writes before dependent checks and all workspace writers before
the final integrated check. Keep check inputs unchanged while checks run; rerun
affected checks if their inputs change.

Completion means the agreed criteria pass, the diff is reviewed, `pnpm check`
passes, and extension/runtime, manifest, build, or browser-harness changes also
pass `pnpm check:browser` and `pnpm smoke:browser`. Report commands, failures, and
remaining manual checks;
a rerun without explaining a flaky failure is not a fix. Resource-sensitive
changes must also satisfy [resource verification](#resource-verification) before
completion. Release still requires the live-site and platform checks below.

## Resource verification

Classify each pull request against the
[resource contract](../CONTRIBUTING.md#resource-contract). A change with no
resource impact needs a brief reason, not an invented benchmark result.
For resource-sensitive changes:

1. **Set acceptance criteria first.** Identify the affected worker, page script,
   or extension UI; its expected idle behavior, lifetime, retained-state bound,
   and per-tab cost. Choose a fixed baseline, representative workload, and
   acceptable measurement tolerance before implementation. Use existing approved
   budgets; new or relaxed budgets require maintainer approval. Include many-tab
   and repeated navigation or enable/disable scenarios when those costs can change.
2. **Protect observable behavior.** Add or extend a sensitive regression for the
   affected contract and run the normal completion commands. Existing inactive
   polling and retry coverage lives in `extension/src/content/content.test.js`;
   `extension/browser-tests/tracker-idle.test.js` checks hidden-tab polling and
   foreground synchronization in the built extension. Extend lifecycle coverage
   for accumulation, bounds, and cleanup when those are affected. Keep valid
   delivery and recovery paths working while eliminating unnecessary work.
3. **Measure baseline and candidate.** Use generated bundles in separate
   disposable browser profiles, the same browser version, settings, synthetic
   pages, tab counts, and interaction sequence. Repeat each build at least three
   times, alternating build order. Record the reproduction commands, environment,
   observation window, repetitions, and measurements with their units; report
   the median and range rather than selecting the best run. The recipe must be
   reproducible from a clean checkout with documented tools; include reusable,
   non-private fixtures or instruments when needed. Keep raw evidence outside
   Git and use only synthetic, non-personal data.
4. **Attribute the cost.** For worker-lifecycle changes, observe idle shutdown
   with its debugger detached and without polling or profiling that keeps it
   awake. Account for legitimate alarms and delivery retries; also verify wakeup
   and settings recovery on return. For page-script changes, profile retained
   heap separately, using an uninjected fixture as a control when estimating
   injection cost. Compare repeated lifecycle cycles for continuing growth in
   affected components. Worker-process memory, page heap, and whole-browser
   memory are distinct measurements; worker exit does not mean the whole
   extension uses zero memory. Browser shutdown timing is not an exact
   cross-platform deadline.
5. **Report the decision.** Include a compact resource-impact summary in the PR:
   affected components and bounds, behavioral checks, baseline/candidate results
   and variation, reproduction commands, and remaining limitations. Explain any
   increase beyond tolerance and obtain the approval required by the contract.
   Missing or unattributed evidence, or unresolved measurement noise, is
   unverified, not proof of no regression; report it and leave the resource
   acceptance gate incomplete.

CI runs the behavioral regressions through the existing completion commands.
The hidden-tab test checks messages, not actual worker termination or RAM use.
There is no automated memory-budget gate: browser memory measurements and their
acceptance remain a required contributor and maintainer review gate. A green CI
run alone does not satisfy this section.

### Scroll-friction resource comparison

Build baseline and candidate Chrome bundles in separate directories, then run:

```sh
node bin/scroll-friction-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/scroll-document.json document
node bin/scroll-friction-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/scroll-app-shell.json app-shell
node bin/scroll-friction-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/scroll-body.json body
```

This uses the same disposable Chromium runner and sandbox settings as the browser
journeys. Each layout alternates three runs per build with eight synthetic site
tabs, 30 preference/SPA-route cycles, 100 measured trusted wheel inputs, and six
seconds hidden. The app-shell fixture locks a document that still has a scroll
range and scrolls a fixed inner container instead. The body fixture scrolls the
body independently inside a locked root. Before timing, 61 additional wheel
inputs exercise initial handling, every re-enable, and 30 DOM replacements
(including the body element itself in that workload). Assertions verify distance
scaling survives those transitions and DOM-node/listener counts do not accumulate.
It waits for the foreground wheel listener to match each preference before
sampling. It records bundle bytes, wheel listeners, GC-retained active-page isolate
heap and DOM counters, an uninjected fixture control, and page script/task/layout
durations. The active isolate measurement is not total browser RAM or a sum across
tabs. CDP wheel-input
elapsed time includes browser dispatch/acknowledgement overhead; it is not user
input latency. Idle request counts do not prove worker shutdown. Compare medians
and ranges, check lifecycle growth, and apply the resource review gate above.
Keep the resulting JSON outside Git. Output files must be new; interrupted or
failed output cannot pass the report formatter or reuse old evidence.
Each run loads a disposable copy so Chromium's generated rule caches cannot
modify the input bundles. Reports fingerprint every input bundle file and the
profiling/runner source; changes during collection fail the run.

Generate tables from the complete reports rather than copying measurements:

```sh
node bin/scroll-profile-report.mjs /tmp/scroll-document.json /tmp/scroll-app-shell.json /tmp/scroll-body.json > /tmp/scroll-report.md
```

The formatter reports medians and ranges with bundle/workload hashes, environment,
observation times and limitations. It rejects incomplete runs, inconsistent
inventories, duplicate layouts, mixed environments/workloads/bundles and failed
lifecycle invariants. Hashes identify measured inputs, not an inferred source
commit. The report does not grant resource acceptance; keep it outside Git too.

## Reference tracer bullets

The first two examples deepen existing features rather than add functionality:

1. **Intentional access:** a user's intention starts the wait; waiting alone
   cannot open access; explicit confirmation grants a shared active-time budget;
   moving away pauses it; expiry or ending access blocks the site again.
2. **Creation tracking and Clear history:** trusted activity reaches stored
   history, visible score, and CSV export; confirmed clearing removes histories
   but preserves preferences and intentions; pending old deliveries cannot restore
   cleared records; fresh trusted input resumes new measurements.

Fast integration journeys and seeded lifecycle properties live in
`extension/src/tests/`; real built-extension journeys live in
`extension/browser-tests/`. Run the focused loop with `pnpm test:tracers`.

### Replaying properties

The access model tracks focused budget spending independently. The delivery
model tracks credited packets and retained totals across retries, history
resets, failures, and Limit & track changes. Both run against the Chrome and
Firefox-style browser adapters with fixed dates. Default runs exercise thousands
of transitions without adding a property-testing library.

Failures print the seed, case, adapter, machine, failing command prefix, and an
exact replay command. Run from the repository root with a supported Node version:

```sh
CR_PROPERTY_SEED=42 pnpm test:tracers
CR_PROPERTY_SEED=42 CR_PROPERTY_CASE=0 CR_PROPERTY_ADAPTER=chrome \
  CR_PROPERTY_MACHINE=delivery node --test extension/src/tests/lifecycle-properties.test.js
```

`CR_PROPERTY_CASES` and `CR_PROPERTY_STEPS` control bounded exploration; keep
local/CI defaults deterministic. Record a discovered regression as a focused
example before changing the generator. These are seeded model-based properties,
not automatic shrinking: the failure prefix is replayable but not guaranteed
minimal. Generated models stay within one local day and exclude above-goal
access; existing focused regression tests cover those policies.

## Browser setup

Set `CHROMIUM_PATH` (or `CHROMIUM`, shared with the broader smoke runner) to an
installed Chromium or Chrome for Testing executable, then run
`pnpm check:browser`. CI downloads a version-pinned, SHA-256-verified
Chrome for Testing archive; the workflow is the source of truth for the version
and checksum. Update both together after verifying the official download and
running the browser journeys. Regular branded Chrome may reject unpacked-extension
launch flags; use Chromium or Chrome for Testing for this runner.

The runner defaults to `/usr/bin/chromium` and a 90-second watchdog;
`BROWSER_TIMEOUT_MS` can override the bounded timeout. Sandbox disabling requires
`CHROMIUM_NO_SANDBOX=1` and is only appropriate in an isolated Linux sandbox that
cannot support Chromium's sandbox. External traffic is blocked
by interception, an unusable proxy, and DNS isolation; supported-site navigations
receive synthetic offline HTML. Trusted CDP input drives the actual extension UI,
waiting for painted, stable geometry and a matching hit target before dispatch.
The tests shift `Date` in pages and the worker to check the 60-second wait and
expiry without minute-long sleeps; native timers and monotonic time remain real.

Use `findByRole(browser, page, role, name)` and `clickByRole(...)` from
`extension/browser-tests/chromium.mjs` for accessibility-driven journeys. Names
normalize whitespace, hidden nodes are excluded, and duplicate matches fail rather
than choosing a row. Both role/name and selector clicks share painted geometry,
disabled-state, hit-target, and trusted-input handling. Inspect new-tab results
with `Target.getTargets`; the runner does not enable target-discovery events.

For fixtures that seed access rather than exercise the gate UI, use
`seedAccess(browser, sites, settings)` from the same runner. It waits for access
rules after storage changes before navigation. Use `waitForEnabledControl` for
native controls; absent, disabled and aria-disabled elements are not ready.

For scroll-surface fixtures, construct `scrollFixture(browser)` from
`extension/browser-tests/scrolling.mjs` before opening the page. Define the page,
panel and stationary surfaces, prove native Off distances with `assertNative`,
then enable resistance and verify the expected distances. Measurements reject
unreachable starting positions and unsettled scrolling. Keep untouched-default
journeys separate: observe defaults before helpers save any preference.

Run HTML/CSS audits against generated pages such as `dist/chrome/settings.html`
after `pnpm build:chrome`. Source HTML references the flat packaged layout, so
shared stylesheets intentionally do not resolve beside `extension/src/pages/`.
Audit the built assets rather than treating missing source-relative CSS as a
product defect.

Failed journeys save browser version, page/worker clocks, URLs, DOM, screenshots,
console/exception events, requested/actual trusted input targets, access state,
alarms, and session rules before profile cleanup. Startup failures and watchdog
termination also retain available evidence.
The default directory is `dist/browser-artifacts`; set `BROWSER_ARTIFACT_DIR` to
override it. CI uploads this evidence and both browser-command logs on failure,
retaining them for seven days. Capture errors never replace the original failure;
logs retain nonzero exit status through `tee`. These artifacts contain only the
disposable profile's synthetic fixtures; never attach this capture to a personal
browser profile. Diagnose the recorded failure rather than hiding it with retries.

Browser tests use disposable profiles and synthetic data. They do not require
accounts, submit real posts, or establish Firefox/Edge compatibility. DOM
fixtures, controlled clocks, and simulated worker replacement cannot prove
operating-system sleep/wake behavior. Keep those release checks manual.

### Live scroll geometry

When a current site behaves differently from synthetic fixtures, review
[`bin/scroll-geometry.js`](../bin/scroll-geometry.js) and run it manually in that
tab's DevTools Console. It returns JSON containing numeric viewport/scroll
geometry, a bounded ancestor path and allowlisted layout styles. It reads no
page text, input values, URLs, IDs, classes or arbitrary attribute values; it
writes no storage, clipboard or network data. Custom tag names and unknown style
values are suppressed. Review the JSON before sharing it.

If browser automation encounters an operating-system permission denial, stop
that connection attempt and use this manual diagnostic or report access blocked.
Do not bypass permissions or attach the synthetic failure-capture harness to an
authenticated profile. Geometry can help reproduce a layout; it cannot establish
live composing behavior, physical comfort or cross-browser compatibility.

## Verification guards

`pnpm check:syntax` uses Node's parser on tracked and nonignored untracked
JavaScript (`.js`, `.mjs`, and `.cjs`) without executing it, then uses Acorn to
reject code comments with file, line and column diagnostics. An initial hashbang
interpreter directive is allowed; comment-like text in strings, templates and
regular expressions is not a comment. This guard covers JavaScript only, not
CSS, HTML or other languages. `pnpm check` runs it before tests and builds.
The pre-commit hook checks staged whitespace, including newly added files.
`pnpm check` rejects Git-tracked root `.pi`, `.agents/skills`, and `.claude/skills`
paths, including skill-directory symlinks and files force-added while ignored.
Ignored or untracked personal files remain allowed.

For a focused command, use a new log directory and retain the exit code:

```sh
logs=$(mktemp -d "${TMPDIR:-/tmp}/createratio-check.XXXXXX")
if pnpm check > "$logs/check.log" 2>&1; then status=0; else status=$?; fi
printf 'Verification log: %s\n' "$logs/check.log"
tail -n 40 "$logs/check.log"
exit "$status"
```

## Release automation

`pnpm check` includes release-command, package-reproduction and store-submission
tests. These tests additionally require Git, `zip` and `unzip` on PATH. Release
command tests use disposable real Git repositories and local remotes; GitHub CLI
and local-check subprocesses are substituted at their external boundaries. Git
URL queries map only the fixture's approved local transport to the official URL;
all other Git operations are real and restricted to file transport. Tests reject
alternate push URLs and URL rewrites before creating branches or tags. With
automatic tag following and mirror settings enabled, they verify the complete
remote ref set: preparation adds only its branch, publication only its version
tag, and unrelated local refs remain local. They never push to the actual
repository or publish a store version.

The package test extracts the generated reviewer-source archive, rebuilds Firefox
with the real build script, and compares every generated file against the packaged
bundle. It also runs the real build tests with a different synchronized version,
preventing fixed-version expectations from blocking preparation. It checks archive
contents, checksums, stale-output removal, dirty
source refusal and tag/commit mismatches. Store API tests substitute HTTP only,
covering version/pending-submission guards, authentication, validation polling,
write failures and refusal paths. Those tests do not establish live credentials,
provider acceptance or publication.

`pnpm check:release` requires Git, `tar`, `zip`, `unzip` and a clean committed
checkout. It exercises the real prepare/check/merge/publish/package journey in a disposable repository. It reuses
installed dependencies, substitutes GitHub CLI and only the approved local Git
transport, and permits file transport only. Automatic tag following and mirror
mode are enabled to verify that unrelated tags remain local. Logs and the result
summary stay in a fresh temporary directory. Native fetch permits only loopback
hosts and rejects every redirect, including caller-requested redirect following;
requests and string URLs use the same restriction. No store endpoints are called. CI
runs this separately from `pnpm check` to avoid recursive verification.

Before approving each store deployment, test its exact extracted artifact in the
relevant browser and complete the manual extension checks below. Verify Chrome
and Firefox submission results separately. A successful job reports submission;
each store controls review, signing and public availability. See
[releases](releases.md) for commands, approval and recovery.

### Store-integration acceptance

Human validation is a release gate, not a CI result. Keep a new integration's
acceptance incomplete until a maintainer has supervised its first real release.
Do not create a test version or push a tag merely to test credentials. That first
release needs explicit authorization, followed by each store's environment
approval; approving one store does not approve the other.

Before approving a store job:

1. Download that run's artifact. Record its tag, source commit and archive hashes
   from `release.txt` and `SHA256SUMS`; verify the hashes locally with
   `shasum -a 256 -c SHA256SUMS` on macOS or `sha256sum --check SHA256SUMS` on Linux.
   Test a disposable extracted copy in the actual target browser and complete the
   [extension checklist](#extension). For Firefox, use a supported real Firefox
   version, not Chromium emulation, and reproduce the bundle using the
   [reviewer-source instructions](firefox-add-ons.md#reproduce-the-firefox-package-from-reviewer-source).
2. In the owning developer dashboard, check the existing listing, intended version,
   permissions, license and disclosures. Record browser/OS versions, test outcomes
   and remaining limitations against those exact hashes in a private release note.
   Use only a sanitized reference in the deployment approval comment. Never attach
   credentials, activity data or publisher-dashboard captures to the repository.
   Secret-name presence and dashboard login do not prove API authentication.

For the first explicitly authorized real release:

3. Supervise the approved job. Its authenticated read-only preflight must succeed
   before upload; check the upload/validation and version-creation results in the
   relevant dashboard. For Firefox, confirm the intended listed version and
   attached reviewer source. Record each store's result separately. On rejection,
   authentication failure or an ambiguous write, stop and inspect the dashboard;
   do not approve another store as a workaround or blindly resubmit.
4. After signing/review and availability, install the store-delivered extension in
   a disposable profile. Verify its ID and version, behavior and update continuity
   using synthetic saved preferences. Only then record end-to-end integration
   acceptance. A submitted version awaiting review is not a verified installation.

The package job links this gate beside the source commit and checksums before
approval. Environment approval authorizes real writes; it is not evidence that
subsequent authentication, store review or installation has already succeeded.

## Refactor equivalence

Build the same browser at the baseline and candidate revisions into separate
folders, then compare their generated bundles:

```sh
pnpm verify:access /tmp/baseline/chrome dist/chrome
```

The comparison checks exact manifests and static rules, plus metadata-derived
URL variants across eleven access states, including untouched defaults. It compares
lookup, status, session rules, storage, alarms, and redirects in a fixed-clock
browser-world VM. Its own tests
prove that lifecycle and static-rule changes fail. Intentional manifest or policy
changes require separate review, not a skipped comparison. This is not browser QA.

## Disposable Chromium smoke

With Chromium, Python 3, and `browser-harness` installed in your agent environment:

```sh
pnpm smoke:browser
```

`CHROMIUM` selects the browser executable. Only in an isolated Linux sandbox that
cannot support Chromium's sandbox, set `CHROMIUM_NO_SANDBOX=1`.

The command builds Chrome, runs worker-selection regressions, launches a unique
temporary profile, and uses browser-harness to verify the real extension worker,
static ruleset activation,
blocked/Off/session/expired session rules, retained synthetic history, four
extension pages, and blocked home-URL redirects. Worker selection matches the
generated manifest and unpacked extension ID rather than unrelated built-in workers. External
hostname resolution is disabled. It stops its own daemon and browser and deletes the profile.
It never attaches to your normal browser or needs a website login. Browser tools
are not project package dependencies; this check is separate from `pnpm check`.
CI runs the same command in a separate job using browser-harness 0.1.13 and
checksum-verified Chrome for Testing 155.0.8059.79. Telemetry and update checks
are disabled. CI disables Chrome's sandbox only inside its disposable runner;
external DNS remains blocked. It does not prove live selectors, frame behavior,
or sleep/wake.

## Extension

Load a generated browser bundle in a disposable profile and use synthetic data.
Do not commit personal browsing data, intention text, CSV exports, authenticated
screenshots, credentials, or publisher-dashboard information.

Before a release, verify:

- X/Twitter aliases and LinkedIn block, while unrelated sites remain accessible.
- Reloading preserves the 60-second wait; only explicit confirmation unlocks.
- Access budgets are shared per site, pause on tab/window changes, survive
  restarts, refill at local midnight, and revoke access at expiry or manual end.
  A worker wake deducts elapsed active time; actual browser downtime does not.
- Goal-based access applies only above today's current target and returns to
  normal gates at or below it and on a new day.
- In an already-open tab, Limit & track Off removes a site's gate, timer, and
  new score measurements together, retaining history and saved duration.
  Re-enabling records only fresh trusted activity and starts blocked with no old
  budget or pending wait, unless optional above-goal access applies.
- Midnight refills use each site's override or current inherited Default. Off
  cancels refills; above-goal access never re-enables measurement on Off sites.
- Slow scrolling starts on at 50% resistance when no choice is saved. Existing
  Off choices and valid strengths must survive upgrades and restarts. The slider
  adjusts resistance from 50–95% in five-point steps; even Light halves movement.
  Saved positive strengths below 50% resolve to 50% without enabling an Off choice.
  Verify drag previews do not save until release, keyboard adjustments retain
  focus, fast changes retain only the latest pending choice, failures restore
  confirmed values, and reloading or toggling Off preserves the chosen strength.
  Saved zero resolves to Off with 50% ready for re-enabling. At Off or Limit & track
  Off, already-open tabs scroll natively. Verify real mouse wheels and trackpads,
  both directions, fractional movement, zoom, horizontal gestures, nested panels,
  editors, messaging, route changes, and page focus. On app-shell pages whose only
  scroll surface is an inner container, verify it slows even when the document
  has a scroll range but its overflow is hidden or clipped. Panels inside it must
  stay native even above half the viewport height. Cover independently scrolling
  bodies and both propagated and non-propagated body overflow, including hidden
  or clipped bodies with auto-overflow or contained roots. Keyboard, touch, and scrollbar
  navigation must stay native. Check the Settings switch and slider with keyboard
  input at narrow widths, with reduced motion and with forced colors. Synthetic Chromium tests do not establish
  physical trackpad feel or Firefox/Edge compatibility.
- Focused editors, routes, click/keyboard submissions, and light actions behave
  correctly in current logged-in X and LinkedIn UIs. Submissions count once.
- Idle, focus, navigation, midnight, and sleep/wake boundaries do not backfill time.
- All-website permission denial leaves tracking off; opt-in records only focused
  domain/time totals; disabling removes permissions and preserves totals.
- Daily and last-seven-day share-card previews match recorded totals, download
  real 1200 × 1200 PNGs, and have readable branding and time/score caveats at feed
  size. Captions include the public CreateRatio link but no site names or private
  details. Check clipboard success/denial, PNG encoding failure, stale requests,
  repeated preview cleanup, and preview removal on period changes/history resets.
  The canvas preview must match downloaded PNG pixels, retain only one drawing
  surface, avoid decoding PNG URLs, and release its backing dimensions on clearing
  or encoding failure. Include changing totals when repeating previews.
  Ready and pending PNG previews and pending HTML exports must survive normal
  receipt-window rollover; only an explicit history reset invalidates them.
  Sharing is manual and never opens a posting flow automatically.
- Daily and last-seven-day HTML reports download with the selected local dates,
  match dashboard totals, and print/save as PDF offline. Check empty history,
  narrow layouts, keyboard selection, removed integrations, and that neither
  website time nor saved intentions appear. A local-date change during either
  PNG or HTML history loading must show a retry message without generating an
  artifact; retry must use the new period. A history reset during HTML history
  loading must also block the pre-reset response; retry must export only the
  remaining history. Activity and website CSV exports remain unchanged.
- Activity and website CSV exports work. Confirmed clearing removes histories,
  cancellation preserves them, and settings/access boundaries stay unchanged.
  Pending measurements from open tabs or failed deliveries cannot restore cleared
  history; fresh input resumes only new creation tracking.
- Sustained saving failures bound pending packets and pause new measurements.
  Recovery preserves queued actions without duplicates, requires fresh input,
  and does not backfill the paused interval. Receipt-window rollover rejects old
  retries without duplicate credit or keyboard/click double-counting.
- Clear history still works at full storage; a failed reset never reports success
  or deletes preferences, access state, or intentions.
- Intention saving is off by default, respects its limit, clears separately,
  and never appears in CSV exports.
- Retention and size limits remove oldest history without altering preferences.
- Store-installed Chrome feedback opens the correct public reviews page without
  activity data. Unpacked builds show feedback as unavailable.
- Popup, Settings, dashboard, and blocked pages work with keyboard navigation,
  narrow windows, and reduced motion.

Chromium blocking has prior live-browser coverage. Firefox and Edge live
validation, current logged-in selectors, and real sleep/wake behavior remain
release checks, not guarantees from unit tests.

## Website

Verify forward/backward scrolling, narrow and mobile layouts, keyboard navigation,
skip links, direct anchors, reduced motion, and disabled JavaScript. Primary
installation links must open the published
[Chrome Web Store listing](https://chromewebstore.google.com/detail/kopbjmlmjpnkekffalpbjfhmbhgbgamk)
and [Firefox Add-ons listing](https://addons.mozilla.org/en-US/firefox/addon/createratio/).
Source installation links must point to the current repository; Edge
instructions must not imply a published store release. Distinguish temporary
Firefox source installs from the permanent store installation.

Check that reported desktop Chrome and Firefox identities show only the matching
install button in both sections and open the matching instructions. Hidden buttons
must not be displayed or keyboard-focusable. Other store links must remain
available through the installation instructions. Mobile, Safari, Edge, other
recognized Chromium variants, unknown identities, and disabled or blocked
JavaScript must show both install buttons. Report user-agent emulation separately
from native-browser installation checks; detection is best-effort, not a
compatibility guarantee.

Local and non-production hosts must not load analytics. Check that production
analytics failures do not break the page and that distributed license notices
are present. Verify `/privacy.html` and `/terms.html` in source and built
previews, including footer/Settings links, cross-links, narrow layouts, and
keyboard skip links. Both legal pages must work without JavaScript and must not
load analytics.
