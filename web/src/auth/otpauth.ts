const safeOtpauthPattern = /^otpauth:\/\/totp\/[A-Za-z0-9._~%@+:-]+(?:\?[A-Za-z0-9._~%=&+-]+)?$/i;

export function sanitizeOtpauthUri(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || /[\r\n\t]/.test(candidate)) return null;
  return safeOtpauthPattern.test(candidate) ? candidate : null;
}
