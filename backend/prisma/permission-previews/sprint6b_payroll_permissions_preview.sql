-- Sprint 6B staging permission preview only.
-- This file is intentionally read-only: it contains no INSERT, UPDATE, or DELETE.
-- It removes only the five managed payroll keys from the preview, then adds the
-- target role mapping. Every unrelated/custom permission is preserved.

WITH role_targets(role_name, payroll_permissions) AS (
  VALUES
    ('Admin', '[]'::jsonb),
    ('HR Manager', '["payroll.view","payroll.manage","payroll.report"]'::jsonb),
    ('Department Manager', '[]'::jsonb),
    ('Employee', '[]'::jsonb),
    ('Accountant', '["payroll.view","payroll.report"]'::jsonb),
    ('Finance Manager', '["payroll.view","payroll.manage","payroll.approve","payroll.report","payroll.pay"]'::jsonb),
    ('Purchasing Officer', '[]'::jsonb)
),
managed_permissions(permission) AS (
  VALUES
    ('payroll.view'),
    ('payroll.manage'),
    ('payroll.approve'),
    ('payroll.report'),
    ('payroll.pay')
),
preview AS (
  SELECT
    role.id,
    role."companyId",
    role.name,
    role.permissions::jsonb AS current_permissions,
    (
      SELECT COALESCE(jsonb_agg(permission ORDER BY permission), '[]'::jsonb)
      FROM (
        SELECT DISTINCT permission
        FROM (
          SELECT jsonb_array_elements_text(role.permissions::jsonb) AS permission
          UNION ALL
          SELECT jsonb_array_elements_text(target.payroll_permissions) AS permission
        ) combined
        WHERE permission NOT IN (SELECT managed.permission FROM managed_permissions managed)
           OR permission IN (SELECT jsonb_array_elements_text(target.payroll_permissions))
      ) merged
    ) AS proposed_permissions
  FROM "Role" role
  JOIN role_targets target ON target.role_name = role.name
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
