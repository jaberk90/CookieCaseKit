# CookieCaseKit 1.1.0

- Integrate all nine open dependency PRs, including current GitHub Actions and Node, Nodemailer and Supertest types.
- Run type checks with TypeScript 7 while retaining TypeScript 5.9 for tsup declaration generation.
- Preserve the existing Node/React API and stored data; no database migration or new secret is required.

Install with `npm install cookiecasekit@1.1.0`. Update server, React/CSS and workers together.

This maintenance minor release integrates the outstanding dependency updates. The runtime API and UI are unchanged from 1.0.2; existing README screenshots still apply. TypeScript 7 checks the source; the separate TypeScript 5.9 compiler API remains necessary for tsup declaration bundling.

Validation covers automated unit, package, browser and CI cloud-store contracts. Live SMTP/IMAP and operator-owned cloud resources are outside automated acceptance.
