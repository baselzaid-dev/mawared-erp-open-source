# Development

Use synthetic test data and run each command from its listed directory.

| Area | Directory | Commands |
| --- | --- | --- |
| API | `backend/` | `npm ci`, `npm run typecheck`, `npm run build`, `npm test -- --exclude 'tests/*.postgres.test.ts'` |
| Database guard | `backend/` | `npm run test:local-db-guard` |
| PostgreSQL integration | `backend/` | `MAWARED_PG_TEST_REQUIRE=1 npm run test:postgres` |
| Web | `web/` | `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` |
| Browser | `web/` | `npx playwright install chromium`, `npm run build`, `npm run test:e2e` |
| Android | root | `./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` |
| Release scan | root | `python3 scripts/prepublish_scan.py --history` |

Put `initdb`, `pg_ctl`, `createdb`, and `psql` on PATH. Use a non-root shell and leave `MAWARED_PG_TEST_DATABASE_URL` unset so suites create throwaway clusters. Playwright serves the built web client with synthetic API fixtures. Firefox and WebKit projects can be run separately after installing those browsers.

Review data access with a second tenant fixture. Review schema changes against a fresh database and a representative previous migration state.
