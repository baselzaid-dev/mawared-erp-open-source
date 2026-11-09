import { expect } from 'vitest';

const forbiddenKey = /(?:password|hash|token|authorization|cookie|secret|baseSalary|grossPay|netPay|messageBody|completionDetails|reviewNote|justification|taxNumber)/i;
const forbiddenValue = /(?:\$2[aby]\$\d{2}\$|Bearer\s+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/i;

export function forbiddenPrivacyPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return forbiddenValue.test(value) ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenPrivacyPaths(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    const nestedPath = `${path}.${key}`;
    return [
      ...(forbiddenKey.test(key) ? [nestedPath] : []),
      ...forbiddenPrivacyPaths(nested, nestedPath),
    ];
  });
}

export function expectPrivacySafe(value: unknown): void {
  expect(forbiddenPrivacyPaths(value)).toEqual([]);
}
