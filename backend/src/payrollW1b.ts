/**
 * Commercial W1B Saudi regulated payroll/tax formulas — FAIL CLOSED.
 * These helpers must never mutate pay amounts. External validation is required
 * before any future activation. W1A must not call them as active calc paths.
 */

export const W1B_EXTERNAL_VALIDATION_REQUIRED = 'EXTERNAL_VALIDATION_REQUIRED' as const;

export class W1bNotActivatedError extends Error {
  readonly code = W1B_EXTERNAL_VALIDATION_REQUIRED;
  constructor(readonly feature: string) {
    super(`W1B feature "${feature}" is not activated; external validation required`);
  }
}

export function assertOvertimeNotActivated(): never {
  throw new W1bNotActivatedError('overtime');
}

export function assertAttendanceAutoDeductionNotActivated(): never {
  throw new W1bNotActivatedError('attendance_auto_deduction');
}

export function assertGosiNotActivated(): never {
  throw new W1bNotActivatedError('gosi');
}

export function assertEosNotActivated(): never {
  throw new W1bNotActivatedError('end_of_service');
}

export function assertWpsNotActivated(): never {
  throw new W1bNotActivatedError('wps');
}

export function assertVatNotActivated(): never {
  throw new W1bNotActivatedError('vat');
}

export function assertZatcaNotActivated(): never {
  throw new W1bNotActivatedError('zatca');
}

/** Soft probe used by calculate paths — never applies regulated amounts. */
export function probeW1bUnsupported(feature: string): {
  supported: false;
  code: typeof W1B_EXTERNAL_VALIDATION_REQUIRED;
  feature: string;
} {
  return {
    supported: false,
    code: W1B_EXTERNAL_VALIDATION_REQUIRED,
    feature,
  };
}

export const W1B_REGULATED_FEATURES = [
  'overtime',
  'attendance_auto_deduction',
  'gosi',
  'end_of_service',
  'wps',
  'vat',
  'zatca',
] as const;
