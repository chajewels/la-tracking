# Automatic background removal (media cut-outs)

PR 1 of 3 (Hub), 2026-10-05. Plan and owner decisions D1–D10:
`~/Code/reference/background-removal-investigation.md` (approved 2026-09-26).

| PR | Where | What |
|---|---|---|
| **1 (this)** | Hub | queue, trigger, worker, provider adapters, quality checks, switch + cap, Website → Photos tab |
| 2 | Hub | `website` API fields (`cutout`, `catalog`, `display_height_mm` + category defaults), backfill enqueue of existing photos, "Height on display (mm)" field, `ProductImportDialog` keeping Page365 ids |
| 3 | Storefront | catalogue / PDP / hero use the Hub's files; delete the bundled interim cut-outs |

Nothing from PR 1 reaches the website: the API does not send cut-outs until PR 2.

**2026-09-27 — provider switched to Photoroom** (owner decision after "Test
30"; migration `20261007100000_media_cutout_photoroom.sql`): fal.ai erased
parts of two watch dials (C1395, C0983) and both passed; fal also cost
~$0.036 a photo ($1.29 for 36). Photoroom's Remove Background API is now the
provider ($0.02); fal / Replicate stay in the code, unused unless selected.
The quality checks gained the interior-hole check (§5) and read Photoroom's
uncertainty score. The worker runs every minute and processes up to 12 photos
a tick (§2 "SPEED").

---

## 1. The rules (non-negotiable)

- **Keyed by the photo's SOURCE URL, never by `website_product_media.id`.** The
  Catalog save deletes and re-inserts every media row (`ProductsCard.tsx`), so
  a media id changes on every edit. `website_media_cutouts.source_url` is the
  primary key; the same photo used by two variants is processed once.
- **Originals are never touched.** Everything the worker writes is under
  `promotions/website/derived/`. Those URLs are never queued themselves.
- **A replaced photo is a new row.** Page365 updates a media row's `url` in
  place when the photo's version stamp changes (`page365_inventory_record_photo`
  → `'replaced'`); the new URL is enqueued, the old row — and any staff
  decision on it — is left exactly as it was.
- **A staff decision is never overwritten by automation.** `approved` /
  `rejected` change only through `review_media_cutout`. A job finishing for
  such a row is ignored (`kept_staff_decision`) unless staff started it
  (re-run or own cut-out).
- **A re-run never makes things worse.** While it runs the published version
  stays. If it comes back worse (needs_review / failed) the published version
  stays and the new result is parked in `last_rerun` ("Use the re-run").
- **Only `ok`, `auto_fixed`, `approved` may ever be shown** (PR 2 sends only
  these; everything else is `null` to the storefront).
- **The switch fails to OFF.** `system_settings.media_cutout_mode` =
  `off | test | on`; anything else reads `off`. The monthly cap reads `0` when
  invalid. Both change ONLY through `set_media_cutout_settings`
  (manage_website_catalog, audited); `trg_guard_media_cutout_settings` refuses
  every other write. Never set them in a migration or SQL.
- **Off means nothing happens.** The worker reads the switch first and returns
  — no provider call, no download, no poll. The enqueue trigger still records
  new photos (a cheap, honest backlog).
- **The trigger can never fail a media write.** Any error inside
  `enqueue_media_cutout()` is a WARNING. The Page365 scheduled fetch never
  writes media, so it is not touched at all.
- **The provider fails to Photoroom.** `system_settings.media_cutout_provider`
  = `photoroom | fal | replicate`; anything else reads `photoroom`. fal and
  Replicate are called ONLY when named there — `FAL_KEY` being set never
  causes a fal call. Provider and `media_cutout_price_usd` (estimate only)
  change ONLY through `set_media_cutout_provider` (manage_website_catalog,
  audited); `trg_guard_media_cutout_provider_settings` refuses every other
  write.
- **Secrets:** `PHOTOROOM_API_KEY` (and, only if selected, `FAL_KEY` or
  `REPLICATE_API_TOKEN` + `REPLICATE_BIREFNET_VERSION`) are edge-function
  secrets only — never in the repo, the database, the browser, a log line or a
  Lovable chat message. Error text from a provider is scrubbed before it is
  stored.
- **Store credit / money / loyalty: untouched.** This feature has no financial
  surface.

## 2. Flow

```
website_product_media INSERT / UPDATE OF url
  └─ trg_website_media_enqueue_cutout ── INSERT … ON CONFLICT (source_url) DO NOTHING
                                          (only promotions/website/…, never …/derived/…)
pg_cron 'media-cutout-worker'  * * * * *  (Vault key)  {"action":"tick"}
  └─ tick (one at a time: media_cutout_lease)
       0. switch off → return
       1. housekeeping   orphan (no media row uses the URL) → kept 30 days → files removed, row forgotten
       2. poll           queue providers only (fal / Replicate): submitted → status → result_url (never billed)
       3. submit         media_cutout_submit_batch (switch, cap, mains of active products first) → provider
                          Photoroom (sync): download original → POST → PNG stored at
                          derived/<sha32>/photoroom-<uuid>.png → media_cutout_sync_result (counted, ready)
       4. process        each ready job in ITS OWN invocation {"action":"process"}, 4 at a time
                          download result + original → cutout-pipeline.ts → Storage → media_cutout_finish
                          (a stored Photoroom result IS the master — not uploaded twice)
```

### SPEED (2026-09-27)

Before: fal's queue meant submit on one tick, poll on the next (2 min later),
process after — 2–6 minutes a photo, 8 a tick at most, one process call at a
time. Now, with a synchronous provider, a photo is sent, stored and processed
in the **same** tick, and the cron fires every minute.

| per tick | value | why it is safe |
|---|---|---|
| submit | 12, 4 at a time | Photoroom allows 60 a minute (429 beyond). The tick's own CPU per photo is a SHA-256 and a multipart copy: **1 ms median, 2 ms p95** (measured, 34 real originals). Downloads, the POST and the upload are I/O. |
| process | 12, 4 at a time | each is its OWN invocation with its own 2 s CPU; running them side by side adds nothing to any one. Pipeline CPU re-measured 2026-09-27 on the 34 real full-size fal results (1440–2400 px, the size Photoroom returns), with the new hole check: **median 429 ms, p95 626 ms, max 638 ms** (laptop core; ~2× on edge → ~1.3 s p95, under 2 s). |
| budget | 45 s | a tick stops starting work before the next minute; the lease stops overlap anyway. |

→ up to **12 photos a minute** (720 an hour). The monthly cap still bounds the
spend. Production truth is still the card's "processing time p95".


Test mode submits only rows with a `test_batch`. Staff's own cut-outs are
processed in test and on modes (no provider call, no cost).

### job_state (machinery) vs status (verdict)

| job_state | meaning |
|---|---|
| queued | waiting to be sent (or re-sent after a retry) |
| submitted | at the provider; polled every tick |
| ready | result in hand, waiting for its own process invocation |
| processing | compositor running (a row stuck here 5 min = killed invocation) |
| done / error | finished |

| status | shown on the website (PR 2) |
|---|---|
| pending | no — not processed yet (treated like `null`) |
| ok | yes |
| auto_fixed | yes — cropped by the frame; hero fades the cut side, catalogue runs it to the edge |
| needs_review | no — held for staff |
| approved | yes — staff decision |
| rejected | no — staff decision; the original is shown |
| failed | no — provider / processing failed 4 times |

### Retries and cost

- 1 try + 3 retries (D9 "retries up to 3"), backoff 5 min → 30 min → 3 h, then
  `failed` with `api_error:…`. A retry goes back to the step that failed: a
  result already paid for is re-processed, never re-bought; a status-check
  hiccup stays on polling.
- 429 from the provider stops submitting for the rest of the tick. For
  Photoroom, 402 (no credits) and 401/403 (key) do the same and are retried
  later — an account problem is never recorded as a failed photo on its
  first try.
- A job still at the provider after 30 minutes is re-submitted (counts as a
  retry).
- Cap = provider **submissions** per PHT calendar month
  (`website_media_cutout_usage`). One staff bell `media_cutout_cap_near` at
  80 % (`used * 5 >= cap * 4`), once per month. At 100 % nothing is submitted;
  the queue waits.

## 3. Providers (D1; Photoroom since 2026-09-27)

`_shared/cutout-provider.ts`, one type `CutoutProvider` = `SyncProvider`
(`remove(bytes)`) | `QueueProvider` (`submit`, `poll`), `fetch` injected
(tested with vitest).

- **Photoroom (default)** — Remove Background API, Basic plan, $0.02 a call,
  errors not billed. Read from the official docs 2026-09-27:
  - `POST https://sdk.photoroom.com/v1/segment`, `multipart/form-data`, header
    `x-api-key` —
    <https://docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide>
  - fields (OpenAPI): `image_file` (required), `format` png|jpg|webp (png),
    `channels` rgba|alpha (rgba), `bg_color`, `size` preview|medium|hd|full
    (full = 36 MP), `crop` (false), `despill` (false) —
    <https://docs.photoroom.com/getting-started/api-reference-openapi>,
    <https://docs.photoroom.com/remove-background-api-basic-plan/background-color-size-and-crop>
  - **We send** `image_file` (the original's bytes — the API takes no URL),
    `format=png`, `channels=rgba`, `size=full`, `crop=false`; no `bg_color`,
    no shadow, no padding. Trim, chalk, shadow, centring, sizes and WebP stay
    in the Hub. Content-Type is left to `fetch` (a hand-set multipart header
    breaks the request — Photoroom troubleshooting).
  - limits: ≤ 50 MB, ≤ 6,000 px widest side —
    <https://docs.photoroom.com/remove-background-api-basic-plan/file-size-resolution-and-format>;
    60 images a minute, then 429 —
    <https://docs.photoroom.com/getting-started/frequently-asked-questions>
  - answer: `200 image/png`; errors 400 / 402 / 403 with JSON
    `{detail, status_code, type}` (OpenAPI).
  - `x-uncertainty-score` header: 0 sure – 1 unsure ("high 0.6–1, low
    0–0.3"), `-1` when none —
    <https://docs.photoroom.com/remove-background-api-basic-plan/uncertainty-score>.
    Stored in `website_media_cutouts.provider_uncertainty`; ≥ 0.45 →
    needs_review (`uncertain:`).
  - pricing: <https://docs.photoroom.com/remove-background-api-basic-plan/pricing>,
    <https://docs.photoroom.com/getting-started/pricing>. A `sandbox_` key
    watermarks the output — production uses the LIVE key.
  - timeout 60 s → 408, retried. "Re-run in high detail" is an ordinary
    re-run (the Basic plan has one model).

- **fal.ai `fal-ai/birefnet/v2`** — queue API `POST https://queue.fal.run/fal-ai/birefnet/v2`,
  header `Authorization: Key $FAL_KEY`, body `model "General Use (Heavy)"`,
  `operating_resolution "2048x2048"`, `output_format "png"`,
  `refine_foreground true`. "Re-run in high detail" = `General Use (Dynamic)`
  at `2304x2304`. The submit answer's `status_url` / `response_url` are stored
  and polled; the result is `{ image: { url } }` (docs via Context7,
  2026-10-05).
- **Replicate (backup)** — same BiRefNet model family, addressed by version:
  needs both `REPLICATE_API_TOKEN` and `REPLICATE_BIREFNET_VERSION`. Used only
  when `FAL_KEY` is absent or `CUTOUT_PROVIDER=replicate`. Its input field
  (`image`) is from the plan's reading of the model page — confirm on the
  model page before relying on it.
- Nothing configured for the SELECTED provider → the worker submits nothing
  and says so in its summary ("PHOTOROOM_API_KEY not set for photoroom").

### COST

The cap stays photos per month. Website → Photos shows the provider, its price
per photo (`media_cutout_price_usd`, Photoroom $0.02; fal 0.036 measured on
Test 30; Replicate unknown) and "Estimated cost: $X so far this month (N ×
$p); at most $Y at the limit". The Turn-on question states the maximum too.
An estimate only — the provider's dashboard is the bill.

## 4. Outputs (D2, D5, D10)

Per run, under `promotions/website/derived/<first 32 hex of sha256(original)>/r<run>/`:

| file | what |
|---|---|
| `master.png` (or `.webp`) | the provider's full-resolution result, kept so the compositor can be re-run without paying |
| `cutout.webp` | transparent WebP q85, trimmed to the piece +2 %, long side ≤ **900**, cut sides faded 14 % (hero) |
| `catalog.webp` | chalk `#F5F5F2` square **1200 × 1200**, WebP q82, no alpha |
| `catalog-small.webp` | the same at **600 × 600** (exact 2× reduction) |

A new run writes a new directory, so a cache never serves a mixed pair.

**Ivory square spec:** flat chalk `#F5F5F2` (the storefront card well, D2);
the piece's box at 80 % of the square, centred, lifted 2 % (optical centre);
contact shadow = an ellipse under the base, 70 % of the piece's width wide, 6 %
high, `rgb(34 34 34)` at 18 % → 0, the same on every product; none when the
base is cut by the frame. A piece cut on two opposite sides spans the square;
one cut side is anchored to the square's edge (D3).

### TIMING TEST (step 1 of the build) and the D10 path taken

Supabase edge functions get **2 s of CPU per request** (Context7,
`guides/functions/limits.mdx`). Provider calls and downloads are I/O and free;
decode → checks → trim → composite → WebP encode are CPU.

Measured 2026-10-05 on real photos: the 5 comps originals with real BiRefNet
output (rembg `birefnet-general`, the model the owner validated 8/8) plus
R3110 at its true 418 × 370 and the two watches rebuilt at 1440²; the shipping
`cutout-pipeline.ts`; 15 warm runs each (120 samples); Apple Silicon laptop,
one core.

| sizes | median | p95 | max |
|---|---|---|---|
| planned — cut-out 1200, ivory 1600 + 800 | 689 ms | **984 ms** | 1,155 ms |
| **D10 path A** — cut-out 900, ivory 1200 + 600 | 443 ms | **645 ms** | 734 ms |

Per step at path A (median / p95 ms): decode cut-out 30/90, decode original
26/39, checks 75/141, trim 35/54, encode cut-out 91/111, compose 47/61, encode
ivory 113/125, encode small 32/35.

Edge CPUs are slower than this laptop; assuming up to 2×, the planned sizes
would be ~2.0 s p95 — over the plan's 1.2 s bar and at the 2 s kill; path A would be ~1.3 s.
**So D10 path A applies** (`CUTOUT_SIZES_PATH_A`), each job runs in its own
invocation, and **path B is automatic per job**: an invocation killed for CPU
leaves its row in `processing`; after 5 minutes it is retried with
`output_kind = 'cutout_only'` (no ivory files — the storefront draws the chalk
well itself, PR 3 must handle `catalog: null` with a cut-out). A second kill
fails the job (`api_error:cpu_limit`).

Production truth: every row stores its step timings (`timings`), and Website →
Photos shows the p95 of the last 200 plus how many fell back to cut-out only.
**Check it in test mode**; if p95 is comfortably under 1,000 ms the sizes can be
raised in a later PR.

## 5. Quality checks (`_shared/cutout-qa.ts`, pure, vitest-tested)

On the alpha downsampled to 256 px (regions, coverage, detail) and at full
resolution (frame contact, fog). Precedence: needs_review > auto_fixed > ok.

| # | check | verdict | flag |
|---|---|---|---|
| 1 | more than one region above 2 % of the largest | needs_review; the cut-out keeps only the main piece | `extra_objects:n` |
|   | D7: earrings / sets — a region 0.5–2× the largest is part of the piece | (kept, no flag) | |
|   | specks ≤ 2 % outside the piece's box | silently removed | |
| 2 | piece touches the frame (≥ max(2 px, 0.2 %) of a side) | auto_fixed | `edge_touch:top,bottom` |
| 3 | coverage outside 3–85 % | needs_review | `coverage:0.012` |
| 4 | fine detail erased: the cut-out keeps < 80 % of the photo's non-backdrop (ΔE > 12 from the corner colour, ignoring colourless brightness shifts < 30 L — shadows, vignettes) | needs_review | `detail_loss:0.42` |
| 5 | original's long side < 800 px (D4) | needs_review | `low_res:418x370` |
|   | 800–1199 px | fine for the catalogue, not the hero (`hero_usable = false`) | `hero_low_res:1000x900` |
| 6 | fog: > 8 % of visible pixels semi-transparent with **no opaque pixel within 2 px** | needs_review | `soft_matte:0.12` |
| 4b | **interior hole**: part of the piece erased from INSIDE its outline (see below) | needs_review | `interior_hole:0.054` |
|    | no original on the grid to judge colour, and openings ≥ 0.4 % of the piece | needs_review | `interior_hole_unchecked:0.009` |
| 4c | Photoroom `x-uncertainty-score` ≥ 0.45 | needs_review | `uncertain:0.62` |
| 7 | provider error / timeout / 4 failures / CPU twice | failed | `api_error:…` |

Two calibrations came out of the real photos (both have regression tests):
- AL112 sits on a black backdrop with a lighter vignette; a plain ΔE rule
  counted the vignette as "piece" and held a clean cut-out (`detail_loss:0.33`).
  Colourless brightness shifts are now backdrop.
- AL3 (a thin cross) scored 0.064 as "all semi-transparent pixels" at full size
  and 0.095 at half size; ordinary anti-aliased edges were being counted as
  fog. Fog is now semi-transparency away from the piece's opaque core.

### INTERIOR HOLES (added 2026-09-27)

Test 30: fal erased part of C1395's dark dial and a chunk of C0983's white
dial; both passed as `auto_fixed`. No check looked inside the outline, and
`detail_loss` could not see it — C0983's dial is backdrop-coloured (ΔE < 12
from the white backdrop), C1395's hole was ~5 % of the piece (kept 0.91 >
0.80).

`interiorHoles()` on the QA grid: transparent cells not reachable from the
frame's border are holes (≥ max(6 cells, 0.2 % of the piece)). A hole is an
**erasure** when
- (a) ≥ 50 % of what the photo shows there is not backdrop (the detail rule), or
- (b) ≥ 50 % of its rim (kept piece cells touching it) is within ΔE 10 of the
  hole's mean colour AND the kept surface of that colour, grown from the rim,
  is ≥ 2× the hole — the cut ran through one surface (a dial), not round an
  opening. The 2× is what separates C0983's dial (surface 7× the hole) from a
  bracelet seen from the side, whose light metal is a thin strip round a big
  opening (0.1–0.3× on C0983_3/_4, C1395_3).

Erasures adding up to ≥ 0.4 % of the piece → needs_review.

Calibration on all 34 stored fal results of Test 30 (the owner's calls in
brackets): C1395_0 held 0.054 [broken], C0983_0 held 0.042 [broken], C0983_0
run 2 auto_fixed (dial intact), R3341_0 ok [OK], R7828_0 ok, AL112 (open heart
— a real opening) ok, AL3 ok; also held: C0983_1 / _6 (dial / caseback
erased), C1395_2 / _6 (bites out of the dial / caseback), R3341_2 (band cut
through), C1395_3 / _4, C0983_3 / _4 (bracelet side views with links bitten),
R7828_1 / _4 (a small gap where the photo shows metal), AL123_1 (texture
specks). Fixtures: `development/cutout-fal-fixtures.ts` →
`src/test/fixtures/media-cutouts-fal-live.json`.

Known cases (tests, real data): **AL123** inset "BACK" → `needs_review`
`extra_objects:1`; **R3110** 418 × 370 → `needs_review` `low_res:418x370`;
AL112, AL3, R3341, R7828 → `ok`; with the owner's validated BiRefNet (rembg)
masks C0983 → `auto_fixed` top+bottom and C1395 → `auto_fixed`
bottom+left+right; with fal's Test 30 masks both → `needs_review`
`interior_hole:…`.

A staff "own cut-out" lands `approved` unless it has no transparency
(coverage > 97 % → `needs_review` + `own_cutout_opaque`). The browser checks
transparency before uploading too.

## 6. Hub — Website → Photos

Sixth tab of `/website` (docs/WEBSITE-WORKSPACE.md), `manage_website_catalog`
(already mapped for `/website`; no new PAGE_PERMISSION_MAP entry).

- **Automatic background removal** card: Off / Test / On (On asks first),
  monthly limit, this month's usage bar, last run + processing-time p95, Run
  now (one tick as the signed-in user), and the **test batch**: paste up to 100
  SKUs + a name (+ "main photo only") → `add_media_cutout_test_batch`.
- **Photos to check**: filters Needs review (default) · Failed · Auto-fixed ·
  In the queue · Published · Rejected · Test batch · All; search SKU / name /
  batch. Each row: Original → cut-out on the dark hero stage → catalogue
  square, status, flags in plain words, and **Approve / Re-run (or high
  detail) / Reject / Upload my own cut-out / Use the re-run**. Every action is
  one `review_media_cutout` call with the status the reviewer saw (a stale
  screen is refused), and one `audit_logs` row
  (`website_media_cutout / review_media_cutout:<action>`).
- Bell `media_cutout_cap_near` opens this tab.
- Dev preview: `/__fixtures/?view=media-cutouts[&mode=off|test|on]`.

## 7a. Database objects (migration 20261007100000_media_cutout_photoroom.sql)

Column `website_media_cutouts.provider_uncertainty`; settings
`media_cutout_provider` ("photoroom"), `media_cutout_price_usd` ("0.02"),
guard `trg_guard_media_cutout_provider_settings`; service-role
`media_cutout_sync_result` (calls `media_cutout_submitted` +
`media_cutout_result_ready`, whose live bodies are md5-guarded); Hub
`get_media_cutout_provider`, `set_media_cutout_provider`; cron → `* * * * *`.
Redefines no existing function. Proven locally by
`docs/sql/20261007_media_cutout_photoroom_local_tests.sql` (on the PR 1 stub;
ALL PASSED; re-run clean; a tampered callee aborts with nothing changed).

## 7. Database objects (migration 20261006100000_media_cutouts.sql)

Tables: `website_media_cutouts`, `website_media_cutout_usage`,
`website_media_cutout_lease` (RLS; staff read the first two; only the functions
write). Settings: `media_cutout_mode`, `media_cutout_monthly_cap`.
Triggers: `trg_website_media_enqueue_cutout`, `trg_media_cutout_revalidate`
(revalidates the storefront page of every product using the photo when status
or a file path changes — the media row itself did not change),
`trg_guard_media_cutout_settings`. Cron: `media-cutout-worker`.
Service-role functions: `media_cutout_*`. Hub RPCs:
`get_media_cutout_overview`, `list_media_cutouts`, `set_media_cutout_settings`,
`review_media_cutout`, `add_media_cutout_test_batch`.

It redefines **no** existing function (no live md5 guard needed; the pre-flight
aborts on any name collision). Proven locally by
`docs/sql/20261005_media_cutouts_local_stub.sql` +
`docs/sql/20261005_media_cutouts_local_tests.sql` (16 blocks, ALL PASSED;
the migration re-runs cleanly).

## 8a. Re-test on Photoroom (owner, after this PR)

1. Release PR on main → owner runs `20261007100000_media_cutout_photoroom.sql`
   (verification SELECTs at its end) → Lovable deploys `media-cutout-worker`;
   owner sets `PHOTOROOM_API_KEY` via Lovable's secure secret form.
2. Website → Photos: provider shows **Photoroom, $0.02 a photo**.
3. Filter **Test batch**. On **C1395 and C0983** (and any other row you judged
   broken) press **Reject** first: they are still `auto_fixed` from fal, and a
   re-run of a published row that comes back worse is parked in "Use the
   re-run" while the old version stays (§1 "A re-run never makes things
   worse"). Then press **Re-run** on each "Test 30" row (a re-run queues it; in
   Test mode only queued rows of a test batch are sent) and switch to
   **Test**. Rows finish within a minute or two.
4. Expect: C1395 and C0983 dials intact → OK / Auto-fixed; or, if Photoroom
   also damages them, **Needs review** with "Part of the piece was erased from
   inside it" — never OK / Auto-fixed while broken. R3341 OK; AL123 held.
5. Cost: 36 photos × $0.02 = **$0.72** (the card shows the estimate).
6. Switch back to **Off** until PR 2.

## 8. Running the 30-photo test (owner)

1. Release PR on main → owner runs the migration → Lovable deploys
   `media-cutout-worker` and sets `FAL_KEY` (deploy message).
2. Website → Photos → Test batch: name "Test 30", paste the 30 SKUs of the
   plan's §4 table (the 8 comps SKUs are AL112, AL3, AL123, R3341, R7828,
   R3110, C0983, C1395), leave "main photo only" off for R1558 (row 26 needs
   photos 3–6). Add.
3. Switch to **Test**. Within ~2–10 minutes rows move from "In the queue" to a
   verdict (Run now speeds it up).
4. Filter **Test batch**; mark each row ✅ / ⚠ / ❌ against the plan's pass
   criteria (zero broken cut-outs on OK/Auto-fixed; ≥ 24/30 usable; ≤ 2 false
   holds; AL123 and R3110 held). Note the processing-time p95 on the card
   (pass: < 1,200 ms) and the month's usage.
5. Switch back to **Off** (or leave Test) until PR 2.
