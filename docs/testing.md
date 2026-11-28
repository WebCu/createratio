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

`pnpm check` is the fast gate: code formatting, JavaScript syntax, types, deterministic Node tests, all
browser builds, and the website build. `pnpm check:browser` builds Chrome and runs
the built extension in a disposable real Chromium profile. `pnpm smoke:browser`
preserves the broader rule, page, and worker checks. CI requires all three;
missing browsers and failed checks are errors, not successful skips.

CI runs browser journeys across eight independent runners, with one browser at a
time per shard. `bin/browser-shards.json` assigns every browser test file exactly
once; missing, duplicate, or unassigned files fail before journeys start. After
adding or moving a browser test, update that plan and keep shard durations balanced.
Run one shard locally with `pnpm check:browser:shard 1` (through `8`); the normal
`pnpm check:browser` still runs the complete suite. The broader smoke runs
separately. The existing `browser-smoke` check requires both that smoke and every
journey shard to succeed, including when a dependency fails, is skipped, or is
cancelled. Failed shards retain separately named evidence for seven days.

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

### Update-lifecycle resource comparison

Build the fixed baseline and candidate into separate directories, then run:

```sh
node bin/update-lifecycle-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/update-profile.json
```

The existing update runner alternates three runs per build with eight synthetic
website tabs and Website time enabled. Disposable manifests promote optional
`tabs`/`idle` permissions only. Every debugger is detached during each 42-second
observation. Append `--baseline-idle` when both builds should shut down; otherwise
the baseline must remain running and the candidate must shut down. Its summed
browser-process RSS is not worker-specific or shared-memory-adjusted memory.

### Tracker navigation and worker attribution

The following companion workload adds attribution, repeated navigation and a
natural idle/wake recovery journey without replacing the Website time comparison.
Build the fixed baseline and candidate into separate directories. Both must
support the current tracker and Slow scrolling contracts. Select an installed
Chromium with `CHROMIUM_PATH`, then run:

```sh
node bin/tracker-lifecycle-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/tracker-profile.json --baseline-idle
node bin/lifecycle-profile-report.mjs /tmp/tracker-profile.json > /tmp/tracker-profile.md
```

This alternates three fresh profiles per build with eight synthetic X tabs,
three full navigation cycles, a seeded access session and saved 75% resistance.
Each current document must apply its initial tracking preferences before sampling;
DOM readiness or access-guard readiness alone is insufficient. Post-GC page-heap
samples identify their V8 isolates, with an uninjected page as a separate control.
Do not sum co-resident targets' isolate heaps or renderer DOM counts.

All debugger sessions are detached during each 42-second idle observation.
Browser-level target inventory observes natural worker absence; foregrounding the
same website document must wake a replacement worker and restore the saved
resistance, including its effect on actual wheel input. The fixture records and
clears scheduled alarms immediately before observation, restoring them after wake
with at least one minute remaining. This isolates idle behavior, not scheduled
access enforcement. Website time stays off; manifests and permissions are unchanged.

`--baseline-idle` requires both builds to shut down. Omit it only for a deliberately
non-idle baseline; the candidate must still shut down. Unique user-timing trace
marks attribute worker/page processes, with shared processes and isolates recorded.
Linux `/proc` samples report worker-containing-process PSS/private memory separately
from page heap and CDP-listed whole-browser RSS. PID identity is rechecked; exited
processes, missing/inaccessible counters and unsupported platforms are distinct.
Unavailable values are null, never false zero or a lifecycle failure. Process
memory is not worker-isolate-only memory, and worker exit is not zero extension RAM.

### Hidden-mutation classification comparison

Build the fixed baseline and candidate separately, select Chromium with
`CHROMIUM_PATH`, then run:

```sh
node bin/hidden-mutation-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/hidden-mutation-profile.json
```

This alternates three fresh profiles per build with tracking enabled on a synthetic
X feed. A foreground blank tab makes the feed genuinely hidden; each hidden and
visible phase drives 100 mutation batches 220 ms apart, followed by a 1.1-second
drain. Returning to the feed must reclassify, visible mutations must classify,
and the candidate must make zero hidden-phase classifier calls. A trusted key
event starts visible tracking; the report includes saved consuming seconds.

CDP precise coverage counts adapter `mode` calls without modifying the bundles.
Background timer throttling can coalesce baseline refreshes. CPU sampling at
100 microseconds attributes leaf samples in extension content/site/DOM/friction/
messages scripts; tab-wide `ScriptDuration` is separate. Profiling perturbs timing
and tiny CPU totals are noisy: report medians and ranges, not exact CPU savings.
JSON includes bundle fingerprints, environment and per-phase measurements. Keep
it outside Git. This complements, not replaces, tracker heap and worker checks.

### Hidden blocked-gate worker comparison

```sh
CHROMIUM_PATH=/path/to/chrome CHROMIUM_NO_SANDBOX=1 node bin/blocked-lifecycle-profile.mjs /tmp/baseline/dist/chrome dist/chrome /path/outside/repo/blocked-profile.json
```

The shared runner alternates three fresh profiles per build. One blocked X gate
has no pending wait or access session, Website time stays off, and a neutral tab
is foregrounded. Every debugger session is detached for 60 seconds; browser-level
target polling records worker presence every 250 ms. A page-local counter records
outgoing access-status sends without worker probes. After observation, the same
gate must refresh within 1.5 seconds of returning and display its current blocked
state. Scheduled alarms stay enabled; their schedules and page-observed alarm
events are reported separately, not attributed to periodic polling. JSON retains
raw observations and bundle/workload fingerprints; the command prints per-run
lifetime, alive-sample fraction, hidden/return sends and synchronization results.
Use a new output path outside Git. This measures lifecycle behavior, not RAM or
an exact cross-platform shutdown deadline; maintainer resource acceptance remains
separate.

### Settings-control resource comparison

```sh
node bin/settings-lifecycle-profile.mjs /tmp/baseline/chrome dist/chrome /tmp/settings-profile.json
node bin/lifecycle-profile-report.mjs /tmp/settings-profile.json > /tmp/settings-profile.md
```

This uses the same disposable Chromium runner, bundle fingerprints, attribution
and reporting helpers: three alternating runs per build, four real built Settings
pages and twelve cycles after warm-up. Each cycle refreshes preferences, changes a
preset, opens/saves/cancels Custom, and restores Default inheritance. Every third
cycle reloads each page and verifies the inherited choice. Synthetic select changes
exercise the real page handlers; Save/Cancel use trusted browser clicks. No browser
API or production polling is replaced. Extra pages close before a final retained
page sample; this verifies target teardown, not immediate process reclamation.

Post-GC checkpoints at cycles 0, 6 and 12 reject growth in connected DOM elements,
retained detached Node wrappers, renderer documents and listener counts over
warm-up, while retaining heap measurements without inventing a heap tolerance.
`Runtime.queryObjects` inspects current-realm Node wrappers and releases its remote
handles after each sample. Total wrapper counts vary with V8 wrapper caching;
renderer-wide node counts also include browser/native state. Both totals remain
informational; shared-isolate/renderer counts are not per-page totals. Built-browser
regressions independently retain a detached control or a listener and require each
fault to fail, in disposable fixtures only.

Both commands require a new output path and preserve incremental, versioned JSON
outside Git. Interrupted reports remain incomplete; failed reports cannot be
formatted as successful evidence. Reports fingerprint all input bundle files and
workload sources, reject mixed/incomplete repetitions and environments, and render
median/range tables. Input bundles are copied before launch and must stay unchanged.
Use `BROWSER_TIMEOUT_MS=180000` if the Settings workload exceeds the normal per-profile
watchdog. Keep generated tables outside Git too. Identical-build comparisons validate
instrumentation, not an optimization. Measurements do not establish or relax a
resource budget; maintainer acceptance, store delivery, native Firefox/Edge and real
sleep/wake remain separate gates.

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
inventories, duplicate layouts, mixed environments/workloads/bundles, inconsistent
wheel distances for the same bundle and layout, and failed lifecycle invariants.
Distinct bundles or layouts may intentionally produce different scroll distances.
Hashes identify measured inputs, not an inferred source commit. The report does not grant resource acceptance; keep it outside Git too.

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

Coordinated-update interruption coverage in
`extension/src/tests/update-interruptions.test.js` connects two live trackers to
the real storage/message path, with a discarded-tab control. Cases name the browser
adapter, client order and interruption point (before/after recovery persistence,
partial commit, or before reload). Replay one case with Node's
`--test-name-pattern` option. Lost acknowledgements, failed saving and failed
reinjection must preserve queued packets without duplicate credit; restored inactive
clients must return to quiet idle. These deterministic cases complement rather than
replace the real Chromium same-document update journeys.

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
local/CI defaults deterministic. The daily `explore-properties.yml` workflow runs
ten fresh random seeds at the maximum case and step bounds; it does not gate pull
requests. Each run prints its seed, and failures print the exact replay command.
GitHub emails scheduled-workflow failures only to the last person who edited the
cron schedule.
Record a discovered regression as a focused
example before changing the generator. These are seeded model-based properties,
not automatic shrinking: the failure prefix is replayable but not guaranteed
minimal. Generated models stay within one local day and exclude above-goal
access; existing focused regression tests cover those policies.

## Browser setup

Run `pnpm setup:chromium` once per machine. It downloads the Chrome for Testing
build that CI uses for `linux64`, `mac-arm64` or `mac-x64`, and checks its SHA-256
before it unpacks the archive. A failed checksum leaves nothing unpacked. The
build goes to a per-user cache that all worktrees share
(`~/Library/Caches/createratio` on macOS, `$XDG_CACHE_HOME/createratio` or
`~/.cache/createratio` on Linux; `CREATERATIO_CACHE_DIR` overrides it). A second
run does nothing.

Both browser runners select the browser in this order: `CHROMIUM_PATH`,
`CHROMIUM`, the cached pinned build, then `/usr/bin/chromium`. They stop before
launch if the browser is missing or is branded Google Chrome, which ignores
unpacked-extension launch flags. They warn if its version differs from the pinned
version. The smoke also warns if `browser-harness` differs from its pinned version.

`bin/browser-pins.json` holds the Chrome for Testing version, the per-platform
checksums and the `browser-harness` version. CI installs the same versions, and
`bin/tests/setup-chromium.test.js` fails if the workflow differs from the pins. To
change the version, download each official archive, record its checksum in the
pins, update the workflow, and run the browser journeys and the smoke.

On macOS, both disposable browser runners use Chromium's mock keychain rather
than requesting access to the login keychain. This does not change macOS or
normal-browser settings.

The runner has a 90-second watchdog; `BROWSER_TIMEOUT_MS` can override the
bounded timeout. Sandbox disabling requires
`CHROMIUM_NO_SANDBOX=1` and is only appropriate in an isolated Linux sandbox that
cannot support Chromium's sandbox. External traffic is blocked
by interception, an unusable proxy, and DNS isolation; supported-site navigations
receive synthetic offline HTML. Trusted CDP input drives the actual extension UI,
waiting for painted, stable geometry and a matching hit target before dispatch.
The tests shift `Date` in pages and the worker to check the five-minute default wait and
expiry without minute-long sleeps; native timers and monotonic time remain real.

CI runs the journeys on Linux only. To choose an option in a native `<select>`,
focus it and call `typeAhead(browser, page, text)` with the first letters of the
option label; arrow, Home and End keys open a native menu on macOS instead of
changing the value. After a click on the select, also press Enter: on Linux the click
opens Chromium's own menu, and type-ahead only highlights the option until Enter. Use `selectAllText(browser, page)` instead of a Ctrl+A key
event. `launch(path, { developerMode: true })` turns on developer mode through
`chrome.developerPrivate` and fails if it stays off. Without developer mode,
`chrome.runtime.reload()` disables the unpacked extension.

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

### Isolated browser container

The `browser-tests` Compose service runs the browser checks in a Linux container
with the same Node.js, pnpm, Chrome for Testing and `browser-harness` versions as
CI. Use it for agent runs and whenever a result must match CI. It needs Docker
Compose v2 and runs as `linux/amd64`; Apple silicon uses Rosetta emulation.

```sh
docker compose build browser-tests
pnpm browser:container pnpm smoke:browser
pnpm browser:container pnpm check:browser
pnpm browser:container pnpm check:browser:shard 3
```

The image build is the only step with network access. It installs the locked
dependencies with lifecycle scripts disabled, the pinned browser through
`bin/setup-chromium.js`, and `browser-harness`. At run time the container has no
network, a read-only root file system, no Linux capabilities and a non-root user.
The container does not mount the checkout. `bin/browser-container.js` sends the
files that `git ls-files --cached --others --exclude-standard` lists as a tar
stream on standard input. Ignored files, such as `.env`, `node_modules`, `dist`
and local agent settings, never enter the container. The container unpacks the
stream into a temporary folder and runs the command there.
Chromium runs with `CHROMIUM_NO_SANDBOX=1`; the container is its sandbox. The
only writable host folder is `dist/container`. The wrapper creates it and runs
the container with your user and group IDs. The folder receives
`browser-artifacts/` whenever a run creates that folder, for example after a
failure. An export error never replaces the command's failure status.

The run refuses to start when `pnpm-lock.yaml` or `bin/browser-pins.json`
differs from the image; rebuild the image after a dependency or browser pin
change. Because of the lockfile check, the image turns off
pnpm's own dependency verification, which needs the network. Remove the image
with `docker image rm createratio-dev-browser-tests`. CI builds the image and
runs the smoke in it. The container does not protect against a kernel or
virtual-machine escape, and Debian system packages in the image are not pinned.

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
reject code comments with file, line and column diagnostics. JSDoc blocks that
contain only type tags with a type and name are allowed in the files
`tsc -p tsconfig.json --listFilesOnly` reports, where `pnpm check:types`
validates the types. Files are checked
across at most four workers; any worker failure fails the command. An initial hashbang
interpreter directive is allowed; comment-like text in strings, templates and
regular expressions is not a comment. Ambiguous `.js` files use Node's CommonJS
syntax check, including its wrapper bindings, to select Acorn's grammar. This
guard covers JavaScript only, not CSS, HTML or other languages. `pnpm check` runs it before tests and builds.

`pnpm check:types` runs `tsc --checkJs` without emitting files, so the shipped
JavaScript is not compiled. `tsconfig.json` checks the packaged extension sources
in `extension/core`, `extension/sites` and `extension/src`, excluding tests and
test harnesses. Types come from inference and JSDoc annotations;
`extension/types/globals.d.ts` declares the globals that classic scripts share in
extension pages and the background worker. Extension API calls are checked
against `@types/chrome`, and Firefox's `browser` global is declared with the same
`chrome` API types.
`extension/types/messages.d.ts` types the runtime messages: `messages.send`
accepts only `RuntimeMessage` shapes, and `message-contracts.js` keeps its
allowed values in `Record<…, true>` tables, so a value missing from either side
fails `pnpm check:types`. `bin/tests/message-types.test.js` covers both failures.
`globals.d.ts` also brands local dates and durations as `LocalDate`,
`Milliseconds`, `Seconds` and `Minutes`. Raw values enter through
`Core.validLocalDate`, `Core.validAccessMinutes`, `Core.asMilliseconds`,
`Core.asSeconds` and `Core.asMinutes`. `AccessMinutes` is a `Minutes` value
that is a whole number from 1 to 240: the session and wait preferences.
Raw values become `AccessMinutes` only through `Core.validAccessMinutes`;
Core's defaults and `ACCESS_LIMITS` are the only casts. A converted or tagged
`Minutes` value cannot start an access session. Access replies carry
`sessionMinutes` as `Minutes`, because content scripts check replies without
Core. A `SiteId` matches the stable site ID format; raw values get it only
through `Sites.validSiteId`, which also checks catalog IDs as they load. A
`VettedSiteId` is a `SiteId` for a vetted site. The catalog casts each checked
site module to `SiteIntegration` once, so `Sites.sites`, `Sites.get`,
`Sites.forURL` and `Sites.forAccessURL` give vetted IDs. Raw values get it only
through `Sites.validVettedSiteId`, which accepts only IDs in the catalog. Saved
intentions and recorded history keep `SiteId`,
because a removed integration keeps its history; access statuses and gate URLs
need `VettedSiteId`. Runtime messages and stored `trackedSites` stay plain
strings. `MessageContracts` checks each incoming `site` field with
`Sites.validVettedSiteId`, so a test that adds a site to a fake catalog must
also add it to that guard.
A `WebsiteDomain` is the hostname that website time records: a normalized URL
hostname, with one leading `www.` removed by `WebTime.domainForURL`. Raw values
get it only through `WebTime.validWebsiteDomain`, which `domainForURL` also uses.
Restored session samples and pending entries are checked when they are
replayed, not when they are restored: an entry without a valid `WebsiteDomain`
is dropped then and never reaches history. While website time is off, restored
pending entries wait in session storage unchanged, and a restored sample is
discarded. `WebsiteDomain` and `SiteId` do not
convert to each other. Stored website-time days keep plain string keys.
An `Intention` is trimmed text of 20–280 characters. Raw text gets it only
through `Core.validIntention` or `Core.intentionFromText`, which trims submitted
text first. A new saved intention is built from an `Intention`. Saved
intentions keep `reason` as a plain string: the intention rule applies to new
text, not to history. The intention list shows every saved entry that has text,
a `SiteId` and a valid time, whatever its length, and never rewrites storage.
Saved entries leave storage only when the user clears them or when the latest
100 push them out.
`CreationStats` has every creation-stats field as a finite number of at least
0: `createSec` and `consumeSec` are `Seconds`, and the action fields are counts.
Only `Core.emptyStats`, `Core.statsSnapshot` and `Core.aggregate` create it, all
through `Core.statsSnapshot`; a stored site row becomes `CreationStats` the same
way. `Core.aggregate` adds the rows, then checks the sums, so a total that
overflows becomes 0. Pages convert the time fields with
`Core.minutesFromSeconds`. History writes and the report's per-site running
totals stay untyped. Only
`Core.score` creates a `CreationScore`, and the score display functions accept
only that type. A `DailyTarget` is a number from 0.1 to 100 in steps of 0.1.
Raw values get it only through `Core.validDailyTarget`, and the default setting
is the only cast. `Core.aboveDailyTarget` is the only place that compares a
score with the target. Stored settings and days stay unchecked raw values until
Core reads them.
Points in time use two clocks:
`EpochTime` for `Date.now()` values and `PageTime` for `performance.now()`
values. Code reads a clock at the call site and tags the reading with
`Core.asEpochTime` or `Core.asPageTime`, so tests can substitute time.
`Core.timeAfter` and `Core.millisecondsBetween` accept only one clock per call;
`Core.epochTimeFromPageTime` is the only conversion between the clocks.
`bin/tests/value-types.test.js` checks that mixed units and mixed clocks fail.
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
tests. Workflow tests exercise the submission conditions for published releases and
manual Chrome-only, Firefox-only and both-store runs. They execute the real tag
guard in disposable Git history, including branch, ancestry, version and browser
refusals. They do not dispatch GitHub Actions or verify live Google federation.
These tests additionally require Git, `zip` and `unzip` on PATH. Release
command tests use disposable real Git repositories and local remotes; GitHub CLI
and local-check subprocesses are substituted at their external boundaries. Git
URL queries map only the fixture's approved local transport to the official URL;
all other Git operations are real and restricted to file transport. Tests reject
alternate push URLs and URL rewrites before creating branches or tags. With
automatic tag following and mirror settings enabled, they verify the complete
remote ref set: preparation adds only its branch, publication only its version
tag, and unrelated local refs remain local. GitHub Release creation is substituted;
tests check generated-note/verified-tag options, authentication refusal, and
recovery after release creation fails without moving its tag. They never push to the actual
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
URL variants across nineteen access states, including untouched defaults; three of them run again after a simulated browser restart. It compares
lookup, status, session rules, storage, alarms, and redirects in a fixed-clock
browser-world VM. Its own tests
prove that lifecycle and static-rule changes fail. Intentional manifest or policy
changes require separate review, not a skipped comparison. Stored access entries are compared exactly, after the baseline is normalized by the accepted stored-shape differences: when the candidate ships `site-access.js`, its parser drops empty entries, drops `expiresAt` and `remainingMs` from entries it reads as requests, and drops a `waitMs` that is not a valid wait duration. In the status reply, a baseline `expiresAt`, `readyAt` or `refilledAt` of `0` matches a candidate `null` in the same place, because `null` now means "no time". Everything else is compared exactly. This is not browser QA.

## Disposable Chromium smoke

With Python 3 and the pinned `browser-harness` installed in your agent
environment (for example `uv tool install browser-harness==0.1.13`):

```sh
pnpm setup:chromium
pnpm smoke:browser
```

The smoke selects its browser as described in [Browser setup](#browser-setup).
Only in an isolated Linux sandbox that cannot support Chromium's sandbox, set
`CHROMIUM_NO_SANDBOX=1`.

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

- Enabled X/Twitter aliases, LinkedIn, TikTok, Instagram, Facebook, YouTube and Reddit block,
  including HTTP/S subdomains, while unrelated sites remain accessible. TikTok,
  Instagram, Facebook, YouTube and Reddit all start On for fresh installs; saved On/Off
  choices survive updates without adding sites to an existing selection. Verify browser
  approval of expanded hosts.
- Reloading preserves the configured wait (five minutes by default). Returning after
  a long absence still offers confirmation; only explicit confirmation unlocks.
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
- All seven popup rows show current access without session-time editors.
  Settings opens Websites initially; Browsing, Privacy and Your data open through
  native section summaries, closing the previous section. Verify keyboard access,
  320px layouts, reduced motion and forced colors. Duration menus support presets,
  inherited Default and on-demand Custom edits from 1–240 whole minutes. Verify
  Save/Cancel, invalid input, failed saves, focused drafts across polling and
  retained arbitrary durations after reload. Saving affects new sessions/refills,
  not the current budget; Off disables editing without deleting saved times.
- Available tracking-only integrations start Off and have no access gates or
  session timers. Their compact Settings switches persist independently; enabling
  applies the shared Slow scrolling preference on consuming pages, while editors,
  messaging, unsupported routes and Off retain native scrolling. Verify documented
  submit controls in each current logged-in UI. Disabling preserves history and
  stops new measurements. Check exact HTTPS hosts and update-permission prompts.
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
  activity data. Unpacked and other-browser builds omit unavailable store feedback;
  Privacy policy and Terms of use remain accessible.
- A store-delivered update preserves synthetic measurements, preferences and
  access budgets. With Website time enabled and its debugger detached, the worker
  becomes inactive between alarms. **Update ready** appears in extension pages;
  unsaved settings/intention drafts are never interrupted automatically. Active
  tracking and failed delivery defer automatic installation. Explicit Update now
  confirms intent, flushes pending measurements and restores tracking in existing
  website documents without reloading them. Verify the actual store version
  transition; a simulated available event and unpacked reload do not prove delivery.
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
