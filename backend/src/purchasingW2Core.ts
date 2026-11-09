/**
 * Shared plumbing for Commercial Wave 2 purchasing routes (Operations Slice E1).
 *
 * Everything here is deliberately small and shared by
 * `purchasingQuotations.ts` and `purchasingReceipts.ts` so the two modules
 * cannot drift on authorization, tenant scoping, idempotency or error shape.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS } from './permissions';
import { PurchasingMathError } from './purchasingMath';

export interface PurchasingW2User {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

export interface PurchasingW2Request extends Request {
  user?: PurchasingW2User;
}

export class PurchasingW2Error extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const fail = (status: number, code: string, message: string, details?: unknown): never => {
  throw new PurchasingW2Error(status, code, message, details);
};

export const isAdmin = (user: PurchasingW2User): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL);

export const has = (user: PurchasingW2User, permission: string): boolean =>
  isAdmin(user) || user.permissions.includes(permission);

export const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail(400, 'VALIDATION_ERROR', 'البيانات المدخلة غير صالحة', result.error.flatten());
  }
  return (result as { data: T }).data;
};

/**
 * Wave 2 mutations are money/quantity changing, so the client must send an
 * `Idempotency-Key` header. An exact retry replays the stored result; the same
 * key with a different payload is a 409, never a second financial effect.
 */
const idempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const requireIdempotencyKey = (req: Request): string => {
  const header = req.header('Idempotency-Key');
  if (header == null || header.trim() === '') {
    fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'مفتاح منع التكرار مطلوب');
  }
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    fail(400, 'IDEMPOTENCY_KEY_INVALID', 'مفتاح منع التكرار غير صالح');
  }
  return parsed.data;
};

/**
 * Stable fingerprint of a mutation payload. Object keys are sorted so an
 * identical request always produces the same digest regardless of JSON key
 * order, and a genuinely different payload on the same key is detectable.
 */
export function payloadFingerprint(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return value ?? null;
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

/**
 * True when a write lost the race on a company-scoped idempotency key.
 *
 * The losing transaction is aborted, so the caller must re-read the winner in a
 * *fresh* transaction — never inside the aborted one (the W1A lesson). Callers
 * use this to turn a concurrent exact retry into a replay instead of a 409.
 */
export const isIdempotencyKeyConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  String(error.meta?.target ?? '').toLowerCase().includes('idempotencykey');

export const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

export const dateOnly = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString().slice(0, 10);

export const dateOnlyText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'يجب إدخال التاريخ بصيغة yyyy-MM-dd')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'التاريخ غير صالح');

export const parseDateOnly = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Document numbers reuse the existing `PR-YYYYMM-XXXXXXXX` shape. */
export const generateDocumentNumber = (prefix: 'SQ' | 'GRN' | 'PRT'): string => {
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  return `${prefix}-${month}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
};

/**
 * Retries a create when the *generated* document number collides. Any other
 * unique violation (including an idempotency key) is rethrown untouched.
 */
export async function retryDocumentNumberCollision<T>(
  field: 'quotationNumber' | 'receiptNumber' | 'returnNumber',
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const target =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
          ? String(error.meta?.target ?? '')
          : '';
      if (!target.includes(field) || attempt === 2) throw error;
    }
  }
  return fail(409, 'PURCHASING_NUMBER_COLLISION', 'تعذر إنشاء رقم فريد للسجل');
}

/** Locks a tenant-scoped row so concurrent quantity mutations serialize. */
export async function lockPurchaseOrder(tx: any, orderId: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${orderId} AND "companyId" = ${companyId} FOR UPDATE`;
}

export async function lockPurchaseRequest(tx: any, requestId: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "PurchaseRequest" WHERE "id" = ${requestId} AND "companyId" = ${companyId} FOR UPDATE`;
}

export const sendW2Error = (res: Response, error: unknown): Response => {
  if (error instanceof PurchasingW2Error) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof PurchasingMathError) {
    return res.status(400).json({ error: error.errorCode, message: error.message, code: 400 });
  }
  // A module-shaped error thrown by purchasing.ts (PurchasingError) keeps its status.
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown };
  if (typeof candidate?.status === 'number' && typeof candidate?.errorCode === 'string') {
    return res.status(candidate.status).json({
      error: candidate.errorCode,
      message: typeof candidate.message === 'string' ? candidate.message : 'تعذر إكمال العملية',
      code: candidate.status,
    });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return res.status(409).json({
      error: 'PURCHASING_DUPLICATE',
      message: 'يوجد سجل مماثل بالفعل',
      code: 409,
    });
  }
  return res.status(500).json({
    error: 'PURCHASING_OPERATION_FAILED',
    message: 'تعذر إكمال عملية المشتريات حالياً',
    code: 500,
  });
};
