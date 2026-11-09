import { ApiError, authenticatedRequest, request } from '@/api/client';
import { sessionMemory } from './sessionMemory';
import type {
  CompanySummary,
  MfaChallenge,
  MfaEnrollment,
  SessionSummary,
  SessionTokens,
  UserSummary,
} from './types';

export { ApiError };

type TokenResponse = SessionTokens & {
  user: UserSummary;
  company: CompanySummary;
  backupCodes?: string[];
};

const webSessionMetadata = {
  deviceLabel: 'Mawared Web',
  platform: 'web',
} as const;

export const authApi = {
  async login(input: {
    companyCode: string;
    identifier: string;
    password: string;
  }): Promise<TokenResponse | MfaChallenge> {
    return request<TokenResponse | MfaChallenge>('/api/v2/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...input, ...webSessionMetadata }),
    });
  },

  async startMfaEnrollment(challengeToken: string): Promise<MfaEnrollment> {
    return request<MfaEnrollment>('/api/v2/auth/mfa/enroll/start', {
      method: 'POST',
      body: JSON.stringify({ challengeToken }),
    });
  },

  async completeMfa(input: {
    challengeToken: string;
    code: string;
    enrollmentRequired: boolean;
  }): Promise<TokenResponse> {
    const path = input.enrollmentRequired
      ? '/api/v2/auth/mfa/enroll/confirm'
      : '/api/v2/auth/mfa/verify';
    return request<TokenResponse>(path, {
      method: 'POST',
      body: JSON.stringify({
        challengeToken: input.challengeToken,
        code: input.code,
        ...webSessionMetadata,
      }),
    });
  },

  async validatePrincipal(accessToken: string): Promise<UserSummary> {
    return request<UserSummary>('/api/auth/me', {}, accessToken);
  },

  async logout(): Promise<void> {
    const tokens = sessionMemory.get();
    try {
      await request('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: tokens?.refreshToken }),
      });
    } finally {
      sessionMemory.clear();
    }
  },

  listSessions(): Promise<SessionSummary[]> {
    return authenticatedRequest('/api/v2/auth/sessions');
  },

  revokeSession(sessionId: string): Promise<void> {
    return authenticatedRequest(`/api/v2/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  },

  revokeOtherSessions(): Promise<{ revokedCount: number }> {
    return authenticatedRequest('/api/v2/auth/sessions/revoke-all', {
      method: 'POST',
      body: JSON.stringify({ exceptCurrent: true }),
    });
  },
};

export function isTokenResponse(
  response: TokenResponse | MfaChallenge,
): response is TokenResponse {
  return 'accessToken' in response && 'refreshToken' in response;
}
