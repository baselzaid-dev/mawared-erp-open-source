# Mawared ERP

Mawared ERP is an open-source, self-hosted ERP and HR application for organizations managing employees, attendance, leave, payroll, purchasing, and day-to-day work. It includes a React web client, a Kotlin Android app, and a TypeScript API backed by PostgreSQL.

**Public community preview.** The source is available under the [MIT License](LICENSE). Start with the synthetic demo company and your own local database. Production readiness, security hardening, and feature coverage are tracked in the [roadmap](docs/ROADMAP.md).

## Get the complete project

[Download the complete project as a ZIP](https://github.com/baselzaid-dev/mawared-erp-open-source/archive/refs/heads/main.zip) or clone the repository.

```sh
git clone https://github.com/baselzaid-dev/mawared-erp-open-source.git mawared-erp
cd mawared-erp
```

## Run it locally

1. Install Node.js 24, npm, Git, and PostgreSQL 16. Use a dedicated local database.
2. Follow the [installation guide](docs/INSTALLATION.md) to create your local environment files, generate your own keys, apply the migrations, and seed the demo company.
3. Start the API and web app in separate terminals as described in the guide. Open the local web address and sign in to the demo company.
4. To try Android, install JDK 21 and Android SDK Platform 36. The guide shows how to build the debug app and connect the emulator to your local API.

The [database and secrets guide](docs/DATABASE_AND_SECRETS.md) explains each setting. Example configuration uses placeholders. Real database credentials, signing keys, and business data belong in your own environment.

## What is implemented

| Area | Included in the preview |
| --- | --- |
| Identity and access | Company login, separate platform administration, role permissions, scoped delegation, session revocation, and MFA for protected accounts |
| HR | Employee and department records, attendance, corrections and exemptions, leave approvals, and salary records |
| Finance and payroll | Payroll periods, components, adjustments, payments, ledger posting, chart of accounts, cost centers, and journal entries |
| Purchasing | Vendors, purchase requests, quotations, orders, receipts, returns, and reports |
| Collaboration | Tasks, training, chat, notifications, report templates, and attachments |
| Clients | React web portal and Android app with Arabic and English localization |

Feature coverage varies by client. Some Android screens use local repositories or demo data. Statutory payroll, accounting, and tax compliance have not been certified.

## What's left

- Document which workflows are available in each client and close gaps between them.
- Expand tests for complete business workflows, tenant isolation, and account recovery.
- Provide reproducible self-hosting packages, operational guides, and an upgrade process.
- Improve accessibility, complete translations, and document the API.
- Establish a maintenance and release policy and complete attribution for distributed binaries.

The [roadmap](docs/ROADMAP.md) describes how to verify each milestone.

## Documentation and contributing

| Guide | Use it to |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Understand the API, clients, and database |
| [Development](docs/DEVELOPMENT.md) | Run checks and work on the project |
| [API overview](docs/API_OVERVIEW.md) | Find the endpoint groups and their source files |
| [Contributing](CONTRIBUTING.md) and [community](docs/COMMUNITY.md) | Report a bug, propose a change, or find a first contribution |
| [Security policy](SECURITY.md) and [verification audit](OPEN_SOURCE_RELEASE_AUDIT.md) | Report vulnerabilities privately and review the tested scope |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Review dependency and asset attribution |
