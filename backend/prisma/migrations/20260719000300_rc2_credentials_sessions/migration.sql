-- Sprint 12G M06: Credential, Employee archive, and session metadata (additive).
-- No plaintext secrets. Temporary passwords are never stored recoverable.
-- RefreshToken composite tenant-safe FK is applied only when all rows already match User(companyId).

BEGIN;

-- ---------------------------------------------------------------------------
-- User credential / account state
-- ---------------------------------------------------------------------------
ALTER TABLE "User"
    ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "temporaryPasswordExpiresAt" TIMESTAMPTZ(3),
    ADD COLUMN "passwordChangedAt" TIMESTAMPTZ(3),
    ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "User"
    ADD CONSTRAINT "User_accountStatus_check"
        CHECK ("accountStatus" IN ('active', 'disabled', 'archived')),
    ADD CONSTRAINT "User_credentialVersion_positive_check"
        CHECK ("credentialVersion" >= 1);

CREATE INDEX "idx_User_company_forced_password_change"
    ON "User"("companyId", "mustChangePassword")
    WHERE "mustChangePassword" = TRUE;

CREATE INDEX "idx_User_company_accountStatus"
    ON "User"("companyId", "accountStatus");

-- ---------------------------------------------------------------------------
-- Employee archive metadata (inactive/terminated are NOT auto-relabeled)
-- ---------------------------------------------------------------------------
ALTER TABLE "Employee"
    ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
    ADD COLUMN "archivedByUserId" TEXT,
    ADD COLUMN "archiveReason" TEXT;

ALTER TABLE "Employee"
    ADD CONSTRAINT "Employee_archiveReason_check"
        CHECK ("archiveReason" IS NULL OR char_length(btrim("archiveReason")) BETWEEN 1 AND 500),
    ADD CONSTRAINT "Employee_archive_pair_check"
        CHECK (
            ("archivedAt" IS NULL AND "archivedByUserId" IS NULL AND "archiveReason" IS NULL)
            OR ("archivedAt" IS NOT NULL AND "archivedByUserId" IS NOT NULL)
        );

CREATE INDEX "idx_Employee_company_archivedAt"
    ON "Employee"("companyId", "archivedAt");

ALTER TABLE "Employee"
    ADD CONSTRAINT "Employee_archivedByUserId_companyId_fkey"
        FOREIGN KEY ("archivedByUserId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RefreshToken public session id + device metadata + tenant-safe User FK
-- ---------------------------------------------------------------------------
ALTER TABLE "RefreshToken"
    ADD COLUMN "sessionId" TEXT,
    ADD COLUMN "deviceLabel" TEXT,
    ADD COLUMN "platform" TEXT,
    ADD COLUMN "lastUsedAt" TIMESTAMPTZ(3),
    ADD COLUMN "bindingHash" TEXT,
    ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "revokedReason" TEXT;

UPDATE "RefreshToken"
SET "sessionId" = gen_random_uuid()::text
WHERE "sessionId" IS NULL;

ALTER TABLE "RefreshToken"
    ALTER COLUMN "sessionId" SET NOT NULL;

ALTER TABLE "RefreshToken"
    ADD CONSTRAINT "RefreshToken_credentialVersion_positive_check"
        CHECK ("credentialVersion" >= 1),
    ADD CONSTRAINT "RefreshToken_deviceLabel_len_check"
        CHECK ("deviceLabel" IS NULL OR char_length("deviceLabel") BETWEEN 1 AND 120),
    ADD CONSTRAINT "RefreshToken_platform_len_check"
        CHECK ("platform" IS NULL OR char_length("platform") BETWEEN 1 AND 40),
    ADD CONSTRAINT "RefreshToken_revokedReason_len_check"
        CHECK ("revokedReason" IS NULL OR char_length(btrim("revokedReason")) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX "RefreshToken_sessionId_key"
    ON "RefreshToken"("sessionId");

CREATE INDEX "idx_RefreshToken_company_user_revoked"
    ON "RefreshToken"("companyId", "userId", "revokedAt");

CREATE INDEX "idx_RefreshToken_user_lastUsedAt"
    ON "RefreshToken"("userId", "lastUsedAt");

DO $$
DECLARE
    mismatch_count INTEGER;
BEGIN
    SELECT COUNT(*)::integer INTO mismatch_count
    FROM "RefreshToken" rt
    LEFT JOIN "User" u ON u."id" = rt."userId" AND u."companyId" = rt."companyId"
    WHERE u."id" IS NULL;

    IF mismatch_count > 0 THEN
        RAISE EXCEPTION
            'M06 blocked: % RefreshToken row(s) have userId/companyId mismatch; fix explicitly before composite FK',
            mismatch_count;
    END IF;
END $$;

ALTER TABLE "RefreshToken" DROP CONSTRAINT IF EXISTS "RefreshToken_userId_fkey";
-- M01 already installed the composite tenant-safe FK; drop/re-add so M06 remains
-- idempotent on fresh disposable databases that apply the full migration chain.
ALTER TABLE "RefreshToken" DROP CONSTRAINT IF EXISTS "RefreshToken_userId_companyId_fkey";

ALTER TABLE "RefreshToken"
    ADD CONSTRAINT "RefreshToken_userId_companyId_fkey"
        FOREIGN KEY ("userId", "companyId")
        REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
