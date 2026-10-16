# Site integrations

Each vetted website is a bundled JavaScript **module**. X and LinkedIn are the
first two **adapters** at the same site-measurement **seam**. A module owns all
of its site's routes, selectors, labels, composer state, keyboard conventions,
action interpretation, default activation, and access policy. Shared tracking
and access code never branch on its site ID.

## Available is not active

`extension/sites/index.js` is the explicit vetted catalog. It determines which integrations
ship, not which integrations a user activates. Users independently enable or
disable available sites in Settings; their choices persist locally.

X and LinkedIn declare `defaultEnabled: true` in their modules. New integrations
omit this flag and start disabled until the user enables them. Adding a module
file without registering it does not ship or activate it.

## Plugin interface

A module publishes the same object through `module.exports` in Node and
`globalThis.C3_SITE_MODULES[id]` in the browser. Copy the small publication pattern
from `x.js` or `linkedin.js`; no browser objects are touched until `create(...)`.
The exported object is:

```js
{
  id: 'example',
  name: 'Example',
  hosts: ['example.com'],
  actions: ['posts', 'likes'],
  classifyPage(state),
  create({ document, location, dom })
}
```

`id` is a stable lowercase ID using letters, digits, `_`, or `-`. `hosts` lists
exact HTTPS hosts, without wildcards or aliases. `actions` lists supported
existing action fields only.

Gated modules also declare optional `access`:

```js
{
  domains: ['example.com', 'alias.example'],
  home: 'https://example.com/feed/',
  redirectRuleId: 4,
  ruleIds: [201, 202],
  unrestrictedRules: [...],
  sessionRules: [...]
}
```

`domains` lists bare blocking roots, including aliases, and covers their HTTP/S
subdomains separately from exact HTTPS tracking hosts. `home` is the owned HTTPS
URL opened after unlocking. Rule IDs use the browser's positive signed 32-bit
range and are unique across integrations; keep them stable. Redirect IDs reserve
one additional ID for the generated shared blocking rule.
`redirectRuleId` identifies the static navigation redirect;
`ruleIds` lists every session rule the gate must remove when access ends.

`unrestrictedRules` declares request rules permitting unrestricted browsing when
Limit & track is Off. `sessionRules` declares request rules permitting timed or
above-goal access, including the site's iframe policy. These are static rule
arrays, not mode-switching functions. The shared blocker selects the appropriate
rule set or removes all allow rules when access ends. Each array uses unique IDs
from `ruleIds`. The catalog exposes `gated` and `defaultEnabled` capabilities to
shared code and owns HTTP/S access lookup through `forAccessURL(...)`.

`classifyPage(state)` returns `create`, `consume`, or `neutral`. Its state details
belong to that module, not the shared tracker. It must return neutral for invalid
URLs and hosts/protocols outside its own integration. This pure entry point is
also used by the core's compatibility classifier and non-DOM tests.

`create(...)` returns a fresh per-document adapter with two methods:

```js
{
  mode(),
  action(event)
}
```

`mode()` returns the current page's `create`, `consume`, or `neutral` mode.
`action(event)` returns the recognition result below or `null` for an unsupported
event. Both adapter methods are synchronous and read-only. They return recognition
results, not promises or side effects. An action result is:

```js
{ button: someElement, action: 'posts', submission: true }
```

- `button` is the actual recognized submit/action Element. Return the same
  Element for a keyboard submission and its generated click so shared
  deduplication counts them once.
- `action` must be declared in the module's `actions` list and supported by the
  shared data format. Quotes remain a subtype of posts.
- `submission` distinguishes post/reply/comment submission from light actions;
  light actions return `false` and receive no score credit.
- Return `null` when an event does not represent a supported action. Do not
  mutate events, intercept scrolling, or read/save editor text.

Adapters own transient intent and composer state. That state is separate for
every document and discarded when tracking is disabled. Modules recognize
activity and declare access policy only: they must not write storage, send
extension messages, change preferences, make network requests, manipulate page
content, or grant access.
These are reviewed, trusted modules, not a sandbox for third-party code.

## Shared implementation

- `extension/src/content/dom.js`: injected, site-agnostic DOM mechanics such as visible
  element lookup, composer scoping, positive light-action lookup, and submit-key
  filtering. No website selectors or site-ID dispatch live here.
- `extension/src/content/content.js`: trusted input, focus/visibility, idle clipping, interval
  splitting, action deduplication, retries, and user activation.
  It creates an adapter only after the worker confirms the site is enabled and,
  for a gated site, has timed or optional above-goal access.
- `extension/src/background/background.js`: sender validation, supported-action validation,
  disabled-site packet rejection, serialized storage updates, and preferences.
- `extension/core/core.js`: scoring, time helpers, stats, history, and export. Site lookup
  and compatibility classification delegate to the catalog.
- `extension/src/background/blocker.js`: waits, budgets, midnight refills, session-rule updates,
  and tab redirects. Site modules supply gate metadata and allow rules.
- `extension/src/content/access-guard.js`: catalog-based access lookup and authoritative
  budget checks; unknown URLs never fall back to another integration.
- `extension/build.js`: bundles registered modules into `sites.js` and generates
  permissions, script matches, blocked-page access, and `block-rules.json` from
  their hosts and access declarations. Tests/helpers/docs never enter that bundle.

The tracker catches adapter creation, classification, and action failures,
including invalid results. It pauses **only that document's integration until
reload**, drops unsaved packets, and reports a developer-console
warning. Other sites and saved user preferences are unaffected. It never silently
falls back to another site's behavior.

## Add, edit, remove

**Add:** create `extension/sites/<id>.js` and `extension/sites/<id>.test.js`, then register
`{ id: '<id>' }` in the catalog. Declare exact tracking hosts in the module;
permissions and script matches are generated. A reviewed access gate additionally
declares `access`. No site-specific edits to shared code or the source manifest
are required. Rebuild and load the extension. Users then choose whether to enable
the new site.

**Edit:** change the site's module and colocated tests. Keep the stable ID so
saved preferences and history still refer to the same website. Host changes
regenerate permissions and may require browser permission approval.

**Remove:** remove its catalog entry, module, and tests. The next build removes
its generated bundle code, rules, matches, and permissions. Recorded history
remains in aggregate totals, charts, badges, per-site rows and CSV; a removed site
uses its stable ID as a fallback display label and cannot record new activity.

Tracking support does not automatically add an access gate. X and LinkedIn have
explicit gate support: their **Limit & track** switch enables timed access and
creation-score measurements together. Their domains, home URLs, rule IDs, and
iframe-specific allow rules live in their site modules. Shared code enforces
access timing and applies their policies.

## Tests and leverage

The **interface is the test surface**. Colocated tests exercise actual adapters,
not private composer helpers. Shared tracker tests use those same adapters for
keyboard/click deduplication and disabled tracking, plus synthetic adapters for
failure isolation and third-site support.

The declared-match DOM fixtures in `test-support.js` keep tests dependency-free;
they do not replace live CSS/markup validation. Use stable Node.js 24.x and pnpm
12.x, run `pnpm install --frozen-lockfile`, then `pnpm test` and `pnpm build`
from the repository root. New integrations need manual checks
against the site's current UI as well as automated coverage.

**Locality:** a site's behavior and verification stay together.
**Depth:** two adapter methods hide its route/DOM/event implementation.
**Leverage:** the same seam supports users' site choices without new shared
site-ID branches. See [Contributing](../../CONTRIBUTING.md) for the GitHub review
process.
