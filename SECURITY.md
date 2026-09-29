# Security policy

Until a stable 1.0 release, security fixes target the latest published 0.x release. Upgrade promptly when a fix is published.

Report vulnerabilities through this repository's GitHub **Security → Report a vulnerability** once private reporting is enabled. Do not post credentials, personal data, or exploitable private deployment details in public issues. Maintainers must enable private reporting before distributing the package.

CookieCaseKit verifies authorization after your host supplies a trusted identity. Authentication, correct role/tenant mapping, HTTPS, rate limiting, session security and restrictive CORS remain host responsibilities. The package enforces case scoping, staff-only internal notes, input limits, parameterized queries, optimistic concurrency, a custom-header JSON write guard, and a restrictive UI content security policy.

Security checks include scheduled npm audits, CodeQL, dependency update PRs and application authorization tests. These checks are not a security certification. Before deploying with sensitive data, review the integration and operational controls in [operations](docs/OPERATIONS.md).

Incoming email is accepted only when a requester address, case number and an unguessable stored notification Message-ID match. Mailbox anti-spoofing and spam protection remain important. Use dedicated IMAP credentials, TLS and a restricted mailbox. A provider-webhook integration must verify the provider signature before calling `receiveEmail()`; never expose raw email ingestion anonymously.
