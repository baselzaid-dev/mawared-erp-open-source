import { authenticatedRequest } from '@/api/client';
import { createIdempotencyKey } from './money';
import type {
  AdjustApplyResponse,
  AdjustPayrollItemInput,
  AdjustPreviewResponse,
  ApprovePayrollResponse,
  CalculatePayrollInput,
  ComponentDefinitionRecord,
  CreatePayrollPeriodInput,
  PayrollItemsResponse,
  PayrollPeriodRecord,
  PostToLedgerInput,
  PostToLedgerResponse,
  ReopenPayrollInput,
  ReopenPayrollResponse,
} from './types';

export const payrollApi = {
  listPeriods(): Promise<PayrollPeriodRecord[]> {
    return authenticatedRequest('/api/payroll/periods');
  },

  createPeriod(input: CreatePayrollPeriodInput): Promise<PayrollPeriodRecord> {
    return authenticatedRequest('/api/payroll/periods', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  calculatePeriod(
    periodId: string,
    input: CalculatePayrollInput = {},
  ): Promise<PayrollItemsResponse> {
    return authenticatedRequest(`/api/payroll/periods/${encodeURIComponent(periodId)}/calculate`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getPeriodItems(periodId: string): Promise<PayrollItemsResponse> {
    return authenticatedRequest(`/api/payroll/periods/${encodeURIComponent(periodId)}/items`);
  },

  approvePeriod(periodId: string): Promise<ApprovePayrollResponse> {
    return authenticatedRequest(`/api/payroll/periods/${encodeURIComponent(periodId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  previewAdjustment(
    periodId: string,
    itemId: string,
    input: AdjustPayrollItemInput,
  ): Promise<AdjustPreviewResponse> {
    return authenticatedRequest(
      `/api/v2/payroll/periods/${encodeURIComponent(periodId)}/items/${encodeURIComponent(itemId)}/adjust/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },

  applyAdjustment(
    periodId: string,
    itemId: string,
    input: AdjustPayrollItemInput,
    idempotencyKey: string,
  ): Promise<AdjustApplyResponse> {
    return authenticatedRequest(
      `/api/v2/payroll/periods/${encodeURIComponent(periodId)}/items/${encodeURIComponent(itemId)}/adjust`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
  },

  reopenPeriod(periodId: string, input: ReopenPayrollInput): Promise<ReopenPayrollResponse> {
    return authenticatedRequest(`/api/v2/payroll/periods/${encodeURIComponent(periodId)}/reopen`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  postToLedger(
    periodId: string,
    input: PostToLedgerInput,
    idempotencyKey = createIdempotencyKey('payroll-ledger'),
  ): Promise<PostToLedgerResponse> {
    return authenticatedRequest(
      `/api/v2/payroll/periods/${encodeURIComponent(periodId)}/post-to-ledger`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
  },

  listComponentDefinitions(): Promise<ComponentDefinitionRecord[]> {
    return authenticatedRequest('/api/v2/payroll/component-definitions');
  },
};
