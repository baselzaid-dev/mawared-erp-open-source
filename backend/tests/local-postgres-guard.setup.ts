import { assertLocalDatabaseUrl } from '../scripts/local-database.mjs';

const attached = process.env.MAWARED_PG_TEST_DATABASE_URL;
if (attached) {
  const url = assertLocalDatabaseUrl(attached, 'MAWARED_PG_TEST_DATABASE_URL');
  if (url.pathname !== '/mawared_test') {
    throw new Error('Use a disposable mawared_test database for PostgreSQL suites');
  }
}
