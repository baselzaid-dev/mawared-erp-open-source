-- AlterTable
ALTER TABLE "PayrollPeriod" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "calculatedAt" TIMESTAMP(3),
ADD COLUMN     "calculatedByUserId" TEXT,
ADD COLUMN     "calculationFingerprint" TEXT,
ADD COLUMN     "calculationVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paidByUserId" TEXT;

-- CreateTable
CREATE TABLE "SalaryRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "baseSalary" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salaryRecordId" TEXT NOT NULL,
    "employeeNameSnapshot" TEXT NOT NULL,
    "employeeNumSnapshot" TEXT NOT NULL,
    "departmentNameSnapshot" TEXT,
    "baseSalary" DECIMAL(18,2) NOT NULL,
    "grossPay" DECIMAL(18,2) NOT NULL,
    "totalDeductions" DECIMAL(18,2) NOT NULL,
    "netPay" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "status" TEXT NOT NULL DEFAULT 'calculated',
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalaryRecord_companyId_employeeId_effectiveFrom_idx" ON "SalaryRecord"("companyId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "SalaryRecord_companyId_effectiveTo_idx" ON "SalaryRecord"("companyId", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRecord_employeeId_effectiveFrom_key" ON "SalaryRecord"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PayrollItem_companyId_payrollPeriodId_idx" ON "PayrollItem"("companyId", "payrollPeriodId");

-- CreateIndex
CREATE INDEX "PayrollItem_companyId_employeeId_idx" ON "PayrollItem"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollItem_companyId_status_idx" ON "PayrollItem"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_payrollPeriodId_employeeId_key" ON "PayrollItem"("payrollPeriodId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollPeriod_companyId_status_idx" ON "PayrollPeriod"("companyId", "status");

-- Refuse an unsafe deploy if legacy data contains duplicate company periods.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "PayrollPeriod"
        GROUP BY "companyId", "year", "month"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate PayrollPeriod rows must be resolved before this migration';
    END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_companyId_year_month_key" ON "PayrollPeriod"("companyId", "year", "month");

-- AddForeignKey
ALTER TABLE "SalaryRecord" ADD CONSTRAINT "SalaryRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryRecord" ADD CONSTRAINT "SalaryRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryRecord" ADD CONSTRAINT "SalaryRecord_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_calculatedByUserId_fkey" FOREIGN KEY ("calculatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_salaryRecordId_fkey" FOREIGN KEY ("salaryRecordId") REFERENCES "SalaryRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Salary history invariants that Prisma cannot express in the data model.
ALTER TABLE "SalaryRecord"
    ADD CONSTRAINT "SalaryRecord_baseSalary_nonnegative_check" CHECK ("baseSalary" >= 0),
    ADD CONSTRAINT "SalaryRecord_currency_sar_check" CHECK ("currency" = 'SAR'),
    ADD CONSTRAINT "SalaryRecord_effective_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

CREATE UNIQUE INDEX "SalaryRecord_one_open_record_per_employee_key"
    ON "SalaryRecord"("companyId", "employeeId")
    WHERE "effectiveTo" IS NULL;

-- Payroll item snapshots are internally consistent before Sprint 6B uses them.
ALTER TABLE "PayrollItem"
    ADD CONSTRAINT "PayrollItem_baseSalary_nonnegative_check" CHECK ("baseSalary" >= 0),
    ADD CONSTRAINT "PayrollItem_grossPay_nonnegative_check" CHECK ("grossPay" >= 0),
    ADD CONSTRAINT "PayrollItem_totalDeductions_nonnegative_check" CHECK ("totalDeductions" >= 0),
    ADD CONSTRAINT "PayrollItem_netPay_nonnegative_check" CHECK ("netPay" >= 0),
    ADD CONSTRAINT "PayrollItem_netPay_consistency_check" CHECK ("netPay" = "grossPay" - "totalDeductions"),
    ADD CONSTRAINT "PayrollItem_currency_sar_check" CHECK ("currency" = 'SAR'),
    ADD CONSTRAINT "PayrollItem_status_check" CHECK ("status" IN ('calculated', 'approved', 'paid'));

ALTER TABLE "PayrollPeriod"
    ADD CONSTRAINT "PayrollPeriod_calculationVersion_nonnegative_check" CHECK ("calculationVersion" >= 0);
