import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';

/**
 * Sprint 12I (M08) — Vendor archive lifecycle.
 *
 * Vendor.status already supports 'active' | 'inactive' via
 * PATCH /api/vendors/:id/status (purchasing.ts). This module adds the third
 * state, 'archived', as a distinct, reversible-only-by-reactivation state
 * guarded by its own permission (vendors.archive) and optimistic concurrency
 * (lifecycleVersion). Archiving/reactivating never deletes the vendor row,
 * its purchase orders, or any history.
 */

export interface VendorLifecycleUser {
  id: string;
  companyId: string;
  permissions: string[];
}

interface VendorLifecycleRequest extends Request {
  user?: VendorLifecycleUser;
}

export interface VendorLifecycleRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkPermission: (permission: string) => RequestHandler;
}

class VendorLifecycleError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Always throws; typed `never` so callers narrow types the same way `throw` would. */
const fail = (
  status: number,
  errorCode: string,
  message: string,
  details?: Record<string, unknown>,
): never => {
  throw new VendorLifecycleError(status, errorCode, message, details);
};

const reasonSchema = z.string().trim().min(1).max(500);

const archiveBodySchema = z.object({
  reason: reasonSchema,
  expectedVersion: z.number().int().min(1),
  // Accepted for client-side double-confirmation UX; no server-side literal is enforced.
  confirmation: z.string().trim().min(1).max(40).optional(),
}).strict();

const reactivateBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: reasonSchema.optional(),
}).strict();

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail(400, 'VALIDATION_ERROR', 'البيانات المدخلة غير صالحة', result.error.flatten());
  }
  return result.data;
};

const route = (
  handler: (req: VendorLifecycleRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as VendorLifecycleRequest, response);
  } catch (error) {
    if (error instanceof VendorLifecycleError) {
      return response.status(error.status).json({
        error: error.errorCode,
        message: error.message,
        code: error.status,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    return next(error);
  }
};

const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const shapeVendorLifecycle = (vendor: any) => ({
  id: vendor.id,
  companyId: vendor.companyId,
  name: vendor.name,
  contact: vendor.contact ?? null,
  email: vendor.email ?? null,
  taxNumber: vendor.taxNumber ?? null,
  category: vendor.category ?? null,
  status: vendor.status,
  lifecycleVersion: vendor.lifecycleVersion,
  deactivatedAt: timestamp(vendor.deactivatedAt),
  archivedAt: timestamp(vendor.archivedAt),
  archivedByUserId: vendor.archivedByUserId ?? null,
  archiveReason: vendor.archiveReason ?? null,
  createdAt: timestamp(vendor.createdAt),
  updatedAt: timestamp(vendor.updatedAt),
});

/** Locks the row (real Postgres) then loads it; 404s on missing/other-company vendor. */
const loadVendorLocked = async (tx: any, companyId: string, id: string) => {
  await tx.$queryRaw`SELECT "id" FROM "Vendor" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
  const vendor = await tx.vendor.findFirst({ where: { id, companyId } });
  if (!vendor) fail(404, 'VENDOR_NOT_FOUND', 'المورد غير موجود');
  return vendor;
};

const assertNoActiveNameDuplicate = async (tx: any, companyId: string, vendor: any) => {
  const duplicate = await tx.vendor.findFirst({
    where: {
      companyId,
      status: 'active',
      id: { not: vendor.id },
      name: { equals: vendor.name, mode: 'insensitive' },
    },
  });
  if (duplicate) {
    fail(409, 'VENDOR_NAME_DUPLICATE', 'لا يمكن إعادة تفعيل المورد لوجود مورد نشط بالاسم نفسه');
  }
};

export function registerVendorLifecycleRoutes({
  app,
  prisma,
  requireAuth,
  checkPermission,
}: VendorLifecycleRouteDeps): void {
  // Archive: active|inactive -> archived. Rejects (409) if already archived —
  // deterministic, not idempotent, so a stale double-submit surfaces to the caller.
  app.post(
    '/api/v2/vendors/:id/archive',
    requireAuth,
    checkPermission(PERMISSIONS.VENDORS_ARCHIVE),
    route(async (req, res) => {
      const body = parse(archiveBodySchema, req.body);
      const companyId = req.user!.companyId;
      const actorId = req.user!.id;
      const updated = await prisma.$transaction(async (tx) => {
        const vendor = await loadVendorLocked(tx, companyId, req.params.id);
        if (vendor.status === 'archived') {
          fail(409, 'VENDOR_ALREADY_ARCHIVED', 'المورد مؤرشف بالفعل');
        }
        if (vendor.lifecycleVersion !== body.expectedVersion) {
          fail(412, 'VENDOR_VERSION_MISMATCH', 'تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة', {
            currentVersion: vendor.lifecycleVersion,
          });
        }
        const nextVersion = vendor.lifecycleVersion + 1;
        const result = await tx.vendor.update({
          where: { id: vendor.id },
          data: {
            status: 'archived',
            archivedAt: new Date(),
            archivedByUserId: actorId,
            archiveReason: body.reason,
            lifecycleVersion: nextVersion,
          },
        });
        // Audit sanitizer forbids contact/email/tax fields — ids/status/version only.
        await writeAuditRequired(tx as any, {
          companyId,
          userId: actorId,
          action: 'vendor.archive',
          details: { vendorId: vendor.id, status: 'archived', lifecycleVersion: nextVersion },
        });
        return result;
      });
      return res.json(shapeVendorLifecycle(updated));
    }),
  );

  // Reactivate: archived -> active only. Distinct from the inactive<->active
  // toggle in PATCH /api/vendors/:id/status, which never touches archive fields.
  app.post(
    '/api/v2/vendors/:id/reactivate',
    requireAuth,
    checkPermission(PERMISSIONS.VENDORS_ARCHIVE),
    route(async (req, res) => {
      const body = parse(reactivateBodySchema, req.body);
      const companyId = req.user!.companyId;
      const actorId = req.user!.id;
      const updated = await prisma.$transaction(async (tx) => {
        const vendor = await loadVendorLocked(tx, companyId, req.params.id);
        if (vendor.status !== 'archived') {
          fail(409, 'VENDOR_NOT_ARCHIVED', 'المورد غير مؤرشف');
        }
        if (vendor.lifecycleVersion !== body.expectedVersion) {
          fail(412, 'VENDOR_VERSION_MISMATCH', 'تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة', {
            currentVersion: vendor.lifecycleVersion,
          });
        }
        await assertNoActiveNameDuplicate(tx, companyId, vendor);
        const nextVersion = vendor.lifecycleVersion + 1;
        const result = await tx.vendor.update({
          where: { id: vendor.id },
          data: {
            status: 'active',
            archivedAt: null,
            archivedByUserId: null,
            archiveReason: null,
            lifecycleVersion: nextVersion,
          },
        });
        await writeAuditRequired(tx as any, {
          companyId,
          userId: actorId,
          action: 'vendor.reactivate',
          details: { vendorId: vendor.id, status: 'active', lifecycleVersion: nextVersion },
        });
        return result;
      });
      return res.json(shapeVendorLifecycle(updated));
    }),
  );

  // Read-only lifecycle detail (archive fields + version) for Android; same
  // permission as the existing vendor list/detail views.
  app.get(
    '/api/v2/vendors/:id/lifecycle',
    requireAuth,
    checkPermission(PERMISSIONS.VENDORS_VIEW),
    route(async (req, res) => {
      const vendor = await prisma.vendor.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
      });
      if (!vendor) fail(404, 'VENDOR_NOT_FOUND', 'المورد غير موجود');
      return res.json(shapeVendorLifecycle(vendor));
    }),
  );
}

export { shapeVendorLifecycle };
