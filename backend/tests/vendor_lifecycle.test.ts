import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerVendorLifecycleRoutes } from '../src/vendorLifecycle';
import { PERMISSIONS } from '../src/permissions';
import { TEST_SECRET, tokenFor } from './helpers';

/**
 * Isolated fake Prisma scoped to this test file (per Agent A path ownership:
 * only backend/src/vendorLifecycle.ts and this test file are owned here).
 * Mirrors the vendor mock shape used in backend/tests/helpers.ts so the
 * where-clause semantics match production usage patterns from purchasing.ts.
 */
function makeVendorLifecyclePrisma() {
  const vendors: any[] = [];
  const auditLogs: any[] = [];

  const prisma: any = {
    vendor: {
      findFirst: vi.fn(async ({ where }: any) => vendors.find((v) => {
        if (typeof where.id === 'string' && v.id !== where.id) return false;
        if (where.id && typeof where.id === 'object' && where.id.not !== undefined && v.id === where.id.not) return false;
        if (where.companyId !== undefined && v.companyId !== where.companyId) return false;
        if (where.status !== undefined && v.status !== where.status) return false;
        if (where.name?.equals !== undefined && v.name.trim().toLowerCase() !== where.name.equals.trim().toLowerCase()) return false;
        return true;
      }) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = vendors.find((v) => v.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `audit-${auditLogs.length + 1}`, createdAt: new Date(), ...data };
        auditLogs.push(row);
        return row;
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    _store: { vendors, auditLogs },
  };
  return prisma;
}

const vendor = (overrides: Record<string, unknown> = {}) => ({
  id: 'vendor-1',
  companyId: 'c1',
  name: 'Acme Supplies',
  contact: '0500000000',
  email: 'vendor@example.com',
  taxNumber: '12345',
  category: 'materials',
  status: 'active',
  lifecycleVersion: 1,
  createdByUserId: 'creator-1',
  deactivatedAt: null,
  archivedAt: null,
  archivedByUserId: null,
  archiveReason: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

function makeVendorLifecycleApp(prisma: ReturnType<typeof makeVendorLifecyclePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const payload = jwt.verify(header.slice(7), TEST_SECRET) as {
        id: string;
        companyId: string;
        permissions: string[];
      };
      (req as express.Request & { user?: typeof payload }).user = payload;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  const checkPermission = (permission: string) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const permissions = (req as express.Request & { user?: { permissions?: string[] } }).user?.permissions ?? [];
      if (permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission)) {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden' });
    };

  registerVendorLifecycleRoutes({ app, prisma, requireAuth, checkPermission });
  return app;
}

describe('vendor lifecycle routes (Sprint 12I M08)', () => {
  let prisma: ReturnType<typeof makeVendorLifecyclePrisma>;
  let app: express.Express;

  const archiverToken = tokenFor({ id: 'u1', companyId: 'c1', permissions: [PERMISSIONS.VENDORS_ARCHIVE] });
  const viewerToken = tokenFor({ id: 'u2', companyId: 'c1', permissions: [PERMISSIONS.VENDORS_VIEW] });
  const otherCompanyArchiverToken = tokenFor({ id: 'u3', companyId: 'c2', permissions: [PERMISSIONS.VENDORS_ARCHIVE] });
  const otherCompanyViewerToken = tokenFor({ id: 'u4', companyId: 'c2', permissions: [PERMISSIONS.VENDORS_VIEW] });

  beforeEach(() => {
    prisma = makeVendorLifecyclePrisma();
    app = makeVendorLifecycleApp(prisma);
  });

  describe('POST /api/v2/vendors/:id/archive', () => {
    it('archives an active vendor, increments lifecycleVersion, and writes a sanitized audit entry', async () => {
      prisma._store.vendors.push(vendor());

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: 'Vendor closed operations', expectedVersion: 1 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('archived');
      expect(res.body.lifecycleVersion).toBe(2);
      expect(res.body.archivedByUserId).toBe('u1');
      expect(res.body.archiveReason).toBe('Vendor closed operations');
      expect(res.body.archivedAt).not.toBeNull();

      expect(prisma._store.vendors).toHaveLength(1); // no delete of the vendor row

      const audit = prisma._store.auditLogs.at(-1);
      expect(audit.action).toBe('vendor.archive');
      const details = JSON.parse(audit.details);
      expect(details).toEqual({ vendorId: 'vendor-1', status: 'archived', lifecycleVersion: 2 });
      expect(details.reason).toBeUndefined();
      expect(details.contact).toBeUndefined();
      expect(details.email).toBeUndefined();
      expect(details.taxNumber).toBeUndefined();
    });

    it('accepts an optional confirmation field without enforcing a specific value', async () => {
      prisma._store.vendors.push(vendor());
      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: 'Vendor closed operations', expectedVersion: 1, confirmation: 'ARCHIVE' });
      expect(res.status).toBe(200);
    });

    it('rejects archiving an already-archived vendor with 409 (deterministic, not idempotent)', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived', archivedAt: new Date(), archivedByUserId: 'u0',
        archiveReason: 'old', lifecycleVersion: 2,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: 'again', expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VENDOR_ALREADY_ARCHIVED');
    });

    it('rejects a stale expectedVersion with 412 and reports the current version', async () => {
      prisma._store.vendors.push(vendor({ lifecycleVersion: 3 }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: 'Closed', expectedVersion: 1 });

      expect(res.status).toBe(412);
      expect(res.body.error).toBe('VENDOR_VERSION_MISMATCH');
      expect(res.body.details.currentVersion).toBe(3);
    });

    it('rejects an empty/too-long reason with 400', async () => {
      prisma._store.vendors.push(vendor());

      const empty = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: '', expectedVersion: 1 });
      expect(empty.status).toBe(400);

      const tooLong = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: 'x'.repeat(501), expectedVersion: 1 });
      expect(tooLong.status).toBe(400);
    });

    it('requires the vendors.archive permission (403 for a viewer)', async () => {
      prisma._store.vendors.push(vendor());

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ reason: 'Closed', expectedVersion: 1 });

      expect(res.status).toBe(403);
    });

    it('requires authentication (401 without a token)', async () => {
      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .send({ reason: 'Closed', expectedVersion: 1 });

      expect(res.status).toBe(401);
    });

    it('returns 404 for a vendor belonging to another company (tenant isolation)', async () => {
      prisma._store.vendors.push(vendor());

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/archive')
        .set('Authorization', `Bearer ${otherCompanyArchiverToken}`)
        .send({ reason: 'Closed', expectedVersion: 1 });

      expect(res.status).toBe(404);
    });

    it('returns 404 for a non-existent vendor id', async () => {
      const res = await request(app)
        .post('/api/v2/vendors/does-not-exist/archive')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ reason: 'Closed', expectedVersion: 1 });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/vendors/:id/reactivate', () => {
    it('reactivates an archived vendor, clears archive fields, and increments lifecycleVersion', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived', archivedAt: new Date(), archivedByUserId: 'u0',
        archiveReason: 'old reason', lifecycleVersion: 2,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ expectedVersion: 2, reason: 'Vendor resumed operations' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.lifecycleVersion).toBe(3);
      expect(res.body.archivedAt).toBeNull();
      expect(res.body.archivedByUserId).toBeNull();
      expect(res.body.archiveReason).toBeNull();

      const audit = prisma._store.auditLogs.at(-1);
      expect(audit.action).toBe('vendor.reactivate');
      const details = JSON.parse(audit.details);
      expect(details).toEqual({ vendorId: 'vendor-1', status: 'active', lifecycleVersion: 3 });
    });

    it('allows reactivation without an optional reason', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived', archivedAt: new Date(), archivedByUserId: 'u0', lifecycleVersion: 2,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(200);
    });

    it('rejects reactivating a non-archived vendor with 409', async () => {
      prisma._store.vendors.push(vendor({ status: 'active', lifecycleVersion: 1 }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ expectedVersion: 1 });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VENDOR_NOT_ARCHIVED');
    });

    it('rejects a stale expectedVersion with 412', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived', archivedAt: new Date(), archivedByUserId: 'u0', lifecycleVersion: 5,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(412);
      expect(res.body.error).toBe('VENDOR_VERSION_MISMATCH');
      expect(res.body.details.currentVersion).toBe(5);
    });

    it('rejects reactivation with 409 when an active vendor already has the same name', async () => {
      prisma._store.vendors.push(vendor({ id: 'vendor-2', name: 'Acme Supplies', status: 'active', lifecycleVersion: 1 }));
      prisma._store.vendors.push(vendor({
        id: 'vendor-1', name: 'Acme Supplies', status: 'archived',
        archivedAt: new Date(), archivedByUserId: 'u0', lifecycleVersion: 2,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${archiverToken}`)
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VENDOR_NAME_DUPLICATE');
    });

    it('requires the vendors.archive permission (403 for a viewer)', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived', archivedAt: new Date(), archivedByUserId: 'u0', lifecycleVersion: 2,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(403);
    });

    it('requires authentication (401 without a token)', async () => {
      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(401);
    });

    it('returns 404 for a vendor belonging to another company (tenant isolation)', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived', archivedAt: new Date(), archivedByUserId: 'u0', lifecycleVersion: 2,
      }));

      const res = await request(app)
        .post('/api/v2/vendors/vendor-1/reactivate')
        .set('Authorization', `Bearer ${otherCompanyArchiverToken}`)
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/vendors/:id/lifecycle', () => {
    it('returns lifecycle detail (including archive fields and version) for a viewer', async () => {
      prisma._store.vendors.push(vendor({
        status: 'archived',
        archivedAt: new Date('2026-02-01T00:00:00.000Z'),
        archivedByUserId: 'u0',
        archiveReason: 'closed',
        lifecycleVersion: 2,
      }));

      const res = await request(app)
        .get('/api/v2/vendors/vendor-1/lifecycle')
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('archived');
      expect(res.body.lifecycleVersion).toBe(2);
      expect(res.body.archiveReason).toBe('closed');
      expect(res.body.archivedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('requires the vendors.view permission (403 without it)', async () => {
      prisma._store.vendors.push(vendor());

      const res = await request(app)
        .get('/api/v2/vendors/vendor-1/lifecycle')
        .set('Authorization', `Bearer ${archiverToken}`);

      expect(res.status).toBe(403);
    });

    it('returns 404 for a vendor belonging to another company (tenant isolation)', async () => {
      prisma._store.vendors.push(vendor());

      const res = await request(app)
        .get('/api/v2/vendors/vendor-1/lifecycle')
        .set('Authorization', `Bearer ${otherCompanyViewerToken}`);

      expect(res.status).toBe(404);
    });

    it('requires authentication (401 without a token)', async () => {
      const res = await request(app).get('/api/v2/vendors/vendor-1/lifecycle');
      expect(res.status).toBe(401);
    });
  });
});
