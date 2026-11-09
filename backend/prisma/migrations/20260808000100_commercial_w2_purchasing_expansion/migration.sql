-- Commercial Wave 2 — Operations Slice E1: purchasing lifecycle expansion (additive only).
--
-- Adds supplier quotations, immutable goods-receipt events, and supplier returns.
-- Quantities are DECIMAL(18,3); money is DECIMAL(18,2).
-- Every new table carries "companyId" and composite tenant foreign keys so a row can
-- never reference another company's record.
--
-- Data-safety boundary: no DROP TABLE, DROP COLUMN, DROP INDEX, DROP SCHEMA,
-- TRUNCATE or DELETE FROM. The only DROP used is `DROP CONSTRAINT IF EXISTS` on
-- two CHECK constraints, each immediately replaced by a strict superset, so no
-- existing row can fail validation and no data is lost.

BEGIN;

-- ---------------------------------------------------------------------------
-- PurchaseOrderLine: composite tenant key required by receipt/return line FKs
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrderLine_id_companyId_key"
    ON "PurchaseOrderLine"("id", "companyId");

-- ---------------------------------------------------------------------------
-- PurchaseWorkflowEvent: widen the entity/action vocabulary for Wave 2.
--
-- Both replacements are strict supersets of the previous predicates, so no
-- existing row can fail validation. Postgres has no in-place "widen CHECK".
-- ---------------------------------------------------------------------------
ALTER TABLE "PurchaseWorkflowEvent"
    DROP CONSTRAINT IF EXISTS "PurchaseWorkflowEvent_entityType_check",
    DROP CONSTRAINT IF EXISTS "PurchaseWorkflowEvent_action_check";

ALTER TABLE "PurchaseWorkflowEvent"
    ADD CONSTRAINT "PurchaseWorkflowEvent_entityType_check"
        CHECK ("entityType" IN (
            'purchase_request',
            'purchase_order',
            'supplier_quotation',
            'purchase_return'
        )),
    ADD CONSTRAINT "PurchaseWorkflowEvent_action_check"
        CHECK ("action" IN (
            'override_approve',
            'override_reject',
            'override_cancel',
            'quotation_create',
            'quotation_update',
            'quotation_submit',
            'quotation_select',
            'quotation_reject',
            'order_receive_partial',
            'return_create',
            'return_approve',
            'return_reject'
        ));

-- Idempotency payload fingerprint for the W2 workflow-event-backed mutations
-- (quotation create/select, return review). Binds the company-scoped idempotency
-- key to the full logical request, so a same-key retry with a different payload
-- returns 409 instead of a false replay. Nullable: pre-W2 events (admin overrides)
-- and any legacy rows stay NULL and are unaffected.
ALTER TABLE "PurchaseWorkflowEvent"
    ADD COLUMN IF NOT EXISTS "payloadFingerprint" TEXT;

-- ---------------------------------------------------------------------------
-- SupplierQuotation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SupplierQuotation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "quotationNumber" TEXT NOT NULL,
    "purchaseRequestId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorNameSnapshot" TEXT NOT NULL,
    "supplierReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "subtotal" DECIMAL(18,2) NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "quotationDate" DATE,
    "validUntilDate" DATE,
    "expectedDeliveryDate" DATE,
    "leadTimeDays" INTEGER,
    "paymentTerms" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),
    "selectedByUserId" TEXT,
    "selectedAt" TIMESTAMPTZ(3),
    "selectionReason" TEXT,
    "rejectedByUserId" TEXT,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "SupplierQuotation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SupplierQuotation"
    ADD CONSTRAINT "SupplierQuotation_status_check"
        CHECK ("status" IN ('draft', 'submitted', 'selected', 'rejected')),
    ADD CONSTRAINT "SupplierQuotation_version_check"
        CHECK ("version" >= 1),
    ADD CONSTRAINT "SupplierQuotation_amount_check"
        CHECK ("subtotal" >= 0 AND "totalAmount" >= 0),
    ADD CONSTRAINT "SupplierQuotation_lead_time_check"
        CHECK ("leadTimeDays" IS NULL OR ("leadTimeDays" >= 0 AND "leadTimeDays" <= 3650)),
    ADD CONSTRAINT "SupplierQuotation_selected_pair_check"
        CHECK (
            ("status" <> 'selected')
            OR ("selectedAt" IS NOT NULL AND "selectedByUserId" IS NOT NULL)
        ),
    ADD CONSTRAINT "SupplierQuotation_rejected_pair_check"
        CHECK (
            ("status" <> 'rejected')
            OR ("rejectedAt" IS NOT NULL AND "rejectedByUserId" IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierQuotation_id_companyId_key"
    ON "SupplierQuotation"("id", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierQuotation_companyId_quotationNumber_key"
    ON "SupplierQuotation"("companyId", "quotationNumber");

-- Exactly one winning quotation per purchase request, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierQuotation_company_request_selected_key"
    ON "SupplierQuotation"("companyId", "purchaseRequestId")
    WHERE "status" = 'selected';

CREATE INDEX IF NOT EXISTS "idx_SupplierQuotation_company_request_status"
    ON "SupplierQuotation"("companyId", "purchaseRequestId", "status");

CREATE INDEX IF NOT EXISTS "idx_SupplierQuotation_company_vendor_status"
    ON "SupplierQuotation"("companyId", "vendorId", "status");

CREATE INDEX IF NOT EXISTS "idx_SupplierQuotation_company_status_createdAt"
    ON "SupplierQuotation"("companyId", "status", "createdAt");

ALTER TABLE "SupplierQuotation"
    ADD CONSTRAINT "SupplierQuotation_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotation_purchaseRequestId_companyId_fkey"
        FOREIGN KEY ("purchaseRequestId", "companyId")
        REFERENCES "PurchaseRequest"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotation_vendorId_companyId_fkey"
        FOREIGN KEY ("vendorId", "companyId")
        REFERENCES "Vendor"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotation_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotation_selectedByUserId_companyId_fkey"
        FOREIGN KEY ("selectedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotation_rejectedByUserId_companyId_fkey"
        FOREIGN KEY ("rejectedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SupplierQuotationLine
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SupplierQuotationLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierQuotationId" TEXT NOT NULL,
    "requestLineId" TEXT,
    "descriptionSnapshot" TEXT NOT NULL,
    "categorySnapshot" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitSnapshot" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "SupplierQuotationLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SupplierQuotationLine"
    ADD CONSTRAINT "SupplierQuotationLine_quantity_check"
        CHECK ("quantity" > 0),
    ADD CONSTRAINT "SupplierQuotationLine_price_check"
        CHECK ("unitPrice" >= 0 AND "lineTotal" >= 0),
    ADD CONSTRAINT "SupplierQuotationLine_lead_time_check"
        CHECK ("leadTimeDays" IS NULL OR ("leadTimeDays" >= 0 AND "leadTimeDays" <= 3650));

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierQuotationLine_id_companyId_key"
    ON "SupplierQuotationLine"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_SupplierQuotationLine_company_quotation"
    ON "SupplierQuotationLine"("companyId", "supplierQuotationId");

CREATE INDEX IF NOT EXISTS "idx_SupplierQuotationLine_company_requestLine"
    ON "SupplierQuotationLine"("companyId", "requestLineId");

ALTER TABLE "SupplierQuotationLine"
    ADD CONSTRAINT "SupplierQuotationLine_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotationLine_supplierQuotationId_companyId_fkey"
        FOREIGN KEY ("supplierQuotationId", "companyId")
        REFERENCES "SupplierQuotation"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "SupplierQuotationLine_requestLineId_companyId_fkey"
        FOREIGN KEY ("requestLineId", "companyId")
        REFERENCES "PurchaseRequestLine"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseOrder: 'partially_received' status + selected-quotation traceability
--
-- Widening a CHECK constraint is an expand-only operation: the new predicate
-- accepts every value the old one accepted plus 'partially_received', so no
-- existing row can fail validation and no data is dropped. Postgres has no
-- in-place "widen CHECK", so the constraint is replaced.
-- ---------------------------------------------------------------------------
ALTER TABLE "PurchaseOrder"
    DROP CONSTRAINT IF EXISTS "PurchaseOrder_status_check";

ALTER TABLE "PurchaseOrder"
    ADD CONSTRAINT "PurchaseOrder_status_check"
        CHECK ("status" IN ('draft', 'issued', 'partially_received', 'received', 'cancelled'));

ALTER TABLE "PurchaseOrder"
    ADD COLUMN IF NOT EXISTS "supplierQuotationId" TEXT;

CREATE INDEX IF NOT EXISTS "idx_PurchaseOrder_company_quotation"
    ON "PurchaseOrder"("companyId", "supplierQuotationId");

ALTER TABLE "PurchaseOrder"
    ADD CONSTRAINT "PurchaseOrder_supplierQuotationId_companyId_fkey"
        FOREIGN KEY ("supplierQuotationId", "companyId")
        REFERENCES "SupplierQuotation"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseReceipt (immutable goods-receipt event)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PurchaseReceipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "receiptKind" TEXT NOT NULL DEFAULT 'partial',
    "referenceNumber" TEXT,
    "note" TEXT,
    "receivedByUserId" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overrideApplied" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseReceipt"
    ADD CONSTRAINT "PurchaseReceipt_kind_check"
        CHECK ("receiptKind" IN ('partial', 'full')),
    ADD CONSTRAINT "PurchaseReceipt_override_pair_check"
        CHECK ("overrideApplied" = false OR "overrideReason" IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReceipt_id_companyId_key"
    ON "PurchaseReceipt"("id", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReceipt_companyId_receiptNumber_key"
    ON "PurchaseReceipt"("companyId", "receiptNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReceipt_companyId_idempotencyKey_key"
    ON "PurchaseReceipt"("companyId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "idx_PurchaseReceipt_company_order_receivedAt"
    ON "PurchaseReceipt"("companyId", "purchaseOrderId", "receivedAt");

ALTER TABLE "PurchaseReceipt"
    ADD CONSTRAINT "PurchaseReceipt_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReceipt_purchaseOrderId_companyId_fkey"
        FOREIGN KEY ("purchaseOrderId", "companyId")
        REFERENCES "PurchaseOrder"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReceipt_receivedByUserId_companyId_fkey"
        FOREIGN KEY ("receivedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseReceiptLine
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PurchaseReceiptLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseReceiptLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseReceiptLine"
    ADD CONSTRAINT "PurchaseReceiptLine_quantity_check"
        CHECK ("quantity" > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReceiptLine_id_companyId_key"
    ON "PurchaseReceiptLine"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_PurchaseReceiptLine_company_receipt"
    ON "PurchaseReceiptLine"("companyId", "purchaseReceiptId");

CREATE INDEX IF NOT EXISTS "idx_PurchaseReceiptLine_company_orderLine"
    ON "PurchaseReceiptLine"("companyId", "purchaseOrderLineId");

ALTER TABLE "PurchaseReceiptLine"
    ADD CONSTRAINT "PurchaseReceiptLine_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReceiptLine_purchaseReceiptId_companyId_fkey"
        FOREIGN KEY ("purchaseReceiptId", "companyId")
        REFERENCES "PurchaseReceipt"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReceiptLine_purchaseOrderLineId_companyId_fkey"
        FOREIGN KEY ("purchaseOrderLineId", "companyId")
        REFERENCES "PurchaseOrderLine"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseReturn
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PurchaseReturn" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewNote" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseReturn"
    ADD CONSTRAINT "PurchaseReturn_status_check"
        CHECK ("status" IN ('pending_approval', 'approved', 'rejected')),
    ADD CONSTRAINT "PurchaseReturn_reason_code_check"
        CHECK ("reasonCode" IN ('damaged', 'wrong_item', 'excess_quantity', 'quality_rejected', 'expired', 'other')),
    ADD CONSTRAINT "PurchaseReturn_review_pair_check"
        CHECK (
            ("status" = 'pending_approval' AND "reviewedAt" IS NULL AND "reviewedByUserId" IS NULL)
            OR ("status" <> 'pending_approval' AND "reviewedAt" IS NOT NULL AND "reviewedByUserId" IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReturn_id_companyId_key"
    ON "PurchaseReturn"("id", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReturn_companyId_returnNumber_key"
    ON "PurchaseReturn"("companyId", "returnNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReturn_companyId_idempotencyKey_key"
    ON "PurchaseReturn"("companyId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "idx_PurchaseReturn_company_order_status"
    ON "PurchaseReturn"("companyId", "purchaseOrderId", "status");

ALTER TABLE "PurchaseReturn"
    ADD CONSTRAINT "PurchaseReturn_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReturn_purchaseOrderId_companyId_fkey"
        FOREIGN KEY ("purchaseOrderId", "companyId")
        REFERENCES "PurchaseOrder"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReturn_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReturn_reviewedByUserId_companyId_fkey"
        FOREIGN KEY ("reviewedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseReturnLine
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PurchaseReturnLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseReturnId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseReturnLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseReturnLine"
    ADD CONSTRAINT "PurchaseReturnLine_quantity_check"
        CHECK ("quantity" > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReturnLine_id_companyId_key"
    ON "PurchaseReturnLine"("id", "companyId");

CREATE INDEX IF NOT EXISTS "idx_PurchaseReturnLine_company_return"
    ON "PurchaseReturnLine"("companyId", "purchaseReturnId");

CREATE INDEX IF NOT EXISTS "idx_PurchaseReturnLine_company_orderLine"
    ON "PurchaseReturnLine"("companyId", "purchaseOrderLineId");

ALTER TABLE "PurchaseReturnLine"
    ADD CONSTRAINT "PurchaseReturnLine_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReturnLine_purchaseReturnId_companyId_fkey"
        FOREIGN KEY ("purchaseReturnId", "companyId")
        REFERENCES "PurchaseReturn"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PurchaseReturnLine_purchaseOrderLineId_companyId_fkey"
        FOREIGN KEY ("purchaseOrderLineId", "companyId")
        REFERENCES "PurchaseOrderLine"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
