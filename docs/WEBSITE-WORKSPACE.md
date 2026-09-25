# Website workspace (`/website`)

Everything that feeds chajewelsjp.com, on one route with five tabs (Page365 stock added 2026-09-26). Replaced
`/website-catalog`, which was a single page of six unrelated cards.

Added 2026-09-21.

---

## 1. Tabs, and what lives on each

| Tab | `?tab=` | Cards | Permission |
|---|---|---|---|
| Catalog | `catalog` | ProductsCard, JewelryTypesCard, CategoriesCard | `manage_website_catalog` |
| Content | `content` | PostsCard, FaqCard, TestimonialsCard | `manage_website_content` |
| Audience | `audience` | CampaignsCard, NewsletterSubscribersCard, WholesaleInquiriesCard, ContactInquiriesCard | **either key** — see below |
| Settings | `settings` | ReservationModeCard, SettingsCard | `manage_website_content` (the reserve-first switch itself: **admin only**) |
| Page365 stock | `page365-stock` | Page365InventoryCard, Page365StockCard | `manage_website_catalog` — fetch the Page365 catalogue, review and apply stock/photos (added 2026-09-27, docs/PAGE365-IMPORT.md "INVENTORY"); Page365 lines that did not reduce website stock, resolved with a note (added 2026-09-26, "STOCK") |

**Audience is the one tab that is not a single key's.** Three of its cards
belong to `manage_website_catalog` — who subscribed, who wrote in — and
CampaignsCard belongs to `manage_website_content`, because a campaign is words
the site sends. So the **tab** opens to *either* key and each **card** keeps
its own gate. A holder of one key sees exactly their cards, and never an empty
tab: whichever key opened it also renders at least one card. The sidebar's
`permFilter` for Audience is the same `||`.

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
| `website_posts` | PostsCard | content |
| `website_faq_sections`, `website_faq_items` | FaqCard | content |
| `newsletter_campaigns` | CampaignsCard | audience |
| `newsletter_campaign_recipients` | not edited here; written by the queue worker | — |
| `website_testimonials` | TestimonialsCard | content |
| `newsletter_subscribers` | NewsletterSubscribersCard (read + subscribe state only) | audience |
| `wholesale_inquiries` | WholesaleInquiriesCard (read only) | audience |
| `contact_inquiries` | ContactInquiriesCard (read + triage only) | audience |
| `fx_rates` | not edited here; ProductsCard reads the latest row for the peso hint | catalog |
| `website_settings` | SettingsCard | settings |

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

## 7. website_settings — the Settings tab

A key/value table: `key` (PK), `value jsonb NOT NULL`, `kind`, `public`,
`updated_at`, `updated_by`.

**The Hub does not offer a free-form key editor over it.** That would be a JSON
text box, which is how a storefront ends up with `announcement.untill` and a
silently dead banner. `src/components/website/website-settings.ts` holds a
typed schema — every key the Hub manages, the shape of its value, and what
counts as valid — and `SettingsCard` renders fields from it.

### The eight keys

| Key | kind | Shape |
|---|---|---|
| `contact.email` | `text` | string, email-validated |
| `social.follow` | `json` | `[{key, href}]` — the footer's social row, in order |
| `social.loyalty_groups` | `json` | `[{key, href}]` — group-chat invites for loyalty members |
| `footer.tagline` | `bilingual` | `{en, ja}` |
| `announcement.active` | `bool` | `true`/`false` |
| `announcement.text` | `bilingual` | `{en, ja}` |
| `announcement.href` | `text` | string, optional |
| `announcement.until` | `date` | ISO date, `""` when unset |

`kind` must be one of the five the table's CHECK allows (`text`, `bilingual`,
`json`, `bool`, `date`). `SETTING_KIND` is the only place that decides, and a
key added without one will not compile.

A social row's `key` comes from a fixed set — `email`, `facebook`, `messenger`,
`instagram`, `whatsapp`, `line`, `tiktok`, `youtube` — because the storefront
renders an icon per key and a key it does not know renders as nothing at all. A
row whose key is outside the set is dropped on read rather than shown broken.
`href` must be a `mailto:` address or an `https://` URL; plain `http://` is
refused, because the storefront is https and an http link in the footer is a
mixed-content warning in the customer's browser.

### Saving

**Per section**, and only the keys that actually changed are written — pressing
Save on Contact must not stamp `updated_by` on the announcement. Each written
key gets its own `audit_logs` row (`entity_type: 'website_setting'`,
`entity_id: <the key>`, `action: 'update_website_setting'`) with the old and
new value, because a key/value table shows only what a setting IS and never
what it was or who changed it. One row per KEY, not per Save: "Announcement
changed" tells nobody which of its four keys moved.

The upsert deliberately does **not** send `public` or `updated_at`. `public`
keeps its column default on insert and its existing value on conflict;
`updated_at` is the table's own `trg_website_settings_updated_at` trigger's job.

### `serializeSetting` never returns null

`value` is `jsonb NOT NULL`, and PostgREST turns a JSON `null` in the request
body into **SQL NULL** — which would fail that constraint on every save of an
announcement with no end date. An unset value is written as `""` instead, which
is already this table's own convention: the seed stores `announcement.href` as
`""` for exactly the same "optional, not set" case.

The seed does store `announcement.until` as JSON `null`. `parseSetting` reads
`null` and `""` identically, so the seeded row needs no migration — it simply
becomes `""` the first time someone saves the announcement.
`src/test/website-settings.test.ts` asserts that no key, on an empty draft,
ever serializes to null.

### Unknown keys

Rows in the table the schema does not know are listed **read-only** at the
bottom of the card with their key, kind and raw JSON. Hiding them would make a
row that exists invisible, which is the failure mode a typed schema otherwise
introduces.

### Permission

Writes are gated on `manage_website_content`, matching the table's own RLS
(`Content managers can manage website settings`). Without the key the card is
**read-only rather than hidden**: knowing what the site currently says is
useful to anyone who can see this tab. Staff may read via a separate SELECT
policy.

Recorded in `supabase/migrations/20260921150000_record_website_settings.sql` —
the DDL, the policies, the `updated_at` trigger and the seed. The
`notify_website_revalidate()` extension and the revalidate trigger on this
table are **not** recorded there: they were applied by Lovable's own migration
and belong to it.

## 8. website_posts — articles and news

`id`, `slug` (NOT NULL **UNIQUE**), `type` (`article` | `news`), `title_en/ja`,
`excerpt_en/ja`, `body_en/ja`, `cover_media`, `published`, `published_at`
(date), `layaway_only`, `created_at`, `updated_at`, `updated_by`.

English is the source language. The Japanese columns are nullable because a
post is written and published before it is translated; the list shows a **no
JA** chip on any post still missing one.

### Bodies are markdown, edited as textareas

Not a rich-text editor. The storefront renders markdown, so a WYSIWYG would be
showing the writer something the site never promised to reproduce. Each body
has a **Preview** toggle rendering through
`src/components/website/markdown.tsx`, which uses `react-markdown` +
`remark-gfm` — both already dependencies (Help.tsx has rendered the staff
handbook with them since it shipped), so this added no package.

`Help.tsx` keeps its own component map: it is a full documentation page with
3xl headings, and this one is sized for a preview pane beside a textarea. Links
in the preview open in a new tab with `noopener`, because a preview must never
navigate the Hub away from an unsaved draft.

### The slug

Auto-filled from `title_en` and editable. It stops following the title once the
post has an id, or once the slug has been typed into — after that it is an
address someone may already have linked to, and the editor says so under the
field.

`postSlug()` is deliberately **not** the catalog's `slugify` from
`product-form.ts`. That one may return `""` (fine for a product, whose slug
falls back to a generated one) and does not truncate. This column is NOT NULL
UNIQUE and ends up in a public URL, so `postSlug`:

- folds accents (`Café` → `cafe`) rather than dropping the letter;
- keeps an apostrophe inside a word (`Japan's` → `japans`, not `japan-s`);
- caps at 80 characters **on a word boundary**, never mid-word;
- is idempotent — running it on its own output changes nothing, which is what
  lets the field re-slug on every keystroke;
- returns `""` for a title with nothing slug-able in it (a Japanese-only
  title), which `validatePost` then reports instead of saving.

Uniqueness is checked twice on purpose. `isSlugTaken` is the friendly check, so
the writer is told before they press Save. The DB's UNIQUE index is the
authority, and the save path handles `23505` with a plain-English message,
because two writers can clear the friendly check in the same moment.

### Publishing

Switching **Published** on fills `published_at` with today (PHT) if it is
blank — visibly, in the date field, rather than silently at save.
`validatePost` refuses a published post with no date, which can only happen if
someone clears it by hand. An unpublished post may be as half-written as the
writer likes.

`layaway_only` is labelled *"Shown on the English site only"* and shows as an
**EN only** chip in the list.

### Saving and deleting

Upsert on `id` with `updated_by`; one `audit_logs` row per save
(`entity_type: 'website_post'`, `create_` / `update_website_post`) recording
the slug, type and published state. Delete is confirmed, names what will break
(`any link to /slug will stop working`), content-managers only, and writes its
own audit row with the deleted post's slug and title — the row itself is gone,
so the log is the only record it existed.

Recorded in `supabase/migrations/20260922090000_record_website_posts.sql`. No
seed: the site ships with no posts, and an invented one would appear on
chajewelsjp.com as though someone had written it. The revalidation trigger on
this table is Lovable's and is not recorded; the `updated_at` trigger is.

## 9. website_faq_sections + website_faq_items — the FAQ

Two tables. Sections carry `slug` (NOT NULL **UNIQUE**, the page anchor),
`title_en/ja`, `sort_order`, `published`. Items carry `section_id`,
`question_en/ja`, `answer_en/ja`, `layaway_only`, `sort_order`, `published`.

`published` defaults to **true** on both — unlike a post, an FAQ entry is
visible the moment it exists. The drafts in `website-faq.ts` default the same
way, so the editor never shows a state the database would not have produced.

### The delete guard is load-bearing

`website_faq_items.section_id` is **`ON DELETE CASCADE`**. Deleting a section
takes every answer in it, silently, at the database — no error, the FAQ page is
just shorter.

So the Hub refuses to delete a section that still has items.
`sectionDeleteBlocker()` is that refusal, and it is checked **twice**: once to
decide what the button does, and again inside the delete mutation with a fresh
`count` from the server, because the button was enabled against a list that may
be a minute old. This is the one guard in the workspace where being wrong is
unrecoverable.

### Ordering

`sort_order` has **no UNIQUE constraint**, so two rows can legitimately share a
value. A naive swap between equal values is a no-op: the row does not move, the
button looks broken, and nothing errors. `reorder()` therefore returns the
explicit `sort_order` each of the two rows must be written to, stepping them
apart when they are tied, rather than swapping stored numbers.

`inOrder()` breaks ties by id so two rows sharing a value never swap places
between renders. New rows land at `max + 10`, starting from the column default
of 100.

Reordering is immediate — a click writes both rows and logs **one** audit row,
for the row that moved. The other only shifted to make space.

Up/down buttons rather than drag: the repo has no drag-and-drop dependency, and
adding one for this would be a package for a pair of buttons that are keyboard-
accessible for free.

### Answers are markdown

Previewed through the same `src/components/website/markdown.tsx` the posts
editor uses — one renderer, so a list that previews correctly in a post
previews correctly here. Section slugs use `postSlug` from `website-posts.ts`
for the same reason: a third slug rule in this folder is a third way for two of
them to disagree.

### The audit is not optional

These answers carry binding layaway and loyalty terms. Every write logs one
row, and an **item's log carries the old and new answer text**, both languages
— not just the id and a changed flag. A log that records *that* an answer
changed without recording *what it said* cannot settle a dispute about what a
customer was told. Deletes log the full question and answer, since the row
itself is gone.

Entity types: `website_faq_section`, `website_faq_item`. Actions:
`create_` / `update_` / `delete_` / `reorder_faq_section` and `…_faq_item`.

Recorded in `supabase/migrations/20260922100000_record_website_faq.sql`. The
revalidation triggers on both tables are Lovable's and are not recorded; the
`updated_at` triggers are.

## 10. newsletter_campaigns — sending to the list

`newsletter_campaigns` holds the composed campaign;
`newsletter_campaign_recipients` is the per-address queue, with a composite
`PRIMARY KEY (campaign_id, subscriber_id)` that stops the worker enqueuing the
same subscriber twice however it retries.

**The Hub composes and queues. It does not send.** Lovable's `campaign-queue`,
`process-newsletter-campaigns` and `campaign-cancel` edge functions and their
cron do that, and none of them is recorded here. `newsletter_campaign_recipients`
is **staff-SELECT only with no write policy at all** — those rows belong to the
worker, which runs as service role.

### 60 per hour is not the provider rate

`SEND_RATE_PER_HOUR = 60`, and docs/RETROACTIVE-AND-EMAIL.md records the actual
Lovable workspace cap as **100 emails per hour, hard** — already reached by the
deduped payment-reminder batch on peak days. A newsletter assuming 100 would be
competing with the reminders for the same allowance, and the reminders are the
ones a customer is waiting on. 60 is deliberate headroom.

The number lives in `newsletter-campaigns.ts` so the estimate the confirm
dialog shows and the rate the queue actually runs at cannot drift apart
silently. If Lovable's cron changes, that constant changes with it.

### Who a campaign reaches

`recipientsFor()` applies the same two rules as the subscriber list (§4 of
docs/NEWSLETTER-SUBSCRIBERS.md): active is `unsubscribed_at IS NULL`, and a
test **customer's** subscription is excluded while a subscriber with **no
customer at all is kept**.

A subscriber whose `lang` is neither `en` nor `ja` counts under **All** and
under neither language. It is a real address, so All must not lose it, and
guessing which language to send it is worse than not sending.

### The layaway refusal

`public.campaign_no_layaway_in_ja()` refuses any write whose Japanese subject
or body mentions layaway, in English or as レイアウェイ. It refuses at **write**
time, not send time, so a campaign that would breach it cannot be saved at all.

It `RAISE`s without an ERRCODE, so it arrives as **SQLSTATE P0001** — the
generic code every other `RAISE` in the schema shares. The Hub therefore
identifies it by **message**, in `isLayawayError()`. **Changing the trigger's
wording without changing that matcher turns the friendly inline hint back into
a raw database exception**; both the migration and the helper say so.

When it fires, the Japanese panel is outlined, both Japanese fields get
`aria-invalid`, and the hint appears in a `role="alert"`. Editing either
Japanese field clears it — the refusal was about the text as it was, and
editing it is the fix.

### Sending

- **Send test** calls `campaign-queue` with `test_email` set to the signed-in
  user's address and renders the returned HTML in an `<iframe sandbox="">` —
  no scripts, no same-origin. It is generated email being *displayed*, never
  trusted.
- **Send to list** confirms first, stating the recipient count and the
  duration. A non-ok answer from the function is surfaced **as written**: when
  the Resend setup is unfinished the function says so in its own words, and
  rewording that into "Could not send" would hide the one sentence explaining
  why.
- **Cancel** is offered while `queued` or `sending`, and says how many have
  already gone and cannot be recalled.
- Only `draft` campaigns are editable.
- Progress polls every 30s **only while something is in flight** — it is
  written by the worker, so the screen has no other way to see it move.

Send and cancel both write `audit_logs` (`entity_type
'newsletter_campaign'`).

### Which key sees this card

CampaignsCard writes under **`manage_website_content`** — a campaign is words
the site sends — while the three cards beside it on Audience are
`manage_website_catalog`'s.

An earlier revision gated the whole tab on the catalog key, which meant a
content-only holder held the key to write campaigns and could not reach the tab
they were on. That is now fixed the other way: the **tab** opens to either key
(`canAudience` in `Website.tsx`, and the matching `||` in the sidebar's
`permFilter`), and each **card** is rendered only for its own key.

So:

- **catalog-only** → Subscribers, Wholesale, Contact messages. No Campaigns.
- **content-only** → Campaigns only, on a tab they can now reach.
- **both** (every live holder today, since the seed grants both to admin) → all four.

The tab is never empty: whichever key opened it also renders at least one card.

Recorded in `supabase/migrations/20260922110000_record_newsletter_campaigns.sql`.

## 11. Files

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
src/components/website/ReservationModeCard.tsx       reserve-first switch (docs/RESERVE-FIRST.md)
src/components/website/reservation-mode.ts           its copy + refusal words
src/components/website/SettingsCard.tsx              the Settings tab
src/components/website/website-settings.ts           the typed key schema
src/components/website/PostsCard.tsx                 the Posts card + editor
src/components/website/website-posts.ts              post shape, slug rule
src/components/website/markdown.tsx                  the preview renderer
src/test/website-settings.test.ts                    schema round-trip vs the seed
src/components/website/FaqCard.tsx                    sections + questions
src/components/website/website-faq.ts                ordering, delete guard
src/test/website-posts.test.tsx                      slug rule + markdown preview
src/components/website/CampaignsCard.tsx              compose, send, cancel
src/components/website/newsletter-campaigns.ts       audience, estimate, layaway error
src/test/website-faq.test.ts                         ordering + the delete guard
src/test/newsletter-campaigns.test.ts                recipients + hours + layaway
```

See also: docs/NEWSLETTER-SUBSCRIBERS.md, docs/WEBSITE-VERCEL.md.
