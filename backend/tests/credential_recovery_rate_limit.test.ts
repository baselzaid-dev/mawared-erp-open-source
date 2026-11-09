import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  InMemoryRecoveryRateLimitStore,
  RecoveryRateLimiter,
  recoveryRateLimitMetricLabels,
} from '../src/credentialRecovery/rateLimit';
import { hashIdentifierForRateLimit } from '../src/credentialRecovery/tokenCrypto';

const PEPPER = 'test-recovery-rate-limit-pepper-32chars!!';

describe('credential recovery rate-limit foundation', () => {
  it('keeps surfaces and dimensions independent', async () => {
    const store = new InMemoryRecoveryRateLimitStore();
    let now = new Date('2026-07-26T12:00:00.000Z');
    const limiter = new RecoveryRateLimiter(store, PEPPER, DEFAULT_RECOVERY_RATE_LIMIT_POLICY, () => now);

    for (let i = 0; i < 3; i += 1) {
      const decision = await limiter.check({
        surface: 'platform_password_reset_initiate',
        dimension: 'target',
        rawKey: 'owner@example.test',
        now,
      });
      expect(decision.allowed).toBe(true);
    }
    const blocked = await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'owner@example.test',
      now,
    });
    expect(blocked.allowed).toBe(false);

    const otherSurface = await limiter.check({
      surface: 'platform_account_discovery',
      dimension: 'target',
      rawKey: 'owner@example.test',
      now,
    });
    expect(otherSurface.allowed).toBe(true);

    const otherDimension = await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'source',
      rawKey: 'owner@example.test',
      now,
    });
    expect(otherDimension.allowed).toBe(true);
  });

  it('stores only keyed hashes and never raw labels', () => {
    const hash = hashIdentifierForRateLimit(
      'owner@example.test',
      PEPPER,
      'platform_password_reset_initiate',
      'target',
    );
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('owner');
    expect(hash).not.toContain('@');

    const labels = recoveryRateLimitMetricLabels({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      result: 'limited',
    });
    expect(labels).toEqual({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      result: 'limited',
    });
  });

  it('fully resets after the cooldown window', async () => {
    const store = new InMemoryRecoveryRateLimitStore();
    let now = new Date('2026-07-26T12:00:00.000Z');
    const limiter = new RecoveryRateLimiter(store, PEPPER, {
      ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      platform_password_reset_initiate: {
        target: { windowMs: 60_000, blockLimit: 1, alertLimit: 1 },
      },
    }, () => now);

    expect((await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'victim@example.test',
      now,
    })).allowed).toBe(true);
    expect((await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'victim@example.test',
      now,
    })).allowed).toBe(false);

    now = new Date('2026-07-26T12:01:00.000Z');
    expect((await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'victim@example.test',
      now,
    })).allowed).toBe(true);
  });

  it('separates alert threshold from block threshold', async () => {
    const store = new InMemoryRecoveryRateLimitStore();
    const now = new Date('2026-07-26T12:00:00.000Z');
    const limiter = new RecoveryRateLimiter(store, PEPPER, {
      ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      platform_password_reset_initiate: {
        source: { windowMs: 60_000, blockLimit: 3, alertLimit: 2 },
      },
    }, () => now);

    const first = await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'source',
      rawKey: '10.0.0.1',
      now,
    });
    expect(first).toEqual({ allowed: true, alert: false });

    const second = await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'source',
      rawKey: '10.0.0.1',
      now,
    });
    expect(second.allowed).toBe(true);
    expect(second.alert).toBe(true);

    await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'source',
      rawKey: '10.0.0.1',
      now,
    });
    const fourth = await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'source',
      rawKey: '10.0.0.1',
      now,
    });
    expect(fourth.allowed).toBe(false);
    expect(fourth.alert).toBe(true);
  });

  it('marks the in-memory store as test-only by type name', () => {
    expect(InMemoryRecoveryRateLimitStore.name).toContain('InMemory');
  });
});
