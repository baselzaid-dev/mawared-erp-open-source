import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export interface AccessTokenPayload {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
  authorizationVersion: number;
  /**
   * Credential generation embedded for E2 freshness fencing.
   * Optional for RC1-era tokens; requireAuth falls back to iat vs passwordChangedAt.
   */
  credentialVersion?: number;
  /** Public refresh-row session id — used for own-user session list/revoke (12G Slice 2A). */
  sessionId?: string;
}

/** SHA-256 hex digest — refresh tokens are stored ONLY as this hash, never plaintext. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Generates an opaque refresh token + its storage hash + expiry. */
export function generateRefreshToken(ttlDays: number): {
  token: string;
  hash: string;
  expiresAt: Date;
} {
  const token = crypto.randomBytes(48).toString('base64url');
  return {
    token,
    hash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  };
}

export function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  expiresIn: string
): string {
  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

/** Attach the public session id claim when issuing access tokens at login/refresh. */
export function attachSessionIdToAccessToken(
  payload: AccessTokenPayload,
  sessionId: string,
  secret: string,
  expiresIn: string,
): string {
  return signAccessToken({ ...payload, sessionId }, secret, expiresIn);
}
