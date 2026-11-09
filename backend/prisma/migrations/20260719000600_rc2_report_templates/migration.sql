-- Sprint 12J M09: SavedReportTemplate (additive).
-- Stores only built-in template key/version + validated filter/scope config.
-- Never SQL, ad-hoc joins, or export file blobs.

BEGIN;

CREATE TABLE "SavedReportTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "builtInKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "scopeKind" TEXT NOT NULL DEFAULT 'company',
    "departmentId" TEXT,
    "filtersJson" JSONB NOT NULL,
    "preferredFormat" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SavedReportTemplate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SavedReportTemplate"
    ADD CONSTRAINT "SavedReportTemplate_templateVersion_positive_check"
        CHECK ("templateVersion" >= 1),
    ADD CONSTRAINT "SavedReportTemplate_name_check"
        CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
    ADD CONSTRAINT "SavedReportTemplate_builtInKey_check"
        CHECK (char_length(btrim("builtInKey")) BETWEEN 1 AND 80),
    ADD CONSTRAINT "SavedReportTemplate_scopeKind_check"
        CHECK ("scopeKind" IN ('company', 'department')),
    ADD CONSTRAINT "SavedReportTemplate_preferredFormat_check"
        CHECK ("preferredFormat" IS NULL OR "preferredFormat" IN ('preview', 'csv', 'xlsx', 'pdf')),
    ADD CONSTRAINT "SavedReportTemplate_department_scope_check"
        CHECK (
            ("scopeKind" = 'company' AND "departmentId" IS NULL)
            OR ("scopeKind" = 'department' AND "departmentId" IS NOT NULL)
        );

CREATE UNIQUE INDEX "SavedReportTemplate_id_companyId_key"
    ON "SavedReportTemplate"("id", "companyId");

CREATE INDEX "idx_SavedReportTemplate_owner"
    ON "SavedReportTemplate"("companyId", "ownerUserId", "archivedAt");

CREATE INDEX "idx_SavedReportTemplate_key"
    ON "SavedReportTemplate"("companyId", "builtInKey");

ALTER TABLE "SavedReportTemplate"
    ADD CONSTRAINT "SavedReportTemplate_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SavedReportTemplate_ownerUserId_companyId_fkey"
        FOREIGN KEY ("ownerUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
