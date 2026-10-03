# Task Roadmap

- [x] Fix preview build errors in edge functions (email templates, portal-link, award-loyalty-points, bulk-import, cleanup-loyalty-images, portal-auth, customer-portal, etc.)
- [x] Fix frontend typecheck errors from generated Supabase types (EditAccountDialog, CashOrderDetail)
- [ ] Continue Lovable-managed email migration: rewrite remaining call sites, delete legacy queue files, restore gold branding on auth templates, deploy rewritten functions
- [ ] DEPLOY ONLY: 36 edge functions from main 4b931db2 (PR #351) after 20 source assertions; no code/migration/settings/package changes; do not touch mcp or .lovable/plan.md
