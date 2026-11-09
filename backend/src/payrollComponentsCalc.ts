import { centsToMoney, moneyToCents, normalizeMoney } from './payrollMoney';

export const CALCULATION_RULES_VERSION = 'payroll-components-v1';

export interface ComponentDefinitionInput {
  id: string;
  code: string;
  name: string;
  componentType: 'allowance' | 'deduction' | string;
  calcMethod: 'fixed' | 'percentage' | string;
  fixedAmount: { toString(): string } | string | number | null;
  rateBps: number | null;
  percentageBasis: string | null;
  version: number;
  currency: string;
  status: string;
}

export interface AdjustmentInput {
  id: string;
  employeeId: string;
  direction: 'allowance' | 'deduction' | string;
  amount: { toString(): string } | string | number;
  status: string;
}

export interface ComputedComponentLine {
  definitionId: string;
  definitionCode: string;
  definitionVersion: number;
  componentType: string;
  calcMethod: string;
  percentageBasis: string | null;
  rateBps: number | null;
  fixedAmountSnapshot: string | null;
  amount: string;
  amountCents: bigint;
}

export interface ComputedEmployeePay {
  baseSalary: string;
  baseSalaryCents: bigint;
  allowanceCents: bigint;
  deductionCents: bigint;
  adjustmentAllowanceCents: bigint;
  adjustmentDeductionCents: bigint;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  componentLines: ComputedComponentLine[];
}

/** Truncate toward zero: (base * rateBps) / 10000n */
export function percentageOfBaseCents(baseSalaryCents: bigint, rateBps: number): bigint {
  if (!Number.isInteger(rateBps) || rateBps <= 0) {
    throw new Error('Invalid rateBps');
  }
  return (baseSalaryCents * BigInt(rateBps)) / 10000n;
}

export function computeDefinitionAmountCents(
  definition: ComponentDefinitionInput,
  baseSalaryCents: bigint,
): { amountCents: bigint; fixedAmountSnapshot: string | null } {
  if (definition.calcMethod === 'fixed') {
    const fixed = normalizeMoney(definition.fixedAmount ?? '');
    if (!fixed) throw new Error('Invalid fixed component amount');
    const amountCents = moneyToCents(fixed);
    if (amountCents <= 0n) throw new Error('Fixed component must be positive');
    return { amountCents, fixedAmountSnapshot: fixed };
  }
  if (definition.calcMethod === 'percentage') {
    if (definition.percentageBasis !== 'base_salary') {
      throw new Error('Only base_salary percentage basis is supported');
    }
    if (definition.rateBps == null) throw new Error('rateBps required');
    return {
      amountCents: percentageOfBaseCents(baseSalaryCents, definition.rateBps),
      fixedAmountSnapshot: null,
    };
  }
  throw new Error('Unsupported calcMethod');
}

export function computeEmployeePay(
  baseSalaryRaw: string,
  definitions: ComponentDefinitionInput[],
  adjustments: AdjustmentInput[],
): ComputedEmployeePay {
  const baseSalary = normalizeMoney(baseSalaryRaw);
  if (!baseSalary) throw new Error('Invalid base salary');
  const baseSalaryCents = moneyToCents(baseSalary);

  let allowanceCents = 0n;
  let deductionCents = 0n;
  const componentLines: ComputedComponentLine[] = [];

  const activeDefs = definitions
    .filter((definition) => definition.status === 'active')
    .slice()
    .sort((left, right) => left.code.localeCompare(right.code));

  for (const definition of activeDefs) {
    const { amountCents, fixedAmountSnapshot } = computeDefinitionAmountCents(
      definition,
      baseSalaryCents,
    );
    if (definition.componentType === 'allowance') allowanceCents += amountCents;
    else if (definition.componentType === 'deduction') deductionCents += amountCents;
    else throw new Error('Unsupported componentType');

    componentLines.push({
      definitionId: definition.id,
      definitionCode: definition.code,
      definitionVersion: definition.version,
      componentType: definition.componentType,
      calcMethod: definition.calcMethod,
      percentageBasis: definition.percentageBasis,
      rateBps: definition.rateBps,
      fixedAmountSnapshot,
      amount: centsToMoney(amountCents),
      amountCents,
    });
  }

  let adjustmentAllowanceCents = 0n;
  let adjustmentDeductionCents = 0n;
  for (const adjustment of adjustments.filter((row) => row.status === 'applied')) {
    const amount = normalizeMoney(adjustment.amount);
    if (!amount) throw new Error('Invalid adjustment amount');
    const amountCents = moneyToCents(amount);
    if (amountCents <= 0n) throw new Error('Adjustment must be positive');
    if (adjustment.direction === 'allowance') adjustmentAllowanceCents += amountCents;
    else if (adjustment.direction === 'deduction') adjustmentDeductionCents += amountCents;
    else throw new Error('Unsupported adjustment direction');
  }

  const grossCents = baseSalaryCents + allowanceCents + adjustmentAllowanceCents;
  const totalDeductionCents = deductionCents + adjustmentDeductionCents;
  if (grossCents < totalDeductionCents) {
    throw new Error('NET_PAY_NEGATIVE');
  }
  const netCents = grossCents - totalDeductionCents;

  return {
    baseSalary,
    baseSalaryCents,
    allowanceCents,
    deductionCents,
    adjustmentAllowanceCents,
    adjustmentDeductionCents,
    grossPay: centsToMoney(grossCents),
    totalDeductions: centsToMoney(totalDeductionCents),
    netPay: centsToMoney(netCents),
    componentLines,
  };
}

export function fingerprintDefinitions(definitions: ComponentDefinitionInput[]) {
  return definitions
    .filter((definition) => definition.status === 'active')
    .slice()
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((definition) => ({
      id: definition.id,
      code: definition.code,
      version: definition.version,
      componentType: definition.componentType,
      calcMethod: definition.calcMethod,
      fixedAmount: definition.fixedAmount == null
        ? null
        : normalizeMoney(definition.fixedAmount),
      rateBps: definition.rateBps,
      percentageBasis: definition.percentageBasis,
    }));
}

export function fingerprintAdjustments(adjustments: AdjustmentInput[]) {
  return adjustments
    .filter((row) => row.status === 'applied')
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      direction: row.direction,
      amount: normalizeMoney(row.amount),
    }));
}
