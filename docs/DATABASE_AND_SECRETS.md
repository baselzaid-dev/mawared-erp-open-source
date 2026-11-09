# Database, credentials, and privacy safety

Mawared ERP's public source release must be **code-only**. Do not copy or export the original project's live database.

## What may be published after review

- Prisma `schema.prisma` (database models, fields, relations, indexes).
- Schema migrations that contain only reviewed DDL and safe, non-sensitive operations.
- Sanitized environment templates with placeholders.
- Deterministic demo/test fixtures containing entirely fictional names, emails, identifiers, and organizations.
- Instructions for setting up a new local development database.

## What must never be published

- Real `DATABASE_URL` or `DIRECT_URL` values, database hosts with embedded credentials, passwords, JWT signing secrets, MFA encryption keys, recovery peppers, session tokens, provider API keys, or cloud service-role keys.
- Database dumps, SQL exports, backups, WAL archives, raw query logs, production telemetry, or application logs containing customer/employee information.
- Real company names, employee names, payroll amounts, identification numbers, email addresses, phone numbers, addresses, access records, attendance history, or other personal information.
- Android release keystores, signing passwords, cloud credentials, service account JSON, or unredacted deployment configuration.
- Internal access procedures, emergency recovery credentials, or operational runbooks that reveal private infrastructure.

## Migration and seed review

Migrations can contain data as well as schema changes. Inspect every migration and seed file before publication. Remove or rewrite any `INSERT`, `UPDATE`, `COPY`, or other statements embedding real users, customer information, real domains, tokens, or privileged account credentials.

A seed script should be **opt-in**, run only against a fresh local database, and use clearly fictional demo data. Do not include a known default admin password suitable for deployment.

## Local development setup

1. Create a brand-new PostgreSQL instance or database under your own control.
2. Copy `backend/.env.example` to `backend/.env`; the real file is Git-ignored.
3. Set `DATABASE_URL` and `DIRECT_URL` to **your own development database**.
4. Generate unique local signing/encryption secrets; never reuse the original project's secrets.
5. Review migrations before applying them. Run them only against disposable development databases.
6. Keep environment files, backups, logs, and test outputs out of Git.

## Required checks before publication

- Search the entire candidate tree and any included Git history with a dedicated secret scanner.
- Review database migrations, seeds, test fixtures, and snapshots manually.
- Inspect any third-party code, fonts, icons, images, and data for redistribution rights.
- Check GitHub Actions for secret exposure and unsafe execution of untrusted pull requests.
- Confirm that no source code contains hardcoded production service URLs or privileged tokens.
- Rotate any credentials that may already have been exposed elsewhere; deleting a file is not sufficient.

## Safety boundary

A new Git history prevents accidental publication of the old repository's history. It **does not** make copied source files safe automatically. Never switch this repository to Public until the checks are complete and the owner explicitly approves.
