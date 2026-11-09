-- Sprint 12H M07: PayrollPayment ledger + period paymentVersion (additive).
-- Exact-decimal payments only. Legacy paid periods get one labeled migration payment.
-- No bank claim. No destructive rewrite of PayrollPeriod.status.

BEGIN;

-- ---------------------------------------------------------------------------
-- PayrollPeriod: optimistic concurrency for payment ledger mutations
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollPeriod"
    ADD COLUMN "paymentVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PayrollPeriod"
    ADD CONSTRAINT "PayrollPeriod_paymentVersion_nonneg_check"
        CHECK ("paymentVersion" >= 0);

-- Tenant-safe composite identity for payment FK
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_id_companyId_key"
    ON "PayrollPeriod"("id", "companyId");

-- ---------------------------------------------------------------------------
-- PayrollPayment
-- ---------------------------------------------------------------------------
CREATE TABLE "PayrollPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "amount" DECIMAL(18, 2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "paymentDate" DATE NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "idempotencyKey" TEXT NOT NULL,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "isLegacyMigration" BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT "PayrollPayment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollPayment"
    ADD CONSTRAINT "PayrollPayment_amount_positive_check"
        CHECK ("amount" > 0),
    ADD CONSTRAINT "PayrollPayment_currency_format_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "PayrollPayment_status_check"
        CHECK ("status" IN ('posted', 'voided')),
    ADD CONSTRAINT "PayrollPayment_reference_len_check"
        CHECK ("reference" IS NULL OR char_length(btrim("reference")) BETWEEN 1 AND 120),
    ADD CONSTRAINT "PayrollPayment_note_len_check"
        CHECK ("note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 500),
    ADD CONSTRAINT "PayrollPayment_void_pair_check"
        CHECK (
            ("status" = 'posted' AND "voidedAt" IS NULL AND "voidedByUserId" IS NULL AND "voidReason" IS NULL)
            OR ("status" = 'voided' AND "voidedAt" IS NOT NULL AND "voidedByUserId" IS NOT NULL
                AND "voidReason" IS NOT NULL AND char_length(btrim("voidReason")) BETWEEN 1 AND 500)
        ),
    ADD CONSTRAINT "PayrollPayment_idempotencyKey_len_check"
        CHECK (char_length(btrim("idempotencyKey")) BETWEEN 8 AND 120);

CREATE UNIQUE INDEX "PayrollPayment_company_period_idempotency_key"
    ON "PayrollPayment"("companyId", "payrollPeriodId", "idempotencyKey");

CREATE INDEX "idx_PayrollPayment_company_period_createdAt"
    ON "PayrollPayment"("companyId", "payrollPeriodId", "createdAt");

CREATE INDEX "idx_PayrollPayment_company_status_paymentDate"
    ON "PayrollPayment"("companyId", "status", "paymentDate");

ALTER TABLE "PayrollPayment"
    ADD CONSTRAINT "PayrollPayment_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollPayment_payrollPeriodId_companyId_fkey"
        FOREIGN KEY ("payrollPeriodId", "companyId")
        REFERENCES "PayrollPeriod"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollPayment_recordedByUserId_companyId_fkey"
        FOREIGN KEY ("recordedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PayrollPayment_voidedByUserId_companyId_fkey"
        FOREIGN KEY ("voidedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Legacy paid periods: one migration evidence payment = immutable approved net
-- ---------------------------------------------------------------------------
INSERT INTO "PayrollPayment" (
    "id",
    "companyId",
    "payrollPeriodId",
    "amount",
    "currency",
    "paymentDate",
    "reference",
    "note",
    "status",
    "idempotencyKey",
    "recordedByUserId",
    "createdAt",
    "isLegacyMigration"
)
SELECT
    'pp_legacy_' || md5(p."id"),
    p."companyId",
    p."id",
    COALESCE(SUM(i."netPay"), 0),
    COALESCE(MIN(i."currency"), 'SAR'),
    COALESCE(p."paidAt"::date, p."approvedAt"::date, p."updatedAt"::date),
    'LEGACY_M07_MIGRATION',
    'Migration evidence payment equal to immutable approved net total. Not a bank transfer.',
    'posted',
    'legacy-m07:' || p."id",
    COALESCE(p."paidByUserId", p."approvedByUserId", p."createdByUserId"),
    COALESCE(p."paidAt", p."approvedAt", p."updatedAt"),
    TRUE
FROM "PayrollPeriod" p
INNER JOIN "PayrollItem" i
    ON i."payrollPeriodId" = p."id" AND i."companyId" = p."companyId"
WHERE p."status" = 'paid'
  AND COALESCE(p."paidByUserId", p."approvedByUserId", p."createdByUserId") IS NOT NULL
GROUP BY
    p."id",
    p."companyId",
    p."paidAt",
    p."approvedAt",
    p."updatedAt",
    p."paidByUserId",
    p."approvedByUserId",
    p."createdByUserId"
HAVING COALESCE(SUM(i."netPay"), 0) > 0;

COMMIT;
