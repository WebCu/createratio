# Contributing to CreateRatio

Project standards for human and agent contributors live here; verification
procedures and completion criteria live in [docs/testing.md](docs/testing.md).
Keep [AGENTS.md](AGENTS.md) as an entry point, not a second rulebook.

## Project principles

- **Create more, consume intentionally.** Help people act on their intentions,
  not maximize engagement.
- **Privacy by default.** Activity stays local. No advertising, behavioral
  profiling, or selling personal activity data. Any cloud or paid service must
  be optional and explicitly opt-in.
- **Security by design.** Minimize permissions, dependencies, and collected
  data.
- **Speed and lightness.** CreateRatio should feel instant and use minimal
  memory, CPU, and battery. Tracking must not slow down browsing. Intentional
  friction supports deliberate choices; software delays do not.
- **Free and sustainable.** Our browser extensions and their future
  improvements stay free and open source. Donations and optional paid products
  or services may fund the project, without weakening the free extensions or
  compromising privacy.
- **Prefer the simplest solution that meets the need.** Add complexity only
  when a simpler approach cannot solve a real problem.
- **Keep dependencies at zero, or as close to zero as possible.** Prefer
  built-in browser and Node.js capabilities. Any new dependency needs a clear
  justification and maintainer approval. For dependency, toolchain, or CI
  changes, follow the [dependency policy](docs/dependencies.md).
- **Do not add AI to the extension unless it solves a real user problem.** AI
  is not a feature goal on its own. Using AI to develop and maintain the
  extension is welcome and encouraged; contributors remain responsible for
  reviewing and verifying their work.
- **Avoid feature bloat.** Before proposing new functionality, identify the
  real user pain point it solves. Consider whether it can replace an existing
  feature instead of adding another one. Prefer improving what already exists
  when that solves the problem.
- **Opinionated defaults, user control.** Build for the maintainer's own
  create-more workflow first. Intentional friction can be on by default; users
  can tune or disable it. Preserve saved choices. No forced accounts or
  artificial lock-in.

For feature proposals, explain the user pain point, why the simplest existing
solution is insufficient, whether an existing feature can be removed, and how
users will enable or disable the functionality.

## Source layout

For extension source or test moves, packaged-path changes, or manifest changes,
read the [extension layout and packaged-path contract](extension/README.md#layout-and-installation).
Search references across the whole repo, including shared test harnesses and
`extension/sites/test-support.js`.

## Website integrations

CreateRatio's website catalog is maintained through this GitHub project. Users
choose which vetted integrations to enable in Settings. Arbitrary domains and
user-supplied scripts are not accepted by the extension. New integrations become
available after review, merge, and an extension release, not through remote code
or an online rules service.

### Propose a website

Open an issue describing:

- The website and the exact HTTPS hosts that need tracking.
- Which routes represent consuming, creating, or neutral activity.
- Which actions to recognize (for example, submitting a post or comment).
- Relevant languages, keyboard shortcuts, and known limitations.

A domain alone is not an integration. A meaningful action needs a site-specific,
reviewable way to recognize it. Do not include private posts, account details,
browsing history, or credentials in issues or test fixtures.

### Implement an integration

1. Create `extension/sites/<id>.js` and colocated `extension/sites/<id>.test.js`. The module owns its
   metadata, routes, selectors, labels, composer state, action recognition, and
   any reviewed access-gate policy.
   Follow the small [plugin interface](extension/sites/README.md#plugin-interface) and use
   X/LinkedIn as working examples. Keep IDs stable: preferences and history use them.
2. Add `{ id: '<id>' }` to the explicit vetted catalog in `extension/sites/index.js`.
   Registration makes an integration available, not active;
   extension users decide which websites to enable. No site-specific edits to
   the shared tracker, DOM helpers, storage writer, or Settings page are needed.
3. Declare exact HTTPS tracking hosts in the module. The build generates narrowly
   scoped permissions and content-script matches from the catalog. Use the shared
   tracker so focus, visibility, trusted-input, idle, retry, and enable/disable
   rules remain consistent. Do not add site-specific data to the source manifest.
4. Use existing action fields only when their meaning matches. Adding a new
   action field or score credit needs a separate design decision and updates to
   storage, export, UI, documentation, and tests. Quotes remain a subtype of posts.
5. Add classifier, DOM, content-tracker, background validation, and browser-build
   tests. Cover disabled tracking, editor precedence, keyboard/click
   deduplication, unsupported routes, and unsupported actions.
6. Document the integration's measurement rules and limitations in
   `extension/README.md`. Include sanitized fixtures and manual browser checks
   for the current website UI. Check narrow and keyboard-accessible popup UI.

The Settings page's available-site list and sender/action validation use the catalog.
Recorded history and CSV remain available even after an integration is removed.
The build packages registered modules into `sites.js`; unregistered code and
colocated tests do not ship. See [Site integrations](extension/sites/README.md)
for selector changes, editing, removal, failure isolation, and ownership rules.

Tracking support does **not** automatically add whole-site blocking. X and
LinkedIn have explicit gate support: **Limit & track** enables their gate and
creation-score measurements together. Adding a gate is a separate product
change: declare its domains, home URL, stable rule IDs, and allow rules in the
site module's optional `access` interface, with colocated policy tests. Shared
access code, Settings, and the build discover gate support through the catalog.

## Coding standards

- **Zero comments in code.** Do not add code comments, including inline,
  block, or documentation comments. Code must be self-explanatory through
  clear names, simple control flow, and small, focused functions. Refactor
  unclear code rather than explaining it with comments; put supporting
  rationale in Markdown documentation.
- **Keep documentation minimal, specific, and current.** Describe verified
  behavior and constraints, not past implementations or future plans. Keep
  internal review transcripts, account-specific infrastructure details, publisher
  approvals, and temporary verification artifacts outside the public repository.
  Keep public privacy disclosures and reusable verification guidance.
- **Keep personal tooling local.** Editor and AI-agent preferences, extensions,
  and machine-specific setup belong in user-level or ignored local configuration.
  Shared project requirements belong in tool-neutral documentation, scripts,
  and CI.

Use the product terms in [GLOSSARY.md](GLOSSARY.md). Keep behavior behind small
interfaces and reuse existing modules. Tests exercise those interfaces using real
application logic; substitute only external browser APIs, time, randomness, and
sanitized website fixtures. Assertions describe observable outcomes, not private
helper calls or internal call order. For documentation and legal pages, test
build output, delivery, links, and executable behavior—not exact prose or the
truth of externally managed facts. Review factual and legal claims against their
evidence separately.

Keep tests deterministic and replayable. Reproduce bugs before fixing them.
Follow the [tracer-bullet workflow](docs/testing.md#strategy-and-completion) for
acceptance criteria, sensitive tests, and incremental implementation.

### Resource contract

Extension changes affecting timers, messages, observers, listeners, queues,
caches, retained data, or content-script injection and bundle size are
resource-sensitive. Apply these requirements before implementation, including
when the change is described as a refactor:

- **Quiet idle:** inactive creation trackers with no pending measurements send
  no periodic worker requests. Local timers and resident content scripts may
  remain; they must not keep the worker alive with empty work. Pending delivery,
  foreground synchronization, and scheduled access enforcement remain valid work.
- **Bounded state:** give queues, caches, and retained DOM references an explicit
  bound and overflow or eviction policy. Preserve unsaved measurements: pause
  new collection under sustained failure rather than silently losing queued data
  or allowing unbounded growth. Reuse existing limits where applicable.
- **Owned lifetimes:** identify who owns each timer, listener, observer, and
  retained object, and when it is released or paused. Repeated navigation,
  enable/disable, and restart cycles must not accumulate duplicate resources.
- **Per-tab cost:** account for resources multiplied across open tabs. Prefer
  existing shared machinery and narrowly scoped injection over another timer,
  observer, copy of history, or bundle in every page.
- **Evidence before acceptance:** follow
  [resource verification](docs/testing.md#resource-verification). An increase
  beyond the agreed measurement tolerance requires a user-facing justification
  and explicit maintainer approval before merge. Do not weaken a regression
  check or reset its baseline merely to make the change pass.

### Review checklist

Automated tests enforce mechanical rules; review the decisions they cannot prove:

- **Ownership:** follow a policy through settings, defaults, runtime, permissions,
  and generated assets. Moving one file is insufficient if shared code still
  makes site-specific decisions. Registration alone must expose capabilities.
- **Interfaces:** prefer named policy data over mode-switching functions. Keep
  validation helpers focused, and name numeric bounds by their meaning. Do not
  add a general framework for two concrete policies.
- **Compatibility:** preserve stable IDs, saved preferences, recorded history,
  defaults, and intentional differences between integrations, including frames.
- **Test value:** identify the observable failure each new test can detect.
  Prefer enforcement already owned by package managers and other tools over
  reimplementing it. Keep architecture and security policy guards distinct from
  behavioral coverage; repeating configuration values does not test the tool
  that consumes them.
- **Evidence:** distinguish mocked browser-world comparisons from actual browser
  checks, and newly added coverage from existing tests rerun. A passing build
  cannot prove live selectors, permissions, or routing. Verify changed behavior
  and its failure paths, not just the happy path.

Review against a fixed baseline and the originating request. Report standards
and request coverage separately, with file locations and actionable findings.
Use the existing code-review skill when an independent review is requested;
keep review transcripts outside the public repository.

## Git synchronization

A fresh `pnpm install` enables staged-whitespace and merge-history guards when
no custom hook path exists. Run `pnpm setup:hooks` for an existing clone or to
enable them explicitly. Existing custom hook paths and non-sample files in Git's
default hooks directory are preserved and reported; integrate
`.githooks/pre-commit` and `.githooks/pre-rebase` into those instead of replacing
or disabling them.

Fetch and merge updated `main` into published feature branches. Before pushing,
use `git pull --rebase --ff-only`: it accepts a fast-forward without flattening
merge commits and stops on divergence. Merge divergent upstream changes rather
than rewriting published history. The hook rejects rebases that would replay
merges on a branch with an upstream or a matching remote-tracking ref.

## Review and verify

Follow [Verification](docs/testing.md) for the testing workflow, completion gate,
and manual release checks.

Pull requests should include automated test results, manual checks, known
limitations, and the supported-host/action matrix where applicable. Maintainers
vet integrations for correct classification, narrowly scoped permissions,
privacy, accessibility, and reliability before shipping them. Never collect
text, keystroke values, usernames, screenshots, URLs, or post IDs as activity data.
