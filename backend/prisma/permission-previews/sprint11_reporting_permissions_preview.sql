-- Sprint 11 reporting permission preview only. This file is intentionally read-only.
-- It replaces only the managed Reports subset and preserves every unrelated key.

WITH role_targets(role_name, reporting_permissions) AS (
  VALUES
    ('Admin', '[]'::jsonb),
    ('HR Manager', '["reports.view","reports.export"]'::jsonb),
    ('Department Manager', '["reports.export"]'::jsonb),
    ('Employee', '[]'::jsonb),
    ('Accountant', '["reports.finance","reports.export"]'::jsonb),
    ('Finance Manager', '["reports.finance","reports.export"]'::jsonb),
    ('Purchasing Officer', '["reports.export"]'::jsonb)
),
managed_permissions(permission) AS (
  VALUES
    ('reports.view'),
    ('reports.finance'),
    ('reports.export')
),
current_roles AS (
  SELECT
    role.id,
    role."companyId",
    role.name,
    role.permissions::jsonb AS current_permissions,
    target.reporting_permissions
  FROM "Role" role
  JOIN role_targets target ON target.role_name = role.name
),
preview AS (
  SELECT
    current_roles.*,
    (
      SELECT COALESCE(jsonb_agg(permission ORDER BY source_order, item_order), '[]'::jsonb)
      FROM (
        SELECT value AS permission, 0 AS source_order, ordinal AS item_order
        FROM jsonb_array_elements_text(current_permissions) WITH ORDINALITY AS item(value, ordinal)
        WHERE value NOT IN (SELECT managed.permission FROM managed_permissions managed)
        UNION ALL
        SELECT value AS permission, 1 AS source_order, ordinal AS item_order
        FROM jsonb_array_elements_text(reporting_permissions) WITH ORDINALITY AS item(value, ordinal)
      ) merged
    ) AS proposed_permissions
  FROM current_roles
)
SELECT
  id,
  "companyId",
  name,
  current_permissions,
  proposed_permissions,
  current_permissions IS DISTINCT FROM proposed_permissions AS would_change
FROM preview
ORDER BY "companyId", name;
