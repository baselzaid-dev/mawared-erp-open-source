import { Prisma, type PrismaClient } from '@prisma/client';
import type { RecoveryPrincipalDomain } from './contracts';

type TxClient = Prisma.TransactionClient;

export interface RecoveryTargetSnapshot {
  principalDomain: RecoveryPrincipalDomain;
  principalId: string;
  companyId: string | null;
  credentialVersion: number;
  status?: string;
}

/**
 * Production target adapter. All reads/locks/CAS must receive the active
 * Prisma transaction client — never resolve outside the recovery transaction.
 */
export interface RecoveryTargetStore {
  lockAndResolve(
    tx: TxClient,
    input: {
      principalDomain: RecoveryPrincipalDomain;
      principalId: string;
      companyId?: string | null;
    },
  ): Promise<RecoveryTargetSnapshot | null>;

  /**
   * Atomic credentialVersion compare-and-swap: expected -> expected + 1.
   * Returns true only when exactly one row was updated.
   */
  compareAndIncrementCredentialVersion(
    tx: TxClient,
    target: RecoveryTargetSnapshot,
    expectedVersion: number,
  ): Promise<boolean>;
}

/**
 * Production PostgreSQL target store.
 * Locks PlatformPrincipal / User rows with FOR UPDATE and verifies
 * company_primary_owner against active CompanyOwnership.
 */
export class PostgresRecoveryTargetStore implements RecoveryTargetStore {
  async lockAndResolve(
    tx: TxClient,
    input: {
      principalDomain: RecoveryPrincipalDomain;
      principalId: string;
      companyId?: string | null;
    },
  ): Promise<RecoveryTargetSnapshot | null> {
    if (input.principalDomain === 'platform_principal') {
      if (input.companyId) return null;
      const rows = await tx.$queryRaw<
        Array<{ id: string; credentialVersion: number; status: string }>
      >`
        SELECT id, "credentialVersion", status
        FROM "PlatformPrincipal"
        WHERE id = ${input.principalId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row || row.status !== 'active') return null;
      return {
        principalDomain: 'platform_principal',
        principalId: row.id,
        companyId: null,
        credentialVersion: row.credentialVersion,
        status: row.status,
      };
    }

    const companyId = input.companyId ?? null;
    if (!companyId) return null;

    const users = await tx.$queryRaw<
      Array<{
        id: string;
        companyId: string;
        credentialVersion: number;
        accountStatus: string;
      }>
    >`
      SELECT id, "companyId", "credentialVersion", "accountStatus"
      FROM "User"
      WHERE id = ${input.principalId}
        AND "companyId" = ${companyId}
      FOR UPDATE
    `;
    const user = users[0];
    if (!user || user.accountStatus !== 'active') return null;

    if (input.principalDomain === 'company_primary_owner') {
      // Mirrors authorization.isPrimaryOwner: active Primary Owner only, not any User.
      const ownership = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "CompanyOwnership"
        WHERE "companyId" = ${companyId}
          AND "userId" = ${input.principalId}
          AND "isPrimary" = TRUE
          AND status = 'active'
          AND "endedAt" IS NULL
        FOR UPDATE
      `;
      if (!ownership[0]) return null;
    }

    return {
      principalDomain: input.principalDomain,
      principalId: user.id,
      companyId: user.companyId,
      credentialVersion: user.credentialVersion,
      status: user.accountStatus,
    };
  }

  async compareAndIncrementCredentialVersion(
    tx: TxClient,
    target: RecoveryTargetSnapshot,
    expectedVersion: number,
  ): Promise<boolean> {
    if (target.principalDomain === 'platform_principal') {
      const result = await tx.platformPrincipal.updateMany({
        where: {
          id: target.principalId,
          credentialVersion: expectedVersion,
        },
        data: { credentialVersion: { increment: 1 } },
      });
      return result.count === 1;
    }

    if (!target.companyId) return false;
    const result = await tx.user.updateMany({
      where: {
        id: target.principalId,
        companyId: target.companyId,
        credentialVersion: expectedVersion,
      },
      data: { credentialVersion: { increment: 1 } },
    });
    return result.count === 1;
  }
}

/**
 * TEST-ONLY in-memory target store. Not production enforcement.
 * Supports transactional CAS against an in-process map for unit tests without PostgreSQL.
 */
export class TestOnlyMapRecoveryTargetStore implements RecoveryTargetStore {
  constructor(private readonly targets: Map<string, RecoveryTargetSnapshot>) {}

  static key(
    domain: RecoveryPrincipalDomain,
    principalId: string,
    companyId?: string | null,
  ): string {
    return `${domain}|${principalId}|${companyId ?? ''}`;
  }

  set(snapshot: RecoveryTargetSnapshot): void {
    this.targets.set(
      TestOnlyMapRecoveryTargetStore.key(
        snapshot.principalDomain,
        snapshot.principalId,
        snapshot.companyId,
      ),
      { ...snapshot },
    );
  }

  get(
    domain: RecoveryPrincipalDomain,
    principalId: string,
    companyId?: string | null,
  ): RecoveryTargetSnapshot | null {
    return (
      this.targets.get(TestOnlyMapRecoveryTargetStore.key(domain, principalId, companyId)) ?? null
    );
  }

  async lockAndResolve(
    _tx: TxClient,
    input: {
      principalDomain: RecoveryPrincipalDomain;
      principalId: string;
      companyId?: string | null;
    },
  ): Promise<RecoveryTargetSnapshot | null> {
    const found = this.get(input.principalDomain, input.principalId, input.companyId);
    return found ? { ...found } : null;
  }

  async compareAndIncrementCredentialVersion(
    _tx: TxClient,
    target: RecoveryTargetSnapshot,
    expectedVersion: number,
  ): Promise<boolean> {
    const key = TestOnlyMapRecoveryTargetStore.key(
      target.principalDomain,
      target.principalId,
      target.companyId,
    );
    const current = this.targets.get(key);
    if (!current || current.credentialVersion !== expectedVersion) return false;
    current.credentialVersion = expectedVersion + 1;
    this.targets.set(key, current);
    return true;
  }
}

/** @deprecated Use TestOnlyMapRecoveryTargetStore — kept name clarity for searches. */
export const MapRecoveryTargetResolver = TestOnlyMapRecoveryTargetStore;

export type RecoveryDb = PrismaClient;
