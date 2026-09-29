# Security policy

Security fixes target the latest published 1.x release. Earlier 0.x releases are unsupported after 1.0.0 is published. Upgrade promptly when a fix is published.

Report vulnerabilities through this repository's GitHub **Security → Report a vulnerability** once private reporting is enabled. Do not post credentials, personal data, or exploitable private deployment details in public issues. Maintainers must enable private reporting before distributing the package.

CookieCaseKit verifies authorization after your host supplies a trusted identity. Authentication, correct role/tenant mapping, HTTPS, rate limiting, session security and restrictive CORS remain host responsibilities. The package enforces case scoping, staff-only internal notes, input limits, parameterized queries, optimistic concurrency, a custom-header JSON write guard, and a restrictive UI content security policy.

Security checks include scheduled npm audits, CodeQL, dependency update PRs and application authorization tests. These checks are not a security certification. Before deploying with sensitive data, review the integration and operational controls in [operations](docs/OPERATIONS.md).

Incoming email is accepted only when a requester address, case number and an unguessable stored notification Message-ID match. Mailbox anti-spoofing and spam protection remain important. Use dedicated IMAP credentials, TLS and a restricted mailbox. A provider-webhook integration must verify the provider signature before calling `receiveEmail()`; never expose raw email ingestion anonymously.

## Automated checks

Dependency audits (including development dependencies, all reported severities) and CodeQL run nightly at 10:43 UTC, including weekends. This is 03:43 Pacific daylight time / 02:43 Pacific standard time. GitHub may delay scheduled runs.

Dependabot checks npm updates at 02:17 and GitHub Actions updates at 02:37 America/Los_Angeles every night, including weekends. Security updates are event-driven: enabled repository alerts cause Dependabot to attempt fix PRs when a patched version is available, independently of the nightly version-update schedule. PRs require review and CI; they are not auto-merged. Some advisories have no available patch or need a manual migration.

Dependency review checks newly introduced dependencies on PRs. Keep the scheduled workflows enabled on the default branch. Configure notification subscriptions in GitHub to receive security and failed workflow alerts.

Browser writes must use the same origin as the API. Behind a TLS-terminating reverse proxy, configure Express `trust proxy` for the actual trusted proxy addresses so `req.protocol` reflects HTTPS; do not blindly trust arbitrary forwarded headers. Apply host rate limits to public contact forms and authenticated API routes.

## Cloud adapters

Cloud storage uses tenant partitions and conditional transactions. Identity-provider setup, private storage policies, cloud IAM, database backups, worker endpoint authentication, and malware scanning are host responsibilities. See [cloud security and deployment requirements](docs/cloud/README.md). The adapters do not imply an independent security audit or provider certification.
