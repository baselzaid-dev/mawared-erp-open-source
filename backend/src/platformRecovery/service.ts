/**
 * E5 Platform MFA-only recovery and full break-glass service.
 * CLI-owned mutations; no HTTP break-glass execution.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../credentialSecrets';
import {
  writeRecoveryAuditRequired,
} from '../credentialRecovery/audit';
import {
  resolveRecoveryTtlSeconds,
  type RecoveryInvalidationReason,
} from '../credentialRecovery/contracts';
import {
  mintRecoveryTokenMaterial,
  type CredentialRecoverySecret,
  type RecoveryCryptoConfig,
} from '../credentialRecovery/tokenCrypto';
import { PostgresRecoveryTargetStore } from '../credentialRecovery/targetStore';
import { writePlatformAudit } from '../platformAuth';
import type {
  OfflineAuthorizationVerifier,
  PlatformRecoveryMode,
  PlatformRecoveryReasonCategory,
  ProductionDualControlVerifier,
} from './approvals';
import {
  UnavailableProductionDualControlVerifier,
  assertProductionSafeDualControlVerifier,
} from './approvals';
import {
  RecoveryPackageSecret,
  type RecoveryPackageEmitter,
} from './emitter';
import type { ResolvedPlatformRecoveryEnvironment } from './environment';

type TxClient = Prisma.TransactionClient;

export class PlatformRecoveryServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformRecoveryServiceError';
    this.code = code;
  }
}

export type MfaStateCategory = 'enrolled' | 'pending' | 'absent';

export interface PlatformRecoveryDryRunPlan {
  mode: PlatformRecoveryMode;
  principalId: string;
  eligible: boolean;
  eligibilityReason: string | null;
  credentialVersion: number | null;
  activeSessionCount: number | null;
  mfaStateCategory: MfaStateCategory | null;
  passwordPreserved: boolean;
  passwordReplaced: boolean;
  mfaWouldBeCleared: boolean;
  reEnrollmentRequired: boolean;
  environmentClass: string;
  fingerprintReference: string;
  productionApprovalsConfigured: boolean;
  dryRun: true;
}

export interface PlatformRecoveryExecuteResult {
  mode: PlatformRecoveryMode;
  operationId: string;
  principalId: string;
  previousCredentialVersion: number;
  credentialVersion: number;
  sessionsRevokedCount: number;
  mfaInvalidated: boolean;
  recoveryPackageIssued: boolean;
  recoveryRequestId: string;
  /** Present only for full-break-glass; emit after commit. */
  recoveryPackage: RecoveryPackageSecret | null;
}

export interface PlatformRecoveryServiceDeps {
  prisma: PrismaClient;
  crypto: RecoveryCryptoConfig;
  offlineAuthorization: OfflineAuthorizationVerifier;
  productionDualControl?: ProductionDualControlVerifier;
  clock?: () => Date;
  /** When true, refuse any Production dual-control that is test-only. */
  enforceProductionConstructionGuards?: boolean;
}

function advisoryLockKey(input: {
  principalDomain: string;
  principalId: string;
  purpose: string;
}): string {
  return `recovery:${input.principalDomain}:${input.principalId}::${input.purpose}`;
}

async function lockPrincipal(
  tx: TxClient,
  principalId: string,
): Promise<{
  id: string;
  status: string;
  credentialVersion: number;
  authorizationVersion: number;
  permissions: string;
  password: string;
} | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    status: string;
    credentialVersion: number;
    authorizationVersion: number;
    permissions: string;
    password: string;
  }>>`
    SELECT id, status, "credentialVersion", "authorizationVersion", permissions, password
    FROM "PlatformPrincipal"
    WHERE id = ${principalId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockMfa(
  tx: TxClient,
  principalId: string,
): Promise<{
  principalId: string;
  state: string;
  secretCiphertext: string | null;
  pendingSecretCiphertext: string | null;
  challengeTokenHash: string | null;
  backupCodeHashes: string;
} | null> {
  const rows = await tx.$queryRaw<Array<{
    principalId: string;
    state: string;
    secretCiphertext: string | null;
    pendingSecretCiphertext: string | null;
    challengeTokenHash: string | null;
    backupCodeHashes: string;
  }>>`
    SELECT "principalId", state, "secretCiphertext", "pendingSecretCiphertext",
           "challengeTokenHash", "backupCodeHashes"
    FROM "PlatformMfaCredential"
    WHERE "principalId" = ${principalId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function mfaCategory(row: {
  state: string;
} | null): MfaStateCategory {
  if (!row) return 'absent';
  if (row.state === 'enrolled') return 'enrolled';
  return 'pending';
}

export class PlatformRecoveryService {
  readonly #prisma: PrismaClient;
  readonly #crypto: RecoveryCryptoConfig;
  readonly #offline: OfflineAuthorizationVerifier;
  readonly #production: ProductionDualControlVerifier;
  readonly #clock: () => Date;
  readonly #targets = new PostgresRecoveryTargetStore();

  constructor(deps: PlatformRecoveryServiceDeps) {
    this.#prisma = deps.prisma;
    this.#crypto = deps.crypto;
    this.#offline = deps.offlineAuthorization;
    this.#production = deps.productionDualControl
      ?? new UnavailableProductionDualControlVerifier();
    this.#clock = deps.clock ?? (() => new Date());
    if (deps.enforceProductionConstructionGuards) {
      assertProductionSafeDualControlVerifier(this.#production);
    }
  }

  async dryRun(input: {
    principalId: string;
    mode: PlatformRecoveryMode;
    environment: ResolvedPlatformRecoveryEnvironment;
  }): Promise<PlatformRecoveryDryRunPlan> {
    // Side-effect-free reads only — no rate buckets, recovery rows, or audit success.
    const principal = await this.#prisma.platformPrincipal.findUnique({
      where: { id: input.principalId },
      select: { id: true, status: true, credentialVersion: true },
    });
    if (!principal) {
      return {
        mode: input.mode,
        principalId: input.principalId,
        eligible: false,
        eligibilityReason: 'principal_not_found',
        credentialVersion: null,
        activeSessionCount: null,
        mfaStateCategory: null,
        passwordPreserved: input.mode === 'mfa-recovery',
        passwordReplaced: input.mode === 'full-break-glass',
        mfaWouldBeCleared: true,
        reEnrollmentRequired: true,
        environmentClass: input.environment.resolvedClass,
        fingerprintReference: input.environment.fingerprintReference,
        productionApprovalsConfigured: this.#production.isConfigured,
        dryRun: true,
      };
    }

    const [sessionCount, mfa] = await Promise.all([
      this.#prisma.platformRefreshToken.count({
        where: { principalId: principal.id, revokedAt: null },
      }),
      this.#prisma.platformMfaCredential.findUnique({
        where: { principalId: principal.id },
        select: { state: true },
      }),
    ]);

    const eligible = principal.status === 'active';
    return {
      mode: input.mode,
      principalId: principal.id,
      eligible,
      eligibilityReason: eligible ? null : 'principal_inactive',
      credentialVersion: principal.credentialVersion,
      activeSessionCount: sessionCount,
      mfaStateCategory: mfaCategory(mfa),
      passwordPreserved: input.mode === 'mfa-recovery',
      passwordReplaced: input.mode === 'full-break-glass',
      mfaWouldBeCleared: true,
      reEnrollmentRequired: true,
      environmentClass: input.environment.resolvedClass,
      fingerprintReference: input.environment.fingerprintReference,
      productionApprovalsConfigured: this.#production.isConfigured,
      dryRun: true,
    };
  }

  async execute(input: {
    principalId: string;
    mode: PlatformRecoveryMode;
    reasonCategory: PlatformRecoveryReasonCategory;
    environment: ResolvedPlatformRecoveryEnvironment;
    offlineSecret: string;
    operationId?: string;
    requestId?: string;
    /** Production-only sanitized approval material (never secrets). */
    productionApprovals?: {
      approverReferences: string[];
      approvalReferences: string[];
    };
    productionConfirmationPhrase?: string;
    targetConfirmationPrincipalId?: string;
  }): Promise<PlatformRecoveryExecuteResult> {
    const operationId = input.operationId ?? randomUUID();
    const requestId = input.requestId ?? operationId;
    const now = this.#clock();

    // Non-DB prerequisites first.
    if (input.environment.isProduction) {
      assertProductionSafeDualControlVerifier(this.#production);
      if (!this.#production.isConfigured) {
        throw new PlatformRecoveryServiceError(
          'production_dual_control_unavailable',
          'Production dual/threshold approval provider is not configured',
        );
      }
      if (input.productionConfirmationPhrase !== 'CONFIRM PRODUCTION BREAK-GLASS') {
        throw new PlatformRecoveryServiceError(
          'production_confirmation_required',
          'Explicit Production confirmation phrase is required',
        );
      }
      if (input.targetConfirmationPrincipalId !== input.principalId) {
        throw new PlatformRecoveryServiceError(
          'target_confirmation_mismatch',
          'Target principal confirmation does not match',
        );
      }
      const dual = await this.#production.verify({
        operationId,
        principalId: input.principalId,
        mode: input.mode,
        reasonCategory: input.reasonCategory,
        environmentBinding: input.environment.environmentBinding,
        approverReferences: input.productionApprovals?.approverReferences ?? [],
        approvalReferences: input.productionApprovals?.approvalReferences ?? [],
      });
      if (dual.ok === false) {
        throw new PlatformRecoveryServiceError(dual.code, dual.message);
      }
    }

    const offline = await this.#offline.verify({
      operationId,
      principalId: input.principalId,
      mode: input.mode,
      reasonCategory: input.reasonCategory,
      environmentBinding: input.environment.environmentBinding,
      presentedSecret: input.offlineSecret,
    });
    if (offline.ok === false) {
      throw new PlatformRecoveryServiceError(offline.code, offline.message);
    }

    if (input.mode === 'mfa-recovery') {
      return this.#executeMfaRecovery({
        principalId: input.principalId,
        reasonCategory: input.reasonCategory,
        environment: input.environment,
        operationId,
        requestId,
        now,
        offlineReference: offline.verifierReference,
      });
    }

    return this.#executeBreakGlass({
      principalId: input.principalId,
      reasonCategory: input.reasonCategory,
      environment: input.environment,
      operationId,
      requestId,
      now,
      offlineReference: offline.verifierReference,
    });
  }

  async #executeMfaRecovery(input: {
    principalId: string;
    reasonCategory: PlatformRecoveryReasonCategory;
    environment: ResolvedPlatformRecoveryEnvironment;
    operationId: string;
    requestId: string;
    now: Date;
    offlineReference: string;
  }): Promise<PlatformRecoveryExecuteResult> {
    const purpose = 'mfa_recovery' as const;
    const ttlSeconds = resolveRecoveryTtlSeconds(purpose);
    const expiresAt = new Date(input.now.getTime() + ttlSeconds * 1000);
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'platform_principal',
        purpose,
        environmentBinding: input.environment.environmentBinding,
      },
      this.#crypto,
    );

    const result = await this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey({
          principalDomain: 'platform_principal',
          principalId: input.principalId,
          purpose,
        })}))
      `;

      const principal = await lockPrincipal(tx, input.principalId);
      if (!principal || principal.status !== 'active') {
        throw new PlatformRecoveryServiceError(
          'principal_ineligible',
          'Target Platform principal is not eligible',
        );
      }
      const previousPassword = principal.password;
      const previousCredentialVersion = principal.credentialVersion;

      const mfa = await lockMfa(tx, input.principalId);

      const casOk = await this.#targets.compareAndIncrementCredentialVersion(
        tx,
        {
          principalDomain: 'platform_principal',
          principalId: principal.id,
          companyId: null,
          credentialVersion: previousCredentialVersion,
          status: principal.status,
        },
        previousCredentialVersion,
      );
      if (!casOk) {
        throw new PlatformRecoveryServiceError(
          'credential_version_conflict',
          'Concurrent credential change blocked this recovery',
        );
      }
      const nextCredentialVersion = previousCredentialVersion + 1;

      const revoked = await tx.platformRefreshToken.updateMany({
        where: { principalId: principal.id, revokedAt: null },
        data: {
          revokedAt: input.now,
          revokedReason: 'platform_mfa_recovery',
        },
      });

      await this.#clearPlatformMfa(tx, principal.id, mfa);

      // Preserve password exactly.
      const passwordCheck = await tx.platformPrincipal.findUnique({
        where: { id: principal.id },
        select: { password: true, authorizationVersion: true, permissions: true, status: true },
      });
      if (
        !passwordCheck
        || passwordCheck.password !== previousPassword
        || passwordCheck.authorizationVersion !== principal.authorizationVersion
        || passwordCheck.permissions !== principal.permissions
        || passwordCheck.status !== 'active'
      ) {
        throw new PlatformRecoveryServiceError(
          'password_preservation_failed',
          'MFA recovery must preserve password and authorization state',
        );
      }

      await this.#invalidatePeerRecoveryRequests(tx, {
        principalId: principal.id,
        now: input.now,
        excludePurpose: null,
      });

      const recoveryRequestId = randomUUID();
      await tx.credentialRecoveryRequest.create({
        data: {
          id: recoveryRequestId,
          principalDomain: 'platform_principal',
          principalId: principal.id,
          companyId: null,
          purpose,
          tokenHash: minted.tokenHash,
          tokenHashAlgorithm: minted.tokenHashAlgorithm,
          environmentBinding: input.environment.environmentBinding,
          createdAt: input.now,
          expiresAt,
          consumedAt: input.now,
          invalidatedAt: input.now,
          invalidationReason: 'consumed' satisfies RecoveryInvalidationReason,
          credentialVersionAtIssuance: previousCredentialVersion,
          initiatedBy: 'platform_operator',
          initiatorPrincipalId: null,
          deliveryChannel: 'none',
          deliveryStatus: 'pending',
        },
      });

      await writeRecoveryAuditRequired(tx as unknown as PrismaClient, {
        eventType: 'recovery_request_consumed',
        actorType: 'support',
        actorId: null,
        subjectId: principal.id,
        subjectDomain: 'platform_principal',
        companyId: null,
        result: 'success',
        reasonCode: 'consumed',
        recoveryRequestId,
        requestId: input.requestId,
      });

      await writePlatformAudit(tx as unknown as PrismaClient, {
        principalId: principal.id,
        action: 'platform.auth.mfa_recovery.completed',
        details: {
          operationId: input.operationId,
          mode: 'mfa-recovery',
          principalId: principal.id,
          reasonCategory: input.reasonCategory,
          environmentClass: input.environment.resolvedClass,
          fingerprintReference: input.environment.fingerprintReference,
          dryRun: false,
          previousCredentialVersion,
          credentialVersion: nextCredentialVersion,
          sessionsRevokedCount: revoked.count,
          mfaInvalidated: true,
          recoveryPackageIssued: false,
          offlineVerifierReference: input.offlineReference,
          recoveryRequestId,
          requestId: input.requestId,
          status: 'success',
        },
      });

      return {
        mode: 'mfa-recovery' as const,
        operationId: input.operationId,
        principalId: principal.id,
        previousCredentialVersion,
        credentialVersion: nextCredentialVersion,
        sessionsRevokedCount: revoked.count,
        mfaInvalidated: true,
        recoveryPackageIssued: false,
        recoveryRequestId,
        recoveryPackage: null,
      };
    });

    // Discard minted raw token — never emit for MFA-only.
    void (minted.rawToken as CredentialRecoverySecret);
    return result;
  }

  async #executeBreakGlass(input: {
    principalId: string;
    reasonCategory: PlatformRecoveryReasonCategory;
    environment: ResolvedPlatformRecoveryEnvironment;
    operationId: string;
    requestId: string;
    now: Date;
    offlineReference: string;
  }): Promise<PlatformRecoveryExecuteResult> {
    const purpose = 'break_glass_recovery' as const;
    const ttlSeconds = resolveRecoveryTtlSeconds(purpose);
    const expiresAt = new Date(input.now.getTime() + ttlSeconds * 1000);
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'platform_principal',
        purpose,
        environmentBinding: input.environment.environmentBinding,
      },
      this.#crypto,
    );
    const unusablePasswordHash = await hashPassword(randomUUID() + randomUUID());

    const result = await this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey({
          principalDomain: 'platform_principal',
          principalId: input.principalId,
          purpose,
        })}))
      `;

      const principal = await lockPrincipal(tx, input.principalId);
      if (!principal || principal.status !== 'active') {
        throw new PlatformRecoveryServiceError(
          'principal_ineligible',
          'Target Platform principal is not eligible',
        );
      }
      const previousCredentialVersion = principal.credentialVersion;
      const mfa = await lockMfa(tx, input.principalId);

      const casOk = await this.#targets.compareAndIncrementCredentialVersion(
        tx,
        {
          principalDomain: 'platform_principal',
          principalId: principal.id,
          companyId: null,
          credentialVersion: previousCredentialVersion,
          status: principal.status,
        },
        previousCredentialVersion,
      );
      if (!casOk) {
        throw new PlatformRecoveryServiceError(
          'credential_version_conflict',
          'Concurrent credential change blocked this recovery',
        );
      }
      const nextCredentialVersion = previousCredentialVersion + 1;

      const passwordUpdated = await tx.platformPrincipal.updateMany({
        where: {
          id: principal.id,
          status: 'active',
          credentialVersion: nextCredentialVersion,
        },
        data: { password: unusablePasswordHash },
      });
      if (passwordUpdated.count !== 1) {
        throw new PlatformRecoveryServiceError(
          'password_invalidation_failed',
          'Failed to invalidate Platform password during break-glass',
        );
      }

      const revoked = await tx.platformRefreshToken.updateMany({
        where: { principalId: principal.id, revokedAt: null },
        data: {
          revokedAt: input.now,
          revokedReason: 'platform_break_glass',
        },
      });

      await this.#clearPlatformMfa(tx, principal.id, mfa);

      // Supersede prior live break-glass packages first (exact supersession chain).
      const priorLive = await tx.credentialRecoveryRequest.findMany({
        where: {
          principalDomain: 'platform_principal',
          principalId: principal.id,
          companyId: null,
          purpose,
          consumedAt: null,
          invalidatedAt: null,
        },
        select: { id: true },
      });
      const recoveryRequestId = randomUUID();
      const priorIds = priorLive.map((row) => row.id);
      if (priorIds.length > 0) {
        await tx.credentialRecoveryRequest.updateMany({
          where: { id: { in: priorIds } },
          data: {
            invalidatedAt: input.now,
            invalidationReason: 'superseded',
          },
        });
      }

      // Invalidate other outstanding Platform recovery challenges (password reset, MFA, etc.).
      await this.#invalidatePeerRecoveryRequests(tx, {
        principalId: principal.id,
        now: input.now,
        excludePurpose: purpose,
      });

      await tx.credentialRecoveryRequest.create({
        data: {
          id: recoveryRequestId,
          principalDomain: 'platform_principal',
          principalId: principal.id,
          companyId: null,
          purpose,
          tokenHash: minted.tokenHash,
          tokenHashAlgorithm: minted.tokenHashAlgorithm,
          environmentBinding: input.environment.environmentBinding,
          createdAt: input.now,
          expiresAt,
          credentialVersionAtIssuance: nextCredentialVersion,
          initiatedBy: 'platform_operator',
          initiatorPrincipalId: null,
          deliveryChannel: 'none',
          deliveryStatus: 'pending',
        },
      });

      if (priorIds.length > 0) {
        await tx.credentialRecoveryRequest.updateMany({
          where: { id: { in: priorIds } },
          data: { supersededByRequestId: recoveryRequestId },
        });
      }

      await writeRecoveryAuditRequired(tx as unknown as PrismaClient, {
        eventType: 'recovery_request_issued',
        actorType: 'support',
        actorId: null,
        subjectId: principal.id,
        subjectDomain: 'platform_principal',
        companyId: null,
        result: 'success',
        reasonCode: 'issued',
        recoveryRequestId,
        requestId: input.requestId,
      });

      await writePlatformAudit(tx as unknown as PrismaClient, {
        principalId: principal.id,
        action: 'platform.auth.break_glass.executed',
        details: {
          operationId: input.operationId,
          mode: 'full-break-glass',
          principalId: principal.id,
          reasonCategory: input.reasonCategory,
          environmentClass: input.environment.resolvedClass,
          fingerprintReference: input.environment.fingerprintReference,
          dryRun: false,
          previousCredentialVersion,
          credentialVersion: nextCredentialVersion,
          sessionsRevokedCount: revoked.count,
          mfaInvalidated: true,
          recoveryPackageIssued: true,
          offlineVerifierReference: input.offlineReference,
          recoveryRequestId,
          requestId: input.requestId,
          status: 'success',
        },
      });

      return {
        mode: 'full-break-glass' as const,
        operationId: input.operationId,
        principalId: principal.id,
        previousCredentialVersion,
        credentialVersion: nextCredentialVersion,
        sessionsRevokedCount: revoked.count,
        mfaInvalidated: true,
        recoveryPackageIssued: true,
        recoveryRequestId,
        recoveryPackage: new RecoveryPackageSecret(minted.rawToken.reveal()),
      };
    });

    return result;
  }

  async #clearPlatformMfa(
    tx: TxClient,
    principalId: string,
    existing: Awaited<ReturnType<typeof lockMfa>>,
  ): Promise<void> {
    if (!existing) {
      await tx.platformMfaCredential.create({
        data: {
          principalId,
          state: 'pending',
          secretCiphertext: null,
          pendingSecretCiphertext: null,
          challengeTokenHash: null,
          challengePurpose: null,
          challengeExpiresAt: null,
          challengeAttempts: 0,
          failedAttempts: 0,
          lockedUntil: null,
          backupCodeHashes: '[]',
          enrolledAt: null,
          lastVerifiedAt: null,
          lastUsedTimeStep: null,
        },
      });
      return;
    }
    await tx.platformMfaCredential.update({
      where: { principalId },
      data: {
        state: 'pending',
        secretCiphertext: null,
        pendingSecretCiphertext: null,
        challengeTokenHash: null,
        challengePurpose: null,
        challengeExpiresAt: null,
        challengeAttempts: 0,
        failedAttempts: 0,
        lockedUntil: null,
        backupCodeHashes: '[]',
        enrolledAt: null,
        lastVerifiedAt: null,
        lastUsedTimeStep: null,
      },
    });
  }

  async #invalidatePeerRecoveryRequests(
    tx: TxClient,
    input: {
      principalId: string;
      now: Date;
      excludePurpose: string | null;
    },
  ): Promise<void> {
    await tx.credentialRecoveryRequest.updateMany({
      where: {
        principalDomain: 'platform_principal',
        principalId: input.principalId,
        companyId: null,
        consumedAt: null,
        invalidatedAt: null,
        ...(input.excludePurpose ? { purpose: { not: input.excludePurpose } } : {}),
      },
      data: {
        invalidatedAt: input.now,
        invalidationReason: 'security_event',
      },
    });
  }
}

/**
 * Emit package after successful commit. Failures do not roll back the DB.
 * Operator must run a new break-glass to supersede if output was lost.
 */
export async function emitBreakGlassPackageAfterCommit(
  emitter: RecoveryPackageEmitter,
  result: PlatformRecoveryExecuteResult,
): Promise<void> {
  if (!result.recoveryPackage) return;
  await emitter.emit(result.recoveryPackage);
}
