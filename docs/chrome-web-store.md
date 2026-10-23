# Chrome Web Store release

CreateRatio is published on the
[Chrome Web Store](https://chromewebstore.google.com/detail/kopbjmlmjpnkekffalpbjfhmbhgbgamk).
Use this guide to verify and release updates to that listing.

## GitHub releases

Use the shared [Chrome and Firefox release workflow](releases.md) to prepare a
version PR and publish its GitHub Release with generated change notes after merge. The workflow retains its existing
`.github/workflows/release-chrome.yml` filename for Google's federated trust,
but builds both store packages and submits them in independent approval jobs.
For a Chrome-only update, use the [manual release option](releases.md#release-to-one-store)
with `browser=chrome`; the Firefox submission job is skipped.

Download the `browser-store-packages` artifact and inspect an extracted copy of
`createratio-chrome.zip` before approving `chrome-web-store`. The artifact also
contains Firefox and reviewer-source archives, checksums, tag and source commit.
Approval confirms the manual release checklist, including current store
disclosures and deployed legal pages. Approval does not replace those checks.

After approval, the job verifies the checksum, exchanges GitHub OIDC for a
short-lived Google token, uploads the archive, waits for upload processing, and
submits it for normal Google review. Google publishes after approval using the
listing's existing visibility. A successful workflow reports submission, not
necessarily public availability. Check the Developer Dashboard for review results.
Warnings block submission. The workflow does not skip review, alter the listing,
change permissions, or cancel an existing pending/staged submission.

### One-time setup

The release workflow requires:

- A dedicated Google project, store service account, and federation restricted
  to this repository's immutable ID, version tags, release workflow, and
  `chrome-web-store` environment. Allow only the `release` and `workflow_dispatch`
  events for automatic and manually targeted releases.
- A `chrome-web-store` environment with owner approval, tag-only deployment
  policy, the pinned Google authentication action allowed, and four non-secret
  variables: `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID`,
  `CWS_WORKLOAD_IDENTITY_PROVIDER`, and `CWS_SERVICE_ACCOUNT`.
- The service account linked in the Chrome Web Store Developer Dashboard.
  Use the publisher ID from its settings and the numeric federation-provider path
  for the corresponding environment variables. Missing values and setup
  placeholders fail before authentication or upload. There are no OAuth refresh
  tokens or service-account keys to store in GitHub.

Before the next automatic Chrome release, the federation owner must replace its
`push` event allowance with `release` and retain `workflow_dispatch` for manually
targeted releases. A release event still uses the version tag ref. Preserve all
repository, workflow, tag and environment restrictions. Repository changes do
not update Google IAM, and existing GitHub variable names do not prove this
permission is configured.

Google's [service-account setup](https://developer.chrome.com/docs/webstore/service-accounts)
and [API guide](https://developer.chrome.com/docs/webstore/using-api) describe the
provider-side requirements. Do not put credentials in this repository.

If a run fails after upload or submission, inspect the dashboard before retrying.
The script does not retry write requests, cancel reviews, or overwrite pending
submissions. A rerun can require dashboard recovery or a new version; do not move
an existing release tag to different code. Manual packaging and submission remain
available below.

## Verify

Use stable Node.js 24.x and pnpm 12.x. For a reproducible release build, use the
exact tool versions recorded in `.github/workflows/ci.yml`:

```sh
pnpm install --frozen-lockfile
pnpm audit --audit-level=high
pnpm test
pnpm build:chrome
```

Complete the [manual verification checklist](testing.md) against the current
bundle, including signed-in X/LinkedIn behavior, active budgets, permissions,
restart, sleep/wake, and keyboard access. Automated fixtures do not establish
current website markup or live browser behavior. Edge and Firefox need their
own live validation before distribution.

The public HTTPS privacy-policy URL must serve the current
[`site/privacy.html`](../site/privacy.html). Also deploy the current
[`site/terms.html`](../site/terms.html) at `https://createratio.com/terms.html`
for the extension Settings link. Legal links open the public pages in a separate
tab; the pages are not bundled. Local-only processing still requires accurate
store privacy disclosures; a passing test suite is not a legal-compliance certificate.
Keep account-specific hosting, publisher decisions, and legal review records
outside this repository.

## Package

With the system `zip` command, after a fresh build:

```sh
(cd dist/chrome && zip -X -r ../createratio-chrome.zip .)
unzip -l dist/createratio-chrome.zip
```

Remove any previous archive before packaging. `manifest.json` must be at the ZIP
root. Include only the generated Chrome bundle, not other browsers, screenshots,
tests, keys, environment files, or build tooling. Builds are disposable,
allowlisted outputs; never edit them by hand.

Load an extracted copy of the exact archive in a disposable browser profile.
Chromium can write `_metadata` into loaded directories, so keep the QA copy
separate from the output you package. Record the submitted archive's checksum
and source commit with the release. Increment the manifest version before
replacing an uploaded package; keep package and manifest versions aligned.

## Listing and disclosures

- Describe the single purpose: intentional site access with private local
  feedback on creating versus consuming.
- Explain default X/LinkedIn blocking, the intention and 60-second wait, shared
  active-time budgets, midnight refills, and the optional above-goal exception.
- Explain Limit & track: Off means unrestricted access and no new creation-score
  measurements; Website time remains an independent opt-in feature.
- Disclose local history retention, optional saved intentions, export/deletion
  controls, and best-effort action recognition. See the
  [extension guide](../extension/README.md).
- Match the dashboard's data categories to actual processing: routes, input
  timing, local domain totals, optional intention text, and transient DOM
  inspection. Do not claim “no user data” solely because it stays on-device.
- Provide public support and privacy links, and use the published Chrome listing
  in installation instructions. Do not imply Edge or Firefox store availability,
  exact measurement, tamper-proof enforcement, or unverified browser support.
- Use actual extension screenshots with synthetic data, not the landing page's
  illustrative graphic. Keep release artwork outside the browser bundle.

### Permissions

| Permission | Purpose |
| --- | --- |
| `storage` | Local activity, preferences, access state, optional intentions, and bounded retry receipts. |
| `alarms` | Active-budget expiry, midnight refills, website timing, and score refresh after worker suspension. |
| `declarativeNetRequestWithHostAccess` | Gate supported-site requests and apply temporary per-site access exceptions. |
| X/Twitter/LinkedIn HTTP/HTTPS hosts | Cover aliases and subdomains, redirect open tabs at expiry, and inject packaged scripts on declared hosts. |
| Optional `tabs` and `idle` | After Website time opt-in, derive domains from active tab URLs and pause timing when idle or locked. Full URLs are not saved. |

All executable extension code ships in the bundle. There are no extension
analytics, remote scripts, accounts, or activity uploads. Website-only Plausible
analytics are disclosed separately in the privacy policy.

## Reviewer workflow

Install and pin the Chrome bundle. Visit X or LinkedIn, enter a synthetic
20–280-character intention, start the wait, and reload to check persistence.
Confirm only after 60 seconds; waiting alone must not unlock access. The default
budget is five active minutes shared by the site's tabs; switching away pauses
it. Check expiry and manual end, then turn Limit & track Off and On in Settings.
Save drafts before expiry redirects open tabs.

Optional Website time requires explicit permission approval and works on normal
HTTP/HTTPS tabs. Verify that privacy links open the public HTTPS policy.
Send feedback is unavailable in
unpacked builds; verify its reviews link after store installation. Signed-in
posting checks require the reviewer's own account, never supplied credentials.
Published GitHub Releases submit through the approved workflow above. Manual dashboard
submission remains available for recovery.

## Store requirements

Consult the current official guidance before submitting:

- [Packaging](https://developer.chrome.com/docs/webstore/prepare) and
  [publication](https://developer.chrome.com/docs/webstore/publish).
- [Privacy policy](https://developer.chrome.com/docs/webstore/program-policies/privacy),
  [local processing](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
  and [privacy declarations](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).
- [Listing images](https://developer.chrome.com/docs/webstore/images).
