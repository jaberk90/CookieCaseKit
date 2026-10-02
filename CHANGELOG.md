# Changelog

## [2.0.0](https://github.com/jaberk90/CookieCaseKit/compare/v1.1.0...v2.0.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* prepare stable 1.0.0 and nightly security updates

### Features

* add cloud adapters and serverless case management for 1.0.0 ([a138a60](https://github.com/jaberk90/CookieCaseKit/commit/a138a601e577b7708ef2a0781789f04f88a954cf))
* add multi-cloud adapters for the 1.0.0 release ([4accb7e](https://github.com/jaberk90/CookieCaseKit/commit/4accb7e29b7573152f61d10cd38617ec0b6d533f))
* prepare stable 1.0.0 and nightly security updates ([bcddcbe](https://github.com/jaberk90/CookieCaseKit/commit/bcddcbeafe9413e43a825283088374b2bf1f3da7))


### Bug fixes

* address CodeQL findings and validate OIDC claims ([cbdd1c5](https://github.com/jaberk90/CookieCaseKit/commit/cbdd1c56e3ec9bdca554debd65983c7e17bb37bd))
* **deps:** bump @types/nodemailer from 7.0.12 to 8.0.2 ([7078bc3](https://github.com/jaberk90/CookieCaseKit/commit/7078bc3d575755cae8910ffb1887f945d428ce7c))
* embedded theme and toolbar styling for 1.0.1 ([d80e599](https://github.com/jaberk90/CookieCaseKit/commit/d80e5995d8afa9dd00b8c6d9820f6f5aa44403e1))
* isolate embedded theme styles for 1.0.1 ([49f2efa](https://github.com/jaberk90/CookieCaseKit/commit/49f2efa5b2481999faca6a7629dc5d7e5769688d))
* send staff reply emails on their own cases ([ad7be33](https://github.com/jaberk90/CookieCaseKit/commit/ad7be33adf74e40a20cadb6c86a05cb117fc636b))
* staff reply notifications for 1.0.2 ([cc50db4](https://github.com/jaberk90/CookieCaseKit/commit/cc50db40826e2d1497a58e653e744daaa9ab1acc))
* validate public origin behind reverse proxies ([524cee1](https://github.com/jaberk90/CookieCaseKit/commit/524cee18201f0e12d8cafd2bd1f7f745efbc1a13))

## 1.1.0

- Integrate all nine open dependency PRs, including current GitHub Actions and Node, Nodemailer and Supertest types.
- Run type checks with TypeScript 7 while retaining TypeScript 5.9 for tsup declaration generation.
- Preserve the existing Node/React API and stored data; no database migration or new secret is required.

## 1.0.2

- Send public agent/admin reply notifications, including the full reply text, even when the staff member is the case requester. Applies to cloud and SQLite backends.
- Keep internal notes private and suppress notification echoes for requester replies. Status updates and public replies remain separately labeled emails.

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
