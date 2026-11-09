import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export const LOGIN_IDENTITY_TYPE = {
  EMAIL: 'email',
  EMPLOYEE_NUMBER: 'employee_number',
} as const;

export type LoginIdentityType = typeof LOGIN_IDENTITY_TYPE[keyof typeof LOGIN_IDENTITY_TYPE];

export class IdentityInputError extends Error {}
export class IdentityCollisionError extends Error {}

const unsafeFormattingCharacters = /[\p{Cc}\p{Cf}]/u;
const companyCodePattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

function normalizeText(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') throw new IdentityInputError('Invalid identity input');
  let normalized: string;
  try {
    normalized = value.normalize('NFKC').trim();
  } catch {
    throw new IdentityInputError('Invalid identity input');
  }
  if (
    normalized.length < 1 ||
    normalized.length > maximumLength ||
    unsafeFormattingCharacters.test(normalized)
  ) {
    throw new IdentityInputError('Invalid identity input');
  }
  return normalized;
}

export function normalizeCompanyCode(value: unknown): string {
  const normalized = normalizeText(value, 32).toUpperCase();
  if (normalized.length < 3 || !companyCodePattern.test(normalized)) {
    throw new IdentityInputError('Invalid Company Code');
  }
  return normalized;
}

export function normalizeEmail(value: unknown): string {
  return normalizeText(value, 320).toLowerCase();
}

export function normalizeEmployeeNumber(value: unknown): string {
  return normalizeText(value, 100).toUpperCase();
}

/**
 * LoginIdentity uses one case-folded lookup key across both identity kinds.
 * This prevents an email and Employee number from becoming ambiguous inside
 * the same company while their profile fields retain their approved casing.
 */
export function normalizeLoginIdentifier(value: unknown): string {
  return normalizeText(value, 320).toLowerCase();
}

export function loginIdentityValues(email: string, employeeNumber: string) {
  const emailIdentifier = normalizeLoginIdentifier(normalizeEmail(email));
  const employeeNumberIdentifier = normalizeLoginIdentifier(
    normalizeEmployeeNumber(employeeNumber),
  );
  if (emailIdentifier === employeeNumberIdentifier) {
    throw new IdentityCollisionError('Login identities collide inside the company');
  }
  return { emailIdentifier, employeeNumberIdentifier };
}

export async function syncLoginIdentities(
  tx: Prisma.TransactionClient,
  input: { companyId: string; userId: string; email: string; employeeNumber: string },
): Promise<void> {
  const { emailIdentifier, employeeNumberIdentifier } = loginIdentityValues(
    input.email,
    input.employeeNumber,
  );
  const desired = [
    { type: LOGIN_IDENTITY_TYPE.EMAIL, normalizedIdentifier: emailIdentifier },
    {
      type: LOGIN_IDENTITY_TYPE.EMPLOYEE_NUMBER,
      normalizedIdentifier: employeeNumberIdentifier,
    },
  ] as const;

  const collision = await tx.loginIdentity.findFirst({
    where: {
      companyId: input.companyId,
      normalizedIdentifier: { in: desired.map((identity) => identity.normalizedIdentifier) },
      userId: { not: input.userId },
    },
    select: { id: true },
  });
  if (collision) throw new IdentityCollisionError('Login identity is already reserved');

  const current = await tx.loginIdentity.findMany({
    where: { companyId: input.companyId, userId: input.userId },
    select: { id: true, type: true },
  });

  // Move existing rows to unique canonical temporary keys first. This allows
  // an atomic email/Employee-number swap without deleting identity history.
  for (const identity of current) {
    await tx.loginIdentity.update({
      where: { id: identity.id },
      data: { normalizedIdentifier: `~sync~${randomUUID()}` },
    });
  }

  for (const identity of desired) {
    const existing = current.find((row) => row.type === identity.type);
    if (existing) {
      await tx.loginIdentity.update({
        where: { id: existing.id },
        data: { normalizedIdentifier: identity.normalizedIdentifier },
      });
    } else {
      await tx.loginIdentity.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          type: identity.type,
          normalizedIdentifier: identity.normalizedIdentifier,
        },
      });
    }
  }
}

export function isPrismaUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
