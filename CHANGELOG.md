# Changelog

## 1.0.1

- Support an explicit public origin for safe writes behind Firebase Hosting and other reverse proxies.

- Fix embedded brand contrast and host CSS collisions affecting the toolbar and theme toggle.
- Add controlled React theme and onThemeChange props to synchronize with host applications.

## 1.0.0

- Add the asynchronous cloud API and Firestore, PostgreSQL, DynamoDB and Cosmos DB storage adapters.
- Add private Google Cloud Storage, S3 and Azure Blob attachments with authenticated access and scan quarantine.
- Add SMTP, SES and Azure email sender adapters, scheduled outbox processing, worker leases and duplicate-safe inbound replies.
- Add React bearer-token authentication, OIDC verification and retry-safe cloud contact submissions.
- Add cloud deployment documentation and provider contract tests. Expanded cloud release remains subject to live-provider validation.

- Establish the stable Node and React integration API.
- Reject cross-origin browser writes independently of host CORS settings.
- Run dependency audits and CodeQL every night; check npm and GitHub Actions updates nightly, including weekends.
- Add dependency review to reject newly introduced known vulnerabilities in pull requests.
- Enable repository Dependabot alerts, automated security-fix PRs, and private vulnerability reporting.

### Included capabilities

- Add the native `cookiecasekit/react` component, scoped stylesheet, React host demo and API-only server mode.

- Add trusted server-side case creation and a tested contact-form integration with an admin-only console.

- Rename the package and console to CookieCaseKit (`cookiecasekit`).
- Add IMAP email-reply ingestion, thread/sender checks, deduplication and schema-v2 migration.
- Add persistent light/dark themes and a shared SVG logo/favicon.
- Expand category setup documentation and ignored local secrets/database/email files.

## 0.1.0

- Initial embeddable case management API and responsive console.
- SQLite persistence, tenant isolation, role authorization, case history and private notes.
- Configurable SMTP notifications with durable retries.
- ESM/CommonJS packaging, demo, tests and GitHub release/security workflows.
