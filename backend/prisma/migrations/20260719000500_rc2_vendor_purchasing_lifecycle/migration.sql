-- Sprint 12I M08: Vendor archive/lifecycle + Purchase workflow events (additive).
-- No hard delete of vendors or purchase history.

BEGIN;

-- ---------------------------------------------------------------------------
-- Vendor lifecycle metadata
-- ---------------------------------------------------------------------------
ALTER TABLE "Vendor"
    ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
    ADD COLUMN "archivedByUserId" TEXT,
    ADD COLUMN "archiveReason" TEXT;

-- purchasing_core already constrained status to active|inactive; widen for archive.
ALTER TABLE "Vendor" DROP CONSTRAINT IF EXISTS "Vendor_status_check";

ALTER TABLE "Vendor"
    ADD CONSTRAINT "Vendor_lifecycleVersion_positive_check"
        CHECK ("lifecycleVersion" >= 1),
    ADD CONSTRAINT "Vendor_status_check"
        CHECK ("status" IN ('active', 'inactive', 'archived')),
    ADD CONSTRAINT "Vendor_archiveReason_check"
        CHECK ("archiveReason" IS NULL OR char_length(btrim("archiveReason")) BETWEEN 1 AND 500),
    ADD CONSTRAINT "Vendor_archive_pair_check"
        CHECK (
            ("archivedAt" IS NULL AND "archivedByUserId" IS NULL AND "archiveReason" IS NULL AND "status" <> 'archived')
            OR ("archivedAt" IS NOT NULL AND "archivedByUserId" IS NOT NULL AND "status" = 'archived')
        );

CREATE INDEX "idx_Vendor_company_archivedAt"
    ON "Vendor"("companyId", "archivedAt");

ALTER TABLE "Vendor"
    ADD CONSTRAINT "Vendor_archivedByUserId_companyId_fkey"
        FOREIGN KEY ("archivedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseWorkflowEvent (override / lifecycle history; immutable append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE "PurchaseWorkflowEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseWorkflowEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseWorkflowEvent"
    ADD CONSTRAINT "PurchaseWorkflowEvent_entityType_check"
        CHECK ("entityType" IN ('purchase_request', 'purchase_order')),
    ADD CONSTRAINT "PurchaseWorkflowEvent_action_check"
        CHECK ("action" IN (
            'override_approve',
            'override_reject',
            'override_cancel'
        )),
    ADD CONSTRAINT "PurchaseWorkflowEvent_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500),
    ADD CONSTRAINT "PurchaseWorkflowEvent_idempotencyKey_check"
        CHECK ("idempotencyKey" IS NULL OR char_length(btrim("idempotencyKey")) BETWEEN 8 AND 128);

CREATE UNIQUE INDEX "PurchaseWorkflowEvent_companyId_idempotencyKey_key"
    ON "PurchaseWorkflowEvent"("companyId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

CREATE INDEX "idx_PurchaseWorkflowEvent_entity"
    ON "PurchaseWorkflowEvent"("companyId", "entityType", "entityId", "createdAt");

CREATE INDEX "idx_PurchaseWorkflowEvent_actor"
    ON "PurchaseWorkflowEvent"("companyId", "actorUserId", "createdAt");

ALTER TABLE "PurchaseWorkflowEvent"
    ADD CONSTRAINT "PurchaseWorkflowEvent_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseWorkflowEvent_actorUserId_companyId_fkey"
        FOREIGN KEY ("actorUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
