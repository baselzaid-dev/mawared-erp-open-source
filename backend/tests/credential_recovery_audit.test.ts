import { describe, expect, it } from 'vitest';
import {
  RecoveryAuditSanitizationError,
  normalizeRecoveryAuditActor,
  sanitizeRecoveryAuditEvent,
} from '../src/credentialRecovery/audit';

const base = {
  eventType: 'recovery_request_issued',
  actorType: 'anonymous',
  subjectDomain: 'platform_principal',
  result: 'success',
  reasonCode: 'issued',
  requestId: 'req_test_001',
};

describe('credential recovery audit sanitation', () => {
  it('accepts allowlisted events', () => {
    const sanitized = sanitizeRecoveryAuditEvent({
      ...base,
      subjectId: 'prin_1',
      sourceBucketHash: 'abc123',
    });
    expect(sanitized.eventType).toBe('recovery_request_issued');
    expect(sanitized.referenceId).toMatch(/^ref_evt_/);
  });

  it('rejects unknown fields', () => {
    expect(() => sanitizeRecoveryAuditEvent({ ...base, extraField: 'x' })).toThrow(
      RecoveryAuditSanitizationError,
    );
  });

  const forbidden = [
    ['password', 'Secret123!'],
    ['temporaryPassword', 'Temp123!'],
    ['newPassword', 'New123!'],
    ['token', 'raw-token'],
    ['tokenHash', 'deadbeef'],
    ['resetToken', 'reset'],
    ['mfaSecret', 'JBSWY3DPEHPK3PXP'],
    ['backupCode', 'ABCD-EFGH'],
    ['Authorization', 'Bearer abc'],
    ['Cookie', 'session=1'],
    ['recoveryUrl', 'https://example.test/reset?token=abc'],
    ['providerRawResponse', '{"id":"msg"}'],
    ['identityNotes', 'caller verified by passport'],
  ] as const;

  for (const [key, value] of forbidden) {
    it(`rejects forbidden field ${key}`, () => {
      expect(() => sanitizeRecoveryAuditEvent({ ...base, [key]: value })).toThrow(
        RecoveryAuditSanitizationError,
      );
    });
  }

  it('rejects Error and request body dumps', () => {
    expect(() =>
      sanitizeRecoveryAuditEvent({ ...base, stack: new Error('boom') as unknown as string }),
    ).toThrow();
    expect(() =>
      sanitizeRecoveryAuditEvent({
        ...base,
        body: { email: 'a@b.c', password: 'x' } as unknown as string,
      }),
    ).toThrow();
  });

  it('rejects full URL values', () => {
    expect(() =>
      sanitizeRecoveryAuditEvent({
        ...base,
        reasonCode: 'https://evil.example/reset?token=abc',
      }),
    ).toThrow();
  });

  it('rejects recovery token-hash digests smuggled into allowlisted fields', () => {
    expect(() =>
      sanitizeRecoveryAuditEvent({
        ...base,
        sourceBucketHash: 'hmac-sha256-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow(RecoveryAuditSanitizationError);
  });

  it('rejects anonymous actorType with a non-null actorId', () => {
    expect(() =>
      sanitizeRecoveryAuditEvent({
        ...base,
        actorType: 'anonymous',
        actorId: 'actor-1',
      }),
    ).toThrow(RecoveryAuditSanitizationError);
  });

  it('normalizes anonymous actors to a null actorId', () => {
    const actor = normalizeRecoveryAuditActor({
      actorType: 'anonymous',
      actorId: null,
      defaultActorType: 'anonymous',
    });
    expect(actor).toEqual({ actorType: 'anonymous', actorId: null });
  });

  it('fails closed when actorId is supplied without a non-anonymous actorType', () => {
    expect(() =>
      normalizeRecoveryAuditActor({
        actorId: 'actor-1',
        defaultActorType: 'anonymous',
      }),
    ).toThrow(RecoveryAuditSanitizationError);
  });

  it('accepts authenticated actor tuples', () => {
    expect(
      normalizeRecoveryAuditActor({
        actorType: 'platform_owner',
        actorId: 'prin_owner_1',
        defaultActorType: 'anonymous',
      }),
    ).toEqual({ actorType: 'platform_owner', actorId: 'prin_owner_1' });
  });
});
