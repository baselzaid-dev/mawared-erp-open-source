export type CompanySummary = {
  id: string;
  code: string;
  name: string;
};

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  companyId: string;
  employeeId: string | null;
  roleId: string;
  roleName: string;
  permissions: string[];
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt?: string | null;
  mfaRequired?: boolean;
  mfaEnrolled?: boolean;
};

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
};

export type AuthenticatedSession = {
  user: UserSummary;
  company: CompanySummary;
};

export type MfaChallenge = {
  challengeToken: string;
  enrollmentRequired: boolean;
  expiresAt: string;
  user: UserSummary;
  company: CompanySummary;
};

export type MfaEnrollment = {
  manualSecret: string;
  otpauthUri: string;
  expiresAt: string;
};

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
