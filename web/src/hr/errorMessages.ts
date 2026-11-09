import { ApiError } from '@/api/client';
import type { Messages } from '@/i18n';

function isApiCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

export function employeeCreateErrorMessage(error: unknown, messages: Messages): string {
  if (
    isApiCode(error, 'EmployeeConflict') ||
    isApiCode(error, 'LoginIdentityAlreadyExists')
  ) {
    return messages.employeeConflictError;
  }
  if (isApiCode(error, 'EmployeeRoleForbidden')) return messages.employeeRoleForbiddenError;
  if (isApiCode(error, 'RequestValidationError')) return messages.employeeValidationError;
  if (error instanceof ApiError && error.status === 403) return messages.employeesForbidden;
  return messages.createEmployeeError;
}

export function departmentCreateErrorMessage(error: unknown, messages: Messages): string {
  if (isApiCode(error, 'DepartmentAlreadyExists')) return messages.departmentConflictError;
  if (isApiCode(error, 'InvalidDepartmentManager')) return messages.departmentManagerInvalidError;
  if (isApiCode(error, 'RequestValidationError')) return messages.departmentValidationError;
  if (error instanceof ApiError && error.status === 403) return messages.departmentsForbidden;
  return messages.createDepartmentError;
}

export function leaveCreateErrorMessage(error: unknown, messages: Messages): string {
  if (error instanceof ApiError && error.status === 403) return messages.leavesForbidden;
  if (error instanceof ApiError && error.status === 400) {
    const detail = error.messageKey ?? error.code;
    if (detail.includes('التأشيرة') || /visa/i.test(detail)) {
      return messages.leaveVisaFeeRequired;
    }
    if (detail.includes('sick leave') || /sick/i.test(detail)) {
      return messages.leaveSickQuotaError;
    }
    if (
      detail.includes('النهاية') ||
      detail.includes('البداية') ||
      /end.*before|before.*start/i.test(detail)
    ) {
      return messages.leaveDateOrderError;
    }
    return messages.leaveValidationError;
  }
  return messages.createLeaveError;
}

export function leaveActionErrorMessage(error: unknown, messages: Messages): string {
  if (error instanceof ApiError && error.status === 409) return messages.leaveConflictError;
  if (error instanceof ApiError && error.status === 403) {
    if (
      error.code === 'Cannot approve own leave' ||
      error.code === 'Cannot reject own leave' ||
      /own leave/i.test(error.code)
    ) {
      return messages.leaveSelfApprovalError;
    }
    return messages.approvalsForbidden;
  }
  if (error instanceof ApiError && error.status === 404) return messages.leaveNotFoundError;
  if (error instanceof ApiError && error.status === 400) return messages.leaveRejectReasonRequired;
  return messages.leaveActionError;
}
