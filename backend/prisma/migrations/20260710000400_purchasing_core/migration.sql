-- Sprint 9 purchasing foundation. Additive only: all legacy vendor rows are retained.

ALTER TABLE "Vendor"
    ADD COLUMN "email" TEXT,
    ADD COLUMN "taxNumber" TEXT,
    ADD COLUMN "category" TEXT,
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN "createdByUserId" TEXT,
    ADD COLUMN "deactivatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Vendor_id_companyId_key" ON "Vendor"("id", "companyId");
CREATE INDEX "Vendor_companyId_status_name_idx" ON "Vendor"("companyId", "status", "name");
CREATE INDEX "Vendor_createdByUserId_idx" ON "Vendor"("createdByUserId");
CREATE UNIQUE INDEX "Vendor_companyId_active_name_key"
    ON "Vendor"("companyId", lower(btrim("name"))) WHERE "status" = 'active';

ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_status_check"
    CHECK ("status" IN ('active', 'inactive'));

CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "requestedByEmployeeId" TEXT NOT NULL,
    "requesterNameSnapshot" TEXT NOT NULL,
    "requesterNumSnapshot" TEXT NOT NULL,
    "departmentId" TEXT,
    "departmentNameSnapshot" TEXT,
    "title" TEXT NOT NULL,
    "justification" TEXT,
    "neededByDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'pending_department',
    "totalEstimated" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "departmentReviewedByUserId" TEXT,
    "departmentReviewedAt" TIMESTAMP(3),
    "departmentReviewNote" TEXT,
    "purchasingReviewedByUserId" TEXT,
    "purchasingReviewedAt" TIMESTAMP(3),
    "purchasingReviewNote" TEXT,
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseRequestLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseRequestId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "estimatedUnitPrice" DECIMAL(18,2) NOT NULL,
    "estimatedTotal" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseRequestLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "purchaseRequestId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorNameSnapshot" TEXT NOT NULL,
    "vendorContactSnapshot" TEXT,
    "vendorEmailSnapshot" TEXT,
    "vendorTaxNumberSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "subtotal" DECIMAL(18,2) NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "issuedByUserId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "receivedByUserId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receiptNote" TEXT,
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "requestLineId" TEXT,
    "descriptionSnapshot" TEXT NOT NULL,
    "categorySnapshot" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitSnapshot" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseRequest_companyId_requestNumber_key" ON "PurchaseRequest"("companyId", "requestNumber");
CREATE UNIQUE INDEX "PurchaseRequest_id_companyId_key" ON "PurchaseRequest"("id", "companyId");
CREATE INDEX "PurchaseRequest_companyId_status_createdAt_idx" ON "PurchaseRequest"("companyId", "status", "createdAt");
CREATE INDEX "PurchaseRequest_requestedByEmployeeId_status_idx" ON "PurchaseRequest"("requestedByEmployeeId", "status");
CREATE INDEX "PurchaseRequest_departmentId_status_idx" ON "PurchaseRequest"("departmentId", "status");
CREATE INDEX "PurchaseRequest_neededByDate_idx" ON "PurchaseRequest"("neededByDate");

CREATE UNIQUE INDEX "PurchaseRequestLine_id_companyId_key" ON "PurchaseRequestLine"("id", "companyId");
CREATE INDEX "PurchaseRequestLine_companyId_purchaseRequestId_idx" ON "PurchaseRequestLine"("companyId", "purchaseRequestId");
CREATE INDEX "PurchaseRequestLine_purchaseRequestId_idx" ON "PurchaseRequestLine"("purchaseRequestId");

CREATE UNIQUE INDEX "PurchaseOrder_companyId_orderNumber_key" ON "PurchaseOrder"("companyId", "orderNumber");
CREATE UNIQUE INDEX "PurchaseOrder_id_companyId_key" ON "PurchaseOrder"("id", "companyId");
CREATE UNIQUE INDEX "PurchaseOrder_active_request_key" ON "PurchaseOrder"("companyId", "purchaseRequestId") WHERE "status" <> 'cancelled';
CREATE INDEX "PurchaseOrder_companyId_status_createdAt_idx" ON "PurchaseOrder"("companyId", "status", "createdAt");
CREATE INDEX "PurchaseOrder_vendorId_status_idx" ON "PurchaseOrder"("vendorId", "status");
CREATE INDEX "PurchaseOrder_purchaseRequestId_status_idx" ON "PurchaseOrder"("purchaseRequestId", "status");

CREATE INDEX "PurchaseOrderLine_companyId_purchaseOrderId_idx" ON "PurchaseOrderLine"("companyId", "purchaseOrderId");
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");
CREATE INDEX "PurchaseOrderLine_requestLineId_idx" ON "PurchaseOrderLine"("requestLineId");

ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_requestedByEmployeeId_companyId_fkey"
    FOREIGN KEY ("requestedByEmployeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_departmentId_companyId_fkey"
    FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_departmentReviewedByUserId_companyId_fkey"
    FOREIGN KEY ("departmentReviewedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_purchasingReviewedByUserId_companyId_fkey"
    FOREIGN KEY ("purchasingReviewedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_cancelledByUserId_companyId_fkey"
    FOREIGN KEY ("cancelledByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_purchaseRequestId_companyId_fkey"
    FOREIGN KEY ("purchaseRequestId", "companyId") REFERENCES "PurchaseRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_purchaseRequestId_companyId_fkey"
    FOREIGN KEY ("purchaseRequestId", "companyId") REFERENCES "PurchaseRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_companyId_fkey"
    FOREIGN KEY ("vendorId", "companyId") REFERENCES "Vendor"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdByUserId_companyId_fkey"
    FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_issuedByUserId_companyId_fkey"
    FOREIGN KEY ("issuedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_receivedByUserId_companyId_fkey"
    FOREIGN KEY ("receivedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_cancelledByUserId_companyId_fkey"
    FOREIGN KEY ("cancelledByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_companyId_fkey"
    FOREIGN KEY ("purchaseOrderId", "companyId") REFERENCES "PurchaseOrder"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_requestLineId_companyId_fkey"
    FOREIGN KEY ("requestLineId", "companyId") REFERENCES "PurchaseRequestLine"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequest"
    ADD CONSTRAINT "PurchaseRequest_status_check" CHECK ("status" IN ('pending_department', 'pending_purchasing', 'approved', 'rejected', 'cancelled', 'ordered', 'received')),
    ADD CONSTRAINT "PurchaseRequest_totalEstimated_check" CHECK ("totalEstimated" >= 0),
    ADD CONSTRAINT "PurchaseRequest_currency_check" CHECK ("currency" = 'SAR'),
    ADD CONSTRAINT "PurchaseRequest_title_check" CHECK (char_length(btrim("title")) > 0);

ALTER TABLE "PurchaseRequestLine"
    ADD CONSTRAINT "PurchaseRequestLine_quantity_check" CHECK ("quantity" > 0),
    ADD CONSTRAINT "PurchaseRequestLine_estimatedUnitPrice_check" CHECK ("estimatedUnitPrice" >= 0),
    ADD CONSTRAINT "PurchaseRequestLine_estimatedTotal_check" CHECK ("estimatedTotal" >= 0),
    ADD CONSTRAINT "PurchaseRequestLine_description_check" CHECK (char_length(btrim("description")) > 0);

ALTER TABLE "PurchaseOrder"
    ADD CONSTRAINT "PurchaseOrder_status_check" CHECK ("status" IN ('draft', 'issued', 'received', 'cancelled')),
    ADD CONSTRAINT "PurchaseOrder_subtotal_check" CHECK ("subtotal" >= 0),
    ADD CONSTRAINT "PurchaseOrder_totalAmount_check" CHECK ("totalAmount" >= 0),
    ADD CONSTRAINT "PurchaseOrder_currency_check" CHECK ("currency" = 'SAR');

ALTER TABLE "PurchaseOrderLine"
    ADD CONSTRAINT "PurchaseOrderLine_quantity_check" CHECK ("quantity" > 0),
    ADD CONSTRAINT "PurchaseOrderLine_unitPrice_check" CHECK ("unitPrice" >= 0),
    ADD CONSTRAINT "PurchaseOrderLine_lineTotal_check" CHECK ("lineTotal" >= 0),
    ADD CONSTRAINT "PurchaseOrderLine_description_check" CHECK (char_length(btrim("descriptionSnapshot")) > 0);

-- No Data API policies or grants are created. The trusted backend remains the entry point.
ALTER TABLE "Vendor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseRequestLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
