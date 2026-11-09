-- Sprint 12C M03: permanent scoped grants, temporary delegation, and
-- permission-change history. Existing Role JSON remains the baseline template.

BEGIN;

CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "departmentId" TEXT,
    "grantedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantKind" TEXT NOT NULL DEFAULT 'direct',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedByUserId" TEXT,
    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TemporaryDelegation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "delegatorUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "departmentId" TEXT,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validUntil" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revokedAt" TIMESTAMPTZ(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TemporaryDelegation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DelegationCapability" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "delegationId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    CONSTRAINT "DelegationCapability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PermissionChangeBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "previewDigest" TEXT NOT NULL,
    "expectedAuthorizationVersion" INTEGER NOT NULL,
    "resultingAuthorizationVersion" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PermissionChangeBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PermissionChangeHistory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "departmentId" TEXT,
    "reason" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PermissionChangeHistory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AccessGrant"
    ADD CONSTRAINT "AccessGrant_capability_check"
        CHECK (char_length("capability") BETWEEN 3 AND 100 AND "capability" ~ '^[a-z][a-z0-9_.]*$'),
    ADD CONSTRAINT "AccessGrant_scope_check"
        CHECK (
            ("scopeType" = 'company' AND "departmentId" IS NULL)
            OR ("scopeType" = 'department' AND "departmentId" IS NOT NULL)
        ),
    ADD CONSTRAINT "AccessGrant_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    ADD CONSTRAINT "AccessGrant_kind_check"
        CHECK ("grantKind" IN ('direct', 'delegated_admin')),
    ADD CONSTRAINT "AccessGrant_state_check"
        CHECK (
            ("status" = 'active' AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL)
            OR
            ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL)
        );

ALTER TABLE "TemporaryDelegation"
    ADD CONSTRAINT "TemporaryDelegation_distinct_users_check"
        CHECK ("delegatorUserId" <> "recipientUserId"),
    ADD CONSTRAINT "TemporaryDelegation_scope_check"
        CHECK (
            ("scopeType" = 'company' AND "departmentId" IS NULL)
            OR ("scopeType" = 'department' AND "departmentId" IS NOT NULL)
        ),
    ADD CONSTRAINT "TemporaryDelegation_interval_check"
        CHECK ("validUntil" > "validFrom"),
    ADD CONSTRAINT "TemporaryDelegation_duration_check"
        CHECK ("validUntil" <= "validFrom" + INTERVAL '90 days'),
    ADD CONSTRAINT "TemporaryDelegation_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    ADD CONSTRAINT "TemporaryDelegation_idempotency_check"
        CHECK (char_length("idempotencyKey") BETWEEN 8 AND 128),
    ADD CONSTRAINT "TemporaryDelegation_state_check"
        CHECK (
            ("status" = 'active' AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL)
            OR
            ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL)
        );

ALTER TABLE "DelegationCapability"
    ADD CONSTRAINT "DelegationCapability_capability_check"
        CHECK (char_length("capability") BETWEEN 3 AND 100 AND "capability" ~ '^[a-z][a-z0-9_.]*$');

ALTER TABLE "PermissionChangeBatch"
    ADD CONSTRAINT "PermissionChangeBatch_idempotency_check"
        CHECK (char_length("idempotencyKey") BETWEEN 8 AND 128),
    ADD CONSTRAINT "PermissionChangeBatch_previewDigest_check"
        CHECK ("previewDigest" ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT "PermissionChangeBatch_versions_check"
        CHECK (
            "expectedAuthorizationVersion" >= 1
            AND "resultingAuthorizationVersion" = "expectedAuthorizationVersion" + 1
        ),
    ADD CONSTRAINT "PermissionChangeBatch_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500);

ALTER TABLE "PermissionChangeHistory"
    ADD CONSTRAINT "PermissionChangeHistory_action_check"
        CHECK ("action" IN ('grant', 'revoke')),
    ADD CONSTRAINT "PermissionChangeHistory_capability_check"
        CHECK (char_length("capability") BETWEEN 3 AND 100 AND "capability" ~ '^[a-z][a-z0-9_.]*$'),
    ADD CONSTRAINT "PermissionChangeHistory_scope_check"
        CHECK (
            ("scopeType" = 'company' AND "departmentId" IS NULL)
            OR ("scopeType" = 'department' AND "departmentId" IS NOT NULL)
        ),
    ADD CONSTRAINT "PermissionChangeHistory_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    ADD CONSTRAINT "PermissionChangeHistory_json_check"
        CHECK (
            char_length("beforeJson") <= 20000
            AND char_length("afterJson") <= 20000
            AND "beforeJson"::jsonb IS NOT NULL
            AND "afterJson"::jsonb IS NOT NULL
        );

CREATE UNIQUE INDEX "AccessGrant_id_companyId_key"
    ON "AccessGrant"("id", "companyId");
CREATE UNIQUE INDEX "AccessGrant_one_active_scope_key"
    ON "AccessGrant"(
        "companyId", "recipientUserId", "capability", "scopeType",
        COALESCE("departmentId", '')
    ) WHERE "status" = 'active';
CREATE INDEX "idx_AccessGrant_company_recipient_status"
    ON "AccessGrant"("companyId", "recipientUserId", "status");
CREATE INDEX "idx_AccessGrant_company_capability_scope_status"
    ON "AccessGrant"("companyId", "capability", "scopeType", "status");
CREATE INDEX "idx_AccessGrant_department_company"
    ON "AccessGrant"("departmentId", "companyId");
CREATE INDEX "idx_AccessGrant_grantor_company"
    ON "AccessGrant"("grantedByUserId", "companyId");
CREATE INDEX "idx_AccessGrant_revoker_company"
    ON "AccessGrant"("revokedByUserId", "companyId");

CREATE UNIQUE INDEX "TemporaryDelegation_id_companyId_key"
    ON "TemporaryDelegation"("id", "companyId");
CREATE UNIQUE INDEX "TemporaryDelegation_delegator_idempotency_key"
    ON "TemporaryDelegation"("companyId", "delegatorUserId", "idempotencyKey");
CREATE INDEX "idx_TemporaryDelegation_recipient_effective"
    ON "TemporaryDelegation"("companyId", "recipientUserId", "status", "validFrom", "validUntil");
CREATE INDEX "idx_TemporaryDelegation_delegator_status"
    ON "TemporaryDelegation"("companyId", "delegatorUserId", "status");
CREATE INDEX "idx_TemporaryDelegation_department_company"
    ON "TemporaryDelegation"("departmentId", "companyId");
CREATE INDEX "idx_TemporaryDelegation_revoker_company"
    ON "TemporaryDelegation"("revokedByUserId", "companyId");

CREATE UNIQUE INDEX "DelegationCapability_id_companyId_key"
    ON "DelegationCapability"("id", "companyId");
CREATE UNIQUE INDEX "DelegationCapability_delegation_capability_key"
    ON "DelegationCapability"("delegationId", "capability");
CREATE INDEX "idx_DelegationCapability_company_capability"
    ON "DelegationCapability"("companyId", "capability");

CREATE UNIQUE INDEX "PermissionChangeBatch_id_companyId_key"
    ON "PermissionChangeBatch"("id", "companyId");
CREATE UNIQUE INDEX "PermissionChangeBatch_actor_idempotency_key"
    ON "PermissionChangeBatch"("companyId", "actorUserId", "idempotencyKey");
CREATE INDEX "idx_PermissionChangeBatch_target_created"
    ON "PermissionChangeBatch"("companyId", "targetUserId", "createdAt");

CREATE UNIQUE INDEX "PermissionChangeHistory_id_companyId_key"
    ON "PermissionChangeHistory"("id", "companyId");
CREATE INDEX "idx_PermissionChangeHistory_batch_company"
    ON "PermissionChangeHistory"("batchId", "companyId");
CREATE INDEX "idx_PermissionChangeHistory_target_created"
    ON "PermissionChangeHistory"("companyId", "targetUserId", "createdAt");
CREATE INDEX "idx_PermissionChangeHistory_actor_created"
    ON "PermissionChangeHistory"("companyId", "actorUserId", "createdAt");
CREATE INDEX "idx_PermissionChangeHistory_department_company"
    ON "PermissionChangeHistory"("departmentId", "companyId");

ALTER TABLE "AccessGrant"
    ADD CONSTRAINT "AccessGrant_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AccessGrant_recipientUserId_companyId_fkey"
        FOREIGN KEY ("recipientUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AccessGrant_grantedByUserId_companyId_fkey"
        FOREIGN KEY ("grantedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AccessGrant_revokedByUserId_companyId_fkey"
        FOREIGN KEY ("revokedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AccessGrant_departmentId_companyId_fkey"
        FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TemporaryDelegation"
    ADD CONSTRAINT "TemporaryDelegation_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TemporaryDelegation_delegatorUserId_companyId_fkey"
        FOREIGN KEY ("delegatorUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TemporaryDelegation_recipientUserId_companyId_fkey"
        FOREIGN KEY ("recipientUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TemporaryDelegation_revokedByUserId_companyId_fkey"
        FOREIGN KEY ("revokedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TemporaryDelegation_departmentId_companyId_fkey"
        FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DelegationCapability"
    ADD CONSTRAINT "DelegationCapability_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DelegationCapability_delegationId_companyId_fkey"
        FOREIGN KEY ("delegationId", "companyId") REFERENCES "TemporaryDelegation"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PermissionChangeBatch"
    ADD CONSTRAINT "PermissionChangeBatch_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PermissionChangeBatch_targetUserId_companyId_fkey"
        FOREIGN KEY ("targetUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PermissionChangeBatch_actorUserId_companyId_fkey"
        FOREIGN KEY ("actorUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PermissionChangeHistory"
    ADD CONSTRAINT "PermissionChangeHistory_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PermissionChangeHistory_batchId_companyId_fkey"
        FOREIGN KEY ("batchId", "companyId") REFERENCES "PermissionChangeBatch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PermissionChangeHistory_targetUserId_companyId_fkey"
        FOREIGN KEY ("targetUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PermissionChangeHistory_actorUserId_companyId_fkey"
        FOREIGN KEY ("actorUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PermissionChangeHistory_departmentId_companyId_fkey"
        FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No direct Data API policy is created. RLS blocks anon/authenticated roles;
-- the trusted Backend database role remains the only entry point.
ALTER TABLE "AccessGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TemporaryDelegation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DelegationCapability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PermissionChangeBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PermissionChangeHistory" ENABLE ROW LEVEL SECURITY;

COMMIT;
