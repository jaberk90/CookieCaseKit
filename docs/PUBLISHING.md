# Publishing and GitHub setup

The repository has no configured Git remote or npm owner yet. Workflows are included but must be connected to your accounts before they can run. Package versions are changed **before** publication; npm versions are immutable.

## One-time setup

1. Choose an npm package name you own (a scope such as `@your-org/cookiecasekit` is recommended). Change `package.json.name`, run `npm install --package-lock-only`, and update install/import examples. The package smoke test reads the configured name automatically.
2. Add the real `repository`, `bugs`, and `homepage` fields in `package.json`. For provenance, `repository.url` must match the GitHub repository used for publishing.
3. Create your GitHub repository and push this source to `main`. Enable Actions, Dependabot alerts/security updates, and private vulnerability reporting. CodeQL needs an eligible repository/license; enable it in Settings → Code security.
4. In Actions settings, allow workflows to create pull requests. Add a fine-grained token owned by a release bot as `RELEASE_PLEASE_TOKEN` with repository Contents and Pull requests write permissions. Bot-created release PRs then trigger CI normally. The default `GITHUB_TOKEN` fallback can create PRs but GitHub suppresses their automatic downstream workflow events: use the bot token when requiring CI checks on release PRs. Never run untrusted PR code with this token.
5. Configure a ruleset for `main`: require PR review, successful CI matrix checks and PR conventions, block force pushes, and use squash merges with the PR title as commit title. Add real code owners to `.github/CODEOWNERS` if your team needs required ownership review.
6. Create a GitHub environment named `npm`, restrict deployments to `main` and release tags, and optionally require a release reviewer.
7. For the first `0.1.0` publication, run the validation commands below, authenticate using `npm login`, and run `npm publish --access public` from the release checkout. This creates the package in your npm account. Do not publish the working unscoped name unless you own it. Tag that commit `v0.1.0` and create a GitHub release for it so Release Please has a release baseline. The manifest already records `0.1.0`.
8. Configure an npm trusted publisher for the package: your GitHub owner/repository, workflow **`release.yml`**, environment **`npm`**. If you want the recovery workflow, configure a second trusted publisher for **`publish-retry.yml`** with the same environment. No long-lived npm token is needed for these workflows. Verify npm account/package permissions allow public publication.

Trusted publisher setup is described in [npm's official documentation](https://docs.npmjs.com/trusted-publishers/). The workflows use Node 24 and npm 11 to satisfy its CLI requirements.

## Regular releases

- `fix: ...` → patch; `feat: ...` → minor; breaking changes use `!` and a `BREAKING CHANGE:` footer. While the package is below 1.0, breaking changes bump the minor version. Release Please manages `package.json`, lockfile, changelog, tag, and release notes.
- A push to `main`, manual workflow run, or Monday schedule updates the release PR when there are releasable changes. Documentation/CI-only work does not force a version bump.
- Review the release PR and merge after CI passes. The same workflow creates the release, checks out its exact tag, retests, audits runtime dependencies, and publishes with npm provenance.
- Dependency updates arrive as weekly Dependabot PRs. Runtime updates use `fix(deps)` titles so a merged fix enters the next release. There is deliberately no automatic merge.

## Validation before publication

```sh
npm ci
npm run check
npm run test:package
npx playwright install chromium
npm run test:ui
npm audit
npm pack --dry-run
```

`npm pack` only includes `dist`, `public`, `docs`, README, license, and package metadata. IDE files, demo identities, local databases, test code, and `.env` files are excluded.

## Recovering failed publication

A GitHub release can exist even if npm publication fails. Fix the registry/trusted-publisher/environment setup, then manually run **Retry npm publication** from `main`, supplying that release's `vX.Y.Z` tag. It verifies the release exists and retests the exact tag. Register `publish-retry.yml` as a trusted publisher first.

If npm already has the version, do not replace or delete it: make a new fix and release a new version. If code changes are needed, use a new release rather than retagging an existing one.

GitHub settings, branch protection, npm ownership, and environment approval rules cannot be created by merely committing workflow YAML; a repository owner must apply the setup above.
