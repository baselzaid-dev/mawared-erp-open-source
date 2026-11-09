import { useCallback, useEffect, useState } from 'react';
import { ApiError, authApi, isTokenResponse } from './api';
import { sessionMemory } from './sessionMemory';
import type {
  AuthenticatedSession,
  MfaChallenge,
  MfaEnrollment,
  UserSummary,
} from './types';

type AuthError = 'invalidCredentials' | 'network' | 'mfa' | 'session' | null;

type AuthState =
  | { status: 'anonymous'; error: AuthError }
  | { status: 'working'; error: AuthError }
  | {
      status: 'mfa';
      challenge: MfaChallenge;
      enrollment: MfaEnrollment | null;
      busy: boolean;
      error: AuthError;
    }
  | {
      status: 'backupCodes';
      session: AuthenticatedSession;
      backupCodes: string[];
      error: AuthError;
    }
  | { status: 'authenticated'; session: AuthenticatedSession; error: AuthError };

function classifyError(error: unknown): AuthError {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'network';
    if (error.status === 401 || error.status === 400) return 'invalidCredentials';
  }
  return 'session';
}

async function acceptTokenResponse(response: {
  accessToken: string;
  refreshToken: string;
  user: UserSummary;
  company: AuthenticatedSession['company'];
}): Promise<AuthenticatedSession> {
  const validated = await authApi.validatePrincipal(response.accessToken);
  if (validated.id !== response.user.id || validated.companyId !== response.company.id) {
    throw new ApiError(401, 'PrincipalBindingMismatch');
  }
  sessionMemory.set({
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
  });
  return { user: response.user, company: response.company };
}

export function useAuthController() {
  const [state, setState] = useState<AuthState>({ status: 'anonymous', error: null });

  useEffect(
    () => sessionMemory.subscribe((tokens) => {
      if (!tokens) {
        setState((current) =>
          current.status === 'anonymous' ? current : { status: 'anonymous', error: null },
        );
      }
    }),
    [],
  );

  const login = useCallback(async (input: {
    companyCode: string;
    identifier: string;
    password: string;
  }) => {
    setState({ status: 'working', error: null });
    try {
      const response = await authApi.login(input);
      if (!isTokenResponse(response)) {
        setState({
          status: 'mfa',
          challenge: response,
          enrollment: null,
          busy: false,
          error: null,
        });
        return;
      }
      const session = await acceptTokenResponse(response);
      setState({ status: 'authenticated', session, error: null });
    } catch (error) {
      sessionMemory.clear();
      setState({ status: 'anonymous', error: classifyError(error) });
    }
  }, []);

  const startEnrollment = useCallback(async () => {
    if (state.status !== 'mfa' || state.busy) return;
    setState({ ...state, busy: true, error: null });
    try {
      const enrollment = await authApi.startMfaEnrollment(state.challenge.challengeToken);
      setState({ ...state, enrollment, busy: false, error: null });
    } catch (error) {
      setState({
        ...state,
        busy: false,
        error: classifyError(error) === 'network' ? 'network' : 'mfa',
      });
    }
  }, [state]);

  const completeMfa = useCallback(async (code: string) => {
    if (state.status !== 'mfa' || state.busy) return;
    setState({ ...state, busy: true, error: null });
    try {
      const response = await authApi.completeMfa({
        challengeToken: state.challenge.challengeToken,
        code,
        enrollmentRequired: state.challenge.enrollmentRequired,
      });
      const session = await acceptTokenResponse(response);
      if (response.backupCodes?.length) {
        setState({
          status: 'backupCodes',
          session,
          backupCodes: [...response.backupCodes],
          error: null,
        });
      } else {
        setState({ status: 'authenticated', session, error: null });
      }
    } catch (error) {
      setState({
        ...state,
        busy: false,
        error: classifyError(error) === 'network' ? 'network' : 'mfa',
      });
    }
  }, [state]);

  const acknowledgeBackupCodes = useCallback(() => {
    setState((current) =>
      current.status === 'backupCodes'
        ? { status: 'authenticated', session: current.session, error: null }
        : current,
    );
  }, []);

  const cancelChallenge = useCallback(() => {
    sessionMemory.clear();
    setState({ status: 'anonymous', error: null });
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setState({ status: 'anonymous', error: null });
    }
  }, []);

  return {
    state,
    login,
    startEnrollment,
    completeMfa,
    acknowledgeBackupCodes,
    cancelChallenge,
    logout,
  };
}
