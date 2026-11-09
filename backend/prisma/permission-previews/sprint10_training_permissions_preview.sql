-- Sprint 10 staging permission preview only. This file is intentionally read-only.
-- It replaces only the managed Training subset and preserves unrelated keys.

WITH role_targets(role_name, training_permissions) AS (
  VALUES
    ('Admin', '[]'::jsonb),
    ('HR Manager', '["training.view_company","training.manage","training.assign","training.review","training.report"]'::jsonb),
    ('Department Manager', '["training.view_own","training.view_department","training.report"]'::jsonb),
    ('Employee', '["training.view_own"]'::jsonb),
    ('Accountant', '["training.view_own"]'::jsonb),
    ('Finance Manager', '["training.view_own"]'::jsonb),
    ('Purchasing Officer', '["training.view_own"]'::jsonb)
),
managed_permissions(permission) AS (
  VALUES
    ('training.view_own'),
    ('training.view_department'),
    ('training.view_company'),
    ('training.manage'),
    ('training.assign'),
    ('training.review'),
    ('training.report')
),
current_roles AS (
  SELECT
    role.id,
    role."companyId",
    role.name,
    role.permissions::jsonb AS current_permissions,
    target.training_permissions
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
        FROM jsonb_array_elements_text(training_permissions) WITH ORDINALITY AS item(value, ordinal)
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
