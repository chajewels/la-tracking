# Hero cut-outs — the hero-only record

Hero auto cut-out, PR 2 of 5 (2026-09-28). Plan: `~/Code/reference/hero-comps/AUTO-HERO-CUTOUT.md`.
Migration `supabase/migrations/20261009100000_hero_cutouts.sql`; local proof
`docs/sql/20261009_hero_cutouts_local_tests.sql` (on the media-cutouts local stub).

## The rule (owner, 2026-09-28)

- The storefront **hero** shows only cut-outs made by the **original tool**:
  BiRefNet-general via rembg (CPU, `post_process_mask=True`, the original
  post-processing), run by the storefront's scheduled GitHub Actions workflow
  (`cha-jewels-web` `scripts/hero-cutouts/`, every 30 minutes).
- **Product** pages and cards use Photoroom (`website_media_cutouts`,
  docs/MEDIA-CUTOUTS.md) or the normal photo. The two records never mix; this
  feature never reads or writes Photoroom data.

| PR | Repo | What |
|---|---|---|
| 1 | storefront | separate the pipelines (hero reads `hero_cutout`, never `cutout`) |
| **2 (this)** | Hub | `website_hero_cutouts`, go-live switch, admin approve / reject, Website → Photos → Hero cut-outs |
| 3 | Hub edge function (built here, deployed by Lovable) | `website` API: `hero_cutout` on `product_media`; `GET/POST /hero-cutouts` behind `HERO_CUTOUT_KEY` — see "The website edge function" below; spec: `~/Code/reference/hero-comps/EDGE-FUNCTION-SPEC.md` |
| 4 | storefront | the workflow + checks (holes, relative coverage, < 1200 px) |
| 5 | storefront | delete the bundled interim set once the owner has approved the backfill |

## Statuses

| status | meaning | storefront (`hero_cutouts_for_site`) |
|---|---|---|
| ok / auto_fixed | passed the checks, **waiting for an admin** | nothing (the whole photo; bundled set while it exists) |
| needs_review / failed | held by the checks (failed = no file) | `{status: held}` — a later photo is skipped |
| approved | an admin approved it (or go-live is on and it passed) | `{status: approved, path, width, height}` |
| rejected | an admin rejected it (any time, also when live) | `{status: rejected}` — the whole photo, no fallback |

`qa_status` keeps the checks' verdict after a decision.

## Access

- **No browser role** (anon, authenticated) can read or write the table.
  Even the service role writes only through the two functions
  (`trg_guard_hero_cutout_writes`).
- **The workflow** writes through `hero_cutout_record(p jsonb)` — service role
  only, called by the website edge function behind its own secret
  `HERO_CUTOUT_KEY`. It may record ok / auto_fixed / needs_review / failed,
  never approved / rejected. It records only URLs a website product uses.
- **Once per unchanged source.** Same URL + same sha256 → `unchanged`, whatever
  the status: a held photo (N3940, W1451 at ~440 px) is held once and never
  re-cut; a decision is never overturned by a run. New bytes at the same URL →
  `replaced` (decision cleared, audited). The workflow skips known photos
  before cutting (`hero_cutouts_known`).
- **The owner**: `review_hero_cutout(url, approve|reject, expected_status, note)`
  and `set_hero_cutout_mode(mode, expected_mode)` — **admin role only** (by
  role, not permission key), stale screens refused, one `audit_logs` row each
  (`website_hero_cutout / review_hero_cutout:<action>`,
  `system_setting / set_hero_cutout_mode`). Reading the list / overview needs
  `manage_website_catalog`; non-admins see no buttons.

## The go-live switch

`system_settings.hero_cutout_mode` = `approve` (seeded, the default) | `auto`.
Anything else reads `approve`. Changed only by `set_hero_cutout_mode`;
`trg_guard_hero_cutout_settings` refuses every other write. With `auto`, a new
cut-out that passed (ok / auto_fixed) lands `approved` with `auto_approved =
true` and an audit row (`hero_cutout_record:auto_approved`, actor
`hero_cutout_workflow`). Turning it on approves nothing already waiting. Held
ones always wait.

## Hub screen

Website → Photos → **Hero cut-outs** (`HeroCutoutsCard.tsx`, below the
Photoroom cards): the switch (confirm before changing), counts, filters
Waiting (default) · Held · Live · Rejected · All, search, Original beside the
cut-out on the dark hero stage, flags in plain words, Approve / Reject (a live
one asks first). Dev preview: `/__fixtures/?view=hero-cutouts[&role=staff]`
(in-memory; `lib/hero-cutouts.ts setHeroTransportForFixture`).

## Revalidation

`trg_hero_cutout_revalidate`: a new record or a status / file change calls
`notify_website` with the slug of every product using the photo (the
storefront revalidates `/` and the catalog tag on every call).

## The website edge function (PR 3)

Code: `supabase/functions/_shared/hero-cutouts.ts`, wired into
`supabase/functions/website/index.ts`. Tests: `src/test/hero-cutouts-edge.test.ts`
(CI "Website and template tests"). It calls only `hero_cutouts_for_site`,
`hero_cutouts_known` and `hero_cutout_record`; it never approves or rejects
and never touches `website_media_cutouts` or the `cutout` field.

- **Read side.** Every catalogue read that returns products (collections/:slug,
  categories/:slug, products/:slug, products list) sets `hero_cutout` on every
  `product_media` entry with ONE `hero_cutouts_for_site` call:
  `{status: approved, url, width, height}` (public URL in bucket `promotions`)
  | `{status: held}` | `{status: rejected}` | `null`. Only a well-formed
  approved row ever carries a URL. If the RPC fails, every entry is `null` and
  the read still succeeds. Nothing else in those responses changes
  (before/after recorded on 2026-09-28, PR description).
- **Workflow routes.** `GET /hero-cutouts` (→ `{items}` from
  `hero_cutouts_known`, `no-store`) and `POST /hero-cutouts` (multipart: `meta`
  JSON + `file` webp). Both need `x-api-key` (as every route) AND
  `x-hero-cutout-key` = secret `HERO_CUTOUT_KEY`, compared in constant time;
  an unset secret refuses everything (401 `{error: unauthorized}`, no detail).
- **POST validation (422).** Content-Length required, body ≤ 5 MB + 64 KB,
  multipart only, one `meta` (≤ 16 KB JSON), at most one `file`. `status`
  ok | auto_fixed | needs_review | failed (anything else, incl. approved /
  rejected → `invalid_status`); `source_url` the same rule as
  `hero_cutout_source_ok`; `source_sha256` 64 lower-case hex; a file exactly
  when not failed; file ≤ 5 MB with `RIFF….WEBP` magic; `width`/`height`
  integers 1–4000 (null when failed). The RPC receives only the validated
  fields plus the path the function computed.
- **Storage.** `promotions/website/derived/hero/<32 hex sha256(file)>/<8 hex
  sha256(source_url)>/cutout.webp`, `upsert: false`. "Already exists" = same
  bytes = kept, never deleted. A file uploaded by THIS request is removed
  (best-effort) when the record answers `unchanged`, `unknown_photo` (422) or
  fails (500 `record_failed`).
- **Secret.** `HERO_CUTOUT_KEY`: Supabase edge-function secret (entered by the
  owner in Lovable's secure secret form) AND the GitHub Actions secret of the
  same name in chajewels/cha-jewels-web. Never equal to `WEBSITE_API_KEY`.
- **Deploy.** Lovable only, from its mirror of `main` (see CLAUDE.md "TOOL
  OWNERSHIP"); the CI "Edge functions" job lints, type-checks and tests but
  deploys nothing.
