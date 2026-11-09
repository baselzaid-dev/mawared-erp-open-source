import type { Prisma, PrismaClient } from '@prisma/client';
import { writeAudit } from './audit';

type SessionClient = Pick<PrismaClient, 'refreshToken' | 'auditLog'>;

export type SessionSummary = {
  sessionId: string;
  deviceLabel: string | null;
  platform: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  isCurrent: boolean;
  isLegacyDevice: boolean;
};

type RefreshTokenRow = {
  sessionId: string;
  deviceLabel: string | null;
  platform: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

export class CannotRevokeCurrentSessionError extends Error {
  constructor() {
    super('Cannot revoke current session');
    this.name = 'CannotRevokeCurrentSessionError';
  }
}

const toIso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

export function shapeSessionSummary(
  row: RefreshTokenRow,
  options: { isCurrent: boolean },
): SessionSummary {
  const deviceLabel = row.deviceLabel ?? null;
  const platform = row.platform ?? null;
  return {
    sessionId: row.sessionId,
    deviceLabel,
    platform,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: toIso(row.lastUsedAt),
    revokedAt: toIso(row.revokedAt),
    isCurrent: options.isCurrent,
    isLegacyDevice: deviceLabel == null && platform == null,
  };
}

export async function listSessionsForUser(
  prisma: SessionClient,
  userId: string,
  companyId: string,
  currentSessionId?: string | null,
): Promise<SessionSummary[]> {
  const rows = await prisma.refreshToken.findMany({
    where: { userId, companyId },
    orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      sessionId: true,
      deviceLabel: true,
      platform: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });

  return rows.map((row) =>
    shapeSessionSummary(row, {
      isCurrent: Boolean(currentSessionId && row.sessionId === currentSessionId),
    }),
  );
}

export async function revokeSessionByPublicId(
  prisma: SessionClient,
  sessionId: string,
  actor: { id: string; companyId: string },
  options: { allowCurrent?: boolean; currentSessionId?: string | null } = {},
): Promise<void> {
  const row = await prisma.refreshToken.findFirst({
    where: { sessionId, userId: actor.id, companyId: actor.companyId },
    select: { sessionId: true, revokedAt: true },
  });
  if (!row) throw new SessionNotFoundError();

  const currentSessionId = options.currentSessionId ?? null;
  if (!options.allowCurrent && currentSessionId && row.sessionId === currentSessionId) {
    throw new CannotRevokeCurrentSessionError();
  }

  if (row.revokedAt) return;

  await prisma.refreshToken.updateMany({
    where: {
      sessionId,
      userId: actor.id,
      companyId: actor.companyId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  await writeAudit(prisma, {
    companyId: actor.companyId,
    userId: actor.id,
    action: 'auth.session.revoke',
    details: { sessionId },
  });
}

export async function revokeAllSessionsForUser(
  prisma: SessionClient,
  userId: string,
  companyId: string,
  options: { exceptSessionId?: string | null; actorUserId?: string } = {},
): Promise<{ revokedCount: number }> {
  const where: Prisma.RefreshTokenWhereInput = {
    userId,
    companyId,
    revokedAt: null,
  };
  if (options.exceptSessionId) {
    where.sessionId = { not: options.exceptSessionId };
  }

  const result = await prisma.refreshToken.updateMany({
    where,
    data: { revokedAt: new Date() },
  });

  const actorUserId = options.actorUserId ?? userId;
  await writeAudit(prisma, {
    companyId,
    userId: actorUserId,
    action: 'auth.session.revoke_all',
    details: {
      revokedCount: result.count,
      ...(options.exceptSessionId ? { exceptSessionId: options.exceptSessionId } : {}),
    },
  });

  return { revokedCount: result.count };
}
