/**
 * Provider-neutral offline authorization and Production dual-control interfaces.
 * Default Production verifier is unavailable — never fake dual control.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const PLATFORM_RECOVERY_REASON_CATEGORIES = [
  'lost_mfa_device',
  'suspected_compromise',
  'total_lockout',
  'administrative_security_event',
] as const;
export type PlatformRecoveryReasonCategory =
  (typeof PLATFORM_RECOVERY_REASON_CATEGORIES)[number];

export type PlatformRecoveryMode = 'mfa-recovery' | 'full-break-glass';

export interface OfflineAuthorizationChallenge {
  operationId: string;
  principalId: string;
  mode: PlatformRecoveryMode;
  reasonCategory: PlatformRecoveryReasonCategory;
  environmentBinding: string;
  /** Secret obtained via SecureOfflineAuthorizationReader only. */
  presentedSecret: string;
}

export type OfflineAuthorizationOutcome =
  | { ok: true; verifierReference: string }
  | { ok: false; code: string; message: string };

export interface OfflineAuthorizationVerifier {
  verify(challenge: OfflineAuthorizationChallenge): Promise<OfflineAuthorizationOutcome>;
}

export class UnavailableOfflineAuthorizationVerifier
  implements OfflineAuthorizationVerifier
{
  async verify(_challenge?: OfflineAuthorizationChallenge): Promise<OfflineAuthorizationOutcome> {
    return {
      ok: false,
      code: 'offline_authorization_unavailable',
      message: 'Offline authorization verifier is not configured',
    };
  }
}

/**
 * Non-Production reduced ceremony only: accept a high-entropy TTY secret and
 * retain only a non-invertible reference for audit attribution.
 * Never used for Production construction.
 */
export class NonProductionEntropyOfflineAuthorizationVerifier
  implements OfflineAuthorizationVerifier
{
  async verify(challenge: OfflineAuthorizationChallenge): Promise<OfflineAuthorizationOutcome> {
    const presented = challenge.presentedSecret;
    if (presented.length < 32) {
      return {
        ok: false,
        code: 'offline_authorization_rejected',
        message: 'Offline authorization rejected',
      };
    }
    const digest = createHash('sha256')
      .update(`e5-offline-ref\0${challenge.operationId}\0${presented}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return { ok: true, verifierReference: `offline-entropy:${digest}` };
  }
}

export interface ProductionApprovalEvidence {
  operationId: string;
  principalId: string;
  mode: PlatformRecoveryMode;
  reasonCategory: PlatformRecoveryReasonCategory;
  environmentBinding: string;
  /** Sanitized approver identity references only — never secrets. */
  approverReferences: string[];
  /** Sanitized approval reference / ceremony id — never shares or signatures. */
  approvalReferences: string[];
}

export type ProductionDualControlOutcome =
  | {
    ok: true;
    ceremonyReference: string;
    approverReferences: string[];
    approvalReferences: string[];
  }
  | { ok: false; code: string; message: string };

export interface ProductionDualControlVerifier {
  readonly isConfigured: boolean;
  verify(evidence: ProductionApprovalEvidence): Promise<ProductionDualControlOutcome>;
}

export class UnavailableProductionDualControlVerifier
  implements ProductionDualControlVerifier
{
  readonly isConfigured = false;

  async verify(_evidence?: ProductionApprovalEvidence): Promise<ProductionDualControlOutcome> {
    return {
      ok: false,
      code: 'production_dual_control_unavailable',
      message: 'Production dual/threshold approval provider is not configured',
    };
  }
}

/**
 * Non-Production offline verifier comparing against an injected expected secret.
 * Construction with a secret is for tests / local ceremony only — never from argv/env
 * in Production composition.
 */
export class ExpectedSecretOfflineAuthorizationVerifier
  implements OfflineAuthorizationVerifier
{
  readonly #expected: string;
  readonly #reference: string;

  constructor(expectedSecret: string, reference = 'offline-auth:local') {
    if (!expectedSecret) {
      throw new Error('ExpectedSecretOfflineAuthorizationVerifier requires a non-empty secret');
    }
    this.#expected = expectedSecret;
    this.#reference = reference;
  }

  async verify(challenge: OfflineAuthorizationChallenge): Promise<OfflineAuthorizationOutcome> {
    const presented = challenge.presentedSecret;
    const expected = this.#expected;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, code: 'offline_authorization_rejected', message: 'Offline authorization rejected' };
    }
    return { ok: true, verifierReference: this.#reference };
  }
}

export interface TestDualApprovalRecord {
  operationId: string;
  principalId: string;
  mode: PlatformRecoveryMode;
  reasonCategory: PlatformRecoveryReasonCategory;
  environmentBinding: string;
  approverReference: string;
  approvalReference: string;
  expiresAt: Date;
  consumed?: boolean;
}

/**
 * Test-only dual-control verifier. Must never be wired into Production construction.
 */
export class TestOnlyProductionDualControlVerifier
  implements ProductionDualControlVerifier
{
  readonly isConfigured = true;
  readonly #approvals: TestDualApprovalRecord[];
  readonly #consumed = new Set<string>();

  constructor(approvals: TestDualApprovalRecord[]) {
    this.#approvals = approvals;
  }

  async verify(evidence: ProductionApprovalEvidence): Promise<ProductionDualControlOutcome> {
    if (evidence.approverReferences.length < 2) {
      return { ok: false, code: 'insufficient_approvers', message: 'At least two distinct approvers are required' };
    }
    const uniqueApprovers = new Set(evidence.approverReferences);
    if (uniqueApprovers.size !== evidence.approverReferences.length) {
      return { ok: false, code: 'duplicate_approver', message: 'Duplicate approver identity rejected' };
    }
    if (uniqueApprovers.has(evidence.principalId)) {
      return { ok: false, code: 'target_self_approval', message: 'Target principal cannot approve their own recovery' };
    }
    if (evidence.approvalReferences.length < 2) {
      return { ok: false, code: 'insufficient_approvals', message: 'At least two approval references are required' };
    }
    if (new Set(evidence.approvalReferences).size !== evidence.approvalReferences.length) {
      return { ok: false, code: 'duplicate_approval', message: 'Duplicate approval reference rejected' };
    }

    const matched: TestDualApprovalRecord[] = [];
    for (let i = 0; i < evidence.approverReferences.length; i += 1) {
      const approver = evidence.approverReferences[i]!;
      const approvalRef = evidence.approvalReferences[i]!;
      const row = this.#approvals.find((item) =>
        item.approverReference === approver
        && item.approvalReference === approvalRef
        && item.operationId === evidence.operationId
        && item.principalId === evidence.principalId
        && item.mode === evidence.mode
        && item.reasonCategory === evidence.reasonCategory
        && item.environmentBinding === evidence.environmentBinding,
      );
      if (!row) {
        return { ok: false, code: 'approval_binding_mismatch', message: 'Approval binding rejected' };
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return { ok: false, code: 'approval_expired', message: 'Approval expired' };
      }
      if (row.consumed || this.#consumed.has(approvalRef)) {
        return { ok: false, code: 'approval_reused', message: 'Approval already consumed' };
      }
      matched.push(row);
    }

    if (matched.length < 2) {
      return { ok: false, code: 'insufficient_approvers', message: 'At least two distinct approvers are required' };
    }

    for (const row of matched) {
      row.consumed = true;
      this.#consumed.add(row.approvalReference);
    }

    return {
      ok: true,
      ceremonyReference: `test-dual:${evidence.operationId}`,
      approverReferences: evidence.approverReferences,
      approvalReferences: evidence.approvalReferences,
    };
  }
}

/**
 * Production composition guard: refuses test-only verifier classes.
 */
export function assertProductionSafeDualControlVerifier(
  verifier: ProductionDualControlVerifier,
): void {
  if (verifier instanceof TestOnlyProductionDualControlVerifier) {
    throw new Error('Test-only dual-control verifier cannot be used in Production construction');
  }
  if (verifier.constructor?.name === 'TestOnlyProductionDualControlVerifier') {
    throw new Error('Test-only dual-control verifier cannot be used in Production construction');
  }
}

export function isPlatformRecoveryReasonCategory(
  value: unknown,
): value is PlatformRecoveryReasonCategory {
  return typeof value === 'string'
    && (PLATFORM_RECOVERY_REASON_CATEGORIES as readonly string[]).includes(value);
}
