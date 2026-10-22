# Dashboard export memory measurements

Use this contributor tool on Linux with readable `/proc/*/smaps_rollup`, Node.js
24.x, pnpm 12.x and the Chromium setup in [testing](testing.md#browser-setup).
It uses the generated dashboard, not a replacement renderer. No runtime code or
resource budget changes are involved.

## Run

Build baseline and candidate Chrome bundles into separate directories. Keep
inputs immutable, and coordinate CPU-heavy comparisons with other contributors.
Raw output and failure evidence must stay outside Git checkouts. Each output
filename must be new; failed and partial results are retained, never resumed.

```sh
pnpm install --frozen-lockfile
pnpm build:chrome
node --test bin/tests/dashboard-native-profile.test.js
node --test --test-concurrency=1 extension/browser-tests/share-memory.test.js extension/browser-tests/share-card.test.js extension/browser-tests/report.test.js

BROWSER_TIMEOUT_MS=180000 node bin/dashboard-native-profile.mjs /tmp/base/chrome /tmp/candidate/chrome /tmp/dashboard-pilot.json
BROWSER_TIMEOUT_MS=180000 node bin/dashboard-native-profile.mjs /tmp/base/chrome /tmp/candidate/chrome /tmp/dashboard-comparison.json /tmp/dashboard-pilot.json
```

Set `CHROMIUM_PATH` when needed. Only use `CHROMIUM_NO_SANDBOX=1` in an isolated
sandbox that cannot support Chromium's sandbox. Use identical environment
settings for pilot and comparison. Run the normal completion checks from
[testing](testing.md#strategy-and-completion) separately.

Without a pilot argument, the tool runs one fresh-profile pilot per build, each
with two dashboards and two cycles. A successful, matching pilot is required
before the comparison: three fresh profiles per build, alternating order
baseline/candidate, candidate/baseline, baseline/candidate. Each comparison run
has eight dashboards, one Settings page, and twelve cycles. The harness also
owns its initial blank tab and attached extension worker.

Each cycle changes synthetic daily/seven-day totals, generates real PNG previews
in every dashboard and downloads one HTML report from the active dashboard.
Period changes discard previews. Every second cycle clears history through the
real Settings message contract, checks a changed history generation, and
navigates every dashboard through Settings and back. The final cycle regenerates
previews after period clearing so history clearing also releases populated
previews. HTML downloads are deleted after completion. PNGs are encoded by the
real application; the profiler does not decode them or retain Blob, image,
canvas, or remote-object handles. Period selection uses a synthetic change event;
export buttons use the shared trusted-input harness. Storage seeding is synthetic
and does not measure creation-tracker delivery.

The existing browser tests above own no-decoded-image, pixel-fidelity and report
content regressions. The profiler deliberately does not duplicate them.

## Read the evidence

JSON records both bundle inventories and SHA-256 fingerprints using the shared
`bundleFingerprint` API, workload/harness source fingerprint, synthetic fixture
recipe, browser product/revision, Node/OS/CPU/memory/timezone, settings, timestamps,
ordered runs and raw process samples. Input fingerprints are checked around each
run; each browser loads a verified disposable bundle copy and fresh profile.
Comparison `summary` entries contain median, minimum and maximum **bytes** for
each checkpoint/build, separately for owned-process PSS, private memory, and
active-dashboard isolate heap. There is no pass/fail tolerance or automatic
resource acceptance; agree tolerance with a maintainer before interpreting a
candidate as acceptable. Identical bundles can validate the tool, not prove an
optimization.

Checkpoints cover ready pages, populated previews at cycles 1/6/12, final period
clearing, history clearing and navigation. Pilot populated checkpoints are cycles
1/2. Isolate heap is measured after forced GC; process memory follows a fixed
250 ms settlement. Up to three snapshot attempts are allowed; discarded transient
snapshots and reasons are recorded. Persistent churn, missing PSS, ownership or
identity mismatches fail rather than silently reporting a partial total.

## Measurement boundaries

- CDP identifies the browser root; `/proc` must confirm both its unique profile
  argument and ancestry to this profiler. Only its live descendants are sampled;
  unrelated processes and zombies are excluded. PID start times and tree identity
  are checked again after sampling. No system-wide Chromium process-name matching
  or memory collection is used.
- PSS is native-inclusive **whole owned browser-tree** proportional resident
  memory, including JS, renderers, GPU and utility processes. It is not
  extension-only memory. Private bytes exclude shared mappings; summed RSS can
  double-count shared pages. Do not subtract isolate heap from PSS to invent a
  native-only estimate.
- Heap is the active dashboard's isolate, possibly shared with other dashboards;
  page heaps are not summed. Forced GC and CDP perturb behavior. The attached
  worker does not establish normal idle shutdown.
- Sequential `/proc` reads are not atomic. Short-lived or reparented processes
  can escape observation; shared-page accounting and other machine workloads add
  noise. A plateau does not prove absence of leaks.
- Cleanup stops the owned browser and removes its profile, but measurements do
  not cover post-exit OS memory return, exact shutdown timing, GPU hardware,
  physical interaction, other platforms or other browsers.
