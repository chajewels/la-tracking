# Permissions, Routes & Team Members

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## PERMISSION RESOLUTION ORDER

When checking whether a user can perform an action:

  1. user_permission_overrides WHERE user_id = this_user
       → if a row exists for this permission_key, use granted value
  2. role_permissions WHERE role = user's role
       → fallback when no override exists
  3. admin role → always full access regardless of any override

  Table: user_permission_overrides (user_id, permission_key, granted)
  Managed via Settings → Permission Matrix → By Member view
  RLS: admins only (has_role(auth.uid(), 'admin'))

## ADDING NEW MENU ITEMS / ROUTES — NON-NEGOTIABLE (added 2026-06-01)

When adding a new route to App.tsx + a sidebar entry to AppSidebar.tsx, the
route must be granted access via ONE of these two paths:

  1. PERM-GATED ROUTE (most common):
     a. Add an entry to PAGE_PERMISSION_MAP in src/contexts/PermissionsContext.tsx
        mapping the path → permission_key (e.g. `'/my-new-page': 'view_my_thing'`)
     b. Seed rows in role_permissions table for each role that should have access
        (admin still gets a row even though admin short-circuits — keep DB consistent)

  2. UNIVERSALLY-ACCESSIBLE ROUTE (any authenticated user, no perm check):
     Add the path to PUBLIC_AUTHENTICATED_PATHS in PermissionsContext.tsx.
     Use this for Help, Glossary, FAQ, Changelog, or any content intended
     for ALL authenticated users regardless of role.

Without either entry, canAccessPage returns false and ProtectedRoute renders
"Access Denied" — including for admins on perm keys that don't yet have DB rows.

Admin short-circuit in can(): an 'admin' user gets true unconditionally
("admin role → always full access"), so a newly-added permission key that is
not yet seeded in role_permissions never denies an admin.

## TEAM MEMBER LIFECYCLE (added 2026-05-24)

  create-team-member creates members and handles deactivate / reactivate
  (admin/manage_team): deactivate = profiles.status 'inactive' + auth ban, the
  user_roles row KEPT; there is NO hard delete. handle_new_user inserts a
  profile ONLY when user_metadata.is_team_member = 'true' (Bug #151). Session
  idle-timeout: 2h with a 5-minute warning, all authenticated sessions.
  Full text: docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".
