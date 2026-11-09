-- RC2 DepartmentManager legacy compatibility backfill (additive migration 20).
--
-- Purpose: materialize one active DepartmentManager membership for every
-- Department.managerId that is still populated, so the new many-to-many
-- authority model matches the legacy single-manager field.
--
-- Attribution: assignedByUserId is the same-company active Primary Owner.
-- This records migration provenance only. It is NOT historical evidence that
-- the Primary Owner assigned the manager.
--
-- assignedAt is the backfill materialization timestamp, not the historical
-- manager-assignment date.
--
-- Idempotent: exact active memberships are left unchanged. Ended historical
-- memberships are preserved. Department.managerId is never rewritten.
--
-- Atomicity: the entire preflight / insert / post-check sequence runs inside
-- one explicit transaction (BEGIN … COMMIT), matching other RC2 data migrations.

BEGIN;

-- Session-scoped locks released automatically on COMMIT or ROLLBACK.
-- SHARE ROW EXCLUSIVE blocks concurrent DML that could change managerId,
-- ownership attribution, or DepartmentManager membership during this migration.
-- SHARE on User blocks concurrent accountStatus changes used by preflight.
LOCK TABLE "CompanyOwnership" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Department" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "DepartmentManager" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "User" IN SHARE MODE;

DO $$
DECLARE
  missing_manager_count integer;
  cross_company_count integer;
  inactive_manager_count integer;
  unknown_manager_status_count integer;
  owner_zero_count integer;
  owner_multi_count integer;
  inactive_owner_count integer;
  unknown_owner_status_count integer;
  rls_enabled boolean;
  before_user_n bigint;
  before_employee_n bigint;
  before_login_identity_n bigint;
  before_ownership_n bigint;
  before_department_n bigint;
  before_ended_dm_n bigint;
  before_fingerprint text;
  unmatched_legacy_count integer;
  cross_company_dm_count integer;
  duplicate_active_count integer;
  after_fingerprint text;
  after_user_n bigint;
  after_employee_n bigint;
  after_login_n bigint;
  after_ownership_n bigint;
  after_department_n bigint;
  after_ended_dm_n bigint;
BEGIN
  IF to_regclass('public."Department"') IS NULL
     OR to_regclass('public."DepartmentManager"') IS NULL
     OR to_regclass('public."CompanyOwnership"') IS NULL
     OR to_regclass('public."User"') IS NULL THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: required tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'accountStatus'
  ) THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: User.accountStatus is required';
  END IF;

  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public."DepartmentManager"'::regclass;
  IF rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: DepartmentManager RLS must be enabled';
  END IF;

  -- Missing manager User
  SELECT COUNT(*)::integer INTO missing_manager_count
  FROM "Department" d
  WHERE d."managerId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = d."managerId"
    );
  IF missing_manager_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Department row(s) reference a missing manager User',
      missing_manager_count;
  END IF;

  -- Cross-company manager
  SELECT COUNT(*)::integer INTO cross_company_count
  FROM "Department" d
  JOIN "User" u ON u.id = d."managerId"
  WHERE d."managerId" IS NOT NULL
    AND u."companyId" IS DISTINCT FROM d."companyId";
  IF cross_company_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Department row(s) have a cross-company manager',
      cross_company_count;
  END IF;

  -- Manager accountStatus must be exactly active
  SELECT COUNT(*)::integer INTO inactive_manager_count
  FROM "Department" d
  JOIN "User" u ON u.id = d."managerId"
  WHERE d."managerId" IS NOT NULL
    AND u."accountStatus" IN ('disabled', 'archived');
  IF inactive_manager_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Department row(s) have a disabled/archived manager',
      inactive_manager_count;
  END IF;

  SELECT COUNT(*)::integer INTO unknown_manager_status_count
  FROM "Department" d
  JOIN "User" u ON u.id = d."managerId"
  WHERE d."managerId" IS NOT NULL
    AND u."accountStatus" IS DISTINCT FROM 'active';
  IF unknown_manager_status_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Department row(s) have a manager with unsupported accountStatus',
      unknown_manager_status_count;
  END IF;

  -- Each affected Company must have exactly one active Primary Owner
  SELECT COUNT(*)::integer INTO owner_zero_count
  FROM (
    SELECT DISTINCT d."companyId"
    FROM "Department" d
    WHERE d."managerId" IS NOT NULL
  ) affected
  WHERE (
    SELECT COUNT(*)::integer
    FROM "CompanyOwnership" o
    WHERE o."companyId" = affected."companyId"
      AND o."isPrimary" = TRUE
      AND o.status = 'active'
  ) = 0;
  IF owner_zero_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Company(ies) with legacy managers have zero active Primary Owners',
      owner_zero_count;
  END IF;

  SELECT COUNT(*)::integer INTO owner_multi_count
  FROM (
    SELECT DISTINCT d."companyId"
    FROM "Department" d
    WHERE d."managerId" IS NOT NULL
  ) affected
  WHERE (
    SELECT COUNT(*)::integer
    FROM "CompanyOwnership" o
    WHERE o."companyId" = affected."companyId"
      AND o."isPrimary" = TRUE
      AND o.status = 'active'
  ) > 1;
  IF owner_multi_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Company(ies) with legacy managers have multiple active Primary Owners',
      owner_multi_count;
  END IF;

  -- Active Primary Owner must be same-company and accountStatus = active
  SELECT COUNT(*)::integer INTO inactive_owner_count
  FROM (
    SELECT DISTINCT d."companyId"
    FROM "Department" d
    WHERE d."managerId" IS NOT NULL
  ) affected
  JOIN "CompanyOwnership" o
    ON o."companyId" = affected."companyId"
   AND o."isPrimary" = TRUE
   AND o.status = 'active'
  JOIN "User" owner_user ON owner_user.id = o."userId"
  WHERE owner_user."companyId" IS DISTINCT FROM affected."companyId"
     OR owner_user."accountStatus" IN ('disabled', 'archived');
  IF inactive_owner_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Company(ies) have inactive or cross-company Primary Owner attribution',
      inactive_owner_count;
  END IF;

  SELECT COUNT(*)::integer INTO unknown_owner_status_count
  FROM (
    SELECT DISTINCT d."companyId"
    FROM "Department" d
    WHERE d."managerId" IS NOT NULL
  ) affected
  JOIN "CompanyOwnership" o
    ON o."companyId" = affected."companyId"
   AND o."isPrimary" = TRUE
   AND o.status = 'active'
  JOIN "User" owner_user ON owner_user.id = o."userId"
  WHERE owner_user."accountStatus" IS DISTINCT FROM 'active';
  IF unknown_owner_status_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill preflight failed: % Company(ies) have Primary Owner with unsupported accountStatus',
      unknown_owner_status_count;
  END IF;

  SELECT COUNT(*) INTO before_user_n FROM "User";
  SELECT COUNT(*) INTO before_employee_n FROM "Employee";
  SELECT COUNT(*) INTO before_login_identity_n FROM "LoginIdentity";
  SELECT COUNT(*) INTO before_ownership_n FROM "CompanyOwnership";
  SELECT COUNT(*) INTO before_department_n FROM "Department";
  SELECT COUNT(*) INTO before_ended_dm_n FROM "DepartmentManager" WHERE status = 'ended';
  SELECT COALESCE(string_agg(id || ':' || COALESCE("managerId", ''), '|' ORDER BY id), '')
    INTO before_fingerprint
  FROM "Department";

  INSERT INTO "DepartmentManager" (
    "id",
    "companyId",
    "departmentId",
    "userId",
    "status",
    "assignedByUserId",
    "assignedAt",
    "endedAt",
    "endedByUserId"
  )
  SELECT
    'dm_legacy_bf_' || md5(d."companyId" || ':' || d.id || ':' || d."managerId"),
    d."companyId",
    d.id,
    d."managerId",
    'active',
    o."userId",
    CURRENT_TIMESTAMP,
    NULL,
    NULL
  FROM "Department" d
  JOIN "CompanyOwnership" o
    ON o."companyId" = d."companyId"
   AND o."isPrimary" = TRUE
   AND o.status = 'active'
  WHERE d."managerId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "DepartmentManager" existing
      WHERE existing."companyId" = d."companyId"
        AND existing."departmentId" = d.id
        AND existing."userId" = d."managerId"
        AND existing.status = 'active'
    );

  SELECT COUNT(*)::integer INTO unmatched_legacy_count
  FROM "Department" d
  WHERE d."managerId" IS NOT NULL
    AND (
      SELECT COUNT(*)::integer
      FROM "DepartmentManager" dm
      WHERE dm."companyId" = d."companyId"
        AND dm."departmentId" = d.id
        AND dm."userId" = d."managerId"
        AND dm.status = 'active'
    ) <> 1;
  IF unmatched_legacy_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: % legacy managerId row(s) lack exactly one active membership',
      unmatched_legacy_count;
  END IF;

  SELECT COUNT(*)::integer INTO cross_company_dm_count
  FROM "DepartmentManager" dm
  JOIN "Department" d ON d.id = dm."departmentId"
  WHERE d."companyId" IS DISTINCT FROM dm."companyId"
     OR EXISTS (
       SELECT 1 FROM "User" u
       WHERE u.id = dm."userId" AND u."companyId" IS DISTINCT FROM dm."companyId"
     );
  IF cross_company_dm_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: cross-company DepartmentManager relationship detected';
  END IF;

  SELECT COUNT(*)::integer INTO duplicate_active_count
  FROM (
    SELECT "companyId", "departmentId", "userId", COUNT(*) AS c
    FROM "DepartmentManager"
    WHERE status = 'active'
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
  ) dupes;
  IF duplicate_active_count > 0 THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: duplicate active memberships exist';
  END IF;

  SELECT COALESCE(string_agg(id || ':' || COALESCE("managerId", ''), '|' ORDER BY id), '')
    INTO after_fingerprint
  FROM "Department";
  IF after_fingerprint IS DISTINCT FROM before_fingerprint THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: Department.managerId changed';
  END IF;

  SELECT COUNT(*) INTO after_user_n FROM "User";
  SELECT COUNT(*) INTO after_employee_n FROM "Employee";
  SELECT COUNT(*) INTO after_login_n FROM "LoginIdentity";
  SELECT COUNT(*) INTO after_ownership_n FROM "CompanyOwnership";
  SELECT COUNT(*) INTO after_department_n FROM "Department";
  SELECT COUNT(*) INTO after_ended_dm_n FROM "DepartmentManager" WHERE status = 'ended';

  IF after_user_n <> before_user_n
     OR after_employee_n <> before_employee_n
     OR after_login_n <> before_login_identity_n
     OR after_ownership_n <> before_ownership_n
     OR after_department_n <> before_department_n THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: User/Employee/LoginIdentity/CompanyOwnership/Department counts changed';
  END IF;

  IF after_ended_dm_n <> before_ended_dm_n THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: ended DepartmentManager history was rewritten';
  END IF;

  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public."DepartmentManager"'::regclass;
  IF rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'DM legacy backfill post-check failed: DepartmentManager RLS is not enabled';
  END IF;
END $$;

COMMIT;
