# Pre-publication audit and migration status

**Status: NOT APPROVED FOR PUBLICATION.** This repository must remain private until a complete security review, source import, and build/test verification are complete.

## Scope checked

The original repository's default-branch tree was inventoried: 945 tracked files (1,101 tree entries including directories), approximately 10.34 MB of tracked blob content. This is an inventory, **not** a complete content scan.

The new repository was created separately with a new Git history. Only selected, manually reviewed text files have been imported so far. The old repository's commit history was not imported.

## Initial observations

- `backend/README.md` contains documented demo accounts and a common demo password. Do not import this documentation unchanged. Confirm that any demo accounts are non-production and that their credentials have never been used on live systems.
- `keystore.properties.example` contains a developer-specific Windows file path. Replace it with a generic placeholder before importing.
- `metadata.json` and some UI files contain Arabic text. Review and translate user-facing descriptions where the English-only release policy applies, without altering program semantics.
- `backend/.env.example` and `backend/.env.production.example` were manually checked for obvious hardcoded credentials. They contain placeholders, not verified live credentials. This does not establish that all other files are safe.
- The original repository contains internal logs and plans (for example `AI_WORK_LOG.md`, `docs/execution/`, `docs/agents/`, `docs/rc2/`, `.cursor/`, `.idea/`). These must not be bulk-copied without an explicit review.
- Some code modules contain Arabic strings. They were deferred rather than automatically translated.

## Exclusion policy

Do not copy: original Git history, real `.env` files, private keys, signing keys, local IDE state, database dumps, backups, production logs, personal or customer data, internal work logs, unreviewed planning documents, or deployment-specific confidential values.

Retain as needed after review: application source, backend and web code, Android build configuration, database schema and migrations, dependency lockfiles, tests, safe example configuration, and public developer documentation.

## Mandatory gates before making public

- [ ] Import all required application and test files with a new history.
- [ ] Review every imported file for credentials, tokens, private URLs, personal data, and sensitive configuration.
- [ ] Run a dedicated secret scanner against the complete candidate tree; manually inspect findings.
- [ ] Review third-party licenses and any copied assets for redistribution rights.
- [ ] Verify the MIT license attribution and ownership of all included code.
- [ ] Translate public-facing documentation into English.
- [ ] Verify backend, web, and Android builds and tests in a safe environment.
- [ ] Review GitHub Actions workflows for forked pull-request security.
- [ ] Configure protected default branch, required checks, and private vulnerability reporting.
- [ ] Obtain explicit owner approval before changing repository visibility.

## Important limitation

The connector supports GitHub file operations, but it does not run the project's tests or a complete local filesystem-based secret scan. Any claim of full security clearance or build readiness would be premature.
