import { describe, expect, it, vi } from 'vitest';
import {
  CredentialRecoveryService,
  TestOnlyMapRecoveryTargetStore,
  createSourceBucketHash,
} from '../src/credentialRecovery';

const TOKEN_PEPPER = 'unit-test-recovery-token-pepper-32chars';
const RATE_PEPPER = 'unit-test-recovery-rate-limit-pepper-32';
const ENV_BINDING = 'test:unit-fixture-fp';

describe('credential recovery service configuration boundaries', () => {
  it('rejects invalid TTL configuration before any issue work', () => {
    const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
    expect(() =>
      new CredentialRecoveryService({
        prisma: {} as never,
        crypto: { tokenPepper: TOKEN_PEPPER },
        environmentBinding: ENV_BINDING,
        targetStore,
        ttlOverrides: { password_reset: 0 },
      }),
    ).toThrow(/TTL|ttl/i);

    expect(() =>
      new CredentialRecoveryService({
        prisma: {} as never,
        crypto: { tokenPepper: TOKEN_PEPPER },
        environmentBinding: ENV_BINDING,
        targetStore,
        ttlOverrides: { password_reset: Number.NaN },
      }),
    ).toThrow();
  });

  it('rejects raw source identifiers before database writes', async () => {
    const create = vi.fn();
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: vi.fn(),
          credentialRecoveryRequest: { findMany: vi.fn(), create, updateMany: vi.fn(), update: vi.fn() },
        }),
    };
    const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
    targetStore.set({
      principalDomain: 'platform_principal',
      principalId: 'p1',
      companyId: null,
      credentialVersion: 1,
    });
    const service = new CredentialRecoveryService({
      prisma: prisma as never,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore,
    });

    const rejected = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'p1',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-raw-source',
      sourceBucketHash: 'owner@example.test',
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'policy_rejected' });
    expect(create).not.toHaveBeenCalled();

    const acceptedHash = createSourceBucketHash('owner@example.test', RATE_PEPPER);
    // Still fails later if transaction mock is incomplete — only assert hash parsing path accepted.
    expect(acceptedHash.toString()).toMatch(/^recovery-src-v1:[a-f0-9]{64}$/);
  });

  it('rejects actorId without non-anonymous actorType before any database mutation', async () => {
    const transaction = vi.fn();
    const service = new CredentialRecoveryService({
      prisma: { $transaction: transaction } as never,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore: new TestOnlyMapRecoveryTargetStore(new Map()),
    });

    const issueRejected = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'p1',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-actor-bad-issue',
      actorId: 'should-not-pair-with-anonymous',
    });
    expect(issueRejected).toMatchObject({ ok: false, reason: 'audit_rejected' });
    expect(issueRejected).not.toMatchObject({ reason: 'concurrent_conflict' });
    expect(transaction).not.toHaveBeenCalled();

    let effectRan = false;
    const consumeRejected = await service.withValidRecoveryRequest(
      {
        rawToken: 'not-a-real-token-value-xxxxxxxxxxxxxx',
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-actor-bad-consume',
        actorId: 'should-not-pair-with-anonymous',
      },
      async () => {
        effectRan = true;
        return 'nope';
      },
    );
    expect(consumeRejected).toMatchObject({ ok: false, reason: 'audit_rejected' });
    expect(effectRan).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });
});
