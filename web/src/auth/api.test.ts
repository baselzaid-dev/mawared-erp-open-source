import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './api';

describe('company web authentication API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('labels browser sessions without sending browser fingerprint data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      user: {},
      company: {},
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await authApi.login({
      companyCode: 'CMP-ONE',
      identifier: 'owner@example.test',
      password: 'test-only-password', // security-scan-allow: explicit test fixture
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      companyCode: 'CMP-ONE',
      identifier: 'owner@example.test',
      password: 'test-only-password', // security-scan-allow: explicit test fixture
      deviceLabel: 'Mawared Web',
      platform: 'web',
    });
  });
});
