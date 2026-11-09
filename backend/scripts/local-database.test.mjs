import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalDatabaseEnvironment, assertLocalDatabaseUrl } from './local-database.mjs';

const local = 'postgresql://mawared_dev:example-only@127.0.0.1:5432/mawared_dev';

test('accepts dedicated development database through matching loopback URLs', () => {
  assert.doesNotThrow(() => assertLocalDatabaseEnvironment({ DATABASE_URL: local, DIRECT_URL: local + '?schema=public' }));
});

test('accepts the dedicated test role on IPv6 loopback', () => {
  assert.doesNotThrow(() => assertLocalDatabaseUrl('postgresql://mawared_test:example-only@[::1]:5433/mawared_test', 'TEST_URL'));
});

test('rejects remote, mismatched, and socket-redirected targets without revealing values', () => {
  for (const url of [
    local.replace('127.0.0.1', 'db.example.invalid'),
    local.replace('127.0.0.1', 'localhost'),
    local.replace('mawared_dev:', 'postgres:'),
    local.replace('/mawared_dev', '/postgres'),
    local + '?host=db.example.invalid',
    local + '?schema=public&schema=private',
    local + '#fragment',
  ]) {
    assert.throws(() => assertLocalDatabaseUrl(url, 'DATABASE_URL'), {
      message: 'DATABASE_URL must target the matching mawared_dev or mawared_test role and database on loopback',
    });
  }
});

test('rejects production mode, missing direct URLs, and different targets', () => {
  assert.throws(() => assertLocalDatabaseEnvironment({ NODE_ENV: 'production', DATABASE_URL: local, DIRECT_URL: local }));
  assert.throws(() => assertLocalDatabaseEnvironment({ DATABASE_URL: local }));
  assert.throws(() => assertLocalDatabaseEnvironment({ DATABASE_URL: local, DIRECT_URL: local.replace('5432', '5433') }));
});
