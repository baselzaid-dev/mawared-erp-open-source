const HOSTS = new Set(['127.0.0.1', '[::1]']);
const DATABASES = new Set(['mawared_dev', 'mawared_test']);

export function assertLocalDatabaseUrl(raw, variable) {
  let url;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new Error(variable + ' must be a dedicated loopback PostgreSQL URL');
  }

  const database = url.pathname.slice(1);
  const parameters = [...url.searchParams];
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol)
    || !HOSTS.has(url.hostname)
    || !url.port
    || !DATABASES.has(database)
    || url.username !== database
    || !url.password
    || url.hash
    || parameters.length > 1
    || parameters.some(([name, value]) => name !== 'schema' || value !== 'public')
  ) {
    throw new Error(variable + ' must target the matching mawared_dev or mawared_test role and database on loopback');
  }
  return url;
}

export function assertLocalDatabaseEnvironment(env = process.env) {
  if (env.NODE_ENV === 'production' || ['production', 'staging'].includes(env.MAWARED_ENV ?? '')) {
    throw new Error('Database setup scripts are for development and test only');
  }
  const database = assertLocalDatabaseUrl(env.DATABASE_URL, 'DATABASE_URL');
  const direct = assertLocalDatabaseUrl(env.DIRECT_URL, 'DIRECT_URL');
  if (database.host !== direct.host || database.pathname !== direct.pathname) {
    throw new Error('DATABASE_URL and DIRECT_URL must target the same local database');
  }
}
