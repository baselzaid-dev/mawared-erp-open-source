-- Sprint 7 staging permission preview only.
-- This file is intentionally read-only: it contains no INSERT, UPDATE, or DELETE.
-- Only the seven managed task keys are replaced in the preview. Every unrelated
-- or custom permission remains unchanged.

WITH role_targets(role_name, task_permissions) AS (
  VALUES
    ('Admin', '[]'::jsonb),
    ('HR Manager', '["tasks.view_company","tasks.create","tasks.assign_company","tasks.review"]'::jsonb),
    ('Department Manager', '["tasks.view_department","tasks.create","tasks.assign_department","tasks.review"]'::jsonb),
    ('Employee', '["tasks.view_own"]'::jsonb),
    ('Accountant', '[]'::jsonb),
    ('Finance Manager', '[]'::jsonb),
    ('Purchasing Officer', '[]'::jsonb)
),
managed_permissions(permission) AS (
  VALUES
    ('tasks.view_own'),
    ('tasks.view_department'),
    ('tasks.view_company'),
    ('tasks.create'),
    ('tasks.assign_department'),
    ('tasks.assign_company'),
    ('tasks.review')
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
          SELECT jsonb_array_elements_text(target.task_permissions) AS permission
        ) combined
        WHERE permission NOT IN (SELECT managed.permission FROM managed_permissions managed)
           OR permission IN (SELECT jsonb_array_elements_text(target.task_permissions))
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
