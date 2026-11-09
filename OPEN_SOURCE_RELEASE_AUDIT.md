# Community release audit

## Decision

**NO-GO for publication.** The private candidate is suitable for maintainer review. Verify the remaining release gates below before a public launch.

## Migration

The source branch inventory contained **945 tracked files**. **723 source paths** were retrieved by immutable Git blob ID and checked in the isolated review workspace. **675 paths** were imported or adapted for the candidate. The remaining **270** were withheld, replaced, or superseded by community documentation. These are path counts, so the candidate also retains original preparation files and adds new files.

| Exclusion category | Paths |
| --- | ---: |
| Internal documentation and reports | 171 |
| Original operations scripts and CI | 21 |
| Backend and web examples, operational material, and tests | 21 |
| Root notes, configuration, and superseded documentation | 20 |
| Editor metadata | 19 |
| Android assets, excluded tests, and the replaced wrapper | 18 |
| **Total** | **270** |

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
- **Dependencies.** npm audit initially reported 16 affected entries for each Node application. Both updated lockfiles returned zero reported advisories from the registry at the time of verification. OSV-Scanner reported no known vulnerabilities across the 125 resolved Android components.
- **Secret patterns.** A custom redacting scan inspected 757 distinct file versions in GitHub CI. Gitleaks scanned 48 commits and the checked-out tree. Eight initial generic-key matches were verified as synthetic test values and removed from the current fixtures. The [ignore file](.gitleaksignore) is scoped to those exact historical findings. Both scans passed. GitHub's separate built-in secret scanning status is unverified.
- **Database safety.** No production database connection, migration, seed, export, or reset was performed. No production credential or database dump was selected for transfer. Pattern scans and targeted review cannot establish the absence of every unrecognized secret.

## Test evidence

The [GitHub Actions run for the verified source revision](https://github.com/baselzaid-dev/mawared-erp-open-source/actions/runs/42669722195) records the commands and results.

| Area | Commands and results |
| --- | --- |
| Backend | `npm ci`, `npm run typecheck`, `npm run build`, and `npm test -- --exclude 'tests/*.postgres.test.ts'` passed. 113 files and 1,123 tests passed. |
| Database guard | `node --test backend/scripts/local-database.test.mjs` passed all 4 tests. |
| PostgreSQL | GitHub CI ran `npm run db:migrate` twice and `npm run seed` on a fresh UTF-8 loopback cluster. All 26 migrations applied, the second apply had no pending migrations, and the seed passed. `MAWARED_PG_TEST_REQUIRE=1 npm run test:postgres` passed 110 tests across 16 suites, with zero skipped. |
| Web | `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, and the Vitest suite passed. 19 files and 94 tests passed. |
| Web Chromium | 15 Playwright tests passed in GitHub CI using the standard browser and synthetic fixture API. The same 15 passed locally using a separately installed Chromium 153 binary after the standard browser download failed there. Firefox and WebKit were outside the CI gate. |
| Android | In CI, `./gradlew --no-daemon --console=plain :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:mawaredDependencySbom` succeeded. All 654 Android unit tests passed, with zero skipped. All 24 scan-verdict tests passed. OSV-Scanner evaluated 125 components with zero reported vulnerabilities. The local runner could not download Gradle. |
| Release tooling | The staged diff passed whitespace checks. The custom history scanner, Python syntax check, shell syntax check, and CI YAML and permission validation passed. |

## Release gates

1. Complete route-level and abuse-case security review for publication. Passing tests and scans cover specific behaviors and patterns.
2. Confirm distribution rights for included contributions and complete third-party attribution for any distributable bundle. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
3. Confirm a private disclosure channel and enforce maintainer reviews and required CI checks in GitHub. The written review policy does not enforce repository settings.
4. Obtain separate maintainer approval for merging and for a public release.
