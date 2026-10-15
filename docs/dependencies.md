# Dependency policy

The browser extension and tests use no third-party libraries. The landing
website's only library dependency is the official Plausible tracker, served
locally. New dependencies require maintainer approval; prefer built-in browser
and Node.js capabilities.

## Toolchain and reproducibility

- Contributors can use stable Node.js 24+ and pnpm 12+. The `engines` ranges
  in `package.json` enforce minimums, not exact versions. `.node-version` is an
  optional Node.js 24 hint for version managers, not an upper bound.
- CI and website deployment pin their own matching Node.js and pnpm versions
  in workflow files. These pins do not constrain contributors' installed tools.
- Install pnpm using the [official instructions](https://pnpm.io/installation).
  Select stable releases from npm's `latest` or `latest-N` tags, never `next`,
  beta, or release-candidate channels. A version without a prerelease suffix
  alone does not prove a stable release.
- Commit one `pnpm-lock.yaml` for the root, extension, and website workspaces.
  Do not add competing npm or Yarn lockfiles.
- Pin preview images to an exact Node/Alpine release and immutable digest.
- Pin external GitHub Actions to full commit SHAs and keep permissions minimal.

```sh
pnpm install --frozen-lockfile
pnpm audit --audit-level=high
pnpm check
```

The [environment preflight](testing.md#environment-preflight) reports selected
tool versions and architecture without installing or downloading anything.
Keep persistent machine provisioning outside the repository.

Use a non-frozen install only when intentionally updating dependencies, then
review and commit manifest and lockfile changes together.

## Updates

Workspace settings save exact library dependency versions, enforce toolchain
minimums, and require a **24-hour** minimum release age. Do not add release-age
exclusions, prereleases, library dependency version ranges, or
Git/private-registry dependencies.

Dependabot checks dependencies, Actions, and Compose images weekly. Major upgrades
require a separate maintainer decision; there is no automatic merge. Review
upstream release notes, integrity, and the full diff, then run CI before merging.
The package audit does not cover the Node.js runtime or container image; check
upstream security advisories as well.
