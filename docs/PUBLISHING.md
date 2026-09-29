# Publishing CookieCaseKit

The repository is [jaberk90/CookieCaseKit](https://github.com/jaberk90/CookieCaseKit). Publishing always follows a **stable Git tag and published GitHub release**. A push alone updates the release PR; it does not publish an unversioned build.

## Two registries

| Registry                               | Package                   | Authentication                                   |
| -------------------------------------- | ------------------------- | ------------------------------------------------ |
| npm (`registry.npmjs.org`)             | `cookiecasekit`           | Actions secret **`NPM`**                         |
| GitHub Packages (`npm.pkg.github.com`) | `@jaberk90/cookiecasekit` | Automatic `GITHUB_TOKEN`, with `packages: write` |

Publishing to npm alone does not populate GitHub's Packages sidebar. The workflow publishes both. The GitHub copy keeps the repository metadata pointing at CookieCaseKit, which links it to [the repository's packages](https://github.com/jaberk90/CookieCaseKit/packages). Its scoped name is changed only in the CI checkout after npm publication; the source package name remains `cookiecasekit`.

GitHub packages are initially private by default. After the first publication, open the package settings and change visibility to public if desired. GitHub Packages requires authentication for installation, including public npm packages. npm is the simpler public installation path. See [GitHub's npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

## One-time setup

1. Add your npm token as an Actions secret named **`NPM`** in repository Settings → Secrets and variables → Actions, or in the `npm` environment. Use a valid granular token with permission to publish this package; it must permit non-interactive publishing under the account's current 2FA policy. Never put the token in a committed `.npmrc`. See [npm CI token guidance](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/).
2. Enable GitHub Actions and allow Actions to create pull requests. Create the `npm` environment, optionally with reviewer approval. If restricting deployment refs, allow release tags such as `v*` as well as `main`.
3. For release PRs to trigger CI automatically, add `RELEASE_PLEASE_TOKEN` from a release bot with Contents and Pull requests write permissions. The default `GITHUB_TOKEN` fallback can create release PRs, but its events do not trigger downstream workflows automatically. Publication is called directly from the release workflow, so it does not depend on a second release event firing.
4. Enable branch protection, required CI/review checks, Dependabot, and CodeQL as appropriate for the repository. Workflow files do not change repository settings themselves.

The npm secret is passed only to the npm publishing step. GitHub Packages uses GitHub's automatic token. The workflow requests OIDC permission for npm provenance; npm authentication uses your `NPM` secret. If npm policy later requires trusted publishing or staged approval, update the authentication flow before the token expires or loses publish permission.

## First release: v0.1.0

Commit and push the intended source, including the new publishing workflows and script. Wait for CI to pass. Ensure `package.json`, both root versions in `package-lock.json`, and `.release-please-manifest.json` all record `0.1.0`.

In GitHub, open **Releases → Draft a new release**:

1. Create tag **`v0.1.0`** targeting the tested commit on `main`.
2. Set the release title to **CookieCaseKit v0.1.0** and add release notes.
3. Publish it as a stable release (not a draft or prerelease).

The **Publish tagged release** action starts after the release exists. It verifies the tag against the package and lockfile, installs dependencies, checks formatting, runs backend/build/package tests, audits runtime dependencies, then publishes npm followed by GitHub Packages. The separate CI workflow also runs browser tests; wait for it before releasing.

No manual local `npm login` or `npm publish` is necessary for this workflow. Creating a release in GitHub is the publication trigger. Tags and published package versions should never be moved or overwritten.

## Later releases

Use Conventional Commit titles when merging PRs: `fix:` for a patch, `feat:` for a feature, and `!` plus a `BREAKING CHANGE:` footer for breaking changes. Below 1.0, breaking changes bump the minor version.

**Version and publish** runs on pushes to `main`, manual dispatch, and a weekly schedule. Release Please opens or updates a PR containing the version, lockfile, and changelog changes. Merge that PR after CI passes: Release Please creates the tag and GitHub release first, then calls the shared **Publish packages** workflow. The weekly run does not force empty releases or automatically merge PRs.

## Retry a partial or failed publication

Open Actions → **Publish tagged release** → Run workflow, select `main`, and enter the existing stable tag (for example `v0.1.0`). A tag without a published GitHub release is rejected, as are mismatched package/lockfile versions.

The workflow checks the exact version in each registry. Existing versions are skipped, so a successful npm publication followed by a GitHub Packages failure can be retried. Authentication/network lookup errors fail the run; only a registry 404 permits a new publish attempt. Already published versions are immutable: code fixes require a new version and release.

## Install

From npm, after publication:

```sh
npm install cookiecasekit
```

From GitHub Packages, configure your own authenticated registry access with `read:packages`, then install the scoped copy:

```ini
# .npmrc — use an environment variable, never a literal token
@jaberk90:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npm install @jaberk90/cookiecasekit
```

For that copy, use `@jaberk90/cookiecasekit`, `@jaberk90/cookiecasekit/react`, and `@jaberk90/cookiecasekit/react.css` in imports. Both copies contain the same implementation.
