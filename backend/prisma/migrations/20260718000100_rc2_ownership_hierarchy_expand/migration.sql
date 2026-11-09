-- Sprint 12C M02: explicit Primary Owner and hierarchical manager foundation.
-- This is additive. Legacy Role permissions and Department.managerId remain
-- available during the compatibility window.

BEGIN;

-- Existing-data M02 requires an explicit, approved legacy owner mapping and
-- truthful migration attribution. A fresh database (no Company rows yet) is
-- unaffected and proceeds exactly as before. An existing-data database MUST
-- have exactly one unconsumed, digest-bound mapping package prepared by
-- `scripts/m02/prepare_legacy_mapping.ts --mode=apply-preparation` before this
-- migration is applied; otherwise it fails closed. Hold a write-blocking lock
-- so a Company cannot race this check before the new-company ownership
-- trigger is installed.
LOCK TABLE "Company" IN SHARE MODE;

DO $$
DECLARE
  company_count integer;
  package_count integer;
  package_id text;
  mapped_count integer;
BEGIN
  SELECT COUNT(*)::int INTO company_count FROM "Company";
  IF company_count = 0 THEN
    RETURN; -- fresh database path
  END IF;

  IF to_regclass('public."_MawaredM02LegacyMappingPackage"') IS NULL
     OR to_regclass('public."_MawaredM02LegacyMappingRow"') IS NULL THEN
    RAISE EXCEPTION 'M02 preflight failed: existing Companies require an explicit approved owner mapping and truthful migration attribution';
  END IF;

  SELECT COUNT(*)::int INTO package_count
  FROM "_MawaredM02LegacyMappingPackage"
  WHERE "databaseName" = current_database() AND "consumedAt" IS NULL;

  IF package_count = 0 THEN
    RAISE EXCEPTION 'M02 preflight failed: existing Companies require an explicit approved owner mapping and truthful migration attribution';
  END IF;
  IF package_count > 1 THEN
    RAISE EXCEPTION 'M02 preflight failed: multiple unconsumed legacy mapping packages for database %', current_database();
  END IF;

  SELECT p."id" INTO package_id
  FROM "_MawaredM02LegacyMappingPackage" p
  WHERE p."databaseName" = current_database() AND p."consumedAt" IS NULL;

  -- exact coverage
  SELECT COUNT(*)::int INTO mapped_count FROM "_MawaredM02LegacyMappingRow" WHERE "packageId" = package_id;
  IF mapped_count <> company_count THEN
    RAISE EXCEPTION 'M02 preflight failed: legacy mapping company count % does not match database company count %', mapped_count, company_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Company" c
    LEFT JOIN "_MawaredM02LegacyMappingRow" r ON r."packageId" = package_id AND r."companyId" = c.id
    WHERE r."companyId" IS NULL
  ) THEN
    RAISE EXCEPTION 'M02 preflight failed: legacy mapping is missing one or more existing Companies';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_MawaredM02LegacyMappingRow" r
    WHERE r."packageId" = package_id
      AND NOT EXISTS (SELECT 1 FROM "Company" c WHERE c.id = r."companyId")
  ) THEN
    RAISE EXCEPTION 'M02 preflight failed: legacy mapping contains unknown Company IDs';
  END IF;

  -- owner + attribution must belong to company
  IF EXISTS (
    SELECT 1 FROM "_MawaredM02LegacyMappingRow" r
    WHERE r."packageId" = package_id
      AND NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u.id = r."primaryOwnerUserId" AND u."companyId" = r."companyId"
      )
  ) THEN
    RAISE EXCEPTION 'M02 preflight failed: primary owner user is missing or belongs to another company';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_MawaredM02LegacyMappingRow" r
    WHERE r."packageId" = package_id
      AND NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u.id = r."createdByUserId" AND u."companyId" = r."companyId"
      )
  ) THEN
    RAISE EXCEPTION 'M02 preflight failed: attribution user is missing or belongs to another company';
  END IF;

  -- Fail-closed active eligibility for mapped owner + attribution users.
  -- When User.accountStatus exists (post credentials_sessions), it is authoritative.
  -- Otherwise require an unambiguous same-company Employee link with status = active.
  -- Missing, inactive, terminated, unknown, or cross-company evidence fails closed.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'accountStatus'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM "_MawaredM02LegacyMappingRow" r
      JOIN "User" owner_user ON owner_user.id = r."primaryOwnerUserId"
      WHERE r."packageId" = package_id
        AND owner_user."accountStatus" <> 'active'
    ) OR EXISTS (
      SELECT 1
      FROM "_MawaredM02LegacyMappingRow" r
      JOIN "User" attribution_user ON attribution_user.id = r."createdByUserId"
      WHERE r."packageId" = package_id
        AND attribution_user."accountStatus" <> 'active'
    ) THEN
      RAISE EXCEPTION 'M02 preflight failed: mapped owner or attribution user accountStatus is not active';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM "_MawaredM02LegacyMappingRow" r
      JOIN "User" owner_user
        ON owner_user.id = r."primaryOwnerUserId"
       AND owner_user."companyId" = r."companyId"
      WHERE r."packageId" = package_id
        AND (
          owner_user."employeeId" IS NULL
          OR (
            SELECT COUNT(*)::int
            FROM "Employee" e
            WHERE e.id = owner_user."employeeId"
          ) <> 1
          OR NOT EXISTS (
            SELECT 1
            FROM "Employee" e
            WHERE e.id = owner_user."employeeId"
              AND e."companyId" = owner_user."companyId"
              AND lower(btrim(e.status)) = 'active'
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM "_MawaredM02LegacyMappingRow" r
      JOIN "User" attribution_user
        ON attribution_user.id = r."createdByUserId"
       AND attribution_user."companyId" = r."companyId"
      WHERE r."packageId" = package_id
        AND (
          attribution_user."employeeId" IS NULL
          OR (
            SELECT COUNT(*)::int
            FROM "Employee" e
            WHERE e.id = attribution_user."employeeId"
          ) <> 1
          OR NOT EXISTS (
            SELECT 1
            FROM "Employee" e
            WHERE e.id = attribution_user."employeeId"
              AND e."companyId" = attribution_user."companyId"
              AND lower(btrim(e.status)) = 'active'
          )
        )
    ) THEN
      RAISE EXCEPTION 'M02 preflight failed: mapped owner or attribution user lacks unambiguous active same-company Employee eligibility';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_MawaredM02LegacyMappingPackage" p
    WHERE p."id" = package_id AND (
      btrim(p."approvedBy") = '' OR btrim(p."approvalReference") = '' OR p."mappingVersion" <> 'm02-legacy-v1'
      OR p."mappingDigest" !~ '^[a-f0-9]{64}$'
      OR btrim(p."canonicalPayload") = ''
    )
  ) THEN
    RAISE EXCEPTION 'M02 preflight failed: legacy mapping approval provenance or digest is invalid';
  END IF;
END $$;

ALTER TABLE "User"
    ADD COLUMN "authorizationVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "User"
    ADD CONSTRAINT "User_authorizationVersion_check"
        CHECK ("authorizationVersion" >= 1);

CREATE TABLE "CompanyOwnership" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "activePrimaryCompanyId" TEXT,
    "userId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT TRUE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "createdByUserId" TEXT NOT NULL,
    "endedByUserId" TEXT,
    CONSTRAINT "CompanyOwnership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OwnershipTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "transferredByUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "previewDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DepartmentManager" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "endedByUserId" TEXT,
    CONSTRAINT "DepartmentManager_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CompanyOwnership"
    ADD CONSTRAINT "CompanyOwnership_state_check"
        CHECK (
            ("status" = 'active' AND "endedAt" IS NULL AND "endedByUserId" IS NULL)
            OR
            ("status" = 'ended' AND "endedAt" IS NOT NULL AND "endedByUserId" IS NOT NULL)
        ),
    ADD CONSTRAINT "CompanyOwnership_end_after_effective_check"
        CHECK ("endedAt" IS NULL OR "endedAt" >= "effectiveAt");

ALTER TABLE "OwnershipTransfer"
    ADD CONSTRAINT "OwnershipTransfer_distinct_users_check"
        CHECK ("fromUserId" <> "toUserId"),
    ADD CONSTRAINT "OwnershipTransfer_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    ADD CONSTRAINT "OwnershipTransfer_idempotency_check"
        CHECK (char_length("idempotencyKey") BETWEEN 8 AND 128),
    ADD CONSTRAINT "OwnershipTransfer_previewDigest_check"
        CHECK ("previewDigest" ~ '^[a-f0-9]{64}$');

ALTER TABLE "DepartmentManager"
    ADD CONSTRAINT "DepartmentManager_state_check"
        CHECK (
            ("status" = 'active' AND "endedAt" IS NULL AND "endedByUserId" IS NULL)
            OR
            ("status" = 'ended' AND "endedAt" IS NOT NULL AND "endedByUserId" IS NOT NULL)
        ),
    ADD CONSTRAINT "DepartmentManager_end_after_assignment_check"
        CHECK ("endedAt" IS NULL OR "endedAt" >= "assignedAt");

CREATE UNIQUE INDEX "CompanyOwnership_id_companyId_key"
    ON "CompanyOwnership"("id", "companyId");
ALTER TABLE "CompanyOwnership"
    ADD CONSTRAINT "CompanyOwnership_one_active_primary_key"
        UNIQUE ("activePrimaryCompanyId")
        DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "idx_CompanyOwnership_company_status_primary"
    ON "CompanyOwnership"("companyId", "status", "isPrimary");
CREATE INDEX "idx_CompanyOwnership_user_company"
    ON "CompanyOwnership"("userId", "companyId");
CREATE INDEX "idx_CompanyOwnership_creator_company"
    ON "CompanyOwnership"("createdByUserId", "companyId");
CREATE INDEX "idx_CompanyOwnership_ender_company"
    ON "CompanyOwnership"("endedByUserId", "companyId");

CREATE UNIQUE INDEX "OwnershipTransfer_actor_idempotency_key"
    ON "OwnershipTransfer"("companyId", "transferredByUserId", "idempotencyKey");
CREATE INDEX "idx_OwnershipTransfer_company_created"
    ON "OwnershipTransfer"("companyId", "createdAt");
CREATE INDEX "idx_OwnershipTransfer_from_company"
    ON "OwnershipTransfer"("fromUserId", "companyId");
CREATE INDEX "idx_OwnershipTransfer_to_company"
    ON "OwnershipTransfer"("toUserId", "companyId");

CREATE UNIQUE INDEX "DepartmentManager_id_companyId_key"
    ON "DepartmentManager"("id", "companyId");
CREATE UNIQUE INDEX "DepartmentManager_one_active_membership_key"
    ON "DepartmentManager"("companyId", "departmentId", "userId")
    WHERE "status" = 'active';
CREATE INDEX "idx_DepartmentManager_company_department_status"
    ON "DepartmentManager"("companyId", "departmentId", "status");
CREATE INDEX "idx_DepartmentManager_company_user_status"
    ON "DepartmentManager"("companyId", "userId", "status");
CREATE INDEX "idx_DepartmentManager_assigner_company"
    ON "DepartmentManager"("assignedByUserId", "companyId");
CREATE INDEX "idx_DepartmentManager_ender_company"
    ON "DepartmentManager"("endedByUserId", "companyId");

ALTER TABLE "CompanyOwnership"
    ADD CONSTRAINT "CompanyOwnership_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "CompanyOwnership_userId_companyId_fkey"
        FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "CompanyOwnership_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "CompanyOwnership_endedByUserId_companyId_fkey"
        FOREIGN KEY ("endedByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OwnershipTransfer"
    ADD CONSTRAINT "OwnershipTransfer_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "OwnershipTransfer_fromUserId_companyId_fkey"
        FOREIGN KEY ("fromUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "OwnershipTransfer_toUserId_companyId_fkey"
        FOREIGN KEY ("toUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "OwnershipTransfer_transferredByUserId_companyId_fkey"
        FOREIGN KEY ("transferredByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DepartmentManager"
    ADD CONSTRAINT "DepartmentManager_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DepartmentManager_departmentId_companyId_fkey"
        FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DepartmentManager_userId_companyId_fkey"
        FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DepartmentManager_assignedByUserId_companyId_fkey"
        FOREIGN KEY ("assignedByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DepartmentManager_endedByUserId_companyId_fkey"
        FOREIGN KEY ("endedByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS is enabled here, before any trigger is created and before the legacy
-- backfill below inserts any row. PostgreSQL rejects ALTER TABLE on a table
-- with pending deferred trigger events, and the backfill's INSERT queues
-- exactly that kind of pending event on CompanyOwnership for the deferred
-- triggers created further down in this migration.
ALTER TABLE "CompanyOwnership" ENABLE ROW LEVEL SECURITY;

-- The support column is always derived by the database. A deferrable unique
-- constraint allows transfer code to insert the successor first, then end the
-- predecessor, while still rejecting two active owners at commit.
CREATE FUNCTION "mawared_sync_active_primary_company_id"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
           NEW."companyId" IS DISTINCT FROM OLD."companyId"
           OR NEW."userId" IS DISTINCT FROM OLD."userId"
       )
    THEN
        RAISE EXCEPTION 'CompanyOwnership cannot change companyId or userId after creation';
    END IF;
    NEW."activePrimaryCompanyId" := CASE
        WHEN NEW."status" = 'active' AND NEW."isPrimary" = TRUE THEN NEW."companyId"
        ELSE NULL
    END;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "CompanyOwnership_sync_active_primary_company_id_trigger"
BEFORE INSERT OR UPDATE ON "CompanyOwnership"
FOR EACH ROW EXECUTE FUNCTION "mawared_sync_active_primary_company_id"();

-- There is deliberately no existing-data backfill here yet. It happens later
-- in this migration, after every ownership trigger below is installed, and
-- only after the fail-closed preflight above has already verified an approved,
-- digest-bound legacy mapping package for a database with existing Companies.
-- The deferred new-company trigger below separately requires future Company
-- creation to include its first owner atomically.

-- Ending or deleting the final owner is rejected immediately. Transfer code
-- inserts the successor first, so this guard sees a replacement in the same
-- transaction. The deferred unique constraint then enforces at most one at
-- commit and the constraint trigger below enforces exactly one.
CREATE FUNCTION "mawared_prevent_last_primary_owner_removal"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    removing_primary BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        removing_primary := TRUE;
    ELSE
        removing_primary := NEW."status" <> 'active' OR NEW."isPrimary" <> TRUE;
    END IF;

    IF OLD."status" = 'active' AND OLD."isPrimary" = TRUE
       AND removing_primary
       AND NOT EXISTS (
           SELECT 1
           FROM "CompanyOwnership" other
           WHERE other."companyId" = OLD."companyId"
             AND other."id" <> OLD."id"
             AND other."status" = 'active'
             AND other."isPrimary" = TRUE
       )
    THEN
        RAISE EXCEPTION 'Company % cannot remove its final active Primary Owner', OLD."companyId";
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "CompanyOwnership_prevent_last_primary_owner_removal_trigger"
BEFORE UPDATE OR DELETE ON "CompanyOwnership"
FOR EACH ROW EXECUTE FUNCTION "mawared_prevent_last_primary_owner_removal"();

-- A deferred constraint trigger checks the final transaction state, so an
-- ownership transfer can end the old row and add the new row atomically while
-- still making zero active Primary Owners impossible at commit.
CREATE FUNCTION "mawared_enforce_one_primary_owner"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    affected_company_id TEXT;
    active_primary_count INTEGER;
BEGIN
    affected_company_id := COALESCE(NEW."companyId", OLD."companyId");
    SELECT count(*) INTO active_primary_count
    FROM "CompanyOwnership"
    WHERE "companyId" = affected_company_id
      AND "status" = 'active'
      AND "isPrimary" = TRUE;

    IF active_primary_count <> 1 THEN
        RAISE EXCEPTION 'Company % must have exactly one active Primary Owner', affected_company_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CompanyOwnership_exactly_one_primary_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CompanyOwnership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "mawared_enforce_one_primary_owner"();

-- New companies must create their first ownership row in the same transaction.
-- This closes the gap where no CompanyOwnership row exists yet and therefore an
-- ownership-table trigger alone would have nothing to validate.
CREATE FUNCTION "mawared_enforce_new_company_primary_owner"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_primary_count INTEGER;
BEGIN
    SELECT count(*) INTO active_primary_count
    FROM "CompanyOwnership"
    WHERE "companyId" = NEW."id"
      AND "status" = 'active'
      AND "isPrimary" = TRUE;

    IF active_primary_count <> 1 THEN
        RAISE EXCEPTION 'New Company % must create exactly one active Primary Owner in the same transaction', NEW."id";
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Company_requires_primary_owner_trigger"
AFTER INSERT ON "Company"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "mawared_enforce_new_company_primary_owner"();

-- Legacy existing-data backfill from prepared mapping (fail-closed preflight already validated).
DO $$
DECLARE
  company_count integer;
  package_id text;
BEGIN
  SELECT COUNT(*)::int INTO company_count FROM "Company";
  IF company_count = 0 THEN
    RETURN;
  END IF;

  SELECT p."id" INTO package_id
  FROM "_MawaredM02LegacyMappingPackage" p
  WHERE p."databaseName" = current_database() AND p."consumedAt" IS NULL
  FOR UPDATE;

  INSERT INTO "CompanyOwnership" (
    "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "endedAt", "createdByUserId", "endedByUserId"
  )
  SELECT
    r."ownershipId",
    r."companyId",
    r."primaryOwnerUserId",
    TRUE,
    'active',
    CURRENT_TIMESTAMP,
    NULL,
    r."createdByUserId",
    NULL
  FROM "_MawaredM02LegacyMappingRow" r
  WHERE r."packageId" = package_id
  ORDER BY r."companyId";

  UPDATE "_MawaredM02LegacyMappingPackage"
  SET "consumedAt" = CURRENT_TIMESTAMP
  WHERE "id" = package_id AND "consumedAt" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'M02 failed: legacy mapping package was already consumed';
  END IF;
END $$;

-- The trusted Backend is the only current database entry point. Enabling RLS
-- with no policies blocks direct anon/authenticated Data API access.
-- CompanyOwnership's RLS was already enabled above, before its triggers.
ALTER TABLE "OwnershipTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DepartmentManager" ENABLE ROW LEVEL SECURITY;

COMMIT;
