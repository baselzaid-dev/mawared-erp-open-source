# Community release audit

## Decision

**NO-GO for publication.** The private candidate is suitable for maintainer review. Verify the remaining release gates below before a public launch.

## Migration

The source branch inventory contained **945 tracked files**. **723 source paths** were retrieved by immutable Git blob ID and checked in the isolated review workspace. **675 paths** were imported or adapted for the candidate. The remaining **270** were withheld, replaced, or superseded by community documentation. These are path counts, so the candidate also retains original preparation files and adds new files.

The candidate includes the Express API, Prisma schema and 26 migration files, React web application, Android Kotlin and Compose application, source tests, dependency locks, and localization. The existing destination Git history is the parent history. The source repository history was not imported.

| Withheld material | Reason |
| --- | --- |
| Internal project notes, editor metadata, operational documentation, reports, and patch archives | Private project and deployment history |
| Deployment, backup, restore, production recovery CLI and runbooks, and staging-specific preparation tools and tests | Installation-specific data, access, or operational assumptions |
| Pending and manual migration SQL outside the reviewed migration chain | Local setup uses the Prisma migration sequence |
| Original launcher assets, screenshot baseline, and screenshot generator | Unverified artwork provenance. The app uses a new vector |
| Original Gradle wrapper JAR | It did not match the configured Gradle 9.4.1 release. Replaced with the matching upstream wrapper |
| Original environment examples, private endpoints, and fixture identities | Replaced with reserved or loopback examples and synthetic values |

## Security review

- **Tenant isolation.** Company administrators could query installation-wide aggregates through `GET /api/owner/metrics`. The route now scopes each database count to the authenticated company. The regression test checks the query filters.
- **Seed and migrations.** The original seed used a shared default password. The candidate requires a unique local seed password and creates random passwords for the other fixtures. Database write commands require matching dedicated loopback targets. If an older seed was ever run outside a disposable environment, rotate any affected accounts.
- **HTTP access.** The API defaults to a loopback listener, uses an explicit browser-origin allow-list, and trusts forwarding headers only when a proxy hop count is configured. Authentication, authorization, logging, upload limits, and raw SQL call sites were reviewed. The two remaining unsafe-named raw SQL calls in request handlers use fixed SQL.
- **Android.** Removed the fixed staging destination and generic dotenv-to-build-config injection. Public API URL configuration rejects embedded user credentials and query parameters. Recovery uses a configured HTTPS host instead of an unverified custom scheme. Keystore credentials remain external.
- **Dependencies.** npm audit initially reported 16 affected entries for each Node application. Both updated lockfiles returned zero reported advisories from the registry at the time of verification. Android dependency scanning requires the resolved Gradle graph.
- **Secret patterns.** A redacting scan covered the final staged files and all 43 distinct file versions in the destination's original reachable history. No configured pattern matched after verifying the placeholder examples. Gitleaks could not be downloaded locally. CI includes a checksum-pinned Gitleaks run. GitHub secret scanning status is unverified.
- **Database safety.** No production database connection, migration, seed, export, or reset was performed. No production credential or database dump was selected for transfer. Pattern scans and targeted review cannot establish the absence of every unrecognized secret.

## Test evidence

| Area | Commands and results |
| --- | --- |
| Backend | `npm ci`, `npm run typecheck`, `npm run build`, and `npm test -- --exclude 'tests/*.postgres.test.ts'` passed. 113 files and 1,123 tests passed. |
| Database guard | `node --test backend/scripts/local-database.test.mjs` passed all 4 tests. |
| PostgreSQL | `MAWARED_PG_TEST_REQUIRE=1 npm run test:postgres` stopped at its prerequisite check. `initdb`, `pg_ctl`, `createdb`, and `psql` were unavailable as a usable local toolchain. Fresh migration and seed execution remain unverified. |
| Web | `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, and the Vitest suite passed. 19 files and 94 tests passed. |
| Web Chromium | 15 Playwright tests passed using a separately installed Chromium 153 binary and the same synthetic fixture. The standard Playwright browser download failed in the local runner. Firefox and WebKit were not run. |
| Android | The Gradle wrapper JAR and distribution checksum match the official Gradle 9.4.1 checksums. Android XML parsed, and 24 JavaScript dependency-scan verdict tests passed. Gradle could not download its distribution locally, so the Android build, JVM tests, lint, and resolved dependency audit remain unverified. |
| Release tooling | The staged diff passed whitespace checks. The custom history scanner, Python syntax check, shell syntax check, and CI YAML and permission validation passed. |

## Release gates

1. Obtain passing PostgreSQL migration, seed, and integration results, and passing Android debug build, unit test, lint, and resolved dependency audit results.
2. Run a dedicated redacting Git history scan and review its findings. Continue route-level and abuse-case security review against the candidate.
3. Confirm distribution rights for included contributions and complete third-party attribution for any distributable bundle. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
4. Confirm a private disclosure channel and enforce maintainer reviews and required CI checks in GitHub. The written review policy does not enforce repository settings.
5. Obtain separate maintainer approval for merging and for a public release.
