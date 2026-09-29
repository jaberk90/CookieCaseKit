# Contributing

Use Node 24 (`nvm use`) and `npm ci`. Run `npm run check` and `npm run test:package` before opening a PR. UI changes should also pass `npm run test:ui` after `npx playwright install chromium`. Refresh screenshots with `npm run screenshots` for visible changes.

Use Conventional Commit PR titles (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`). Squash merges preserve the PR title for automatic versioning. Never commit customer data, database files, SMTP credentials or authentication secrets.

Changes to API handlers must preserve tenant scoping and requester ownership checks. Test denied access, not only the happy path. Private notes must remain absent from requester responses and email. Database changes need a versioned migration and backup/restore coverage. See [publishing](docs/PUBLISHING.md) for maintainer setup and release recovery.
