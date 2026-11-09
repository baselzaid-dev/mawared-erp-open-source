/**
 * Resolve opaque recipientRef values to verified email addresses (E6).
 * Never log or return principal/company identifiers to callers beyond the email.
 */

import type { PrismaClient } from '@prisma/client';

export interface RecoveryRecipientDirectory {
  resolveEmail(recipientRef: string): Promise<string | null>;
}

const PLATFORM_REF_RE =
  /^platform-email:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const OWNER_REF_RE =
  /^owner-email:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidDeliveryEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 320) return false;
  if (trimmed !== value.trim().toLowerCase() && trimmed.toLowerCase() !== trimmed) {
    // Allow mixed case but validate structure on lowercase form.
  }
  return EMAIL_RE.test(trimmed) && !/\s/.test(trimmed);
}

export function createPrismaRecoveryRecipientDirectory(
  prisma: PrismaClient,
): RecoveryRecipientDirectory {
  return {
    async resolveEmail(recipientRef: string): Promise<string | null> {
      const platform = PLATFORM_REF_RE.exec(recipientRef);
      if (platform) {
        const principal = await prisma.platformPrincipal.findUnique({
          where: { id: platform[1] },
          select: { normalizedEmail: true, status: true },
        });
        if (!principal || principal.status !== 'active') return null;
        if (!isValidDeliveryEmail(principal.normalizedEmail)) return null;
        return principal.normalizedEmail;
      }

      const owner = OWNER_REF_RE.exec(recipientRef);
      if (owner) {
        const companyId = owner[1];
        const userId = owner[2];
        const user = await prisma.user.findFirst({
          where: {
            id: userId,
            companyId,
            accountStatus: 'active',
          },
          select: { normalizedEmail: true },
        });
        if (!user?.normalizedEmail) return null;
        if (!isValidDeliveryEmail(user.normalizedEmail)) return null;
        return user.normalizedEmail;
      }

      return null;
    },
  };
}

/** Test helper — map opaque refs without Prisma. */
export function createStaticRecoveryRecipientDirectory(
  map: ReadonlyMap<string, string> | Record<string, string>,
): RecoveryRecipientDirectory {
  const lookup = map instanceof Map ? map : new Map(Object.entries(map));
  return {
    async resolveEmail(recipientRef: string): Promise<string | null> {
      const email = lookup.get(recipientRef) ?? null;
      if (!email || !isValidDeliveryEmail(email)) return null;
      return email.trim().toLowerCase();
    },
  };
}
