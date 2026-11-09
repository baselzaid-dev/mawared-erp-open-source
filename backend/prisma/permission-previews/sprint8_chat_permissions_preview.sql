-- Sprint 8 staging permission preview only. This file is intentionally read-only.
-- It manages only chat.view and preserves every unrelated permission and its order.

WITH role_targets(role_name, should_have_chat) AS (
  VALUES
    ('Admin', false),
    ('HR Manager', true),
    ('Department Manager', true),
    ('Employee', true),
    ('Accountant', true),
    ('Finance Manager', true),
    ('Purchasing Officer', true)
),
current_roles AS (
  SELECT
    role.id,
    role."companyId",
    role.name,
    role.permissions::jsonb AS current_permissions,
    target.should_have_chat,
    role.permissions::jsonb ? 'chat.view' AS currently_has_chat
  FROM "Role" role
  JOIN role_targets target ON target.role_name = role.name
),
preview AS (
  SELECT
    current_roles.*,
    CASE
      WHEN should_have_chat AND NOT currently_has_chat
        THEN current_permissions || '["chat.view"]'::jsonb
      WHEN NOT should_have_chat AND currently_has_chat
        THEN COALESCE((
          SELECT jsonb_agg(value ORDER BY ordinal)
          FROM jsonb_array_elements_text(current_permissions) WITH ORDINALITY AS item(value, ordinal)
          WHERE value <> 'chat.view'
        ), '[]'::jsonb)
      ELSE current_permissions
    END AS proposed_permissions
  FROM current_roles
)
SELECT
  id,
  "companyId",
  name,
  current_permissions,
  proposed_permissions,
  should_have_chat,
  currently_has_chat,
  should_have_chat IS DISTINCT FROM currently_has_chat AS would_change
FROM preview
ORDER BY "companyId", name;
