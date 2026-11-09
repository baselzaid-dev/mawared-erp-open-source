# Mawared ERP

Mawared ERP is a self-hosted, multi-company ERP and HR application. It brings employee administration, purchasing, payroll, finance, and work coordination into one workspace. The project aims to make ERP workflows inspectable and adaptable for contributors working with their own data and infrastructure.

This repository is a community release candidate. Review the [release audit](OPEN_SOURCE_RELEASE_AUDIT.md) for the verification status and publication gates.

## Features

| Area | Implemented in the source |
| --- | --- |
| Identity and access | Company login, separate platform administration, role permissions, scoped delegation, session revocation, and MFA for protected accounts |
| HR | Employees, departments, attendance, corrections, exemptions, leave approvals, and salary records |
| Finance and payroll | Payroll periods, components, adjustments, payments, ledger posting, chart of accounts, cost centers, and journal entries |
| Purchasing | Vendors, requests, quotations, orders, receipts, returns, and reports |
| Collaboration | Tasks, training, chat, notifications, report templates, and attachments |
| Clients | React company portal and Kotlin Android client with Arabic and English localization |

Feature coverage varies by client. The [roadmap](docs/ROADMAP.md) separates planned work and verification from implemented modules. No statutory payroll, accounting, or tax compliance certification is claimed.

## Stack and layout

| Path | Purpose |
| --- | --- |
| [backend/](backend/) | TypeScript, Express, Prisma, PostgreSQL, and Vitest |
| [web/](web/) | React, Vite, TypeScript, Vitest, and Playwright |
| [app/](app/) | Kotlin, Jetpack Compose, Retrofit, and Android resources |
| [docs/](docs/) | Contributor and self-hosting documentation |
| [scripts/](scripts/) | Release and dependency checks |

The clients call an Express HTTP API. The backend validates credentials and permissions and uses Prisma to query PostgreSQL. The [architecture guide](docs/ARCHITECTURE.md) describes the company and platform boundaries and where to trace requests.

## Run locally

Use Node.js 24 and npm, a dedicated PostgreSQL 16 development database, and a local copy of this repository. For Android, install JDK 21 and Android SDK 36. Follow the [installation guide](docs/INSTALLATION.md) to provision PostgreSQL, configure both `.env` files, generate local keys, apply migrations, and sign in with a synthetic development account. The [database and environment guide](docs/DATABASE_AND_SECRETS.md) lists the settings and safeguards.

Start the backend with `npm run dev` in `backend/` and the web app with `npm run dev` in `web/`. Run `./gradlew :app:assembleDebug :app:testDebugUnitTest` from the root for Android. The [development guide](docs/DEVELOPMENT.md) lists type checks, tests, lint, integration tests, and the Chromium fixture.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. Use the [community guide](docs/COMMUNITY.md) for first-issue ideas and the [security policy](SECURITY.md) for private vulnerability reporting. See [security architecture](docs/SECURITY_ARCHITECTURE.md) before changing access controls or handling credentials.

## License

Project-authored code is offered under the [MIT License](LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for third-party components and outstanding license checks.
