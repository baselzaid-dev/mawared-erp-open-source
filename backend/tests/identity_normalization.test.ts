import { describe, expect, it } from 'vitest';
import {
  IdentityCollisionError,
  IdentityInputError,
  loginIdentityValues,
  normalizeCompanyCode,
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeLoginIdentifier,
} from '../src/identity';

describe('company login identity normalization', () => {
  it('canonicalizes approved Company Codes without locale dependence', () => {
    expect(normalizeCompanyCode('  cmp-demo  ')).toBe('CMP-DEMO');
    expect(normalizeCompanyCode('branch01')).toBe('BRANCH01');
  });

  it.each(['AB', '-ABC', 'ABC-', 'ABC--DEF', 'ABC DEF', 'ABC_01']) (
    'rejects invalid Company Code %s',
    (value) => expect(() => normalizeCompanyCode(value)).toThrow(IdentityInputError),
  );

  it('normalizes email and Employee number while preserving meaningful format', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
    expect(normalizeEmployeeNumber('  emp-٠١  ')).toBe('EMP-٠١');
    expect(normalizeLoginIdentifier('  Emp-001  ')).toBe('emp-001');
  });

  it('uses Unicode NFKC and rejects invisible formatting characters', () => {
    expect(normalizeEmployeeNumber('ＥＭＰ-００１')).toBe('EMP-001');
    expect(() => normalizeEmail('person\u200B@example.com')).toThrow(IdentityInputError);
    expect(() => normalizeLoginIdentifier('line\nbreak')).toThrow(IdentityInputError);
  });

  it('rejects a cross-kind ambiguity inside one company', () => {
    expect(() => loginIdentityValues('EMP001', 'emp001')).toThrow(IdentityCollisionError);
  });
});
