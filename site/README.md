# CreateRatio website

A standalone static landing page. No framework or remote script CDN.
Website analytics are separate from the analytics-free browser extension.

## Installation links

The hero and installation section link directly to the
[published Chrome Web Store listing](https://chromewebstore.google.com/detail/kopbjmlmjpnkekffalpbjfhmbhgbgamk),
without requiring JavaScript. Source instructions remain under **Build from source**;
Edge and Firefox are development builds, not published store releases.

## Preview

From the repository root, using stable Node.js 24+ and pnpm 12+:

```sh
pnpm install --frozen-lockfile
pnpm preview
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).
Use `WEB_PORT=4174 pnpm preview` to change the port.

With Docker and Compose 2.24 or newer:

```sh
./bin/dev.sh --no-proxy
```

This also binds only to loopback. If you already run a shared Traefik proxy on
port 80 with its Docker provider and external `devproxy` network, `./bin/dev.sh`
serves [http://createratio.localhost](http://createratio.localhost). The launcher
does not install a proxy.

Ctrl-C stops a foreground preview. Compose options pass through to the launcher.
To remove containers:

```sh
docker compose --env-file /dev/null -f docker-compose.yml down
```

For proxy mode, also pass `-f docker-compose.dev-proxy.yml` before `down`.
If your editor replaces mounted files on save, rerun the launcher with
`--force-recreate`.

Previews serve only public assets and `LICENSE`, not the checkout, environment
files, documentation, or tests. The Docker mounts are read-only; the launcher
does not load a local `.env`. Export `WEB_PORT` explicitly to override it.
Compose is for local development, not production hosting.

## Build

```sh
pnpm build:site
```

Publish **`dist/site/`** with a static host, not the source directory. The build
copies public assets (including `privacy.html` and `terms.html`) and licenses, fingerprints the
locally served Plausible module and analytics loader, and rewrites their imports.
Website and extension builds are independent. Hosting credentials and
account-specific deployment configuration do not belong in source control.

The privacy policy is at `/privacy.html`; terms are at `/terms.html`. Both are
linked from the homepage and extension Settings, cross-link to each other, and
have no analytics scripts. Terms preserve MIT commercial reuse and distinguish
the free extension from any future optional paid service. See the
[legal-page maintenance notes](../docs/privacy-policy-notes.md) and
[release guide](../docs/chrome-web-store.md); verify both deployed HTTPS URLs
before release and use the privacy URL in Chrome Web Store.

## Analytics

`analytics.js` loads the official `@plausible-analytics/tracker` only on
`createratio.com` and `www.createratio.com`. Local previews and other hostnames
never load it or send events.

The website sends pageviews and engagement to `https://plausible.io/api/event`.
No cookies, custom events, outbound-link, download, or form tracking are enabled.
To exclude your visits, set `localStorage.plausible_ignore = 'true'` in the browser
console. Blocked analytics or disabled JavaScript do not affect the page.
This tracker is not included in extension builds.

## Accessibility and verification

`arrival.js` progressively enhances native scrolling. Without JavaScript or CSS
mask support, content remains readable. Reduced-motion preferences, keyboard
navigation, a skip link, and direct anchors are supported. After eight seconds at
the top, **Scroll down** offers a slow, 2.8-second reveal of the homepage. Manual
input interrupts it; reduced motion skips the animation. The activity graphic
and notifications are illustrative, not personal data or live measurements.

Run `pnpm test` and the [website verification checks](../docs/testing.md#website).
The distributed site includes the [MIT license](../LICENSE) and the Plausible
tracker's license notice.
