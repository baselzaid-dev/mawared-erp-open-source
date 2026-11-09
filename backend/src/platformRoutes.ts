import crypto from 'node:crypto';
import type express from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  generateTemporaryPassword,
  hashPassword,
  temporaryPasswordExpiresAt,
} from './credentialSecrets';
import {
  normalizeCompanyCode,
  normalizeEmail,
  normalizeLoginIdentifier,
} from './identity';
import {
  PLATFORM_PERMISSIONS,
  type PlatformPrincipalContext,
  type PlatformRequest,
  writePlatformAudit,
} from './platformAuth';

interface PlatformRoutesDeps {
  app: express.Express;
  prisma: PrismaClient;
  requirePlatformAuth: express.RequestHandler;
  provisionLimiter: express.RequestHandler;
}

class PlatformRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new PlatformRouteError(status, code, messageKey);
};

const provisionSchema = z.object({
  name: z.string().trim().min(2).max(200),
  companyCode: z.string().trim().min(3).max(32),
  primaryOwner: z.object({
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(2).max(200),
  }).strict(),
}).strict();

const idempotencySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const actor = (req: express.Request): PlatformPrincipalContext => {
  const principal = (req as PlatformRequest).platformPrincipal;
  if (!principal) fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
  return principal;
};

const requireCapability = (
  principal: PlatformPrincipalContext,
  permission: string,
): void => {
  if (!principal.permissions.includes(permission)) {
    fail(403, 'PlatformForbidden', 'platform.forbidden');
  }
};

const requestDigest = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const companyShape = (company: any, owner?: any) => ({
  id: company.id,
  code: company.code,
  name: company.name,
  createdAt: company.createdAt?.toISOString?.() ?? company.createdAt,
  primaryOwner: owner
    ? {
      userId: owner.userId ?? owner.user?.id,
      email: owner.user?.email ?? null,
      name: owner.user?.name ?? null,
    }
    : null,
});

const loadProvisionReplay = async (
  prisma: PrismaClient,
  principalId: string,
  key: string,
  digest: string,
) => {
  const existingKey = await prisma.platformIdempotencyKey.findUnique({
    where: { principalId_key: { principalId, key } },
  });
  if (!existingKey) return null;
  if (existingKey.requestHash !== digest) {
    fail(409, 'IdempotencyConflict', 'platform.idempotency_conflict');
  }
  const company = existingKey.companyId
    ? await prisma.company.findUnique({
      where: { id: existingKey.companyId },
      select: { id: true, code: true, name: true, createdAt: true },
    })
    : null;
  if (!company) fail(409, 'IdempotencyIncomplete', 'platform.idempotency_incomplete');
  const owner = await prisma.companyOwnership.findFirst({
    where: {
      companyId: company.id,
      isPrimary: true,
      status: 'active',
      endedAt: null,
    },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  return {
    company: companyShape(company, owner),
    credentialDelivery: null,
    credentialAlreadyDelivered: true,
  };
};

export function registerPlatformRoutes({
  app,
  prisma,
  requirePlatformAuth,
  provisionLimiter,
}: PlatformRoutesDeps): void {
  const route = (
    handler: (req: express.Request, res: express.Response) => Promise<unknown>,
  ): express.RequestHandler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof PlatformRouteError) {
        return res.status(error.status).json({
          code: error.code,
          messageKey: error.messageKey,
        });
      }
      if ((error as { code?: string }).code === 'P2002') {
        return res.status(409).json({
          code: 'PlatformConflict',
          messageKey: 'platform.conflict',
        });
      }
      return res.status(500).json({
        code: 'PlatformOperationFailed',
        messageKey: 'platform.operation_failed',
      });
    }
  };

  app.get('/api/platform/v1/companies', requirePlatformAuth, route(async (req, res) => {
    const principal = actor(req);
    requireCapability(principal, PLATFORM_PERMISSIONS.COMPANIES_VIEW);
    const companies = await prisma.company.findMany({
      select: { id: true, code: true, name: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 100,
    });
    return res.json({ items: companies.map((company) => companyShape(company)) });
  }));

  app.get('/api/platform/v1/companies/:id', requirePlatformAuth, route(async (req, res) => {
    const principal = actor(req);
    requireCapability(principal, PLATFORM_PERMISSIONS.COMPANIES_VIEW);
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      select: { id: true, code: true, name: true, createdAt: true },
    });
    if (!company) fail(404, 'PlatformCompanyNotFound', 'platform.company_not_found');
    const owner = await prisma.companyOwnership.findFirst({
      where: {
        companyId: company.id,
        isPrimary: true,
        status: 'active',
        endedAt: null,
      },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return res.json(companyShape(company, owner));
  }));

  app.post(
    '/api/platform/v1/companies',
    requirePlatformAuth,
    provisionLimiter,
    route(async (req, res) => {
    const principal = actor(req);
    requireCapability(principal, PLATFORM_PERMISSIONS.COMPANIES_PROVISION);
    const parsed = provisionSchema.safeParse(req.body);
    if (!parsed.success) fail(400, 'InvalidRequest', 'platform.invalid_request');
    const key = idempotencySchema.safeParse(req.header('Idempotency-Key'));
    if (!key.success) {
      fail(400, 'IdempotencyKeyRequired', 'platform.idempotency_key_required');
    }

    let companyCode: string;
    try {
      companyCode = normalizeCompanyCode(parsed.data.companyCode);
    } catch {
      fail(400, 'InvalidCompanyCode', 'platform.company_code_invalid');
    }
    const normalizedOwnerEmail = normalizeEmail(parsed.data.primaryOwner.email);
    const canonicalRequest = {
      name: parsed.data.name,
      companyCode,
      primaryOwner: {
        email: normalizedOwnerEmail,
        name: parsed.data.primaryOwner.name,
      },
    };
    const digest = requestDigest(canonicalRequest);
    const existingReplay = await loadProvisionReplay(
      prisma,
      principal.id,
      key.data,
      digest,
    );
    if (existingReplay) return res.json(existingReplay);

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword.reveal());
    const expiresAt = temporaryPasswordExpiresAt();
    let result: { company: any; ownerUser: any };
    try {
      result = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { code: companyCode, name: parsed.data.name },
      });
      const role = await tx.role.create({
        data: {
          companyId: company.id,
          name: 'Primary Owner',
          permissions: '[]',
        },
      });
      const ownerUser = await tx.user.create({
        data: {
          companyId: company.id,
          employeeId: null,
          email: parsed.data.primaryOwner.email,
          normalizedEmail: normalizedOwnerEmail,
          password: passwordHash,
          name: parsed.data.primaryOwner.name,
          roleId: role.id,
          accountStatus: 'active',
          mustChangePassword: true,
          temporaryPasswordExpiresAt: expiresAt,
          credentialVersion: 1,
        },
      });
      await tx.loginIdentity.create({
        data: {
          companyId: company.id,
          userId: ownerUser.id,
          type: 'email',
          normalizedIdentifier: normalizeLoginIdentifier(parsed.data.primaryOwner.email),
        },
      });
      await tx.companyOwnership.create({
        data: {
          companyId: company.id,
          userId: ownerUser.id,
          isPrimary: true,
          status: 'active',
          effectiveAt: new Date(),
          createdByUserId: null,
          createdByPlatformPrincipalId: principal.id,
        },
      });
      await tx.attendanceExemption.create({
        data: {
          companyId: company.id,
          userId: ownerUser.id,
          employeeId: null,
          validFrom: new Date(),
          validUntil: null,
          reasonCategory: 'account_only_primary_owner',
          note: null,
          status: 'active',
          createdByUserId: null,
          createdByPlatformPrincipalId: principal.id,
        },
      });
      await writePlatformAudit(tx as PrismaClient, {
        principalId: principal.id,
        action: 'platform.company.provision',
        targetCompanyId: company.id,
        details: { companyId: company.id, primaryOwnerUserId: ownerUser.id },
      });
      await tx.platformIdempotencyKey.create({
        data: {
          principalId: principal.id,
          key: key.data,
          requestHash: digest,
          companyId: company.id,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        return { company, ownerUser };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const replay = await loadProvisionReplay(
          prisma,
          principal.id,
          key.data,
          digest,
        );
        if (replay) return res.json(replay);
      }
      throw error;
    }

    return res.status(201).json({
      company: companyShape(result.company, {
        userId: result.ownerUser.id,
        user: result.ownerUser,
      }),
      credentialDelivery: {
        temporaryPassword: temporaryPassword.reveal(),
        mustChangePassword: true,
        expiresAt: expiresAt.toISOString(),
      },
      credentialAlreadyDelivered: false,
    });
    }),
  );
}
