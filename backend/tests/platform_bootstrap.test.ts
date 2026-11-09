import bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapPlatformPrincipal } from '../scripts/bootstrap_platform_principal';
import { PLATFORM_PERMISSIONS } from '../src/platformAuth';

describe('local Platform principal bootstrap', () => {
  it('creates only the first principal without exposing its password', async () => {
    const create = vi.fn(async ({ data, select }: any) => ({
      id: 'platform-1',
      email: data.email,
      name: data.name,
      status: data.status,
      _passwordHash: data.password,
      _permissions: data.permissions,
      _select: select,
    }));
    const prisma: any = {
      $executeRawUnsafe: vi.fn(),
      platformPrincipal: {
        count: vi.fn(async () => 0),
        create,
      },
    };
    prisma.$transaction = vi.fn(async (operation: any) => operation(prisma));

    const result: any = await bootstrapPlatformPrincipal(prisma, {
      email: 'platform@example.test',
      name: 'Platform Owner',
      password: 'Platform-password-123!',
    });
    const data = create.mock.calls[0][0].data;
    expect(await bcrypt.compare('Platform-password-123!', data.password)).toBe(true);
    expect(data.permissions).toBe(JSON.stringify(Object.values(PLATFORM_PERMISSIONS)));
    expect(result.temporaryPassword).toBeUndefined();
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtext('mawared-platform-bootstrap-v1'))"
    );
  });

  it('fails closed when any Platform principal already exists', async () => {
    const prisma: any = {
      $executeRawUnsafe: vi.fn(),
      platformPrincipal: {
        count: vi.fn(async () => 1),
        create: vi.fn(),
      },
    };
    prisma.$transaction = vi.fn(async (operation: any) => operation(prisma));
    await expect(bootstrapPlatformPrincipal(prisma, {
      email: 'other@example.test',
      name: 'Other Owner',
      password: 'Platform-password-123!',
    })).rejects.toThrow('only when no principal exists');
    expect(prisma.platformPrincipal.create).not.toHaveBeenCalled();
  });

  it('rejects malformed email and oversized passwords before locking or creating', async () => {
    const prisma: any = {
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
      platformPrincipal: { count: vi.fn(), create: vi.fn() },
    };
    await expect(bootstrapPlatformPrincipal(prisma, {
      email: 'not-an-email',
      name: 'Platform Owner',
      password: 'x'.repeat(513),
    })).rejects.toThrow('input is invalid');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
