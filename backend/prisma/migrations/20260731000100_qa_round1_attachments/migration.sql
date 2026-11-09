-- QA Round 1 attachments (DB-backed bytea). Requires Staging redeploy + migrate.

CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "storageBytes" BYTEA NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "chatMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Attachment_id_companyId_key" ON "Attachment"("id", "companyId");
CREATE INDEX "Attachment_companyId_purpose_createdAt_idx" ON "Attachment"("companyId", "purpose", "createdAt");
CREATE INDEX "Attachment_companyId_purchaseOrderId_idx" ON "Attachment"("companyId", "purchaseOrderId");
CREATE INDEX "Attachment_companyId_chatMessageId_idx" ON "Attachment"("companyId", "chatMessageId");
CREATE INDEX "Attachment_uploadedByUserId_idx" ON "Attachment"("uploadedByUserId");
CREATE INDEX "Attachment_sha256_idx" ON "Attachment"("sha256");

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedByUserId_companyId_fkey" FOREIGN KEY ("uploadedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_purchaseOrderId_companyId_fkey" FOREIGN KEY ("purchaseOrderId", "companyId") REFERENCES "PurchaseOrder"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_chatMessageId_companyId_fkey" FOREIGN KEY ("chatMessageId", "companyId") REFERENCES "ChatMessage"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
