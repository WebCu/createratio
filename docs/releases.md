# Chrome and Firefox releases

One version and one Git tag select the source for both stores. Chrome and Firefox
use different packages, approval environments and submission APIs. Their reviews
and publication times are independent; one store can succeed while the other fails.
Finish or resolve current submissions before tagging another version.

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
version fields, and pushes an annotated matching `vVERSION` tag. It does not need
store credentials on your machine. It refuses remote tags that already exist,
local lightweight tags, and local tags pointing at a different commit; it never
force-pushes, replaces or moves tags. Only an annotated local tag pointing at the
current commit, such as one left by a failed push, can be reused. Publication pushes only
the fully qualified ref for that version, not other local tags.

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

## Human validation gate

Keep the `chrome-web-store` and `firefox-addons` approvals pending until the
pre-submission checks in [store-integration acceptance](testing.md#store-integration-acceptance)
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

After a tag is pushed, use **Re-run failed jobs** for a failed store job; do not
resubmit a successful store job, move the tag, or rerun a different source commit
under the same version. Inspect the relevant dashboard first if a write request
timed out: the store may already have received it. Uploads and submissions are not
retried automatically, and pending submissions are not cancelled or overwritten.
A dashboard correction or a newer version may be necessary. Retain the source
commit and artifact checksum with any recovery record.
