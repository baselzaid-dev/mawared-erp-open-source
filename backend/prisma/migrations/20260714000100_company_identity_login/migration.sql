-- Sprint 12B M01: company-aware login identities.
-- The migration expands first, verifies legacy data, backfills deterministically,
-- then replaces only the unsafe global identifier constraint.

BEGIN;

-- Expand
ALTER TABLE "Company" ADD COLUMN "code" TEXT;
ALTER TABLE "User" ADD COLUMN "normalizedEmail" TEXT;
ALTER TABLE "Employee" ADD COLUMN "normalizedEmployeeNum" TEXT;

CREATE TABLE "LoginIdentity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "normalizedIdentifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginIdentity_pkey" PRIMARY KEY ("id")
);

-- PostgreSQL's POSIX [[:cntrl:]] class does not cover Unicode Cf formatting
-- characters. Keep this immutable helper aligned with the runtime Cc/Cf rule.
CREATE FUNCTION "mawared_identity_has_unsafe_formatting"(TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM generate_series(1, char_length($1)) AS character_index
        CROSS JOIN LATERAL (
            SELECT ascii(substr($1, character_index, 1)) AS codepoint
        ) AS character
        WHERE codepoint BETWEEN 0 AND 31
           OR codepoint BETWEEN 127 AND 159
           OR codepoint = 173
           OR codepoint BETWEEN 1536 AND 1541
           OR codepoint IN (1564, 1757, 1807, 2274, 6158, 65279, 69821, 69837, 917505)
           OR codepoint BETWEEN 2192 AND 2193
           OR codepoint BETWEEN 8203 AND 8207
           OR codepoint BETWEEN 8234 AND 8238
           OR codepoint BETWEEN 8288 AND 8292
           OR codepoint BETWEEN 8294 AND 8303
           OR codepoint BETWEEN 65529 AND 65531
           OR codepoint BETWEEN 78896 AND 78911
           OR codepoint BETWEEN 113824 AND 113827
           OR codepoint BETWEEN 119155 AND 119162
           OR codepoint BETWEEN 917536 AND 917631
    );
$$;

-- Preflight: fail before changing any login constraint when legacy data cannot
-- be represented safely by the approved normalization contract.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "User"
        WHERE char_length(normalize(btrim("email"), NFKC)) NOT BETWEEN 1 AND 320
           OR "email" ~ '[[:cntrl:]]'
           OR "mawared_identity_has_unsafe_formatting"("email")
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: invalid normalized User email';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Employee"
        WHERE char_length(normalize(btrim("employeeNum"), NFKC)) NOT BETWEEN 1 AND 100
           OR "employeeNum" ~ '[[:cntrl:]]'
           OR "mawared_identity_has_unsafe_formatting"("employeeNum")
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: invalid normalized Employee number';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "User"
        GROUP BY "companyId", lower(normalize(btrim("email"), NFKC))
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: duplicate normalized email inside one company';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Employee"
        GROUP BY "companyId", upper(normalize(btrim("employeeNum"), NFKC))
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: duplicate normalized Employee number inside one company';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "User" u
        JOIN "Employee" e ON e."id" = u."employeeId"
        WHERE u."companyId" <> e."companyId"
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: User is linked to a foreign-company Employee';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "RefreshToken" r
        JOIN "User" u ON u."id" = r."userId"
        WHERE r."companyId" <> u."companyId"
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: refresh session company mismatch';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            SELECT u."companyId", lower(normalize(btrim(u."email"), NFKC)) AS identifier
            FROM "User" u
            UNION ALL
            SELECT u."companyId", lower(normalize(btrim(e."employeeNum"), NFKC)) AS identifier
            FROM "User" u
            JOIN "Employee" e
              ON e."id" = u."employeeId"
             AND e."companyId" = u."companyId"
        ) identities
        GROUP BY "companyId", identifier
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'M01 preflight failed: company login identity collision';
    END IF;
END $$;

-- Backfill. The seeded development company keeps one documented stable code;
-- all other existing companies use only an opaque digest of their stable ID.
UPDATE "Company"
SET "code" = CASE
    WHEN "id" = '1' THEN 'CMP-DEMO'
    ELSE 'CMP-' || upper(substr(md5("id"), 1, 16))
END
WHERE "code" IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Company" GROUP BY "code" HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'M01 backfill failed: deterministic Company code collision';
    END IF;
END $$;

UPDATE "User"
SET "normalizedEmail" = lower(normalize(btrim("email"), NFKC));

UPDATE "Employee"
SET "normalizedEmployeeNum" = upper(normalize(btrim("employeeNum"), NFKC));

INSERT INTO "LoginIdentity" (
    "id", "companyId", "userId", "type", "normalizedIdentifier", "createdAt", "updatedAt"
)
SELECT
    'li_' || md5(u."companyId" || ':' || u."id" || ':email'),
    u."companyId",
    u."id",
    'email',
    lower(normalize(btrim(u."email"), NFKC)),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "User" u;

INSERT INTO "LoginIdentity" (
    "id", "companyId", "userId", "type", "normalizedIdentifier", "createdAt", "updatedAt"
)
SELECT
    'li_' || md5(u."companyId" || ':' || u."id" || ':employee_number'),
    u."companyId",
    u."id",
    'employee_number',
    lower(normalize(btrim(e."employeeNum"), NFKC)),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "User" u
JOIN "Employee" e
  ON e."id" = u."employeeId"
 AND e."companyId" = u."companyId";

-- Enforce canonical values and tenant-scoped uniqueness.
ALTER TABLE "Company" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "normalizedEmail" SET NOT NULL;
ALTER TABLE "Employee" ALTER COLUMN "normalizedEmployeeNum" SET NOT NULL;

ALTER TABLE "Company"
    ADD CONSTRAINT "Company_code_format_check"
    CHECK (
        char_length("code") BETWEEN 3 AND 32
        AND "code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'
    );

ALTER TABLE "User"
    ADD CONSTRAINT "User_normalizedEmail_check"
    CHECK (
        char_length("normalizedEmail") BETWEEN 1 AND 320
        AND "normalizedEmail" = lower(normalize(btrim("email"), NFKC))
        AND "normalizedEmail" !~ '[[:cntrl:]]'
        AND NOT "mawared_identity_has_unsafe_formatting"("normalizedEmail")
    );

ALTER TABLE "Employee"
    ADD CONSTRAINT "Employee_normalizedEmployeeNum_check"
    CHECK (
        char_length("normalizedEmployeeNum") BETWEEN 1 AND 100
        AND "normalizedEmployeeNum" = upper(normalize(btrim("employeeNum"), NFKC))
        AND "normalizedEmployeeNum" !~ '[[:cntrl:]]'
        AND NOT "mawared_identity_has_unsafe_formatting"("normalizedEmployeeNum")
    );

ALTER TABLE "LoginIdentity"
    ADD CONSTRAINT "LoginIdentity_type_check"
        CHECK ("type" IN ('email', 'employee_number')),
    ADD CONSTRAINT "LoginIdentity_normalizedIdentifier_check"
        CHECK (
            char_length("normalizedIdentifier") BETWEEN 1 AND 320
            AND "normalizedIdentifier" = lower(normalize(btrim("normalizedIdentifier"), NFKC))
            AND "normalizedIdentifier" !~ '[[:cntrl:]]'
            AND NOT "mawared_identity_has_unsafe_formatting"("normalizedIdentifier")
        );

CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");
CREATE UNIQUE INDEX "User_companyId_normalizedEmail_key"
    ON "User"("companyId", "normalizedEmail");
CREATE UNIQUE INDEX "Employee_companyId_normalizedEmployeeNum_key"
    ON "Employee"("companyId", "normalizedEmployeeNum");
CREATE UNIQUE INDEX "LoginIdentity_companyId_normalizedIdentifier_key"
    ON "LoginIdentity"("companyId", "normalizedIdentifier");
CREATE UNIQUE INDEX "LoginIdentity_companyId_type_normalizedIdentifier_key"
    ON "LoginIdentity"("companyId", "type", "normalizedIdentifier");
CREATE UNIQUE INDEX "LoginIdentity_companyId_userId_type_key"
    ON "LoginIdentity"("companyId", "userId", "type");
CREATE INDEX "idx_LoginIdentity_userId_companyId"
    ON "LoginIdentity"("userId", "companyId");

ALTER TABLE "LoginIdentity"
    ADD CONSTRAINT "LoginIdentity_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "LoginIdentity_userId_companyId_fkey"
        FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional composite keys close legacy cross-company relation gaps while
-- retaining the older compatible foreign keys until a later cleanup gate.
ALTER TABLE "User"
    ADD CONSTRAINT "User_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefreshToken"
    ADD CONSTRAINT "RefreshToken_userId_companyId_fkey"
        FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contract: email remains profile data, but global uniqueness no longer chooses
-- a tenant. The replacement company-scoped normalized key already exists above.
DROP INDEX "User_email_key";

-- Company codes cannot be changed after their first canonical assignment.
CREATE FUNCTION "prevent_company_code_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."code" IS DISTINCT FROM OLD."code" THEN
        RAISE EXCEPTION 'Company code is immutable after activation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Company_code_immutable_trigger"
BEFORE UPDATE OF "code" ON "Company"
FOR EACH ROW EXECUTE FUNCTION "prevent_company_code_change"();

-- No direct Data API policy is created. RLS therefore blocks anon/authenticated
-- roles while the trusted backend database role remains the only entry point.
ALTER TABLE "LoginIdentity" ENABLE ROW LEVEL SECURITY;

COMMIT;
