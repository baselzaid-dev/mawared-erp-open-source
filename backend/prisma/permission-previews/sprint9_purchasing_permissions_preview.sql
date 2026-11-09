-- Sprint 9 staging permission preview only. This file is intentionally read-only.
-- It replaces only the managed Purchasing subset and preserves unrelated keys.

WITH role_targets(role_name, purchasing_permissions) AS (
  VALUES
    ('Admin', '[]'::jsonb),
    ('HR Manager', '[]'::jsonb),
    ('Department Manager', '["purchasing.view_own","purchasing.view_department","purchasing.create","purchasing.review_department"]'::jsonb),
    ('Employee', '["purchasing.view_own","purchasing.create"]'::jsonb),
    ('Accountant', '["purchasing.report"]'::jsonb),
    ('Finance Manager', '["purchasing.view","purchasing.report","vendors.view"]'::jsonb),
    ('Purchasing Officer', '["purchasing.view","purchasing.create","purchasing.approve","purchasing.manage","purchasing.receive","purchasing.report","vendors.view","vendors.manage"]'::jsonb)
),
managed_permissions(permission) AS (
  VALUES
    ('purchasing.view'),
    ('purchasing.view_own'),
    ('purchasing.view_department'),
    ('purchasing.create'),
    ('purchasing.review_department'),
    ('purchasing.approve'),
    ('purchasing.manage'),
    ('purchasing.receive'),
    ('purchasing.report'),
    ('vendors.view'),
    ('vendors.manage')
),
current_roles AS (
  SELECT
    role.id,
    role."companyId",
    role.name,
    role.permissions::jsonb AS current_permissions,
    target.purchasing_permissions
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
        FROM jsonb_array_elements_text(purchasing_permissions) WITH ORDINALITY AS item(value, ordinal)
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
