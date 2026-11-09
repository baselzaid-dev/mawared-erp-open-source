-- RC2 real backend MFA (provider-independent TOTP).
-- Additive only: no existing User, session, ownership, or M02 data is changed.

CREATE TABLE "UserMfaCredential" (
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
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

    CONSTRAINT "UserMfaCredential_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "UserMfaCredential_state_check"
      CHECK ("state" IN ('pending', 'enrolled')),
    CONSTRAINT "UserMfaCredential_challenge_purpose_check"
      CHECK ("challengePurpose" IS NULL OR "challengePurpose" IN ('enroll', 'login')),
    CONSTRAINT "UserMfaCredential_challenge_attempts_check"
      CHECK ("challengeAttempts" >= 0 AND "challengeAttempts" <= 5),
    CONSTRAINT "UserMfaCredential_failed_attempts_check"
      CHECK ("failedAttempts" >= 0 AND "failedAttempts" <= 5),
    CONSTRAINT "UserMfaCredential_user_company_fkey"
      FOREIGN KEY ("userId", "companyId")
      REFERENCES "User"("id", "companyId")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserMfaCredential_userId_companyId_key"
  ON "UserMfaCredential"("userId", "companyId");
CREATE UNIQUE INDEX "UserMfaCredential_challengeTokenHash_key"
  ON "UserMfaCredential"("challengeTokenHash");
CREATE INDEX "idx_UserMfaCredential_company_state"
  ON "UserMfaCredential"("companyId", "state");
CREATE INDEX "idx_UserMfaCredential_challenge_expiry"
  ON "UserMfaCredential"("challengeExpiresAt");
CREATE INDEX "idx_UserMfaCredential_locked_until"
  ON "UserMfaCredential"("lockedUntil");

-- The Backend uses the trusted direct PostgreSQL connection. Data API roles
-- receive no policy and therefore cannot read or mutate MFA material.
ALTER TABLE "UserMfaCredential" ENABLE ROW LEVEL SECURITY;
