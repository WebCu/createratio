# Firefox Add-ons releases

CreateRatio's existing [Firefox listing](https://addons.mozilla.org/en-US/firefox/addon/createratio/)
uses the add-on ID `create-greater-consume@createratio`. Updates target this ID;
the workflow never creates a replacement listing.

## One-time setup

The `firefox-addons` GitHub environment must allow `v*` tags and require maintainer
approval. Its non-secret `AMO_ADDON_ID` variable must match the existing add-on ID.
Store both Mozilla credentials as environment secrets, outside source control:

| Mozilla field | Environment secret |
| --- | --- |
| JWT issuer | `AMO_API_KEY` |
| JWT secret | `AMO_API_SECRET` |

Generate or retrieve them on Mozilla's
[API credentials page](https://addons.mozilla.org/en-US/developers/addon/api/key/).
They authorize the developer account, not only this add-on. Keep both values
private; do not put them in source archives, command arguments, issue bodies or
logs. The Firefox job receives them only after environment approval and does not
use Chrome's Google federation.

## Submission and recovery

The job verifies the archive checksums and Firefox manifest ID/version, then
checks the existing listing and submitted version history. It refuses duplicates,
older versions, disabled listings and pending listed submissions. It uploads to
the `listed` channel, waits for Mozilla validation, then creates a version with
the reviewer-source archive and MIT license. Each HTTP request uses a new
short-lived HMAC-SHA256 JWT. Write requests are never retried automatically.

The job reports submission, not signing or publication. Mozilla controls validation,
review and availability. Inspect the Developer Hub before rerunning a failed job,
especially after a timeout. Do not create another listing, move a release tag,
overwrite a pending version, or submit test versions to check credentials.
See the official [submission API](https://addons-server.readthedocs.io/en/latest/topics/api/addons.html)
and [authentication guide](https://addons-server.readthedocs.io/en/latest/topics/api/auth.html).

## Reproduce the Firefox package from reviewer source

Extract `createratio-source.zip` into an empty directory and use stable Node.js
24.x. From that directory, run:

```sh
node extension/build.js firefox
```

No dependency installation or network access is needed for this build. The script
copies allowlisted runtime assets, concatenates the vetted site modules, generates
the manifest and blocking rules, and copies the MIT license. It does not minify,
obfuscate or fetch executable code. The generated directory is `dist/firefox`.
Compare its file contents with an extracted `createratio-firefox.zip`; ZIP timestamps
need not match. Tests, credentials and build tools are not included in the browser
bundle. The source archive includes the extension sources, build script, license,
Node selection and this guide from the exact tagged commit.

Package reproduction and mocked API tests do not establish current signed-in site
behavior, Firefox permission enforcement or sleep/wake behavior. Perform real
Firefox release QA before approving its submission job.
