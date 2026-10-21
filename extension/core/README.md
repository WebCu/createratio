# Shared core

`core.js` is dependency-free and has no DOM, browser-storage, or network access. It exports CommonJS in Node and exposes `globalThis.C3` in browser bundles.

```js
const core = require('./extension/core/core.js');
const dailyScore = core.score(core.aggregate(day));
```

## Score and classification

```text
score = (createSec + 120 * (posts + replies + comments)) / max(consumeSec, 1)
```

Aggregate recorded sites before calculating the headline score, even if their integration is no longer available. Quotes are a subtype of posts: clients increment both `posts` and `quotes`, but never award a second bonus. Likes, bookmarks, and reposts have no score credit.

`SITES` exposes metadata from the explicit vetted catalog in `extension/sites/index.js`:
stable IDs, display names, exact HTTPS hosts, and allowed action fields. It controls
available-site switches and new collection validation, never permission to display
saved history. Contributions are reviewed through GitHub; see
[Site integrations](../sites/README.md) and [Contributing](../../CONTRIBUTING.md).

`DEFAULT_SETTINGS.trackedSites` enables X and LinkedIn by default.
`trackingEnabled(site, settings)` uses that default when the preference is absent
and respects an empty list (all tracking disabled). Malformed non-array saved
selections, including `null`, resolve to all sites Off; only a missing preference
uses catalog defaults. Normalization does not overwrite saved preferences.
Tracking preferences
do not filter historical aggregates or CSV exports. New catalog entries start
disabled; the extension user decides which integrations to activate.

`siteForURL` delegates supported HTTPS lookup to the catalog. `classifyPage` is a
compatibility entry point delegating opaque route/editor state to the selected
site's pure classifier; it returns `create`, `consume`, or `neutral`. The actual
routes, selectors, and DOM/action interpretation live together in `extension/sites/<id>.js`.
The core never chooses X-versus-LinkedIn behavior itself.

`activeMillis` clips active intervals to the 30-second idle window and discards gaps over 15 seconds. `splitInterval` divides time at local midnight; `localDate` and `recentDates` use the local calendar.

## Data contract

A day's activity is an object keyed by site (`x`, `linkedin`). Each site contains:

- `consumeSec`, `createSec`: nonnegative seconds, including fractional seconds.
- `posts`, `replies`, `comments`, `likes`, `bookmarks`, `quotes`, `reposts`: nonnegative action counts.

Missing sites and fields aggregate as zero. `recordedSites(day)` identifies safe,
stable historical site IDs, including removed integrations; aggregate stats and
CSV retain those sites independently of the current catalog. `emptyStats()` supplies all fields. The extension stores days under local `YYYY-MM-DD` keys, retaining 30 days including today (or fewer if its history size budget is reached); settings and receipt metadata are separate and excluded from `csv()` exports. See the [storage rules](../README.md#local-storage-and-export).

Top-level access preferences are the user's Default. `siteSettings(site, settings)`
resolves the access limit from Default plus optional `siteOverrides`.
`updatePreferences(settings, changes, site)` validates and copies access limits;
omitting `site` updates Default, and per-site `null` removes an override without
changing creation tracking or recorded history. `settingsSnapshot(settings)` omits
retired nudge preferences without deleting the saved values. Snapshots normalize
invalid durations, targets, booleans, and overrides without mutating storage;
an invalid override inherits Default.

`validScrollFrictionStrength` and `SCROLL_FRICTION_LIMITS` share the slider's
0–90% resistance bounds and five-point steps with command receivers. Missing or
invalid restored strength resolves to 50% without rewriting saved preferences.
Slow scrolling remains opt-in; setting zero resistance leaves scrolling native.

`validAccessMinutes`, `validIntention`, and their exported limits supply the same
rules to forms and receivers. Intentions use a trimmed minimum but a raw maximum;
new commands never coerce values. `validLocalDate` rejects impossible calendar
dates. `DELIVERY_LIMITS` bounds packets, items, seconds, IDs, and receipts.
`statsSnapshot` resolves missing or invalid known numbers to zero without
coercing numeric strings; history reads preserve unknown fields and partial rows.

`trackingEnabled(site, settings)` reads the site's combined Limit & track choice
from `trackedSites`. Access-session eligibility is enforced by the extension;
creation-score measurements on gated sites require timed or optional above-goal
access. `dailyTarget(settings)` validates the current daily target with a safe
legacy default; goal-based access is off by default. Website time
is a separate browsing overview and never enters the score.
`scoreColor` and `badgeText` provide consistent display thresholds.

## Tests

From the repository root:

```sh
node --test extension/core/tests/*.test.js
```

Run `pnpm test` for all core and client tests with the pinned toolchain.
Browser builds package this file unchanged.
