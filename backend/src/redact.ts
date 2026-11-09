export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_STRING_LENGTH = 512;

const SENSITIVE_KEY_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'password',
  'passwordhash',
  'temporarypassword',
  'currentpassword',
  'newpassword',
  'confirmationpassword',
  'mfasecret',
  'totpsecret',
  'totpcode',
  'backupcode',
  'backupcodes',
  'mfachallenge',
  'invitationtoken',
  'resettoken',
  'recoverytoken',
  'apikey',
  'databaseurl',
  'encryptionkey',
  'privatekey',
  'signingmaterial',
  'clientsecret',
]);

const SENSITIVE_VALUE_PATTERN = new RegExp(
  [
    String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`,
    String.raw`(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s]+`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  ].join('|'),
  'i',
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKey(key));
}

export function redactString(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed.length > MAX_STRING_LENGTH) return REDACTED;
  if (SENSITIVE_VALUE_PATTERN.test(trimmed)) return REDACTED;
  if (isSensitiveKey(trimmed)) return REDACTED;
  return value;
}

export function redactMetadata(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return REDACTED;
  }
  if (typeof value !== 'object') return REDACTED;

  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value)) return REDACTED;
  visited.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactMetadata(item, depth + 1, visited));
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
  for (const [key, nested] of entries) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactMetadata(nested, depth + 1, visited);
  }
  return output;
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers).slice(0, MAX_OBJECT_KEYS)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    if (typeof value === 'string') {
      output[key] = redactString(value);
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.map((item) => (typeof item === 'string' ? redactString(item) : REDACTED));
      continue;
    }
    output[key] = REDACTED;
  }
  return output;
}
