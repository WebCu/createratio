# Website and store listing kit

Edit [`marketing/release.json`](../marketing/release.json), then run:

```sh
pnpm marketing
pnpm check
```

Use the supported Node.js 24.x and pnpm 12.x toolchain. Screenshot generation
also needs Chromium with unpacked-extension support; set `CHROMIUM_PATH` if it
is not `/usr/bin/chromium`. In an isolated Linux sandbox without Chromium's
sandbox support, explicitly set `CHROMIUM_NO_SANDBOX=1`. Never use a personal
browser profile for these captures.

## Inputs and outputs

The JSON owns the latest website announcement, activation instructions, listing
summary and description, release notes, social post and screenshot captions.
`pnpm marketing:copy` synchronizes the two static website announcement locations
and writes reviewable text files to `dist/marketing/`. Website builds reject an
outdated announcement; they never silently rewrite source files. The rest of the
website, metadata, agent guide and legal disclosures still need factual review
when capabilities change.

`pnpm marketing:assets` rebuilds Chrome, refreshes the text kit and generates:

- `dist/marketing/screenshots/01-websites.png`: four supported sites, enabled
  for demonstration. Instagram and TikTok start Off in the actual defaults.
- `02-intention.png`: the real Instagram access gate with a synthetic intention.
- `03-creation-score.png`: the real dashboard with synthetic daily totals.
- `manifest.json`: extension version, Chromium version, copy fingerprint,
  bundle/file hashes and captions for these exact images.

Images are full-bleed 1280 × 800 PNGs, matching the
[Chrome screenshot guidance](https://developer.chrome.com/docs/webstore/images).
Capture uses a disposable copy of the built extension with external requests
blocked. It does not sign in, post, or read existing browser data. Any copy
regeneration deletes the old generated screenshot directory to prevent mixing
new announcements with stale images. Failed captures do not produce a completed
screenshot directory. Generated artifacts stay outside source control and the
extension packages; regenerate rather than editing them.

## Review and publish

1. Review every text file, PNG and caption. Confirm the advertised feature is
   actually available in each store before announcing it there. Store versions
   and review times can differ.
2. Review the website diff, including metadata, defaults, installation steps,
   privacy and measurement limitations. Deploy through the existing website
   workflow; this command does not deploy it.
3. In the Chrome Web Store Developer Dashboard, replace listing copy and
   screenshots with the reviewed files. Preserve accurate privacy disclosures.
4. Separately update the existing Firefox listing in Mozilla's Developer Hub.
   These images show the Chrome build, not Firefox validation: compare them
   against the current Firefox UI before reusing them. Follow Mozilla's
   [listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/)
   and the existing [Firefox release checks](firefox-add-ons.md).
5. Publish the reviewed social post manually. Verify the live website and each
   public listing after its changes become available.

This is an artifact generator, not a publisher. It uses no store credentials,
changes no listing, and bypasses no approval. Extension package submission and
its independent store approvals remain in the [release workflow](releases.md).
