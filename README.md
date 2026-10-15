# CreateRatio

**Create > Consume.**

A free, open-source browser extension that helps you spend more time creating
and less time consuming. X and LinkedIn are blocked by default. Write an
intention, wait 60 seconds, then confirm access for five active minutes by default.
Switching away pauses the timer.

- **Intentional access:** configurable session times and a **Limit & track**
  switch for each supported site. Turning it off removes access restrictions
  and stops new creation-score measurements without deleting history.
- **A daily creation score:** compares creating time and credit for posts,
  replies, and comments against consuming time. See the
  [measurement rules and limitations](extension/README.md#measurement-and-score).
- **Optional extras:** track time across websites or save your access
  intentions. Both features are off by default.
- **Private by default:** no extension account, analytics, telemetry, or activity
  uploads. The landing website uses separate, disclosed analytics.

**Save drafts before installing and before access expires:** open site tabs
redirect to the blocked page.
This is a personal focus tool, not tamper-proof enforcement. Timed budgets are
shared across a site's tabs and refill daily until the session is ended or the
site's Limit & track switch is turned off.

## Install

[**Add to Chrome from the Chrome Web Store**](https://chromewebstore.google.com/detail/kopbjmlmjpnkekffalpbjfhmbhgbgamk).
Choose **Add to Chrome**, confirm installation, then pin CreateRatio from Chrome's
extensions menu. No build tools or Developer mode are needed.

For Chrome development builds, Edge, or Firefox, use the source instructions below.
Edge and Firefox do not have published store releases.

## Build and install

Use stable **Node.js 24+** and **pnpm 12+**, as declared in
[`package.json`](package.json). Newer stable releases are accepted; no exact
local toolchain is required. See the [dependency policy](docs/dependencies.md).

```sh
git clone https://github.com/WebCu/createratio.git
cd createratio
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

- **Chrome 111+:** open `chrome://extensions`, enable Developer mode, choose
  **Load unpacked**, and select `dist/chrome`.
- **Edge:** open `edge://extensions`, enable Developer mode, choose
  **Load unpacked**, and select `dist/edge`.
- **Firefox 140+:** open `about:debugging#/runtime/this-firefox`, choose
  **Load Temporary Add-on**, and select `dist/firefox/manifest.json`.
  Temporary installs disappear on restart; permanent distribution requires signing.

Load generated bundles, not source directories. After rebuilding, reload the
extension in the browser's extensions manager. Individual builds are available
through `pnpm build:chrome`, `pnpm build:edge`, and `pnpm build:firefox`.
Edge and Firefox bundles are build targets, not yet live-browser-validated releases.

See the [extension guide](extension/README.md) for settings, permissions,
measurement rules, and limitations.

## Privacy

Read the [privacy policy](site/privacy.html) and [terms of use](site/terms.html),
also linked from extension Settings.

Activity histories stay in your local browser profile for **30 local calendar
days including today**; a shared **4 MiB history budget** can remove older days
sooner. Export CSV or clear history in Settings. Creation tracking does not save
post text, screenshots, usernames, full page URLs, or keystroke values.

Optional **Website time** saves only domains and elapsed time. Optional
**Remember my intentions** keeps your latest 100 intention texts, sites, and
dates locally. Intentions have a separate clear control and are excluded from
CSV exports. Extension records are not synced or sent to a server.
The [landing website](site/README.md#analytics), unlike the extension, uses
Plausible analytics.

## Repository layout

```text
site/            Standalone landing website
extension/       Browser extension package and build tooling
  src/           Browser runtime, access gates, UI, manifest, and tests
  core/          Scoring, time, history, data helpers, and tests
  sites/         Vetted website tracking integrations and tests
bin/             Local development launcher and tests
docs/            Release, dependency, privacy, and verification guides
```

The website builds and deploys independently from the extension.

## Contributing and feedback

See [Contributing](CONTRIBUTING.md) for project principles, website integrations,
and verification requirements, and the [glossary](GLOSSARY.md) for project terms.
New vetted integrations are opt-in; tracking support does not automatically
add an access gate.

Use [GitHub issues](https://github.com/WebCu/createratio/issues) for bug reports
and feature proposals. Do not include private activity, intention text,
credentials, or CSV exports.

**Send feedback** in a store-installed Chrome build opens its public Chrome Web
Store reviews page without attaching local activity data. Feedback links are
unavailable in unpacked builds and are not configured for Edge or Firefox.

## Website

Run `pnpm preview` for [http://127.0.0.1:4173](http://127.0.0.1:4173), or
`pnpm build:site` to generate `dist/site/`. See the [website guide](site/README.md)
for Docker previews, analytics, and static builds.

## Release

See the [Chrome Web Store release guide](docs/chrome-web-store.md) for packaging,
permission justifications, privacy disclosures, and manual release checks.
Keep the deployed `/privacy.html`, `/terms.html`, and store disclosures current
when releasing updates. Store submission and publication remain manual.

## License

[MIT](LICENSE), including commercial use, modification, and redistribution with
the required notice. Distributed builds include the license notice. The official
extension and future improvements stay free and open source; separate optional
paid products or services may fund the project. None are currently offered.
The [terms](site/terms.html#open-source) do not narrow MIT rights.
