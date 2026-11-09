-- RC2 minimal Platform Owner control plane.
-- Additive principal/session/audit tables plus truthful platform attribution.
-- M02 ownership backfill SQL and its fail-closed behavior are not changed.

CREATE TABLE "PlatformPrincipal" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "authorizationVersion" INTEGER NOT NULL DEFAULT 1,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformPrincipal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformPrincipal_status_check" CHECK ("status" IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX "PlatformPrincipal_normalizedEmail_key"
  ON "PlatformPrincipal"("normalizedEmail");
CREATE INDEX "idx_PlatformPrincipal_status" ON "PlatformPrincipal"("status");

CREATE TABLE "PlatformRefreshToken" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,
    "credentialVersion" INTEGER NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformRefreshToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformRefreshToken_principal_fkey"
      FOREIGN KEY ("principalId") REFERENCES "PlatformPrincipal"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformRefreshToken_sessionId_key"
  ON "PlatformRefreshToken"("sessionId");
CREATE UNIQUE INDEX "PlatformRefreshToken_tokenHash_key"
  ON "PlatformRefreshToken"("tokenHash");
CREATE INDEX "idx_PlatformRefreshToken_principal_revoked"
  ON "PlatformRefreshToken"("principalId", "revokedAt");

CREATE TABLE "PlatformMfaCredential" (
    "principalId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "secretCiphertext" TEXT,
    "pendingSecretCiphertext" TEXT,
    "challengeTokenHash" TEXT,
    "challengePurpose" TEXT,
    "challengeExpiresAt" TIMESTAMPTZ(3),
    "challengeAttempts" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "backupCodeHashes" TEXT NOT NULL DEFAULT '[]',
    "enrolledAt" TIMESTAMPTZ(3),
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "lastUsedTimeStep" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformMfaCredential_pkey" PRIMARY KEY ("principalId"),
    CONSTRAINT "PlatformMfaCredential_state_check"
      CHECK ("state" IN ('pending', 'enrolled')),
    CONSTRAINT "PlatformMfaCredential_challenge_purpose_check"
      CHECK ("challengePurpose" IS NULL OR "challengePurpose" IN ('enroll', 'login')),
    CONSTRAINT "PlatformMfaCredential_challenge_attempts_check"
      CHECK ("challengeAttempts" BETWEEN 0 AND 5),
    CONSTRAINT "PlatformMfaCredential_failed_attempts_check"
      CHECK ("failedAttempts" BETWEEN 0 AND 5),
    CONSTRAINT "PlatformMfaCredential_principal_fkey"
      FOREIGN KEY ("principalId") REFERENCES "PlatformPrincipal"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformMfaCredential_challengeTokenHash_key"
  ON "PlatformMfaCredential"("challengeTokenHash");
CREATE INDEX "idx_PlatformMfaCredential_challenge_expiry"
  ON "PlatformMfaCredential"("challengeExpiresAt");
CREATE INDEX "idx_PlatformMfaCredential_locked_until"
  ON "PlatformMfaCredential"("lockedUntil");

CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "targetCompanyId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformAuditLog_principal_fkey"
      FOREIGN KEY ("principalId") REFERENCES "PlatformPrincipal"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlatformAuditLog_company_fkey"
      FOREIGN KEY ("targetCompanyId") REFERENCES "Company"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_PlatformAuditLog_principal_created"
  ON "PlatformAuditLog"("principalId", "createdAt");
CREATE INDEX "idx_PlatformAuditLog_company_created"
  ON "PlatformAuditLog"("targetCompanyId", "createdAt");

CREATE TABLE "PlatformIdempotencyKey" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "companyId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformIdempotencyKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformIdempotencyKey_principal_fkey"
      FOREIGN KEY ("principalId") REFERENCES "PlatformPrincipal"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlatformIdempotencyKey_company_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformIdempotencyKey_principal_key_key"
  ON "PlatformIdempotencyKey"("principalId", "key");
CREATE INDEX "idx_PlatformIdempotencyKey_company"
  ON "PlatformIdempotencyKey"("companyId");

ALTER TABLE "CompanyOwnership"
  ALTER COLUMN "createdByUserId" DROP NOT NULL,
  ADD COLUMN "createdByPlatformPrincipalId" TEXT;
ALTER TABLE "CompanyOwnership"
  ADD CONSTRAINT "CompanyOwnership_platform_creator_fkey"
    FOREIGN KEY ("createdByPlatformPrincipalId") REFERENCES "PlatformPrincipal"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CompanyOwnership_exactly_one_creator_check"
    CHECK (num_nonnulls("createdByUserId", "createdByPlatformPrincipalId") = 1);
CREATE INDEX "idx_CompanyOwnership_platform_creator"
  ON "CompanyOwnership"("createdByPlatformPrincipalId");

ALTER TABLE "AttendanceExemption"
  ALTER COLUMN "createdByUserId" DROP NOT NULL,
  ADD COLUMN "createdByPlatformPrincipalId" TEXT;
ALTER TABLE "AttendanceExemption"
  ADD CONSTRAINT "AttendanceExemption_platform_creator_fkey"
    FOREIGN KEY ("createdByPlatformPrincipalId") REFERENCES "PlatformPrincipal"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AttendanceExemption_exactly_one_creator_check"
    CHECK (num_nonnulls("createdByUserId", "createdByPlatformPrincipalId") = 1);
CREATE INDEX "idx_AttendanceExemption_platform_creator"
  ON "AttendanceExemption"("createdByPlatformPrincipalId");

ALTER TABLE "PlatformPrincipal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformRefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformMfaCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformIdempotencyKey" ENABLE ROW LEVEL SECURITY;
