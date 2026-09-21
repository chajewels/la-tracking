# Website workspace (`/website`)

Everything that feeds chajewelsjp.com, on one route with four tabs. Replaced
`/website-catalog`, which was a single page of six unrelated cards.

Added 2026-09-21. Posts and FAQ (content tab) arrive in PRs 5–6; site settings
(settings tab) in PR 4.

---

## 1. Tabs, and what lives on each

| Tab | `?tab=` | Cards | Permission |
|---|---|---|---|
| Catalog | `catalog` | ProductsCard, JewelryTypesCard, CategoriesCard | `manage_website_catalog` |
| Content | `content` | TestimonialsCard | `manage_website_content` |
| Audience | `audience` | NewsletterSubscribersCard, WholesaleInquiriesCard, ContactInquiriesCard | `manage_website_catalog` |
| Settings | `settings` | placeholder | `manage_website_content` |

`catalog` is the fallback: an unknown or absent `?tab=` renders it rather than
nothing. Tab state is written back with a **functional** `setSearchParams`, not
a snapshot — see §4.

## 2. The two permission keys

One route, two jobs, and they are not held by the same people: whoever
maintains the shop is not necessarily whoever writes the site's words.

- **`manage_website_catalog`** — products, jewelry types, categories,
  subscribers, inquiries. The shop, and the people who wrote in about it.
- **`manage_website_content`** — testimonials, posts, FAQ, site settings. The
  words on the site.

Both appear in Settings › Matrix under the **Website** module, each with the
description above.

The live seed grants both keys to **admin only**, and writes an explicit
`is_allowed = false` row for staff, finance, csr and live_agent. The false rows
matter: an absent row reads as false but gives the matrix nothing to toggle, so
the key could never be granted from the UI.

`/website` resolves as **either** key (`PermissionsContext.canAccessPage`),
the same shape as `/page365/`: gating a two-job route on a single key would
lock out whoever holds only the other. Each **tab** is then filtered by its own
key, in the sidebar and again on the page, so holding one key shows two tabs
and not four.

The sidebar parent deliberately carries **no `permPath`** — a single-key
`permPath` would hide the whole parent from someone holding only the other key.
It disappears on its own when both children are filtered out, because
`AppSidebar` already drops a parent left with no children.

### Delete guards

Removing a product, jewelry type, category or testimonial used to require
`isAdmin`, which meant a staff member trusted with the screen could not finish
a job on it. Each card now derives `can(<its key>) || admin`. `can()` returns
true for admin unconditionally, so admin is unaffected.

`isAdmin` survives in **ProductsCard only**, for the two things that really are
admin-only: the variant **cost-basis** field and the importer's admin mode.
Those are about money, not about who maintains the catalog.

## 3. The redirect

`/website-catalog` → `/website?tab=…`, **query string preserved**, implemented
as `WebsiteCatalogRedirect` in `src/App.tsx`.

A bare `<Navigate to>` would drop the query string, and the query string is the
point: the staff bell sent people to
`/website-catalog?subscriber=<id>#subscribers` for months and those links are
still in its history. Every param is carried across; `?subscriber=` and
`?inquiry=` select `audience`, anything else selects `catalog` (what the old
page opened on). The hash is carried too.

The bell now links straight to `/website` and no longer depends on the
redirect — the redirect is there for links already sent.

## 4. Why the param writes are functional

Three things write to the query string on this page:

1. the page, setting `?tab=`;
2. `NewsletterSubscribersCard`, deleting `?subscriber=` after consuming it once;
3. `ContactInquiriesCard`, deleting `?inquiry=` after consuming it once.

(2) and (3) only ever run on the audience tab. With a snapshot-based
`setSearchParams(next)` they would write back a params object built before the
tab was set, dropping `tab=audience` — and the reader would be bounced to
catalog at the moment their drawer opened. All three use the functional form,
which reads the live params.

Both one-shot consumes fire **once**, as soon as the row the param names has
loaded, and then clear the param. Coming back to the tab later must not
silently re-apply a filter, or re-open a drawer, from a notification read days
ago.

## 5. Where each table's editor lives

| Table | Editor | Tab |
|---|---|---|
| `website_products`, `website_product_variants`, `website_product_media` | ProductsCard + ProductDialog | catalog |
| `website_collections` (jewelry types) | JewelryTypesCard | catalog |
| `website_categories` | CategoriesCard → CategoriesEditor | catalog |
| `website_collection_products`, `website_category_products` | written by ProductDialog's save | catalog |
| `website_testimonials` | TestimonialsCard | content |
| `newsletter_subscribers` | NewsletterSubscribersCard (read + subscribe state only) | audience |
| `wholesale_inquiries` | WholesaleInquiriesCard (read only) | audience |
| `contact_inquiries` | ContactInquiriesCard (read + triage only) | audience |
| `fx_rates` | not edited here; ProductsCard reads the latest row for the peso hint | catalog |

## 6. contact_inquiries

Messages from the contact form on chajewelsjp.com. Rows are written by the
`website` edge function.

Columns used by the Hub: `full_name`, `email`, `phone`, `message`, `lang`,
`page`, `customer_id` (nullable — most people who write in are not Hub
customers), `status`, `staff_note`, `created_at`.

`status` is `new` | `replied` | `closed`. `new` is what the form writes;
anything unrecognised renders as `new` rather than blank.

The Hub **sends no reply**. The reply happens in email; `replied` records that
it did, and `staff_note` records who and how. Every status or note change
writes an `audit_logs` row (`entity_type: 'contact_inquiry'`, `action:
'triage_contact_inquiry'`) for the reason the subscriber card gives: the row
only ever shows the CURRENT state, so without the log nobody could tell who
closed an enquiry or when.

`lang` is `en` | `ja` (CHECK). `customer_id` is `ON DELETE SET NULL` — deleting
a customer must not delete what they wrote.

**`updated_at` has no trigger.** Every other `website_*` table carries
`trg_<t>_updated_at` running `public.update_updated_at_column()`; this one does
not. Until it does, `updated_at` would hold the insert time forever, so
`ContactInquiriesCard`'s triage sets it explicitly. If a trigger is ever added,
that line can go — it is not wrong with one, just redundant.

RLS: staff read and triage everything (`is_staff`). A catalog manager who is
not staff can **SELECT and UPDATE only** — no insert, no delete. The rows are
the public's own words, written by the `website` edge function, and the Hub's
job on them is to record what happened, not to author or destroy them. The
Hub's `can('manage_website_catalog')` guard on the drawer matches that UPDATE
policy exactly.

The table is absent from `src/integrations/supabase/types.ts`, so it is reached
through the `as any` table cast every `website_*` table uses. The types
regenerate on Lovable's next deploy.

Recorded in `supabase/migrations/20260921140000_record_contact_inquiries.sql`;
the two permission keys and the three `website_*` policies in
`20260921130000_record_website_permission_keys_and_policies.sql`. Both are
record-only: replaying them against live is a no-op.

### Bell notification

Type `contact_inquiry`, Mail icon, opens
`/website?tab=audience&inquiry=<id>#contact-inquiries`. The id opens that
message's drawer, the way `?subscriber=` narrows the list above it.

## 7. Files

```
src/pages/Website.tsx                              the workspace + tab state
src/App.tsx                       WebsiteCatalogRedirect (legacy path)
src/components/website/ProductsCard.tsx            products, queries, mutations
src/components/website/ProductDialog.tsx           the product editor
src/components/website/product-form.ts             form types + pure helpers
src/components/website/JewelryTypesCard.tsx
src/components/website/CategoriesCard.tsx          CategoriesCard + CategoriesEditor
src/components/website/TestimonialsCard.tsx
src/components/website/NewsletterSubscribersCard.tsx
src/components/website/WholesaleInquiriesCard.tsx
src/components/website/ContactInquiriesCard.tsx
```

See also: docs/NEWSLETTER-SUBSCRIBERS.md, docs/WEBSITE-VERCEL.md.
