# Chrome and Firefox releases

One GitHub Release with generated change notes and an immutable version tag
selects the source for both stores. Chrome and Firefox
use different packages, approval environments and submission APIs. Their reviews
and publication times are independent; one store can succeed while the other fails.
Publishing a release targets both stores; a tag push alone does not submit anything.
A manual run can target Chrome, Firefox or both.
Browser-specific fixes may skip the unaffected store, so store versions can differ.
Resolve current submissions for the targeted store before submitting another version.

## Prepare a version PR

Use the supported Node.js and pnpm versions, Git, and an authenticated GitHub CLI
with write access to `WebCu/createratio`. Start from a clean, current `main`:

```sh
git switch main
git pull --rebase --ff-only
pnpm release prepare patch
```

Use `minor` or `major` instead of `patch` when appropriate. The command validates
the configured and effective fetch/push URLs against the official origin and
checks synchronized source versions, creates `release/vVERSION`,
updates only `package.json`, `extension/package.json` and
`extension/src/manifest.json`, runs `pnpm check`, commits and pushes the branch,
and opens a version PR. It does not merge the PR, create a tag or submit to stores.
The website package has a separate lifecycle and is not version-bumped.
Preparation pushes only its fully qualified branch ref. Both commands disable
implicit tag following and mirror pushes for that invocation, regardless of Git
configuration; unrelated local tags and branches are not published. Git settings
and hooks are left intact.

Each component is numeric, without leading zeroes, and at most 65535 to satisfy
Chrome's version format. The new version must also exceed previous store uploads;
submission checks refuse duplicates and versions already pending review. A manual
store release ahead of the source version requires reconciling the versions before
using the command.

Review and merge the version PR after its CI checks pass. Complete the manual
browser and disclosure checks in [verification](testing.md) before submission.

## Publish the merged version

```sh
git switch main
git pull --rebase --ff-only
pnpm release publish
```

This command requires clean `main` matching `origin/main`, validates all three
version fields, pushes an annotated matching `vVERSION` tag, and creates a
GitHub Release with GitHub-generated change notes. GitHub CLI authentication is
required before any tag is created or pushed; store credentials are not needed
on your machine. The command uses `--verify-tag` so GitHub cannot silently select
another source commit. Open the printed release URL to see the changes selected
for deployment; publishing the release starts CI and packaging, not store availability.

It refuses local lightweight tags and tags pointing at another commit; it never
force-pushes, replaces or moves tags. An existing remote tag can be reused only
when annotated and pointing at current `main`, allowing recovery if release
creation failed after the tag push. Publication pushes only the fully qualified
ref for that version, not other local tags. An existing GitHub Release is not
edited or republished.

Open **Actions → Release browser extensions**. The workflow retains its filename
`.github/workflows/release-chrome.yml` because Chrome's federated authentication
trusts that exact workflow path.

The workflow runs the reusable CI, then builds only the two store bundles. Its
`browser-store-packages` artifact retains these files for 30 days:

- `createratio-chrome.zip` and `createratio-firefox.zip`, each with its manifest at
  the ZIP root;
- `createratio-source.zip`, containing allowlisted committed extension source and
  Firefox reproduction instructions, not website assets or credential files;
- `SHA256SUMS` and `release.txt`, recording archive hashes, tag and source commit.

## Release to one store

For a browser-specific fix, prepare and merge the version PR as usual. Publish its
GitHub Release, then cancel the automatic both-store run before approving either
store. Do not start overlapping runs for the same version or resubmit a store
that already received it.

Run the same workflow manually against the existing tag, selecting `chrome`,
`firefox` or `both`. For example, with the authenticated GitHub CLI:

```sh
gh workflow run release-chrome.yml --repo WebCu/createratio --ref vVERSION -f browser=chrome
```

Replace `vVERSION` with the exact existing tag. Manual dispatch must use the tag
as its workflow ref, not `main` with a tag input. This keeps CI, checkout,
packaging, environment tag policies and Google identity tied to the same source.
The tag must contain this manual-release workflow; do not move an older tag to
add it. Branch refs, invalid browser choices and mismatched versions are rejected.

Both packages are still built and retained for audit, but the unselected store
job is skipped before environment approval or credentials are accessed. The
selected store retains the same CI, checksum and human-validation requirements.
A later release to the other store can use the same tag if that version has not
already been submitted there. Check that store's dashboard first.

Chrome's Google federation must permit `release` and `workflow_dispatch` on
version tags; see [Chrome setup](chrome-web-store.md#one-time-setup). GitHub
secrets and variables alone do not establish this provider-side permission.

## Human validation gate

Keep each selected store's `chrome-web-store` or `firefox-addons` approval pending
until the pre-submission checks in
[store-integration acceptance](testing.md#store-integration-acceptance)
are complete for the exact artifacts. The package job links that checklist in its
Actions summary alongside the commit and hashes. Approve each store separately;
CI and secret-name checks do not establish live authentication or Firefox behavior.
Both jobs verify checksums and use the retained files without rebuilding. Chrome uses its existing
short-lived Google token; Firefox reads its environment secrets only in the
submission step and signs short-lived Mozilla JWTs. Neither job depends on the
other store's submission result.

A successful job means submitted to the store, not necessarily publicly available.
Check each developer dashboard for signing, review and publication results.
Store-specific setup and recovery details:
[Chrome](chrome-web-store.md) · [Firefox](firefox-add-ons.md).

## Failures and retries

Preparation failures preserve your work. A missing GitHub login stops before
branch creation; failed checks print their output and leave the release branch
and version edits intact.
Fix the checks and finish that existing branch rather than overwriting it. If the
branch was pushed but PR creation failed, open its PR from GitHub.

If GitHub Release creation fails after the tag push, inspect **Releases** first:
GitHub may have accepted the request despite a CLI error. If the release exists,
do not recreate or republish it. If absent, rerun `pnpm release publish` from the
same clean, current `main`; the matching annotated remote tag is reused. If main
has advanced, stop and inspect the tagged commit rather than moving the tag.

After a release is published, use **Re-run failed jobs** for a failed store job; do not
resubmit a successful store job, move the tag, or rerun a different source commit
under the same version. Inspect the relevant dashboard first if a write request
timed out: the store may already have received it. Uploads and submissions are not
retried automatically, and pending submissions are not cancelled or overwritten.
A dashboard correction or a newer version may be necessary. Retain the source
commit and artifact checksum with any recovery record.
