# Changelog

## 1.0.0

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
