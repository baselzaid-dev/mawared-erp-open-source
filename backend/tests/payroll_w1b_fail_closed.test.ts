import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertGosiNotActivated,
  assertOvertimeNotActivated,
  assertVatNotActivated,
  assertZatcaNotActivated,
  assertEosNotActivated,
  assertWpsNotActivated,
  assertAttendanceAutoDeductionNotActivated,
  probeW1bUnsupported,
  W1B_EXTERNAL_VALIDATION_REQUIRED,
  W1B_REGULATED_FEATURES,
} from '../src/payrollW1b';
import { CALCULATION_RULES_VERSION } from '../src/payrollComponentsCalc';

describe('payroll W1B fail-closed boundary', () => {
  it('keeps W1A calculation version free of regulated Saudi formulas', () => {
    expect(CALCULATION_RULES_VERSION).toBe('payroll-components-v1');
    expect(CALCULATION_RULES_VERSION).not.toMatch(/gosi|eos|wps|zatca|vat|overtime/i);
  });

  it('exports fail-closed helpers that never activate regulated features', () => {
    for (const feature of W1B_REGULATED_FEATURES) {
      const probe = probeW1bUnsupported(feature);
      expect(probe.supported).toBe(false);
      expect(probe.code).toBe(W1B_EXTERNAL_VALIDATION_REQUIRED);
    }

    expect(() => assertOvertimeNotActivated()).toThrow(/EXTERNAL_VALIDATION_REQUIRED|not activated/i);
    expect(() => assertAttendanceAutoDeductionNotActivated()).toThrow();
    expect(() => assertGosiNotActivated()).toThrow();
    expect(() => assertEosNotActivated()).toThrow();
    expect(() => assertWpsNotActivated()).toThrow();
    expect(() => assertVatNotActivated()).toThrow();
    expect(() => assertZatcaNotActivated()).toThrow();
  });

  it('does not wire regulated auto-deduction into payroll calculation source', () => {
    const payrollSource = readFileSync(new URL('../src/payroll.ts', import.meta.url), 'utf8');
    expect(payrollSource).toContain('probeW1bUnsupported');
    expect(payrollSource).not.toMatch(/assertGosiNotActivated\(\);\s*\/\/\s*apply/);
    expect(payrollSource).not.toMatch(/gosiEmployeeShare|overtimeHours|zatcaPayload|wpsFile/);
  });
});
