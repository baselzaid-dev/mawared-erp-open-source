import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { translations } from '@/i18n';
import {
  departmentCreateErrorMessage,
  employeeCreateErrorMessage,
  leaveActionErrorMessage,
  leaveCreateErrorMessage,
} from './errorMessages';

const messages = translations.en;

describe('HR create error messages', () => {
  it('maps known employee create failures', () => {
    expect(employeeCreateErrorMessage(new ApiError(409, 'EmployeeConflict'), messages)).toBe(
      messages.employeeConflictError,
    );
    expect(employeeCreateErrorMessage(new ApiError(403, 'EmployeeRoleForbidden'), messages)).toBe(
      messages.employeeRoleForbiddenError,
    );
  });

  it('maps known department create failures', () => {
    expect(departmentCreateErrorMessage(new ApiError(409, 'DepartmentAlreadyExists'), messages)).toBe(
      messages.departmentConflictError,
    );
  });

  it('maps leave create validation and visa-fee failures', () => {
    expect(
      leaveCreateErrorMessage(
        new ApiError(400, 'ValidationError', 'الرجاء دفع رسوم التأشيرة ثم تقديم الطلب مرة أخرى'),
        messages,
      ),
    ).toBe(messages.leaveVisaFeeRequired);
    expect(
      leaveCreateErrorMessage(
        new ApiError(400, 'ValidationError', 'تاريخ النهاية لا يمكن أن يكون قبل تاريخ البداية'),
        messages,
      ),
    ).toBe(messages.leaveDateOrderError);
  });

  it('maps leave action conflict and self-approval failures', () => {
    expect(
      leaveActionErrorMessage(new ApiError(409, 'LeaveStateConflict'), messages),
    ).toBe(messages.leaveConflictError);
    expect(
      leaveActionErrorMessage(new ApiError(403, 'Cannot approve own leave'), messages),
    ).toBe(messages.leaveSelfApprovalError);
  });
});
