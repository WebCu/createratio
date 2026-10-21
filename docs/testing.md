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
node bin/scroll-friction-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/scroll-resources.json
```

This uses the same disposable Chromium runner and sandbox settings as the browser
journeys. It alternates three runs per build with eight synthetic site tabs,
30 preference/SPA-route cycles, 100 trusted wheel inputs, and six seconds hidden.
It records bundle bytes, wheel listeners, GC-retained active-page isolate heap,
an uninjected fixture control, and page script/task/layout durations. The active
isolate measurement is not total browser RAM or a sum across tabs. CDP wheel-input
elapsed time includes browser dispatch/acknowledgement overhead; it is not user
input latency. Idle request counts do not prove worker shutdown. Compare medians
and ranges, check lifecycle growth, and apply the resource review gate above.
Keep the resulting JSON outside Git.

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

## Verification guards

`pnpm check:syntax` uses Node's parser on tracked and nonignored untracked
JavaScript (`.js`, `.mjs`, and `.cjs`) without executing it. `pnpm check` runs it before tests and builds.
The pre-commit hook checks staged whitespace, including newly added files.
`pnpm check` rejects Git-tracked root `.pi` configuration, even if force-added while ignored; ignored or untracked personal files remain allowed.

To print a verification log without swallowing its exit code, including an
expected failing test:

```sh
if pnpm check > /tmp/createratio-check.log 2>&1; then status=0; else status=$?; fi
tail -n 40 /tmp/createratio-check.log
exit "$status"
```

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
- Slow scrolling starts off. Enabling it halves vertical wheel/trackpad movement
  on consuming pages during access; disabling it or Limit & track restores native
  scrolling in already-open tabs. Verify real mouse wheels and trackpads, both
  directions, fractional movement, zoom, horizontal gestures, nested panels,
  editors, messaging, route changes, and page focus. Keyboard, touch, and scrollbar
  navigation must stay native. Check the Settings switch with keyboard input at
  narrow widths and with reduced motion. Synthetic Chromium tests do not establish
  physical trackpad feel or Firefox/Edge compatibility.
- Focused editors, routes, click/keyboard submissions, and light actions behave
  correctly in current logged-in X and LinkedIn UIs. Submissions count once.
- Idle, focus, navigation, midnight, and sleep/wake boundaries do not backfill time.
- All-website permission denial leaves tracking off; opt-in records only focused
  domain/time totals; disabling removes permissions and preserves totals.
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
[Chrome Web Store listing](https://chromewebstore.google.com/detail/kopbjmlmjpnkekffalpbjfhmbhgbgamk).
Source installation links must point to the current repository; Edge and Firefox
instructions must not imply published store releases.

Local and non-production hosts must not load analytics. Check that production
analytics failures do not break the page and that distributed license notices
are present. Verify `/privacy.html` and `/terms.html` in source and built
previews, including footer/Settings links, cross-links, narrow layouts, and
keyboard skip links. Both legal pages must work without JavaScript and must not
load analytics.
