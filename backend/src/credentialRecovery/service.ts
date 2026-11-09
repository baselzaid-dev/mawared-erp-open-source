import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  assertRecoveryPolicyCombination,
  assertRecoveryTtlOverrides,
  resolveRecoveryTtlSeconds,
  type RecoveryDeliveryChannel,
  type RecoveryInitiator,
  type RecoveryInvalidationReason,
  type RecoveryPrincipalDomain,
  type RecoveryPurpose,
  type RecoveryTtlOverrides,
} from './contracts';
import {
  writeRecoveryAuditRequired,
  subjectDomainFromPrincipal,
  normalizeRecoveryAuditActor,
  RecoveryAuditSanitizationError,
  type RecoveryAuditActorType,
  type RecoveryAuditActor,
} from './audit';
import type { RecoveryInternalFailure, RecoveryResult } from './errors';
import {
  assertRecoveryCryptoConfig,
  hashRecoveryToken,
  mintRecoveryTokenMaterial,
  parseSourceBucketHash,
  resolveEnvironmentBinding,
  type CredentialRecoverySecret,
  type RecoveryCryptoConfig,
  type RecoverySourceBucketHash,
} from './tokenCrypto';
import type { RecoveryTargetStore } from './targetStore';

type DbClient = PrismaClient;
type TxClient = Prisma.TransactionClient;

export interface IssueRecoveryRequestInput {
  principalDomain: RecoveryPrincipalDomain;
  principalId: string;
  companyId?: string | null;
  purpose: RecoveryPurpose;
  initiatedBy: RecoveryInitiator;
  initiatorPrincipalId?: string | null;
  deliveryChannel: RecoveryDeliveryChannel;
  requestId: string;
  /** Keyed recovery-src-v1 hash only — never raw email/IP/phone. */
  sourceBucketHash?: RecoverySourceBucketHash | string | null;
  actorType?: RecoveryAuditActorType;
  actorId?: string | null;
  now?: Date;
}

export interface IssuedRecoveryRequest {
  requestId: string;
  recoveryRequestId: string;
  purpose: RecoveryPurpose;
  principalDomain: RecoveryPrincipalDomain;
  principalId: string;
  companyId: string | null;
  expiresAt: Date;
  credentialVersionAtIssuance: number;
  environmentBinding: string;
  deliveryStatus: 'pending';
  /** Present only for token-bearing purposes; transient secret boundary. */
  deliverySecret: CredentialRecoverySecret | null;
  auditEventId: string;
  supersededRequestIds: string[];
}

export interface ConsumeRecoveryRequestInput {
  rawToken: string | CredentialRecoverySecret;
  principalDomain: RecoveryPrincipalDomain;
  purpose: RecoveryPurpose;
  /**
   * Optional server-owned assertion after the recovery row is resolved.
   * Never used to write audit companyId for unknown tokens.
   */
  expectedCompanyId?: string | null;
  requestId: string;
  now?: Date;
  actorType?: RecoveryAuditActorType;
  actorId?: string | null;
}

export interface ValidRecoveryRequestContext {
  recoveryRequestId: string;
  principalDomain: RecoveryPrincipalDomain;
  principalId: string;
  companyId: string | null;
  purpose: RecoveryPurpose;
  credentialVersionAtIssuance: number;
  /** Version that was current when the fence passed (equals expected before CAS). */
  expectedCredentialVersion: number;
  /** Version after E1's owned increment when policy requires it; otherwise equals expected. */
  nextCredentialVersion: number;
  environmentBinding: string;
  expiresAt: Date;
}

export interface CredentialRecoveryServiceOptions {
  prisma: DbClient;
  crypto: RecoveryCryptoConfig;
  environmentBinding?: string;
  /** Production: PostgresRecoveryTargetStore. Tests may inject TestOnlyMapRecoveryTargetStore. */
  targetStore: RecoveryTargetStore;
  /** Optional server-owned TTL overrides validated at construction. */
  ttlOverrides?: RecoveryTtlOverrides;
  clock?: () => Date;
}

export interface RecordDeliveryStatusInput {
  recoveryRequestId: string;
  deliveryStatus: 'dispatched' | 'failed';
  requestId: string;
  actorType?: RecoveryAuditActorType;
  actorId?: string | null;
  now?: Date;
}

export interface RecordedDeliveryStatus {
  recoveryRequestId: string;
  deliveryStatus: 'dispatched' | 'failed';
  auditEventId: string;
}

function fail(reason: RecoveryInternalFailure['reason'], detailCode?: string): RecoveryInternalFailure {
  return { ok: false, reason, detailCode };
}

function isDocumentedConcurrencyConflict(error: unknown): boolean {
  // Only unique-constraint races are documented as concurrent_conflict.
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function resolveIssueAuditActor(input: IssueRecoveryRequestInput): RecoveryAuditActor {
  const defaultActorType: RecoveryAuditActorType =
    input.initiatedBy === 'self' ? 'anonymous' : 'system';
  const resolvedType = input.actorType ?? defaultActorType;
  // Never attach initiatorPrincipalId under anonymous — that fails closed.
  const actorIdCandidate =
    resolvedType === 'anonymous'
      ? (input.actorId ?? null)
      : (input.actorId ?? input.initiatorPrincipalId ?? null);
  return normalizeRecoveryAuditActor({
    actorType: input.actorType,
    actorId: actorIdCandidate,
    defaultActorType,
  });
}

function resolveConsumeAuditActor(input: ConsumeRecoveryRequestInput): RecoveryAuditActor {
  return normalizeRecoveryAuditActor({
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    defaultActorType: 'anonymous',
  });
}

function advisoryLockKey(input: {
  principalDomain: RecoveryPrincipalDomain;
  principalId: string;
  companyId: string | null;
  purpose: RecoveryPurpose;
}): string {
  return [
    'mawared-recovery-e1',
    input.principalDomain,
    input.principalId,
    input.companyId ?? '',
    input.purpose,
  ].join(':');
}

function normalizeSourceBucketHash(
  value: RecoverySourceBucketHash | string | null | undefined,
): string | null {
  if (value == null) return null;
  return parseSourceBucketHash(typeof value === 'string' ? value : value.toString()).toString();
}

export class CredentialRecoveryService {
  readonly #prisma: DbClient;
  readonly #crypto: RecoveryCryptoConfig;
  readonly #environmentBinding: string;
  readonly #targetStore: RecoveryTargetStore;
  readonly #ttlOverrides: RecoveryTtlOverrides;
  readonly #clock: () => Date;

  constructor(options: CredentialRecoveryServiceOptions) {
    this.#crypto = assertRecoveryCryptoConfig(options.crypto);
    this.#environmentBinding = resolveEnvironmentBinding(options.environmentBinding);
    this.#prisma = options.prisma;
    this.#targetStore = options.targetStore;
    this.#ttlOverrides = assertRecoveryTtlOverrides(options.ttlOverrides);
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Atomically issue a recovery request, superseding any prior active request
   * for the same domain + principal + company + purpose.
   * Target credentialVersion is read only inside the transaction under row lock.
   */
  async issue(
    input: IssueRecoveryRequestInput,
  ): Promise<RecoveryResult<IssuedRecoveryRequest>> {
    // Fail closed before opening a transaction for policy/hash/actor errors so
    // callers can observe zero DB side effects on rejected configurations.
    try {
      assertRecoveryPolicyCombination({
        principalDomain: input.principalDomain,
        purpose: input.purpose,
        companyId: input.companyId,
      });
    } catch {
      return fail('policy_rejected');
    }
    try {
      normalizeSourceBucketHash(input.sourceBucketHash);
    } catch {
      return fail('policy_rejected', 'source_bucket_hash_invalid');
    }
    try {
      resolveRecoveryTtlSeconds(input.purpose, this.#ttlOverrides);
    } catch {
      return fail('policy_rejected', 'ttl_invalid');
    }
    try {
      resolveIssueAuditActor(input);
    } catch (error) {
      if (error instanceof RecoveryAuditSanitizationError) {
        return fail('audit_rejected', 'actor_inconsistent');
      }
      throw error;
    }

    try {
      const value = await this.#prisma.$transaction(async (tx) =>
        this.issueInTransaction(tx, input),
      );
      return { ok: true, value };
    } catch (error) {
      if (error instanceof RecoveryTransactionRejectError) {
        return fail(error.reason, error.detailCode);
      }
      if (error instanceof RecoveryAuditSanitizationError) {
        return fail('audit_rejected', 'actor_inconsistent');
      }
      if (isDocumentedConcurrencyConflict(error)) {
        return fail('concurrent_conflict');
      }
      throw error;
    }
  }

  /**
   * Transaction-aware issue primitive for callers that must compose issuance
   * with adjacent durable work (e.g. Platform idempotency + audit) atomically.
   * Throws RecoveryTransactionRejectError / RecoveryAuditSanitizationError on
   * documented failures so the outer transaction can roll back.
   */
  async issueInTransaction(
    tx: TxClient,
    input: IssueRecoveryRequestInput,
  ): Promise<IssuedRecoveryRequest> {
    let policy;
    try {
      policy = assertRecoveryPolicyCombination({
        principalDomain: input.principalDomain,
        purpose: input.purpose,
        companyId: input.companyId,
      });
    } catch {
      throw new RecoveryTransactionRejectError('policy_rejected');
    }

    let sourceBucketHash: string | null = null;
    try {
      sourceBucketHash = normalizeSourceBucketHash(input.sourceBucketHash);
    } catch {
      throw new RecoveryTransactionRejectError('policy_rejected', 'source_bucket_hash_invalid');
    }

    const now = input.now ?? this.#clock();
    let ttlSeconds: number;
    try {
      ttlSeconds = resolveRecoveryTtlSeconds(input.purpose, this.#ttlOverrides);
    } catch {
      throw new RecoveryTransactionRejectError('policy_rejected', 'ttl_invalid');
    }
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const recoveryRequestId = randomUUID();

    let auditActor: RecoveryAuditActor;
    try {
      auditActor = resolveIssueAuditActor(input);
    } catch (error) {
      if (error instanceof RecoveryAuditSanitizationError) {
        throw error;
      }
      throw error;
    }

    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey({
        principalDomain: input.principalDomain,
        principalId: input.principalId,
        companyId: input.companyId ?? null,
        purpose: input.purpose,
      })}))
    `;

    const target = await this.#targetStore.lockAndResolve(tx, {
      principalDomain: input.principalDomain,
      principalId: input.principalId,
      companyId: input.companyId,
    });
    if (!target) {
      throw new RecoveryTransactionRejectError('target_unresolved');
    }
    if (target.principalDomain !== input.principalDomain) {
      throw new RecoveryTransactionRejectError('domain_mismatch');
    }
    if ((target.companyId ?? null) !== (input.companyId ?? null)) {
      throw new RecoveryTransactionRejectError('company_mismatch');
    }

    let deliverySecret: CredentialRecoverySecret | null = null;
    let tokenHash: string | null = null;
    let tokenHashAlgorithm: string | null = null;
    if (policy.mintsBearerToken) {
      const minted = mintRecoveryTokenMaterial(
        {
          principalDomain: input.principalDomain,
          purpose: input.purpose,
          environmentBinding: this.#environmentBinding,
        },
        this.#crypto,
      );
      deliverySecret = minted.rawToken;
      tokenHash = minted.tokenHash;
      tokenHashAlgorithm = minted.tokenHashAlgorithm;
    }

    const active = await tx.credentialRecoveryRequest.findMany({
      where: {
        principalDomain: input.principalDomain,
        principalId: target.principalId,
        purpose: input.purpose,
        companyId: target.companyId,
        consumedAt: null,
        invalidatedAt: null,
      },
      select: { id: true },
    });

    const supersededRequestIds = active.map((row) => row.id);
    if (active.length > 0) {
      await tx.credentialRecoveryRequest.updateMany({
        where: { id: { in: supersededRequestIds } },
        data: {
          invalidatedAt: now,
          invalidationReason: 'superseded' satisfies RecoveryInvalidationReason,
        },
      });
    }

    await tx.credentialRecoveryRequest.create({
      data: {
        id: recoveryRequestId,
        principalDomain: input.principalDomain,
        principalId: target.principalId,
        companyId: target.companyId,
        purpose: input.purpose,
        tokenHash,
        tokenHashAlgorithm,
        environmentBinding: this.#environmentBinding,
        createdAt: now,
        expiresAt,
        credentialVersionAtIssuance: target.credentialVersion,
        initiatedBy: input.initiatedBy,
        initiatorPrincipalId: input.initiatorPrincipalId ?? null,
        deliveryChannel: input.deliveryChannel,
        deliveryStatus: 'pending',
        requestSourceHash: sourceBucketHash,
      },
    });

    if (supersededRequestIds.length > 0) {
      await tx.credentialRecoveryRequest.updateMany({
        where: { id: { in: supersededRequestIds } },
        data: { supersededByRequestId: recoveryRequestId },
      });
      for (const priorId of supersededRequestIds) {
        await writeRecoveryAuditRequired(tx as unknown as DbClient, {
          eventType: 'recovery_request_superseded',
          actorType: auditActor.actorType,
          actorId: auditActor.actorId,
          subjectId: target.principalId,
          subjectDomain: subjectDomainFromPrincipal(input.principalDomain),
          companyId: target.companyId,
          result: 'success',
          reasonCode: 'superseded',
          recoveryRequestId: priorId,
          requestId: input.requestId,
          sourceBucketHash,
        });
      }
    }

    const audit = await writeRecoveryAuditRequired(tx as unknown as DbClient, {
      eventType: 'recovery_request_issued',
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      subjectId: target.principalId,
      subjectDomain: subjectDomainFromPrincipal(input.principalDomain),
      companyId: target.companyId,
      result: 'success',
      reasonCode: 'issued',
      recoveryRequestId,
      requestId: input.requestId,
      sourceBucketHash,
    });

    await tx.credentialRecoveryRequest.update({
      where: { id: recoveryRequestId },
      data: { auditEventId: audit.id },
    });

    return {
      requestId: input.requestId,
      recoveryRequestId,
      purpose: input.purpose,
      principalDomain: input.principalDomain,
      principalId: target.principalId,
      companyId: target.companyId,
      expiresAt,
      credentialVersionAtIssuance: target.credentialVersion,
      environmentBinding: this.#environmentBinding,
      deliveryStatus: 'pending',
      deliverySecret,
      auditEventId: audit.id,
      supersededRequestIds,
    };
  }

  /**
   * Record delivery outcome after a committed issue. Never invents dispatched
   * on crash; only transitions pending -> dispatched|failed.
   * Callers must inspect RecoveryResult.ok — resolved ok:false is persistence failure.
   */
  async recordDeliveryStatus(
    input: RecordDeliveryStatusInput,
  ): Promise<RecoveryResult<RecordedDeliveryStatus>> {
    return this.recordDeliveryStatusWithEffect(input, async () => undefined);
  }

  /**
   * Atomically transition pending -> dispatched|failed, write the E1 delivery audit,
   * then run a caller-provided transactional effect (e.g. Platform final audit).
   * No Platform-specific logic here. If the effect throws, the whole transaction
   * rolls back and the result is ok:false (callback_failed).
   */
  async recordDeliveryStatusWithEffect<T = void>(
    input: RecordDeliveryStatusInput,
    transactionalEffect: (
      tx: TxClient,
      recorded: RecordedDeliveryStatus,
    ) => Promise<T>,
  ): Promise<RecoveryResult<RecordedDeliveryStatus>> {
    if (input.deliveryStatus !== 'dispatched' && input.deliveryStatus !== 'failed') {
      return fail('policy_rejected', 'delivery_status_invalid');
    }

    let auditActor: RecoveryAuditActor;
    try {
      auditActor = normalizeRecoveryAuditActor({
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        defaultActorType: 'system',
      });
    } catch (error) {
      if (error instanceof RecoveryAuditSanitizationError) {
        return fail('audit_rejected', 'actor_inconsistent');
      }
      throw error;
    }

    try {
      return await this.#prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            principalDomain: string;
            principalId: string;
            companyId: string | null;
            deliveryStatus: string;
          }>
        >`
          SELECT id, "principalDomain", "principalId", "companyId", "deliveryStatus"
          FROM "CredentialRecoveryRequest"
          WHERE id = ${input.recoveryRequestId}
          FOR UPDATE
        `;
        const locked = rows[0];
        if (!locked) {
          return fail('token_invalid');
        }

        const writeDeliveryAudit = async (): Promise<RecordedDeliveryStatus> => {
          const audit = await writeRecoveryAuditRequired(tx as unknown as DbClient, {
            eventType: 'recovery_delivery_recorded',
            actorType: auditActor.actorType,
            actorId: auditActor.actorId,
            subjectId: locked.principalId,
            subjectDomain: subjectDomainFromPrincipal(
              locked.principalDomain as RecoveryPrincipalDomain,
            ),
            companyId: locked.companyId,
            result: input.deliveryStatus === 'dispatched' ? 'success' : 'failure',
            reasonCode:
              input.deliveryStatus === 'dispatched'
                ? 'delivery_dispatched'
                : 'delivery_failed',
            recoveryRequestId: locked.id,
            requestId: input.requestId,
          });
          return {
            recoveryRequestId: locked.id,
            deliveryStatus: input.deliveryStatus,
            auditEventId: audit.id,
          };
        };

        let recorded: RecordedDeliveryStatus;
        if (locked.deliveryStatus !== 'pending') {
          // Idempotent replay of the same terminal status is treated as success.
          if (locked.deliveryStatus === input.deliveryStatus) {
            recorded = await writeDeliveryAudit();
          } else {
            return fail('policy_rejected', 'delivery_status_conflict');
          }
        } else {
          const updated = await tx.credentialRecoveryRequest.updateMany({
            where: {
              id: locked.id,
              deliveryStatus: 'pending',
            },
            data: { deliveryStatus: input.deliveryStatus },
          });
          if (updated.count !== 1) {
            return fail('concurrent_conflict');
          }
          recorded = await writeDeliveryAudit();
        }

        try {
          await transactionalEffect(tx, recorded);
        } catch (error) {
          throw new RecoveryCallbackFailedError(
            error instanceof Error ? error.message : 'callback_failed',
          );
        }

        return {
          ok: true as const,
          value: recorded,
        };
      });
    } catch (error) {
      if (error instanceof RecoveryCallbackFailedError) {
        return fail('callback_failed');
      }
      if (error instanceof RecoveryAuditSanitizationError) {
        return fail('audit_rejected', 'actor_inconsistent');
      }
      if (isDocumentedConcurrencyConflict(error)) {
        return fail('concurrent_conflict');
      }
      throw error;
    }
  }

  /**
   * Verify and consume a recovery token atomically with a caller-provided effect.
   * E1 owns credentialVersion CAS when policy.affectsCredentialVersionOnConsume.
   * Future E2–E5 effects must not increment credentialVersion again.
   */
  async withValidRecoveryRequest<T>(
    input: ConsumeRecoveryRequestInput,
    transactionalEffect: (
      ctx: ValidRecoveryRequestContext,
      tx: TxClient,
    ) => Promise<T>,
  ): Promise<RecoveryResult<{ context: ValidRecoveryRequestContext; effect: T }>> {
    const now = input.now ?? this.#clock();
    let auditActor: RecoveryAuditActor;
    try {
      auditActor = resolveConsumeAuditActor(input);
    } catch (error) {
      if (error instanceof RecoveryAuditSanitizationError) {
        return fail('audit_rejected', 'actor_inconsistent');
      }
      throw error;
    }

    const raw =
      typeof input.rawToken === 'string' ? input.rawToken : input.rawToken.reveal();

    const hashed = hashRecoveryToken(
      raw,
      {
        principalDomain: input.principalDomain,
        purpose: input.purpose,
        environmentBinding: this.#environmentBinding,
      },
      this.#crypto,
    );

    try {
      return await this.#prisma.$transaction(async (tx) => {
        const row = await tx.credentialRecoveryRequest.findFirst({
          where: { tokenHash: hashed.tokenHash },
        });

        if (!row) {
          await writeRecoveryAuditRequired(tx as unknown as DbClient, {
            eventType: 'recovery_request_rejected',
            actorType: auditActor.actorType,
            actorId: auditActor.actorId,
            subjectId: null,
            subjectDomain: 'unresolved',
            companyId: null,
            result: 'failure',
            reasonCode: 'invalid_or_expired_token',
            recoveryRequestId: null,
            requestId: input.requestId,
          });
          return fail('token_invalid');
        }

        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey({
            principalDomain: row.principalDomain as RecoveryPrincipalDomain,
            principalId: row.principalId,
            companyId: row.companyId,
            purpose: row.purpose as RecoveryPurpose,
          })}))
        `;

        const lockedRows = await tx.$queryRaw<
          Array<{
            id: string;
            principalDomain: string;
            principalId: string;
            companyId: string | null;
            purpose: string;
            tokenHash: string | null;
            tokenHashAlgorithm: string | null;
            environmentBinding: string;
            createdAt: Date;
            expiresAt: Date;
            consumedAt: Date | null;
            supersededByRequestId: string | null;
            invalidatedAt: Date | null;
            invalidationReason: string | null;
            credentialVersionAtIssuance: number;
            initiatedBy: string;
            initiatorPrincipalId: string | null;
            deliveryChannel: string;
            deliveryStatus: string;
            requestSourceHash: string | null;
            auditEventId: string | null;
          }>
        >`
          SELECT *
          FROM "CredentialRecoveryRequest"
          WHERE id = ${row.id}
          FOR UPDATE
        `;
        const locked = lockedRows[0];
        if (!locked) return fail('token_invalid');

        const reject = async (
          reason: RecoveryInternalFailure['reason'],
          reasonCode: string,
          invalidate?: RecoveryInvalidationReason,
        ): Promise<RecoveryInternalFailure> => {
          if (invalidate && !locked.invalidatedAt) {
            await tx.credentialRecoveryRequest.update({
              where: { id: locked.id },
              data: {
                invalidatedAt: now,
                invalidationReason: invalidate,
              },
            });
          }
          await writeRecoveryAuditRequired(tx as unknown as DbClient, {
            eventType: 'recovery_request_rejected',
            actorType: auditActor.actorType,
            actorId: auditActor.actorId,
            subjectId: locked.principalId,
            subjectDomain: subjectDomainFromPrincipal(
              locked.principalDomain as RecoveryPrincipalDomain,
            ),
            companyId: locked.companyId,
            result: reason === 'token_expired' ? 'expired' : 'failure',
            reasonCode,
            recoveryRequestId: locked.id,
            requestId: input.requestId,
          });
          return fail(reason);
        };

        if (locked.tokenHashAlgorithm !== hashed.tokenHashAlgorithm) {
          return reject('algorithm_mismatch', 'algorithm_mismatch');
        }
        if (locked.environmentBinding !== this.#environmentBinding) {
          return reject('environment_mismatch', 'environment_mismatch');
        }
        if (locked.principalDomain !== input.principalDomain) {
          return reject('domain_mismatch', 'domain_mismatch');
        }
        if (locked.purpose !== input.purpose) {
          return reject('purpose_mismatch', 'purpose_mismatch');
        }
        if (
          input.expectedCompanyId !== undefined &&
          (locked.companyId ?? null) !== (input.expectedCompanyId ?? null)
        ) {
          return reject('company_mismatch', 'company_mismatch');
        }
        if (locked.consumedAt) {
          return reject('token_consumed', 'token_already_used');
        }
        if (locked.invalidatedAt) {
          const reason =
            locked.invalidationReason === 'superseded'
              ? 'token_superseded'
              : locked.invalidationReason === 'credential_version_mismatch'
                ? 'credential_version_mismatch'
                : 'token_invalidated';
          return reject(
            reason,
            reason === 'token_superseded' ? 'token_already_used' : 'invalid_or_expired_token',
          );
        }
        if (locked.expiresAt.getTime() <= now.getTime()) {
          return reject('token_expired', 'expired', 'expired');
        }

        const target = await this.#targetStore.lockAndResolve(tx, {
          principalDomain: locked.principalDomain as RecoveryPrincipalDomain,
          principalId: locked.principalId,
          companyId: locked.companyId,
        });
        if (!target) {
          return reject('target_unresolved', 'target_unresolved');
        }
        if (target.credentialVersion !== locked.credentialVersionAtIssuance) {
          return reject(
            'credential_version_mismatch',
            'credential_version_mismatch',
            'credential_version_mismatch',
          );
        }

        const purpose = locked.purpose as RecoveryPurpose;
        const policy = assertRecoveryPolicyCombination({
          principalDomain: locked.principalDomain as RecoveryPrincipalDomain,
          purpose,
          companyId: locked.companyId,
        });

        let nextCredentialVersion = locked.credentialVersionAtIssuance;
        if (policy.affectsCredentialVersionOnConsume) {
          const casOk = await this.#targetStore.compareAndIncrementCredentialVersion(
            tx,
            target,
            locked.credentialVersionAtIssuance,
          );
          if (!casOk) {
            return reject(
              'credential_version_mismatch',
              'credential_version_mismatch',
              'credential_version_mismatch',
            );
          }
          nextCredentialVersion = locked.credentialVersionAtIssuance + 1;
        }

        const context: ValidRecoveryRequestContext = {
          recoveryRequestId: locked.id,
          principalDomain: locked.principalDomain as RecoveryPrincipalDomain,
          principalId: locked.principalId,
          companyId: locked.companyId,
          purpose,
          credentialVersionAtIssuance: locked.credentialVersionAtIssuance,
          expectedCredentialVersion: locked.credentialVersionAtIssuance,
          nextCredentialVersion,
          environmentBinding: locked.environmentBinding,
          expiresAt: locked.expiresAt,
        };

        let effect: T;
        try {
          effect = await transactionalEffect(context, tx);
        } catch (error) {
          throw new RecoveryCallbackFailedError(
            error instanceof Error ? error.message : 'callback_failed',
          );
        }

        const consumed = await tx.credentialRecoveryRequest.updateMany({
          where: {
            id: locked.id,
            consumedAt: null,
            invalidatedAt: null,
          },
          data: {
            consumedAt: now,
            invalidationReason: 'consumed',
            invalidatedAt: now,
          },
        });
        if (consumed.count !== 1) {
          return reject('token_consumed', 'token_already_used');
        }

        await writeRecoveryAuditRequired(tx as unknown as DbClient, {
          eventType: 'recovery_request_consumed',
          actorType: auditActor.actorType,
          actorId: auditActor.actorId,
          subjectId: locked.principalId,
          subjectDomain: subjectDomainFromPrincipal(
            locked.principalDomain as RecoveryPrincipalDomain,
          ),
          companyId: locked.companyId,
          result: 'success',
          reasonCode: 'consumed',
          recoveryRequestId: locked.id,
          requestId: input.requestId,
        });

        return { ok: true as const, value: { context, effect } };
      });
    } catch (error) {
      if (error instanceof RecoveryCallbackFailedError) {
        return fail('callback_failed');
      }
      if (error instanceof RecoveryAuditSanitizationError) {
        return fail('audit_rejected', 'actor_inconsistent');
      }
      if (isDocumentedConcurrencyConflict(error)) {
        return fail('concurrent_conflict');
      }
      throw error;
    }
  }
}

export class RecoveryCallbackFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryCallbackFailedError';
  }
}

export class RecoveryTransactionRejectError extends Error {
  readonly reason: RecoveryInternalFailure['reason'];
  readonly detailCode?: string;

  constructor(reason: RecoveryInternalFailure['reason'], detailCode?: string) {
    super(reason);
    this.name = 'RecoveryTransactionRejectError';
    this.reason = reason;
    this.detailCode = detailCode;
  }
}
