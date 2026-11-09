-- RC2 Credential Recovery E1 foundation.
-- Additive only: recovery request, recovery audit, and durable rate-limit buckets.
-- Does not modify existing Company/User/PlatformPrincipal rows or prior migrations.
--
-- Polymorphic principalId intentionally has no cross-table FK (PlatformPrincipal vs User);
-- companyId is FK-restricted when present so tenant evidence cannot be silently erased.
-- Application code must lock and resolve the real target inside the recovery transaction.
--
-- Deliberate constraints documented below. Constraints that would block legitimate
-- future E2–E5 workflows (for example multi-step break-glass procedural state) are omitted.

CREATE TABLE "CredentialRecoveryRequest" (
    "id" TEXT NOT NULL,
    "principalDomain" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "companyId" TEXT,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT,
    "tokenHashAlgorithm" TEXT,
    "environmentBinding" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "supersededByRequestId" TEXT,
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationReason" TEXT,
    "credentialVersionAtIssuance" INTEGER NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "initiatorPrincipalId" TEXT,
    "deliveryChannel" TEXT NOT NULL,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "requestSourceHash" TEXT,
    "auditEventId" TEXT,
    CONSTRAINT "CredentialRecoveryRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CredentialRecoveryRequest_principalDomain_check"
      CHECK ("principalDomain" IN ('platform_principal', 'company_primary_owner', 'company_employee')),
    CONSTRAINT "CredentialRecoveryRequest_purpose_check"
      CHECK ("purpose" IN (
        'password_reset',
        'account_discovery',
        'mfa_recovery',
        'break_glass_recovery',
        'employee_admin_reset'
      )),
    CONSTRAINT "CredentialRecoveryRequest_domain_company_check"
      CHECK (
        ("principalDomain" = 'platform_principal' AND "companyId" IS NULL)
        OR ("principalDomain" IN ('company_primary_owner', 'company_employee') AND "companyId" IS NOT NULL)
      ),
    CONSTRAINT "CredentialRecoveryRequest_domain_purpose_check"
      CHECK (
        ("principalDomain" = 'platform_principal' AND "purpose" IN (
          'password_reset', 'account_discovery', 'mfa_recovery', 'break_glass_recovery'
        ))
        OR ("principalDomain" = 'company_primary_owner' AND "purpose" IN (
          'password_reset', 'mfa_recovery'
        ))
        OR ("principalDomain" = 'company_employee' AND "purpose" IN (
          'mfa_recovery', 'employee_admin_reset'
        ))
      ),
    -- Token purposes must store keyed digests; non-token purposes must not.
    CONSTRAINT "CredentialRecoveryRequest_token_shape_check"
      CHECK (
        (
          "purpose" IN ('password_reset', 'mfa_recovery')
          AND "tokenHash" IS NOT NULL
          AND "tokenHashAlgorithm" IS NOT NULL
          AND "tokenHashAlgorithm" = 'hmac-sha256-v1'
          AND "tokenHash" ~ '^hmac-sha256-v1:[a-f0-9]{64}$'
        )
        OR (
          "purpose" IN ('account_discovery', 'break_glass_recovery', 'employee_admin_reset')
          AND "tokenHash" IS NULL
          AND "tokenHashAlgorithm" IS NULL
        )
      ),
    -- E1 V1-only environment binding shape (class:fingerprint).
    CONSTRAINT "CredentialRecoveryRequest_environmentBinding_check"
      CHECK ("environmentBinding" ~ '^(local|test|staging|production):[A-Za-z0-9_-]{8,128}$'),
    CONSTRAINT "CredentialRecoveryRequest_expires_after_created_check"
      CHECK ("expiresAt" > "createdAt"),
    -- Lifecycle timestamp consistency: invalidation reason and timestamp travel together;
    -- successful consume marks both consumedAt and invalidatedAt with reason 'consumed'.
    CONSTRAINT "CredentialRecoveryRequest_lifecycle_check"
      CHECK (
        (("invalidatedAt" IS NULL) = ("invalidationReason" IS NULL))
        AND (
          "consumedAt" IS NULL
          OR (
            "invalidatedAt" IS NOT NULL
            AND "invalidationReason" = 'consumed'
            AND "consumedAt" >= "createdAt"
          )
        )
        AND (
          "invalidatedAt" IS NULL
          OR "invalidatedAt" >= "createdAt"
        )
        AND (
          "supersededByRequestId" IS NULL
          OR "invalidationReason" = 'superseded'
        )
      ),
    CONSTRAINT "CredentialRecoveryRequest_initiatedBy_check"
      CHECK ("initiatedBy" IN ('self', 'platform_operator', 'company_admin', 'system')),
    CONSTRAINT "CredentialRecoveryRequest_deliveryChannel_check"
      CHECK ("deliveryChannel" IN ('email', 'sms', 'push', 'none')),
    CONSTRAINT "CredentialRecoveryRequest_deliveryStatus_check"
      CHECK ("deliveryStatus" IN ('pending', 'dispatched', 'failed')),
    CONSTRAINT "CredentialRecoveryRequest_invalidationReason_check"
      CHECK (
        "invalidationReason" IS NULL
        OR "invalidationReason" IN (
          'superseded',
          'credential_version_mismatch',
          'expired',
          'consumed',
          'admin_cancelled',
          'security_event'
        )
      ),
    CONSTRAINT "CredentialRecoveryRequest_credentialVersion_check"
      CHECK ("credentialVersionAtIssuance" >= 1),
    -- Keyed source-bucket hash only (recovery-src-v1:<64 hex>); never raw email/IP/phone.
    CONSTRAINT "CredentialRecoveryRequest_requestSourceHash_check"
      CHECK (
        "requestSourceHash" IS NULL
        OR "requestSourceHash" ~ '^recovery-src-v1:[a-f0-9]{64}$'
      ),
    CONSTRAINT "CredentialRecoveryRequest_company_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CredentialRecoveryRequest_supersededBy_fkey"
      FOREIGN KEY ("supersededByRequestId") REFERENCES "CredentialRecoveryRequest"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CredentialRecoveryRequest_tokenHash_key"
  ON "CredentialRecoveryRequest"("tokenHash")
  WHERE "tokenHash" IS NOT NULL;

CREATE UNIQUE INDEX "CredentialRecoveryRequest_active_unique"
  ON "CredentialRecoveryRequest" (
    "principalDomain",
    "principalId",
    (COALESCE("companyId", '')),
    "purpose"
  )
  WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL;

CREATE INDEX "idx_CredentialRecoveryRequest_token_lookup"
  ON "CredentialRecoveryRequest"("tokenHash", "purpose", "principalDomain")
  WHERE "tokenHash" IS NOT NULL;

CREATE INDEX "idx_CredentialRecoveryRequest_expiry_cleanup"
  ON "CredentialRecoveryRequest"("expiresAt")
  WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL;

CREATE INDEX "idx_CredentialRecoveryRequest_principal_purpose"
  ON "CredentialRecoveryRequest"("principalDomain", "principalId", "purpose", "createdAt");

CREATE INDEX "idx_CredentialRecoveryRequest_company_created"
  ON "CredentialRecoveryRequest"("companyId", "createdAt")
  WHERE "companyId" IS NOT NULL;

CREATE INDEX "idx_CredentialRecoveryRequest_audit_ref"
  ON "CredentialRecoveryRequest"("auditEventId")
  WHERE "auditEventId" IS NOT NULL;

CREATE TABLE "CredentialRecoveryAuditEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "subjectId" TEXT,
    "subjectDomain" TEXT NOT NULL,
    "companyId" TEXT,
    "result" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "recoveryRequestId" TEXT,
    "requestId" TEXT NOT NULL,
    "sourceBucketHash" TEXT,
    "referenceId" TEXT NOT NULL,
    CONSTRAINT "CredentialRecoveryAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CredentialRecoveryAuditEvent_eventType_check"
      CHECK ("eventType" IN (
        'recovery_request_issued',
        'recovery_request_superseded',
        'recovery_request_consumed',
        'recovery_request_rejected',
        'recovery_request_invalidated',
        'recovery_delivery_recorded',
        'recovery_rate_limit_triggered',
        'recovery_alert_raised'
      )),
    CONSTRAINT "CredentialRecoveryAuditEvent_actorType_check"
      CHECK ("actorType" IN (
        'anonymous',
        'platform_owner',
        'primary_owner',
        'company_admin',
        'employee',
        'system',
        'support'
      )),
    CONSTRAINT "CredentialRecoveryAuditEvent_subjectDomain_check"
      CHECK ("subjectDomain" IN (
        'platform_principal',
        'company_primary_owner',
        'company_employee',
        'unresolved'
      )),
    CONSTRAINT "CredentialRecoveryAuditEvent_result_check"
      CHECK ("result" IN ('success', 'failure', 'denied', 'expired', 'limited')),
    -- Unresolved subjects cannot claim a company or subject ID (no company-existence oracle).
    CONSTRAINT "CredentialRecoveryAuditEvent_unresolved_subject_check"
      CHECK (
        "subjectDomain" <> 'unresolved'
        OR ("subjectId" IS NULL AND "companyId" IS NULL)
      ),
    -- Anonymous actors must not claim an actorId.
    CONSTRAINT "CredentialRecoveryAuditEvent_anonymous_actor_check"
      CHECK (
        "actorType" <> 'anonymous'
        OR "actorId" IS NULL
      ),
    CONSTRAINT "CredentialRecoveryAuditEvent_sourceBucketHash_check"
      CHECK (
        "sourceBucketHash" IS NULL
        OR "sourceBucketHash" ~ '^recovery-src-v1:[a-f0-9]{64}$'
      ),
    CONSTRAINT "CredentialRecoveryAuditEvent_company_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CredentialRecoveryAuditEvent_request_fkey"
      FOREIGN KEY ("recoveryRequestId") REFERENCES "CredentialRecoveryRequest"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

-- External-safe event reference must be unique.
CREATE UNIQUE INDEX "CredentialRecoveryAuditEvent_referenceId_key"
  ON "CredentialRecoveryAuditEvent"("referenceId");

CREATE INDEX "idx_CredentialRecoveryAuditEvent_request"
  ON "CredentialRecoveryAuditEvent"("recoveryRequestId", "timestamp")
  WHERE "recoveryRequestId" IS NOT NULL;

CREATE INDEX "idx_CredentialRecoveryAuditEvent_subject"
  ON "CredentialRecoveryAuditEvent"("subjectDomain", "subjectId", "timestamp");

CREATE INDEX "idx_CredentialRecoveryAuditEvent_company"
  ON "CredentialRecoveryAuditEvent"("companyId", "timestamp")
  WHERE "companyId" IS NOT NULL;

CREATE INDEX "idx_CredentialRecoveryAuditEvent_requestId"
  ON "CredentialRecoveryAuditEvent"("requestId");

CREATE TABLE "CredentialRecoveryRateLimitBucket" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "bucketKeyHash" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "windowEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CredentialRecoveryRateLimitBucket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CredentialRecoveryRateLimitBucket_surface_check"
      CHECK ("surface" IN (
        'platform_password_reset_initiate',
        'platform_password_reset_confirm',
        'platform_account_discovery',
        'platform_mfa_recovery',
        'company_owner_recovery_initiate',
        'company_owner_recovery_confirm',
        'employee_admin_reset',
        'break_glass_attempt'
      )),
    CONSTRAINT "CredentialRecoveryRateLimitBucket_dimension_check"
      CHECK ("dimension" IN (
        'source',
        'target',
        'token',
        'actor',
        'company',
        'global'
      )),
    CONSTRAINT "CredentialRecoveryRateLimitBucket_count_check"
      CHECK ("count" >= 0),
    CONSTRAINT "CredentialRecoveryRateLimitBucket_window_check"
      CHECK ("windowEndsAt" > "windowStartedAt"),
    CONSTRAINT "CredentialRecoveryRateLimitBucket_bucketKeyHash_check"
      CHECK ("bucketKeyHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "CredentialRecoveryRateLimitBucket_unique"
  ON "CredentialRecoveryRateLimitBucket"("surface", "dimension", "bucketKeyHash", "windowStartedAt");

CREATE INDEX "idx_CredentialRecoveryRateLimitBucket_window"
  ON "CredentialRecoveryRateLimitBucket"("windowEndsAt");

ALTER TABLE "CredentialRecoveryRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialRecoveryAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialRecoveryRateLimitBucket" ENABLE ROW LEVEL SECURITY;
