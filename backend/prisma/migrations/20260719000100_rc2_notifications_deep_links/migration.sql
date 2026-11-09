-- Sprint 12E M04: Notification deep-link fields + preferences.
-- Additive expand. Legacy Notifications remain renderable without descriptors.
-- Existing rows default category=general with null deep-link fields.
-- isRead remains authoritative for compatibility; readAt dual-writes on mark-read.

BEGIN;

ALTER TABLE "Notification"
    ADD COLUMN "category" TEXT NOT NULL DEFAULT 'general',
    ADD COLUMN "routeKey" TEXT,
    ADD COLUMN "resourceType" TEXT,
    ADD COLUMN "resourceId" TEXT,
    ADD COLUMN "filterJson" TEXT,
    ADD COLUMN "readAt" TIMESTAMPTZ(3),
    ADD COLUMN "hiddenAt" TIMESTAMPTZ(3);

UPDATE "Notification"
SET "readAt" = "updatedAt"
WHERE "isRead" = TRUE AND "readAt" IS NULL;

CREATE INDEX "Notification_userId_hiddenAt_createdAt_idx"
    ON "Notification"("userId", "hiddenAt", "createdAt");

CREATE INDEX "Notification_userId_category_createdAt_idx"
    ON "Notification"("userId", "category", "createdAt");

CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_companyId_userId_category_key"
    ON "NotificationPreference"("companyId", "userId", "category");

CREATE INDEX "NotificationPreference_userId_category_idx"
    ON "NotificationPreference"("userId", "category");

ALTER TABLE "NotificationPreference"
    ADD CONSTRAINT "NotificationPreference_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "NotificationPreference_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
