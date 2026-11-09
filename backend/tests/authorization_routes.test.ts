import bcrypt from 'bcrypt';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import { PERMISSIONS } from '../src/permissions';
import { encryptMfaSecret } from '../src/mfa';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const MFA_KEY = Buffer.alloc(32, 13).toString('base64');
const MFA_SECRET = new OTPAuth.Secret({ size: 20 }).base32;
const totpCode = () => new OTPAuth.TOTP({
  issuer: 'Mawared',
  label: 'owner',
  secret: OTPAuth.Secret.fromBase32(MFA_SECRET),
}).generate();
const invalidTotpCode = () => totpCode() === '000000' ? '000001' : '000000';

function makeAuthorizationPrisma(passwordHash: string) {
  let currentOwnerUserId = 'u-owner';
  let pendingOwnerUserId: string | null = null;
  const versions: Record<string, number> = { 'u-owner': 5, 'u-target': 2, 'u-peer': 1 };
  const users: Record<string, any> = {
    'u-owner': {
      id: 'u-owner',
      companyId: 'c1',
      employeeId: 'e-owner',
      name: 'Owner',
      password: passwordHash,
      role: { permissions: JSON.stringify([PERMISSIONS.ADMIN_FULL]) },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-target': {
      id: 'u-target',
      companyId: 'c1',
      employeeId: 'e-target',
      name: 'Target User',
      password: passwordHash,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-peer': {
      id: 'u-peer',
      companyId: 'c1',
      employeeId: 'e-peer',
      name: 'Peer Manager',
      password: passwordHash,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'active' },
    },
  };
  const prisma = makeFakePrisma();
  prisma._store.userMfaCredentials.push({
    userId: 'u-owner',
    companyId: 'c1',
    state: 'enrolled',
    secretCiphertext: encryptMfaSecret(MFA_SECRET, MFA_KEY),
    pendingSecretCiphertext: null,
    challengeTokenHash: null,
    challengePurpose: null,
    challengeExpiresAt: null,
    challengeAttempts: 0,
    backupCodeHashes: '[]',
    enrolledAt: new Date(),
    lastVerifiedAt: null,
    lastUsedTimeStep: null,
  });
  prisma.user.findFirst = vi.fn(async ({ where }: any) => {
    const user = users[where.id];
    return user ? { ...user, authorizationVersion: versions[user.id] } : null;
  });
  prisma.user.findMany = vi.fn(async () => Object.values(users).map((user) => ({
    ...user,
    authorizationVersion: versions[user.id],
  })));
  prisma.user.updateMany = vi.fn(async ({ where }: any) => {
    for (const id of where.id.in) versions[id] += 1;
    return { count: where.id.in.length };
  });
  prisma.user.update = vi.fn(async ({ where, data }: any) => {
    if (data.authorizationVersion?.increment) versions[where.id] += data.authorizationVersion.increment;
    return { ...users[where.id], authorizationVersion: versions[where.id] };
  });
  prisma.department.findMany = vi.fn(async ({ where }: any) =>
    where.managerId === 'u-peer' ? [{ id: 'd1' }] : []);
  prisma.department.findFirst = vi.fn(async ({ where }: any) =>
    where.companyId === 'c1' && where.id === 'd1' ? { id: 'd1' } : null);
  prisma.departmentManager.findMany = vi.fn(async ({ where }: any) =>
    where.userId === 'u-peer' ? [{ departmentId: 'd1' }] : []);
  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any) => {
    const requestedUserId = where.userId;
    if (requestedUserId && requestedUserId !== currentOwnerUserId) return null;
    return { id: `ownership-${currentOwnerUserId}`, userId: currentOwnerUserId };
  });
  prisma.companyOwnership.findMany = vi.fn(async () => [{
    id: `ownership-${currentOwnerUserId}`,
    companyId: 'c1',
    userId: currentOwnerUserId,
    isPrimary: true,
    status: 'active',
  }]);
  prisma.companyOwnership.updateMany = vi.fn(async ({ where }: any) => {
    if (where.id !== `ownership-${currentOwnerUserId}`) return { count: 0 };
    if (pendingOwnerUserId) {
      currentOwnerUserId = pendingOwnerUserId;
      pendingOwnerUserId = null;
    }
    return { count: 1 };
  });
  prisma.companyOwnership.create = vi.fn(async ({ data }: any) => {
    pendingOwnerUserId = data.userId;
    return { id: `ownership-${data.userId}`, ...data };
  });
  prisma.ownershipTransfer.create = vi.fn(async ({ data }: any) => ({ id: 'transfer-1', ...data }));
  prisma.accessGrant.findMany = vi.fn().mockResolvedValue([]);
  prisma.temporaryDelegation.findMany = vi.fn().mockResolvedValue([]);

  let rawCall = 0;
  prisma.$queryRaw = vi.fn(async () => {
    rawCall += 1;
    if (rawCall === 1) return [];
    return [
      { id: 'u-owner', authorizationVersion: versions['u-owner'], employeeActive: true },
      { id: 'u-target', authorizationVersion: versions['u-target'], employeeActive: true },
    ];
  });

  return {
    prisma,
    get currentOwnerUserId() { return currentOwnerUserId; },
    versions,
  };
}

describe('Sprint 12C authorization APIs', () => {
  let passwordHash = '';

  beforeEach(async () => {
    passwordHash = await bcrypt.hash('Owner-password-1', 4);
  });

  it('returns a dry-run preview and rejects a stale apply without partial grants', async () => {
    const fixture = makeAuthorizationPrisma(passwordHash);
    const app = makeApp(fixture.prisma, { mfaEncryptionKey: MFA_KEY });
    const auth = `Bearer ${tokenFor({
      id: 'u-owner',
      companyId: 'c1',
      employeeId: 'e-owner',
      permissions: [PERMISSIONS.ADMIN_FULL],
    })}`;

    const preview = await request(app)
      .post('/api/v2/company/permissions/preview')
      .set('Authorization', auth)
      .send({
        targetUserId: 'u-target',
        expectedAuthorizationVersion: 2,
        reason: 'تجهيز صلاحية مراجعة محددة',
        operations: [{
          action: 'grant',
          capability: PERMISSIONS.TASKS_REVIEW,
          scopeType: 'company',
          departmentId: null,
        }],
      });
    expect(preview.status).toBe(200);
    expect(preview.body.previewId).toEqual(expect.any(String));
    expect(preview.body.changes).toHaveLength(1);
    expect(fixture.prisma.accessGrant.create).not.toHaveBeenCalled();

    fixture.prisma.$queryRaw = vi.fn().mockResolvedValue([{ authorizationVersion: 3 }]);
    const apply = await request(app)
      .post('/api/v2/company/permissions/apply')
      .set('Authorization', auth)
      .set('Idempotency-Key', ['permission', 'version', 'test'].join('-'))
      .send({ previewId: preview.body.previewId });
    expect(apply.status).toBe(412);
    expect(apply.body.messageKey).toBe('authorization.stale_version');
    expect(fixture.prisma.accessGrant.create).not.toHaveBeenCalled();
    expect(fixture.prisma.permissionChangeHistory.create).not.toHaveBeenCalled();
  });

  it('requires owner password re-authentication before issuing a transfer preview', async () => {
    const fixture = makeAuthorizationPrisma(passwordHash);
    const app = makeApp(fixture.prisma, { mfaEncryptionKey: MFA_KEY });
    const auth = `Bearer ${tokenFor({
      id: 'u-owner', companyId: 'c1', employeeId: 'e-owner', permissions: [PERMISSIONS.ADMIN_FULL],
    })}`;

    const denied = await request(app)
      .post('/api/v2/company/ownership/transfers/preview')
      .set('Authorization', auth)
      .send({
        targetUserId: 'u-target',
        reason: 'نقل مسؤولية الشركة',
        password: 'wrong-password',
        totpCode: totpCode(),
      });
    expect(denied.status).toBe(401);

    const mfaDenied = await request(app)
      .post('/api/v2/company/ownership/transfers/preview')
      .set('Authorization', auth)
      .send({
        targetUserId: 'u-target',
        reason: 'نقل مسؤولية الشركة',
        password: 'Owner-password-1',
        totpCode: invalidTotpCode(),
      });
    expect(mfaDenied.status).toBe(401);
    expect(mfaDenied.body.messageKey).toBe('authorization.mfa_verification_failed');

    const allowed = await request(app)
      .post('/api/v2/company/ownership/transfers/preview')
      .set('Authorization', auth)
      .send({
        targetUserId: 'u-target',
        reason: 'نقل مسؤولية الشركة',
        password: 'Owner-password-1',
        totpCode: totpCode(),
      });
    expect(allowed.status).toBe(200);
    expect(allowed.body.confirmationText).toBe('TRANSFER OWNERSHIP');
    expect(JSON.stringify(allowed.body)).not.toMatch(/password|hash|salary|token/i);
  });

  it('allows one atomic ownership transfer and rejects reuse after ownership changed', async () => {
    const fixture = makeAuthorizationPrisma(passwordHash);
    const app = makeApp(fixture.prisma, { mfaEncryptionKey: MFA_KEY });
    const auth = `Bearer ${tokenFor({
      id: 'u-owner', companyId: 'c1', employeeId: 'e-owner', permissions: [PERMISSIONS.ADMIN_FULL],
    })}`;
    const preview = await request(app)
      .post('/api/v2/company/ownership/transfers/preview')
      .set('Authorization', auth)
      .send({
        targetUserId: 'u-target',
        reason: 'اعتماد المالك الأساسي الجديد',
        password: 'Owner-password-1',
        totpCode: totpCode(),
      });
    expect(preview.status).toBe(200);

    const first = await request(app)
      .post('/api/v2/company/ownership/transfers')
      .set('Authorization', auth)
      .set('Idempotency-Key', 'ownership-transfer-001')
      .send({
        previewId: preview.body.previewId,
        confirmationText: 'TRANSFER OWNERSHIP',
        expectedVersion: 5,
      });
    expect(first.status).toBe(200);
    expect(first.body.owner.userId).toBe('u-target');
    expect(first.body.sessionsRevoked).toBe(true);
    expect(fixture.currentOwnerUserId).toBe('u-target');

    const second = await request(app)
      .post('/api/v2/company/ownership/transfers')
      .set('Authorization', auth)
      .set('Idempotency-Key', 'ownership-transfer-002')
      .send({
        previewId: preview.body.previewId,
        confirmationText: 'TRANSFER OWNERSHIP',
        expectedVersion: 5,
      });
    expect(second.status).toBe(409);
    expect(fixture.currentOwnerUserId).toBe('u-target');
  });
});
