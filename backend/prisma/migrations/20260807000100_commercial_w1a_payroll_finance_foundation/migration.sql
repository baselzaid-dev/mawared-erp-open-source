-- Commercial W1A: Neutral Payroll + Accounting/Finance Foundation (additive only).
-- Exact money via DECIMAL(18,2). W1B formulas not activated.
-- Constraints use ADD only on this unmerged additive migration (no DROP CONSTRAINT).

BEGIN;

-- ---------------------------------------------------------------------------
-- ChartOfAccount: hierarchy + status + tenant uniqueness
-- ---------------------------------------------------------------------------
ALTER TABLE "ChartOfAccount"
    ADD COLUMN IF NOT EXISTS "parentId" TEXT,
    ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "archivedByUserId" TEXT;

ALTER TABLE "ChartOfAccount"
    ADD CONSTRAINT "ChartOfAccount_status_check"
        CHECK ("status" IN ('active', 'archived')),
    ADD CONSTRAINT "ChartOfAccount_type_check"
        CHECK ("type" IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
    ADD CONSTRAINT "ChartOfAccount_archive_pair_check"
        CHECK (
            ("status" = 'active' AND "archivedAt" IS NULL AND "archivedByUserId" IS NULL)
            OR ("status" = 'archived' AND "archivedAt" IS NOT NULL AND "archivedByUserId" IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS "ChartOfAccount_companyId_code_key"
    ON "ChartOfAccount"("companyId", "code");

CREATE UNIQUE INDEX IF NOT EXISTS "ChartOfAccount_id_companyId_key"
    ON "ChartOfAccount"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_ChartOfAccount_company_status"
    ON "ChartOfAccount"("companyId", "status");

CREATE INDEX IF NOT EXISTS "idx_ChartOfAccount_company_parentId"
    ON "ChartOfAccount"("companyId", "parentId");

CREATE INDEX IF NOT EXISTS "idx_ChartOfAccount_company_type"
    ON "ChartOfAccount"("companyId", "type");

ALTER TABLE "ChartOfAccount"
    ADD CONSTRAINT "ChartOfAccount_parentId_companyId_fkey"
        FOREIGN KEY ("parentId", "companyId")
        REFERENCES "ChartOfAccount"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "ChartOfAccount_archivedByUserId_companyId_fkey"
        FOREIGN KEY ("archivedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CostCenter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CostCenter" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "archivedAt" TIMESTAMPTZ(3),
    "archivedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CostCenter"
    ADD CONSTRAINT "CostCenter_status_check"
        CHECK ("status" IN ('active', 'archived')),
    ADD CONSTRAINT "CostCenter_archive_pair_check"
        CHECK (
            ("status" = 'active' AND "archivedAt" IS NULL AND "archivedByUserId" IS NULL)
            OR ("status" = 'archived' AND "archivedAt" IS NOT NULL AND "archivedByUserId" IS NOT NULL)
        ),
    ADD CONSTRAINT "CostCenter_code_len_check"
        CHECK (char_length(btrim("code")) BETWEEN 1 AND 40),
    ADD CONSTRAINT "CostCenter_name_len_check"
        CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX IF NOT EXISTS "CostCenter_companyId_code_key"
    ON "CostCenter"("companyId", "code");

CREATE UNIQUE INDEX IF NOT EXISTS "CostCenter_id_companyId_key"
    ON "CostCenter"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_CostCenter_company_status"
    ON "CostCenter"("companyId", "status");

ALTER TABLE "CostCenter"
    ADD CONSTRAINT "CostCenter_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "CostCenter_archivedByUserId_companyId_fkey"
        FOREIGN KEY ("archivedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PayrollPeriod: reopen + ledger denormalized fields
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollPeriod"
    ADD COLUMN IF NOT EXISTS "reopenedByUserId" TEXT,
    ADD COLUMN IF NOT EXISTS "reopenedAt" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "reopenReason" TEXT,
    ADD COLUMN IF NOT EXISTS "ledgerPostedAt" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "ledgerPostingId" TEXT;

ALTER TABLE "PayrollPeriod"
    ADD CONSTRAINT "PayrollPeriod_reopen_reason_len_check"
        CHECK ("reopenReason" IS NULL OR char_length(btrim("reopenReason")) BETWEEN 1 AND 500);

ALTER TABLE "PayrollPeriod"
    ADD CONSTRAINT "PayrollPeriod_reopenedByUserId_companyId_fkey"
        FOREIGN KEY ("reopenedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PayrollItem: tenant composite identity for child FKs
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollItem_id_companyId_key"
    ON "PayrollItem"("id", "companyId");

-- ---------------------------------------------------------------------------
-- JournalEntry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "entryDate" DATE NOT NULL,
    "reference" TEXT,
    "memo" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "totalDebit" DECIMAL(18, 2) NOT NULL,
    "totalCredit" DECIMAL(18, 2) NOT NULL,
    "postedAt" TIMESTAMPTZ(3),
    "postedByUserId" TEXT,
    "reversedAt" TIMESTAMPTZ(3),
    "reversedByUserId" TEXT,
    "reversesJournalEntryId" TEXT,
    "idempotencyKey" TEXT,
    "sourceType" TEXT,
    "sourcePayrollPeriodId" TEXT,
    "sourceCalculationVersion" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "JournalEntry"
    ADD CONSTRAINT "JournalEntry_status_check"
        CHECK ("status" IN ('draft', 'posted', 'reversed')),
    ADD CONSTRAINT "JournalEntry_currency_format_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "JournalEntry_totals_nonneg_check"
        CHECK ("totalDebit" >= 0 AND "totalCredit" >= 0),
    ADD CONSTRAINT "JournalEntry_sourceType_check"
        CHECK ("sourceType" IS NULL OR "sourceType" IN ('manual', 'payroll')),
    ADD CONSTRAINT "JournalEntry_idempotencyKey_len_check"
        CHECK ("idempotencyKey" IS NULL OR char_length(btrim("idempotencyKey")) BETWEEN 8 AND 120),
    ADD CONSTRAINT "JournalEntry_reference_len_check"
        CHECK ("reference" IS NULL OR char_length(btrim("reference")) BETWEEN 1 AND 120),
    ADD CONSTRAINT "JournalEntry_memo_len_check"
        CHECK ("memo" IS NULL OR char_length(btrim("memo")) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_id_companyId_key"
    ON "JournalEntry"("id", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_companyId_idempotencyKey_key"
    ON "JournalEntry"("companyId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "idx_JournalEntry_company_status_entryDate"
    ON "JournalEntry"("companyId", "status", "entryDate");

CREATE INDEX IF NOT EXISTS "idx_JournalEntry_company_source"
    ON "JournalEntry"("companyId", "sourceType", "sourcePayrollPeriodId");

CREATE INDEX IF NOT EXISTS "idx_JournalEntry_company_createdAt"
    ON "JournalEntry"("companyId", "createdAt");

ALTER TABLE "JournalEntry"
    ADD CONSTRAINT "JournalEntry_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntry_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntry_postedByUserId_companyId_fkey"
        FOREIGN KEY ("postedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntry_reversedByUserId_companyId_fkey"
        FOREIGN KEY ("reversedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntry_reversesJournalEntryId_companyId_fkey"
        FOREIGN KEY ("reversesJournalEntryId", "companyId")
        REFERENCES "JournalEntry"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntry_sourcePayrollPeriodId_companyId_fkey"
        FOREIGN KEY ("sourcePayrollPeriodId", "companyId")
        REFERENCES "PayrollPeriod"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- JournalEntryLine
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "JournalEntryLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "debit" DECIMAL(18, 2) NOT NULL,
    "credit" DECIMAL(18, 2) NOT NULL,
    "lineMemo" TEXT,
    CONSTRAINT "JournalEntryLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "JournalEntryLine"
    ADD CONSTRAINT "JournalEntryLine_one_side_check"
        CHECK (
            ("debit" > 0 AND "credit" = 0)
            OR ("credit" > 0 AND "debit" = 0)
        ),
    ADD CONSTRAINT "JournalEntryLine_lineNo_positive_check"
        CHECK ("lineNo" > 0),
    ADD CONSTRAINT "JournalEntryLine_lineMemo_len_check"
        CHECK ("lineMemo" IS NULL OR char_length(btrim("lineMemo")) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntryLine_journalEntryId_lineNo_key"
    ON "JournalEntryLine"("journalEntryId", "lineNo");

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntryLine_id_companyId_key"
    ON "JournalEntryLine"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_JournalEntryLine_company_entry"
    ON "JournalEntryLine"("companyId", "journalEntryId");

CREATE INDEX IF NOT EXISTS "idx_JournalEntryLine_company_account"
    ON "JournalEntryLine"("companyId", "accountId");

CREATE INDEX IF NOT EXISTS "idx_JournalEntryLine_company_costCenter"
    ON "JournalEntryLine"("companyId", "costCenterId");

ALTER TABLE "JournalEntryLine"
    ADD CONSTRAINT "JournalEntryLine_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntryLine_journalEntryId_companyId_fkey"
        FOREIGN KEY ("journalEntryId", "companyId")
        REFERENCES "JournalEntry"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntryLine_accountId_companyId_fkey"
        FOREIGN KEY ("accountId", "companyId")
        REFERENCES "ChartOfAccount"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "JournalEntryLine_costCenterId_companyId_fkey"
        FOREIGN KEY ("costCenterId", "companyId")
        REFERENCES "CostCenter"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PayrollLedgerPosting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PayrollLedgerPosting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "calculationVersion" INTEGER NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "postedByUserId" TEXT NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    CONSTRAINT "PayrollLedgerPosting_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollLedgerPosting"
    ADD CONSTRAINT "PayrollLedgerPosting_idempotencyKey_len_check"
        CHECK (char_length(btrim("idempotencyKey")) BETWEEN 8 AND 120),
    ADD CONSTRAINT "PayrollLedgerPosting_calculationVersion_positive_check"
        CHECK ("calculationVersion" > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollLedgerPosting_company_period_version_key"
    ON "PayrollLedgerPosting"("companyId", "payrollPeriodId", "calculationVersion");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollLedgerPosting_companyId_idempotencyKey_key"
    ON "PayrollLedgerPosting"("companyId", "idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollLedgerPosting_journalEntryId_companyId_key"
    ON "PayrollLedgerPosting"("journalEntryId", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollLedgerPosting_id_companyId_key"
    ON "PayrollLedgerPosting"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_PayrollLedgerPosting_company_period"
    ON "PayrollLedgerPosting"("companyId", "payrollPeriodId");

ALTER TABLE "PayrollLedgerPosting"
    ADD CONSTRAINT "PayrollLedgerPosting_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollLedgerPosting_payrollPeriodId_companyId_fkey"
        FOREIGN KEY ("payrollPeriodId", "companyId")
        REFERENCES "PayrollPeriod"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollLedgerPosting_journalEntryId_companyId_fkey"
        FOREIGN KEY ("journalEntryId", "companyId")
        REFERENCES "JournalEntry"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollLedgerPosting_postedByUserId_companyId_fkey"
        FOREIGN KEY ("postedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PayrollComponentDefinition
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PayrollComponentDefinition" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "calcMethod" TEXT NOT NULL,
    "fixedAmount" DECIMAL(18, 2),
    "rateBps" INTEGER,
    "percentageBasis" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "createdByUserId" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "archivedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PayrollComponentDefinition_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollComponentDefinition"
    ADD CONSTRAINT "PayrollComponentDefinition_type_check"
        CHECK ("componentType" IN ('allowance', 'deduction')),
    ADD CONSTRAINT "PayrollComponentDefinition_method_check"
        CHECK ("calcMethod" IN ('fixed', 'percentage')),
    ADD CONSTRAINT "PayrollComponentDefinition_status_check"
        CHECK ("status" IN ('active', 'archived')),
    ADD CONSTRAINT "PayrollComponentDefinition_currency_format_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "PayrollComponentDefinition_version_positive_check"
        CHECK ("version" > 0),
    ADD CONSTRAINT "PayrollComponentDefinition_calc_fields_check"
        CHECK (
            ("calcMethod" = 'fixed' AND "fixedAmount" IS NOT NULL AND "fixedAmount" > 0
                AND "rateBps" IS NULL AND "percentageBasis" IS NULL)
            OR ("calcMethod" = 'percentage' AND "rateBps" IS NOT NULL AND "rateBps" > 0 AND "rateBps" <= 100000
                AND "percentageBasis" = 'base_salary' AND "fixedAmount" IS NULL)
        ),
    ADD CONSTRAINT "PayrollComponentDefinition_archive_pair_check"
        CHECK (
            ("status" = 'active' AND "archivedAt" IS NULL AND "archivedByUserId" IS NULL)
            OR ("status" = 'archived' AND "archivedAt" IS NOT NULL AND "archivedByUserId" IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollComponentDefinition_companyId_code_key"
    ON "PayrollComponentDefinition"("companyId", "code");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollComponentDefinition_id_companyId_key"
    ON "PayrollComponentDefinition"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_PayrollComponentDefinition_company_status_type"
    ON "PayrollComponentDefinition"("companyId", "status", "componentType");

ALTER TABLE "PayrollComponentDefinition"
    ADD CONSTRAINT "PayrollComponentDefinition_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollComponentDefinition_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollComponentDefinition_archivedByUserId_companyId_fkey"
        FOREIGN KEY ("archivedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PayrollItemComponentLine (calculation snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PayrollItemComponentLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollItemId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "definitionId" TEXT,
    "definitionCode" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "componentType" TEXT NOT NULL,
    "calcMethod" TEXT NOT NULL,
    "percentageBasis" TEXT,
    "rateBps" INTEGER,
    "fixedAmountSnapshot" DECIMAL(18, 2),
    "amount" DECIMAL(18, 2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollItemComponentLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollItemComponentLine"
    ADD CONSTRAINT "PayrollItemComponentLine_amount_nonneg_check"
        CHECK ("amount" >= 0),
    ADD CONSTRAINT "PayrollItemComponentLine_type_check"
        CHECK ("componentType" IN ('allowance', 'deduction')),
    ADD CONSTRAINT "PayrollItemComponentLine_method_check"
        CHECK ("calcMethod" IN ('fixed', 'percentage'));

CREATE INDEX IF NOT EXISTS "idx_PayrollItemComponentLine_company_item"
    ON "PayrollItemComponentLine"("companyId", "payrollItemId");

CREATE INDEX IF NOT EXISTS "idx_PayrollItemComponentLine_company_period_employee"
    ON "PayrollItemComponentLine"("companyId", "payrollPeriodId", "employeeId");

CREATE INDEX IF NOT EXISTS "idx_PayrollItemComponentLine_company_definition"
    ON "PayrollItemComponentLine"("companyId", "definitionId");

ALTER TABLE "PayrollItemComponentLine"
    ADD CONSTRAINT "PayrollItemComponentLine_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemComponentLine_payrollItemId_companyId_fkey"
        FOREIGN KEY ("payrollItemId", "companyId")
        REFERENCES "PayrollItem"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemComponentLine_payrollPeriodId_companyId_fkey"
        FOREIGN KEY ("payrollPeriodId", "companyId")
        REFERENCES "PayrollPeriod"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemComponentLine_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId")
        REFERENCES "Employee"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemComponentLine_definitionId_companyId_fkey"
        FOREIGN KEY ("definitionId", "companyId")
        REFERENCES "PayrollComponentDefinition"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PayrollItemAdjustment
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PayrollItemAdjustment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payrollItemId" TEXT,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(18, 2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "idempotencyKey" TEXT NOT NULL,
    CONSTRAINT "PayrollItemAdjustment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollItemAdjustment"
    ADD CONSTRAINT "PayrollItemAdjustment_direction_check"
        CHECK ("direction" IN ('allowance', 'deduction')),
    ADD CONSTRAINT "PayrollItemAdjustment_status_check"
        CHECK ("status" IN ('applied', 'superseded')),
    ADD CONSTRAINT "PayrollItemAdjustment_amount_positive_check"
        CHECK ("amount" > 0),
    ADD CONSTRAINT "PayrollItemAdjustment_reason_len_check"
        CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500),
    ADD CONSTRAINT "PayrollItemAdjustment_idempotencyKey_len_check"
        CHECK (char_length(btrim("idempotencyKey")) BETWEEN 8 AND 120);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollItemAdjustment_companyId_idempotencyKey_key"
    ON "PayrollItemAdjustment"("companyId", "idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollItemAdjustment_id_companyId_key"
    ON "PayrollItemAdjustment"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_PayrollItemAdjustment_company_period_employee_status"
    ON "PayrollItemAdjustment"("companyId", "payrollPeriodId", "employeeId", "status");

CREATE INDEX IF NOT EXISTS "idx_PayrollItemAdjustment_company_item"
    ON "PayrollItemAdjustment"("companyId", "payrollItemId");

ALTER TABLE "PayrollItemAdjustment"
    ADD CONSTRAINT "PayrollItemAdjustment_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemAdjustment_payrollPeriodId_companyId_fkey"
        FOREIGN KEY ("payrollPeriodId", "companyId")
        REFERENCES "PayrollPeriod"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemAdjustment_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId")
        REFERENCES "Employee"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemAdjustment_payrollItemId_companyId_fkey"
        FOREIGN KEY ("payrollItemId", "companyId")
        REFERENCES "PayrollItem"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollItemAdjustment_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
