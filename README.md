# Mawared ERP

**Open-source release candidate — not yet approved for public use.**

Mawared ERP is a work-in-progress, multi-tenant enterprise resource planning platform intended to help organizations manage everyday operations in one place. The codebase includes a TypeScript/Express backend with Prisma and PostgreSQL, a React-based web client, and a Kotlin/Jetpack Compose Android application.

> **Current status:** This repository is being prepared from a separate private development repository with a fresh Git history. The complete application has **not** yet been imported, independently tested, or security-cleared. Do not deploy it to production or use it with real employee/customer data.

## Project goals

- Organize employee and departmental information.
- Support attendance, leave requests, approvals, and payroll-related workflows.
- Support purchasing, vendors, and other operational modules.
- Apply role-based authorization and company-level data isolation.
- Provide web and Android experiences.

These are project goals and areas represented in the source project, **not a guarantee that every feature is complete or production-ready**.

## Technology

| Layer | Technology |
| --- | --- |
| API | Node.js, TypeScript, Express |
| Data | PostgreSQL, Prisma |
| Web | React, TypeScript, Vite |
| Android | Kotlin, Jetpack Compose |
| Tests | Vitest and project-specific Android tests |

## Repository layout

| Directory | Purpose |
| --- | --- |
| `backend/` | API, Prisma schema, migrations, backend tests |
| `web/` | Browser application and tests |
| `app/` | Android application and tests |
| `scripts/` | Open-source preparation and safety checks |
| `docs/` | Community and developer documentation |

**Note:** Some of these directories are still incomplete in this release-preparation repository.

## Getting started

The complete source tree and a verified end-to-end setup are not yet available here. Once the import is complete, the intended development workflow is:

1. Install Node.js and the Android development tools needed by the relevant module.
2. Provision your **own local development PostgreSQL database**. Never connect to the original project's database.
3. Copy the relevant `.env.example` file to an untracked local `.env`, then supply your own locally generated secrets.
4. Install dependencies using the module's lockfile.
5. Apply the reviewed Prisma migrations to your own **disposable development database**.
6. Run the module's documented build and test commands.

See [Database and secrets safety](docs/DATABASE_AND_SECRETS.md) for mandatory precautions. **Do not execute migrations or seed scripts against production or shared databases.**

## Contributing

We welcome bug reports, documentation improvements, tests, accessibility improvements, and carefully scoped code contributions after the initial public release. See [CONTRIBUTING.md](CONTRIBUTING.md). Please discuss major changes in an issue before opening a large pull request.

## Security and privacy

This repository must never include real database credentials, API tokens, production configuration, employee records, customer information, backups, or private signing keys. Report suspected vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Roadmap

1. Complete a clean, reviewed source import.
2. Verify third-party licensing and remove private operational materials.
3. Run full secret scanning and test/build checks.
4. Publish accurate setup instructions and example development data.
5. Obtain explicit owner approval before making this repository public.

## License

Licensed under the [MIT License](LICENSE), subject to verification that all included code and assets can legally be distributed under this license.

## Project status and limitations

This project is under active development. APIs, database migrations, interfaces, and documentation may change. No production support or security response-time guarantee is currently offered.
